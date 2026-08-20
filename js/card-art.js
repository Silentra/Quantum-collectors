/**
 * card-art.js — Canonical card artwork resolution (admin override → local WebP → placeholder)
 *
 * Local assets: assets/scientists/{slug}.webp | assets/concepts/{slug}.webp
 * Slug derived from card.name (not cardId). No runtime file probing — missing files use img onerror.
 *
 * Transient delivery (e.g. GitHub Pages 503): one delayed same-URL retry after emoji fallback.
 */

import { CARD_TYPES, TYPE_EMOJIS } from './cards.js';

const LOCAL_ART_FOLDERS = {
  scientist: 'assets/scientists',
  concept: 'assets/concepts',
};

/** Delay before the single artwork retry (ms). */
const CARD_ART_RETRY_DELAY_MS = 500;

/** Dev-only: localStorage.qc_card_art_diag === 'true' */
const CARD_ART_DIAG_LS_KEY = 'qc_card_art_diag';

/** 1×1 transparent GIF — diag probe only; restore still uses the real artwork URL. */
const CARD_ART_DIAG_PROBE_DATA_URI =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Guaranteed-missing path to force a first-load error under simulateTransientFailure. */
const CARD_ART_DIAG_MISSING_SRC = 'assets/scientists/__card_art_diag_missing__.webp';

/**
 * One-shot diag simulation arm (cleared after one retry schedule).
 * @type {{ probeSucceed: boolean, zeroDelay: boolean }|null}
 */
let _cardArtDiagSimArm = null;
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

function _isCardArtDiagEnabled() {
  try {
    return localStorage.getItem(CARD_ART_DIAG_LS_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * @returns {number}
 */
function _cardArtRetryDelayMs() {
  if (_isCardArtDiagEnabled() && _cardArtDiagSimArm?.zeroDelay) return 0;
  return CARD_ART_RETRY_DELAY_MS;
}

/**
 * Consume one-shot probe override after schedule starts.
 * @returns {boolean}
 */
function _consumeDiagProbeSucceed() {
  if (!_isCardArtDiagEnabled() || !_cardArtDiagSimArm?.probeSucceed) return false;
  _cardArtDiagSimArm = null;
  return true;
}

/**
 * @param {object} entry
 */
function _cardArtDiag(entry) {
  if (!_isCardArtDiagEnabled()) return;
  console.info('[CardArtDiag]', entry);
}

/**
 * @param {boolean} isMini
 * @param {string} emoji
 * @returns {HTMLElement}
 */
function _createEmojiPlaceholder(isMini, emoji) {
  if (isMini) {
    const placeholder = document.createElement('div');
    placeholder.className = 'rp-mini-emoji';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.textContent = emoji;
    return placeholder;
  }
  const span = document.createElement('span');
  span.className = 'card-detail-art-emoji';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = emoji;
  return span;
}

/**
 * Rebuild a card-art img for a successful retry restore.
 * @param {{
 *   src: string,
 *   alt: string,
 *   emoji: string,
 *   isMini: boolean,
 *   cardName: string,
 * }} meta
 * @returns {HTMLImageElement}
 */
function _createRestoredCardArtImg(meta) {
  const img = document.createElement('img');
  img.src = meta.src;
  img.alt = meta.alt || 'Card artwork';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.dataset.cardArtFallback = '1';
  img.dataset.fallbackEmoji = meta.emoji;
  img.dataset.cardArtRetryAttempted = '1';
  if (meta.cardName) img.dataset.cardArtName = meta.cardName;
  if (meta.isMini) img.classList.add('rp-mini-img');
  return img;
}

/**
 * One delayed same-URL retry after emoji fallback. Off-DOM probe; restore only if
 * the placeholder is still connected and still owns this retry token.
 * @param {HTMLElement} placeholder
 * @param {string} token
 */
function _scheduleCardArtRetry(placeholder, token) {
  const delayMs = _cardArtRetryDelayMs();
  const diagProbeSucceed = _consumeDiagProbeSucceed();

  window.setTimeout(() => {
    if (!placeholder.isConnected) return;
    if (placeholder.dataset.cardArtRetryToken !== token) return;
    if (placeholder.dataset.cardArtRetryPending !== '1') return;

    const src = placeholder.dataset.cardArtRetrySrc || '';
    if (!src) {
      delete placeholder.dataset.cardArtRetryPending;
      return;
    }

    const isMini = placeholder.dataset.cardArtRetrySurface === 'mini';
    const emoji = placeholder.dataset.cardArtRetryEmoji
      || placeholder.textContent
      || '\uD83D\uDD2C';
    const alt = placeholder.dataset.cardArtRetryAlt || 'Card artwork';
    const cardName = placeholder.dataset.cardArtName || '';
    const surface = isMini ? 'mini' : 'detail';

    _cardArtDiag({
      event: 'retry_attempted',
      url: src,
      surface,
      card: cardName || null,
      diagProbe: diagProbeSucceed || undefined,
    });

    const probe = new Image();
    probe.onload = () => {
      if (!placeholder.isConnected) return;
      if (placeholder.dataset.cardArtRetryToken !== token) return;
      if (placeholder.dataset.cardArtRetryPending !== '1') return;

      const restored = _createRestoredCardArtImg({
        src,
        alt,
        emoji,
        isMini,
        cardName,
      });
      delete placeholder.dataset.cardArtRetryPending;
      placeholder.replaceWith(restored);
      _cardArtDiag({
        event: 'retry_recovered',
        url: src,
        surface,
        card: cardName || null,
      });
    };
    probe.onerror = () => {
      if (!placeholder.isConnected) return;
      if (placeholder.dataset.cardArtRetryToken !== token) return;
      delete placeholder.dataset.cardArtRetryPending;
      _cardArtDiag({
        event: 'retry_failed',
        url: src,
        surface,
        card: cardName || null,
      });
    };
    // Production: same URL — no cache-bust. Diag sim: tiny data URI so probe succeeds;
    // restored img still uses real `src` from placeholder metadata.
    probe.src = diagProbeSucceed ? CARD_ART_DIAG_PROBE_DATA_URI : src;
  }, delayMs);
}

/**
 * Replace a failed card-art img with the type emoji placeholder (silent).
 * Schedules at most one same-URL retry; never loops.
 * @param {HTMLImageElement} img
 */
export function applyCardArtEmojiFallback(img) {
  if (!img || img.dataset.cardArtFallbackApplied === '1') return;
  img.dataset.cardArtFallbackApplied = '1';

  const emoji = img.dataset.fallbackEmoji || '\uD83D\uDD2C';
  const isMini = img.classList.contains('rp-mini-img');
  const artHost = img.closest('.card-detail-art');
  const miniCard = isMini ? img.closest('.rp-mini-card') : null;

  if (isMini && !miniCard) return;
  if (!isMini && !artHost) return;

  // Diag sim may force a missing src while preserving the real retry URL on the dataset.
  let src = '';
  if (_isCardArtDiagEnabled() && img.dataset.cardArtDiagSimRealSrc) {
    src = String(img.dataset.cardArtDiagSimRealSrc).trim();
    delete img.dataset.cardArtDiagSimRealSrc;
  } else {
    src = (img.getAttribute('src') || img.currentSrc || '').trim();
  }
  const alt = img.getAttribute('alt') || '';
  const cardName = img.dataset.cardArtName || '';
  const alreadyRetried = img.dataset.cardArtRetryAttempted === '1';
  const surface = isMini ? 'mini' : 'detail';

  const placeholder = _createEmojiPlaceholder(isMini, emoji);
  if (cardName) placeholder.dataset.cardArtName = cardName;

  _cardArtDiag({
    event: 'initial_failure',
    url: src || null,
    surface,
    card: cardName || null,
    willRetry: Boolean(src && !alreadyRetried),
  });

  if (!src || alreadyRetried) {
    img.replaceWith(placeholder);
    return;
  }

  const token = `r${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  placeholder.dataset.cardArtRetrySrc = src;
  placeholder.dataset.cardArtRetryAlt = alt;
  placeholder.dataset.cardArtRetryEmoji = emoji;
  placeholder.dataset.cardArtRetrySurface = surface;
  placeholder.dataset.cardArtRetryPending = '1';
  placeholder.dataset.cardArtRetryToken = token;

  img.replaceWith(placeholder);
  _scheduleCardArtRetry(placeholder, token);
}

/**
 * Resolve a live card-art img for diag simulation.
 * @param {string|HTMLImageElement|null|undefined} selectorOrImg
 * @returns {HTMLImageElement|null}
 */
function _resolveCardArtDiagTarget(selectorOrImg) {
  if (selectorOrImg instanceof HTMLImageElement) {
    return selectorOrImg.dataset.cardArtFallback === '1' ? selectorOrImg : null;
  }
  if (typeof selectorOrImg === 'string' && selectorOrImg.trim()) {
    const el = document.querySelector(selectorOrImg.trim());
    if (el instanceof HTMLImageElement && el.dataset.cardArtFallback === '1') return el;
    return null;
  }
  const imgs = document.querySelectorAll('img[data-card-art-fallback="1"]');
  for (const el of imgs) {
    if (!(el instanceof HTMLImageElement)) continue;
    if (el.dataset.cardArtFallbackApplied === '1') continue;
    if (el.offsetParent === null && el.getClientRects().length === 0) continue;
    return el;
  }
  return imgs[0] instanceof HTMLImageElement ? imgs[0] : null;
}

/**
 * Dev-only: first load fails, retry probe succeeds — exercises real recovery path.
 * Requires localStorage.qc_card_art_diag === 'true'.
 * @param {string|HTMLImageElement} [selectorOrImg]
 * @returns {Promise<{ ok: boolean, reason?: string, url?: string, surface?: string }>}
 */
export async function simulateCardArtTransientFailure(selectorOrImg) {
  if (!_isCardArtDiagEnabled()) {
    console.warn('[CardArtDiag] Enable first: localStorage.setItem("qc_card_art_diag","true"); location.reload()');
    return { ok: false, reason: 'diag-off' };
  }

  const img = _resolveCardArtDiagTarget(selectorOrImg);
  if (!img) {
    return { ok: false, reason: 'no-target' };
  }

  const realSrc = (img.getAttribute('src') || img.currentSrc || '').trim();
  if (!realSrc || realSrc.includes('__card_art_diag_missing__')) {
    return { ok: false, reason: 'no-real-src' };
  }

  _cardArtDiagSimArm = { probeSucceed: true, zeroDelay: true };
  img.dataset.cardArtDiagSimRealSrc = realSrc;
  // Reset applied flag if somehow set; force a fresh error cycle.
  delete img.dataset.cardArtFallbackApplied;
  delete img.dataset.cardArtRetryAttempted;

  _cardArtDiag({
    event: 'simulate_armed',
    url: realSrc,
    surface: img.classList.contains('rp-mini-img') ? 'mini' : 'detail',
    card: img.dataset.cardArtName || null,
  });

  img.src = CARD_ART_DIAG_MISSING_SRC;

  return {
    ok: true,
    url: realSrc,
    surface: img.classList.contains('rp-mini-img') ? 'mini' : 'detail',
  };
}

function _installCardArtDiagApi() {
  if (typeof window === 'undefined') return;
  window.qcCardArtDiag = {
    isEnabled: () => _isCardArtDiagEnabled(),
    simulateTransientFailure: simulateCardArtTransientFailure,
    help() {
      console.info(`Card-art diag (DevTools)
Enable: localStorage.setItem('qc_card_art_diag','true'); location.reload()
Recovery proof (Collection art visible):
  await qcCardArtDiag.simulateTransientFailure()
Expect [CardArtDiag]: initial_failure → retry_attempted → retry_recovered
Optional: await qcCardArtDiag.simulateTransientFailure('.collection-grid img[data-card-art-fallback="1"]')`);
    },
  };
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

  _installCardArtDiagApi();
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
  const safeName = escapeCardArtAttr(card.name || '');

  return `<img src="${safeSrc}" alt="${safeAlt}" loading="lazy" decoding="async" data-card-art-fallback="1" data-fallback-emoji="${safeEmoji}" data-card-art-name="${safeName}">`;
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

  return `<img class="rp-mini-img" src="${safeSrc}" alt="${safeName}" loading="lazy" decoding="async" data-card-art-fallback="1" data-fallback-emoji="${safeEmoji}" data-card-art-name="${safeName}">`;
}
