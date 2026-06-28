/**
 * vfx-debug-registry.js — Extensible registry of cosmetic VFX debug effect definitions.
 */

/** @type {Map<string, object>} */
const effects = new Map();

/**
 * @param {object} definition
 * @param {string} definition.id
 * @param {string} definition.label
 * @param {Array<{ id: string, label: string, default?: number }>} definition.controls
 * @param {(root: HTMLElement, values: Record<string, number>) => void} definition.apply
 */
export function registerVfxDebugEffect(definition) {
  if (!definition?.id) throw new Error('VFX debug effect requires id');
  effects.set(definition.id, definition);
}

/** @returns {object[]} */
export function listVfxDebugEffects() {
  return Array.from(effects.values());
}

/** @param {string} id @returns {object|undefined} */
export function getVfxDebugEffect(id) {
  return effects.get(id);
}

/** @returns {string[]} */
export function getVfxDebugEffectIds() {
  return Array.from(effects.keys());
}
