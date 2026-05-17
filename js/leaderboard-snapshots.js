/**
 * leaderboard-snapshots.js
 * Phase LB-5 — Historical snapshots for non-seasonal (lifetime) leaderboards.
 *
 * Completely separate from leaderboard-seasons.js (seasonal system).
 * This file handles only lifetime-style stat categories:
 *   Overall RP, Projects Completed, Packs Opened, Unique Cards, Trades Completed
 *
 * DB path: leaderboardSnapshots/
 *   snapshots/
 *     {snapshotId}: {
 *       id, title, statType, createdAt,
 *       groupId (optional — group scope used at snapshot time),
 *       entries: { [username]: { value, groupId, subgroupId, snapshotAt } },
 *       hidden: boolean,
 *       visibleToGroups: null | 'all' | string[]
 *     }
 *   categoryResets/
 *     {statType}: { resetAt: number, resetBy: 'admin' }
 *
 * Safeguards:
 *   - Only archived (read-only) snapshots may be deleted.
 *   - Only non-seasonal stat types are accepted.
 *   - Resets are strictly isolated to the requested statType.
 *   - Seasonal system is never touched.
 */

import * as db from './database.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const SNAP_ROOT = 'leaderboardSnapshots';

/**
 * Non-seasonal stat types eligible for snapshots + resets.
 * Maps readable category ID → player stat path.
 */
export const SNAPSHOT_STAT_TYPES = {
  LIFETIME_RP:        'totalResearchPoints',
  PROJECTS_COMPLETED: 'projectsCompleted',
  PACKS_OPENED:       'stats.packsOpened',
  UNIQUE_CARDS_OWNED: 'stats.uniqueCardsOwned',
  TRADES_COMPLETED:   'stats.tradesCompleted',
  BREAKTHROUGHS:      'researchStats.breakthroughs',
};

/** Human-readable labels for admin UI */
export const SNAPSHOT_STAT_LABELS = {
  [SNAPSHOT_STAT_TYPES.LIFETIME_RP]:        '🏆 Overall RP',
  [SNAPSHOT_STAT_TYPES.PROJECTS_COMPLETED]: '🔬 Projects Completed',
  [SNAPSHOT_STAT_TYPES.PACKS_OPENED]:       '🎴 Packs Opened',
  [SNAPSHOT_STAT_TYPES.UNIQUE_CARDS_OWNED]: '🃏 Unique Cards',
  [SNAPSHOT_STAT_TYPES.TRADES_COMPLETED]:   '🤝 Trades Completed',
  [SNAPSHOT_STAT_TYPES.BREAKTHROUGHS]:      '💥 Breakthroughs',
};

/** Stat reset paths — what gets zeroed per category (ISOLATED per type) */
const RESET_PATHS = {
  [SNAPSHOT_STAT_TYPES.LIFETIME_RP]:        'totalResearchPoints',
  [SNAPSHOT_STAT_TYPES.PROJECTS_COMPLETED]: 'projectsCompleted',
  [SNAPSHOT_STAT_TYPES.PACKS_OPENED]:       'stats/packsOpened',
  [SNAPSHOT_STAT_TYPES.UNIQUE_CARDS_OWNED]: 'stats/uniqueCardsOwned',
  [SNAPSHOT_STAT_TYPES.TRADES_COMPLETED]:   'stats/tradesCompleted',
  [SNAPSHOT_STAT_TYPES.BREAKTHROUGHS]:      'researchStats/breakthroughs',
};

// ─── Schema bootstrap ──────────────────────────────────────────────────────

/**
 * Ensure leaderboardSnapshots root node exists.
 * Safe to call multiple times — never overwrites existing data.
 */
export function ensureSnapshotsSchema() {
  const existing = db.get(SNAP_ROOT);
  if (!existing || typeof existing !== 'object') {
    db.set(SNAP_ROOT, { snapshots: {}, categoryResets: {} });
    console.log('[LB-5] Snapshots schema initialized');
    return;
  }
  if (!existing.snapshots || typeof existing.snapshots !== 'object') {
    db.set(`${SNAP_ROOT}/snapshots`, {});
  }
  if (!existing.categoryResets || typeof existing.categoryResets !== 'object') {
    db.set(`${SNAP_ROOT}/categoryResets`, {});
  }
}

// ─── ID generation ─────────────────────────────────────────────────────────

function _genSnapshotId() {
  const existing = db.get(`${SNAP_ROOT}/snapshots`) || {};
  const count = Object.keys(existing).length + 1;
  return 'snap_' + String(count).padStart(4, '0') + '_' + Date.now().toString(36);
}

// ─── Stat resolution ───────────────────────────────────────────────────────

/**
 * Read a dot/slash-separated stat path from a player object.
 * e.g. 'stats.packsOpened' → player.stats.packsOpened
 */
function _resolvePlayerStat(player, statType) {
  if (!player || !statType) return 0;
  const parts = statType.replace(/\./g, '/').split('/');
  let cursor = player;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return 0;
    cursor = cursor[part];
  }
  return typeof cursor === 'number' ? cursor : 0;
}

// ─── Snapshot creation ─────────────────────────────────────────────────────

/**
 * Create a snapshot of all players' current value for a given stat type.
 *
 * @param {object} options
 * @param {string}      options.title      - Human-readable snapshot name (e.g. "2026 Overall RP")
 * @param {string}      options.statType   - One of SNAPSHOT_STAT_TYPES values
 * @param {boolean}     options.resetAfter - If true, reset that stat to 0 for all players after snapshot
 * @returns {{ snapshotId: string, resetDone: boolean }}
 */
export function createSnapshot({ title, statType, resetAfter = false } = {}) {
  if (!title || !title.trim()) throw new Error('[LB-5] Snapshot title is required');

  // Guard: only non-seasonal stat types
  const validTypes = new Set(Object.values(SNAPSHOT_STAT_TYPES));
  if (!validTypes.has(statType)) {
    throw new Error(`[LB-5] Invalid statType for snapshot: "${statType}". Only non-seasonal types allowed.`);
  }

  ensureSnapshotsSchema();

  const id = _genSnapshotId();
  const players = db.getChildren('players');

  // Build entries from current live values
  const entries = {};
  for (const { key: username, value: p } of players) {
    entries[username] = {
      value:      _resolvePlayerStat(p, statType),
      groupId:    p?.groupId    ?? null,
      subgroupId: p?.subgroupId ?? null,
      snapshotAt: Date.now(),
    };
  }

  const snapshot = {
    id,
    title:           title.trim(),
    statType,
    createdAt:       Date.now(),
    entries,
    hidden:          false,
    visibleToGroups: null,
  };

  db.set(`${SNAP_ROOT}/snapshots/${id}`, snapshot);
  console.log(`[LB-5] Snapshot created: ${id} ("${snapshot.title}", stat: ${statType}, players: ${players.length})`);

  let resetDone = false;
  if (resetAfter) {
    resetDone = _resetStatForAllPlayers(statType);
  }

  return { snapshotId: id, resetDone };
}

// ─── Isolated stat reset ───────────────────────────────────────────────────

/**
 * Reset a single non-seasonal stat to 0 for all players.
 * ONLY the requested statType is touched. All other stats are unaffected.
 * Seasonal RP is never touched (it is not in RESET_PATHS).
 *
 * @param {string} statType - Must be a SNAPSHOT_STAT_TYPES value
 * @returns {boolean} success
 */
function _resetStatForAllPlayers(statType) {
  const resetPath = RESET_PATHS[statType];
  if (!resetPath) {
    console.error(`[LB-5] No reset path defined for statType: "${statType}"`);
    return false;
  }

  const players = db.getChildren('players');
  for (const { key: username } of players) {
    db.set(`players/${username}/${resetPath}`, 0);
  }

  // Record the reset timestamp so history can show "reset on date X"
  db.set(`${SNAP_ROOT}/categoryResets/${statType.replace(/\./g, '_')}`, {
    resetAt:  Date.now(),
    statType,
  });

  console.log(`[LB-5] Reset "${statType}" to 0 for ${players.length} players`);
  return true;
}

// ─── Snapshot reads ────────────────────────────────────────────────────────

/**
 * Get all snapshots sorted newest-first.
 * @returns {Array<object>}
 */
export function getAllSnapshots() {
  const snaps = db.get(`${SNAP_ROOT}/snapshots`) || {};
  return Object.values(snaps).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * Get a single snapshot by ID.
 * @param {string} snapshotId
 * @returns {object|null}
 */
export function getSnapshot(snapshotId) {
  if (!snapshotId) return null;
  return db.get(`${SNAP_ROOT}/snapshots/${snapshotId}`) ?? null;
}

/**
 * Get snapshots for a specific stat type, newest-first.
 * @param {string} statType
 * @returns {Array<object>}
 */
export function getSnapshotsByStatType(statType) {
  return getAllSnapshots().filter(s => s.statType === statType);
}

// ─── Visibility-aware query (reuses LB-4 pattern) ─────────────────────────

/**
 * Get snapshots that are visible to a given player group.
 * Reuses the exact same visibility rules as LB-4 archived seasons.
 *
 * Rules:
 *  - hidden:true                   → never shown to players
 *  - visibleToGroups = null        → visible if player's group has entries in the snapshot
 *  - visibleToGroups = 'all'       → everyone sees it
 *  - visibleToGroups = [id…]       → only listed groups
 *
 * @param {string|null} groupId   - Current player's groupId
 * @param {string|null} statType  - Optional filter by stat type
 * @returns {Array<object>}
 */
export function getVisibleSnapshots(groupId, statType = null) {
  let snaps = getAllSnapshots();
  if (statType) snaps = snaps.filter(s => s.statType === statType);

  return snaps.filter(s => {
    if (s.hidden === true) return false;

    const vg = s.visibleToGroups ?? null;
    if (vg === 'all') return true;
    if (Array.isArray(vg)) return groupId ? vg.includes(groupId) : false;

    // null (default) — visible if the player's group has entries in this snapshot
    if (!groupId) return true;
    const entries = Object.values(s.entries || {});
    return entries.some(e => e.groupId === groupId);
  });
}

// ─── Snapshot entries ──────────────────────────────────────────────────────

/**
 * Get the ranked entries of a snapshot, optionally filtered by group.
 * @param {string}      snapshotId
 * @param {string|null} groupId
 * @param {string|null} subgroupId
 * @param {number}      limit
 * @returns {Array<{ rank, username, value, groupId, subgroupId, snapshotAt }>}
 */
export function getSnapshotEntries(snapshotId, groupId = null, subgroupId = null, limit = 100) {
  const snap = getSnapshot(snapshotId);
  if (!snap) return [];

  let entries = Object.entries(snap.entries || {})
    .map(([username, e]) => ({ username, ...e }));

  if (groupId) {
    entries = entries.filter(e => e.groupId === groupId);
    if (subgroupId) {
      entries = entries.filter(e => e.subgroupId === subgroupId);
    }
  }

  entries.sort((a, b) => {
    const diff = (b.value || 0) - (a.value || 0);
    if (diff !== 0) return diff;
    return (a.username || '').localeCompare(b.username || '');
  });

  return entries.slice(0, limit).map((e, i) => ({ rank: i + 1, ...e }));
}

// ─── Snapshot metadata management (LB-4 pattern) ──────────────────────────

/**
 * Update snapshot metadata (hide/restore, visibleToGroups).
 * @param {string} snapshotId
 * @param {object} patch  - subset of { hidden, visibleToGroups }
 * @returns {boolean}
 */
export function updateSnapshotMetadata(snapshotId, patch) {
  const snap = getSnapshot(snapshotId);
  if (!snap) {
    console.warn(`[LB-5] updateSnapshotMetadata: unknown snapshot ${snapshotId}`);
    return false;
  }
  const safe = {};
  if (patch.hasOwnProperty('hidden'))          safe.hidden          = !!patch.hidden;
  if (patch.hasOwnProperty('visibleToGroups')) safe.visibleToGroups = patch.visibleToGroups ?? null;
  if (Object.keys(safe).length === 0) return true;
  db.update(`${SNAP_ROOT}/snapshots/${snapshotId}`, safe);
  console.log(`[LB-5] Snapshot metadata updated for ${snapshotId}:`, safe);
  return true;
}

/**
 * Permanently delete a snapshot.
 * Live leaderboards (player stats) cannot be deleted — only snapshots.
 * @param {string} snapshotId
 * @returns {boolean}
 */
export function deleteSnapshot(snapshotId) {
  const snap = getSnapshot(snapshotId);
  if (!snap) {
    console.warn(`[LB-5] deleteSnapshot: unknown snapshot ${snapshotId}`);
    return false;
  }
  db.remove(`${SNAP_ROOT}/snapshots/${snapshotId}`);
  console.log(`[LB-5] Permanently deleted snapshot: ${snapshotId} ("${snap.title}")`);
  return true;
}

/**
 * Get the last reset timestamp for a stat type (for display in admin UI).
 * @param {string} statType
 * @returns {number|null}
 */
export function getLastResetTime(statType) {
  const key = statType.replace(/\./g, '_');
  const rec = db.get(`${SNAP_ROOT}/categoryResets/${key}`);
  return rec?.resetAt ?? null;
}
