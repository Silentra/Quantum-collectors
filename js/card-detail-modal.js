/**
 * Card detail modal — shared open/close flow for Collection and Shop.
 */

import * as auth from './auth.js';
import * as cards from './cards.js';
import * as player from './player.js';
import { resolveBorderRenderEffectIdFromPlayer } from './card-border.js';
import { getEquippedShimmer } from './profile-ui.js';
import { renderCardDetailView } from './card-render.js';

/**
 * Open the global card detail modal (same content as Collection).
 * @param {string} cardId
 * @param {number} [quantity=1]
 */
export function openCardDetailModal(cardId, quantity = 1) {
  const card = cards.getCard(cardId);
  if (!card) return;

  let resolvedQty = quantity;
  const session = auth.getSession();
  if (resolvedQty <= 1) {
    if (session && session.username !== '__admin__') {
      const inv = player.getInventory(session.username);
      const entry = inv.find(i => i.cardId === cardId);
      if (entry) resolvedQty = entry.quantity;
    }
  }

  const modal = document.getElementById('card-detail-modal');
  const content = document.getElementById('card-detail-content');
  if (!modal || !content) return;

  let borderRenderEffectId = null;
  let equippedShimmerDefinition = null;
  if (session && session.username !== '__admin__') {
    const playerData = player.getPlayer(session.username);
    borderRenderEffectId = resolveBorderRenderEffectIdFromPlayer(playerData);
    equippedShimmerDefinition = getEquippedShimmer(playerData)?.definition ?? null;
  }

  content.innerHTML = renderCardDetailView(card, {
    quantity: resolvedQty,
    profileCosmeticAura: null,
    borderRenderEffectId,
    equippedShimmerDefinition,
  });
  modal.classList.remove('hidden');
}

export function closeCardDetailModal() {
  document.getElementById('card-detail-modal')?.classList.add('hidden');
}

/** Wire close button, backdrop click, and Escape (call once from ui.init). */
export function initCardDetailModal() {
  const modal = document.getElementById('card-detail-modal');
  const closeBtn = document.getElementById('btn-close-card-detail');
  if (!modal) return;

  const close = () => closeCardDetailModal();

  closeBtn?.addEventListener('click', close);

  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (modal.classList.contains('hidden')) return;
    event.preventDefault();
    close();
  });
}
