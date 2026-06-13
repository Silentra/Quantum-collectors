/**
 * trade-availability.js
 *
 * Hybrid availability model:
 *   - Projects: binary per cardId (one active project maximum per card identity)
 *   - Trades/listings: copy-aware reservations (inventory minus reserved copies)
 *
 * No inventory subtraction at reservation time — all math is derived.
 */

import * as db from './database.js';
import { PROJECT_STATES } from './project-state.js';

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
    if (!trade || trade.status !== 'pending') continue;
    if (excludeDirect.has(tradeId) || excludeDirect.has(trade.id)) continue;
    if (trade.offeringPlayerId === username) {
      bump(trade.offeredCardId, 'outgoing');
    }
    if (trade.targetPlayerId === username) {
      bump(trade.requestedCardId, 'incoming');
    }
  }

  const allListings = listings ?? db.get('trades/listings') ?? {};
  for (const [listingId, listing] of Object.entries(allListings)) {
    if (!listing || listing.status !== 'active') continue;
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
