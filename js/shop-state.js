/**
 * shop-state.js
 * Phase 1A — Pure shop state/schema helpers.
 * NO gameplay logic. NO Firebase. NO rendering. NO mutation logic.
 * Helper/schema layer only.
 */

// ── Conceptual cap for purchase history entries ─────────────────────────────
export const PURCHASE_HISTORY_MAX = 10;

// ── Schema Helpers ──────────────────────────────────────────────────────────

/**
 * Create an empty player shop state object.
 * Represents the per-player shop status for one rotation cycle.
 *
 * @returns {Object} Empty shop state with default field values.
 */
export function createEmptyShopState() {
  return {
    slots: [],                    // Array<ShopSlot> — populated by generation layer
    rerollsUsedThisRotation: 0,   // Number of rerolls consumed this cycle
    currentRotation: 0,           // Monotonically increasing rotation counter
    refreshAt: null,              // ISO timestamp — when the next auto-refresh occurs
    generatedAt: null,            // ISO timestamp — when this rotation was generated
    generationVersion: null,      // Matches shop-config generationVersion at creation time
    purchaseHistory: [],          // Array<PurchaseHistoryEntry> — capped at PURCHASE_HISTORY_MAX
  };
}

/**
 * Create a single shop slot schema object.
 * All fields default to empty/null; populated by generation layer.
 *
 * @param {Object} [overrides] — Optional field overrides.
 * @returns {Object} Shop slot with schema-compliant defaults.
 */
export function createShopSlot(overrides = {}) {
  return {
    id: null,                     // Unique slot identifier (e.g., uuid or index-based)
    itemId: null,                 // References an ITEM_DEFINITIONS key
    basePrice: 0,                 // Original price before discounts
    currentPrice: 0,              // Price after any discounts applied
    frozen: false,                // Whether this slot persists through next rotation
    purchased: false,             // Whether the player has bought this slot
    discountApplied: null,        // null or DiscountApplied object (see below)
    ...overrides,
  };
}

/**
 * Create a discount descriptor for a shop slot.
 *
 * @param {Object} [overrides] — Optional field overrides.
 * @returns {Object} Discount schema object.
 */
export function createDiscountApplied(overrides = {}) {
  return {
    sourceItemId: null,           // The consumable item that caused this discount
    percent: 0,                   // Percentage discount (0–100)
    reductionAmount: 0,           // Flat currency reduction after percentage
    appliedAt: null,              // ISO timestamp of when the discount was applied
    ...overrides,
  };
}

/**
 * Create a purchase history entry.
 * Purchase history is conceptually capped at PURCHASE_HISTORY_MAX entries.
 *
 * @param {Object} [overrides] — Optional field overrides.
 * @returns {Object} Purchase history entry with schema-compliant defaults.
 */
export function createPurchaseHistoryEntry(overrides = {}) {
  return {
    itemId: null,                 // References an ITEM_DEFINITIONS key
    pricePaid: 0,                 // Actual currency spent
    purchasedAt: null,            // ISO timestamp of purchase
    rotation: 0,                  // Which rotation cycle this purchase occurred in
    ...overrides,
  };
}
