/**
 * Player Schema Expansion — Phase 2A + Phase 2B
 *
 * Persistence-only module. Defines default schema shapes for new player
 * subsystems and provides normalization helpers that safely backfill
 * missing fields on existing player records without overwriting valid data.
 *
 * NO gameplay logic, UI rendering, Firebase mutation flows, or shop generation.
 *
 * Subsystems covered:
 *   - currencies       (currentResearchPoints)
 *   - cosmetics        (owned + equipped)
 *   - items            (consumable inventory)
 *   - shopUsage        (rotation-scoped tracking)
 *   - shop             (persistent rotation storage)
 *   - purchaseHistory  (capped rolling log)
 *   - profileCustomization (featured cards/achievements)
 *   - profileVisibility    (hidden flags)
 */

import * as db from './database.js';
import {
  SHOP_GENERATION_VERSION,
  createEmptyShopState,
  createShopRotationState,
  createShopSlot,
  createDiscountApplied,
} from './shop-state.js';

// ─────────────────────────────────────────────────────────────────────────────
// Default schema shapes (frozen — canonical source of truth)
// ─────────────────────────────────────────────────────────────────────────────

/** Currency storage defaults */
export const DEFAULT_CURRENCIES = Object.freeze({
  currentResearchPoints: 0,
});

/** Cosmetic ownership + equipment defaults */
export const DEFAULT_COSMETICS = Object.freeze({
  owned: Object.freeze({
    profile_banner_default: true,
  }),
  equipped: Object.freeze({
    aura: 'default_prismatic',
    border: null,
    title: null,
    profileBanner: 'profile_banner_default',
  }),
});

/** Consumable inventory defaults (all stackable, inventory-held) */
export const DEFAULT_ITEMS = Object.freeze({
  reroll_token: 0,
  cosmetic_reroll_token: 0,
  aura_reroll_token: 0,
  border_reroll_token: 0,
  discount_chip: 0,
  freeze_token: 0,
  research_proposal: 0,
});

/** Shop usage tracking defaults (per rotation) */
export const DEFAULT_SHOP_USAGE = Object.freeze({
  rerollsUsedThisRotation: 0,
  frozenSlotsUsedThisRotation: 0,
});

/** Persistent shop rotation storage defaults (Phase 2B) */
export const DEFAULT_SHOP = Object.freeze({
  currentRotation: Object.freeze({
    slots: Object.freeze([]),
    generatedAt: 0,
    refreshAt: 0,
    generationVersion: SHOP_GENERATION_VERSION,
  }),
  rerollResetAt: 0,
});

/** Profile customization defaults */
export const DEFAULT_PROFILE_CUSTOMIZATION = Object.freeze({
  featuredCards: [],
  featuredAchievements: [],
});

/** Profile visibility defaults */
export const DEFAULT_PROFILE_VISIBILITY = Object.freeze({
  isProfileHidden: false,
  isCollectionHidden: false,
});

/** Maximum number of purchase history entries retained */
export const PURCHASE_HISTORY_MAX = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — deep-safe default merging
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shallow-merge defaults into an existing object without overwriting
 * any key that already has a non-undefined value.
 * Returns a new object (never mutates `existing`).
 */
function mergeDefaults(existing, defaults) {
  const result = { ...(existing || {}) };
  for (const [key, defaultVal] of Object.entries(defaults)) {
    if (result[key] === undefined || result[key] === null) {
      // Deep-copy arrays and plain objects so frozen defaults aren't shared
      if (Array.isArray(defaultVal)) {
        result[key] = [...defaultVal];
      } else if (defaultVal !== null && typeof defaultVal === 'object') {
        result[key] = { ...defaultVal };
      } else {
        result[key] = defaultVal;
      }
    }
  }
  return result;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valuesDiffer(a, b) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function normalizeDiscountApplied(raw) {
  if (raw === null || raw === undefined) return null;
  if (!isObject(raw)) return createDiscountApplied();
  return {
    ...createDiscountApplied(),
    ...raw,
    sourceItemId: raw.sourceItemId ?? null,
    percent: raw.percent ?? 0,
    reductionAmount: raw.reductionAmount ?? 0,
    appliedAt: raw.appliedAt ?? 0,
  };
}

function normalizeShopSlot(raw) {
  if (!isObject(raw)) return createShopSlot();
  return {
    ...createShopSlot(),
    ...raw,
    id: raw.id ?? null,
    itemId: raw.itemId ?? null,
    basePrice: raw.basePrice ?? 0,
    currentPrice: raw.currentPrice ?? 0,
    currency: raw.currency ?? 'rp',
    frozen: raw.frozen ?? false,
    purchased: raw.purchased ?? false,
    discountApplied: normalizeDiscountApplied(raw.discountApplied),
  };
}

function normalizeShopSlots(rawSlots) {
  if (Array.isArray(rawSlots)) {
    return rawSlots.map(normalizeShopSlot);
  }
  if (isObject(rawSlots)) {
    return Object.values(rawSlots).map(normalizeShopSlot);
  }
  return [];
}

function createPlayerShopDefaults() {
  return createEmptyShopState();
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema builder — for new player records
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return a fresh copy of all Phase 2A/2B schema fields with their defaults.
 * Used by createPlayerRecord() to embed in the initial write.
 * @returns {object}
 */
export function getPhase2ADefaults() {
  return {
    currencies: { ...DEFAULT_CURRENCIES },
    cosmetics: {
      owned: { ...DEFAULT_COSMETICS.owned },
      equipped: { ...DEFAULT_COSMETICS.equipped },
    },
    items: { ...DEFAULT_ITEMS },
    shopUsage: { ...DEFAULT_SHOP_USAGE },
    shop: createPlayerShopDefaults(),
    purchaseHistory: [],
    profileCustomization: {
      featuredCards: [],
      featuredAchievements: [],
    },
    profileVisibility: { ...DEFAULT_PROFILE_VISIBILITY },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization — safe backfill for existing players
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure a single player record has all Phase 2A/2B schema fields.
 * Never overwrites existing valid data.
 * Safe to call multiple times (idempotent).
 *
 * @param {string} username
 * @returns {boolean} true if any field was added/patched
 */
export function normalizePlayerSchema(username) {
  const player = db.get(`players/${username}`);
  if (!player) return false;

  let patched = false;

  // ── currencies ──────────────────────────────────────────────────────────
  if (!player.currencies || typeof player.currencies !== 'object') {
    db.set(`players/${username}/currencies`, { ...DEFAULT_CURRENCIES });
    patched = true;
  } else {
    const merged = mergeDefaults(player.currencies, DEFAULT_CURRENCIES);
    // Only write if something changed
    for (const key of Object.keys(DEFAULT_CURRENCIES)) {
      if (player.currencies[key] === undefined || player.currencies[key] === null) {
        db.set(`players/${username}/currencies/${key}`, merged[key]);
        patched = true;
      }
    }
  }

  // ── cosmetics ───────────────────────────────────────────────────────────
  if (!player.cosmetics || typeof player.cosmetics !== 'object') {
    db.set(`players/${username}/cosmetics`, {
      owned: { ...DEFAULT_COSMETICS.owned },
      equipped: { ...DEFAULT_COSMETICS.equipped },
    });
    patched = true;
  } else {
    // cosmetics.owned
    if (!player.cosmetics.owned || typeof player.cosmetics.owned !== 'object') {
      db.set(`players/${username}/cosmetics/owned`, { ...DEFAULT_COSMETICS.owned });
      patched = true;
    } else {
      // Ensure default owned item exists
      for (const [key, val] of Object.entries(DEFAULT_COSMETICS.owned)) {
        if (player.cosmetics.owned[key] === undefined) {
          db.set(`players/${username}/cosmetics/owned/${key}`, val);
          patched = true;
        }
      }
    }
    // cosmetics.equipped
    if (!player.cosmetics.equipped || typeof player.cosmetics.equipped !== 'object') {
      db.set(`players/${username}/cosmetics/equipped`, { ...DEFAULT_COSMETICS.equipped });
      patched = true;
    } else {
      for (const [key, val] of Object.entries(DEFAULT_COSMETICS.equipped)) {
        if (player.cosmetics.equipped[key] === undefined) {
          db.set(`players/${username}/cosmetics/equipped/${key}`, val);
          patched = true;
        }
      }
    }
  }

  // ── items (consumable inventory) ────────────────────────────────────────
  if (!player.items || typeof player.items !== 'object') {
    db.set(`players/${username}/items`, { ...DEFAULT_ITEMS });
    patched = true;
  } else {
    for (const [key, val] of Object.entries(DEFAULT_ITEMS)) {
      if (player.items[key] === undefined || player.items[key] === null) {
        db.set(`players/${username}/items/${key}`, val);
        patched = true;
      }
    }
  }

  // ── shopUsage ───────────────────────────────────────────────────────────
  if (!player.shopUsage || typeof player.shopUsage !== 'object') {
    db.set(`players/${username}/shopUsage`, { ...DEFAULT_SHOP_USAGE });
    patched = true;
  } else {
    for (const [key, val] of Object.entries(DEFAULT_SHOP_USAGE)) {
      if (player.shopUsage[key] === undefined || player.shopUsage[key] === null) {
        db.set(`players/${username}/shopUsage/${key}`, val);
        patched = true;
      }
    }
  }

  // ── shop (persistent rotation storage) ──────────────────────────────────
  if (!player.shop || typeof player.shop !== 'object' || Array.isArray(player.shop)) {
    db.set(`players/${username}/shop`, createPlayerShopDefaults());
    patched = true;
  } else {
    const shop = player.shop;

    if (!shop.currentRotation || typeof shop.currentRotation !== 'object' || Array.isArray(shop.currentRotation)) {
      db.set(`players/${username}/shop/currentRotation`, createShopRotationState({
        slots: normalizeShopSlots(shop.slots),
        generatedAt: shop.generatedAt ?? 0,
        refreshAt: shop.refreshAt ?? 0,
        generationVersion: shop.generationVersion ?? SHOP_GENERATION_VERSION,
      }));
      patched = true;
    } else {
      const rotation = shop.currentRotation;

      const normalizedSlots = normalizeShopSlots(rotation.slots);
      if (!Array.isArray(rotation.slots) || valuesDiffer(rotation.slots, normalizedSlots)) {
        db.set(`players/${username}/shop/currentRotation/slots`, normalizedSlots);
        patched = true;
      }
      if (rotation.generatedAt === undefined || rotation.generatedAt === null) {
        db.set(`players/${username}/shop/currentRotation/generatedAt`, 0);
        patched = true;
      }
      if (rotation.refreshAt === undefined || rotation.refreshAt === null) {
        db.set(`players/${username}/shop/currentRotation/refreshAt`, 0);
        patched = true;
      }
      if (rotation.generationVersion === undefined || rotation.generationVersion === null) {
        db.set(`players/${username}/shop/currentRotation/generationVersion`, SHOP_GENERATION_VERSION);
        patched = true;
      }
    }

    if (shop.rerollResetAt === undefined || shop.rerollResetAt === null) {
      db.set(`players/${username}/shop/rerollResetAt`, 0);
      patched = true;
    }
  }

  // ── purchaseHistory ─────────────────────────────────────────────────────
  if (!Array.isArray(player.purchaseHistory)) {
    // Firebase may store arrays as objects — normalize safely
    if (player.purchaseHistory && typeof player.purchaseHistory === 'object') {
      const arr = Object.values(player.purchaseHistory);
      // Cap at max
      db.set(`players/${username}/purchaseHistory`, arr.slice(-PURCHASE_HISTORY_MAX));
      patched = true;
    } else {
      db.set(`players/${username}/purchaseHistory`, []);
      patched = true;
    }
  } else if (player.purchaseHistory.length > PURCHASE_HISTORY_MAX) {
    // Enforce cap on existing data
    db.set(`players/${username}/purchaseHistory`, player.purchaseHistory.slice(-PURCHASE_HISTORY_MAX));
    patched = true;
  }

  // ── profileCustomization ────────────────────────────────────────────────
  if (!player.profileCustomization || typeof player.profileCustomization !== 'object') {
    db.set(`players/${username}/profileCustomization`, {
      featuredCards: [],
      featuredAchievements: [],
    });
    patched = true;
  } else {
    if (!Array.isArray(player.profileCustomization.featuredCards)) {
      // Firebase array → object normalization
      const raw = player.profileCustomization.featuredCards;
      const arr = (raw && typeof raw === 'object') ? Object.values(raw) : [];
      db.set(`players/${username}/profileCustomization/featuredCards`, arr);
      patched = true;
    }
    if (!Array.isArray(player.profileCustomization.featuredAchievements)) {
      const raw = player.profileCustomization.featuredAchievements;
      const arr = (raw && typeof raw === 'object') ? Object.values(raw) : [];
      db.set(`players/${username}/profileCustomization/featuredAchievements`, arr);
      patched = true;
    }
  }

  // ── profileVisibility ──────────────────────────────────────────────────
  if (!player.profileVisibility || typeof player.profileVisibility !== 'object') {
    db.set(`players/${username}/profileVisibility`, { ...DEFAULT_PROFILE_VISIBILITY });
    patched = true;
  } else {
    for (const [key, val] of Object.entries(DEFAULT_PROFILE_VISIBILITY)) {
      if (player.profileVisibility[key] === undefined || player.profileVisibility[key] === null) {
        db.set(`players/${username}/profileVisibility/${key}`, val);
        patched = true;
      }
    }
  }

  if (patched) {
    console.log(`[PlayerSchema] Phase 2A/2B fields initialized: ${username}`);
  }
  return patched;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk migration — safe for startup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Migrate all existing players to include Phase 2A/2B schema fields.
 * Safe to call multiple times — skips players already up to date.
 * Called once at startup from main.js.
 */
export function migrateAllPlayersPhase2A() {
  const players = db.getChildren('players');
  let count = 0;

  for (const { key: username } of players) {
    if (normalizePlayerSchema(username)) {
      count++;
    }
  }

  if (count > 0) {
    console.log(`[PlayerSchema] Phase 2A/2B migration complete — ${count} player(s) updated`);
  } else {
    console.log('[PlayerSchema] Phase 2A/2B migration complete — all players up to date');
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Purchase history helper — capped append (persistence only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize and cap a purchase history array.
 * Returns a new array with at most PURCHASE_HISTORY_MAX entries (most recent kept).
 * Handles Firebase array→object conversion.
 *
 * @param {Array|object|null} raw - existing purchaseHistory from DB
 * @returns {Array}
 */
export function normalizePurchaseHistory(raw) {
  let arr;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw && typeof raw === 'object') {
    arr = Object.values(raw);
  } else {
    arr = [];
  }
  // Cap to last N entries
  if (arr.length > PURCHASE_HISTORY_MAX) {
    return arr.slice(-PURCHASE_HISTORY_MAX);
  }
  return [...arr];
}
