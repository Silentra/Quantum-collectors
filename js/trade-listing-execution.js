/**
 * Trade Listing Execution Module — Phase T-4 / Hybrid C+ Gate C
 *
 * Isolated helper for listing-trade card swaps.
 * Fulfillment uses:
 *   1) claimListingIfActive (active → processing)
 *   2) index transition (owner PTI processing; group leaf removed)
 *   3) updateAcknowledged fulfill with ServerValue.increment(±1) + fulfilled
 *   4) optional zero-leaf cleanup on give cards (never undoes fulfill)
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
import * as metrics from './db-metrics.js';
import { validateListingTrade, isDetailedLogging } from './trading.js';
import {
  buildListingFulfillPlan,
  commitListingFulfillPlan,
  cleanupZeroGiveLeavesAfterListingFulfill,
  isListingInventoryDiagEnabled,
  createListingInventoryDiagAttempt,
} from './trade-listing-plan.js';
import {
  listingClaimIndexTransitionPaths,
  listingReleaseIndexRestorePaths,
  listingIndexRemovalsForListing,
} from './trade-index.js';
import {
  loadTradingCounterpartyContext,
  loadPlayerInventoryOnce,
  buildCounterpartyAvailabilitySnapshot,
  buildTradingSelfAvailabilitySnapshot,
} from './trade-availability.js';

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

function _diagCardQty(player, cardId) {
  const n = player?.inventory?.[cardId];
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
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

/**
 * Release claim and restore index projections (owner active + group browsable).
 * @returns {Promise<{ ok: boolean, released?: boolean, indexRestored?: boolean, error?: string }>}
 */
async function _releaseOwnedClaimAndRestoreIndex(listingId, claimId, reason) {
  const release = await _releaseOwnedClaim(listingId, claimId, reason);
  if (!release.ok || !release.released) {
    return { ok: false, released: false, indexRestored: false, error: release.error };
  }
  const restoredListing = release.listing || db.get(`trades/listings/${listingId}`);
  if (!restoredListing) {
    return { ok: true, released: true, indexRestored: false, error: 'Listing missing after release' };
  }
  const restorePaths = listingReleaseIndexRestorePaths({
    ...restoredListing,
    id: restoredListing.id || listingId,
    status: 'active',
  });
  if (Object.keys(restorePaths).length === 0) {
    return { ok: true, released: true, indexRestored: true };
  }
  const ack = await db.updateAcknowledged(restorePaths);
  metrics.recordTradeIndexLifecycle({
    tag: 'listing-release-index-restore',
    ops: 1,
    ok: ack.ok,
    username: restoredListing.ownerId,
  });
  if (!ack.ok) {
    console.warn(
      `[TradeIndex] Claim released but index restore failed for listing ${listingId}. ` +
        'Rebuild Trade Indexes. Listing is active canonical.',
      ack.error,
    );
    return { ok: false, released: true, indexRestored: false, error: ack.error };
  }
  return { ok: true, released: true, indexRestored: true };
}

/**
 * Observation-only post-ack force loads (four card qtys). Never alters fulfill result.
 */
async function _diagPostAckVerify(diag, {
  ownerId,
  accepterId,
  offeredCardId,
  chosenCardId,
  planDiag,
}) {
  if (!diag || !planDiag) return;

  diag.mark('postAckVerificationStarted', { observationOnly: true });

  let ownerInv = null;
  let accepterInv = null;
  let ownerOk = false;
  let accepterOk = false;

  const ownerLoad = await loadPlayerInventoryOnce(ownerId, { force: true });
  ownerOk = ownerLoad.ok === true;
  ownerInv = ownerOk ? ownerLoad.inventory : null;

  const accepterLoad = await loadPlayerInventoryOnce(accepterId, { force: true });
  accepterOk = accepterLoad.ok === true;
  accepterInv = accepterOk ? accepterLoad.inventory : null;

  const ownerPlayer = ownerInv ? { inventory: ownerInv } : null;
  const accepterPlayer = accepterInv ? { inventory: accepterInv } : null;

  const serverQtys = {
    owner: {
      giveQty: _diagCardQty(ownerPlayer, offeredCardId),
      receiveQty: _diagCardQty(ownerPlayer, chosenCardId),
    },
    accepter: {
      giveQty: _diagCardQty(accepterPlayer, chosenCardId),
      receiveQty: _diagCardQty(accepterPlayer, offeredCardId),
    },
  };

  const ownerGiveDelta = serverQtys.owner.giveQty - (planDiag.owner?.giveBefore ?? 0);
  const ownerRecvDelta = serverQtys.owner.receiveQty - (planDiag.owner?.receiveBefore ?? 0);
  const accepterGiveDelta = serverQtys.accepter.giveQty - (planDiag.accepter?.giveBefore ?? 0);
  const accepterRecvDelta = serverQtys.accepter.receiveQty - (planDiag.accepter?.receiveBefore ?? 0);

  diag.mark('postAckVerificationCompleted', {
    observationOnly: true,
    loadsOk: { owner: ownerOk, accepter: accepterOk },
    serverQtys: {
      owner: {
        username: ownerId,
        giveCardId: offeredCardId,
        giveQty: serverQtys.owner.giveQty,
        receiveCardId: chosenCardId,
        receiveQty: serverQtys.owner.receiveQty,
        observedGiveDelta: ownerGiveDelta,
        observedReceiveDelta: ownerRecvDelta,
      },
      accepter: {
        username: accepterId,
        giveCardId: chosenCardId,
        giveQty: serverQtys.accepter.giveQty,
        receiveCardId: offeredCardId,
        receiveQty: serverQtys.accepter.receiveQty,
        observedGiveDelta: accepterGiveDelta,
        observedReceiveDelta: accepterRecvDelta,
      },
    },
  });
}

/**
 * Revalidate after PERMISSION_DENIED: if a give copy is unavailable → INSUFFICIENT_AVAILABLE_COPIES.
 * Otherwise null (generic recoverable rejection → release).
 */
async function classifyPermissionDeniedForListing({
  listingId,
  claimedListing,
  ownerId,
  accepterId,
  offeredCardId,
  chosenCardId,
}) {
  const ownerCtx = await loadTradingCounterpartyContext(ownerId, { force: true });
  if (!ownerCtx.ok || !ownerCtx.player) return null;

  let freshAccepter = db.get(`players/${accepterId}`);
  if (typeof db.loadPathOnce === 'function') {
    const accepterLoad = await db.loadPathOnce(`players/${accepterId}`, { force: true });
    if (!accepterLoad || accepterLoad.ok !== true || !accepterLoad.value) return null;
    freshAccepter = accepterLoad.value;
  }
  if (!freshAccepter) return null;

  const players = {
    [ownerId]: _normalizePlayer(ownerCtx.player),
    [accepterId]: _normalizePlayer(freshAccepter),
  };
  const allCards = db.get('cards') || {};
  const excludeIds = listingId ? [listingId] : [];

  const ownerSnapshot = buildCounterpartyAvailabilitySnapshot(ownerId, ownerCtx, {
    playerData: players[ownerId],
    excludeListingIds: excludeIds,
  });
  const accepterSnapshot = buildTradingSelfAvailabilitySnapshot(accepterId, {
    playerData: players[accepterId],
    excludeListingIds: excludeIds,
  });

  const validation = validateListingTrade({
    listing: { ...claimedListing, status: 'processing', id: listingId },
    accepterId,
    chosenCardId,
    players,
    cards: allCards,
    excludeListingId: listingId,
    ownerAvailabilitySnapshot: ownerSnapshot,
    accepterAvailabilitySnapshot: accepterSnapshot,
  });

  if (!validation.valid) {
    const r = validation.reason;
    if (
      r === 'INSUFFICIENT_AVAILABLE_COPIES'
      || r === 'LISTING_OWNER_MISSING_OFFERED_CARD'
      || r === 'ACCEPTER_MISSING_CHOSEN_CARD'
    ) {
      return 'INSUFFICIENT_AVAILABLE_COPIES';
    }
  }

  if ((ownerCtx.player.inventory?.[offeredCardId] || 0) < 1) {
    return 'INSUFFICIENT_AVAILABLE_COPIES';
  }
  if ((freshAccepter.inventory?.[chosenCardId] || 0) < 1) {
    return 'INSUFFICIENT_AVAILABLE_COPIES';
  }

  return null;
}

// ─── Atomic Listing Execution ───────────────────────────────────────────────

/**
 * Execute a listing trade (claim + relative inventory fulfill).
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

  const diag = isListingInventoryDiagEnabled()
    ? createListingInventoryDiagAttempt(listingId)
    : null;
  if (diag) {
    diag.claimId = claimId;
    diag.mark('executeEntered', { inventoryCommitAttempted: false });
  }

  // ── 0. Cache pre-checks (no network) ──────────────────────────────────────
  const freshListing = db.get(`trades/listings/${listingId}`);
  if (!freshListing || freshListing.status !== 'active') {
    console.log(`[Listings] Listing ${listingId} skipped — status is '${freshListing?.status}', not 'active'`);
    if (diag) {
      diag.claimWon = false;
      diag.mark('claimSkipped', { reason: 'LISTING_NOT_ACTIVE', status: freshListing?.status ?? null });
    }
    return { success: false, reason: 'LISTING_NOT_ACTIVE', stale: true };
  }

  if (freshListing.expiresAt && now > freshListing.expiresAt) {
    const still = db.get(`trades/listings/${listingId}`);
    if (still && still.status === 'active') {
      const id = still.id || listingId;
      await db.updateAcknowledged({
        [`trades/listings/${id}/status`]: 'expired',
        [`trades/listings/${id}/respondedAt`]: now,
        ...listingIndexRemovalsForListing({ ...still, id }),
      });
    }
    if (diag) {
      diag.claimWon = false;
      diag.mark('claimSkipped', { reason: 'LISTING_EXPIRED' });
    }
    return { success: false, reason: 'LISTING_EXPIRED' };
  }

  const accepterCooldown = _getListingAcceptCooldown(accepterId);
  if (accepterCooldown.onCooldown) {
    if (diag) {
      diag.claimWon = false;
      diag.mark('claimSkipped', { reason: 'ACCEPTER_ON_COOLDOWN' });
    }
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
    if (diag) {
      diag.claimWon = false;
      diag.mark('claimFailed', { error: claim.error || 'WRITE_FAILED' });
    }
    return {
      success: false,
      reason: 'WRITE_FAILED',
      error: claim.error || 'Could not claim listing',
    };
  }
  if (!claim.claimed) {
    if (diag) {
      diag.claimWon = false;
      diag.mark('claimLost', {
        reason: claim.reason || 'LISTING_NOT_ACTIVE',
        currentStatus: claim.listing?.status ?? null,
      });
    }
    return {
      success: false,
      reason: claim.reason || 'LISTING_NOT_ACTIVE',
      stale: true,
      currentStatus: claim.listing?.status ?? null,
    };
  }

  if (diag) {
    diag.claimWon = true;
    diag.mark('claimWon', {
      claimId,
      processingBy: accepterId,
      sameListingClaimWinnerProof: {
        listingId,
        claimId,
        processingBy: accepterId,
        status: 'processing',
      },
    });
  }

  const claimedListing = claim.listing || db.get(`trades/listings/${listingId}`);
  const ownerId = claimedListing.ownerId || freshListing.ownerId;

  // ── 1b. Required index transition (processing owner leaf; remove group leaf) ─
  const transitionPaths = listingClaimIndexTransitionPaths({
    ...claimedListing,
    id: claimedListing.id || listingId,
    status: 'processing',
  }, now);
  if (Object.keys(transitionPaths).length === 0) {
    console.warn(`[TradeIndex] Empty claim index transition for ${listingId}; releasing claim.`);
    await _releaseOwnedClaimAndRestoreIndex(listingId, claimId, 'EMPTY_INDEX_TRANSITION');
    return {
      success: false,
      reason: 'WRITE_FAILED',
      error: 'Could not build trade index transition after claim.',
      indexTransitionFailed: true,
    };
  }
  const transitionAck = await db.updateAcknowledged(transitionPaths);
  metrics.recordTradeIndexLifecycle({
    tag: 'listing-claim-index-transition',
    ops: 1,
    ok: transitionAck.ok,
    username: ownerId,
  });
  if (!transitionAck.ok) {
    console.warn(
      `[TradeIndex] Post-claim index transition failed for ${listingId}; releasing claim.`,
      transitionAck.error,
    );
    const released = await _releaseOwnedClaimAndRestoreIndex(
      listingId,
      claimId,
      'INDEX_TRANSITION_FAILED',
    );
    return {
      success: false,
      reason: 'WRITE_FAILED',
      error:
        transitionAck.error
        || (released.released
          ? 'Could not update trade indexes after claim; listing restored when possible.'
          : 'Could not update trade indexes after claim; listing may still be processing — rebuild/repair.'),
      indexTransitionFailed: true,
      claimReleased: !!released.released,
    };
  }

  // ── 2. S5c-D7a: force-load owner (+ PTI) after claim; refresh accepter ─────
  if (diag) {
    diag.mark('forcePlayerLoadsStarted', { ownerId, accepterId });
  }

  const ownerCtx = await loadTradingCounterpartyContext(ownerId, { force: true });
  if (!ownerCtx.ok) {
    await _releaseOwnedClaimAndRestoreIndex(
      listingId,
      claimId,
      ownerCtx.reason || 'COUNTERPARTY_LOAD_FAILED',
    );
    return { success: false, reason: ownerCtx.reason || 'COUNTERPARTY_LOAD_FAILED' };
  }

  let freshAccepter = db.get(`players/${accepterId}`);
  if (typeof db.loadPathOnce === 'function') {
    const accepterLoad = await db.loadPathOnce(`players/${accepterId}`, { force: true });
    if (!accepterLoad || accepterLoad.ok !== true || !accepterLoad.value) {
      await _releaseOwnedClaimAndRestoreIndex(listingId, claimId, 'ACCEPTER_NOT_FOUND');
      return { success: false, reason: 'ACCEPTER_NOT_FOUND' };
    }
    freshAccepter = accepterLoad.value;
  }

  const freshOwner = ownerCtx.player;

  if (!freshOwner) {
    await _releaseOwnedClaimAndRestoreIndex(listingId, claimId, 'LISTING_OWNER_NOT_FOUND');
    return { success: false, reason: 'LISTING_OWNER_NOT_FOUND' };
  }
  if (!freshAccepter) {
    await _releaseOwnedClaimAndRestoreIndex(listingId, claimId, 'ACCEPTER_NOT_FOUND');
    return { success: false, reason: 'ACCEPTER_NOT_FOUND' };
  }

  if (diag) {
    diag.mark('forcePlayerLoadsCompleted', {
      ownerOk: !!freshOwner,
      accepterOk: !!freshAccepter,
      ownerGiveQty: _diagCardQty(freshOwner, claimedListing.offeredCardId),
      accepterGiveQty: _diagCardQty(freshAccepter, chosenCardId),
    });
  }

  const allCards = db.get('cards') || {};
  const players = {
    [ownerId]: _normalizePlayer(freshOwner),
    [accepterId]: _normalizePlayer(freshAccepter),
  };

  const excludeIds = listingId ? [listingId] : [];
  const ownerSnapshot = buildCounterpartyAvailabilitySnapshot(ownerId, ownerCtx, {
    playerData: players[ownerId],
    excludeListingIds: excludeIds,
  });
  const accepterSnapshot = buildTradingSelfAvailabilitySnapshot(accepterId, {
    playerData: players[accepterId],
    excludeListingIds: excludeIds,
  });

  const validation = validateListingTrade({
    listing: claimedListing,
    accepterId,
    chosenCardId,
    players,
    cards: allCards,
    excludeListingId: listingId,
    ownerAvailabilitySnapshot: ownerSnapshot,
    accepterAvailabilitySnapshot: accepterSnapshot,
  });

  if (!validation.valid) {
    if (isDetailedLogging()) {
      console.log(
        `[Listings][DETAIL] Listing ${listingId} failed validation after claim: ${validation.reason} ` +
          `(owner=${ownerId}, accepter=${accepterId}, chosen=${chosenCardId})`,
      );
    }
    if (diag) {
      diag.mark('permanentPostClaimValidationFailure', { reason: validation.reason });
    }
    await _releaseOwnedClaimAndRestoreIndex(listingId, claimId, validation.reason);
    return { success: false, reason: validation.reason };
  }

  const cooldownAfterClaim = _getListingAcceptCooldown(accepterId);
  if (cooldownAfterClaim.onCooldown) {
    await _releaseOwnedClaimAndRestoreIndex(listingId, claimId, 'ACCEPTER_ON_COOLDOWN');
    return { success: false, reason: 'ACCEPTER_ON_COOLDOWN' };
  }

  const offeredCardId = claimedListing.offeredCardId;

  // ── 3. Build relative fulfill plan ────────────────────────────────────────
  const plan = buildListingFulfillPlan({
    listingId,
    claimId,
    ownerId,
    accepterId,
    offeredCardId,
    chosenCardId,
    ownerPlayer: freshOwner,
    accepterPlayer: freshAccepter,
    groupId: claimedListing.groupId || freshListing.groupId,
    now,
  });

  if (!plan.ok) {
    await _releaseOwnedClaimAndRestoreIndex(listingId, claimId, plan.reason);
    return { success: false, reason: plan.reason || 'INVALID_LISTING_PLAN' };
  }

  if (diag) {
    diag.mark('planBuilt', {
      inventoryDiag: plan.inventoryDiag || null,
      giveLeafPaths: plan.giveLeafPaths || null,
      note: 'Relative increments; no absolute planned-after inventory authority',
    });
  }

  // ── 4. Commit fulfill; recover safely on ack error (never replay increments) ─
  const result = await commitListingFulfillPlan(listingId, claimId, plan, {
    accepterId,
    chosenCardId,
    diag,
    classifyPermissionDenied: async () => classifyPermissionDeniedForListing({
      listingId,
      claimedListing,
      ownerId,
      accepterId,
      offeredCardId,
      chosenCardId,
    }),
  });

  if (!result.success) {
    if (diag) {
      diag.mark('commitFailed', {
        reason: result.reason || 'WRITE_FAILED',
        inventoryCommitAttempted: result.inventoryCommitAttempted === true,
        uncertain: result.uncertain === true,
        released: result.released === true,
      });
    }
    if (result.stale || result.reason === 'LISTING_NOT_ACTIVE') {
      await _releaseOwnedClaimAndRestoreIndex(listingId, claimId, 'STALE_BEFORE_FULFILL');
    } else if (result.released) {
      const listingAfter = db.get(`trades/listings/${listingId}`);
      if (listingAfter && listingAfter.status === 'active') {
        const restorePaths = listingReleaseIndexRestorePaths({
          ...listingAfter,
          id: listingAfter.id || listingId,
        });
        if (Object.keys(restorePaths).length > 0) {
          await db.updateAcknowledged(restorePaths);
          metrics.recordTradeIndexLifecycle({
            tag: 'listing-release-index-restore',
            ops: 1,
            ok: true,
            username: ownerId,
          });
        }
      }
    }
    // WRITE_UNCERTAIN: leave processing; owner index already processing, group absent
    return result;
  }

  // ── 5. Zero-leaf cleanup (give cards only; never undoes fulfill) ──────────
  await cleanupZeroGiveLeavesAfterListingFulfill(
    result.giveLeafPaths || plan.giveLeafPaths || [],
    diag,
  );

  // Optional UI convergence: refresh transformed inventory paths without synthesizing deltas
  if (Array.isArray(result.transformedPaths) && result.transformedPaths.length > 0
    && typeof db.loadPathOnce === 'function') {
    const inventoryRoots = new Set();
    for (const p of result.transformedPaths) {
      const m = String(p).match(/^players\/([^/]+)\//);
      if (m) inventoryRoots.add(`players/${m[1]}/inventory`);
    }
    for (const root of inventoryRoots) {
      try {
        await db.loadPathOnce(root, { force: true });
      } catch { /* ignore — fulfill already committed */ }
    }
  }

  if (diag && plan.inventoryDiag) {
    await _diagPostAckVerify(diag, {
      ownerId,
      accepterId,
      offeredCardId,
      chosenCardId,
      planDiag: plan.inventoryDiag,
    });
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

  if (diag) {
    diag.mark('executeCompleted', {
      success: true,
      inventoryCommitAttempted: true,
      claimWon: true,
      claimId,
    });
  }

  return {
    success: true,
    notifiedAccepter: result.notifiedAccepter || [],
    writeCount: result.writeCount || 3,
  };
}
