/**
 * Auth Module - Username/Password Authentication via Firebase RTDB
 *
 * No Firebase Auth — passwords are stored (hashed) in players/{username}.
 * Sessions persist via localStorage with a server-backed opaque session id
 * (players/{username}/activeSession). Only username === '__admin__' is exempt.
 *
 * Exported API:
 *   getSession()
 *   login(username, password)
 *   register(username, password, accessCode)
 *   adminLogin(password)
 *   logout()
 *   isAdmin()
 *   getCurrentUsername()
 *   generateAccessCodes(count, group)
 *   initAuth()  — async, restores session from localStorage
 *   ensureSessionGuard()
 *   consumePendingAuthMessage()
 */

import * as db from './database.js';
import * as config from './config.js';
import { syncProjects } from './project-sync.js';
import { getProjectConfig } from './project-config.js';
import * as cards from './cards.js';
import { getPhase2ADefaults, normalizePlayerSchema } from './player-schema.js';
import { resetLoginAchievementEvaluation, runLoginAchievementEvaluation } from './achievements.js';
import { ensurePlayerRPFields, ensurePlayerUniqueCardsOwned } from './research.js';
import { checkAndResetWeeklyCycle } from './weekly-research-pack.js';

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
}

/**
 * Force local exit without clearing the server session (already invalid or cleared elsewhere).
 */
function forceLocalExit(message) {
  if (_exitingLocally) return;
  _exitingLocally = true;
  stopSessionGuard();
  clearLocalSessionOnly();
  if (message) setPendingAuthMessage(message);
  location.reload();
}

function armSessionGuardGrace(sessionId, ms = 4000) {
  _sessionGuardExpectedId = sessionId || null;
  _sessionGuardGraceUntil = sessionId ? Date.now() + ms : 0;
}

function startSessionGuard(username) {
  stopSessionGuard();
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
    // Stale in-flight root snapshot can briefly disagree after an acknowledged claim.
    if (
      _sessionGuardExpectedId === session.sessionId &&
      Date.now() < _sessionGuardGraceUntil
    ) {
      return;
    }
    forceLocalExit(MSG_SIGNED_IN_ELSEWHERE);
  });
}

/** Start or refresh the in-process session guard for the current session. */
export function ensureSessionGuard() {
  const session = getSession();
  if (!session || session.username === '__admin__') {
    stopSessionGuard();
    return;
  }
  if (!session.sessionId) return;
  startSessionGuard(session.username);
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
        rememberSessionSnapshot(null);
        resetLoginAchievementEvaluation();
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
 * Explicit logout: ownership-checked clear of activeSession, then local clear.
 */
export async function logout() {
  stopSessionGuard();
  const session = getSession();
  if (session && session.username && session.username !== '__admin__' && session.sessionId) {
    await db.clearActiveSessionIfOwned(session.username, session.sessionId);
  }
  clearLocalSessionOnly();
}

/** Check if current session is admin */
export function isAdmin() {
  const session = getSession();
  if (!session) return false;
  // Admin via admin password login
  if (session.isAdmin === true) return true;
  // Admin via player flag
  if (session.username && session.username !== '__admin__') {
    const player = db.get(`players/${session.username}`);
    return player && player.isAdmin === true;
  }
  return false;
}

/** Get current username */
export function getCurrentUsername() {
  const session = getSession();
  return session ? session.username : null;
}

function applyPostLoginPlayerMaintenance(username) {
  const player = db.get(`players/${username}`);
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

  // Child/shallow updates only — never whole-player overwrite (preserves activeSession).
  db.update(`players/${username}`, {
    lastLogin: Date.now(),
    ...defaults
  });

  // Phase B: per-player backfill that used to run via startup migrateAll* bulk passes.
  // Order: RP + uniqueCardsOwned before normalize (normalize seeds uniqueCardsOwned to 0).
  ensurePlayerRPFields(username);
  ensurePlayerUniqueCardsOwned(username);
  checkAndResetWeeklyCycle(username);

  // Path-specific child writes only — must not clobber activeSession.
  normalizePlayerSchema(username);
  runLoginAchievementEvaluation(username);

  const freshPlayer = db.get(`players/${username}`);
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
    db.update(`players/${username}`, {
      projects:             syncResult.projects,
      lastProjectRefreshAt: syncResult.refreshAt,
    });
  }
  console.log(`[ResearchProjects] Sync complete — generated:${syncResult.generatedCount} resolved:${syncResult.resolvedCount} pruned:${syncResult.prunedCount}`);
}

// ---------- Auth init (session restore) ----------

/**
 * Initialize auth. Restores session from localStorage.
 * Validates opaque session id against players/{u}/activeSession (except __admin__).
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

  const player = db.get(`players/${session.username}`);
  if (!player) {
    console.warn('[Auth] Stale session cleared (player not found)');
    clearLocalSessionOnly();
    setPendingAuthMessage(MSG_SESSION_INVALID);
    return;
  }

  const activeSession = db.get(`players/${session.username}/activeSession`);
  const serverId = activeSession && activeSession.id != null ? activeSession.id : null;
  if (serverId !== session.sessionId) {
    console.warn('[Auth] Stale session cleared (session id mismatch)');
    clearLocalSessionOnly();
    setPendingAuthMessage(MSG_SESSION_INVALID);
    return;
  }

  // Cache already matches — start guard before fire-and-forget maintenance.
  startSessionGuard(session.username);
  applyPostLoginPlayerMaintenance(session.username);
  console.log(`[Auth] Session restored for: ${session.username}`);
}

// ---------- Login ----------

/**
 * Login with username + password
 * Returns { success, error?, session? }
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

  const player = db.get(`players/${username}`);
  if (!player) {
    return { success: false, error: 'Account not found. Please register first.' };
  }

  const hashedInput = await hashPassword(password);
  if (player.password !== hashedInput) {
    return { success: false, error: 'Incorrect password.' };
  }

  const sessionId = generateSessionId();
  const issuedAt = Date.now();
  const ack = await db.setAcknowledged(`players/${username}/activeSession`, {
    id: sessionId,
    issuedAt
  });
  if (!ack.ok) {
    return { success: false, error: MSG_SESSION_ESTABLISH };
  }

  // Cache patched by setAcknowledged — set local session, then start guard.
  const session = {
    username,
    isAdmin: player.isAdmin === true,
    loginTime: issuedAt,
    sessionId
  };
  setSession(session);
  armSessionGuardGrace(sessionId);
  startSessionGuard(username);

  applyPostLoginPlayerMaintenance(username);

  return { success: true, session };
}

// ---------- Register ----------

/**
 * Register with username, password, and access code.
 * Commits player (with activeSession) + access-code consumption in one acknowledged multi-path update.
 */
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

  if (db.get(`players/${username}`)) {
    return { success: false, error: 'Username already taken.' };
  }

  const codeData = db.get(`accessCodes/${accessCode}`);
  if (!codeData) {
    return { success: false, error: 'Invalid access code.' };
  }
  if (codeData.used) {
    return { success: false, error: 'This access code has already been used.' };
  }

  const hashedPassword = await hashPassword(password);
  const sessionId = generateSessionId();
  const issuedAt = Date.now();

  const playerRecord = buildPlayerRecord(username, hashedPassword, codeData.group || null);
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
    [`accessCodes/${accessCode}/used`]: true,
    [`accessCodes/${accessCode}/usedBy`]: username,
    [`accessCodes/${accessCode}/usedAt`]: issuedAt,
  });

  if (!ack.ok) {
    return { success: false, error: MSG_SESSION_ESTABLISH };
  }

  console.log(`[ResearchProjects] New account sync — generated:${regSyncResult.generatedCount}`);
  console.log(`[Auth] New player created: ${username}`);

  const session = {
    username,
    isAdmin: false,
    isTradeRestricted: false,
    loginTime: issuedAt,
    sessionId
  };
  setSession(session);
  armSessionGuardGrace(sessionId);
  startSessionGuard(username);

  return { success: true, session };
}

/**
 * Pick up to `count` random items from `pool` without replacement.
 * Returns at most pool.length items (graceful cap).
 */
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
export function adminLogin(password) {
  const adminPw = config.getValue('adminPassword');
  if (password !== adminPw) {
    return { success: false, error: 'Incorrect admin password.' };
  }

  const existing = getSession();
  if (existing && existing.username && existing.username !== '__admin__') {
    const playerData = db.get(`players/${existing.username}`);
    if (playerData) {
      db.update(`players/${existing.username}`, { isAdmin: true });
      existing.isAdmin = true;
      setSession(existing);
      console.log(`[Auth] Player permanently promoted to admin: ${existing.username}`);
      return { success: true, session: existing };
    }
  }

  stopSessionGuard();
  const session = { username: '__admin__', isAdmin: true, loginTime: Date.now() };
  setSession(session);
  return { success: true, session };
}

// ---------- Admin Password Reset ----------

/**
 * Reset a player's password (admin tool).
 * Hashes the new password and writes it — existing password is never read or returned.
 * @param {string} username
 * @param {string} newPassword
 * @returns {{ success: boolean, error?: string }}
 */
export async function resetPlayerPassword(username, newPassword) {
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

// ---------- Access codes ----------

/**
 * Generate access codes
 * Returns array of generated code strings
 */
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
