/**
 * card-shimmer.js — Shimmer cosmetic render resolution (card-face surface effects).
 *
 * Phase 1–2: automatic default shimmer (prismatic) when Mathematical Aura tier >= 1.
 * No equip/shop/registry in this module yet.
 *
 * @see card-render.js — inner mount inside .card-detail-inner (full card interior)
 */

/** Default face shimmer for tier 1+ cards (shimmer_prismatic concept). */
export const DEFAULT_SHIMMER_EFFECT_ID = 'prismatic';

/** Recognized shimmer effect ids for CSS [data-card-shimmer]. */
export const SHIMMER_EFFECT_IDS = [DEFAULT_SHIMMER_EFFECT_ID];

/**
 * @param {number} auraTier - Mathematical Aura tier (0–3)
 * @returns {boolean}
 */
export function shouldRenderShimmer(auraTier) {
  return typeof auraTier === 'number' && auraTier >= 1;
}

/**
 * Resolve active shimmer effect id from Mathematical Aura tier.
 * @param {object} [options]
 * @param {number} options.auraTier
 * @param {object|null} [options.shimmerDefinition] - reserved for future equip override
 * @returns {string|null} effect id or null when tier 0
 */
export function resolveShimmerRenderEffectId({ auraTier, shimmerDefinition = null } = {}) {
  if (!shouldRenderShimmer(auraTier)) return null;

  const id = shimmerDefinition?.renderEffectId;
  if (id && SHIMMER_EFFECT_IDS.includes(id)) return id;

  return DEFAULT_SHIMMER_EFFECT_ID;
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
