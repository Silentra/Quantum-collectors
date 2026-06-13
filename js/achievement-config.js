/**
 * achievement-config.js
 * Admin-authored achievement definitions at config/achievements.
 * No gameplay logic. No player mutations.
 */

import * as db from './database.js';

const ACHIEVEMENT_CONFIG_PATH = 'config/achievements';

export const CONDITION_OPS = Object.freeze(['gte', 'lte', 'eq', 'gt', 'lt']);
export const CONDITION_MODES = Object.freeze(['all', 'any']);
export const REWARD_TYPES = Object.freeze(['rp', 'consumable', 'pack', 'cosmetic']);

export const DEFAULT_ACHIEVEMENT_CONFIG = Object.freeze({
  meta: Object.freeze({
    enabled: true,
    version: 1,
    updatedAt: 0,
  }),
  definitions: Object.freeze({}),
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDefinition(id, raw = {}) {
  const safeId = typeof id === 'string' && id.trim() ? id.trim() : '';
  if (!safeId) return null;

  const conditions = Array.isArray(raw.conditions)
    ? raw.conditions
      .filter(c => isObject(c) && typeof c.stat === 'string' && CONDITION_OPS.includes(c.op))
      .map(c => ({
        stat: c.stat.trim(),
        op: c.op,
        value: Number(c.value),
      }))
      .filter(c => Number.isFinite(c.value))
    : [];

  const rewards = Array.isArray(raw.rewards)
    ? raw.rewards
      .filter(r => isObject(r) && REWARD_TYPES.includes(r.type))
      .map(r => ({ ...r }))
    : [];

  return {
    id: safeId,
    enabled: raw.enabled !== false,
    name: typeof raw.name === 'string' ? raw.name : safeId,
    description: typeof raw.description === 'string' ? raw.description : '',
    category: typeof raw.category === 'string' ? raw.category : 'general',
    sortOrder: Number.isFinite(Number(raw.sortOrder)) ? Number(raw.sortOrder) : 0,
    rarity: typeof raw.rarity === 'string' ? raw.rarity : 'common',
    hidden: raw.hidden === true,
    icon: isObject(raw.icon) ? { ...raw.icon } : {},
    conditions,
    conditionMode: CONDITION_MODES.includes(raw.conditionMode) ? raw.conditionMode : 'all',
    rewards,
    notifyOnUnlock: raw.notifyOnUnlock !== false,
  };
}

function mergeAchievementConfig(raw = {}) {
  const definitions = {};
  const source = isObject(raw.definitions) ? raw.definitions : {};
  for (const [id, def] of Object.entries(source)) {
    const normalized = normalizeDefinition(id, def);
    if (normalized) definitions[id] = normalized;
  }

  return {
    meta: {
      ...DEFAULT_ACHIEVEMENT_CONFIG.meta,
      ...(isObject(raw.meta) ? raw.meta : {}),
      enabled: isObject(raw.meta) && raw.meta.enabled === false ? false : true,
    },
    definitions,
  };
}

export function getAchievementConfig() {
  const raw = db.get(ACHIEVEMENT_CONFIG_PATH) || {};
  return mergeAchievementConfig(raw);
}

export function saveAchievementConfig(patch = {}) {
  const current = mergeAchievementConfig(db.get(ACHIEVEMENT_CONFIG_PATH) || {});
  const nextDefinitions = { ...current.definitions };

  if (isObject(patch.definitions)) {
    for (const [id, def] of Object.entries(patch.definitions)) {
      if (def === null) {
        delete nextDefinitions[id];
        continue;
      }
      const normalized = normalizeDefinition(id, { ...nextDefinitions[id], ...def });
      if (normalized) nextDefinitions[id] = normalized;
    }
  }

  const next = mergeAchievementConfig({
    ...current,
    ...patch,
    meta: {
      ...current.meta,
      ...(isObject(patch.meta) ? patch.meta : {}),
      updatedAt: Date.now(),
    },
    definitions: nextDefinitions,
  });

  db.set(ACHIEVEMENT_CONFIG_PATH, next);
  return next;
}

export function saveAchievementDefinition(definition = {}) {
  const id = definition.id;
  if (!id || typeof id !== 'string') {
    return { success: false, reason: 'invalid_id' };
  }
  return { success: true, config: saveAchievementConfig({ definitions: { [id]: definition } }) };
}

export function deleteAchievementDefinition(achievementId) {
  if (!achievementId || typeof achievementId !== 'string') {
    return { success: false, reason: 'invalid_id' };
  }
  const current = getAchievementConfig();
  if (!current.definitions[achievementId]) {
    return { success: false, reason: 'not_found' };
  }
  const config = saveAchievementConfig({ definitions: { [achievementId]: null } });
  if (getAchievementConfig().definitions[achievementId]) {
    return { success: false, reason: 'delete_failed' };
  }
  return { success: true, config };
}

export function listAchievementDefinitions() {
  const config = getAchievementConfig();
  return Object.values(config.definitions)
    .sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));
}

/**
 * Generate a stable achievement id from title (create only).
 * @param {string} title
 * @param {Set<string>|string[]} [existingIds]
 */
export function generateAchievementId(title, existingIds = []) {
  const used = existingIds instanceof Set ? existingIds : new Set(existingIds);
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  const slug = base ? `ach_${base}` : 'ach_untitled';
  let id = slug;
  let n = 2;
  while (used.has(id)) {
    id = `${slug}_${n++}`;
  }
  return id;
}

/**
 * Persist admin display order for locked visible achievements (sortOrder field).
 * @param {string[]} orderedIds
 */
export function saveAchievementSortOrder(orderedIds = []) {
  const current = getAchievementConfig();
  const patch = {};
  orderedIds.forEach((id, index) => {
    const def = current.definitions[id];
    if (def) patch[id] = { ...def, sortOrder: index };
  });
  if (!Object.keys(patch).length) return current;
  return saveAchievementConfig({ definitions: patch });
}

export function isAchievementSystemEnabled() {
  return getAchievementConfig().meta.enabled !== false;
}
