/**
 * vfx-debug-store.js — Local session state + localStorage persistence for VFX debug sliders.
 */

import { getVfxDebugEffect, getVfxDebugEffectIds } from './vfx-debug-registry.js';

const STORAGE_KEY = 'qc-vfx-debug-v1';

/** @type {{ activeEffectId: string, effects: Record<string, Record<string, number>> }} */
let state = {
  activeEffectId: 'synchrotron',
  effects: {},
};

function defaultValuesForEffect(effectId) {
  const effect = getVfxDebugEffect(effectId);
  if (!effect) return {};
  /** @type {Record<string, number>} */
  const values = {};
  for (const control of effect.controls) {
    values[control.id] = control.default ?? 100;
  }
  return values;
}

function normalizeState() {
  const ids = getVfxDebugEffectIds();
  if (!ids.length) return;
  if (!ids.includes(state.activeEffectId)) {
    state.activeEffectId = ids[0];
  }
  for (const id of ids) {
    const defaults = defaultValuesForEffect(id);
    state.effects[id] = { ...defaults, ...(state.effects[id] || {}) };
    for (const control of getVfxDebugEffect(id)?.controls || []) {
      const v = state.effects[id][control.id];
      if (typeof v !== 'number' || Number.isNaN(v)) {
        state.effects[id][control.id] = control.default ?? 100;
      } else {
        state.effects[id][control.id] = Math.min(100, Math.max(0, v));
      }
    }
  }
}

export function loadVfxDebugStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state = {
          activeEffectId: parsed.activeEffectId || 'synchrotron',
          effects: parsed.effects && typeof parsed.effects === 'object' ? parsed.effects : {},
        };
      }
    }
  } catch {
    /* ignore corrupt storage */
  }
  normalizeState();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode */
  }
}

export function getActiveVfxDebugEffectId() {
  return state.activeEffectId;
}

export function setActiveVfxDebugEffectId(effectId) {
  if (!getVfxDebugEffect(effectId)) return;
  state.activeEffectId = effectId;
  persist();
}

/** @returns {Record<string, number>} */
export function getVfxDebugValues(effectId = state.activeEffectId) {
  return { ...(state.effects[effectId] || defaultValuesForEffect(effectId)) };
}

export function setVfxDebugValue(effectId, controlId, value) {
  if (!getVfxDebugEffect(effectId)) return;
  if (!state.effects[effectId]) {
    state.effects[effectId] = defaultValuesForEffect(effectId);
  }
  state.effects[effectId][controlId] = Math.min(100, Math.max(0, Number(value)));
  persist();
}
