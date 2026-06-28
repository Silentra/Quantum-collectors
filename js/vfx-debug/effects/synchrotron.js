/**
 * effects/synchrotron.js — VFX debug tunables for Synchrotron Glow.
 *
 * Sets CSS custom properties on document.documentElement (shipping at 100%).
 */

import { registerVfxDebugEffect } from '../vfx-debug-registry.js';

const CONTROLS = [
  { id: 'motionSpeed', label: 'Motion Speed', default: 100 },
  { id: 'headAnimation', label: 'Head Animation', default: 100 },
  { id: 'tailBlur', label: 'Tail Blur', default: 100 },
  { id: 'headBlur', label: 'Head Blur', default: 100 },
  { id: 'animatedShadow', label: 'Animated Shadow', default: 100 },
  { id: 'blendStrength', label: 'Blend Strength', default: 100 },
];

/**
 * @param {HTMLElement} root
 * @param {Record<string, number>} values
 */
export function applySynchrotronVfxDebug(root, values) {
  const motionSpeed = values.motionSpeed ?? 100;
  const headAnimation = (values.headAnimation ?? 100) / 100;
  const tailBlur = (values.tailBlur ?? 100) / 100;
  const headBlur = (values.headBlur ?? 100) / 100;
  const animatedShadow = (values.animatedShadow ?? 100) / 100;
  const blendStrength = values.blendStrength ?? 100;

  if (motionSpeed <= 0) {
    root.style.setProperty('--vfx-sync-motion-play-state', 'paused');
    root.style.setProperty('--vfx-sync-motion-duration-mult', '1');
  } else {
    root.style.setProperty('--vfx-sync-motion-play-state', 'running');
    root.style.setProperty('--vfx-sync-motion-duration-mult', String(100 / motionSpeed));
  }

  if (headAnimation <= 0) {
    root.style.setProperty('--vfx-sync-head-anim-name', 'none');
    root.style.setProperty('--vfx-sync-head-anim-strength', '0');
  } else {
    root.style.setProperty('--vfx-sync-head-anim-name', 'syncHeadPulse');
    root.style.setProperty('--vfx-sync-head-anim-strength', String(headAnimation));
  }

  root.style.setProperty('--vfx-sync-tail-blur-strength', String(tailBlur));
  root.style.setProperty('--vfx-sync-head-blur-strength', String(headBlur));
  root.style.setProperty('--vfx-sync-shadow-strength', String(animatedShadow));

  if (blendStrength <= 0) {
    root.style.setProperty('--vfx-sync-blend-mode', 'normal');
    root.style.setProperty('--vfx-sync-blend-opacity', '1');
  } else if (blendStrength >= 100) {
    root.style.setProperty('--vfx-sync-blend-mode', 'screen');
    root.style.setProperty('--vfx-sync-blend-opacity', '1');
  } else {
    root.style.setProperty('--vfx-sync-blend-mode', 'screen');
    root.style.setProperty('--vfx-sync-blend-opacity', String(blendStrength / 100));
  }
}

registerVfxDebugEffect({
  id: 'synchrotron',
  label: 'Synchrotron',
  controls: CONTROLS,
  apply: applySynchrotronVfxDebug,
});
