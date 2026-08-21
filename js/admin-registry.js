/**
 * S8c-0 Spark admin authority registry — admins/{authUid}: true
 *
 * Security authority after S8c-1 rules will be this registry only.
 * During S8c-0 (open rules), writes are client-side preparation; not yet enforced.
 *
 * Do not trust players/{u}.isAdmin as security authority — UI mirror only.
 */

import * as db from './database.js';

export const ADMINS_ROOT = 'admins';

/**
 * @param {string} authUid
 * @returns {string}
 */
export function adminRegistryPath(authUid) {
  const uid = String(authUid || '').trim();
  return `${ADMINS_ROOT}/${uid}`;
}

/**
 * @param {string|null|undefined} authUid
 * @returns {boolean}
 */
export function isUidInAdminRegistry(authUid) {
  const uid = String(authUid || '').trim();
  if (!uid) return false;
  return db.get(adminRegistryPath(uid)) === true;
}

/**
 * Once-load admins/{uid} into cache (open rules today; required after S8c-1).
 * @param {string} authUid
 * @param {{ force?: boolean }} [options]
 */
export async function loadAdminRegistryEntryOnce(authUid, options = {}) {
  const uid = String(authUid || '').trim();
  if (!uid || typeof db.loadPathOnce !== 'function') {
    return { ok: false, isAdmin: false, reason: 'INVALID_UID' };
  }
  const load = await db.loadPathOnce(adminRegistryPath(uid), { force: options.force === true });
  if (!load || load.ok !== true) {
    return { ok: false, isAdmin: false, reason: 'LOAD_FAILED', mode: load?.mode };
  }
  return {
    ok: true,
    isAdmin: load.value === true,
    reason: null,
    mode: load.mode,
  };
}

/**
 * Multipath fragment: registry + optional players.isAdmin + directory mirror fields.
 * Caller must supply directory sync paths separately if needed.
 *
 * @param {string} targetAuthUid
 * @param {boolean} promote
 * @returns {Record<string, boolean|null>}
 */
export function buildAdminRegistryUpdates(targetAuthUid, promote) {
  const uid = String(targetAuthUid || '').trim();
  if (!uid) return {};
  return {
    [adminRegistryPath(uid)]: promote ? true : null,
  };
}
