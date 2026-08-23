/**
 * season-class-ops.js
 * S8d-5b — Safe Start New Season class operations.
 *
 * Authoritative gather (adminLoadCanonical players + forced seasons root) →
 * pure planners → preview → Confirm re-gather → awaited fail-stop phases:
 *   A archive entries → B rotate → C seasonal RP reset
 *
 * Kept separate from leaderboard-seasons.js to avoid circular imports with
 * leaderboard-summaries.js / research.js.
 */

import * as db from './database.js';
import {
  adminLoadCanonical,
  assertCanonicalComplete,
  canonicalChildEntries,
} from './admin-maintenance.js';
import {
  STAT_TYPES,
  ensureLeaderboardSeasonsSchema,
} from './leaderboard-seasons.js';
import {
  buildLeaderboardSummaryPathsForChangedStats,
  playerLikeWithStatOverlay,
  resolveLeaderboardGroupFields,
} from './leaderboard-summaries.js';

const SEASONS_ROOT = 'leaderboardSeasons';
const EXCLUDED_PLAYER_KEYS = Object.freeze(['__admin__']);

const SEASON_PLAYER_RP_RE = /^players\/[^/]+\/seasonalResearchPoints$/;
const SEASON_LB_RE = /^leaderboards\/seasonalResearchPoints\/[^/]+$/;
const SEASON_META_RE = /^leaderboardSeasons\//;

/**
 * @param {Record<string, unknown>} updates
 */
export function assertStartNewSeasonPathsAllowed(updates) {
  const keys = updates && typeof updates === 'object' ? Object.keys(updates) : [];
  for (const path of keys) {
    if (SEASON_META_RE.test(path)) continue;
    if (SEASON_PLAYER_RP_RE.test(path)) continue;
    if (SEASON_LB_RE.test(path)) continue;
    throw new Error(`[S8d-5b] Illegal Start New Season path ${JSON.stringify(path)}`);
  }
  return true;
}

/**
 * Pure seasonal RP reset planner — no DB/cache reads.
 * @param {{ playersSnapshot?: object|null, now?: number }} input
 */
export function buildSeasonalResetPlan(input) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const playerEntries = canonicalChildEntries(input.playersSnapshot, {
    exclude: [...EXCLUDED_PLAYER_KEYS],
  });

  /** @type {Record<string, object|number>} */
  const updates = {};
  for (const { key: username, value: player } of playerEntries) {
    updates[`players/${username}/seasonalResearchPoints`] = 0;
    const playerLike = playerLikeWithStatOverlay(
      player && typeof player === 'object' ? player : {},
      { [STAT_TYPES.SEASONAL_RP]: 0 },
    );
    Object.assign(
      updates,
      buildLeaderboardSummaryPathsForChangedStats(
        username,
        playerLike,
        [STAT_TYPES.SEASONAL_RP],
        now,
      ),
    );
  }

  assertStartNewSeasonPathsAllowed(updates);

  return {
    ok: true,
    updates,
    playersScanned: playerEntries.length,
    playersReset: playerEntries.length,
    playerPaths: playerEntries.length,
    leaderboardPaths: playerEntries.length,
    now,
  };
}

/**
 * Pure: build active-season archive entries from canonical players.
 * @param {{ playersSnapshot?: object|null, now?: number }} input
 */
export function buildActiveSeasonSnapshotEntries(input) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const playerEntries = canonicalChildEntries(input.playersSnapshot, {
    exclude: [...EXCLUDED_PLAYER_KEYS],
  });

  /** @type {Record<string, { value: number, groupId: string|null, subgroupId: string|null, snapshotAt: number }>} */
  const entries = {};
  let nonzeroSeasonalCount = 0;

  for (const { key: username, value: player } of playerEntries) {
    const p = player && typeof player === 'object' ? player : {};
    const raw = p.seasonalResearchPoints;
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    if (value !== 0) nonzeroSeasonalCount += 1;
    const { groupId, subgroupId } = resolveLeaderboardGroupFields(p);
    entries[username] = {
      value,
      groupId,
      subgroupId,
      snapshotAt: now,
    };
  }

  return {
    ok: true,
    entries,
    playersScanned: playerEntries.length,
    nonzeroSeasonalCount,
    now,
  };
}

/**
 * Build multipath for Phase A archive entry writes.
 * @param {{ seasonId: string, entries: Record<string, object> }} input
 */
export function buildActiveSeasonArchiveUpdates(input) {
  const seasonId = String(input.seasonId || '').trim();
  if (!seasonId) throw new Error('[S8d-5b] seasonId required for archive entries');
  /** @type {Record<string, object>} */
  const updates = {};
  for (const [username, entry] of Object.entries(input.entries || {})) {
    updates[`${SEASONS_ROOT}/seasons/${seasonId}/entries/${username}`] = entry;
  }
  assertStartNewSeasonPathsAllowed(updates);
  return { updates, entryCount: Object.keys(updates).length };
}

/**
 * Build multipath for Phase B rotate (archive flags + new season + activeSeasonId).
 * @param {{
 *   activeSeasonId: string|null,
 *   newSeasonId: string,
 *   newSeasonName: string,
 *   now?: number,
 * }} input
 */
export function buildSeasonRotateUpdates(input) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const activeSeasonId = input.activeSeasonId || null;
  const newSeasonId = String(input.newSeasonId || '').trim();
  const name = String(input.newSeasonName || '').trim() || `Season ${newSeasonId}`;
  if (!newSeasonId) throw new Error('[S8d-5b] newSeasonId required');

  /** @type {Record<string, object|string|boolean|number|null>} */
  const updates = {};

  if (activeSeasonId) {
    updates[`${SEASONS_ROOT}/seasons/${activeSeasonId}/archived`] = true;
    updates[`${SEASONS_ROOT}/seasons/${activeSeasonId}/archivedAt`] = now;
  }

  updates[`${SEASONS_ROOT}/seasons/${newSeasonId}`] = {
    id: newSeasonId,
    name,
    statType: STAT_TYPES.SEASONAL_RP,
    createdAt: now,
    archivedAt: null,
    archived: false,
    entries: {},
  };
  updates[`${SEASONS_ROOT}/activeSeasonId`] = newSeasonId;

  assertStartNewSeasonPathsAllowed(updates);
  return {
    updates,
    archivedSeasonId: activeSeasonId,
    newSeasonId,
    now,
  };
}

function _proposeNewSeasonId(seasonsSnapshot) {
  const seasons = seasonsSnapshot && typeof seasonsSnapshot === 'object' ? seasonsSnapshot : {};
  const count = Object.keys(seasons).length + 1;
  let id = 'season_' + String(count).padStart(3, '0');
  // Avoid collision if IDs were non-sequential
  while (Object.prototype.hasOwnProperty.call(seasons, id)) {
    const n = Number(String(id).replace(/\D/g, '')) + 1 || (count + 1);
    id = 'season_' + String(n).padStart(3, '0');
  }
  return id;
}

/**
 * Authoritative gather for Start New Season (fail-closed).
 * @param {{ timeoutMs?: number }} [options]
 */
export async function gatherStartNewSeasonSnapshots(options = {}) {
  const playersLoad = await adminLoadCanonical('players', options);
  if (!assertCanonicalComplete(playersLoad)) {
    return {
      ok: false,
      complete: false,
      error: playersLoad?.error || 'PLAYERS_CANONICAL_INCOMPLETE',
    };
  }

  const playerEntries = canonicalChildEntries(playersLoad.value, {
    exclude: [...EXCLUDED_PLAYER_KEYS],
  });
  if (playerEntries.length === 0) {
    return {
      ok: false,
      complete: true,
      error: 'EMPTY_CLASS',
      playersScanned: 0,
      playersSnapshot: playersLoad.value,
    };
  }

  const seasonsRootLoad = await db.loadPathOnce(SEASONS_ROOT, {
    force: true,
    timeoutMs: options.timeoutMs,
  });
  if (!seasonsRootLoad || seasonsRootLoad.ok !== true || seasonsRootLoad.mode !== 'firebase') {
    return {
      ok: false,
      complete: false,
      error: seasonsRootLoad?.error || 'SEASONS_LOAD_INCOMPLETE',
    };
  }

  const root = seasonsRootLoad.value && typeof seasonsRootLoad.value === 'object'
    ? seasonsRootLoad.value
    : {};
  const activeSeasonId = root.activeSeasonId ?? null;
  const seasons = root.seasons && typeof root.seasons === 'object' ? root.seasons : {};
  const activeSeason = activeSeasonId && seasons[activeSeasonId]
    ? seasons[activeSeasonId]
    : null;

  return {
    ok: true,
    complete: true,
    playersSnapshot: playersLoad.value,
    playersScanned: playerEntries.length,
    seasonsRoot: root,
    seasonsSnapshot: seasons,
    activeSeasonId,
    activeSeason,
  };
}

/**
 * Advisory preview — no writes.
 * @param {{ name: string, timeoutMs?: number, now?: number }} options
 */
export async function prepareStartNewSeason(options = {}) {
  const name = String(options.name || '').trim();
  if (!name) {
    return { ok: false, error: 'Season name is required' };
  }

  const gathered = await gatherStartNewSeasonSnapshots(options);
  if (!gathered.ok) {
    return {
      ok: false,
      error: gathered.error || 'Gather failed',
      playersScanned: gathered.playersScanned || 0,
    };
  }

  const archivePlan = buildActiveSeasonSnapshotEntries({
    playersSnapshot: gathered.playersSnapshot,
    now: options.now,
  });
  const proposedNewSeasonId = _proposeNewSeasonId(gathered.seasonsSnapshot);

  return {
    ok: true,
    advisory: true,
    playersScanned: gathered.playersScanned,
    currentSeasonId: gathered.activeSeasonId,
    currentSeasonName: gathered.activeSeason?.name ?? null,
    proposedNewSeasonId,
    proposedNewSeasonName: name,
    nonzeroSeasonalCount: archivePlan.nonzeroSeasonalCount,
    expectedActiveSeasonId: gathered.activeSeasonId,
  };
}

/**
 * Confirm path: re-gather → recheck active season → Phase A → B → C (awaited fail-stop).
 * @param {{
 *   name: string,
 *   expectedActiveSeasonId?: string|null,
 *   timeoutMs?: number,
 *   now?: number,
 * }} options
 */
export async function commitStartNewSeasonFresh(options = {}) {
  const name = String(options.name || '').trim();
  if (!name) {
    return { ok: false, phase: 'PLAN_FAILED', error: 'Season name is required', written: 0 };
  }

  const gathered = await gatherStartNewSeasonSnapshots(options);
  if (!gathered.ok) {
    return {
      ok: false,
      phase: gathered.error === 'EMPTY_CLASS' ? 'EMPTY_CLASS' : 'GATHER_FAILED',
      error: gathered.error || 'Fresh gather failed',
      written: 0,
    };
  }

  const expected = options.expectedActiveSeasonId;
  if (expected !== undefined) {
    const current = gathered.activeSeasonId ?? null;
    const want = expected ?? null;
    if (current !== want) {
      return {
        ok: false,
        phase: 'ACTIVE_SEASON_CHANGED',
        error: `Active season changed (expected ${want ?? 'null'}, found ${current ?? 'null'}). Aborting with zero further writes.`,
        written: 0,
      };
    }
  }

  ensureLeaderboardSeasonsSchema();

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const archiveBuilt = buildActiveSeasonSnapshotEntries({
    playersSnapshot: gathered.playersSnapshot,
    now,
  });

  // Phase A — archive current active season entries (skip if no active season)
  if (gathered.activeSeasonId) {
    const archiveUpdates = buildActiveSeasonArchiveUpdates({
      seasonId: gathered.activeSeasonId,
      entries: archiveBuilt.entries,
    });
    if (archiveUpdates.entryCount > 0) {
      const archiveAck = await db.updateAcknowledged(archiveUpdates.updates);
      if (!archiveAck.ok) {
        return {
          ok: false,
          phase: 'SEASON_ARCHIVE_FAILED',
          error: archiveAck.error || 'Season archive entry write failed',
          written: 0,
          mode: archiveAck.mode,
        };
      }
    }
  }

  // Phase B — rotate season
  const newSeasonId = _proposeNewSeasonId(gathered.seasonsSnapshot);
  const rotateBuilt = buildSeasonRotateUpdates({
    activeSeasonId: gathered.activeSeasonId,
    newSeasonId,
    newSeasonName: name,
    now,
  });
  const rotateAck = await db.updateAcknowledged(rotateBuilt.updates);
  if (!rotateAck.ok) {
    return {
      ok: false,
      phase: 'SEASON_ROTATE_FAILED',
      error: rotateAck.error || 'Season rotate failed',
      written: Object.keys(rotateBuilt.updates).length,
      mode: rotateAck.mode,
      archivedSeasonId: gathered.activeSeasonId,
    };
  }

  // Phase C — reset seasonal RP for all current players
  const resetPlan = buildSeasonalResetPlan({
    playersSnapshot: gathered.playersSnapshot,
    now,
  });
  assertStartNewSeasonPathsAllowed(resetPlan.updates);
  if (Object.keys(resetPlan.updates).length > 0) {
    const resetAck = await db.updateAcknowledged(resetPlan.updates);
    if (!resetAck.ok) {
      return {
        ok: false,
        phase: 'SEASON_RESET_FAILED',
        error: resetAck.error
          || 'Season rotation succeeded but seasonal RP reset failed',
        archivedSeasonId: gathered.activeSeasonId,
        newSeasonId,
        playersScanned: gathered.playersScanned,
        written: Object.keys(rotateBuilt.updates).length,
        mode: resetAck.mode,
      };
    }
  }

  return {
    ok: true,
    phase: 'COMPLETE',
    archivedSeasonId: gathered.activeSeasonId,
    newSeasonId,
    playersScanned: gathered.playersScanned,
    resetPlayers: resetPlan.playersReset,
    mode: rotateAck.mode,
  };
}
