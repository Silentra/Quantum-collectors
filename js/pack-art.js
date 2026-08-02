/**
 * pack-art.js — Static pack card-back resolution (local WebP → emoji fallback)
 *
 * Assets: assets/card-backs/{standard|premium|research}-pack.webp (600×840, 5:7).
 * No Firebase paths. Pack identity is derived from pack display name (opaque pack IDs).
 * Missing/failed images fall back silently to the existing emoji presentation.
 */

/** @typedef {'standard'|'premium'|'research'} PackArtKey */

const PACK_ART_FOLDER = 'assets/card-backs';

/** Fallback emoji — matches face-down CSS ::after and prior Packs-tab tile. */
export const PACK_ART_FALLBACK_EMOJI = '\uD83C\uDCB4';

/** Reveal face-down historically used atom via CSS ::after; keep for back chrome. */
export const PACK_BACK_FALLBACK_EMOJI = '\u269B\uFE0F';

const PACK_ART_FILES = {
  standard: 'standard-pack.webp',
  premium: 'premium-pack.webp',
  research: 'research-pack.webp',
};

/**
 * Escape a value for use inside an HTML attribute.
 * @param {string} value
 * @returns {string}
 */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Map pack record or display name to a canonical art key.
 * @param {object|string|null|undefined} packOrName - pack object with `.name`, or name string
 * @returns {PackArtKey|null}
 */
export function resolvePackArtKey(packOrName) {
  const name = typeof packOrName === 'string'
    ? packOrName
    : (packOrName && packOrName.name != null ? String(packOrName.name) : '');
  const n = name.trim().toLowerCase();
  if (!n) return null;

  if (n.includes('premium')) return 'premium';
  if (n.includes('research') || n.includes('scientist')) return 'research';
  if (n.includes('standard') || n.includes('basic')) return 'standard';
  return null;
}

/**
 * Relative URL for a known art key, or null.
 * @param {PackArtKey|null|undefined} key
 * @returns {string|null}
 */
export function getPackArtPath(key) {
  if (!key || !PACK_ART_FILES[key]) return null;
  return `${PACK_ART_FOLDER}/${PACK_ART_FILES[key]}`;
}

/**
 * @typedef {{ key: PackArtKey|null, src: string|null, fallbackEmoji: string }} ResolvedPackArt
 */

/**
 * Resolve pack back art for a pack object, name, or explicit key.
 * @param {object|string|null|undefined} packOrName
 * @param {{ packArtKey?: PackArtKey|null }} [options]
 * @returns {ResolvedPackArt}
 */
export function resolvePackArt(packOrName, options = {}) {
  const explicit = options.packArtKey;
  const key = (explicit === 'standard' || explicit === 'premium' || explicit === 'research')
    ? explicit
    : resolvePackArtKey(packOrName);
  return {
    key,
    src: getPackArtPath(key),
    fallbackEmoji: PACK_ART_FALLBACK_EMOJI,
  };
}

/**
 * Face-down reveal back inner HTML (optional img). Parent should add class `has-pack-art` when src is set.
 * alt="" — pack name is already in the overlay title.
 * @param {ResolvedPackArt} resolved
 * @returns {string}
 */
export function renderPackBackArtHtml(resolved) {
  if (!resolved?.src) return '';
  const safeSrc = escapeAttr(resolved.src);
  const safeEmoji = escapeAttr(PACK_BACK_FALLBACK_EMOJI);
  return `<img class="pack-card-back-art" src="${safeSrc}" alt="" decoding="async" data-pack-art-fallback="1" data-fallback-emoji="${safeEmoji}">`;
}

/**
 * Packs-tab tile art HTML. alt="" when the visible pack name sits beside/below the image.
 * @param {ResolvedPackArt} resolved
 * @returns {string}
 */
export function renderPackTileArtHtml(resolved) {
  const emoji = resolved?.fallbackEmoji || PACK_ART_FALLBACK_EMOJI;
  if (!resolved?.src) {
    return `<div class="pack-tile-art pack-tile-art--emoji" aria-hidden="true">${emoji}</div>`;
  }
  const safeSrc = escapeAttr(resolved.src);
  const safeEmoji = escapeAttr(emoji);
  return `<div class="pack-tile-art has-pack-art" aria-hidden="true"><img class="pack-tile-art-img" src="${safeSrc}" alt="" decoding="async" loading="lazy" data-pack-art-fallback="1" data-fallback-emoji="${safeEmoji}"></div>`;
}

/**
 * On failed pack-art img: remove image and restore emoji UI (no console noise).
 * @param {HTMLImageElement} img
 */
export function applyPackArtEmojiFallback(img) {
  if (!img || img.dataset.packArtFallbackApplied === '1') return;
  img.dataset.packArtFallbackApplied = '1';

  const emoji = img.dataset.fallbackEmoji || PACK_ART_FALLBACK_EMOJI;
  const back = img.closest('.pack-card-back');
  if (back) {
    back.classList.remove('has-pack-art');
    img.remove();
    return;
  }

  const tile = img.closest('.pack-tile-art');
  if (tile) {
    tile.classList.remove('has-pack-art');
    tile.classList.add('pack-tile-art--emoji');
    tile.textContent = emoji;
    tile.setAttribute('aria-hidden', 'true');
    return;
  }

  img.remove();
}

let packArtFallbackBound = false;

/** One-time delegated error handler for pack card-back images. */
export function initPackArtFallback() {
  if (packArtFallbackBound) return;
  packArtFallbackBound = true;

  document.addEventListener(
    'error',
    (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLImageElement)) return;
      if (target.dataset.packArtFallback !== '1') return;
      applyPackArtEmojiFallback(target);
    },
    true
  );
}
