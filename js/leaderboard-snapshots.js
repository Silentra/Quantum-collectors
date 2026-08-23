/**
 * leaderboard-snapshots.js
 * Phase LB-5 — Historical snapshots for non-seasonal (lifetime) leaderboards.
 *
 * S8d-5b: class-wide create/reset uses adminLoadCanonical('players') + re-gather on Confirm.
 * Completely separate from leaderboard-seasons.js (seasonal system).
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
 */

import * as db from './database.js';
import {
  adminLoadCanonical,
  assertCanonicalComplete,
  canonicalChildEntries,
} from './admin-maintenance.js';
import {
  LEADERBOARDS_ROOT,
  buildLeaderboardSummaryPathsForChangedStats,
  normalizeLeaderboardStatKey,
  playerLikeWithStatOverlay,
  resolveLeaderboardGroupFields,
} from './leaderboard-summaries.js';

// ─── Constants ─────────────────────────────────────────────────────────────

export const SNAP_ROOT = 'leaderboardSnapshots';

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
export const SNAPSHOT_RESET_PATHS = {
  [SNAPSHOT_STAT_TYPES.LIFETIME_RP]:        'totalResearchPoints',
  [SNAPSHOT_STAT_TYPES.PROJECTS_COMPLETED]: 'projectsCompleted',
  [SNAPSHOT_STAT_TYPES.PACKS_OPENED]:       'stats/packsOpened',
  [SNAPSHOT_STAT_TYPES.UNIQUE_CARDS_OWNED]: 'stats/uniqueCardsOwned',
  [SNAPSHOT_STAT_TYPES.TRADES_COMPLETED]:   'stats/tradesCompleted',
  [SNAPSHOT_STAT_TYPES.BREAKTHROUGHS]:      'researchStats/breakthroughs',
};

const EXCLUDED_PLAYER_KEYS = Object.freeze(['__admin__']);

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

function _genSnapshotId(existingSnapCount = 0) {
  const count = Number(existingSnapCount) + 1;
  return 'snap_' + String(count).padStart(4, '0') + '_' + Date.now().toString(36);
}

// ─── Stat resolution ───────────────────────────────────────────────────────

/**
 * Read a dot/slash-separated stat path from a player object.
 * e.g. 'stats.packsOpened' → player.stats.packsOpened
 * @param {object|null|undefined} player
 * @param {string} statType
 * @returns {number}
 */
export function resolvePlayerStat(player, statType) {
  if (!player || !statType) return 0;
  const parts = String(statType).replace(/\./g, '/').split('/');
  let cursor = player;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return 0;
    cursor = cursor[part];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : 0;
}

/**
 * @param {Record<string, unknown>} updates
 * @param {{ resetAfter?: boolean, statType?: string }} [opts]
 */
export function assertLifetimeSnapshotPathsAllowed(updates, opts = {}) {
  const keys = updates && typeof updates === 'object' ? Object.keys(updates) : [];
  const resetAfter = opts.resetAfter === true;
  const statType = opts.statType || '';
  const resetPath = SNAPSHOT_RESET_PATHS[statType] || '';
  const lbKey = normalizeLeaderboardStatKey(statType);
  const allowedLb = lbKey ? `${LEADERBOARDS_ROOT}/${lbKey}/` : null;

  for (const path of keys) {
    if (path.startsWith(`${SNAP_ROOT}/`)) continue;
    if (resetAfter && resetPath) {
      const playerResetRe = new RegExp(`^players/[^/]+/${resetPath}$`);
      if (playerResetRe.test(path)) continue;
    }
    if (resetAfter && allowedLb && path.startsWith(allowedLb)) continue;
    throw new Error(`[LB-5] Illegal snapshot path ${JSON.stringify(path)}`);
  }
  return true;
}

/**
 * Pure Lifetime Snapshot (+ optional reset) planner.
 *
 * @param {{
 *   playersSnapshot?: object|null,
 *   category: string,
 *   title: string,
 *   resetAfter?: boolean,
 *   now?: number,
 *   snapshotId: string,
 * }} input
 */
export function buildLifetimeSnapshotPlan(input) {
  const title = String(input.title || '').trim();
  const statType = input.category;
  const resetAfter = input.resetAfter === true;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const snapshotId = String(input.snapshotId || '').trim();

  if (!title) throw new Error('[LB-5] Snapshot title is required');
  if (!snapshotId) throw new Error('[LB-5] snapshotId is required');
  const validTypes = new Set(Object.values(SNAPSHOT_STAT_TYPES));
  if (!validTypes.has(statType)) {
    throw new Error(`[LB-5] Invalid statType for snapshot: "${statType}"`);
  }
  if (statType === 'seasonalResearchPoints') {
    throw new Error('[LB-5] Seasonal RP cannot be reset through Lifetime Snapshot');
  }

  const playerEntries = canonicalChildEntries(input.playersSnapshot, {
    exclude: [...EXCLUDED_PLAYER_KEYS],
  });
  if (playerEntries.length === 0) {
    return {
      ok: false,
      error: 'EMPTY_CLASS',
      playersScanned: 0,
      updates: {},
      resetAfter,
      snapshotId,
    };
  }

  /** @type {Record<string, object>} */
  const entries = {};
  for (const { key: username, value: player } of playerEntries) {
    const p = player && typeof player === 'object' ? player : {};
    const { groupId, subgroupId } = resolveLeaderboardGroupFields(p);
    entries[username] = {
      value: resolvePlayerStat(p, statType),
      groupId,
      subgroupId,
      snapshotAt: now,
    };
  }

  /** @type {Record<string, object|number>} */
  const updates = {
    [`${SNAP_ROOT}/snapshots/${snapshotId}`]: {
      id: snapshotId,
      title,
      statType,
      createdAt: now,
      entries,
      hidden: false,
      visibleToGroups: null,
    },
  };

  let resetPathCount = 0;
  if (resetAfter) {
    const resetPath = SNAPSHOT_RESET_PATHS[statType];
    for (const { key: username, value: player } of playerEntries) {
      updates[`players/${username}/${resetPath}`] = 0;
      resetPathCount += 1;
      const playerLike = playerLikeWithStatOverlay(
        player && typeof player === 'object' ? player : {},
        { [statType]: 0 },
      );
      Object.assign(
        updates,
        buildLeaderboardSummaryPathsForChangedStats(username, playerLike, [statType], now),
      );
    }
    updates[`${SNAP_ROOT}/categoryResets/${statType.replace(/\./g, '_')}`] = {
      resetAt: now,
      statType,
    };
  }

  assertLifetimeSnapshotPathsAllowed(updates, { resetAfter, statType });

  return {
    ok: true,
    updates,
    playersScanned: playerEntries.length,
    entriesCreated: playerEntries.length,
    resetPathCount,
    resetAfter,
    snapshotId,
    title,
    category: statType,
    now,
  };
}

/**
 * @param {{ timeoutMs?: number }} [options]
 */
export async function gatherLifetimeSnapshotPlayers(options = {}) {
  const playersLoad = await adminLoadCanonical('players', options);
  if (!assertCanonicalComplete(playersLoad)) {
    return {
      ok: false,
      complete: false,
      error: playersLoad?.error || 'PLAYERS_CANONICAL_INCOMPLETE',
    };
  }
  const entries = canonicalChildEntries(playersLoad.value, {
    exclude: [...EXCLUDED_PLAYER_KEYS],
  });
  if (entries.length === 0) {
    return {
      ok: false,
      complete: true,
      error: 'EMPTY_CLASS',
      playersScanned: 0,
      playersSnapshot: playersLoad.value,
    };
  }
  return {
    ok: true,
    complete: true,
    playersSnapshot: playersLoad.value,
    playersScanned: entries.length,
  };
}

/**
 * Advisory preview (no writes).
 * @param {{ title: string, category: string, resetAfter?: boolean, timeoutMs?: number, now?: number }} options
 */
export async function prepareLifetimeSnapshot(options = {}) {
  const gathered = await gatherLifetimeSnapshotPlayers(options);
  if (!gathered.ok) {
    return {
      ok: false,
      error: gathered.error || 'Gather failed',
      playersScanned: gathered.playersScanned || 0,
      category: options.category,
      title: options.title,
      resetAfter: options.resetAfter === true,
      expectedPlayerCount: gathered.playersScanned || 0,
    };
  }

  // Preview uses a temporary id; Confirm regenerates after re-gather
  const previewId = 'preview_only';
  let plan;
  try {
    plan = buildLifetimeSnapshotPlan({
      playersSnapshot: gathered.playersSnapshot,
      category: options.category,
      title: options.title,
      resetAfter: options.resetAfter === true,
      now: options.now,
      snapshotId: previewId,
    });
  } catch (err) {
    return { ok: false, error: err?.message || 'PLAN_FAILED' };
  }

  if (!plan.ok) {
    return { ok: false, error: plan.error || 'PLAN_FAILED', playersScanned: plan.playersScanned };
  }

  return {
    ok: true,
    advisory: true,
    playersScanned: plan.playersScanned,
    category: plan.category,
    title: plan.title,
    resetAfter: plan.resetAfter,
    expectedPlayerCount: plan.playersScanned,
  };
}

/**
 * Confirm path: re-gather → fresh plan → await snapshot → optional await reset.
 * @param {{ title: string, category: string, resetAfter?: boolean, timeoutMs?: number, now?: number }} options
 */
export async function commitLifetimeSnapshotFresh(options = {}) {
  const gathered = await gatherLifetimeSnapshotPlayers(options);
  if (!gathered.ok) {
    return {
      ok: false,
      phase: gathered.error === 'EMPTY_CLASS' ? 'EMPTY_CLASS' : 'GATHER_FAILED',
      error: gathered.error || 'Fresh gather failed',
      written: 0,
    };
  }

  ensureSnapshotsSchema();
  const snapsLoad = await db.loadPathOnce(`${SNAP_ROOT}/snapshots`, {
    force: true,
    timeoutMs: options.timeoutMs,
  });
  const existingCount = snapsLoad?.ok === true && snapsLoad.value && typeof snapsLoad.value === 'object'
    ? Object.keys(snapsLoad.value).length
    : 0;
  const snapshotId = _genSnapshotId(existingCount);

  let plan;
  try {
    plan = buildLifetimeSnapshotPlan({
      playersSnapshot: gathered.playersSnapshot,
      category: options.category,
      title: options.title,
      resetAfter: options.resetAfter === true,
      now: options.now,
      snapshotId,
    });
  } catch (err) {
    return { ok: false, phase: 'PLAN_FAILED', error: err?.message || 'PLAN_FAILED', written: 0 };
  }
  if (!plan.ok) {
    return { ok: false, phase: plan.error || 'PLAN_FAILED', error: plan.error, written: 0 };
  }

  const snapPath = `${SNAP_ROOT}/snapshots/${snapshotId}`;
  const snapBody = plan.updates[snapPath];
  const snapAck = await db.updateAcknowledged({ [snapPath]: snapBody });
  if (!snapAck.ok) {
    return {
      ok: false,
      phase: 'SNAPSHOT_WRITE_FAILED',
      error: snapAck.error || 'Snapshot write failed',
      written: 0,
      mode: snapAck.mode,
    };
  }

  if (!plan.resetAfter) {
    return {
      ok: true,
      phase: 'COMPLETE',
      snapshotId,
      resetDone: false,
      playersScanned: plan.playersScanned,
      written: 1,
      mode: snapAck.mode,
    };
  }

  /** @type {Record<string, object|number>} */
  const resetUpdates = { ...plan.updates };
  delete resetUpdates[snapPath];
  const resetAck = await db.updateAcknowledged(resetUpdates);
  if (!resetAck.ok) {
    return {
      ok: false,
      phase: 'SNAPSHOT_RESET_FAILED',
      error: resetAck.error || 'Snapshot created but reset failed',
      snapshotId,
      resetDone: false,
      playersScanned: plan.playersScanned,
      written: 1,
      mode: resetAck.mode,
    };
  }

  return {
    ok: true,
    phase: 'COMPLETE',
    snapshotId,
    resetDone: true,
    playersScanned: plan.playersScanned,
    written: 1 + Object.keys(resetUpdates).length,
    mode: resetAck.mode,
  };
}

/**
 * Create a snapshot of all players' current value for a given stat type.
 * S8d-5b: awaits authoritative gather + staged writes.
 *
 * @param {object} options
 * @param {string}      options.title
 * @param {string}      options.statType
 * @param {boolean}     options.resetAfter
 * @returns {Promise<{ snapshotId: string, resetDone: boolean }>}
 */
export async function createSnapshot({ title, statType, resetAfter = false } = {}) {
  const result = await commitLifetimeSnapshotFresh({
    title,
    category: statType,
    resetAfter,
  });
  if (!result.ok) {
    throw new Error(result.error || result.phase || 'Snapshot failed');
  }
  return { snapshotId: result.snapshotId, resetDone: result.resetDone === true };
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

/**
 * Ranked entries for a snapshot (optional group/subgroup filter).
 * @param {string} snapshotId
 * @param {string|null} [groupId]
 * @param {string|null} [subgroupId]
 * @param {number} [limit]
 * @returns {Array<{ rank, username, value, groupId, subgroupId, snapshotAt }>}
 */
export function getSnapshotEntries(snapshotId, groupId = null, subgroupId = null, limit = 100) {
  const snap = getSnapshot(snapshotId);
  if (!snap) return [];
  const entries = snap.entries || {};
  let rows = Object.entries(entries).map(([username, e]) => ({
    username,
    value: typeof e?.value === 'number' ? e.value : 0,
    groupId: e?.groupId ?? null,
    subgroupId: e?.subgroupId ?? null,
    snapshotAt: e?.snapshotAt ?? null,
  }));
  if (groupId) rows = rows.filter(r => r.groupId === groupId);
  if (subgroupId) rows = rows.filter(r => r.subgroupId === subgroupId);
  rows.sort((a, b) => {
    const diff = (b.value || 0) - (a.value || 0);
    if (diff !== 0) return diff;
    return a.username.localeCompare(b.username);
  });
  const capped = rows.slice(0, Math.max(0, Number(limit) || 100));
  return capped.map((r, i) => ({ rank: i + 1, ...r }));
}

// ─── Visibility-aware query (reuses LB-4 pattern) ─────────────────────────

/**
 * Snapshots visible to a player group (optional statType filter).
 * @param {string|null} groupId
 * @param {string|null} [statType]
 * @returns {Array<object>}
 */
export function getVisibleSnapshots(groupId, statType = null) {
  return getAllSnapshots().filter(s => {
    if (s.hidden === true) return false;
    if (statType && s.statType !== statType) return false;

    const vg = s.visibleToGroups ?? null;
    if (vg === 'all') return true;
    if (Array.isArray(vg)) {
      return groupId ? vg.includes(groupId) : false;
    }
    // null (default) — visible if ungrouped, or if any entry matches the player's group
    if (!groupId) return true;
    const entries = Object.values(s.entries || {});
    return entries.some(e => e && e.groupId === groupId);
  });
}

/**
 * Update snapshot metadata (hide/restore / visibleToGroups).
 * @param {string} snapshotId
 * @param {{ hidden?: boolean, visibleToGroups?: null|'all'|string[] }} patch
 * @returns {boolean}
 */
export function updateSnapshotMetadata(snapshotId, patch = {}) {
  const snap = getSnapshot(snapshotId);
  if (!snap) {
    console.warn(`[LB-5] updateSnapshotMetadata: unknown snapshot ${snapshotId}`);
    return false;
  }
  const safe = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'hidden')) {
    safe.hidden = !!patch.hidden;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'visibleToGroups')) {
    safe.visibleToGroups = patch.visibleToGroups ?? null;
  }
  if (Object.keys(safe).length === 0) return true;
  db.update(`${SNAP_ROOT}/snapshots/${snapshotId}`, safe);
  return true;
}

/**
 * Delete a snapshot node. Does not undo resetAfter player writes.
 * @param {string} snapshotId
 * @returns {boolean}
 */
export function deleteSnapshot(snapshotId) {
  if (!snapshotId) return false;
  const snap = getSnapshot(snapshotId);
  if (!snap) {
    console.warn(`[LB-5] Cannot delete unknown snapshot: ${snapshotId}`);
    return false;
  }
  db.remove(`${SNAP_ROOT}/snapshots/${snapshotId}`);
  console.log(`[LB-5] Deleted snapshot: ${snapshotId}`);
  return true;
}

/**
 * Last category reset timestamp (ms), or null.
 * @param {string} statType
 * @returns {number|null}
 */
export function getLastResetTime(statType) {
  if (!statType) return null;
  const key = String(statType).replace(/\./g, '_');
  const meta = db.get(`${SNAP_ROOT}/categoryResets/${key}`);
  return typeof meta?.resetAt === 'number' ? meta.resetAt : null;
}
