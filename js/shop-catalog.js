/**
 * shop-catalog.js
 * Assembles the full shop-eligible item pool from static definitions,
 * rarity-driven cards, and pack shop settings. Generation stays pure by
 * receiving the assembled pool from mutation/lifecycle callers.
 */

import { getShopConfig, getShopItemDefinitions } from './shop-config.js';
import { isCosmeticShopEligible } from './cosmetic-definitions.js';
import { ITEM_CATEGORIES, ITEM_RARITIES, ITEM_TYPES } from './shop-definitions.js';
import * as cards from './cards.js';
import * as packs from './packs.js';

export const SHOP_CARD_PREFIX = 'shop_card:';
export const SHOP_PACK_PREFIX = 'shop_pack:';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toNonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function toPositiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function toShopCardItemId(cardId) {
  return `${SHOP_CARD_PREFIX}${cardId}`;
}

export function toShopPackItemId(packId) {
  return `${SHOP_PACK_PREFIX}${packId}`;
}

export function parseShopItemId(itemId) {
  if (typeof itemId !== 'string') return null;
  if (itemId.startsWith(SHOP_CARD_PREFIX)) {
    return { kind: 'card', sourceId: itemId.slice(SHOP_CARD_PREFIX.length) };
  }
  if (itemId.startsWith(SHOP_PACK_PREFIX)) {
    return { kind: 'pack', sourceId: itemId.slice(SHOP_PACK_PREFIX.length) };
  }
  return { kind: 'static', sourceId: itemId };
}

/**
 * One synthetic shop entry per enabled card whose rarity is enabled in config.
 * Rarity controls are global settings applied per eligible card (not per-rarity
 * grouped selection): e.g. common.weight = 20 gives every enabled common card
 * weight 20 in the weighted pool as shop_card:{cardId}.
 */
function buildCardShopEntries(config) {
  const controls = isObject(config?.cardRarityControls) ? config.cardRarityControls : {};
  const enabledCards = cards.getEnabledCards();
  const entries = [];

  for (const card of enabledCards) {
    const rarity = card?.rarity;
    const rarityControl = isObject(controls[rarity]) ? controls[rarity] : null;
    if (!rarityControl || rarityControl.enabled !== true) continue;

    const weight = toPositiveNumber(rarityControl.weight, 0);
    const price = toNonNegativeInteger(rarityControl.price, 0);
    if (weight <= 0) continue;

    entries.push({
      id: toShopCardItemId(card.id),
      name: card.name || card.id,
      description: card.description || '',
      type: ITEM_TYPES.CARD,
      category: ITEM_CATEGORIES.CARD,
      rarity: rarity || ITEM_RARITIES.COMMON,
      price,
      weight,
      enabled: true,
      sourceType: 'card',
      sourceId: card.id,
    });
  }

  return entries;
}

function buildPackShopEntries() {
  const entries = [];

  for (const packType of packs.getAllPackTypes()) {
    const shop = isObject(packType?.shop) ? packType.shop : {};
    if (shop.enabled !== true) continue;

    const weight = toPositiveNumber(shop.weight, 0);
    const price = toNonNegativeInteger(shop.price, 0);
    if (weight <= 0) continue;

    entries.push({
      id: toShopPackItemId(packType.id),
      name: packType.name || packType.id,
      description: `${packType.cardsPerPack || 0} cards per pack`,
      type: ITEM_TYPES.PACK,
      category: ITEM_CATEGORIES.PACK,
      rarity: shop.rarity || ITEM_RARITIES.COMMON,
      price,
      weight,
      enabled: true,
      sourceType: 'pack',
      sourceId: packType.id,
    });
  }

  return entries;
}

/**
 * Builds the merged shop catalog and lookup helpers.
 *
 * @param {Object} [config] Optional shop config override.
 * @returns {{ pool: Array, lookup: Map, getItem: Function }}
 */
export function buildShopCatalog(config = getShopConfig()) {
  const staticItems = Object.values(getShopItemDefinitions())
    .filter(item => item?.deleted !== true)
    .filter(item => item?.type === ITEM_TYPES.COSMETIC
      ? isCosmeticShopEligible(item)
      : item?.enabled !== false)
    .map(item => ({ ...item, sourceType: 'static', sourceId: item.id }));

  const pool = [
    ...staticItems,
    ...buildCardShopEntries(config),
    ...buildPackShopEntries(),
  ];

  const lookup = new Map(pool.map(item => [item.id, item]));

  return {
    pool,
    lookup,
    getItem(itemId) {
      return lookup.get(itemId) || null;
    },
  };
}
