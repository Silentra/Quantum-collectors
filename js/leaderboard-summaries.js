/**
 * leaderboard-summaries.js — S5d derived live leaderboard projections
 *
 * players/{username} remains canonical for stats. leaderboards/{statKey}/{username}
 * is a derived projection for student live boards (no full players scan).
 *
 * Entry shape: { value, groupId, subgroupId, updatedAt }
 * Username is the leaf key. No displayName / eligibility flags.
 *
 * No mirror listeners — callers merge path builders into acknowledged updates
 * or call syncLeaderboardSummariesForPlayer / rebuildLeaderboardSummaries.
 */

import * as db from './database.js';
import { STAT_TYPES } from './leaderboard-seasons.js';

export const LEADERBOARDS_ROOT = 'leaderboards';

/** Live STAT_TYPES values used by the Leaderboard tab (stable path segments). */
export const LIVE_LEADERBOARD_STAT_TYPES = Object.freeze([
  STAT_TYPES.LIFETIME_RP,
  STAT_TYPES.SEASONAL_RP,
  STAT_TYPES.PROJECTS_COMPLETED,
  STAT_TYPES.PACKS_OPENED,
  STAT_TYPES.TRADES_COMPLETED,
  STAT_TYPES.UNIQUE_CARDS_OWNED,
  STAT_TYPES.BREAKTHROUGHS,
]);

export { STAT_TYPES };

/**
 * Resolve a STAT_TYPES path on a player-like object (shared with live queries).
 * e.g. 'stats.packsOpened' → player.stats.packsOpened
 * @param {object|null|undefined} player
 * @param {string} statType
 * @returns {number}
 */
export function resolveLeaderboardStatValue(player, statType) {
  if (!player || !statType) return 0;
  const parts = String(statType).replace(/\./g, '/').split('/').filter(Boolean);
  let cursor = player;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return 0;
    cursor = cursor[part];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : 0;
}

/**
 * @param {string} statType
 * @param {string} username
 * @returns {string}
 */
export function leaderboardSummaryPath(statType, username) {
  return `${LEADERBOARDS_ROOT}/${statType}/${username}`;
}

/**
 * Set a STAT_TYPES value onto a mutable playerLike (shallow-clones nested objects as needed).
 * @param {object} playerLike
 * @param {string} statType
 * @param {number} value
 */
export function setStatValueOnPlayerLike(playerLike, statType, value) {
  if (!playerLike || !statType) return;
  const parts = String(statType).replace(/\./g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return;
  if (parts.length === 1) {
    playerLike[parts[0]] = value;
    return;
  }
  let cur = playerLike;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const next = cur[part];
    if (!next || typeof next !== 'object') {
      cur[part] = {};
    } else {
      cur[part] = { ...next };
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Clone player and overlay STAT_TYPES → numeric values.
 * @param {object|null|undefined} basePlayer
 * @param {Record<string, number>} overlayByStatType
 * @returns {object}
 */
export function playerLikeWithStatOverlay(basePlayer, overlayByStatType = {}) {
  const p = {
    ...(basePlayer || {}),
    stats: { ...(basePlayer?.stats || {}) },
    researchStats: { ...(basePlayer?.researchStats || {}) },
  };
  for (const [statType, value] of Object.entries(overlayByStatType || {})) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      setStatValueOnPlayerLike(p, statType, value);
    }
  }
  return p;
}

/**
 * @param {string} username
 * @param {object} playerLike
 * @param {string} statType
 * @param {number} [now]
 * @returns {{ value: number, groupId: string|null, subgroupId: string|null, updatedAt: number }}
 */
export function buildLeaderboardSummaryEntry(username, playerLike, statType, now = Date.now()) {
  return {
    value: resolveLeaderboardStatValue(playerLike, statType),
    groupId: playerLike?.groupId ?? null,
    subgroupId: playerLike?.subgroupId ?? null,
    updatedAt: now,
  };
}

/**
 * @param {string} username
 * @param {object} playerLike
 * @param {{ statTypes?: string[], now?: number }} [options]
 * @returns {Record<string, object>}
 */
export function buildLeaderboardSummaryPathsForPlayer(username, playerLike, options = {}) {
  const key = String(username || '').trim();
  if (!key || key === '__admin__') return {};
  const types = Array.isArray(options.statTypes) && options.statTypes.length > 0
    ? options.statTypes
    : LIVE_LEADERBOARD_STAT_TYPES;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  /** @type {Record<string, object>} */
  const updates = {};
  for (const statType of types) {
    updates[leaderboardSummaryPath(statType, key)] = buildLeaderboardSummaryEntry(
      key,
      playerLike,
      statType,
      now,
    );
  }
  return updates;
}

/**
 * @param {string} username
 * @param {object} playerLike
 * @param {string[]} changedStatTypes
 * @param {number} [now]
 * @returns {Record<string, object>}
 */
export function buildLeaderboardSummaryPathsForChangedStats(
  username,
  playerLike,
  changedStatTypes,
  now = Date.now(),
) {
  const types = (Array.isArray(changedStatTypes) ? changedStatTypes : [])
    .filter((t) => typeof t === 'string' && t.length > 0);
  if (types.length === 0) return {};
  return buildLeaderboardSummaryPathsForPlayer(username, playerLike, { statTypes: types, now });
}

/**
 * Refresh group projection on all live summary leaves (scores from playerLike).
 * @param {string} username
 * @param {object} playerLike - must include next groupId/subgroupId and current scores
 * @param {number} [now]
 * @returns {Record<string, object>}
 */
export function buildLeaderboardGroupProjectionPaths(username, playerLike, now = Date.now()) {
  return buildLeaderboardSummaryPathsForPlayer(username, playerLike, { now });
}

/**
 * @param {string} username
 * @returns {Record<string, null>}
 */
export function buildLeaderboardSummaryDeletePaths(username) {
  const key = String(username || '').trim();
  if (!key) return {};
  /** @type {Record<string, null>} */
  const updates = {};
  for (const statType of LIVE_LEADERBOARD_STAT_TYPES) {
    updates[leaderboardSummaryPath(statType, key)] = null;
  }
  return updates;
}

function _entriesEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.value === b.value
    && (a.groupId ?? null) === (b.groupId ?? null)
    && (a.subgroupId ?? null) === (b.subgroupId ?? null);
  // updatedAt intentionally ignored for omit-unchanged
}

/**
 * Local/ack sync for call sites that still use db.set for player stats.
 * @param {string} username
 * @param {{ statTypes?: string[], now?: number }} [options]
 * @returns {Promise<{ ok: boolean, skipped?: boolean, mode?: string, error?: string, written?: number }>}
 */
export async function syncLeaderboardSummariesForPlayer(username, options = {}) {
  const key = String(username || '').trim();
  if (!key || key === '__admin__') {
    return { ok: true, skipped: true, written: 0 };
  }
  const player = db.get(`players/${key}`) || {};
  const desired = buildLeaderboardSummaryPathsForPlayer(key, player, options);
  /** @type {Record<string, object>} */
  const updates = {};
  for (const [path, entry] of Object.entries(desired)) {
    const existing = db.get(path);
    if (!_entriesEqual(existing, entry)) {
      updates[path] = entry;
    }
  }
  if (Object.keys(updates).length === 0) {
    return { ok: true, skipped: true, written: 0 };
  }
  const ack = await db.updateAcknowledged(updates);
  return {
    ok: ack.ok === true,
    mode: ack.mode,
    error: ack.error,
    written: Object.keys(updates).length,
  };
}

/**
 * Admin/dev repair: scan all players once and rewrite drifted/missing summaries.
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped?: boolean,
 *   created: number,
 *   updated: number,
 *   removed: number,
 *   unchanged: number,
 *   written: number,
 *   mode?: string,
 *   error?: string
 * }>}
 */
export async function rebuildLeaderboardSummaries() {
  const players = db.getChildren('players');
  const now = Date.now();
  /** @type {Record<string, object|null>} */
  const updates = {};
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  const desiredKeys = new Set();

  for (const { key: username, value: player } of players) {
    if (username === '__admin__') continue;
    const paths = buildLeaderboardSummaryPathsForPlayer(username, player || {}, { now });
    for (const [path, entry] of Object.entries(paths)) {
      desiredKeys.add(path);
      const existing = db.get(path);
      if (existing == null) {
        updates[path] = entry;
        created += 1;
      } else if (!_entriesEqual(existing, entry)) {
        updates[path] = entry;
        updated += 1;
      } else {
        unchanged += 1;
      }
    }
  }

  // Orphan summary leaves (player gone)
  let removed = 0;
  for (const statType of LIVE_LEADERBOARD_STAT_TYPES) {
    const children = db.getChildren(`${LEADERBOARDS_ROOT}/${statType}`) || [];
    for (const { key: username } of children) {
      const path = leaderboardSummaryPath(statType, username);
      if (desiredKeys.has(path)) continue;
      updates[path] = null;
      removed += 1;
    }
  }

  if (Object.keys(updates).length === 0) {
    return {
      ok: true,
      skipped: true,
      created: 0,
      updated: 0,
      removed: 0,
      unchanged,
      written: 0,
    };
  }

  const ack = await db.updateAcknowledged(updates);
  return {
    ok: ack.ok === true,
    skipped: false,
    created,
    updated,
    removed,
    unchanged,
    written: Object.keys(updates).length,
    mode: ack.mode,
    error: ack.error,
  };
}

/**
 * Whether the leaderboards root has been marked ready by scoped load/subscribe
 * (or root coexistence already populated cache — isPathReady still gates fail-closed).
 * @returns {boolean}
 */
export function areLeaderboardSummariesReady() {
  return db.isPathReady(LEADERBOARDS_ROOT) === true
    || db.get(LEADERBOARDS_ROOT) != null;
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcLeaderboardSummaries = {
    LEADERBOARDS_ROOT,
    LIVE_LEADERBOARD_STAT_TYPES,
    STAT_TYPES,
    rebuildLeaderboardSummaries,
    syncLeaderboardSummariesForPlayer,
    areLeaderboardSummariesReady,
    help() {
      console.info(`Leaderboard summaries (S5d)
Root: ${LEADERBOARDS_ROOT}/{statKey}/{username} = { value, groupId, subgroupId, updatedAt }
Rebuild: qcLeaderboardSummaries.rebuildLeaderboardSummaries()
Sync one: qcLeaderboardSummaries.syncLeaderboardSummariesForPlayer(username)`);
    },
  };
}

_installWindowApi();
