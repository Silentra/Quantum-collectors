/**
 * leaderboard-summaries.js — S5d derived live leaderboard projections
 *
 * players/{username} remains canonical for stats. leaderboards/{statKey}/{username}
 * is a derived projection for student live boards (no full players scan).
 *
 * Entry shape: { value, groupId, subgroupId, updatedAt }
 * Username is the leaf key. No displayName / eligibility flags.
 *
 * Firebase path segment = Firebase-safe `statKey` (no ".").
 * Player value source = separate `playerPath` (may use "." nesting).
 * Callers may pass either form; all path construction goes through normalizeLeaderboardStatKey.
 *
 * No mirror listeners — callers merge path builders into acknowledged updates
 * or call syncLeaderboardSummariesForPlayer / rebuildLeaderboardSummaries.
 */

import * as db from './database.js';
import { STAT_TYPES } from './leaderboard-seasons.js';

export const LEADERBOARDS_ROOT = 'leaderboards';

/**
 * Canonical live summary matrix (single source of truth).
 * statKey = RTDB path segment under leaderboards/
 * playerPath = nested player field used only for value resolution
 */
export const LEADERBOARD_STAT_DEFS = Object.freeze({
  totalResearchPoints: { playerPath: 'totalResearchPoints' },
  seasonalResearchPoints: { playerPath: 'seasonalResearchPoints' },
  projectsCompleted: { playerPath: 'projectsCompleted' },
  packsOpened: { playerPath: 'stats.packsOpened' },
  tradesCompleted: { playerPath: 'stats.tradesCompleted' },
  uniqueCardsOwned: { playerPath: 'stats.uniqueCardsOwned' },
  breakthroughs: { playerPath: 'researchStats.breakthroughs' },
});

/** Firebase-safe live summary keys (stable order). */
export const LIVE_LEADERBOARD_STAT_KEYS = Object.freeze(Object.keys(LEADERBOARD_STAT_DEFS));

/** @deprecated Prefer LIVE_LEADERBOARD_STAT_KEYS — kept as alias for early S5d call sites. */
export const LIVE_LEADERBOARD_STAT_TYPES = LIVE_LEADERBOARD_STAT_KEYS;

/** playerPath / legacy STAT_TYPES value → Firebase-safe statKey */
const PLAYER_PATH_TO_STAT_KEY = Object.freeze(
  Object.fromEntries(
    Object.entries(LEADERBOARD_STAT_DEFS).map(([statKey, def]) => [def.playerPath, statKey]),
  ),
);

/** Illegal RTDB key characters (Firebase rejects "." among others). */
const ILLEGAL_RTDB_KEY_CHARS = /[.#$\[\]]/;

/**
 * @param {string} segment
 * @returns {string}
 */
export function assertFirebaseSafeKey(segment) {
  const key = String(segment ?? '');
  if (!key || ILLEGAL_RTDB_KEY_CHARS.test(key)) {
    throw new Error(
      `[LeaderboardSummaries] Illegal RTDB key segment: ${JSON.stringify(segment)} `
      + '(keys cannot contain ".", "#", "$", "[", or "]")',
    );
  }
  return key;
}

/**
 * Normalize any accepted live-stat identifier to the Firebase-safe statKey.
 * Accepts: safe key, playerPath, or legacy STAT_TYPES value.
 * @param {string} input
 * @returns {string|null}
 */
export function normalizeLeaderboardStatKey(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (Object.prototype.hasOwnProperty.call(LEADERBOARD_STAT_DEFS, raw)) return raw;
  if (Object.prototype.hasOwnProperty.call(PLAYER_PATH_TO_STAT_KEY, raw)) {
    return PLAYER_PATH_TO_STAT_KEY[raw];
  }
  return null;
}

/**
 * @param {string} input - safe key, playerPath, or STAT_TYPES value
 * @returns {string|null}
 */
export function playerPathForLeaderboardStat(input) {
  const statKey = normalizeLeaderboardStatKey(input);
  if (!statKey) return null;
  return LEADERBOARD_STAT_DEFS[statKey].playerPath;
}

export { STAT_TYPES };

/**
 * Resolve a live LB stat on a player-like object via canonical playerPath.
 * @param {object|null|undefined} player
 * @param {string} statInput - Firebase-safe key or playerPath / STAT_TYPES
 * @returns {number}
 */
export function resolveLeaderboardStatValue(player, statInput) {
  if (!player || !statInput) return 0;
  const playerPath = playerPathForLeaderboardStat(statInput) || String(statInput);
  const parts = String(playerPath).replace(/\./g, '/').split('/').filter(Boolean);
  let cursor = player;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return 0;
    cursor = cursor[part];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : 0;
}

/**
 * @param {string} statInput - safe key or playerPath / STAT_TYPES
 * @param {string} username
 * @returns {string}
 */
export function leaderboardSummaryPath(statInput, username) {
  const statKey = normalizeLeaderboardStatKey(statInput);
  if (!statKey) {
    throw new Error(
      `[LeaderboardSummaries] Unknown leaderboard stat: ${JSON.stringify(statInput)}`,
    );
  }
  assertFirebaseSafeKey(statKey);
  const user = assertFirebaseSafeKey(String(username || '').trim());
  return `${LEADERBOARDS_ROOT}/${statKey}/${user}`;
}

/**
 * Set a live LB stat onto a mutable playerLike using canonical playerPath.
 * @param {object} playerLike
 * @param {string} statInput
 * @param {number} value
 */
export function setStatValueOnPlayerLike(playerLike, statInput, value) {
  if (!playerLike || !statInput) return;
  const playerPath = playerPathForLeaderboardStat(statInput) || String(statInput);
  const parts = String(playerPath).replace(/\./g, '/').split('/').filter(Boolean);
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
 * Clone player and overlay live-stat identifiers → numeric values.
 * Overlay keys may be safe keys or playerPaths / STAT_TYPES values.
 * @param {object|null|undefined} basePlayer
 * @param {Record<string, number>} overlayByStat
 * @returns {object}
 */
export function playerLikeWithStatOverlay(basePlayer, overlayByStat = {}) {
  const p = {
    ...(basePlayer || {}),
    stats: { ...(basePlayer?.stats || {}) },
    researchStats: { ...(basePlayer?.researchStats || {}) },
  };
  for (const [statInput, value] of Object.entries(overlayByStat || {})) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      setStatValueOnPlayerLike(p, statInput, value);
    }
  }
  return p;
}

/**
 * Resolve group projection fields the same way as playerDirectory (legacy `group` / `subgroup`).
 * @param {object|null|undefined} playerLike
 * @returns {{ groupId: string|null, subgroupId: string|null }}
 */
export function resolveLeaderboardGroupFields(playerLike) {
  const p = playerLike && typeof playerLike === 'object' ? playerLike : {};
  const groupId = p.groupId != null && p.groupId !== ''
    ? String(p.groupId)
    : (p.group != null && p.group !== '' ? String(p.group) : null);
  const subgroupId = p.subgroupId != null && p.subgroupId !== ''
    ? String(p.subgroupId)
    : (p.subgroup != null && p.subgroup !== '' ? String(p.subgroup) : null);
  return { groupId, subgroupId };
}

/**
 * @param {string} username
 * @param {object} playerLike
 * @param {string} statInput
 * @param {number} [now]
 * @returns {{ value: number, groupId: string|null, subgroupId: string|null, updatedAt: number }}
 */
export function buildLeaderboardSummaryEntry(username, playerLike, statInput, now = Date.now()) {
  const { groupId, subgroupId } = resolveLeaderboardGroupFields(playerLike);
  return {
    value: resolveLeaderboardStatValue(playerLike, statInput),
    groupId,
    subgroupId,
    updatedAt: now,
  };
}

/**
 * Settlement-safe tradesCompleted LB sync: ServerValue.increment(1) on value only.
 * Does not read or absolute-write canonical/player-stat cache.
 * Also writes groupId/subgroupId from available playerLike (trade-visible or own)
 * so a missing row becomes a complete first-trade projection (value resolves to 1).
 *
 * @param {string} username
 * @param {object|null|undefined} playerLike
 * @param {number} [now]
 * @returns {Record<string, unknown>}
 */
export function buildTradesCompletedLeaderboardIncrementPaths(username, playerLike, now = Date.now()) {
  const key = String(username || '').trim();
  if (!key) return {};
  const base = leaderboardSummaryPath('tradesCompleted', key);
  const { groupId, subgroupId } = resolveLeaderboardGroupFields(playerLike);
  return {
    [`${base}/value`]: { '.sv': { increment: 1 } },
    [`${base}/updatedAt`]: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
    [`${base}/groupId`]: groupId,
    [`${base}/subgroupId`]: subgroupId,
  };
}

/**
 * @param {string[]} inputs
 * @returns {string[]}
 */
function _normalizeStatKeyList(inputs) {
  const out = [];
  const seen = new Set();
  for (const input of inputs || []) {
    const key = normalizeLeaderboardStatKey(input);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * @param {string} username
 * @param {object} playerLike
 * @param {{ statTypes?: string[], statKeys?: string[], now?: number }} [options]
 * @returns {Record<string, object>}
 */
export function buildLeaderboardSummaryPathsForPlayer(username, playerLike, options = {}) {
  const key = String(username || '').trim();
  if (!key || key === '__admin__') return {};
  const rawList = Array.isArray(options.statKeys) && options.statKeys.length > 0
    ? options.statKeys
    : (Array.isArray(options.statTypes) && options.statTypes.length > 0
      ? options.statTypes
      : LIVE_LEADERBOARD_STAT_KEYS);
  const types = _normalizeStatKeyList(rawList);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  /** @type {Record<string, object>} */
  const updates = {};
  for (const statKey of types) {
    updates[leaderboardSummaryPath(statKey, key)] = buildLeaderboardSummaryEntry(
      key,
      playerLike,
      statKey,
      now,
    );
  }
  return updates;
}

/**
 * @param {string} username
 * @param {object} playerLike
 * @param {string[]} changedStats - Firebase-safe keys and/or playerPaths / STAT_TYPES
 * @param {number} [now]
 * @returns {Record<string, object>}
 */
export function buildLeaderboardSummaryPathsForChangedStats(
  username,
  playerLike,
  changedStats,
  now = Date.now(),
) {
  const types = _normalizeStatKeyList(
    (Array.isArray(changedStats) ? changedStats : [])
      .filter((t) => typeof t === 'string' && t.length > 0),
  );
  if (types.length === 0) return {};
  return buildLeaderboardSummaryPathsForPlayer(username, playerLike, { statKeys: types, now });
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
  for (const statKey of LIVE_LEADERBOARD_STAT_KEYS) {
    updates[leaderboardSummaryPath(statKey, key)] = null;
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
 * @param {{ statTypes?: string[], statKeys?: string[], now?: number }} [options]
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

  // Orphan summary leaves (player gone) under Firebase-safe keys only
  let removed = 0;
  for (const statKey of LIVE_LEADERBOARD_STAT_KEYS) {
    const children = db.getChildren(`${LEADERBOARDS_ROOT}/${statKey}`) || [];
    for (const { key: username } of children) {
      const path = leaderboardSummaryPath(statKey, username);
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
    LEADERBOARD_STAT_DEFS,
    LIVE_LEADERBOARD_STAT_KEYS,
    LIVE_LEADERBOARD_STAT_TYPES,
    STAT_TYPES,
    normalizeLeaderboardStatKey,
    playerPathForLeaderboardStat,
    assertFirebaseSafeKey,
    rebuildLeaderboardSummaries,
    syncLeaderboardSummariesForPlayer,
    areLeaderboardSummariesReady,
    resolveLeaderboardGroupFields,
    buildTradesCompletedLeaderboardIncrementPaths,
    help() {
      console.info(`Leaderboard summaries (S5d)
Root: ${LEADERBOARDS_ROOT}/{statKey}/{username} = { value, groupId, subgroupId, updatedAt }
statKeys: ${LIVE_LEADERBOARD_STAT_KEYS.join(', ')}
Rebuild: qcLeaderboardSummaries.rebuildLeaderboardSummaries()
  (also removes orphan leaves for deleted players)
Sync one: qcLeaderboardSummaries.syncLeaderboardSummariesForPlayer(username)
Trade settle: buildTradesCompletedLeaderboardIncrementPaths (LB value +1)
Inspect: qcDbHydration.getCached('leaderboards')`);
    },
  };
}

_installWindowApi();
