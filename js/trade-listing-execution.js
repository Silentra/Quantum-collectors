/**
 * Trade Listing Execution Module — Phase T-4
 *
 * Isolated helper for atomic listing-trade card swaps.
 * Same architecture as trade-execution.js but for anonymous listings.
 *
 * All inventory mutation for listing trades is contained here.
 * UI handlers must NEVER directly modify inventories.
 *
 * Responsibilities:
 *   - Reload fresh state from DB
 *   - Rerun T-1 listing validation with fresh data
 *   - Concurrency guard (prevent duplicate acceptance)
 *   - Decrement/increment inventories atomically
 *   - Clean up zero-quantity entries
 *   - Apply cooldown timestamps
 *   - Increment stats.tradesCompleted for both players
 */

import * as db from './database.js';
import * as config from './config.js';
import { bumpPlayerStat, notifyCardInventoryChanged, STAT_KEYS } from './achievements.js';
import { validateListingTrade, isDetailedLogging } from './trading.js';
import { getPlayerLockedCardIds } from './trade-lock-helpers.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function _normalizePlayer(p) {
  if (!p) return p;
  return { ...p, groupId: p.groupId || p.group || null };
}

/**
 * Get listing-accept cooldown info for a player.
 * Listing acceptance uses its own separate cooldown field (lastListingAcceptAt)
 * and config key (economy.listingAcceptCooldownMinutes).
 */
function _getListingAcceptCooldownMinutes() {
  const val = config.getValue('economy.listingAcceptCooldownMinutes');
  return typeof val === 'number' ? val : 30;
}

function _getListingAcceptCooldown(username) {
  const p = db.get(`players/${username}`);
  if (!p) return { onCooldown: false, remainingMs: 0, readyAt: 0 };

  const lastAcceptAt = p.lastListingAcceptAt || 0;
  const cooldownMs = _getListingAcceptCooldownMinutes() * 60 * 1000;
  const readyAt = lastAcceptAt + cooldownMs;
  const now = Date.now();

  if (now >= readyAt) return { onCooldown: false, remainingMs: 0, readyAt };
  return { onCooldown: true, remainingMs: readyAt - now, readyAt };
}

// ─── Public cooldown accessors (thin wrappers over private helpers) ──────────

export function getListingAcceptCooldown(username) {
  return _getListingAcceptCooldown(username);
}

export function getListingAcceptCooldownMinutes() {
  return _getListingAcceptCooldownMinutes();
}

// ─── Atomic Listing Execution ───────────────────────────────────────────────

/**
 * Execute a listing trade atomically.
 *
 * This is the ONLY function that mutates inventories for listing trades.
 *
 * @param {object} listing   - The listing object from /trades/listings/{id}
 * @param {string} accepterId - Username of the player accepting the listing
 * @param {string} chosenCardId - The card the accepter is providing
 *
 * @returns {{ success: boolean, reason?: string }}
 */
export function executeListingTrade(listing, accepterId, chosenCardId) {
  const listingId = listing.id;

  // ── 0. Concurrency guard — reload listing & verify still active ────────
  const freshListing = db.get(`trades/listings/${listingId}`);
  if (!freshListing || freshListing.status !== 'active') {
    console.log(`[Listings] Listing ${listingId} skipped — status is '${freshListing?.status}', not 'active'`);
    return { success: false, reason: 'LISTING_NOT_ACTIVE' };
  }

  // Check expiry
  if (freshListing.expiresAt && Date.now() > freshListing.expiresAt) {
    db.update(`trades/listings/${listingId}`, { status: 'expired', respondedAt: Date.now() });
    return { success: false, reason: 'LISTING_EXPIRED' };
  }

  const ownerId = freshListing.ownerId;

  // ── 1. Reload fresh player state ──────────────────────────────────────────
  const freshOwner = db.get(`players/${ownerId}`);
  const freshAccepter = db.get(`players/${accepterId}`);

  if (!freshOwner) return { success: false, reason: 'LISTING_OWNER_NOT_FOUND' };
  if (!freshAccepter) return { success: false, reason: 'ACCEPTER_NOT_FOUND' };

  // ── 2. Reload all card definitions ────────────────────────────────────────
  const allCards = db.get('cards') || {};

  // ── 3. Rerun T-1 listing validation with fresh data (includes project-lock check) ──
  const players = {
    [ownerId]:    { ..._normalizePlayer(freshOwner),    _lockedCardIds: getPlayerLockedCardIds(ownerId) },
    [accepterId]: { ..._normalizePlayer(freshAccepter), _lockedCardIds: getPlayerLockedCardIds(accepterId) },
  };

  const validation = validateListingTrade({
    listing: freshListing,
    accepterId,
    chosenCardId,
    players,
    cards: allCards,
  });

  if (!validation.valid) {
    if (isDetailedLogging()) {
      console.log(`[Listings][DETAIL] Listing ${listingId} failed validation: ${validation.reason} (owner=${ownerId}, accepter=${accepterId}, chosen=${chosenCardId})`);
    }
    // Mark listing as failed in DB
    db.update(`trades/listings/${listingId}`, {
      status: 'failed',
      respondedAt: Date.now(),
      failureReason: validation.reason,
    });
    return { success: false, reason: validation.reason };
  }

  // ── 4. Check listing-accept cooldown for the accepter ───────────────────
  // Only the accepter receives a listing-accept cooldown; the owner is simply
  // fulfilling their posted listing and is never subject to this cooldown.
  const accepterCooldown = _getListingAcceptCooldown(accepterId);
  if (accepterCooldown.onCooldown) {
    db.update(`trades/listings/${listingId}`, { status: 'failed', respondedAt: Date.now(), failureReason: 'ACCEPTER_ON_COOLDOWN' });
    return { success: false, reason: 'ACCEPTER_ON_COOLDOWN' };
  }

  // ── 5. Compute new inventories (no DB writes yet) ─────────────────────────
  const offeredCardId = freshListing.offeredCardId;

  const ownerInv = { ...(freshOwner.inventory || {}) };
  const accepterInv = { ...(freshAccepter.inventory || {}) };

  // Owner loses offered card, gains chosen card
  ownerInv[offeredCardId] = (ownerInv[offeredCardId] || 0) - 1;
  if (ownerInv[offeredCardId] <= 0) delete ownerInv[offeredCardId];
  ownerInv[chosenCardId] = (ownerInv[chosenCardId] || 0) + 1;

  // Accepter loses chosen card, gains offered card
  accepterInv[chosenCardId] = (accepterInv[chosenCardId] || 0) - 1;
  if (accepterInv[chosenCardId] <= 0) delete accepterInv[chosenCardId];
  accepterInv[offeredCardId] = (accepterInv[offeredCardId] || 0) + 1;

  // ── 6. Prepare stats updates ──────────────────────────────────────────────
  const ownerStats = { ...(freshOwner.stats || {}) };
  const accepterStats = { ...(freshAccepter.stats || {}) };

  const now = Date.now();

  // ── 7. Write ALL mutations together ────────────────────────���──────────────
  // Lock listing as 'processing' before any inventory writes
  db.update(`trades/listings/${listingId}`, { status: 'processing' });

  // Owner: inventory + stats + progression (no listing-accept cooldown)
  db.set(`players/${ownerId}/inventory`, ownerInv);
  db.set(`players/${ownerId}/stats`, ownerStats);
  db.update(`players/${ownerId}/progression`, { firstTrade: true });

  // Accepter: inventory + stats + listing-accept cooldown + progression
  db.set(`players/${accepterId}/inventory`, accepterInv);
  db.set(`players/${accepterId}/stats`, accepterStats);
  db.set(`players/${accepterId}/lastListingAcceptAt`, now);
  db.update(`players/${accepterId}/progression`, { firstTrade: true });

  // ── 8. Mark listing as fulfilled ──────────────────────────────────────────
  db.update(`trades/listings/${listingId}`, {
    status: 'fulfilled',
    respondedAt: now,
    fulfilledBy: accepterId,
    fulfilledCardId: chosenCardId,
  });

  bumpPlayerStat(ownerId, STAT_KEYS.TRADES_COMPLETED, 1);
  bumpPlayerStat(accepterId, STAT_KEYS.TRADES_COMPLETED, 1);
  notifyCardInventoryChanged(ownerId);
  notifyCardInventoryChanged(accepterId);

  if (isDetailedLogging()) {
    console.log(`[Listings][DETAIL] Listing ${listingId} fulfilled: ${ownerId} gave ${offeredCardId}, ${accepterId} gave ${chosenCardId}, accepter cooldown applied at ${now}`);
  } else {
    console.log(`[Listings] Listing ${listingId} fulfilled: ${ownerId} gave ${offeredCardId}, ${accepterId} gave ${chosenCardId}`);
  }

  return { success: true };
}
