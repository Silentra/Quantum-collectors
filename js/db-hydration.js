/**
 * db-hydration.js — Named cache hydration scopes (Phase S2–S5c-D1)
 *
 * S2: sharedDefs — once-loads for config / cards / packs / groups.
 * S3: currentPlayer — auth-owned once-load + one subscribePath for players/{username}.
 * S5b: adminDirectory — Admin-owned playerDirectory subscribe;
 *      adminSelectedPlayer — Admin-owned players/{selected} or borrow auth current-player.
 * S5c-C: playerTradeIndex — auth-owned once-load + one subscribePath for
 *      playerTradeIndex/{username}; loads tradeIndexMeta once (no permanent listener).
 * S5c-D1: tradeDirectory — Trading-owned playerDirectory subscribe while Trading tab open.
 *      Does not share Admin's handle. No consumer cutover at D1.
 * S5c-D5b: groupListings — Trading-owned listingsByGroup/{groupId} while Trading tab open.
 *
 * accessCodes is intentionally NOT part of sharedDefs (register-only; do not broaden).
 * S6a: register uses once-load of accessCodes/{code}; bootstrap seed once-loads accessCodes/.
 * No accessCodes subscription.
 *
 * Root once('/') + on('value') remain the legacy safety net (unchanged). Root and scoped
 * player events may arrive in either order during coexistence — do not depend on root
 * events “winning.” No bandwidth claim while they coexist.
 */

import * as db from './database.js';
import * as metrics from './db-metrics.js';
import { DIRECTORY_ROOT, resolvePlayerDirectoryKey } from './player-directory.js';
import {
  CURRENT_TRADE_INDEX_SCHEMA_VERSION,
  PLAYER_TRADE_INDEX_ROOT,
  LISTINGS_BY_GROUP_ROOT,
  TRADE_INDEX_META_KEY,
  TRADE_INDEX_META_ROOT,
  isGlobalTradeIndexMetaCurrent,
  isGroupListingsIndexReady,
  isPlayerTradeIndexReady as isPlayerTradeIndexMetaReady,
} from './trade-index.js';

/** Dev flag prep (S7 cutover later). Does not disable the root listener. */
export const SCOPED_LOADING_LS_KEY = 'qc_scoped_loading';
export const SCOPED_LOADING_CONFIG_PATH = 'config/firebase/scopedLoadingEnabled';

/**
 * Approved shared definition paths for Phase S2.
 * Order is stable for reports; loads run in parallel.
 */
export const SHARED_DEF_PATHS = Object.freeze(['config', 'cards', 'packs', 'groups']);

export const SCOPE_SHARED_DEFS = 'sharedDefs';

/** S6a — accessCodes once-load roots (no subscription ownership). */
export const ACCESS_CODES_ROOT = 'accessCodes';
export const SCOPE_ACCESS_CODES = 'accessCodes';

/** @type {{ purpose: string, path: string, ok: boolean, mode?: string, reused?: boolean, error?: string|null, at: number }|null} */
let _lastAccessCodesLoad = null;
export const SCOPE_CURRENT_PLAYER = 'currentPlayer';
export const SCOPE_PLAYER_TRADE_INDEX = 'playerTradeIndex';

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
 * Flag prep + S7b boot latch surface.
 * Root attaches only in root-on boot; scoped boot skips root once+on.
 * @returns {object}
 */
export function getScopedLoadingFlagState() {
  const configEnabled = db.get(SCOPED_LOADING_CONFIG_PATH) === true;
  const boot = typeof db.getBootModeReport === 'function' ? db.getBootModeReport() : null;
  const scopedBoot = boot && boot.mode === 'scoped';
  return {
    localStorageEnabled: isScopedLoadingDevFlagEnabled(),
    configPath: SCOPED_LOADING_CONFIG_PATH,
    configEnabled,
    bootMode: boot ? boot.mode : null,
    bootReason: boot ? boot.reason : null,
    rootListenerAttached: boot ? boot.rootListenerAttached === true : null,
    rootListenerLegacySafetyNet: !scopedBoot,
    note: scopedBoot
      ? 'S7b scoped boot: root once+on skipped this page load. Reload required to change. Config path not used for boot latch.'
      : 'Default root-on: root once+on when Firebase OK. Set localStorage.qc_scoped_loading=true and reload for scoped boot (S7b).',
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

// ---------- Phase S6a: accessCodes once-load (no subscription) ----------

/**
 * Normalize access-code leaf key (uppercase trim).
 * @param {string} code
 * @returns {string}
 */
function _normalizeAccessCode(code) {
  return String(code || '').trim().toUpperCase();
}

/**
 * @param {string} purpose
 * @param {string} path
 * @param {{ ok?: boolean, mode?: string, reused?: boolean, error?: string|null }} result
 */
function _recordAccessCodesLoad(purpose, path, result) {
  _lastAccessCodesLoad = {
    purpose,
    path,
    ok: result?.ok === true,
    mode: result?.mode,
    reused: result?.reused === true,
    error: result?.error || null,
    at: Date.now(),
  };
}

/**
 * S6a register: scoped once-load of a single accessCodes/{code} leaf.
 * Uses force:true so bootstrap ancestor-readiness cannot skip a fresh code fetch.
 * No subscribePath.
 * @param {string} code
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, path: string, value: any, mode?: string, reused?: boolean, error?: string, purpose: 'register' }>}
 */
export async function loadAccessCodeOnce(code, options = {}) {
  const normalized = _normalizeAccessCode(code);
  if (!normalized) {
    const fail = {
      ok: false,
      path: '',
      value: null,
      error: 'Missing access code',
      purpose: 'register',
    };
    _recordAccessCodesLoad('register', '', fail);
    return fail;
  }
  const path = `${ACCESS_CODES_ROOT}/${normalized}`;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  const result = await db.loadPathOnce(path, { timeoutMs, force: true });
  _recordAccessCodesLoad('register', path, result);
  return {
    ...result,
    purpose: 'register',
  };
}

/**
 * S6a bootstrap/seed: once-load whole accessCodes collection to decide if empty.
 * No subscribePath. Admin bulk UI is separate and unchanged.
 * @param {{ timeoutMs?: number, force?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, path: string, value: any, mode?: string, reused?: boolean, error?: string, purpose: 'bootstrap', empty?: boolean, count?: number }>}
 */
export async function bootstrapAccessCodesOnce(options = {}) {
  const path = ACCESS_CODES_ROOT;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  const force = options.force === true;
  const result = await db.loadPathOnce(path, { timeoutMs, force });
  _recordAccessCodesLoad('bootstrap', path, result);
  if (!result.ok) {
    return { ...result, purpose: 'bootstrap', empty: true, count: 0 };
  }
  const children = db.getChildren(path) || [];
  return {
    ...result,
    purpose: 'bootstrap',
    empty: children.length === 0,
    count: children.length,
  };
}

/**
 * Last accessCodes once-load (register vs bootstrap) for DevTools / audit distinction.
 * @returns {object|null}
 */
export function getAccessCodesLoadReport() {
  const last = _lastAccessCodesLoad;
  return {
    phase: 'S6a/S7c',
    scope: SCOPE_ACCESS_CODES,
    root: ACCESS_CODES_ROOT,
    subscription: false,
    note: 'Once-load only. Register uses accessCodes/{code}; bootstrap/admin use accessCodes/.',
    lastLoad: last
      ? { ...last }
      : null,
    pathReady: {
      [ACCESS_CODES_ROOT]: db.isPathReady(ACCESS_CODES_ROOT),
    },
  };
}

/**
 * S7c Admin Access sub-tab: once-load whole accessCodes collection (no subscribe).
 * Distinguishes load failure from genuine empty (ok + empty).
 * @param {{ timeoutMs?: number, force?: boolean }} [options]
 * @returns {Promise<{
 *   ok: boolean, path: string, value: any, mode?: string, reused?: boolean,
 *   error?: string, purpose: 'admin-access', empty?: boolean, count?: number
 * }>}
 */
export async function loadAdminAccessCodesOnce(options = {}) {
  const path = ACCESS_CODES_ROOT;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  const force = options.force !== false;
  const result = await db.loadPathOnce(path, { timeoutMs, force });
  _recordAccessCodesLoad('admin-access', path, result);
  if (!result.ok) {
    return {
      ...result,
      purpose: 'admin-access',
      empty: false,
      count: 0,
      error: result.error || 'accessCodes once-load failed',
    };
  }
  const children = db.getChildren(path) || [];
  return {
    ...result,
    purpose: 'admin-access',
    empty: children.length === 0,
    count: children.length,
  };
}

/** S7c — leaderboard archive once-load roots (no subscription). */
export const LEADERBOARD_SEASONS_ROOT = 'leaderboardSeasons';
export const LEADERBOARD_SNAPSHOTS_ROOT = 'leaderboardSnapshots';
export const SCOPE_LEADERBOARD_ARCHIVES = 'leaderboardArchives';

/** @type {object|null} */
let _lastLeaderboardArchivesLoad = null;

/**
 * S7c: once-load leaderboardSeasons + leaderboardSnapshots (no subscribe).
 * ok===true only when both loads succeed. empty is meaningful only when ok.
 * @param {{ timeoutMs?: number, force?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function hydrateLeaderboardArchivesOnce(options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  const force = options.force !== false;
  const startedAt = Date.now();

  const [seasonsResult, snapshotsResult] = await Promise.all([
    db.loadPathOnce(LEADERBOARD_SEASONS_ROOT, { timeoutMs, force }),
    db.loadPathOnce(LEADERBOARD_SNAPSHOTS_ROOT, { timeoutMs, force }),
  ]);

  const seasonsOk = seasonsResult?.ok === true;
  const snapshotsOk = snapshotsResult?.ok === true;
  const ok = seasonsOk && snapshotsOk;

  const seasonsVal = seasonsOk ? db.get(LEADERBOARD_SEASONS_ROOT) : null;
  const snapshotsVal = snapshotsOk ? db.get(LEADERBOARD_SNAPSHOTS_ROOT) : null;
  const seasonsEmpty = seasonsOk && (
    seasonsVal == null
    || (typeof seasonsVal === 'object'
      && !seasonsVal.activeSeasonId
      && (!seasonsVal.seasons || Object.keys(seasonsVal.seasons).length === 0))
  );
  const snapshotsEmpty = snapshotsOk && (
    snapshotsVal == null
    || (typeof snapshotsVal === 'object'
      && (!snapshotsVal.snapshots || Object.keys(snapshotsVal.snapshots).length === 0))
  );

  const report = {
    phase: 'S7c',
    scope: SCOPE_LEADERBOARD_ARCHIVES,
    ok,
    subscription: false,
    durationMs: Date.now() - startedAt,
    at: Date.now(),
    seasons: {
      path: LEADERBOARD_SEASONS_ROOT,
      ok: seasonsOk,
      mode: seasonsResult?.mode,
      reused: seasonsResult?.reused === true,
      error: seasonsResult?.error || null,
      pathReady: db.isPathReady(LEADERBOARD_SEASONS_ROOT),
      empty: seasonsOk ? seasonsEmpty : false,
    },
    snapshots: {
      path: LEADERBOARD_SNAPSHOTS_ROOT,
      ok: snapshotsOk,
      mode: snapshotsResult?.mode,
      reused: snapshotsResult?.reused === true,
      error: snapshotsResult?.error || null,
      pathReady: db.isPathReady(LEADERBOARD_SNAPSHOTS_ROOT),
      empty: snapshotsOk ? snapshotsEmpty : false,
    },
    note: ok
      ? 'Archives once-loaded; schema ensure may run. empty≠failed.'
      : 'Load failed/unready — do not run schema ensure (unready ≠ empty).',
  };
  _lastLeaderboardArchivesLoad = report;
  return report;
}

/**
 * @returns {object|null}
 */
export function getLeaderboardArchivesHydrationReport() {
  return _lastLeaderboardArchivesLoad
    ? { ..._lastLeaderboardArchivesLoad }
    : {
      phase: 'S7c',
      scope: SCOPE_LEADERBOARD_ARCHIVES,
      ok: false,
      lastLoad: null,
      note: 'No archive once-load yet this page load.',
      pathReady: {
        [LEADERBOARD_SEASONS_ROOT]: db.isPathReady(LEADERBOARD_SEASONS_ROOT),
        [LEADERBOARD_SNAPSHOTS_ROOT]: db.isPathReady(LEADERBOARD_SNAPSHOTS_ROOT),
      },
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

  // Other players/* paths may be owned by Admin selected-player scope — ignore them.
  // Only refuse if THIS path is already subscribed without our auth handle (orphan / share).
  const existingSame = db.getSubscriptionRegistry().find((e) => e.path === path);
  if (existingSame && !_currentPlayerUnsub) {
    return {
      ok: false,
      path,
      username: u,
      reused: false,
      id: existingSame.id,
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

// ---------- Phase S5c-C: player trade index (auth-owned) ----------

/** @type {string|null} */
let _ptiUsername = null;
/** @type {(() => void)|null} */
let _ptiUnsub = null;
/** @type {string|null} */
let _ptiSubId = null;
/** @type {number|null} */
let _ptiStartedAt = null;
/** @type {Promise<object>|null} */
let _ptiPromise = null;
/** @type {object|null} */
let _ptiLastResult = null;
/** @type {object|null} */
let _ptiGlobalMetaLast = null;

function _ptiPath(username) {
  const u = _normalizeUsername(username);
  return u ? `${PLAYER_TRADE_INDEX_ROOT}/${u}` : '';
}

function _registryEntryForPlayerTradeIndex() {
  const path = _ptiUsername ? _ptiPath(_ptiUsername) : '';
  if (!path) return null;
  return db.getSubscriptionRegistry().find((e) => e.path === path) || null;
}

/**
 * Release the auth-owned playerTradeIndex/{me} subscription.
 * Does not clear cache or readiness. Auth is the sole caller — not on DevTools mirror.
 * @returns {{ released: boolean, previousUsername: string|null }}
 */
export function releasePlayerTradeIndexScope() {
  const previousUsername = _ptiUsername;
  if (_ptiUnsub) {
    try { _ptiUnsub(); } catch { /* ignore */ }
  }
  _ptiUnsub = null;
  _ptiSubId = null;
  _ptiUsername = null;
  _ptiStartedAt = null;
  _ptiPromise = null;
  _ptiLastResult = null;
  return { released: previousUsername != null, previousUsername };
}

/**
 * Scoped path subscribed and marked ready (does not alone prove reservation usability).
 * @param {string} [username]
 * @returns {boolean}
 */
export function isPlayerTradeIndexScopeReady(username) {
  const u = username != null && username !== ''
    ? _normalizeUsername(username)
    : _ptiUsername;
  if (!u) return false;
  if (_ptiUsername && u !== _ptiUsername) return false;
  return db.isPathReady(_ptiPath(u));
}

/**
 * Usable Research reservation index: scoped path ready + player _meta + global schema.
 * @param {string} [username]
 * @returns {boolean}
 */
export function isPlayerTradeIndexReady(username) {
  const u = username != null && username !== ''
    ? _normalizeUsername(username)
    : _ptiUsername;
  if (!u || u === '__admin__') return false;
  if (!isPlayerTradeIndexScopeReady(u)) return false;
  if (!isPlayerTradeIndexMetaReady(u)) return false;
  return isGlobalTradeIndexMetaCurrent();
}

/**
 * @param {string} [username]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, scope: string, path?: string, error?: string }>}
 */
export function waitForPlayerTradeIndex(username, options = {}) {
  const u = username != null && username !== ''
    ? _normalizeUsername(username)
    : _ptiUsername;
  if (!u) {
    return Promise.resolve({
      ok: false,
      scope: SCOPE_PLAYER_TRADE_INDEX,
      error: 'No player trade-index username',
    });
  }
  const path = _ptiPath(u);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  return db.waitForPath(path, { timeoutMs }).then((result) => ({
    ok: result.ok === true,
    scope: SCOPE_PLAYER_TRADE_INDEX,
    path,
    error: result.error,
  }));
}

/**
 * Once-load tradeIndexMeta (no permanent listener). Safe to call repeatedly.
 * @param {{ timeoutMs?: number, force?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function hydrateTradeIndexMeta(options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  const force = options.force === true;
  const load = await db.loadPathOnce(TRADE_INDEX_META_ROOT, { timeoutMs, force });
  _ptiGlobalMetaLast = {
    ok: load.ok === true,
    mode: load.mode,
    reused: load.reused === true,
    schemaVersion: db.get(`${TRADE_INDEX_META_ROOT}/schemaVersion`),
    rebuiltAt: db.get(`${TRADE_INDEX_META_ROOT}/rebuiltAt`),
    current: isGlobalTradeIndexMetaCurrent(),
    expectedVersion: CURRENT_TRADE_INDEX_SCHEMA_VERSION,
    error: load.ok ? null : (load.error || 'Load failed'),
  };
  return _ptiGlobalMetaLast;
}

/**
 * @param {string} username
 * @returns {{ ok: boolean, path: string, username: string, reused: boolean, id: string, refCount?: number, error?: string }}
 */
export function subscribePlayerTradeIndex(username) {
  const u = _normalizeUsername(username);
  if (!u || u === '__admin__') {
    return {
      ok: false,
      path: '',
      username: u || '',
      reused: false,
      id: '',
      error: u === '__admin__' ? 'Standalone __admin__ has no player trade-index scope' : 'Invalid username',
    };
  }

  const path = _ptiPath(u);

  if (_ptiUsername === u && _ptiUnsub) {
    const entry = _registryEntryForPlayerTradeIndex();
    return {
      ok: true,
      path,
      username: u,
      reused: true,
      id: _ptiSubId || entry?.id || '',
      refCount: entry?.refCount ?? 1,
    };
  }

  if (_ptiUsername && _ptiUsername !== u) {
    releasePlayerTradeIndexScope();
  }

  const existingSame = db.getSubscriptionRegistry().find((e) => e.path === path);
  if (existingSame && !_ptiUnsub) {
    return {
      ok: false,
      path,
      username: u,
      reused: false,
      id: existingSame.id,
      error: 'Player trade-index path already subscribed without auth owner handle',
    };
  }

  const handle = db.subscribePath(path);
  const entryAfter = db.getSubscriptionRegistry().find((e) => e.path === path);
  if (entryAfter && entryAfter.refCount > 1) {
    try { handle.unsubscribe(); } catch { /* ignore */ }
    return {
      ok: false,
      path,
      username: u,
      reused: false,
      id: handle.id,
      error: 'Refusing to share playerTradeIndex subscription (auth must be sole owner)',
    };
  }

  _ptiUsername = u;
  _ptiUnsub = handle.unsubscribe;
  _ptiSubId = handle.id;
  _ptiStartedAt = _ptiStartedAt || Date.now();

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
 * Auth-owned ensure: once-load playerTradeIndex/{u} + subscribe + once-load tradeIndexMeta.
 * Concurrent same-username callers share one in-flight Promise. refCount stays 1.
 *
 * @param {string} username
 * @param {{ timeoutMs?: number, force?: boolean, ackCacheFallback?: boolean }} [options]
 * @returns {Promise<object>}
 */
export function ensurePlayerTradeIndexScope(username, options = {}) {
  const u = _normalizeUsername(username);
  if (!u || u === '__admin__') {
    return Promise.resolve({
      ok: false,
      scope: SCOPE_PLAYER_TRADE_INDEX,
      path: '',
      username: u || '',
      error: u === '__admin__' ? 'Standalone __admin__ has no player trade-index scope' : 'Invalid username',
    });
  }

  const force = options.force === true;

  if (
    !force
    && _ptiUsername === u
    && _ptiUnsub
    && db.isPathReady(_ptiPath(u))
  ) {
    return Promise.resolve({
      ok: true,
      scope: SCOPE_PLAYER_TRADE_INDEX,
      path: _ptiPath(u),
      username: u,
      reused: true,
      subscriptionActive: true,
      subscriptionRefCount: _registryEntryForPlayerTradeIndex()?.refCount ?? 1,
      ready: true,
      metaReady: isPlayerTradeIndexMetaReady(u),
      globalVersionCurrent: isGlobalTradeIndexMetaCurrent(),
      usable: isPlayerTradeIndexReady(u),
    });
  }

  if (_ptiPromise && _ptiUsername === u && !force) {
    return _ptiPromise.then((result) => ({ ...result, reused: true }));
  }

  _ptiPromise = _runEnsurePlayerTradeIndex(u, options).then((result) => {
    _ptiLastResult = result;
    return result;
  }).finally(() => {
    _ptiPromise = null;
  });

  return _ptiPromise;
}

/**
 * @param {string} u
 * @param {{ timeoutMs?: number, force?: boolean, ackCacheFallback?: boolean }} options
 */
async function _runEnsurePlayerTradeIndex(u, options = {}) {
  const path = _ptiPath(u);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  const force = options.force === true;
  const ackCacheFallback = options.ackCacheFallback === true;
  const startedAt = Date.now();

  metrics.mark('playerTradeIndexHydrateStart');
  if (typeof metrics.recordTradeIndexLifecycle === 'function') {
    metrics.recordTradeIndexLifecycle({
      tag: 'playerTradeIndexHydrateStart',
      ops: 0,
      ok: true,
      username: u,
    });
  }

  if (_ptiUsername && _ptiUsername !== u) {
    releasePlayerTradeIndexScope();
  }

  // Global meta once (no permanent listener)
  await hydrateTradeIndexMeta({ timeoutMs, force: false });

  let scopedOnceFailed = false;
  let load = await db.loadPathOnce(path, { timeoutMs, force });

  if (!load.ok) {
    if (ackCacheFallback && db.get(path)) {
      scopedOnceFailed = true;
      console.warn(
        '[Hydration] Player trade-index once-load failed after acknowledged write; using ack cache + subscribe:',
        load.error,
      );
    } else {
      metrics.mark('playerTradeIndexHydrateFailed');
      if (typeof metrics.recordTradeIndexLifecycle === 'function') {
        metrics.recordTradeIndexLifecycle({
          tag: 'playerTradeIndexHydrateFailed',
          ops: 0,
          ok: false,
          username: u,
        });
      }
      return {
        ok: false,
        scope: SCOPE_PLAYER_TRADE_INDEX,
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

  _ptiUsername = u;
  _ptiStartedAt = startedAt;

  const sub = subscribePlayerTradeIndex(u);
  if (!sub.ok) {
    metrics.mark('playerTradeIndexHydrateFailed');
    if (typeof metrics.recordTradeIndexLifecycle === 'function') {
      metrics.recordTradeIndexLifecycle({
        tag: 'playerTradeIndexHydrateFailed',
        ops: 0,
        ok: false,
        username: u,
      });
    }
    return {
      ok: false,
      scope: SCOPE_PLAYER_TRADE_INDEX,
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
      console.warn(
        '[Hydration] waitForPath timeout on playerTradeIndex after register ack; continuing with cache present',
      );
    } else {
      metrics.mark('playerTradeIndexHydrateFailed');
      if (typeof metrics.recordTradeIndexLifecycle === 'function') {
        metrics.recordTradeIndexLifecycle({
          tag: 'playerTradeIndexHydrateFailed',
          ops: 0,
          ok: false,
          username: u,
        });
      }
      return {
        ok: false,
        scope: SCOPE_PLAYER_TRADE_INDEX,
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

  metrics.mark('playerTradeIndexHydrateComplete');
  if (typeof metrics.recordTradeIndexLifecycle === 'function') {
    metrics.recordTradeIndexLifecycle({
      tag: 'playerTradeIndexHydrateComplete',
      ops: 0,
      ok: true,
      username: u,
    });
  }

  const entry = _registryEntryForPlayerTradeIndex();
  const completedAt = Date.now();
  const metaReady = isPlayerTradeIndexMetaReady(u);
  const globalVersionCurrent = isGlobalTradeIndexMetaCurrent();

  return {
    ok: true,
    scope: SCOPE_PLAYER_TRADE_INDEX,
    path,
    username: u,
    status: scopedOnceFailed ? 'ready-with-once-fallback' : 'ready',
    reused: false,
    scopedOnceFailed,
    subscriptionActive: _ptiUnsub != null,
    subscriptionId: _ptiSubId,
    subscriptionRefCount: entry?.refCount ?? 1,
    ready: db.isPathReady(path),
    metaReady,
    globalVersionCurrent,
    usable: metaReady && globalVersionCurrent && db.isPathReady(path),
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    note: 'S5c-C playerTradeIndex once + subscribe beside legacy root safety net. No bandwidth claim.',
  };
}

/**
 * Dev report — no index payloads, inventories, or sessions.
 * @returns {object}
 */
export function getPlayerTradeIndexHydrationReport() {
  const entry = _registryEntryForPlayerTradeIndex();
  const path = _ptiUsername ? _ptiPath(_ptiUsername) : null;
  const meta = _ptiUsername
    ? db.get(`${PLAYER_TRADE_INDEX_ROOT}/${_ptiUsername}/${TRADE_INDEX_META_KEY}`)
    : null;

  return {
    phase: 'S5c-C',
    scope: SCOPE_PLAYER_TRADE_INDEX,
    username: _ptiUsername,
    path,
    ready: isPlayerTradeIndexScopeReady(),
    metaReady: _ptiUsername ? isPlayerTradeIndexMetaReady(_ptiUsername) : false,
    metaPresent: meta != null,
    metaVersion: meta?.v ?? null,
    expectedMetaVersion: CURRENT_TRADE_INDEX_SCHEMA_VERSION,
    globalVersionCurrent: isGlobalTradeIndexMetaCurrent(),
    globalSchemaVersion: db.get(`${TRADE_INDEX_META_ROOT}/schemaVersion`) ?? null,
    usable: isPlayerTradeIndexReady(),
    active: _ptiUnsub != null,
    refCount: entry?.refCount ?? (_ptiUnsub ? 1 : 0),
    subscriptionId: _ptiSubId,
    subscriptionStartedAt: _ptiStartedAt,
    lastEnsure: _ptiLastResult
      ? {
        ok: _ptiLastResult.ok,
        status: _ptiLastResult.status,
        scopedOnceFailed: _ptiLastResult.scopedOnceFailed === true,
        durationMs: _ptiLastResult.durationMs,
        usable: _ptiLastResult.usable === true,
        error: _ptiLastResult.error || null,
      }
      : null,
    globalMetaLast: _ptiGlobalMetaLast
      ? {
        ok: _ptiGlobalMetaLast.ok,
        current: _ptiGlobalMetaLast.current,
        schemaVersion: _ptiGlobalMetaLast.schemaVersion,
        error: _ptiGlobalMetaLast.error,
      }
      : null,
    inFlight: _ptiPromise != null,
    rootListenerNote: 'Canonical fallback allowed only while legacy root coexistence provides trades trees.',
  };
}

// ---------- Phase S5b: Admin directory + selected player ----------

export const SCOPE_ADMIN_DIRECTORY = 'adminDirectory';
export const SCOPE_ADMIN_SELECTED_PLAYER = 'adminSelectedPlayer';

const ADMIN_DIRECTORY_PATH = DIRECTORY_ROOT; // 'playerDirectory'

/** @type {(() => void)|null} */
let _adminDirUnsub = null;
/** @type {string|null} */
let _adminDirSubId = null;
/** @type {number|null} */
let _adminDirStartedAt = null;
/** @type {Promise<object>|null} */
let _adminDirPromise = null;

/** @type {string|null} */
let _adminSelectedUsername = null;
/** @type {(() => void)|null} */
let _adminSelectedUnsub = null;
/** @type {string|null} */
let _adminSelectedSubId = null;
/** @type {boolean} */
let _adminSelectedBorrowed = false;
/** @type {Promise<object>|null} */
let _adminSelectedPromise = null;
/** @type {string|null} — in-flight target for dedupe / supersession */
let _adminSelectedInFlightKey = null;

function _isAuthOwnedCurrentPlayer(playerKey) {
  if (!_currentPlayerUsername || !playerKey) return false;
  return (
    _currentPlayerUsername === playerKey
    || _currentPlayerUsername === String(playerKey).toLowerCase()
  );
}

function _registryEntry(path) {
  return db.getSubscriptionRegistry().find((e) => e.path === path) || null;
}

/**
 * @returns {boolean}
 */
export function isAdminDirectoryReady() {
  return db.isPathReady(ADMIN_DIRECTORY_PATH);
}

/**
 * @param {{ timeoutMs?: number }} [options]
 */
export function waitForAdminDirectory(options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  return db.waitForPath(ADMIN_DIRECTORY_PATH, { timeoutMs }).then((result) => ({
    ok: result.ok === true,
    scope: SCOPE_ADMIN_DIRECTORY,
    path: ADMIN_DIRECTORY_PATH,
    error: result.error,
  }));
}

/**
 * Release Admin-owned playerDirectory subscription. Does not clear cache.
 */
export function releaseAdminDirectoryScope() {
  if (_adminDirUnsub) {
    try { _adminDirUnsub(); } catch { /* ignore */ }
  }
  _adminDirUnsub = null;
  _adminDirSubId = null;
  _adminDirStartedAt = null;
  _adminDirPromise = null;
  return { released: true, path: ADMIN_DIRECTORY_PATH };
}

/**
 * Ensure exactly one Admin-owned subscription to playerDirectory.
 * @param {{ timeoutMs?: number, force?: boolean }} [options]
 */
export function ensureAdminDirectoryScope(options = {}) {
  const force = options.force === true;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;

  if (!force && _adminDirUnsub && isAdminDirectoryReady()) {
    const entry = _registryEntry(ADMIN_DIRECTORY_PATH);
    return Promise.resolve({
      ok: true,
      scope: SCOPE_ADMIN_DIRECTORY,
      path: ADMIN_DIRECTORY_PATH,
      reused: true,
      subscriptionActive: true,
      subscriptionRefCount: entry?.refCount ?? 1,
      ready: true,
    });
  }

  if (_adminDirPromise && !force) {
    return _adminDirPromise.then((r) => ({ ...r, reused: true }));
  }

  _adminDirPromise = (async () => {
    if (force) {
      releaseAdminDirectoryScope();
    }

    const load = await db.loadPathOnce(ADMIN_DIRECTORY_PATH, { timeoutMs, force });
    if (!load.ok) {
      return {
        ok: false,
        scope: SCOPE_ADMIN_DIRECTORY,
        path: ADMIN_DIRECTORY_PATH,
        error: load.error || 'Directory load failed',
        ready: false,
      };
    }

    if (_adminDirUnsub) {
      const entry = _registryEntry(ADMIN_DIRECTORY_PATH);
      return {
        ok: true,
        scope: SCOPE_ADMIN_DIRECTORY,
        path: ADMIN_DIRECTORY_PATH,
        reused: true,
        subscriptionActive: true,
        subscriptionRefCount: entry?.refCount ?? 1,
        ready: isAdminDirectoryReady(),
      };
    }

    const handle = db.subscribePath(ADMIN_DIRECTORY_PATH);
    const entryAfter = _registryEntry(ADMIN_DIRECTORY_PATH);
    if (entryAfter && entryAfter.refCount > 1) {
      try { handle.unsubscribe(); } catch { /* ignore */ }
      return {
        ok: false,
        scope: SCOPE_ADMIN_DIRECTORY,
        path: ADMIN_DIRECTORY_PATH,
        error: 'Refusing to share playerDirectory subscription (Admin must be sole owner)',
        ready: false,
      };
    }

    _adminDirUnsub = handle.unsubscribe;
    _adminDirSubId = handle.id;
    _adminDirStartedAt = Date.now();

    const wait = await db.waitForPath(ADMIN_DIRECTORY_PATH, { timeoutMs });
    return {
      ok: wait.ok === true,
      scope: SCOPE_ADMIN_DIRECTORY,
      path: ADMIN_DIRECTORY_PATH,
      reused: false,
      subscriptionActive: _adminDirUnsub != null,
      subscriptionId: _adminDirSubId,
      subscriptionRefCount: entryAfter?.refCount ?? 1,
      ready: isAdminDirectoryReady(),
      error: wait.ok ? null : (wait.error || 'timeout'),
    };
  })().finally(() => {
    _adminDirPromise = null;
  });

  return _adminDirPromise;
}

export function getAdminDirectoryHydrationReport() {
  const entry = _registryEntry(ADMIN_DIRECTORY_PATH);
  return {
    phase: 'S5b',
    scope: SCOPE_ADMIN_DIRECTORY,
    path: ADMIN_DIRECTORY_PATH,
    ready: isAdminDirectoryReady(),
    active: _adminDirUnsub != null,
    subscriptionId: _adminDirSubId,
    refCount: entry?.refCount ?? (_adminDirUnsub ? 1 : 0),
    startedAt: _adminDirStartedAt,
    inFlight: _adminDirPromise != null,
  };
}

/**
 * Release Admin-selected player. Never releases auth current-player scope.
 * @param {{ preserveInFlight?: boolean }} [options] — set preserveInFlight when switching
 *   selection inside ensureAdminSelectedPlayerScope so the new target stays current.
 */
export function releaseAdminSelectedPlayerScope(options = {}) {
  const prev = _adminSelectedUsername;
  const wasBorrowed = _adminSelectedBorrowed;
  if (!_adminSelectedBorrowed && _adminSelectedUnsub) {
    try { _adminSelectedUnsub(); } catch { /* ignore */ }
  }
  _adminSelectedUnsub = null;
  _adminSelectedSubId = null;
  _adminSelectedUsername = null;
  _adminSelectedBorrowed = false;
  _adminSelectedPromise = null;
  if (options.preserveInFlight !== true) {
    _adminSelectedInFlightKey = null;
  }
  return { released: prev != null, previousUsername: prev, borrowed: wasBorrowed };
}

/**
 * Ensure Admin selected-player scope. Self → borrow auth current-player (no second network sub).
 * @param {string} username
 * @param {{ timeoutMs?: number, force?: boolean }} [options]
 */
export function ensureAdminSelectedPlayerScope(username, options = {}) {
  const playerKey = resolvePlayerDirectoryKey(username);
  if (!playerKey || playerKey === '__admin__') {
    return Promise.resolve({
      ok: false,
      scope: SCOPE_ADMIN_SELECTED_PLAYER,
      path: '',
      error: 'Invalid selected username',
    });
  }

  // Auth current-player paths are normalized lowercase; prefer that path when self.
  const isSelf = _isAuthOwnedCurrentPlayer(playerKey);
  const authPath = isSelf && _currentPlayerUsername
    ? _playerPath(_currentPlayerUsername)
    : `players/${playerKey}`;
  const path = authPath;
  const force = options.force === true;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;

  if (
    !force
    && _adminSelectedUsername === playerKey
    && (_adminSelectedBorrowed || _adminSelectedUnsub)
    && db.isPathReady(path)
  ) {
    return Promise.resolve({
      ok: true,
      scope: SCOPE_ADMIN_SELECTED_PLAYER,
      path,
      username: playerKey,
      reused: true,
      borrowedFromCurrentPlayer: _adminSelectedBorrowed,
      subscriptionActive: _adminSelectedBorrowed ? false : _adminSelectedUnsub != null,
      subscriptionRefCount: _registryEntry(path)?.refCount ?? 1,
      ready: true,
    });
  }

  if (_adminSelectedPromise && _adminSelectedInFlightKey === playerKey && !force) {
    return _adminSelectedPromise.then((r) => ({ ...r, reused: true }));
  }

  _adminSelectedInFlightKey = playerKey;
  const run = (async () => {
    // Switching selection: release prior Admin-owned sub (not auth)
    if (_adminSelectedUsername && _adminSelectedUsername !== playerKey) {
      releaseAdminSelectedPlayerScope({ preserveInFlight: true });
    } else if (force && _adminSelectedUsername === playerKey && !_adminSelectedBorrowed) {
      releaseAdminSelectedPlayerScope({ preserveInFlight: true });
    }

    const superseded = () => _adminSelectedInFlightKey !== playerKey;

    // Self → always borrow auth-owned current-player; never open a second players/{me} sub
    if (isSelf) {
      if (!_currentPlayerUnsub) {
        const waitAuth = await waitForCurrentPlayer(_currentPlayerUsername, { timeoutMs });
        if (!waitAuth.ok || !_currentPlayerUnsub) {
          return {
            ok: false,
            scope: SCOPE_ADMIN_SELECTED_PLAYER,
            path,
            username: playerKey,
            borrowedFromCurrentPlayer: true,
            error: waitAuth.error || 'Auth current-player scope not active; cannot borrow',
            ready: false,
          };
        }
      }
      if (superseded()) {
        return {
          ok: false,
          scope: SCOPE_ADMIN_SELECTED_PLAYER,
          path,
          username: playerKey,
          superseded: true,
          error: 'Selection superseded',
          ready: false,
        };
      }

      _adminSelectedUsername = playerKey;
      _adminSelectedBorrowed = true;
      _adminSelectedUnsub = null;
      _adminSelectedSubId = _currentPlayerSubId;

      if (!db.isPathReady(path)) {
        const wait = await db.waitForPath(path, { timeoutMs });
        if (!wait.ok) {
          if (!superseded()) releaseAdminSelectedPlayerScope();
          return {
            ok: false,
            scope: SCOPE_ADMIN_SELECTED_PLAYER,
            path,
            username: playerKey,
            borrowedFromCurrentPlayer: true,
            error: wait.error || 'timeout',
            ready: false,
          };
        }
      }

      return {
        ok: true,
        scope: SCOPE_ADMIN_SELECTED_PLAYER,
        path,
        username: playerKey,
        reused: false,
        borrowedFromCurrentPlayer: true,
        subscriptionActive: false,
        subscriptionRefCount: _registryEntry(path)?.refCount ?? 1,
        ready: true,
        note: 'Borrowed auth-owned current-player subscription; no second network listener',
      };
    }

    // Explicit scoped load — do not treat root cache as success without scoped ready
    const load = await db.loadPathOnce(path, { timeoutMs, force: true });
    if (!load.ok) {
      return {
        ok: false,
        scope: SCOPE_ADMIN_SELECTED_PLAYER,
        path,
        username: playerKey,
        error: load.error || 'Selected player load failed',
        ready: false,
      };
    }

    if (!db.get(path)) {
      return {
        ok: false,
        scope: SCOPE_ADMIN_SELECTED_PLAYER,
        path,
        username: playerKey,
        error: 'Player not found',
        ready: false,
      };
    }

    if (superseded()) {
      return {
        ok: false,
        scope: SCOPE_ADMIN_SELECTED_PLAYER,
        path,
        username: playerKey,
        superseded: true,
        error: 'Selection superseded',
        ready: false,
      };
    }

    let createdHandle = null;
    if (!(_adminSelectedUnsub && _adminSelectedUsername === playerKey)) {
      const handle = db.subscribePath(path);
      createdHandle = handle;
      const entryAfter = _registryEntry(path);
      // Auth owns players/{me}; never share. Other unexpected owners also refuse.
      if (entryAfter && entryAfter.refCount > 1) {
        try { handle.unsubscribe(); } catch { /* ignore */ }
        return {
          ok: false,
          scope: SCOPE_ADMIN_SELECTED_PLAYER,
          path,
          username: playerKey,
          error: 'Path already has a network subscription; cannot acquire Admin selected-player share',
          ready: false,
        };
      }
      if (superseded()) {
        try { handle.unsubscribe(); } catch { /* ignore */ }
        return {
          ok: false,
          scope: SCOPE_ADMIN_SELECTED_PLAYER,
          path,
          username: playerKey,
          superseded: true,
          error: 'Selection superseded',
          ready: false,
        };
      }
      _adminSelectedUnsub = handle.unsubscribe;
      _adminSelectedSubId = handle.id;
    }

    _adminSelectedUsername = playerKey;
    _adminSelectedBorrowed = false;

    const wait = await db.waitForPath(path, { timeoutMs });
    if (!wait.ok) {
      if (!superseded()) releaseAdminSelectedPlayerScope();
      else if (createdHandle) {
        try { createdHandle.unsubscribe(); } catch { /* ignore */ }
      }
      return {
        ok: false,
        scope: SCOPE_ADMIN_SELECTED_PLAYER,
        path,
        username: playerKey,
        error: wait.error || 'timeout',
        ready: false,
      };
    }

    if (superseded()) {
      if (createdHandle) {
        try { createdHandle.unsubscribe(); } catch { /* ignore */ }
      }
      // Do not releaseAdminSelectedPlayerScope — a newer selection owns Admin state
      return {
        ok: false,
        scope: SCOPE_ADMIN_SELECTED_PLAYER,
        path,
        username: playerKey,
        superseded: true,
        error: 'Selection superseded',
        ready: false,
      };
    }

    return {
      ok: true,
      scope: SCOPE_ADMIN_SELECTED_PLAYER,
      path,
      username: playerKey,
      reused: false,
      borrowedFromCurrentPlayer: false,
      subscriptionActive: _adminSelectedUnsub != null,
      subscriptionId: _adminSelectedSubId,
      subscriptionRefCount: _registryEntry(path)?.refCount ?? 1,
      ready: true,
    };
  })();

  _adminSelectedPromise = run;
  run.finally(() => {
    if (_adminSelectedInFlightKey === playerKey) _adminSelectedInFlightKey = null;
    if (_adminSelectedPromise === run) _adminSelectedPromise = null;
  });

  return run;
}

export function getAdminSelectedPlayerReport() {
  const path = _adminSelectedUsername
    ? (_adminSelectedBorrowed && _currentPlayerUsername
      ? _playerPath(_currentPlayerUsername)
      : `players/${_adminSelectedUsername}`)
    : null;
  const entry = path ? _registryEntry(path) : null;
  return {
    phase: 'S5b',
    scope: SCOPE_ADMIN_SELECTED_PLAYER,
    username: _adminSelectedUsername,
    path,
    ready: path ? db.isPathReady(path) : false,
    active: _adminSelectedUnsub != null || _adminSelectedBorrowed,
    borrowedFromCurrentPlayer: _adminSelectedBorrowed,
    subscriptionId: _adminSelectedSubId,
    refCount: entry?.refCount ?? (_adminSelectedUnsub ? 1 : (_adminSelectedBorrowed ? (entry?.refCount ?? 1) : 0)),
    inFlight: _adminSelectedPromise != null,
  };
}

// ---------- Phase S5c-D1: Trading-owned playerDirectory ----------

export const SCOPE_TRADE_DIRECTORY = 'tradeDirectory';

const TRADE_DIRECTORY_PATH = DIRECTORY_ROOT; // 'playerDirectory'

/** @type {(() => void)|null} */
let _tradeDirUnsub = null;
/** @type {string|null} */
let _tradeDirSubId = null;
/** @type {number|null} */
let _tradeDirStartedAt = null;
/** @type {Promise<object>|null} */
let _tradeDirPromise = null;
/** @type {number} — bumped on release to cancel in-flight ensure */
let _tradeDirGeneration = 0;
/** @type {object|null} */
let _tradeDirLastResult = null;

/**
 * @returns {boolean}
 */
export function isTradeDirectoryReady() {
  return db.isPathReady(TRADE_DIRECTORY_PATH);
}

/**
 * @param {{ timeoutMs?: number }} [options]
 */
export function waitForTradeDirectory(options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  return db.waitForPath(TRADE_DIRECTORY_PATH, { timeoutMs }).then((result) => ({
    ok: result.ok === true,
    scope: SCOPE_TRADE_DIRECTORY,
    path: TRADE_DIRECTORY_PATH,
    error: result.error,
  }));
}

/**
 * Release Trading-owned playerDirectory subscription. Does not clear cache/readiness.
 * Does not touch Admin's directory handle. Bumps generation so late ensures discard handles.
 */
export function releaseTradeDirectoryScope() {
  _tradeDirGeneration += 1;
  if (_tradeDirUnsub) {
    try { _tradeDirUnsub(); } catch { /* ignore */ }
  }
  _tradeDirUnsub = null;
  _tradeDirSubId = null;
  _tradeDirStartedAt = null;
  _tradeDirPromise = null;
  return { released: true, path: TRADE_DIRECTORY_PATH };
}

/**
 * Ensure exactly one Trading-owned subscription to playerDirectory.
 * Refuses to share with Admin (or any other) holder (refCount must stay 1 after acquire).
 * @param {{ timeoutMs?: number, force?: boolean }} [options]
 * @returns {Promise<object>}
 */
export function ensureTradeDirectoryScope(options = {}) {
  const force = options.force === true;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;

  if (!force && _tradeDirUnsub && isTradeDirectoryReady()) {
    const entry = _registryEntry(TRADE_DIRECTORY_PATH);
    const reused = {
      ok: true,
      scope: SCOPE_TRADE_DIRECTORY,
      path: TRADE_DIRECTORY_PATH,
      reused: true,
      subscriptionActive: true,
      subscriptionRefCount: entry?.refCount ?? 1,
      subscriptionId: _tradeDirSubId,
      ready: true,
    };
    _tradeDirLastResult = reused;
    return Promise.resolve(reused);
  }

  if (_tradeDirPromise && !force) {
    return _tradeDirPromise.then((r) => ({ ...r, reused: true }));
  }

  const myGen = _tradeDirGeneration;

  _tradeDirPromise = (async () => {
    metrics.mark('tradingDirectoryHydrateStart');

    if (force) {
      // force: drop our handle without cancelling this ensure's generation
      if (_tradeDirUnsub) {
        try { _tradeDirUnsub(); } catch { /* ignore */ }
      }
      _tradeDirUnsub = null;
      _tradeDirSubId = null;
      _tradeDirStartedAt = null;
    }

    if (myGen !== _tradeDirGeneration) {
      const cancelled = {
        ok: false,
        cancelled: true,
        scope: SCOPE_TRADE_DIRECTORY,
        path: TRADE_DIRECTORY_PATH,
        error: 'Trading directory ensure cancelled',
        ready: false,
      };
      _tradeDirLastResult = cancelled;
      metrics.mark('tradingDirectoryHydrateFailed');
      return cancelled;
    }

    const load = await db.loadPathOnce(TRADE_DIRECTORY_PATH, { timeoutMs, force });
    if (myGen !== _tradeDirGeneration) {
      const cancelled = {
        ok: false,
        cancelled: true,
        scope: SCOPE_TRADE_DIRECTORY,
        path: TRADE_DIRECTORY_PATH,
        error: 'Trading directory ensure cancelled',
        ready: false,
      };
      _tradeDirLastResult = cancelled;
      metrics.mark('tradingDirectoryHydrateFailed');
      return cancelled;
    }

    if (!load.ok) {
      const failed = {
        ok: false,
        scope: SCOPE_TRADE_DIRECTORY,
        path: TRADE_DIRECTORY_PATH,
        error: load.error || 'Directory load failed',
        ready: false,
      };
      _tradeDirLastResult = failed;
      metrics.mark('tradingDirectoryHydrateFailed');
      return failed;
    }

    if (_tradeDirUnsub) {
      const entry = _registryEntry(TRADE_DIRECTORY_PATH);
      const reused = {
        ok: true,
        scope: SCOPE_TRADE_DIRECTORY,
        path: TRADE_DIRECTORY_PATH,
        reused: true,
        subscriptionActive: true,
        subscriptionRefCount: entry?.refCount ?? 1,
        subscriptionId: _tradeDirSubId,
        ready: isTradeDirectoryReady(),
      };
      _tradeDirLastResult = reused;
      metrics.mark('tradingDirectoryHydrateComplete');
      return reused;
    }

    const handle = db.subscribePath(TRADE_DIRECTORY_PATH);
    if (myGen !== _tradeDirGeneration) {
      try { handle.unsubscribe(); } catch { /* ignore */ }
      const cancelled = {
        ok: false,
        cancelled: true,
        scope: SCOPE_TRADE_DIRECTORY,
        path: TRADE_DIRECTORY_PATH,
        error: 'Trading directory ensure cancelled',
        ready: false,
      };
      _tradeDirLastResult = cancelled;
      metrics.mark('tradingDirectoryHydrateFailed');
      return cancelled;
    }

    const entryAfter = _registryEntry(TRADE_DIRECTORY_PATH);
    if (entryAfter && entryAfter.refCount > 1) {
      try { handle.unsubscribe(); } catch { /* ignore */ }
      const failed = {
        ok: false,
        scope: SCOPE_TRADE_DIRECTORY,
        path: TRADE_DIRECTORY_PATH,
        error: 'Refusing to share playerDirectory subscription (Trading must be sole owner)',
        ready: false,
      };
      _tradeDirLastResult = failed;
      metrics.mark('tradingDirectoryHydrateFailed');
      return failed;
    }

    _tradeDirUnsub = handle.unsubscribe;
    _tradeDirSubId = handle.id;
    _tradeDirStartedAt = Date.now();

    const wait = await db.waitForPath(TRADE_DIRECTORY_PATH, { timeoutMs });
    if (myGen !== _tradeDirGeneration) {
      if (_tradeDirUnsub === handle.unsubscribe) {
        try { handle.unsubscribe(); } catch { /* ignore */ }
        _tradeDirUnsub = null;
        _tradeDirSubId = null;
        _tradeDirStartedAt = null;
      }
      const cancelled = {
        ok: false,
        cancelled: true,
        scope: SCOPE_TRADE_DIRECTORY,
        path: TRADE_DIRECTORY_PATH,
        error: 'Trading directory ensure cancelled',
        ready: false,
      };
      _tradeDirLastResult = cancelled;
      metrics.mark('tradingDirectoryHydrateFailed');
      return cancelled;
    }

    const result = {
      ok: wait.ok === true,
      scope: SCOPE_TRADE_DIRECTORY,
      path: TRADE_DIRECTORY_PATH,
      reused: false,
      subscriptionActive: _tradeDirUnsub != null,
      subscriptionId: _tradeDirSubId,
      subscriptionRefCount: entryAfter?.refCount ?? 1,
      ready: isTradeDirectoryReady(),
      error: wait.ok ? null : (wait.error || 'timeout'),
    };
    _tradeDirLastResult = result;
    if (result.ok) {
      metrics.mark('tradingDirectoryHydrateComplete');
    } else {
      metrics.mark('tradingDirectoryHydrateFailed');
    }
    return result;
  })();

  const run = _tradeDirPromise;
  run.finally(() => {
    if (_tradeDirPromise === run) {
      _tradeDirPromise = null;
    }
  });

  return run;
}

export function getTradeDirectoryHydrationReport() {
  const entry = _registryEntry(TRADE_DIRECTORY_PATH);
  return {
    phase: 'S5c-D1',
    scope: SCOPE_TRADE_DIRECTORY,
    path: TRADE_DIRECTORY_PATH,
    ready: isTradeDirectoryReady(),
    active: _tradeDirUnsub != null,
    subscriptionId: _tradeDirSubId,
    refCount: entry?.refCount ?? (_tradeDirUnsub ? 1 : 0),
    startedAt: _tradeDirStartedAt,
    inFlight: _tradeDirPromise != null,
    lastResult: _tradeDirLastResult
      ? {
        ok: _tradeDirLastResult.ok === true,
        cancelled: _tradeDirLastResult.cancelled === true,
        error: _tradeDirLastResult.error || null,
        reused: _tradeDirLastResult.reused === true,
      }
      : null,
  };
}

// ---------- Phase S5c-D5b: Trading-owned listingsByGroup/{groupId} ----------

export const SCOPE_GROUP_LISTINGS = 'groupListings';

/** @type {(() => void)|null} */
let _groupListingsUnsub = null;
/** @type {string|null} */
let _groupListingsSubId = null;
/** @type {string|null} — actively subscribed group (null if none) */
let _groupListingsGroupId = null;
/** @type {string|null} — desired target during ensure/switch */
let _groupListingsDesiredGroupId = null;
/** @type {number|null} */
let _groupListingsStartedAt = null;
/** @type {Promise<object>|null} */
let _groupListingsPromise = null;
/** @type {number} — bumped on release/switch to cancel in-flight ensure */
let _groupListingsGeneration = 0;
/** @type {object|null} */
let _groupListingsLastResult = null;

/**
 * @param {string} groupId
 * @returns {string}
 */
function _groupListingsPath(groupId) {
  return `${LISTINGS_BY_GROUP_ROOT}/${String(groupId || '').trim()}`;
}

/**
 * Drop Trading-owned group-listings handle without bumping generation.
 * Used when switching A→B inside a new ensure that already owns the generation bump.
 */
function _dropGroupListingsHandle() {
  if (_groupListingsUnsub) {
    try { _groupListingsUnsub(); } catch { /* ignore */ }
  }
  _groupListingsUnsub = null;
  _groupListingsSubId = null;
  _groupListingsStartedAt = null;
  _groupListingsGroupId = null;
}

/**
 * @param {string} [groupId]
 * @returns {boolean}
 */
export function isGroupListingsReady(groupId) {
  const key = groupId != null ? String(groupId).trim() : _groupListingsGroupId;
  if (!key) return false;
  if (_groupListingsGroupId !== key || !_groupListingsUnsub) return false;
  return db.isPathReady(_groupListingsPath(key));
}

/**
 * @param {string} [groupId]
 * @param {{ timeoutMs?: number }} [options]
 */
export function waitForGroupListings(groupId, options = {}) {
  const key = groupId != null ? String(groupId).trim() : _groupListingsGroupId;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  if (!key) {
    return Promise.resolve({
      ok: false,
      scope: SCOPE_GROUP_LISTINGS,
      path: null,
      groupId: null,
      error: 'Missing groupId',
    });
  }
  const path = _groupListingsPath(key);
  return db.waitForPath(path, { timeoutMs }).then((result) => ({
    ok: result.ok === true,
    scope: SCOPE_GROUP_LISTINGS,
    path,
    groupId: key,
    error: result.error,
  }));
}

/**
 * Release Trading-owned listingsByGroup subscription. Does not clear cache/readiness.
 * Bumps generation so late ensures discard handles.
 */
export function releaseGroupListingsScope() {
  _groupListingsGeneration += 1;
  _groupListingsDesiredGroupId = null;
  const prevPath = _groupListingsGroupId ? _groupListingsPath(_groupListingsGroupId) : null;
  _dropGroupListingsHandle();
  _groupListingsPromise = null;
  return { released: true, path: prevPath, scope: SCOPE_GROUP_LISTINGS };
}

/**
 * Ensure exactly one Trading-owned subscription to listingsByGroup/{groupId}.
 * At most one ensure/switch in flight; group changes cancel prior ownership before acquiring.
 * Never holds two group listeners simultaneously.
 *
 * @param {string} groupId
 * @param {{ timeoutMs?: number, force?: boolean }} [options]
 * @returns {Promise<object>}
 */
export function ensureGroupListingsScope(groupId, options = {}) {
  const key = String(groupId || '').trim();
  if (!key) {
    releaseGroupListingsScope();
    const failed = {
      ok: false,
      scope: SCOPE_GROUP_LISTINGS,
      path: null,
      groupId: null,
      error: 'Missing groupId',
      ready: false,
    };
    _groupListingsLastResult = failed;
    return Promise.resolve(failed);
  }

  const force = options.force === true;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  const path = _groupListingsPath(key);

  // Fast reuse: already sole-owning this group and path ready
  if (!force && _groupListingsUnsub && _groupListingsGroupId === key && db.isPathReady(path)) {
    const entry = _registryEntry(path);
    const reused = {
      ok: true,
      scope: SCOPE_GROUP_LISTINGS,
      path,
      groupId: key,
      reused: true,
      subscriptionActive: true,
      subscriptionRefCount: entry?.refCount ?? 1,
      subscriptionId: _groupListingsSubId,
      ready: true,
    };
    _groupListingsLastResult = reused;
    return Promise.resolve(reused);
  }

  // Coalesce in-flight ensure for the same desired group (no duplicate network / refCount++)
  if (!force && _groupListingsPromise && _groupListingsDesiredGroupId === key) {
    return _groupListingsPromise.then((r) => ({ ...r, reused: true }));
  }

  // Invalidate/cancel prior ownership (A→B or B→C): bump gen, drop handle A, ensure B once
  _groupListingsGeneration += 1;
  _dropGroupListingsHandle();
  _groupListingsDesiredGroupId = key;
  const myGen = _groupListingsGeneration;

  _groupListingsPromise = (async () => {
    metrics.mark('groupListingsHydrateStart');

    if (myGen !== _groupListingsGeneration || _groupListingsDesiredGroupId !== key) {
      const cancelled = {
        ok: false,
        cancelled: true,
        scope: SCOPE_GROUP_LISTINGS,
        path,
        groupId: key,
        error: 'Group listings ensure cancelled',
        ready: false,
      };
      _groupListingsLastResult = cancelled;
      metrics.mark('groupListingsHydrateFailed');
      return cancelled;
    }

    const load = await db.loadPathOnce(path, { timeoutMs, force: force === true });
    if (myGen !== _groupListingsGeneration || _groupListingsDesiredGroupId !== key) {
      const cancelled = {
        ok: false,
        cancelled: true,
        scope: SCOPE_GROUP_LISTINGS,
        path,
        groupId: key,
        error: 'Group listings ensure cancelled',
        ready: false,
      };
      _groupListingsLastResult = cancelled;
      metrics.mark('groupListingsHydrateFailed');
      return cancelled;
    }

    if (!load.ok) {
      const failed = {
        ok: false,
        scope: SCOPE_GROUP_LISTINGS,
        path,
        groupId: key,
        error: load.error || 'Group listings load failed',
        ready: false,
      };
      _groupListingsLastResult = failed;
      metrics.mark('groupListingsHydrateFailed');
      return failed;
    }

    // If a handle somehow already exists for this path under our ownership, reuse
    if (_groupListingsUnsub && _groupListingsGroupId === key) {
      const entry = _registryEntry(path);
      const reused = {
        ok: true,
        scope: SCOPE_GROUP_LISTINGS,
        path,
        groupId: key,
        reused: true,
        subscriptionActive: true,
        subscriptionRefCount: entry?.refCount ?? 1,
        subscriptionId: _groupListingsSubId,
        ready: isGroupListingsReady(key),
      };
      _groupListingsLastResult = reused;
      metrics.mark('groupListingsHydrateComplete');
      return reused;
    }

    const handle = db.subscribePath(path);
    if (myGen !== _groupListingsGeneration || _groupListingsDesiredGroupId !== key) {
      try { handle.unsubscribe(); } catch { /* ignore */ }
      const cancelled = {
        ok: false,
        cancelled: true,
        scope: SCOPE_GROUP_LISTINGS,
        path,
        groupId: key,
        error: 'Group listings ensure cancelled',
        ready: false,
      };
      _groupListingsLastResult = cancelled;
      metrics.mark('groupListingsHydrateFailed');
      return cancelled;
    }

    const entryAfter = _registryEntry(path);
    if (entryAfter && entryAfter.refCount > 1) {
      try { handle.unsubscribe(); } catch { /* ignore */ }
      const failed = {
        ok: false,
        scope: SCOPE_GROUP_LISTINGS,
        path,
        groupId: key,
        error: 'Refusing to share listingsByGroup subscription (Trading must be sole owner)',
        ready: false,
      };
      _groupListingsLastResult = failed;
      metrics.mark('groupListingsHydrateFailed');
      return failed;
    }

    _groupListingsUnsub = handle.unsubscribe;
    _groupListingsSubId = handle.id;
    _groupListingsGroupId = key;
    _groupListingsStartedAt = Date.now();

    const wait = await db.waitForPath(path, { timeoutMs });
    if (myGen !== _groupListingsGeneration || _groupListingsDesiredGroupId !== key) {
      if (_groupListingsUnsub === handle.unsubscribe) {
        try { handle.unsubscribe(); } catch { /* ignore */ }
        _groupListingsUnsub = null;
        _groupListingsSubId = null;
        _groupListingsStartedAt = null;
        _groupListingsGroupId = null;
      }
      const cancelled = {
        ok: false,
        cancelled: true,
        scope: SCOPE_GROUP_LISTINGS,
        path,
        groupId: key,
        error: 'Group listings ensure cancelled',
        ready: false,
      };
      _groupListingsLastResult = cancelled;
      metrics.mark('groupListingsHydrateFailed');
      return cancelled;
    }

    const result = {
      ok: wait.ok === true,
      scope: SCOPE_GROUP_LISTINGS,
      path,
      groupId: key,
      reused: false,
      subscriptionActive: _groupListingsUnsub != null,
      subscriptionId: _groupListingsSubId,
      subscriptionRefCount: entryAfter?.refCount ?? 1,
      ready: isGroupListingsReady(key),
      error: wait.ok ? null : (wait.error || 'timeout'),
    };
    _groupListingsLastResult = result;
    if (result.ok) {
      metrics.mark('groupListingsHydrateComplete');
    } else {
      metrics.mark('groupListingsHydrateFailed');
    }
    return result;
  })();

  const run = _groupListingsPromise;
  run.finally(() => {
    if (_groupListingsPromise === run) {
      _groupListingsPromise = null;
    }
  });

  return run;
}

export function getGroupListingsHydrationReport() {
  const path = _groupListingsGroupId ? _groupListingsPath(_groupListingsGroupId) : null;
  const entry = path ? _registryEntry(path) : null;
  const groupId = _groupListingsGroupId;
  const metaReady = groupId ? isGroupListingsIndexReady(groupId) : false;
  const globalVersionCurrent = isGlobalTradeIndexMetaCurrent();
  return {
    phase: 'S5c-D5b',
    scope: SCOPE_GROUP_LISTINGS,
    groupId,
    desiredGroupId: _groupListingsDesiredGroupId,
    path,
    ready: groupId ? isGroupListingsReady(groupId) : false,
    metaReady,
    globalVersionCurrent,
    active: _groupListingsUnsub != null,
    subscriptionId: _groupListingsSubId,
    refCount: entry?.refCount ?? (_groupListingsUnsub ? 1 : 0),
    startedAt: _groupListingsStartedAt,
    inFlight: _groupListingsPromise != null,
    lastResult: _groupListingsLastResult
      ? {
        ok: _groupListingsLastResult.ok === true,
        cancelled: _groupListingsLastResult.cancelled === true,
        error: _groupListingsLastResult.error || null,
        reused: _groupListingsLastResult.reused === true,
        groupId: _groupListingsLastResult.groupId || null,
      }
      : null,
  };
}

// ---------- Phase S5d: Leaderboard-tab-owned leaderboards root ----------

export const SCOPE_LEADERBOARDS = 'leaderboards';

/** @type {(() => void)|null} */
let _leaderboardsUnsub = null;
/** @type {string|null} */
let _leaderboardsSubId = null;
/** @type {number|null} */
let _leaderboardsStartedAt = null;
/** @type {Promise<object>|null} */
let _leaderboardsPromise = null;
/** @type {number} */
let _leaderboardsGeneration = 0;
/** @type {object|null} */
let _leaderboardsLastResult = null;

const LEADERBOARDS_PATH = 'leaderboards';

export function isLeaderboardsScopeReady() {
  return db.isPathReady(LEADERBOARDS_PATH);
}

export function releaseLeaderboardsScope() {
  _leaderboardsGeneration += 1;
  if (_leaderboardsUnsub) {
    try { _leaderboardsUnsub(); } catch { /* ignore */ }
  }
  _leaderboardsUnsub = null;
  _leaderboardsSubId = null;
  _leaderboardsStartedAt = null;
  _leaderboardsPromise = null;
  return { released: true, path: LEADERBOARDS_PATH };
}

/**
 * Ensure one Leaderboard-tab-owned subscription to leaderboards/.
 * @param {{ timeoutMs?: number, force?: boolean }} [options]
 * @returns {Promise<object>}
 */
export function ensureLeaderboardsScope(options = {}) {
  const force = options.force === true;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;

  if (!force && _leaderboardsUnsub && isLeaderboardsScopeReady()) {
    const entry = _registryEntry(LEADERBOARDS_PATH);
    const reused = {
      ok: true,
      scope: SCOPE_LEADERBOARDS,
      path: LEADERBOARDS_PATH,
      reused: true,
      subscriptionActive: true,
      subscriptionRefCount: entry?.refCount ?? 1,
      subscriptionId: _leaderboardsSubId,
      ready: true,
    };
    _leaderboardsLastResult = reused;
    return Promise.resolve(reused);
  }

  if (_leaderboardsPromise && !force) {
    return _leaderboardsPromise.then((r) => ({ ...r, reused: true }));
  }

  const myGen = _leaderboardsGeneration;

  _leaderboardsPromise = (async () => {
    if (force && _leaderboardsUnsub) {
      try { _leaderboardsUnsub(); } catch { /* ignore */ }
      _leaderboardsUnsub = null;
      _leaderboardsSubId = null;
      _leaderboardsStartedAt = null;
    }

    if (myGen !== _leaderboardsGeneration) {
      const cancelled = {
        ok: false,
        cancelled: true,
        scope: SCOPE_LEADERBOARDS,
        path: LEADERBOARDS_PATH,
        error: 'Leaderboards ensure cancelled',
        ready: false,
      };
      _leaderboardsLastResult = cancelled;
      return cancelled;
    }

    const load = await db.loadPathOnce(LEADERBOARDS_PATH, { timeoutMs, force });
    if (myGen !== _leaderboardsGeneration) {
      const cancelled = {
        ok: false,
        cancelled: true,
        scope: SCOPE_LEADERBOARDS,
        path: LEADERBOARDS_PATH,
        error: 'Leaderboards ensure cancelled',
        ready: false,
      };
      _leaderboardsLastResult = cancelled;
      return cancelled;
    }

    if (!load.ok) {
      console.warn('[Hydration] leaderboards once-load:', load.error || 'failed');
    }

    if (_leaderboardsUnsub) {
      const entry = _registryEntry(LEADERBOARDS_PATH);
      const reused = {
        ok: true,
        scope: SCOPE_LEADERBOARDS,
        path: LEADERBOARDS_PATH,
        reused: true,
        subscriptionActive: true,
        subscriptionRefCount: entry?.refCount ?? 1,
        subscriptionId: _leaderboardsSubId,
        ready: isLeaderboardsScopeReady(),
      };
      _leaderboardsLastResult = reused;
      return reused;
    }

    const handle = db.subscribePath(LEADERBOARDS_PATH);
    if (myGen !== _leaderboardsGeneration) {
      try { handle.unsubscribe?.(); } catch { /* ignore */ }
      const cancelled = {
        ok: false,
        cancelled: true,
        scope: SCOPE_LEADERBOARDS,
        path: LEADERBOARDS_PATH,
        error: 'Leaderboards ensure cancelled',
        ready: false,
      };
      _leaderboardsLastResult = cancelled;
      return cancelled;
    }

    if (!handle?.unsubscribe) {
      const failed = {
        ok: false,
        scope: SCOPE_LEADERBOARDS,
        path: LEADERBOARDS_PATH,
        error: 'Leaderboards subscribe failed',
        ready: false,
      };
      _leaderboardsLastResult = failed;
      return failed;
    }

    _leaderboardsUnsub = handle.unsubscribe;
    _leaderboardsSubId = handle.id;
    _leaderboardsStartedAt = Date.now();

    await db.waitForPath(LEADERBOARDS_PATH, { timeoutMs }).catch(() => null);

    const result = {
      ok: true,
      scope: SCOPE_LEADERBOARDS,
      path: LEADERBOARDS_PATH,
      reused: false,
      subscriptionActive: _leaderboardsUnsub != null,
      subscriptionId: _leaderboardsSubId,
      ready: isLeaderboardsScopeReady() || db.get(LEADERBOARDS_PATH) != null,
    };
    _leaderboardsLastResult = result;
    return result;
  })();

  const run = _leaderboardsPromise;
  run.finally(() => {
    if (_leaderboardsPromise === run) _leaderboardsPromise = null;
  });
  return run;
}

export function getLeaderboardsHydrationReport() {
  const entry = _registryEntry(LEADERBOARDS_PATH);
  return {
    phase: 'S5d',
    scope: SCOPE_LEADERBOARDS,
    path: LEADERBOARDS_PATH,
    ready: isLeaderboardsScopeReady(),
    active: _leaderboardsUnsub != null,
    subscriptionId: _leaderboardsSubId,
    refCount: entry?.refCount ?? (_leaderboardsUnsub ? 1 : 0),
    startedAt: _leaderboardsStartedAt,
    inFlight: _leaderboardsPromise != null,
    lastResult: _leaderboardsLastResult
      ? {
        ok: _leaderboardsLastResult.ok === true,
        cancelled: _leaderboardsLastResult.cancelled === true,
        error: _leaderboardsLastResult.error || null,
        reused: _leaderboardsLastResult.reused === true,
      }
      : null,
  };
}

/**
 * Named-scope status snapshot (S2–S5d).
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
      [SCOPE_PLAYER_TRADE_INDEX]: {
        ready: isPlayerTradeIndexScopeReady(),
        usable: isPlayerTradeIndexReady(),
        username: _ptiUsername,
        path: _ptiUsername ? _ptiPath(_ptiUsername) : null,
        subscriptionActive: _ptiUnsub != null,
        lastStatus: _ptiLastResult?.status || (_ptiUnsub ? 'subscribed' : 'idle'),
        inFlight: _ptiPromise != null,
      },
      [SCOPE_ADMIN_DIRECTORY]: getAdminDirectoryHydrationReport(),
      [SCOPE_ADMIN_SELECTED_PLAYER]: getAdminSelectedPlayerReport(),
      [SCOPE_TRADE_DIRECTORY]: getTradeDirectoryHydrationReport(),
      [SCOPE_GROUP_LISTINGS]: getGroupListingsHydrationReport(),
      [SCOPE_LEADERBOARDS]: getLeaderboardsHydrationReport(),
      [SCOPE_ACCESS_CODES]: getAccessCodesLoadReport(),
      [SCOPE_LEADERBOARD_ARCHIVES]: getLeaderboardArchivesHydrationReport(),
    },
    deferredScopes: [],
    accessCodes: getAccessCodesLoadReport(),
    shared: getSharedHydrationReport(),
    currentPlayer: getCurrentPlayerHydrationReport(),
    playerTradeIndex: getPlayerTradeIndexHydrationReport(),
    adminDirectory: getAdminDirectoryHydrationReport(),
    adminSelectedPlayer: getAdminSelectedPlayerReport(),
    tradeDirectory: getTradeDirectoryHydrationReport(),
    groupListings: getGroupListingsHydrationReport(),
    leaderboards: getLeaderboardsHydrationReport(),
    leaderboardArchives: getLeaderboardArchivesHydrationReport(),
  };
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcDbHydration = {
    SHARED_DEF_PATHS,
    SCOPE_SHARED_DEFS,
    ACCESS_CODES_ROOT,
    SCOPE_ACCESS_CODES,
    SCOPE_CURRENT_PLAYER,
    SCOPE_PLAYER_TRADE_INDEX,
    SCOPE_ADMIN_DIRECTORY,
    SCOPE_ADMIN_SELECTED_PLAYER,
    SCOPE_TRADE_DIRECTORY,
    SCOPE_GROUP_LISTINGS,
    SCOPE_LEADERBOARDS,
    hydrateSharedDefs,
    isSharedDefsReady,
    waitForSharedDefs,
    loadAccessCodeOnce,
    bootstrapAccessCodesOnce,
    loadAdminAccessCodesOnce,
    getAccessCodesLoadReport,
    hydrateLeaderboardArchivesOnce,
    getLeaderboardArchivesHydrationReport,
    LEADERBOARD_SEASONS_ROOT,
    LEADERBOARD_SNAPSHOTS_ROOT,
    SCOPE_LEADERBOARD_ARCHIVES,
    getHydrationStatus,
    getSharedHydrationReport,
    getCurrentPlayerHydrationReport,
    isCurrentPlayerReady,
    waitForCurrentPlayer,
    ensureCurrentPlayerScope,
    ensurePlayerTradeIndexScope,
    isPlayerTradeIndexScopeReady,
    isPlayerTradeIndexReady,
    waitForPlayerTradeIndex,
    getPlayerTradeIndexHydrationReport,
    hydrateTradeIndexMeta,
    ensureAdminDirectoryScope,
    isAdminDirectoryReady,
    waitForAdminDirectory,
    getAdminDirectoryHydrationReport,
    ensureAdminSelectedPlayerScope,
    getAdminSelectedPlayerReport,
    ensureTradeDirectoryScope,
    isTradeDirectoryReady,
    waitForTradeDirectory,
    getTradeDirectoryHydrationReport,
    ensureGroupListingsScope,
    isGroupListingsReady,
    waitForGroupListings,
    getGroupListingsHydrationReport,
    ensureLeaderboardsScope,
    isLeaderboardsScopeReady,
    getLeaderboardsHydrationReport,
    // release* retained for auth/Admin/Trading UI only — not exposed here
    getScopedLoadingFlagState,
    isScopedLoadingDevFlagEnabled,
    getBootModeReport: () => db.getBootModeReport(),
    isScopedOnlyMode: () => db.isScopedOnlyMode(),
    isRootListenerAttached: () => db.isRootListenerAttached(),
    isPathReady: (path) => db.isPathReady(path),
    waitForPath: (path, options) => db.waitForPath(path, options),
    loadPathOnce: (path, options) => db.loadPathOnce(path, options),
    clearCachedPath: (path) => db.clearCachedPath(path),
    getSubscriptionRegistry: () => db.getSubscriptionRegistry(),
    getCached: (path) => db.get(path),
    help() {
      console.info(`DB Hydration (S2–S7c)
Shared: ${SHARED_DEF_PATHS.join(', ')}
Access codes: loadAccessCodeOnce | bootstrapAccessCodesOnce | loadAdminAccessCodesOnce
Archives: hydrateLeaderboardArchivesOnce | getLeaderboardArchivesHydrationReport
Boot: getBootModeReport | isScopedOnlyMode
Root: default ON; scoped via qc_scoped_loading=true + reload`);
    },
  };
}

_installWindowApi();
