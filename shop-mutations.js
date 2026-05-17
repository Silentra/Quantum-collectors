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
import { DEFAULT_SHOP_CONFIG } from './shop-config.js';
import {
  REROLL_SCOPES,
  generateReplacementShopSlot,
  generateShopRotation,
  getShopRotationSlots,
} from './shop-generation.js';
import { DEFAULT_SHOP_USAGE } from './player-schema.js';
import {
  canFreezeSlot,
  canRerollRotation,
  canRerollSlot,
} from './shop-validation.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSlots(rawSlots) {
  if (Array.isArray(rawSlots)) return rawSlots;
  if (isObject(rawSlots)) return Object.values(rawSlots);
  return [];
}

function normalizeConfig(config = DEFAULT_SHOP_CONFIG) {
  return {
    ...DEFAULT_SHOP_CONFIG,
    ...(isObject(config) ? config : {}),
    rerollCosts: {
      ...DEFAULT_SHOP_CONFIG.rerollCosts,
      ...(isObject(config?.rerollCosts) ? config.rerollCosts : {}),
    },
  };
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

function hasActiveRotation(player, config, now) {
  const rotation = getCurrentRotation(player);
  if (!rotation) return false;

  const slots = normalizeSlots(rotation.slots);
  const refreshAt = Number(rotation.refreshAt || 0);
  const expectedVersion = config.generationVersion ?? DEFAULT_SHOP_CONFIG.generationVersion;

  return slots.length > 0 &&
    refreshAt > now &&
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

  const config = normalizeConfig(options.config);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();

  if (!options.force && hasActiveRotation(player, config, now)) {
    return {
      success: true,
      generated: false,
      rotation: getCurrentRotation(player),
    };
  }

  const rotation = generateShopRotation(player, config, {
    now,
    rng: options.rng,
    currentRotation: getCurrentRotation(player),
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
 * Future flow:
 * 1. canPurchaseItem() validation.
 * 2. Deduct RP from player balance.
 * 3. Add item to player inventory/cosmetics.
 * 4. Mark slot as purchased (locked for rotation).
 * 5. Persist to Firebase.
 * 6. Trigger rerender.
 *
 * @returns {Object} Placeholder — returns { success: false, reason: 'not_implemented' }.
 */
export function purchaseShopItem() {
  // TODO: Phase 2+ — implement purchase mutation
  return { success: false, reason: 'not_implemented' };
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
  const config = normalizeConfig(options.config);
  const validation = canRerollSlot(player, slotIndex, scope, config);
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  const currentRotation = getCurrentRotation(player);
  const slots = getShopRotationSlots(currentRotation);
  const replacement = generateReplacementShopSlot(player, currentRotation, Number(slotIndex), scope, config, {
    rng: options.rng,
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
  const config = normalizeConfig(options.config);
  const validation = canRerollRotation(player, scope, config);
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
      { rng: options.rng }
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

  const config = normalizeConfig(options.config);
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
export function applyDiscountToSlot() {
  // TODO: Phase 2+ — implement discount mutation
  return { success: false, reason: 'not_implemented' };
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
export function generateAdditionalProject() {
  // TODO: Phase 2+ — implement additional project generation mutation
  return { success: false, reason: 'not_implemented' };
}
