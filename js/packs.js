/**
 * Packs Module - Pack creation, configuration, and opening
 *
 * Pack opening uses weighted random selection based on per-pack rarity odds
 * stored in /packs/{id}/odds. The config.packOdds fallback is @deprecated —
 * it only triggers if a pack somehow has no odds object. All packs created
 * via the admin UI always have explicit odds. Do NOT change live generation
 * behavior without a migration plan.
 */

import * as db from './database.js';
import * as config from './config.js';
import * as cards from './cards.js';
import * as player from './player.js';
import { bumpPlayerStat, STAT_KEYS } from './achievements.js';

/**
 * Create a new pack type
 */
export function createPackType({ name, cardsPerPack, odds, enabled }) {
  const id = 'pack_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
  const pack = {
    id,
    name: name || 'Basic Pack',
    cardsPerPack: cardsPerPack || 5,
    odds: odds || config.getPackOdds(), // @deprecated fallback — admin UI always provides odds
    enabled: enabled !== false,
    shop: {
      enabled: false,
      price: 0,
      weight: 0,
      rarity: 'common',
    },
    created: Date.now()
  };
  db.set(`packs/${id}`, pack);
  return id;
}

/**
 * Get a pack type by ID
 */
export function getPackType(id) {
  return db.get(`packs/${id}`);
}

/**
 * Get all pack types
 */
export function getAllPackTypes() {
  return db.getChildren('packs').map(p => p.value);
}

/**
 * Get enabled pack types
 */
export function getEnabledPackTypes() {
  return getAllPackTypes().filter(p => p.enabled);
}

/**
 * Update a pack type
 */
export function updatePackType(id, updates) {
  db.update(`packs/${id}`, updates);
}

/**
 * Delete a pack type
 */
export function deletePackType(id) {
  db.remove(`packs/${id}`);
}

/**
 * Toggle pack enabled state
 */
export function togglePack(id) {
  const pack = getPackType(id);
  if (pack) {
    db.update(`packs/${id}`, { enabled: !pack.enabled });
  }
}

/**
 * Open a pack for a player
 * Returns array of card objects received
 */
export function openPack(username, packId) {
  const packType = getPackType(packId);
  if (!packType) return { success: false, error: 'Pack type not found.' };

  // Check player has this pack
  const playerPacks = player.getPlayerPacks(username);
  if (!playerPacks[packId] || playerPacks[packId] <= 0) {
    return { success: false, error: 'You don\'t have this pack.' };
  }

  const allCards = cards.getAllCards();
  if (allCards.length === 0) {
    return { success: false, error: 'No cards in the database.' };
  }

  // Roll cards
  const rolledCards = [];
  const odds = packType.odds || config.getPackOdds(); // @deprecated fallback — each pack should have its own odds

  for (let i = 0; i < packType.cardsPerPack; i++) {
    const rarity = rollRarity(odds);
    const card = pickCardOfRarity(allCards, rarity);
    if (card) {
      rolledCards.push(card);
      player.addCard(username, card.id);
    }
  }

  // Remove pack from player
  player.removePack(username, packId);

  bumpPlayerStat(username, STAT_KEYS.PACKS_OPENED, 1);

  // Mark progression
  const prog = db.get(`players/${username}/progression`) || {};
  if (!prog.firstPackOpened) {
    db.update(`players/${username}/progression`, { firstPackOpened: true });
  }

  return { success: true, cards: rolledCards };
}

/**
 * Roll a rarity based on weighted odds
 */
function rollRarity(odds) {
  const total = Object.values(odds).reduce((sum, v) => sum + v, 0);
  let roll = Math.random() * total;

  // Go from rarest to most common for better UX feel
  const order = ['legendary', 'epic', 'rare', 'uncommon', 'common'];
  for (const rarity of order) {
    const weight = odds[rarity] || 0;
    if (roll < weight) return rarity;
    roll -= weight;
  }
  return 'common'; // Fallback
}

/**
 * Pick a random card of a given rarity
 * Falls back to any card if no cards of that rarity exist
 */
function pickCardOfRarity(allCards, rarity) {
  const matching = allCards.filter(c => c.rarity === rarity);
  if (matching.length > 0) {
    return matching[Math.floor(Math.random() * matching.length)];
  }
  // Fallback: any card
  return allCards[Math.floor(Math.random() * allCards.length)];
}

/**
 * Seed default pack types
 */
export function seedDefaultPacks() {
  if (getAllPackTypes().length > 0) return;

  createPackType({
    name: 'Standard Pack',
    cardsPerPack: 5,
    odds: { common: 50, uncommon: 25, rare: 15, epic: 8, legendary: 2 }
  });

  createPackType({
    name: 'Premium Pack',
    cardsPerPack: 5,
    odds: { common: 25, uncommon: 30, rare: 25, epic: 15, legendary: 5 }
  });

  createPackType({
    name: 'Scientist Pack',
    cardsPerPack: 3,
    odds: { common: 40, uncommon: 30, rare: 18, epic: 10, legendary: 2 }
  });
}
