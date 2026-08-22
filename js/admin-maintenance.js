/**
 * admin-maintenance.js — S8d-1 Admin canonical-read foundation
 *
 * Teacher/admin maintenance loads for later rebuild slices (S8d-2+).
 * Requires Firebase Auth + admins/{uid} registry soft-gate; RTDB rules are final.
 *
 * CRITICAL CONTRACT FOR LATER REBUILDS:
 *   Consume result.value / result.keys from adminLoadCanonical() as the canonical
 *   universe. Do NOT call adminLoadCanonical then treat db.getChildren(...) as proof
 *   of completeness — cache hydration is a side effect only, never canonical truth.
 *
 * Allowlisted paths only: players | trades/direct | trades/listings
 */

import * as db from './database.js';
import { getAuth } from './firebase-config.js';
import { loadAdminRegistryEntryOnce } from './admin-registry.js';

/** Paths that may be loaded via adminLoadCanonical in S8d-1. */
export const ADMIN_CANONICAL_PATHS = Object.freeze([
  'players',
  'trades/direct',
  'trades/listings',
]);

const ALLOWED = new Set(ADMIN_CANONICAL_PATHS);

/**
 * @typedef {{
 *   ok: boolean,
 *   complete: boolean,
 *   path: string,
 *   value: object|null,
 *   empty: boolean,
 *   count: number,
 *   keys: string[],
 *   source: 'firebase'|null,
 *   mode: 'firebase'|'local'|null,
 *   error?: string
 * }} CanonicalLoadResult
 */

/**
 * @param {string} path
 * @returns {string}
 */
function _normalizeCanonicalPath(path) {
  return String(path || '')
    .split('/')
    .filter(Boolean)
    .join('/');
}

/**
 * @param {any} value
 * @returns {{ keys: string[], count: number, empty: boolean }}
 */
export function canonicalKeysFromValue(value) {
  if (value == null || typeof value !== 'object') {
    return { keys: [], count: 0, empty: true };
  }
  const keys = Object.keys(value);
  return { keys, count: keys.length, empty: keys.length === 0 };
}

/**
 * Pure helper: entries for planners (does not read cache).
 * @param {object|null|undefined} value
 * @param {{ exclude?: string[] }} [options]
 * @returns {Array<{ key: string, value: any }>}
 */
export function canonicalChildEntries(value, options = {}) {
  const exclude = new Set(
    (Array.isArray(options.exclude) ? options.exclude : []).map((k) => String(k)),
  );
  if (value == null || typeof value !== 'object') return [];
  /** @type {Array<{ key: string, value: any }>} */
  const out = [];
  for (const [key, child] of Object.entries(value)) {
    if (exclude.has(key)) continue;
    out.push({ key, value: child });
  }
  return out;
}

/**
 * Fail-closed gate for later rebuilds: refuse destructive planning unless complete.
 * @param {CanonicalLoadResult|null|undefined} result
 * @returns {boolean}
 */
export function assertCanonicalComplete(result) {
  return !!(result && result.complete === true && result.ok === true);
}

/**
 * @param {Partial<CanonicalLoadResult> & { path: string, error: string }} fields
 * @returns {CanonicalLoadResult}
 */
function _fail(fields) {
  return {
    ok: false,
    complete: false,
    path: fields.path,
    value: null,
    empty: false,
    count: 0,
    keys: [],
    source: null,
    mode: fields.mode ?? null,
    error: fields.error,
  };
}

/**
 * Soft-gate: Firebase Auth uid + admins/{uid} registry (not session/players.isAdmin).
 * @returns {Promise<{ ok: true, uid: string } | { ok: false, error: string }>}
 */
async function _softGateAdmin() {
  if (typeof db.isFirebaseConnected !== 'function' || !db.isFirebaseConnected()) {
    return { ok: false, error: 'FIREBASE_INACTIVE' };
  }
  let uid = '';
  try {
    uid = String(getAuth().currentUser?.uid || '').trim();
  } catch {
    uid = '';
  }
  if (!uid) {
    return { ok: false, error: 'NOT_AUTHENTICATED' };
  }
  const reg = await loadAdminRegistryEntryOnce(uid, { force: true });
  if (!reg || reg.ok !== true) {
    return { ok: false, error: reg?.reason || 'ADMIN_REGISTRY_LOAD_FAILED' };
  }
  if (reg.isAdmin !== true) {
    return { ok: false, error: 'NOT_ADMIN' };
  }
  return { ok: true, uid };
}

/**
 * Acknowledged Firebase parent read for admin maintenance.
 * complete===true only when mode==='firebase' and the remote read succeeded.
 * value===null with complete===true means confirmed empty tree (not a failure).
 *
 * @param {string} path
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<CanonicalLoadResult>}
 */
export async function adminLoadCanonical(path, options = {}) {
  const normalized = _normalizeCanonicalPath(path);
  if (!normalized || !ALLOWED.has(normalized)) {
    return _fail({
      path: normalized || String(path || ''),
      error: 'PATH_NOT_ALLOWLISTED',
    });
  }

  const gate = await _softGateAdmin();
  if (!gate.ok) {
    return _fail({ path: normalized, error: gate.error, mode: 'firebase' });
  }

  // Always force — ready-path reuse must not fake completeness from scoped cache.
  const load = await db.loadPathOnce(normalized, {
    force: true,
    timeoutMs: options.timeoutMs,
  });

  if (!load || load.ok !== true) {
    return _fail({
      path: normalized,
      mode: load?.mode ?? 'firebase',
      error: load?.error || 'LOAD_FAILED',
    });
  }

  // Never treat local/cache fallback as complete canonical truth.
  if (load.mode !== 'firebase') {
    return _fail({
      path: normalized,
      mode: load.mode,
      error: 'NOT_FIREBASE_AUTHORITATIVE',
    });
  }

  const value = load.value == null ? null : load.value;
  const { keys, count, empty } = canonicalKeysFromValue(value);

  return {
    ok: true,
    complete: true,
    path: normalized,
    value,
    empty: value == null || empty,
    count: value == null ? 0 : count,
    keys: value == null ? [] : keys,
    source: 'firebase',
    mode: 'firebase',
  };
}

/** @param {{ timeoutMs?: number }} [options] */
export function adminLoadPlayers(options = {}) {
  return adminLoadCanonical('players', options);
}

/** @param {{ timeoutMs?: number }} [options] */
export function adminLoadDirectTrades(options = {}) {
  return adminLoadCanonical('trades/direct', options);
}

/** @param {{ timeoutMs?: number }} [options] */
export function adminLoadListings(options = {}) {
  return adminLoadCanonical('trades/listings', options);
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcAdminMaintenance = {
    ADMIN_CANONICAL_PATHS,
    adminLoadCanonical,
    adminLoadPlayers,
    adminLoadDirectTrades,
    adminLoadListings,
    assertCanonicalComplete,
    canonicalChildEntries,
    canonicalKeysFromValue,
    help() {
      console.info(`Admin maintenance (S8d-1 canonical reads)
Allowlist: ${ADMIN_CANONICAL_PATHS.join(' | ')}
Soft-gate: Firebase Auth uid + admins/{uid} (rules remain final)
Load: await qcAdminMaintenance.adminLoadCanonical('players')
  complete===true → may plan orphans (incl. empty tree)
  complete===false → abort; never use db.getChildren as canonical
Rebuilds (S8d-2+): consume result.value / result.keys only — cache is not truth`);
    },
  };
}

_installWindowApi();
