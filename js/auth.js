/**
 * Auth Module - Username/Password Authentication via Firebase RTDB
 *
 * Production default: Firebase Auth (synthetic emails via authDirectory).
 * Option C-a.2: login/register/restore require authDirectory/{username} (strict default).
 * Developer emergency: qc_auth_directory_compat=true allows temporary gen0 fallback.
 * Emergency developer rollback: localStorage.qc_force_legacy_auth='true' → RTDB SHA-256
 * hashes at players/{username}.password (Auth-native accounts without a hash cannot log in).
 * Stale qc_firebase_auth is ignored and does not control mode.
 * Sessions persist via localStorage with a server-backed opaque session id
 * (players/{username}/activeSession). Only username === '__admin__' is exempt.
 *
 * Exported API:
 *   getSession()
 *   login(username, password)
 *   register(username, password, accessCode)
 *   adminLogin(password)
 *   logout()
 *   getLastPersonalCacheClearReport()  — S6b post-logout personal cache clear proof
 *   isAdmin()
 *   getCurrentUsername()
 *   generateAccessCodes(count, group)
 *   initAuth()  — async, restores session from localStorage
 *   ensureSessionGuard()
 *   consumePendingAuthMessage()
 */

import * as db from './database.js';
import * as config from './config.js';
import { getAuth } from './firebase-config.js';
import {
  ensureCurrentPlayerScope,
  ensurePlayerTradeIndexScope,
  hydrateCurrentPlayer,
  hydrateSharedDefs,
  releaseCurrentPlayerScope,
  releasePlayerTradeIndexScope,
  releaseLeaderboardsScope,
  subscribeCurrentPlayer,
  loadAccessCodeOnce,
} from './db-hydration.js';
import {
  buildDirectoryEntry,
  directoryPathsForPlayer,
  resolvePlayerDirectoryKey,
  syncDirectoryUpdateFromPlayer,
  DIRECTORY_ROOT,
} from './player-directory.js';
import { emptyPlayerTradeIndexPaths } from './trade-index.js';
import { syncProjects } from './project-sync.js';
import { getProjectConfig } from './project-config.js';
import { buildLeaderboardSummaryPathsForPlayer } from './leaderboard-summaries.js';
import * as cards from './cards.js';
import { getPhase2ADefaults, normalizePlayerSchema } from './player-schema.js';
import { resetLoginAchievementEvaluation, runLoginAchievementEvaluation } from './achievements.js';
import { ensurePlayerRPFields, ensurePlayerUniqueCardsOwned } from './research.js';
import { checkAndResetWeeklyCycle } from './weekly-research-pack.js';
import {
  isUidInAdminRegistry,
  loadAdminRegistryEntryOnce,
  buildAdminRegistryUpdates,
} from './admin-registry.js';
import {
  AUTH_DIRECTORY_ROOT,
  usernameToAuthEmail,
  resolveAuthLoginTarget,
  loadAuthDirectoryEntry,
  authDirectoryPathsForRegistration,
  allowMissingAuthDirectoryOnRestore,
} from './auth-directory.js';
import {
  resetPasswordViaIdentityRotation,
} from './auth-rotation.js';
import {
  isPlayerAdminLocked,
  MSG_ACCOUNT_TEMPORARILY_UNAVAILABLE,
  playerLockPath,
} from './player-lock.js';

export { usernameToAuthEmail, AUTH_DIRECTORY_ROOT };
export { MSG_ACCOUNT_TEMPORARILY_UNAVAILABLE };
const SESSION_KEY = 'scicards_session';
const AUTH_MESSAGE_KEY = 'scicards_auth_message';

const MSG_SESSION_ESTABLISH =
  'Could not establish a secure session. Check your connection and try again.';
const MSG_SESSION_INVALID =
  'Your saved session is no longer valid. Please sign in again.';
const MSG_SIGNED_IN_ELSEWHERE =
  'This account was signed in on another device.';

/** In-tab snapshot for cross-tab storage comparison (storage events update localStorage before the handler runs). */
let _localSessionSnapshot = null;

/** S6b: last personal-cache clear report (also mirrored to sessionStorage for post-reload proof). */
const S6B_CLEAR_REPORT_KEY = 'qc_s6b_personal_cache_clear';
const S6B_SHARED_PRESERVE_PATHS = Object.freeze([
  'config',
  'cards',
  'packs',
  'groups',
  'playerDirectory',
  'listingsByGroup',
  'tradeIndexMeta',
  'leaderboards',
  'leaderboardSeasons',
  'leaderboardSnapshots',
]);
/** @type {object|null} */
let _lastPersonalCacheClearReport = null;
let _unsubSessionGuard = null;
let _crossTabWatchInstalled = false;
let _exitingLocally = false;
/** After an acknowledged session claim, ignore brief stale root-listener snapshots. */
let _sessionGuardExpectedId = null;
let _sessionGuardGraceUntil = 0;

// ---------- Password Hashing ----------

/**
 * Hash a password using SHA-256 (Web Crypto API).
 * Returns a hex string. Async because SubtleCrypto is async.
 */
async function hashPassword(password) {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + '_scicards_salt_2024');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    // Fallback for environments without SubtleCrypto (shouldn't happen in browsers)
    console.warn('[Auth] crypto.subtle unavailable, using simple hash');
    return simpleHash(password);
  }
}

/** Simple fallback hash (not cryptographic, but better than plaintext) */
function simpleHash(str) {
  let hash = 0;
  const s = str + '_scicards_salt_2024';
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return 'sh_' + Math.abs(hash).toString(36);
}

// ---------- Session helpers ----------

/** Opaque random session id (16 bytes hex). */

// ---------- Firebase Auth (production default; emergency qc_force_legacy_auth) ----------

/** Developer-only emergency rollback to legacy RTDB hash auth. Students never set this. */
const FORCE_LEGACY_AUTH_LS_KEY = 'qc_force_legacy_auth';

/**
 * True when Firebase Auth is authoritative for student login/register/restore.
 * Production default: ON (fresh browser / no flag).
 * OFF only when localStorage.qc_force_legacy_auth === 'true'.
 * Stale qc_firebase_auth values are ignored.
 */
export function isFirebaseAuthEnabled() {
  try {
    return localStorage.getItem(FORCE_LEGACY_AUTH_LS_KEY) !== 'true';
  } catch {
    return true; // fail open to Auth if localStorage throws
  }
}

function waitForFirebaseAuthUser() {
  const auth = getAuth();
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return new Promise((resolve) => {
    const unsub = auth.onAuthStateChanged((user) => {
      unsub();
      resolve(user);
    });
  });
}

async function signOutFirebaseBestEffort() {
  try {
    const auth = getAuth();
    if (auth.currentUser) await auth.signOut();
  } catch (e) {
    console.warn('[Auth] Firebase signOut failed:', e?.message || e);
  }
}

function mapFirebaseAuthError(err) {
  const code = err && err.code ? String(err.code) : '';
  if (
    code === 'auth/user-not-found'
    || code === 'auth/wrong-password'
    || code === 'auth/invalid-credential'
    || code === 'auth/invalid-login-credentials'
  ) {
    return 'Incorrect username or password.';
  }
  if (code === 'auth/email-already-in-use') {
    return 'Username already taken.';
  }
  if (code === 'auth/weak-password') {
    return 'Password must be at least 6 characters when Firebase Auth is on.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Too many attempts. Please wait and try again.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Network error. Check your connection and try again.';
  }
  return (err && err.message) ? String(err.message) : 'Authentication failed.';
}

function generateSessionId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function rememberSessionSnapshot(session) {
  if (!session) {
    _localSessionSnapshot = null;
    return;
  }
  _localSessionSnapshot = {
    username: session.username || null,
    sessionId: session.sessionId || null
  };
}

function setPendingAuthMessage(message) {
  if (!message) return;
  try { sessionStorage.setItem(AUTH_MESSAGE_KEY, message); }
  catch { /* ignore */ }
}

/** Read and clear a one-shot message for the login screen. */
export function consumePendingAuthMessage() {
  try {
    const msg = sessionStorage.getItem(AUTH_MESSAGE_KEY);
    if (msg) sessionStorage.removeItem(AUTH_MESSAGE_KEY);
    return msg;
  } catch {
    return null;
  }
}

/** Get current session */
export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** Set session */
function setSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  rememberSessionSnapshot(session);
}

function clearLocalSessionOnly() {
  localStorage.removeItem(SESSION_KEY);
  rememberSessionSnapshot(null);
  resetLoginAchievementEvaluation();
}

function stopSessionGuard() {
  if (_unsubSessionGuard) {
    try { _unsubSessionGuard(); } catch { /* ignore */ }
    _unsubSessionGuard = null;
  }
  stopLockGuard();
}

/**
 * Release auth-owned gameplay scopes (player record + trade index).
 * Does not clear cache. Used on logout / force exit / __admin__ / failed establish.
 */
function releaseAuthOwnedScopes() {
  releasePlayerTradeIndexScope();
  releaseCurrentPlayerScope();
  releaseLeaderboardsScope();
}

/**
 * S6b: after scope release, clear personal cache roots (not shared indexes).
 * Captures a compact report at the clear boundary for verification before root refill/reload.
 * @param {'logout'|'forceLocalExit'|'crossTab'} reason
 * @returns {object}
 */
function clearPersonalCacheAfterScopeRelease(reason) {
  const beforePlayers = db.get('players');
  const beforePti = db.get('playerTradeIndex');
  const playerKeysBefore = beforePlayers && typeof beforePlayers === 'object'
    ? Object.keys(beforePlayers).filter((k) => k && k !== '__admin__')
    : [];
  const ptiKeysBefore = beforePti && typeof beforePti === 'object'
    ? Object.keys(beforePti).filter((k) => k && k !== '__admin__')
    : [];

  /** @type {Record<string, boolean>} */
  const sharedBefore = {};
  for (const path of S6B_SHARED_PRESERVE_PATHS) {
    sharedBefore[path] = db.get(path) != null;
  }

  const playersClear = db.clearCachedPath('players');
  const ptiClear = db.clearCachedPath('playerTradeIndex');

  const afterPlayers = db.get('players');
  const afterPti = db.get('playerTradeIndex');
  /** @type {Record<string, boolean>} */
  const sharedAfter = {};
  for (const path of S6B_SHARED_PRESERVE_PATHS) {
    sharedAfter[path] = db.get(path) != null;
  }

  const sharedScopesPreserved = S6B_SHARED_PRESERVE_PATHS.every(
    (path) => !sharedBefore[path] || sharedAfter[path] === true,
  );

  const report = {
    phase: 'S6b',
    reason: reason || 'unknown',
    timestamp: Date.now(),
    playersCleared: playersClear?.ok === true && afterPlayers == null,
    playerTradeIndexCleared: ptiClear?.ok === true && afterPti == null,
    sharedScopesPreserved,
    before: {
      playerKeyCount: playerKeysBefore.length,
      playerKeysSample: playerKeysBefore.slice(0, 8),
      ptiKeyCount: ptiKeysBefore.length,
      ptiKeysSample: ptiKeysBefore.slice(0, 8),
      sharedPresent: sharedBefore,
    },
    after: {
      playersNull: afterPlayers == null,
      playerTradeIndexNull: afterPti == null,
      sharedPresent: sharedAfter,
    },
    clearResults: {
      players: playersClear,
      playerTradeIndex: ptiClear,
    },
  };

  _lastPersonalCacheClearReport = report;
  try {
    sessionStorage.setItem(S6B_CLEAR_REPORT_KEY, JSON.stringify(report));
  } catch { /* ignore quota / private mode */ }

  console.info('[Auth S6b] Personal cache cleared', {
    reason: report.reason,
    playersCleared: report.playersCleared,
    playerTradeIndexCleared: report.playerTradeIndexCleared,
    sharedScopesPreserved: report.sharedScopesPreserved,
    playerKeyCountBefore: report.before.playerKeyCount,
    ptiKeyCountBefore: report.before.ptiKeyCount,
  });

  return report;
}

/**
 * Last S6b personal-cache clear report (in-memory, else sessionStorage for post-reload).
 * @returns {object|null}
 */
export function getLastPersonalCacheClearReport() {
  if (_lastPersonalCacheClearReport) return { ..._lastPersonalCacheClearReport };
  try {
    const raw = sessionStorage.getItem(S6B_CLEAR_REPORT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * After current-player scope is live: ensure playerTradeIndex/{me}.
 * Failure does not revoke login — Research fail-closes until retry/rebuild.
 * @param {string} username
 * @param {{ ackCacheFallback?: boolean }} [options]
 */
async function ensureAuthPlayerTradeIndex(username, options = {}) {
  if (!username || username === '__admin__') return { ok: false, skipped: true };
  try {
    const result = await ensurePlayerTradeIndexScope(username, options);
    if (!result.ok) {
      console.warn(
        '[Auth] Player trade-index scope failed — Research reservations fail-closed until retry/rebuild:',
        result.error,
      );
    }
    return result;
  } catch (e) {
    console.warn('[Auth] Player trade-index scope threw — Research fail-closed:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Force local exit without clearing the server session (already invalid or cleared elsewhere).
 * Releases auth-owned scoped subscriptions; never calls clearActiveSessionIfOwned.
 */
function forceLocalExit(message) {
  if (_exitingLocally) return;
  _exitingLocally = true;
  void signOutFirebaseBestEffort();
  stopSessionGuard();
  releaseAuthOwnedScopes();
  clearPersonalCacheAfterScopeRelease('forceLocalExit');
  clearLocalSessionOnly();
  // S7a: after session teardown, enforced persist uses null personal projection.
  db.persistLocalNow({ sessionUsername: null, reason: 'forceLocalExit-null-user' });
  if (message) setPendingAuthMessage(message);
  location.reload();
}

function armSessionGuardGrace(sessionId, ms = 4000) {
  _sessionGuardExpectedId = sessionId || null;
  _sessionGuardGraceUntil = sessionId ? Date.now() + ms : 0;
}

let _unsubLockGuard = null;

function stopLockGuard() {
  if (typeof _unsubLockGuard === 'function') {
    try { _unsubLockGuard(); } catch { /* ignore */ }
  }
  _unsubLockGuard = null;
}

/**
 * Secondary UX: exit when Admin locks this account. Security remains RTDB rules.
 */
function startLockGuard(username) {
  stopLockGuard();
  if (!username || username === '__admin__') return;
  const path = playerLockPath(username);
  _unsubLockGuard = db.onValue(path, (lockRow) => {
    if (_exitingLocally) return;
    const session = getSession();
    if (!session || session.username !== username || session.username === '__admin__') return;
    if (lockRow && lockRow.locked === true) {
      forceLocalExit(MSG_ACCOUNT_TEMPORARILY_UNAVAILABLE);
    }
  });
}

function startSessionGuard(username) {
  stopSessionGuard();
  stopLockGuard();
  if (!username || username === '__admin__') return;

  const path = `players/${username}/activeSession`;
  _unsubSessionGuard = db.onValue(path, (activeSession) => {
    if (_exitingLocally) return;
    const session = getSession();
    if (!session || session.username !== username || session.username === '__admin__') return;
    if (!session.sessionId) {
      forceLocalExit(MSG_SESSION_INVALID);
      return;
    }
    const serverId = activeSession && activeSession.id != null ? activeSession.id : null;
    if (serverId === session.sessionId) {
      if (_sessionGuardExpectedId === session.sessionId) {
        _sessionGuardExpectedId = null;
        _sessionGuardGraceUntil = 0;
      }
      return;
    }
    // Stale in-flight root/scoped snapshot can briefly disagree after an acknowledged claim.
    if (
      _sessionGuardExpectedId === session.sessionId &&
      Date.now() < _sessionGuardGraceUntil
    ) {
      return;
    }
    // Prefer lock message when Admin lock cleared the session in the same multipath.
    if (isPlayerAdminLocked(username)) {
      forceLocalExit(MSG_ACCOUNT_TEMPORARILY_UNAVAILABLE);
      return;
    }
    forceLocalExit(MSG_SIGNED_IN_ELSEWHERE);
  });
  startLockGuard(username);
}

/** Start or refresh the in-process session guard for the current session. */
export function ensureSessionGuard() {
  const session = getSession();
  if (!session || session.username === '__admin__') {
    stopSessionGuard();
    stopLockGuard();
    releaseAuthOwnedScopes();
    return;
  }
  if (!session.sessionId) return;
  startSessionGuard(session.username);
}

/**
 * Load lock leaf and refuse if Admin-locked (client UX; rules enforce writes).
 * @param {string} username
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function assertPlayerNotAdminLocked(username) {
  const key = String(username || '').trim();
  if (!key || key === '__admin__') return { ok: true };
  await db.loadPathOnce(playerLockPath(key), { force: true });
  if (isPlayerAdminLocked(key)) {
    return { ok: false, error: MSG_ACCOUNT_TEMPORARILY_UNAVAILABLE };
  }
  return { ok: true };
}

function setupCrossTabSessionWatch() {
  if (_crossTabWatchInstalled) return;
  _crossTabWatchInstalled = true;

  window.addEventListener('storage', (e) => {
    if (e.key !== SESSION_KEY) return;
    if (_exitingLocally) return;

    if (e.newValue == null) {
      if (_localSessionSnapshot) {
        stopSessionGuard();
        releaseAuthOwnedScopes();
        clearPersonalCacheAfterScopeRelease('crossTab');
        rememberSessionSnapshot(null);
        resetLoginAchievementEvaluation();
        // S7a: session already cleared in other tab; persist null personal projection.
        db.persistLocalNow({ sessionUsername: null, reason: 'crossTab-null-user' });
        location.reload();
      }
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(e.newValue);
    } catch {
      location.reload();
      return;
    }

    const prev = _localSessionSnapshot;
    if (!prev) {
      location.reload();
      return;
    }

    const nextUser = parsed.username || null;
    const nextId = parsed.sessionId || null;
    if (nextUser !== prev.username || nextId !== prev.sessionId) {
      // Do not adopt the new token in-tab — reload and let initAuth verify.
      location.reload();
    }
  });
}

/**
 * Explicit logout: stop in-process guard, ownership-checked clear of activeSession
 * (Firebase transaction — does not depend on the scoped player subscription), then
 * release current-player scope, S6b clear personal cache roots, and clear local session.
 * Forced remote logout must never call this clear path (see forceLocalExit).
 */
export async function logout() {
  stopSessionGuard();
  await signOutFirebaseBestEffort();
  const session = getSession();
  if (session && session.username && session.username !== '__admin__' && session.sessionId) {
    await db.clearActiveSessionIfOwned(session.username, session.sessionId);
  }
  releaseAuthOwnedScopes();
  clearPersonalCacheAfterScopeRelease('logout');
  clearLocalSessionOnly();
  // S7a: after personal clear + session teardown, enforced persist uses null personal projection.
  db.persistLocalNow({ sessionUsername: null, reason: 'logout-null-user' });
}

/**
 * S8c-0 admin check.
 *
 * Preferred authority: admins/{authUid} === true (Spark registry).
 *
 * Legacy fallbacks (PRE-S8c-1 ONLY — open rules; stop treating as security after rules lock):
 *   - session.isAdmin (includes __admin__ password login)
 *   - players/{u}.isAdmin UI mirror
 *
 * After S8c-1 RTDB rules deploy, only admins/{uid} grants write power; legacy flags
 * remain cosmetic until removed.
 */
export function isAdmin() {
  const session = getSession();
  if (!session) return false;

  const uid = _resolveSessionAuthUid(session);
  if (uid && isUidInAdminRegistry(uid)) return true;

  // Legacy fallbacks — transition only (not security after S8c-1)
  if (session.isAdmin === true) return true;
  if (session.username && session.username !== '__admin__') {
    const player = db.get(`players/${session.username}`);
    if (player && player.isAdmin === true) return true;
  }
  return false;
}

function _resolveSessionAuthUid(session) {
  if (session?.authUid) return String(session.authUid);
  try {
    const u = getAuth().currentUser;
    if (u?.uid) return u.uid;
  } catch { /* Auth not ready */ }
  if (session?.username && session.username !== '__admin__') {
    const player = db.get(`players/${session.username}`);
    if (player?.authUid) return String(player.authUid);
  }
  return null;
}

/** Best-effort hydrate admins/{uid} for the signed-in Auth user. */
async function _hydrateOwnAdminRegistry(session) {
  const uid = _resolveSessionAuthUid(session);
  if (!uid) return;
  await loadAdminRegistryEntryOnce(uid, { force: true });
  if (isUidInAdminRegistry(uid) && session && session.isAdmin !== true) {
    session.isAdmin = true;
    setSession(session);
  }
}

/** Get current username */
export function getCurrentUsername() {
  const session = getSession();
  return session ? session.username : null;
}

async function applyPostLoginPlayerMaintenance(username) {
  const playerKey = resolvePlayerDirectoryKey(username);
  const player = db.get(`players/${playerKey}`);
  if (!player) return;

  const defaults = {};
  if (player.projects === undefined || player.projects === null) defaults.projects = [];
  if (player.lastProjectRefreshAt === undefined) defaults.lastProjectRefreshAt = 0;
  if (player.totalResearchPoints === undefined) {
    defaults.totalResearchPoints = (typeof player.researchPoints === 'number' ? player.researchPoints : 0);
  }
  if (player.projectsCompleted === undefined) defaults.projectsCompleted = 0;
  if (player.seasonalResearchPoints === undefined) defaults.seasonalResearchPoints = 0;
  if (player.isAdmin === undefined) defaults.isAdmin = false;
  if (player.isTradeRestricted === undefined) defaults.isTradeRestricted = false;
  if (player.isTradeProfileHidden === undefined) defaults.isTradeProfileHidden = false;

  const flagDefaultsApplied =
    defaults.isAdmin !== undefined
    || defaults.isTradeRestricted !== undefined
    || defaults.isTradeProfileHidden !== undefined;

  const playerPatch = {
    lastLogin: Date.now(),
    ...defaults,
  };

  // When directory-relevant flags are first seeded, commit player leaves + directory
  // in one acknowledged multi-path update (no second fire-and-forget directory write).
  if (flagDefaultsApplied) {
    const updates = {};
    for (const [field, value] of Object.entries(playerPatch)) {
      updates[`players/${playerKey}/${field}`] = value;
    }
    Object.assign(
      updates,
      syncDirectoryUpdateFromPlayer(playerKey, { ...player, ...defaults }),
    );
    const ack = await db.updateAcknowledged(updates);
    if (!ack.ok) {
      console.warn('[Auth] Post-login player+directory sync failed:', ack.error);
    }
  } else {
    // lastLogin (+ non-directory defaults only) — player path only
    db.update(`players/${playerKey}`, playerPatch);
  }

  // Phase B: per-player backfill that used to run via startup migrateAll* bulk passes.
  // Order: RP + uniqueCardsOwned before normalize (normalize seeds uniqueCardsOwned to 0).
  ensurePlayerRPFields(playerKey);
  ensurePlayerUniqueCardsOwned(playerKey);
  checkAndResetWeeklyCycle(playerKey);

  // Path-specific child writes only — must not clobber activeSession.
  normalizePlayerSchema(playerKey);
  runLoginAchievementEvaluation(playerKey);

  const freshPlayer = db.get(`players/${playerKey}`);
  const prevRefreshAt = freshPlayer.lastProjectRefreshAt ?? 0;
  const syncResult = syncProjects({
    projects:      freshPlayer.projects      ?? [],
    totalRP:       freshPlayer.totalResearchPoints ?? 0,
    lastRefreshAt: prevRefreshAt,
    now:           Date.now(),
  });
  // Match project-ui heartbeat: persist only when sync changed something
  // (including refreshAt advances when the pool is full).
  if (
    syncResult.generatedCount > 0 ||
    syncResult.resolvedCount > 0 ||
    syncResult.prunedCount > 0 ||
    syncResult.refreshAt !== prevRefreshAt
  ) {
    db.update(`players/${playerKey}`, {
      projects:             syncResult.projects,
      lastProjectRefreshAt: syncResult.refreshAt,
    });
  }
  console.log(`[ResearchProjects] Sync complete — generated:${syncResult.generatedCount} resolved:${syncResult.resolvedCount} pruned:${syncResult.prunedCount}`);
}

// ---------- Auth init (session restore) ----------

/**
 * Initialize auth. Restores session from localStorage.
 * S3 restore order: hydrate players/{u} → verify exact activeSession token match
 * → subscribe → guard → maintenance. Grace must not mask an invalid saved session.
 */
export async function initAuth() {
  setupCrossTabSessionWatch();

  const session = getSession();
  rememberSessionSnapshot(session);

  if (!session) {
    console.log('[Auth] No existing session');
    return;
  }

  // Only username === '__admin__' is exempt from activeSession enforcement.
  if (session.isAdmin && session.username === '__admin__') {
    releaseAuthOwnedScopes();
    console.log('[Auth] Admin session restored');
    return;
  }

  if (!session.username) {
    clearLocalSessionOnly();
    return;
  }

  // No legacy compatibility — sessionId required.
  if (!session.sessionId) {
    console.warn('[Auth] Stale session cleared (missing sessionId)');
    clearLocalSessionOnly();
    setPendingAuthMessage(MSG_SESSION_INVALID);
    return;
  }

  if (isFirebaseAuthEnabled()) {
    const fbUser = await waitForFirebaseAuthUser();
    if (!fbUser) {
      console.warn('[Auth] Stale session cleared (Firebase Auth user missing)');
      await signOutFirebaseBestEffort();
      releaseAuthOwnedScopes();
      clearLocalSessionOnly();
      setPendingAuthMessage(MSG_SESSION_INVALID);
      return;
    }

    const dirLoad = await loadAuthDirectoryEntry(session.username, { force: true });
    if (dirLoad.ok && !dirLoad.missing && dirLoad.parsed) {
      const expectedUid = dirLoad.parsed.authUid;
      if (String(fbUser.uid) !== String(expectedUid)) {
        console.warn('[Auth] Stale session cleared (authDirectory uid mismatch)');
        await signOutFirebaseBestEffort();
        releaseAuthOwnedScopes();
        clearLocalSessionOnly();
        setPendingAuthMessage(MSG_SESSION_INVALID);
        return;
      }
      const dirEmail = String(dirLoad.parsed.loginEmail || '').toLowerCase();
      const fbEmail = String(fbUser.email || '').toLowerCase();
      if (dirEmail && fbEmail && dirEmail !== fbEmail) {
        console.warn('[Auth] Stale session cleared (authDirectory email mismatch)');
        await signOutFirebaseBestEffort();
        releaseAuthOwnedScopes();
        clearLocalSessionOnly();
        setPendingAuthMessage(MSG_SESSION_INVALID);
        return;
      }
    } else if (dirLoad.missing || (dirLoad.ok && !dirLoad.parsed)) {
      // C-a.2: missing authDirectory fails closed unless developer compat escape
      if (!allowMissingAuthDirectoryOnRestore()) {
        console.warn('[Auth] Stale session cleared (authDirectory missing, strict default)');
        await signOutFirebaseBestEffort();
        releaseAuthOwnedScopes();
        clearLocalSessionOnly();
        setPendingAuthMessage(MSG_SESSION_INVALID);
        return;
      }
      const expectedEmail = usernameToAuthEmail(session.username);
      if (String(fbUser.email || '').toLowerCase() !== expectedEmail) {
        console.warn('[Auth] Stale session cleared (gen0 compat email mismatch)');
        await signOutFirebaseBestEffort();
        releaseAuthOwnedScopes();
        clearLocalSessionOnly();
        setPendingAuthMessage(MSG_SESSION_INVALID);
        return;
      }
    } else {
      console.warn('[Auth] Stale session cleared (authDirectory load failed)', dirLoad.error);
      await signOutFirebaseBestEffort();
      releaseAuthOwnedScopes();
      clearLocalSessionOnly();
      setPendingAuthMessage(MSG_SESSION_INVALID);
      return;
    }
  }

  const hydrated = await hydrateCurrentPlayer(session.username);
  if (!hydrated.ok) {
    console.warn('[Auth] Stale session cleared (current-player hydrate failed)', hydrated.error);
    releaseAuthOwnedScopes();
    clearLocalSessionOnly();
    setPendingAuthMessage(MSG_SESSION_INVALID);
    return;
  }

  const player = db.get(`players/${session.username}`);
  if (!player) {
    console.warn('[Auth] Stale session cleared (player not found)');
    releaseAuthOwnedScopes();
    clearLocalSessionOnly();
    setPendingAuthMessage(MSG_SESSION_INVALID);
    return;
  }

  const lockGate = await assertPlayerNotAdminLocked(session.username);
  if (!lockGate.ok) {
    console.warn('[Auth] Session blocked (account admin-locked)');
    await signOutFirebaseBestEffort();
    releaseAuthOwnedScopes();
    clearLocalSessionOnly();
    setPendingAuthMessage(lockGate.error);
    return;
  }

  const activeSession = db.get(`players/${session.username}/activeSession`);
  const serverId = activeSession && activeSession.id != null ? activeSession.id : null;
  // Exact match only — no grace window on restore.
  if (serverId !== session.sessionId) {
    console.warn('[Auth] Stale session cleared (session id mismatch)');
    releaseAuthOwnedScopes();
    clearLocalSessionOnly();
    setPendingAuthMessage(MSG_SESSION_INVALID);
    return;
  }

  const sub = subscribeCurrentPlayer(session.username);
  if (!sub.ok) {
    console.warn('[Auth] Stale session cleared (current-player subscribe failed)', sub.error);
    releaseAuthOwnedScopes();
    clearLocalSessionOnly();
    setPendingAuthMessage(MSG_SESSION_INVALID);
    return;
  }

  await ensureAuthPlayerTradeIndex(session.username);

  startSessionGuard(session.username);
  await applyPostLoginPlayerMaintenance(session.username);
  await _hydrateOwnAdminRegistry(session);
  try {
    await hydrateSharedDefs({ force: false });
  } catch (e) {
    console.warn('[Auth] sharedDefs hydrate on session restore:', e?.message || e);
  }
  console.log(`[Auth] Session restored for: ${session.username}`);
}

async function rollbackFirebaseAuthUser(reason) {
  try {
    const u = getAuth().currentUser;
    if (u) await u.delete();
  } catch (delErr) {
    console.warn('[Auth] Rollback Auth user delete failed:', reason, delErr?.message || delErr);
  }
  await signOutFirebaseBestEffort();
}

// ---------- Login ----------

/**
 * Login with username + password
 * Returns { success, error?, session? }
 *
 * Auth-on (S8c): Firebase sign-in first, then load players/{u} (bound read).
 * Legacy: once-load players/{username} before password hash check.
 */
export async function login(username, password) {
  if (!username || !username.trim()) {
    return { success: false, error: 'Please enter a username.' };
  }
  if (!password || !password.trim()) {
    return { success: false, error: 'Please enter a password.' };
  }

  username = username.trim().toLowerCase();

  if (!config.isGameOpen()) {
    return { success: false, error: 'The game is currently closed.' };
  }

  const useFirebase = isFirebaseAuthEnabled();
  let player = null;

  if (useFirebase) {
    const target = await resolveAuthLoginTarget(username);
    if (!target.ok) {
      return { success: false, error: target.error || 'Could not resolve account login.' };
    }

    try {
      await getAuth().signInWithEmailAndPassword(target.loginEmail, password);
    } catch (err) {
      return { success: false, error: mapFirebaseAuthError(err) };
    }

    const fbUid = getAuth().currentUser?.uid;
    if (!fbUid) {
      await signOutFirebaseBestEffort();
      return { success: false, error: 'Could not verify account. Please try again.' };
    }

    // Shared defs need Auth; load after sign-in (cards/config for post-login gameplay).
    try {
      await hydrateSharedDefs({ force: false });
    } catch (e) {
      console.warn('[Auth] sharedDefs hydrate after login:', e?.message || e);
    }

    const preLoad = await db.loadPathOnce(`players/${username}`, { force: true });
    if (!preLoad.ok) {
      await signOutFirebaseBestEffort();
      return { success: false, error: 'Could not verify account. Please try again.' };
    }
    player = db.get(`players/${username}`);
    if (!player) {
      await signOutFirebaseBestEffort();
      return { success: false, error: 'Account not found. Please register first.' };
    }

    // Binding check: authDirectory.authUid (required under C-a.2) or players.authUid (compat only)
    const expectedUid = target.expectedAuthUid
      || (typeof player.authUid === 'string' ? player.authUid : null);
    if (!expectedUid || String(fbUid) !== String(expectedUid)) {
      console.warn('[Auth] Login aborted: Auth uid binding mismatch', {
        source: target.source,
        fbUid,
        expectedUid,
      });
      await signOutFirebaseBestEffort();
      return {
        success: false,
        error: 'Account identity binding mismatch. Ask a teacher for help.',
      };
    }
    if (
      typeof player.authUid === 'string'
      && player.authUid
      && String(player.authUid) !== String(fbUid)
    ) {
      await signOutFirebaseBestEffort();
      return {
        success: false,
        error: 'Account identity binding mismatch. Ask a teacher for help.',
      };
    }
  } else {
    // Legacy: ID-specific once-load only — do not use hydrateCurrentPlayer here.
    const preLoad = await db.loadPathOnce(`players/${username}`, { force: true });
    if (!preLoad.ok) {
      return { success: false, error: 'Could not verify account. Please try again.' };
    }
    player = db.get(`players/${username}`);
    if (!player) {
      return { success: false, error: 'Account not found. Please register first.' };
    }
    const hashedInput = await hashPassword(password);
    if (player.password !== hashedInput) {
      return { success: false, error: 'Incorrect password.' };
    }
  }

  }

  const lockGate = await assertPlayerNotAdminLocked(username);
  if (!lockGate.ok) {
    if (useFirebase) await signOutFirebaseBestEffort();
    return { success: false, error: lockGate.error };
  }

  const sessionId = generateSessionId();
  const issuedAt = Date.now();
  const ack = await db.setAcknowledged(`players/${username}/activeSession`, {
    id: sessionId,
    issuedAt
  });
  if (!ack.ok) {
    if (useFirebase) await signOutFirebaseBestEffort();
    return { success: false, error: MSG_SESSION_ESTABLISH };
  }

  // Cache patched by setAcknowledged — set local session, arm grace, then
  // scoped hydrate+subscribe before starting the in-process guard.
  const session = {
    username,
    isAdmin: player.isAdmin === true,
    loginTime: issuedAt,
    sessionId,
    authUid: (useFirebase && getAuth().currentUser)
      ? getAuth().currentUser.uid
      : (player.authUid || null),
  };
  setSession(session);
  armSessionGuardGrace(sessionId);

  const scoped = await ensureCurrentPlayerScope(username);
  if (!scoped.ok) {
    console.warn('[Auth] Current-player scope failed after login claim', scoped.error);
    releaseAuthOwnedScopes();
    // Do not clear server activeSession we just claimed — next login replaces it.
    clearLocalSessionOnly();
    if (useFirebase) await signOutFirebaseBestEffort();
    return { success: false, error: MSG_SESSION_ESTABLISH };
  }

  await ensureAuthPlayerTradeIndex(username);

  startSessionGuard(username);
  await applyPostLoginPlayerMaintenance(username);
  await _hydrateOwnAdminRegistry(session);

  return { success: true, session: getSession() || session };
}

export async function register(username, password, accessCode) {
  if (!username || !username.trim()) {
    return { success: false, error: 'Please enter a username.' };
  }
  if (!password || !password.trim()) {
    return { success: false, error: 'Please enter a password.' };
  }
  if (password.trim().length < 4) {
    return { success: false, error: 'Password must be at least 4 characters.' };
  }
  if (isFirebaseAuthEnabled() && password.trim().length < 6) {
    return { success: false, error: 'Password must be at least 6 characters when Firebase Auth is on.' };
  }
  if (!accessCode || !accessCode.trim()) {
    return { success: false, error: 'Please enter an access code.' };
  }

  username = username.trim().toLowerCase();
  accessCode = accessCode.trim().toUpperCase();

  if (!config.isGameOpen()) {
    return { success: false, error: 'The game is currently closed.' };
  }

  if (!config.isRegistrationOpen()) {
    return { success: false, error: 'Registration is currently closed.' };
  }

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return { success: false, error: 'Username must be 3-20 characters, letters/numbers/underscore only.' };
  }

  const useFirebase = isFirebaseAuthEnabled();
  let authUid = null;

  // S8c Auth-on: create Auth identity first so directory/authUid/accessCodes reads are allowed.
  if (useFirebase) {
    try {
      const cred = await getAuth().createUserWithEmailAndPassword(
        usernameToAuthEmail(username),
        password,
      );
      authUid = cred.user.uid;
      try {
        await cred.user.updateProfile({ displayName: username });
      } catch (profileErr) {
        console.warn('[Auth] updateProfile failed:', profileErr?.message || profileErr);
      }
    } catch (err) {
      return { success: false, error: mapFirebaseAuthError(err) };
    }

    // Need cards for starter inventory; shared defs require Auth.
    try {
      await hydrateSharedDefs({ force: false });
    } catch (e) {
      console.warn('[Auth] sharedDefs hydrate after register Auth:', e?.message || e);
    }
  }

  // Username taken checks (Auth-on: after Auth; legacy: pre-Auth open rules / local).
  const dirPath = `${DIRECTORY_ROOT}/${username}`;
  const dirLoad = await db.loadPathOnce(dirPath, { force: true });
  if (!dirLoad.ok) {
    if (useFirebase) await rollbackFirebaseAuthUser('directory-load');
    return { success: false, error: 'Could not verify username availability. Please try again.' };
  }
  if (db.get(dirPath)) {
    if (useFirebase) await rollbackFirebaseAuthUser('directory-taken');
    return { success: false, error: 'Username already taken.' };
  }
  const authUidLeaf = await db.loadPathOnce(`players/${username}/authUid`, { force: true });
  if (!authUidLeaf.ok) {
    if (useFirebase) await rollbackFirebaseAuthUser('authUid-load');
    return { success: false, error: 'Could not verify username availability. Please try again.' };
  }
  const existingUid = db.get(`players/${username}/authUid`);
  if (existingUid != null && existingUid !== '') {
    if (useFirebase) await rollbackFirebaseAuthUser('authUid-taken');
    return { success: false, error: 'Username already taken.' };
  }
  if (useFirebase) {
    const authDirLoad = await loadAuthDirectoryEntry(username, { force: true });
    if (!authDirLoad.ok && !authDirLoad.missing) {
      await rollbackFirebaseAuthUser('authDirectory-load');
      return { success: false, error: 'Could not verify username availability. Please try again.' };
    }
    if (authDirLoad.ok && !authDirLoad.missing) {
      await rollbackFirebaseAuthUser('authDirectory-taken');
      return { success: false, error: 'Username already taken.' };
    }
  }

  // S6a: scoped once-load of this code leaf only (not all accessCodes; no subscribe).
  const codeLoad = await loadAccessCodeOnce(accessCode);
  if (!codeLoad.ok) {
    if (useFirebase) await rollbackFirebaseAuthUser('access-code-load');
    return {
      success: false,
      error: 'Could not verify access code. Please try again.',
    };
  }

  const codeData = db.get(`accessCodes/${accessCode}`);
  if (!codeData || typeof codeData !== 'object') {
    if (useFirebase) await rollbackFirebaseAuthUser('access-code-invalid');
    return { success: false, error: 'Invalid access code.' };
  }
  if (codeData.used) {
    if (useFirebase) await rollbackFirebaseAuthUser('access-code-used');
    return { success: false, error: 'This access code has already been used.' };
  }

  const hashedPassword = useFirebase ? null : await hashPassword(password);
  const sessionId = generateSessionId();
  const issuedAt = Date.now();

  const playerRecord = buildPlayerRecord(username, hashedPassword, codeData.group || null);
  if (useFirebase) {
    delete playerRecord.password;
    playerRecord.authUid = authUid;
  }
  playerRecord.activeSession = { id: sessionId, issuedAt };

  // Embed starter projects in the same atomic player write.
  const regSyncResult = syncProjects({
    projects:      playerRecord.projects      ?? [],
    totalRP:       playerRecord.totalResearchPoints ?? 0,
    lastRefreshAt: playerRecord.lastProjectRefreshAt ?? 0,
    now:           issuedAt,
  });
  playerRecord.projects = regSyncResult.projects;
  playerRecord.lastProjectRefreshAt = regSyncResult.refreshAt;

  const ack = await db.updateAcknowledged({
    [`players/${username}`]: playerRecord,
    // Single-path access-code consume (not leaf multipath): $code rules need used+usedBy
    // together in newData; sibling leaf updates are not visible to each other.
    [`accessCodes/${accessCode}`]: {
      ...codeData,
      used: true,
      usedBy: username,
      usedAt: issuedAt,
    },
    ...directoryPathsForPlayer(username, buildDirectoryEntry(username, playerRecord)),
    ...emptyPlayerTradeIndexPaths(username),
    ...buildLeaderboardSummaryPathsForPlayer(username, playerRecord, { now: issuedAt }),
    ...(useFirebase && authUid
      ? authDirectoryPathsForRegistration(username, authUid)
      : {}),
  });

  if (!ack.ok) {
    if (useFirebase) {
      await rollbackFirebaseAuthUser('rtdb-multipath');
    }
    return { success: false, error: MSG_SESSION_ESTABLISH };
  }

  console.log(`[ResearchProjects] New account sync — generated:${regSyncResult.generatedCount}`);
  console.log(`[Auth] New player created: ${username}${useFirebase ? ' (Firebase Auth)' : ' (legacy hash)'}`);

  const session = {
    username,
    isAdmin: false,
    isTradeRestricted: false,
    loginTime: issuedAt,
    sessionId,
    authUid: authUid || null,
  };
  setSession(session);
  armSessionGuardGrace(sessionId);

  // Account + access code already committed. If the redundant scoped once-load fails,
  // ackCacheFallback continues with ack-patched cache + subscribe — never re-register.
  const scoped = await ensureCurrentPlayerScope(username, { ackCacheFallback: true });
  if (!scoped.ok) {
    console.warn('[Auth] Current-player scope failed after registration', scoped.error);
    if (db.get(`players/${username}`)) {
      const sub = subscribeCurrentPlayer(username);
      if (sub.ok) {
        await ensureAuthPlayerTradeIndex(username, { ackCacheFallback: true });
        startSessionGuard(username);
        return { success: true, session, scopedWarning: scoped.error };
      }
    }
    releaseAuthOwnedScopes();
    clearLocalSessionOnly();
    if (useFirebase) await signOutFirebaseBestEffort();
    return {
      success: false,
      error: 'Account was created but profile hydration failed. Please sign in.',
    };
  }

  await ensureAuthPlayerTradeIndex(username, { ackCacheFallback: true });

  startSessionGuard(username);

  return { success: true, session };
}


function sampleWithoutReplacement(pool, count) {
  if (!pool || pool.length === 0 || count <= 0) return [];
  const copy = [...pool];
  const n = Math.min(count, copy.length);
  const result = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

/**
 * Build the starter inventory object for a new player.
 * Returns { inventory, cardsGrantedCount }
 */
function buildStarterInventory(pCfg) {
  const inventory = {};
  let cardsGrantedCount = 0;

  const scientistCount = typeof pCfg.starterScientistCount === 'number' ? pCfg.starterScientistCount : 5;
  if (scientistCount > 0) {
    const pool = cards.getAllCards().filter(
      c => c.enabled !== false && c.type === 'scientist' && c.rarity === 'common'
    );
    const chosen = sampleWithoutReplacement(pool, scientistCount);
    for (const card of chosen) {
      inventory[card.id] = (inventory[card.id] || 0) + 1;
      cardsGrantedCount++;
    }
    console.log(`[Auth] Starter scientists granted: ${chosen.length} (requested: ${scientistCount}, pool: ${pool.length})`);
  }

  const conceptCount = typeof pCfg.starterConceptCount === 'number' ? pCfg.starterConceptCount : 2;
  let conceptPool = pCfg.starterConceptPool;
  if (conceptPool && typeof conceptPool === 'object' && !Array.isArray(conceptPool)) {
    conceptPool = Object.values(conceptPool);
  }
  if (!Array.isArray(conceptPool)) conceptPool = ['synergyBoost', 'breakthrough'];

  if (conceptCount > 0 && conceptPool.length > 0) {
    const eligibleByType = {};
    for (const ct of conceptPool) {
      const typeCards = cards.getAllCards().filter(
        c => c.enabled !== false && c.type === 'concept' && c.rarity === 'common' && c.conceptType === ct
      );
      if (typeCards.length > 0) eligibleByType[ct] = typeCards;
    }

    const eligibleTypes = Object.keys(eligibleByType);
    const selectedTypes = sampleWithoutReplacement(eligibleTypes, conceptCount);

    for (const ct of selectedTypes) {
      const typePool = eligibleByType[ct];
      const card = typePool[Math.floor(Math.random() * typePool.length)];
      inventory[card.id] = (inventory[card.id] || 0) + 1;
      cardsGrantedCount++;
    }
    console.log(`[Auth] Starter concepts granted: ${selectedTypes.length} (requested: ${conceptCount}, eligible types: ${eligibleTypes.length})`);
  }

  return { inventory, cardsGrantedCount };
}

/**
 * Build a new player record (does not write). Caller commits via updateAcknowledged.
 */
function buildPlayerRecord(username, hashedPassword, group) {
  const pCfg = getProjectConfig();

  let starterPacks = {};
  const starterPackId  = (pCfg.starterPackId  || '').trim();
  const starterPackQty = typeof pCfg.starterPackQuantity === 'number' ? pCfg.starterPackQuantity : 1;
  if (starterPackId && starterPackQty > 0) {
    starterPacks[starterPackId] = starterPackQty;
  }

  const { inventory: starterInventory, cardsGrantedCount } = buildStarterInventory(pCfg);

  return {
    username,
    password: hashedPassword,
    createdAt: Date.now(),
    lastLogin: Date.now(),
    isAdmin: false,
    group: group || null,
    subgroup: null,
    inventory: starterInventory,
    packs: starterPacks,
    stats: {
      packsOpened: 0,
      cardsCollected: cardsGrantedCount,
      tradesCompleted: 0,
      projectsCompleted: 0
    },
    badges: {},
    achievements: {},
    progression: {
      tutorialComplete: false,
      firstPackOpened: false,
      firstTrade: false,
      starterPacksGranted:     true,
      starterScientistsGranted: true,
      starterConceptsGranted:   true,
    },
    projects: [],
    lastProjectRefreshAt: 0,
    totalResearchPoints: 0,
    projectsCompleted: 0,
    researchStats: {
      totalProjects: 0,
      successfulProjects: 0,
      failedProjects: 0,
      breakthroughs: 0,
      highestTierCompleted: null
    },
    seasonalResearchPoints: 0,
    isTradeRestricted: false,
    isTradeProfileHidden: (config.getValue('trading.defaultHiddenProfile') === true),
    starterPacksGranted: true,
    ...getPhase2ADefaults(),
  };
}

// ---------- Admin Login ----------

/**
 * Admin login with password
 * Returns { success, error?, session? }
 *
 * Phase 5A: If a player is currently logged in, permanently sets isAdmin=true
 * on their player profile (persists across sessions). Otherwise falls back
 * to the standalone __admin__ session (only account exempt from activeSession).
 */
export async function adminLogin(password) {
  const adminPw = config.getValue('adminPassword');
  if (password !== adminPw) {
    return { success: false, error: 'Incorrect admin password.' };
  }

  const existing = getSession();
  if (existing && existing.username && existing.username !== '__admin__') {
    const playerKey = resolvePlayerDirectoryKey(existing.username);
    const playerData = db.get(`players/${playerKey}`);
    if (playerData) {
      const targetUid = playerData.authUid
        || existing.authUid
        || (isFirebaseAuthEnabled() ? getAuth().currentUser?.uid : null)
        || null;
      const updates = {
        [`players/${playerKey}/isAdmin`]: true,
        ...syncDirectoryUpdateFromPlayer(playerKey, { ...playerData, isAdmin: true }),
        ...(targetUid ? buildAdminRegistryUpdates(String(targetUid), true) : {}),
      };
      const ack = await db.updateAcknowledged(updates);
      if (!ack.ok) {
        return { success: false, error: ack.error || 'Could not promote player to admin.' };
      }
      if (targetUid) {
        await loadAdminRegistryEntryOnce(String(targetUid), { force: true });
      }
      existing.isAdmin = true;
      if (targetUid) existing.authUid = String(targetUid);
      setSession(existing);
      console.log(`[Auth] Player permanently promoted to admin: ${playerKey}`
        + (targetUid ? ` (admins/${targetUid})` : ' (no authUid — registry not written)'));
      return { success: true, session: existing };
    }
  }

  stopSessionGuard();
  releaseAuthOwnedScopes();
  const session = { username: '__admin__', isAdmin: true, loginTime: Date.now() };
  setSession(session);
  return { success: true, session };
}

// ---------- Admin Password Reset ----------

/**
 * Reset a player's password (admin tool).
 * When Firebase Auth is authoritative, RTDB hash reset is disabled — use the trusted Admin script.
 * @param {string} username
 * @param {string} newPassword
 * @returns {{ success: boolean, error?: string }}
 */
export async function resetPlayerPassword(username, newPassword, options = {}) {
  if (isFirebaseAuthEnabled()) {
    return resetPasswordViaIdentityRotation(username, newPassword, {
      confirmPassword: options.confirmPassword,
    });
  }

  if (!username || !username.trim()) {
    return { success: false, error: 'No username provided.' };
  }
  if (!newPassword || !newPassword.trim()) {
    return { success: false, error: 'Please enter a new password.' };
  }
  if (newPassword.trim().length < 4) {
    return { success: false, error: 'Password must be at least 4 characters.' };
  }

  const playerRecord = db.get(`players/${username}`);
  if (!playerRecord) {
    return { success: false, error: `Player "${username}" not found.` };
  }

  const hashed = await hashPassword(newPassword.trim());
  db.update(`players/${username}`, { password: hashed });
  console.log(`[Auth] Password reset for player: ${username}`);
  return { success: true };
}

export function generateAccessCodes(count, group = null) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = generateCode();
    db.set(`accessCodes/${code}`, {
      created: Date.now(),
      used: false,
      usedBy: null,
      usedAt: null,
      group: group || null
    });
    codes.push(code);
  }
  return codes;
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I/O/0/1 to avoid confusion
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function _installAuthWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcAuthS6b = {
    getLastPersonalCacheClearReport,
    help() {
      console.info(`Auth S6b personal cache clear
After logout / forceLocalExit / crossTab session wipe:
  clearCachedPath('players') + clearCachedPath('playerTradeIndex')
Shared indexes are preserved.
Report (survives reload via sessionStorage):
  qcAuthS6b.getLastPersonalCacheClearReport()
  // PASS: playersCleared && playerTradeIndexCleared && sharedScopesPreserved
  // reason: logout | forceLocalExit | crossTab
S7a (when persist enforcement latched ON — production scoped or qc_persist_enforce):
  after session clear → persistLocalNow({ sessionUsername: null })`);
    },
  };
}

_installAuthWindowApi();
