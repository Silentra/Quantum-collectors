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

/** Voltaic discharge cycle length — must match CSS animation-duration (10s). */
export const VOLTAIC_CYCLE_SECONDS = 10;

/** Deterministic phase buckets for animation-delay desync (40 × 0.25s steps across 10s). */
export const VOLTAIC_PHASE_BUCKETS = 40;

/**
 * Stable string hash for phase bucketing (djb2-style).
 * @param {string} seed
 * @returns {number} unsigned 32-bit
 */
export function hashStringForPhase(seed) {
  let hash = 5381;
  const text = String(seed ?? '');
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Negative animation-delay (seconds) so Voltaic cards start mid-cycle immediately.
 * @param {string} cardId
 * @returns {number} in range [-VOLTAIC_CYCLE_SECONDS, 0]
 */
export function getVoltaicPhaseDelaySeconds(cardId) {
  const id = String(cardId ?? '').trim();
  if (!id) return 0;
  const bucket = hashStringForPhase(id) % VOLTAIC_PHASE_BUCKETS;
  const offset = (bucket / VOLTAIC_PHASE_BUCKETS) * VOLTAIC_CYCLE_SECONDS;
  const rounded = Math.round(offset * 100) / 100;
  return rounded === 0 ? 0 : -rounded;
}

/**
 * Inline style for per-card Voltaic phase (--voltaic-phase-delay on card shell).
 * @param {string|null|undefined} cardId
 * @param {string|null|undefined} shimmerEffectId
 * @returns {string} leading space + style attr, or empty
 */
export function formatVoltaicPhaseStyleAttr(cardId, shimmerEffectId) {
  if (shimmerEffectId !== 'voltaic') return '';
  const delay = getVoltaicPhaseDelaySeconds(cardId);
  return ` style="--voltaic-phase-delay: ${delay}s"`;
}

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
