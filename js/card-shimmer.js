/**
 * card-shimmer.js — Shimmer cosmetic render resolution (card-face surface effects).
 *
 * Tier 1+ cards receive face shimmer. Default = prismatic (not a shop item).
 * Equipped premium shimmer overrides default when owned.
 *
 * @see card-render.js — inner mount inside .card-detail-inner (full card interior)
 */

import { getEquippedShimmer } from './profile-ui.js';

/** Default face shimmer for tier 1+ cards when no premium shimmer is equipped. */
export const DEFAULT_SHIMMER_EFFECT_ID = 'prismatic';

/** Player-ownable / purchasable shimmer effect ids (excludes automatic prismatic default). */
export const COSMETIC_SHIMMER_EFFECT_IDS = [
  'holographic',
  'voltaic',
];

/** All ids recognized by the shimmer renderer (default + purchasable). */
export const SHIMMER_EFFECT_IDS = [DEFAULT_SHIMMER_EFFECT_ID, ...COSMETIC_SHIMMER_EFFECT_IDS];

/**
 * @param {number} auraTier - Mathematical Aura tier (0–3)
 * @returns {boolean}
 */
export function shouldRenderShimmer(auraTier) {
  return typeof auraTier === 'number' && auraTier >= 1;
}

/**
 * Resolve active shimmer effect id from Mathematical Aura tier + optional equip.
 * @param {object} [options]
 * @param {number} options.auraTier
 * @param {object|null} [options.shimmerDefinition] - equipped shimmer cosmetic definition
 * @returns {string|null} effect id or null when tier 0
 */
export function resolveShimmerRenderEffectId({ auraTier, shimmerDefinition = null } = {}) {
  if (!shouldRenderShimmer(auraTier)) return null;

  const id = shimmerDefinition?.renderEffectId;
  if (id && COSMETIC_SHIMMER_EFFECT_IDS.includes(id)) return id;

  return DEFAULT_SHIMMER_EFFECT_ID;
}

/**
 * @param {object|null|undefined} playerData
 * @param {number} auraTier
 * @returns {string|null}
 */
export function resolveShimmerRenderEffectIdForCard(playerData, auraTier) {
  return resolveShimmerRenderEffectId({
    auraTier,
    shimmerDefinition: getEquippedShimmer(playerData)?.definition,
  });
}

/**
 * @param {string|null|undefined} shimmerEffectId
 * @returns {Record<string, string>}
 */
export function getCardShimmerDataAttrs(shimmerEffectId) {
  if (!shimmerEffectId || !SHIMMER_EFFECT_IDS.includes(shimmerEffectId)) return {};
  return { 'data-card-shimmer': shimmerEffectId };
}

/**
 * @param {string|null|undefined} shimmerEffectId
 * @returns {string} HTML attribute fragment (leading space when set)
 */
export function formatCardShimmerAttr(shimmerEffectId) {
  const attrs = getCardShimmerDataAttrs(shimmerEffectId);
  const value = attrs['data-card-shimmer'];
  return value ? ` data-card-shimmer="${value}"` : '';
}

/** Face shimmer layer HTML — mount inside .card-detail-inner (covers header, art, divider, body). */
export function renderShimmerFaceLayerHtml() {
  return '<div class="card-shimmer card-shimmer--face" aria-hidden="true"></div>';
}
