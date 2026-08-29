/**
 * player-lock.js — Admin server-enforced one-player account lock.
 *
 * Dual mirrors (atomic multipath):
 *   playerLocks/{username}     — username-scoped rules checks
 *   playerLocksByUid/{authUid} — uid-scoped rules checks (indexes, etc.)
 *
 * Security is RTDB rules. This module only writes lock mirrors + clears activeSession.
 */

import * as db from './database.js';
import { getAuth } from './firebase-config.js';
import { isUidInAdminRegistry } from './admin-registry.js';

export const PLAYER_LOCKS_ROOT = 'playerLocks';
export const PLAYER_LOCKS_BY_UID_ROOT = 'playerLocksByUid';

export const MSG_ACCOUNT_TEMPORARILY_UNAVAILABLE =
  'Your account is temporarily unavailable. Please contact your teacher.';

/**
 * @param {string} username
 * @returns {string}
 */
export function playerLockPath(username) {
  return `${PLAYER_LOCKS_ROOT}/${String(username || '').trim()}`;
}

/**
 * @param {string} authUid
 * @returns {string}
 */
export function playerLockByUidPath(authUid) {
  return `${PLAYER_LOCKS_BY_UID_ROOT}/${String(authUid || '').trim()}`;
}

/**
 * True when username mirror explicitly locked:true (fail-closed for UI/guards).
 * @param {string} username
 * @returns {boolean}
 */
export function isPlayerAdminLocked(username) {
  const key = String(username || '').trim();
  if (!key) return false;
  const row = db.get(playerLockPath(key));
  return !!(row && row.locked === true);
}

/**
 * @param {string} authUid
 * @returns {boolean}
 */
export function isAuthUidAdminLocked(authUid) {
  const uid = String(authUid || '').trim();
  if (!uid) return false;
  const row = db.get(playerLockByUidPath(uid));
  return !!(row && row.locked === true);
}

/**
 * Fail-closed evaluation of dual lock mirrors (pure; used by rules UX + tests).
 * @param {string} key
 * @param {string} uid
 * @param {object|null} usernameMirror
 * @param {object|null} uidMirror
 * @returns {{ locked: boolean, reason?: string, usernameMirror: object|null, uidMirror: object|null }}
 */
export function evaluateLockMirrors(key, uid, usernameMirror, uidMirror) {
  const userLocked = !!(usernameMirror && usernameMirror.locked === true);
  const uidLocked = !!(uidMirror && uidMirror.locked === true);

  if (!userLocked && !uidLocked && !usernameMirror && !uidMirror) {
    return { locked: false, usernameMirror, uidMirror };
  }

  if (userLocked && uidLocked) {
    if (uid && uidMirror.username && uidMirror.username !== key) {
      return {
        locked: true,
        reason: 'mirror_username_mismatch',
        usernameMirror,
        uidMirror,
      };
    }
    return { locked: true, usernameMirror, uidMirror };
  }

  // Incomplete or one-sided → treat as locked (fail-closed)
  return {
    locked: true,
    reason: userLocked && !uidLocked
      ? 'uid_mirror_missing'
      : !userLocked && uidLocked
        ? 'username_mirror_missing'
        : 'malformed_lock',
    usernameMirror,
    uidMirror,
  };
}

/**
 * Fail-closed client check: either mirror locked, or mirrors disagree / incomplete.
 * @param {string} username
 * @param {string|null|undefined} authUid
 * @returns {{ locked: boolean, reason?: string, usernameMirror: object|null, uidMirror: object|null }}
 */
export function getPlayerLockConsistency(username, authUid) {
  const key = String(username || '').trim();
  const uid = authUid != null ? String(authUid).trim() : '';
  const usernameMirror = key ? (db.get(playerLockPath(key)) || null) : null;
  const uidMirror = uid ? (db.get(playerLockByUidPath(uid)) || null) : null;
  return evaluateLockMirrors(key, uid, usernameMirror, uidMirror);
}

async function _callerIsAdmin() {
  // Dynamic import avoids circular dependency with auth.js (which imports this module).
  const authMod = await import('./auth.js');
  if (!authMod.isAdmin()) return false;
  try {
    const uid = getAuth().currentUser?.uid;
    if (uid && isUidInAdminRegistry(uid)) return true;
  } catch { /* Auth not ready */ }
  return authMod.isAdmin();
}

function _callerAuthUid() {
  try {
    const uid = getAuth().currentUser?.uid;
    if (uid) return String(uid);
  } catch { /* ignore */ }
  return null;
}

/**
 * Resolve stable player identity for lock ops.
 * @param {string} username
 * @returns {{ ok: true, username: string, authUid: string } | { ok: false, error: string }}
 */
export function resolvePlayerLockIdentity(username) {
  const key = String(username || '').trim();
  if (!key || key === '__admin__') {
    return { ok: false, error: 'Invalid player username.' };
  }
  const player = db.get(`players/${key}`);
  if (!player || typeof player !== 'object') {
    return { ok: false, error: 'Player record not found.' };
  }
  const authUid = player.authUid != null ? String(player.authUid).trim() : '';
  if (!authUid) {
    return { ok: false, error: 'Player is missing authUid; cannot lock safely.' };
  }
  return { ok: true, username: key, authUid };
}

/**
 * Admin lock: both mirrors + clear activeSession in one updateAcknowledged.
 * @param {string} username
 * @returns {Promise<object>}
 */
export async function adminLockPlayer(username) {
  if (!(await _callerIsAdmin())) {
    return { ok: false, error: 'Admin authorization required.' };
  }
  const identity = resolvePlayerLockIdentity(username);
  if (!identity.ok) return { ok: false, error: identity.error };

  // Ensure identity leaf is present (caller should have hydrated player; re-check authUid).
  await db.loadPathOnce(`players/${identity.username}`, { force: true });
  const refreshed = resolvePlayerLockIdentity(username);
  if (!refreshed.ok) return { ok: false, error: refreshed.error };

  const lockedByUid = _callerAuthUid();
  if (!lockedByUid) {
    return { ok: false, error: 'Admin Auth uid unavailable.' };
  }

  const now = Date.now();
  const lockBody = {
    locked: true,
    lockedAt: now,
    lockedByUid,
  };
  const uidBody = {
    locked: true,
    username: refreshed.username,
    lockedAt: now,
    lockedByUid,
  };

  const updates = {
    [playerLockPath(refreshed.username)]: lockBody,
    [playerLockByUidPath(refreshed.authUid)]: uidBody,
    [`players/${refreshed.username}/activeSession`]: null,
  };

  const ack = await db.updateAcknowledged(updates);
  if (!ack.ok) {
    return { ok: false, error: ack.error || 'Lock write failed.', mode: ack.mode };
  }

  return {
    ok: true,
    username: refreshed.username,
    authUid: refreshed.authUid,
    lockedAt: now,
    lockedByUid,
    clearedActiveSession: true,
    mode: ack.mode,
  };
}

/**
 * Admin unlock: remove both mirrors atomically. Reports corrupt/mismatch without silent unlock.
 * @param {string} username
 * @returns {Promise<object>}
 */
export async function adminUnlockPlayer(username) {
  if (!(await _callerIsAdmin())) {
    return { ok: false, error: 'Admin authorization required.' };
  }
  const identity = resolvePlayerLockIdentity(username);
  if (!identity.ok) return { ok: false, error: identity.error };

  await db.loadPathOnce(`players/${identity.username}`, { force: true });
  await db.loadPathOnce(playerLockPath(identity.username), { force: true });
  await db.loadPathOnce(playerLockByUidPath(identity.authUid), { force: true });

  const refreshed = resolvePlayerLockIdentity(username);
  if (!refreshed.ok) return { ok: false, error: refreshed.error };

  const consistency = getPlayerLockConsistency(refreshed.username, refreshed.authUid);
  const userPath = playerLockPath(refreshed.username);
  const uidPath = playerLockByUidPath(refreshed.authUid);
  const userRow = consistency.usernameMirror;
  const uidRow = consistency.uidMirror;

  if (!userRow && !uidRow) {
    return {
      ok: true,
      alreadyUnlocked: true,
      username: refreshed.username,
      authUid: refreshed.authUid,
    };
  }

  // Mismatch / one-sided: still clear BOTH known paths, but report warning
  const warnings = [];
  if (consistency.reason) warnings.push(consistency.reason);
  if (uidRow?.username && uidRow.username !== refreshed.username) {
    warnings.push('uid_mirror_points_elsewhere');
  }
  if (userRow && userRow.locked !== true) {
    warnings.push('username_mirror_locked_flag_not_true');
  }
  if (uidRow && uidRow.locked !== true) {
    warnings.push('uid_mirror_locked_flag_not_true');
  }

  /** @type {Record<string, null>} */
  const updates = {
    [userPath]: null,
    [uidPath]: null,
  };

  // If uid mirror points at a different username string, still clear this player's uid path only.
  // Do not delete unrelated usernames' locks.

  const ack = await db.updateAcknowledged(updates);
  if (!ack.ok) {
    return {
      ok: false,
      error: ack.error || 'Unlock write failed.',
      mode: ack.mode,
      warnings,
    };
  }

  return {
    ok: true,
    username: refreshed.username,
    authUid: refreshed.authUid,
    warnings,
    mode: ack.mode,
    hadInconsistentMirrors: warnings.length > 0,
  };
}

/**
 * Build lock multipath for tests / planners (no I/O).
 */
export function buildAdminLockPlayerUpdates(username, authUid, lockedByUid, now = Date.now()) {
  const key = String(username || '').trim();
  const uid = String(authUid || '').trim();
  const by = String(lockedByUid || '').trim();
  return {
    [playerLockPath(key)]: { locked: true, lockedAt: now, lockedByUid: by },
    [playerLockByUidPath(uid)]: {
      locked: true,
      username: key,
      lockedAt: now,
      lockedByUid: by,
    },
    [`players/${key}/activeSession`]: null,
  };
}

export function buildAdminUnlockPlayerUpdates(username, authUid) {
  const key = String(username || '').trim();
  const uid = String(authUid || '').trim();
  return {
    [playerLockPath(key)]: null,
    [playerLockByUidPath(uid)]: null,
  };
}
