/**
 * Player Module - Player profiles, inventories, statistics
 */

import * as db from './database.js';
import * as metrics from './db-metrics.js';
import { notifyCardInventoryChanged, recordCardCollectionGain } from './achievements.js';
import {
  resolvePlayerDirectoryKey,
  syncDirectoryUpdateFromPlayer,
} from './player-directory.js';
import {
  buildPlayerDeleteTradeCleanupUpdates,
  listOwnedProcessingListingClaims,
  PLAYER_TRADE_INDEX_ROOT,
} from './trade-index.js';
import { TRADE_GRANTS_ROOT, clearTradeGrant } from './trade-grants.js';
import {
  buildLeaderboardGroupProjectionPaths,
  buildLeaderboardSummaryDeletePaths,
} from './leaderboard-summaries.js';

/**
 * Create a new player profile
 */
export function createPlayer(username, groupId = null) {
  const player = {
    username,
    created: Date.now(),
    lastLogin: Date.now(),
    groupId: groupId || null,
    subgroupId: null,
    inventory: {},       // cardId -> quantity
    packs: {},           // packId -> quantity
    stats: {
      packsOpened: 0,
      cardsCollected: 0,
      tradesCompleted: 0,
      projectsCompleted: 0
    },
    badges: {},
    achievements: {},
    progression: {
      tutorialComplete: false,
      firstPackOpened: false,
      firstTrade: false
    },
    totalResearchPoints: 0,
    seasonalResearchPoints: 0,
    researchStats: {
      totalProjects: 0,
      successfulProjects: 0,
      failedProjects: 0,
      breakthroughs: 0,
      highestTierCompleted: null
    }
  };
  db.set(`players/${username}`, player);
  return player;
}

/**
 * Get player data
 */
export function getPlayer(username) {
  return db.get(`players/${username}`);
}

/**
 * Update player data (shallow merge)
 */
export function updatePlayer(username, updates) {
  db.update(`players/${username}`, updates);
}

/**
 * Get player inventory as array of { cardId, quantity }.
 * Canonical ownership: only Number(quantity) > 0 (missing leaf ≡ quantity 0 ≡ not owned).
 */
export function getInventory(username) {
  const inv = db.get(`players/${username}/inventory`) || {};
  return Object.entries(inv)
    .filter(([, quantity]) => typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0)
    .map(([cardId, quantity]) => ({ cardId, quantity }));
}

/**
 * Add card(s) to player inventory
 */
export function addCard(username, cardId, quantity = 1) {
  const current = db.get(`players/${username}/inventory/${cardId}`) || 0;
  const next = current + quantity;
  db.set(`players/${username}/inventory/${cardId}`, next);

  // Update stats
  const stats = db.get(`players/${username}/stats`) || {};
  stats.cardsCollected = (stats.cardsCollected || 0) + quantity;
  db.set(`players/${username}/stats`, stats);

  recordCardCollectionGain(username, cardId, current, next);
}

/**
 * Remove card(s) from player inventory
 * Returns true if successful, false if insufficient
 */
export function removeCard(username, cardId, quantity = 1) {
  const current = db.get(`players/${username}/inventory/${cardId}`) || 0;
  if (current < quantity) return false;

  if (current - quantity <= 0) {
    db.remove(`players/${username}/inventory/${cardId}`);
  } else {
    db.set(`players/${username}/inventory/${cardId}`, current - quantity);
  }

  notifyCardInventoryChanged(username);
  return true;
}

/**
 * Add pack(s) to player
 */
export function addPack(username, packId, quantity = 1) {
  const current = db.get(`players/${username}/packs/${packId}`) || 0;
  db.set(`players/${username}/packs/${packId}`, current + quantity);
}

/**
 * Remove a pack from player (after opening)
 */
export function removePack(username, packId) {
  const current = db.get(`players/${username}/packs/${packId}`) || 0;
  if (current <= 1) {
    db.remove(`players/${username}/packs/${packId}`);
  } else {
    db.set(`players/${username}/packs/${packId}`, current - 1);
  }
}

/**
 * Get player's packs
 */
export function getPlayerPacks(username) {
  return db.get(`players/${username}/packs`) || {};
}

/**
 * Get all players
 */
export function getAllPlayers() {
  return db.getChildren('players');
}

/**
 * Set player group and optional subgroup (canonical + directory, one ack).
 * @param {string} username
 * @param {string|null} groupId
 * @param {string|null} subgroupId
 * @returns {Promise<{ ok: boolean, mode?: string, error?: string }>}
 */
export async function setPlayerGroup(username, groupId, subgroupId = null) {
  const playerKey = resolvePlayerDirectoryKey(username);
  const playerData = db.get(`players/${playerKey}`) || {};
  const nextGroupId = groupId || null;
  const nextSubgroupId = subgroupId || null;
  return db.updateAcknowledged({
    [`players/${playerKey}/groupId`]: nextGroupId,
    [`players/${playerKey}/subgroupId`]: nextSubgroupId,
    ...syncDirectoryUpdateFromPlayer(playerKey, {
      ...playerData,
      groupId: nextGroupId,
      subgroupId: nextSubgroupId,
    }),
    ...buildLeaderboardGroupProjectionPaths(playerKey, {
      ...playerData,
      groupId: nextGroupId,
      subgroupId: nextSubgroupId,
    }),
  });
}

/**
 * Increment a stat
 */
export function incrementStat(username, statKey, amount = 1) {
  const stats = db.get(`players/${username}/stats`) || {};
  stats[statKey] = (stats[statKey] || 0) + amount;
  db.set(`players/${username}/stats`, stats);
}

/**
 * Delete a player: terminalize open trades/listings as cancelled, clear indexes,
 * remove player + directory. Processing listings are claim-released first when possible.
 * @param {string} username
 * @returns {Promise<{ ok: boolean, mode?: string, error?: string, claimReleases?: number }>}
 */
export async function deletePlayer(username) {
  const playerKey = resolvePlayerDirectoryKey(username);
  if (!playerKey) {
    return { ok: false, error: 'Invalid username' };
  }

  let claimReleases = 0;
  const processingClaims = listOwnedProcessingListingClaims(playerKey);
  for (const { listingId, claimId } of processingClaims) {
    const listing = db.get(`trades/listings/${listingId}`);
    const grantUid = listing?.claimerAuthUid || null;
    const release = await db.releaseListingClaimIfOwned(listingId, claimId);
    if (release.ok && release.released) {
      claimReleases += 1;
      // S8c-1: clear grant tied to this processing claim (owner = deleted player)
      if (grantUid) {
        await clearTradeGrant(playerKey, grantUid);
      }
    } else {
      console.warn(
        `[Player] Could not release processing claim on listing ${listingId} before delete; ` +
          'continuing with cancel+clear in multi-path.',
        release.error,
      );
    }
  }

  const now = Date.now();
  const tradeCleanup = buildPlayerDeleteTradeCleanupUpdates(playerKey, now);
  // tradeCleanup already nulls playerTradeIndex/{key}; avoid overlapping with directory/player
  const updates = {
    ...tradeCleanup,
    [`players/${playerKey}`]: null,
    [`playerDirectory/${playerKey}`]: null,
    // S8c-1: drop any grants targeting this player
    [`${TRADE_GRANTS_ROOT}/${playerKey}`]: null,
    ...buildLeaderboardSummaryDeletePaths(playerKey),
  };

  // Safety: ensure trade index root for deleted user is cleared even if no actives
  if (!Object.prototype.hasOwnProperty.call(updates, `${PLAYER_TRADE_INDEX_ROOT}/${playerKey}`)) {
    updates[`${PLAYER_TRADE_INDEX_ROOT}/${playerKey}`] = null;
  }

  const ack = await db.updateAcknowledged(updates);
  metrics.recordTradeIndexLifecycle({
    tag: 'trade-index-delete-cleanup',
    ops: 1 + claimReleases,
    ok: ack.ok,
    username: playerKey,
  });
  if (!ack.ok) {
    return {
      ok: false,
      mode: ack.mode,
      error: ack.error || 'Player delete failed',
      claimReleases,
    };
  }
  return { ok: true, mode: ack.mode, claimReleases };
}
