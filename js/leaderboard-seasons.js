/**
 * leaderboard-seasons.js
 * Phase LB-1 — Season storage and lifecycle management.
 *
 * Handles:
 *   - DB schema for leaderboardSeasons
 *   - Creating, archiving, and rotating seasons
 *   - Multiple stat types (not RP-only)
 *   - Non-destructive: old seasons are read-only after archiving
 *
 * DB path: leaderboardSeasons/
 *   activeSeasonId: string | null
 *   seasons/
 *     {seasonId}: {
 *       id, name, statType, createdAt, archivedAt, archived,
 *       entries: { [username]: { value: number, groupId, subgroupId, snapshotAt } }
 *     }
 *
 * stat types (extensible, not hardcoded to RP):
 *   'totalResearchPoints'
 *   'seasonalResearchPoints'
 *   'stats.projectsCompleted'   (top-level projectsCompleted)
 *   'stats.packsOpened'
 *   'stats.tradesCompleted'
 *   'stats.uniqueCardsOwned'
 *   ... any player stat key path added in the future
 */

import * as db from './database.js';

// ---------- Constants ----------

export const STAT_TYPES = {
  LIFETIME_RP:          'totalResearchPoints',
  SEASONAL_RP:          'seasonalResearchPoints',
  PROJECTS_COMPLETED:   'projectsCompleted',
  PACKS_OPENED:         'stats.packsOpened',
  TRADES_COMPLETED:     'stats.tradesCompleted',
  UNIQUE_CARDS_OWNED:   'stats.uniqueCardsOwned',
  BREAKTHROUGHS:        'researchStats.breakthroughs',
};

const SEASONS_ROOT = 'leaderboardSeasons';

// ---------- ID generation ----------

function _genSeasonId() {
  const existing = db.get(`${SEASONS_ROOT}/seasons`) || {};
  const count = Object.keys(existing).length + 1;
  return 'season_' + String(count).padStart(3, '0');
}

// ---------- Schema bootstrap ----------

/**
 * Ensure the leaderboardSeasons root node exists in the DB.
 * Safe to call multiple times — never overwrites existing data.
 */
export function ensureLeaderboardSeasonsSchema() {
  const existing = db.get(SEASONS_ROOT);
  if (!existing || typeof existing !== 'object') {
    db.set(SEASONS_ROOT, {
      activeSeasonId: null,
      seasons: {}
    });
    console.log('[LeaderboardSeasons] Schema initialized');
    return;
  }
  // Patch individual missing fields — never destructive
  if (existing.activeSeasonId === undefined) {
    db.set(`${SEASONS_ROOT}/activeSeasonId`, null);
  }
  if (!existing.seasons || typeof existing.seasons !== 'object') {
    db.set(`${SEASONS_ROOT}/seasons`, {});
  }
}

// ---------- Active season reads ----------

/**
 * Get the current active season ID.
 * @returns {string|null}
 */
export function getActiveSeasonId() {
  return db.get(`${SEASONS_ROOT}/activeSeasonId`) ?? null;
}

/**
 * Get the full active season object.
 * @returns {object|null}
 */
export function getActiveSeason() {
  const id = getActiveSeasonId();
  if (!id) return null;
  return db.get(`${SEASONS_ROOT}/seasons/${id}`) ?? null;
}

/**
 * Get a season by ID.
 * @param {string} seasonId
 * @returns {object|null}
 */
export function getSeason(seasonId) {
  if (!seasonId) return null;
  return db.get(`${SEASONS_ROOT}/seasons/${seasonId}`) ?? null;
}

/**
 * Get all seasons (active and archived) as an array, sorted by createdAt ascending.
 * @returns {Array<object>}
 */
export function getAllSeasons() {
  const seasons = db.get(`${SEASONS_ROOT}/seasons`) || {};
  return Object.values(seasons).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/**
 * Get all archived (read-only) seasons.
 * @returns {Array<object>}
 */
export function getArchivedSeasons() {
  return getAllSeasons().filter(s => s.archived === true);
}

// ---------- Season lifecycle ----------

/**
 * Create a new season.
 * Does NOT automatically activate it — caller must call activateSeason().
 *
 * @param {object} options
 * @param {string} options.name      - Human-readable season name (e.g., "Spring 2025")
 * @param {string} options.statType  - One of STAT_TYPES values (default: SEASONAL_RP)
 * @returns {string} seasonId
 */
export function createSeason({ name, statType = STAT_TYPES.SEASONAL_RP } = {}) {
  const id = _genSeasonId();
  const season = {
    id,
    name: (name || `Season ${id}`).trim(),
    statType,
    createdAt: Date.now(),
    archivedAt: null,
    archived: false,
    entries: {}
  };
  db.set(`${SEASONS_ROOT}/seasons/${id}`, season);
  console.log(`[LeaderboardSeasons] Created season: ${id} (${season.name}, stat: ${statType})`);
  return id;
}

/**
 * Activate a season by ID.
 * Replaces activeSeasonId — does NOT archive the previous season automatically.
 * Use rotateSeason() if you want to archive the old one first.
 *
 * @param {string} seasonId
 * @returns {boolean} success
 */
export function activateSeason(seasonId) {
  const season = getSeason(seasonId);
  if (!season) {
    console.warn(`[LeaderboardSeasons] Cannot activate unknown season: ${seasonId}`);
    return false;
  }
  if (season.archived) {
    console.warn(`[LeaderboardSeasons] Cannot activate archived season: ${seasonId}`);
    return false;
  }
  db.set(`${SEASONS_ROOT}/activeSeasonId`, seasonId);
  console.log(`[LeaderboardSeasons] Activated season: ${seasonId}`);
  return true;
}

/**
 * Archive a season.
 * Archived seasons:
 *   - remain fully readable
 *   - cannot be re-activated
 *   - entries are frozen (no new writes)
 *
 * @param {string} seasonId
 * @returns {boolean} success
 */
export function archiveSeason(seasonId) {
  const season = getSeason(seasonId);
  if (!season) {
    console.warn(`[LeaderboardSeasons] Cannot archive unknown season: ${seasonId}`);
    return false;
  }
  if (season.archived) {
    console.warn(`[LeaderboardSeasons] Season already archived: ${seasonId}`);
    return true; // idempotent
  }
  db.update(`${SEASONS_ROOT}/seasons/${seasonId}`, {
    archived: true,
    archivedAt: Date.now()
  });
  // Clear activeSeasonId if it was this season
  const activeId = getActiveSeasonId();
  if (activeId === seasonId) {
    db.set(`${SEASONS_ROOT}/activeSeasonId`, null);
  }
  console.log(`[LeaderboardSeasons] Archived season: ${seasonId}`);
  return true;
}

/**
 * Rotate seasons:
 *   1. Archive the current active season (if any)
 *   2. Create a new season with the given config
 *   3. Activate the new season
 *
 * @param {object} options
 * @param {string} options.name      - Name for the new season
 * @param {string} options.statType  - STAT_TYPES value (default: SEASONAL_RP)
 * @returns {{ archivedSeasonId: string|null, newSeasonId: string }}
 */
export function rotateSeason({ name, statType = STAT_TYPES.SEASONAL_RP } = {}) {
  const archivedSeasonId = getActiveSeasonId();

  // Archive old season if there is one
  if (archivedSeasonId) {
    archiveSeason(archivedSeasonId);
  }

  // Create + activate new season
  const newSeasonId = createSeason({ name, statType });
  activateSeason(newSeasonId);

  console.log(`[LeaderboardSeasons] Rotated — archived: ${archivedSeasonId ?? 'none'}, new: ${newSeasonId}`);
  return { archivedSeasonId, newSeasonId };
}

// ---------- Entry management ----------

/**
 * Snapshot a player's current stat value into the active season's entries.
 * This is additive — it records the value at the time of the snapshot.
 * Only writes to the active (non-archived) season.
 *
 * @param {string} username
 * @param {number} value     - Current stat value to record
 * @param {string|null} groupId
 * @param {string|null} subgroupId
 * @returns {boolean} success
 */
export function updateSeasonEntry(username, value, groupId = null, subgroupId = null) {
  const seasonId = getActiveSeasonId();
  if (!seasonId) return false;

  const season = getSeason(seasonId);
  if (!season || season.archived) return false;

  db.set(`${SEASONS_ROOT}/seasons/${seasonId}/entries/${username}`, {
    value: typeof value === 'number' ? value : 0,
    groupId: groupId ?? null,
    subgroupId: subgroupId ?? null,
    snapshotAt: Date.now()
  });
  return true;
}

/**
 * Get all entries for a season as an array, sorted by value descending.
 * @param {string} seasonId
 * @returns {Array<{ username, value, groupId, subgroupId, snapshotAt }>}
 */
export function getSeasonEntries(seasonId) {
  const season = getSeason(seasonId);
  if (!season) return [];
  const entries = season.entries || {};
  return Object.entries(entries)
    .map(([username, e]) => ({ username, ...e }))
    .sort((a, b) => {
      const diff = (b.value || 0) - (a.value || 0);
      if (diff !== 0) return diff;
      return a.username.localeCompare(b.username); // stable tiebreaker
    });
}

/**
 * Get entries for the currently active season.
 * @returns {Array<{ username, value, groupId, subgroupId, snapshotAt }>}
 */
export function getActiveSeasonEntries() {
  const id = getActiveSeasonId();
  if (!id) return [];
  return getSeasonEntries(id);
}

// ---------- Phase LB-4: Archive lifecycle ----------

/**
 * Update metadata on an archived season (hide/restore, visibleToGroups).
 * ONLY works on archived seasons — silently ignores active seasons.
 *
 * @param {string} seasonId
 * @param {object} patch  - subset of { hidden: boolean, visibleToGroups: string[]|'all'|null }
 * @returns {boolean} success
 */
export function updateArchiveMetadata(seasonId, patch) {
  const season = getSeason(seasonId);
  if (!season) {
    console.warn(`[LeaderboardSeasons] updateArchiveMetadata: unknown season ${seasonId}`);
    return false;
  }
  if (!season.archived) {
    console.warn(`[LeaderboardSeasons] updateArchiveMetadata: season ${seasonId} is not archived — skipped`);
    return false;
  }
  // Whitelist only safe metadata keys
  const safe = {};
  if (patch.hasOwnProperty('hidden'))         safe.hidden         = !!patch.hidden;
  if (patch.hasOwnProperty('visibleToGroups')) safe.visibleToGroups = patch.visibleToGroups ?? null;
  if (Object.keys(safe).length === 0) return true;
  db.update(`${SEASONS_ROOT}/seasons/${seasonId}`, safe);
  console.log(`[LeaderboardSeasons] Archive metadata updated for ${seasonId}:`, safe);
  return true;
}

/**
 * Permanently delete an archived season.
 * ONLY archived seasons may be deleted. Active season is protected.
 *
 * Removes: the season node (snapshot + metadata).
 * Does NOT touch: players, inventories, lifetime stats.
 *
 * @param {string} seasonId
 * @returns {boolean} success
 */
export function deleteArchivedSeason(seasonId) {
  const season = getSeason(seasonId);
  if (!season) {
    console.warn(`[LeaderboardSeasons] deleteArchivedSeason: unknown season ${seasonId}`);
    return false;
  }
  if (!season.archived) {
    console.error(`[LeaderboardSeasons] deleteArchivedSeason: BLOCKED — cannot delete active season ${seasonId}`);
    return false;
  }
  db.remove(`${SEASONS_ROOT}/seasons/${seasonId}`);
  console.log(`[LeaderboardSeasons] Permanently deleted archived season: ${seasonId}`);
  return true;
}
