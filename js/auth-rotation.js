/**
 * auth-rotation.js — Option C-b password reset via Auth identity rotation
 *
 * Teacher primary Auth stays signed in. Replacement student Auth identity is
 * created on a secondary named Firebase App (Persistence.NONE), then Admin
 * multipath rebinds authDirectory + players.authUid and clears activeSession.
 *
 * Allowed rebind paths ONLY:
 *   authDirectory/{u}
 *   players/{u}/authUid
 *   players/{u}/activeSession
 *
 * Mid-trade tradeGrants/claimerAuthUid may still reference old UID briefly —
 * ownership security remains correct because players.authUid changed. Do not
 * rewrite Trading here.
 *
 * Old Auth identities may remain orphaned on Spark (harmless after unbind).
 */

import * as db from './database.js';
import { getAuth, createSecondaryAuthApp, disposeSecondaryAuthApp } from './firebase-config.js';
import {
  AUTH_DIRECTORY_ROOT,
  AUTH_EMAIL_DOMAIN,
  loadAuthDirectoryEntry,
} from './auth-directory.js';
import {
  ADMINS_ROOT,
  loadAdminRegistryEntryOnce,
} from './admin-registry.js';

export const OPTION_CB_VERSION = 'option-c-b-1';

export const RESET_ALLOWED_PATH_KINDS = Object.freeze([
  'authDirectory',
  'players.authUid',
  'players.activeSession',
]);

const MAX_EMAIL_COLLISION_ATTEMPTS = 3;
const TOKEN_HEX_LEN = 12;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const SESSION_LS_KEY = 'scicards_session';

let _resetInFlight = false;

/** Avoid importing auth.js (circular). Session username is advisory for self-refuse. */
function _peekSessionUsername() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(SESSION_LS_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s?.username ? String(s.username).trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * @returns {boolean}
 */
export function isPasswordResetInFlight() {
  return _resetInFlight === true;
}

/**
 * @param {string} username
 * @returns {string}
 */
export function normalizeResetUsername(username) {
  return String(username || '').trim().toLowerCase();
}

/**
 * @param {number} oldGeneration
 * @returns {number}
 */
export function nextAuthDirectoryGeneration(oldGeneration) {
  const g = Number(oldGeneration);
  const base = Number.isFinite(g) && g >= 0 ? Math.floor(g) : 0;
  return base + 1;
}

/**
 * @param {number} [byteLength]
 * @returns {string} lowercase hex
 */
export function generateRotationTokenHex(byteLength = TOKEN_HEX_LEN / 2) {
  const n = Math.max(1, Math.floor(Number(byteLength) || 6));
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(n);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* fallback */ }
  let out = '';
  while (out.length < n * 2) {
    out += Math.random().toString(16).slice(2);
  }
  return out.slice(0, n * 2);
}

/**
 * @param {string} username
 * @param {number} generation
 * @param {string} tokenHex
 * @returns {string}
 */
export function buildRotatedLoginEmail(username, generation, tokenHex) {
  const u = normalizeResetUsername(username);
  const g = Number(generation);
  const tok = String(tokenHex || '').trim().toLowerCase();
  if (!USERNAME_RE.test(u)) {
    throw new Error('INVALID_USERNAME_FOR_EMAIL');
  }
  if (!Number.isFinite(g) || g < 1) {
    throw new Error('INVALID_GENERATION_FOR_EMAIL');
  }
  if (!/^[0-9a-f]+$/.test(tok) || tok.length !== TOKEN_HEX_LEN) {
    throw new Error('INVALID_TOKEN_FOR_EMAIL');
  }
  return `${u}.g${Math.floor(g)}.${tok}@${AUTH_EMAIL_DOMAIN}`;
}

/**
 * Mirror Auth registration password checks (js/auth.js register).
 * @param {string} password
 * @param {string} [confirmPassword]
 * @returns {{ ok: true } | { ok: false, code: string, error: string }}
 */
export function validateResetPasswordInput(password, confirmPassword) {
  if (!password || !String(password).trim()) {
    return { ok: false, code: 'PASSWORD_REQUIRED', error: 'Please enter a new password.' };
  }
  if (String(password).trim().length < 6) {
    return {
      ok: false,
      code: 'PASSWORD_TOO_SHORT',
      error: 'Password must be at least 6 characters when Firebase Auth is on.',
    };
  }
  if (confirmPassword !== undefined && confirmPassword !== null) {
    if (String(confirmPassword) !== String(password)) {
      return {
        ok: false,
        code: 'PASSWORD_CONFIRM_MISMATCH',
        error: 'Password confirmation does not match.',
      };
    }
  }
  return { ok: true };
}

/**
 * @param {string} path
 * @param {string} username
 * @returns {'authDirectory'|'players.authUid'|'players.activeSession'|null}
 */
export function classifyResetRebindPath(path, username) {
  const u = normalizeResetUsername(username);
  const p = String(path || '');
  if (p === `${AUTH_DIRECTORY_ROOT}/${u}`) return 'authDirectory';
  if (p === `players/${u}/authUid`) return 'players.authUid';
  if (p === `players/${u}/activeSession`) return 'players.activeSession';
  return null;
}

/**
 * @param {Record<string, unknown>} updates
 * @param {string} username
 * @returns {{ ok: true } | { ok: false, code: string, extraPaths?: string[] }}
 */
export function assertResetRebindPathInvariant(updates, username) {
  const u = normalizeResetUsername(username);
  const keys = Object.keys(updates || {});
  const seen = new Set();
  const extra = [];
  for (const path of keys) {
    const kind = classifyResetRebindPath(path, u);
    if (!kind) {
      extra.push(path);
      continue;
    }
    seen.add(kind);
  }
  if (extra.length) {
    return { ok: false, code: 'RESET_PATH_INVARIANT_EXTRA', extraPaths: extra };
  }
  for (const need of RESET_ALLOWED_PATH_KINDS) {
    if (!seen.has(need)) {
      return { ok: false, code: 'RESET_PATH_INVARIANT_MISSING', missing: need };
    }
  }
  if (keys.length !== 3) {
    return { ok: false, code: 'RESET_PATH_INVARIANT_COUNT', count: keys.length };
  }
  return { ok: true };
}

/**
 * Pure builder for rebind multipath.
 * @param {{
 *   username: string,
 *   newLoginEmail: string,
 *   newUid: string,
 *   newGeneration: number,
 * }} input
 */
export function buildIdentityRebindUpdates(input) {
  const u = normalizeResetUsername(input.username);
  const updates = {
    [`${AUTH_DIRECTORY_ROOT}/${u}`]: {
      loginEmail: String(input.newLoginEmail || '').trim().toLowerCase(),
      authUid: String(input.newUid || '').trim(),
      generation: Number(input.newGeneration),
    },
    [`players/${u}/authUid`]: String(input.newUid || '').trim(),
    [`players/${u}/activeSession`]: null,
  };
  const inv = assertResetRebindPathInvariant(updates, u);
  if (!inv.ok) {
    throw new Error(inv.code || 'RESET_PATH_INVARIANT');
  }
  return updates;
}

/**
 * Pure stale-binding decision after Auth create.
 * @param {{
 *   observedOldUid: string,
 *   observedGeneration: number,
 *   directoryAuthUid?: string|null,
 *   directoryGeneration?: number|null,
 *   playerAuthUid?: string|null,
 * }} input
 */
export function evaluateStaleBinding(input) {
  const oldUid = String(input.observedOldUid || '').trim();
  const oldGen = Number(input.observedGeneration);
  const dirUid = String(input.directoryAuthUid || '').trim();
  const dirGen = Number(input.directoryGeneration);
  const playerUid = String(input.playerAuthUid || '').trim();

  if (!oldUid || !Number.isFinite(oldGen) || oldGen < 0) {
    return { ok: false, code: 'STALE_BINDING', reason: 'INVALID_OBSERVED' };
  }
  if (!dirUid || dirUid !== oldUid) {
    return { ok: false, code: 'STALE_BINDING', reason: 'DIRECTORY_UID_CHANGED' };
  }
  if (!playerUid || playerUid !== oldUid) {
    return { ok: false, code: 'STALE_BINDING', reason: 'PLAYER_UID_CHANGED' };
  }
  if (!Number.isFinite(dirGen) || dirGen !== oldGen) {
    return { ok: false, code: 'STALE_BINDING', reason: 'GENERATION_CHANGED' };
  }
  return { ok: true };
}

/**
 * Authoritative precheck before secondary Auth create.
 * @param {{
 *   username: string,
 *   newPassword: string,
 *   confirmPassword?: string,
 *   teacherUsername?: string|null,
 * }} input
 */
export async function preparePasswordIdentityReset(input) {
  const pwCheck = validateResetPasswordInput(input.newPassword, input.confirmPassword);
  if (!pwCheck.ok) return pwCheck;

  const username = normalizeResetUsername(input.username);
  if (!username || !USERNAME_RE.test(username)) {
    return { ok: false, code: 'INVALID_USERNAME', error: 'Invalid username.' };
  }
  if (username === '__admin__') {
    return { ok: false, code: 'REFUSE_INFRA_USERNAME', error: 'Cannot reset infrastructure accounts.' };
  }

  let primaryAuth;
  try {
    primaryAuth = getAuth();
  } catch {
    return { ok: false, code: 'PRIMARY_AUTH_UNAVAILABLE', error: 'Firebase Auth is not ready.' };
  }
  const teacherUid = primaryAuth?.currentUser?.uid
    ? String(primaryAuth.currentUser.uid)
    : null;
  if (!teacherUid) {
    return { ok: false, code: 'TEACHER_NOT_SIGNED_IN', error: 'Teacher must be signed in.' };
  }

  const teacherAdmin = await loadAdminRegistryEntryOnce(teacherUid, { force: true });
  if (!teacherAdmin.ok || teacherAdmin.isAdmin !== true) {
    return { ok: false, code: 'TEACHER_NOT_ADMIN', error: 'Admin authority required.' };
  }

  const teacherUsername = normalizeResetUsername(
    input.teacherUsername != null ? input.teacherUsername : _peekSessionUsername(),
  );
  if (teacherUsername && teacherUsername === username) {
    return { ok: false, code: 'REFUSE_SELF', error: 'Cannot reset your own password here.' };
  }

  const playerLoad = await db.loadPathOnce(`players/${username}`, { force: true });
  if (!playerLoad || playerLoad.ok !== true) {
    return { ok: false, code: 'PLAYER_LOAD_FAILED', error: 'Could not load player.' };
  }
  const player = playerLoad.value;
  if (!player || typeof player !== 'object') {
    return { ok: false, code: 'PLAYER_MISSING', error: 'Player not found.' };
  }
  const playerAuthUid = typeof player.authUid === 'string' ? player.authUid.trim() : '';
  if (!playerAuthUid) {
    return { ok: false, code: 'PLAYER_AUTHUID_MISSING', error: 'Player has no authUid.' };
  }

  if (playerAuthUid === teacherUid) {
    return { ok: false, code: 'REFUSE_SELF', error: 'Cannot reset your own password here.' };
  }

  const dirLoad = await loadAuthDirectoryEntry(username, { force: true });
  if (!dirLoad.ok && !dirLoad.missing) {
    return { ok: false, code: 'AUTH_DIRECTORY_LOAD_FAILED', error: 'Could not load auth directory.' };
  }
  if (dirLoad.missing || !dirLoad.parsed) {
    return { ok: false, code: 'AUTH_DIRECTORY_MISSING', error: 'Auth directory entry missing.' };
  }
  if (dirLoad.parsed.authUid !== playerAuthUid) {
    return {
      ok: false,
      code: 'UID_MISMATCH',
      error: 'Player and auth directory identity binding mismatch.',
    };
  }
  const generation = dirLoad.parsed.generation;
  if (!Number.isFinite(generation) || generation < 0) {
    return { ok: false, code: 'INVALID_GENERATION', error: 'Invalid auth directory generation.' };
  }

  const targetAdmin = await loadAdminRegistryEntryOnce(playerAuthUid, { force: true });
  if (!targetAdmin.ok) {
    return { ok: false, code: 'TARGET_ADMIN_LOAD_FAILED', error: 'Could not verify target admin status.' };
  }
  if (targetAdmin.isAdmin === true) {
    return { ok: false, code: 'REFUSE_ADMIN_TARGET', error: 'Cannot reset Admin accounts.' };
  }

  return {
    ok: true,
    username,
    teacherUid,
    oldUid: playerAuthUid,
    oldGeneration: generation,
    oldLoginEmail: dirLoad.parsed.loginEmail,
  };
}

async function _bestEffortDeleteSecondaryUser(auth) {
  try {
    const u = auth?.currentUser;
    if (u && typeof u.delete === 'function') {
      await u.delete();
      return { ok: true };
    }
    return { ok: false, error: 'NO_SECONDARY_USER' };
  } catch (e) {
    return { ok: false, error: e?.code || e?.message || 'SECONDARY_DELETE_FAILED' };
  }
}

/**
 * Full Admin password reset via identity rotation.
 * @param {string} username
 * @param {string} newPassword
 * @param {{ confirmPassword?: string }} [options]
 */
export async function resetPasswordViaIdentityRotation(username, newPassword, options = {}) {
  if (_resetInFlight) {
    return {
      success: false,
      ok: false,
      code: 'RESET_IN_FLIGHT',
      error: 'A password reset is already in progress.',
    };
  }
  _resetInFlight = true;

  let secondary = null;
  let rebindSucceeded = false;

  try {
    const prepared = await preparePasswordIdentityReset({
      username,
      newPassword,
      confirmPassword: options.confirmPassword,
    });
    if (!prepared.ok) {
      return {
        success: false,
        ok: false,
        code: prepared.code,
        error: prepared.error || 'Reset precheck failed.',
      };
    }

    const {
      username: u,
      teacherUid,
      oldUid,
      oldGeneration,
    } = prepared;

    const newGeneration = nextAuthDirectoryGeneration(oldGeneration);
    secondary = createSecondaryAuthApp();
    if (!secondary.ok) {
      return {
        success: false,
        ok: false,
        code: 'SECONDARY_APP_FAILED',
        error: 'Could not start secure password reset.',
        detail: secondary.error,
      };
    }

    let newLoginEmail = null;
    let newUid = null;
    let lastCreateError = null;

    for (let attempt = 1; attempt <= MAX_EMAIL_COLLISION_ATTEMPTS; attempt += 1) {
      const token = generateRotationTokenHex();
      let email;
      try {
        email = buildRotatedLoginEmail(u, newGeneration, token);
      } catch (e) {
        return {
          success: false,
          ok: false,
          code: 'EMAIL_BUILD_FAILED',
          error: 'Could not build replacement login identity.',
        };
      }
      try {
        const cred = await secondary.auth.createUserWithEmailAndPassword(email, newPassword);
        newUid = cred?.user?.uid ? String(cred.user.uid) : null;
        newLoginEmail = email;
        lastCreateError = null;
        break;
      } catch (err) {
        lastCreateError = err;
        const code = err?.code || '';
        if (code === 'auth/email-already-in-use' && attempt < MAX_EMAIL_COLLISION_ATTEMPTS) {
          continue;
        }
        break;
      }
    }

    if (!newUid || !newLoginEmail) {
      const code = lastCreateError?.code || 'AUTH_CREATE_FAILED';
      return {
        success: false,
        ok: false,
        code: code === 'auth/email-already-in-use' ? 'EMAIL_COLLISION' : 'AUTH_CREATE_FAILED',
        error: 'Could not create replacement login identity.',
        detail: lastCreateError?.message || code,
      };
    }

    // Mandatory stale recheck
    const dirReload = await loadAuthDirectoryEntry(u, { force: true });
    const playerUidReload = await db.loadPathOnce(`players/${u}/authUid`, { force: true });
    const playerAuthUidNow = playerUidReload?.ok
      ? (typeof playerUidReload.value === 'string'
        ? playerUidReload.value.trim()
        : (db.get(`players/${u}/authUid`) != null ? String(db.get(`players/${u}/authUid`)).trim() : ''))
      : '';
    const dirUidNow = dirReload.ok && !dirReload.missing && dirReload.parsed
      ? dirReload.parsed.authUid
      : null;
    const dirGenNow = dirReload.ok && !dirReload.missing && dirReload.parsed
      ? dirReload.parsed.generation
      : null;

    const stale = evaluateStaleBinding({
      observedOldUid: oldUid,
      observedGeneration: oldGeneration,
      directoryAuthUid: dirUidNow,
      directoryGeneration: dirGenNow,
      playerAuthUid: playerAuthUidNow,
    });

    if (!stale.ok) {
      const del = await _bestEffortDeleteSecondaryUser(secondary.auth);
      return {
        success: false,
        ok: false,
        code: 'STALE_BINDING',
        error: 'Account changed during reset. No changes were applied. Try again.',
        reason: stale.reason,
        secondaryDeleted: del.ok === true,
      };
    }

    let updates;
    try {
      updates = buildIdentityRebindUpdates({
        username: u,
        newLoginEmail,
        newUid,
        newGeneration,
      });
    } catch (e) {
      const del = await _bestEffortDeleteSecondaryUser(secondary.auth);
      return {
        success: false,
        ok: false,
        code: 'REBIND_BUILD_FAILED',
        error: 'Could not build identity rebind.',
        secondaryDeleted: del.ok === true,
      };
    }

    const ack = await db.updateAcknowledged(updates);
    if (!ack.ok) {
      const del = await _bestEffortDeleteSecondaryUser(secondary.auth);
      return {
        success: false,
        ok: false,
        code: 'RESET_REBIND_FAILED',
        error: 'Could not update account login binding. Old password still applies.',
        detail: ack.error,
        secondaryDeleted: del.ok === true,
      };
    }

    rebindSucceeded = true;

    // Sanity: teacher primary unchanged
    try {
      const still = getAuth()?.currentUser?.uid;
      if (still && String(still) !== String(teacherUid)) {
        console.warn('[AuthRotation] Primary Auth uid changed unexpectedly during reset');
      }
    } catch { /* ignore */ }

    return {
      success: true,
      ok: true,
      code: 'OK',
      username: u,
      oldUid,
      newUid,
      oldGeneration,
      newGeneration,
      // loginEmail intentionally omitted from normal UI success
    };
  } catch (e) {
    if (!rebindSucceeded && secondary?.auth) {
      await _bestEffortDeleteSecondaryUser(secondary.auth);
    }
    return {
      success: false,
      ok: false,
      code: 'RESET_UNEXPECTED',
      error: 'Password reset failed unexpectedly.',
      detail: e?.message || String(e),
    };
  } finally {
    if (secondary?.ok || secondary?.app) {
      const disposed = await disposeSecondaryAuthApp(secondary);
      if (rebindSucceeded && disposed.ok === false) {
        console.warn('[AuthRotation] Secondary cleanup warning after successful rebind:', disposed);
      } else if (disposed.warnings?.length) {
        console.warn('[AuthRotation] Secondary cleanup warnings:', disposed.warnings);
      }
    }
    _resetInFlight = false;
  }
}

/**
 * Delete-player Option C precheck (authoritative).
 * @param {{
 *   username: string,
 *   teacherUsername?: string|null,
 *   teacherUid?: string|null,
 * }} input
 */
export async function preparePlayerDeleteLifecycle(input) {
  const username = normalizeResetUsername(input.username);
  if (!username || !USERNAME_RE.test(username)) {
    return { ok: false, code: 'INVALID_USERNAME', error: 'Invalid username.' };
  }
  if (username === '__admin__') {
    return { ok: false, code: 'REFUSE_INFRA_USERNAME', error: 'Cannot delete infrastructure accounts.' };
  }

  let teacherUid = input.teacherUid ? String(input.teacherUid).trim() : null;
  if (!teacherUid) {
    try {
      teacherUid = getAuth()?.currentUser?.uid ? String(getAuth().currentUser.uid) : null;
    } catch {
      teacherUid = null;
    }
  }
  if (!teacherUid) {
    return { ok: false, code: 'TEACHER_NOT_SIGNED_IN', error: 'Teacher must be signed in.' };
  }

  const teacherAdmin = await loadAdminRegistryEntryOnce(teacherUid, { force: true });
  if (!teacherAdmin.ok || teacherAdmin.isAdmin !== true) {
    return { ok: false, code: 'TEACHER_NOT_ADMIN', error: 'Admin authority required.' };
  }

  const teacherUsername = normalizeResetUsername(
    input.teacherUsername != null ? input.teacherUsername : _peekSessionUsername(),
  );
  if (teacherUsername && teacherUsername === username) {
    return { ok: false, code: 'REFUSE_SELF', error: 'Cannot delete your own account here.' };
  }

  const playerLoad = await db.loadPathOnce(`players/${username}`, { force: true });
  if (!playerLoad || playerLoad.ok !== true) {
    return { ok: false, code: 'PLAYER_LOAD_FAILED', error: 'Could not load player.' };
  }
  if (!playerLoad.value || typeof playerLoad.value !== 'object') {
    return { ok: false, code: 'PLAYER_MISSING', error: 'Player not found.' };
  }
  const playerAuthUid = typeof playerLoad.value.authUid === 'string'
    ? playerLoad.value.authUid.trim()
    : '';
  if (!playerAuthUid) {
    return { ok: false, code: 'PLAYER_AUTHUID_MISSING', error: 'Player has no authUid.' };
  }
  if (playerAuthUid === teacherUid) {
    return { ok: false, code: 'REFUSE_SELF', error: 'Cannot delete your own account here.' };
  }

  const dirLoad = await loadAuthDirectoryEntry(username, { force: true });
  if (!dirLoad.ok && !dirLoad.missing) {
    return { ok: false, code: 'AUTH_DIRECTORY_LOAD_FAILED', error: 'Could not load auth directory.' };
  }
  if (dirLoad.missing || !dirLoad.parsed) {
    return { ok: false, code: 'AUTH_DIRECTORY_MISSING', error: 'Auth directory entry missing.' };
  }
  if (dirLoad.parsed.authUid !== playerAuthUid) {
    return {
      ok: false,
      code: 'UID_MISMATCH',
      error: 'Identity binding mismatch — delete aborted.',
    };
  }

  const targetAdmin = await loadAdminRegistryEntryOnce(playerAuthUid, { force: true });
  if (!targetAdmin.ok) {
    return { ok: false, code: 'TARGET_ADMIN_LOAD_FAILED', error: 'Could not verify target admin status.' };
  }
  if (targetAdmin.isAdmin === true) {
    return { ok: false, code: 'REFUSE_ADMIN_TARGET', error: 'Cannot delete Admin accounts.' };
  }

  return {
    ok: true,
    username,
    oldUid: playerAuthUid,
    generation: dirLoad.parsed.generation,
    loginEmail: dirLoad.parsed.loginEmail,
    targetIsAdmin: false,
  };
}

/**
 * Multipath fragment: clear authDirectory (and admins only if explicitly requested).
 * v1 refuses Admin delete, so adminsClear is normally unused.
 * @param {{ username: string, oldUid?: string|null, clearAdminRegistry?: boolean }} input
 */
export function buildAuthLifecycleDeleteUpdates(input) {
  const u = normalizeResetUsername(input.username);
  /** @type {Record<string, null>} */
  const updates = {
    [`${AUTH_DIRECTORY_ROOT}/${u}`]: null,
  };
  if (input.clearAdminRegistry === true && input.oldUid) {
    updates[`${ADMINS_ROOT}/${String(input.oldUid).trim()}`] = null;
  }
  return updates;
}

/**
 * Path denylist helper for delete update maps (tests).
 * @param {Record<string, unknown>} updates
 * @returns {string[]}
 */
export function findForbiddenHistoricalDeletePaths(updates) {
  const bad = [];
  for (const path of Object.keys(updates || {})) {
    if (path.startsWith('leaderboardSeasons/') || path.startsWith('leaderboardSnapshots/')) {
      bad.push(path);
    }
  }
  return bad;
}

export function getOptionCbStatus() {
  return {
    optionCbVersion: OPTION_CB_VERSION,
    identityRotation: true,
    deleteUnbindsAuthDirectory: true,
    adminTargetRefuse: true,
    selfRefuse: true,
    sameUsernameReregisterGuaranteed: false,
    orphanAuthCleanupAutomated: false,
    midTradeGrantResidualAccepted: true,
    note:
      'C-b: Admin Reset Password = secondary Auth identity rotation + authDirectory/players.authUid rebind. '
      + 'Delete Player clears authDirectory; Auth orphans may remain. '
      + 'Same-username re-register may need developer Auth cleanup. '
      + 'Future orphan report is docs-only (not implemented).',
  };
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcAuth = {
    ...(window.qcAuth || {}),
    OPTION_CB_VERSION,
    getOptionCbStatus,
    resetPasswordViaIdentityRotation,
    preparePasswordIdentityReset,
    preparePlayerDeleteLifecycle,
    buildRotatedLoginEmail,
    nextAuthDirectoryGeneration,
    generateRotationTokenHex,
    validateResetPasswordInput,
    buildIdentityRebindUpdates,
    assertResetRebindPathInvariant,
    evaluateStaleBinding,
    buildAuthLifecycleDeleteUpdates,
    isPasswordResetInFlight,
    helpCb() {
      console.info(`Option C-b identity rotation
Freshness: qcAuth.getOptionCbStatus()
  → optionCbVersion === '${OPTION_CB_VERSION}'
  → identityRotation === true
  → deleteUnbindsAuthDirectory === true
C-a still: qcAuth.getOptionCaStatus() → strictDefault === true
Reset: Admin Players → Reset Password (secondary Auth; teacher session intact)
Delete: clears authDirectory; Auth orphan may remain; username reuse not guaranteed
Never uses primary getAuth() for replacement account create`);
    },
  };
}

_installWindowApi();
