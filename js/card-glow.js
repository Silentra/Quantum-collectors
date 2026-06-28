/**
 * card-glow.js — Glow cosmetic render resolution (perimeter halo effects).
 *
 * Full-size cards only (.sci-card, .card-detail-frame). No default glow when unequipped.
 * Renders only when Mathematical Aura tier >= 1 (see shouldRenderGlow).
 *
 * @see card-render.js — .card-glow--halo (z0); effect-specific hosts (molten, frost, synchrotron ring)
 */

import { getEquippedAura } from './profile-ui.js';

/** Player-ownable / purchasable glow effect ids. */
export const COSMETIC_GLOW_EFFECT_IDS = [
  'void',
  'rarity',
  'molten',
  'winterfrost',
  'synchrotron',
];

/**
 * @param {number} auraTier - Mathematical Aura tier (0–3)
 * @returns {boolean}
 */
export function shouldRenderGlow(auraTier) {
  return typeof auraTier === 'number' && auraTier >= 1;
}

/**
 * Resolve equipped glow definition → data-card-glow effect id.
 * null / unequipped / unknown → no glow.
 * @param {object|null|undefined} glowDefinition - cosmetic item definition
 * @param {number} auraTier - Mathematical Aura tier (0–3)
 * @returns {string|null}
 */
export function resolveGlowRenderEffectId(glowDefinition, auraTier) {
  if (!shouldRenderGlow(auraTier)) return null;

  const id = glowDefinition?.renderEffectId;
  if (id && COSMETIC_GLOW_EFFECT_IDS.includes(id)) return id;

  return null;
}

/**
 * @param {object} [options]
 * @param {number} options.auraTier
 * @param {object|null} [options.glowDefinition] - equipped glow cosmetic definition
 * @returns {string|null}
 */
export function resolveGlowRenderEffectIdFromOptions({ auraTier, glowDefinition = null } = {}) {
  return resolveGlowRenderEffectId(glowDefinition, auraTier);
}

/**
 * @param {object|null|undefined} playerData
 * @param {number} auraTier
 * @returns {string|null}
 */
export function resolveGlowRenderEffectIdFromPlayer(playerData, auraTier) {
  return resolveGlowRenderEffectId(
    getEquippedAura(playerData)?.definition,
    auraTier
  );
}

/**
 * @param {string|null|undefined} glowEffectId
 * @returns {Record<string, string>}
 */
export function getCardGlowDataAttrs(glowEffectId) {
  if (!glowEffectId || !COSMETIC_GLOW_EFFECT_IDS.includes(glowEffectId)) return {};
  return { 'data-card-glow': glowEffectId };
}

/**
 * @param {string|null|undefined} glowEffectId
 * @returns {string} HTML attribute fragment (leading space when set)
 */
export function formatCardGlowAttr(glowEffectId) {
  const attrs = getCardGlowDataAttrs(glowEffectId);
  const value = attrs['data-card-glow'];
  return value ? ` data-card-glow="${value}"` : '';
}

/** Molten Glow — static thermal hotspot slots (CSS-only; no JS animation). */
const MOLTEN_EMBER_SLOT_COUNT = 14;

/** Molten Glow — continuous drift flecks (CSS-only; Emberglow-style span pool). */
const MOLTEN_DRIFT_SLOT_COUNT = 18;

/** Winter Frost Glow — slow vapor wisps (CSS-only span pool). */
const FROST_WISP_SLOT_COUNT = 10;

function renderMoltenEmberSpansHtml() {
  return Array.from({ length: MOLTEN_EMBER_SLOT_COUNT }, (_, i) => {
    const n = i + 1;
    return `<span class="molten-ember molten-ember--${n}" aria-hidden="true"></span>`;
  }).join('');
}

function renderMoltenDriftSpansHtml() {
  return Array.from({ length: MOLTEN_DRIFT_SLOT_COUNT }, (_, i) => {
    const n = i + 1;
    return `<span class="molten-drift molten-drift--${n}" aria-hidden="true"></span>`;
  }).join('');
}

function renderFrostWispSpansHtml() {
  return Array.from({ length: FROST_WISP_SLOT_COUNT }, (_, i) => {
    const n = i + 1;
    return `<span class="frost-wisp frost-wisp--${n}" aria-hidden="true"></span>`;
  }).join('');
}

/**
 * Perimeter glow host — mount before .card-cosmetic-effects (z0).
 * @param {string|null|undefined} glowEffectId
 * @returns {string}
 */
export function renderGlowHaloLayerHtml(glowEffectId = null) {
  if (!glowEffectId || !COSMETIC_GLOW_EFFECT_IDS.includes(glowEffectId)) return '';
  if (glowEffectId === 'molten') {
    return '<div class="card-glow card-glow--halo card-glow--molten" aria-hidden="true"></div>';
  }
  if (glowEffectId === 'winterfrost') {
    return '<div class="card-glow card-glow--halo card-glow--winterfrost" aria-hidden="true"></div>';
  }
  if (glowEffectId === 'synchrotron') {
    return '<div class="card-glow card-glow--halo card-glow--synchrotron" aria-hidden="true"><div class="synchrotron-ring" aria-hidden="true"></div></div>';
  }
  return '<div class="card-glow card-glow--halo" aria-hidden="true"></div>';
}

/**
 * Molten ember host — mount after .card-cosmetic-effects (z1, above border paint).
 * @param {string|null|undefined} glowEffectId
 * @returns {string}
 */
export function renderMoltenEmberLayerHtml(glowEffectId = null) {
  if (glowEffectId !== 'molten') return '';
  return `<div class="card-glow card-glow--molten-embers" aria-hidden="true">${renderMoltenEmberSpansHtml()}</div>`;
}

/**
 * Molten drift host — mount after .card-detail-inner (z2, above artwork).
 * @param {string|null|undefined} glowEffectId
 * @returns {string}
 */
export function renderMoltenDriftLayerHtml(glowEffectId = null) {
  if (glowEffectId !== 'molten') return '';
  return `<div class="card-glow card-glow--molten-drift" aria-hidden="true">${renderMoltenDriftSpansHtml()}</div>`;
}

/**
 * Winter Frost wisp host — mount after .card-detail-inner (z2, may overlap artwork slightly).
 * @param {string|null|undefined} glowEffectId
 * @returns {string}
 */
export function renderFrostWispLayerHtml(glowEffectId = null) {
  if (glowEffectId !== 'winterfrost') return '';
  return `<div class="card-glow card-glow--frost-wisps" aria-hidden="true">${renderFrostWispSpansHtml()}</div>`;
}
