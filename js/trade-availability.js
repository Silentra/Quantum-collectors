/**
 * trade-availability.js
 *
 * Hybrid availability model:
 *   - Projects: binary per cardId (one active project maximum per card identity)
 *   - Trades/listings: copy-aware reservations (inventory minus reserved copies)
 *
 * S5c-C: Research Projects resolve reservations via playerTradeIndex/{me} when verified;
 * Trading callers keep using buildAvailabilitySnapshot defaults (canonical trades/*).
 *
 * No inventory subtraction at reservation time — all math is derived.
 */

import * as db from './database.js';
import { PROJECT_STATES } from './project-state.js';
import {
  PLAYER_TRADE_INDEX_ROOT,
  getReservationIndexSource,
  isGlobalTradeIndexMetaCurrent,
  isPlayerTradeIndexReady,
} from './trade-index.js';
import * as metrics from './db-metrics.js';

/** @type {Set<string>} */
const _fallbackWarningsShown = new Set();

/**
 * Whether legacy root coexistence can supply canonical trade trees for fallback.
 * Personal isolation without a verified index → no silent zero; fail closed.
 * @returns {boolean}
 */
function _canUseCanonicalFallback() {
  try {
    if (typeof localStorage !== 'undefined'
      && localStorage.getItem('qc-personal-cache-isolation') === 'true') {
      return false;
    }
  } catch { /* ignore */ }
  // S1–S5: root once + on(value) remain the safety net (including local-only cache).
  return true;
}

function _isTradeIndexHydrating(username) {
  try {
    const report = typeof window !== 'undefined'
      && window.qcDbHydration
      && typeof window.qcDbHydration.getPlayerTradeIndexHydrationReport === 'function'
      ? window.qcDbHydration.getPlayerTradeIndexHydrationReport()
      : null;
    if (!report) return false;
    if (report.inFlight === true) return true;
    const key = String(username || '').trim().toLowerCase();
    if (report.username && key && report.username !== key) return false;
    return false;
  } catch {
    return false;
  }
}

function _recordResearchSource(source) {
  if (typeof metrics.recordTradeIndexLifecycle !== 'function') return;
  metrics.recordTradeIndexLifecycle({
    tag: `researchReservationSource:${source}`,
    ops: 0,
    ok: source === 'index' || source === 'canonical-fallback',
  });
  if (source === 'canonical-fallback' && typeof metrics.recordTradeIndexFallback === 'function') {
    metrics.recordTradeIndexFallback({ reason: 'index-unready-or-wrong-version' });
  }
  if (source === 'unavailable' && typeof metrics.recordTradeIndexFailClosed === 'function') {
    metrics.recordTradeIndexFailClosed({ reason: 'no-index-no-canonical-fallback' });
  }
}

function _warnFallbackOnce(reason) {
  const key = String(reason || 'default');
  if (_fallbackWarningsShown.has(key)) return;
  _fallbackWarningsShown.add(key);
  console.warn(
    `[TradeAvailability] Research using canonical-fallback (${key}). ` +
      'Resolve trade-index readiness before S7. Gameplay still correct under root coexistence.',
  );
}

/**
 * Owner listing index leaves omit ownerId — inject comparison/assignment-only copies.
 * @param {string} username
 * @param {object} listingMap
 * @returns {object}
 */
export function listingsWithOwnerIdForReservation(username, listingMap) {
  const key = String(username || '');
  const out = {};
  for (const [id, entry] of Object.entries(listingMap || {})) {
    if (!entry || typeof entry !== 'object') continue;
    out[id] = { ...entry, ownerId: key };
  }
  return out;
}

/**
 * Resolve reservation source for Research Projects (S5c-C).
 * @param {string} username
 * @param {{ forceUnavailable?: boolean }} [opts]
 * @returns {'index'|'canonical-fallback'|'unavailable'|'loading'}
 */
export function resolveResearchReservationSource(username, opts = {}) {
  const key = String(username || '').trim().toLowerCase();
  if (!key || key === '__admin__') return 'unavailable';

  const pathReady = db.isPathReady(`${PLAYER_TRADE_INDEX_ROOT}/${key}`);
  const hydrating = _isTradeIndexHydrating(key);

  const source = getReservationIndexSource(key, {
    scopePathReady: pathReady,
    hydrating,
    allowCanonicalFallback: _canUseCanonicalFallback(),
    forceUnavailable: opts.forceUnavailable === true,
  });

  if (source === 'canonical-fallback') {
    const reason = !isPlayerTradeIndexReady(key)
      ? 'player-meta-unready'
      : (!isGlobalTradeIndexMetaCurrent() ? 'global-schema-mismatch' : 'scope-path-unready');
    _warnFallbackOnce(reason);
  }

  _recordResearchSource(source);
  return source;
}

/**
 * Load current-player trade-index maps for reservation counting (no cache mutation).
 * @param {string} username
 * @returns {{ direct: object, listings: object }}
 */
export function loadPlayerTradeIndexReservationMaps(username) {
  const key = String(username || '').trim();
  const direct = db.get(`${PLAYER_TRADE_INDEX_ROOT}/${key}/direct`) || {};
  const rawListings = db.get(`${PLAYER_TRADE_INDEX_ROOT}/${key}/listings`) || {};
  return {
    direct,
    listings: listingsWithOwnerIdForReservation(key, rawListings),
  };
}

/**
 * Research Projects availability snapshot — uses verified index when ready.
 * Trading must keep calling buildAvailabilitySnapshot (canonical defaults).
 *
 * @param {string} username
 * @param {object} [opts] — same as buildAvailabilitySnapshot extras
 * @returns {AvailabilitySnapshot & { reservationSource: string }}
 */
export function buildResearchAvailabilitySnapshot(username, opts = {}) {
  const source = resolveResearchReservationSource(username);

  if (source === 'loading' || source === 'unavailable') {
    const playerData = opts.playerData ?? db.get(`players/${username}`);
    return {
      username,
      inventory: { ...(opts.inventory ?? playerData?.inventory ?? {}) },
      projects: opts.projects ?? playerData?.projects ?? [],
      tradeCounts: new Map(),
      excludeDirectTradeIds: opts.excludeDirectTradeIds ?? [],
      excludeListingIds: opts.excludeListingIds ?? [],
      reservationSource: source,
      reservationsTrusted: false,
    };
  }

  if (source === 'index') {
    const maps = loadPlayerTradeIndexReservationMaps(username);
    const snap = buildAvailabilitySnapshot(username, {
      ...opts,
      directTrades: maps.direct,
      listings: maps.listings,
    });
    snap.reservationSource = 'index';
    snap.reservationsTrusted = true;
    return snap;
  }

  // canonical-fallback — existing algorithm over trades/* (root coexistence)
  const snap = buildAvailabilitySnapshot(username, opts);
  snap.reservationSource = 'canonical-fallback';
  snap.reservationsTrusted = true;
  return snap;
}

// ─── Project uniqueness (binary per cardId) ───────────────────────────────────

/**
 * True when cardId appears in ANY ACTIVE project's assignments.
 * Projects consume the entire card identity — not per-copy slots.
 *
 * @param {string} cardId
 * @param {object[]} [projects]
 * @returns {boolean}
 */
export function isCardLockedByActiveProject(cardId, projects = []) {
  for (const project of projects) {
    if (project.state !== PROJECT_STATES.ACTIVE) continue;
    for (const id of project.assignedScientists ?? []) {
      if (id === cardId) return true;
    }
    for (const id of project.assignedConcepts ?? []) {
      if (id === cardId) return true;
    }
  }
  return false;
}

/**
 * @deprecated Use isCardLockedByActiveProject — projects are binary, not copy-counted.
 * @returns {number} 0 or 1
 */
export function countProjectCommittedCopies(cardId, projects = []) {
  return isCardLockedByActiveProject(cardId, projects) ? 1 : 0;
}

// ─── Trade reservation tallies (copy-aware) ───────────────────────────────────

/**
 * @typedef {{ outgoing: number, listing: number, incoming: number }} CardReservationBreakdown
 */

/**
 * Direct-trade statuses that reserve card copies.
 * Terminal statuses (accepted/declined/cancelled/failed) reserve nothing.
 */
export const ACTIVE_DIRECT_TRADE_STATUSES = new Set([
  'awaiting_target_response',
  'awaiting_offerer_confirmation',
  'processing',
]);

/**
 * @param {string} username
 * @param {object} [opts]
 * @param {object} [opts.directTrades]
 * @param {object} [opts.listings]
 * @param {number} [opts.now]
 * @param {string[]} [opts.excludeDirectTradeIds]
 * @param {string[]} [opts.excludeListingIds]
 * @returns {Map<string, CardReservationBreakdown>}
 */
export function buildTradeReservationCounts(username, {
  directTrades = null,
  listings = null,
  now = Date.now(),
  excludeDirectTradeIds = [],
  excludeListingIds = [],
} = {}) {
  const excludeDirect = new Set(excludeDirectTradeIds);
  const excludeListing = new Set(excludeListingIds);
  const counts = new Map();

  const bump = (cardId, field) => {
    if (!cardId) return;
    const cur = counts.get(cardId) ?? { outgoing: 0, listing: 0, incoming: 0 };
    cur[field]++;
    counts.set(cardId, cur);
  };

  const allDirect = directTrades ?? db.get('trades/direct') ?? {};
  for (const [tradeId, trade] of Object.entries(allDirect)) {
    if (!trade || !ACTIVE_DIRECT_TRADE_STATUSES.has(trade.status)) continue;
    if (excludeDirect.has(tradeId) || excludeDirect.has(trade.id)) continue;

    // awaiting_target_response: offered only
    // awaiting_offerer_confirmation / processing: offered + requested (if set)
    if (trade.offeringPlayerId === username) {
      bump(trade.offeredCardId, 'outgoing');
    }
    if (
      trade.targetPlayerId === username &&
      (trade.status === 'awaiting_offerer_confirmation' || trade.status === 'processing')
    ) {
      bump(trade.requestedCardId, 'incoming');
    }
  }

  // active + processing both reserve the creator's offered card (fulfill in flight).
  // Terminal statuses reserve nothing. excludeListingIds skips the listing under validation.
  const allListings = listings ?? db.get('trades/listings') ?? {};
  for (const [listingId, listing] of Object.entries(allListings)) {
    if (!listing) continue;
    if (listing.status !== 'active' && listing.status !== 'processing') continue;
    if (excludeListing.has(listingId) || excludeListing.has(listing.id)) continue;
    if (listing.expiresAt && now > listing.expiresAt) continue;
    if (listing.ownerId === username) {
      bump(listing.offeredCardId, 'listing');
    }
  }

  return counts;
}

/**
 * @param {Map<string, CardReservationBreakdown>} tradeCounts
 * @param {string} cardId
 * @returns {number}
 */
export function getTradeReservedCopies(tradeCounts, cardId) {
  const b = tradeCounts.get(cardId);
  if (!b) return 0;
  return b.outgoing + b.listing + b.incoming;
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} AvailabilitySnapshot
 * @property {string} username
 * @property {object} inventory
 * @property {object[]} projects
 * @property {Map<string, CardReservationBreakdown>} tradeCounts
 */

export function buildAvailabilitySnapshot(username, opts = {}) {
  const playerData = opts.playerData ?? db.get(`players/${username}`);
  return {
    username,
    inventory: { ...(opts.inventory ?? playerData?.inventory ?? {}) },
    projects: opts.projects ?? playerData?.projects ?? [],
    tradeCounts: buildTradeReservationCounts(username, {
      directTrades: opts.directTrades,
      listings: opts.listings,
      now: opts.now,
      excludeDirectTradeIds: opts.excludeDirectTradeIds ?? [],
      excludeListingIds: opts.excludeListingIds ?? [],
    }),
    excludeDirectTradeIds: opts.excludeDirectTradeIds ?? [],
    excludeListingIds: opts.excludeListingIds ?? [],
    reservationSource: opts.reservationSource || 'canonical',
    reservationsTrusted: opts.reservationsTrusted !== false,
  };
}

export function getOwnedCopyCount(snapshot, cardId) {
  return snapshot.inventory[cardId] || 0;
}

// ─── Trade availability (copy-aware) ──────────────────────────────────────────

/**
 * Copies available to offer in trade/listings.
 * One active project assignment consumes one physical copy; trade reservations consume copies.
 *
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @returns {number}
 */
export function getAvailableCopyCount(snapshot, cardId) {
  const owned = getOwnedCopyCount(snapshot, cardId);
  const projectCopy = isCardLockedByActiveProject(cardId, snapshot.projects) ? 1 : 0;
  const trade = getTradeReservedCopies(snapshot.tradeCounts, cardId);
  return Math.max(0, owned - projectCopy - trade);
}

export function canOfferCardInTrade(snapshot, cardId) {
  return getAvailableCopyCount(snapshot, cardId) >= 1;
}

export function isLastAvailableCopy(snapshot, cardId) {
  return getAvailableCopyCount(snapshot, cardId) === 1;
}

// ─── Project assignment availability (binary project + copy-aware trade) ──────

/**
 * Whether a cardId may be assigned to a new ACTIVE project.
 *   - Blocked if cardId is already on ANY active project (binary)
 *   - Blocked if trade reservations leave no free copy
 *
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @returns {boolean}
 */
export function canAssignCardToProject(snapshot, cardId) {
  if (snapshot?.reservationsTrusted === false) return false;
  if (snapshot?.reservationSource === 'unavailable' || snapshot?.reservationSource === 'loading') {
    return false;
  }
  if (isCardLockedByActiveProject(cardId, snapshot.projects)) return false;
  const owned = getOwnedCopyCount(snapshot, cardId);
  const trade = getTradeReservedCopies(snapshot.tradeCounts, cardId);
  return (owned - trade) >= 1;
}

export function isProjectAssignmentLocked(snapshot, cardId) {
  return !canAssignCardToProject(snapshot, cardId);
}

/**
 * Assignment-panel tooltip when the card cannot be assigned.
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @returns {string|null}
 */
export function getProjectAssignmentLockTooltip(snapshot, cardId) {
  if (snapshot?.reservationSource === 'loading') {
    return 'Checking card availability…';
  }
  if (snapshot?.reservationSource === 'unavailable' || snapshot?.reservationsTrusted === false) {
    return 'Trade reservation data is unavailable';
  }
  if (getOwnedCopyCount(snapshot, cardId) < 1) return null;

  if (isCardLockedByActiveProject(cardId, snapshot.projects)) {
    return 'Assigned to an active research project';
  }

  const owned = getOwnedCopyCount(snapshot, cardId);
  const trade = getTradeReservedCopies(snapshot.tradeCounts, cardId);
  if ((owned - trade) >= 1) return null;

  const b = snapshot.tradeCounts.get(cardId) ?? { outgoing: 0, listing: 0, incoming: 0 };
  if (b.incoming > 0) return 'Last remaining card is reserved for an incoming trade';
  if (b.listing > 0) return 'Last remaining card is listed for trade';
  if (b.outgoing > 0) return 'Last remaining card is offered in a trade';

  return 'No copies available';
}

/**
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @param {'offer'|'assign'} context
 * @returns {string|null}
 */
export function getAvailabilityFailureReason(snapshot, cardId, context = 'offer') {
  if (snapshot?.reservationSource === 'unavailable' || snapshot?.reservationsTrusted === false) {
    return 'TRADE_RESERVATION_DATA_UNAVAILABLE';
  }
  if (snapshot?.reservationSource === 'loading') {
    return 'TRADE_RESERVATION_DATA_LOADING';
  }

  if (context === 'assign') {
    if (isCardLockedByActiveProject(cardId, snapshot.projects)) {
      return 'locked_cards_present';
    }
    const owned = getOwnedCopyCount(snapshot, cardId);
    const trade = getTradeReservedCopies(snapshot.tradeCounts, cardId);
    if ((owned - trade) >= 1) return null;

    const b = snapshot.tradeCounts.get(cardId) ?? { outgoing: 0, listing: 0, incoming: 0 };
    if (b.incoming > 0) return 'CARD_RESERVED_BY_INCOMING_TRADE';
    if (b.listing > 0) return 'CARD_RESERVED_BY_LISTING';
    if (b.outgoing > 0) return 'CARD_RESERVED_BY_OUTGOING_TRADE';
    return 'INSUFFICIENT_AVAILABLE_COPIES';
  }

  // Trade / listing offer context — copy-aware including project copy consumption
  if (getAvailableCopyCount(snapshot, cardId) >= 1) return null;

  const b = snapshot.tradeCounts.get(cardId) ?? { outgoing: 0, listing: 0, incoming: 0 };
  if (b.incoming > 0) return 'CARD_RESERVED_BY_INCOMING_TRADE';
  if (b.listing > 0) return 'CARD_RESERVED_BY_LISTING';
  if (b.outgoing > 0) return 'CARD_RESERVED_BY_OUTGOING_TRADE';

  if (isCardLockedByActiveProject(cardId, snapshot.projects)) {
    return 'OFFERED_CARD_LOCKED_BY_PROJECT';
  }

  return 'INSUFFICIENT_AVAILABLE_COPIES';
}

export function validateCardsAssignableToProject(snapshot, cardIds) {
  for (const cardId of cardIds) {
    if (!cardId) continue;
    if (!canAssignCardToProject(snapshot, cardId)) {
      const reason = getAvailabilityFailureReason(snapshot, cardId, 'assign');
      return { valid: false, reason: reason ?? 'locked_cards_present', cardId };
    }
  }
  return { valid: true, reason: null };
}

/**
 * Card IDs with zero trade-available copies (for trade UI filtering).
 * @param {AvailabilitySnapshot} snapshot
 * @param {string[]} [cardIds]
 * @returns {Set<string>}
 */
export function getUnavailableCardIds(snapshot, cardIds = null) {
  const ids = cardIds ?? Object.keys(snapshot.inventory);
  const out = new Set();
  for (const cardId of ids) {
    if (getAvailableCopyCount(snapshot, cardId) < 1) out.add(cardId);
  }
  return out;
}

export function countHiddenByReservations(snapshot, ownedTradableCardIds) {
  let hidden = 0;
  for (const cardId of ownedTradableCardIds) {
    const owned = getOwnedCopyCount(snapshot, cardId);
    if (owned < 1) continue;
    if (getAvailableCopyCount(snapshot, cardId) < 1) hidden++;
  }
  return hidden;
}
