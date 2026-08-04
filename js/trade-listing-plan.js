/**
 * trade-listing-plan.js
 *
 * Two-write listing fulfillment:
 *   1) claimListingIfActive (RTDB transaction) — active → processing
 *   2) updateAcknowledged — inventories/stats/achievements + fulfilled
 *
 * Cooldown parity with current executeListingTrade:
 *   - accepter gets lastListingAcceptAt on fulfill only
 *   - owner gets no fulfill cooldown
 *   - no lastDirectTradeAt / lastListingCreatedAt on fulfill
 *
 * Achievement updates persist for both players; callers toast accepter unlocks only.
 */

import * as db from './database.js';
import {
  STAT_KEYS,
  getPlayerStat,
  computeCardsAtMaxAuraFromInventory,
} from './achievement-stats.js';
import { planAchievementUpdatesForStats } from './achievement-mutations.js';
import { computeUniqueCardsOwnedFromInventory } from './research.js';

/**
 * RTDB multi-path updates cannot include both an ancestor and a descendant.
 * @param {Object} updates
 */
export function assertNoOverlappingUpdatePaths(updates) {
  const paths = Object.keys(updates || {}).sort();
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (paths[j].startsWith(`${paths[i]}/`) || paths[i].startsWith(`${paths[j]}/`)) {
        throw new Error(`[ListingFulfill] Overlapping update paths: ${paths[i]} vs ${paths[j]}`);
      }
    }
  }
}

function appendInventorySwapPaths(updates, username, nextInv, giveCardId, receiveCardId) {
  const giveQty = nextInv[giveCardId];
  updates[`players/${username}/inventory/${giveCardId}`] =
    typeof giveQty === 'number' && giveQty > 0 ? giveQty : null;

  const recvQty = nextInv[receiveCardId];
  updates[`players/${username}/inventory/${receiveCardId}`] =
    typeof recvQty === 'number' && recvQty > 0 ? recvQty : null;
}

/**
 * Plan post-swap unique/aura + tradesCompleted achievement overlay for one player.
 */
function planPlayerPostTradeSideEffects(username, nextInventory, now) {
  const updates = {};
  const plannedStatValues = {};
  const achStatKeys = [];

  const prevTrades = getPlayerStat(username, STAT_KEYS.TRADES_COMPLETED);
  const nextTrades = prevTrades + 1;
  updates[`players/${username}/stats/tradesCompleted`] = nextTrades;
  plannedStatValues[STAT_KEYS.TRADES_COMPLETED] = nextTrades;
  achStatKeys.push(STAT_KEYS.TRADES_COMPLETED);

  const prevUnique = getPlayerStat(username, STAT_KEYS.UNIQUE_CARDS_OWNED);
  const nextUnique = computeUniqueCardsOwnedFromInventory(nextInventory);
  if (nextUnique !== prevUnique) {
    updates[`players/${username}/stats/uniqueCardsOwned`] = nextUnique;
  }
  plannedStatValues[STAT_KEYS.UNIQUE_CARDS_OWNED] = nextUnique;
  achStatKeys.push(STAT_KEYS.UNIQUE_CARDS_OWNED);

  const prevAura = getPlayerStat(username, STAT_KEYS.MAX_CARD_AURA_TIER);
  const nextAura = computeCardsAtMaxAuraFromInventory(nextInventory);
  if (nextAura !== prevAura) {
    updates[`players/${username}/stats/maxCardAuraTier`] = nextAura;
    plannedStatValues[STAT_KEYS.MAX_CARD_AURA_TIER] = nextAura;
    achStatKeys.push(STAT_KEYS.MAX_CARD_AURA_TIER);
  }

  const getStat = (statKey) => {
    if (Object.prototype.hasOwnProperty.call(plannedStatValues, statKey)) {
      return plannedStatValues[statKey];
    }
    return getPlayerStat(username, statKey);
  };

  const achPlan = planAchievementUpdatesForStats(username, [...new Set(achStatKeys)], {
    getStat,
    now,
  });
  Object.assign(updates, achPlan.updates);

  return {
    updates,
    notified: achPlan.notified,
    unlocked: achPlan.unlocked,
  };
}

/**
 * Build absolute multi-path updates for a claimed listing fulfill.
 * Caller must own the processing claim and have already validated eligibility.
 *
 * @returns {{ ok: boolean, reason?: string, updates?: Object, notifiedOwner?: string[], notifiedAccepter?: string[], unlockedOwner?: string[], unlockedAccepter?: string[], writeCount?: number }}
 */
export function buildListingFulfillPlan({
  listingId,
  claimId,
  ownerId,
  accepterId,
  offeredCardId,
  chosenCardId,
  ownerPlayer,
  accepterPlayer,
  now,
} = {}) {
  if (!listingId || !claimId || !ownerId || !accepterId || !offeredCardId || !chosenCardId) {
    return { ok: false, reason: 'INVALID_LISTING_PLAN' };
  }
  if (offeredCardId === chosenCardId) {
    return { ok: false, reason: 'SAME_CARD_BOTH_SIDES' };
  }
  if (!Number.isFinite(Number(now))) {
    return { ok: false, reason: 'INVALID_TIMESTAMP' };
  }

  if ((ownerPlayer?.inventory?.[offeredCardId] || 0) < 1) {
    return { ok: false, reason: 'LISTING_OWNER_MISSING_OFFERED_CARD' };
  }
  if ((accepterPlayer?.inventory?.[chosenCardId] || 0) < 1) {
    return { ok: false, reason: 'ACCEPTER_MISSING_CHOSEN_CARD' };
  }

  const ownerInv = { ...(ownerPlayer?.inventory || {}) };
  const accepterInv = { ...(accepterPlayer?.inventory || {}) };

  ownerInv[offeredCardId] = (ownerInv[offeredCardId] || 0) - 1;
  if (ownerInv[offeredCardId] <= 0) delete ownerInv[offeredCardId];
  ownerInv[chosenCardId] = (ownerInv[chosenCardId] || 0) + 1;

  accepterInv[chosenCardId] = (accepterInv[chosenCardId] || 0) - 1;
  if (accepterInv[chosenCardId] <= 0) delete accepterInv[chosenCardId];
  accepterInv[offeredCardId] = (accepterInv[offeredCardId] || 0) + 1;

  const updates = {
    [`trades/listings/${listingId}/status`]: 'fulfilled',
    [`trades/listings/${listingId}/respondedAt`]: now,
    [`trades/listings/${listingId}/fulfilledBy`]: accepterId,
    [`trades/listings/${listingId}/fulfilledCardId`]: chosenCardId,
    // Clear claim metadata (never leave processing after successful fulfill)
    [`trades/listings/${listingId}/processingBy`]: null,
    [`trades/listings/${listingId}/processingAt`]: null,
    [`trades/listings/${listingId}/claimId`]: null,
    // Accepter-only listing-accept cooldown (owner has none on fulfill)
    [`players/${accepterId}/lastListingAcceptAt`]: now,
    [`players/${ownerId}/progression/firstTrade`]: true,
    [`players/${accepterId}/progression/firstTrade`]: true,
  };

  appendInventorySwapPaths(updates, ownerId, ownerInv, offeredCardId, chosenCardId);
  appendInventorySwapPaths(updates, accepterId, accepterInv, chosenCardId, offeredCardId);

  const ownerSide = planPlayerPostTradeSideEffects(ownerId, ownerInv, now);
  const accepterSide = planPlayerPostTradeSideEffects(accepterId, accepterInv, now);
  Object.assign(updates, ownerSide.updates, accepterSide.updates);

  assertNoOverlappingUpdatePaths(updates);

  return {
    ok: true,
    updates,
    notifiedOwner: ownerSide.notified,
    notifiedAccepter: accepterSide.notified,
    unlockedOwner: ownerSide.unlocked,
    unlockedAccepter: accepterSide.unlocked,
    writeCount: 1,
  };
}

async function withListingFulfillLock(listingId, fn) {
  const lockName = `qc-listing-fulfill:${listingId}`;
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(lockName, { mode: 'exclusive' }, () => fn());
  }
  return fn();
}

/**
 * After an acknowledged fulfill error: re-read server listing before release.
 * @returns {Promise<{ outcome: 'success'|'released'|'uncertain', listing?: object|null, release?: object, error?: string }>}
 */
export async function recoverListingFulfillAfterAckError(listingId, claimId, accepterId, chosenCardId) {
  const remote = await db.getAcknowledged(`trades/listings/${listingId}`);
  if (!remote.ok) {
    return {
      outcome: 'uncertain',
      listing: null,
      error: remote.error || 'Could not re-read listing after write failure',
    };
  }

  const listing = remote.value;
  if (
    listing &&
    listing.status === 'fulfilled' &&
    listing.fulfilledBy === accepterId &&
    listing.fulfilledCardId === chosenCardId
  ) {
    return { outcome: 'success', listing };
  }

  if (listing && listing.status === 'processing' && listing.claimId === claimId) {
    const release = await db.releaseListingClaimIfOwned(listingId, claimId);
    if (release.ok && release.released) {
      return { outcome: 'released', listing: release.listing, release };
    }
    // Still processing but release failed / not owned — uncertain
    return {
      outcome: 'uncertain',
      listing: release.listing ?? listing,
      release,
      error: release.error || 'Could not release listing claim',
    };
  }

  // Terminal or claimed by someone else — never overwrite
  return { outcome: 'uncertain', listing };
}

/**
 * Commit a pre-built listing fulfill plan via updateAcknowledged.
 * On ack failure, recovers via server re-read (never blind release).
 */
export async function commitListingFulfillPlan(listingId, claimId, plan, { accepterId, chosenCardId } = {}) {
  return withListingFulfillLock(listingId, async () => {
    if (!plan?.ok || !plan.updates) {
      return { success: false, reason: plan?.reason || 'INVALID_LISTING_PLAN' };
    }

    // Soft cache check — claim should still be ours
    const statusCheck = db.get(`trades/listings/${listingId}`);
    if (
      !statusCheck ||
      statusCheck.status !== 'processing' ||
      statusCheck.claimId !== claimId
    ) {
      return {
        success: false,
        reason: 'LISTING_NOT_ACTIVE',
        stale: true,
        currentStatus: statusCheck?.status ?? null,
      };
    }

    const ack = await db.updateAcknowledged(plan.updates);
    if (ack.ok) {
      return {
        success: true,
        notifiedAccepter: plan.notifiedAccepter || [],
        notifiedOwner: plan.notifiedOwner || [],
        writeCount: 2, // claim txn + fulfill update
      };
    }

    const recovery = await recoverListingFulfillAfterAckError(
      listingId,
      claimId,
      accepterId,
      chosenCardId,
    );

    if (recovery.outcome === 'success') {
      // Server applied the multi-path; patch local cache so UI isn't stale until root snap.
      for (const [path, value] of Object.entries(plan.updates)) {
        db.applyLocalOnly(path, value);
      }
      return {
        success: true,
        notifiedAccepter: plan.notifiedAccepter || [],
        notifiedOwner: plan.notifiedOwner || [],
        recovered: true,
        writeCount: 2,
      };
    }

    if (recovery.outcome === 'released') {
      return {
        success: false,
        reason: 'WRITE_FAILED',
        error: ack.error || 'Could not save listing fulfill. Check your connection and try again.',
        released: true,
      };
    }

    console.warn(
      `[Listings] Fulfill ack uncertain for ${listingId} claim=${claimId}; leaving processing. ` +
        `status=${recovery.listing?.status ?? 'null'}`,
    );
    return {
      success: false,
      reason: 'WRITE_UNCERTAIN',
      error:
        recovery.error ||
        ack.error ||
        'Listing fulfill may have partially completed. Please refresh before retrying.',
      uncertain: true,
      currentStatus: recovery.listing?.status ?? null,
    };
  });
}
