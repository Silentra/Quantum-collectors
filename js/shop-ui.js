/**
 * shop-ui.js — Shop rendering layer (UI only)
 *
 * This module is strictly rendering-only.
 * - Gameplay logic (purchases, rerolls, consumables) belongs in shop-mutations.js
 * - Weighted generation / pool building belongs in shop-generation.js
 * - Validation / exploit-prevention belongs in shop-validation.js
 * - Consumable behavior routing belongs in shop-consumables.js
 * - Admin config UI belongs in shop-admin.js
 *
 * renderShop()   — called when the shop tab becomes active
 * cleanupShop()  — called when the shop tab is deactivated (teardown listeners, intervals, etc.)
 */

import * as auth from './auth.js';
import * as cards from './cards.js';
import * as db from './database.js';
import * as player from './player.js';
import * as toast from './toast.js';
import { renderCollectionCard } from './card-render.js';
import { resolveBorderRenderEffectIdFromPlayer } from './card-border.js';
import { getEquippedShimmer } from './profile-ui.js';
import { openCardDetailModal } from './card-detail-modal.js';
import { openCosmeticPreviewModal } from './cosmetic-preview-modal.js';
import { buildShopCatalog, parseShopItemId } from './shop-catalog.js';
import { getShopConfig } from './shop-config.js';
import {
  getItemDefinition as getRegistryItemDefinition,
  getMergedItemDefinitions,
} from './cosmetic-definitions.js';
import { renderShopCosmeticPreview } from './cosmetic-preview.js';
import { ITEM_TYPES, resolveItemDisplay } from './shop-definitions.js';
import { getWeeklyRefreshLabel } from './weekly-research-pack.js';
import {
  ensureShopRotation,
  freezeShopSlot,
  purchaseShopItem,
  refreshShopRotation,
  rerollShopRotation,
  rerollShopSlot,
} from './shop-mutations.js';
import { useConsumable } from './shop-consumables.js';

const SHOP_CONSUMABLE_BEHAVIORS = Object.freeze(new Set([
  'reroll_shop',
  'apply_discount',
  'freeze_slot',
  'grant_research',
]));
const TARGET_BEHAVIORS = Object.freeze(new Set(['reroll_shop', 'apply_discount']));

let countdownIntervalId = null;
let targetMode = null;
let actionInFlight = false;

function getRoot() {
  return document.getElementById('shop-content');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeSlots(rawSlots) {
  if (Array.isArray(rawSlots)) return rawSlots;
  if (isObject(rawSlots)) return Object.values(rawSlots);
  return [];
}

function formatLabel(value, fallback = 'Unknown') {
  if (!value || typeof value !== 'string') return fallback;
  return value
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getItemDefinition(itemId) {
  return getRegistryItemDefinition(itemId)
    || buildShopCatalog(getShopConfig()).getItem(itemId);
}

function getSafeItem(slot) {
  const itemId = slot?.itemId || null;
  const definition = getItemDefinition(itemId);
  return {
    id: itemId || 'unknown_item',
    name: definition?.name || formatLabel(itemId, 'Unknown Item'),
    description: definition?.description || 'No description is available for this item.',
    type: definition?.type || 'unknown',
    category: definition?.category || 'unknown',
    rarity: definition?.rarity || 'common',
    behaviorType: definition?.behaviorType || null,
    definition,
  };
}

function getPlayerSnapshot(username) {
  return {
    shop: isObject(db.get(`players/${username}/shop`)) ? db.get(`players/${username}/shop`) : {},
    currencies: isObject(db.get(`players/${username}/currencies`)) ? db.get(`players/${username}/currencies`) : {},
    items: isObject(db.get(`players/${username}/items`)) ? db.get(`players/${username}/items`) : {},
    cosmetics: isObject(db.get(`players/${username}/cosmetics`)) ? db.get(`players/${username}/cosmetics`) : {},
    shopUsage: isObject(db.get(`players/${username}/shopUsage`)) ? db.get(`players/${username}/shopUsage`) : {},
  };
}

function getRotation(snapshot) {
  return isObject(snapshot?.shop?.currentRotation) ? snapshot.shop.currentRotation : null;
}

function getCurrentRp(snapshot) {
  const rp = Number(snapshot?.currencies?.currentResearchPoints || 0);
  return Number.isFinite(rp) ? rp : 0;
}

function getItemQuantity(snapshot, itemId) {
  const quantity = Number(snapshot?.items?.[itemId] || 0);
  return Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 0;
}

function isOwnedCosmetic(snapshot, itemId, item) {
  return item?.type === ITEM_TYPES.COSMETIC && snapshot?.cosmetics?.owned?.[itemId] === true;
}

function formatPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) return '0 RP';
  return `${Math.floor(price)} RP`;
}

function formatCountdown(refreshAt) {
  const target = Number(refreshAt || 0);
  if (!Number.isFinite(target) || target <= 0) return 'Refresh timing unavailable';
  const remaining = target - Date.now();
  if (remaining <= 0) return 'Weekly reset on next shop visit';
  const totalSeconds = Math.ceil(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function updateCountdownText(refreshAt) {
  const el = document.getElementById('shop-refresh-countdown');
  if (el) el.textContent = formatCountdown(refreshAt);
}

function startCountdown(refreshAt) {
  if (countdownIntervalId) clearInterval(countdownIntervalId);
  updateCountdownText(refreshAt);
  countdownIntervalId = setInterval(() => {
    updateCountdownText(refreshAt);
  }, 1000);
}

function stopCountdown() {
  if (countdownIntervalId) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }
}

function getReasonMessage(reason) {
  const messages = {
    already_discounted: 'This slot already has a discount.',
    already_frozen: 'This slot is already frozen.',
    card_not_owned: 'You do not own that card.',
    cosmetic_already_owned: 'You already own that cosmetic.',
    cosmetic_not_owned: 'You do not own that cosmetic.',
    insufficient_item_quantity: 'You do not have enough of that item.',
    insufficient_rp: 'You do not have enough Research Points.',
    invalid_slot: 'That shop slot is no longer valid.',
    no_eligible_replacement: 'No valid replacement is available right now.',
    no_eligible_slots: 'No valid slots are available for that action.',
    purchased_slot: 'Purchased slots cannot be changed.',
    slot_already_purchased: 'That slot has already been purchased.',
    slot_frozen: 'Frozen slots cannot be rerolled.',
    unsupported_behavior: 'That item cannot be used here.',
  };
  return messages[reason] || formatLabel(reason, 'Action failed.');
}

function showResult(result, successMessage) {
  if (result?.success) {
    toast.success(successMessage);
    return;
  }
  toast.error(getReasonMessage(result?.reason));
}

function renderPrice(slot) {
  const basePrice = Number(slot?.basePrice ?? slot?.currentPrice ?? 0);
  const currentPrice = Number(slot?.currentPrice ?? basePrice);
  const hasDiscount = slot?.discountApplied && Number.isFinite(basePrice) &&
    Number.isFinite(currentPrice) && currentPrice < basePrice;

  if (!hasDiscount) {
    return `<span class="shop-price-current">${escapeHtml(formatPrice(currentPrice))}</span>`;
  }

  return `
    <span class="shop-price-original">${escapeHtml(formatPrice(basePrice))}</span>
    <span class="shop-price-current shop-price-discounted">${escapeHtml(formatPrice(currentPrice))}</span>
  `;
}

function renderShopCardPreview(item) {
  if (item?.type !== ITEM_TYPES.CARD) return '';

  const parsed = parseShopItemId(item.id);
  if (!parsed || parsed.kind !== 'card') return '';

  const card = cards.getCard(parsed.sourceId);
  if (!card) return '';

  const session = auth.getSession();
  const borderRenderEffectId = session && session.username !== '__admin__'
    ? resolveBorderRenderEffectIdFromPlayer(player.getPlayer(session.username))
    : null;

  const cardHtml = renderCollectionCard(card, {
    quantity: 1,
    variant: 'collection',
    profileCosmeticAura: null,
    borderRenderEffectId,
  });

  const label = escapeHtml(card.name || parsed.sourceId);
  return `
    <button type="button"
      class="shop-preview-expand shop-preview-expand--card"
      data-shop-preview="card"
      data-card-id="${escapeHtml(parsed.sourceId)}"
      aria-label="View ${label} details">
      <div class="shop-card-preview-slot">${cardHtml}</div>
    </button>
  `;
}

function getPlayerCardFacePreviewContext() {
  const session = auth.getSession();
  if (!session || session.username === '__admin__') {
    return { borderRenderEffectId: null, equippedShimmerDefinition: null };
  }
  const playerData = player.getPlayer(session.username);
  return {
    borderRenderEffectId: resolveBorderRenderEffectIdFromPlayer(playerData),
    equippedShimmerDefinition: getEquippedShimmer(playerData)?.definition ?? null,
  };
}

function renderSlotPreview(item) {
  if (item?.type === ITEM_TYPES.COSMETIC) {
    return renderShopCosmeticPreview(item, escapeHtml, {
      playerContext: getPlayerCardFacePreviewContext(),
    });
  }
  if (item?.type === ITEM_TYPES.CARD) {
    return renderShopCardPreview(item);
  }
  return '';
}

function renderSlot(slot, index, snapshot) {
  const item = getSafeItem(slot);
  const purchased = slot?.purchased === true;
  const frozen = slot?.frozen === true;
  const discounted = Boolean(slot?.discountApplied);
  const ownedCosmetic = isOwnedCosmetic(snapshot, item.id, item);
  const previewHtml = renderSlotPreview(item);
  const isTargetable = targetMode && !purchased;
  const targetDisabled = !isTargetable || (targetMode?.behaviorType === 'reroll_shop' && frozen);
  const classes = [
    'shop-slot-card',
    `rarity-${escapeHtml(item.rarity)}`,
    purchased ? 'is-purchased' : '',
    frozen ? 'is-frozen' : '',
    discounted ? 'is-discounted' : '',
    isTargetable && !targetDisabled ? 'is-targetable' : '',
  ].filter(Boolean).join(' ');

  return `
    <article class="${classes}" data-slot-index="${index}">
      <div class="shop-slot-topline">
        <span class="shop-rarity-pill">${escapeHtml(formatLabel(item.rarity))}</span>
        <span class="shop-category-pill">${escapeHtml(formatLabel(item.category))}</span>
      </div>
      ${previewHtml}
      <div class="shop-slot-header">
        <div>
          <h3 class="shop-slot-title">${escapeHtml(item.name)}</h3>
          <div class="shop-slot-type">${escapeHtml(formatLabel(item.type))}</div>
        </div>
        <div class="shop-slot-icon" aria-hidden="true">${escapeHtml(getItemIcon(item))}</div>
      </div>
      <p class="shop-slot-description">${escapeHtml(item.description)}</p>
      <div class="shop-slot-badges">
        ${purchased ? '<span class="shop-state-badge shop-state-purchased">PURCHASED</span>' : ''}
        ${frozen ? '<span class="shop-state-badge shop-state-frozen">FROZEN</span>' : ''}
        ${discounted ? '<span class="shop-state-badge shop-state-discount">DISCOUNTED</span>' : ''}
        ${ownedCosmetic ? '<span class="shop-state-badge shop-state-owned">OWNED</span>' : ''}
      </div>
      <div class="shop-slot-price">${renderPrice(slot)}</div>
      ${targetMode ? renderTargetButton(index, targetDisabled) : renderSlotActions(index, { purchased, frozen, discounted, ownedCosmetic })}
    </article>
  `;
}

function getItemIcon(item) {
  const source = item?.definition || item;
  return resolveItemDisplay(source).emoji;
}

function getShopConsumables() {
  return Object.values(getMergedItemDefinitions())
    .filter(definition => definition?.type === ITEM_TYPES.CONSUMABLE)
    .filter(definition => SHOP_CONSUMABLE_BEHAVIORS.has(definition.behaviorType));
}

function renderTargetButton(index, disabled) {
  return `
    <div class="shop-slot-actions">
      <button class="shop-btn shop-btn-primary" data-shop-action="target-slot" data-slot-index="${index}" ${disabled ? 'disabled' : ''}>
        Target Slot
      </button>
    </div>
  `;
}

function renderSlotActions(index, state) {
  const locked = state.purchased;
  const canBuy = !locked && !state.ownedCosmetic;
  const canReroll = !locked && !state.frozen;
  const canFreeze = !locked && !state.frozen;

  return `
    <div class="shop-slot-actions">
      <button class="shop-btn shop-btn-primary" data-shop-action="buy" data-slot-index="${index}" ${canBuy ? '' : 'disabled'}>
        ${state.ownedCosmetic ? 'Owned' : 'Buy'}
      </button>
      <button class="shop-btn" data-shop-action="reroll-slot" data-slot-index="${index}" ${canReroll ? '' : 'disabled'}>
        Reroll
      </button>
      <button class="shop-btn" data-shop-action="freeze-slot" data-slot-index="${index}" ${canFreeze ? '' : 'disabled'}>
        Freeze
      </button>
    </div>
  `;
}

function renderConsumables(snapshot) {
  const rows = getShopConsumables().map(definition => {
    const itemId = definition.id;
    const quantity = getItemQuantity(snapshot, itemId);
    const disabled = quantity <= 0;
    const behaviorType = definition.behaviorType || 'unknown';
    const actionLabel = TARGET_BEHAVIORS.has(behaviorType) ? 'Target' : 'Use';
    const visual = resolveItemDisplay(definition);
    const iconClass = visual.cssClass ? ` ${escapeHtml(visual.cssClass)}` : '';
    const title = escapeHtml(definition.description || definition.name || itemId);
    return `
      <button class="shop-consumable${iconClass}" data-shop-action="use-consumable" data-item-id="${escapeHtml(itemId)}" title="${title}" ${disabled ? 'disabled' : ''}>
        <span class="shop-consumable-icon" aria-hidden="true">${escapeHtml(visual.emoji)}</span>
        <span class="shop-consumable-body">
          <span class="shop-consumable-name">${escapeHtml(definition.name || formatLabel(itemId))}</span>
          <span class="shop-consumable-meta">×${quantity}</span>
        </span>
        <span class="shop-consumable-action">${actionLabel}</span>
      </button>
    `;
  }).join('');

  if (!rows) {
    return `
      <aside class="shop-consumables-aside">
        <div class="shop-consumables-aside-header">
          <h3>Consumables</h3>
        </div>
        <p class="shop-consumables-empty">None owned</p>
      </aside>
    `;
  }

  return `
    <aside class="shop-consumables-aside">
      <div class="shop-consumables-aside-header">
        <h3>Consumables</h3>
        <span class="shop-consumables-aside-note">Use on slots</span>
      </div>
      <div class="shop-consumables-stack">${rows}</div>
    </aside>
  `;
}

function renderAdminToolbarActions(slots) {
  if (!auth.isAdmin()) return '';
  return `
      <button class="shop-btn" data-shop-action="reroll-rotation" ${slots.length ? '' : 'disabled'}>Reroll Rotation</button>
      <button class="shop-btn" data-shop-action="refresh-now">Refresh Now</button>
  `;
}

function renderTargetBanner() {
  if (!targetMode) return '';
  return `
    <div class="shop-target-banner">
      <div>
        <strong>Select a target slot</strong>
        <span>${escapeHtml(targetMode.label)} will be applied through the backend consumable router.</span>
      </div>
      <button class="shop-btn" data-shop-action="cancel-target">Cancel</button>
    </div>
  `;
}

function renderShopHtml(snapshot) {
  const rotation = getRotation(snapshot);
  const slots = normalizeSlots(rotation?.slots);
  const rp = getCurrentRp(snapshot);
  const generatedAt = Number(rotation?.generatedAt || 0);
  const generatedLabel = generatedAt > 0 ? new Date(generatedAt).toLocaleString() : 'Unknown';
  const weeklyLabel = getWeeklyRefreshLabel();

  return `
    <div class="shop-header">
      <div>
        <h2>Shop</h2>
        <p>Spend Research Points and use shop consumables. Resets weekly with your reward pack (${escapeHtml(weeklyLabel)}).</p>
      </div>
      <div class="shop-header-stats">
        <div class="shop-stat">
          <span>Research Points</span>
          <strong>${escapeHtml(rp)}</strong>
        </div>
        <div class="shop-stat">
          <span>Weekly Reset In</span>
          <strong id="shop-refresh-countdown">${escapeHtml(formatCountdown(rotation?.refreshAt))}</strong>
        </div>
      </div>
    </div>

    <div class="shop-layout">
      <div class="shop-layout-main">
        <div class="shop-toolbar">
          <div class="shop-toolbar-meta">
            <span>Generated: ${escapeHtml(generatedLabel)}</span>
            <span class="shop-toolbar-weekly">Resets ${escapeHtml(weeklyLabel)}</span>
          </div>
          ${auth.isAdmin() ? `<div class="shop-toolbar-actions shop-toolbar-actions--admin">${renderAdminToolbarActions(slots)}</div>` : ''}
        </div>

        ${renderTargetBanner()}

        <section class="shop-panel shop-panel--rotation">
          <div class="shop-panel-header">
        <h3>Current Rotation</h3>
        <span class="shop-panel-note">${slots.length} slots</span>
      </div>
      ${slots.length ? `<div class="shop-slot-grid">${slots.map((slot, index) => renderSlot(slot, index, snapshot)).join('')}</div>` : renderEmptyState()}
        </section>
      </div>

      ${renderConsumables(snapshot)}
    </div>
  `;
}

function renderEmptyState() {
  return `
    <div class="shop-empty-state">
      <div class="text-4xl mb-3">🛒</div>
      <p>No shop rotation is available yet.</p>
    </div>
  `;
}

function renderError(message) {
  stopCountdown();
  const root = getRoot();
  if (!root) return;
  root.innerHTML = `<div class="shop-empty-state"><p>${escapeHtml(message)}</p></div>`;
}

function handleShopPreviewClick(previewButton) {
  const kind = previewButton.dataset.shopPreview;
  if (kind === 'card') {
    const cardId = previewButton.dataset.cardId;
    if (cardId) openCardDetailModal(cardId);
    return;
  }

  if (kind === 'cosmetic') {
    const itemId = previewButton.dataset.cosmeticItemId;
    if (!itemId) return;
    const item = getSafeItem({ itemId });
    openCosmeticPreviewModal(item, {
      playerContext: getPlayerCardFacePreviewContext(),
    });
  }
}

function wireShopEvents(root, username) {
  root.onclick = async event => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const previewButton = target?.closest('[data-shop-preview]');
    if (previewButton) {
      event.preventDefault();
      event.stopPropagation();
      handleShopPreviewClick(previewButton);
      return;
    }

    const button = target?.closest('[data-shop-action]');
    if (!button || actionInFlight) return;
    const action = button.dataset.shopAction;
    const slotIndex = Number(button.dataset.slotIndex);
    const itemId = button.dataset.itemId;
    await handleShopAction(username, action, { slotIndex, itemId });
  };
}

async function handleShopAction(username, action, { slotIndex, itemId }) {
  actionInFlight = true;
  try {
    if (action === 'cancel-target') {
      targetMode = null;
      renderShop();
      return;
    }

    if (action === 'buy') {
      const confirmed = await confirmShopAction('Purchase this shop item?', 'Confirm Purchase');
      if (!confirmed) return;
      const result = purchaseShopItem(username, slotIndex);
      showResult(result, 'Purchase complete.');
      if (result.success) targetMode = null;
      renderShop();
      return;
    }

    if (action === 'reroll-slot') {
      const result = rerollShopSlot(username, slotIndex);
      showResult(result, 'Slot rerolled.');
      if (result.success) targetMode = null;
      renderShop();
      return;
    }

    if (action === 'reroll-rotation' || action === 'refresh-now') {
      if (!auth.isAdmin()) return;
    }

    if (action === 'reroll-rotation') {
      const confirmed = await confirmShopAction('Reroll every eligible shop slot using Research Points?', 'Reroll Rotation');
      if (!confirmed) return;
      const result = rerollShopRotation(username);
      showResult(result, 'Rotation rerolled.');
      if (result.success) targetMode = null;
      renderShop();
      return;
    }

    if (action === 'freeze-slot') {
      const result = freezeShopSlot(username, slotIndex);
      showResult(result, 'Slot frozen.');
      if (result.success) targetMode = null;
      renderShop();
      return;
    }

    if (action === 'use-consumable') {
      handleConsumableSelection(username, itemId);
      return;
    }

    if (action === 'target-slot') {
      if (!targetMode) return;
      const result = useConsumable(username, targetMode.itemId, { slotIndex });
      showResult(result, `${targetMode.label} used.`);
      if (result.success) targetMode = null;
      renderShop();
      return;
    }

    if (action === 'refresh-now') {
      const confirmed = await confirmShopAction('Force a shop refresh now? Frozen eligible slots may persist.', 'Refresh Shop');
      if (!confirmed) return;
      const result = refreshShopRotation(username);
      showResult(result, 'Shop refreshed.');
      if (result.success) targetMode = null;
      renderShop();
    }
  } finally {
    actionInFlight = false;
  }
}

function handleConsumableSelection(username, itemId) {
  const definition = getItemDefinition(itemId);
  if (!definition) {
    toast.error('Unknown consumable.');
    return;
  }

  if (TARGET_BEHAVIORS.has(definition.behaviorType)) {
    targetMode = {
      itemId,
      behaviorType: definition.behaviorType,
      label: definition.name || formatLabel(itemId),
    };
    renderShop();
    return;
  }

  const result = useConsumable(username, itemId, {});
  showResult(result, `${definition.name || 'Consumable'} used.`);
  if (result.success) targetMode = null;
  renderShop();
}

function confirmShopAction(message, title = 'Confirm Action') {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-title');
    const messageEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');

    if (!modal || !titleEl || !messageEl || !okBtn || !cancelBtn) {
      resolve(false);
      return;
    }

    titleEl.textContent = title;
    messageEl.textContent = message;
    modal.classList.remove('hidden');

    function cleanup(result) {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

/** Render the shop tab contents. */
export function renderShop() {
  const root = getRoot();
  if (!root) return;

  const session = auth.getSession();
  if (!session || session.username === '__admin__') {
    renderError('Shop is available to player accounts only.');
    return;
  }

  const ensureResult = ensureShopRotation(session.username);
  if (!ensureResult.success) {
    renderError(getReasonMessage(ensureResult.reason));
    return;
  }

  const snapshot = getPlayerSnapshot(session.username);
  root.innerHTML = renderShopHtml(snapshot);
  wireShopEvents(root, session.username);
  startCountdown(getRotation(snapshot)?.refreshAt);
}

/** Cleanup shop state when navigating away. */
export function cleanupShop() {
  stopCountdown();
  targetMode = null;
  actionInFlight = false;
  const root = getRoot();
  if (root) root.onclick = null;
}
