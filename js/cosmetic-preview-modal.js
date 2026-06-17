/**
 * Shop cosmetic preview modal — enlarged CSS-driven previews (shared slug doctrine).
 */

import { renderExpandedCosmeticPreview } from './cosmetic-preview.js';
import { ITEM_CATEGORIES, ITEM_TYPES } from './shop-definitions.js';

let escapeHandlerBound = false;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatLabel(value, fallback = 'Unknown') {
  if (!value || typeof value !== 'string') return fallback;
  return value
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getCategoryLabel(category) {
  if (category === ITEM_CATEGORIES.SHELL_BACKGROUND) return 'Background';
  if (category === ITEM_CATEGORIES.PROFILE_BANNER) return 'Banner';
  if (category === ITEM_CATEGORIES.TITLE) return 'Title';
  if (category === ITEM_CATEGORIES.BORDER) return 'Border';
  if (category === ITEM_CATEGORIES.SHIMMER) return 'Shimmer';
  if (category === ITEM_CATEGORIES.AURA) return 'Glow';
  return formatLabel(category);
}

export function closeCosmeticPreviewModal() {
  document.getElementById('cosmetic-preview-modal')?.classList.add('hidden');
}

/**
 * @param {object|null|undefined} item — shop item shape (id, name, description, type, category, rarity)
 */
export function openCosmeticPreviewModal(item, options = {}) {
  if (!item || item.type !== ITEM_TYPES.COSMETIC) return;

  const modal = document.getElementById('cosmetic-preview-modal');
  const titleEl = document.getElementById('cosmetic-preview-title');
  const metaEl = document.getElementById('cosmetic-preview-meta');
  const stageEl = document.getElementById('cosmetic-preview-stage');
  const descriptionEl = document.getElementById('cosmetic-preview-description');
  if (!modal || !titleEl || !metaEl || !stageEl || !descriptionEl) return;

  const previewHtml = renderExpandedCosmeticPreview(item, escapeHtml, options);
  if (!previewHtml) return;

  titleEl.textContent = item.name || item.id || 'Cosmetic';
  metaEl.textContent = `${formatLabel(item.rarity)} · ${getCategoryLabel(item.category)}`;
  descriptionEl.textContent = item.description || '';
  stageEl.innerHTML = previewHtml;

  modal.classList.remove('hidden');
}

/** Wire close button, backdrop click, and Escape (call once from ui.init). */
export function initCosmeticPreviewModal() {
  const modal = document.getElementById('cosmetic-preview-modal');
  const closeBtn = document.getElementById('btn-close-cosmetic-preview');
  if (!modal) return;

  const close = () => closeCosmeticPreviewModal();

  closeBtn?.addEventListener('click', close);

  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });

  if (!escapeHandlerBound) {
    escapeHandlerBound = true;
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (modal.classList.contains('hidden')) return;
      event.preventDefault();
      close();
    });
  }
}
