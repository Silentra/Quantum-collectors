/**
 * leaderboard-class-period.js
 * Class Leaderboard Period — baseline competition without mutating player stats.
 *
 * Live boards for Overall RP / Projects / Breakthroughs / Trades display:
 *   max(0, absoluteLifetimeValue - baselineValue)
 *
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
import { resolveLeaderboardStatValue, normalizeLeaderboardStatKey } from './leaderboard-summaries.js';

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
 * @param {string} statKeyOrPath
 * @returns {boolean}
 */
export function isClassPeriodStatKey(statKeyOrPath) {
  const key = normalizeLeaderboardStatKey(statKeyOrPath) || String(statKeyOrPath || '');
  return CLASS_PERIOD_STAT_KEY_SET.has(key);
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
 * Pure plan builder — never touches players/leaderboards.
 *
 * @param {{
 *   playersSnapshot?: object|null,
 *   previousActive?: object|null,
 *   now?: number,
 *   periodId?: string,
 * }} input
 */
export function buildClassPeriodPlan(input) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const previousActive =
    input.previousActive && typeof input.previousActive === 'object'
      ? input.previousActive
      : null;

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
      periodId: null,
      startedAt: now,
      nonzeroByStat: built.nonzeroByStat,
    };
  }

  const periodId = String(input.periodId || '').trim() || `clp_${now}`;
  const active = {
    id: periodId,
    startedAt: now,
    baselines: built.baselines,
  };

  /** @type {Record<string, object|null>} */
  const updates = {
    [CLASS_PERIOD_ACTIVE_PATH]: active,
  };

  const replacing = !!(previousActive && previousActive.id);
  if (replacing) {
    const histId = String(previousActive.id);
    updates[`${CLASS_PERIOD_HISTORY_ROOT}/${histId}`] = {
      ...previousActive,
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
    previousPeriodId: replacing ? String(previousActive.id) : null,
    previousStartedAt: replacing ? coerceBaselineNumber(previousActive.startedAt) || null : null,
    periodId,
    startedAt: now,
    nonzeroByStat: built.nonzeroByStat,
    active,
  };
}

/**
 * Pure disable/end plan — move active → history, clear active.
 * @param {{ previousActive?: object|null, now?: number }} input
 */
export function buildDisableClassPeriodPlan(input) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const previousActive =
    input.previousActive && typeof input.previousActive === 'object'
      ? input.previousActive
      : null;

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
  /** @type {Record<string, object|null>} */
  const updates = {
    [CLASS_PERIOD_ACTIVE_PATH]: null,
    [`${CLASS_PERIOD_HISTORY_ROOT}/${histId}`]: {
      ...previousActive,
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
 * @param {{ timeoutMs?: number, now?: number }} [options]
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

  const plan = buildClassPeriodPlan({
    playersSnapshot: gathered.playersSnapshot,
    previousActive,
    now: options.now,
  });

  if (!plan.ok) {
    return {
      ok: false,
      error: plan.error || 'PLAN_FAILED',
      playersBaselined: plan.playersBaselined || 0,
      playerStatWrites: 0,
      gameplayStateWrites: 0,
      seasonalRpWrites: 0,
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
  let plan;
  try {
    plan = buildClassPeriodPlan({
      playersSnapshot: gathered.playersSnapshot,
      previousActive,
      now,
      periodId: `clp_${now}`,
    });
  } catch (err) {
    return { ok: false, phase: 'PLAN_FAILED', error: err?.message || 'PLAN_FAILED', written: 0 };
  }

  if (!plan.ok) {
    return { ok: false, phase: plan.error || 'PLAN_FAILED', error: plan.error, written: 0 };
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
    previousPeriodId: plan.previousPeriodId,
    playerStatWrites: 0,
    gameplayStateWrites: 0,
    seasonalRpWrites: 0,
    written: Object.keys(plan.updates).length,
    mode: ack.mode,
  };
}

/**
 * End/disable active period → restore absolute live boards (no player writes).
 * @param {{ timeoutMs?: number, now?: number }} [options]
 */
export async function commitDisableClassLeaderboardPeriodFresh(options = {}) {
  await db.loadPathOnce(CLASS_PERIOD_ROOT, { force: true, timeoutMs: options.timeoutMs });
  const previousActive = getActiveClassPeriod();

  let plan;
  try {
    plan = buildDisableClassPeriodPlan({
      previousActive,
      now: options.now,
    });
  } catch (err) {
    return { ok: false, phase: 'PLAN_FAILED', error: err?.message || 'PLAN_FAILED', written: 0 };
  }

  if (!plan.ok) {
    return { ok: false, phase: plan.error || 'PLAN_FAILED', error: plan.error, written: 0 };
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
  if (!active) {
    return {
      hasActive: false,
      periodId: null,
      startedAt: null,
      playersBaselined: 0,
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
    statKeys: [...CLASS_PERIOD_STAT_KEYS],
    nonzeroByStat: Object.fromEntries(
      CLASS_PERIOD_STAT_KEYS.map((k) => {
        const m = baselines[k] && typeof baselines[k] === 'object' ? baselines[k] : {};
        return [k, Object.values(m).filter((v) => coerceBaselineNumber(v) > 0).length];
      }),
    ),
  };
}
