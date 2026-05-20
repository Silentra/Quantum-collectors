/**
 * achievements-ui.js — Player-facing achievements tab and profile summary.
 */

import * as auth from './auth.js';
import * as db from './database.js';
import * as toast from './toast.js';
import {
  isAchievementSystemEnabled,
  listAchievementDefinitions,
} from './achievement-config.js';
import { claimAchievementReward } from './achievements.js';
import { isPlayerClaimed, isPlayerUnlocked } from './achievement-engine.js';
import { ITEM_DEFINITIONS } from './shop-definitions.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getPlayerAchievements(username) {
  const raw = db.get(`players/${username}/achievements`);
  return raw && typeof raw === 'object' ? raw : {};
}

function getEntry(playerAchievements, achievementId) {
  const entry = playerAchievements?.[achievementId];
  return entry && typeof entry === 'object' ? entry : {};
}

function formatRewardSummary(reward) {
  if (!reward?.type) return '';
  if (reward.type === 'rp') return `${reward.amount} RP`;
  if (reward.type === 'pack') {
    const pack = db.get(`packs/${reward.packId}`);
    const name = pack?.name || reward.packId || 'Pack';
    const qty = Math.max(1, Number(reward.quantity) || 1);
    return qty > 1 ? `${qty}× ${name}` : name;
  }
  if (reward.type === 'consumable' || reward.type === 'cosmetic') {
    const def = ITEM_DEFINITIONS[reward.itemId];
    const name = def?.name || reward.itemId || 'Item';
    if (reward.type === 'cosmetic') return `${name} (unlock)`;
    const qty = Math.max(1, Number(reward.quantity) || 1);
    return qty > 1 ? `${qty}× ${name}` : name;
  }
  return reward.type;
}

function rewardsSummary(definition) {
  const rewards = Array.isArray(definition?.rewards) ? definition.rewards : [];
  if (!rewards.length) return 'No rewards';
  return rewards.map(formatRewardSummary).filter(Boolean).join(', ');
}

function progressPercent(entry) {
  const target = Number(entry?.targetValue) || 0;
  const value = Number(entry?.progressValue) || 0;
  if (target > 0) return Math.min(100, Math.round((value / target) * 100));
  const progress = Number(entry?.progress);
  if (Number.isFinite(progress)) return Math.min(100, Math.round(progress * 100));
  return 0;
}

function isSecretLocked(definition, unlocked) {
  return definition.hidden === true && !unlocked;
}

function achievementCardHtml(definition, playerAchievements, username, options = {}) {
  const entry = getEntry(playerAchievements, definition.id);
  const unlocked = isPlayerUnlocked(playerAchievements, definition.id);
  const claimed = isPlayerClaimed(playerAchievements, definition.id);
  const secret = isSecretLocked(definition, unlocked);
  const compact = options.compact === true;

  const name = secret ? '??? Secret Achievement' : escapeHtml(definition.name);
  const description = secret ? '' : escapeHtml(definition.description);
  const icon = secret ? '❓' : escapeHtml(definition.icon?.emoji || '🏆');
  const rewardText = secret ? '' : escapeHtml(rewardsSummary(definition));
  const pct = progressPercent(entry);
  const showProgress = !unlocked && !secret;
  const canClaim = unlocked && !claimed && (definition.rewards?.length > 0);

  const claimBtn = canClaim && !compact
    ? `<button type="button" class="ach-claim-btn bg-primary-600 hover:bg-primary-500 px-3 py-1.5 rounded text-xs font-medium" data-achievement-id="${escapeHtml(definition.id)}">Claim reward</button>`
    : '';

  const statusBadge = claimed
    ? '<span class="ach-badge ach-badge-done">Claimed</span>'
    : unlocked
      ? '<span class="ach-badge ach-badge-ready">Unlocked</span>'
      : '<span class="ach-badge ach-badge-progress">In progress</span>';

  return `
    <article class="ach-card${secret ? ' ach-card-secret' : ''}" data-achievement-id="${escapeHtml(definition.id)}">
      <div class="ach-card-icon" aria-hidden="true">${icon}</div>
      <div class="ach-card-body">
        <div class="ach-card-head">
          <h4 class="ach-card-title">${name}</h4>
          ${compact ? '' : statusBadge}
        </div>
        ${description ? `<p class="ach-card-desc">${description}</p>` : ''}
        ${showProgress ? `
          <div class="ach-progress-wrap">
            <div class="ach-progress-bar"><div class="ach-progress-fill" style="width:${pct}%"></div></div>
            <span class="ach-progress-label">${pct}%</span>
          </div>
        ` : ''}
        ${rewardText && !claimed ? `<p class="ach-card-reward">Reward: ${rewardText}</p>` : ''}
        ${claimBtn}
      </div>
    </article>
  `;
}

function sectionHtml(title, cardsHtml, emptyMessage) {
  if (!cardsHtml) {
    return `
      <section class="ach-section">
        <h3 class="ach-section-title">${escapeHtml(title)}</h3>
        <p class="ach-section-empty">${escapeHtml(emptyMessage)}</p>
      </section>
    `;
  }
  return `
    <section class="ach-section">
      <h3 class="ach-section-title">${escapeHtml(title)}</h3>
      <div class="ach-card-grid">${cardsHtml}</div>
    </section>
  `;
}

function categorizeAchievements(definitions, playerAchievements) {
  const ready = [];
  const inProgress = [];
  const completed = [];

  for (const def of definitions) {
    if (!def.enabled) continue;
    const unlocked = isPlayerUnlocked(playerAchievements, def.id);
    const claimed = isPlayerClaimed(playerAchievements, def.id);
    const hasRewards = Array.isArray(def.rewards) && def.rewards.length > 0;

    if (unlocked && hasRewards && !claimed) {
      ready.push(def);
    } else if (unlocked && (!hasRewards || claimed)) {
      completed.push(def);
    } else {
      inProgress.push(def);
    }
  }

  return { ready, inProgress, completed };
}

function wireClaimButtons(container, username) {
  container.querySelectorAll('.ach-claim-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const achievementId = btn.dataset.achievementId;
      const result = claimAchievementReward(username, achievementId);
      if (result.success) {
        toast.success('Reward claimed!');
        renderAchievements();
        return;
      }
      toast.error(getClaimErrorMessage(result.reason));
    });
  });
}

function getClaimErrorMessage(reason) {
  const messages = {
    achievement_not_unlocked: 'Complete this achievement before claiming.',
    already_claimed: 'You already claimed this reward.',
    no_rewards: 'This achievement has no rewards to claim.',
    definition_not_found: 'Achievement not found.',
    invalid_request: 'Could not claim reward.',
    invalid_item_id: 'Reward item is invalid.',
    invalid_pack_id: 'Reward pack is invalid.',
    unsupported_reward: 'Unsupported reward type.',
  };
  return messages[reason] || 'Could not claim reward.';
}

export function renderAchievements() {
  const container = document.getElementById('achievements-content');
  if (!container) return;

  const session = auth.getSession();
  if (!session || session.username === '__admin__') {
    container.innerHTML = '<p class="text-surface-500 text-sm">Sign in to view achievements.</p>';
    return;
  }

  const username = session.username;

  if (!isAchievementSystemEnabled()) {
    container.innerHTML = '<p class="text-surface-500 text-sm">Achievements are temporarily disabled.</p>';
    return;
  }

  const definitions = listAchievementDefinitions();
  const playerAchievements = getPlayerAchievements(username);

  if (!definitions.length) {
    container.innerHTML = '<p class="text-surface-500 text-sm">No achievements are available yet. Check back soon!</p>';
    return;
  }

  const { ready, inProgress, completed } = categorizeAchievements(definitions, playerAchievements);

  const readyHtml = ready.map(d => achievementCardHtml(d, playerAchievements, username)).join('');
  const progressHtml = inProgress.map(d => achievementCardHtml(d, playerAchievements, username)).join('');
  const doneHtml = completed.map(d => achievementCardHtml(d, playerAchievements, username)).join('');

  container.innerHTML = [
    sectionHtml('Ready to claim', readyHtml, 'No rewards waiting — keep playing!'),
    sectionHtml('In progress', progressHtml, 'All achievements unlocked or completed.'),
    sectionHtml('Completed', doneHtml, 'No completed achievements yet.'),
  ].join('');

  wireClaimButtons(container, username);
}

export function renderProfileAchievementsSummary() {
  const container = document.getElementById('profile-achievements-placeholder');
  if (!container) return;

  const session = auth.getSession();
  if (!session || session.username === '__admin__') return;

  if (!isAchievementSystemEnabled()) {
    container.innerHTML = `
      <section class="profile-panel profile-panel-muted">
        <div class="profile-panel-header">
          <h3>Achievements</h3>
          <span>Disabled</span>
        </div>
        <div class="profile-empty-state">Achievements are temporarily unavailable.</div>
      </section>
    `;
    return;
  }

  const username = session.username;
  const definitions = listAchievementDefinitions().filter(d => d.enabled);
  const playerAchievements = getPlayerAchievements(username);
  const unlockedCount = definitions.filter(d => isPlayerUnlocked(playerAchievements, d.id)).length;
  const claimable = definitions.filter(d => {
    const unlocked = isPlayerUnlocked(playerAchievements, d.id);
    const claimed = isPlayerClaimed(playerAchievements, d.id);
    return unlocked && !claimed && d.rewards?.length > 0;
  });

  const recent = definitions
    .filter(d => isPlayerUnlocked(playerAchievements, d.id))
    .slice(0, 3)
    .map(d => achievementCardHtml(d, playerAchievements, username, { compact: true }))
    .join('');

  container.innerHTML = `
    <section class="profile-panel">
      <div class="profile-panel-header">
        <h3>Achievements</h3>
        <button type="button" class="text-xs text-primary-400 hover:text-primary-300" data-open-achievements-tab>View all</button>
      </div>
      <p class="text-sm text-surface-400 mb-3">${unlockedCount} / ${definitions.length} unlocked${claimable.length ? ` · <span class="text-amber-400">${claimable.length} reward(s) ready</span>` : ''}</p>
      ${recent ? `<div class="ach-profile-preview">${recent}</div>` : '<div class="profile-empty-state">No achievements unlocked yet.</div>'}
    </section>
  `;

  container.querySelector('[data-open-achievements-tab]')?.addEventListener('click', () => {
    const tabBtn = document.querySelector('.tab-btn[data-tab="achievements"]');
    tabBtn?.click();
  });
}
