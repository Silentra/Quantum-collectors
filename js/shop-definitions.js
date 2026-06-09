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
  SHIMMER:        'shimmer',        // card-face shimmer effects (inside .card-detail-inner)
  PROFILE_BANNER: 'profile_banner', // profile banner cosmetics
  SHELL_BACKGROUND: 'shell_background', // gameplay shell backdrop (below tabs)
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

/** Retired item id — graphite renders via card-border fallback, not inventory/shop. */
export const INTERNAL_DEFAULT_BORDER_ITEM_ID = 'border_graphite';

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
    display: { emoji: '🔄' },
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
    display: { emoji: '💄' },
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
    display: { emoji: '✦' },
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
    display: { emoji: '▣' },
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
    display: { emoji: '🏷' },
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
    display: { emoji: '❄' },
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
    display: { emoji: '📋' },
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

  border_silver: {
    id: 'border_silver',
    name: 'Silver Border',
    description: 'A clean brushed-silver frame with a soft metallic sheen.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.BORDER,
    rarity: ITEM_RARITIES.COMMON,
    price: 150,
    weight: 12,
    enabled: true,
    renderEffectId: 'silver',
  },

  border_sapphire: {
    id: 'border_sapphire',
    name: 'Sapphire Border',
    description: 'A deep blue frame with restrained sapphire highlights.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.BORDER,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 220,
    weight: 10,
    enabled: true,
    renderEffectId: 'sapphire',
  },

  border_emerald: {
    id: 'border_emerald',
    name: 'Emerald Border',
    description: 'A polished emerald-toned frame with subtle depth.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.BORDER,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 220,
    weight: 10,
    enabled: true,
    renderEffectId: 'emerald',
  },

  border_violet: {
    id: 'border_violet',
    name: 'Violet Border',
    description: 'A deep violet frame with a soft satin finish.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.BORDER,
    rarity: ITEM_RARITIES.RARE,
    price: 300,
    weight: 8,
    enabled: true,
    renderEffectId: 'violet',
  },

  border_spectrum: {
    id: 'border_spectrum',
    name: 'Spectrum Border',
    description: 'A rarity-reactive chromatic frame — the classic high-energy collector look.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.BORDER,
    rarity: ITEM_RARITIES.LEGENDARY,
    price: 450,
    weight: 4,
    enabled: true,
    renderEffectId: 'spectrum',
  },

  border_diamond_etched: {
    id: 'border_diamond_etched',
    name: 'Diamond Etched Metal',
    description: 'Precision-machined steel with a restrained engraved diamond texture.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.BORDER,
    rarity: ITEM_RARITIES.RARE,
    price: 340,
    weight: 6,
    enabled: true,
    renderEffectId: 'diamond_etched',
  },

  border_brushed_aluminum: {
    id: 'border_brushed_aluminum',
    name: 'Brushed Aluminum',
    description: 'Fine directional striations — laboratory-grade machined aluminum.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.BORDER,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 250,
    weight: 8,
    enabled: true,
    renderEffectId: 'brushed_aluminum',
  },

  border_leather_stitch: {
    id: 'border_leather_stitch',
    name: 'Matte Leather Stitching',
    description: 'Dark field-journal leather with a subtle stitched outer edge.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.BORDER,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 230,
    weight: 8,
    enabled: true,
    renderEffectId: 'leather_stitch',
  },

  border_carbon_weave: {
    id: 'border_carbon_weave',
    name: 'Carbon Fiber Weave',
    description: 'Low-contrast composite weave — precision engineering, not racing chrome.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.BORDER,
    rarity: ITEM_RARITIES.RARE,
    price: 320,
    weight: 6,
    enabled: true,
    renderEffectId: 'carbon_weave',
  },

  border_stone_slate: {
    id: 'border_stone_slate',
    name: 'Stone Slate Frame',
    description: 'Dark slate stock with faint mineral variation — museum display plaque.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.BORDER,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 210,
    weight: 9,
    enabled: true,
    renderEffectId: 'stone_slate',
  },

  border_marble_inlay: {
    id: 'border_marble_inlay',
    name: 'Marble Inlay Frame',
    description: 'Polished archival marble with sparse, restrained veining.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.BORDER,
    rarity: ITEM_RARITIES.EPIC,
    price: 390,
    weight: 5,
    enabled: true,
    renderEffectId: 'marble_inlay',
  },

  // ── Cosmetics — Shimmer (card-face; prismatic is automatic default, not sold) ──

  shimmer_holographic: {
    id: 'shimmer_holographic',
    name: 'Holographic Shimmer',
    description: 'A static iridescent foil finish across the card face — premium collector sheen.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHIMMER,
    rarity: ITEM_RARITIES.EPIC,
    price: 420,
    weight: 5,
    enabled: true,
    renderEffectId: 'holographic',
  },

  // ── Cosmetics — Profile Banners (BN-1 solid chrome; visuals in CSS only) ──

  profile_banner_deep_blue: {
    id: 'profile_banner_deep_blue',
    name: 'Deep Blue Banner',
    description: 'A restrained deep blue chrome banner.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.COMMON,
    price: 75,
    weight: 14,
    enabled: true,
    display: { emoji: '▰' },
  },

  profile_banner_crimson: {
    id: 'profile_banner_crimson',
    name: 'Crimson Banner',
    description: 'A restrained crimson chrome banner.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.COMMON,
    price: 75,
    weight: 14,
    enabled: true,
    display: { emoji: '▰' },
  },

  profile_banner_emerald: {
    id: 'profile_banner_emerald',
    name: 'Emerald Banner',
    description: 'A restrained emerald chrome banner.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.COMMON,
    price: 75,
    weight: 14,
    enabled: true,
    display: { emoji: '▰' },
  },

  profile_banner_purple: {
    id: 'profile_banner_purple',
    name: 'Purple Banner',
    description: 'A restrained purple chrome banner.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 120,
    weight: 10,
    enabled: true,
    display: { emoji: '▰' },
  },

  profile_banner_charcoal: {
    id: 'profile_banner_charcoal',
    name: 'Charcoal Banner',
    description: 'A neutral charcoal chrome banner.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.COMMON,
    price: 50,
    weight: 16,
    enabled: true,
    display: { emoji: '▰' },
  },

  profile_banner_slate: {
    id: 'profile_banner_slate',
    name: 'Slate Banner',
    description: 'A cool slate chrome banner.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.COMMON,
    price: 50,
    weight: 16,
    enabled: true,
    display: { emoji: '▰' },
  },

  profile_banner_football_field: {
    id: 'profile_banner_football_field',
    name: 'Football Field Banner',
    description: 'A subtle scrolling turf strip for banner chrome.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 180,
    weight: 8,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '🏟️' },
  },

  profile_banner_ancient_library: {
    id: 'profile_banner_ancient_library',
    name: 'Ancient Library Banner',
    description: 'A slow drift through vaulted stacks and candlelit shelves.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.RARE,
    price: 220,
    weight: 6,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '📜' },
  },

  profile_banner_archeology: {
    id: 'profile_banner_archeology',
    name: 'Archeology Banner',
    description: 'A panoramic sweep across sunlit dig sites and relics.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.RARE,
    price: 220,
    weight: 6,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '🏺' },
  },

  profile_banner_blueprints: {
    id: 'profile_banner_blueprints',
    name: 'Blueprints Banner',
    description: 'Technical drawings drifting behind chrome tabs.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.RARE,
    price: 220,
    weight: 6,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '📐' },
  },

  profile_banner_chalkboard: {
    id: 'profile_banner_chalkboard',
    name: 'Chalkboard Banner',
    description: 'A classroom chalkboard panorama in slow motion.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.RARE,
    price: 220,
    weight: 6,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '🧮' },
  },

  profile_banner_circuit_board: {
    id: 'profile_banner_circuit_board',
    name: 'Circuit Board Banner',
    description: 'Traces and solder paths gliding across banner chrome.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.RARE,
    price: 220,
    weight: 6,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '🔌' },
  },

  profile_banner_city: {
    id: 'profile_banner_city',
    name: 'City Banner',
    description: 'An urban skyline panorama behind the header.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.RARE,
    price: 220,
    weight: 6,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '🏙️' },
  },

  profile_banner_computer_lab: {
    id: 'profile_banner_computer_lab',
    name: 'Computer Lab Banner',
    description: 'Monitors and lab benches in a gentle panoramic drift.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.RARE,
    price: 220,
    weight: 6,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '💻' },
  },

  profile_banner_desert: {
    id: 'profile_banner_desert',
    name: 'Desert Banner',
    description: 'Dunes and horizon light sweeping across chrome.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.RARE,
    price: 220,
    weight: 6,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '🏜️' },
  },

  profile_banner_jungle_banner: {
    id: 'profile_banner_jungle_banner',
    name: 'Jungle Banner',
    description: 'Dense canopy foliage in a slow panoramic pass.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.RARE,
    price: 220,
    weight: 6,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '🌿' },
  },

  profile_banner_night_sky: {
    id: 'profile_banner_night_sky',
    name: 'Night Sky Banner',
    description: 'Stars and deep sky drifting behind the tab bar.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.RARE,
    price: 220,
    weight: 6,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '🌌' },
  },

  profile_banner_observatory: {
    id: 'profile_banner_observatory',
    name: 'Observatory Banner',
    description: 'Domes and telescopes in a calm observatory panorama.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.RARE,
    price: 220,
    weight: 6,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '🔭' },
  },

  profile_banner_particle_accelerator: {
    id: 'profile_banner_particle_accelerator',
    name: 'Particle Accelerator Banner',
    description: 'Accelerator halls and beam lines in ambient motion.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.RARE,
    price: 220,
    weight: 6,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '⚛️' },
  },

  profile_banner_underwater_research_facility: {
    id: 'profile_banner_underwater_research_facility',
    name: 'Underwater Research Facility Banner',
    description: 'Submerged labs and blue depths gliding across chrome.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.PROFILE_BANNER,
    rarity: ITEM_RARITIES.RARE,
    price: 220,
    weight: 6,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
    display: { emoji: '🫧' },
  },

  // ── Cosmetics — Shell Backgrounds (BG-1 solid / BG-2 asset; visuals in CSS + /assets/backgrounds/) ──

  shell_background_deep_blue: {
    id: 'shell_background_deep_blue',
    name: 'Deep Blue',
    description: 'A deep blue gameplay shell background.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.COMMON,
    price: 75,
    weight: 14,
    enabled: true,
    display: { emoji: '▮' },
  },

  shell_background_crimson: {
    id: 'shell_background_crimson',
    name: 'Crimson',
    description: 'A deep crimson gameplay shell background.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.COMMON,
    price: 75,
    weight: 14,
    enabled: true,
    display: { emoji: '▮' },
  },

  shell_background_emerald: {
    id: 'shell_background_emerald',
    name: 'Emerald',
    description: 'A deep emerald gameplay shell background.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.COMMON,
    price: 75,
    weight: 14,
    enabled: true,
    display: { emoji: '▮' },
  },

  shell_background_purple: {
    id: 'shell_background_purple',
    name: 'Purple',
    description: 'A deep purple gameplay shell background.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 120,
    weight: 10,
    enabled: true,
    display: { emoji: '▮' },
  },

  shell_background_charcoal: {
    id: 'shell_background_charcoal',
    name: 'Charcoal',
    description: 'A neutral charcoal gameplay shell background.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.COMMON,
    price: 50,
    weight: 16,
    enabled: true,
    display: { emoji: '▮' },
  },

  shell_background_slate: {
    id: 'shell_background_slate',
    name: 'Slate',
    description: 'A cool slate gameplay shell background.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.COMMON,
    price: 50,
    weight: 16,
    enabled: true,
    display: { emoji: '▮' },
  },

  shell_background_crimson_fade: {
    id: 'shell_background_crimson_fade',
    name: 'Crimson Fade',
    description: 'Crimson atmosphere fading into deep black — CSS gameplay shell backdrop.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 160,
    weight: 9,
    enabled: true,
    display: { emoji: '▮' },
  },

  shell_background_arctic_depths: {
    id: 'shell_background_arctic_depths',
    name: 'Arctic Depths',
    description: 'Arctic cyan fading into navy depth — CSS gameplay shell backdrop.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 165,
    weight: 9,
    enabled: true,
    display: { emoji: '▮' },
  },

  shell_background_teal_emerald: {
    id: 'shell_background_teal_emerald',
    name: 'Teal Emerald',
    description: 'Teal highlights melting into emerald depth — CSS gameplay shell backdrop.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 165,
    weight: 9,
    enabled: true,
    display: { emoji: '▮' },
  },

  shell_background_deep_cosmos: {
    id: 'shell_background_deep_cosmos',
    name: 'Deep Cosmos',
    description: 'Deep blue space fading into dark violet — CSS gameplay shell backdrop.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 170,
    weight: 8,
    enabled: true,
    display: { emoji: '▮' },
  },

  shell_background_aurora: {
    id: 'shell_background_aurora',
    name: 'Aurora',
    description: 'Layered auroral color fields — CSS atmospheric shell backdrop.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.RARE,
    price: 240,
    weight: 6,
    enabled: true,
    display: { emoji: '✨' },
  },

  shell_background_nebula: {
    id: 'shell_background_nebula',
    name: 'Nebula',
    description: 'Soft nebular color masses with depth — CSS atmospheric shell backdrop.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.RARE,
    price: 250,
    weight: 6,
    enabled: true,
    display: { emoji: '✨' },
  },

  shell_background_starry_sky: {
    id: 'shell_background_starry_sky',
    name: 'Starry Sky',
    description: 'A distant night sky with the Milky Way — repository-authored artwork.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.RARE,
    price: 280,
    weight: 5,
    enabled: true,
    display: { emoji: '🌌' },
  },

  shell_background_blueprint_paper: {
    id: 'shell_background_blueprint_paper',
    name: 'Blueprint Paper',
    description: 'Technical blueprint tones for the gameplay shell backdrop.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 190,
    weight: 8,
    enabled: true,
    display: { emoji: '📐' },
  },

  shell_background_football_field: {
    id: 'shell_background_football_field',
    name: 'Football Field',
    description: 'Stadium turf atmosphere for the gameplay shell backdrop.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 200,
    weight: 7,
    enabled: true,
    display: { emoji: '🏈' },
  },

  shell_background_jungle: {
    id: 'shell_background_jungle',
    name: 'Jungle',
    description: 'Lush rainforest canopy mood for the gameplay shell backdrop.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 200,
    weight: 7,
    enabled: true,
    display: { emoji: '🌿' },
  },

  shell_background_pyramids: {
    id: 'shell_background_pyramids',
    name: 'Pyramids',
    description: 'Desert monument atmosphere for the gameplay shell backdrop.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.RARE,
    price: 260,
    weight: 5,
    enabled: true,
    display: { emoji: '🔺' },
  },

  shell_background_saturn: {
    id: 'shell_background_saturn',
    name: 'Saturn',
    description: 'Ringed planet vista for the gameplay shell backdrop.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.RARE,
    price: 280,
    weight: 5,
    enabled: true,
    display: { emoji: '🪐' },
  },

  shell_background_spiral_galaxy: {
    id: 'shell_background_spiral_galaxy',
    name: 'Spiral Galaxy',
    description: 'Deep-space spiral structure for the gameplay shell backdrop.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.RARE,
    price: 300,
    weight: 4,
    enabled: true,
    display: { emoji: '🌀' },
  },

  shell_background_car: {
    id: 'shell_background_car',
    name: 'Car',
    description: 'Automotive scene mood for the gameplay shell backdrop.',
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.SHELL_BACKGROUND,
    rarity: ITEM_RARITIES.UNCOMMON,
    price: 190,
    weight: 7,
    enabled: true,
    display: { emoji: '🚗' },
  },

  // ── Cosmetics — Titles ─────────────────────────────────────────────────
  // Titles are authored via Admin → Cosmetics (Firebase registry). No static title seeds.
});

/**
 * Resolve lightweight display metadata for any shop item definition.
 * Prefers definition.display (emoji, icon, symbol, cssClass); falls back by type/behavior.
 * @param {Object|null|undefined} definition
 * @returns {{ emoji: string, cssClass: string }}
 */
export function resolveItemDisplay(definition) {
  const display = definition?.display;
  const emojiFromMeta = display?.emoji || display?.icon || display?.symbol;
  if (typeof emojiFromMeta === 'string' && emojiFromMeta.trim()) {
    return {
      emoji: emojiFromMeta.trim(),
      cssClass: typeof display?.cssClass === 'string' ? display.cssClass.trim() : '',
    };
  }
  if (typeof definition?.iconClass === 'string' && definition.iconClass.trim()) {
    return { emoji: fallbackEmoji(definition), cssClass: definition.iconClass.trim() };
  }
  return { emoji: fallbackEmoji(definition), cssClass: '' };
}

function fallbackEmoji(definition) {
  if (!definition) return '•';
  if (definition.type === ITEM_TYPES.COSMETIC) {
    if (definition.category === ITEM_CATEGORIES.AURA) return '✦';
    if (definition.category === ITEM_CATEGORIES.BORDER) return '▣';
    if (definition.category === ITEM_CATEGORIES.SHIMMER) return '✧';
    if (definition.category === ITEM_CATEGORIES.PROFILE_BANNER) return '▰';
    if (definition.category === ITEM_CATEGORIES.SHELL_BACKGROUND) return '▮';
    if (definition.category === ITEM_CATEGORIES.TITLE) return '★';
    return '◆';
  }
  if (definition.behaviorType === 'apply_discount') return '%';
  if (definition.behaviorType === 'freeze_slot') return '❄';
  if (definition.behaviorType === 'grant_research') return '⌁';
  if (definition.behaviorType === 'reroll_shop') return '↻';
  if (definition.type === ITEM_TYPES.PACK) return '▤';
  if (definition.type === ITEM_TYPES.CARD) return '▥';
  if (definition.type === ITEM_TYPES.CONSUMABLE) return '◈';
  return '•';
}
