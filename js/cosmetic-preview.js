/**
 * Cosmetic previews — slug-driven surfaces + full-card shimmer previews.
 * Inline shop tiles and expanded modal share preview helpers.
 */

import { getEnabledCards } from './cards.js';
import { renderCollectionCard } from './card-render.js';
import { COSMETIC_SHIMMER_EFFECT_IDS } from './card-shimmer.js';
import { DEFAULT_BORDER_EFFECT_ID, COSMETIC_BORDER_EFFECT_IDS } from './card-border.js';
import { cosmeticIdToShellSlug } from './shell-theme.js';
import { ITEM_CATEGORIES, ITEM_RARITIES, ITEM_TYPES } from './shop-definitions.js';

const PREVIEW_CARD_RARITIES = [
  ITEM_RARITIES.LEGENDARY,
  ITEM_RARITIES.EPIC,
  ITEM_RARITIES.RARE,
  ITEM_RARITIES.UNCOMMON,
  ITEM_RARITIES.COMMON,
];

/** Mathematical Aura tier forced for shimmer shop previews (effect always visible). */
export const SHIMMER_PREVIEW_AURA_TIER = 3;

/**
 * First enabled card by rarity descent, alphabetical within tier (shop shimmer preview).
 * @returns {object|null}
 */
export function resolveCosmeticPreviewCard() {
  const enabled = getEnabledCards();
  for (const rarity of PREVIEW_CARD_RARITIES) {
    const match = enabled
      .filter(card => card.rarity === rarity)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))[0];
    if (match) return match;
  }
  return null;
}

/**
 * @param {object|null|undefined} item
 * @returns {string|null}
 */
export function getCosmeticPreviewSlug(item) {
  if (!item?.id || item.type !== ITEM_TYPES.COSMETIC) return null;
  return cosmeticIdToShellSlug(item.id);
}

/**
 * @param {object} item
 * @param {(value: string) => string} escapeHtml
 * @param {{ borderRenderEffectId?: string|null }} [options]
 * @returns {string}
 */
function renderShimmerCardPreview(item, escapeHtml, options = {}) {
  const previewCard = resolveCosmeticPreviewCard();
  if (!previewCard) return '';

  const effectId = COSMETIC_SHIMMER_EFFECT_IDS.includes(item.renderEffectId)
    ? item.renderEffectId
    : null;
  if (!effectId) return '';

  const borderEffect = options.borderRenderEffectId != null
    ? options.borderRenderEffectId
    : DEFAULT_BORDER_EFFECT_ID;

  const cardHtml = renderCollectionCard(previewCard, {
    quantity: 3,
    variant: 'collection',
    auraTierOverride: SHIMMER_PREVIEW_AURA_TIER,
    shimmerRenderEffectId: effectId,
    borderRenderEffectId: borderEffect,
  });

  const label = escapeHtml(item.name || 'Shimmer');
  return `
    <div class="shop-cosmetic-preview shop-cosmetic-preview--shimmer" role="img" aria-label="${label} preview">
      <div class="shop-card-preview-slot">${cardHtml}</div>
    </div>`;
}

/**
 * Core preview surface (category + slug CSS). Used by inline and expanded views.
 * @param {object} item
 * @param {(value: string) => string} escapeHtml
 * @param {{ expanded?: boolean, borderRenderEffectId?: string|null }} [options]
 * @returns {string}
 */
export function renderCosmeticPreviewSurface(item, escapeHtml, options = {}) {
  if (!item || item.type !== ITEM_TYPES.COSMETIC) return '';

  const expandedClass = options.expanded ? ' cosmetic-preview--expanded' : '';

  if (item.category === ITEM_CATEGORIES.SHIMMER) {
    const surface = renderShimmerCardPreview(item, escapeHtml, options);
    if (!surface) return '';
    return surface.replace(
      'shop-cosmetic-preview--shimmer"',
      `shop-cosmetic-preview--shimmer${expandedClass}"`
    );
  }

  const slug = getCosmeticPreviewSlug(item);
  if (!slug) return '';

  if (item.category === ITEM_CATEGORIES.SHELL_BACKGROUND) {
    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--bg${expandedClass}" data-bg-slug="${escapeHtml(slug)}" role="img" aria-label="Background preview"></div>`;
  }

  if (item.category === ITEM_CATEGORIES.TITLE) {
    const label = escapeHtml(item.name || 'Title');
    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--title${expandedClass}" role="img" aria-label="Title preview"><span class="shop-cosmetic-preview-title-text">${label}</span></div>`;
  }

  if (item.category === ITEM_CATEGORIES.AURA) {
    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--aura${expandedClass}" role="img" aria-label="Glow preview"></div>`;
  }

  if (item.category === ITEM_CATEGORIES.BORDER) {
    const effectId = COSMETIC_BORDER_EFFECT_IDS.includes(item.renderEffectId)
      ? item.renderEffectId
      : DEFAULT_BORDER_EFFECT_ID;

    const rarityClass = effectId === 'spectrum' ? ' rarity-legendary' : '';

    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--border${rarityClass}${expandedClass}" data-card-border="${escapeHtml(effectId)}" role="img" aria-label="Border preview"><div class="card-cosmetic-effects" aria-hidden="true"></div></div>`;
  }

  if (item.category === ITEM_CATEGORIES.PROFILE_BANNER) {
    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--banner${expandedClass}" data-banner-slug="${escapeHtml(slug)}" role="img" aria-label="Banner preview"></div>`;
  }

  return '';
}

/**
 * @param {object|null|undefined} item
 * @param {(value: string) => string} escapeHtml
 * @param {{ borderRenderEffectId?: string|null }} [options]
 * @returns {string}
 */
export function renderShopCosmeticPreview(item, escapeHtml, options = {}) {
  const surface = renderCosmeticPreviewSurface(item, escapeHtml, { ...options, expanded: false });
  if (!surface) return '';

  const label = escapeHtml(item.name || 'cosmetic');
  return `
    <button type="button"
      class="shop-preview-expand shop-preview-expand--cosmetic"
      data-shop-preview="cosmetic"
      data-cosmetic-item-id="${escapeHtml(item.id)}"
      aria-label="Enlarge ${label} preview">
      ${surface}
    </button>
  `;
}

/**
 * Expanded preview markup for #cosmetic-preview-stage (no button wrapper).
 * @param {object|null|undefined} item
 * @param {(value: string) => string} escapeHtml
 * @param {{ borderRenderEffectId?: string|null }} [options]
 * @returns {string}
 */
export function renderExpandedCosmeticPreview(item, escapeHtml, options = {}) {
  return renderCosmeticPreviewSurface(item, escapeHtml, { ...options, expanded: true });
}
