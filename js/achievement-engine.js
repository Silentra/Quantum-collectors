/**
 * achievement-engine.js
 * Pure evaluation: simple stat conditions only. No JS eval, no formulas.
 */

import { listRegisteredStatKeys } from './achievement-stats.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compare(op, current, target) {
  switch (op) {
    case 'gte': return current >= target;
    case 'lte': return current <= target;
    case 'eq': return current === target;
    case 'gt': return current > target;
    case 'lt': return current < target;
    default: return false;
  }
}

/**
 * @param {Object} condition
 * @param {Function} getStat
 * @returns {{ met: boolean, progressValue: number, targetValue: number }}
 */
export function evaluateCondition(condition, getStat) {
  if (!condition?.stat || !condition?.op) {
    return { met: false, progressValue: 0, targetValue: 0 };
  }

  const current = Number(getStat(condition.stat)) || 0;
  const target = Number(condition.value) || 0;
  const met = compare(condition.op, current, target);

  let progressValue = current;
  let progressTarget = target;
  if (condition.op === 'gte' || condition.op === 'gt') {
    progressTarget = target;
    progressValue = current;
  } else if (condition.op === 'lte' || condition.op === 'lt') {
    progressTarget = target;
    progressValue = current;
  } else {
    progressTarget = 1;
    progressValue = met ? 1 : 0;
  }

  return { met, progressValue, targetValue: progressTarget };
}

/**
 * @param {Object} definition
 * @param {Function} getStat
 */
export function evaluateDefinition(definition, getStat) {
  const conditions = Array.isArray(definition?.conditions) ? definition.conditions : [];
  if (!conditions.length) {
    return { met: false, progressValue: 0, targetValue: 0, conditionResults: [] };
  }

  const conditionResults = conditions.map(c => evaluateCondition(c, getStat));
  const mode = definition.conditionMode === 'any' ? 'any' : 'all';
  const met = mode === 'any'
    ? conditionResults.some(r => r.met)
    : conditionResults.every(r => r.met);

  const primary = conditionResults[0] || { progressValue: 0, targetValue: 0 };
  const progressValue = primary.progressValue;
  const targetValue = primary.targetValue || 1;
  const progress = targetValue > 0 ? Math.min(1, progressValue / targetValue) : (met ? 1 : 0);

  return {
    met,
    progressValue,
    targetValue,
    progress,
    conditionResults,
  };
}

/**
 * Build statKey -> achievementId[] index from enabled definitions.
 * @param {Object} definitions
 * @returns {Map<string, string[]>}
 */
export function buildStatIndex(definitions = {}) {
  const index = new Map();
  const validStats = new Set(listRegisteredStatKeys());

  for (const def of Object.values(definitions)) {
    if (!def?.enabled || !def?.id) continue;
    const statsUsed = new Set();
    for (const cond of def.conditions || []) {
      if (!cond?.stat || !validStats.has(cond.stat)) continue;
      statsUsed.add(cond.stat);
    }
    for (const stat of statsUsed) {
      if (!index.has(stat)) index.set(stat, []);
      index.get(stat).push(def.id);
    }
  }

  return index;
}

/**
 * Collect achievement ids to evaluate for given stat keys (deduped).
 * @param {Map<string, string[]>} index
 * @param {string[]} statKeys
 * @returns {string[]}
 */
export function getAchievementIdsForStats(index, statKeys = []) {
  const ids = new Set();
  for (const statKey of statKeys) {
    const list = index.get(statKey);
    if (!list) continue;
    for (const id of list) ids.add(id);
  }
  return [...ids];
}

/**
 * Login scope: enabled definitions not yet unlocked.
 * @param {Object} definitions
 * @param {Object} playerAchievements
 */
export function getPendingAchievementIds(definitions, playerAchievements = {}) {
  const pending = [];
  for (const def of Object.values(definitions)) {
    if (!def?.enabled || !def?.id) continue;
    if (isPlayerUnlocked(playerAchievements, def.id)) continue;
    pending.push(def.id);
  }
  return pending;
}

export function isPlayerUnlocked(playerAchievements, achievementId) {
  const entry = playerAchievements?.[achievementId];
  if (entry === true) return true;
  if (isObject(entry)) {
    return entry.unlocked === true || entry.completed === true || entry.earned === true;
  }
  return false;
}

export function isPlayerClaimed(playerAchievements, achievementId) {
  const entry = playerAchievements?.[achievementId];
  return isObject(entry) && entry.claimed === true;
}
