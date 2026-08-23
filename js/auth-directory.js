/**
 * auth-directory.js — Option C-a authDirectory foundation
 *
 * Schema: authDirectory/{username} = { loginEmail, authUid, generation }
 * Pre-auth public read for login email resolution.
 * players/{u}.authUid remains RTDB ownership authority (Security Rules).
 *
 * Rollout: until localStorage.qc_auth_directory_strict === 'true', Firebase Auth
 * login/restore may use gen0 hardcoded email ONLY when authDirectory is missing
 * (explicit migration window). Final verified state must enable strict mode.
 */

import * as db from './database.js';
import {
  adminLoadCanonical,
  assertCanonicalComplete,
  canonicalChildEntries,
} from './admin-maintenance.js';

export const AUTH_DIRECTORY_ROOT = 'authDirectory';
export const AUTH_EMAIL_DOMAIN = 'scicards.local';

/** Freshness / feature proof for live C-a builds. */
export const OPTION_CA_FOUNDATION_VERSION = 'option-c-a-1';

/** After backfill verified: set to 'true' for strict authDirectory-only Auth login. */
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

/**
 * @returns {boolean}
 */
export function isAuthDirectoryStrict() {
  try {
    return localStorage.getItem(AUTH_DIRECTORY_STRICT_LS_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Call after backfill + login verify to end gen0 missing-directory compat. */
export function enableAuthDirectoryStrict() {
  try {
    localStorage.setItem(AUTH_DIRECTORY_STRICT_LS_KEY, 'true');
  } catch (e) {
    console.warn('[AuthDirectory] enableAuthDirectoryStrict failed:', e?.message || e);
  }
  return { ok: true, strict: true };
}

/** Developer: re-open migration compat window. */
export function disableAuthDirectoryStrict() {
  try {
    localStorage.removeItem(AUTH_DIRECTORY_STRICT_LS_KEY);
  } catch (e) {
    console.warn('[AuthDirectory] disableAuthDirectoryStrict failed:', e?.message || e);
  }
  return { ok: true, strict: false };
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
 * Resolve login credentials for Firebase Auth path.
 * Strict: authDirectory required.
 * Compat (default until enableAuthDirectoryStrict): missing → gen0 email fallback.
 *
 * @param {string} username
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
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
  if (!loaded.ok && !loaded.missing) {
    return {
      ok: false,
      error: loaded.error === 'AUTH_DIRECTORY_LOAD_FAILED'
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
  if (isAuthDirectoryStrict()) {
    return {
      ok: false,
      error:
        'Account is not ready for login (auth directory missing). '
        + 'Ask a teacher to run auth directory backfill.',
    };
  }

  // Explicit C-a migration window only
  return {
    ok: true,
    loginEmail: usernameToAuthEmail(u),
    expectedAuthUid: null, // verified against players/{u}.authUid after sign-in
    generation: 0,
    source: 'gen0Compat',
  };
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
 * Gather + plan authDirectory backfill (admin).
 * @param {{ timeoutMs?: number }} [options]
 */
export async function prepareAuthDirectoryBackfill(options = {}) {
  const playersLoad = await adminLoadCanonical('players', options);
  if (!assertCanonicalComplete(playersLoad)) {
    return {
      ok: false,
      error: playersLoad?.error || 'PLAYERS_CANONICAL_INCOMPLETE',
    };
  }

  const dirLoad = await db.loadPathOnce(AUTH_DIRECTORY_ROOT, {
    force: true,
    timeoutMs: options.timeoutMs,
  });
  if (!dirLoad || dirLoad.ok !== true || dirLoad.mode !== 'firebase') {
    return {
      ok: false,
      error: dirLoad?.error || 'AUTH_DIRECTORY_ROOT_LOAD_INCOMPLETE',
    };
  }

  const plan = buildAuthDirectoryBackfillPlan({
    playersSnapshot: playersLoad.value,
    authDirectorySnapshot: dirLoad.value && typeof dirLoad.value === 'object'
      ? dirLoad.value
      : {},
  });

  return {
    ok: true,
    plan,
    advisory: true,
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
  return {
    optionCaFoundationVersion: OPTION_CA_FOUNDATION_VERSION,
    authDirectoryStrict: isAuthDirectoryStrict(),
    authDirectoryRoot: AUTH_DIRECTORY_ROOT,
    note:
      'C-a: authDirectory foundation. Enable strict after backfill: qcAuth.enableAuthDirectoryStrict()',
  };
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcAuth = {
    ...(window.qcAuth || {}),
    OPTION_CA_FOUNDATION_VERSION,
    AUTH_DIRECTORY_ROOT,
    AUTH_DIRECTORY_STRICT_LS_KEY,
    getOptionCaStatus,
    usernameToAuthEmail,
    buildGen0AuthDirectoryEntry,
    parseAuthDirectoryEntry,
    loadAuthDirectoryEntry,
    resolveAuthLoginTarget,
    prepareAuthDirectoryBackfill,
    commitAuthDirectoryBackfill,
    backfillAuthDirectory,
    enableAuthDirectoryStrict,
    disableAuthDirectoryStrict,
    isAuthDirectoryStrict,
    help() {
      console.info(`Option C-a authDirectory
Freshness: qcAuth.getOptionCaStatus()
  → optionCaFoundationVersion === '${OPTION_CA_FOUNDATION_VERSION}'
Backfill (Admin Auth session): await qcAuth.backfillAuthDirectory()
Strict after verify: qcAuth.enableAuthDirectoryStrict()
Compat window (missing directory → gen0 email): default until strict
Schema: ${AUTH_DIRECTORY_ROOT}/{u} = { loginEmail, authUid, generation }
Ownership remains players/{u}/authUid`);
    },
  };
}

_installWindowApi();
