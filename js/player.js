/**
 * Player Module - Player profiles, inventories, statistics
 */

import * as db from './database.js';
import { notifyCardInventoryChanged, recordCardCollectionGain } from './achievements.js';
import {
  resolvePlayerDirectoryKey,
  syncDirectoryUpdateFromPlayer,
} from './player-directory.js';

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
 * Get player inventory as array of { cardId, quantity }
 */
export function getInventory(username) {
  const inv = db.get(`players/${username}/inventory`) || {};
  return Object.entries(inv).map(([cardId, quantity]) => ({ cardId, quantity }));
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
 * Delete a player and directory projection in one acknowledged multi-path update.
 * @param {string} username
 * @returns {Promise<{ ok: boolean, mode?: string, error?: string }>}
 */
export async function deletePlayer(username) {
  const playerKey = resolvePlayerDirectoryKey(username);
  return db.updateAcknowledged({
    [`players/${playerKey}`]: null,
    [`playerDirectory/${playerKey}`]: null,
  });
}
