/**
 * Cosmetic previews — shell slug stubs + unified card-face previews (Border / Shimmer / future Glow).
 * Inline shop tiles and expanded modal share the same helpers.
 */

import * as cards from './cards.js';
import * as db from './database.js';
import { renderCollectionCard } from './card-render.js';
import { COSMETIC_SHIMMER_EFFECT_IDS } from './card-shimmer.js';
import { COSMETIC_BORDER_EFFECT_IDS, DEFAULT_BORDER_EFFECT_ID } from './card-border.js';
import { getCosmeticDefinition } from './cosmetic-definitions.js';
import { cosmeticIdToShellSlug } from './shell-theme.js';
import { ITEM_CATEGORIES, ITEM_RARITIES, ITEM_TYPES } from './shop-definitions.js';

const PREVIEW_CARD_RARITIES = [
  ITEM_RARITIES.LEGENDARY,
  ITEM_RARITIES.EPIC,
  ITEM_RARITIES.RARE,
  ITEM_RARITIES.UNCOMMON,
  ITEM_RARITIES.COMMON,
];

/** Mathematical Aura tier forced for card-face shop previews (shimmer always visible). */
export const CARD_FACE_PREVIEW_AURA_TIER = 3;

/** @deprecated use CARD_FACE_PREVIEW_AURA_TIER */
export const SHIMMER_PREVIEW_AURA_TIER = CARD_FACE_PREVIEW_AURA_TIER;

const CARD_FACE_PREVIEW_CATEGORIES = new Set([
  ITEM_CATEGORIES.BORDER,
  ITEM_CATEGORIES.SHIMMER,
]);

/**
 * @typedef {Object} CardFacePreviewPlayerContext
 * @property {string|null} [borderRenderEffectId] - player's equipped border for context
 * @property {object|null} [equippedShimmerDefinition] - player's equipped shimmer for context
 * @property {string|null} [glowRenderEffectId] - reserved for future Glow equip override
 */

/**
 * First enabled card by rarity descent, alphabetical within tier.
 * Hydrates via cards.getCard(id) — same path as shop card-item previews.
 * @returns {object|null}
 */
export function resolveCosmeticPreviewCard() {
  const enabled = db.getChildren('cards').filter(({ value }) => value?.enabled !== false);

  for (const rarity of PREVIEW_CARD_RARITIES) {
    const tierMatches = enabled
      .filter(({ value }) => value?.rarity === rarity)
      .sort((a, b) => (a.value.name || '').localeCompare(b.value.name || ''));

    for (const { key, value } of tierMatches) {
      const cardId = value?.id ?? key;
      const card = cards.getCard(cardId);
      if (!card || !(card.name || '').trim()) continue;
      return card;
    }
  }
  return null;
}

/**
 * Shared shop preview slot wrapper — same markup as card-item shop previews.
 * @param {object} card
 * @param {import('./card-render.js').CardRenderOptions} [options]
 * @returns {string}
 */
export function renderShopCardPreviewSlot(card, options = {}) {
  return `<div class="shop-card-preview-slot">${renderCollectionCard(card, options)}</div>`;
}

/**
 * Merge shop slot item with canonical cosmetic definition (restores renderEffectId, etc.).
 * @param {object|null|undefined} item
 * @returns {object|null}
 */
export function normalizeCosmeticPreviewItem(item) {
  if (!item?.id) return null;

  const definition = getCosmeticDefinition(item.id) || item.definition || null;

  return {
    id: item.id,
    name: definition?.name ?? item.name,
    description: definition?.description ?? item.description,
    type: definition?.type ?? item.type,
    category: definition?.category ?? item.category,
    rarity: definition?.rarity ?? item.rarity,
    renderEffectId: definition?.renderEffectId ?? item.renderEffectId ?? null,
    definition,
  };
}

/**
 * @param {string|null|undefined} category
 * @returns {boolean}
 */
export function isCardFacePreviewCategory(category) {
  return CARD_FACE_PREVIEW_CATEGORIES.has(category);
}

/**
 * @param {object} item - normalized cosmetic item
 * @param {CardFacePreviewPlayerContext} [playerContext]
 * @returns {import('./card-render.js').CardRenderOptions}
 */
export function buildCardFacePreviewOptions(item, playerContext = {}) {
  const ctx = playerContext || {};
  const options = {
    quantity: 3,
    variant: 'collection',
    auraTierOverride: CARD_FACE_PREVIEW_AURA_TIER,
    borderRenderEffectId: ctx.borderRenderEffectId ?? null,
    equippedShimmerDefinition: ctx.equippedShimmerDefinition ?? null,
  };

  const effectId = item.renderEffectId;

  if (item.category === ITEM_CATEGORIES.BORDER) {
    if (effectId && COSMETIC_BORDER_EFFECT_IDS.includes(effectId)) {
      options.borderRenderEffectId = effectId;
    } else {
      options.borderRenderEffectId = DEFAULT_BORDER_EFFECT_ID;
    }
  }

  if (item.category === ITEM_CATEGORIES.SHIMMER) {
    if (effectId && COSMETIC_SHIMMER_EFFECT_IDS.includes(effectId)) {
      options.shimmerRenderEffectId = effectId;
    }
    if (options.borderRenderEffectId == null) {
      options.borderRenderEffectId = DEFAULT_BORDER_EFFECT_ID;
    }
  }

  // Reserved for future Glow — glowRenderEffectId on ctx when card-glow ships
  if (item.category === ITEM_CATEGORIES.AURA && ctx.glowRenderEffectId) {
    options.glowRenderEffectId = ctx.glowRenderEffectId;
  }

  return options;
}

/**
 * Unified real-card preview for Border / Shimmer (future Glow uses same path).
 * @param {object} item - normalized cosmetic item
 * @param {(value: string) => string} escapeHtml
 * @param {{ expanded?: boolean, playerContext?: CardFacePreviewPlayerContext }} [options]
 * @returns {string}
 */
export function renderCardFaceCosmeticPreview(item, escapeHtml, options = {}) {
  if (!item || !isCardFacePreviewCategory(item.category)) return '';

  const previewCard = resolveCosmeticPreviewCard();
  const expandedClass = options.expanded ? ' cosmetic-preview--expanded' : '';

  if (!previewCard) {
    return `
      <div class="shop-cosmetic-preview shop-cosmetic-preview--card shop-cosmetic-preview--unavailable${expandedClass}" data-preview-category="${escapeHtml(item.category)}" role="status">
        <span class="shop-cosmetic-preview-unavailable-text">No cards available for preview</span>
      </div>`;
  }

  const slotHtml = renderShopCardPreviewSlot(
    previewCard,
    buildCardFacePreviewOptions(item, options.playerContext)
  );

  const label = escapeHtml(item.name || 'Cosmetic');
  return `
    <div class="shop-cosmetic-preview shop-cosmetic-preview--card${expandedClass}" data-preview-category="${escapeHtml(item.category)}" role="img" aria-label="${label} preview">
      ${slotHtml}
    </div>`;
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
 * Core preview surface (category + slug CSS). Used by inline and expanded views.
 * @param {object} item
 * @param {(value: string) => string} escapeHtml
 * @param {{ expanded?: boolean, playerContext?: CardFacePreviewPlayerContext }} [options]
 * @returns {string}
 */
export function renderCosmeticPreviewSurface(item, escapeHtml, options = {}) {
  const normalized = normalizeCosmeticPreviewItem(item);
  if (!normalized || normalized.type !== ITEM_TYPES.COSMETIC) return '';

  if (isCardFacePreviewCategory(normalized.category)) {
    return renderCardFaceCosmeticPreview(normalized, escapeHtml, options);
  }

  const expandedClass = options.expanded ? ' cosmetic-preview--expanded' : '';
  const slug = getCosmeticPreviewSlug(normalized);
  if (!slug && normalized.category !== ITEM_CATEGORIES.TITLE && normalized.category !== ITEM_CATEGORIES.AURA) {
    return '';
  }

  if (normalized.category === ITEM_CATEGORIES.SHELL_BACKGROUND) {
    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--bg${expandedClass}" data-bg-slug="${escapeHtml(slug)}" role="img" aria-label="Background preview"></div>`;
  }

  if (normalized.category === ITEM_CATEGORIES.TITLE) {
    const label = escapeHtml(normalized.name || 'Title');
    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--title${expandedClass}" role="img" aria-label="Title preview"><span class="shop-cosmetic-preview-title-text">${label}</span></div>`;
  }

  if (normalized.category === ITEM_CATEGORIES.AURA) {
    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--aura${expandedClass}" role="img" aria-label="Glow preview"></div>`;
  }

  if (normalized.category === ITEM_CATEGORIES.PROFILE_BANNER) {
    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--banner${expandedClass}" data-banner-slug="${escapeHtml(slug)}" role="img" aria-label="Banner preview"></div>`;
  }

  return '';
}

/**
 * @param {object|null|undefined} item
 * @param {(value: string) => string} escapeHtml
 * @param {{ playerContext?: CardFacePreviewPlayerContext }} [options]
 * @returns {string}
 */
export function renderShopCosmeticPreview(item, escapeHtml, options = {}) {
  const normalized = normalizeCosmeticPreviewItem(item);
  const surface = renderCosmeticPreviewSurface(normalized || item, escapeHtml, { ...options, expanded: false });
  if (!surface) return '';

  const label = escapeHtml((normalized || item)?.name || 'cosmetic');
  return `
    <button type="button"
      class="shop-preview-expand shop-preview-expand--cosmetic"
      data-shop-preview="cosmetic"
      data-cosmetic-item-id="${escapeHtml((normalized || item).id)}"
      aria-label="Enlarge ${label} preview">
      ${surface}
    </button>
  `;
}

/**
 * Expanded preview markup for #cosmetic-preview-stage (no button wrapper).
 * @param {object|null|undefined} item
 * @param {(value: string) => string} escapeHtml
 * @param {{ playerContext?: CardFacePreviewPlayerContext }} [options]
 * @returns {string}
 */
export function renderExpandedCosmeticPreview(item, escapeHtml, options = {}) {
  const normalized = normalizeCosmeticPreviewItem(item);
  return renderCosmeticPreviewSurface(normalized || item, escapeHtml, { ...options, expanded: true });
}
