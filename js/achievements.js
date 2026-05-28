/**
 * achievements.js
 * Public facade: stat bumps for gameplay, evaluation, init.
 * Gameplay modules MUST only call bumpPlayerStat / notify* helpers here — never unlock directly.
 */

import {
  applyStatChange,
  ensureAchievementStats,
  healDerivedAchievementStats,
  recordBreakthrough,
  recordCardInventoryChange,
  recordCardInventoryGain,
  recordProjectResolution,
  refreshCosmeticsEquipped,
  STAT_KEYS,
} from './achievement-stats.js';
import {
  evaluateAchievementsForStats,
  evaluateAchievementsOnLogin,
} from './achievement-mutations.js';
import { getAchievementConfig, isAchievementSystemEnabled } from './achievement-config.js';
import { claimAchievementReward as claimRewardMutation } from './achievement-mutations.js';
import * as toast from './toast.js';

let loginEvaluatedForSession = null;

function runEvaluation(username, statKeys, options = {}) {
  if (!username || !isAchievementSystemEnabled()) {
    return { unlocked: [], notified: [] };
  }
  const result = evaluateAchievementsForStats(username, statKeys, options);
  for (const achievementId of result.notified) {
    const def = getAchievementConfig().definitions[achievementId];
    if (def?.name) {
      toast.success(`Achievement unlocked: ${def.name}`);
    }
  }
  return result;
}

/**
 * Primary gameplay API — bump a registered stat and evaluate only related achievements.
 */
export function bumpPlayerStat(username, statKey, delta = 1, options = {}) {
  if (!username || !statKey) {
    return { changed: false, statKey, value: 0 };
  }

  ensureAchievementStats(username);
  const change = applyStatChange(username, statKey, delta, options);
  if (change.changed) {
    runEvaluation(username, [statKey], options);
  }
  return change;
}

/**
 * Notify evaluation after multi-stat updates (e.g. card gain).
 */
export function notifyStatsChanged(username, statKeys = [], options = {}) {
  if (!username || !statKeys.length) return { unlocked: [], notified: [] };
  return runEvaluation(username, [...new Set(statKeys)], options);
}

/**
 * Project completed or failed — updates streak + best streak + projects on success.
 */
export function recordProjectOutcome(username, success) {
  const result = recordProjectResolution(username, success);
  const statKeys = [...new Set(result.statKeys || [])];
  if (statKeys.length) {
    return runEvaluation(username, statKeys);
  }
  return { unlocked: [], notified: [] };
}

/**
 * Card added to inventory — discovery + aura tier + unique count.
 */
export function recordCardCollectionGain(username, cardId, previousQuantity, newQuantity) {
  const result = recordCardInventoryGain(username, cardId, newQuantity, { previousQuantity });
  const statKeys = result.statKeys || [];
  if (statKeys.length) {
    return runEvaluation(username, statKeys);
  }
  return { unlocked: [], notified: [] };
}

/**
 * Inventory lost or traded — refresh derived card stats (unique count, max-aura count).
 */
export function notifyCardInventoryChanged(username) {
  const result = recordCardInventoryChange(username);
  const statKeys = result.statKeys || [];
  if (statKeys.length) {
    return runEvaluation(username, statKeys);
  }
  return { unlocked: [], notified: [] };
}

/**
 * Equip/unequip — refresh cosmeticsEquipped from live profile slots.
 */
export function notifyEquippedCosmeticsChanged(username) {
  const refresh = refreshCosmeticsEquipped(username);
  if (refresh.changed) {
    return runEvaluation(username, [STAT_KEYS.COSMETICS_EQUIPPED]);
  }
  return { unlocked: [], notified: [] };
}

/**
 * Breakthrough earned (call in addition to recordProjectOutcome on success if needed).
 */
export function recordBreakthroughEarned(username) {
  const change = recordBreakthrough(username);
  if (change.changed) {
    return runEvaluation(username, [STAT_KEYS.BREAKTHROUGHS_ACHIEVED]);
  }
  return { unlocked: [], notified: [] };
}

export function claimAchievementReward(username, achievementId) {
  return claimRewardMutation(username, achievementId);
}

export function resetLoginAchievementEvaluation() {
  loginEvaluatedForSession = null;
}

export function runLoginAchievementEvaluation(username) {
  if (!username || !isAchievementSystemEnabled()) {
    return { unlocked: [], notified: [] };
  }
  if (loginEvaluatedForSession === username) {
    return { unlocked: [], notified: [] };
  }
  loginEvaluatedForSession = username;
  ensureAchievementStats(username);
  const healedKeys = healDerivedAchievementStats(username);
  if (healedKeys.length) {
    runEvaluation(username, healedKeys);
  }
  const result = evaluateAchievementsOnLogin(username);
  for (const achievementId of result.notified) {
    const def = getAchievementConfig().definitions[achievementId];
    if (def?.name) toast.success(`Achievement unlocked: ${def.name}`);
  }
  return result;
}

export function initAchievements() {
  const config = getAchievementConfig();
  console.log(`[Achievements] Loaded ${Object.keys(config.definitions).length} definition(s); enabled=${config.meta.enabled !== false}`);
}

export { STAT_KEYS };
export { getAchievementConfig, listAchievementDefinitions } from './achievement-config.js';
export { evaluateAchievementsForStats } from './achievement-mutations.js';
