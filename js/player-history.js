/**
 * player-history.js — Observational provenance under playerHistory/{username}/{eventId}.
 *
 * History never mutates gameplay. Later retention may ONLY null leaves under this root.
 */

import * as db from './database.js';

export const PLAYER_HISTORY_ROOT = 'playerHistory';
export const PLAYER_HISTORY_SCHEMA_VERSION = 1;
export const HISTORY_PAGE_SIZE = 50;

/** Firebase RTDB server timestamp sentinel (resolved on write). */
export const HISTORY_SERVER_TIMESTAMP = Object.freeze({ '.sv': 'timestamp' });

export const HISTORY_EVENT_TYPES = Object.freeze({
  PACK_OPENED: 'pack_opened',
  PACK_GRANTED: 'pack_granted',
  PACK_REMOVED: 'pack_removed',
  CARD_GRANTED: 'card_granted',
  CARD_REMOVED: 'card_removed',
  ADMIN_STAT_CORRECT: 'admin_stat_correct',
  TRADE_COMPLETED: 'trade_completed',
  PROJECT_CLAIMED: 'project_claimed',
  SHOP_PURCHASE: 'shop_purchase',
});

export const HISTORY_ACTOR_TYPES = Object.freeze({
  SELF: 'self',
  ADMIN: 'admin',
  SYSTEM: 'system',
});

export const HISTORY_SOURCES = Object.freeze({
  PACK_OPEN: 'pack_open',
  ADMIN_GRANT_PACKS: 'admin_grant_packs',
  ADMIN_REMOVE_PACKS: 'admin_remove_packs',
  ADMIN_GRANT_CARDS: 'admin_grant_cards',
  ADMIN_REMOVE_CARDS: 'admin_remove_cards',
  ADMIN_STAT_CORRECTION: 'admin_stat_correction',
  TRADE_DIRECT: 'trade_direct',
  TRADE_LISTING: 'trade_listing',
  PROJECT_CLAIM: 'project_claim',
  SHOP_PURCHASE: 'shop_purchase',
  WEEKLY_RESEARCH_PACK: 'weekly_research_pack',
});

/** Types allowed for student (self) create under own username. */
export const HISTORY_SELF_CREATE_TYPES = Object.freeze([
  HISTORY_EVENT_TYPES.PACK_OPENED,
  HISTORY_EVENT_TYPES.TRADE_COMPLETED,
  HISTORY_EVENT_TYPES.PROJECT_CLAIMED,
  HISTORY_EVENT_TYPES.SHOP_PURCHASE,
  HISTORY_EVENT_TYPES.PACK_GRANTED, // weekly/system only (rules constrain source/actor)
]);

/** Types allowed for Admin create. */
export const HISTORY_ADMIN_CREATE_TYPES = Object.freeze([
  HISTORY_EVENT_TYPES.PACK_OPENED,
  HISTORY_EVENT_TYPES.PACK_GRANTED,
  HISTORY_EVENT_TYPES.PACK_REMOVED,
  HISTORY_EVENT_TYPES.CARD_GRANTED,
  HISTORY_EVENT_TYPES.CARD_REMOVED,
  HISTORY_EVENT_TYPES.ADMIN_STAT_CORRECT,
  HISTORY_EVENT_TYPES.TRADE_COMPLETED,
  HISTORY_EVENT_TYPES.PROJECT_CLAIMED,
  HISTORY_EVENT_TYPES.SHOP_PURCHASE,
]);

/**
 * @param {string} username
 * @returns {string}
 */
export function playerHistoryUserPath(username) {
  return `${PLAYER_HISTORY_ROOT}/${String(username || '').trim()}`;
}

/**
 * @param {string} username
 * @param {string} eventId
 * @returns {string}
 */
export function playerHistoryEventPath(username, eventId) {
  return `${playerHistoryUserPath(username)}/${String(eventId || '').trim()}`;
}

/**
 * Allocate a unique event path under the player's history root.
 * @param {string} username
 * @returns {{ eventId: string, path: string }}
 */
export function allocatePlayerHistoryEvent(username) {
  const key = String(username || '').trim();
  const parent = playerHistoryUserPath(key);
  const eventId = db.generatePushKey(parent);
  return { eventId, path: playerHistoryEventPath(key, eventId) };
}

/**
 * @param {{
 *   type: string,
 *   actorType: string,
 *   source: string,
 *   actorUid?: string|null,
 *   actorUsername?: string|null,
 *   sourceEventId?: string|null,
 *   payload?: Record<string, unknown>,
 * }} opts
 */
export function buildHistoryEventBody(opts) {
  const type = String(opts.type || '').trim();
  const actorType = String(opts.actorType || '').trim();
  const source = String(opts.source || '').trim();
  const body = {
    type,
    ts: HISTORY_SERVER_TIMESTAMP,
    schemaVersion: PLAYER_HISTORY_SCHEMA_VERSION,
    actorType,
    source,
  };
  if (opts.actorUid != null && String(opts.actorUid).trim()) {
    body.actorUid = String(opts.actorUid).trim();
  }
  if (opts.actorUsername != null && String(opts.actorUsername).trim()) {
    body.actorUsername = String(opts.actorUsername).trim();
  }
  if (opts.sourceEventId != null && String(opts.sourceEventId).trim()) {
    body.sourceEventId = String(opts.sourceEventId).trim();
  }
  const payload = opts.payload && typeof opts.payload === 'object' ? opts.payload : {};
  Object.assign(body, payload);
  return body;
}

/**
 * @param {string} username
 * @param {Parameters<typeof buildHistoryEventBody>[0]} opts
 * @returns {{ path: string, eventId: string, body: object, updates: Record<string, object> }}
 */
export function buildPlayerHistoryLeafUpdate(username, opts) {
  const { eventId, path } = allocatePlayerHistoryEvent(username);
  const body = buildHistoryEventBody(opts);
  return {
    path,
    eventId,
    body,
    updates: { [path]: body },
  };
}

/**
 * Aggregate card id → quantity from rolled card objects or id list.
 * @param {Array<{ id?: string }|string>} rolledCards
 * @returns {Record<string, number>}
 */
export function aggregateCardsGranted(rolledCards) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const item of Array.isArray(rolledCards) ? rolledCards : []) {
    const id = typeof item === 'string' ? item : (item && item.id != null ? String(item.id) : '');
    if (!id) continue;
    out[id] = (out[id] || 0) + 1;
  }
  return out;
}

/**
 * Normalize a compact cardId → qty map (positive ints only).
 * @param {Record<string, unknown>|null|undefined} map
 * @returns {Record<string, number>}
 */
export function normalizeCardQtyMap(map) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [rawId, rawQty] of Object.entries(map)) {
    const id = String(rawId || '').trim();
    if (!id) continue;
    const qty = Math.floor(Number(rawQty));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    out[id] = qty;
  }
  return out;
}

/**
 * Pack-open history leaf for the same multipath as buildPackOpenPlan.
 */
export function buildPackOpenedHistoryUpdate(username, {
  packId,
  cardsGranted,
  packsOpenedDelta = 1,
  cardsCollectedDelta,
  actorUid = null,
}) {
  return buildPlayerHistoryLeafUpdate(username, {
    type: HISTORY_EVENT_TYPES.PACK_OPENED,
    actorType: HISTORY_ACTOR_TYPES.SELF,
    source: HISTORY_SOURCES.PACK_OPEN,
    actorUid,
    actorUsername: username,
    payload: {
      packId: String(packId || ''),
      cardsGranted: cardsGranted && typeof cardsGranted === 'object' ? cardsGranted : {},
      deltas: {
        packsOpened: packsOpenedDelta,
        cardsCollected: Number(cardsCollectedDelta) || 0,
      },
    },
  });
}

/**
 * One player's perspective of a settled trade (direct or listing).
 */
export function buildTradeCompletedHistoryUpdate(username, {
  tradeKind,
  tradeId,
  listingId = null,
  counterpartyUsername,
  gave,
  received,
  actorUid = null,
}) {
  const kind = tradeKind === 'listing' ? 'listing' : 'direct';
  const tid = String(tradeId || listingId || '').trim();
  const payload = {
    tradeKind: kind,
    tradeId: tid,
    counterpartyUsername: String(counterpartyUsername || '').trim(),
    gave: normalizeCardQtyMap(gave),
    received: normalizeCardQtyMap(received),
  };
  if (kind === 'listing') {
    payload.listingId = String(listingId || tid).trim();
  }
  return buildPlayerHistoryLeafUpdate(username, {
    type: HISTORY_EVENT_TYPES.TRADE_COMPLETED,
    actorType: HISTORY_ACTOR_TYPES.SELF,
    source: kind === 'listing' ? HISTORY_SOURCES.TRADE_LISTING : HISTORY_SOURCES.TRADE_DIRECT,
    actorUid,
    actorUsername: username,
    payload,
  });
}

/**
 * Successful research project claim.
 */
export function buildProjectClaimedHistoryUpdate(username, {
  projectId,
  rpDelta = 0,
  breakthrough = false,
  cardsGranted = null,
  packsGranted = null,
  success = true,
  actorUid = null,
}) {
  /** @type {Record<string, unknown>} */
  const payload = {
    projectId: String(projectId || ''),
    rpDelta: Number(rpDelta) || 0,
    breakthrough: breakthrough === true,
    success: success !== false,
  };
  const cards = normalizeCardQtyMap(cardsGranted);
  if (Object.keys(cards).length) payload.cardsGranted = cards;
  const packs = normalizeCardQtyMap(packsGranted);
  if (Object.keys(packs).length) payload.packsGranted = packs;
  return buildPlayerHistoryLeafUpdate(username, {
    type: HISTORY_EVENT_TYPES.PROJECT_CLAIMED,
    actorType: HISTORY_ACTOR_TYPES.SELF,
    source: HISTORY_SOURCES.PROJECT_CLAIM,
    actorUid,
    actorUsername: username,
    payload,
  });
}

/**
 * Successful shop purchase (separate from players/.../purchaseHistory).
 */
export function buildShopPurchaseHistoryUpdate(username, {
  itemId,
  itemType,
  pricePaid,
  currency,
  grant = null,
  actorUid = null,
}) {
  /** @type {Record<string, unknown>} */
  const payload = {
    itemId: String(itemId || ''),
    itemType: String(itemType || ''),
    pricePaid: Number(pricePaid) || 0,
    currency: String(currency || 'rp'),
  };
  if (grant && typeof grant === 'object') {
    if (grant.packId) {
      payload.packId = String(grant.packId);
      payload.quantity = Math.max(0, Math.floor(Number(grant.quantity) || 0));
    } else if (grant.cardId) {
      payload.cardId = String(grant.cardId);
      payload.quantity = Math.max(0, Math.floor(Number(grant.quantity) || 0));
    } else if (grant.consumableId) {
      payload.consumableId = String(grant.consumableId);
      payload.quantity = Math.max(0, Math.floor(Number(grant.quantity) || 0));
    } else if (grant.cosmeticId) {
      payload.cosmeticId = String(grant.cosmeticId);
      payload.quantity = 1;
    }
  }
  return buildPlayerHistoryLeafUpdate(username, {
    type: HISTORY_EVENT_TYPES.SHOP_PURCHASE,
    actorType: HISTORY_ACTOR_TYPES.SELF,
    source: HISTORY_SOURCES.SHOP_PURCHASE,
    actorUid,
    actorUsername: username,
    payload,
  });
}

/**
 * Weekly Research Pack system grant (pack_granted + reason weekly).
 */
export function buildWeeklyPackGrantedHistoryUpdate(username, {
  packId,
  quantity,
  before,
  after,
  actorUid = null,
}) {
  return buildPlayerHistoryLeafUpdate(username, {
    type: HISTORY_EVENT_TYPES.PACK_GRANTED,
    actorType: HISTORY_ACTOR_TYPES.SYSTEM,
    source: HISTORY_SOURCES.WEEKLY_RESEARCH_PACK,
    actorUid,
    actorUsername: username,
    payload: {
      packId: String(packId || ''),
      quantity: Math.max(0, Math.floor(Number(quantity) || 0)),
      before: Math.max(0, Math.floor(Number(before) || 0)),
      after: Math.max(0, Math.floor(Number(after) || 0)),
      reason: 'weekly',
    },
  });
}

/**
 * True if every update key is under playerHistory/ (for future prune safety tests).
 * @param {Record<string, unknown>} updates
 */
export function updatesArePlayerHistoryOnly(updates) {
  const prefix = `${PLAYER_HISTORY_ROOT}/`;
  return Object.keys(updates || {}).every((k) => k === PLAYER_HISTORY_ROOT || k.startsWith(prefix));
}

/**
 * Sort query entries newest-first (push keys are chronological).
 * @param {Array<{ key: string, value?: unknown }>} entries
 */
export function sortHistoryEntriesNewestFirst(entries) {
  return [...(entries || [])].sort((a, b) => {
    const ka = String(a?.key || '');
    const kb = String(b?.key || '');
    if (ka < kb) return 1;
    if (ka > kb) return -1;
    return 0;
  });
}

/**
 * Merge an older page (limitToLast(51) + endAt(oldest)) into a newest-first list.
 * Drops the boundary duplicate key.
 *
 * @param {Array<{ key: string, value?: unknown }>} loadedNewestFirst
 * @param {Array<{ key: string, value?: unknown }>} pageEntries
 * @returns {{ entries: Array<{ key: string, value?: unknown }>, hasMore: boolean, added: number }}
 */
export function applyOlderHistoryPage(loadedNewestFirst, pageEntries) {
  const loaded = Array.isArray(loadedNewestFirst) ? loadedNewestFirst : [];
  const oldestKey = loaded.length ? String(loaded[loaded.length - 1].key) : null;
  const ascending = [...(pageEntries || [])].sort((a, b) => {
    const ka = String(a?.key || '');
    const kb = String(b?.key || '');
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
  const withoutBoundary = oldestKey
    ? ascending.filter((e) => String(e.key) !== oldestKey)
    : ascending;
  const olderNewestFirst = [...withoutBoundary].reverse();
  const seen = new Set(loaded.map((e) => String(e.key)));
  const next = [...loaded];
  let added = 0;
  for (const e of olderNewestFirst) {
    const k = String(e.key);
    if (seen.has(k)) continue;
    seen.add(k);
    next.push(e);
    added += 1;
  }
  const hasMore = ascending.length >= (HISTORY_PAGE_SIZE + 1) && withoutBoundary.length > 0;
  return { entries: next, hasMore, added };
}

/**
 * Human-readable absolute timestamp for Admin History UI.
 * Example: "August 30, 2026 at 6:42 PM"
 * @param {unknown} tsMs
 * @returns {string}
 */
export function formatHistoryTimestamp(tsMs) {
  const n = Number(tsMs);
  if (!Number.isFinite(n) || n <= 0) return 'Unknown time';
  try {
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return 'Unknown time';
    const datePart = d.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    const timePart = d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
    return `${datePart} at ${timePart}`;
  } catch {
    return 'Unknown time';
  }
}

/**
 * Load newest history page (once-query, no listener, no cache merge by default).
 * @param {string} username
 * @param {{ limit?: number }} [opts]
 */
export async function loadNewestPlayerHistoryPage(username, opts = {}) {
  const key = String(username || '').trim();
  const limit = Number.isFinite(Number(opts.limit)) ? Math.trunc(Number(opts.limit)) : HISTORY_PAGE_SIZE;
  const path = playerHistoryUserPath(key);
  const result = await db.loadPathQueryOnce(path, {
    orderByKey: true,
    limitToLast: limit,
  }, { mergeCache: false });
  if (!result.ok) {
    return { ok: false, entries: [], hasMore: false, error: result.error || 'Query failed' };
  }
  const newestFirst = sortHistoryEntriesNewestFirst(result.entries || []);
  return {
    ok: true,
    entries: newestFirst,
    hasMore: (result.entries || []).length >= limit,
    error: null,
  };
}

/**
 * Load older page using endAt(oldestKey) + limitToLast(pageSize+1).
 * @param {string} username
 * @param {string} oldestLoadedKey
 * @param {Array<{ key: string, value?: unknown }>} loadedNewestFirst
 * @param {{ limit?: number }} [opts]
 */
export async function loadOlderPlayerHistoryPage(username, oldestLoadedKey, loadedNewestFirst, opts = {}) {
  const key = String(username || '').trim();
  const oldest = String(oldestLoadedKey || '').trim();
  if (!key || !oldest) {
    return { ok: false, entries: loadedNewestFirst || [], hasMore: false, error: 'Missing cursor' };
  }
  const limit = Number.isFinite(Number(opts.limit))
    ? Math.trunc(Number(opts.limit))
    : HISTORY_PAGE_SIZE;
  const path = playerHistoryUserPath(key);
  const result = await db.loadPathQueryOnce(path, {
    orderByKey: true,
    endAt: oldest,
    limitToLast: limit + 1,
  }, { mergeCache: false });
  if (!result.ok) {
    return {
      ok: false,
      entries: loadedNewestFirst || [],
      hasMore: false,
      error: result.error || 'Query failed',
    };
  }
  const merged = applyOlderHistoryPage(loadedNewestFirst || [], result.entries || []);
  return {
    ok: true,
    entries: merged.entries,
    hasMore: merged.hasMore,
    added: merged.added,
    error: null,
  };
}
