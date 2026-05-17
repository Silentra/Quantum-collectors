/**
 * shop-validation.js
 * ==================
 * Future validation and exploit-prevention layer.
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
 * Dependencies (future):
 *   - js/shop-config.js  (reroll costs, maxFrozenSlots)
 *   - js/shop-state.js   (shop state shape)
 *
 * Phase 2B note: persistent slot flags may exist on player records, but this
 * module still performs NO validation logic, Firebase, rendering, or gameplay.
 */

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
 * Future checks:
 * - Slot is not purchased (purchased slots are immutable).
 * - Player has enough RP for the reroll cost, OR has a valid reroll consumable.
 * - Slot index is valid.
 * - RP will not go below 0 after deduction.
 *
 * @returns {Object} Placeholder — returns { allowed: false, reason: 'not_implemented' }.
 */
export function canRerollSlot() {
  // TODO: Phase 2+ — implement reroll validation
  return { allowed: false, reason: 'not_implemented' };
}

// ---------------------------------------------------------------------------
// canFreezeSlot
// ---------------------------------------------------------------------------
/**
 * Checks whether a player can freeze a specific shop slot.
 *
 * Future checks:
 * - Slot is not already purchased (purchased slots cannot be frozen).
 * - Total frozen slots has not reached maxFrozenSlots limit.
 * - Player has a valid freeze consumable.
 * - Slot is not already frozen (no double-freeze).
 *
 * @returns {Object} Placeholder — returns { allowed: false, reason: 'not_implemented' }.
 */
export function canFreezeSlot() {
  // TODO: Phase 2+ — implement freeze validation
  return { allowed: false, reason: 'not_implemented' };
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
