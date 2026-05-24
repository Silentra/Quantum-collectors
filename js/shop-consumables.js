/**
 * shop-consumables.js
 * ====================
 * Consumable behavior router.
 *
 * IMPORTANT ARCHITECTURAL RULE:
 * Consumables NEVER contain core logic directly.
 * This module is a behavior routing layer only.
 *
 * When a consumable is used, this module:
 * 1. Identifies the consumable's behaviorType.
 * 2. Routes to the appropriate mutation in shop-mutations.js (or other modules).
 * 3. Returns the result of that mutation.
 *
 * The actual logic for rerolling, freezing, discounting, generating, etc.
 * lives in their respective modules (shop-mutations, shop-generation, etc.).
 * This file only maps behaviorType → handler.
 *
 * Supported behavior routes:
 * - reroll_shop    → rerolls one slot using behaviorConfig.scope
 * - apply_discount → applies a persistent discount to one slot
 * - freeze_slot    → grants one extra freeze allowance for this rotation
 * - grant_research → generates one cap-respecting AVAILABLE research project
 *
 * Dependencies:
 *   - js/shop-validation.js   (canUseConsumable)
 *   - js/shop-mutations.js    (routed mutation pipelines)
 *   - js/shop-definitions.js  (ITEM_DEFINITIONS for behaviorType lookup)
 *
 * NO core gameplay logic, generation algorithms, Firebase listeners, or rendering in this file.
 */

import * as db from './database.js';
import { getItemDefinition } from './cosmetic-definitions.js';
import {
  applyDiscountToSlot,
  consumeItem,
  generateAdditionalProject,
  grantFreezeAllowance,
  rerollShopSlotWithToken,
} from './shop-mutations.js';
import { canUseConsumable } from './shop-validation.js';

function getConsumablePlayerSnapshot(username) {
  const items = db.get(`players/${username}/items`);
  if (!items || typeof items !== 'object' || Array.isArray(items)) {
    return { items: {} };
  }
  return { items };
}

function getConsumableQuantity(username, itemId) {
  return Math.max(0, Math.floor(Number(db.get(`players/${username}/items/${itemId}`) || 0)));
}

// ---------------------------------------------------------------------------
// useConsumable
// ---------------------------------------------------------------------------
/**
 * Entry point for using a consumable item.
 *
 * Behavior:
 * 1. Look up the consumable's behaviorType from ITEM_DEFINITIONS.
 * 2. Call canUseConsumable() validation.
 * 3. Route to executeBehavior() with the resolved behavior type and context.
 * 4. Consume exactly one item only after routed mutation success.
 * 5. Return the result (success/failure + details).
 *
 * @param {string} username
 * @param {string} consumableItemId
 * @param {Object} [context]
 * @param {Object} [options]
 * @returns {Object}
 *
 */
export function useConsumable(username, consumableItemId, context = {}, options = {}) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }

  const definition = getItemDefinition(consumableItemId);
  const player = getConsumablePlayerSnapshot(username);
  const validation = canUseConsumable(player, definition, context);
  if (!validation.allowed) {
    return { success: false, reason: validation.reason, validation };
  }

  const mutationResult = executeBehavior(username, definition, context, options);
  if (!mutationResult.success) {
    return mutationResult;
  }

  const consumeResult = consumeItem(username, definition.id, 1);
  if (!consumeResult.success) {
    return {
      ...mutationResult,
      success: false,
      reason: consumeResult.reason,
      consumeResult,
    };
  }

  return {
    ...mutationResult,
    consumableItemId: definition.id,
    behaviorType: definition.behaviorType,
    consumed: true,
    remainingQuantity: getConsumableQuantity(username, definition.id),
  };
}

// ---------------------------------------------------------------------------
// executeBehavior
// ---------------------------------------------------------------------------
/**
 * Routes a consumable's behaviorType to the correct mutation handler.
 *
 * Routing map:
 *   'reroll_shop'    → shop-mutations.rerollShopSlotWithToken
 *   'apply_discount' → shop-mutations.applyDiscountToSlot
 *   'freeze_slot'    → shop-mutations.grantFreezeAllowance
 *   'grant_research' → shop-mutations.generateAdditionalProject
 *
 * This function does NOT contain any core logic itself.
 * It is purely a dispatch/routing layer.
 *
 * @param {string} username
 * @param {Object} itemDefinition
 * @param {Object} [context]
 * @param {Object} [options]
 * @returns {Object}
 */
export function executeBehavior(username, itemDefinition, context = {}, options = {}) {
  const behaviorConfig = itemDefinition?.behaviorConfig || {};

  switch (itemDefinition?.behaviorType) {
    case 'reroll_shop':
      return rerollShopSlotWithToken(username, context.slotIndex, {
        ...options,
        scope: behaviorConfig.scope,
      });

    case 'apply_discount':
      return applyDiscountToSlot(username, context.slotIndex, {
        ...options,
        ...behaviorConfig,
        sourceItemId: itemDefinition.id,
      });

    case 'freeze_slot':
      return grantFreezeAllowance(username, {
        ...options,
        ...behaviorConfig,
      });

    case 'grant_research':
      return generateAdditionalProject(username, {
        ...options,
        ...behaviorConfig,
      });

    default:
      return { success: false, reason: 'unsupported_behavior' };
  }
}
