/**
 * cosmetic-definitions.js
 * Canonical cosmetic definition registry: static ITEM_DEFINITIONS + Firebase admin titles.
 * Data-only definitions — no renderer/DOM/animation payloads.
 *
 * @see ARCHITECTURE.md — Cosmetic Definition Registry
 */

import * as db from './database.js';
import {
  INTERNAL_DEFAULT_BORDER_ITEM_ID,
  ITEM_CATEGORIES,
  ITEM_DEFINITIONS,
  ITEM_RARITIES,
  ITEM_TYPES,
} from './shop-definitions.js';

function isInternalDefaultBorderItemId(itemId) {
  return itemId === INTERNAL_DEFAULT_BORDER_ITEM_ID;
}

export const COSMETIC_DEFINITIONS_PATH = 'config/cosmetics/definitions';

/** Shop governance overrides for static cosmetics (managed from Admin → Cosmetics). */
export const COSMETIC_GOVERNANCE_OVERRIDES_PATH = 'config/shop/itemOverrides';

const GOVERNANCE_OVERRIDE_KEYS = Object.freeze([
  'enabled',
  'shopEnabled',
  'achievementEnabled',
  'rarity',
  'price',
  'weight',
]);

export const COSMETIC_SOURCES = Object.freeze({
  STATIC: 'static',
  ADMIN: 'admin',
});

/**
 * Static cosmetic groups keyed by cosmetics-admin tab id (excludes titles + shimmer).
 * Single source — reuse in cosmetics-admin.js and Manage Player grant UI.
 */
export const ADMIN_STATIC_COSMETIC_TAB_MAP = Object.freeze({
  banners: ITEM_CATEGORIES.PROFILE_BANNER,
  backgrounds: ITEM_CATEGORIES.SHELL_BACKGROUND,
  glow: ITEM_CATEGORIES.AURA,
  borders: ITEM_CATEGORIES.BORDER,
});

/**
 * Admin cosmetics category nav: mirrors Admin → Cosmetics (titles + static + shimmer placeholder).
 */
export const ADMIN_COSMETIC_GRANT_CATEGORY_NAV = Object.freeze([
  { id: 'titles', label: 'Titles', kind: 'titles' },
  { id: 'banners', label: 'Banners', kind: 'static', category: ITEM_CATEGORIES.PROFILE_BANNER },
  { id: 'backgrounds', label: 'Backgrounds', kind: 'static', category: ITEM_CATEGORIES.SHELL_BACKGROUND },
  { id: 'glow', label: 'Glow', kind: 'static', category: ITEM_CATEGORIES.AURA },
  { id: 'borders', label: 'Borders', kind: 'static', category: ITEM_CATEGORIES.BORDER },
  { id: 'shimmer', label: 'Shimmer', kind: 'placeholder' },
]);

/**
 * List enabled grantable cosmetics for Manage Player → Give Cosmetic category filter.
 * @param {string} navId - key from ADMIN_COSMETIC_GRANT_CATEGORY_NAV
 * @returns {object[]}
 */
export function listGrantableCosmeticsForAdminCategory(navId) {
  const nav = ADMIN_COSMETIC_GRANT_CATEGORY_NAV.find(entry => entry.id === navId);
  if (!nav || nav.kind === 'placeholder') return [];
  if (nav.kind === 'titles') {
    return listCosmeticDefinitions({ category: ITEM_CATEGORIES.TITLE, includeDisabled: false });
  }
  return listCosmeticDefinitions({ category: nav.category, includeDisabled: false });
}

export const TITLE_DISPLAY_NAME_MAX_LENGTH = 50;

const ITEM_RARITY_SET = new Set(Object.values(ITEM_RARITIES));

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize display name for uniqueness comparison (case/whitespace insensitive).
 * @param {string} name
 * @returns {string}
 */
export function normalizeTitleDisplayNameKey(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Sanitize title display text for shell (single line, plain text).
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeTitleDisplayName(raw) {
  let text = String(raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.includes('<') || text.includes('>')) {
    text = text.replace(/<[^>]*>/g, '').trim();
  }
  return text.slice(0, TITLE_DISPLAY_NAME_MAX_LENGTH);
}

function tagStaticDefinition(definition) {
  if (!definition || !isObject(definition)) return null;
  return {
    ...definition,
    source: COSMETIC_SOURCES.STATIC,
    deleted: definition.deleted === true,
    shopEnabled: definition.shopEnabled !== false,
    achievementEnabled: definition.achievementEnabled !== false,
  };
}

function normalizeAdminTitleDefinition(id, raw = {}) {
  const safeId = typeof id === 'string' && id.trim() ? id.trim() : '';
  if (!safeId || !safeId.startsWith('title_')) return null;

  const name = sanitizeTitleDisplayName(raw.name);
  if (!name) return null;

  const rarity = ITEM_RARITY_SET.has(raw.rarity) ? raw.rarity : ITEM_RARITIES.COMMON;
  const price = Math.max(0, Math.floor(Number(raw.price) || 0));
  const weight = Math.max(0, Number(raw.weight) || 0);
  const enabled = raw.enabled !== false;
  const deleted = raw.deleted === true;
  const shopEnabled = raw.shopEnabled !== false && enabled && !deleted;

  return {
    id: safeId,
    type: ITEM_TYPES.COSMETIC,
    category: ITEM_CATEGORIES.TITLE,
    name,
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 200) : '',
    rarity,
    enabled,
    deleted,
    deletedAt: deleted ? (Number(raw.deletedAt) || Date.now()) : 0,
    price,
    weight,
    shopEnabled,
    achievementEnabled: raw.achievementEnabled !== false,
    source: COSMETIC_SOURCES.ADMIN,
    display: isObject(raw.display) ? { emoji: raw.display.emoji || '★' } : { emoji: '★' },
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
}

function getFirebaseCosmeticDefinitions() {
  const raw = db.get(COSMETIC_DEFINITIONS_PATH) || {};
  const source = isObject(raw) ? raw : {};
  const merged = {};
  for (const [id, def] of Object.entries(source)) {
    if (def === null || def === undefined) continue;
    const normalized = normalizeAdminTitleDefinition(id, def);
    if (normalized) merged[id] = normalized;
  }
  return merged;
}

function applyItemGovernanceOverride(definition) {
  if (!definition?.id) return definition;
  const override = db.get(`${COSMETIC_GOVERNANCE_OVERRIDES_PATH}/${definition.id}`);
  if (!isObject(override)) return definition;
  const merged = { ...definition };
  for (const key of GOVERNANCE_OVERRIDE_KEYS) {
    if (override[key] !== undefined) merged[key] = override[key];
  }
  return merged;
}

/**
 * Merged static + admin cosmetic/item definitions (admin entries override same id).
 */
export function getMergedItemDefinitions() {
  const staticEntries = Object.fromEntries(
    Object.entries(ITEM_DEFINITIONS).map(([id, def]) => [id, tagStaticDefinition(def)])
  );
  const adminEntries = getFirebaseCosmeticDefinitions();
  return { ...staticEntries, ...adminEntries };
}

/**
 * Resolve any merged shop/item definition by id.
 * @param {string} itemId
 * @returns {object|null}
 */
export function getItemDefinition(itemId) {
  if (!itemId || typeof itemId !== 'string') return null;
  if (isInternalDefaultBorderItemId(itemId)) return null;
  const def = getMergedItemDefinitions()[itemId];
  if (!def || def.deleted === true) return null;
  return applyItemGovernanceOverride(def);
}

/**
 * Resolve a cosmetic definition by id (merged registry).
 * @param {string} itemId
 * @returns {object|null}
 */
export function getCosmeticDefinition(itemId) {
  const def = getItemDefinition(itemId);
  if (!def || def.type !== ITEM_TYPES.COSMETIC) return null;
  return def;
}

/**
 * Whether a cosmetic definition is active for gameplay/UI resolution.
 * @param {object|null} definition
 * @returns {boolean}
 */
export function isCosmeticDefinitionActive(definition) {
  if (!definition) return false;
  if (definition.deleted === true) return false;
  if (definition.enabled === false) return false;
  if (definition.type !== ITEM_TYPES.COSMETIC) return false;
  return true;
}

/**
 * Whether a cosmetic may appear in shop generation or be purchased from a slot.
 * @param {object|null} definition — resolved definition (governance applied).
 * @returns {boolean}
 */
export function isCosmeticShopEligible(definition) {
  if (!isCosmeticDefinitionActive(definition)) return false;
  if (definition.shopEnabled === false) return false;
  if (!(Number(definition.weight) > 0)) return false;
  return true;
}

/**
 * Whether a cosmetic may be newly configured as an achievement reward.
 * @param {object|null} definition — resolved definition (governance applied).
 * @returns {boolean}
 */
export function isCosmeticAchievementRewardEligible(definition) {
  if (!isCosmeticDefinitionActive(definition)) return false;
  if (definition.achievementEnabled === false) return false;
  return true;
}

/**
 * Whether a configured achievement reward may grant this cosmetic (legacy-compatible).
 * Disabled cosmetics remain grantable; tombstoned/missing definitions do not.
 * @param {object|null} definition — resolved definition from getCosmeticDefinition().
 * @returns {boolean}
 */
export function isCosmeticGrantable(definition) {
  if (!definition) return false;
  if (isInternalDefaultBorderItemId(definition.id)) return false;
  if (definition.deleted === true) return false;
  if (definition.type !== ITEM_TYPES.COSMETIC) return false;
  return true;
}

/**
 * Merged cosmetic rows with governance overrides applied (pre-filter).
 * @returns {object[]}
 */
function listResolvedCosmeticDefinitions() {
  return Object.values(getMergedItemDefinitions())
    .filter(def => def?.type === ITEM_TYPES.COSMETIC)
    .map(def => applyItemGovernanceOverride(def));
}

/**
 * @param {object} [options]
 * @param {string} [options.category]
 * @param {boolean} [options.includeDisabled]
 * @param {boolean} [options.includeDeleted]
 * @param {boolean} [options.shopEligibleOnly]
 * @param {boolean} [options.achievementEligibleOnly]
 * @returns {object[]}
 */
export function listCosmeticDefinitions(options = {}) {
  const {
    category = null,
    includeDisabled = false,
    includeDeleted = false,
    shopEligibleOnly = false,
    achievementEligibleOnly = false,
  } = options;

  return listResolvedCosmeticDefinitions()
    .filter(def => (includeDeleted ? true : def.deleted !== true))
    .filter(def => (includeDisabled ? true : isCosmeticDefinitionActive(def)))
    .filter(def => !category || def.category === category)
    .filter(def => !shopEligibleOnly || isCosmeticShopEligible(def))
    .filter(def => !achievementEligibleOnly || isCosmeticAchievementRewardEligible(def))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

/**
 * List title definitions for admin (includes disabled; optional deleted).
 */
export function listTitleDefinitions(options = {}) {
  return listCosmeticDefinitions({
    category: ITEM_CATEGORIES.TITLE,
    includeDisabled: true,
    includeDeleted: options.includeDeleted === true,
  });
}

/**
 * Check display-name uniqueness among titles.
 * @param {string} displayName
 * @param {string} [excludeId]
 * @returns {{ unique: boolean, conflictId?: string }}
 */
export function checkTitleDisplayNameUnique(displayName, excludeId = null) {
  const key = normalizeTitleDisplayNameKey(displayName);
  if (!key) return { unique: false, reason: 'empty_name' };

  for (const def of listTitleDefinitions({ includeDeleted: true })) {
    if (excludeId && def.id === excludeId) continue;
    if (normalizeTitleDisplayNameKey(def.name) === key) {
      return { unique: false, conflictId: def.id };
    }
  }
  return { unique: true };
}

/**
 * @param {string} displayName
 * @param {Set<string>|string[]} [existingIds]
 */
export function generateTitleId(displayName, existingIds = []) {
  const used = existingIds instanceof Set ? existingIds : new Set(existingIds);
  const base = String(displayName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const slug = base ? `title_${base}` : 'title_untitled';
  let id = slug;
  let n = 2;
  while (used.has(id)) {
    id = `${slug}_${n++}`;
  }
  return id;
}

/**
 * Validate title definition for admin save.
 * @param {object} raw
 * @param {string} [existingId] — set when editing (immutable id)
 */
export function validateTitleDefinition(raw, existingId = null) {
  const name = sanitizeTitleDisplayName(raw?.name);
  if (!name) return { valid: false, reason: 'invalid_name' };

  const uniqueness = checkTitleDisplayNameUnique(name, existingId);
  if (!uniqueness.unique) {
    return { valid: false, reason: 'duplicate_title_name', conflictId: uniqueness.conflictId };
  }

  const id = existingId || generateTitleId(name, Object.keys(getMergedItemDefinitions()));
  if (!id.startsWith('title_')) {
    return { valid: false, reason: 'invalid_id' };
  }

  if (existingId && raw?.id && raw.id !== existingId) {
    return { valid: false, reason: 'id_immutable' };
  }

  return { valid: true, id, name };
}

/**
 * @param {object} raw
 * @param {string} [existingId]
 */
export function saveTitleDefinition(raw, existingId = null) {
  const validation = validateTitleDefinition(raw, existingId);
  if (!validation.valid) return { success: false, reason: validation.reason, conflictId: validation.conflictId };

  const id = validation.id;
  const current = db.get(`${COSMETIC_DEFINITIONS_PATH}/${id}`) || {};
  const normalized = normalizeAdminTitleDefinition(id, {
    ...current,
    ...raw,
    id,
    name: validation.name,
    createdAt: current.createdAt || Date.now(),
  });
  if (!normalized) return { success: false, reason: 'normalize_failed' };

  db.set(`${COSMETIC_DEFINITIONS_PATH}/${id}`, normalized);
  return { success: true, definition: normalized };
}

/**
 * Tombstone delete (distinct from enabled: false).
 * @param {string} titleId
 */
export function deleteTitleDefinition(titleId) {
  if (!titleId || typeof titleId !== 'string') {
    return { success: false, reason: 'invalid_id' };
  }
  const existing = db.get(`${COSMETIC_DEFINITIONS_PATH}/${titleId}`);
  if (!existing) {
    return { success: false, reason: 'not_found' };
  }
  const normalized = normalizeAdminTitleDefinition(titleId, {
    ...existing,
    deleted: true,
    enabled: false,
    shopEnabled: false,
    deletedAt: Date.now(),
  });
  db.set(`${COSMETIC_DEFINITIONS_PATH}/${titleId}`, normalized);
  return { success: true, definition: normalized };
}

/**
 * Persist governance/acquisition overrides for a static/code-defined cosmetic.
 * Admin-authored titles use saveTitleDefinition() instead.
 * @param {string} itemId
 * @param {object} patch
 */
export function saveCosmeticGovernanceOverride(itemId, patch = {}) {
  const def = getMergedItemDefinitions()[itemId];
  if (!itemId || !def || def.type !== ITEM_TYPES.COSMETIC || def.source === COSMETIC_SOURCES.ADMIN) {
    return { success: false, reason: 'invalid_cosmetic_override' };
  }
  const safePatch = {};
  for (const key of GOVERNANCE_OVERRIDE_KEYS) {
    if (patch[key] !== undefined) safePatch[key] = patch[key];
  }
  if (!Object.keys(safePatch).length) {
    return { success: false, reason: 'empty_patch' };
  }
  const current = db.get(`${COSMETIC_GOVERNANCE_OVERRIDES_PATH}/${itemId}`) || {};
  const next = { ...current, ...safePatch };
  db.set(`${COSMETIC_GOVERNANCE_OVERRIDES_PATH}/${itemId}`, next);
  return { success: true, itemId, override: next };
}

/**
 * List static cosmetics for a category with governance overrides applied.
 * @param {string} category
 * @returns {object[]}
 */
export function listStaticCosmeticsByCategory(category) {
  return listCosmeticDefinitions({ category, includeDisabled: true })
    .filter(def => def.source === COSMETIC_SOURCES.STATIC);
}

/**
 * Admin category label (runtime id unchanged).
 * @param {string} category
 */
export function getCosmeticCategoryAdminLabel(category) {
  if (category === ITEM_CATEGORIES.AURA) return 'Glow';
  if (category === ITEM_CATEGORIES.BORDER) return 'Border';
  if (category === ITEM_CATEGORIES.PROFILE_BANNER) return 'Banner';
  if (category === ITEM_CATEGORIES.SHELL_BACKGROUND) return 'Background';
  if (category === ITEM_CATEGORIES.TITLE) return 'Title';
  return category || 'Other';
}
