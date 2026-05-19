/**
 * shop-config.js
 * Phase 1A — Centralized configurable economy defaults.
 * NO gameplay logic. NO rendering. Runtime config persistence is scoped to
 * config/shop and consumed through helper functions.
 */

import * as db from './database.js';
import { ITEM_DEFINITIONS, ITEM_RARITIES } from './shop-definitions.js';

const ALL_RARITIES = Object.values(ITEM_RARITIES);

function defaultCardRarityControls() {
  return Object.freeze({
    common: { enabled: true, price: 50, weight: 20 },
    uncommon: { enabled: true, price: 100, weight: 10 },
    rare: { enabled: false, price: 250, weight: 0 },
    epic: { enabled: false, price: 500, weight: 0 },
    legendary: { enabled: false, price: 1000, weight: 0 },
  });
}

// ── Default Shop Configuration ──────────────────────────────────────────────
// All slot constraints are configurable down to 0.
// shopSlotCount is conceptually constrained to 3–9.
// rerollCosts supports individually configurable reroll types.

export const DEFAULT_SHOP_CONFIG = Object.freeze({

  // Legacy field — automatic shop refresh uses weekly-research-pack.js timing (ignored by generation).
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
  // Legacy combined cap — used only when maxCardSlots/maxPackSlots are absent.
  maximumPackAndCardSlots: 2,

  // Independent slot caps (preferred over maximumPackAndCardSlots).
  maxCardSlots: 1,
  maxPackSlots: 1,

  // Rarity-driven card shop controls (not per-card whitelisting).
  cardRarityControls: defaultCardRarityControls(),

  // Built-in RP rerolls per rotation (0–3), independent from token rerolls.
  builtInRerolls: Object.freeze({
    total: 3,
    costs: Object.freeze([100, 250, 500]),
  }),

  // Whether cosmetics the player already owns can appear in the shop
  allowOwnedCosmeticsInShop: false,

  // Version tag for the generation algorithm; bumping this signals
  // that previously generated shops may need regeneration.
  generationVersion: 1,
});

export { ALL_RARITIES };

const SHOP_CONFIG_PATH = 'config/shop';
const ITEM_OVERRIDES_PATH = 'config/shop/itemOverrides';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeCardRarityControls(overrides = {}) {
  const merged = {};
  for (const rarity of ALL_RARITIES) {
    const defaults = DEFAULT_SHOP_CONFIG.cardRarityControls[rarity];
    const patch = isObject(overrides?.[rarity]) ? overrides[rarity] : {};
    merged[rarity] = {
      ...defaults,
      ...patch,
    };
  }
  return merged;
}

function mergeBuiltInRerolls(overrides = {}) {
  const defaults = DEFAULT_SHOP_CONFIG.builtInRerolls;
  const costs = Array.isArray(overrides?.costs)
    ? overrides.costs.map(value => Math.max(0, Number(value) || 0))
    : [...defaults.costs];
  const total = Math.min(
    3,
    Math.max(0, Math.floor(Number(overrides?.total ?? defaults.total) || 0))
  );
  return {
    total,
    costs: costs.slice(0, Math.max(total, costs.length)),
  };
}

export function resolveMaxCardSlots(config = DEFAULT_SHOP_CONFIG) {
  if (Number.isFinite(Number(config?.maxCardSlots))) {
    return Math.max(0, Math.floor(Number(config.maxCardSlots)));
  }
  if (Number.isFinite(Number(config?.maximumPackAndCardSlots))) {
    return Math.max(0, Math.floor(Number(config.maximumPackAndCardSlots)));
  }
  return DEFAULT_SHOP_CONFIG.maxCardSlots;
}

export function resolveMaxPackSlots(config = DEFAULT_SHOP_CONFIG) {
  if (Number.isFinite(Number(config?.maxPackSlots))) {
    return Math.max(0, Math.floor(Number(config.maxPackSlots)));
  }
  if (Number.isFinite(Number(config?.maximumPackAndCardSlots))) {
    return Math.max(0, Math.floor(Number(config.maximumPackAndCardSlots)));
  }
  return DEFAULT_SHOP_CONFIG.maxPackSlots;
}

export function resolveBuiltInRerolls(config = DEFAULT_SHOP_CONFIG) {
  if (isObject(config?.builtInRerolls)) {
    return mergeBuiltInRerolls(config.builtInRerolls);
  }
  return mergeBuiltInRerolls(DEFAULT_SHOP_CONFIG.builtInRerolls);
}

export function getBuiltInRerollCost(config, rerollsUsed) {
  const builtIn = resolveBuiltInRerolls(config);
  const index = Math.max(0, Math.floor(Number(rerollsUsed) || 0));
  if (index >= builtIn.total) return null;
  const cost = builtIn.costs[index];
  return Number.isFinite(Number(cost)) && Number(cost) >= 0 ? Number(cost) : null;
}

function mergeShopConfig(overrides = {}) {
  return {
    ...DEFAULT_SHOP_CONFIG,
    ...(isObject(overrides) ? overrides : {}),
    rerollCosts: {
      ...DEFAULT_SHOP_CONFIG.rerollCosts,
      ...(isObject(overrides?.rerollCosts) ? overrides.rerollCosts : {}),
    },
    cardRarityControls: mergeCardRarityControls(
      isObject(overrides?.cardRarityControls) ? overrides.cardRarityControls : {}
    ),
    builtInRerolls: mergeBuiltInRerolls(
      isObject(overrides?.builtInRerolls) ? overrides.builtInRerolls : {}
    ),
    itemOverrides: isObject(overrides?.itemOverrides) ? overrides.itemOverrides : {},
  };
}

function mergeDefinition(definition, override = {}) {
  if (!isObject(override)) return definition;
  return {
    ...definition,
    ...override,
    behaviorConfig: {
      ...(isObject(definition?.behaviorConfig) ? definition.behaviorConfig : {}),
      ...(isObject(override.behaviorConfig) ? override.behaviorConfig : {}),
    },
  };
}

export function getShopConfig() {
  return mergeShopConfig(db.get(SHOP_CONFIG_PATH) || {});
}

/**
 * Canonical runtime config for generation and mutations.
 * Uses persisted admin config unless an explicit override is provided.
 */
export function resolveShopRuntimeConfig(configOverride) {
  if (isObject(configOverride)) {
    return mergeShopConfig(configOverride);
  }
  return getShopConfig();
}

export function saveShopConfig(configPatch = {}) {
  const current = db.get(SHOP_CONFIG_PATH) || {};
  const next = mergeShopConfig({
    ...current,
    ...configPatch,
    rerollCosts: {
      ...(isObject(current.rerollCosts) ? current.rerollCosts : {}),
      ...(isObject(configPatch.rerollCosts) ? configPatch.rerollCosts : {}),
    },
    cardRarityControls: mergeCardRarityControls({
      ...(isObject(current.cardRarityControls) ? current.cardRarityControls : {}),
      ...(isObject(configPatch.cardRarityControls) ? configPatch.cardRarityControls : {}),
    }),
    builtInRerolls: mergeBuiltInRerolls({
      ...(isObject(current.builtInRerolls) ? current.builtInRerolls : {}),
      ...(isObject(configPatch.builtInRerolls) ? configPatch.builtInRerolls : {}),
    }),
    itemOverrides: isObject(current.itemOverrides) ? current.itemOverrides : {},
  });
  db.set(SHOP_CONFIG_PATH, next);
  return next;
}

export function getShopItemDefinitions() {
  const overrides = db.get(ITEM_OVERRIDES_PATH) || {};
  return Object.fromEntries(
    Object.entries(ITEM_DEFINITIONS).map(([itemId, definition]) => [
      itemId,
      mergeDefinition(definition, overrides[itemId]),
    ])
  );
}

export function saveShopItemOverride(itemId, patch = {}) {
  if (!itemId || !ITEM_DEFINITIONS[itemId] || !isObject(patch)) {
    return { success: false, reason: 'invalid_item_override' };
  }
  const current = db.get(`${ITEM_OVERRIDES_PATH}/${itemId}`) || {};
  const next = mergeDefinition(current, patch);
  db.set(`${ITEM_OVERRIDES_PATH}/${itemId}`, next);
  return { success: true, itemId, override: next };
}

export function resetShopConfigOverrides() {
  db.set(SHOP_CONFIG_PATH, mergeShopConfig());
  return getShopConfig();
}
