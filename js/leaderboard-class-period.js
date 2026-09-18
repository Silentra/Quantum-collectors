/**
 * leaderboard-class-period.js
 * Class Leaderboard Period — baseline competition without mutating player stats.
 *
 * Live boards for Overall RP / Projects / Breakthroughs / Trades display:
 *   max(0, absoluteLifetimeValue - baselineValue)
 *
 * Completed periods freeze period-earned finalEntries under history/{id}.
 * Writes ONLY under leaderboardClassPeriod/* (allowlisted).
 * Never writes players/*, leaderboards/*, leaderboardSeasons/*, leaderboardSnapshots/*.
 * Seasonal RP is untouched.
 */

import * as db from './database.js';
import {
  adminLoadCanonical,
  assertCanonicalComplete,
  canonicalChildEntries,
} from './admin-maintenance.js';
import {
  resolveLeaderboardStatValue,
  normalizeLeaderboardStatKey,
  resolveLeaderboardGroupFields,
} from './leaderboard-summaries.js';

export const CLASS_PERIOD_ROOT = 'leaderboardClassPeriod';
export const CLASS_PERIOD_ACTIVE_PATH = `${CLASS_PERIOD_ROOT}/active`;
export const CLASS_PERIOD_HISTORY_ROOT = `${CLASS_PERIOD_ROOT}/history`;

/** Firebase-safe statKeys that participate in class-period baselines. */
export const CLASS_PERIOD_STAT_KEYS = Object.freeze([
  'totalResearchPoints',
  'projectsCompleted',
  'breakthroughs',
  'tradesCompleted',
]);

const CLASS_PERIOD_STAT_KEY_SET = new Set(CLASS_PERIOD_STAT_KEYS);

const EXCLUDED_PLAYER_KEYS = Object.freeze(['__admin__']);

const ACTIVE_PATH_RE = /^leaderboardClassPeriod\/active(\/|$)/;
const HISTORY_PATH_RE = /^leaderboardClassPeriod\/history\/[^/]+(\/|$)/;

const DEFAULT_OPENING_LABEL = 'Opening Period';

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isClassPeriodPathAllowed(path) {
  const p = String(path || '');
  return ACTIVE_PATH_RE.test(p) || HISTORY_PATH_RE.test(p);
}

/**
 * Structural write boundary — throw if any path escapes leaderboardClassPeriod allowlist.
 * @param {Record<string, unknown>} updates
 */
export function assertClassPeriodPathsAllowed(updates) {
  const keys = updates && typeof updates === 'object' ? Object.keys(updates) : [];
  for (const path of keys) {
    if (isClassPeriodPathAllowed(path)) continue;
    throw new Error(
      `[ClassPeriod] Illegal path ${JSON.stringify(path)} `
      + '(only leaderboardClassPeriod/active and leaderboardClassPeriod/history/{id} allowed)',
    );
  }
  return true;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function coerceBaselineNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {unknown} historyMap
 * @returns {boolean}
 */
export function isClassPeriodHistoryEmpty(historyMap) {
  if (!historyMap || typeof historyMap !== 'object') return true;
  return !Object.keys(historyMap).some((id) => {
    const node = historyMap[id];
    return node != null && typeof node === 'object';
  });
}

/**
 * @param {string} periodId
 * @param {object|null|undefined} existingHistory
 * @returns {boolean}
 */
export function historyPeriodIdExists(periodId, existingHistory) {
  const id = String(periodId || '').trim();
  if (!id || !existingHistory || typeof existingHistory !== 'object') return false;
  const node = existingHistory[id];
  return node != null && typeof node === 'object';
}

/**
 * Period-adjusted display value.
 * @param {string} statKeyOrPath - Firebase-safe key or playerPath / STAT_TYPES value
 * @param {string} username
 * @param {unknown} absoluteValue
 * @param {object|null|undefined} activePeriod
 * @returns {number}
 */
export function applyClassPeriodBaseline(statKeyOrPath, username, absoluteValue, activePeriod) {
  const abs = coerceBaselineNumber(absoluteValue);
  const statKey = normalizeLeaderboardStatKey(statKeyOrPath) || String(statKeyOrPath || '');
  if (!CLASS_PERIOD_STAT_KEY_SET.has(statKey)) return abs;
  if (!activePeriod || typeof activePeriod !== 'object') return abs;
  const baselines = activePeriod.baselines;
  if (!baselines || typeof baselines !== 'object') return abs;
  const map = baselines[statKey];
  if (!map || typeof map !== 'object') return abs;
  const key = String(username || '').trim();
  if (!key || !Object.prototype.hasOwnProperty.call(map, key)) return abs;
  const baseline = coerceBaselineNumber(map[key]);
  return Math.max(0, abs - baseline);
}

/**
 * @returns {object|null}
 */
export function getActiveClassPeriod() {
  const active = db.get(CLASS_PERIOD_ACTIVE_PATH);
  if (!active || typeof active !== 'object') return null;
  if (!active.id) return null;
  return active;
}

/**
 * Cached history map (may be empty).
 * @returns {Record<string, object>}
 */
export function getClassPeriodHistoryMap() {
  const hist = db.get(CLASS_PERIOD_HISTORY_ROOT);
  if (!hist || typeof hist !== 'object') return {};
  return hist;
}

/**
 * @param {string} periodId
 * @returns {object|null}
 */
export function getClassPeriodHistoryPeriod(periodId) {
  const id = String(periodId || '').trim();
  if (!id) return null;
  const node = db.get(`${CLASS_PERIOD_HISTORY_ROOT}/${id}`);
  if (!node || typeof node !== 'object' || !node.id) return null;
  return node;
}

/**
 * Archived periods newest-first by endedAt / supersededAt.
 * @returns {Array<object>}
 */
export function listClassPeriodHistory() {
  const map = getClassPeriodHistoryMap();
  return Object.keys(map)
    .map((id) => {
      const node = map[id];
      if (!node || typeof node !== 'object') return null;
      const resolvedId = node.id != null ? String(node.id) : String(id);
      return { ...node, id: resolvedId };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ta = coerceBaselineNumber(a.endedAt) || coerceBaselineNumber(a.supersededAt) || 0;
      const tb = coerceBaselineNumber(b.endedAt) || coerceBaselineNumber(b.supersededAt) || 0;
      return tb - ta;
    });
}

/**
 * @param {string} statKeyOrPath
 * @returns {boolean}
 */
export function isClassPeriodStatKey(statKeyOrPath) {
  const key = normalizeLeaderboardStatKey(statKeyOrPath) || String(statKeyOrPath || '');
  return CLASS_PERIOD_STAT_KEY_SET.has(key);
}

/**
 * Empty baselines shell (Opening Period conceptual baseline = 0).
 * @returns {Record<string, Record<string, number>>}
 */
export function emptyClassPeriodBaselines() {
  /** @type {Record<string, Record<string, number>>} */
  const baselines = {};
  for (const statKey of CLASS_PERIOD_STAT_KEYS) {
    baselines[statKey] = {};
  }
  return baselines;
}

/**
 * Build baselines maps from a canonical players snapshot (pure).
 * @param {object|null|undefined} playersSnapshot
 * @returns {{
 *   baselines: Record<string, Record<string, number>>,
 *   playersBaselined: number,
 *   nonzeroByStat: Record<string, number>,
 * }}
 */
export function buildBaselinesFromPlayersSnapshot(playersSnapshot) {
  const playerEntries = canonicalChildEntries(playersSnapshot, {
    exclude: [...EXCLUDED_PLAYER_KEYS],
  });

  /** @type {Record<string, Record<string, number>>} */
  const baselines = {};
  /** @type {Record<string, number>} */
  const nonzeroByStat = {};
  for (const statKey of CLASS_PERIOD_STAT_KEYS) {
    baselines[statKey] = {};
    nonzeroByStat[statKey] = 0;
  }

  for (const { key: username, value: player } of playerEntries) {
    const p = player && typeof player === 'object' ? player : {};
    for (const statKey of CLASS_PERIOD_STAT_KEYS) {
      const n = coerceBaselineNumber(resolveLeaderboardStatValue(p, statKey));
      baselines[statKey][username] = n;
      if (n > 0) nonzeroByStat[statKey] += 1;
    }
  }

  return {
    baselines,
    playersBaselined: playerEntries.length,
    nonzeroByStat,
  };
}

/**
 * Freeze period-earned standings from outgoing baselines + canonical gather.
 * Missing baseline → 0. Below baseline → 0. Includes group/subgroup metadata.
 *
 * @param {object|null|undefined} outgoingBaselines
 * @param {object|null|undefined} playersSnapshot
 * @returns {Record<string, Record<string, { value: number, groupId: string|null, subgroupId: string|null }>>}
 */
export function computeFinalEntriesFromPlayersSnapshot(outgoingBaselines, playersSnapshot) {
  const baselines =
    outgoingBaselines && typeof outgoingBaselines === 'object' ? outgoingBaselines : {};
  const playerEntries = canonicalChildEntries(playersSnapshot, {
    exclude: [...EXCLUDED_PLAYER_KEYS],
  });

  /** @type {Record<string, Record<string, { value: number, groupId: string|null, subgroupId: string|null }>>} */
  const finalEntries = {};
  for (const statKey of CLASS_PERIOD_STAT_KEYS) {
    finalEntries[statKey] = {};
  }

  for (const { key: username, value: player } of playerEntries) {
    const p = player && typeof player === 'object' ? player : {};
    const { groupId, subgroupId } = resolveLeaderboardGroupFields(p);
    for (const statKey of CLASS_PERIOD_STAT_KEYS) {
      const abs = coerceBaselineNumber(resolveLeaderboardStatValue(p, statKey));
      const baseMap = baselines[statKey] && typeof baselines[statKey] === 'object'
        ? baselines[statKey]
        : {};
      const baseline = Object.prototype.hasOwnProperty.call(baseMap, username)
        ? coerceBaselineNumber(baseMap[username])
        : 0;
      finalEntries[statKey][username] = {
        value: Math.max(0, abs - baseline),
        groupId,
        subgroupId,
      };
    }
  }

  return finalEntries;
}

/**
 * Flatten frozen finalEntries[statKey] → rows (no ranking).
 * @param {object|null|undefined} finalEntriesForStat
 * @returns {Array<{ username: string, value: number, groupId: string|null, subgroupId: string|null }>}
 */
export function listFinalEntryRows(finalEntriesForStat) {
  if (!finalEntriesForStat || typeof finalEntriesForStat !== 'object') return [];
  return Object.keys(finalEntriesForStat)
    .map((username) => {
      const key = String(username || '').trim();
      if (!key || key === '__admin__') return null;
      const raw = finalEntriesForStat[username];
      if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
        return {
          username: key,
          value: coerceBaselineNumber(raw.value),
          groupId: raw.groupId != null && raw.groupId !== '' ? String(raw.groupId) : null,
          subgroupId: raw.subgroupId != null && raw.subgroupId !== '' ? String(raw.subgroupId) : null,
        };
      }
      // Legacy / numeric-only shape
      return {
        username: key,
        value: coerceBaselineNumber(raw),
        groupId: null,
        subgroupId: null,
      };
    })
    .filter(Boolean);
}

/**
 * @param {string|null|undefined} label
 * @param {string} fallback
 * @returns {string}
 */
function resolveArchiveLabel(label, fallback) {
  const trimmed = label != null ? String(label).trim() : '';
  return trimmed || fallback;
}

/**
 * Default label for a non-opening archive.
 * @param {number} endedAt
 * @returns {string}
 */
export function defaultEndedPeriodLabel(endedAt) {
  const t = coerceBaselineNumber(endedAt) || Date.now();
  try {
    return `Period ended ${new Date(t).toLocaleDateString()}`;
  } catch {
    return 'Archived Period';
  }
}

/**
 * Pure plan builder — never touches players/leaderboards.
 *
 * @param {{
 *   playersSnapshot?: object|null,
 *   previousActive?: object|null,
 *   existingHistory?: object|null,
 *   now?: number,
 *   periodId?: string,
 *   openingPeriodId?: string,
 *   archiveLabel?: string|null,
 * }} input
 */
export function buildClassPeriodPlan(input) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const previousActive =
    input.previousActive && typeof input.previousActive === 'object'
      ? input.previousActive
      : null;
  const existingHistory =
    input.existingHistory && typeof input.existingHistory === 'object'
      ? input.existingHistory
      : {};

  const built = buildBaselinesFromPlayersSnapshot(input.playersSnapshot);
  if (built.playersBaselined === 0) {
    return {
      ok: false,
      error: 'EMPTY_CLASS',
      updates: {},
      playersBaselined: 0,
      playerStatWrites: 0,
      gameplayStateWrites: 0,
      seasonalRpWrites: 0,
      replacing: false,
      firstEver: false,
      periodId: null,
      startedAt: now,
      nonzeroByStat: built.nonzeroByStat,
    };
  }

  const historyEmpty = isClassPeriodHistoryEmpty(existingHistory);
  const replacing = !!(previousActive && previousActive.id);
  const firstEver = !replacing && historyEmpty;

  /** @type {Record<string, object|null>} */
  const updates = {};

  if (firstEver) {
    const openingPeriodId = String(input.openingPeriodId || '').trim() || `clp_${now}`;
    let periodId = String(input.periodId || '').trim() || `clp_${now + 1}`;
    if (periodId === openingPeriodId) {
      periodId = `clp_${now + 1}`;
    }

    if (historyPeriodIdExists(openingPeriodId, existingHistory)) {
      return {
        ok: false,
        error: 'HISTORY_ID_EXISTS',
        updates: {},
        playersBaselined: built.playersBaselined,
        playerStatWrites: 0,
        gameplayStateWrites: 0,
        seasonalRpWrites: 0,
        replacing: false,
        firstEver: true,
        conflictPeriodId: openingPeriodId,
        periodId: null,
        startedAt: now,
        nonzeroByStat: built.nonzeroByStat,
      };
    }
    if (historyPeriodIdExists(periodId, existingHistory)) {
      return {
        ok: false,
        error: 'HISTORY_ID_EXISTS',
        updates: {},
        playersBaselined: built.playersBaselined,
        playerStatWrites: 0,
        gameplayStateWrites: 0,
        seasonalRpWrites: 0,
        replacing: false,
        firstEver: true,
        conflictPeriodId: periodId,
        periodId: null,
        startedAt: now,
        nonzeroByStat: built.nonzeroByStat,
      };
    }

    const finalEntries = computeFinalEntriesFromPlayersSnapshot(
      emptyClassPeriodBaselines(),
      input.playersSnapshot,
    );
    const openingLabel = resolveArchiveLabel(input.archiveLabel, DEFAULT_OPENING_LABEL);

    updates[`${CLASS_PERIOD_HISTORY_ROOT}/${openingPeriodId}`] = {
      id: openingPeriodId,
      label: openingLabel,
      startedAt: null,
      endedAt: now,
      baselines: emptyClassPeriodBaselines(),
      finalEntries,
      supersededAt: now,
    };

    const active = {
      id: periodId,
      startedAt: now,
      baselines: built.baselines,
    };
    updates[CLASS_PERIOD_ACTIVE_PATH] = active;
    assertClassPeriodPathsAllowed(updates);

    return {
      ok: true,
      updates,
      playersBaselined: built.playersBaselined,
      playerStatWrites: 0,
      gameplayStateWrites: 0,
      seasonalRpWrites: 0,
      replacing: false,
      firstEver: true,
      openingPeriodId,
      openingLabel,
      previousPeriodId: null,
      previousStartedAt: null,
      periodId,
      startedAt: now,
      nonzeroByStat: built.nonzeroByStat,
      active,
    };
  }

  const periodId = String(input.periodId || '').trim() || `clp_${now}`;
  const active = {
    id: periodId,
    startedAt: now,
    baselines: built.baselines,
  };
  updates[CLASS_PERIOD_ACTIVE_PATH] = active;

  if (replacing) {
    const histId = String(previousActive.id);
    if (historyPeriodIdExists(histId, existingHistory)) {
      return {
        ok: false,
        error: 'HISTORY_ID_EXISTS',
        updates: {},
        playersBaselined: built.playersBaselined,
        playerStatWrites: 0,
        gameplayStateWrites: 0,
        seasonalRpWrites: 0,
        replacing: true,
        firstEver: false,
        conflictPeriodId: histId,
        periodId: null,
        startedAt: now,
        nonzeroByStat: built.nonzeroByStat,
      };
    }

    const finalEntries = computeFinalEntriesFromPlayersSnapshot(
      previousActive.baselines,
      input.playersSnapshot,
    );
    const archiveLabel = resolveArchiveLabel(
      input.archiveLabel,
      defaultEndedPeriodLabel(now),
    );

    updates[`${CLASS_PERIOD_HISTORY_ROOT}/${histId}`] = {
      id: histId,
      label: archiveLabel,
      startedAt: previousActive.startedAt ?? null,
      endedAt: now,
      baselines: previousActive.baselines && typeof previousActive.baselines === 'object'
        ? previousActive.baselines
        : emptyClassPeriodBaselines(),
      finalEntries,
      supersededAt: now,
    };
  }

  assertClassPeriodPathsAllowed(updates);

  return {
    ok: true,
    updates,
    playersBaselined: built.playersBaselined,
    playerStatWrites: 0,
    gameplayStateWrites: 0,
    seasonalRpWrites: 0,
    replacing,
    firstEver: false,
    previousPeriodId: replacing ? String(previousActive.id) : null,
    previousStartedAt: replacing ? coerceBaselineNumber(previousActive.startedAt) || null : null,
    periodId,
    startedAt: now,
    nonzeroByStat: built.nonzeroByStat,
    active,
  };
}

/**
 * Pure disable/end plan — freeze finals, move active → history, clear active.
 * @param {{
 *   previousActive?: object|null,
 *   playersSnapshot?: object|null,
 *   existingHistory?: object|null,
 *   now?: number,
 *   archiveLabel?: string|null,
 * }} input
 */
export function buildDisableClassPeriodPlan(input) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const previousActive =
    input.previousActive && typeof input.previousActive === 'object'
      ? input.previousActive
      : null;
  const existingHistory =
    input.existingHistory && typeof input.existingHistory === 'object'
      ? input.existingHistory
      : {};

  if (!previousActive || !previousActive.id) {
    return {
      ok: false,
      error: 'NO_ACTIVE_PERIOD',
      updates: {},
      playerStatWrites: 0,
      gameplayStateWrites: 0,
      seasonalRpWrites: 0,
    };
  }

  const histId = String(previousActive.id);
  if (historyPeriodIdExists(histId, existingHistory)) {
    return {
      ok: false,
      error: 'HISTORY_ID_EXISTS',
      updates: {},
      playerStatWrites: 0,
      gameplayStateWrites: 0,
      seasonalRpWrites: 0,
      conflictPeriodId: histId,
    };
  }

  const playerEntries = canonicalChildEntries(input.playersSnapshot, {
    exclude: [...EXCLUDED_PLAYER_KEYS],
  });
  if (playerEntries.length === 0) {
    return {
      ok: false,
      error: 'EMPTY_CLASS',
      updates: {},
      playerStatWrites: 0,
      gameplayStateWrites: 0,
      seasonalRpWrites: 0,
    };
  }

  const finalEntries = computeFinalEntriesFromPlayersSnapshot(
    previousActive.baselines,
    input.playersSnapshot,
  );
  const archiveLabel = resolveArchiveLabel(
    input.archiveLabel,
    defaultEndedPeriodLabel(now),
  );

  /** @type {Record<string, object|null>} */
  const updates = {
    [CLASS_PERIOD_ACTIVE_PATH]: null,
    [`${CLASS_PERIOD_HISTORY_ROOT}/${histId}`]: {
      id: histId,
      label: archiveLabel,
      startedAt: previousActive.startedAt ?? null,
      endedAt: now,
      baselines: previousActive.baselines && typeof previousActive.baselines === 'object'
        ? previousActive.baselines
        : emptyClassPeriodBaselines(),
      finalEntries,
      supersededAt: now,
      endedWithoutReplace: true,
    },
  };

  assertClassPeriodPathsAllowed(updates);

  return {
    ok: true,
    updates,
    playerStatWrites: 0,
    gameplayStateWrites: 0,
    seasonalRpWrites: 0,
    previousPeriodId: histId,
    previousStartedAt: coerceBaselineNumber(previousActive.startedAt) || null,
    archiveLabel,
    now,
  };
}

/**
 * @param {{ timeoutMs?: number }} [options]
 */
async function gatherClassPeriodPlayers(options = {}) {
  const playersLoad = await adminLoadCanonical('players', { timeoutMs: options.timeoutMs });
  try {
    assertCanonicalComplete(playersLoad, 'players');
  } catch (err) {
    return {
      ok: false,
      error: err?.message || 'INCOMPLETE_PLAYERS',
      playersSnapshot: null,
      playersScanned: 0,
    };
  }

  const playerEntries = canonicalChildEntries(playersLoad.value, {
    exclude: [...EXCLUDED_PLAYER_KEYS],
  });
  if (playerEntries.length === 0) {
    return {
      ok: false,
      error: 'EMPTY_CLASS',
      playersSnapshot: playersLoad.value,
      playersScanned: 0,
    };
  }

  return {
    ok: true,
    complete: true,
    playersSnapshot: playersLoad.value,
    playersScanned: playerEntries.length,
  };
}

/**
 * Advisory dry-run — no writes.
 * @param {{ timeoutMs?: number, now?: number, archiveLabel?: string|null }} [options]
 */
export async function prepareClassLeaderboardPeriod(options = {}) {
  const gathered = await gatherClassPeriodPlayers(options);
  if (!gathered.ok) {
    return {
      ok: false,
      error: gathered.error || 'Gather failed',
      playersBaselined: gathered.playersScanned || 0,
      playerStatWrites: 0,
      gameplayStateWrites: 0,
      seasonalRpWrites: 0,
    };
  }

  await db.loadPathOnce(CLASS_PERIOD_ROOT, { force: true, timeoutMs: options.timeoutMs });
  const previousActive = getActiveClassPeriod();
  const existingHistory = getClassPeriodHistoryMap();

  const plan = buildClassPeriodPlan({
    playersSnapshot: gathered.playersSnapshot,
    previousActive,
    existingHistory,
    now: options.now,
    archiveLabel: options.archiveLabel,
  });

  if (!plan.ok) {
    return {
      ok: false,
      error: plan.error || 'PLAN_FAILED',
      playersBaselined: plan.playersBaselined || 0,
      playerStatWrites: 0,
      gameplayStateWrites: 0,
      seasonalRpWrites: 0,
      conflictPeriodId: plan.conflictPeriodId,
    };
  }

  return {
    ok: true,
    advisory: true,
    playersBaselined: plan.playersBaselined,
    playerStatWrites: 0,
    gameplayStateWrites: 0,
    seasonalRpWrites: 0,
    replacing: plan.replacing,
    firstEver: plan.firstEver === true,
    openingPeriodId: plan.openingPeriodId || null,
    openingLabel: plan.openingLabel || null,
    previousPeriodId: plan.previousPeriodId,
    previousStartedAt: plan.previousStartedAt,
    periodId: plan.periodId,
    startedAt: plan.startedAt,
    nonzeroByStat: plan.nonzeroByStat,
    writeRoots: [CLASS_PERIOD_ROOT],
  };
}

/**
 * Confirm path: re-gather → fresh plan → allowlist → one multipath write.
 * @param {{
 *   expectedPreviousPeriodId?: string|null,
 *   timeoutMs?: number,
 *   now?: number,
 *   archiveLabel?: string|null,
 * }} [options]
 */
export async function commitClassLeaderboardPeriodFresh(options = {}) {
  const gathered = await gatherClassPeriodPlayers(options);
  if (!gathered.ok) {
    return {
      ok: false,
      phase: gathered.error === 'EMPTY_CLASS' ? 'EMPTY_CLASS' : 'GATHER_FAILED',
      error: gathered.error || 'Fresh gather failed',
      written: 0,
    };
  }

  await db.loadPathOnce(CLASS_PERIOD_ROOT, { force: true, timeoutMs: options.timeoutMs });
  const previousActive = getActiveClassPeriod();
  const existingHistory = getClassPeriodHistoryMap();

  if (options.expectedPreviousPeriodId !== undefined) {
    const want = options.expectedPreviousPeriodId ?? null;
    const have = previousActive?.id ?? null;
    if (want !== have) {
      return {
        ok: false,
        phase: 'ACTIVE_PERIOD_CHANGED',
        error: `Active class period changed (expected ${want ?? 'null'}, found ${have ?? 'null'}). Aborting with zero writes.`,
        written: 0,
      };
    }
  }

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const historyEmpty = isClassPeriodHistoryEmpty(existingHistory);
  const firstEver = !(previousActive && previousActive.id) && historyEmpty;

  let plan;
  try {
    plan = buildClassPeriodPlan({
      playersSnapshot: gathered.playersSnapshot,
      previousActive,
      existingHistory,
      now,
      openingPeriodId: firstEver ? `clp_${now}` : undefined,
      periodId: firstEver ? `clp_${now + 1}` : `clp_${now}`,
      archiveLabel: options.archiveLabel,
    });
  } catch (err) {
    return { ok: false, phase: 'PLAN_FAILED', error: err?.message || 'PLAN_FAILED', written: 0 };
  }

  if (!plan.ok) {
    return {
      ok: false,
      phase: plan.error || 'PLAN_FAILED',
      error: plan.error,
      written: 0,
      conflictPeriodId: plan.conflictPeriodId,
    };
  }

  try {
    assertClassPeriodPathsAllowed(plan.updates);
  } catch (err) {
    return { ok: false, phase: 'ALLOWLIST_FAILED', error: err?.message || 'ALLOWLIST_FAILED', written: 0 };
  }

  const ack = await db.updateAcknowledged(plan.updates);
  if (!ack.ok) {
    return {
      ok: false,
      phase: 'WRITE_FAILED',
      error: ack.error || 'Class period write failed',
      written: 0,
      mode: ack.mode,
    };
  }

  return {
    ok: true,
    phase: 'COMPLETE',
    periodId: plan.periodId,
    startedAt: plan.startedAt,
    playersBaselined: plan.playersBaselined,
    replacing: plan.replacing,
    firstEver: plan.firstEver === true,
    openingPeriodId: plan.openingPeriodId || null,
    previousPeriodId: plan.previousPeriodId,
    playerStatWrites: 0,
    gameplayStateWrites: 0,
    seasonalRpWrites: 0,
    written: Object.keys(plan.updates).length,
    mode: ack.mode,
  };
}

/**
 * End/disable active period → freeze finals, restore absolute live boards (no player writes).
 * @param {{ timeoutMs?: number, now?: number, archiveLabel?: string|null }} [options]
 */
export async function commitDisableClassLeaderboardPeriodFresh(options = {}) {
  const gathered = await gatherClassPeriodPlayers(options);
  if (!gathered.ok) {
    return {
      ok: false,
      phase: gathered.error === 'EMPTY_CLASS' ? 'EMPTY_CLASS' : 'GATHER_FAILED',
      error: gathered.error || 'Fresh gather failed',
      written: 0,
    };
  }

  await db.loadPathOnce(CLASS_PERIOD_ROOT, { force: true, timeoutMs: options.timeoutMs });
  const previousActive = getActiveClassPeriod();
  const existingHistory = getClassPeriodHistoryMap();

  let plan;
  try {
    plan = buildDisableClassPeriodPlan({
      previousActive,
      playersSnapshot: gathered.playersSnapshot,
      existingHistory,
      now: options.now,
      archiveLabel: options.archiveLabel,
    });
  } catch (err) {
    return { ok: false, phase: 'PLAN_FAILED', error: err?.message || 'PLAN_FAILED', written: 0 };
  }

  if (!plan.ok) {
    return {
      ok: false,
      phase: plan.error || 'PLAN_FAILED',
      error: plan.error,
      written: 0,
      conflictPeriodId: plan.conflictPeriodId,
    };
  }

  try {
    assertClassPeriodPathsAllowed(plan.updates);
  } catch (err) {
    return { ok: false, phase: 'ALLOWLIST_FAILED', error: err?.message || 'ALLOWLIST_FAILED', written: 0 };
  }

  const ack = await db.updateAcknowledged(plan.updates);
  if (!ack.ok) {
    return {
      ok: false,
      phase: 'WRITE_FAILED',
      error: ack.error || 'Disable class period write failed',
      written: 0,
      mode: ack.mode,
    };
  }

  return {
    ok: true,
    phase: 'COMPLETE',
    previousPeriodId: plan.previousPeriodId,
    archiveLabel: plan.archiveLabel,
    playerStatWrites: 0,
    gameplayStateWrites: 0,
    seasonalRpWrites: 0,
    written: Object.keys(plan.updates).length,
    mode: ack.mode,
  };
}

/**
 * Admin/diagnostic summary of the active period.
 * @returns {object}
 */
export function getClassPeriodReport() {
  const active = getActiveClassPeriod();
  const historyCount = listClassPeriodHistory().length;
  if (!active) {
    return {
      hasActive: false,
      periodId: null,
      startedAt: null,
      playersBaselined: 0,
      historyCount,
      statKeys: [...CLASS_PERIOD_STAT_KEYS],
    };
  }
  const baselines = active.baselines && typeof active.baselines === 'object' ? active.baselines : {};
  const sampleKey = CLASS_PERIOD_STAT_KEYS[0];
  const sampleMap = baselines[sampleKey] && typeof baselines[sampleKey] === 'object'
    ? baselines[sampleKey]
    : {};
  return {
    hasActive: true,
    periodId: active.id ?? null,
    startedAt: active.startedAt ?? null,
    playersBaselined: Object.keys(sampleMap).length,
    historyCount,
    statKeys: [...CLASS_PERIOD_STAT_KEYS],
    nonzeroByStat: Object.fromEntries(
      CLASS_PERIOD_STAT_KEYS.map((k) => {
        const m = baselines[k] && typeof baselines[k] === 'object' ? baselines[k] : {};
        return [k, Object.values(m).filter((v) => coerceBaselineNumber(v) > 0).length];
      }),
    ),
  };
}
