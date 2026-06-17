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
  const entry = {
    unlocked: true,
    unlockedAt: now,
    progress: evalResult.progress ?? 1,
    progressValue: evalResult.progressValue ?? 0,
    targetValue: evalResult.targetValue ?? 1,
    claimed: false,
    claimedAt: 0,
    lastEvaluatedAt: now,
  };
  db.set(`players/${username}/achievements/${achievementId}`, entry);
  return entry;
}

function writeProgress(username, achievementId, evalResult, now) {
  const existing = db.get(`players/${username}/achievements/${achievementId}`);
  if (isPlayerUnlocked({ [achievementId]: existing }, achievementId)) return;

  const entry = {
    unlocked: false,
    unlockedAt: 0,
    progress: evalResult.progress ?? 0,
    progressValue: evalResult.progressValue ?? 0,
    targetValue: evalResult.targetValue ?? 1,
    claimed: false,
    claimedAt: 0,
    lastEvaluatedAt: now,
  };
  db.set(`players/${username}/achievements/${achievementId}`, entry);
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
  const config = getAchievementConfig();
  if (config.meta.enabled === false || !statKeys.length) {
    return { unlocked: [], notified: [] };
  }

  const index = buildStatIndex(config.definitions);
  const achievementIds = getAchievementIdsForStats(index, statKeys);
  return evaluateAchievementIds(username, achievementIds, options);
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
