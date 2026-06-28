/**
 * vfx-debug-applicator.js — Applies registry effect values to document.documentElement.
 */

import { getVfxDebugEffect } from './vfx-debug-registry.js';
import { getActiveVfxDebugEffectId, getVfxDebugValues } from './vfx-debug-store.js';

const SYNC_VAR_PREFIX = '--vfx-sync-';

/** @type {string[]} */
const SYNCHROTRON_VARS = [
  '--vfx-sync-motion-play-state',
  '--vfx-sync-motion-duration-mult',
  '--vfx-sync-head-anim-name',
  '--vfx-sync-head-anim-strength',
  '--vfx-sync-tail-blur-strength',
  '--vfx-sync-head-blur-strength',
  '--vfx-sync-shadow-strength',
  '--vfx-sync-blend-mode',
  '--vfx-sync-blend-opacity',
];

function clearSynchrotronVars(root) {
  for (const name of SYNCHROTRON_VARS) {
    root.style.removeProperty(name);
  }
}

/**
 * @param {string} [effectId]
 */
export function applyVfxDebugEffect(effectId = getActiveVfxDebugEffectId()) {
  const root = document.documentElement;
  const effect = getVfxDebugEffect(effectId);
  if (!effect) return;

  root.dataset.vfxDebugActive = 'true';
  const values = getVfxDebugValues(effectId);
  effect.apply(root, values);
}

/** Apply all registered effects (extensible for future multi-effect debug). */
export function applyAllVfxDebugEffects() {
  const root = document.documentElement;
  root.dataset.vfxDebugActive = 'true';
  clearSynchrotronVars(root);

  const effectId = getActiveVfxDebugEffectId();
  const effect = getVfxDebugEffect(effectId);
  if (effect) {
    effect.apply(root, getVfxDebugValues(effectId));
  }
}

export function clearVfxDebugApplication() {
  const root = document.documentElement;
  delete root.dataset.vfxDebugActive;
  for (const name of SYNCHROTRON_VARS) {
    if (name.startsWith(SYNC_VAR_PREFIX)) {
      root.style.removeProperty(name);
    }
  }
}
