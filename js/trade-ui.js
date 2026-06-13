/**
 * Trade UI Module — Phase T-2 + T-4 + T-6 (UX Safeguards)
 *
 * Lightweight trading UI: player selection, card pickers, pending trade panels,
 * and anonymous trade listings.
 * Renders into #tab-trading content area.
 * All trade logic delegates to trading.js (lifecycle), trade-execution.js (swap),
 * trade-listings.js (listing lifecycle), and trade-listing-execution.js (listing swap).
 *
 * Phase T-6 additions:
 *   - Project-locked cards filtered from UI selectors
 *   - Last-copy warnings on card selectors and confirmation previews
 *   - Sandbox-safe confirmation modal before direct trade send/accept, listing create/accept
 *   - Error messages for OFFERED_CARD_LOCKED_BY_PROJECT / REQUESTED_CARD_LOCKED_BY_PROJECT
 */

import * as auth from './auth.js';
import * as player from './player.js';
import * as cards from './cards.js';
import * as db from './database.js';
import * as toast from './toast.js';
import {
  createTradeOffer,
  acceptTrade,
  declineTrade,
  cancelTrade,
  getPendingTrades,
} from './trading.js';
import {
  getDirectTradeCooldown,
  formatCooldown,
} from './trade-execution.js';
import {
  createListing,
  cancelListing,
  acceptListing,
  getVisibleListings,
  getMyActiveListing,
  getMyActiveListings,
  getMaxActiveListingsPerPlayer,
  getListingCooldown,
  expireStaleListings,
} from './trade-listings.js';
import {
  getListingAcceptCooldown,
} from './trade-listing-execution.js';
import {
  buildAvailabilitySnapshot,
  getAvailableCopyCount,
  canOfferCardInTrade,
  isLastAvailableCopy,
} from './trade-availability.js';
import { showTradeConfirmModal } from './trade-confirm-modal.js';

const TRADE_PROJECT_IN_USE_HINT =
  'Cards in use on research projects are not available.';

// ─── State ──────────────────────────────────────────────────────────────────

let _selectedTarget = null;   // username of selected trade partner
let _offeredCardId = null;    // card the current user is offering
let _requestedCardId = null;  // card the current user wants from target
let _cooldownTimer = null;    // interval for live cooldown display
let _activeSubTab = 'direct'; // 'direct' or 'listings'

/**
 * Shared filter/sort state for trading card selection views.
 * Scoped to the trading tab — reset on full renderTrading().
 * Keys:
 *   search      {string}  — case-insensitive partial name match
 *   type        {string}  — '' = all, else card.type value
 *   rarity      {string}  — '' = all, else card.rarity value
 *   dupeOnly    {boolean} — show only cards with quantity > 1
 *   sort        {string}  — 'default' | 'qty_desc' | 'qty_asc'
 */
const _tradeFilters = {
  search: '',
  type: '',
  rarity: '',
  dupeOnly: false,
  sort: 'default',
};

// ─── Filter / Sort Pipeline ──────────────────────────────────────────────────

const _RARITY_ORDER = { legendary: 0, epic: 1, rare: 2, uncommon: 3, common: 4 };

/**
 * Apply current _tradeFilters to a card list returned by _getTradableCards().
 * @param {Array<{card, quantity}>} list
 * @returns {Array<{card, quantity}>}  filtered + sorted subset
 */
function _applyTradeFilters(list) {
  let result = list;

  // 1. Name search (case-insensitive, partial) — local/personal only
  if (_tradeFilters.search.trim()) {
    const q = _tradeFilters.search.trim().toLowerCase();
    result = result.filter(({ card }) => card.name.toLowerCase().includes(q));
  }

  // 2. Type filter — shared
  if (_tradeFilters.type) {
    result = result.filter(({ card }) => (card.type || '') === _tradeFilters.type);
  }

  // 3. Rarity filter — shared
  if (_tradeFilters.rarity) {
    result = result.filter(({ card }) => (card.rarity || '') === _tradeFilters.rarity);
  }

  // 4. Duplicates-only toggle (qty > 1) — local/personal only
  if (_tradeFilters.dupeOnly) {
    result = result.filter(({ quantity }) => quantity > 1);
  }

  // 5. Sort
  if (_tradeFilters.sort === 'qty_desc') {
    result = [...result].sort((a, b) => b.quantity - a.quantity || a.card.name.localeCompare(b.card.name));
  } else if (_tradeFilters.sort === 'qty_asc') {
    result = [...result].sort((a, b) => a.quantity - b.quantity || a.card.name.localeCompare(b.card.name));
  }
  // 'default' → preserve existing rarity-then-name order from _getTradableCards

  return result;
}

/**
 * Apply only shared filters (type + rarity) to a card list.
 * Used for the trade partner's card pool — search and dupeOnly remain personal/local.
 * @param {Array<{card, quantity}>} list
 * @returns {Array<{card, quantity}>}
 */
function _applySharedTradeFilters(list) {
  let result = list;

  // Type filter — shared
  if (_tradeFilters.type) {
    result = result.filter(({ card }) => (card.type || '') === _tradeFilters.type);
  }

  // Rarity filter — shared
  if (_tradeFilters.rarity) {
    result = result.filter(({ card }) => (card.rarity || '') === _tradeFilters.rarity);
  }

  return result;
}

/**
 * Render the compact filter/sort bar for trading card pickers.
 * @param {string} prefix - DOM id prefix ('picker' | 'listing') to namespace controls
 * @param {Array<string>} availableTypes - distinct card types present in the full pool
 */
function _renderTradeFilterBar(prefix, availableTypes) {
  const typeOptions = ['', ...availableTypes].map(t =>
    `<option value="${t}" ${_tradeFilters.type === t ? 'selected' : ''}>${t === '' ? 'All Types' : (t.charAt(0).toUpperCase() + t.slice(1))}</option>`
  ).join('');

  const rarityOptions = [
    { value: '',          label: 'All Rarities' },
    { value: 'common',    label: 'Common' },
    { value: 'uncommon',  label: 'Uncommon' },
    { value: 'rare',      label: 'Rare' },
    { value: 'epic',      label: 'Epic' },
    { value: 'legendary', label: 'Legendary' },
  ].map(o => `<option value="${o.value}" ${_tradeFilters.rarity === o.value ? 'selected' : ''}>${o.label}</option>`).join('');

  const sortOptions = [
    { value: 'default',  label: 'Sort: Default' },
    { value: 'qty_desc', label: 'Sort: Most Owned' },
    { value: 'qty_asc',  label: 'Sort: Fewest Owned' },
  ].map(o => `<option value="${o.value}" ${_tradeFilters.sort === o.value ? 'selected' : ''}>${o.label}</option>`).join('');

  return `<div id="${prefix}-filter-bar" class="flex flex-wrap gap-1.5 mb-2 p-2 rounded-lg bg-surface-900 border border-surface-700">
    <input id="${prefix}-filter-search" type="text" placeholder="Search cards…"
      value="${_tradeFilters.search.replace(/"/g, '&quot;')}"
      class="flex-1 min-w-[120px] bg-surface-800 border border-surface-600 rounded px-2 py-1 text-xs text-white placeholder-surface-500 focus:outline-none focus:border-primary-500" />
    <select id="${prefix}-filter-type"
      class="bg-surface-800 border border-surface-600 rounded px-2 py-1 text-xs text-white">
      ${typeOptions}
    </select>
    <select id="${prefix}-filter-rarity"
      class="bg-surface-800 border border-surface-600 rounded px-2 py-1 text-xs text-white">
      ${rarityOptions}
    </select>
    <select id="${prefix}-filter-sort"
      class="bg-surface-800 border border-surface-600 rounded px-2 py-1 text-xs text-white">
      ${sortOptions}
    </select>
    <label class="flex items-center gap-1 text-xs text-surface-300 cursor-pointer select-none">
      <input id="${prefix}-filter-dupes" type="checkbox" class="rounded" ${_tradeFilters.dupeOnly ? 'checked' : ''} />
      Dupes only
    </label>
  </div>`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Render the full trading tab content.
 * Called by ui.js when the Trading tab is activated.
 */
export function renderTrading() {
  const container = document.getElementById('trading-content');
  if (!container) return;

  const session = auth.getSession();
  if (!session || session.username === '__admin__') {
    container.innerHTML = '<div class="text-center text-surface-500 py-8">Admin mode — trading not available.</div>';
    return;
  }

  const username = session.username;
  const me = player.getPlayer(username);
  if (!me) {
    container.innerHTML = '<div class="text-center text-surface-500 py-8">Player data not found.</div>';
    return;
  }

  if (me.isTradeRestricted) {
    container.innerHTML = '<div class="text-center text-red-400 py-8">Your trading privileges have been restricted by an administrator.</div>';
    return;
  }

  const myGroup = me.groupId || me.group || null;
  if (!myGroup) {
    container.innerHTML = '<div class="text-center text-surface-500 py-8">You must be in a group to trade. Contact your administrator.</div>';
    return;
  }

  // Expire stale listings on render
  expireStaleListings();

  // Reset reactive hashes so first reactive tick after render detects fresh state correctly
  _lastIncomingHash = '';
  _lastAvailableListingsHash = '';
  _lastMyListingsHash = '';
  _reactiveTickCounter = 0;
  _lastListingCooldownState = null; // T-8.6: reset so transition detection starts fresh

  // Reset trade filters on full tab render
  _tradeFilters.search = '';
  _tradeFilters.type = '';
  _tradeFilters.rarity = '';
  _tradeFilters.dupeOnly = false;
  _tradeFilters.sort = 'default';

  const isHidden = me.isTradeProfileHidden === true;

  let html = '';

  // Hide Trading Profile toggle
  html += `<div class="mb-4 p-3 rounded-lg bg-surface-800 border border-surface-700 flex items-center justify-between">
    <div>
      <div class="text-sm font-medium text-surface-200">Hide Trading Profile</div>
      <div class="text-xs text-surface-500">When ON, other players cannot search for you or send you trade requests.</div>
    </div>
    <div class="flex items-center gap-2">
      <span class="text-xs font-medium ${isHidden ? 'text-primary-400' : 'text-surface-500'}">${isHidden ? 'ON' : 'OFF'}</span>
      <button id="trade-hide-toggle" class="relative w-11 h-6 rounded-full transition-colors ${isHidden ? 'bg-primary-600' : 'bg-surface-600'}" aria-label="Toggle hide trading profile"
        style="min-width:2.75rem;">
        <span class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all" style="left:${isHidden ? '1.375rem' : '0.125rem'};"></span>
      </button>
    </div>
  </div>`;

  // Sub-tab navigation: Direct Trades | Trade Listings
  html += `<div class="flex gap-1 mb-4 bg-surface-800 rounded-lg p-1">
    <button class="trade-subtab-btn flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${_activeSubTab === 'direct' ? 'bg-primary-600 text-white' : 'text-surface-400 hover:text-white hover:bg-surface-700'}" data-subtab="direct">
      🤝 Direct Trades
    </button>
    <button class="trade-subtab-btn flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${_activeSubTab === 'listings' ? 'bg-primary-600 text-white' : 'text-surface-400 hover:text-white hover:bg-surface-700'}" data-subtab="listings">
      📋 Trade Listings
    </button>
  </div>`;

  // Sub-tab content areas
  html += `<div id="trade-subtab-direct" class="${_activeSubTab === 'direct' ? '' : 'hidden'}">`;
  html += _renderDirectTradesContent(username, myGroup);
  html += `</div>`;

  html += `<div id="trade-subtab-listings" class="${_activeSubTab === 'listings' ? '' : 'hidden'}">`;
  html += _renderListingsContent(username, myGroup);
  html += `</div>`;

  container.innerHTML = html;
  _wireTradeEvents(username);
  _wireListingEvents(username);
  _startCooldownTimer(username);
}

/**
 * Clean up timers when leaving the tab.
 */
export function cleanupTrading() {
  if (_cooldownTimer) {
    clearInterval(_cooldownTimer);
    _cooldownTimer = null;
  }
}

// ─── Availability helpers (UI) ──────────────────────────────────────────────

/**
 * Build a confirmation summary string for trade confirmations.
 * Includes card names, rarities, and last-copy warnings.
 */
function _buildConfirmSummary(giveCardId, receiveCardId, giveIsLastCopy, receiveLabel) {
  const giveCard = cards.getCard(giveCardId);
  const receiveCard = receiveCardId ? cards.getCard(receiveCardId) : null;

  let msg = 'Confirm Trade\n\n';
  msg += `You give: ${giveCard ? giveCard.name : giveCardId}`;
  if (giveCard) msg += ` [${giveCard.rarity}]`;
  if (giveIsLastCopy) msg += ' ⚠️ LAST COPY';
  msg += '\n';

  if (receiveCard) {
    msg += `You get: ${receiveCard.name}`;
    msg += ` [${receiveCard.rarity}]`;
  } else if (receiveLabel) {
    msg += `You get: ${receiveLabel}`;
  }
  msg += '\n\nProceed?';
  return msg;
}

// ─── Direct Trades Content ──────────────────────────────────────────────────

function _renderDirectTradesContent(username, myGroup) {
  const { incoming, outgoing } = getPendingTrades(username);
  const cooldown = getDirectTradeCooldown(username);

  let html = '';

  // Cooldown banner
  html += `<div id="trade-cooldown-banner" class="${cooldown.onCooldown ? '' : 'hidden'} mb-4 p-3 rounded-lg bg-amber-900/30 border border-amber-700 text-amber-300 text-sm text-center">
    Trade cooldown active: <span id="trade-cooldown-timer">${formatCooldown(cooldown.remainingMs)}</span>
  </div>`;

  // Incoming trades
  html += `<div class="mb-6" data-section="incoming-trades">
    <h3 class="text-lg font-semibold mb-3 flex items-center gap-2">
      📥 Incoming Trades
      ${incoming.length > 0 ? `<span class="bg-primary-600 text-white text-xs px-2 py-0.5 rounded-full">${incoming.length}</span>` : ''}
    </h3>
    ${incoming.length === 0
      ? '<p class="text-surface-500 text-sm">No incoming trade requests.</p>'
      : incoming.map(t => _renderIncomingTrade(t, username)).join('')}
  </div>`;

  // Outgoing trades
  html += `<div class="mb-6">
    <h3 class="text-lg font-semibold mb-3">📤 Outgoing Trades</h3>
    ${outgoing.length === 0
      ? '<p class="text-surface-500 text-sm">No outgoing trade requests.</p>'
      : outgoing.map(t => _renderOutgoingTrade(t)).join('')}
  </div>`;

  // New Trade section
  html += `<div class="border-t border-surface-700 pt-6">
    <h3 class="text-lg font-semibold mb-3">🤝 Send a Trade</h3>
    <div id="trade-new-section">
      ${_renderPlayerPicker(username, myGroup)}
    </div>
  </div>`;

  return html;
}

// ─── Listings Content ───────────────────────────────────────���───────────────

function _renderListingsContent(username, myGroup) {
  const ownedListings = getMyActiveListings(username);
  const maxListings = getMaxActiveListingsPerPlayer();
  const visibleListings = getVisibleListings(username);
  const listingCooldown = getListingCooldown(username);

  let html = '';

  // Listing posting cooldown banner
  html += `<div id="listing-cooldown-banner" class="${listingCooldown.onCooldown ? '' : 'hidden'} mb-4 p-3 rounded-lg bg-amber-900/30 border border-amber-700 text-amber-300 text-sm text-center">
    Listing cooldown active: <span id="listing-cooldown-timer">${formatCooldown(listingCooldown.remainingMs)}</span>
  </div>`;

  // Listing accept cooldown banner
  const listingAcceptCd = getListingAcceptCooldown(username);
  html += `<div id="listing-accept-cooldown-banner" class="${listingAcceptCd.onCooldown ? '' : 'hidden'} mb-4 p-3 rounded-lg bg-orange-900/30 border border-orange-700 text-orange-300 text-sm text-center">
    Listing accept cooldown active: <span id="listing-accept-cooldown-timer">${formatCooldown(listingAcceptCd.remainingMs)}</span>
  </div>`;

  // My Active Listings
  html += `<div id="my-listings-section" class="mb-6">
    <h3 class="text-lg font-semibold mb-3 flex items-center gap-2">
      📌 My Listings
      <span class="text-sm font-normal text-surface-400">(${ownedListings.length}/${maxListings})</span>
    </h3>`;

  if (ownedListings.length > 0) {
    html += ownedListings.map(l => _renderMyListing(l)).join('');
  } else {
    html += `<p class="text-surface-500 text-sm mb-3">You have no active listings.</p>`;
  }

  // Only show create form if below max
  if (ownedListings.length < maxListings) {
    html += _renderCreateListingForm(username);
  } else {
    html += `<p class="text-amber-400 text-sm mt-2">You've reached the maximum of ${maxListings} active listing${maxListings !== 1 ? 's' : ''}. Cancel one to post a new listing.</p>`;
  }

  html += `</div>`;

  // Available Listings (from other players in group)
  const otherListings = visibleListings.filter(l => l.ownerId !== username);

  html += `<div id="available-listings-section" class="border-t border-surface-700 pt-6">
    <h3 class="text-lg font-semibold mb-3 flex items-center gap-2">
      🏪 Available Listings
      ${otherListings.length > 0 ? `<span class="bg-primary-600 text-white text-xs px-2 py-0.5 rounded-full">${otherListings.length}</span>` : ''}
    </h3>`;

  if (otherListings.length === 0) {
    html += '<p class="text-surface-500 text-sm">No listings available in your group right now.</p>';
  } else {
    html += otherListings.map(l => _renderAvailableListing(l, username)).join('');
  }

  html += `</div>`;

  return html;
}

function _renderMyListing(listing) {
  const offeredCard = cards.getCard(listing.offeredCardId);
  const offeredName = offeredCard ? offeredCard.name : listing.offeredCardId;
  const offeredRarity = offeredCard ? offeredCard.rarity : 'common';
  const requestedNames = (listing.requestedCardIds || []).map(id => {
    const c = cards.getCard(id);
    return c ? c.name : id;
  });
  const timeLeft = _formatTimeLeft(listing.expiresAt);

  return `<div class="bg-surface-800 rounded-lg p-4 mb-2 border border-primary-700/50">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs text-primary-400 font-medium">YOUR ACTIVE LISTING</span>
      <span class="text-xs text-surface-500">Expires: ${timeLeft}</span>
    </div>
    <div class="flex items-center gap-3 mb-3">
      <div class="flex-1 text-center p-2 rounded bg-surface-900 border border-surface-600">
        <div class="text-xs text-surface-500 mb-1">You offer</div>
        <div class="font-semibold text-sm rarity-text-${offeredRarity}">${offeredName}</div>
        <div class="text-xs text-surface-500 capitalize">${offeredRarity}</div>
      </div>
      <div class="text-surface-500 text-lg">⇄</div>
      <div class="flex-1 text-center p-2 rounded bg-surface-900 border border-surface-600">
        <div class="text-xs text-surface-500 mb-1">You want (any one)</div>
        ${requestedNames.map(n => `<div class="font-semibold text-sm rarity-text-${offeredRarity}">${n}</div>`).join('')}
      </div>
    </div>
    <button class="listing-cancel-btn w-full bg-surface-700 hover:bg-surface-600 text-surface-300 text-sm py-2 rounded-lg transition-colors"
      data-listing-id="${listing.id}">Cancel Listing</button>
  </div>`;
}

function _renderCreateListingForm(username) {
  const cooldown = getListingCooldown(username);
  if (cooldown.onCooldown) {
    return `<p class="text-amber-400 text-sm">You're on listing cooldown. Please wait before creating a new listing.</p>`;
  }

  const myInv = player.getInventory(username);
  const mySnapshot = buildAvailabilitySnapshot(username);
  const myCardsAll = _getTradableCards(myInv, mySnapshot);

  if (myCardsAll.length === 0) {
    return '<p class="text-surface-500 text-sm">You have no tradable cards to list.</p>';
  }

  // Collect available types for filter bar
  const listingTypes = [...new Set(myCardsAll.map(({ card }) => card.type || '').filter(Boolean))].sort();

  // Apply filters to listing card pool
  const myCards = _applyTradeFilters(myCardsAll);

  return `<div class="bg-surface-800 rounded-lg p-4 border border-surface-700">
    <div class="text-sm font-medium text-surface-200 mb-3">Create a Listing</div>
    ${_renderTradeFilterBar('listing', listingTypes)}
    <div class="listing-filter-count text-xs text-surface-500 mb-2">${myCards.length} of ${myCardsAll.length} card${myCardsAll.length !== 1 ? 's' : ''} shown</div>
    <div class="mb-3">
      <label class="text-sm text-surface-400 block mb-1">Card you want to offer</label>
      <p class="trade-availability-hint text-xs text-surface-500 mt-0.5 mb-1">${TRADE_PROJECT_IN_USE_HINT}</p>
      <select id="listing-offered-card" class="w-full bg-surface-900 border border-surface-600 rounded-lg px-3 py-2 text-sm text-white">
        <option value="">— Select a card —</option>
        ${_buildCardOptions(myCards, mySnapshot)}
      </select>
    </div>
    <div id="listing-requested-section" class="hidden">
      <label class="text-sm text-surface-400 block mb-1">Cards you'll accept (pick 1–3 of same rarity)</label>
      <div id="listing-requested-checkboxes" class="max-h-48 overflow-y-auto rounded-lg bg-surface-900 border border-surface-600 p-2 space-y-1"></div>
      <div id="listing-requested-count" class="text-xs text-surface-500 mt-1">0 / 3 selected</div>
    </div>
    <div id="listing-rarity-info" class="hidden mt-2 p-2 rounded bg-blue-900/30 border border-blue-700 text-blue-300 text-xs"></div>
    <div id="listing-error" class="hidden mt-2 p-2 rounded bg-red-900/30 border border-red-700 text-red-300 text-xs"></div>
    <button id="listing-create-btn" class="hidden mt-3 w-full bg-primary-600 hover:bg-primary-700 text-white py-2.5 rounded-lg font-semibold transition-colors">
      Post Listing
    </button>
  </div>`;
}

function _renderAvailableListing(listing, myUsername) {
  const offeredCard = cards.getCard(listing.offeredCardId);
  const offeredName = offeredCard ? offeredCard.name : listing.offeredCardId;
  const offeredRarity = offeredCard ? offeredCard.rarity : 'common';
  const requestedIds = listing.requestedCardIds || [];
  const timeLeft = _formatTimeLeft(listing.expiresAt);
  const acceptCd = getListingAcceptCooldown(myUsername);

  const mySnapshot = buildAvailabilitySnapshot(myUsername);

  const canFulfillWith = requestedIds.filter(id => canOfferCardInTrade(mySnapshot, id));

  const requestedCards = requestedIds.map(id => {
    const c = cards.getCard(id);
    const owns = (mySnapshot.inventory[id] || 0) >= 1;
    const locked = !canOfferCardInTrade(mySnapshot, id);
    return {
      id,
      name: c ? c.name : id,
      rarity: c ? c.rarity : 'common',
      owns,
      locked,
    };
  });

  return `<div class="bg-surface-800 rounded-lg p-4 mb-2 border border-surface-700">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs text-surface-500">Anonymous Listing</span>
      <span class="text-xs text-surface-500">Expires: ${timeLeft}</span>
    </div>
    <div class="flex items-center gap-3 mb-3">
      <div class="flex-1 text-center p-2 rounded bg-surface-900 border border-surface-600">
        <div class="text-xs text-surface-500 mb-1">They offer</div>
        <div class="font-semibold text-sm rarity-text-${offeredRarity}">${offeredName}</div>
        <div class="text-xs text-surface-500 capitalize">${offeredRarity}</div>
      </div>
      <div class="text-surface-500 text-lg">⇄</div>
      <div class="flex-1 text-center p-2 rounded bg-surface-900 border border-surface-600">
        <div class="text-xs text-surface-500 mb-1">They want (any one)</div>
        ${requestedCards.map(rc => {
          let extra = '';
          if (rc.locked && rc.owns) extra = ' <span class="trade-locked-badge">IN USE</span>';
          else if (rc.owns) extra = ' ✓';
          const cls = rc.owns && !rc.locked
            ? 'rarity-text-' + rc.rarity + ' font-semibold'
            : 'text-surface-500' + (rc.owns ? '' : ' line-through');
          return `<div class="text-sm ${cls}">${rc.name}${extra}</div>`;
        }).join('')}
      </div>
    </div>
    ${canFulfillWith.length > 0
      ? `<div class="flex gap-2 flex-wrap">
          ${canFulfillWith.map(cardId => {
            const c = cards.getCard(cardId);
            const cName = c ? c.name : cardId;
            const isLast = isLastAvailableCopy(mySnapshot, cardId);
            const lastLabel = isLast ? ' ⚠️' : '';
            return acceptCd.onCooldown
              ? `<button class="flex-1 bg-surface-600 text-surface-400 text-sm py-2 px-3 rounded-lg cursor-not-allowed opacity-60" disabled
                  title="Listing accept cooldown active">Trade: Give ${cName}${lastLabel}</button>`
              : `<button class="listing-accept-btn flex-1 bg-green-600 hover:bg-green-700 text-white text-sm py-2 px-3 rounded-lg transition-colors"
                  data-listing-id="${listing.id}" data-chosen-card="${cardId}"
                  data-offered-name="${offeredName}" data-offered-rarity="${offeredRarity}"
                  data-chosen-name="${cName}" data-chosen-rarity="${c ? c.rarity : 'common'}"
                  data-is-last="${isLast}">Trade: Give ${cName}${lastLabel}</button>`;
          }).join('')}
        </div>`
      : '<p class="text-surface-500 text-xs text-center">You don\'t own any eligible requested cards.</p>'}
  </div>`;
}

// ─── Direct Trade Render Helpers ────────────────────────────────────────────

function _renderIncomingTrade(trade, myUsername) {
  const offeredCard = cards.getCard(trade.offeredCardId);
  const requestedCard = cards.getCard(trade.requestedCardId);
  const offeredName = offeredCard ? offeredCard.name : trade.offeredCardId;
  const requestedName = requestedCard ? requestedCard.name : trade.requestedCardId;
  const offeredRarity = offeredCard ? offeredCard.rarity : 'common';
  const requestedRarity = requestedCard ? requestedCard.rarity : 'common';
  const ago = _timeAgo(trade.createdAt);

  const acceptSnapshot = buildAvailabilitySnapshot(myUsername, {
    excludeDirectTradeIds: trade.id ? [trade.id] : [],
  });
  const isLast = isLastAvailableCopy(acceptSnapshot, trade.requestedCardId);
  const lastCopyHtml = isLast ? '<span class="trade-last-copy-warn">LAST COPY</span>' : '';

  return `<div class="bg-surface-800 rounded-lg p-4 mb-2 border border-surface-700">
    <div class="flex items-center justify-between mb-2">
      <span class="text-sm text-surface-400">From: <strong class="text-white">${trade.offeringPlayerId}</strong></span>
      <span class="text-xs text-surface-500">${ago}</span>
    </div>
    <div class="flex items-center gap-3 mb-3">
      <div class="flex-1 text-center p-2 rounded bg-surface-900 border border-surface-600">
        <div class="text-xs text-surface-500 mb-1">They offer</div>
        <div class="font-semibold text-sm rarity-text-${offeredRarity}">${offeredName}</div>
        <div class="text-xs text-surface-500 capitalize">${offeredRarity}</div>
      </div>
      <div class="text-surface-500 text-lg">⇄</div>
      <div class="flex-1 text-center p-2 rounded bg-surface-900 border border-surface-600">
        <div class="text-xs text-surface-500 mb-1">They want</div>
        <div class="font-semibold text-sm rarity-text-${requestedRarity}">${requestedName} ${lastCopyHtml}</div>
        <div class="text-xs text-surface-500 capitalize">${requestedRarity}</div>
      </div>
    </div>
    <div class="flex gap-2">
      <button class="trade-accept-btn flex-1 bg-green-600 hover:bg-green-700 text-white text-sm py-2 rounded-lg transition-colors"
        data-trade-id="${trade.id}"
        data-give-name="${requestedName}" data-give-rarity="${requestedRarity}"
        data-get-name="${offeredName}" data-get-rarity="${offeredRarity}"
        data-is-last="${isLast}">✓ Accept</button>
      <button class="trade-decline-btn flex-1 bg-red-600/30 hover:bg-red-600/50 text-red-300 text-sm py-2 rounded-lg border border-red-700 transition-colors"
        data-trade-id="${trade.id}">✕ Decline</button>
    </div>
  </div>`;
}

function _renderOutgoingTrade(trade) {
  const offeredCard = cards.getCard(trade.offeredCardId);
  const requestedCard = cards.getCard(trade.requestedCardId);
  const offeredName = offeredCard ? offeredCard.name : trade.offeredCardId;
  const requestedName = requestedCard ? requestedCard.name : trade.requestedCardId;
  const offeredRarity = offeredCard ? offeredCard.rarity : 'common';
  const requestedRarity = requestedCard ? requestedCard.rarity : 'common';
  const ago = _timeAgo(trade.createdAt);

  return `<div class="bg-surface-800 rounded-lg p-4 mb-2 border border-surface-700">
    <div class="flex items-center justify-between mb-2">
      <span class="text-sm text-surface-400">To: <strong class="text-white">${trade.targetPlayerId}</strong></span>
      <span class="text-xs text-surface-500">${ago}</span>
    </div>
    <div class="flex items-center gap-3 mb-3">
      <div class="flex-1 text-center p-2 rounded bg-surface-900 border border-surface-600">
        <div class="text-xs text-surface-500 mb-1">You offer</div>
        <div class="font-semibold text-sm rarity-text-${offeredRarity}">${offeredName}</div>
        <div class="text-xs text-surface-500 capitalize">${offeredRarity}</div>
      </div>
      <div class="text-surface-500 text-lg">⇄</div>
      <div class="flex-1 text-center p-2 rounded bg-surface-900 border border-surface-600">
        <div class="text-xs text-surface-500 mb-1">You want</div>
        <div class="font-semibold text-sm rarity-text-${requestedRarity}">${requestedName}</div>
        <div class="text-xs text-surface-500 capitalize">${requestedRarity}</div>
      </div>
    </div>
    <button class="trade-cancel-btn w-full bg-surface-700 hover:bg-surface-600 text-surface-300 text-sm py-2 rounded-lg transition-colors"
      data-trade-id="${trade.id}">Cancel Trade</button>
  </div>`;
}

function _renderPlayerPicker(username, myGroup) {
  // Get all players in the same group
  const allPlayers = player.getAllPlayers();
  const groupPlayers = allPlayers
    .filter(({ key, value }) =>
      key !== username &&
      key !== '__admin__' &&
      (value.groupId || value.group) === myGroup &&
      !value.isTradeRestricted &&
      !value.isTradeProfileHidden
    )
    .sort((a, b) => a.key.localeCompare(b.key));

  if (groupPlayers.length === 0) {
    return '<p class="text-surface-500 text-sm">No other players in your group to trade with.</p>';
  }

  return `<div class="mb-4">
    <label class="text-sm text-surface-400 block mb-1">Select a player</label>
    <select id="trade-target-select" class="w-full bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm text-white">
      <option value="">— Choose a player —</option>
      ${groupPlayers.map(({ key }) => `<option value="${key}">${key}</option>`).join('')}
    </select>
  </div>
  <div id="trade-card-pickers" class="hidden"></div>`;
}

function _renderCardPickers(username, targetUsername) {
  const myInv = player.getInventory(username);
  const targetInv = player.getInventory(targetUsername);

  const mySnapshot = buildAvailabilitySnapshot(username);
  const targetSnapshot = buildAvailabilitySnapshot(targetUsername);

  const myCardsAll = _getTradableCards(myInv, mySnapshot);
  const targetCardsAll = _getTradableCards(targetInv, targetSnapshot);

  if (myCardsAll.length === 0) {
    return '<p class="text-surface-500 text-sm mt-3">You have no tradable cards.</p>';
  }
  if (targetCardsAll.length === 0) {
    return `<p class="text-surface-500 text-sm mt-3">${targetUsername} has no tradable cards.</p>`;
  }

  // Collect available card types across both pools for the filter bar
  const allTypes = [...new Set([...myCardsAll, ...targetCardsAll].map(({ card }) => card.type || '').filter(Boolean))].sort();

  // Apply full filters (including search + dupeOnly) to my cards — personal/local
  const myCards = _applyTradeFilters(myCardsAll);
  // Apply only shared filters (type + rarity) to target's cards — no personal search/dupeOnly
  const targetCards = _applySharedTradeFilters(targetCardsAll);

  return `
    ${_renderTradeFilterBar('picker', allTypes)}
    <div id="picker-filter-result-count" class="text-xs text-surface-500 mb-2">
      ${myCards.length} of ${myCardsAll.length} card${myCardsAll.length !== 1 ? 's' : ''} shown (you) · ${targetCards.length} of ${targetCardsAll.length} shown (${targetUsername})
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-1">
      <div>
        <label class="text-sm text-surface-400 block mb-1">Card you offer</label>
        <p class="trade-availability-hint text-xs text-surface-500 mt-0.5 mb-1">${TRADE_PROJECT_IN_USE_HINT}</p>
        <select id="trade-offered-card" class="w-full bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm text-white">
          <option value="">— Select a card —</option>
          ${_buildCardOptions(myCards, mySnapshot)}
        </select>
      </div>
      <div>
        <label class="text-sm text-surface-400 block mb-1">Card you want from ${targetUsername}</label>
        <select id="trade-requested-card" class="w-full bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm text-white">
          <option value="">— Select a card —</option>
          ${_buildCardOptions(targetCards, targetSnapshot)}
        </select>
      </div>
    </div>
    <div id="trade-rarity-warning" class="hidden mt-2 p-2 rounded bg-red-900/30 border border-red-700 text-red-300 text-xs"></div>
    <div id="trade-confirm-section" class="hidden mt-4">
      <div id="trade-confirm-preview" class="bg-surface-900 rounded-lg p-4 border border-surface-700 mb-3"></div>
      <button id="trade-send-btn" class="w-full bg-primary-600 hover:bg-primary-700 text-white py-2.5 rounded-lg font-semibold transition-colors">
        Send Trade Request
      </button>
    </div>`;
}

/**
 * Get tradable cards with copy-aware available quantities.
 * @param {Array} inventory - [{cardId, quantity}]
 * @param {import('./trade-availability.js').AvailabilitySnapshot} snapshot
 */
function _getTradableCards(inventory, snapshot) {
  const result = [];
  for (const { cardId, quantity } of inventory) {
    if (quantity < 1) continue;
    const card = cards.getCard(cardId);
    if (!card || card.enabled === false) continue;
    if (card.tradable === false) continue;
    const available = getAvailableCopyCount(snapshot, cardId);
    if (available < 1) continue;
    result.push({ card, quantity: available });
  }
  // Sort by rarity (legendary first) then alphabetical by name
  result.sort((a, b) => {
    const rd = (cards.RARITY_ORDER[a.card.rarity] ?? 5) - (cards.RARITY_ORDER[b.card.rarity] ?? 5);
    if (rd !== 0) return rd;
    return a.card.name.localeCompare(b.card.name);
  });
  return result;
}

/**
 * Build <option> tags for card selectors (available copy counts).
 * @param {Array} cardList - [{card, quantity}] quantity = available copies
 * @param {import('./trade-availability.js').AvailabilitySnapshot} [snapshot]
 */
function _buildCardOptions(cardList, snapshot) {
  return cardList.map(({ card, quantity }) => {
    const qty = quantity > 1 ? ` (x${quantity})` : '';
    const rarity = card.rarity ? ` [${card.rarity}]` : '';
    const lastCopy = snapshot && isLastAvailableCopy(snapshot, card.id) ? ' ⚠️ LAST' : '';
    return `<option value="${card.id}" data-rarity="${card.rarity}">${card.name}${rarity}${qty}${lastCopy}</option>`;
  }).join('');
}

// ─── Event Wiring ───────────────────────────────────────────────────────────

function _wireTradeEvents(username) {
  // Hide Trading Profile toggle
  const hideToggle = document.getElementById('trade-hide-toggle');
  if (hideToggle) {
    hideToggle.addEventListener('click', () => {
      const current = db.get(`players/${username}/isTradeProfileHidden`) === true;
      db.set(`players/${username}/isTradeProfileHidden`, !current);
      console.log(`[Trading] ${username} set isTradeProfileHidden = ${!current}`);
      toast.info(!current ? 'Trading profile hidden.' : 'Trading profile visible.');
      renderTrading(); // Re-render to reflect new state
    });
  }

  // Sub-tab navigation
  document.querySelectorAll('.trade-subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeSubTab = btn.dataset.subtab;
      renderTrading();
    });
  });

  // Player picker
  const targetSelect = document.getElementById('trade-target-select');
  if (targetSelect) {
    targetSelect.addEventListener('change', () => {
      _selectedTarget = targetSelect.value || null;
      const pickerArea = document.getElementById('trade-card-pickers');
      if (pickerArea) {
        if (_selectedTarget) {
          pickerArea.innerHTML = _renderCardPickers(username, _selectedTarget);
          pickerArea.classList.remove('hidden');
          _wirePickerFilterEvents(username);
          _wireCardSelectionEvents(username);
        } else {
          pickerArea.innerHTML = '';
          pickerArea.classList.add('hidden');
        }
      }
    });
  }

  // Accept buttons — T-6: Confirmation step before accepting
  document.querySelectorAll('.trade-accept-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tradeId = btn.dataset.tradeId;
      const giveName = btn.dataset.giveName || '?';
      const giveRarity = btn.dataset.giveRarity || '';
      const getName = btn.dataset.getName || '?';
      const getRarity = btn.dataset.getRarity || '';
      const isLast = btn.dataset.isLast === 'true';

      // T-6: Sandbox-safe confirmation modal
      let msg = `You give: ${giveName} [${giveRarity}]`;
      msg += `\nYou get: ${getName} [${getRarity}]`;

      const confirmed = await showTradeConfirmModal({
        title: 'Accept Trade?',
        message: msg,
        confirmText: 'Accept',
        cancelText: 'Cancel',
        warning: isLast ? '⚠️ This is your LAST COPY of this card' : '',
      });
      if (!confirmed) return;

      const result = acceptTrade(tradeId, username);
      if (result.success) {
        toast.success('Trade accepted! Cards swapped.');
      } else {
        toast.error(_friendlyError(result.reason));
      }
      renderTrading();
    });
  });

  // Decline buttons
  document.querySelectorAll('.trade-decline-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tradeId = btn.dataset.tradeId;
      const result = declineTrade(tradeId, username);
      if (result.success) {
        toast.info('Trade declined.');
      } else {
        toast.error(_friendlyError(result.reason));
      }
      renderTrading();
    });
  });

  // Cancel buttons
  document.querySelectorAll('.trade-cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tradeId = btn.dataset.tradeId;
      const result = cancelTrade(tradeId, username);
      if (result.success) {
        toast.info('Trade cancelled.');
      } else {
        toast.error(_friendlyError(result.reason));
      }
      renderTrading();
    });
  });
}

function _wireListingEvents(username) {
  // Cancel listing buttons
  document.querySelectorAll('.listing-cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const listingId = btn.dataset.listingId;
      const result = cancelListing(listingId, username);
      if (result.success) {
        toast.info('Listing cancelled.');
      } else {
        toast.error(_friendlyError(result.reason));
      }
      renderTrading();
    });
  });

  // Accept listing buttons — T-6: Confirmation step before accepting listing
  document.querySelectorAll('.listing-accept-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const listingId = btn.dataset.listingId;
      const chosenCard = btn.dataset.chosenCard;
      const offeredName = btn.dataset.offeredName || '?';
      const offeredRarity = btn.dataset.offeredRarity || '';
      const chosenName = btn.dataset.chosenName || '?';
      const chosenRarity = btn.dataset.chosenRarity || '';
      const isLast = btn.dataset.isLast === 'true';

      // T-6: Sandbox-safe confirmation modal
      let msg = `You give: ${chosenName} [${chosenRarity}]`;
      msg += `\nYou get: ${offeredName} [${offeredRarity}]`;

      const confirmed = await showTradeConfirmModal({
        title: 'Accept Listing?',
        message: msg,
        confirmText: 'Accept',
        cancelText: 'Cancel',
        warning: isLast ? '⚠️ This is your LAST COPY of this card' : '',
      });
      if (!confirmed) return;

      const result = acceptListing(listingId, username, chosenCard);
      if (result.success) {
        toast.success('Listing fulfilled! Cards swapped.');
      } else {
        toast.error(_friendlyError(result.reason));
      }
      renderTrading();
    });
  });

  // Create listing form
  const offeredSelect = document.getElementById('listing-offered-card');
  if (offeredSelect) {
    offeredSelect.addEventListener('change', () => {
      _updateListingRequestedSection(offeredSelect.value, username);
    });
  }

  // Create listing button
  const createBtn = document.getElementById('listing-create-btn');
  if (createBtn) {
    createBtn.addEventListener('click', () => {
      _handleCreateListing(username);
    });
  }

  // Listing filter bar
  _wireListingFilterEvents(username);
}

function _wireListingFilterEvents(username) {
  const searchEl  = document.getElementById('listing-filter-search');
  const typeEl    = document.getElementById('listing-filter-type');
  const rarityEl  = document.getElementById('listing-filter-rarity');
  const sortEl    = document.getElementById('listing-filter-sort');
  const dupesEl   = document.getElementById('listing-filter-dupes');

  if (!searchEl && !typeEl && !rarityEl && !sortEl && !dupesEl) return;

  const applyAndRefresh = () => {
    if (searchEl)  _tradeFilters.search   = searchEl.value;
    if (typeEl)    _tradeFilters.type     = typeEl.value;
    if (rarityEl)  _tradeFilters.rarity   = rarityEl.value;
    if (sortEl)    _tradeFilters.sort     = sortEl.value;
    if (dupesEl)   _tradeFilters.dupeOnly = dupesEl.checked;

    // Rebuild only the offered-card select in the listing form + count
    const myInv = player.getInventory(username);
    const mySnapshot = buildAvailabilitySnapshot(username);
    const myCardsAll = _getTradableCards(myInv, mySnapshot);
    const myCards = _applyTradeFilters(myCardsAll);

    const listingSelect = document.getElementById('listing-offered-card');
    if (listingSelect) {
      const prevVal = listingSelect.value;
      listingSelect.innerHTML = `<option value="">— Select a card —</option>${_buildCardOptions(myCards, mySnapshot)}`;
      if (prevVal && listingSelect.querySelector(`option[value="${prevVal}"]`)) {
        listingSelect.value = prevVal;
      } else {
        listingSelect.value = '';
        // Clear dependent requested section since offered card changed
        const reqSection = document.getElementById('listing-requested-section');
        if (reqSection) reqSection.classList.add('hidden');
        const createBtnEl = document.getElementById('listing-create-btn');
        if (createBtnEl) createBtnEl.classList.add('hidden');
      }
    }

    // Update count display
    const countEl = document.querySelector('.listing-filter-count');
    if (countEl) countEl.textContent = `${myCards.length} of ${myCardsAll.length} card${myCardsAll.length !== 1 ? 's' : ''} shown`;
  };

  if (searchEl)  searchEl.addEventListener('input', applyAndRefresh);
  if (typeEl)    typeEl.addEventListener('change', applyAndRefresh);
  if (rarityEl)  rarityEl.addEventListener('change', applyAndRefresh);
  if (sortEl)    sortEl.addEventListener('change', applyAndRefresh);
  if (dupesEl)   dupesEl.addEventListener('change', applyAndRefresh);
}

function _updateListingRequestedSection(offeredCardId, username) {
  const section = document.getElementById('listing-requested-section');
  const checkboxArea = document.getElementById('listing-requested-checkboxes');
  const countEl = document.getElementById('listing-requested-count');
  const rarityInfo = document.getElementById('listing-rarity-info');
  const createBtn = document.getElementById('listing-create-btn');
  const errorEl = document.getElementById('listing-error');

  if (!section || !checkboxArea) return;

  if (errorEl) { errorEl.classList.add('hidden'); errorEl.textContent = ''; }

  if (!offeredCardId) {
    section.classList.add('hidden');
    if (createBtn) createBtn.classList.add('hidden');
    return;
  }

  const offeredCard = cards.getCard(offeredCardId);
  if (!offeredCard) {
    section.classList.add('hidden');
    return;
  }

  const targetRarity = offeredCard.rarity;
  if (rarityInfo) {
    rarityInfo.textContent = `Only ${targetRarity} cards can be selected (must match offered card rarity).`;
    rarityInfo.classList.remove('hidden');
  }

  // Get all enabled, tradable cards of the same rarity (excluding the offered card)
  const matchingCards = cards.getEnabledCards()
    .filter(c => c.rarity === targetRarity && c.id !== offeredCardId && c.tradable !== false)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (matchingCards.length === 0) {
    checkboxArea.innerHTML = '<p class="text-surface-500 text-xs">No matching cards available.</p>';
    section.classList.remove('hidden');
    if (createBtn) createBtn.classList.add('hidden');
    return;
  }

  checkboxArea.innerHTML = matchingCards.map(c =>
    `<label class="flex items-center gap-2 p-1 rounded hover:bg-surface-800 cursor-pointer text-sm">
      <input type="checkbox" class="listing-req-checkbox rounded" value="${c.id}" />
      <span class="rarity-text-${c.rarity}">${c.name}</span>
    </label>`
  ).join('');

  section.classList.remove('hidden');

  // Wire checkbox change events
  const checkboxes = checkboxArea.querySelectorAll('.listing-req-checkbox');
  checkboxes.forEach(cb => {
    cb.addEventListener('change', () => {
      const checked = checkboxArea.querySelectorAll('.listing-req-checkbox:checked');
      const count = checked.length;

      // Enforce max 3
      if (count > 3) {
        cb.checked = false;
        toast.error('Maximum 3 requested cards.');
        return;
      }

      if (countEl) countEl.textContent = `${count} / 3 selected`;

      // Show/hide create button
      if (createBtn) {
        if (count >= 1 && count <= 3) {
          createBtn.classList.remove('hidden');
        } else {
          createBtn.classList.add('hidden');
        }
      }
    });
  });

  if (countEl) countEl.textContent = '0 / 3 selected';
  if (createBtn) createBtn.classList.add('hidden');
}

async function _handleCreateListing(username) {
  const offeredSelect = document.getElementById('listing-offered-card');
  const checkboxArea = document.getElementById('listing-requested-checkboxes');
  const errorEl = document.getElementById('listing-error');

  if (!offeredSelect || !checkboxArea) return;

  const offeredCardId = offeredSelect.value;
  if (!offeredCardId) {
    if (errorEl) { errorEl.textContent = 'Select a card to offer.'; errorEl.classList.remove('hidden'); }
    return;
  }

  const checked = checkboxArea.querySelectorAll('.listing-req-checkbox:checked');
  const requestedCardIds = Array.from(checked).map(cb => cb.value);
  if (requestedCardIds.length < 1 || requestedCardIds.length > 3) {
    if (errorEl) { errorEl.textContent = 'Select 1–3 cards you want.'; errorEl.classList.remove('hidden'); }
    return;
  }

  // T-6: Sandbox-safe confirmation modal for listing creation
  const offeredCard = cards.getCard(offeredCardId);
  const listingSnapshot = buildAvailabilitySnapshot(username);
  const isLast = isLastAvailableCopy(listingSnapshot, offeredCardId);
  const requestedNames = requestedCardIds.map(id => {
    const c = cards.getCard(id);
    return c ? c.name : id;
  });

  let msg = `You offer: ${offeredCard ? offeredCard.name : offeredCardId}`;
  if (offeredCard) msg += ` [${offeredCard.rarity}]`;
  msg += `\nYou want: ${requestedNames.join(', ')}`;

  const confirmed = await showTradeConfirmModal({
    title: 'Post Listing?',
    message: msg,
    confirmText: 'Post',
    cancelText: 'Cancel',
    warning: isLast ? '⚠️ This is your LAST COPY of this card' : '',
  });
  if (!confirmed) return;

  const result = createListing(username, offeredCardId, requestedCardIds);
  if (result.success) {
    toast.success('Listing posted!');
  } else {
    const reason = result.reason || 'Unknown error';
    toast.error(_friendlyError(reason));
  }
  renderTrading();
}

function _wirePickerFilterEvents(username) {
  const searchEl  = document.getElementById('picker-filter-search');
  const typeEl    = document.getElementById('picker-filter-type');
  const rarityEl  = document.getElementById('picker-filter-rarity');
  const sortEl    = document.getElementById('picker-filter-sort');
  const dupesEl   = document.getElementById('picker-filter-dupes');

  if (!searchEl && !typeEl && !rarityEl && !sortEl && !dupesEl) return;

  const applyAndRefresh = () => {
    if (searchEl)  _tradeFilters.search   = searchEl.value;
    if (typeEl)    _tradeFilters.type     = typeEl.value;
    if (rarityEl)  _tradeFilters.rarity   = rarityEl.value;
    if (sortEl)    _tradeFilters.sort     = sortEl.value;
    if (dupesEl)   _tradeFilters.dupeOnly = dupesEl.checked;

    if (!_selectedTarget) return;

    // Rebuild offered-card select (my side — full filters)
    const myInv = player.getInventory(username);
    const mySnapshot = buildAvailabilitySnapshot(username);
    const myCardsAll = _getTradableCards(myInv, mySnapshot);
    const myCards = _applyTradeFilters(myCardsAll);

    const offeredSelect = document.getElementById('trade-offered-card');
    if (offeredSelect) {
      const prevVal = offeredSelect.value;
      offeredSelect.innerHTML = `<option value="">— Select a card —</option>${_buildCardOptions(myCards, mySnapshot)}`;
      if (prevVal && offeredSelect.querySelector(`option[value="${prevVal}"]`)) {
        offeredSelect.value = prevVal;
      } else {
        offeredSelect.value = '';
        _offeredCardId = null;
        const cs = document.getElementById('trade-confirm-section');
        if (cs) cs.classList.add('hidden');
      }
    }

    // Rebuild requested-card select (target side — shared filters only: type + rarity)
    const targetInv = player.getInventory(_selectedTarget);
    const targetSnapshot = buildAvailabilitySnapshot(_selectedTarget);
    const targetCardsAll = _getTradableCards(targetInv, targetSnapshot);
    const targetCards = _applySharedTradeFilters(targetCardsAll);

    const requestedSelect = document.getElementById('trade-requested-card');
    if (requestedSelect) {
      const prevVal = requestedSelect.value;
      requestedSelect.innerHTML = `<option value="">— Select a card —</option>${_buildCardOptions(targetCards, targetSnapshot)}`;
      if (prevVal && requestedSelect.querySelector(`option[value="${prevVal}"]`)) {
        requestedSelect.value = prevVal;
      } else {
        requestedSelect.value = '';
        _requestedCardId = null;
        const cs = document.getElementById('trade-confirm-section');
        if (cs) cs.classList.add('hidden');
      }
    }

    const countEl = document.getElementById('picker-filter-result-count');
    if (countEl) {
      countEl.textContent = `${myCards.length} of ${myCardsAll.length} card${myCardsAll.length !== 1 ? 's' : ''} shown (you) · ${targetCards.length} of ${targetCardsAll.length} shown (${_selectedTarget})`;
    }
  };

  if (searchEl)  searchEl.addEventListener('input', applyAndRefresh);
  if (typeEl)    typeEl.addEventListener('change', applyAndRefresh);
  if (rarityEl)  rarityEl.addEventListener('change', applyAndRefresh);
  if (sortEl)    sortEl.addEventListener('change', applyAndRefresh);
  if (dupesEl)   dupesEl.addEventListener('change', applyAndRefresh);
}

function _wireCardSelectionEvents(username) {
  const offeredSelect = document.getElementById('trade-offered-card');
  const requestedSelect = document.getElementById('trade-requested-card');
  if (!offeredSelect || !requestedSelect) return;

  const updatePreview = () => {
    _offeredCardId = offeredSelect.value || null;
    _requestedCardId = requestedSelect.value || null;

    const warningEl = document.getElementById('trade-rarity-warning');
    const confirmSection = document.getElementById('trade-confirm-section');

    if (!_offeredCardId || !_requestedCardId) {
      if (confirmSection) confirmSection.classList.add('hidden');
      if (warningEl) warningEl.classList.add('hidden');
      return;
    }

    const offeredCard = cards.getCard(_offeredCardId);
    const requestedCard = cards.getCard(_requestedCardId);

    // Rarity mismatch warning
    if (offeredCard && requestedCard && offeredCard.rarity !== requestedCard.rarity) {
      if (warningEl) {
        warningEl.textContent = `Rarity mismatch: ${offeredCard.rarity} ≠ ${requestedCard.rarity}. Trades must be equal rarity.`;
        warningEl.classList.remove('hidden');
      }
      if (confirmSection) confirmSection.classList.add('hidden');
      return;
    }

    if (warningEl) warningEl.classList.add('hidden');

    // T-6: Check for last copy and show warning in preview
    const pickerSnapshot = buildAvailabilitySnapshot(username);
    const isLast = isLastAvailableCopy(pickerSnapshot, _offeredCardId);
    const lastCopyHtml = isLast
      ? '<div class="mt-2 p-1.5 rounded bg-amber-900/40 border border-amber-700 text-amber-300 text-xs text-center">⚠️ This is your LAST COPY of this card</div>'
      : '';

    // Show confirmation preview
    if (confirmSection) {
      const preview = document.getElementById('trade-confirm-preview');
      if (preview && offeredCard && requestedCard) {
        preview.innerHTML = `
          <div class="text-center text-sm mb-2 text-surface-400">Confirm Trade with <strong class="text-white">${_selectedTarget}</strong></div>
          <div class="flex items-center gap-3">
            <div class="flex-1 text-center p-2 rounded bg-surface-800 border border-surface-600">
              <div class="text-xs text-surface-500 mb-1">You give</div>
              <div class="font-semibold text-sm rarity-text-${offeredCard.rarity}">${offeredCard.name}</div>
              <div class="text-xs text-surface-500 capitalize">${offeredCard.rarity}</div>
            </div>
            <div class="text-surface-500 text-lg">⇄</div>
            <div class="flex-1 text-center p-2 rounded bg-surface-800 border border-surface-600">
              <div class="text-xs text-surface-500 mb-1">You get</div>
              <div class="font-semibold text-sm rarity-text-${requestedCard.rarity}">${requestedCard.name}</div>
              <div class="text-xs text-surface-500 capitalize">${requestedCard.rarity}</div>
            </div>
          </div>
          ${lastCopyHtml}`;
      }
      confirmSection.classList.remove('hidden');

      // Wire send button
      const sendBtn = document.getElementById('trade-send-btn');
      if (sendBtn) {
        // Remove old listeners by replacing the element
        const newBtn = sendBtn.cloneNode(true);
        sendBtn.parentNode.replaceChild(newBtn, sendBtn);
        newBtn.addEventListener('click', () => {
          _handleSendTrade(username);
        });
      }
    }
  };

  offeredSelect.addEventListener('change', updatePreview);
  requestedSelect.addEventListener('change', updatePreview);
}

async function _handleSendTrade(username) {
  if (!_selectedTarget || !_offeredCardId || !_requestedCardId) {
    toast.error('Please select a player and both cards.');
    return;
  }

  // T-6: Sandbox-safe confirmation modal before sending direct trade
  const offeredCard = cards.getCard(_offeredCardId);
  const requestedCard = cards.getCard(_requestedCardId);
  const sendSnapshot = buildAvailabilitySnapshot(username);
  const isLast = isLastAvailableCopy(sendSnapshot, _offeredCardId);

  let msg = `You offer: ${offeredCard ? offeredCard.name : _offeredCardId}`;
  if (offeredCard) msg += ` [${offeredCard.rarity}]`;
  msg += `\nYou want: ${requestedCard ? requestedCard.name : _requestedCardId}`;
  if (requestedCard) msg += ` [${requestedCard.rarity}]`;

  const confirmed = await showTradeConfirmModal({
    title: `Send Trade to ${_selectedTarget}?`,
    message: msg,
    confirmText: 'Send',
    cancelText: 'Cancel',
    warning: isLast ? '⚠️ This is your LAST COPY of this card' : '',
  });
  if (!confirmed) return;

  const result = createTradeOffer(username, _selectedTarget, _offeredCardId, _requestedCardId);
  if (result.success) {
    toast.success(`Trade request sent to ${_selectedTarget}!`);
  } else {
    toast.error(_friendlyError(result.reason));
  }
  renderTrading();
}

// ─── Lightweight Reactive Refresh Helpers ───────────────────────────────────
// These helpers update ONLY specific DOM regions.
// They NEVER call renderTrading() and NEVER destroy active form state.

/**
 * Refresh direct trade cooldown banner text only.
 * Safe to call at any time — only touches the timer text and visibility.
 */
export function refreshTradeCooldownBanners(username) {
  if (!username) {
    const session = auth.getSession();
    if (!session || session.username === '__admin__') return;
    username = session.username;
  }

  // Direct trade cooldown
  const cd = getDirectTradeCooldown(username);
  const banner = document.getElementById('trade-cooldown-banner');
  const timerEl = document.getElementById('trade-cooldown-timer');
  if (banner) {
    if (!cd.onCooldown) {
      banner.classList.add('hidden');
    } else {
      banner.classList.remove('hidden');
      if (timerEl) timerEl.textContent = formatCooldown(cd.remainingMs);
    }
  }
}

/**
 * Refresh listing cooldown banners (posting + accept).
 * Safe to call at any time — only touches banner visibility and timer text.
 */
export function refreshListingCooldownBanners(username) {
  if (!username) {
    const session = auth.getSession();
    if (!session || session.username === '__admin__') return;
    username = session.username;
  }

  // Listing posting cooldown
  const lcd = getListingCooldown(username);
  const lBanner = document.getElementById('listing-cooldown-banner');
  const lTimerEl = document.getElementById('listing-cooldown-timer');
  if (lBanner) {
    if (!lcd.onCooldown) {
      lBanner.classList.add('hidden');
    } else {
      lBanner.classList.remove('hidden');
      if (lTimerEl) lTimerEl.textContent = formatCooldown(lcd.remainingMs);
    }
  }

  // Listing accept cooldown
  const lacd = getListingAcceptCooldown(username);
  const laBanner = document.getElementById('listing-accept-cooldown-banner');
  const laTimerEl = document.getElementById('listing-accept-cooldown-timer');
  if (laBanner) {
    if (!lacd.onCooldown) {
      laBanner.classList.add('hidden');
    } else {
      laBanner.classList.remove('hidden');
      if (laTimerEl) laTimerEl.textContent = formatCooldown(lacd.remainingMs);
    }
  }
}

/**
 * Refresh only the Incoming Trades section.
 * Replaces the contents of the incoming trades container without touching the new trade form.
 * Preserves all form selections.
 */
export function refreshIncomingTradesSection(username) {
  if (!username) {
    const session = auth.getSession();
    if (!session || session.username === '__admin__') return;
    username = session.username;
  }

  // Locate the incoming trades container by its heading landmark
  // The incoming trades div is the first .mb-6 in #trade-subtab-direct
  const directTab = document.getElementById('trade-subtab-direct');
  if (!directTab) return;

  const { incoming } = getPendingTrades(username);

  // Find the incoming trades section by data attribute or reconstruct it
  const incomingSection = directTab.querySelector('[data-section="incoming-trades"]');
  if (!incomingSection) return;

  const countBadge = incoming.length > 0
    ? `<span class="bg-primary-600 text-white text-xs px-2 py-0.5 rounded-full">${incoming.length}</span>`
    : '';

  incomingSection.innerHTML = `
    <h3 class="text-lg font-semibold mb-3 flex items-center gap-2">
      📥 Incoming Trades ${countBadge}
    </h3>
    ${incoming.length === 0
      ? '<p class="text-surface-500 text-sm">No incoming trade requests.</p>'
      : incoming.map(t => _renderIncomingTrade(t, username)).join('')}`;

  // Re-wire accept/decline buttons in this section only
  incomingSection.querySelectorAll('.trade-accept-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tradeId = btn.dataset.tradeId;
      const giveName = btn.dataset.giveName || '?';
      const giveRarity = btn.dataset.giveRarity || '';
      const getName = btn.dataset.getName || '?';
      const getRarity = btn.dataset.getRarity || '';
      const isLast = btn.dataset.isLast === 'true';

      let msg = `You give: ${giveName} [${giveRarity}]`;
      msg += `\nYou get: ${getName} [${getRarity}]`;

      const confirmed = await showTradeConfirmModal({
        title: 'Accept Trade?', message: msg, confirmText: 'Accept', cancelText: 'Cancel',
        warning: isLast ? '⚠️ This is your LAST COPY of this card' : '',
      });
      if (!confirmed) return;

      const result = acceptTrade(tradeId, username);
      if (result.success) {
        toast.success('Trade accepted! Cards swapped.');
      } else {
        toast.error(_friendlyError(result.reason));
      }
      renderTrading();
    });
  });

  incomingSection.querySelectorAll('.trade-decline-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tradeId = btn.dataset.tradeId;
      const result = declineTrade(tradeId, username);
      if (result.success) {
        toast.info('Trade declined.');
      } else {
        toast.error(_friendlyError(result.reason));
      }
      renderTrading();
    });
  });
}

/**
 * Refresh only the Available Listings section (other players' listings).
 * Replaces #available-listings-section innerHTML.
 * Preserves all form state in My Listings section and the new-trade form.
 */
export function refreshAvailableListingsSection(username) {
  if (!username) {
    const session = auth.getSession();
    if (!session || session.username === '__admin__') return;
    username = session.username;
  }

  const section = document.getElementById('available-listings-section');
  if (!section) return;

  const visibleListings = getVisibleListings(username);
  const otherListings = visibleListings.filter(l => l.ownerId !== username);

  const countBadge = otherListings.length > 0
    ? `<span class="bg-primary-600 text-white text-xs px-2 py-0.5 rounded-full">${otherListings.length}</span>`
    : '';

  section.innerHTML = `
    <h3 class="text-lg font-semibold mb-3 flex items-center gap-2">
      🏪 Available Listings ${countBadge}
    </h3>
    ${otherListings.length === 0
      ? '<p class="text-surface-500 text-sm">No listings available in your group right now.</p>'
      : otherListings.map(l => _renderAvailableListing(l, username)).join('')}`;

  // Re-wire accept listing buttons
  section.querySelectorAll('.listing-accept-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const listingId = btn.dataset.listingId;
      const chosenCard = btn.dataset.chosenCard;
      const offeredName = btn.dataset.offeredName || '?';
      const offeredRarity = btn.dataset.offeredRarity || '';
      const chosenName = btn.dataset.chosenName || '?';
      const chosenRarity = btn.dataset.chosenRarity || '';
      const isLast = btn.dataset.isLast === 'true';

      let msg = `You give: ${chosenName} [${chosenRarity}]`;
      msg += `\nYou get: ${offeredName} [${offeredRarity}]`;

      const confirmed = await showTradeConfirmModal({
        title: 'Accept Listing?', message: msg, confirmText: 'Accept', cancelText: 'Cancel',
        warning: isLast ? '⚠️ This is your LAST COPY of this card' : '',
      });
      if (!confirmed) return;

      const result = acceptListing(listingId, username, chosenCard);
      if (result.success) {
        toast.success('Listing fulfilled! Cards swapped.');
      } else {
        toast.error(_friendlyError(result.reason));
      }
      renderTrading();
    });
  });
}

/**
 * Refresh the My Listings section (owned listings + create form).
 * Replaces #my-listings-section innerHTML.
 * Does NOT touch the available listings section or the direct trade form.
 *
 * IMPORTANT: Only call this when the user is NOT actively filling the create-listing form.
 * The create-listing form is rebuilt as part of this section, so any in-progress
 * selection in the form would be lost. This helper is only used by the passive
 * reactive ticker when the listing create form is not visible (i.e. user is at max listings).
 */
export function refreshMyListingsSection(username) {
  if (!username) {
    const session = auth.getSession();
    if (!session || session.username === '__admin__') return;
    username = session.username;
  }

  const section = document.getElementById('my-listings-section');
  if (!section) return;

  const ownedListings = getMyActiveListings(username);
  const maxListings = getMaxActiveListingsPerPlayer();

  let inner = `<h3 class="text-lg font-semibold mb-3 flex items-center gap-2">
    📌 My Listings
    <span class="text-sm font-normal text-surface-400">(${ownedListings.length}/${maxListings})</span>
  </h3>`;

  if (ownedListings.length > 0) {
    inner += ownedListings.map(l => _renderMyListing(l)).join('');
  } else {
    inner += `<p class="text-surface-500 text-sm mb-3">You have no active listings.</p>`;
  }

  if (ownedListings.length < maxListings) {
    inner += _renderCreateListingForm(username);
  } else {
    inner += `<p class="text-amber-400 text-sm mt-2">You've reached the maximum of ${maxListings} active listing${maxListings !== 1 ? 's' : ''}. Cancel one to post a new listing.</p>`;
  }

  section.innerHTML = inner;

  // Re-wire cancel listing buttons in this section
  section.querySelectorAll('.listing-cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const listingId = btn.dataset.listingId;
      const result = cancelListing(listingId, username);
      if (result.success) {
        toast.info('Listing cancelled.');
      } else {
        toast.error(_friendlyError(result.reason));
      }
      renderTrading();
    });
  });

  // Re-wire listing create form
  const offeredSelect = section.querySelector('#listing-offered-card');
  if (offeredSelect) {
    offeredSelect.addEventListener('change', () => {
      _updateListingRequestedSection(offeredSelect.value, username);
    });
  }
  const createBtn = section.querySelector('#listing-create-btn');
  if (createBtn) {
    createBtn.addEventListener('click', () => {
      _handleCreateListing(username);
    });
  }

  // Re-wire listing filter bar (rendered as part of the create form)
  _wireListingFilterEvents(username);
}

/**
 * Refresh trade availability state: disable/enable controls based on
 * current config (trading enabled/disabled, listings enabled/disabled).
 * Targets button states and banners without touching form DOM.
 */
export function refreshTradeAvailabilityState() {
  // This is a lightweight pass — if trading gets disabled while tab is open,
  // a full renderTrading() on the next user interaction will show the correct state.
  // For now, just ensure cooldown banners are accurate.
  const session = auth.getSession();
  if (!session || session.username === '__admin__') return;
  refreshTradeCooldownBanners(session.username);
  refreshListingCooldownBanners(session.username);
}

// ─── Cooldown Timer ─────────────────────────────────────────────────────────

// Snapshot hashes for reactive change detection (avoids unnecessary DOM writes)
let _lastIncomingHash = '';
let _lastAvailableListingsHash = '';
let _lastMyListingsHash = '';
let _reactiveTickCounter = 0;
// T-8.6: Track listing cooldown state to detect expiry transitions
let _lastListingCooldownState = null;

function _hashArray(arr) {
  if (!arr || arr.length === 0) return '[]';
  return arr.map(x => (x.id || '') + ':' + (x.status || '') + ':' + (x.expiresAt || 0)).join('|');
}

function _startCooldownTimer(username) {
  if (_cooldownTimer) clearInterval(_cooldownTimer);

  _cooldownTimer = setInterval(() => {
    // ── 1. Cooldown banners (every tick, 1s) ──────────────────────────────
    refreshTradeCooldownBanners(username);
    refreshListingCooldownBanners(username);

    // ── 2. Reactive checks (every 5s to avoid excess DOM churn) ──────────
    _reactiveTickCounter++;
    if (_reactiveTickCounter % 5 !== 0) return;

    // Guard: skip reactive updates if user is actively filling the trade form
    // (detected by presence of #trade-target-select with a value set, or
    //  #listing-offered-card with a value set)
    const targetSelect = document.getElementById('trade-target-select');
    const listingOfferedSelect = document.getElementById('listing-offered-card');

    const userFillingDirectTrade = targetSelect && targetSelect.value !== '';
    const userFillingListingForm = listingOfferedSelect && listingOfferedSelect.value !== '';

    // ── 2a. Refresh incoming trades (safe — separate section) ────────────
    const directTab = document.getElementById('trade-subtab-direct');
    const incomingSection = directTab && directTab.querySelector('[data-section="incoming-trades"]');
    if (incomingSection) {
      const { incoming } = getPendingTrades(username);
      const newHash = _hashArray(incoming);
      if (newHash !== _lastIncomingHash) {
        _lastIncomingHash = newHash;
        refreshIncomingTradesSection(username);
      }
    }

    // ── 2b. Refresh available listings (safe — separate section) ─────────
    const availSection = document.getElementById('available-listings-section');
    if (availSection) {
      expireStaleListings();
      const visible = getVisibleListings(username).filter(l => l.ownerId !== username);
      const newHash = _hashArray(visible);
      if (newHash !== _lastAvailableListingsHash) {
        _lastAvailableListingsHash = newHash;
        refreshAvailableListingsSection(username);
      }
    }

    // ── 2c. Refresh my listings section (only if user is NOT filling the form) ──
    // When user has at max listings (create form hidden), the section can refresh safely.
    // When user is filling the create form, skip to preserve their selections.
    if (!userFillingListingForm) {
      const mySection = document.getElementById('my-listings-section');
      if (mySection) {
        const owned = getMyActiveListings(username);
        const newHash = _hashArray(owned);
        if (newHash !== _lastMyListingsHash) {
          _lastMyListingsHash = newHash;
          refreshMyListingsSection(username);
        }
      }
    }

    // ── 2d. T-8.6: Detect listing cooldown expiry transitions ────────────
    // The hash-based check above misses cooldown expirations because the
    // listings array itself doesn't change when a cooldown ends.
    // This separate check triggers a rerender when onCooldown flips false.
    const cooldownNow = getListingCooldown(username).onCooldown;
    if (cooldownNow !== _lastListingCooldownState) {
      _lastListingCooldownState = cooldownNow;
      if (!userFillingListingForm) {
        refreshMyListingsSection(username);
      }
    }
  }, 1000);
}

// ─── Utility ────────────────────────────────────────────────────────────────

function _timeAgo(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function _formatTimeLeft(expiresAt) {
  if (!expiresAt) return 'unknown';
  const diff = expiresAt - Date.now();
  if (diff <= 0) return 'expired';
  const hrs = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

const ERROR_MESSAGES = {
  SELF_TRADE: 'You cannot trade with yourself.',
  DIFFERENT_GROUPS: 'Players must be in the same group to trade.',
  OFFERING_PLAYER_TRADE_RESTRICTED: 'Your trading is restricted.',
  TARGET_PLAYER_TRADE_RESTRICTED: 'This player\'s trading is restricted.',
  TARGET_PLAYER_HIDDEN: 'This player is not available for trades.',
  RARITY_MISMATCH: 'Cards must be the same rarity to trade.',
  OFFERING_PLAYER_MISSING_OFFERED_CARD: 'You no longer own this card.',
  TARGET_PLAYER_MISSING_REQUESTED_CARD: 'The other player no longer owns the requested card.',
  SENDER_ON_COOLDOWN: 'You are on trade cooldown. Please wait.',
  ACCEPTER_ON_COOLDOWN: 'You are on trade cooldown. Please wait.',
  OFFERING_PLAYER_ON_COOLDOWN: 'The sending player is on trade cooldown.',
  TARGET_PLAYER_ON_COOLDOWN: 'You are on trade cooldown.',
  DUPLICATE_PENDING_TRADE: 'You already have a pending trade for these exact cards with this player.',
  TRADE_NOT_FOUND: 'Trade not found.',
  TRADE_NOT_PENDING: 'This trade is no longer pending.',
  NOT_TARGET_PLAYER: 'You cannot respond to this trade.',
  NOT_OFFERING_PLAYER: 'You cannot cancel this trade.',
  // Listing errors
  LISTING_NOT_FOUND: 'Listing not found.',
  LISTING_NOT_ACTIVE: 'This listing is no longer active.',
  LISTING_EXPIRED: 'This listing has expired.',
  LISTING_ON_COOLDOWN: 'You are on listing cooldown. Please wait.',
  MAX_ACTIVE_LISTINGS_REACHED: 'You have reached the maximum number of active listings. Cancel one first.',
  OWNER_NOT_FOUND: 'Player not found.',
  OWNER_TRADE_RESTRICTED: 'Your trading is restricted.',
  OWNER_NO_GROUP: 'You must be in a group to create listings.',
  OWNER_MISSING_OFFERED_CARD: 'You no longer own this card.',
  OFFERED_CARD_NOT_FOUND: 'Card not found.',
  OFFERED_CARD_DISABLED: 'This card is disabled.',
  OFFERED_CARD_NOT_TRADABLE: 'This card cannot be traded.',
  INVALID_REQUESTED_CARDS_COUNT: 'Select 1–3 cards you want.',
  DUPLICATE_REQUESTED_CARDS: 'Requested cards must be unique.',
  OFFERED_CARD_IN_REQUESTED: 'You cannot request the same card you are offering.',
  NOT_LISTING_OWNER: 'You cannot cancel this listing.',
  LISTING_OWNER_NOT_FOUND: 'The listing owner no longer exists.',
  LISTING_OWNER_TRADE_RESTRICTED: 'The listing owner\'s trading is restricted.',
  LISTING_OWNER_MISSING_OFFERED_CARD: 'The listing owner no longer has this card.',
  ACCEPTER_NOT_FOUND: 'Player not found.',
  ACCEPTER_TRADE_RESTRICTED: 'Your trading is restricted.',
  ACCEPTER_MISSING_CHOSEN_CARD: 'You don\'t own the card you selected.',
  CHOSEN_CARD_NOT_IN_REQUESTED: 'That card is not accepted for this listing.',
  CHOSEN_CARD_NOT_FOUND: 'Card not found.',
  CHOSEN_CARD_NOT_TRADABLE: 'That card cannot be traded.',
  LISTING_OWNER_ON_COOLDOWN: 'The listing owner is on trade cooldown.',
  LISTING_WRONG_GROUP: 'This listing is not in your group.',
  // T-6: Project-lock errors
  OFFERED_CARD_LOCKED_BY_PROJECT: 'This card is assigned to an active research project and cannot be traded.',
  REQUESTED_CARD_LOCKED_BY_PROJECT: 'The requested card is assigned to an active research project and cannot be traded.',
  CARD_RESERVED_BY_LISTING: 'Your last available copy of this card is listed for trade.',
  CARD_RESERVED_BY_OUTGOING_TRADE: 'Your last available copy of this card is offered in a pending trade.',
  CARD_RESERVED_BY_INCOMING_TRADE: 'Your last available copy is reserved for an incoming trade offer.',
  INSUFFICIENT_AVAILABLE_COPIES: 'You have no available copies of this card to trade.',
};

function _friendlyError(reason) {
  // Handle parameterized error codes like RARITY_MISMATCH:cardId
  const base = reason.split(':')[0];
  return ERROR_MESSAGES[base] || ERROR_MESSAGES[reason] || `Trade failed: ${reason}`;
}
