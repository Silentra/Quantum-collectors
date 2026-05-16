/**
 * shop-definitions.js
 * Phase 1A — Static item/shop definitions only.
 * NO gameplay logic. NO Firebase. NO rendering. NO mutations.
 */

// ── Item Type Enum ──────────────────────────────────────────────────────────
export const ITEM_TYPES = Object.freeze({
  CONSUMABLE: 'consumable',
  COSMETIC:   'cosmetic',
  PACK:       'pack',
  CARD:       'card',
});

// ── Item Category Enum ──────────────────────────────────────────────────────
export const ITEM_CATEGORIES = Object.freeze({
  UTILITY:        'utility',        // reroll tokens, freeze tokens, discount chips
  AURA:           'aura',           // profile card aura effects
  BORDER:         'border',         // profile card border styles
  PROFILE_BANNER: 'profile_banner', // profile banner cosmetics
  TITLE:          'title',          // display title cosmetics
  PACK:           'pack',           // card packs
  CARD:           'card',           // individual cards
});

// ── Item Rarity Enum ────────────────────────────────────────────────────────
export const ITEM_RARITIES = Object.freeze({
  COMMON:    'common',
  UNCOMMON:  'uncommon',
  RARE:      'rare',
  EPIC:      'epic',
  LEGENDARY: 'legendary',
});

// ── Aura Render Effects ─────────────────────────────────────────────────────
// Maps renderEffectId → static effect descriptor.
// Actual render implementations belong in a future render layer, not here.
export const AURA_EFFECTS = Object.freeze({
  void: {
    renderEffectId: 'void',
    label: 'Void',
    description: 'A dark, pulsing emptiness surrounds the card.',
    colorHint: '#1a0033',
  },
  quantum: {
    renderEffectId: 'quantum',
    label: 'Quantum Flux',
    description: 'Shimmering probability waves dance across the surface.',
    colorHint: '#00e5ff',
  },
  plasma: {
    renderEffectId: 'plasma',
    label: 'Plasma Field',
    description: 'Bright ionized arcs crackle around the edges.',
    colorHint: '#ff6d00',
  },
  graviton: {
    renderEffectId: 'graviton',
    label: 'Graviton Well',
    description: 'Space-time distortion ripples outward.',
    colorHint: '#7c4dff',
  },
});

// ── Item Definitions ────────────────────────────────────────────────────────
// Static catalog of all shop-eligible items.
// Cosmetics are separate from cards by design.
// Consumables use behaviorType + behaviorConfig.
// Aura/cosmetic items reference renderEffectId where applicable.

export const ITEM_DEFINITIONS = Object.freeze({

  // ── Consumables / Utility ───────────────────────────────────────────────

  reroll_token: {
    id: 'reroll_token',
    name: 'Reroll Token',
    description: 'Reroll the entire shop rotation.',
    type: ITEM_TYPES.CONSUMABLE,
    category: ITEM_CATEGORIES.UTILITY,
    rarity: ITEM_RARITIES.COMMON,
    price: 50,
    weight: 30,
    enabled: true,
    behaviorType: 'reroll_shop',
    behaviorConfig: { scope: 'all' },
  },

  cosmetic_reroll_token: {
    id: 'cosmetic_reroll_token',
    name: 'Cosmetic Reroll Token',
    description: 'Reroll only the cosmetic slots in the shop.',
    type: ITEM_TYPES.CONSUMABLE,
    category: ITEM_CATEGORIES.UTILITY,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 75,
    weight: 15,
    enabled: true,
    behaviorType: 'reroll_shop',
    behaviorConfig: { scope: 'cosmetic' },
  },

  aura_reroll_token: {
    id: 'aura_reroll_token',
    name: 'Aura Reroll Token',
    description: 'Reroll only the aura slots in the shop.',
    type: ITEM_TYPES.CONSUMABLE,
    category: ITEM_CATEGORIES.UTILITY,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 80,
    weight: 12,
    enabled: true,
    behaviorType: 'reroll_shop',
    behaviorConfig: { scope: 'aura' },
  },

  border_reroll_token: {
    id: 'border_reroll_token',
    name: 'Border Reroll Token',
    description: 'Reroll only the border slots in the shop.',
    type: ITEM_TYPES.CONSUMABLE,
    category: ITEM_CATEGORIES.UTILITY,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 80,
    weight: 12,
    enabled: true,
    behaviorType: 'reroll_shop',
    behaviorConfig: { scope: 'border' },
  },

  discount_chip: {
    id: 'discount_chip',
    name: 'Discount Chip',
    description: 'Apply a percentage discount to a shop slot.',
    type: ITEM_TYPES.CONSUMABLE,
    category: ITEM_CATEGORIES.UTILITY,
    rarity: ITEM_RARITIES.RARE,
    price: 120,
    weight: 8,
    enabled: true,
    behaviorType: 'apply_discount',
    behaviorConfig: { percent: 25, targetScope: 'any_slot' },
  },

  freeze_token: {
    id: 'freeze_token',
    name: 'Freeze Token',
    description: 'Freeze a shop slot so it persists through the next rotation.',
    type: ITEM_TYPES.CONSUMABLE,
    category: ITEM_CATEGORIES.UTILITY,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 60,
    weight: 20,
    enabled: true,
    behaviorType: 'freeze_slot',
    behaviorConfig: { duration: 1 }, // persists 1 rotation
  },

  research_proposal: {
    id: 'research_proposal',
    name: 'Research Proposal',
    description: 'A consumable that grants bonus research progress.',
    type: ITEM_TYPES.CONSUMABLE,
    category: ITEM_CATEGORIES.UTILITY,
    rarity: ITEM_RARITIES.RARE,
    price: 200,
    weight: 5,
    enabled: true,
    behaviorType: 'grant_research',
    behaviorConfig: { amount: 50 },
  },

  // ── Cosmetics — Auras ──────────────────────────────────────────────────

  aura_void: {
    id: 'aura_void',
    name: 'Void Aura',
    description: 'A dark, pulsing emptiness surrounds your profile card.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.AURA,
    rarity: ITEM_RARITIES.EPIC,
    price: 500,
    weight: 4,
    enabled: true,
    renderEffectId: 'void',
  },

  // ── Cosmetics — Borders ────────────────────────────────────────────────

  border_quantum: {
    id: 'border_quantum',
    name: 'Quantum Border',
    description: 'A shimmering border of probability waves.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.BORDER,
    rarity: ITEM_RARITIES.RARE,
    price: 350,
    weight: 6,
    enabled: true,
    renderEffectId: 'quantum',
  },

  // ── Cosmetics — Profile Banners ────────────────────────────────────────

  profile_banner_research: {
    id: 'profile_banner_research',
    name: 'Research Lab Banner',
    description: 'A sleek laboratory-themed profile banner.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 150,
    weight: 10,
    enabled: true,
  },

  // ── Cosmetics — Titles ─────────────────────────────────────────────────

  title_master_researcher: {
    id: 'title_master_researcher',
    name: 'Master Researcher',
    description: 'Display the title "Master Researcher" on your profile.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.TITLE,
    rarity: ITEM_RARITIES.LEGENDARY,
    price: 1000,
    weight: 2,
    enabled: true,
  },
});
