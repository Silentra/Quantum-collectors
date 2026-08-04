/**
 * db-hydration.js — Named cache hydration scopes (Phase S2–S3)
 *
 * S2: sharedDefs — once-loads for config / cards / packs / groups.
 * S3: currentPlayer — auth-owned once-load + one subscribePath for players/{username}.
 *
 * accessCodes is intentionally NOT part of sharedDefs (register-only; do not broaden).
 * Trading / leaderboard / admin / directory scopes belong to later phases.
 *
 * Root once('/') + on('value') remain the legacy safety net (unchanged). Root and scoped
 * player events may arrive in either order during S3 coexistence — do not depend on root
 * events “winning.” No bandwidth claim while they coexist.
 */

import * as db from './database.js';
import * as metrics from './db-metrics.js';

/** Dev flag prep (S7 cutover later). Does not disable the root listener. */
export const SCOPED_LOADING_LS_KEY = 'qc_scoped_loading';
export const SCOPED_LOADING_CONFIG_PATH = 'config/firebase/scopedLoadingEnabled';

/**
 * Approved shared definition paths for Phase S2.
 * Order is stable for reports; loads run in parallel.
 */
export const SHARED_DEF_PATHS = Object.freeze(['config', 'cards', 'packs', 'groups']);

export const SCOPE_SHARED_DEFS = 'sharedDefs';
export const SCOPE_CURRENT_PLAYER = 'currentPlayer';

/** @type {Promise<object>|null} */
let _sharedDefsPromise = null;

/** @type {object|null} */
let _sharedDefsLastResult = null;

/** @type {string|null} */
let _currentPlayerUsername = null;

/** @type {(() => void)|null} */
let _currentPlayerUnsub = null;

/** @type {string|null} */
let _currentPlayerSubId = null;

/** @type {number|null} */
let _currentPlayerStartedAt = null;

/** @type {Promise<object>|null} */
let _currentPlayerPromise = null;

/** @type {object|null} */
let _currentPlayerLastResult = null;

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
 * Flag prep only — root listener stays on regardless of these values in S3.
 * @returns {object}
 */
export function getScopedLoadingFlagState() {
  const configEnabled = db.get(SCOPED_LOADING_CONFIG_PATH) === true;
  return {
    localStorageEnabled: isScopedLoadingDevFlagEnabled(),
    configPath: SCOPED_LOADING_CONFIG_PATH,
    configEnabled,
    rootListenerLegacySafetyNet: true,
    note: 'Flag prep only. Root once + on(value) remain the legacy safety net; flag does not cut over or disable root.',
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
    note: 'S2 shared once-loads beside legacy root safety net. No bandwidth claim yet. accessCodes excluded.',
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
    rootListenerNote: 'Legacy root once + on(value) still active as safety net (S2/S3 coexistence).',
    bandwidthNote: 'Do not claim bandwidth reduction while root and scoped snapshots coexist.',
  };
}

// ---------- Phase S3: current player ----------

function _normalizeUsername(username) {
  if (username == null || username === '') return '';
  return String(username).trim().toLowerCase();
}

function _playerPath(username) {
  const u = _normalizeUsername(username);
  return u ? `players/${u}` : '';
}

function _registryEntryForCurrentPlayer() {
  const path = _currentPlayerUsername ? _playerPath(_currentPlayerUsername) : '';
  if (!path) return null;
  return db.getSubscriptionRegistry().find((e) => e.path === path) || null;
}

/**
 * Release the auth-owned current-player Firebase subscription.
 * Does not clear cache or readiness. Auth is the sole caller — not on DevTools mirror.
 * @returns {{ released: boolean, previousUsername: string|null }}
 */
export function releaseCurrentPlayerScope() {
  const previousUsername = _currentPlayerUsername;
  if (_currentPlayerUnsub) {
    try { _currentPlayerUnsub(); } catch { /* ignore */ }
  }
  _currentPlayerUnsub = null;
  _currentPlayerSubId = null;
  _currentPlayerUsername = null;
  _currentPlayerStartedAt = null;
  _currentPlayerPromise = null;
  _currentPlayerLastResult = null;
  return { released: previousUsername != null, previousUsername };
}

/**
 * @param {string} [username]
 * @returns {boolean}
 */
export function isCurrentPlayerReady(username) {
  const u = username != null && username !== ''
    ? _normalizeUsername(username)
    : _currentPlayerUsername;
  if (!u) return false;
  if (_currentPlayerUsername && u !== _currentPlayerUsername) return false;
  return db.isPathReady(_playerPath(u));
}

/**
 * @param {string} [username]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, scope: string, path?: string, error?: string }>}
 */
export function waitForCurrentPlayer(username, options = {}) {
  const u = username != null && username !== ''
    ? _normalizeUsername(username)
    : _currentPlayerUsername;
  if (!u) {
    return Promise.resolve({
      ok: false,
      scope: SCOPE_CURRENT_PLAYER,
      error: 'No current player username',
    });
  }
  const path = _playerPath(u);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  return db.waitForPath(path, { timeoutMs }).then((result) => ({
    ok: result.ok === true,
    scope: SCOPE_CURRENT_PLAYER,
    path,
    error: result.error,
  }));
}

/**
 * Once-load players/{u} only (no live subscription). Used by restore before token verify.
 * Does not start the session guard.
 *
 * @param {string} username
 * @param {{ timeoutMs?: number, force?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function hydrateCurrentPlayer(username, options = {}) {
  const u = _normalizeUsername(username);
  if (!u || u === '__admin__') {
    return {
      ok: false,
      scope: SCOPE_CURRENT_PLAYER,
      path: '',
      error: u === '__admin__' ? 'Standalone __admin__ has no player scope' : 'Invalid username',
    };
  }

  const path = _playerPath(u);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  const force = options.force === true;

  metrics.mark('current-player-hydrate-start');
  const load = await db.loadPathOnce(path, { timeoutMs, force });
  if (!load.ok) {
    metrics.mark('current-player-hydrate-failed');
    return {
      ok: false,
      scope: SCOPE_CURRENT_PLAYER,
      path,
      username: u,
      error: load.error || 'Load failed',
      mode: load.mode,
      reused: load.reused === true,
    };
  }

  // Track intended owner before subscribe (restore verifies token next).
  if (_currentPlayerUsername && _currentPlayerUsername !== u) {
    releaseCurrentPlayerScope();
  }
  _currentPlayerUsername = u;

  return {
    ok: true,
    scope: SCOPE_CURRENT_PLAYER,
    path,
    username: u,
    mode: load.mode,
    reused: load.reused === true,
    ready: db.isPathReady(path),
  };
}

/**
 * Attach the single auth-owned subscribePath for players/{u}.
 * Requires hydrateCurrentPlayer / ensure to have set the owner username (or matches).
 * Does not bump refCount above 1 — rejects if another owner already holds a different sub.
 *
 * @param {string} username
 * @returns {{ ok: boolean, path: string, username: string, reused: boolean, id: string, error?: string }}
 */
export function subscribeCurrentPlayer(username) {
  const u = _normalizeUsername(username);
  if (!u || u === '__admin__') {
    return {
      ok: false,
      path: '',
      username: u || '',
      reused: false,
      id: '',
      error: u === '__admin__' ? 'Standalone __admin__ has no player scope' : 'Invalid username',
    };
  }

  const path = _playerPath(u);

  // Already owning this exact subscription
  if (_currentPlayerUsername === u && _currentPlayerUnsub) {
    const entry = _registryEntryForCurrentPlayer();
    return {
      ok: true,
      path,
      username: u,
      reused: true,
      id: _currentPlayerSubId || entry?.id || '',
      refCount: entry?.refCount ?? 1,
    };
  }

  // Switching accounts
  if (_currentPlayerUsername && _currentPlayerUsername !== u) {
    releaseCurrentPlayerScope();
  }

  // Ensure we never leave a dangling second player sub from a prior partial ensure
  const existingOther = db.getSubscriptionRegistry().find((e) => e.path.startsWith('players/'));
  if (existingOther && existingOther.path !== path) {
    // Should not happen if auth is sole owner — release our handle if any, then refuse
    releaseCurrentPlayerScope();
    return {
      ok: false,
      path,
      username: u,
      reused: false,
      id: '',
      error: `Unexpected player subscription already active at ${existingOther.path}`,
    };
  }

  if (existingOther && existingOther.path === path && !_currentPlayerUnsub) {
    // Orphaned registry entry without our unsub handle — do not acquire a second refCount
    return {
      ok: false,
      path,
      username: u,
      reused: false,
      id: existingOther.id,
      error: 'Player path already subscribed without auth owner handle',
    };
  }

  const handle = db.subscribePath(path);
  const entryAfter = db.getSubscriptionRegistry().find((e) => e.path === path);
  if (entryAfter && entryAfter.refCount > 1) {
    // Another holder already had this path — drop our acquire so refCount returns to prior.
    try { handle.unsubscribe(); } catch { /* ignore */ }
    return {
      ok: false,
      path,
      username: u,
      reused: false,
      id: handle.id,
      error: 'Refusing to share player subscription (auth must be sole owner)',
    };
  }

  _currentPlayerUsername = u;
  _currentPlayerUnsub = handle.unsubscribe;
  _currentPlayerSubId = handle.id;
  _currentPlayerStartedAt = _currentPlayerStartedAt || Date.now();

  return {
    ok: true,
    path,
    username: u,
    reused: handle.reused === true,
    id: handle.id,
    refCount: entryAfter?.refCount ?? 1,
  };
}

/**
 * Canonical login/register path: once-load then subscribe (Option C).
 * Concurrent same-username callers share one in-flight Promise.
 *
 * @param {string} username
 * @param {{
 *   timeoutMs?: number,
 *   force?: boolean,
 *   ackCacheFallback?: boolean
 * }} [options]
 *   ackCacheFallback — registration only: if redundant once-load fails but ack already
 *   patched players/{u} into cache, still attach subscription (never re-create account).
 * @returns {Promise<object>}
 */
export function ensureCurrentPlayerScope(username, options = {}) {
  const u = _normalizeUsername(username);
  if (!u || u === '__admin__') {
    return Promise.resolve({
      ok: false,
      scope: SCOPE_CURRENT_PLAYER,
      path: '',
      username: u || '',
      error: u === '__admin__' ? 'Standalone __admin__ has no player scope' : 'Invalid username',
    });
  }

  const force = options.force === true;

  if (
    !force
    && _currentPlayerUsername === u
    && _currentPlayerUnsub
    && db.isPathReady(_playerPath(u))
  ) {
    return Promise.resolve({
      ok: true,
      scope: SCOPE_CURRENT_PLAYER,
      path: _playerPath(u),
      username: u,
      reused: true,
      subscriptionActive: true,
      subscriptionRefCount: _registryEntryForCurrentPlayer()?.refCount ?? 1,
      ready: true,
    });
  }

  if (_currentPlayerPromise && _currentPlayerUsername === u && !force) {
    return _currentPlayerPromise.then((result) => ({ ...result, reused: true }));
  }

  _currentPlayerPromise = _runEnsureCurrentPlayer(u, options).then((result) => {
    _currentPlayerLastResult = result;
    return result;
  }).finally(() => {
    _currentPlayerPromise = null;
  });

  return _currentPlayerPromise;
}

/**
 * @param {string} u
 * @param {{ timeoutMs?: number, force?: boolean, ackCacheFallback?: boolean }} options
 */
async function _runEnsureCurrentPlayer(u, options = {}) {
  const path = _playerPath(u);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  const force = options.force === true;
  const ackCacheFallback = options.ackCacheFallback === true;
  const startedAt = Date.now();

  metrics.mark('current-player-hydrate-start');

  if (_currentPlayerUsername && _currentPlayerUsername !== u) {
    releaseCurrentPlayerScope();
  }

  let scopedOnceFailed = false;
  let load = await db.loadPathOnce(path, { timeoutMs, force });

  if (!load.ok) {
    if (ackCacheFallback && db.get(path)) {
      // Registration already committed player + consumed access code. Do not fail hard
      // or retry register — continue with cache + live subscription.
      scopedOnceFailed = true;
      console.warn(
        '[Hydration] Current-player once-load failed after acknowledged write; using ack cache + subscribe:',
        load.error,
      );
    } else {
      metrics.mark('current-player-hydrate-failed');
      return {
        ok: false,
        scope: SCOPE_CURRENT_PLAYER,
        path,
        username: u,
        status: 'failed',
        error: load.error || 'Load failed',
        scopedOnceFailed: true,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  _currentPlayerUsername = u;
  _currentPlayerStartedAt = startedAt;

  const sub = subscribeCurrentPlayer(u);
  if (!sub.ok) {
    metrics.mark('current-player-hydrate-failed');
    return {
      ok: false,
      scope: SCOPE_CURRENT_PLAYER,
      path,
      username: u,
      status: 'failed',
      error: sub.error || 'Subscribe failed',
      scopedOnceFailed,
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  }

  const wait = await db.waitForPath(path, { timeoutMs });
  if (!wait.ok) {
    if (ackCacheFallback && db.get(path)) {
      // Still allow session — root safety net + ack cache; subscription may catch up.
      console.warn(
        '[Hydration] waitForPath timeout after register ack; continuing with cache present',
      );
    } else {
      metrics.mark('current-player-hydrate-failed');
      return {
        ok: false,
        scope: SCOPE_CURRENT_PLAYER,
        path,
        username: u,
        status: 'failed',
        error: wait.error || 'timeout',
        scopedOnceFailed,
        subscriptionActive: true,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  metrics.mark('current-player-hydrate-complete');
  const entry = _registryEntryForCurrentPlayer();
  const completedAt = Date.now();

  return {
    ok: true,
    scope: SCOPE_CURRENT_PLAYER,
    path,
    username: u,
    status: scopedOnceFailed ? 'ready-with-once-fallback' : 'ready',
    reused: false,
    scopedOnceFailed,
    subscriptionActive: _currentPlayerUnsub != null,
    subscriptionId: _currentPlayerSubId,
    subscriptionRefCount: entry?.refCount ?? 1,
    ready: db.isPathReady(path),
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    note: 'S3 current-player once + subscribe beside legacy root safety net. No bandwidth claim.',
  };
}

/**
 * Dev report — no password, sessionId, inventory, or player payload.
 * @returns {object}
 */
export function getCurrentPlayerHydrationReport() {
  const entry = _registryEntryForCurrentPlayer();
  const path = _currentPlayerUsername ? _playerPath(_currentPlayerUsername) : null;
  const registry = db.getSubscriptionRegistry();
  const playerSubs = registry.filter((e) => e.path.startsWith('players/'));

  return {
    phase: 'S3',
    scope: SCOPE_CURRENT_PLAYER,
    currentPlayerReady: isCurrentPlayerReady(),
    username: _currentPlayerUsername,
    path,
    subscriptionActive: _currentPlayerUnsub != null,
    subscriptionId: _currentPlayerSubId,
    subscriptionRefCount: entry?.refCount ?? (_currentPlayerUnsub ? 1 : 0),
    subscriptionStartedAt: _currentPlayerStartedAt,
    inFlight: _currentPlayerPromise != null,
    lastEnsure: _currentPlayerLastResult
      ? {
        ok: _currentPlayerLastResult.ok,
        status: _currentPlayerLastResult.status,
        scopedOnceFailed: _currentPlayerLastResult.scopedOnceFailed === true,
        durationMs: _currentPlayerLastResult.durationMs,
        error: _currentPlayerLastResult.error || null,
      }
      : null,
    playerScopedSubscriptions: playerSubs.map((e) => ({
      path: e.path,
      id: e.id,
      refCount: e.refCount,
    })),
    hasSocialSubscription: registry.some((e) =>
      e.path === 'trades'
      || e.path.startsWith('trades/')
      || e.path === 'playerDirectory'
      || e.path.startsWith('playerDirectory/')
      || e.path === 'leaderboards'
      || e.path.startsWith('leaderboards/')
      || e.path === 'leaderboardSeasons'
      || e.path.startsWith('leaderboardSeasons/')),
    rootListenerNote: 'Legacy root once + on(value) active as safety net; scoped player is intended eventual owner — do not depend on root winning.',
    bandwidthNote: 'Do not claim bandwidth reduction while root and scoped snapshots coexist.',
  };
}

/**
 * Named-scope status snapshot (S2 sharedDefs + S3 currentPlayer).
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
      [SCOPE_CURRENT_PLAYER]: {
        ready: isCurrentPlayerReady(),
        username: _currentPlayerUsername,
        path: _currentPlayerUsername ? _playerPath(_currentPlayerUsername) : null,
        subscriptionActive: _currentPlayerUnsub != null,
        lastStatus: _currentPlayerLastResult?.status || (_currentPlayerUnsub ? 'subscribed' : 'idle'),
        inFlight: _currentPlayerPromise != null,
      },
    },
    deferredScopes: [
      'trading',
      'leaderboard',
      'adminDirectory',
      'adminSelectedPlayer',
      'bootstrapPublicAccessCodes',
    ],
    shared: getSharedHydrationReport(),
    currentPlayer: getCurrentPlayerHydrationReport(),
  };
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcDbHydration = {
    SHARED_DEF_PATHS,
    SCOPE_SHARED_DEFS,
    SCOPE_CURRENT_PLAYER,
    hydrateSharedDefs,
    isSharedDefsReady,
    waitForSharedDefs,
    getHydrationStatus,
    getSharedHydrationReport,
    getCurrentPlayerHydrationReport,
    isCurrentPlayerReady,
    waitForCurrentPlayer,
    // Safe reuse probe — does not expose releaseCurrentPlayerScope (auth-owned)
    ensureCurrentPlayerScope,
    getScopedLoadingFlagState,
    isScopedLoadingDevFlagEnabled,
    // Thin mirrors for console verification
    isPathReady: (path) => db.isPathReady(path),
    waitForPath: (path, options) => db.waitForPath(path, options),
    loadPathOnce: (path, options) => db.loadPathOnce(path, options),
    clearCachedPath: (path) => db.clearCachedPath(path),
    getSubscriptionRegistry: () => db.getSubscriptionRegistry(),
    getCached: (path) => db.get(path),
    help() {
      console.info(`DB Hydration (Phase S2–S3)
Shared paths: ${SHARED_DEF_PATHS.join(', ')} (accessCodes excluded)
Current player: auth-owned ensure/hydrate/subscribe — release is NOT on this mirror
API:
  qcDbHydration.getSharedHydrationReport()
  qcDbHydration.getCurrentPlayerHydrationReport()
  qcDbHydration.getHydrationStatus()
  qcDbHydration.isCurrentPlayerReady()
  await qcDbHydration.ensureCurrentPlayerScope(username)  // reuse only; auth owns lifecycle
Root remains the legacy safety net; no bandwidth claim yet.`);
    },
  };
}

_installWindowApi();
