/**
 * shop-generation.js
 * ==================
 * Phase 2C weighted shop generation engine.
 *
 * Architectural decisions (finalized):
 * - Weighted generation: each item has a weight property influencing selection probability.
 * - Without replacement: static items and synthetic cards cannot repeat the same item.id in one rotation.
 * - Synthetic packs may repeat the same shop_pack:{packId} up to maxPackSlots (weighted, not bucket-filled).
 * - Owned cosmetics excluded: cosmetics the player already owns are filtered out before generation.
 * - Configurable slot constraints: shop-config.js defines minimum/maximum slots per category;
 *   maxCardSlots and maxPackSlots are ceilings only, not guaranteed fill targets.
 *
 * Dependencies:
 *   - js/shop-definitions.js  (ITEM_DEFINITIONS, ITEM_TYPES, ITEM_CATEGORIES)
 *   - js/shop-config.js       (DEFAULT_SHOP_CONFIG slot constraints)
 *   - js/shop-state.js        (createShopSlot)
 *
 * Phase 2C note: this module is pure generation only. It performs no Firebase,
 * rendering, purchase, reroll, discount, or consumable mutation logic.
 */

import { SHOP_PACK_PREFIX } from './shop-catalog.js';
import { DEFAULT_SHOP_CONFIG, resolveMaxCardSlots, resolveMaxPackSlots } from './shop-config.js';
import { getItemDefinition, getMergedItemDefinitions } from './cosmetic-definitions.js';
import { ITEM_CATEGORIES, ITEM_TYPES } from './shop-definitions.js';
import { createShopRotationState, createShopSlot } from './shop-state.js';
import { getNextWeeklyRefreshTimestamp } from './weekly-research-pack.js';

export const REROLL_SCOPES = Object.freeze({
  ALL: 'all',
  COSMETIC: 'cosmetic',
  AURA: 'aura',
  BORDER: 'border',
  UTILITY: 'utility',
  PACK: 'pack',
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toPositiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function toNonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeConfig(config = DEFAULT_SHOP_CONFIG) {
  return {
    ...DEFAULT_SHOP_CONFIG,
    ...(isObject(config) ? config : {}),
  };
}

function getOwnedCosmeticIds(ownedCosmetics = {}) {
  if (Array.isArray(ownedCosmetics)) return new Set(ownedCosmetics);
  if (!isObject(ownedCosmetics)) return new Set();
  return new Set(
    Object.entries(ownedCosmetics)
      .filter(([, owned]) => Boolean(owned))
      .map(([itemId]) => itemId)
  );
}

function isCosmeticItem(item) {
  return item?.type === ITEM_TYPES.COSMETIC;
}

function isUtilityItem(item) {
  return item?.category === ITEM_CATEGORIES.UTILITY;
}

function isCardItem(item) {
  return item?.type === ITEM_TYPES.CARD || item?.category === ITEM_CATEGORIES.CARD;
}

function isPackItem(item) {
  return item?.type === ITEM_TYPES.PACK || item?.category === ITEM_CATEGORIES.PACK;
}

function isPackOrCardItem(item) {
  return isCardItem(item) || isPackItem(item);
}

function isSyntheticPackItemId(itemId) {
  return typeof itemId === 'string' && itemId.startsWith(SHOP_PACK_PREFIX);
}

/** Static items and cards dedupe by item.id; packs may repeat in a rotation. */
function usesRotationItemIdDedupe(itemOrItemId) {
  if (typeof itemOrItemId === 'string') {
    return !isSyntheticPackItemId(itemOrItemId);
  }
  return !isPackItem(itemOrItemId);
}

function isBlockedForRotationSelection(item, selectedIds) {
  return usesRotationItemIdDedupe(item) && selectedIds.has(item.id);
}

function resolveCatalogItem(itemId, catalog) {
  if (typeof catalog?.getItem === 'function') {
    return catalog.getItem(itemId);
  }
  return getItemDefinition(itemId) || null;
}

function uniqueByItemId(pool) {
  const seen = new Set();
  const unique = [];
  for (const item of Array.isArray(pool) ? pool : []) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

function normalizeExistingSlots(rawSlots) {
  if (Array.isArray(rawSlots)) return rawSlots;
  if (isObject(rawSlots)) return Object.values(rawSlots);
  return [];
}

export function getShopRotationSlots(currentRotation) {
  return normalizeExistingSlots(currentRotation?.slots);
}

function getPreservedFrozenSlots(currentRotation, maxSlots) {
  const rawSlots = normalizeExistingSlots(currentRotation?.slots);
  return rawSlots
    .filter(slot => slot?.frozen === true && slot?.purchased !== true && slot?.itemId)
    .slice(0, maxSlots)
    .map((slot, index) => createShopSlot({
      ...slot,
      id: slot.id ?? `slot_${index}`,
      frozen: true,
      purchased: false,
    }));
}

function createSlotFromItem(item, slotIndex) {
  return createShopSlot({
    id: `slot_${slotIndex}`,
    itemId: item.id,
    basePrice: toNonNegativeInteger(item.price, 0),
    currentPrice: toNonNegativeInteger(item.price, 0),
    currency: item.currency || 'rp',
    frozen: false,
    purchased: false,
    discountApplied: null,
  });
}

export function itemMatchesRerollScope(item, scope = REROLL_SCOPES.ALL) {
  switch (scope) {
    case REROLL_SCOPES.ALL:
      return true;
    case REROLL_SCOPES.COSMETIC:
      return isCosmeticItem(item);
    case REROLL_SCOPES.AURA:
      return item?.category === ITEM_CATEGORIES.AURA;
    case REROLL_SCOPES.BORDER:
      return item?.category === ITEM_CATEGORIES.BORDER;
    case REROLL_SCOPES.UTILITY:
      return isUtilityItem(item);
    case REROLL_SCOPES.PACK:
      return isPackOrCardItem(item);
    default:
      return false;
  }
}

export function getRotationItemIds(currentRotation, options = {}) {
  const replacingIndexes = new Set(options.replacingIndexes || []);
  return new Set(
    getShopRotationSlots(currentRotation)
      .filter((slot, index) => !replacingIndexes.has(index))
      .map(slot => slot?.itemId)
      .filter(itemId => itemId && usesRotationItemIdDedupe(itemId))
  );
}

export function buildScopedEligiblePool(
  player = {},
  currentRotation = {},
  scope = REROLL_SCOPES.ALL,
  config = DEFAULT_SHOP_CONFIG,
  options = {}
) {
  const excludedItemIds = getRotationItemIds(currentRotation, {
    replacingIndexes: options.replacingIndexes || [],
  });
  const pool = buildEligiblePool(player, config, {
    excludeItemIds: excludedItemIds,
    pool: options.pool,
  });
  return pool.filter(item => itemMatchesRerollScope(item, scope));
}

export function generateReplacementShopSlot(
  player = {},
  currentRotation = {},
  slotIndex = 0,
  scope = REROLL_SCOPES.ALL,
  config = DEFAULT_SHOP_CONFIG,
  options = {}
) {
  const slots = getShopRotationSlots(currentRotation);
  const currentSlot = slots[slotIndex];
  if (!currentSlot) return null;

  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const pool = buildScopedEligiblePool(player, currentRotation, scope, config, {
    replacingIndexes: [slotIndex],
    pool: options.pool,
  });
  const scopedPool = isSyntheticPackItemId(currentSlot.itemId)
    ? pool
    : pool.filter(item => item.id !== currentSlot.itemId);
  const [item] = weightedSelectWithoutReplacement(scopedPool, 1, rng);
  if (!item) return null;

  return createSlotFromItem(item, slotIndex);
}

// ---------------------------------------------------------------------------
// buildEligiblePool
// ---------------------------------------------------------------------------
/**
 * Builds the eligible item pool for shop generation.
 *
 * Behavior:
 * - Starts from all enabled ITEM_DEFINITIONS with positive weights.
 * - Removes items the player already owns (cosmetics), unless config allows them.
 * - Returns a flat array of eligible item entries with their weights intact.
 *
 * @param {Object} [player]
 * @param {Object} [config]
 * @param {Object} [options]
 * @param {Iterable<string>} [options.excludeItemIds]
 * @returns {Array}
 */
export function buildEligiblePool(player = {}, config = DEFAULT_SHOP_CONFIG, options = {}) {
  const effectiveConfig = normalizeConfig(config);
  const excluded = options.excludeItemIds instanceof Set
    ? options.excludeItemIds
    : new Set(options.excludeItemIds || []);

  const sourcePool = Array.isArray(options.pool) && options.pool.length > 0
    ? options.pool
    : Object.values(getMergedItemDefinitions()).filter(item => item?.deleted !== true);

  let pool = sourcePool
    .filter(item => item?.enabled !== false)
    .filter(item => item?.type !== ITEM_TYPES.COSMETIC || item.shopEnabled !== false)
    .filter(item => item?.id && !excluded.has(item.id))
    .filter(item => toPositiveNumber(item.weight, 0) > 0)
    .filter(item => Number.isFinite(Number(item.price)) && Number(item.price) >= 0)
    .map(item => ({
      ...item,
      weight: toPositiveNumber(item.weight, 0),
      price: toNonNegativeInteger(item.price, 0),
    }));

  if (!effectiveConfig.allowOwnedCosmeticsInShop) {
    pool = filterOwnedCosmetics(pool, player?.cosmetics?.owned, effectiveConfig);
  }

  return uniqueByItemId(pool);
}

// ---------------------------------------------------------------------------
// weightedSelectWithoutReplacement
// ---------------------------------------------------------------------------
/**
 * Selects N items from a weighted pool without replacement.
 *
 * Behavior:
 * - Accepts an eligible pool (array of { id, weight, ... }).
 * - Selects `count` items using weighted random sampling.
 * - Each selected item is removed from the pool before the next pick (without replacement).
 * - Returns the selected items in pick order.
 *
 * @param {Array} pool
 * @param {number} count
 * @param {Function} [rng]
 * @returns {Array}
 */
export function weightedSelectWithoutReplacement(pool = [], count = 0, rng = Math.random) {
  const remaining = uniqueByItemId(pool)
    .filter(item => toPositiveNumber(item.weight, 0) > 0)
    .map(item => ({ ...item }));
  const selected = [];
  const targetCount = Math.min(toNonNegativeInteger(count, 0), remaining.length);

  while (selected.length < targetCount) {
    const totalWeight = remaining.reduce((sum, item) => sum + toPositiveNumber(item.weight, 0), 0);
    if (totalWeight <= 0) break;

    const roll = clamp(Number(rng()), 0, 0.999999999) * totalWeight;
    let cursor = 0;
    let selectedIndex = remaining.length - 1;

    for (let i = 0; i < remaining.length; i += 1) {
      cursor += toPositiveNumber(remaining[i].weight, 0);
      if (roll < cursor) {
        selectedIndex = i;
        break;
      }
    }

    selected.push(remaining[selectedIndex]);
    remaining.splice(selectedIndex, 1);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// generateShopRotation
// ---------------------------------------------------------------------------
/**
 * Generates a full shop rotation (all slots for a refresh cycle).
 *
 * Behavior:
 * - Calls buildEligiblePool() to get candidates.
 * - Applies slot constraints from shop-config (min cosmetic slots, min utility slots, etc.).
 * - Uses weightedSelectWithoutReplacement() to fill each constrained bucket.
 * - Assembles final slot array via createShopSlot().
 * - Mixed weighted fill with per-type slot ceilings; static/cards unique by item.id, packs may repeat.
 *
 * @param {Object} [player]
 * @param {Object} [config]
 * @param {Object} [options]
 * @param {number} [options.now]
 * @param {Function} [options.rng]
 * @param {Object} [options.currentRotation]
 * @returns {Object}
 */
export function generateShopRotation(player = {}, config = DEFAULT_SHOP_CONFIG, options = {}) {
  const effectiveConfig = normalizeConfig(config);
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const slotCount = clamp(toNonNegativeInteger(effectiveConfig.shopSlotCount, DEFAULT_SHOP_CONFIG.shopSlotCount), 3, 9);
  const currentRotation = options.currentRotation || player?.shop?.currentRotation;
  const catalog = options.catalog || null;
  const preservedSlots = getPreservedFrozenSlots(currentRotation, slotCount);
  const preservedItems = preservedSlots
    .map(slot => resolveCatalogItem(slot.itemId, catalog))
    .filter(Boolean);
  const preservedItemIds = new Set(
    preservedSlots
      .map(slot => slot.itemId)
      .filter(itemId => itemId && usesRotationItemIdDedupe(itemId))
  );
  const pool = buildEligiblePool(player, effectiveConfig, {
    excludeItemIds: preservedItemIds,
    pool: options.pool || catalog?.pool,
  });
  const plan = applySlotConstraints(pool, effectiveConfig, {
    availableSlots: Math.max(0, slotCount - preservedSlots.length),
    existingUtilitySlots: preservedItems.filter(isUtilityItem).length,
    existingCosmeticSlots: preservedItems.filter(isCosmeticItem).length,
    existingCardSlots: preservedItems.filter(isCardItem).length,
    existingPackSlots: preservedItems.filter(isPackItem).length,
  });

  const selected = [];
  const selectedIds = new Set(preservedItemIds);

  function selectFrom(predicate, count) {
    const candidates = pool.filter(item => predicate(item) && !isBlockedForRotationSelection(item, selectedIds));
    const picks = weightedSelectWithoutReplacement(candidates, count, rng);
    for (const pick of picks) {
      selected.push(pick);
      if (usesRotationItemIdDedupe(pick)) {
        selectedIds.add(pick.id);
      }
    }
  }

  selectFrom(isUtilityItem, plan.utilitySlots);
  selectFrom(isCosmeticItem, plan.cosmeticSlots);

  while (selected.length < plan.totalSlots) {
    const cardSelected = plan.existingCardSlots + selected.filter(isCardItem).length;
    const packSelected = plan.existingPackSlots + selected.filter(isPackItem).length;
    const candidates = pool.filter(item => {
      if (isBlockedForRotationSelection(item, selectedIds)) return false;
      if (isCardItem(item)) return cardSelected < plan.maxCardSlots;
      if (isPackItem(item)) return packSelected < plan.maxPackSlots;
      return true;
    });
    const [pick] = weightedSelectWithoutReplacement(candidates, 1, rng);
    if (!pick) break;
    selected.push(pick);
    if (usesRotationItemIdDedupe(pick)) {
      selectedIds.add(pick.id);
    }
  }

  const slots = [...preservedSlots, ...selected.map((item, index) => (
    createSlotFromItem(item, preservedSlots.length + index)
  ))].slice(0, slotCount);

  return createShopRotationState({
    slots,
    generatedAt: now,
    refreshAt: getNextWeeklyRefreshTimestamp(now),
    generationVersion: effectiveConfig.generationVersion ?? DEFAULT_SHOP_CONFIG.generationVersion,
  });
}

// ---------------------------------------------------------------------------
// filterOwnedCosmetics
// ---------------------------------------------------------------------------
/**
 * Filters out cosmetics the player already owns from a candidate pool.
 *
 * Behavior:
 * - Accepts a pool array and a set/array of owned cosmetic IDs.
 * - Returns a new array with owned cosmetics removed.
 * - Non-cosmetic items pass through unfiltered.
 *
 * @param {Array} pool
 * @param {Object|Array|Set} ownedCosmetics
 * @param {Object} [config]
 * @returns {Array}
 */
export function filterOwnedCosmetics(pool = [], ownedCosmetics = {}, config = DEFAULT_SHOP_CONFIG) {
  const effectiveConfig = normalizeConfig(config);
  if (effectiveConfig.allowOwnedCosmeticsInShop) {
    return [...(Array.isArray(pool) ? pool : [])];
  }

  const ownedIds = ownedCosmetics instanceof Set
    ? ownedCosmetics
    : getOwnedCosmeticIds(ownedCosmetics);

  return (Array.isArray(pool) ? pool : []).filter(item => {
    if (!isCosmeticItem(item)) return true;
    return !ownedIds.has(item.id);
  });
}

// ---------------------------------------------------------------------------
// applySlotConstraints
// ---------------------------------------------------------------------------
/**
 * Enforces slot-type constraints defined in shop-config.
 *
 * Behavior:
 * - Reads minimumCosmeticSlots, minimumUtilitySlots, maxCardSlots, and maxPackSlots from config.
 * - Partitions the eligible pool into category buckets.
 * - Ensures each bucket meets its minimum before filling remaining slots freely.
 * - Returns a constraint plan object describing how many slots each category receives.
 *
 * @param {Array} pool
 * @param {Object} [config]
 * @param {Object} [options]
 * @param {number} [options.availableSlots]
 * @param {number} [options.existingUtilitySlots]
 * @param {number} [options.existingCosmeticSlots]
 * @param {number} [options.existingPackAndCardSlots]
 * @returns {Object}
 */
export function applySlotConstraints(pool = [], config = DEFAULT_SHOP_CONFIG, options = {}) {
  const effectiveConfig = normalizeConfig(config);
  const defaultSlotCount = clamp(
    toNonNegativeInteger(effectiveConfig.shopSlotCount, DEFAULT_SHOP_CONFIG.shopSlotCount),
    3,
    9
  );
  const totalSlots = clamp(
    toNonNegativeInteger(options.availableSlots, defaultSlotCount),
    0,
    defaultSlotCount
  );

  const uniquePool = uniqueByItemId(pool);
  const utilityAvailable = uniquePool.filter(isUtilityItem).length;
  const cosmeticAvailable = uniquePool.filter(isCosmeticItem).length;
  const cardAvailable = uniquePool.filter(isCardItem).length;
  const packAvailable = uniquePool.filter(isPackItem).length;
  const existingUtilitySlots = toNonNegativeInteger(options.existingUtilitySlots, 0);
  const existingCosmeticSlots = toNonNegativeInteger(options.existingCosmeticSlots, 0);
  const existingCardSlots = toNonNegativeInteger(options.existingCardSlots, 0);
  const existingPackSlots = toNonNegativeInteger(options.existingPackSlots, 0);
  const legacyPackAndCardSlots = toNonNegativeInteger(options.existingPackAndCardSlots, 0);

  let remaining = totalSlots;
  const neededUtilitySlots = Math.max(
    0,
    toNonNegativeInteger(effectiveConfig.minimumUtilitySlots, DEFAULT_SHOP_CONFIG.minimumUtilitySlots) - existingUtilitySlots
  );
  const utilitySlots = Math.min(
    remaining,
    utilityAvailable,
    neededUtilitySlots
  );
  remaining -= utilitySlots;

  const neededCosmeticSlots = Math.max(
    0,
    toNonNegativeInteger(effectiveConfig.minimumCosmeticSlots, DEFAULT_SHOP_CONFIG.minimumCosmeticSlots) - existingCosmeticSlots
  );
  const cosmeticSlots = Math.min(
    remaining,
    cosmeticAvailable,
    neededCosmeticSlots
  );
  remaining -= cosmeticSlots;

  const maxCardSlots = resolveMaxCardSlots(effectiveConfig);
  const maxPackSlots = resolveMaxPackSlots(effectiveConfig);
  const resolvedExistingCardSlots = existingCardSlots || (legacyPackAndCardSlots > 0 ? legacyPackAndCardSlots : 0);
  const resolvedExistingPackSlots = existingPackSlots || (legacyPackAndCardSlots > 0 ? legacyPackAndCardSlots : 0);

  return {
    totalSlots,
    existingCardSlots: resolvedExistingCardSlots,
    existingPackSlots: resolvedExistingPackSlots,
    utilitySlots,
    cosmeticSlots,
    maxCardSlots: Math.min(
      totalSlots + resolvedExistingCardSlots,
      cardAvailable + resolvedExistingCardSlots,
      maxCardSlots
    ),
    // Pack ceiling is slot-count only; identical shop_pack ids may repeat (not limited by packAvailable).
    maxPackSlots: Math.min(
      totalSlots + resolvedExistingPackSlots,
      maxPackSlots
    ),
    freeSlots: remaining,
  };
}
