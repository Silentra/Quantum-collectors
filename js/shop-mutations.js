/**
 * shop-mutations.js
 * =================
 * Phase 2C shop state mutation/lifecycle layer.
 *
 * Architectural decisions (finalized):
 * - Atomic mutation strategy: every mutation is a discrete, isolated operation.
 *   No partial writes — either the full mutation succeeds or nothing changes.
 * - Validate → Mutate → Persist → Rerender flow:
 *   1. Call the corresponding shop-validation.js guard.
 *   2. Apply the state change in memory.
 *   3. Persist to Firebase (future).
 *   4. Trigger UI rerender (future).
 *   If any step fails, the mutation aborts and state is not changed.
 * - Purchased slots lock permanently for the current rotation.
 *   Once purchased, a slot cannot be rerolled, frozen, or discounted.
 * - Consumables consumed only on successful persistence:
 *   The consumable item is deducted from the player's inventory only AFTER
 *   Firebase persistence confirms success, preventing loss on network failure.
 *
 * Dependencies:
 *   - js/shop-validation.js  (canPurchaseItem, canRerollSlot, etc.)
 *   - js/shop-state.js       (state shape helpers)
 *   - js/shop-config.js      (refresh cadence, generation version)
 *   - js/shop-generation.js  (generateShopRotation)
 *
 * Phase 3 note: refresh, RP-only reroll, and state-only freeze mutations live
 * here. This module still performs NO purchase execution, consumable token
 * consumption, discount execution, gameplay rewards, UI rendering, or reroll
 * reset behavior.
 */

import * as db from './database.js';
import { DEFAULT_SHOP_CONFIG, getShopConfig, resolveShopRuntimeConfig } from './shop-config.js';
import { buildShopCatalog } from './shop-catalog.js';
import { ITEM_TYPES } from './shop-definitions.js';
import {
  REROLL_SCOPES,
  generateReplacementShopSlot,
  generateShopRotation,
  getShopRotationSlots,
} from './shop-generation.js';
import { createDiscountApplied, createPurchaseHistoryEntry } from './shop-state.js';
import {
  DEFAULT_SHOP_USAGE,
  PURCHASE_HISTORY_MAX,
  normalizePurchaseHistory,
} from './player-schema.js';
import { generateAvailableProjects } from './project-pool.js';
import { getLastWeeklyRefreshTimestamp } from './weekly-research-pack.js';
import { bumpPlayerStat, STAT_KEYS } from './achievements.js';
import {
  canApplyDiscount,
  canFreezeSlot,
  canGenerateAdditionalProject,
  canGrantFreezeAllowance,
  canEquipCosmetic,
  canFeatureAchievement,
  canFeatureCard,
  canPurchaseItem,
  canRerollRotation,
  canRerollSlot,
  canUnequipCosmetic,
  canUnfeatureAchievement,
  canUnfeatureCard,
} from './shop-validation.js';
import {
  normalizeIdentityAccent,
  normalizeProfileBodyTextColor,
  normalizeProfileHeaderTextColor,
} from './shell-theme.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSlots(rawSlots) {
  if (Array.isArray(rawSlots)) return rawSlots;
  if (isObject(rawSlots)) return Object.values(rawSlots);
  return [];
}

function getShopPlayerSnapshot(username) {
  const shop = db.get(`players/${username}/shop`);
  const currencies = db.get(`players/${username}/currencies`);
  const shopUsage = db.get(`players/${username}/shopUsage`);
  const cosmetics = db.get(`players/${username}/cosmetics`);

  if (!shop && !currencies && !shopUsage && !cosmetics) return null;

  return {
    shop: isObject(shop) ? shop : {},
    currencies: isObject(currencies) ? currencies : {},
    shopUsage: isObject(shopUsage) ? shopUsage : {},
    cosmetics: isObject(cosmetics) ? cosmetics : {},
  };
}

function getCurrentRotation(player) {
  return isObject(player?.shop?.currentRotation) ? player.shop.currentRotation : null;
}

function getEconomySnapshot(username) {
  const shop = db.get(`players/${username}/shop`);
  const currentRotation = db.get(`players/${username}/shop/currentRotation`);
  const currencies = db.get(`players/${username}/currencies`);
  const cosmetics = db.get(`players/${username}/cosmetics`);
  const items = db.get(`players/${username}/items`);
  const inventory = db.get(`players/${username}/inventory`);
  const playerPacks = db.get(`players/${username}/packs`);
  const purchaseHistory = db.get(`players/${username}/purchaseHistory`);

  if (!shop && !currentRotation && !currencies && !cosmetics && !items && purchaseHistory === null) {
    return null;
  }

  return {
    shop: {
      ...(isObject(shop) ? shop : {}),
      ...(isObject(currentRotation) ? { currentRotation } : {}),
    },
    currencies: isObject(currencies) ? currencies : {},
    cosmetics: isObject(cosmetics) ? cosmetics : {},
    items: isObject(items) ? items : {},
    inventory: isObject(inventory) ? inventory : {},
    packs: isObject(playerPacks) ? playerPacks : {},
    purchaseHistory: normalizePurchaseHistory(purchaseHistory),
  };
}

function getShopCatalogForConfig(config = getShopConfig()) {
  return buildShopCatalog(config);
}

function getCurrentItemQuantity(username, itemId) {
  return Math.max(0, Math.floor(Number(db.get(`players/${username}/items/${itemId}`) || 0)));
}

function getGrantQuantity(itemDefinition, options = {}) {
  const configuredQuantity = Number(options.quantity ?? itemDefinition?.grantQuantity ?? itemDefinition?.behaviorConfig?.quantity ?? 1);
  if (!Number.isFinite(configuredQuantity) || configuredQuantity <= 0) return 1;
  return Math.floor(configuredQuantity);
}

function appendPurchaseHistoryEntry(rawHistory, entry) {
  const history = normalizePurchaseHistory(rawHistory);
  return [...history, entry].slice(-PURCHASE_HISTORY_MAX);
}

function persistPurchasePlan(username, writePlan) {
  for (const [path, value] of writePlan) {
    db.set(`players/${username}/${path}`, value);
  }
}

function buildPurchaseHistoryEntry({ itemDefinition, price, currency, slot, rotation, now }) {
  return createPurchaseHistoryEntry({
    itemId: itemDefinition.id,
    pricePaid: price,
    currency,
    purchasedAt: new Date(now).toISOString(),
    source: 'shop',
    slotId: slot?.id ?? null,
    rotationGeneratedAt: rotation?.generatedAt ?? 0,
  });
}

function buildGrantWrite(snapshot, itemDefinition, options = {}) {
  if (itemDefinition.type === ITEM_TYPES.COSMETIC) {
    return {
      path: `cosmetics/owned/${itemDefinition.id}`,
      value: true,
      quantity: 1,
    };
  }

  if (itemDefinition.type === ITEM_TYPES.CONSUMABLE) {
    const quantity = getGrantQuantity(itemDefinition, options);
    const currentQuantity = Math.max(0, Math.floor(Number(snapshot.items?.[itemDefinition.id] || 0)));
    return {
      path: `items/${itemDefinition.id}`,
      value: currentQuantity + quantity,
      quantity,
    };
  }

  if (itemDefinition.type === ITEM_TYPES.CARD) {
    const cardId = itemDefinition.sourceId || itemDefinition.id;
    const quantity = getGrantQuantity(itemDefinition, options);
    const currentQuantity = Math.max(0, Math.floor(Number(snapshot.inventory?.[cardId] || 0)));
    return {
      path: `inventory/${cardId}`,
      value: currentQuantity + quantity,
      quantity,
    };
  }

  if (itemDefinition.type === ITEM_TYPES.PACK) {
    const packId = itemDefinition.sourceId || itemDefinition.id;
    const quantity = getGrantQuantity(itemDefinition, options);
    const currentQuantity = Math.max(0, Math.floor(Number(snapshot.packs?.[packId] || 0)));
    return {
      path: `packs/${packId}`,
      value: currentQuantity + quantity,
      quantity,
    };
  }

  return null;
}

export function grantConsumable(username, itemId, quantity = 1) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }
  if (!itemId || typeof itemId !== 'string') {
    return { success: false, reason: 'invalid_item_id' };
  }

  const safeQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
  const currentQuantity = getCurrentItemQuantity(username, itemId);
  const nextQuantity = currentQuantity + safeQuantity;
  db.set(`players/${username}/items/${itemId}`, nextQuantity);

  return { success: true, itemId, quantity: safeQuantity, nextQuantity };
}

export function consumeItem(username, itemId, quantity = 1) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }
  if (!itemId || typeof itemId !== 'string') {
    return { success: false, reason: 'invalid_item_id' };
  }

  const safeQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
  const currentQuantity = getCurrentItemQuantity(username, itemId);
  if (currentQuantity < safeQuantity) {
    return { success: false, reason: 'insufficient_item_quantity', currentQuantity, quantity: safeQuantity };
  }

  const nextQuantity = currentQuantity - safeQuantity;
  db.set(`players/${username}/items/${itemId}`, nextQuantity);

  return { success: true, itemId, quantity: safeQuantity, nextQuantity };
}

export function unlockCosmetic(username, itemId) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }
  if (!itemId || typeof itemId !== 'string') {
    return { success: false, reason: 'invalid_item_id' };
  }

  const wasOwned = db.get(`players/${username}/cosmetics/owned/${itemId}`) === true;
  db.set(`players/${username}/cosmetics/owned/${itemId}`, true);
  if (!wasOwned) {
    bumpPlayerStat(username, STAT_KEYS.COSMETICS_UNLOCKED, 1);
  }
  return { success: true, itemId };
}

function getProjectPlayerSnapshot(username) {
  const projects = db.get(`players/${username}/projects`);
  const totalResearchPoints = db.get(`players/${username}/totalResearchPoints`);

  if (!Array.isArray(projects) && totalResearchPoints === null) return null;

  return {
    projects: Array.isArray(projects) ? projects : [],
    totalResearchPoints: Number(totalResearchPoints || 0),
  };
}

function getProfilePlayerSnapshot(username) {
  const profile = db.get(`players/${username}/profile`);
  const cosmetics = db.get(`players/${username}/cosmetics`);
  const achievements = db.get(`players/${username}/achievements`);
  const badges = db.get(`players/${username}/badges`);

  if (!profile && !cosmetics && !achievements && !badges) return null;

  return {
    profile: isObject(profile) ? profile : {},
    cosmetics: isObject(cosmetics) ? cosmetics : {},
    achievements: isObject(achievements) ? achievements : {},
    badges: isObject(badges) ? badges : {},
  };
}

function getProfileCardSnapshot(username, cardId) {
  const snapshot = getProfilePlayerSnapshot(username);
  if (!snapshot) return null;
  const quantity = db.get(`players/${username}/inventory/${cardId}`) || 0;
  return {
    ...snapshot,
    inventory: { [cardId]: quantity },
  };
}

function hasActiveRotation(player, config, now) {
  const rotation = getCurrentRotation(player);
  if (!rotation) return false;

  const slots = normalizeSlots(rotation.slots);
  const refreshAt = Number(rotation.refreshAt || 0);
  const generatedAt = Number(rotation.generatedAt || 0);
  const expectedVersion = config.generationVersion ?? DEFAULT_SHOP_CONFIG.generationVersion;
  const lastWeeklyBoundary = getLastWeeklyRefreshTimestamp(now);
  const isWithinWeeklyCycle = generatedAt >= lastWeeklyBoundary;

  return slots.length > 0 &&
    refreshAt > now &&
    isWithinWeeklyCycle &&
    rotation.generationVersion === expectedVersion;
}

// ---------------------------------------------------------------------------
// ensureShopRotation
// ---------------------------------------------------------------------------
/**
 * Ensures a player has a current generated shop rotation.
 *
 * Phase 2C scope:
 * - Generates and persists full rotations only.
 * - Preserves eligible frozen slots through generateShopRotation().
 * - Resets rotation-scoped usage only when a new full rotation is written.
 * - Does NOT update or derive rerollResetAt behavior.
 *
 * @param {string} username
 * @param {Object} [options]
 * @param {boolean} [options.force=false] Force generation even if current rotation is active.
 * @param {Object} [options.config] Optional shop config override.
 * @param {number} [options.now] Optional timestamp for deterministic generation.
 * @param {Function} [options.rng] Optional RNG for deterministic selection.
 * @returns {Object}
 */
export function ensureShopRotation(username, options = {}) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getShopPlayerSnapshot(username);
  if (!player) {
    return { success: false, reason: 'player_not_found' };
  }

  const config = resolveShopRuntimeConfig(options.config);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();

  if (!options.force && hasActiveRotation(player, config, now)) {
    return {
      success: true,
      generated: false,
      rotation: getCurrentRotation(player),
    };
  }

  const catalog = getShopCatalogForConfig(config);
  const rotation = generateShopRotation(player, config, {
    now,
    rng: options.rng,
    currentRotation: getCurrentRotation(player),
    catalog,
    pool: catalog.pool,
  });

  db.set(`players/${username}/shop/currentRotation`, rotation);
  db.set(`players/${username}/shopUsage`, { ...DEFAULT_SHOP_USAGE });

  return {
    success: true,
    generated: true,
    rotation,
  };
}

// ---------------------------------------------------------------------------
// refreshShopRotation
// ---------------------------------------------------------------------------
/**
 * Forces a full shop refresh using the same safe lifecycle as ensureShopRotation.
 *
 * @param {string} username
 * @param {Object} [options]
 * @returns {Object}
 */
export function refreshShopRotation(username, options = {}) {
  return ensureShopRotation(username, {
    ...options,
    force: true,
  });
}

// ---------------------------------------------------------------------------
// purchaseShopItem
// ---------------------------------------------------------------------------
/**
 * Purchases an item from a specific shop slot.
 *
 * Layer 2 flow:
 * 1. canPurchaseItem() validation.
 * 2. Deduct RP from player balance.
 * 3. Add item to player inventory/cosmetics.
 * 4. Mark slot as purchased (locked for rotation).
 * 5. Append capped purchase history.
 * 6. Persist scoped economy paths.
 *
 * @param {string} username
 * @param {number} slotIndex
 * @param {Object} [options]
 * @returns {Object}
 */
export function purchaseShopItem(username, slotIndex, options = {}) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const snapshot = getEconomySnapshot(username);
  if (!snapshot) {
    return { success: false, reason: 'player_not_found' };
  }

  const config = resolveShopRuntimeConfig(options.config);
  const catalog = getShopCatalogForConfig(config);
  const validation = canPurchaseItem(snapshot, slotIndex, { getItem: catalog.getItem });
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  const currentRotation = getCurrentRotation(snapshot);
  const slots = getShopRotationSlots(currentRotation);
  const nextSlots = [...slots];
  const purchasedSlot = {
    ...nextSlots[validation.slotIndex],
    purchased: true,
  };
  nextSlots[validation.slotIndex] = purchasedSlot;

  const grantWrite = buildGrantWrite(snapshot, validation.itemDefinition, options);
  if (!grantWrite) {
    return {
      success: false,
      reason: 'unsupported_item_type',
      itemType: validation.itemDefinition.type,
    };
  }

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const nextRp = Number(snapshot.currencies?.currentResearchPoints || 0) - validation.price;
  const historyEntry = buildPurchaseHistoryEntry({
    itemDefinition: validation.itemDefinition,
    price: validation.price,
    currency: validation.currency,
    slot: purchasedSlot,
    rotation: currentRotation,
    now,
  });
  const purchaseHistory = appendPurchaseHistoryEntry(snapshot.purchaseHistory, historyEntry);

  const writePlan = [
    ['currencies/currentResearchPoints', nextRp],
    [grantWrite.path, grantWrite.value],
    ['shop/currentRotation/slots', nextSlots],
    ['purchaseHistory', purchaseHistory],
  ];

  persistPurchasePlan(username, writePlan);
  bumpPlayerStat(username, STAT_KEYS.SHOP_PURCHASES, 1);

  return {
    success: true,
    itemId: validation.itemDefinition.id,
    itemType: validation.itemDefinition.type,
    pricePaid: validation.price,
    currency: validation.currency,
    grantQuantity: grantWrite.quantity,
    slotIndex: validation.slotIndex,
    slot: purchasedSlot,
    purchaseHistory,
    currentResearchPoints: nextRp,
    rotation: {
      ...currentRotation,
      slots: nextSlots,
    },
  };
}

// ---------------------------------------------------------------------------
// rerollShopSlot
// ---------------------------------------------------------------------------
/**
 * Rerolls a single shop slot with a new random item.
 *
 * Phase 3 flow:
 * 1. canRerollSlot() validation.
 * 2. Deduct configured RP reroll cost.
 * 3. Generate a replacement item (via shop-generation).
 * 4. Update slot in shop state.
 * 5. Persist to Firebase.
 * 6. Return mutation result for future UI rerender.
 *
 * @returns {Object}
 */
export function rerollShopSlot(username, slotIndex, options = {}) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getShopPlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const scope = options.scope || REROLL_SCOPES.ALL;
  const config = resolveShopRuntimeConfig(options.config);
  const catalog = getShopCatalogForConfig(config);
  const validation = canRerollSlot(player, slotIndex, scope, config, {
    getItem: catalog.getItem,
  });
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  const currentRotation = getCurrentRotation(player);
  const slots = getShopRotationSlots(currentRotation);
  const replacement = generateReplacementShopSlot(player, currentRotation, Number(slotIndex), scope, config, {
    rng: options.rng,
    pool: catalog.pool,
  });

  if (!replacement) {
    return { success: false, reason: 'no_eligible_replacement' };
  }

  const nextSlots = [...slots];
  nextSlots[Number(slotIndex)] = replacement;
  const currentRp = Number(player.currencies?.currentResearchPoints || 0);
  const nextRp = currentRp - validation.cost;
  const rerollsUsed = Number(player.shopUsage?.rerollsUsedThisRotation || 0) + 1;

  db.set(`players/${username}/shop/currentRotation/slots`, nextSlots);
  db.set(`players/${username}/currencies/currentResearchPoints`, nextRp);
  db.set(`players/${username}/shopUsage/rerollsUsedThisRotation`, rerollsUsed);

  return {
    success: true,
    scope,
    cost: validation.cost,
    slotIndex: Number(slotIndex),
    slot: replacement,
    rotation: {
      ...currentRotation,
      slots: nextSlots,
    },
  };
}

// ---------------------------------------------------------------------------
// rerollShopSlotWithToken
// ---------------------------------------------------------------------------
/**
 * Rerolls one slot using a consumable token payment mode.
 * No RP is deducted; consumable inventory is handled by shop-consumables.js.
 *
 * @param {string} username
 * @param {number} slotIndex
 * @param {Object} [options]
 * @returns {Object}
 */
export function rerollShopSlotWithToken(username, slotIndex, options = {}) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getShopPlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const scope = options.scope || REROLL_SCOPES.ALL;
  const config = resolveShopRuntimeConfig(options.config);
  const catalog = getShopCatalogForConfig(config);
  const validation = canRerollSlot(player, slotIndex, scope, config, {
    paymentMode: 'token',
    requireCurrentSlotScope: false,
    getItem: catalog.getItem,
  });
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  const currentRotation = getCurrentRotation(player);
  const slots = getShopRotationSlots(currentRotation);
  const replacement = generateReplacementShopSlot(player, currentRotation, Number(slotIndex), scope, config, {
    rng: options.rng,
    pool: catalog.pool,
  });

  if (!replacement) {
    return { success: false, reason: 'no_eligible_replacement' };
  }

  const nextSlots = [...slots];
  nextSlots[Number(slotIndex)] = replacement;

  db.set(`players/${username}/shop/currentRotation/slots`, nextSlots);

  return {
    success: true,
    scope,
    paymentMode: 'token',
    cost: 0,
    slotIndex: Number(slotIndex),
    slot: replacement,
    rotation: {
      ...currentRotation,
      slots: nextSlots,
    },
  };
}

// ---------------------------------------------------------------------------
// rerollShopRotation
// ---------------------------------------------------------------------------
/**
 * Rerolls every eligible non-purchased, non-frozen slot for a scope.
 * Phase 3 deducts RP only; it does not consume reroll tokens.
 *
 * @param {string} username
 * @param {Object} [options]
 * @returns {Object}
 */
export function rerollShopRotation(username, options = {}) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getShopPlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const scope = options.scope || REROLL_SCOPES.ALL;
  const config = resolveShopRuntimeConfig(options.config);
  const catalog = getShopCatalogForConfig(config);
  const validation = canRerollRotation(player, scope, config, { getItem: catalog.getItem });
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  const currentRotation = getCurrentRotation(player);
  const slots = getShopRotationSlots(currentRotation);
  const nextSlots = [...slots];
  let replacedCount = 0;

  for (const index of validation.eligibleSlotIndexes) {
    const currentSlot = nextSlots[index];
    if (currentSlot?.purchased === true || currentSlot?.frozen === true) continue;

    const replacement = generateReplacementShopSlot(
      {
        ...player,
        shop: {
          ...player.shop,
          currentRotation: {
            ...currentRotation,
            slots: nextSlots,
          },
        },
      },
      { ...currentRotation, slots: nextSlots },
      index,
      scope,
      config,
      { rng: options.rng, pool: catalog.pool }
    );

    if (!replacement) continue;
    nextSlots[index] = replacement;
    replacedCount += 1;
  }

  if (replacedCount === 0) {
    return { success: false, reason: 'no_eligible_replacement' };
  }

  const currentRp = Number(player.currencies?.currentResearchPoints || 0);
  const nextRp = currentRp - validation.cost;
  const rerollsUsed = Number(player.shopUsage?.rerollsUsedThisRotation || 0) + 1;

  db.set(`players/${username}/shop/currentRotation/slots`, nextSlots);
  db.set(`players/${username}/currencies/currentResearchPoints`, nextRp);
  db.set(`players/${username}/shopUsage/rerollsUsedThisRotation`, rerollsUsed);

  return {
    success: true,
    scope,
    cost: validation.cost,
    replacedCount,
    rotation: {
      ...currentRotation,
      slots: nextSlots,
    },
  };
}

// ---------------------------------------------------------------------------
// freezeShopSlot
// ---------------------------------------------------------------------------
/**
 * Freezes a shop slot so it persists across rotations.
 *
 * Phase 3 flow:
 * 1. canFreezeSlot() validation (respects maxFrozenSlots from config).
 * 2. Set frozen flag on the slot.
 * 3. Persist to Firebase.
 * 4. Return mutation result for future UI rerender.
 *
 * @returns {Object}
 */
export function freezeShopSlot(username, slotIndex, options = {}) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getShopPlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const config = resolveShopRuntimeConfig(options.config);
  const validation = canFreezeSlot(player, slotIndex, config);
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  const currentRotation = getCurrentRotation(player);
  const slots = getShopRotationSlots(currentRotation);
  const index = Number(slotIndex);
  const nextSlots = [...slots];
  nextSlots[index] = {
    ...nextSlots[index],
    frozen: true,
  };
  const frozenSlotsUsed = Number(player.shopUsage?.frozenSlotsUsedThisRotation || 0) + 1;

  db.set(`players/${username}/shop/currentRotation/slots`, nextSlots);
  db.set(`players/${username}/shopUsage/frozenSlotsUsedThisRotation`, frozenSlotsUsed);

  return {
    success: true,
    slotIndex: index,
    slot: nextSlots[index],
    rotation: {
      ...currentRotation,
      slots: nextSlots,
    },
  };
}

// ---------------------------------------------------------------------------
// applyDiscountToSlot
// ---------------------------------------------------------------------------
/**
 * Applies a discount consumable to a specific shop slot.
 *
 * Future flow:
 * 1. canApplyDiscount() validation (discounts cannot stack).
 * 2. Reduce the slot's effective price.
 * 3. Mark slot as discounted (prevents further discounts).
 * 4. Persist to Firebase.
 * 5. Consume the consumable only after persistence succeeds.
 * 6. Trigger rerender.
 *
 * @returns {Object} Placeholder — returns { success: false, reason: 'not_implemented' }.
 */
export function applyDiscountToSlot(username, slotIndex, options = {}) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getShopPlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const validation = canApplyDiscount(player, slotIndex, options);
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  const currentRotation = getCurrentRotation(player);
  const slots = getShopRotationSlots(currentRotation);
  const index = Number(slotIndex);
  const nextSlots = [...slots];
  const discountApplied = createDiscountApplied({
    sourceItemId: options.sourceItemId || null,
    percent: validation.percent,
    reductionAmount: validation.reductionAmount,
    appliedAt: Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now(),
  });

  nextSlots[index] = {
    ...nextSlots[index],
    currentPrice: validation.nextPrice,
    discountApplied,
  };

  db.set(`players/${username}/shop/currentRotation/slots`, nextSlots);

  return {
    success: true,
    slotIndex: index,
    discountApplied,
    reductionAmount: validation.reductionAmount,
    currentPrice: validation.nextPrice,
    rotation: {
      ...currentRotation,
      slots: nextSlots,
    },
  };
}

// ---------------------------------------------------------------------------
// grantFreezeAllowance
// ---------------------------------------------------------------------------
/**
 * Grants one extra freeze allowance for the current rotation.
 * This does NOT freeze a slot; freezeShopSlot() remains the slot mutation.
 *
 * @param {string} username
 * @param {Object} [options]
 * @returns {Object}
 */
export function grantFreezeAllowance(username, options = {}) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getShopPlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const config = resolveShopRuntimeConfig(options.config);
  const validation = canGrantFreezeAllowance(player, config);
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  db.set(
    `players/${username}/shopUsage/extraFreezeAllowanceThisRotation`,
    validation.nextExtraAllowance
  );

  return {
    success: true,
    extraFreezeAllowanceThisRotation: validation.nextExtraAllowance,
    maxFrozenSlots: validation.maxFrozenSlots,
  };
}

// ---------------------------------------------------------------------------
// generateAdditionalProject
// ---------------------------------------------------------------------------
/**
 * Generates an additional project slot via consumable.
 *
 * Future flow:
 * 1. Validate consumable ownership and eligibility.
 * 2. Generate a new project using project generation rules.
 * 3. Add to player's active project list.
 * 4. Persist to Firebase.
 * 5. Consume the consumable only after persistence succeeds.
 * 6. Trigger rerender.
 *
 * @returns {Object} Placeholder — returns { success: false, reason: 'not_implemented' }.
 */
export function generateAdditionalProject(username, options = {}) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getProjectPlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const validation = canGenerateAdditionalProject(player);
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  const createdAt = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const [project] = generateAvailableProjects({
    totalRP: player.totalResearchPoints,
    slots: 1,
    createdAt,
  });

  if (!project) {
    return { success: false, reason: 'project_generation_failed' };
  }

  const projects = [...player.projects, project];
  db.set(`players/${username}/projects`, projects);

  return {
    success: true,
    project,
    projects,
  };
}

// ---------------------------------------------------------------------------
// equipCosmetic
// ---------------------------------------------------------------------------
/**
 * Equips an owned cosmetic into its category-specific profile slot.
 *
 * @param {string} username
 * @param {string} cosmeticId
 * @param {Object} [options]
 * @returns {Object}
 */
export function equipCosmetic(username, cosmeticId, options = {}) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getProfilePlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const validation = canEquipCosmetic(player, cosmeticId, options.category || null);
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  db.set(`players/${username}/profile/${validation.profileField}`, cosmeticId);
  bumpPlayerStat(username, STAT_KEYS.COSMETICS_EQUIPPED, 1);

  return {
    success: true,
    cosmeticId,
    category: validation.category,
    profileField: validation.profileField,
  };
}

// ---------------------------------------------------------------------------
// unequipCosmetic
// ---------------------------------------------------------------------------
/**
 * Clears the equipped cosmetic for a supported profile category.
 *
 * @param {string} username
 * @param {string} category
 * @returns {Object}
 */
export function unequipCosmetic(username, category) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getProfilePlayerSnapshot(username) || { profile: {}, cosmetics: {} };
  const validation = canUnequipCosmetic(player, category);
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  db.set(`players/${username}/profile/${validation.profileField}`, null);

  return {
    success: true,
    category,
    profileField: validation.profileField,
    cosmeticId: null,
  };
}

export function featureCard(username, cardId) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getProfileCardSnapshot(username, cardId);
  if (!player) return { success: false, reason: 'player_not_found' };

  const validation = canFeatureCard(player, cardId);
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  const featuredCards = [...validation.featuredCards, cardId];
  db.set(`players/${username}/profile/featuredCards`, featuredCards);

  return { success: true, cardId, featuredCards };
}

export function unfeatureCard(username, cardId) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getProfilePlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const validation = canUnfeatureCard(player, cardId);
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  const featuredCards = validation.featuredCards.filter(id => id !== cardId);
  db.set(`players/${username}/profile/featuredCards`, featuredCards);

  return { success: true, cardId, featuredCards };
}

export function setFeaturedCards(username, cardIds = []) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }
  if (!Array.isArray(cardIds)) return { success: false, reason: 'invalid_featured_cards' };

  let featuredCards = [];
  for (const cardId of cardIds) {
    const player = {
      ...(getProfileCardSnapshot(username, cardId) || {}),
      profile: { featuredCards },
    };
    const validation = canFeatureCard(player, cardId);
    if (!validation.allowed) return { success: false, reason: validation.reason, validation };
    featuredCards = [...featuredCards, cardId];
  }

  db.set(`players/${username}/profile/featuredCards`, featuredCards);
  return { success: true, featuredCards };
}

export function featureAchievement(username, achievementId) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getProfilePlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const validation = canFeatureAchievement(player, achievementId);
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  const featuredAchievements = [...validation.featuredAchievements, achievementId];
  db.set(`players/${username}/profile/featuredAchievements`, featuredAchievements);

  return { success: true, achievementId, featuredAchievements };
}

export function unfeatureAchievement(username, achievementId) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const player = getProfilePlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const validation = canUnfeatureAchievement(player, achievementId);
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  const featuredAchievements = validation.featuredAchievements.filter(id => id !== achievementId);
  db.set(`players/${username}/profile/featuredAchievements`, featuredAchievements);

  return { success: true, achievementId, featuredAchievements };
}

export function setFeaturedAchievements(username, achievementIds = []) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }
  if (!Array.isArray(achievementIds)) {
    return { success: false, reason: 'invalid_featured_achievements' };
  }

  const basePlayer = getProfilePlayerSnapshot(username);
  if (!basePlayer) return { success: false, reason: 'player_not_found' };

  let featuredAchievements = [];
  for (const achievementId of achievementIds) {
    const validation = canFeatureAchievement(
      { ...basePlayer, profile: { featuredAchievements } },
      achievementId
    );
    if (!validation.allowed) return { success: false, reason: validation.reason, validation };
    featuredAchievements = [...featuredAchievements, achievementId];
  }

  db.set(`players/${username}/profile/featuredAchievements`, featuredAchievements);
  return { success: true, featuredAchievements };
}

/**
 * Set profile identity accent (utility preference — not a cosmetic unlock).
 * @param {string} username
 * @param {string} accentId
 */
export function setIdentityAccent(username, accentId) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }
  const player = getProfilePlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const identityAccent = normalizeIdentityAccent(accentId);
  db.set(`players/${username}/profile/identityAccent`, identityAccent);
  return { success: true, identityAccent };
}

/**
 * @param {string} username
 * @param {string} colorId
 */
export function setProfileHeaderTextColor(username, colorId) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }
  const player = getProfilePlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const headerTextColor = normalizeProfileHeaderTextColor(colorId);
  db.set(`players/${username}/profile/headerTextColor`, headerTextColor);
  return { success: true, headerTextColor };
}

/**
 * @param {string} username
 * @param {string} colorId
 */
export function setProfileBodyTextColor(username, colorId) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }
  const player = getProfilePlayerSnapshot(username);
  if (!player) return { success: false, reason: 'player_not_found' };

  const bodyTextColor = normalizeProfileBodyTextColor(colorId);
  db.set(`players/${username}/profile/bodyTextColor`, bodyTextColor);
  return { success: true, bodyTextColor };
}
