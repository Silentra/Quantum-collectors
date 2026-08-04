/**
 * db-hydration.js — Named cache hydration scopes (Phase S2+)
 *
 * S2 owns `sharedDefs` only: explicit once-loads for config / cards / packs / groups
 * beside the legacy root listener. Does not subscribe current-player or social trees.
 *
 * accessCodes is intentionally NOT part of sharedDefs (register-only; do not broaden).
 * Trading / leaderboard / admin / directory scopes belong to later phases.
 *
 * Root once('/') + on('value') remain authoritative. S2 does not disable the root listener
 * and does not claim bandwidth reduction while root + scoped snapshots coexist.
 */

import * as db from './database.js';
import * as metrics from './db-metrics.js';

/** Dev flag prep (S7 cutover later). Does not disable the root listener in S2. */
export const SCOPED_LOADING_LS_KEY = 'qc_scoped_loading';
export const SCOPED_LOADING_CONFIG_PATH = 'config/firebase/scopedLoadingEnabled';

/**
 * Approved shared definition paths for Phase S2.
 * Order is stable for reports; loads run in parallel.
 */
export const SHARED_DEF_PATHS = Object.freeze(['config', 'cards', 'packs', 'groups']);

export const SCOPE_SHARED_DEFS = 'sharedDefs';

/** @type {Promise<object>|null} */
let _sharedDefsPromise = null;

/** @type {object|null} */
let _sharedDefsLastResult = null;

/**
 * @returns {boolean}
 */
export function isScopedLoadingDevFlagEnabled() {
  try {
    return localStorage.getItem(SCOPED_LOADING_LS_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Flag prep only — root listener stays on regardless of these values in S2.
 * @returns {{
 *   localStorageEnabled: boolean,
 *   configPath: string,
 *   configEnabled: boolean,
 *   rootListenerAuthoritative: true,
 *   note: string
 * }}
 */
export function getScopedLoadingFlagState() {
  const configEnabled = db.get(SCOPED_LOADING_CONFIG_PATH) === true;
  return {
    localStorageEnabled: isScopedLoadingDevFlagEnabled(),
    configPath: SCOPED_LOADING_CONFIG_PATH,
    configEnabled,
    rootListenerAuthoritative: true,
    note: 'S2 flag prep only. Root once + on(value) remain active; flag does not cut over or disable root.',
  };
}

/**
 * @returns {boolean}
 */
export function isSharedDefsReady() {
  return SHARED_DEF_PATHS.every((path) => db.isPathReady(path));
}

/**
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, scope: string, error?: string }>}
 */
export function waitForSharedDefs(options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  if (isSharedDefsReady()) {
    return Promise.resolve({ ok: true, scope: SCOPE_SHARED_DEFS });
  }

  return Promise.all(
    SHARED_DEF_PATHS.map((path) => db.waitForPath(path, { timeoutMs })),
  ).then((results) => {
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      return {
        ok: false,
        scope: SCOPE_SHARED_DEFS,
        error: failed.map((f) => `${f.path}:${f.error || 'not-ready'}`).join(', '),
      };
    }
    return { ok: true, scope: SCOPE_SHARED_DEFS };
  });
}

/**
 * Explicit shared-defs hydration via loadPathOnce (no permanent path subscriptions).
 * Concurrent callers share one in-flight Promise; completed work is reused until force.
 *
 * @param {{ timeoutMs?: number, force?: boolean }} [options]
 * @returns {Promise<object>}
 */
export function hydrateSharedDefs(options = {}) {
  const force = options.force === true;
  if (force) {
    _sharedDefsPromise = null;
    _sharedDefsLastResult = null;
  }

  if (_sharedDefsPromise) {
    return _sharedDefsPromise.then((result) => ({
      ...result,
      reused: true,
    }));
  }

  if (_sharedDefsLastResult && !force) {
    return Promise.resolve({
      ..._sharedDefsLastResult,
      reused: true,
    });
  }

  _sharedDefsPromise = _runSharedDefsHydration(options).then((result) => {
    _sharedDefsLastResult = result;
    return result;
  }).finally(() => {
    // Keep last result; clear in-flight handle so force can re-run.
    _sharedDefsPromise = null;
  });

  return _sharedDefsPromise;
}

/**
 * @param {{ timeoutMs?: number, force?: boolean }} options
 */
async function _runSharedDefsHydration(options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  const force = options.force === true;
  const startedAt = Date.now();

  const pathResults = await Promise.all(
    SHARED_DEF_PATHS.map(async (path) => {
      const result = await db.loadPathOnce(path, { timeoutMs, force });
      return {
        path,
        ok: result.ok === true,
        mode: result.mode,
        reused: result.reused === true,
        error: result.error || null,
        ready: db.isPathReady(path),
      };
    }),
  );

  const completedAt = Date.now();
  const allOk = pathResults.every((r) => r.ok);
  const anyOk = pathResults.some((r) => r.ok);

  if (!allOk) {
    metrics.mark('shared-hydrate-failed');
  }

  const status = allOk ? 'ready' : anyOk ? 'partial' : 'failed';

  return {
    ok: allOk,
    scope: SCOPE_SHARED_DEFS,
    status,
    reused: false,
    pathsHydrated: pathResults.filter((r) => r.ok).map((r) => r.path),
    pathsFailed: pathResults.filter((r) => !r.ok).map((r) => r.path),
    pathResults,
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    sharedDefsReady: isSharedDefsReady(),
    flagState: getScopedLoadingFlagState(),
    excludedFromSharedDefs: ['accessCodes'],
    permanentSubscriptionsAdded: [],
    note: 'S2 shared once-loads beside legacy root. Root remains authoritative; no bandwidth claim yet. accessCodes excluded.',
  };
}

/**
 * Development verification: shared-scope readiness and exact paths hydrated.
 * @returns {object}
 */
export function getSharedHydrationReport() {
  const registry = db.getSubscriptionRegistry();
  const last = _sharedDefsLastResult;
  return {
    phase: 'S2',
    scope: SCOPE_SHARED_DEFS,
    sharedDefsReady: isSharedDefsReady(),
    approvedPaths: [...SHARED_DEF_PATHS],
    pathReady: Object.fromEntries(
      SHARED_DEF_PATHS.map((path) => [path, db.isPathReady(path)]),
    ),
    pathsHydrated: last?.pathsHydrated || SHARED_DEF_PATHS.filter((p) => db.isPathReady(p)),
    pathsFailed: last?.pathsFailed || [],
    lastHydration: last
      ? {
        ok: last.ok,
        status: last.status,
        durationMs: last.durationMs,
        startedAt: last.startedAt,
        completedAt: last.completedAt,
        pathResults: last.pathResults,
      }
      : null,
    inFlight: _sharedDefsPromise != null,
    excludedFromSharedDefs: ['accessCodes'],
    scopedFirebaseSubscriptions: registry,
    hasCurrentPlayerSubscription: registry.some((e) => e.path.startsWith('players/')),
    hasSocialSubscription: registry.some((e) =>
      e.path === 'trades'
      || e.path.startsWith('trades/')
      || e.path === 'playerDirectory'
      || e.path.startsWith('playerDirectory/')
      || e.path === 'leaderboards'
      || e.path.startsWith('leaderboards/')
      || e.path === 'leaderboardSeasons'
      || e.path.startsWith('leaderboardSeasons/')),
    flagState: getScopedLoadingFlagState(),
    rootListenerNote: 'Legacy root once + on(value) still active and authoritative (S2 coexistence).',
    bandwidthNote: 'Do not claim bandwidth reduction while root and scoped snapshots coexist.',
  };
}

/**
 * Named-scope status snapshot (S2: sharedDefs only).
 * @returns {object}
 */
export function getHydrationStatus() {
  return {
    scopes: {
      [SCOPE_SHARED_DEFS]: {
        ready: isSharedDefsReady(),
        paths: [...SHARED_DEF_PATHS],
        pathReady: Object.fromEntries(
          SHARED_DEF_PATHS.map((path) => [path, db.isPathReady(path)]),
        ),
        lastStatus: _sharedDefsLastResult?.status || 'idle',
        inFlight: _sharedDefsPromise != null,
      },
    },
    deferredScopes: [
      'currentPlayer',
      'trading',
      'leaderboard',
      'adminDirectory',
      'adminSelectedPlayer',
      'bootstrapPublicAccessCodes',
    ],
    report: getSharedHydrationReport(),
  };
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcDbHydration = {
    SHARED_DEF_PATHS,
    SCOPE_SHARED_DEFS,
    hydrateSharedDefs,
    isSharedDefsReady,
    waitForSharedDefs,
    getHydrationStatus,
    getSharedHydrationReport,
    getScopedLoadingFlagState,
    isScopedLoadingDevFlagEnabled,
    // Thin mirrors for S2 console verification (not new hydration scopes)
    isPathReady: (path) => db.isPathReady(path),
    waitForPath: (path, options) => db.waitForPath(path, options),
    loadPathOnce: (path, options) => db.loadPathOnce(path, options),
    clearCachedPath: (path) => db.clearCachedPath(path),
    getSubscriptionRegistry: () => db.getSubscriptionRegistry(),
    getCached: (path) => db.get(path),
    help() {
      console.info(`DB Hydration (Phase S2 — sharedDefs)
Approved paths: ${SHARED_DEF_PATHS.join(', ')}
Excluded: accessCodes (not broadened)
API:
  qcDbHydration.getSharedHydrationReport()
  qcDbHydration.getHydrationStatus()
  qcDbHydration.isSharedDefsReady()
  await qcDbHydration.hydrateSharedDefs()
  await qcDbHydration.hydrateSharedDefs({ force: true })
  await qcDbHydration.waitForSharedDefs({ timeoutMs: 500 })
Root listener remains authoritative; no bandwidth claim yet.`);
    },
  };
}

_installWindowApi();
