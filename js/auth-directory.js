/**
 * auth-directory.js — Option C-a authDirectory foundation
 *
 * Schema: authDirectory/{username} = { loginEmail, authUid, generation }
 * Pre-auth public read for login email resolution (child paths only — no parent enumerate).
 * players/{u}.authUid remains RTDB ownership authority (Security Rules).
 *
 * C-a.2 (production default): authDirectory REQUIRED for Firebase Auth login/restore.
 *   Missing/invalid directory → FAIL CLOSED.
 * Developer emergency only: localStorage qc_auth_directory_compat === 'true'
 *   temporarily allows gen0 {u}@scicards.local fallback (not normal production).
 * Separate emergency: qc_force_legacy_auth (full legacy RTDB-hash path in auth.js).
 *
 * Backfill (qcAuth.backfillAuthDirectory) is migration/emergency tooling — never
 * auto-run during student login. Per-username child force-reads only.
 */

import * as db from './database.js';
import {
  adminLoadCanonical,
  assertCanonicalComplete,
  canonicalChildEntries,
} from './admin-maintenance.js';

export const AUTH_DIRECTORY_ROOT = 'authDirectory';
export const AUTH_EMAIL_DOMAIN = 'scicards.local';

/** Freshness / feature proof for live C-a.2 builds (production-default strict). */
export const OPTION_CA_FOUNDATION_VERSION = 'option-c-a-2';

/**
 * Developer/emergency compatibility escape only.
 * When === 'true', missing authDirectory may fall back to gen0 synthetic email.
 * Unset/any other value → production STRICT (fail closed).
 */
export const AUTH_DIRECTORY_COMPAT_LS_KEY = 'qc_auth_directory_compat';

/**
 * @deprecated Obsolete C-a.1 localStorage key. Production is strict by default (C-a.2).
 * No longer read for gating. Kept only so old DevTools notes do not confuse rollout.
 */
export const AUTH_DIRECTORY_STRICT_LS_KEY = 'qc_auth_directory_strict';

const EXCLUDED_PLAYER_KEYS = Object.freeze(['__admin__']);

/**
 * Gen0 synthetic email — never a real student inbox.
 * @param {string} username
 * @returns {string}
 */
export function usernameToAuthEmail(username) {
  const u = String(username || '').trim().toLowerCase();
  return `${u}@${AUTH_EMAIL_DOMAIN}`;
}

function _lsGet(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function _lsSet(key, value) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn('[AuthDirectory] localStorage set failed:', e?.message || e);
    return false;
  }
}

function _lsRemove(key) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.removeItem(key);
    return true;
  } catch (e) {
    console.warn('[AuthDirectory] localStorage remove failed:', e?.message || e);
    return false;
  }
}

/**
 * Developer/emergency: temporary gen0 missing-directory fallback.
 * @returns {boolean}
 */
export function isAuthDirectoryCompatEnabled() {
  return _lsGet(AUTH_DIRECTORY_COMPAT_LS_KEY) === 'true';
}

/**
 * Effective production mode for this browser.
 * Default/unset → strict (true). Compat escape → false.
 * @returns {boolean}
 */
export function isAuthDirectoryStrict() {
  return !isAuthDirectoryCompatEnabled();
}

/** Enable developer/emergency gen0 missing-directory fallback (this browser only). */
export function enableAuthDirectoryCompat() {
  _lsSet(AUTH_DIRECTORY_COMPAT_LS_KEY, 'true');
  _lsRemove(AUTH_DIRECTORY_STRICT_LS_KEY);
  return {
    ok: true,
    strictDefault: true,
    compatEnabled: true,
    scope: 'localStorage-this-browser-only',
    note: 'Developer/emergency only — not normal production behavior.',
  };
}

/** Clear developer compat escape → this browser back to production strict. */
export function disableAuthDirectoryCompat() {
  _lsRemove(AUTH_DIRECTORY_COMPAT_LS_KEY);
  return {
    ok: true,
    strictDefault: true,
    compatEnabled: false,
    scope: 'localStorage-this-browser-only',
  };
}

/**
 * @deprecated Alias — production is already strict by default. Clears compat escape only.
 */
export function enableAuthDirectoryStrict() {
  const r = disableAuthDirectoryCompat();
  return {
    ...r,
    strict: true,
    note:
      'C-a.2 production is strict by default. This only clears qc_auth_directory_compat. '
      + 'Do not use as a teacher rollout step.',
  };
}

/**
 * @deprecated Prefer enableAuthDirectoryCompat(). Opens developer gen0 fallback.
 */
export function disableAuthDirectoryStrict() {
  const r = enableAuthDirectoryCompat();
  return {
    ...r,
    strict: false,
    note: 'Developer/emergency compat escape only — not production.',
  };
}

/**
 * @param {string} username
 * @param {{ loginEmail: string, authUid: string, generation?: number }} fields
 */
export function buildAuthDirectoryEntry(username, fields) {
  const u = String(username || '').trim().toLowerCase();
  const loginEmail = String(fields.loginEmail || '').trim().toLowerCase();
  const authUid = String(fields.authUid || '').trim();
  const generation = Number(fields.generation);
  return {
    username: u,
    entry: {
      loginEmail,
      authUid,
      generation: Number.isFinite(generation) && generation >= 0 ? generation : 0,
    },
  };
}

/**
 * Gen0 entry for registration / backfill.
 * @param {string} username
 * @param {string} authUid
 */
export function buildGen0AuthDirectoryEntry(username, authUid) {
  const u = String(username || '').trim().toLowerCase();
  return buildAuthDirectoryEntry(u, {
    loginEmail: usernameToAuthEmail(u),
    authUid,
    generation: 0,
  }).entry;
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, loginEmail: string, authUid: string, generation: number } | { ok: false, error: string }}
 */
export function parseAuthDirectoryEntry(value) {
  if (value == null || typeof value !== 'object') {
    return { ok: false, error: 'AUTH_DIRECTORY_MISSING' };
  }
  const loginEmail = String(value.loginEmail || '').trim().toLowerCase();
  const authUid = String(value.authUid || '').trim();
  const generation = Number(value.generation);
  if (!loginEmail) return { ok: false, error: 'AUTH_DIRECTORY_INVALID_EMAIL' };
  if (!authUid) return { ok: false, error: 'AUTH_DIRECTORY_INVALID_UID' };
  if (!Number.isFinite(generation) || generation < 0) {
    return { ok: false, error: 'AUTH_DIRECTORY_INVALID_GENERATION' };
  }
  return { ok: true, loginEmail, authUid, generation };
}

/**
 * Cache read only — not authoritative for login.
 * @param {string} username
 */
export function getAuthDirectoryEntry(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  return db.get(`${AUTH_DIRECTORY_ROOT}/${u}`) ?? null;
}

/**
 * Authoritative once-load for login/restore (not cache-as-truth).
 * @param {string} username
 * @param {{ force?: boolean, timeoutMs?: number }} [options]
 */
export async function loadAuthDirectoryEntry(username, options = {}) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) {
    return { ok: false, error: 'INVALID_USERNAME', entry: null, parsed: null };
  }
  const path = `${AUTH_DIRECTORY_ROOT}/${u}`;
  const load = await db.loadPathOnce(path, {
    force: options.force !== false,
    timeoutMs: options.timeoutMs,
  });
  if (!load || load.ok !== true) {
    return {
      ok: false,
      error: load?.error || 'AUTH_DIRECTORY_LOAD_FAILED',
      entry: null,
      parsed: null,
      mode: load?.mode ?? null,
    };
  }
  // Confirmed null = missing entry (valid empty)
  const raw = load.value !== undefined ? load.value : db.get(path);
  if (raw == null) {
    return {
      ok: true,
      missing: true,
      entry: null,
      parsed: null,
      mode: load.mode,
    };
  }
  const parsed = parseAuthDirectoryEntry(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      entry: raw,
      parsed: null,
      mode: load.mode,
    };
  }
  return {
    ok: true,
    missing: false,
    entry: raw,
    parsed,
    mode: load.mode,
  };
}

/**
 * Pure decision after authDirectory load (testable).
 * Production default: missing → FAIL. Compat escape: gen0 email fallback.
 *
 * @param {string} username
 * @param {{
 *   ok?: boolean,
 *   missing?: boolean,
 *   parsed?: { loginEmail: string, authUid: string, generation: number }|null,
 *   error?: string,
 * }} loaded
 * @param {{ compatEnabled?: boolean }} [options]
 */
export function decideAuthLoginTargetFromLoad(username, loaded, options = {}) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return { ok: false, error: 'Please enter a username.' };

  const compatEnabled = options.compatEnabled === true
    || (options.compatEnabled == null && isAuthDirectoryCompatEnabled());

  if (!loaded || (!loaded.ok && !loaded.missing)) {
    const err = loaded?.error;
    return {
      ok: false,
      error: err === 'AUTH_DIRECTORY_LOAD_FAILED'
        ? 'Could not verify account. Please try again.'
        : 'Account auth directory is invalid. Ask a teacher for help.',
    };
  }

  if (loaded.ok && !loaded.missing && loaded.parsed) {
    return {
      ok: true,
      loginEmail: loaded.parsed.loginEmail,
      expectedAuthUid: loaded.parsed.authUid,
      generation: loaded.parsed.generation,
      source: 'authDirectory',
    };
  }

  // Missing directory
  if (!compatEnabled) {
    return {
      ok: false,
      error:
        'Account is not ready for login (auth directory missing). '
        + 'Ask a teacher to run auth directory backfill.',
      code: 'AUTH_DIRECTORY_REQUIRED',
    };
  }

  return {
    ok: true,
    loginEmail: usernameToAuthEmail(u),
    expectedAuthUid: null, // verified against players/{u}.authUid after sign-in
    generation: 0,
    source: 'gen0Compat',
  };
}

/**
 * Whether restore may continue when authDirectory is missing.
 * Production default: false. Developer compat: true (then gen0 email must still match).
 *
 * @param {{ compatEnabled?: boolean }} [options]
 * @returns {boolean}
 */
export function allowMissingAuthDirectoryOnRestore(options = {}) {
  if (options.compatEnabled === true) return true;
  if (options.compatEnabled === false) return false;
  return isAuthDirectoryCompatEnabled();
}

/**
 * Resolve login credentials for Firebase Auth path.
 * C-a.2: authDirectory required unless qc_auth_directory_compat === 'true'.
 *
 * @param {string} username
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   code?: string,
 *   loginEmail?: string,
 *   expectedAuthUid?: string|null,
 *   generation?: number|null,
 *   source?: 'authDirectory'|'gen0Compat',
 * }>}
 */
export async function resolveAuthLoginTarget(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return { ok: false, error: 'Please enter a username.' };

  const loaded = await loadAuthDirectoryEntry(u, { force: true });
  return decideAuthLoginTargetFromLoad(u, loaded);
}

/**
 * Registration multipath fragment.
 * @param {string} username
 * @param {string} authUid
 */
export function authDirectoryPathsForRegistration(username, authUid) {
  const u = String(username || '').trim().toLowerCase();
  const entry = buildGen0AuthDirectoryEntry(u, authUid);
  return { [`${AUTH_DIRECTORY_ROOT}/${u}`]: entry };
}

/**
 * Pure backfill planner — no DB writes.
 * @param {{
 *   playersSnapshot?: object|null,
 *   authDirectorySnapshot?: object|null,
 * }} input
 */
export function buildAuthDirectoryBackfillPlan(input) {
  const players = input.playersSnapshot;
  const existingDir = input.authDirectorySnapshot && typeof input.authDirectorySnapshot === 'object'
    ? input.authDirectorySnapshot
    : {};

  const playerEntries = canonicalChildEntries(players, {
    exclude: [...EXCLUDED_PLAYER_KEYS],
  });

  /** @type {Record<string, object>} */
  const updates = {};
  /** @type {string[]} */
  const created = [];
  /** @type {string[]} */
  const unchanged = [];
  /** @type {Array<{ username: string, reason: string, existing?: object, desired?: object }>} */
  const conflicts = [];
  /** @type {string[]} */
  const missingAuthUid = [];

  for (const { key: username, value: player } of playerEntries) {
    const p = player && typeof player === 'object' ? player : {};
    const authUid = typeof p.authUid === 'string' && p.authUid.trim()
      ? p.authUid.trim()
      : null;
    if (!authUid) {
      missingAuthUid.push(username);
      continue;
    }

    const desired = buildGen0AuthDirectoryEntry(username, authUid);
    const cur = existingDir[username];

    if (cur == null) {
      updates[`${AUTH_DIRECTORY_ROOT}/${username}`] = desired;
      created.push(username);
      continue;
    }

    const parsed = parseAuthDirectoryEntry(cur);
    if (!parsed.ok) {
      conflicts.push({
        username,
        reason: 'INVALID_EXISTING',
        existing: cur,
        desired,
      });
      continue;
    }

    const matchesGen0 =
      parsed.loginEmail === desired.loginEmail
      && parsed.authUid === desired.authUid
      && parsed.generation === 0;

    if (matchesGen0) {
      unchanged.push(username);
      continue;
    }

    // Non-gen0 or mismatched — do not overwrite
    conflicts.push({
      username,
      reason: 'CONFLICT_NOT_GEN0_MATCH',
      existing: {
        loginEmail: parsed.loginEmail,
        authUid: parsed.authUid,
        generation: parsed.generation,
      },
      desired,
    });
  }

  return {
    ok: true,
    updates,
    scanned: playerEntries.length,
    created: created.length,
    unchanged: unchanged.length,
    conflicts: conflicts.length,
    missingAuthUid: missingAuthUid.length,
    createdUsernames: created,
    unchangedUsernames: unchanged,
    conflictDetails: conflicts,
    missingAuthUidUsernames: missingAuthUid,
  };
}

/**
 * Force-load authDirectory/{username} for each username (public child reads).
 * Never loads authDirectory parent — child .read does not grant parent enumerate.
 *
 * Fail-closed: any child with ok!==true or mode!=='firebase' aborts (caller must not write).
 *
 * @param {string[]} usernames
 * @param {{ timeoutMs?: number, loadPathOnce?: Function }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   failedUsername?: string,
 *   path?: string,
 *   authDirectorySnapshot?: Record<string, object>,
 * }>}
 */
export async function gatherAuthDirectorySnapshotByUsernames(usernames, options = {}) {
  const loadFn = typeof options.loadPathOnce === 'function'
    ? options.loadPathOnce
    : (path, opts) => db.loadPathOnce(path, opts);

  /** @type {Record<string, object>} */
  const authDirectorySnapshot = {};
  const list = Array.isArray(usernames) ? usernames : [];

  for (const raw of list) {
    const username = String(raw || '').trim().toLowerCase();
    if (!username) continue;
    const path = `${AUTH_DIRECTORY_ROOT}/${username}`;
    const load = await loadFn(path, {
      force: true,
      timeoutMs: options.timeoutMs,
    });
    if (!load || load.ok !== true || load.mode !== 'firebase') {
      return {
        ok: false,
        error: load?.error || 'AUTH_DIRECTORY_CHILD_LOAD_FAILED',
        failedUsername: username,
        path,
      };
    }
    // Confirmed null / undefined = missing entry (omit key)
    const value = load.value;
    if (value != null && typeof value === 'object') {
      authDirectorySnapshot[username] = value;
    }
  }

  return { ok: true, authDirectorySnapshot };
}

/**
 * Gather + plan authDirectory backfill (admin).
 * Uses per-username child force-reads only — never authDirectory parent.
 * @param {{ timeoutMs?: number, loadPathOnce?: Function }} [options]
 */
export async function prepareAuthDirectoryBackfill(options = {}) {
  const playersLoad = await adminLoadCanonical('players', options);
  if (!assertCanonicalComplete(playersLoad)) {
    return {
      ok: false,
      error: playersLoad?.error || 'PLAYERS_CANONICAL_INCOMPLETE',
    };
  }

  const playerEntries = canonicalChildEntries(playersLoad.value, {
    exclude: [...EXCLUDED_PLAYER_KEYS],
  });
  const usernames = playerEntries.map((e) => e.key);

  const gathered = await gatherAuthDirectorySnapshotByUsernames(usernames, options);
  if (!gathered.ok) {
    return {
      ok: false,
      error: gathered.error || 'AUTH_DIRECTORY_CHILD_LOAD_FAILED',
      failedUsername: gathered.failedUsername,
      path: gathered.path,
      written: 0,
    };
  }

  const plan = buildAuthDirectoryBackfillPlan({
    playersSnapshot: playersLoad.value,
    authDirectorySnapshot: gathered.authDirectorySnapshot || {},
  });

  return {
    ok: true,
    plan,
    advisory: true,
    authDirectorySnapshot: gathered.authDirectorySnapshot,
  };
}

/**
 * Commit backfill plan (or prepare+commit).
 * @param {{ plan?: object, timeoutMs?: number }} [options]
 */
export async function commitAuthDirectoryBackfill(options = {}) {
  let plan = options.plan;
  if (!plan) {
    const prepared = await prepareAuthDirectoryBackfill(options);
    if (!prepared.ok || !prepared.plan) {
      return { ok: false, error: prepared.error || 'PREPARE_FAILED' };
    }
    plan = prepared.plan;
  }

  if (plan.conflicts > 0) {
    return {
      ok: false,
      error: 'CONFLICTS_PRESENT',
      plan,
      written: 0,
      message:
        'Backfill refused: conflicting authDirectory entries exist. Inspect plan.conflictDetails.',
    };
  }

  const keys = Object.keys(plan.updates || {});
  if (keys.length === 0) {
    return {
      ok: true,
      skipped: true,
      written: 0,
      plan,
      mode: null,
    };
  }

  const ack = await db.updateAcknowledged(plan.updates);
  if (!ack.ok) {
    return {
      ok: false,
      error: ack.error || 'BACKFILL_WRITE_FAILED',
      plan,
      written: 0,
      mode: ack.mode,
    };
  }

  return {
    ok: true,
    written: keys.length,
    plan,
    mode: ack.mode,
  };
}

/**
 * One-shot Admin helper: prepare → commit (refuses on conflicts).
 */
export async function backfillAuthDirectory(options = {}) {
  const prepared = await prepareAuthDirectoryBackfill(options);
  if (!prepared.ok) {
    return prepared;
  }
  const result = await commitAuthDirectoryBackfill({ plan: prepared.plan, ...options });
  return {
    ...result,
    scanned: prepared.plan.scanned,
    created: prepared.plan.created,
    unchanged: prepared.plan.unchanged,
    conflicts: prepared.plan.conflicts,
    missingAuthUid: prepared.plan.missingAuthUid,
    conflictDetails: prepared.plan.conflictDetails,
    missingAuthUidUsernames: prepared.plan.missingAuthUidUsernames,
  };
}

export function getOptionCaStatus() {
  const compatEnabled = isAuthDirectoryCompatEnabled();
  return {
    optionCaFoundationVersion: OPTION_CA_FOUNDATION_VERSION,
    release: 'C-a.2',
    strictDefault: true,
    migrationCompatDefault: false,
    authDirectoryCompatEnabled: compatEnabled,
    authDirectoryStrictEffective: !compatEnabled,
    authDirectoryRoot: AUTH_DIRECTORY_ROOT,
    authDirectoryCompatLsKey: AUTH_DIRECTORY_COMPAT_LS_KEY,
    backfillGather: 'per-username child force-reads (no authDirectory parent)',
    registrationLbUsername: true,
    note:
      'C-a.2 production-default strict: authDirectory required for login/restore. '
      + 'Developer emergency only: localStorage qc_auth_directory_compat=true allows temporary gen0 fallback. '
      + 'Separate: qc_force_legacy_auth for full legacy RTDB-hash path. '
      + 'Backfill is migration/emergency tooling — not student login. No rules republish.',
  };
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcAuth = {
    ...(window.qcAuth || {}),
    OPTION_CA_FOUNDATION_VERSION,
    AUTH_DIRECTORY_ROOT,
    AUTH_DIRECTORY_COMPAT_LS_KEY,
    AUTH_DIRECTORY_STRICT_LS_KEY,
    getOptionCaStatus,
    usernameToAuthEmail,
    buildGen0AuthDirectoryEntry,
    parseAuthDirectoryEntry,
    loadAuthDirectoryEntry,
    decideAuthLoginTargetFromLoad,
    allowMissingAuthDirectoryOnRestore,
    resolveAuthLoginTarget,
    gatherAuthDirectorySnapshotByUsernames,
    prepareAuthDirectoryBackfill,
    commitAuthDirectoryBackfill,
    backfillAuthDirectory,
    enableAuthDirectoryCompat,
    disableAuthDirectoryCompat,
    isAuthDirectoryCompatEnabled,
    enableAuthDirectoryStrict,
    disableAuthDirectoryStrict,
    isAuthDirectoryStrict,
    help() {
      console.info(`Option C-a.2 authDirectory (production-default STRICT)
Freshness: qcAuth.getOptionCaStatus()
  → optionCaFoundationVersion === '${OPTION_CA_FOUNDATION_VERSION}'
  → strictDefault === true
  → migrationCompatDefault === false
  → authDirectoryCompatEnabled === false (unless you set developer escape)
Login/restore require authDirectory/{u} (fail closed if missing)
Developer emergency ONLY:
  localStorage.setItem('${AUTH_DIRECTORY_COMPAT_LS_KEY}', 'true')
  // or qcAuth.enableAuthDirectoryCompat()
Separate emergency: qc_force_legacy_auth (legacy RTDB hash — not authDirectory)
Backfill (Admin, migration/emergency): await qcAuth.backfillAuthDirectory()
Schema: ${AUTH_DIRECTORY_ROOT}/{u} = { loginEmail, authUid, generation }
Ownership remains players/{u}/authUid
Do NOT tell teachers to call enableAuthDirectoryStrict() as a rollout step`);
    },
  };
}

_installWindowApi();
