/**
 * Weekly Research Pack System
 *
 * Additive tracking system that awards players ONE reward pack per weekly cycle.
 *
 * This module ONLY adds:
 *   - weekly RP tracking toward a reward pack
 *   - weekly refresh check / reset
 *   - pack grant via existing player.addPack()
 *
 * It does NOT:
 *   - touch lifetime RP
 *   - touch seasonal RP
 *   - touch leaderboards
 *   - create a new pack type or inventory system
 *   - replace any existing progression system
 *
 * Player DB fields managed here (all additive / new):
 *   players/{username}/weeklyRPProgress   — number, resets each cycle
 *   players/{username}/weeklyPackClaimed  — boolean, resets each cycle
 *   players/{username}/weeklyResetAt      — timestamp of last reset applied to this player
 *
 * Config stored at: config/projectBalance (same path as project config)
 *   weeklyRewardPackId    — string, pack id to grant
 *   weeklyRefreshDay      — number 0–6 (0=Sun … 6=Sat), default 5 (Friday)
 *   weeklyRefreshHour     — number 0–23, default 23
 *   weeklyRPRequirements  — { common, uncommon, rare, epic, legendary }
 *                           RP thresholds per rarity stage (first stage hardcoded 1)
 */

import * as db from './database.js';
import * as player from './player.js';
import { getProjectConfig } from './project-config.js';
import { getUnlockedProjectRarities } from './project-generator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants / defaults
// ─────────────────────────────────────────────────────────────────────────────

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/**
 * Default RP requirements per highest-unlocked rarity stage.
 * common = 1 (intentional onboarding — hardcoded for safety).
 * All others derive from the existing rarityUnlockThresholds in project-config.
 * Admins can override any of these in the balance panel.
 */
export const WEEKLY_RP_REQUIREMENTS_DEFAULTS = {
  common:    1,
  uncommon:  40,
  rare:      80,
  epic:      150,
  legendary: 250,
};

/** Default refresh: Friday (5), 23:00 (11 PM) */
const DEFAULT_REFRESH_DAY  = 5;  // Friday
const DEFAULT_REFRESH_HOUR = 23; // 11 PM

// ──────────────────────────────────────��──────────────────────────────────────
// Config helpers (read from project-config DB path)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the currently configured weekly reward pack ID.
 * @returns {string} pack id or empty string
 */
export function getWeeklyRewardPackId() {
  const cfg = getProjectConfig();
  return cfg.weeklyRewardPackId ?? '';
}

/**
 * Get the configured weekly refresh day (0=Sun … 6=Sat).
 * @returns {number}
 */
export function getWeeklyRefreshDay() {
  const cfg = getProjectConfig();
  const d = cfg.weeklyRefreshDay;
  return (typeof d === 'number' && d >= 0 && d <= 6) ? d : DEFAULT_REFRESH_DAY;
}

/**
 * Get the configured weekly refresh hour (0–23).
 * @returns {number}
 */
export function getWeeklyRefreshHour() {
  const cfg = getProjectConfig();
  const h = cfg.weeklyRefreshHour;
  return (typeof h === 'number' && h >= 0 && h <= 23) ? h : DEFAULT_REFRESH_HOUR;
}

/**
 * Get the admin-configurable weekly RP requirement table.
 * Falls back to WEEKLY_RP_REQUIREMENTS_DEFAULTS for any missing key.
 * common is always forced to 1.
 * @returns {{ common:number, uncommon:number, rare:number, epic:number, legendary:number }}
 */
export function getWeeklyRPRequirements() {
  const cfg = getProjectConfig();
  const saved = cfg.weeklyRPRequirements ?? {};
  const result = {};
  for (const r of RARITY_ORDER) {
    result[r] = typeof saved[r] === 'number' ? saved[r] : WEEKLY_RP_REQUIREMENTS_DEFAULTS[r];
  }
  result.common = 1; // always 1 — onboarding
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh timestamp helpers
// ────────────────────────────────────────���────────────────────────────────────

/**
 * Compute the most recent past occurrence of the configured refresh time.
 * Returns a UTC timestamp (ms) for the last Friday 23:00 (or configured day/hour).
 * @param {number} [now] - reference timestamp, defaults to Date.now()
 * @returns {number}
 */
export function getLastWeeklyRefreshTimestamp(now = Date.now()) {
  const day  = getWeeklyRefreshDay();
  const hour = getWeeklyRefreshHour();

  const d = new Date(now);
  // Walk back day-by-day until we land on the configured weekday
  let candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);
  // Subtract days until we reach the right weekday
  while (candidate.getDay() !== day) {
    candidate = new Date(candidate.getTime() - 86_400_000);
  }
  // If we overshot (candidate is in the future), subtract another week
  if (candidate.getTime() > now) {
    candidate = new Date(candidate.getTime() - 7 * 86_400_000);
  }
  return candidate.getTime();
}

/**
 * Compute the NEXT upcoming refresh timestamp after `now`.
 * @param {number} [now]
 * @returns {number}
 */
export function getNextWeeklyRefreshTimestamp(now = Date.now()) {
  const last = getLastWeeklyRefreshTimestamp(now);
  return last + 7 * 86_400_000;
}

/**
 * Return a human-readable string like "Friday at 11:00 PM"
 * showing when the weekly cycle refreshes.
 * @returns {string}
 */
export function getWeeklyRefreshLabel() {
  const day  = getWeeklyRefreshDay();
  const hour = getWeeklyRefreshHour();
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12  = hour % 12 === 0 ? 12 : hour % 12;
  return `${dayNames[day]} at ${h12}:00 ${ampm}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Player weekly state helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a player's current weekly RP progress (0 if missing).
 * @param {string} username
 * @returns {number}
 */
export function getWeeklyRPProgress(username) {
  if (!username) return 0;
  const val = db.get(`players/${username}/weeklyRPProgress`);
  return typeof val === 'number' ? val : 0;
}

/**
 * Return true if the player has already claimed their pack this cycle.
 * @param {string} username
 * @returns {boolean}
 */
export function hasClaimedWeeklyPack(username) {
  if (!username) return false;
  return db.get(`players/${username}/weeklyPackClaimed`) === true;
}

/**
 * Get the timestamp of the last weekly reset applied to this player.
 * Used to detect when a new cycle has started.
 * @param {string} username
 * @returns {number}
 */
export function getPlayerWeeklyResetAt(username) {
  if (!username) return 0;
  const val = db.get(`players/${username}/weeklyResetAt`);
  return typeof val === 'number' ? val : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly reset logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a player's weekly state needs to be reset (new cycle has started).
 * Safe to call on every page load / tab open.
 * Only writes to DB if a reset is actually needed.
 * @param {string} username
 * @param {number} [now]
 * @returns {boolean} true if a reset was applied
 */
export function checkAndResetWeeklyCycle(username, now = Date.now()) {
  if (!username) return false;

  const lastRefresh   = getLastWeeklyRefreshTimestamp(now);
  const playerResetAt = getPlayerWeeklyResetAt(username);

  // Player's reset timestamp is before the most recent cycle boundary → reset needed
  if (playerResetAt < lastRefresh) {
    db.set(`players/${username}/weeklyRPProgress`,  0);
    db.set(`players/${username}/weeklyPackClaimed`, false);
    db.set(`players/${username}/weeklyResetAt`,     lastRefresh);
    console.log(`[WeeklyPack] Reset weekly state for ${username} (cycle started ${new Date(lastRefresh).toISOString()})`);
    return true;
  }
  return false;
}

/**
 * Migrate existing players to include weekly pack fields.
 * Safe to call multiple times — skips players that already have weeklyResetAt.
 * @returns {number} count of players updated
 */
export function migrateAllPlayersWeeklyPack() {
  const players = db.getChildren('players');
  let count = 0;

  for (const { key: username } of players) {
    const existing = db.get(`players/${username}/weeklyResetAt`);
    if (existing === null || existing === undefined) {
      // Brand-new field — start them fresh so they get the first cycle right away
      db.set(`players/${username}/weeklyRPProgress`,  0);
      db.set(`players/${username}/weeklyPackClaimed`, false);
      // Set weeklyResetAt to 0 so the next checkAndResetWeeklyCycle() fires immediately
      db.set(`players/${username}/weeklyResetAt`,     0);
      count++;
    }
  }

  if (count > 0) {
    console.log(`[WeeklyPack] Migration — ${count} player(s) initialized`);
  } else {
    console.log('[WeeklyPack] Migration — all players up to date');
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// RP accumulation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add RP toward the weekly reward pack progress.
 * Called whenever a player earns RP from a research project claim.
 * Does NOT touch lifetime RP or seasonal RP.
 *
 * @param {string} username
 * @param {number} amount
 * @returns {number} new weekly RP progress total
 */
export function addWeeklyPackRP(username, amount) {
  if (!username || typeof amount !== 'number' || amount <= 0) {
    return getWeeklyRPProgress(username);
  }
  const current = getWeeklyRPProgress(username);
  const newTotal = current + amount;
  db.set(`players/${username}/weeklyRPProgress`, newTotal);
  return newTotal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Required RP computation (connects to existing rarity unlock thresholds)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the RP required for the current player to earn their weekly pack.
 * Derives from the highest rarity tier the player has unlocked,
 * using the admin-configurable weeklyRPRequirements table.
 * First stage (common) is always 1 RP.
 *
 * @param {string} username
 * @returns {number}
 */
export function getWeeklyRPRequired(username) {
  const totalRP    = db.get(`players/${username}/totalResearchPoints`) ?? 0;
  const unlocked   = getUnlockedProjectRarities(totalRP);  // uses existing rarity unlock thresholds
  const reqs       = getWeeklyRPRequirements();

  // Highest unlocked rarity = last entry in the ordered array
  const highestRarity = unlocked.length > 0 ? unlocked[unlocked.length - 1] : 'common';
  return reqs[highestRarity] ?? 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pack claim
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to claim the weekly reward pack for a player.
 * Uses existing player.addPack() — no new inventory/pack logic.
 *
 * @param {string} username
 * @returns {{ success: boolean, error?: string, packId?: string }}
 */
export function claimWeeklyPack(username) {
  if (!username) return { success: false, error: 'No user.' };

  // Ensure cycle is current
  checkAndResetWeeklyCycle(username);

  // Already claimed this cycle?
  if (hasClaimedWeeklyPack(username)) {
    return { success: false, error: 'Already claimed this week.' };
  }

  // Threshold met?
  const progress  = getWeeklyRPProgress(username);
  const required  = getWeeklyRPRequired(username);
  if (progress < required) {
    return { success: false, error: `Need ${required - progress} more RP.` };
  }

  // Pack configured?
  const packId = getWeeklyRewardPackId();
  if (!packId) {
    return { success: false, error: 'No weekly reward pack configured.' };
  }

  // Grant pack via existing infrastructure
  player.addPack(username, packId, 1);

  // Mark claimed
  db.set(`players/${username}/weeklyPackClaimed`, true);

  console.log(`[WeeklyPack] Granted pack "${packId}" to ${username}`);
  return { success: true, packId };
}
