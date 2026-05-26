/**
 * Lightweight slug-driven shop cosmetic previews (CSS-only; no renderer coupling).
 */

import { cosmeticIdToShellSlug } from './shell-theme.js';
import { ITEM_CATEGORIES, ITEM_TYPES } from './shop-definitions.js';

/**
 * @param {object|null|undefined} item
 * @returns {string|null}
 */
export function getCosmeticPreviewSlug(item) {
  if (!item?.id || item.type !== ITEM_TYPES.COSMETIC) return null;
  return cosmeticIdToShellSlug(item.id);
}

/**
 * @param {object|null|undefined} item
 * @param {(value: string) => string} escapeHtml
 * @returns {string}
 */
export function renderShopCosmeticPreview(item, escapeHtml) {
  if (!item || item.type !== ITEM_TYPES.COSMETIC) return '';

  const slug = getCosmeticPreviewSlug(item);
  if (!slug) return '';

  if (item.category === ITEM_CATEGORIES.SHELL_BACKGROUND) {
    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--bg" data-bg-slug="${escapeHtml(slug)}" role="img" aria-label="Background preview"></div>`;
  }

  if (item.category === ITEM_CATEGORIES.TITLE) {
    const label = escapeHtml(item.name || 'Title');
    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--title" role="img" aria-label="Title preview"><span class="shop-cosmetic-preview-title-text">${label}</span></div>`;
  }

  if (item.category === ITEM_CATEGORIES.AURA) {
    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--aura aura-prismatic" data-aura-tier="2" role="img" aria-label="Glow preview"></div>`;
  }

  if (item.category === ITEM_CATEGORIES.BORDER) {
    const rarity = escapeHtml(item.rarity || 'rare');
    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--border rarity-${rarity}" role="img" aria-label="Border preview"></div>`;
  }

  if (item.category === ITEM_CATEGORIES.PROFILE_BANNER) {
    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--banner" data-banner-slug="${escapeHtml(slug)}" role="img" aria-label="Banner preview"></div>`;
  }

  return '';
}
