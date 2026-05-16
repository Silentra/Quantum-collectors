/**
 * Admin Foundation Module
 *
 * Lightweight admin infrastructure for Phase 2 admin dashboard tools.
 * Provides helper functions that require isAdmin check.
 *
 * API:
 *   isAdmin(username)         - Check if a player has admin flag
 *   getPlayer(username)       - Get full player record
 *   setPlayerData(username, path, value) - Set arbitrary player data
 *   listPlayers()             - List all players
 */

import * as db from './database.js';

// ---------- Admin Check ----------

/**
 * Check if a given username has admin privileges.
 * Reads the isAdmin flag from players/{username}.
 * @param {string} username
 * @returns {boolean}
 */
export function isAdmin(username) {
  if (!username) return false;
  const player = db.get(`players/${username}`);
  return player && player.isAdmin === true;
}

// ---------- Player Data Helpers ----------

/**
 * Get full player record by username.
 * @param {string} username
 * @returns {object|null}
 */
export function getPlayer(username) {
  if (!username) return null;
  return db.get(`players/${username}`);
}

/**
 * Set a value at an arbitrary path within a player's record.
 * Example: setPlayerData('alice', 'xp', 500)
 * Example: setPlayerData('alice', 'stats/level', 5)
 * @param {string} username
 * @param {string} path - Dot or slash-separated subpath within the player record
 * @param {*} value
 * @returns {boolean} success
 */
export function setPlayerData(username, path, value) {
  if (!username) return false;
  const player = db.get(`players/${username}`);
  if (!player) return false;

  // Normalize: support both dot and slash paths
  const normalizedPath = path.replace(/\./g, '/');
  const fullPath = `players/${username}/${normalizedPath}`;
  db.set(fullPath, value);
  return true;
}

/**
 * List all players as an array of { username, ...playerData }.
 * @returns {Array<object>}
 */
export function listPlayers() {
  const children = db.getChildren('players');
  return children.map(({ key, value }) => ({
    username: key,
    ...value
  }));
}

// ---------- Admin Flag Management ----------

/**
 * Promote a player to admin.
 * @param {string} username
 * @returns {boolean}
 */
export function promoteToAdmin(username) {
  return setPlayerData(username, 'isAdmin', true);
}

/**
 * Demote a player from admin.
 * @param {string} username
 * @returns {boolean}
 */
export function demoteFromAdmin(username) {
  return setPlayerData(username, 'isAdmin', false);
}
