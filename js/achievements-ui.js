/**
 * achievements-ui.js — Profile-embedded achievements panel.
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

const DEFAULT_SHOW_COUNT = 5;
let profileShowLimit = DEFAULT_SHOW_COUNT;

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

function getUnlockedAt(playerAchievements, achievementId) {
  const entry = getEntry(playerAchievements, achievementId);
  return Number(entry.unlockedAt) || 0;
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
  if (!rewards.length) return '';
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

/**
 * Visible achievements: hidden+locked omitted; unlocked first (newest), then locked by sortOrder.
 */
function buildOrderedVisibleAchievements(definitions, playerAchievements) {
  const unlocked = [];
  const lockedVisible = [];

  for (const def of definitions) {
    if (!def?.enabled) continue;
    const unlockedFlag = isPlayerUnlocked(playerAchievements, def.id);
    if (!unlockedFlag && def.hidden === true) continue;
    if (unlockedFlag) unlocked.push(def);
    else lockedVisible.push(def);
  }

  unlocked.sort((a, b) => getUnlockedAt(playerAchievements, b.id) - getUnlockedAt(playerAchievements, a.id));
  lockedVisible.sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));

  return [...unlocked, ...lockedVisible];
}

function achievementCardHtml(definition, playerAchievements) {
  const entry = getEntry(playerAchievements, definition.id);
  const unlocked = isPlayerUnlocked(playerAchievements, definition.id);
  const claimed = isPlayerClaimed(playerAchievements, definition.id);
  const emoji = (definition.icon?.emoji || '').trim() || '🏆';
  const rewardText = escapeHtml(rewardsSummary(definition));
  const pct = progressPercent(entry);
  const canClaim = unlocked && !claimed && (definition.rewards?.length > 0);

  const claimBtn = canClaim
    ? `<button type="button" class="ach-claim-btn bg-primary-600 hover:bg-primary-500 px-2 py-1 rounded text-xs font-medium" data-achievement-id="${escapeHtml(definition.id)}">Claim</button>`
    : '';

  const statusBadge = claimed
    ? '<span class="ach-badge ach-badge-done">Claimed</span>'
    : unlocked
      ? (canClaim ? '<span class="ach-badge ach-badge-ready">Claim</span>' : '<span class="ach-badge ach-badge-done">Done</span>')
      : '<span class="ach-badge ach-badge-progress">Locked</span>';

  return `
    <article class="ach-card ach-card-compact" data-achievement-id="${escapeHtml(definition.id)}">
      <div class="ach-card-icon" aria-hidden="true">${escapeHtml(emoji)}</div>
      <div class="ach-card-body">
        <div class="ach-card-head">
          <h4 class="ach-card-title">${escapeHtml(definition.name)}</h4>
          ${statusBadge}
        </div>
        ${definition.description ? `<p class="ach-card-desc">${escapeHtml(definition.description)}</p>` : ''}
        ${!unlocked ? `
          <div class="ach-progress-wrap">
            <div class="ach-progress-bar"><div class="ach-progress-fill" style="width:${pct}%"></div></div>
            <span class="ach-progress-label">${pct}%</span>
          </div>
        ` : ''}
        ${rewardText && !claimed ? `<p class="ach-card-reward">${rewardText}</p>` : ''}
        ${claimBtn}
      </div>
    </article>
  `;
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

function wireClaimButtons(container, username) {
  container.querySelectorAll('.ach-claim-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const result = claimAchievementReward(username, btn.dataset.achievementId);
      if (result.success) {
        toast.success('Reward claimed!');
        renderProfileAchievements();
        return;
      }
      toast.error(getClaimErrorMessage(result.reason));
    });
  });
}

function wireShowMore(container) {
  container.querySelectorAll('[data-ach-show]').forEach(btn => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.achShow;
      profileShowLimit = raw === 'all' ? Infinity : Number(raw) || DEFAULT_SHOW_COUNT;
      renderProfileAchievements();
    });
  });
}

export function renderProfileAchievements() {
  const container = document.getElementById('profile-achievements');
  if (!container) return;

  const session = auth.getSession();
  if (!session || session.username === '__admin__') {
    container.innerHTML = '';
    return;
  }

  if (!isAchievementSystemEnabled()) {
    container.innerHTML = `
      <section class="profile-achievements-panel profile-panel-muted">
        <header class="profile-achievements-header"><h3>Achievements</h3></header>
        <p class="profile-achievements-empty">Achievements are temporarily unavailable.</p>
      </section>
    `;
    return;
  }

  const username = session.username;
  const definitions = listAchievementDefinitions();
  const playerAchievements = getPlayerAchievements(username);
  const ordered = buildOrderedVisibleAchievements(definitions, playerAchievements);

  if (!ordered.length) {
    container.innerHTML = `
      <section class="profile-achievements-panel">
        <header class="profile-achievements-header"><h3>Achievements</h3></header>
        <p class="profile-achievements-empty">No achievements to show yet.</p>
      </section>
    `;
    return;
  }

  const limit = profileShowLimit === Infinity ? ordered.length : profileShowLimit;
  const visible = ordered.slice(0, limit);
  const cardsHtml = visible.map(d => achievementCardHtml(d, playerAchievements)).join('');

  const showControls = ordered.length > DEFAULT_SHOW_COUNT
    ? `<div class="ach-show-more" role="group" aria-label="Show more achievements">
        <button type="button" class="ach-show-btn${profileShowLimit === 5 ? ' active' : ''}" data-ach-show="5">Show 5</button>
        <button type="button" class="ach-show-btn${profileShowLimit === 10 ? ' active' : ''}" data-ach-show="10">Show 10</button>
        <button type="button" class="ach-show-btn${profileShowLimit === Infinity ? ' active' : ''}" data-ach-show="all">Show All</button>
      </div>`
    : '';

  const unlockedCount = ordered.filter(d => isPlayerUnlocked(playerAchievements, d.id)).length;

  container.innerHTML = `
    <section class="profile-achievements-panel">
      <header class="profile-achievements-header">
        <h3>Achievements</h3>
        <span class="profile-achievements-meta">${unlockedCount} unlocked</span>
      </header>
      <div class="ach-profile-list">${cardsHtml}</div>
      ${showControls}
    </section>
  `;

  wireClaimButtons(container, username);
  wireShowMore(container);
}
