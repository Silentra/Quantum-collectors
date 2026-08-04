/**
 * Trade Listing Execution Module — Phase T-4
 *
 * Isolated helper for listing-trade card swaps.
 * Fulfillment uses two acknowledged writes:
 *   1) claimListingIfActive (active → processing)
 *   2) updateAcknowledged fulfill (inventories + fulfilled)
 *
 * UI handlers must NEVER directly modify inventories.
 *
 * Cooldown (preserved):
 *   - accepter: lastListingAcceptAt on successful fulfill
 *   - owner: no fulfill cooldown
 *   - no lastDirectTradeAt on listing fulfill
 */

import * as db from './database.js';
import * as config from './config.js';
import { validateListingTrade, isDetailedLogging } from './trading.js';
import {
  buildListingFulfillPlan,
  commitListingFulfillPlan,
} from './trade-listing-plan.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function _normalizePlayer(p) {
  if (!p) return p;
  return { ...p, groupId: p.groupId || p.group || null };
}

function _newClaimId(accepterId) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${accepterId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

async function _releaseOwnedClaim(listingId, claimId, reason) {
  const release = await db.releaseListingClaimIfOwned(listingId, claimId);
  if (!release.ok) {
    console.warn(`[Listings] Failed to release claim ${claimId} on ${listingId}:`, release.error);
  } else if (release.released && isDetailedLogging()) {
    console.log(`[Listings][DETAIL] Released claim ${claimId} on ${listingId} (${reason})`);
  }
  return release;
}

// ─── Atomic Listing Execution ───────────────────────────────────────────────

/**
 * Execute a listing trade (claim + fulfill).
 *
 * This is the ONLY function that mutates inventories for listing trades.
 *
 * @param {object} listing   - The listing object from /trades/listings/{id}
 * @param {string} accepterId - Username of the player accepting the listing
 * @param {string} chosenCardId - The card the accepter is providing
 *
 * @returns {Promise<{ success: boolean, reason?: string, notifiedAccepter?: string[], stale?: boolean, uncertain?: boolean }>}
 */
export async function executeListingTrade(listing, accepterId, chosenCardId) {
  const listingId = listing.id;
  const now = Date.now();
  const claimId = _newClaimId(accepterId);

  // ── 0. Cache pre-checks (no network) ──────────────────────────────────────
  const freshListing = db.get(`trades/listings/${listingId}`);
  if (!freshListing || freshListing.status !== 'active') {
    console.log(`[Listings] Listing ${listingId} skipped — status is '${freshListing?.status}', not 'active'`);
    return { success: false, reason: 'LISTING_NOT_ACTIVE', stale: true };
  }

  if (freshListing.expiresAt && now > freshListing.expiresAt) {
    // Expire only while still active — never overwrite terminals
    const still = db.get(`trades/listings/${listingId}`);
    if (still && still.status === 'active') {
      db.update(`trades/listings/${listingId}`, { status: 'expired', respondedAt: now });
    }
    return { success: false, reason: 'LISTING_EXPIRED' };
  }

  const accepterCooldown = _getListingAcceptCooldown(accepterId);
  if (accepterCooldown.onCooldown) {
    // Do not claim or destroy the listing for other students
    return { success: false, reason: 'ACCEPTER_ON_COOLDOWN' };
  }

  // ── 1. Server claim: active → processing ──────────────────────────────────
  const claim = await db.claimListingIfActive(listingId, {
    accepterId,
    chosenCardId,
    claimId,
    now,
  });

  if (!claim.ok) {
    return {
      success: false,
      reason: 'WRITE_FAILED',
      error: claim.error || 'Could not claim listing',
    };
  }
  if (!claim.claimed) {
    return {
      success: false,
      reason: claim.reason || 'LISTING_NOT_ACTIVE',
      stale: true,
      currentStatus: claim.listing?.status ?? null,
    };
  }

  const claimedListing = claim.listing || db.get(`trades/listings/${listingId}`);
  const ownerId = claimedListing.ownerId || freshListing.ownerId;

  // ── 2. Reload players / cards after claim ─────────────────────────────────
  const freshOwner = db.get(`players/${ownerId}`);
  const freshAccepter = db.get(`players/${accepterId}`);

  if (!freshOwner) {
    await _releaseOwnedClaim(listingId, claimId, 'LISTING_OWNER_NOT_FOUND');
    return { success: false, reason: 'LISTING_OWNER_NOT_FOUND' };
  }
  if (!freshAccepter) {
    await _releaseOwnedClaim(listingId, claimId, 'ACCEPTER_NOT_FOUND');
    return { success: false, reason: 'ACCEPTER_NOT_FOUND' };
  }

  const allCards = db.get('cards') || {};
  const players = {
    [ownerId]: _normalizePlayer(freshOwner),
    [accepterId]: _normalizePlayer(freshAccepter),
  };

  // Validate against claimed listing; exclude self from reservation math.
  // Status may be processing — allow when excludeListingId matches this listing.
  const validation = validateListingTrade({
    listing: claimedListing,
    accepterId,
    chosenCardId,
    players,
    cards: allCards,
    excludeListingId: listingId,
  });

  if (!validation.valid) {
    if (isDetailedLogging()) {
      console.log(
        `[Listings][DETAIL] Listing ${listingId} failed validation after claim: ${validation.reason} ` +
          `(owner=${ownerId}, accepter=${accepterId}, chosen=${chosenCardId})`,
      );
    }
    await _releaseOwnedClaim(listingId, claimId, validation.reason);
    return { success: false, reason: validation.reason };
  }

  // Re-check cooldown after claim (stale race)
  const cooldownAfterClaim = _getListingAcceptCooldown(accepterId);
  if (cooldownAfterClaim.onCooldown) {
    await _releaseOwnedClaim(listingId, claimId, 'ACCEPTER_ON_COOLDOWN');
    return { success: false, reason: 'ACCEPTER_ON_COOLDOWN' };
  }

  const offeredCardId = claimedListing.offeredCardId;

  // ── 3. Build fulfill plan ─────────────────────────────────────────────────
  const plan = buildListingFulfillPlan({
    listingId,
    claimId,
    ownerId,
    accepterId,
    offeredCardId,
    chosenCardId,
    ownerPlayer: freshOwner,
    accepterPlayer: freshAccepter,
    now,
  });

  if (!plan.ok) {
    await _releaseOwnedClaim(listingId, claimId, plan.reason);
    return { success: false, reason: plan.reason || 'INVALID_LISTING_PLAN' };
  }

  // ── 4. Commit fulfill (write 2); recover safely on ack error ──────────────
  const result = await commitListingFulfillPlan(listingId, claimId, plan, {
    accepterId,
    chosenCardId,
  });

  if (!result.success) {
    // Stale before write: claim may still be ours — release if still processing/ours
    if (result.stale || result.reason === 'LISTING_NOT_ACTIVE') {
      await _releaseOwnedClaim(listingId, claimId, 'STALE_BEFORE_FULFILL');
    }
    // WRITE_FAILED with released: already released by recovery
    // WRITE_UNCERTAIN: leave processing
    return result;
  }

  if (isDetailedLogging()) {
    console.log(
      `[Listings][DETAIL] Listing ${listingId} fulfilled: ${ownerId} gave ${offeredCardId}, ` +
        `${accepterId} gave ${chosenCardId}, accepter cooldown applied at ${now}`,
    );
  } else {
    console.log(
      `[Listings] Listing ${listingId} fulfilled: ${ownerId} gave ${offeredCardId}, ${accepterId} gave ${chosenCardId}`,
    );
  }

  return {
    success: true,
    notifiedAccepter: result.notifiedAccepter || [],
    writeCount: result.writeCount || 2,
  };
}
