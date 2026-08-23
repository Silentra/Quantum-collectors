/**
 * Research Points (RP) Infrastructure Module
 *
 * Schema + persistence only. No quests, UI, timers, or rewards.
 *
 * Provides:
 *   - ensurePlayerRPFields(username)  - per-player RP backfill (login)
 *   - migrateAllPlayersRP()           - bulk helper (admin/manual; not student startup)
 *   - repairUniqueCardsOwnedStats()   - one-time uniqueCardsOwned repair (admin/manual; not startup)
 *   - getResearchPoints(username)
 *   - addResearchPoints(username, amount)
 *   - addSeasonalResearchPoints(username, amount)
 *   - getTopResearchPlayers(limit)
 *   - getTopSeasonalResearchPlayers(limit)
 *   - resetSeasonalResearchPoints()   - admin-only reset
 */

import * as db from './database.js';
import * as cards from './cards.js';
import {
  adminLoadCanonical,
  assertCanonicalComplete,
  canonicalChildEntries,
} from './admin-maintenance.js';
import {
  STAT_TYPES,
  LEADERBOARDS_ROOT,
  buildLeaderboardSummaryPathsForChangedStats,
  playerLikeWithStatOverlay,
  syncLeaderboardSummariesForPlayer,
} from './leaderboard-summaries.js';

/** Infra key under players/ — never repair as a student. */
const UNIQUE_CARDS_EXCLUDED_PLAYER_KEYS = Object.freeze(['__admin__']);

const UNIQUE_CARDS_STAT_PATH_RE = /^players\/[^/]+\/stats\/uniqueCardsOwned$/;
const UNIQUE_CARDS_LB_PATH_RE = /^leaderboards\/uniqueCardsOwned\/[^/]+$/;

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
export function ensurePlayerRPFields(username) {
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
    // Missing entirely — write full default.
    // Note: highestTierCompleted defaults to null; RTDB omits nulls, so we omit it
    // from the written object to avoid a delete/recreate loop on every startup.
    const { highestTierCompleted, ...requiredStats } = DEFAULT_RESEARCH_STATS;
    db.set(`players/${username}/researchStats`, { ...requiredStats });
    migrated = true;
  } else {
    // Patch individual missing keys (skip null defaults — absent already means null)
    for (const [key, defaultVal] of Object.entries(DEFAULT_RESEARCH_STATS)) {
      if (defaultVal === null || defaultVal === undefined) {
        // Absent or explicit null are equivalent; never db.set(path, null).
        continue;
      }
      if (existing[key] === undefined || existing[key] === null) {
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
 * Phase B: not called from ordinary student startup; use ensurePlayerRPFields on login
 * or invoke this helper manually/admin.
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
  const planned = buildResearchPointGrantUpdates(username, amount);
  for (const [path, value] of Object.entries(planned.updates)) {
    db.set(path, value);
  }

  import('./achievements.js')
    .then(mod => mod.notifyStatsChanged(username, ['totalResearchPoints']))
    .catch(() => {});

  return planned.newTotal;
}

/**
 * Pure: absolute multi-path updates for a lifetime + spendable RP grant.
 * Matches addResearchPoints write targets (no achievement notify, no DB writes).
 * @param {string} username
 * @param {number} amount
 * @returns {{ updates: Object, newTotal: number }}
 */
export function buildResearchPointGrantUpdates(username, amount) {
  const empty = { updates: {}, newTotal: getResearchPoints(username) };
  if (!username || typeof amount !== 'number' || amount <= 0) return empty;

  const current = getResearchPoints(username);
  const newTotal = current + amount;
  const currentSpendable = db.get(`players/${username}/currencies/currentResearchPoints`);
  const spendableSafe = typeof currentSpendable === 'number' ? currentSpendable : 0;
  const playerBefore = db.get(`players/${username}`) || {};
  const playerLike = playerLikeWithStatOverlay(playerBefore, {
    [STAT_TYPES.LIFETIME_RP]: newTotal,
  });

  return {
    updates: {
      [`players/${username}/totalResearchPoints`]: newTotal,
      [`players/${username}/currencies/currentResearchPoints`]: spendableSafe + amount,
      ...buildLeaderboardSummaryPathsForChangedStats(
        username,
        playerLike,
        [STAT_TYPES.LIFETIME_RP],
      ),
    },
    newTotal,
  };
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
  const planned = buildSeasonalResearchPointGrantUpdates(username, amount);
  for (const [path, value] of Object.entries(planned.updates)) {
    db.set(path, value);
  }
  return planned.newTotal;
}

/**
 * Pure: absolute update for seasonal RP grant (parity with addSeasonalResearchPoints).
 * @param {string} username
 * @param {number} amount
 * @returns {{ updates: Object, newTotal: number }}
 */
export function buildSeasonalResearchPointGrantUpdates(username, amount) {
  const current = db.get(`players/${username}/seasonalResearchPoints`);
  const currentSafe = typeof current === 'number' ? current : 0;
  if (!username || typeof amount !== 'number' || amount <= 0) {
    return { updates: {}, newTotal: currentSafe };
  }
  const newTotal = currentSafe + amount;
  const playerBefore = db.get(`players/${username}`) || {};
  const playerLike = playerLikeWithStatOverlay(playerBefore, {
    [STAT_TYPES.SEASONAL_RP]: newTotal,
  });
  return {
    updates: {
      [`players/${username}/seasonalResearchPoints`]: newTotal,
      ...buildLeaderboardSummaryPathsForChangedStats(
        username,
        playerLike,
        [STAT_TYPES.SEASONAL_RP],
      ),
    },
    newTotal,
  };
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
 * Compute the number of unique card types a player currently owns.
 * Matches Collection/Profile: Number(qty) > 0 AND card exists in catalog AND enabled !== false.
 * Orphan / disabled inventory leaves are ignored (not deleted).
 * @param {string} username
 * @returns {number}
 */
export function computeUniqueCardsOwned(username) {
  if (!username) return 0;
  const inventory = db.get(`players/${username}/inventory`) || {};
  return computeUniqueCardsOwnedFromInventory(inventory);
}

/**
 * Unique card count from an inventory map against an explicit cards catalog snapshot.
 * Pure — no DB/cache. Same rules as computeUniqueCardsOwnedFromInventory.
 *
 * @param {object|null|undefined} inventory
 * @param {object|null|undefined} cardsSnapshot - map of cardId → card
 * @returns {number}
 */
export function countUniqueCardsOwnedFromSnapshots(inventory = {}, cardsSnapshot = null) {
  const catalog = cardsSnapshot && typeof cardsSnapshot === 'object' ? cardsSnapshot : {};
  let count = 0;
  const inv = inventory && typeof inventory === 'object' ? inventory : {};
  for (const [cardId, qty] of Object.entries(inv)) {
    if (!(Number(qty) > 0)) continue;
    const card = catalog[cardId];
    if (!card || card.enabled === false) continue;
    count += 1;
  }
  return count;
}

/**
 * Unique card count from an inventory map (no DB writes).
 * Aligns with Collection/Profile progress — uses `cards.getCard` (same catalog cache).
 * @param {Object} inventory
 * @returns {number}
 */
export function computeUniqueCardsOwnedFromInventory(inventory = {}) {
  let count = 0;
  for (const [cardId, qty] of Object.entries(inventory || {})) {
    if (!(Number(qty) > 0)) continue;
    const card = cards.getCard(cardId);
    if (!card || card.enabled === false) continue;
    count += 1;
  }
  return count;
}

/**
 * @param {Record<string, unknown>|null|undefined} updates
 * @returns {true}
 */
export function assertUniqueCardsRepairPathsAllowed(updates) {
  const keys = updates && typeof updates === 'object' ? Object.keys(updates) : [];
  for (const path of keys) {
    if (UNIQUE_CARDS_STAT_PATH_RE.test(path) || UNIQUE_CARDS_LB_PATH_RE.test(path)) continue;
    throw new Error(
      `[UniqueCardsRepair] Illegal path ${JSON.stringify(path)} — `
      + 'only players/{u}/stats/uniqueCardsOwned and leaderboards/uniqueCardsOwned/{u} allowed',
    );
  }
  return true;
}

/**
 * Pure Unique Cards repair planner (S8d-5a). No DB/cache reads.
 * Only plans writes when stored stats.uniqueCardsOwned differs from inventory-derived count.
 * When a stat is repaired, also writes the live uniqueCardsOwned LB leaf (create/update).
 * Does not repair LB-only drift when the stored stat is already correct (use S8d-3 for that).
 *
 * @param {{
 *   playersSnapshot?: object|null,
 *   cardsSnapshot?: object|null,
 *   leaderboardSnapshot?: object|null,
 *   now?: number,
 * }} [input]
 */
export function buildUniqueCardsRepairPlan(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const cardsSnap = input.cardsSnapshot && typeof input.cardsSnapshot === 'object'
    ? input.cardsSnapshot
    : {};
  // Accept full leaderboards root or uniqueCardsOwned subtree
  let lbUnique = null;
  const lbRoot = input.leaderboardSnapshot;
  if (lbRoot && typeof lbRoot === 'object') {
    if (lbRoot.uniqueCardsOwned && typeof lbRoot.uniqueCardsOwned === 'object') {
      lbUnique = lbRoot.uniqueCardsOwned;
    } else {
      lbUnique = lbRoot;
    }
  }
  lbUnique = lbUnique && typeof lbUnique === 'object' ? lbUnique : {};

  /** @type {Record<string, object|number>} */
  const updates = {};
  let playersChanged = 0;
  let unchanged = 0;
  let statRepairs = 0;
  let leaderboardCreates = 0;
  let leaderboardUpdates = 0;
  /** @type {string[]} */
  const changedPlayers = [];

  const playerEntries = canonicalChildEntries(input.playersSnapshot, {
    exclude: [...UNIQUE_CARDS_EXCLUDED_PLAYER_KEYS],
  });

  for (const { key: username, value: player } of playerEntries) {
    const playerObj = player != null && typeof player === 'object' ? player : {};
    const inventory = playerObj.inventory && typeof playerObj.inventory === 'object'
      ? playerObj.inventory
      : {};
    const next = countUniqueCardsOwnedFromSnapshots(inventory, cardsSnap);
    const prev = playerObj.stats?.uniqueCardsOwned;
    if (typeof prev === 'number' && prev === next) {
      unchanged += 1;
      continue;
    }

    const statPath = `players/${username}/stats/uniqueCardsOwned`;
    updates[statPath] = next;
    statRepairs += 1;

    const playerLike = playerLikeWithStatOverlay(playerObj, {
      [STAT_TYPES.UNIQUE_CARDS_OWNED]: next,
    });
    const lbPaths = buildLeaderboardSummaryPathsForChangedStats(
      username,
      playerLike,
      [STAT_TYPES.UNIQUE_CARDS_OWNED],
      now,
    );
    Object.assign(updates, lbPaths);

    const lbPath = `${LEADERBOARDS_ROOT}/uniqueCardsOwned/${username}`;
    if (lbUnique[username] == null) leaderboardCreates += 1;
    else leaderboardUpdates += 1;

    playersChanged += 1;
    changedPlayers.push(username);
  }

  assertUniqueCardsRepairPathsAllowed(updates);

  return {
    ok: true,
    updates,
    playersScanned: playerEntries.length,
    playersChanged,
    unchanged,
    statRepairs,
    leaderboardCreates,
    leaderboardUpdates,
    changedPlayers,
    now,
  };
}

/**
 * Authoritative gather for Unique Cards repair (fail-closed).
 * @param {{ timeoutMs?: number }} [options]
 */
export async function gatherUniqueCardsRepairSnapshots(options = {}) {
  const playersLoad = await adminLoadCanonical('players', options);
  if (!assertCanonicalComplete(playersLoad)) {
    return {
      ok: false,
      complete: false,
      error: playersLoad?.error || 'PLAYERS_CANONICAL_INCOMPLETE',
    };
  }

  const cardsLoad = await db.loadPathOnce('cards', {
    force: true,
    timeoutMs: options.timeoutMs,
  });
  if (!cardsLoad || cardsLoad.ok !== true || cardsLoad.mode !== 'firebase') {
    return {
      ok: false,
      complete: false,
      error: cardsLoad?.error || 'CARDS_LOAD_INCOMPLETE',
    };
  }

  const lbPath = `${LEADERBOARDS_ROOT}/uniqueCardsOwned`;
  const lbLoad = await db.loadPathOnce(lbPath, {
    force: true,
    timeoutMs: options.timeoutMs,
  });
  if (!lbLoad || lbLoad.ok !== true || lbLoad.mode !== 'firebase') {
    return {
      ok: false,
      complete: false,
      error: lbLoad?.error || 'UNIQUE_CARDS_LB_LOAD_INCOMPLETE',
    };
  }

  return {
    ok: true,
    complete: true,
    playersSnapshot: playersLoad.value,
    cardsSnapshot: cardsLoad.value == null ? null : cardsLoad.value,
    leaderboardSnapshot: lbLoad.value == null ? null : lbLoad.value,
  };
}

/**
 * Gather + plan (no writes). For Admin preview.
 * @param {{ timeoutMs?: number, now?: number }} [options]
 */
export async function prepareUniqueCardsRepair(options = {}) {
  const gathered = await gatherUniqueCardsRepairSnapshots(options);
  if (!gathered.ok || !gathered.complete) {
    return {
      ok: false,
      skipped: false,
      complete: false,
      plan: null,
      error: gathered.error || 'Gather failed',
      playersScanned: 0,
      playersChanged: 0,
      unchanged: 0,
      statRepairs: 0,
      leaderboardCreates: 0,
      leaderboardUpdates: 0,
      changedPlayers: [],
    };
  }

  const plan = buildUniqueCardsRepairPlan({
    playersSnapshot: gathered.playersSnapshot,
    cardsSnapshot: gathered.cardsSnapshot,
    leaderboardSnapshot: gathered.leaderboardSnapshot,
    now: options.now,
  });

  return {
    ok: true,
    skipped: Object.keys(plan.updates).length === 0,
    complete: true,
    plan,
    error: undefined,
    playersScanned: plan.playersScanned,
    playersChanged: plan.playersChanged,
    unchanged: plan.unchanged,
    statRepairs: plan.statRepairs,
    leaderboardCreates: plan.leaderboardCreates,
    leaderboardUpdates: plan.leaderboardUpdates,
    changedPlayers: [...plan.changedPlayers],
  };
}

/**
 * Commit an already-prepared plan (exact in-memory updates). No re-gather.
 * @param {{ updates: Record<string, object|number>, playersScanned?: number, playersChanged?: number, unchanged?: number, statRepairs?: number, leaderboardCreates?: number, leaderboardUpdates?: number, changedPlayers?: string[] }} plan
 */
export async function commitUniqueCardsRepairPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    return {
      ok: false,
      skipped: false,
      scanned: 0,
      changed: 0,
      unchanged: 0,
      failed: 0,
      written: 0,
      error: 'INVALID_PLAN',
    };
  }

  const updates = plan.updates && typeof plan.updates === 'object' ? plan.updates : {};
  try {
    assertUniqueCardsRepairPathsAllowed(updates);
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      scanned: Number(plan.playersScanned) || 0,
      changed: Number(plan.playersChanged) || 0,
      unchanged: Number(plan.unchanged) || 0,
      failed: Number(plan.playersChanged) || 0,
      written: 0,
      error: err?.message || 'ILLEGAL_REPAIR_PATH',
    };
  }

  const scanned = Number(plan.playersScanned) || 0;
  const changed = Number(plan.playersChanged) || 0;
  const unchanged = Number(plan.unchanged) || 0;

  if (Object.keys(updates).length === 0) {
    return {
      ok: true,
      skipped: true,
      scanned,
      changed: 0,
      unchanged,
      failed: 0,
      written: 0,
      statRepairs: 0,
      leaderboardCreates: 0,
      leaderboardUpdates: 0,
    };
  }

  const ack = await db.updateAcknowledged(updates);
  if (!ack.ok) {
    return {
      ok: false,
      skipped: false,
      scanned,
      changed,
      unchanged,
      failed: changed,
      written: 0,
      mode: ack.mode,
      error: ack.error || 'COMMIT_FAILED',
    };
  }

  return {
    ok: true,
    skipped: false,
    scanned,
    changed,
    unchanged,
    failed: 0,
    written: Object.keys(updates).length,
    mode: ack.mode,
    statRepairs: Number(plan.statRepairs) || 0,
    leaderboardCreates: Number(plan.leaderboardCreates) || 0,
    leaderboardUpdates: Number(plan.leaderboardUpdates) || 0,
    changedPlayers: Array.isArray(plan.changedPlayers) ? [...plan.changedPlayers] : [],
  };
}

/**
 * One-time Admin/dev repair: recompute stats.uniqueCardsOwned for all players
 * (enabled catalog only) and sync leaderboards/uniqueCardsOwned/{u} when the
 * value differs. Does not delete inventory leaves. Not invoked on startup.
 * S8d-5a: authoritative gather → plan → commit (no scoped getChildren universe).
 *
 * @param {{ timeoutMs?: number, now?: number, plan?: object }} [options]
 */
export async function repairUniqueCardsOwnedStats(options = {}) {
  if (options.plan) {
    return commitUniqueCardsRepairPlan(options.plan);
  }

  const prepared = await prepareUniqueCardsRepair(options);
  if (!prepared.ok || !prepared.plan) {
    return {
      ok: false,
      scanned: 0,
      changed: 0,
      unchanged: 0,
      failed: 0,
      written: 0,
      error: prepared.error || 'Prepare failed',
    };
  }

  return commitUniqueCardsRepairPlan(prepared.plan);
}

/**
 * Ensure a single player record has stats.uniqueCardsOwned.
 * Computes value from live inventory if missing.
 * @param {string} username
 * @returns {boolean} true if field was added
 */
export function ensurePlayerUniqueCardsOwned(username) {
  const player = db.get(`players/${username}`);
  if (!player) return false;

  const stats = player.stats || {};
  if (typeof stats.uniqueCardsOwned === 'number') return false;

  const computed = computeUniqueCardsOwned(username);
  db.set(`players/${username}/stats/uniqueCardsOwned`, computed);
  void syncLeaderboardSummariesForPlayer(username, {
    statTypes: [STAT_TYPES.UNIQUE_CARDS_OWNED],
  });
  return true;
}

/**
 * Migrate all existing players to include stats.uniqueCardsOwned.
 * Safe to call multiple times — skips players that already have the field.
 * Phase B: no longer invoked from ordinary student startup — use ensurePlayerUniqueCardsOwned on login
 * or call this helper manually/admin.
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
  void syncLeaderboardSummariesForPlayer(username, {
    statTypes: [STAT_TYPES.UNIQUE_CARDS_OWNED],
  });
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcResearch = {
    computeUniqueCardsOwned,
    computeUniqueCardsOwnedFromInventory,
    countUniqueCardsOwnedFromSnapshots,
    buildUniqueCardsRepairPlan,
    prepareUniqueCardsRepair,
    commitUniqueCardsRepairPlan,
    refreshUniqueCardsOwned,
    ensurePlayerUniqueCardsOwned,
    repairUniqueCardsOwnedStats,
    help() {
      console.info(`Research / Unique Cards (S8d-5a)
Compute (enabled catalog only): qcResearch.computeUniqueCardsOwned('bobby')
Safe repair: await qcResearch.prepareUniqueCardsRepair() then commitUniqueCardsRepairPlan(plan)
  or await qcResearch.repairUniqueCardsOwnedStats()
Does not delete orphan inventory leaves. Not run on startup.`);
    },
  };
}

_installWindowApi();

/**
 * Reset seasonal research points for ALL players.
 * Preserves lifetime RP, inventories, accounts — only touches seasonalResearchPoints.
 */
export function resetSeasonalResearchPoints() {
  const players = db.getChildren('players');
  let count = 0;
  const now = Date.now();
  /** @type {Record<string, object|number>} */
  const updates = {};

  for (const { key: username, value: player } of players) {
    if (username === '__admin__') continue;
    updates[`players/${username}/seasonalResearchPoints`] = 0;
    const playerLike = playerLikeWithStatOverlay(player || {}, {
      [STAT_TYPES.SEASONAL_RP]: 0,
    });
    Object.assign(
      updates,
      buildLeaderboardSummaryPathsForChangedStats(
        username,
        playerLike,
        [STAT_TYPES.SEASONAL_RP],
        now,
      ),
    );
    count += 1;
  }

  if (Object.keys(updates).length > 0) {
    void db.updateAcknowledged(updates);
  }

  console.log(`[Research] Seasonal RP reset — ${count} player(s) cleared`);
  return count;
}
