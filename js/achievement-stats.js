/**
 * achievement-stats.js
 * Canonical player stat registry and additive stat writes.
 * Gameplay modules call bumpPlayerStat from achievements.js (not this file directly).
 */

import * as db from './database.js';
import * as cards from './cards.js';
const { getAuraTier } = cards;
import { getCosmeticDefinition, isCosmeticDefinitionActive } from './cosmetic-definitions.js';
import { ITEM_CATEGORIES } from './shop-definitions.js';
import { refreshUniqueCardsOwned } from './research.js';

/** Aura tier index when a card has reached maximum duplicate scaling. */
const MAX_AURA_TIER = 3;

/** Canonical profile slots counted toward cosmeticsEquipped (max 5). */
const EQUIPPED_COSMETIC_SLOTS = Object.freeze([
  { profileField: 'equippedAura', category: ITEM_CATEGORIES.AURA },
  { profileField: 'equippedBorder', category: ITEM_CATEGORIES.BORDER },
  { profileField: 'equippedBanner', category: ITEM_CATEGORIES.PROFILE_BANNER },
  { profileField: 'equippedBackground', category: ITEM_CATEGORIES.SHELL_BACKGROUND },
  { profileField: 'equippedTitle', category: ITEM_CATEGORIES.TITLE },
]);

/** Registry keys exposed to admin condition builder. */
export const STAT_KEYS = Object.freeze({
  TOTAL_RESEARCH_POINTS: 'totalResearchPoints',
  PROJECTS_COMPLETED: 'projectsCompleted',
  BREAKTHROUGHS_ACHIEVED: 'breakthroughsAchieved',
  UNIQUE_CARDS_OWNED: 'uniqueCardsOwned',
  TRADES_COMPLETED: 'tradesCompleted',
  PACKS_OPENED: 'packsOpened',
  SHOP_PURCHASES: 'shopPurchases',
  COSMETICS_UNLOCKED: 'cosmeticsUnlocked',
  COSMETICS_EQUIPPED: 'cosmeticsEquipped',
  UNIQUE_CARDS_DISCOVERED: 'uniqueCardsDiscovered',
  MAX_CARD_AURA_TIER: 'maxCardAuraTier',
  BEST_PROJECT_SUCCESS_STREAK: 'bestProjectSuccessStreak',
});

const STAT_PATHS = Object.freeze({
  [STAT_KEYS.TOTAL_RESEARCH_POINTS]: 'totalResearchPoints',
  [STAT_KEYS.PROJECTS_COMPLETED]: 'projectsCompleted',
  [STAT_KEYS.BREAKTHROUGHS_ACHIEVED]: 'researchStats/breakthroughs',
  [STAT_KEYS.UNIQUE_CARDS_OWNED]: 'stats/uniqueCardsOwned',
  [STAT_KEYS.TRADES_COMPLETED]: 'stats/tradesCompleted',
  [STAT_KEYS.PACKS_OPENED]: 'stats/packsOpened',
  [STAT_KEYS.SHOP_PURCHASES]: 'stats/shopPurchases',
  [STAT_KEYS.COSMETICS_UNLOCKED]: 'stats/cosmeticsUnlocked',
  [STAT_KEYS.COSMETICS_EQUIPPED]: 'stats/cosmeticsEquipped',
  [STAT_KEYS.UNIQUE_CARDS_DISCOVERED]: 'stats/uniqueCardsDiscovered',
  [STAT_KEYS.MAX_CARD_AURA_TIER]: 'stats/maxCardAuraTier',
  [STAT_KEYS.BEST_PROJECT_SUCCESS_STREAK]: 'stats/bestProjectSuccessStreak',
});

/** Stats that may be reset downward (current streak only). */
const RESETTABLE_STATS = Object.freeze(new Set([
  'stats/projectSuccessStreak',
]));

export const DEFAULT_ACHIEVEMENT_STATS = Object.freeze({
  packsOpened: 0,
  tradesCompleted: 0,
  uniqueCardsOwned: 0,
  shopPurchases: 0,
  cosmeticsUnlocked: 0,
  cosmeticsEquipped: 0,
  uniqueCardsDiscovered: 0,
  maxCardAuraTier: 0,
  projectSuccessStreak: 0,
  bestProjectSuccessStreak: 0,
});

export function listRegisteredStatKeys() {
  return Object.values(STAT_KEYS);
}

function resolvePath(statKey) {
  return STAT_PATHS[statKey] || null;
}

function readPath(username, path) {
  if (!username || !path) return 0;
  const val = db.get(`players/${username}/${path}`);
  return typeof val === 'number' && Number.isFinite(val) ? val : 0;
}

function writePath(username, path, value) {
  db.set(`players/${username}/${path}`, value);
}

/**
 * Read a registered stat for achievement evaluation.
 * @param {string} username
 * @param {string} statKey
 * @returns {number}
 */
export function getPlayerStat(username, statKey) {
  const path = resolvePath(statKey);
  if (!path) return 0;
  return readPath(username, path);
}

/**
 * Ensure additive stats object exists on player (idempotent).
 * @param {string} username
 */
export function ensureAchievementStats(username) {
  if (!username) return;
  const stats = db.get(`players/${username}/stats`);
  if (!stats || typeof stats !== 'object') {
    db.set(`players/${username}/stats`, { ...DEFAULT_ACHIEVEMENT_STATS });
    return;
  }
  for (const [key, defaultVal] of Object.entries(DEFAULT_ACHIEVEMENT_STATS)) {
    if (stats[key] === undefined || stats[key] === null) {
      db.set(`players/${username}/stats/${key}`, defaultVal);
    }
  }
}

/**
 * Count owned cards whose current aura tier is max (tier 3).
 * @param {string} username
 * @returns {number}
 */
export function computeCardsAtMaxAura(username) {
  if (!username) return 0;
  const inventory = db.get(`players/${username}/inventory`) || {};
  let count = 0;
  for (const [cardId, qty] of Object.entries(inventory)) {
    if (typeof qty !== 'number' || qty <= 0) continue;
    const card = cards.getCard(cardId);
    if (!card?.rarity) continue;
    if (getAuraTier(card.rarity, qty) === MAX_AURA_TIER) count++;
  }
  return count;
}

/**
 * Recompute stats/maxCardAuraTier from live inventory (can increase or decrease).
 * @param {string} username
 * @returns {{ changed: boolean, previous: number, value: number }}
 */
export function refreshMaxCardAuraTier(username) {
  if (!username) return { changed: false, previous: 0, value: 0 };
  ensureAchievementStats(username);
  const path = STAT_PATHS[STAT_KEYS.MAX_CARD_AURA_TIER];
  const previous = readPath(username, path);
  const value = computeCardsAtMaxAura(username);
  if (value !== previous) {
    writePath(username, path, value);
    return { changed: true, previous, value };
  }
  return { changed: false, previous, value };
}

/**
 * Count profile cosmetic slots with a valid, owned, active equipped item.
 * @param {string} username
 * @returns {number}
 */
export function computeEquippedCosmeticsCount(username) {
  if (!username) return 0;
  const profile = db.get(`players/${username}/profile`) || {};
  const owned = db.get(`players/${username}/cosmetics/owned`) || {};
  let count = 0;
  for (const { profileField, category } of EQUIPPED_COSMETIC_SLOTS) {
    const itemId = profile[profileField];
    if (!itemId || typeof itemId !== 'string') continue;
    const definition = getCosmeticDefinition(itemId);
    if (!isCosmeticDefinitionActive(definition) || definition.category !== category) continue;
    if (!owned[itemId]) continue;
    count++;
  }
  return count;
}

/**
 * Recompute stats/cosmeticsEquipped from live profile + ownership (can increase or decrease).
 * @param {string} username
 * @returns {{ changed: boolean, previous: number, value: number }}
 */
export function refreshCosmeticsEquipped(username) {
  if (!username) return { changed: false, previous: 0, value: 0 };
  ensureAchievementStats(username);
  const path = STAT_PATHS[STAT_KEYS.COSMETICS_EQUIPPED];
  const previous = readPath(username, path);
  const value = computeEquippedCosmeticsCount(username);
  if (value !== previous) {
    writePath(username, path, value);
    return { changed: true, previous, value };
  }
  return { changed: false, previous, value };
}

/**
 * Login / init self-heal for derived stats (no migration script).
 * @param {string} username
 * @returns {string[]} stat keys whose stored values changed
 */
export function healDerivedAchievementStats(username) {
  if (!username) return [];
  ensureAchievementStats(username);
  const changedKeys = [];
  const aura = refreshMaxCardAuraTier(username);
  if (aura.changed) changedKeys.push(STAT_KEYS.MAX_CARD_AURA_TIER);
  const equipped = refreshCosmeticsEquipped(username);
  if (equipped.changed) changedKeys.push(STAT_KEYS.COSMETICS_EQUIPPED);
  return changedKeys;
}

/**
 * Low-level stat write used by achievements.js after hooks.
 * @returns {{ changed: boolean, statKey: string, path: string, previous: number, value: number }}
 */
export function applyStatChange(username, statKey, delta = 1, options = {}) {
  const path = resolvePath(statKey);
  if (!username || !path) {
    return { changed: false, statKey, path: path || '', previous: 0, value: 0 };
  }

  ensureAchievementStats(username);

  if (statKey === STAT_KEYS.UNIQUE_CARDS_OWNED) {
    refreshUniqueCardsOwned(username);
    const value = readPath(username, path);
    return { changed: true, statKey, path, previous: value, value };
  }

  if (statKey === STAT_KEYS.MAX_CARD_AURA_TIER) {
    const previous = readPath(username, path);
    const refresh = refreshMaxCardAuraTier(username);
    return {
      changed: refresh.changed,
      statKey,
      path,
      previous: refresh.previous,
      value: refresh.value,
    };
  }

  if (statKey === STAT_KEYS.COSMETICS_EQUIPPED) {
    const previous = readPath(username, path);
    const refresh = refreshCosmeticsEquipped(username);
    return {
      changed: refresh.changed,
      statKey,
      path,
      previous: refresh.previous,
      value: refresh.value,
    };
  }

  const previous = readPath(username, path);
  let next = previous;

  if (options.setAbsolute === true && Number.isFinite(Number(options.value))) {
    next = Math.max(0, Math.floor(Number(options.value)));
  } else if (statKey === STAT_KEYS.BEST_PROJECT_SUCCESS_STREAK) {
    const candidate = Number.isFinite(Number(options.value))
      ? Math.floor(Number(options.value))
      : previous + Math.max(0, Math.floor(Number(delta) || 0));
    next = Math.max(previous, candidate);
  } else if (RESETTABLE_STATS.has(path)) {
    next = Math.max(0, Math.floor(Number(options.value ?? delta) || 0));
  } else {
    const safeDelta = Math.max(0, Math.floor(Number(delta) || 0));
    if (safeDelta <= 0) {
      return { changed: false, statKey, path, previous, value: previous };
    }
    next = previous + safeDelta;
  }

  if (next === previous) {
    return { changed: false, statKey, path, previous, value: previous };
  }

  writePath(username, path, next);
  return { changed: true, statKey, path, previous, value: next };
}

/**
 * After inventory changes, update discovery + derived inventory stats.
 * @param {string} username
 * @param {string} cardId
 * @param {number} newQuantity
 */
export function recordCardInventoryGain(username, cardId, newQuantity, options = {}) {
  if (!username || !cardId) return { changed: false, statKeys: [] };

  const statKeys = [];
  const previousQty = Math.max(0, Math.floor(Number(options.previousQuantity) || 0));
  const qty = Math.max(0, Math.floor(Number(newQuantity) || 0));

  if (previousQty === 0 && qty > 0) {
    const discovery = applyStatChange(username, STAT_KEYS.UNIQUE_CARDS_DISCOVERED, 1);
    if (discovery.changed) statKeys.push(STAT_KEYS.UNIQUE_CARDS_DISCOVERED);
  }

  refreshUniqueCardsOwned(username);
  statKeys.push(STAT_KEYS.UNIQUE_CARDS_OWNED);

  const aura = refreshMaxCardAuraTier(username);
  if (aura.changed) statKeys.push(STAT_KEYS.MAX_CARD_AURA_TIER);

  return { changed: statKeys.length > 0, statKeys };
}

/**
 * Recompute inventory-derived stats after removals/trades (no discovery bump).
 * @param {string} username
 * @returns {{ changed: boolean, statKeys: string[] }}
 */
export function recordCardInventoryChange(username) {
  if (!username) return { changed: false, statKeys: [] };

  const statKeys = [];
  refreshUniqueCardsOwned(username);
  statKeys.push(STAT_KEYS.UNIQUE_CARDS_OWNED);

  const aura = refreshMaxCardAuraTier(username);
  if (aura.changed) statKeys.push(STAT_KEYS.MAX_CARD_AURA_TIER);

  return { changed: statKeys.length > 0, statKeys };
}

/**
 * Project resolved — update streak + best streak (additive best only).
 * @param {string} username
 * @param {boolean} success
 */
export function recordProjectResolution(username, success) {
  if (!username) return { changed: false, statKeys: [] };

  ensureAchievementStats(username);
  const statKeys = [];

  if (success) {
    const prevStreak = readPath(username, 'stats/projectSuccessStreak');
    const nextStreak = prevStreak + 1;
    writePath(username, 'stats/projectSuccessStreak', nextStreak);

    const best = applyStatChange(username, STAT_KEYS.BEST_PROJECT_SUCCESS_STREAK, 0, {
      value: nextStreak,
    });
    if (best.changed) statKeys.push(STAT_KEYS.BEST_PROJECT_SUCCESS_STREAK);

    const projects = applyStatChange(username, STAT_KEYS.PROJECTS_COMPLETED, 1);
    if (projects.changed) statKeys.push(STAT_KEYS.PROJECTS_COMPLETED);
  } else {
    const prevStreak = readPath(username, 'stats/projectSuccessStreak');
    if (prevStreak !== 0) {
      writePath(username, 'stats/projectSuccessStreak', 0);
    }
  }

  return { changed: statKeys.length > 0, statKeys };
}

/**
 * Record breakthrough without double-counting project completion.
 */
export function recordBreakthrough(username) {
  return applyStatChange(username, STAT_KEYS.BREAKTHROUGHS_ACHIEVED, 1);
}
