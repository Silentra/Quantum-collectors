/**
 * achievement-preferences.js — Player achievement UI preferences (not unlock state).
 */

import * as db from './database.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} username
 * @returns {string[]}
 */
export function getStarredAchievementIds(username) {
  if (!username) return [];
  const prefs = db.get(`players/${username}/achievementPreferences`);
  const starred = prefs?.starred;
  if (!Array.isArray(starred)) return [];
  return starred.filter(id => typeof id === 'string' && id.trim());
}

/**
 * @param {string} username
 * @param {string} achievementId
 * @returns {boolean} new starred state
 */
export function toggleStarredAchievement(username, achievementId) {
  if (!username || !achievementId) return false;

  const current = getStarredAchievementIds(username);
  const set = new Set(current);
  let starred = false;
  if (set.has(achievementId)) {
    set.delete(achievementId);
    starred = false;
  } else {
    set.add(achievementId);
    starred = true;
  }

  const next = [...set];
  const existing = db.get(`players/${username}/achievementPreferences`);
  db.set(`players/${username}/achievementPreferences`, {
    ...(isObject(existing) ? existing : {}),
    starred: next,
  });
  return starred;
}

export function isAchievementStarred(username, achievementId) {
  return getStarredAchievementIds(username).includes(achievementId);
}
