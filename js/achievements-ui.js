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
import {
  getStarredAchievementIds,
  toggleStarredAchievement,
} from './achievement-preferences.js';
import { getCosmeticDefinition, getItemDefinition } from './cosmetic-definitions.js';

const DEFAULT_SHOW_COUNT = 5;
const SHOW_LIMIT_STORAGE_KEY = 'qc_profile_ach_show_limit';

function loadShowLimit() {
  try {
    const raw = localStorage.getItem(SHOW_LIMIT_STORAGE_KEY);
    if (raw === 'all') return Infinity;
    const n = Number(raw);
    if (n === 10) return 10;
    if (n === 5) return 5;
  } catch {
    /* ignore */
  }
  return DEFAULT_SHOW_COUNT;
}

function saveShowLimit(limit) {
  try {
    const value = limit === Infinity ? 'all' : String(limit);
    localStorage.setItem(SHOW_LIMIT_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
}

let profileShowLimit = loadShowLimit();

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
    const def = reward.type === 'cosmetic'
      ? getCosmeticDefinition(reward.itemId)
      : getItemDefinition(reward.itemId);
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
 * Starred unlocked → normal unlocked (newest) → locked visible (admin sortOrder).
 * Hidden+locked omitted entirely.
 */
function filterStarredIds(starredIds, definitions) {
  const validIds = new Set(definitions.map(d => d.id));
  return starredIds.filter(id => validIds.has(id));
}

function buildOrderedVisibleAchievements(definitions, playerAchievements, starredIds) {
  const starredSet = new Set(starredIds);
  const starredUnlocked = [];
  const normalUnlocked = [];
  const lockedVisible = [];

  for (const def of definitions) {
    if (!def?.enabled) continue;
    const unlockedFlag = isPlayerUnlocked(playerAchievements, def.id);
    if (!unlockedFlag && def.hidden === true) continue;
    if (unlockedFlag) {
      if (starredSet.has(def.id)) starredUnlocked.push(def);
      else normalUnlocked.push(def);
    } else {
      lockedVisible.push(def);
    }
  }

  starredUnlocked.sort((a, b) => {
    const ai = starredIds.indexOf(a.id);
    const bi = starredIds.indexOf(b.id);
    if (ai !== bi) return ai - bi;
    return getUnlockedAt(playerAchievements, b.id) - getUnlockedAt(playerAchievements, a.id);
  });
  normalUnlocked.sort((a, b) => getUnlockedAt(playerAchievements, b.id) - getUnlockedAt(playerAchievements, a.id));
  lockedVisible.sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));

  return [...starredUnlocked, ...normalUnlocked, ...lockedVisible];
}

function achievementRowHtml(definition, playerAchievements, username, starredIds) {
  const entry = getEntry(playerAchievements, definition.id);
  const unlocked = isPlayerUnlocked(playerAchievements, definition.id);
  const claimed = isPlayerClaimed(playerAchievements, definition.id);
  const emoji = (definition.icon?.emoji || '').trim() || '🏆';
  const pct = progressPercent(entry);
  const canClaim = unlocked && !claimed && (definition.rewards?.length > 0);
  const starred = starredIds.includes(definition.id);
  const rewardText = escapeHtml(rewardsSummary(definition));

  const claimBtn = canClaim
    ? `<button type="button" class="ach-claim-btn" data-achievement-id="${escapeHtml(definition.id)}">Claim</button>`
    : '';

  const starBtn = unlocked
    ? `<button type="button" class="ach-star-btn${starred ? ' ach-star-btn-active' : ''}" data-achievement-id="${escapeHtml(definition.id)}" aria-label="${starred ? 'Unstar' : 'Star'} achievement" title="${starred ? 'Unstar' : 'Star'}">${starred ? '★' : '☆'}</button>`
    : '';

  const descLine = definition.description
    ? `<span class="ach-row-desc">${escapeHtml(definition.description)}</span>`
    : '';

  const progressBlock = !unlocked
    ? `<div class="ach-row-progress">
        <div class="ach-progress-bar"><div class="ach-progress-fill" style="width:${pct}%"></div></div>
        <span class="ach-progress-label">${pct}%</span>
      </div>`
    : (canClaim || rewardText
      ? `<div class="ach-row-actions">${rewardText && !claimed ? `<span class="ach-row-reward">${rewardText}</span>` : ''}${claimBtn}</div>`
      : (claimed ? '<span class="ach-row-status">Claimed</span>' : ''));

  return `
    <article class="ach-row" data-achievement-id="${escapeHtml(definition.id)}">
      <span class="ach-row-icon" aria-hidden="true">${escapeHtml(emoji)}</span>
      <div class="ach-row-main">
        <span class="ach-row-title">${escapeHtml(definition.name)}</span>
        ${descLine}
        ${progressBlock}
      </div>
      ${starBtn}
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

function wireStarButtons(container, username) {
  container.querySelectorAll('.ach-star-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleStarredAchievement(username, btn.dataset.achievementId);
      renderProfileAchievements();
    });
  });
}

function wireShowMore(container) {
  container.querySelectorAll('[data-ach-show]').forEach(btn => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.achShow;
      profileShowLimit = raw === 'all' ? Infinity : Number(raw) || DEFAULT_SHOW_COUNT;
      saveShowLimit(profileShowLimit);
      renderProfileAchievements();
    });
  });
}

function showMoreControlsHtml(totalCount) {
  if (totalCount <= DEFAULT_SHOW_COUNT) return '';
  const limit = profileShowLimit === Infinity ? 'all' : profileShowLimit;
  return `
    <div class="ach-show-more" role="group" aria-label="Show achievements">
      <button type="button" class="ach-show-btn${limit === 5 ? ' active' : ''}" data-ach-show="5">Show 5</button>
      <button type="button" class="ach-show-btn${limit === 10 ? ' active' : ''}" data-ach-show="10">Show 10</button>
      <button type="button" class="ach-show-btn${limit === 'all' ? ' active' : ''}" data-ach-show="all">Show All</button>
    </div>
  `;
}

export function renderProfileAchievements() {
  const container = document.getElementById('profile-achievements');
  if (!container) return;

  profileShowLimit = loadShowLimit();

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
  const starredIds = filterStarredIds(getStarredAchievementIds(username), definitions);
  const ordered = buildOrderedVisibleAchievements(definitions, playerAchievements, starredIds);

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
  const rowsHtml = visible.map(d => achievementRowHtml(d, playerAchievements, username, starredIds)).join('');
  const showControls = showMoreControlsHtml(ordered.length);
  const unlockedCount = ordered.filter(d => isPlayerUnlocked(playerAchievements, d.id)).length;

  container.innerHTML = `
    <section class="profile-achievements-panel">
      <header class="profile-achievements-header">
        <h3>Achievements</h3>
        <span class="profile-achievements-meta">${unlockedCount} unlocked</span>
      </header>
      ${showControls}
      <div class="ach-profile-list">${rowsHtml}</div>
    </section>
  `;

  wireClaimButtons(container, username);
  wireStarButtons(container, username);
  wireShowMore(container);
}
