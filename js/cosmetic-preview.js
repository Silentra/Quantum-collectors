/**

 * Lightweight slug-driven cosmetic previews (CSS-only; no renderer coupling).

 * Inline shop tiles and expanded modal share the same surface markup + slug attrs.

 */



import { cosmeticIdToShellSlug } from './shell-theme.js';

import { COSMETIC_BORDER_EFFECT_IDS } from './card-border.js';
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

 * Core preview surface (category + slug CSS). Used by inline and expanded views.

 * @param {object} item

 * @param {(value: string) => string} escapeHtml

 * @param {{ expanded?: boolean }} [options]

 * @returns {string}

 */

export function renderCosmeticPreviewSurface(item, escapeHtml, options = {}) {

  if (!item || item.type !== ITEM_TYPES.COSMETIC) return '';



  const slug = getCosmeticPreviewSlug(item);

  if (!slug) return '';



  const expandedClass = options.expanded ? ' cosmetic-preview--expanded' : '';



  if (item.category === ITEM_CATEGORIES.SHELL_BACKGROUND) {

    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--bg${expandedClass}" data-bg-slug="${escapeHtml(slug)}" role="img" aria-label="Background preview"></div>`;

  }



  if (item.category === ITEM_CATEGORIES.TITLE) {

    const label = escapeHtml(item.name || 'Title');

    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--title${expandedClass}" role="img" aria-label="Title preview"><span class="shop-cosmetic-preview-title-text">${label}</span></div>`;

  }



  if (item.category === ITEM_CATEGORIES.AURA) {

    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--aura aura-prismatic${expandedClass}" data-aura-tier="2" role="img" aria-label="Glow preview"></div>`;

  }



  if (item.category === ITEM_CATEGORIES.BORDER) {

    const effectId = COSMETIC_BORDER_EFFECT_IDS.includes(item.renderEffectId)
      ? item.renderEffectId
      : 'silver';

    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--border${expandedClass}" data-card-border="${escapeHtml(effectId)}" role="img" aria-label="Border preview"><div class="card-cosmetic-effects" aria-hidden="true"></div></div>`;

  }



  if (item.category === ITEM_CATEGORIES.PROFILE_BANNER) {

    return `<div class="shop-cosmetic-preview shop-cosmetic-preview--banner${expandedClass}" data-banner-slug="${escapeHtml(slug)}" role="img" aria-label="Banner preview"></div>`;

  }



  return '';

}



/**

 * @param {object|null|undefined} item

 * @param {(value: string) => string} escapeHtml

 * @returns {string}

 */

export function renderShopCosmeticPreview(item, escapeHtml) {

  const surface = renderCosmeticPreviewSurface(item, escapeHtml, { expanded: false });

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

 * @returns {string}

 */

export function renderExpandedCosmeticPreview(item, escapeHtml) {

  return renderCosmeticPreviewSurface(item, escapeHtml, { expanded: true });

}


