/**
 * admin-player-history.js — Lazy Admin View History UI helpers (D1).
 *
 * No history reads until Admin explicitly opens View History / Load More.
 * Display strings are derived locally; never persisted to Firebase.
 */

import { getCard } from './cards.js';
import { getPackType } from './packs.js';
import {
  ADMIN_STAT_CORRECTION_FIELDS,
} from './admin-stat-correction.js';
import {
  HISTORY_EVENT_TYPES,
  HISTORY_PAGE_SIZE,
  formatHistoryTimestamp,
  loadNewestPlayerHistoryPage,
  loadOlderPlayerHistoryPage,
  sortHistoryEntriesNewestFirst,
} from './player-history.js';

export const HISTORY_UI_DOM_CAP = 200;

/**
 * Escape text for HTML text nodes / attributes.
 * @param {unknown} value
 */
export function escapeHistoryHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {string} cardId
 * @returns {string}
 */
export function resolveCardLabel(cardId) {
  const id = String(cardId || '').trim();
  if (!id) return 'Unknown card';
  try {
    const card = getCard(id);
    if (card?.name) return String(card.name);
  } catch { /* ignore */ }
  return id;
}

/**
 * @param {string} packId
 * @returns {string}
 */
export function resolvePackLabel(packId) {
  const id = String(packId || '').trim();
  if (!id) return 'Unknown pack';
  try {
    const pack = getPackType(id);
    if (pack?.name) return String(pack.name);
  } catch { /* ignore */ }
  return id;
}

/**
 * @param {Record<string, number>|null|undefined} map
 * @returns {string}
 */
export function formatCardQtyList(map) {
  if (!map || typeof map !== 'object') return '';
  const parts = Object.entries(map).map(([id, qty]) => {
    const label = resolveCardLabel(id);
    const n = Math.floor(Number(qty) || 0);
    return n > 1 ? `${label} ×${n}` : label;
  });
  return parts.join(', ');
}

/**
 * @param {unknown} event
 * @returns {string}
 */
export function actorLabelForHistoryEvent(event) {
  const actorType = String(event?.actorType || '');
  if (actorType === 'admin') {
    const name = event?.actorUsername ? String(event.actorUsername) : '';
    return name ? `Admin (${name})` : 'Admin';
  }
  if (actorType === 'system') return 'System reward';
  if (actorType === 'self') return 'Player action';
  return 'Unknown actor';
}

/**
 * Build teacher-readable summary + optional detail lines (not stored).
 * @param {unknown} event
 * @returns {{ summary: string, details: string[], actorLabel: string, known: boolean }}
 */
export function describeHistoryEvent(event) {
  const actorLabel = actorLabelForHistoryEvent(event);
  if (!event || typeof event !== 'object' || !event.type) {
    return {
      summary: 'Unknown history event',
      details: [],
      actorLabel,
      known: false,
    };
  }

  const type = String(event.type);
  /** @type {string[]} */
  const details = [];

  switch (type) {
    case HISTORY_EVENT_TYPES.PACK_OPENED: {
      const packLabel = resolvePackLabel(event.packId);
      const cards = event.cardsGranted && typeof event.cardsGranted === 'object'
        ? event.cardsGranted
        : {};
      const total = Object.values(cards).reduce((s, n) => s + (Math.floor(Number(n) || 0)), 0);
      details.push(`Pack: ${packLabel} (${event.packId || '—'})`);
      if (Object.keys(cards).length) {
        details.push(`Cards: ${formatCardQtyList(cards)}`);
      }
      return {
        summary: `Opened ${packLabel} — ${total || 0} card${total === 1 ? '' : 's'}`,
        details,
        actorLabel,
        known: true,
      };
    }
    case HISTORY_EVENT_TYPES.PACK_GRANTED: {
      const packLabel = resolvePackLabel(event.packId);
      const qty = Math.floor(Number(event.quantity) || 0);
      const reason = String(event.reason || '');
      const isWeekly = reason === 'weekly' || String(event.source) === 'weekly_research_pack';
      const who = isWeekly ? 'System granted' : 'Admin granted';
      details.push(`${event.before ?? '?'} → ${event.after ?? '?'}`);
      if (isWeekly) details.push('Reason: weekly Research Pack');
      return {
        summary: `${who} ${qty} ${packLabel}${qty === 1 ? '' : 's'}`,
        details,
        actorLabel,
        known: true,
      };
    }
    case HISTORY_EVENT_TYPES.PACK_REMOVED: {
      const packLabel = resolvePackLabel(event.packId);
      const qty = Math.floor(Number(event.quantity) || 0);
      details.push(`${event.before ?? '?'} → ${event.after ?? '?'}`);
      return {
        summary: `Admin removed ${qty} ${packLabel}${qty === 1 ? '' : 's'}`,
        details,
        actorLabel,
        known: true,
      };
    }
    case HISTORY_EVENT_TYPES.CARD_GRANTED: {
      const label = resolveCardLabel(event.cardId);
      const qty = Math.floor(Number(event.quantity) || 0);
      details.push(`${event.before ?? '?'} → ${event.after ?? '?'}`);
      return {
        summary: `Admin granted ${qty} ${label}`,
        details,
        actorLabel,
        known: true,
      };
    }
    case HISTORY_EVENT_TYPES.CARD_REMOVED: {
      const label = resolveCardLabel(event.cardId);
      const qty = Math.floor(Number(event.quantity) || 0);
      details.push(`${event.before ?? '?'} → ${event.after ?? '?'}`);
      return {
        summary: `Admin removed ${qty} ${qty === 1 ? 'copy' : 'copies'} of ${label}`,
        details,
        actorLabel,
        known: true,
      };
    }
    case HISTORY_EVENT_TYPES.ADMIN_STAT_CORRECT: {
      const fieldId = String(event.fieldId || '');
      const field = ADMIN_STAT_CORRECTION_FIELDS[fieldId];
      const fieldLabel = field?.label || fieldId || 'stat';
      details.push(`${event.before ?? '?'} → ${event.after ?? '?'}`);
      details.push(`Adjustment: ${event.adjustment ?? '?'}`);
      return {
        summary: `Corrected ${fieldLabel}`,
        details,
        actorLabel,
        known: true,
      };
    }
    case HISTORY_EVENT_TYPES.TRADE_COMPLETED: {
      const kind = event.tradeKind === 'listing' ? 'listing' : 'direct';
      const counterparty = String(event.counterpartyUsername || 'someone');
      const gave = formatCardQtyList(event.gave);
      const received = formatCardQtyList(event.received);
      details.push(`Kind: ${kind}`);
      details.push(`Trade ID: ${event.tradeId || event.listingId || '—'}`);
      if (gave) details.push(`Gave: ${gave}`);
      if (received) details.push(`Received: ${received}`);
      return {
        summary: `Traded with ${counterparty}`,
        details,
        actorLabel,
        known: true,
      };
    }
    case HISTORY_EVENT_TYPES.PROJECT_CLAIMED: {
      const rp = Number(event.rpDelta) || 0;
      const bits = [];
      if (rp) bits.push(`${rp > 0 ? '+' : ''}${rp} RP`);
      if (event.breakthrough) bits.push('Breakthrough');
      if (event.success === false) bits.push('Failed outcome');
      const cards = formatCardQtyList(event.cardsGranted);
      if (cards) details.push(`Cards: ${cards}`);
      details.push(`Project: ${event.projectId || '—'}`);
      return {
        summary: `Claimed Research Project${bits.length ? ` — ${bits.join(', ')}` : ''}`,
        details,
        actorLabel,
        known: true,
      };
    }
    case HISTORY_EVENT_TYPES.SHOP_PURCHASE: {
      const itemId = String(event.itemId || '');
      const price = Number(event.pricePaid) || 0;
      const currency = String(event.currency || 'RP').toUpperCase();
      if (event.packId) {
        details.push(`Granted: ${resolvePackLabel(event.packId)} ×${event.quantity || 1}`);
      } else if (event.cardId) {
        details.push(`Granted: ${resolveCardLabel(event.cardId)} ×${event.quantity || 1}`);
      } else if (event.consumableId) {
        details.push(`Granted consumable: ${event.consumableId} ×${event.quantity || 1}`);
      } else if (event.cosmeticId) {
        details.push(`Unlocked cosmetic: ${event.cosmeticId}`);
      }
      details.push(`Item: ${itemId || '—'} (${event.itemType || 'item'})`);
      return {
        summary: `Purchased ${itemId || 'shop item'} — ${price} ${currency}`,
        details,
        actorLabel,
        known: true,
      };
    }
    default:
      return {
        summary: 'Unknown history event',
        details: [`Type: ${type}`],
        actorLabel,
        known: false,
      };
  }
}

/**
 * Render one history row (expandable details).
 * @param {{ key: string, value?: object }} entry
 */
export function renderHistoryEventRowHtml(entry) {
  const event = entry?.value && typeof entry.value === 'object' ? entry.value : null;
  const described = describeHistoryEvent(event);
  const ts = formatHistoryTimestamp(event?.ts);
  const detailsId = `hist-detail-${escapeHistoryHtml(entry.key)}`;
  const detailLines = (described.details || [])
    .map((line) => `<li>${escapeHistoryHtml(line)}</li>`)
    .join('');
  const hasDetails = detailLines.length > 0;

  return `
    <article class="pd-history-row border-b border-surface-700/80 py-2" data-event-id="${escapeHistoryHtml(entry.key)}">
      <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p class="text-sm text-surface-100 font-medium">${escapeHistoryHtml(described.summary)}</p>
        <time class="text-xs text-surface-400 whitespace-nowrap" datetime="">${escapeHistoryHtml(ts)}</time>
      </div>
      <p class="text-xs text-surface-500 mt-0.5">${escapeHistoryHtml(described.actorLabel)}</p>
      ${hasDetails ? `
        <button type="button" class="pd-history-toggle text-xs text-primary-400 hover:text-primary-300 mt-1"
          data-detail-id="${detailsId}" aria-expanded="false">
          Show details
        </button>
        <ul id="${detailsId}" class="hidden mt-1 text-xs text-surface-400 list-disc list-inside space-y-0.5">
          ${detailLines}
        </ul>
      ` : ''}
    </article>
  `;
}

/**
 * @param {Array<{ key: string, value?: object }>} entriesNewestFirst
 * @param {{ hasMore: boolean, loading?: boolean, error?: string|null, totalLoaded?: number }} state
 */
export function renderHistoryListHtml(entriesNewestFirst, state = {}) {
  const all = Array.isArray(entriesNewestFirst) ? entriesNewestFirst : [];
  const visible = all.slice(0, HISTORY_UI_DOM_CAP);
  const rows = visible.map(renderHistoryEventRowHtml).join('');
  const empty = !visible.length
    ? '<p class="text-sm text-surface-500 py-3">No history events yet.</p>'
    : '';
  const truncated = all.length > HISTORY_UI_DOM_CAP
    ? `<p class="text-xs text-surface-500 mt-2">Showing newest ${HISTORY_UI_DOM_CAP} of ${all.length} loaded.</p>`
    : '';
  const err = state.error
    ? `<p class="text-xs text-amber-400 mb-2">${escapeHistoryHtml(state.error)}</p>`
    : '';
  const loadDisabled = state.loading || state.hasMore === false;
  const loadLabel = state.loading
    ? 'Loading…'
    : (state.hasMore === false ? 'No more history' : 'Load 50 More');

  return `
    ${err}
    <div class="pd-history-list max-h-80 overflow-y-auto pr-1">
      ${empty || rows}
    </div>
    ${truncated}
    <div class="mt-3 flex items-center gap-2">
      <button type="button" id="pd-history-load-more"
        class="bg-surface-600 hover:bg-surface-500 px-3 py-1.5 rounded text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        ${loadDisabled ? 'disabled' : ''}>
        ${escapeHistoryHtml(loadLabel)}
      </button>
      <span class="text-xs text-surface-500">${all.length ? `${all.length} loaded` : ''}</span>
    </div>
  `;
}

/**
 * Create mutable session state for one Manage → View History session.
 * @param {string} username
 */
export function createPlayerHistoryUiState(username) {
  return {
    username: String(username || '').trim(),
    entries: /** @type {Array<{ key: string, value?: object }>} */ ([]),
    hasMore: false,
    loading: false,
    loaded: false,
    error: null,
  };
}

/**
 * @param {ReturnType<typeof createPlayerHistoryUiState>} state
 */
export async function refreshNewestHistory(state) {
  state.loading = true;
  state.error = null;
  const page = await loadNewestPlayerHistoryPage(state.username, { limit: HISTORY_PAGE_SIZE });
  state.loading = false;
  state.loaded = true;
  if (!page.ok) {
    state.error = page.error || 'Failed to load history';
    state.entries = [];
    state.hasMore = false;
    return state;
  }
  state.entries = sortHistoryEntriesNewestFirst(page.entries || []);
  state.hasMore = page.hasMore === true;
  return state;
}

/**
 * @param {ReturnType<typeof createPlayerHistoryUiState>} state
 */
export async function loadMoreHistory(state) {
  if (!state.entries.length || state.hasMore === false || state.loading) return state;
  const oldest = state.entries[state.entries.length - 1]?.key;
  if (!oldest) {
    state.hasMore = false;
    return state;
  }
  state.loading = true;
  state.error = null;
  const page = await loadOlderPlayerHistoryPage(
    state.username,
    oldest,
    state.entries,
    { limit: HISTORY_PAGE_SIZE },
  );
  state.loading = false;
  if (!page.ok) {
    state.error = page.error || 'Failed to load more history';
    return state;
  }
  state.entries = page.entries;
  state.hasMore = page.hasMore === true;
  return state;
}

/**
 * Wire expand toggles + Load More inside a container.
 * @param {HTMLElement} container
 * @param {ReturnType<typeof createPlayerHistoryUiState>} state
 * @param {() => void} rerender
 */
export function bindPlayerHistoryUi(container, state, rerender) {
  container.querySelectorAll('.pd-history-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-detail-id');
      const el = id ? document.getElementById(id) : null;
      if (!el) return;
      const open = !el.classList.contains('hidden');
      if (open) {
        el.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = 'Show details';
      } else {
        el.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
        btn.textContent = 'Hide details';
      }
    });
  });

  container.querySelector('#pd-history-load-more')?.addEventListener('click', async () => {
    await loadMoreHistory(state);
    rerender();
  });
}
