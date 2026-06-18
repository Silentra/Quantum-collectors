/**
 * card-glow.js — Glow cosmetic render resolution (perimeter halo effects).
 *
 * Full-size cards only (.sci-card, .card-detail-frame). No default glow when unequipped.
 * Renders only when Mathematical Aura tier >= 1 (see shouldRenderGlow).
 *
 * @see card-render.js — .card-glow--halo mount (z0, behind .card-cosmetic-effects)
 */

import { getEquippedAura } from './profile-ui.js';

/** Player-ownable / purchasable glow effect ids. */
export const COSMETIC_GLOW_EFFECT_IDS = [
  'void',
  'rarity',
  'molten',
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

/**
 * Perimeter glow host — mount before .card-cosmetic-effects (z0).
 * @param {string|null|undefined} glowEffectId
 * @returns {string}
 */
export function renderGlowHaloLayerHtml(glowEffectId = null) {
  if (!glowEffectId || !COSMETIC_GLOW_EFFECT_IDS.includes(glowEffectId)) return '';
  return '<div class="card-glow card-glow--halo" aria-hidden="true"></div>';
}
