/**
 * shop-validation.js
 * ==================
 * Phase 3 validation and exploit-prevention layer.
 *
 * Every mutation in shop-mutations.js calls the corresponding guard here
 * BEFORE modifying any state. If validation fails, the mutation aborts.
 *
 * Validation rules (finalized):
 * - RP cannot go below 0: no purchase or reroll is allowed if the player
 *   lacks sufficient RP after the transaction.
 * - Discounts cannot stack: a slot that already has a discount applied
 *   cannot receive another discount consumable.
 * - Purchased slots are immutable: once a slot is purchased, it cannot be
 *   rerolled, frozen, discounted, or otherwise mutated for the current rotation.
 * - Frozen slot rules: the total number of frozen slots cannot exceed
 *   maxFrozenSlots from shop-config. A purchased slot cannot be frozen.
 * - Ownership rules for cosmetics: a player cannot purchase a cosmetic
 *   they already own. Owned cosmetics should be filtered at generation time,
 *   but validation provides a second safety net.
 *
 * Dependencies:
 *   - js/shop-config.js  (reroll costs, maxFrozenSlots)
 *   - js/shop-generation.js (slot normalization, reroll scope helpers)
 *
 * Phase 3 note: reroll/freeze guards are pure and perform no Firebase writes,
 * rendering, or inventory/currency mutation.
 */

import { DEFAULT_SHOP_CONFIG } from './shop-config.js';
import { ITEM_DEFINITIONS } from './shop-definitions.js';
import {
  REROLL_SCOPES,
  getShopRotationSlots,
  itemMatchesRerollScope,
} from './shop-generation.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function getRotation(player) {
  return isObject(player?.shop?.currentRotation) ? player.shop.currentRotation : null;
}

function getCurrentResearchPoints(player) {
  return Number(player?.currencies?.currentResearchPoints || 0);
}

function getRerollCost(scope, config) {
  const cost = Number(config.rerollCosts?.[scope]);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

function isValidScope(scope, config) {
  return Object.values(REROLL_SCOPES).includes(scope) && getRerollCost(scope, config) !== null;
}

function getSlotItem(slot) {
  return slot?.itemId ? ITEM_DEFINITIONS[slot.itemId] : null;
}

function countFrozenSlots(slots) {
  return slots.filter(slot => slot?.frozen === true).length;
}

// ---------------------------------------------------------------------------
// canPurchaseItem
// ---------------------------------------------------------------------------
/**
 * Checks whether a player can purchase a specific shop slot item.
 *
 * Future checks:
 * - Player has enough RP (balance >= effective price).
 * - Slot is not already purchased.
 * - If cosmetic, player does not already own it.
 * - Slot index is valid and within current rotation.
 *
 * @returns {Object} Placeholder — returns { allowed: false, reason: 'not_implemented' }.
 */
export function canPurchaseItem() {
  // TODO: Phase 2+ — implement purchase validation
  return { allowed: false, reason: 'not_implemented' };
}

// ---------------------------------------------------------------------------
// canRerollSlot
// ---------------------------------------------------------------------------
/**
 * Checks whether a player can reroll a specific shop slot.
 *
 * Phase 3 checks:
 * - Slot is not purchased (purchased slots are immutable).
 * - Slot is not frozen.
 * - Player has enough RP for the configured reroll cost.
 * - Slot index is valid.
 * - RP will not go below 0 after deduction.
 *
 * @returns {Object}
 */
export function canRerollSlot(player, slotIndex, scope = REROLL_SCOPES.ALL, config = DEFAULT_SHOP_CONFIG) {
  const effectiveConfig = normalizeConfig(config);
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };
  if (!isValidScope(scope, effectiveConfig)) return { allowed: false, reason: 'invalid_reroll_scope' };

  const rotation = getRotation(player);
  const slots = getShopRotationSlots(rotation);
  const index = Number(slotIndex);
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) {
    return { allowed: false, reason: 'invalid_slot_index' };
  }

  const slot = slots[index];
  if (slot?.purchased === true) return { allowed: false, reason: 'slot_purchased' };
  if (slot?.frozen === true) return { allowed: false, reason: 'slot_frozen' };

  const item = getSlotItem(slot);
  if (scope !== REROLL_SCOPES.ALL && !itemMatchesRerollScope(item, scope)) {
    return { allowed: false, reason: 'slot_scope_mismatch' };
  }

  const cost = getRerollCost(scope, effectiveConfig);
  if (getCurrentResearchPoints(player) < cost) {
    return { allowed: false, reason: 'insufficient_rp', cost };
  }

  return { allowed: true, reason: null, cost, scope };
}

// ---------------------------------------------------------------------------
// canRerollRotation
// ---------------------------------------------------------------------------
/**
 * Checks whether a player can reroll all eligible slots for a scope.
 *
 * @param {Object} player
 * @param {string} scope
 * @param {Object} config
 * @returns {Object}
 */
export function canRerollRotation(player, scope = REROLL_SCOPES.ALL, config = DEFAULT_SHOP_CONFIG) {
  const effectiveConfig = normalizeConfig(config);
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };
  if (!isValidScope(scope, effectiveConfig)) return { allowed: false, reason: 'invalid_reroll_scope' };

  const slots = getShopRotationSlots(getRotation(player));
  const eligibleSlots = slots
    .map((slot, index) => ({ slot, index, item: getSlotItem(slot) }))
    .filter(({ slot, item }) => slot?.purchased !== true &&
      slot?.frozen !== true &&
      itemMatchesRerollScope(item, scope));

  if (eligibleSlots.length === 0) {
    return { allowed: false, reason: 'no_eligible_slots' };
  }

  const cost = getRerollCost(scope, effectiveConfig);
  if (getCurrentResearchPoints(player) < cost) {
    return { allowed: false, reason: 'insufficient_rp', cost };
  }

  return {
    allowed: true,
    reason: null,
    cost,
    scope,
    eligibleSlotIndexes: eligibleSlots.map(({ index }) => index),
  };
}

// ---------------------------------------------------------------------------
// canFreezeSlot
// ---------------------------------------------------------------------------
/**
 * Checks whether a player can freeze a specific shop slot.
 *
 * Phase 3 checks:
 * - Slot is not already purchased (purchased slots cannot be frozen).
 * - Total frozen slots has not reached maxFrozenSlots limit.
 * - Phase 3 does not require or consume freeze tokens.
 * - Slot is not already frozen (no double-freeze).
 *
 * @returns {Object}
 */
export function canFreezeSlot(player, slotIndex, config = DEFAULT_SHOP_CONFIG) {
  const effectiveConfig = normalizeConfig(config);
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };

  const slots = getShopRotationSlots(getRotation(player));
  const index = Number(slotIndex);
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) {
    return { allowed: false, reason: 'invalid_slot_index' };
  }

  const slot = slots[index];
  if (slot?.purchased === true) return { allowed: false, reason: 'slot_purchased' };
  if (slot?.frozen === true) return { allowed: false, reason: 'slot_already_frozen' };

  const maxFrozenSlots = Math.max(0, Math.floor(Number(effectiveConfig.maxFrozenSlots || 0)));
  if (countFrozenSlots(slots) >= maxFrozenSlots) {
    return { allowed: false, reason: 'max_frozen_slots_reached', maxFrozenSlots };
  }

  return { allowed: true, reason: null, maxFrozenSlots };
}

// ---------------------------------------------------------------------------
// canApplyDiscount
// ---------------------------------------------------------------------------
/**
 * Checks whether a discount consumable can be applied to a shop slot.
 *
 * Future checks:
 * - Slot is not already purchased.
 * - Slot does not already have a discount applied (discounts cannot stack).
 * - Player has a valid discount consumable.
 * - Resulting price remains >= 0.
 *
 * @returns {Object} Placeholder — returns { allowed: false, reason: 'not_implemented' }.
 */
export function canApplyDiscount() {
  // TODO: Phase 2+ — implement discount validation
  return { allowed: false, reason: 'not_implemented' };
}

// ---------------------------------------------------------------------------
// canUseConsumable
// ---------------------------------------------------------------------------
/**
 * Generic guard for any consumable usage attempt.
 *
 * Future checks:
 * - Player owns the consumable in their inventory.
 * - Consumable quantity > 0.
 * - Consumable type is valid and enabled.
 * - Target context (slot index, shop state) is appropriate for the consumable's behavior type.
 *
 * @returns {Object} Placeholder — returns { allowed: false, reason: 'not_implemented' }.
 */
export function canUseConsumable() {
  // TODO: Phase 2+ — implement consumable usage validation
  return { allowed: false, reason: 'not_implemented' };
}
