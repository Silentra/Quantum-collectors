/**
 * persist-allowlist.js — S6d persistence policy (preparation only)
 *
 * Defines which _db subtrees S7 may write to localStorage (`scicards_db`).
 * S6d does NOT change `_persistLocal()` — full _db may still be persisted while
 * root coexistence remains ON. Enforcement belongs to S7.
 *
 * accessCodes: NEVER persist — register once-loads accessCodes/{code};
 * bootstrap may once-load the collection; neither is normal session state.
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
 * Explicit never-persist roots (documented for S7).
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

/**
 * S6d: false — `_persistLocal` still writes full `_db`.
 * S7: set true (or wire database.js to call filter) when root-off enforces allowlist.
 */
export const PERSIST_ENFORCEMENT_ENABLED = false;

export const PERSIST_LOCAL_STORAGE_KEY = 'scicards_db';

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
 * Whether a path would be allowed under the S7 persist allowlist.
 * Does not read or write localStorage. Enforcement is OFF in S6d.
 *
 * @param {string} path - absolute DB path (e.g. players/bobby, config/economy)
 * @param {string|null|undefined} sessionUsername - current or last user for personal roots
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

  // Unknown top-level roots: deny (fail closed for S7)
  return false;
}

/**
 * Build a filtered shallow copy of `_db` per policy (for S7; unused by S6d persist).
 * @param {object|null|undefined} dbRoot
 * @param {string|null|undefined} sessionUsername
 * @returns {object}
 */
export function filterDbForPersist(dbRoot, sessionUsername) {
  const out = {};
  if (!dbRoot || typeof dbRoot !== 'object') return out;

  for (const root of PERSIST_ALWAYS_ROOTS) {
    if (Object.prototype.hasOwnProperty.call(dbRoot, root) && dbRoot[root] != null) {
      out[root] = dbRoot[root];
    }
  }

  const user = _normalizeUsername(sessionUsername);
  if (user && user !== '__admin__') {
    for (const root of PERSIST_PERSONAL_ROOTS) {
      const tree = dbRoot[root];
      if (!tree || typeof tree !== 'object') continue;
      if (Object.prototype.hasOwnProperty.call(tree, user) && tree[user] != null) {
        out[root] = { [user]: tree[user] };
      }
    }
  }

  return out;
}

/**
 * DevTools / verification snapshot of the S6d policy.
 * @returns {object}
 */
export function getPersistAllowlistReport() {
  return {
    phase: 'S6d',
    enforcementEnabled: PERSIST_ENFORCEMENT_ENABLED,
    localStorageKey: PERSIST_LOCAL_STORAGE_KEY,
    alwaysRoots: [...PERSIST_ALWAYS_ROOTS],
    personalRoots: [...PERSIST_PERSONAL_ROOTS],
    neverRoots: [...PERSIST_NEVER_ROOTS],
    accessCodesPolicy: 'never — register once-loads accessCodes/{code}; bootstrap may once-load accessCodes/; not session state',
    note: PERSIST_ENFORCEMENT_ENABLED
      ? '_persistLocal should filter via this policy (S7).'
      : 'S6d prep only — _persistLocal still writes full _db; enforcement belongs to S7.',
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
  };
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcPersistAllowlist = {
    PERSIST_ALWAYS_ROOTS,
    PERSIST_PERSONAL_ROOTS,
    PERSIST_NEVER_ROOTS,
    PERSIST_ENFORCEMENT_ENABLED,
    shouldPersistPath,
    filterDbForPersist,
    getPersistAllowlistReport,
    help() {
      console.info(`Persist allowlist (S6d — prep only)
Enforcement: ${PERSIST_ENFORCEMENT_ENABLED ? 'ON' : 'OFF (full _db still persisted)'}
Always: ${PERSIST_ALWAYS_ROOTS.join(', ')}
Personal: ${PERSIST_PERSONAL_ROOTS.map((r) => r + '/{user}').join(', ')}
Never: ${PERSIST_NEVER_ROOTS.join(', ')}
Report: qcPersistAllowlist.getPersistAllowlistReport()
Test: qcPersistAllowlist.shouldPersistPath('players/bobby','bobby')`);
    },
  };
}

_installWindowApi();
