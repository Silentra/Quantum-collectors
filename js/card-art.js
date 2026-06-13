/**
 * card-art.js — Canonical card artwork resolution (admin override → local WebP → placeholder)
 *
 * Local assets: assets/scientists/{slug}.webp | assets/concepts/{slug}.webp
 * Slug derived from card.name (not cardId). No runtime file probing — missing files use img onerror.
 */

import { CARD_TYPES, TYPE_EMOJIS } from './cards.js';

const LOCAL_ART_FOLDERS = {
  scientist: 'assets/scientists',
  concept: 'assets/concepts',
};

/**
 * Deterministic filename stem from display name.
 * @param {string|null|undefined} name
 * @returns {string|null}
 */
export function normalizeCardArtSlug(name) {
  if (name == null || name === '') return null;

  let slug = String(name).trim();
  if (!slug) return null;

  slug = slug
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[''`´]/g, '')
    .replace(/[""]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || null;
}

/**
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function getAdminCardImageOverride(card) {
  if (!card) return null;
  const raw = (card.imageUrl ?? card.image ?? '').trim();
  return raw || null;
}

/**
 * Relative URL for repository-local artwork, or null if type unsupported / no slug.
 * @param {object} card
 * @returns {string|null}
 */
export function getLocalCardArtPath(card) {
  if (!card || !CARD_TYPES.includes(card.type)) return null;
  const slug = normalizeCardArtSlug(card.name);
  if (!slug) return null;
  const folder = LOCAL_ART_FOLDERS[card.type];
  if (!folder) return null;
  return `${folder}/${slug}.webp`;
}

/**
 * @typedef {'override'|'local'|'none'} CardArtSource
 * @typedef {{ src: string|null, source: CardArtSource, slug: string|null }} ResolvedCardArt
 */

/**
 * @param {object} card
 * @returns {ResolvedCardArt}
 */
export function resolveCardArt(card) {
  const slug = normalizeCardArtSlug(card?.name);

  const override = getAdminCardImageOverride(card);
  if (override) {
    return { src: override, source: 'override', slug };
  }

  const local = getLocalCardArtPath(card);
  if (local) {
    return { src: local, source: 'local', slug };
  }

  return { src: null, source: 'none', slug };
}

/**
 * @param {string} value
 * @returns {string}
 */
export function escapeCardArtAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/**
 * Emoji placeholder for a card type.
 * @param {object} card
 * @returns {string}
 */
export function getCardArtPlaceholderEmoji(card) {
  return TYPE_EMOJIS[card?.type] || '\uD83D\uDD2C';
}

/**
 * Replace a failed card-art img with the type emoji placeholder (silent).
 * @param {HTMLImageElement} img
 */
export function applyCardArtEmojiFallback(img) {
  if (!img || img.dataset.cardArtFallbackApplied === '1') return;
  img.dataset.cardArtFallbackApplied = '1';

  const emoji = img.dataset.fallbackEmoji || '\uD83D\uDD2C';
  const isMini = img.classList.contains('rp-mini-img');
  const artHost = img.closest('.card-detail-art');

  if (isMini) {
    const miniCard = img.closest('.rp-mini-card');
    if (!miniCard) return;
    const placeholder = document.createElement('div');
    placeholder.className = 'rp-mini-emoji';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.textContent = emoji;
    img.replaceWith(placeholder);
    return;
  }

  if (artHost) {
    const span = document.createElement('span');
    span.className = 'card-detail-art-emoji';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = emoji;
    img.replaceWith(span);
  }
}

let cardArtFallbackBound = false;

/** One-time delegated error handler for card artwork images. */
export function initCardArtFallback() {
  if (cardArtFallbackBound) return;
  cardArtFallbackBound = true;

  document.addEventListener(
    'error',
    (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLImageElement)) return;
      if (target.dataset.cardArtFallback !== '1') return;
      applyCardArtEmojiFallback(target);
    },
    true
  );
}

/**
 * Full-card art region HTML (.card-detail-art).
 * @param {object} card
 * @param {ResolvedCardArt} [resolved]
 * @returns {string}
 */
export function renderCardDetailArtHtml(card, resolved = resolveCardArt(card)) {
  const emoji = getCardArtPlaceholderEmoji(card);
  if (!resolved.src) {
    return `<span class="card-detail-art-emoji" aria-hidden="true">${emoji}</span>`;
  }

  const safeSrc = escapeCardArtAttr(resolved.src);
  const safeAlt = escapeCardArtAttr(card.name || 'Card artwork');
  const safeEmoji = escapeCardArtAttr(emoji);

  return `<img src="${safeSrc}" alt="${safeAlt}" loading="lazy" decoding="async" data-card-art-fallback="1" data-fallback-emoji="${safeEmoji}">`;
}

/**
 * Research project mini-card art HTML.
 * @param {object} card
 * @param {ResolvedCardArt} [resolved]
 * @returns {string}
 */
export function renderMiniCardArtHtml(card, resolved = resolveCardArt(card)) {
  const emoji = getCardArtPlaceholderEmoji(card);
  const safeName = escapeCardArtAttr(card.name || 'Card');

  if (!resolved.src) {
    return `<div class="rp-mini-emoji" aria-hidden="true">${emoji}</div>`;
  }

  const safeSrc = escapeCardArtAttr(resolved.src);
  const safeEmoji = escapeCardArtAttr(emoji);

  return `<img class="rp-mini-img" src="${safeSrc}" alt="${safeName}" loading="lazy" decoding="async" data-card-art-fallback="1" data-fallback-emoji="${safeEmoji}">`;
}
