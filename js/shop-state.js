/**
 * shop-state.js
 * Phase 1A / 2B — Pure shop state/schema helpers.
 * NO gameplay logic. NO Firebase. NO rendering. NO mutation logic.
 * Helper/schema layer only.
 */

// ── Conceptual cap for purchase history entries ─────────────────────────────
export const PURCHASE_HISTORY_MAX = 10;

// ── Persistence metadata defaults ───────────────────────────────────────────
export const SHOP_GENERATION_VERSION = 1;

// ── Schema Helpers ──────────────────────────────────────────────────────────

/**
 * Create an empty persisted player shop state object.
 * Phase 2B stores structure only; no refresh, reroll, or generation behavior.
 *
 * @returns {Object} Empty shop state with default field values.
 */
export function createEmptyShopState() {
  return {
    currentRotation: createShopRotationState(),
    rerollResetAt: 0,             // Timestamp metadata only; no reset execution in Phase 2B
  };
}

/**
 * Create an empty persisted shop rotation container.
 *
 * @param {Object} [overrides] — Optional field overrides.
 * @returns {Object} Rotation state with schema-compliant defaults.
 */
export function createShopRotationState(overrides = {}) {
  return {
    slots: [],                    // Array<ShopSlot> — populated by future generation layer
    generatedAt: 0,               // Timestamp metadata only
    refreshAt: 0,                 // Timestamp metadata only
    generationVersion: SHOP_GENERATION_VERSION,
    ...overrides,
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
    currency: 'rp',               // Stored currency identifier; no deduction logic here
    frozen: false,                // Persisted state only; no freeze behavior here
    purchased: false,             // Persisted state only; no purchase behavior here
    discountApplied: null,        // null or DiscountApplied structure (see below)
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
    appliedAt: 0,                 // Timestamp metadata only
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
