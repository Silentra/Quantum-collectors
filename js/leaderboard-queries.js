/**
 * leaderboard-queries.js
 * Phase LB-1 — Reusable, side-effect-free leaderboard query helpers.
 *
 * All functions:
 *   - Are pure reads (no writes to DB)
 *   - Support groupId and subgroupId filtering
 *   - Support lifetime vs seasonal stat modes
 *   - Support multiple stat types (not just RP)
 *   - Return sorted arrays, stable-tie-broken by username
 *   - Never throw — bad inputs return empty arrays or safe fallbacks
 *
 * Relies on:
 *   - database.js for player + season data
 *   - leaderboard-seasons.js for season storage
 *   - STAT_TYPES constant (re-exported here for convenience)
 */

import * as db from './database.js';
import {
  STAT_TYPES,
  getActiveSeason,
  getSeason,
  getSeasonEntries,
  getActiveSeasonEntries,
  getAllSeasons,
  getArchivedSeasons,
} from './leaderboard-seasons.js';
import {
  getSnapshotEntries   as _getSnapshotEntries,
  getVisibleSnapshots  as _getVisibleSnapshots,
  getSnapshot          as _getSnapshot,
} from './leaderboard-snapshots.js';

export { STAT_TYPES };

// ---------- Internal helpers ----------

/**
 * Resolve a dot/slash-separated stat path on a player object.
 * e.g., 'stats.packsOpened' → player.stats.packsOpened
 * e.g., 'totalResearchPoints' → player.totalResearchPoints
 *
 * @param {object} player
 * @param {string} statType - STAT_TYPES value or any dot-path
 * @returns {number}
 */
function _resolveStatValue(player, statType) {
  if (!player || !statType) return 0;
  const parts = statType.replace(/\./g, '/').split('/');
  let cursor = player;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return 0;
    cursor = cursor[part];
  }
  return typeof cursor === 'number' ? cursor : 0;
}

/**
 * Sort an array of { username, value, groupId?, subgroupId? } descending by value.
 * Stable: ties broken alphabetically by username.
 * @param {Array} entries
 * @returns {Array}
 */
function _sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const diff = (b.value || 0) - (a.value || 0);
    if (diff !== 0) return diff;
    return (a.username || '').localeCompare(b.username || '');
  });
}

/**
 * Apply optional group + subgroup filter to an entries array.
 * @param {Array}       entries
 * @param {string|null} groupId
 * @param {string|null} subgroupId
 * @returns {Array}
 */
function _filterByGroup(entries, groupId, subgroupId) {
  if (!groupId) return entries; // no filter — return all
  const byGroup = entries.filter(e => e.groupId === groupId);
  if (!subgroupId) return byGroup;
  return byGroup.filter(e => e.subgroupId === subgroupId);
}

/**
 * Convert all players in DB to a normalized entry array.
 * @param {string} statType - A STAT_TYPES value
 * @returns {Array<{ username, value, groupId, subgroupId }>}
 */
function _buildPlayerEntries(statType) {
  const players = db.getChildren('players');
  return players.map(({ key: username, value: player }) => ({
    username,
    value: _resolveStatValue(player, statType),
    groupId: player?.groupId ?? null,
    subgroupId: player?.subgroupId ?? null,
  }));
}

// ---------- Public query API ----------

/**
 * Get a leaderboard ranked by any lifetime player stat.
 *
 * @param {object} options
 * @param {string}      options.statType   - STAT_TYPES value (default: LIFETIME_RP)
 * @param {string|null} options.groupId    - Filter to this group (optional)
 * @param {string|null} options.subgroupId - Filter to this subgroup within the group (optional)
 * @param {number}      options.limit      - Max entries (default: 50)
 * @returns {Array<{ rank, username, value, groupId, subgroupId }>}
 */
export function getLeaderboardByStat({
  statType   = STAT_TYPES.LIFETIME_RP,
  groupId    = null,
  subgroupId = null,
  limit      = 50,
} = {}) {
  const entries = _buildPlayerEntries(statType);
  const filtered = _filterByGroup(entries, groupId, subgroupId);
  const sorted   = _sortEntries(filtered).slice(0, limit);
  return sorted.map((e, i) => ({ rank: i + 1, ...e }));
}

/**
 * Get a leaderboard for a specific season's stored entries.
 * Works for both active and archived seasons.
 *
 * @param {object} options
 * @param {string}      options.seasonId   - Season ID to query
 * @param {string|null} options.groupId    - Filter to this group (optional)
 * @param {string|null} options.subgroupId - Filter to this subgroup (optional)
 * @param {number}      options.limit      - Max entries (default: 50)
 * @returns {Array<{ rank, username, value, groupId, subgroupId, snapshotAt }>}
 */
export function getSeasonLeaderboard({
  seasonId,
  groupId    = null,
  subgroupId = null,
  limit      = 50,
} = {}) {
  if (!seasonId) return [];
  const entries  = getSeasonEntries(seasonId);
  const filtered = _filterByGroup(entries, groupId, subgroupId);
  const sorted   = _sortEntries(filtered).slice(0, limit);
  return sorted.map((e, i) => ({ rank: i + 1, ...e }));
}

/**
 * Get the active season's leaderboard.
 * Uses stored entries (snapshots) in the season record.
 *
 * @param {object} options
 * @param {string|null} options.groupId
 * @param {string|null} options.subgroupId
 * @param {number}      options.limit
 * @returns {Array<{ rank, username, value, groupId, subgroupId, snapshotAt }>}
 */
export function getActiveSeasonLeaderboard({
  groupId    = null,
  subgroupId = null,
  limit      = 50,
} = {}) {
  const season = getActiveSeason();
  if (!season) return [];
  return getSeasonLeaderboard({ seasonId: season.id, groupId, subgroupId, limit });
}

/**
 * Get a group-scoped lifetime leaderboard.
 * Convenience wrapper around getLeaderboardByStat.
 *
 * @param {object} options
 * @param {string}      options.groupId
 * @param {string}      options.statType  - Default: LIFETIME_RP
 * @param {number}      options.limit
 * @returns {Array<{ rank, username, value, groupId, subgroupId }>}
 */
export function getGroupLeaderboard({
  groupId,
  statType = STAT_TYPES.LIFETIME_RP,
  limit    = 50,
} = {}) {
  if (!groupId) return [];
  return getLeaderboardByStat({ statType, groupId, subgroupId: null, limit });
}

/**
 * Get a subgroup-scoped lifetime leaderboard.
 * Convenience wrapper around getLeaderboardByStat.
 *
 * @param {object} options
 * @param {string}      options.groupId
 * @param {string}      options.subgroupId
 * @param {string}      options.statType   - Default: LIFETIME_RP
 * @param {number}      options.limit
 * @returns {Array<{ rank, username, value, groupId, subgroupId }>}
 */
export function getSubgroupLeaderboard({
  groupId,
  subgroupId,
  statType = STAT_TYPES.LIFETIME_RP,
  limit    = 50,
} = {}) {
  if (!groupId || !subgroupId) return [];
  return getLeaderboardByStat({ statType, groupId, subgroupId, limit });
}

/**
 * Get a player's current rank for a given stat type and scope.
 * Returns null if the player is not found.
 *
 * @param {object} options
 * @param {string}      options.username
 * @param {string}      options.statType    - Default: LIFETIME_RP
 * @param {string|null} options.groupId     - Optional scope
 * @param {string|null} options.subgroupId  - Optional scope
 * @returns {{ rank: number, value: number, total: number } | null}
 */
export function getPlayerRank({
  username,
  statType   = STAT_TYPES.LIFETIME_RP,
  groupId    = null,
  subgroupId = null,
} = {}) {
  if (!username) return null;
  const board = getLeaderboardByStat({ statType, groupId, subgroupId, limit: 9999 });
  const entry = board.find(e => e.username === username);
  if (!entry) return null;
  return { rank: entry.rank, value: entry.value, total: board.length };
}

/**
 * Get a player's rank within the active season.
 * Returns null if there is no active season or the player has no entry.
 *
 * @param {object} options
 * @param {string}      options.username
 * @param {string|null} options.groupId
 * @param {string|null} options.subgroupId
 * @returns {{ rank: number, value: number, total: number, seasonId: string } | null}
 */
export function getPlayerSeasonRank({
  username,
  groupId    = null,
  subgroupId = null,
} = {}) {
  if (!username) return null;
  const season = getActiveSeason();
  if (!season) return null;
  const board = getSeasonLeaderboard({ seasonId: season.id, groupId, subgroupId, limit: 9999 });
  const entry = board.find(e => e.username === username);
  if (!entry) return null;
  return { rank: entry.rank, value: entry.value, total: board.length, seasonId: season.id };
}

/**
 * Get a summary of all seasons (useful for season selector UI in a future phase).
 * Returns lightweight metadata — no entries.
 *
 * @returns {Array<{ id, name, statType, createdAt, archivedAt, archived, isActive, hidden, visibleToGroups }>}
 */
export function getSeasonSummaries() {
  const activeId = db.get('leaderboardSeasons/activeSeasonId') ?? null;
  return getAllSeasons().map(s => ({
    id:              s.id,
    name:            s.name,
    statType:        s.statType,
    createdAt:       s.createdAt,
    archivedAt:      s.archivedAt,
    archived:        s.archived,
    isActive:        s.id === activeId,
    // Phase LB-4 fields (default to safe values if absent on legacy records)
    hidden:          s.hidden === true,
    visibleToGroups: s.visibleToGroups ?? null,
  }));
}

// ---------- Phase LB-5: Non-seasonal snapshot queries ----------

/**
 * Get the ranked leaderboard from a specific snapshot.
 * Wraps leaderboard-snapshots.js entry logic with group filtering.
 *
 * @param {object} options
 * @param {string}      options.snapshotId
 * @param {string|null} options.groupId
 * @param {string|null} options.subgroupId
 * @param {number}      options.limit
 * @returns {Array<{ rank, username, value, groupId, subgroupId, snapshotAt }>}
 */
export function getSnapshotLeaderboard({
  snapshotId,
  groupId    = null,
  subgroupId = null,
  limit      = 100,
} = {}) {
  if (!snapshotId) return [];
  return _getSnapshotEntries(snapshotId, groupId, subgroupId, limit);
}

/**
 * Get snapshots visible to a given player group, optionally filtered by statType.
 * Reuses the LB-4 visibility rules from leaderboard-snapshots.js.
 *
 * @param {string|null} groupId
 * @param {string|null} statType  - Optional filter (e.g. STAT_TYPES.LIFETIME_RP)
 * @returns {Array<object>}
 */
export function getVisibleSnapshots(groupId, statType = null) {
  return _getVisibleSnapshots(groupId, statType);
}

/**
 * Get a single snapshot's metadata (no entries).
 * @param {string} snapshotId
 * @returns {object|null}
 */
export function getSnapshotMeta(snapshotId) {
  const snap = _getSnapshot(snapshotId);
  if (!snap) return null;
  const { entries: _ignored, ...meta } = snap;
  return meta;
}

// ---------- Phase LB-4: Visibility-aware archive query ----------

/**
 * Get archived seasons that are visible to a given player group.
 *
 * Visibility rules:
 *  - hidden:true    → never shown to players (admin-only)
 *  - visibleToGroups = null   → only the original owner group (groupId from entries)
 *  - visibleToGroups = 'all'  → any player may see this archive
 *  - visibleToGroups = [id…]  → only players whose groupId is in the list
 *
 * Active seasons are never included here — use getActiveSeason() for those.
 *
 * @param {string|null} groupId  - The current player's groupId (null = ungrouped)
 * @returns {Array<{ id, name, statType, createdAt, archivedAt, hidden, visibleToGroups }>}
 */
export function getVisibleArchivedSeasons(groupId) {
  const archived = getArchivedSeasons();
  return archived.filter(s => {
    // Never show hidden archives to players
    if (s.hidden === true) return false;

    const vg = s.visibleToGroups ?? null;

    // 'all' — visible to everyone
    if (vg === 'all') return true;

    // Array of specific group IDs
    if (Array.isArray(vg)) {
      return groupId ? vg.includes(groupId) : false;
    }

    // null (default) — derive the original group from the entries
    // An archive is visible to a player if at least one of its entries
    // belongs to the player's group (i.e., this was their season).
    if (!groupId) return true; // ungrouped players see all unscoped archives
    const entries = Object.values(s.entries || {});
    return entries.some(e => e.groupId === groupId);
  });
}
