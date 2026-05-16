/**
 * shop-config.js
 * Phase 1A — Centralized configurable economy defaults.
 * NO gameplay logic. NO Firebase. NO rendering. NO mutations.
 */

// ── Default Shop Configuration ──────────────────────────────────────────────
// All slot constraints are configurable down to 0.
// shopSlotCount is conceptually constrained to 3–9.
// rerollCosts supports individually configurable reroll types.

export const DEFAULT_SHOP_CONFIG = Object.freeze({

  // How many days between automatic shop rotations
  shopRefreshDays: 3,

  // Number of slots in the shop (conceptual range: 3–9)
  shopSlotCount: 6,

  // Individually configurable reroll costs by scope.
  // Each key maps to the currency cost of that reroll type.
  rerollCosts: Object.freeze({
    all:      50,   // full shop reroll
    cosmetic: 75,   // cosmetic-only reroll
    aura:     80,   // aura-only reroll
    border:   80,   // border-only reroll
    utility:  60,   // utility-only reroll
    pack:     70,   // pack-only reroll
  }),

  // Maximum number of slots a player may freeze simultaneously
  maxFrozenSlots: 2,

  // Minimum number of cosmetic slots guaranteed per rotation (configurable to 0)
  minimumCosmeticSlots: 1,

  // Minimum number of utility/consumable slots guaranteed per rotation (configurable to 0)
  minimumUtilitySlots: 1,

  // Maximum number of pack + card slots per rotation (configurable to 0)
  maximumPackAndCardSlots: 2,

  // Whether cosmetics the player already owns can appear in the shop
  allowOwnedCosmeticsInShop: false,

  // Version tag for the generation algorithm; bumping this signals
  // that previously generated shops may need regeneration.
  generationVersion: 1,
});
