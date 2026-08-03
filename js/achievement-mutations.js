/**
 * achievement-mutations.js
 * Unlock and claim persistence. Not called from gameplay modules.
 */

import * as db from './database.js';
import { getAchievementConfig } from './achievement-config.js';
import {
  evaluateDefinition,
  getAchievementIdsForStats,
  getPendingAchievementIds,
  buildStatIndex,
  isPlayerUnlocked,
} from './achievement-engine.js';
import { getPlayerStat } from './achievement-stats.js';
import { canClaimAchievementReward } from './achievement-validation.js';
import { grantAchievementRewards } from './achievement-rewards.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getPlayerAchievements(username) {
  const raw = db.get(`players/${username}/achievements`);
  return isObject(raw) ? raw : {};
}

function getPlayerSnapshot(username) {
  return {
    achievements: getPlayerAchievements(username),
  };
}

function writeUnlock(username, achievementId, evalResult, now) {
  const entry = buildUnlockEntry(evalResult, now);
  db.set(`players/${username}/achievements/${achievementId}`, entry);
  return entry;
}

function buildUnlockEntry(evalResult, now) {
  return {
    unlocked: true,
    unlockedAt: now,
    progress: evalResult.progress ?? 1,
    progressValue: evalResult.progressValue ?? 0,
    targetValue: evalResult.targetValue ?? 1,
    claimed: false,
    claimedAt: 0,
    lastEvaluatedAt: now,
  };
}

function buildProgressEntryIfChanged(existing, evalResult, now) {
  if (existing?.unlocked === true) return null;

  const progress = evalResult.progress ?? 0;
  const progressValue = evalResult.progressValue ?? 0;
  const targetValue = evalResult.targetValue ?? 1;

  // Persist only when meaningful state changes (or first seed). Do not rewrite for
  // lastEvaluatedAt alone — that caused one set() per pending achievement every login.
  if (
    isObject(existing) &&
    existing.unlocked !== true &&
    Number(existing.progress ?? 0) === Number(progress) &&
    Number(existing.progressValue ?? 0) === Number(progressValue) &&
    Number(existing.targetValue ?? 1) === Number(targetValue) &&
    existing.claimed !== true
  ) {
    return null;
  }

  return {
    unlocked: false,
    unlockedAt: 0,
    progress,
    progressValue,
    targetValue,
    claimed: false,
    claimedAt: 0,
    lastEvaluatedAt: now,
  };
}

function writeProgress(username, achievementId, evalResult, now) {
  const existing = db.get(`players/${username}/achievements/${achievementId}`);
  if (isPlayerUnlocked({ [achievementId]: existing }, achievementId)) return;

  const entry = buildProgressEntryIfChanged(existing, evalResult, now);
  if (!entry) return;
  db.set(`players/${username}/achievements/${achievementId}`, entry);
}

/**
 * Pure achievement write plan for given stat keys — reuses evaluateDefinition /
 * buildStatIndex / dirty progress rules. Does not write to the DB.
 *
 * @param {string} username
 * @param {string[]} statKeys
 * @param {Object} [options]
 * @param {(statKey: string) => number} [options.getStat] - override live DB stats (planned overlay)
 * @param {Object} [options.playerAchievements] - override live achievement map
 * @param {number} [options.now]
 * @returns {{ updates: Object<string, Object>, unlocked: string[], notified: string[] }}
 */
export function planAchievementUpdatesForStats(username, statKeys = [], options = {}) {
  const empty = { updates: {}, unlocked: [], notified: [] };
  if (!username || !statKeys.length) return empty;

  const config = getAchievementConfig();
  if (config.meta.enabled === false) return empty;

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const playerAchievements = isObject(options.playerAchievements)
    ? options.playerAchievements
    : getPlayerAchievements(username);
  const getStat = typeof options.getStat === 'function'
    ? options.getStat
    : (statKey => getPlayerStat(username, statKey));

  const index = buildStatIndex(config.definitions);
  const achievementIds = getAchievementIdsForStats(index, statKeys);
  if (!achievementIds.length) return empty;

  const updates = {};
  const unlocked = [];
  const notified = [];

  for (const achievementId of achievementIds) {
    const definition = config.definitions[achievementId];
    if (!definition?.enabled) continue;
    if (isPlayerUnlocked(playerAchievements, achievementId)) continue;

    const evalResult = evaluateDefinition(definition, getStat);
    const path = `players/${username}/achievements/${achievementId}`;

    if (evalResult.met) {
      updates[path] = buildUnlockEntry(evalResult, now);
      unlocked.push(achievementId);
      if (definition.notifyOnUnlock) notified.push(achievementId);
    } else {
      const existing = playerAchievements[achievementId];
      const entry = buildProgressEntryIfChanged(existing, evalResult, now);
      if (entry) updates[path] = entry;
    }
  }

  return { updates, unlocked, notified };
}

/**
 * Evaluate specific achievement ids only.
 * @param {string} username
 * @param {string[]} achievementIds
 * @param {Object} [options]
 * @returns {{ unlocked: string[], notified: string[] }}
 */
export function evaluateAchievementIds(username, achievementIds = [], options = {}) {
  if (!username || !achievementIds.length) {
    return { unlocked: [], notified: [] };
  }

  const config = getAchievementConfig();
  if (config.meta.enabled === false) {
    return { unlocked: [], notified: [] };
  }

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const playerAchievements = getPlayerAchievements(username);
  const getStat = statKey => getPlayerStat(username, statKey);

  // Reuse planner via a synthetic stat-key path: evaluate the explicit id list directly
  // while keeping unlock/progress entry builders shared with pack-open planning.
  const unlocked = [];
  const notified = [];

  for (const achievementId of achievementIds) {
    const definition = config.definitions[achievementId];
    if (!definition?.enabled) continue;
    if (isPlayerUnlocked(playerAchievements, achievementId)) continue;

    const evalResult = evaluateDefinition(definition, getStat);
    if (evalResult.met) {
      writeUnlock(username, achievementId, evalResult, now);
      unlocked.push(achievementId);
      if (definition.notifyOnUnlock) notified.push(achievementId);
    } else {
      writeProgress(username, achievementId, evalResult, now);
    }
  }

  return { unlocked, notified };
}

/**
 * Evaluate only achievements indexed for the given stat keys.
 */
export function evaluateAchievementsForStats(username, statKeys = [], options = {}) {
  const plan = planAchievementUpdatesForStats(username, statKeys, options);
  for (const [path, value] of Object.entries(plan.updates)) {
    db.set(path, value);
  }
  return { unlocked: plan.unlocked, notified: plan.notified };
}

/**
 * Login: evaluate all enabled achievements not yet unlocked (once per session restore).
 */
export function evaluateAchievementsOnLogin(username, options = {}) {
  const config = getAchievementConfig();
  if (config.meta.enabled === false) return { unlocked: [], notified: [] };

  const playerAchievements = getPlayerAchievements(username);
  const pending = getPendingAchievementIds(config.definitions, playerAchievements);
  return evaluateAchievementIds(username, pending, options);
}

/**
 * Claim rewards for an unlocked achievement.
 */
export function claimAchievementReward(username, achievementId) {
  if (!username || !achievementId) {
    return { success: false, reason: 'invalid_request' };
  }

  const config = getAchievementConfig();
  const definition = config.definitions[achievementId];
  if (!definition) {
    return { success: false, reason: 'definition_not_found' };
  }

  const player = getPlayerSnapshot(username);
  const validation = canClaimAchievementReward(player, definition, achievementId);
  if (!validation.allowed) {
    return { success: false, reason: validation.reason };
  }

  const grantResult = grantAchievementRewards(username, definition.rewards);
  if (!grantResult.success) {
    return { success: false, reason: grantResult.reason, grantResult };
  }

  const now = Date.now();
  db.update(`players/${username}/achievements/${achievementId}`, {
    claimed: true,
    claimedAt: now,
  });

  return { success: true, achievementId, grantResult };
}
