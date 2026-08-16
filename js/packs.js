/**
 * Packs Module - Pack creation, configuration, and opening
 *
 * Pack opening uses weighted random selection based on per-pack rarity odds
 * stored in /packs/{id}/odds. The config.packOdds fallback is @deprecated —
 * it only triggers if a pack somehow has no odds object. All packs created
 * via the admin UI always have explicit odds. Do NOT change live generation
 * behavior without a migration plan.
 *
 * Pack-open persistence (batched):
 *   1. Acquire cross-tab lock when navigator.locks is available
 *   2. Revalidate pack ownership from the current in-memory cache (not a
 *      guaranteed server-fresh read — Option B residual race with same-session
 *      tabs that bypass locks is documented in ARCHITECTURE.md)
 *   3. Roll all cards once (immutable reveal list)
 *   4. Build absolute multi-path updates (pack, inventory aggregates, stats,
 *      progression, achievement progress/unlock entries via pure planner)
 *   5. Commit with updateAcknowledged — reveal only after success
 */

import * as db from './database.js';
import * as config from './config.js';
import * as cards from './cards.js';
import {
  STAT_KEYS,
  planAchievementUpdatesForStats,
} from './achievements.js';
import { getPlayerStat, computeCardsAtMaxAuraFromInventory } from './achievement-stats.js';
import { computeUniqueCardsOwnedFromInventory } from './research.js';
import {
  STAT_TYPES,
  buildLeaderboardSummaryPathsForChangedStats,
  playerLikeWithStatOverlay,
} from './leaderboard-summaries.js';

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
 * Serialize pack opens for the same username+packId across tabs when
 * navigator.locks is available; otherwise run immediately (per-tab UI mutex
 * still applies in openPackUI).
 * @template T
 * @param {string} username
 * @param {string} packId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withPackOpenLock(username, packId, fn) {
  const lockName = `qc-pack-open:${username}:${packId}`;
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(lockName, { mode: 'exclusive' }, () => fn());
  }
  return fn();
}

/**
 * Build absolute multi-path updates for one pack open from cache snapshot + rolls.
 * @returns {{ updates: Object, rolledCards: Object[], statKeys: string[], unlocked: string[], notified: string[] } | { error: string }}
 */
function buildPackOpenPlan(username, packId, packType) {
  const ownedQty = Number(db.get(`players/${username}/packs/${packId}`)) || 0;
  if (ownedQty <= 0) {
    return { error: "You don't have this pack." };
  }

  const allCards = cards.getAllCards();
  if (allCards.length === 0) {
    return { error: 'No cards in the database.' };
  }

  const odds = packType.odds || config.getPackOdds();
  const rolledCards = [];
  for (let i = 0; i < packType.cardsPerPack; i++) {
    const rarity = rollRarity(odds);
    const card = pickCardOfRarity(allCards, rarity);
    if (card) rolledCards.push(card);
  }

  if (rolledCards.length === 0) {
    return { error: 'No cards in the database.' };
  }

  // Aggregate duplicate rolls: A,A,B → { A:2, B:1 }
  const gainsByCardId = {};
  for (const card of rolledCards) {
    gainsByCardId[card.id] = (gainsByCardId[card.id] || 0) + 1;
  }

  const prevInventory = { ...(db.get(`players/${username}/inventory`) || {}) };
  const nextInventory = { ...prevInventory };
  let discoveryDelta = 0;

  const updates = {};
  for (const [cardId, gain] of Object.entries(gainsByCardId)) {
    const prevQty = typeof prevInventory[cardId] === 'number' ? prevInventory[cardId] : 0;
    const nextQty = prevQty + gain;
    nextInventory[cardId] = nextQty;
    updates[`players/${username}/inventory/${cardId}`] = nextQty;
    if (prevQty === 0 && nextQty > 0) discoveryDelta += 1;
  }

  const nextPackQty = ownedQty - 1;
  updates[`players/${username}/packs/${packId}`] = nextPackQty <= 0 ? null : nextPackQty;

  const prevCardsCollected = Number(db.get(`players/${username}/stats/cardsCollected`)) || 0;
  updates[`players/${username}/stats/cardsCollected`] = prevCardsCollected + rolledCards.length;

  const prevPacksOpened = getPlayerStat(username, STAT_KEYS.PACKS_OPENED);
  const nextPacksOpened = prevPacksOpened + 1;
  updates[`players/${username}/stats/packsOpened`] = nextPacksOpened;

  const prevDiscovered = getPlayerStat(username, STAT_KEYS.UNIQUE_CARDS_DISCOVERED);
  const nextDiscovered = prevDiscovered + discoveryDelta;
  if (discoveryDelta > 0) {
    updates[`players/${username}/stats/uniqueCardsDiscovered`] = nextDiscovered;
  }

  const prevUniqueOwned = getPlayerStat(username, STAT_KEYS.UNIQUE_CARDS_OWNED);
  const nextUniqueOwned = computeUniqueCardsOwnedFromInventory(nextInventory);
  if (nextUniqueOwned !== prevUniqueOwned) {
    updates[`players/${username}/stats/uniqueCardsOwned`] = nextUniqueOwned;
  }

  const prevAura = getPlayerStat(username, STAT_KEYS.MAX_CARD_AURA_TIER);
  const nextAura = computeCardsAtMaxAuraFromInventory(nextInventory);
  if (nextAura !== prevAura) {
    updates[`players/${username}/stats/maxCardAuraTier`] = nextAura;
  }

  const prog = db.get(`players/${username}/progression`) || {};
  if (!prog.firstPackOpened) {
    updates[`players/${username}/progression/firstPackOpened`] = true;
  }

  const plannedStatValues = {
    [STAT_KEYS.PACKS_OPENED]: nextPacksOpened,
    [STAT_KEYS.UNIQUE_CARDS_DISCOVERED]: nextDiscovered,
    [STAT_KEYS.UNIQUE_CARDS_OWNED]: nextUniqueOwned,
    [STAT_KEYS.MAX_CARD_AURA_TIER]: nextAura,
  };

  const statKeys = [STAT_KEYS.PACKS_OPENED, STAT_KEYS.UNIQUE_CARDS_OWNED];
  if (discoveryDelta > 0) statKeys.push(STAT_KEYS.UNIQUE_CARDS_DISCOVERED);
  if (nextAura !== prevAura) statKeys.push(STAT_KEYS.MAX_CARD_AURA_TIER);

  const getStat = (statKey) => {
    if (Object.prototype.hasOwnProperty.call(plannedStatValues, statKey)) {
      return plannedStatValues[statKey];
    }
    return getPlayerStat(username, statKey);
  };

  const achPlan = planAchievementUpdatesForStats(username, statKeys, { getStat });
  Object.assign(updates, achPlan.updates);

  const playerBefore = db.get(`players/${username}`) || {};
  const playerLike = playerLikeWithStatOverlay(playerBefore, {
    [STAT_TYPES.PACKS_OPENED]: nextPacksOpened,
    [STAT_TYPES.UNIQUE_CARDS_OWNED]: nextUniqueOwned,
  });
  Object.assign(
    updates,
    buildLeaderboardSummaryPathsForChangedStats(
      username,
      playerLike,
      [STAT_TYPES.PACKS_OPENED, STAT_TYPES.UNIQUE_CARDS_OWNED],
    ),
  );

  return {
    updates,
    rolledCards,
    statKeys,
    unlocked: achPlan.unlocked,
    notified: achPlan.notified,
  };
}

/**
 * Open a pack for a player (acknowledged multi-path commit).
 * Reveal only after this resolves successfully.
 * @returns {Promise<{ success: boolean, cards?: Object[], unlocked?: string[], notified?: string[], error?: string, writeCount?: number }>}
 */
export async function openPack(username, packId) {
  if (!username || !packId) {
    return { success: false, error: 'Invalid pack open request.' };
  }

  return withPackOpenLock(username, packId, async () => {
    const packType = getPackType(packId);
    if (!packType) return { success: false, error: 'Pack type not found.' };

    // Revalidate ownership after lock — still cache state, not server-fresh.
    const plan = buildPackOpenPlan(username, packId, packType);
    if (plan.error) return { success: false, error: plan.error };

    const ack = await db.updateAcknowledged(plan.updates);
    if (!ack.ok) {
      return {
        success: false,
        error: ack.error || 'Could not save pack opening. Check your connection and try again.',
      };
    }

    return {
      success: true,
      cards: plan.rolledCards,
      unlocked: plan.unlocked,
      notified: plan.notified,
      writeCount: 1,
    };
  });
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
