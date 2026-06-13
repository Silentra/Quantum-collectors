/**
 * Research Points (RP) Infrastructure Module
 *
 * Schema + persistence only. No quests, UI, timers, or rewards.
 *
 * Provides:
 *   - migrateAllPlayersRP()           - safe migration for existing players
 *   - getResearchPoints(username)
 *   - addResearchPoints(username, amount)
 *   - addSeasonalResearchPoints(username, amount)
 *   - getTopResearchPlayers(limit)
 *   - getTopSeasonalResearchPlayers(limit)
 *   - resetSeasonalResearchPoints()   - admin-only reset
 */

import * as db from './database.js';

// ---------- Default RP fields ----------

const DEFAULT_RESEARCH_STATS = {
  totalProjects: 0,
  successfulProjects: 0,
  failedProjects: 0,
  breakthroughs: 0,
  highestTierCompleted: null
};

/**
 * Ensure a single player record has all RP fields.
 * Never overwrites existing valid data.
 * Migrates legacy researchPoints → totalResearchPoints if needed.
 * @param {string} username
 * @returns {boolean} true if any field was added
 */
function ensurePlayerRPFields(username) {
  const player = db.get(`players/${username}`);
  if (!player) return false;

  let migrated = false;

  // Canonical RP field migration: totalResearchPoints is the single source of truth
  if (typeof player.totalResearchPoints !== 'number') {
    // Backfill from legacy researchPoints if it exists, otherwise start at 0
    const legacyRP = typeof player.researchPoints === 'number' ? player.researchPoints : 0;
    db.set(`players/${username}/totalResearchPoints`, legacyRP);
    migrated = true;
  }
  if (typeof player.seasonalResearchPoints !== 'number') {
    db.set(`players/${username}/seasonalResearchPoints`, 0);
    migrated = true;
  }

  // researchStats object
  const existing = player.researchStats;
  if (!existing || typeof existing !== 'object') {
    // Missing entirely — write full default
    db.set(`players/${username}/researchStats`, { ...DEFAULT_RESEARCH_STATS });
    migrated = true;
  } else {
    // Patch individual missing keys
    for (const [key, defaultVal] of Object.entries(DEFAULT_RESEARCH_STATS)) {
      if (existing[key] === undefined || existing[key] === null) {
        // highestTierCompleted default is null, which is valid — but if the key
        // is entirely absent we should add it
        db.set(`players/${username}/researchStats/${key}`, defaultVal);
        migrated = true;
      }
    }
  }

  if (migrated) {
    console.log(`[Research] Player RP initialized: ${username}`);
  }
  return migrated;
}

// ---------- Migration ----------

/**
 * Migrate all existing players to include RP fields.
 * Safe to call multiple times — skips players that already have valid data.
 * Called once at startup from main.js.
 */
export function migrateAllPlayersRP() {
  const players = db.getChildren('players');
  let count = 0;

  for (const { key: username } of players) {
    if (ensurePlayerRPFields(username)) {
      count++;
    }
  }

  if (count > 0) {
    console.log(`[Research] RP migration complete — ${count} player(s) updated`);
  } else {
    console.log('[Research] RP migration complete — all players up to date');
  }
}

// ---------- Getter / Adder helpers ----------

/**
 * Get lifetime research points for a player.
 * Reads from canonical totalResearchPoints field.
 * @param {string} username
 * @returns {number}
 */
export function getResearchPoints(username) {
  if (!username) return 0;
  const val = db.get(`players/${username}/totalResearchPoints`);
  if (typeof val === 'number') return val;
  // Legacy fallback: check old researchPoints field for uncached records
  const legacy = db.get(`players/${username}/researchPoints`);
  return typeof legacy === 'number' ? legacy : 0;
}

/**
 * Add research points to a player's lifetime total and spendable shop balance.
 * Writes to canonical totalResearchPoints and currencies.currentResearchPoints.
 * @param {string} username
 * @param {number} amount - Must be a positive number
 * @returns {number} new total
 */
export function addResearchPoints(username, amount) {
  if (!username || typeof amount !== 'number' || amount <= 0) return getResearchPoints(username);
  const current = getResearchPoints(username);
  const newTotal = current + amount;
  const currentSpendable = db.get(`players/${username}/currencies/currentResearchPoints`);
  const spendableSafe = typeof currentSpendable === 'number' ? currentSpendable : 0;
  db.set(`players/${username}/totalResearchPoints`, newTotal);
  db.set(`players/${username}/currencies/currentResearchPoints`, spendableSafe + amount);

  import('./achievements.js')
    .then(mod => mod.notifyStatsChanged(username, ['totalResearchPoints']))
    .catch(() => {});

  return newTotal;
}

/**
 * Add seasonal research points to a player.
 * @param {string} username
 * @param {number} amount - Must be a positive number
 * @returns {number} new seasonal total
 */
export function addSeasonalResearchPoints(username, amount) {
  if (!username || typeof amount !== 'number' || amount <= 0) {
    const val = db.get(`players/${username}/seasonalResearchPoints`);
    return typeof val === 'number' ? val : 0;
  }
  const current = db.get(`players/${username}/seasonalResearchPoints`);
  const currentSafe = typeof current === 'number' ? current : 0;
  const newTotal = currentSafe + amount;
  db.set(`players/${username}/seasonalResearchPoints`, newTotal);
  return newTotal;
}

// ---------- Leaderboard helpers (data only, no UI) ----------

/**
 * Get top players by lifetime research points.
 * Descending sort, stable (secondary sort by username for determinism).
 * @param {number} limit
 * @returns {Array<{username: string, researchPoints: number}>}
 */
export function getTopResearchPlayers(limit = 10) {
  const players = db.getChildren('players');
  return players
    .map(({ key, value }) => {
      // Use canonical totalResearchPoints; fall back to legacy researchPoints for old records
      const rp = typeof value?.totalResearchPoints === 'number'
        ? value.totalResearchPoints
        : (typeof value?.researchPoints === 'number' ? value.researchPoints : 0);
      return { username: key, totalResearchPoints: rp };
    })
    .sort((a, b) => {
      const diff = b.totalResearchPoints - a.totalResearchPoints;
      if (diff !== 0) return diff;
      return a.username.localeCompare(b.username); // stable tiebreaker
    })
    .slice(0, limit);
}

/**
 * Get top players by seasonal research points.
 * Descending sort, stable (secondary sort by username for determinism).
 * @param {number} limit
 * @returns {Array<{username: string, seasonalResearchPoints: number}>}
 */
export function getTopSeasonalResearchPlayers(limit = 10) {
  const players = db.getChildren('players');
  return players
    .map(({ key, value }) => ({
      username: key,
      seasonalResearchPoints: typeof value?.seasonalResearchPoints === 'number' ? value.seasonalResearchPoints : 0
    }))
    .sort((a, b) => {
      const diff = b.seasonalResearchPoints - a.seasonalResearchPoints;
      if (diff !== 0) return diff;
      return a.username.localeCompare(b.username); // stable tiebreaker
    })
    .slice(0, limit);
}

// ---------- Admin helpers ----------

/**
 * Compute the number of unique card types a player currently owns (quantity > 0).
 * Reads directly from the player's inventory object.
 * @param {string} username
 * @returns {number}
 */
export function computeUniqueCardsOwned(username) {
  if (!username) return 0;
  const inventory = db.get(`players/${username}/inventory`) || {};
  return Object.values(inventory).filter(qty => typeof qty === 'number' && qty > 0).length;
}

/**
 * Ensure a single player record has stats.uniqueCardsOwned.
 * Computes value from live inventory if missing.
 * @param {string} username
 * @returns {boolean} true if field was added
 */
function ensurePlayerUniqueCardsOwned(username) {
  const player = db.get(`players/${username}`);
  if (!player) return false;

  const stats = player.stats || {};
  if (typeof stats.uniqueCardsOwned === 'number') return false;

  const computed = computeUniqueCardsOwned(username);
  db.set(`players/${username}/stats/uniqueCardsOwned`, computed);
  return true;
}

/**
 * Migrate all existing players to include stats.uniqueCardsOwned.
 * Safe to call multiple times — skips players that already have the field.
 * Called once at startup from main.js alongside migrateAllPlayersRP.
 */
export function migrateAllPlayersLeaderboardStats() {
  const players = db.getChildren('players');
  let count = 0;

  for (const { key: username } of players) {
    if (ensurePlayerUniqueCardsOwned(username)) {
      count++;
    }
  }

  if (count > 0) {
    console.log(`[Research] Leaderboard stats migration — ${count} player(s) updated`);
  } else {
    console.log('[Research] Leaderboard stats migration — all players up to date');
  }
}

/**
 * Refresh stats.uniqueCardsOwned for a single player from their live inventory.
 * Call this after pack openings or card additions/removals.
 * @param {string} username
 */
export function refreshUniqueCardsOwned(username) {
  if (!username) return;
  const count = computeUniqueCardsOwned(username);
  db.set(`players/${username}/stats/uniqueCardsOwned`, count);
}

/**
 * Reset seasonal research points for ALL players.
 * Preserves lifetime RP, inventories, accounts — only touches seasonalResearchPoints.
 */
export function resetSeasonalResearchPoints() {
  const players = db.getChildren('players');
  let count = 0;

  for (const { key: username } of players) {
    db.set(`players/${username}/seasonalResearchPoints`, 0);
    count++;
  }

  console.log(`[Research] Seasonal RP reset — ${count} player(s) cleared`);
  return count;
}
