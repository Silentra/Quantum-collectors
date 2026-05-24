/**
 * shop-validation.js
 * ==================
 * Phase 3 validation and exploit-prevention layer.
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
 * Dependencies:
 *   - js/shop-config.js  (reroll costs, maxFrozenSlots)
 *   - js/shop-generation.js (slot normalization, reroll scope helpers)
 *
 * Phase 3 note: reroll/freeze guards are pure and perform no Firebase writes,
 * rendering, or inventory/currency mutation.
 */

import {
  DEFAULT_SHOP_CONFIG,
  getBuiltInRerollCost,
  resolveBuiltInRerolls,
} from './shop-config.js';
import {
  getCosmeticDefinition,
  getItemDefinition,
  isCosmeticDefinitionActive,
} from './cosmetic-definitions.js';
import { ITEM_CATEGORIES, ITEM_TYPES } from './shop-definitions.js';
import { PROJECT_STATES } from './project-state.js';
import { getAvailableProjectSlots } from './project-refresh.js';
import { MAX_FEATURED_ACHIEVEMENTS, MAX_FEATURED_CARDS } from './player-schema.js';
import {
  REROLL_SCOPES,
  getShopRotationSlots,
  itemMatchesRerollScope,
} from './shop-generation.js';

const SUPPORTED_CONSUMABLE_BEHAVIORS = Object.freeze([
  'reroll_shop',
  'apply_discount',
  'freeze_slot',
  'grant_research',
]);

const COSMETIC_CATEGORY_FIELDS = Object.freeze({
  [ITEM_CATEGORIES.AURA]: 'equippedAura',
  [ITEM_CATEGORIES.BORDER]: 'equippedBorder',
  [ITEM_CATEGORIES.PROFILE_BANNER]: 'equippedBanner',
  banner: 'equippedBanner',
  profileBanner: 'equippedBanner',
  [ITEM_CATEGORIES.SHELL_BACKGROUND]: 'equippedBackground',
  shellBackground: 'equippedBackground',
  [ITEM_CATEGORIES.TITLE]: 'equippedTitle',
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeConfig(config = DEFAULT_SHOP_CONFIG) {
  return {
    ...DEFAULT_SHOP_CONFIG,
    ...(isObject(config) ? config : {}),
    rerollCosts: {
      ...DEFAULT_SHOP_CONFIG.rerollCosts,
      ...(isObject(config?.rerollCosts) ? config.rerollCosts : {}),
    },
  };
}

function getRotation(player) {
  return isObject(player?.shop?.currentRotation) ? player.shop.currentRotation : null;
}

function getCurrentResearchPoints(player) {
  return Number(player?.currencies?.currentResearchPoints || 0);
}

function getRerollCost(scope, config) {
  const cost = Number(config.rerollCosts?.[scope]);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

function isValidScope(scope, config) {
  return Object.values(REROLL_SCOPES).includes(scope) && getRerollCost(scope, config) !== null;
}

function getSlotItem(slot, options = {}) {
  if (!slot?.itemId) return null;
  if (typeof options.getItem === 'function') {
    return options.getItem(slot.itemId);
  }
  return getItemDefinition(slot.itemId);
}

function getBuiltInRerollsUsed(player) {
  return Math.max(0, Math.floor(Number(player?.shopUsage?.rerollsUsedThisRotation || 0)));
}

function countFrozenSlots(slots) {
  return slots.filter(slot => slot?.frozen === true).length;
}

function getExtraFreezeAllowance(player) {
  return Math.max(0, Math.floor(Number(player?.shopUsage?.extraFreezeAllowanceThisRotation || 0)));
}

function countCapProjects(projects = []) {
  if (!Array.isArray(projects)) return 0;
  return projects.filter(project =>
    project?.state === PROJECT_STATES.AVAILABLE ||
    project?.state === PROJECT_STATES.ACTIVE
  ).length;
}

function getConsumableQuantity(player, itemId) {
  return Math.max(0, Math.floor(Number(player?.items?.[itemId] || 0)));
}

function hasSlotIndex(context = {}) {
  const index = Number(context.slotIndex);
  return Number.isInteger(index) && index >= 0;
}

function getOwnedCosmetics(player) {
  return isObject(player?.cosmetics?.owned) ? player.cosmetics.owned : {};
}

function getPurchasePrice(slot) {
  const price = Number(slot?.currentPrice ?? slot?.basePrice);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function getProfile(player) {
  return isObject(player?.profile) ? player.profile : {};
}

function normalizeIdArray(raw) {
  return Array.isArray(raw)
    ? raw.filter(value => typeof value === 'string' && value.trim())
    : [];
}

function getCosmeticProfileField(category) {
  return COSMETIC_CATEGORY_FIELDS[category] || null;
}

function isAchievementUnlocked(container, achievementId) {
  const value = container?.[achievementId];
  if (value === true) return true;
  if (isObject(value)) {
    return value.unlocked === true || value.completed === true || value.earned === true;
  }
  return false;
}

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
export function canPurchaseItem(player, slotIndex, options = {}) {
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };

  const slots = getShopRotationSlots(getRotation(player));
  const index = Number(slotIndex);
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) {
    return { allowed: false, reason: 'invalid_slot_index' };
  }

  const slot = slots[index];
  if (slot?.purchased === true) return { allowed: false, reason: 'slot_purchased' };
  if (!slot?.itemId) return { allowed: false, reason: 'missing_item_id' };

  const itemDefinition = getSlotItem(slot, options);
  if (!itemDefinition || itemDefinition.enabled === false) {
    return { allowed: false, reason: 'invalid_item_definition' };
  }

  const currency = slot.currency || 'rp';
  if (currency !== 'rp') {
    return { allowed: false, reason: 'unsupported_currency', currency };
  }

  const price = getPurchasePrice(slot);
  if (price === null) {
    return { allowed: false, reason: 'invalid_slot_price' };
  }

  if (itemDefinition.type === ITEM_TYPES.COSMETIC && getOwnedCosmetics(player)[itemDefinition.id]) {
    return { allowed: false, reason: 'cosmetic_already_owned' };
  }

  const supportedTypes = new Set([
    ITEM_TYPES.COSMETIC,
    ITEM_TYPES.CONSUMABLE,
    ITEM_TYPES.CARD,
    ITEM_TYPES.PACK,
  ]);
  if (!supportedTypes.has(itemDefinition.type)) {
    return { allowed: false, reason: 'unsupported_item_type', itemType: itemDefinition.type };
  }

  if (itemDefinition.type === ITEM_TYPES.CONSUMABLE && !getItemDefinition(itemDefinition.id)) {
    return { allowed: false, reason: 'invalid_consumable_grant' };
  }

  if (getCurrentResearchPoints(player) < price) {
    return { allowed: false, reason: 'insufficient_rp', price, currency };
  }

  return {
    allowed: true,
    reason: null,
    itemDefinition,
    price,
    currency,
    slot,
    slotIndex: index,
  };
}

// ---------------------------------------------------------------------------
// canRerollSlot
// ---------------------------------------------------------------------------
/**
 * Checks whether a player can reroll a specific shop slot.
 *
 * Phase 3 checks:
 * - Slot is not purchased (purchased slots are immutable).
 * - Slot is not frozen.
 * - Player has enough RP for the configured reroll cost.
 * - Slot index is valid.
 * - RP will not go below 0 after deduction.
 *
 * @returns {Object}
 */
export function canRerollSlot(player, slotIndex, scope = REROLL_SCOPES.ALL, config = DEFAULT_SHOP_CONFIG, options = {}) {
  const effectiveConfig = normalizeConfig(config);
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };
  if (!isValidScope(scope, effectiveConfig)) return { allowed: false, reason: 'invalid_reroll_scope' };

  const rotation = getRotation(player);
  const slots = getShopRotationSlots(rotation);
  const index = Number(slotIndex);
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) {
    return { allowed: false, reason: 'invalid_slot_index' };
  }

  const slot = slots[index];
  if (slot?.purchased === true) return { allowed: false, reason: 'slot_purchased' };
  if (slot?.frozen === true) return { allowed: false, reason: 'slot_frozen' };

  const item = getSlotItem(slot, options);
  const requireCurrentSlotScope = options.requireCurrentSlotScope !== false;
  if (requireCurrentSlotScope && scope !== REROLL_SCOPES.ALL && !itemMatchesRerollScope(item, scope)) {
    return { allowed: false, reason: 'slot_scope_mismatch' };
  }

  const paymentMode = options.paymentMode || 'rp';
  if (paymentMode === 'token') {
    return { allowed: true, reason: null, cost: 0, scope, paymentMode };
  }

  const rerollsUsed = getBuiltInRerollsUsed(player);
  const builtIn = resolveBuiltInRerolls(effectiveConfig);
  if (rerollsUsed >= builtIn.total) {
    return { allowed: false, reason: 'built_in_rerolls_exhausted', rerollsUsed, total: builtIn.total };
  }

  const cost = getBuiltInRerollCost(effectiveConfig, rerollsUsed);
  if (cost === null) {
    const legacyCost = getRerollCost(scope, effectiveConfig);
    if (legacyCost === null) {
      return { allowed: false, reason: 'invalid_reroll_cost' };
    }
    if (getCurrentResearchPoints(player) < legacyCost) {
      return { allowed: false, reason: 'insufficient_rp', cost: legacyCost };
    }
    return { allowed: true, reason: null, cost: legacyCost, scope, paymentMode };
  }

  if (getCurrentResearchPoints(player) < cost) {
    return { allowed: false, reason: 'insufficient_rp', cost };
  }

  return { allowed: true, reason: null, cost, scope, paymentMode };
}

// ---------------------------------------------------------------------------
// canRerollRotation
// ---------------------------------------------------------------------------
/**
 * Checks whether a player can reroll all eligible slots for a scope.
 *
 * @param {Object} player
 * @param {string} scope
 * @param {Object} config
 * @returns {Object}
 */
export function canRerollRotation(player, scope = REROLL_SCOPES.ALL, config = DEFAULT_SHOP_CONFIG, options = {}) {
  const effectiveConfig = normalizeConfig(config);
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };
  if (!isValidScope(scope, effectiveConfig)) return { allowed: false, reason: 'invalid_reroll_scope' };

  const slots = getShopRotationSlots(getRotation(player));
  const eligibleSlots = slots
    .map((slot, index) => ({ slot, index, item: getSlotItem(slot, options) }))
    .filter(({ slot, item }) => slot?.purchased !== true &&
      slot?.frozen !== true &&
      itemMatchesRerollScope(item, scope));

  if (eligibleSlots.length === 0) {
    return { allowed: false, reason: 'no_eligible_slots' };
  }

  const paymentMode = options.paymentMode || 'rp';
  if (paymentMode === 'token') {
    return {
      allowed: true,
      reason: null,
      cost: 0,
      scope,
      eligibleSlotIndexes: eligibleSlots.map(({ index }) => index),
    };
  }

  const rerollsUsed = getBuiltInRerollsUsed(player);
  const builtIn = resolveBuiltInRerolls(effectiveConfig);
  if (rerollsUsed >= builtIn.total) {
    return { allowed: false, reason: 'built_in_rerolls_exhausted', rerollsUsed, total: builtIn.total };
  }

  const cost = getBuiltInRerollCost(effectiveConfig, rerollsUsed);
  const resolvedCost = cost === null ? getRerollCost(scope, effectiveConfig) : cost;
  if (resolvedCost === null) {
    return { allowed: false, reason: 'invalid_reroll_cost' };
  }
  if (getCurrentResearchPoints(player) < resolvedCost) {
    return { allowed: false, reason: 'insufficient_rp', cost: resolvedCost };
  }

  return {
    allowed: true,
    reason: null,
    cost: resolvedCost,
    scope,
    eligibleSlotIndexes: eligibleSlots.map(({ index }) => index),
  };
}

// ---------------------------------------------------------------------------
// canFreezeSlot
// ---------------------------------------------------------------------------
/**
 * Checks whether a player can freeze a specific shop slot.
 *
 * Phase 3 checks:
 * - Slot is not already purchased (purchased slots cannot be frozen).
 * - Total frozen slots has not reached maxFrozenSlots limit.
 * - Phase 3 does not require or consume freeze tokens.
 * - Slot is not already frozen (no double-freeze).
 *
 * @returns {Object}
 */
export function canFreezeSlot(player, slotIndex, config = DEFAULT_SHOP_CONFIG) {
  const effectiveConfig = normalizeConfig(config);
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };

  const slots = getShopRotationSlots(getRotation(player));
  const index = Number(slotIndex);
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) {
    return { allowed: false, reason: 'invalid_slot_index' };
  }

  const slot = slots[index];
  if (slot?.purchased === true) return { allowed: false, reason: 'slot_purchased' };
  if (slot?.frozen === true) return { allowed: false, reason: 'slot_already_frozen' };

  const maxFrozenSlots = Math.max(0, Math.floor(Number(effectiveConfig.maxFrozenSlots || 0))) +
    getExtraFreezeAllowance(player);
  if (countFrozenSlots(slots) >= maxFrozenSlots) {
    return { allowed: false, reason: 'max_frozen_slots_reached', maxFrozenSlots };
  }

  return { allowed: true, reason: null, maxFrozenSlots };
}

// ---------------------------------------------------------------------------
// canGrantFreezeAllowance
// ---------------------------------------------------------------------------
/**
 * Checks whether a consumable can add one current-rotation freeze allowance.
 *
 * @param {Object} player
 * @param {Object} config
 * @returns {Object}
 */
export function canGrantFreezeAllowance(player, config = DEFAULT_SHOP_CONFIG) {
  const effectiveConfig = normalizeConfig(config);
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };

  const slots = getShopRotationSlots(getRotation(player));
  if (slots.length === 0) return { allowed: false, reason: 'missing_shop_rotation' };

  const baseMaxFrozenSlots = Math.max(0, Math.floor(Number(effectiveConfig.maxFrozenSlots || 0)));
  const extraAllowance = getExtraFreezeAllowance(player);
  const freezableSlots = slots.filter(slot => slot?.purchased !== true).length;

  if (baseMaxFrozenSlots + extraAllowance >= freezableSlots) {
    return { allowed: false, reason: 'no_freeze_capacity_available', maxFrozenSlots: baseMaxFrozenSlots + extraAllowance };
  }

  return {
    allowed: true,
    reason: null,
    extraAllowance,
    nextExtraAllowance: extraAllowance + 1,
    maxFrozenSlots: baseMaxFrozenSlots + extraAllowance + 1,
  };
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
export function canApplyDiscount(player, slotIndex, discountConfig = {}) {
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };

  const slots = getShopRotationSlots(getRotation(player));
  const index = Number(slotIndex);
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) {
    return { allowed: false, reason: 'invalid_slot_index' };
  }

  const slot = slots[index];
  if (slot?.purchased === true) return { allowed: false, reason: 'slot_purchased' };
  if (slot?.discountApplied !== null && slot?.discountApplied !== undefined) {
    return { allowed: false, reason: 'discount_already_applied' };
  }

  const percent = Number(discountConfig.percent);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return { allowed: false, reason: 'invalid_discount_percent' };
  }

  const currentPrice = Number(slot?.currentPrice ?? slot?.basePrice ?? 0);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { allowed: false, reason: 'invalid_slot_price' };
  }

  const reductionAmount = Math.min(currentPrice, Math.ceil(currentPrice * (percent / 100)));
  const nextPrice = Math.max(0, currentPrice - reductionAmount);

  return {
    allowed: true,
    reason: null,
    percent,
    currentPrice,
    reductionAmount,
    nextPrice,
  };
}

// ---------------------------------------------------------------------------
// canGenerateAdditionalProject
// ---------------------------------------------------------------------------
/**
 * Checks whether a research proposal can add one AVAILABLE project.
 *
 * @param {Object} player
 * @returns {Object}
 */
export function canGenerateAdditionalProject(player) {
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };
  if (!Array.isArray(player.projects)) return { allowed: false, reason: 'invalid_projects' };

  const activeProjectCount = countCapProjects(player.projects);
  const openSlots = getAvailableProjectSlots(activeProjectCount);
  if (openSlots <= 0) {
    return { allowed: false, reason: 'project_cap_full', activeProjectCount };
  }

  return { allowed: true, reason: null, activeProjectCount, openSlots };
}

// ---------------------------------------------------------------------------
// canEquipCosmetic
// ---------------------------------------------------------------------------
/**
 * Checks whether an owned cosmetic can be equipped into its category slot.
 *
 * @param {Object} player
 * @param {string} cosmeticId
 * @param {string|null} expectedCategory
 * @returns {Object}
 */
export function canEquipCosmetic(player, cosmeticId, expectedCategory = null) {
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };
  if (!cosmeticId || typeof cosmeticId !== 'string') {
    return { allowed: false, reason: 'invalid_cosmetic_id' };
  }

  const definition = getCosmeticDefinition(cosmeticId);
  if (!isCosmeticDefinitionActive(definition)) {
    return { allowed: false, reason: 'invalid_cosmetic_definition' };
  }
  if (definition.type !== ITEM_TYPES.COSMETIC) {
    return { allowed: false, reason: 'item_not_cosmetic' };
  }

  const profileField = getCosmeticProfileField(definition.category);
  if (!profileField) {
    return { allowed: false, reason: 'unsupported_cosmetic_category', category: definition.category };
  }

  if (expectedCategory && getCosmeticProfileField(expectedCategory) !== profileField) {
    return { allowed: false, reason: 'cosmetic_category_mismatch', category: definition.category };
  }

  if (!getOwnedCosmetics(player)[cosmeticId]) {
    return { allowed: false, reason: 'cosmetic_not_owned' };
  }

  return {
    allowed: true,
    reason: null,
    cosmeticId,
    category: definition.category,
    profileField,
    definition,
  };
}

// ---------------------------------------------------------------------------
// canUnequipCosmetic
// ---------------------------------------------------------------------------
/**
 * Checks whether a cosmetic category can be unequipped.
 *
 * @param {Object} player
 * @param {string} category
 * @returns {Object}
 */
export function canUnequipCosmetic(player, category) {
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };
  const profileField = getCosmeticProfileField(category);
  if (!profileField) {
    return { allowed: false, reason: 'unsupported_cosmetic_category', category };
  }
  return { allowed: true, reason: null, category, profileField };
}

// ---------------------------------------------------------------------------
// canFeatureCard
// ---------------------------------------------------------------------------
/**
 * Checks whether an owned card can be added to featured profile cards.
 *
 * @param {Object} player
 * @param {string} cardId
 * @returns {Object}
 */
export function canFeatureCard(player, cardId) {
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };
  if (!cardId || typeof cardId !== 'string') return { allowed: false, reason: 'invalid_card_id' };

  const quantity = Number(player?.inventory?.[cardId] || 0);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { allowed: false, reason: 'card_not_owned' };
  }

  const featuredCards = normalizeIdArray(getProfile(player).featuredCards);
  if (featuredCards.includes(cardId)) return { allowed: false, reason: 'card_already_featured' };
  if (featuredCards.length >= MAX_FEATURED_CARDS) {
    return { allowed: false, reason: 'featured_cards_full', maxFeaturedCards: MAX_FEATURED_CARDS };
  }

  return { allowed: true, reason: null, cardId, featuredCards };
}

export function canUnfeatureCard(player, cardId) {
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };
  if (!cardId || typeof cardId !== 'string') return { allowed: false, reason: 'invalid_card_id' };

  const featuredCards = normalizeIdArray(getProfile(player).featuredCards);
  if (!featuredCards.includes(cardId)) return { allowed: false, reason: 'card_not_featured' };
  return { allowed: true, reason: null, cardId, featuredCards };
}

// ---------------------------------------------------------------------------
// canFeatureAchievement
// ---------------------------------------------------------------------------
/**
 * Checks whether an unlocked achievement can be featured.
 *
 * @param {Object} player
 * @param {string} achievementId
 * @returns {Object}
 */
export function canFeatureAchievement(player, achievementId) {
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };
  if (!achievementId || typeof achievementId !== 'string') {
    return { allowed: false, reason: 'invalid_achievement_id' };
  }

  const unlocked = isAchievementUnlocked(player.achievements, achievementId) ||
    isAchievementUnlocked(player.badges, achievementId);
  if (!unlocked) return { allowed: false, reason: 'achievement_not_unlocked' };

  const featuredAchievements = normalizeIdArray(getProfile(player).featuredAchievements);
  if (featuredAchievements.includes(achievementId)) {
    return { allowed: false, reason: 'achievement_already_featured' };
  }
  if (featuredAchievements.length >= MAX_FEATURED_ACHIEVEMENTS) {
    return {
      allowed: false,
      reason: 'featured_achievements_full',
      maxFeaturedAchievements: MAX_FEATURED_ACHIEVEMENTS,
    };
  }

  return { allowed: true, reason: null, achievementId, featuredAchievements };
}

export function canUnfeatureAchievement(player, achievementId) {
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };
  if (!achievementId || typeof achievementId !== 'string') {
    return { allowed: false, reason: 'invalid_achievement_id' };
  }

  const featuredAchievements = normalizeIdArray(getProfile(player).featuredAchievements);
  if (!featuredAchievements.includes(achievementId)) {
    return { allowed: false, reason: 'achievement_not_featured' };
  }
  return { allowed: true, reason: null, achievementId, featuredAchievements };
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
export function canUseConsumable(player, itemDefinition, context = {}) {
  if (!isObject(player)) return { allowed: false, reason: 'invalid_player' };
  if (!isObject(itemDefinition) || !itemDefinition.id) {
    return { allowed: false, reason: 'invalid_consumable' };
  }
  if (itemDefinition.enabled === false) {
    return { allowed: false, reason: 'consumable_disabled' };
  }
  if (itemDefinition.type !== ITEM_TYPES.CONSUMABLE) {
    return { allowed: false, reason: 'item_not_consumable' };
  }
  if (!SUPPORTED_CONSUMABLE_BEHAVIORS.includes(itemDefinition.behaviorType)) {
    return { allowed: false, reason: 'unsupported_behavior' };
  }
  if (getConsumableQuantity(player, itemDefinition.id) <= 0) {
    return { allowed: false, reason: 'missing_consumable' };
  }

  if ((itemDefinition.behaviorType === 'reroll_shop' || itemDefinition.behaviorType === 'apply_discount') &&
      !hasSlotIndex(context)) {
    return { allowed: false, reason: 'missing_slot_index' };
  }

  return {
    allowed: true,
    reason: null,
    behaviorType: itemDefinition.behaviorType,
    behaviorConfig: itemDefinition.behaviorConfig || {},
  };
}
