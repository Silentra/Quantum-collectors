/**
 * Trade Listings Module — Phase T-4
 *
 * Anonymous trade listing lifecycle: create, cancel, accept, query, expire.
 * Listings are stored at /trades/listings/{listingId}.
 * Inventory mutation is delegated to trade-listing-execution.js.
 *
 * Rules:
 *   - Max 1 active listing per player
 *   - Listings are group-scoped and anonymous
 *   - requestedCardIds: 1–3 exact card IDs, all must match offered card rarity
 *   - Listings expire after configurable duration
 *   - Hidden players MAY create and accept listings
 *   - Manual cancellation does NOT remove posting cooldown
 */

import * as db from './database.js';
import * as config from './config.js';
import { validateListingTrade, isCardTradable, isTradingEnabled, isListingsEnabled, isDetailedLogging } from './trading.js';
import { executeListingTrade } from './trade-listing-execution.js';
import { getPlayerLockedCardIds } from './trade-lock-helpers.js';

// ─── Helpers ─────────────────────────────────���──────────────────────────────

function _normalizePlayer(p) {
  if (!p) return p;
  return { ...p, groupId: p.groupId || p.group || null };
}

/**
 * Get listing expiration duration in ms from config.
 * Default: 24 hours.
 */
function _getListingExpirationMs() {
  const hours = config.getValue('economy.listingExpirationHours');
  return (typeof hours === 'number' ? hours : 24) * 60 * 60 * 1000;
}

/**
 * Get listing cooldown in minutes from config.
 * Default: 30 minutes.
 */
function _getListingCooldownMinutes() {
  const val = config.getValue('economy.listingCooldownMinutes');
  return typeof val === 'number' ? val : 30;
}

/**
 * Get max active listings per player from config.
 * Default: 1.
 */
function _getMaxActiveListings() {
  const val = config.getValue('economy.maxActiveListingsPerPlayer');
  return typeof val === 'number' && val >= 1 ? Math.floor(val) : 1;
}

/** Exported accessor for UI to read max active listings. */
export function getMaxActiveListingsPerPlayer() {
  return _getMaxActiveListings();
}

/**
 * Check whether a player is on listing cooldown.
 * Returns { onCooldown, remainingMs, readyAt }
 */
export function getListingCooldown(username) {
  const p = db.get(`players/${username}`);
  if (!p) return { onCooldown: false, remainingMs: 0, readyAt: 0 };

  const lastListingAt = p.lastListingCreatedAt || 0;
  const cooldownMs = _getListingCooldownMinutes() * 60 * 1000;
  const readyAt = lastListingAt + cooldownMs;
  const now = Date.now();

  if (now >= readyAt) return { onCooldown: false, remainingMs: 0, readyAt };
  return { onCooldown: true, remainingMs: readyAt - now, readyAt };
}

// ─── Expire stale listings ──────────────────────────────────────────────────

/**
 * Scan all active listings and expire any past their expiresAt.
 * Safe to call frequently (e.g., on tab render). No-op if nothing to expire.
 */
export function expireStaleListings() {
  const allListings = db.get('trades/listings') || {};
  const now = Date.now();
  let expired = 0;

  for (const [id, listing] of Object.entries(allListings)) {
    if (!listing || listing.status !== 'active') continue;
    if (listing.expiresAt && now > listing.expiresAt) {
      db.update(`trades/listings/${id}`, {
        status: 'expired',
        respondedAt: now,
      });
      expired++;
    }
  }

  if (expired > 0) {
    console.log(`[Listings] Expired ${expired} stale listing(s)`);
  }
}

// ─── Listing Lifecycle ───────��──────────────────────────────────────────────

/**
 * Create an anonymous trade listing.
 *
 * @param {string}   ownerId         - Username of the listing creator
 * @param {string}   offeredCardId   - Card the owner is offering
 * @param {string[]} requestedCardIds - 1–3 card IDs the owner would accept (any ONE fulfills)
 * @returns {{ success: boolean, listingId?: string, reason?: string }}
 */
export function createListing(ownerId, offeredCardId, requestedCardIds) {
  // Phase T-8: Global / listing toggle enforcement
  if (!isTradingEnabled()) return { success: false, reason: 'TRADING_DISABLED' };
  if (!isListingsEnabled()) return { success: false, reason: 'LISTINGS_DISABLED' };

  // ── 1. Basic input validation ──────────────────────────────────────────────
  if (!Array.isArray(requestedCardIds) || requestedCardIds.length < 1 || requestedCardIds.length > 3) {
    return { success: false, reason: 'INVALID_REQUESTED_CARDS_COUNT' };
  }

  // Check uniqueness
  const uniqueIds = new Set(requestedCardIds);
  if (uniqueIds.size !== requestedCardIds.length) {
    return { success: false, reason: 'DUPLICATE_REQUESTED_CARDS' };
  }

  // Offered card cannot be in requested list
  if (requestedCardIds.includes(offeredCardId)) {
    return { success: false, reason: 'OFFERED_CARD_IN_REQUESTED' };
  }

  // ── 2. Player checks ──────────────────────────────────────────────────────
  const freshOwner = db.get(`players/${ownerId}`);
  if (!freshOwner) return { success: false, reason: 'OWNER_NOT_FOUND' };

  const owner = _normalizePlayer(freshOwner);
  if (owner.isTradeRestricted) return { success: false, reason: 'OWNER_TRADE_RESTRICTED' };

  const ownerGroup = owner.groupId;
  if (!ownerGroup) return { success: false, reason: 'OWNER_NO_GROUP' };

  // ── 3. Cooldown check ─────────────────────────────────────────────────────
  const cooldown = getListingCooldown(ownerId);
  if (cooldown.onCooldown) {
    return { success: false, reason: 'LISTING_ON_COOLDOWN' };
  }

  // ── 4. Max active listings per player (config-driven) ────────────────────
  const maxListings = _getMaxActiveListings();
  const allListings = db.get('trades/listings') || {};
  let activeCount = 0;
  for (const listing of Object.values(allListings)) {
    if (listing && listing.ownerId === ownerId && listing.status === 'active') {
      activeCount++;
    }
  }
  if (activeCount >= maxListings) {
    return { success: false, reason: 'MAX_ACTIVE_LISTINGS_REACHED' };
  }

  // ── 5. Card validation ─────────────────────────────────────────────────────
  const allCards = db.get('cards') || {};

  // Offered card must exist, be enabled, and be tradable
  const offeredCard = allCards[offeredCardId];
  if (!offeredCard) return { success: false, reason: 'OFFERED_CARD_NOT_FOUND' };
  if (offeredCard.enabled === false) return { success: false, reason: 'OFFERED_CARD_DISABLED' };
  if (!isCardTradable(offeredCard)) return { success: false, reason: 'OFFERED_CARD_NOT_TRADABLE' };

  // Owner must own the offered card
  const ownerInv = owner.inventory || {};
  if ((ownerInv[offeredCardId] || 0) < 1) {
    return { success: false, reason: 'OWNER_MISSING_OFFERED_CARD' };
  }

  // Offered card must not be locked by an active research project
  const lockedSet = getPlayerLockedCardIds(ownerId);
  if (lockedSet.has(offeredCardId)) {
    return { success: false, reason: 'OFFERED_CARD_LOCKED_BY_PROJECT' };
  }

  // All requested cards must exist, be tradable, and match offered rarity
  for (const reqId of requestedCardIds) {
    const reqCard = allCards[reqId];
    if (!reqCard) return { success: false, reason: `REQUESTED_CARD_NOT_FOUND:${reqId}` };
    if (reqCard.enabled === false) return { success: false, reason: `REQUESTED_CARD_DISABLED:${reqId}` };
    if (!isCardTradable(reqCard)) return { success: false, reason: `REQUESTED_CARD_NOT_TRADABLE:${reqId}` };
    if (reqCard.rarity !== offeredCard.rarity) {
      return { success: false, reason: `RARITY_MISMATCH:${reqId}` };
    }
  }

  // ── 6. Create listing record ───────────────────────────────────────────────
  const now = Date.now();
  const expiresAt = now + _getListingExpirationMs();

  const listingId = db.push('trades/listings', {
    ownerId,
    offeredCardId,
    requestedCardIds,
    createdAt: now,
    expiresAt,
    groupId: ownerGroup,
    status: 'active',
  });

  // Store id inside the record
  db.set(`trades/listings/${listingId}/id`, listingId);

  // Set listing cooldown (even though listing is active, cooldown starts now)
  db.set(`players/${ownerId}/lastListingCreatedAt`, now);

  if (isDetailedLogging()) {
    console.log(`[Listings][DETAIL] Listing ${listingId} created by ${ownerId}: offers ${offeredCardId}, wants [${requestedCardIds.join(', ')}], group=${ownerGroup}, expires=${new Date(expiresAt).toISOString()}`);
  } else {
    console.log(`[Listings] Listing ${listingId} created by ${ownerId}: offers ${offeredCardId}, wants [${requestedCardIds.join(', ')}]`);
  }
  return { success: true, listingId };
}

/**
 * Cancel an active listing (by the owner).
 * NOTE: Does NOT remove the posting cooldown.
 *
 * @param {string} listingId
 * @param {string} cancellingPlayerId
 * @returns {{ success: boolean, reason?: string }}
 */
export function cancelListing(listingId, cancellingPlayerId) {
  // Phase T-8: Global toggle check (allow cancellation even if listings disabled — player should be able to clean up)
  const listing = db.get(`trades/listings/${listingId}`);
  if (!listing) return { success: false, reason: 'LISTING_NOT_FOUND' };
  if (listing.status !== 'active') return { success: false, reason: 'LISTING_NOT_ACTIVE' };
  if (listing.ownerId !== cancellingPlayerId) return { success: false, reason: 'NOT_LISTING_OWNER' };

  db.update(`trades/listings/${listingId}`, {
    status: 'cancelled',
    respondedAt: Date.now(),
  });

  if (isDetailedLogging()) {
    console.log(`[Listings][DETAIL] Listing ${listingId} cancelled by ${cancellingPlayerId}, offeredCard=${listing.offeredCardId}`);
  } else {
    console.log(`[Listings] Listing ${listingId} cancelled by ${cancellingPlayerId}`);
  }
  return { success: true };
}

/**
 * Accept an active listing by providing one of the requested cards.
 *
 * @param {string} listingId
 * @param {string} accepterId
 * @param {string} chosenCardId - Must be one of listing.requestedCardIds that the accepter owns
 * @returns {{ success: boolean, reason?: string }}
 */
export function acceptListing(listingId, accepterId, chosenCardId) {
  // Phase T-8: Global / listing toggle enforcement
  if (!isTradingEnabled()) return { success: false, reason: 'TRADING_DISABLED' };
  if (!isListingsEnabled()) return { success: false, reason: 'LISTINGS_DISABLED' };

  const listing = db.get(`trades/listings/${listingId}`);
  if (!listing) return { success: false, reason: 'LISTING_NOT_FOUND' };
  if (listing.status !== 'active') return { success: false, reason: 'LISTING_NOT_ACTIVE' };

  // Check expiry
  if (listing.expiresAt && Date.now() > listing.expiresAt) {
    db.update(`trades/listings/${listingId}`, { status: 'expired', respondedAt: Date.now() });
    return { success: false, reason: 'LISTING_EXPIRED' };
  }

  // Cannot accept own listing
  if (accepterId === listing.ownerId) {
    return { success: false, reason: 'SELF_TRADE' };
  }

  // Accepter trade restriction check
  const freshAccepter = db.get(`players/${accepterId}`);
  if (!freshAccepter) return { success: false, reason: 'ACCEPTER_NOT_FOUND' };
  if (freshAccepter.isTradeRestricted) return { success: false, reason: 'ACCEPTER_TRADE_RESTRICTED' };

  // Delegate to isolated listing execution
  return executeListingTrade(listing, accepterId, chosenCardId);
}

// ─── Queries ────────────────────────────────────────────────────────────────

/**
 * Get all active listings visible to a specific player (same group, not own).
 *
 * @param {string} username
 * @returns {object[]} Array of listing objects (anonymous — ownerId NOT exposed to UI)
 */
export function getVisibleListings(username) {
  const me = db.get(`players/${username}`);
  if (!me) return [];
  const myGroup = me.groupId || me.group || null;
  if (!myGroup) return [];

  const allListings = db.get('trades/listings') || {};
  const now = Date.now();
  const result = [];

  for (const listing of Object.values(allListings)) {
    if (!listing || listing.status !== 'active') continue;
    if (listing.groupId !== myGroup) continue;
    // Don't show expired listings
    if (listing.expiresAt && now > listing.expiresAt) continue;
    // Include own listings (so owner can see/cancel them)
    result.push(listing);
  }

  // Sort newest first
  result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return result;
}

/**
 * Get the active listing for a specific player (max 1).
 * @deprecated Use getMyActiveListings() for multi-listing support.
 *
 * @param {string} username
 * @returns {object|null}
 */
export function getMyActiveListing(username) {
  const all = getMyActiveListings(username);
  return all.length > 0 ? all[0] : null;
}

/**
 * Get ALL active listings for a specific player.
 * Returns newest-first. Respects maxActiveListingsPerPlayer config.
 *
 * @param {string} username
 * @returns {object[]}
 */
export function getMyActiveListings(username) {
  const allListings = db.get('trades/listings') || {};
  const result = [];
  for (const listing of Object.values(allListings)) {
    if (listing && listing.ownerId === username && listing.status === 'active') {
      result.push(listing);
    }
  }
  // Sort newest first
  result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return result;
}
