/**
 * Auth Module - Username/Password Authentication via Firebase RTDB
 *
 * No Firebase Auth — passwords are stored (hashed) in players/{username}.
 * Sessions persist via localStorage.
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
 */

import * as db from './database.js';
import * as config from './config.js';
import { syncProjects } from './project-sync.js';
import { getProjectConfig } from './project-config.js';
import * as player from './player.js';
import * as cards from './cards.js';
import { getPhase2ADefaults, normalizePlayerSchema } from './player-schema.js';

const SESSION_KEY = 'scicards_session';

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

// ---------- Session (localStorage) ----------

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
}

/** Clear session */
export function logout() {
  localStorage.removeItem(SESSION_KEY);
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

// ---------- Auth init (session restore) ----------

/**
 * Initialize auth. Restores session from localStorage.
 * Validates that the stored session's player still exists.
 */
export async function initAuth() {
  const session = getSession();
  if (!session) {
    console.log('[Auth] No existing session');
    return;
  }

  // Admin session — just trust it
  if (session.isAdmin && session.username === '__admin__') {
    console.log('[Auth] Admin session restored');
    return;
  }

  // Player session — verify player still exists in DB
  if (session.username) {
    const player = db.get(`players/${session.username}`);
    if (player) {
      // Update last login + safely backfill missing fields (Phase 4A + 5A + schema migration)
      const researchDefaults = {};
      if (player.projects === undefined || player.projects === null)         researchDefaults.projects = [];
      if (player.lastProjectRefreshAt === undefined)  researchDefaults.lastProjectRefreshAt = 0;
      // Canonical RP migration: backfill totalResearchPoints from legacy researchPoints if missing
      if (player.totalResearchPoints === undefined)   researchDefaults.totalResearchPoints = (typeof player.researchPoints === 'number' ? player.researchPoints : 0);
      if (player.projectsCompleted === undefined)     researchDefaults.projectsCompleted = 0;
      if (player.seasonalResearchPoints === undefined) researchDefaults.seasonalResearchPoints = 0;
      // Phase 5A — persistent capability flags migration
      if (player.isAdmin === undefined)               researchDefaults.isAdmin = false;
      if (player.isTradeRestricted === undefined)     researchDefaults.isTradeRestricted = false;
      // Phase T-3 — trade profile hidden flag migration
      if (player.isTradeProfileHidden === undefined)  researchDefaults.isTradeProfileHidden = false;

      db.update(`players/${session.username}`, {
        lastLogin: Date.now(),
        ...researchDefaults
      });

      // Phase 2A — safe backfill of expanded schema fields
      normalizePlayerSchema(session.username);

      // Phase 4B — passive backend sync on session restore
      const freshPlayer = db.get(`players/${session.username}`);
      const syncResult = syncProjects({
        projects:      freshPlayer.projects      ?? [],
        totalRP:       freshPlayer.totalResearchPoints ?? 0,
        lastRefreshAt: freshPlayer.lastProjectRefreshAt ?? 0,
        now:           Date.now(),
      });
      db.update(`players/${session.username}`, {
        projects:             syncResult.projects,
        lastProjectRefreshAt: syncResult.refreshAt,
      });
      console.log(`[ResearchProjects] Sync complete — generated:${syncResult.generatedCount} resolved:${syncResult.resolvedCount} pruned:${syncResult.prunedCount}`);

      console.log(`[Auth] Session restored for: ${session.username}`);
    } else {
      // Player was deleted — clear stale session
      console.warn('[Auth] Stale session cleared (player not found)');
      logout();
    }
  }
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

  // Validate password
  const hashedInput = await hashPassword(password);
  if (player.password !== hashedInput) {
    return { success: false, error: 'Incorrect password.' };
  }

  const session = {
    username,
    isAdmin: player.isAdmin === true,
    loginTime: Date.now()
  };
  setSession(session);

  // Update last login + migration backfill (Phase 5A + canonical RP schema)
  const loginDefaults = {};
  if (player.isTradeRestricted === undefined) loginDefaults.isTradeRestricted = false;
  if (player.isAdmin === undefined)           loginDefaults.isAdmin = false;
  // Canonical RP migration: backfill totalResearchPoints from legacy researchPoints if missing
  if (player.totalResearchPoints === undefined) loginDefaults.totalResearchPoints = (typeof player.researchPoints === 'number' ? player.researchPoints : 0);
  if (player.seasonalResearchPoints === undefined) loginDefaults.seasonalResearchPoints = 0;
  // Phase T-3 — trade profile hidden flag migration
  if (player.isTradeProfileHidden === undefined) loginDefaults.isTradeProfileHidden = false;
  db.update(`players/${username}`, { lastLogin: Date.now(), ...loginDefaults });

  // Phase 2A — safe backfill of expanded schema fields
  normalizePlayerSchema(username);

  // Phase 4B — passive backend sync on login
  const loginPlayer = db.get(`players/${username}`);
  const syncResult = syncProjects({
    projects:      loginPlayer.projects      ?? [],
    totalRP:       loginPlayer.totalResearchPoints ?? 0,
    lastRefreshAt: loginPlayer.lastProjectRefreshAt ?? 0,
    now:           Date.now(),
  });
  db.update(`players/${username}`, {
    projects:             syncResult.projects,
    lastProjectRefreshAt: syncResult.refreshAt,
  });
  console.log(`[ResearchProjects] Sync complete — generated:${syncResult.generatedCount} resolved:${syncResult.resolvedCount} pruned:${syncResult.prunedCount}`);

  return { success: true, session };
}

// ---------- Register ----------

/**
 * Register with username, password, and access code
 * Returns { success, error?, session? }
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

  // Validate username format
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return { success: false, error: 'Username must be 3-20 characters, letters/numbers/underscore only.' };
  }

  // Check if username already exists
  if (db.get(`players/${username}`)) {
    return { success: false, error: 'Username already taken.' };
  }

  // Validate access code
  const codeData = db.get(`accessCodes/${accessCode}`);
  if (!codeData) {
    return { success: false, error: 'Invalid access code.' };
  }
  if (codeData.used) {
    return { success: false, error: 'This access code has already been used.' };
  }

  // Mark code as used
  db.update(`accessCodes/${accessCode}`, {
    used: true,
    usedBy: username,
    usedAt: Date.now()
  });

  // Hash the password
  const hashedPassword = await hashPassword(password);

  // Create player with password and isAdmin fields
  createPlayerRecord(username, hashedPassword, codeData.group || null);

  // Phase 4B — initial project sync on registration (same as login path).
  // createPlayerRecord writes projects:[] and lastProjectRefreshAt:0, so
  // syncProjects will immediately generate the configured starter projects.
  const newPlayer = db.get(`players/${username}`);
  const regSyncResult = syncProjects({
    projects:      newPlayer.projects      ?? [],
    totalRP:       newPlayer.totalResearchPoints ?? 0,
    lastRefreshAt: newPlayer.lastProjectRefreshAt ?? 0,
    now:           Date.now(),
  });
  db.update(`players/${username}`, {
    projects:             regSyncResult.projects,
    lastProjectRefreshAt: regSyncResult.refreshAt,
  });
  console.log(`[ResearchProjects] New account sync — generated:${regSyncResult.generatedCount}`);

  const session = { username, isAdmin: false, isTradeRestricted: false, loginTime: Date.now() };
  setSession(session);

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
 * Returns { inventory, cardsGrantedCount, scientistsGranted, conceptsGranted }
 * so createPlayerRecord can embed it into the initial write.
 */
function buildStarterInventory(pCfg) {
  const inventory = {};
  let cardsGrantedCount = 0;

  // ── Starter Scientists ──────────────────────────────────────────────────────
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

  // ── Starter Concepts ────────────────────────────────────────────────────────
  const conceptCount = typeof pCfg.starterConceptCount === 'number' ? pCfg.starterConceptCount : 2;
  // Normalize pool — Firebase may store arrays as objects
  let conceptPool = pCfg.starterConceptPool;
  if (conceptPool && typeof conceptPool === 'object' && !Array.isArray(conceptPool)) {
    conceptPool = Object.values(conceptPool);
  }
  if (!Array.isArray(conceptPool)) conceptPool = ['synergyBoost', 'breakthrough'];

  if (conceptCount > 0 && conceptPool.length > 0) {
    // For each conceptType in the pool, collect enabled concept cards of that type
    const eligibleByType = {};
    for (const ct of conceptPool) {
      const typeCards = cards.getAllCards().filter(
        c => c.enabled !== false && c.type === 'concept' && c.rarity === 'common' && c.conceptType === ct
      );
      if (typeCards.length > 0) eligibleByType[ct] = typeCards;
    }

    // Build a flat pool of [conceptType, cardObj] pairs from eligible types
    // so we can sample up to conceptCount distinct conceptTypes when possible
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
 * Create a player record in the DB with auth fields.
 * This is the auth-aware version that includes password + isAdmin.
 *
 * Starter packs: if config.starterPackId is set and starterPackQuantity > 0,
 * we add packs to the player record directly (no separate reward pipeline).
 *
 * Starter cards: random common scientist + concept cards from the live card pool.
 * All grants are written atomically in the initial record and protected by
 * idempotency flags (starterPacksGranted, starterScientistsGranted,
 * starterConceptsGranted) so they can never fire a second time.
 */
function createPlayerRecord(username, hashedPassword, group) {
  const pCfg = getProjectConfig();

  // ── Starter Packs ───────────────────────────────────────────────────────────
  let starterPacks = {};
  const starterPackId  = (pCfg.starterPackId  || '').trim();
  const starterPackQty = typeof pCfg.starterPackQuantity === 'number' ? pCfg.starterPackQuantity : 1;
  if (starterPackId && starterPackQty > 0) {
    starterPacks[starterPackId] = starterPackQty;
  }

  // ── Starter Cards ───────────────────────────────────────────────────────────
  const { inventory: starterInventory, cardsGrantedCount } = buildStarterInventory(pCfg);

  const playerRecord = {
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
      // Idempotency flags — prevent any future double-grant
      starterPacksGranted:     true,
      starterScientistsGranted: true,
      starterConceptsGranted:   true,
    },
    // ResearchProjects persistence fields (Phase 4A)
    projects: [],
    lastProjectRefreshAt: 0,
    totalResearchPoints: 0,  // canonical permanent RP field
    projectsCompleted: 0,
    researchStats: {
      totalProjects: 0,
      successfulProjects: 0,
      failedProjects: 0,
      breakthroughs: 0,
      highestTierCompleted: null
    },
    seasonalResearchPoints: 0,
    // Phase 5A — persistent capability flags
    isTradeRestricted: false,
    // Phase T-3/T-8 — trade profile hidden flag (default from config)
    isTradeProfileHidden: (config.getValue('trading.defaultHiddenProfile') === true),
    // Legacy top-level grant flag kept for backward compat
    starterPacksGranted: true,
    // Phase 2A — expanded player schema
    ...getPhase2ADefaults(),
  };
  db.set(`players/${username}`, playerRecord);
  console.log(`[Auth] New player created: ${username}${starterPackId && starterPackQty > 0 ? ` — granted ${starterPackQty}x starter pack` : ''}${cardsGrantedCount > 0 ? ` — granted ${cardsGrantedCount} starter card(s)` : ''}`);
  return playerRecord;
}

// ---------- Admin Login ----------

/**
 * Admin login with password
 * Returns { success, error?, session? }
 *
 * Phase 5A: If a player is currently logged in, permanently sets isAdmin=true
 * on their player profile (persists across sessions). Otherwise falls back
 * to the standalone __admin__ session.
 */
export function adminLogin(password) {
  const adminPw = config.getValue('adminPassword');
  if (password !== adminPw) {
    return { success: false, error: 'Incorrect admin password.' };
  }

  // Phase 5A — if a player is already logged in, promote them permanently
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

  // Fallback: standalone admin session (no player logged in)
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
