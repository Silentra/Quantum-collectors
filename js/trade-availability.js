/**
 * trade-availability.js
 *
 * Copy-aware card availability derived from inventory minus reservations.
 * No inventory subtraction at reservation time — same model as project locks.
 *
 * Reservations counted:
 *   - ACTIVE project assignments (per card ID occurrence)
 *   - Pending direct trades (outgoing offered + incoming requested)
 *   - Active non-expired marketplace listings (offered card)
 */

import * as db from './database.js';
import { PROJECT_STATES } from './project-state.js';

// ─── Pure: project commitment ───────────────────────────────────────────────

/**
 * Count how many ACTIVE project slots reference a card ID.
 * @param {string} cardId
 * @param {object[]} [projects]
 * @returns {number}
 */
export function countProjectCommittedCopies(cardId, projects = []) {
  let count = 0;
  for (const project of projects) {
    if (project.state !== PROJECT_STATES.ACTIVE) continue;
    for (const id of project.assignedScientists ?? []) {
      if (id === cardId) count++;
    }
    for (const id of project.assignedConcepts ?? []) {
      if (id === cardId) count++;
    }
  }
  return count;
}

// ─── Pure: trade reservation tallies ──────────────────────────────────────────

/**
 * Per-card reservation breakdown for a player.
 * @typedef {{ outgoing: number, listing: number, incoming: number }} CardReservationBreakdown
 */

/**
 * Aggregate trade/listing reservations from trade records.
 *
 * @param {string} username
 * @param {object} [opts]
 * @param {object} [opts.directTrades] - map of tradeId → trade
 * @param {object} [opts.listings] - map of listingId → listing
 * @param {number} [opts.now] - timestamp for expiry checks
 * @param {string[]} [opts.excludeDirectTradeIds] - pending trades to ignore (e.g. trade being accepted)
 * @param {string[]} [opts.excludeListingIds] - active listings to ignore (e.g. listing being fulfilled)
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
 * Total trade-side reserved copies for a card (outgoing + listing + incoming).
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
 * @property {object} inventory - { cardId: qty }
 * @property {object[]} projects
 * @property {Map<string, CardReservationBreakdown>} tradeCounts
 * @property {string[]} [excludeDirectTradeIds]
 * @property {string[]} [excludeListingIds]
 */

/**
 * Build a fresh availability snapshot for a player (DB reads unless overridden).
 *
 * @param {string} username
 * @param {object} [opts]
 * @param {object} [opts.playerData]
 * @param {object} [opts.directTrades]
 * @param {object} [opts.listings]
 * @param {number} [opts.now]
 * @param {string[]} [opts.excludeDirectTradeIds]
 * @param {string[]} [opts.excludeListingIds]
 * @returns {AvailabilitySnapshot}
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

/**
 * Available copies for a card after project + trade reservations.
 *
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @returns {number}
 */
export function getAvailableCopyCount(snapshot, cardId) {
  const owned = snapshot.inventory[cardId] || 0;
  const project = countProjectCommittedCopies(cardId, snapshot.projects);
  const trade = getTradeReservedCopies(snapshot.tradeCounts, cardId);
  return Math.max(0, owned - project - trade);
}

/**
 * Owned quantity (ignoring reservations).
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @returns {number}
 */
export function getOwnedCopyCount(snapshot, cardId) {
  return snapshot.inventory[cardId] || 0;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

/**
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @returns {boolean}
 */
export function canOfferCardInTrade(snapshot, cardId) {
  return getAvailableCopyCount(snapshot, cardId) >= 1;
}

/**
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @returns {boolean}
 */
export function canAssignCardToProject(snapshot, cardId) {
  return getAvailableCopyCount(snapshot, cardId) >= 1;
}

/**
 * True when this card is the player's last *available* copy for trade warnings.
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @returns {boolean}
 */
export function isLastAvailableCopy(snapshot, cardId) {
  return getAvailableCopyCount(snapshot, cardId) === 1;
}

/**
 * Assignment-panel tooltip when availableCopies === 0.
 * Trade-specific copy only when trade reservation consumes the last copy.
 *
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @returns {string|null}
 */
export function getProjectAssignmentLockTooltip(snapshot, cardId) {
  if (getAvailableCopyCount(snapshot, cardId) > 0) return null;

  const owned = getOwnedCopyCount(snapshot, cardId);
  if (owned < 1) return null;

  const b = snapshot.tradeCounts.get(cardId) ?? { outgoing: 0, listing: 0, incoming: 0 };
  if (b.incoming > 0) return 'Last remaining card is reserved for an incoming trade';
  if (b.listing > 0) return 'Last remaining card is listed for trade';
  if (b.outgoing > 0) return 'Last remaining card is offered in a trade';

  const project = countProjectCommittedCopies(cardId, snapshot.projects);
  if (project > 0) return 'Assigned to an active research project';

  return 'No copies available';
}

/**
 * Reason code for failed trade/project mutations.
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @param {'offer'|'assign'|'accept'} context
 * @returns {string|null}
 */
export function getAvailabilityFailureReason(snapshot, cardId, context = 'offer') {
  if (getAvailableCopyCount(snapshot, cardId) >= 1) return null;

  const b = snapshot.tradeCounts.get(cardId) ?? { outgoing: 0, listing: 0, incoming: 0 };
  if (b.incoming > 0) return 'CARD_RESERVED_BY_INCOMING_TRADE';
  if (b.listing > 0) return 'CARD_RESERVED_BY_LISTING';
  if (b.outgoing > 0) return 'CARD_RESERVED_BY_OUTGOING_TRADE';

  const project = countProjectCommittedCopies(cardId, snapshot.projects);
  if (project > 0) {
    return context === 'assign' ? 'locked_cards_present' : 'OFFERED_CARD_LOCKED_BY_PROJECT';
  }

  return 'INSUFFICIENT_AVAILABLE_COPIES';
}

/**
 * Validate multiple card IDs for project assignment (each needs >= 1 available).
 *
 * @param {AvailabilitySnapshot} snapshot
 * @param {string[]} cardIds
 * @returns {{ valid: boolean, reason: string|null, cardId?: string }}
 */
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
 * Cards with zero available copies (any reason).
 * @param {AvailabilitySnapshot} snapshot
 * @param {string[]} [cardIds] - if omitted, scans all owned card IDs
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

/**
 * Count owned tradable cards hidden from offer pickers (available < 1 but owned >= 1).
 * @param {AvailabilitySnapshot} snapshot
 * @param {string[]} ownedTradableCardIds
 * @returns {number}
 */
export function countHiddenByReservations(snapshot, ownedTradableCardIds) {
  let hidden = 0;
  for (const cardId of ownedTradableCardIds) {
    const owned = getOwnedCopyCount(snapshot, cardId);
    if (owned < 1) continue;
    if (getAvailableCopyCount(snapshot, cardId) < 1) hidden++;
  }
  return hidden;
}
