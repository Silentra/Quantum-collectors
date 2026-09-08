/**
 * card-art-layout.js — Responsive shrinkwrap sizing for physical-style card fronts.
 * Measures artwork natural aspect and sizes the luminous art frame to hug the image.
 */

const ART_FILL_SCALE = 0.912;

/**
 * Size one .card-detail-art well so its shrink frame matches the image aspect.
 * @param {HTMLElement} artEl
 */
export function applyShrinkwrapToArtElement(artEl) {
  if (!artEl || !artEl.classList.contains('card-detail-art')) return;
  const img = artEl.querySelector('img.card-detail-art-img, img');
  if (!img) {
    artEl.removeAttribute('data-art-shrink');
    artEl.style.removeProperty('--card-art-w');
    artEl.style.removeProperty('--card-art-h');
    return;
  }

  const run = () => {
    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;
    const cellW = artEl.clientWidth;
    const cellH = artEl.clientHeight;
    if (cellW < 4 || cellH < 4) return;

    const ar = nw > 0 && nh > 0 ? nw / nh : 5 / 4;
    artEl.style.setProperty('--card-art-aspect', String(ar));

    const maxW = cellW * ART_FILL_SCALE;
    const maxH = cellH * ART_FILL_SCALE;
    let w = maxW;
    let h = w / ar;
    if (h > maxH) {
      h = maxH;
      w = h * ar;
    }
    artEl.style.setProperty('--card-art-w', `${Math.max(1, Math.round(w * 100) / 100)}px`);
    artEl.style.setProperty('--card-art-h', `${Math.max(1, Math.round(h * 100) / 100)}px`);
    artEl.dataset.artShrink = '1';
  };

  if (img.complete && (img.naturalWidth > 0 || img.getAttribute('src') === '')) {
    run();
  } else {
    // Optimistic 5:4 before load to limit CLS
    artEl.style.setProperty('--card-art-aspect', String(5 / 4));
    const cellW = artEl.clientWidth;
    const cellH = artEl.clientHeight;
    if (cellW >= 4 && cellH >= 4) {
      const ar = 5 / 4;
      const maxW = cellW * ART_FILL_SCALE;
      const maxH = cellH * ART_FILL_SCALE;
      let w = maxW;
      let h = w / ar;
      if (h > maxH) {
        h = maxH;
        w = h * ar;
      }
      artEl.style.setProperty('--card-art-w', `${Math.round(w * 100) / 100}px`);
      artEl.style.setProperty('--card-art-h', `${Math.round(h * 100) / 100}px`);
      artEl.dataset.artShrink = '1';
    }
    img.addEventListener('load', run, { once: true });
  }
}

/**
 * Apply shrinkwrap to all physical card faces under a root.
 * @param {ParentNode} [root=document]
 */
export function applyCardArtShrinkwrap(root = document) {
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('.card-detail-art').forEach((el) => applyShrinkwrapToArtElement(el));
}

let _ro = null;

/**
 * Observe card face stages for size changes (collection resize, modal open).
 * @param {ParentNode} [root=document]
 */
export function observeCardArtShrinkwrap(root = document) {
  applyCardArtShrinkwrap(root);
  if (typeof ResizeObserver === 'undefined') return;
  if (!_ro) {
    _ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const art = entry.target.classList?.contains('card-detail-art')
          ? entry.target
          : entry.target.querySelector?.('.card-detail-art');
        if (art) applyShrinkwrapToArtElement(art);
      }
    });
  }
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('.card-face-stage, .card-detail-art').forEach((el) => {
    try {
      _ro.observe(el);
    } catch {
      /* ignore */
    }
  });
}
