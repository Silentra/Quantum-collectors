/**
 * shop-consumables.js
 * ====================
 * Future consumable behavior router.
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
 * Supported behavior routes (finalized):
 * - shop_reroll      → rerolls the entire shop rotation (all non-purchased, non-frozen slots)
 * - cosmetic_reroll   → rerolls a specific cosmetic slot with a new cosmetic
 * - aura_reroll       → rerolls a specific slot to produce an aura-type cosmetic
 * - border_reroll     → rerolls a specific slot to produce a border-type cosmetic
 * - freeze_slot       → freezes a slot so it persists across the next rotation refresh
 * - discount_slot     → applies a percentage discount to a specific slot's price
 * - generate_project  → generates an additional project for the player
 *
 * Dependencies (future):
 *   - js/shop-validation.js   (canUseConsumable)
 *   - js/shop-mutations.js    (rerollShopSlot, freezeShopSlot, applyDiscountToSlot, generateAdditionalProject)
 *   - js/shop-definitions.js  (ITEM_DEFINITIONS for behaviorType lookup)
 *
 * NO actual consumable execution, gameplay logic, Firebase, or rendering in this file.
 */

// ---------------------------------------------------------------------------
// useConsumable
// ---------------------------------------------------------------------------
/**
 * Entry point for using a consumable item.
 *
 * Future behavior:
 * 1. Look up the consumable's behaviorType from ITEM_DEFINITIONS.
 * 2. Call canUseConsumable() validation.
 * 3. Route to executeBehavior() with the resolved behavior type and context.
 * 4. Return the result (success/failure + details).
 *
 * Consumable is only deducted from inventory if the routed mutation
 * succeeds and persists (handled by the mutation layer, not here).
 *
 * @returns {Object} Placeholder — returns { success: false, reason: 'not_implemented' }.
 */
export function useConsumable() {
  // TODO: Phase 2+ — implement consumable usage entry point
  return { success: false, reason: 'not_implemented' };
}

// ---------------------------------------------------------------------------
// executeBehavior
// ---------------------------------------------------------------------------
/**
 * Routes a consumable's behaviorType to the correct mutation handler.
 *
 * Future routing map:
 *   'shop_reroll'      → shop-mutations.rerollShopSlot (all eligible slots)
 *   'cosmetic_reroll'  → shop-mutations.rerollShopSlot (single slot, cosmetic filter)
 *   'aura_reroll'      → shop-mutations.rerollShopSlot (single slot, aura-only filter)
 *   'border_reroll'    → shop-mutations.rerollShopSlot (single slot, border-only filter)
 *   'freeze_slot'      → shop-mutations.freezeShopSlot
 *   'discount_slot'    → shop-mutations.applyDiscountToSlot
 *   'generate_project' → shop-mutations.generateAdditionalProject
 *
 * This function does NOT contain any core logic itself.
 * It is purely a dispatch/routing layer.
 *
 * @returns {Object} Placeholder — returns { success: false, reason: 'not_implemented' }.
 */
export function executeBehavior() {
  // TODO: Phase 2+ — implement behavior routing dispatch
  return { success: false, reason: 'not_implemented' };
}
