/**
 * persist-allowlist.js — S6d policy + S7a enforcement latch
 *
 * Canonical allowlist for what may be written to / restored from `scicards_db`.
 *
 * Classroom authority (reload-latched; follows boot mode):
 *   localStorage.qc_persist_enforce === 'true'  OR  boot mode === scoped
 *   → enforcement ON (reason: qc_persist_enforce | production-default)
 * After S8d-0 boot is always scoped, so enforcement is ON unless somehow unlatched
 * before boot resolves — still prefer passing `{ bootMode }` from initDB.
 * Mid-session flag changes require reload — latch does not re-read.
 *
 * accessCodes: NEVER persist — register once-loads accessCodes/{code}.
 */

/** Top-level roots always safe to persist (shared / derived indexes / LB archives). */
export const PERSIST_ALWAYS_ROOTS = Object.freeze([
  'config',
  'cards',
  'packs',
  'groups',
  'tradeIndexMeta',
  'playerDirectory',
  'listingsByGroup',
  'leaderboards',
  'leaderboardSeasons',
  'leaderboardSnapshots',
]);

/**
 * Personal roots: only `{root}/{sessionUsername}` may persist.
 * Bare `players` / `playerTradeIndex` trees must not be persisted wholesale.
 */
export const PERSIST_PERSONAL_ROOTS = Object.freeze([
  'players',
  'playerTradeIndex',
]);

/**
 * Explicit never-persist roots.
 * Not exhaustive of every unknown key — unknown roots also deny by default.
 */
export const PERSIST_NEVER_ROOTS = Object.freeze([
  'accessCodes',
  'trades',
  'admin',
  'achievements',
  'quests',
  'seasonal',
]);

/** Dedicated flag — forces persist enforcement ON (redundant under production scoped boot). */
export const PERSIST_ENFORCE_LS_KEY = 'qc_persist_enforce';

/**
 * @deprecated Not used for boot or persist authority after classroom default flip.
 * Harmless if still set to 'true' in older browsers.
 */
export const PERSIST_SCOPED_LOADING_LS_KEY = 'qc_scoped_loading';

export const PERSIST_LOCAL_STORAGE_KEY = 'scicards_db';
export const PERSIST_SESSION_KEY = 'scicards_session';

/**
 * @typedef {{ enabled: boolean, reason: string, latchedAt: number }} PersistEnforcementLatch
 */

/** @type {PersistEnforcementLatch|null} */
let _enforcementLatch = null;

/** @type {object|null} */
let _lastSanitizeReport = null;

/** @type {object|null} */
let _lastPersistReport = null;

/**
 * Resolve enforcement once per page load (reload required to change).
 * Prefer `{ bootMode }` from initDB after resolveBootModeLatch (follows boot latch).
 * Fallback assumes scoped production-default (S8d-0; qc_force_root_loading ignored).
 *
 * @param {{ bootMode?: 'scoped'|'root' }} [options]
 * @returns {PersistEnforcementLatch}
 */
export function resolvePersistEnforcementLatch(options = {}) {
  if (_enforcementLatch) return _enforcementLatch;
  let persistFlag = false;
  try {
    persistFlag = localStorage.getItem(PERSIST_ENFORCE_LS_KEY) === 'true';
  } catch { /* private mode */ }

  let bootMode = options.bootMode;
  if (bootMode !== 'scoped' && bootMode !== 'root') {
    bootMode = 'scoped';
  }

  let reason = 'default-off';
  let enabled = false;
  if (persistFlag) {
    enabled = true;
    reason = PERSIST_ENFORCE_LS_KEY;
  } else if (bootMode === 'scoped') {
    enabled = true;
    reason = 'production-default';
  }

  _enforcementLatch = {
    enabled,
    reason,
    latchedAt: Date.now(),
  };
  return _enforcementLatch;
}

/**
 * Whether filtered persist / sanitize-on-load is active this page load.
 * @returns {boolean}
 */
export function isPersistEnforcementEnabled() {
  return resolvePersistEnforcementLatch().enabled === true;
}

/**
 * @deprecated Static false meant “not globally forced.” Use isPersistEnforcementEnabled().
 * Kept as false so old “global always-on” reads stay wrong in a safe direction.
 */
export const PERSIST_ENFORCEMENT_ENABLED = false;

/**
 * @param {string|null|undefined} path
 * @returns {string}
 */
function _normalizePath(path) {
  if (path == null || path === '' || path === '/') return '';
  return String(path).split('/').filter(Boolean).join('/');
}

/**
 * @param {string|null|undefined} username
 * @returns {string}
 */
function _normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

/**
 * Normal student username for personal persist, or null.
 * Ignores __admin__ and missing/invalid sessions.
 * @param {string|null|undefined} [overrideUsername] - force null/user (e.g. logout)
 * @returns {string|null}
 */
export function getPersistSessionUsername(overrideUsername) {
  if (overrideUsername !== undefined) {
    const u = _normalizeUsername(overrideUsername);
    if (!u || u === '__admin__') return null;
    return u;
  }
  try {
    const raw = localStorage.getItem(PERSIST_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    const u = _normalizeUsername(s && s.username);
    if (!u || u === '__admin__') return null;
    return u;
  } catch {
    return null;
  }
}

/**
 * Whether a path would be allowed under the persist allowlist.
 * @param {string} path
 * @param {string|null|undefined} sessionUsername
 * @returns {boolean}
 */
export function shouldPersistPath(path, sessionUsername) {
  const normalized = _normalizePath(path);
  if (!normalized) return false;

  const parts = normalized.split('/');
  const root = parts[0];

  if (PERSIST_NEVER_ROOTS.includes(root)) return false;

  if (PERSIST_ALWAYS_ROOTS.includes(root)) return true;

  if (PERSIST_PERSONAL_ROOTS.includes(root)) {
    const user = _normalizeUsername(sessionUsername);
    if (!user || user === '__admin__') return false;
    if (parts.length < 2) return false;
    return parts[1] === user;
  }

  return false;
}

/**
 * Build a filtered shallow copy of `_db` per policy (does not mutate input).
 * @param {object|null|undefined} dbRoot
 * @param {string|null|undefined} sessionUsername
 * @returns {object}
 */
export function filterDbForPersist(dbRoot, sessionUsername) {
  return filterDbForPersistWithStats(dbRoot, sessionUsername).filtered;
}

/**
 * @param {object|null|undefined} dbRoot
 * @param {string|null|undefined} sessionUsername
 * @returns {{
 *   filtered: object,
 *   sessionUsernameUsed: string|null,
 *   droppedTopLevelRoots: string[],
 *   droppedForeignPlayerCount: number,
 *   droppedForeignPTICount: number,
 *   keptAlwaysRoots: string[],
 *   keptPersonalRoots: string[]
 * }}
 */
export function filterDbForPersistWithStats(dbRoot, sessionUsername) {
  const filtered = {};
  const droppedTopLevelRoots = [];
  let droppedForeignPlayerCount = 0;
  let droppedForeignPTICount = 0;
  const keptAlwaysRoots = [];
  const keptPersonalRoots = [];
  const user = (() => {
    const u = _normalizeUsername(sessionUsername);
    if (!u || u === '__admin__') return null;
    return u;
  })();

  if (!dbRoot || typeof dbRoot !== 'object') {
    return {
      filtered,
      sessionUsernameUsed: user,
      droppedTopLevelRoots,
      droppedForeignPlayerCount,
      droppedForeignPTICount,
      keptAlwaysRoots,
      keptPersonalRoots,
    };
  }

  const inputKeys = Object.keys(dbRoot);

  for (const root of PERSIST_ALWAYS_ROOTS) {
    if (Object.prototype.hasOwnProperty.call(dbRoot, root) && dbRoot[root] != null) {
      filtered[root] = dbRoot[root];
      keptAlwaysRoots.push(root);
    }
  }

  if (user) {
    for (const root of PERSIST_PERSONAL_ROOTS) {
      const tree = dbRoot[root];
      if (!tree || typeof tree !== 'object') continue;
      const foreignKeys = Object.keys(tree).filter((k) => k && k !== user && k !== '__admin__');
      if (root === 'players') droppedForeignPlayerCount += foreignKeys.length;
      if (root === 'playerTradeIndex') droppedForeignPTICount += foreignKeys.length;
      if (Object.prototype.hasOwnProperty.call(tree, user) && tree[user] != null) {
        filtered[root] = { [user]: tree[user] };
        keptPersonalRoots.push(`${root}/${user}`);
      }
    }
  } else {
    for (const root of PERSIST_PERSONAL_ROOTS) {
      const tree = dbRoot[root];
      if (!tree || typeof tree !== 'object') continue;
      const keys = Object.keys(tree).filter((k) => k && k !== '__admin__');
      if (root === 'players') droppedForeignPlayerCount += keys.length;
      if (root === 'playerTradeIndex') droppedForeignPTICount += keys.length;
    }
  }

  for (const key of inputKeys) {
    if (Object.prototype.hasOwnProperty.call(filtered, key)) continue;
    droppedTopLevelRoots.push(key);
  }

  return {
    filtered,
    sessionUsernameUsed: user,
    droppedTopLevelRoots,
    droppedForeignPlayerCount,
    droppedForeignPTICount,
    keptAlwaysRoots,
    keptPersonalRoots,
  };
}

/**
 * Record last sanitize-on-load stats (called from database.js).
 * @param {object} report
 */
export function recordSanitizeReport(report) {
  _lastSanitizeReport = report ? { ...report, at: Date.now() } : null;
}

/**
 * Record last filtered persist stats.
 * @param {object} report
 */
export function recordPersistFilterReport(report) {
  _lastPersistReport = report ? { ...report, at: Date.now() } : null;
}

/**
 * S7a diagnostics for DevTools.
 * @returns {object}
 */
export function getPersistEnforcementReport() {
  const latch = resolvePersistEnforcementLatch();
  return {
    phase: 'S7a',
    enforcementEnabled: latch.enabled,
    enforcementReason: latch.reason,
    enforcementLatchedAt: latch.latchedAt,
    sessionUsernameUsed: getPersistSessionUsername(),
    localStorageKey: PERSIST_LOCAL_STORAGE_KEY,
    alwaysRoots: [...PERSIST_ALWAYS_ROOTS],
    personalRoots: [...PERSIST_PERSONAL_ROOTS],
    neverRoots: [...PERSIST_NEVER_ROOTS],
    localCacheSanitized: _lastSanitizeReport,
    lastPersistFiltered: _lastPersistReport,
    note: latch.enabled
      ? 'S7a: sanitize-on-load + filtered _persistLocal active this page load.'
      : 'Persist OFF this page load (unexpected under scoped-only boot). Enable via production scoped default or localStorage qc_persist_enforce=true + reload.',
  };
}

/**
 * DevTools / policy snapshot (includes enforcement latch).
 * @returns {object}
 */
export function getPersistAllowlistReport() {
  const latch = resolvePersistEnforcementLatch();
  return {
    phase: 'S7a',
    enforcementEnabled: latch.enabled,
    enforcementReason: latch.reason,
    localStorageKey: PERSIST_LOCAL_STORAGE_KEY,
    alwaysRoots: [...PERSIST_ALWAYS_ROOTS],
    personalRoots: [...PERSIST_PERSONAL_ROOTS],
    neverRoots: [...PERSIST_NEVER_ROOTS],
    accessCodesPolicy: 'never — register once-loads accessCodes/{code}; bootstrap may once-load accessCodes/; not session state',
    note: latch.enabled
      ? 'Enforcement ON this page load (reload-latched; follows boot scoped or qc_persist_enforce).'
      : 'Enforcement OFF — full _db persist (unexpected under scoped-only boot).',
    examples: {
      'players/bobby@bobby': shouldPersistPath('players/bobby', 'bobby'),
      'players/bobby2@bobby': shouldPersistPath('players/bobby2', 'bobby'),
      'playerTradeIndex/bobby@bobby': shouldPersistPath('playerTradeIndex/bobby', 'bobby'),
      'playerTradeIndex/bobby2@bobby': shouldPersistPath('playerTradeIndex/bobby2', 'bobby'),
      'config': shouldPersistPath('config', 'bobby'),
      'accessCodes': shouldPersistPath('accessCodes', 'bobby'),
      'accessCodes/ABC123': shouldPersistPath('accessCodes/ABC123', 'bobby'),
      'trades/direct/x': shouldPersistPath('trades/direct/x', 'bobby'),
    },
    enforcement: getPersistEnforcementReport(),
  };
}

/**
 * Preview filter without writing (verification helper).
 * @param {object} dbRoot
 * @param {string|null|undefined} sessionUsername
 */
export function previewPersistFilter(dbRoot, sessionUsername) {
  return filterDbForPersistWithStats(dbRoot, sessionUsername);
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcPersistAllowlist = {
    PERSIST_ALWAYS_ROOTS,
    PERSIST_PERSONAL_ROOTS,
    PERSIST_NEVER_ROOTS,
    PERSIST_ENFORCE_LS_KEY,
    PERSIST_SCOPED_LOADING_LS_KEY,
    PERSIST_ENFORCEMENT_ENABLED,
    resolvePersistEnforcementLatch,
    isPersistEnforcementEnabled,
    getPersistSessionUsername,
    shouldPersistPath,
    filterDbForPersist,
    filterDbForPersistWithStats,
    previewPersistFilter,
    getPersistAllowlistReport,
    getPersistEnforcementReport,
    help() {
      const latch = resolvePersistEnforcementLatch();
      console.info(`Persist allowlist (S7a + scoped-only boot)
Enforcement: ${latch.enabled ? 'ON' : 'OFF'} (reason: ${latch.reason})
ON when: boot mode scoped (production-default) OR localStorage.${PERSIST_ENFORCE_LS_KEY}==='true'
Deprecated (ignored for authority): ${PERSIST_SCOPED_LOADING_LS_KEY}; qc_force_root_loading removed (S8d-0)
Always: ${PERSIST_ALWAYS_ROOTS.join(', ')}
Personal: ${PERSIST_PERSONAL_ROOTS.map((r) => `${r}/{user}`).join(', ')}
Never: ${PERSIST_NEVER_ROOTS.join(', ')}
Report: qcPersistAllowlist.getPersistEnforcementReport()`);
    },
  };
}

_installWindowApi();
