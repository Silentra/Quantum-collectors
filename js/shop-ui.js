/**
 * shop-ui.js — Shop rendering layer (UI only)
 *
 * This module is strictly rendering-only.
 * - Gameplay logic (purchases, rerolls, consumables) belongs in shop-mutations.js
 * - Weighted generation / pool building belongs in shop-generation.js
 * - Validation / exploit-prevention belongs in shop-validation.js
 * - Consumable behavior routing belongs in shop-consumables.js
 * - Admin config UI belongs in shop-admin.js
 *
 * renderShop()   — called when the shop tab becomes active
 * cleanupShop()  — called when the shop tab is deactivated (teardown listeners, intervals, etc.)
 */

/** Render the shop tab contents. Placeholder — Phase 2 will implement. */
export function renderShop() {
  // TODO: Phase 2 — render shop rotation, slots, purchase buttons
}

/** Cleanup shop state when navigating away. Placeholder — Phase 2 will implement. */
export function cleanupShop() {
  // TODO: Phase 2 — remove listeners, clear intervals, reset transient UI state
}
