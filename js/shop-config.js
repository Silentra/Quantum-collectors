/**
 * shop-config.js
 * Phase 1A — Centralized configurable economy defaults.
 * NO gameplay logic. NO rendering. Runtime config persistence is scoped to
 * config/shop and consumed through helper functions.
 */

import * as db from './database.js';
import { ITEM_DEFINITIONS } from './shop-definitions.js';

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

const SHOP_CONFIG_PATH = 'config/shop';
const ITEM_OVERRIDES_PATH = 'config/shop/itemOverrides';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeShopConfig(overrides = {}) {
  return {
    ...DEFAULT_SHOP_CONFIG,
    ...(isObject(overrides) ? overrides : {}),
    rerollCosts: {
      ...DEFAULT_SHOP_CONFIG.rerollCosts,
      ...(isObject(overrides?.rerollCosts) ? overrides.rerollCosts : {}),
    },
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

export function saveShopConfig(configPatch = {}) {
  const current = db.get(SHOP_CONFIG_PATH) || {};
  const next = mergeShopConfig({
    ...current,
    ...configPatch,
    rerollCosts: {
      ...(isObject(current.rerollCosts) ? current.rerollCosts : {}),
      ...(isObject(configPatch.rerollCosts) ? configPatch.rerollCosts : {}),
    },
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
