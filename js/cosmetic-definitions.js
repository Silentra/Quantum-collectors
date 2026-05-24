/**
 * cosmetic-definitions.js
 * Canonical cosmetic definition registry: static ITEM_DEFINITIONS + Firebase admin titles.
 * Data-only definitions — no renderer/DOM/animation payloads.
 *
 * @see ARCHITECTURE.md — Cosmetic Definition Registry
 */

import * as db from './database.js';
import {
  ITEM_CATEGORIES,
  ITEM_DEFINITIONS,
  ITEM_RARITIES,
  ITEM_TYPES,
} from './shop-definitions.js';

export const COSMETIC_DEFINITIONS_PATH = 'config/cosmetics/definitions';

export const COSMETIC_SOURCES = Object.freeze({
  STATIC: 'static',
  ADMIN: 'admin',
});

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
  const def = getMergedItemDefinitions()[itemId];
  if (!def || def.deleted === true) return null;
  return def;
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

  return Object.values(getMergedItemDefinitions())
    .filter(def => def?.type === ITEM_TYPES.COSMETIC)
    .filter(def => (includeDeleted ? true : def.deleted !== true))
    .filter(def => (includeDisabled ? true : def.enabled !== false))
    .filter(def => !category || def.category === category)
    .filter(def => {
      if (!shopEligibleOnly) return true;
      return def.shopEnabled !== false && Number(def.weight) > 0;
    })
    .filter(def => {
      if (!achievementEligibleOnly) return true;
      return def.achievementEnabled !== false;
    })
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
 * Admin category label (runtime id unchanged).
 * @param {string} category
 */
export function getCosmeticCategoryAdminLabel(category) {
  if (category === ITEM_CATEGORIES.AURA) return 'Glow';
  if (category === ITEM_CATEGORIES.BORDER) return 'Border';
  if (category === ITEM_CATEGORIES.PROFILE_BANNER) return 'Banner';
  if (category === ITEM_CATEGORIES.TITLE) return 'Title';
  return category || 'Other';
}
