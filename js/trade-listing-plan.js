/**
 * trade-listing-plan.js
 *
 * Hybrid C+ Gate C — listing fulfillment under existing claim:
 *   1) claimListingIfActive (RTDB transaction) — active → processing
 *   2) updateAcknowledged — inventory ServerValue.increment(±1) + fulfilled
 *
 * No absolute inventory card quantities in the terminal payload.
 * navigator.locks is UX/local only; the RTDB claim is the correctness boundary.
 *
 * Cooldown parity:
 *   - accepter gets lastListingAcceptAt on fulfill only
 *   - owner gets no fulfill cooldown
 *   - no lastDirectTradeAt / lastListingCreatedAt on fulfill
 *
 * Achievement updates persist for both players; callers toast accepter unlocks only.
 */

import * as db from './database.js';
import * as metrics from './db-metrics.js';
import {
  STAT_KEYS,
  getPlayerStat,
  computeCardsAtMaxAuraFromInventory,
} from './achievement-stats.js';
import { planAchievementUpdatesForStats } from './achievement-mutations.js';
import { computeUniqueCardsOwnedFromInventory } from './research.js';
import { listingIndexRemovalsForListing } from './trade-index.js';
import { buildTradeCompletedHistoryUpdate } from './player-history.js';
import {
  mergeTradeGrantClear,
  resolveClaimerAuthUid,
} from './trade-grants.js';
import {
  STAT_TYPES,
  buildLeaderboardSummaryPathsForChangedStats,
  buildTradesCompletedLeaderboardIncrementPaths,
  playerLikeWithStatOverlay,
} from './leaderboard-summaries.js';

/** Dev-only localStorage gate. Absent/false → identical production behavior. */
export const LISTING_INVENTORY_DIAG_LS_KEY = 'qc-listing-inventory-diag';

let _diagAttemptSeq = 0;

/**
 * Firebase RTDB relative increment wire form (survives JSON clone).
 * @param {number} delta
 * @returns {{ '.sv': { increment: number } }}
 */
export function serverIncrement(delta) {
  return { '.sv': { increment: Number(delta) } };
}

/**
 * @returns {boolean}
 */
export function isListingInventoryDiagEnabled() {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(LISTING_INVENTORY_DIAG_LS_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * @param {unknown} inv
 * @param {string} cardId
 * @returns {number}
 */
function _invQty(inv, cardId) {
  const n = inv?.[cardId];
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * @param {string} listingId
 * @returns {{ attemptId: string, listingId: string, marks: Object[], log: Function, mark: Function }}
 */
export function createListingInventoryDiagAttempt(listingId) {
  _diagAttemptSeq += 1;
  const attemptId = `lid-${Date.now()}-${_diagAttemptSeq}`;
  const lid = String(listingId || '');
  const marks = [];
  const attempt = {
    attemptId,
    listingId: lid,
    marks,
    locksAvailable: !!(typeof navigator !== 'undefined'
      && navigator.locks
      && typeof navigator.locks.request === 'function'),
    inventoryCommitAttempted: false,
    claimWon: null,
    claimId: null,
    recoveryOutcome: null,
    rejectionClassification: null,
    log(phase, payload = {}) {
      const entry = {
        tag: '[ListingInventoryDiag]',
        attemptId,
        listingId: lid,
        phase,
        ts: Date.now(),
        locksAvailable: attempt.locksAvailable,
        inventoryCommitAttempted: attempt.inventoryCommitAttempted,
        claimWon: attempt.claimWon,
        claimId: attempt.claimId,
        recoveryOutcome: attempt.recoveryOutcome,
        rejectionClassification: attempt.rejectionClassification,
        ...payload,
      };
      marks.push({ phase, ts: entry.ts });
      console.info('[ListingInventoryDiag]', entry);
      return entry;
    },
    mark(phase, payload = {}) {
      return attempt.log(phase, payload);
    },
  };
  return attempt;
}

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

/**
 * Inventory swap paths for terminal settlement.
 * Give leaf: null when pre-qty is exactly 1 (canonical absent leaf; grant still valid
 * in the same multipath pre-write root). Else ServerValue.increment(-1).
 * Receive leaf: always increment(+1).
 *
 * @param {Object} updates
 * @param {string} username
 * @param {string} giveCardId
 * @param {string} receiveCardId
 * @param {object|null|undefined} inventory - pre-settlement inventory for qty decision
 * @returns {{ giveNulled: boolean }}
 */
function appendInventoryIncrementSwapPaths(updates, username, giveCardId, receiveCardId, inventory) {
  const giveQty = _invQty(inventory, giveCardId);
  const givePath = `players/${username}/inventory/${giveCardId}`;
  if (giveQty === 1) {
    updates[givePath] = null;
  } else {
    updates[givePath] = serverIncrement(-1);
  }
  updates[`players/${username}/inventory/${receiveCardId}`] = serverIncrement(1);
  return { giveNulled: giveQty === 1 };
}

/**
 * Logical ±1 inventory image for unique/aura stats only (not written as card leaves).
 * @param {object} inventory
 * @param {string} giveCardId
 * @param {string} receiveCardId
 * @returns {object}
 */
function logicalInventoryAfterSwap(inventory, giveCardId, receiveCardId) {
  const next = { ...(inventory || {}) };
  next[giveCardId] = (next[giveCardId] || 0) - 1;
  if (next[giveCardId] <= 0) delete next[giveCardId];
  next[receiveCardId] = (next[receiveCardId] || 0) + 1;
  return next;
}

/**
 * Plan post-swap unique/aura + tradesCompleted achievement overlay for one player.
 *
 * @param {string} username
 * @param {object} nextInventory
 * @param {number} now
 * @param {{ statsReadable?: boolean }} [options]
 *   statsReadable=true (own/claimer): achievements + unique LB; tradesCompleted always increment(1).
 *   statsReadable=false (foreign owner): increment tradesCompleted; skip achievements.
 * @returns {{ updates: Object, plannedStatValues: Object, leaderboardStatKeys: string[], notified: string[], unlocked: string[] }}
 */
function planPlayerPostTradeSideEffects(username, nextInventory, now, options = {}) {
  const statsReadable = options.statsReadable !== false;
  const updates = {};
  const plannedStatValues = {};
  const achStatKeys = [];
  /** @type {string[]} */
  const leaderboardStatKeys = [];

  updates[`players/${username}/stats/tradesCompleted`] = serverIncrement(1);
  if (statsReadable) {
    plannedStatValues[STAT_KEYS.TRADES_COMPLETED] = getPlayerStat(username, STAT_KEYS.TRADES_COMPLETED) + 1;
    achStatKeys.push(STAT_KEYS.TRADES_COMPLETED);
  }

  const prevUnique = getPlayerStat(username, STAT_KEYS.UNIQUE_CARDS_OWNED);
  const nextUnique = computeUniqueCardsOwnedFromInventory(nextInventory);
  if (nextUnique !== prevUnique) {
    updates[`players/${username}/stats/uniqueCardsOwned`] = nextUnique;
  }
  plannedStatValues[STAT_KEYS.UNIQUE_CARDS_OWNED] = nextUnique;
  achStatKeys.push(STAT_KEYS.UNIQUE_CARDS_OWNED);
  if (statsReadable || nextUnique !== prevUnique) {
    if (!leaderboardStatKeys.includes(STAT_TYPES.UNIQUE_CARDS_OWNED)) {
      leaderboardStatKeys.push(STAT_TYPES.UNIQUE_CARDS_OWNED);
    }
  }

  const prevAura = getPlayerStat(username, STAT_KEYS.MAX_CARD_AURA_TIER);
  const nextAura = computeCardsAtMaxAuraFromInventory(nextInventory);
  if (nextAura !== prevAura) {
    updates[`players/${username}/stats/maxCardAuraTier`] = nextAura;
    plannedStatValues[STAT_KEYS.MAX_CARD_AURA_TIER] = nextAura;
    achStatKeys.push(STAT_KEYS.MAX_CARD_AURA_TIER);
  }

  let notified = [];
  let unlocked = [];
  if (statsReadable) {
    const getStat = (statKey) => {
      if (Object.prototype.hasOwnProperty.call(plannedStatValues, statKey)) {
        return plannedStatValues[statKey];
      }
      return getPlayerStat(username, statKey);
    };
    const achPlan = planAchievementUpdatesForStats(username, [...new Set(achStatKeys)], {
      getStat,
      now,
      requireAchievementsReady: true,
    });
    Object.assign(updates, achPlan.updates);
    notified = achPlan.notified;
    unlocked = achPlan.unlocked;
  }

  return {
    updates,
    plannedStatValues,
    leaderboardStatKeys,
    notified,
    unlocked,
  };
}

/**
 * True if any inventory card path holds an absolute numeric qty (not .sv, not null).
 * Null is allowed — canonical removal when giving the last copy.
 * @param {Object} updates
 * @returns {boolean}
 */
export function terminalPayloadHasAbsoluteInventoryQty(updates) {
  for (const [path, value] of Object.entries(updates || {})) {
    if (!/\/inventory\//.test(path)) continue;
    if (value == null) continue;
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '.sv')) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Planner diag for relative increments — no authoritative planned absolute after.
 * @returns {object|null}
 */
export function buildListingPlanInventoryDiag({
  ownerId,
  accepterId,
  offeredCardId,
  chosenCardId,
  ownerPlayer,
  accepterPlayer,
  updates,
}) {
  const ownerGivePath = `players/${ownerId}/inventory/${offeredCardId}`;
  const ownerRecvPath = `players/${ownerId}/inventory/${chosenCardId}`;
  const accepterGivePath = `players/${accepterId}/inventory/${chosenCardId}`;
  const accepterRecvPath = `players/${accepterId}/inventory/${offeredCardId}`;

  const inventoryPaths = {
    [ownerGivePath]: Object.prototype.hasOwnProperty.call(updates, ownerGivePath)
      ? updates[ownerGivePath]
      : undefined,
    [ownerRecvPath]: Object.prototype.hasOwnProperty.call(updates, ownerRecvPath)
      ? updates[ownerRecvPath]
      : undefined,
    [accepterGivePath]: Object.prototype.hasOwnProperty.call(updates, accepterGivePath)
      ? updates[accepterGivePath]
      : undefined,
    [accepterRecvPath]: Object.prototype.hasOwnProperty.call(updates, accepterRecvPath)
      ? updates[accepterRecvPath]
      : undefined,
  };

  const incrementDeltas = {
    [ownerGivePath]: -1,
    [ownerRecvPath]: 1,
    [accepterGivePath]: -1,
    [accepterRecvPath]: 1,
  };

  return {
    offeredCardId,
    chosenCardId,
    model: 'relative-increment',
    incrementDeltas,
    owner: {
      username: ownerId,
      giveCardId: offeredCardId,
      receiveCardId: chosenCardId,
      giveBefore: _invQty(ownerPlayer?.inventory, offeredCardId),
      receiveBefore: _invQty(ownerPlayer?.inventory, chosenCardId),
      expectedGiveDelta: -1,
      expectedReceiveDelta: 1,
    },
    accepter: {
      username: accepterId,
      giveCardId: chosenCardId,
      receiveCardId: offeredCardId,
      giveBefore: _invQty(accepterPlayer?.inventory, chosenCardId),
      receiveBefore: _invQty(accepterPlayer?.inventory, offeredCardId),
      expectedGiveDelta: -1,
      expectedReceiveDelta: 1,
    },
    inventoryPaths,
  };
}

/**
 * Build relative multi-path updates for a claimed listing fulfill.
 * Caller must own the processing claim and have already validated eligibility.
 *
 * @returns {{ ok: boolean, reason?: string, updates?: Object, giveLeafPaths?: string[], notifiedOwner?: string[], notifiedAccepter?: string[] }}
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
  groupId = null,
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

  // Soft precheck only — server inventory >=0 validate is the hard oversell guard.
  if ((ownerPlayer?.inventory?.[offeredCardId] || 0) < 1) {
    return { ok: false, reason: 'LISTING_OWNER_MISSING_OFFERED_CARD' };
  }
  if ((accepterPlayer?.inventory?.[chosenCardId] || 0) < 1) {
    return { ok: false, reason: 'ACCEPTER_MISSING_CHOSEN_CARD' };
  }

  const ownerLogical = logicalInventoryAfterSwap(
    ownerPlayer?.inventory,
    offeredCardId,
    chosenCardId,
  );
  const accepterLogical = logicalInventoryAfterSwap(
    accepterPlayer?.inventory,
    chosenCardId,
    offeredCardId,
  );

  const resolvedGroupId = groupId || db.get(`trades/listings/${listingId}`)?.groupId || null;

  const updates = {
    [`trades/listings/${listingId}/status`]: 'fulfilled',
    [`trades/listings/${listingId}/respondedAt`]: now,
    [`trades/listings/${listingId}/fulfilledBy`]: accepterId,
    [`trades/listings/${listingId}/fulfilledCardId`]: chosenCardId,
    [`trades/listings/${listingId}/processingBy`]: null,
    [`trades/listings/${listingId}/processingAt`]: null,
    [`trades/listings/${listingId}/claimId`]: null,
    [`trades/listings/${listingId}/claimerAuthUid`]: null,
    [`players/${accepterId}/lastListingAcceptAt`]: now,
    [`players/${ownerId}/progression/firstTrade`]: true,
    [`players/${accepterId}/progression/firstTrade`]: true,
    ...listingIndexRemovalsForListing({
      id: listingId,
      ownerId,
      groupId: resolvedGroupId,
    }),
  };

  // S8c-1: clear claim-scoped foreign inventory grant in the same terminal multipath
  mergeTradeGrantClear(updates, ownerId, resolveClaimerAuthUid());

  const ownerGive = appendInventoryIncrementSwapPaths(
    updates,
    ownerId,
    offeredCardId,
    chosenCardId,
    ownerPlayer?.inventory,
  );
  const accepterGive = appendInventoryIncrementSwapPaths(
    updates,
    accepterId,
    chosenCardId,
    offeredCardId,
    accepterPlayer?.inventory,
  );

  // Claimer is accepter. Owner is foreign under tradeGrant — cannot read owner stats.
  const ownerSide = planPlayerPostTradeSideEffects(ownerId, ownerLogical, now, {
    statsReadable: false,
  });
  const accepterSide = planPlayerPostTradeSideEffects(accepterId, accepterLogical, now, {
    statsReadable: true,
  });
  Object.assign(updates, ownerSide.updates, accepterSide.updates);

  const ownerLike = playerLikeWithStatOverlay(ownerPlayer, {
    [STAT_TYPES.UNIQUE_CARDS_OWNED]: ownerSide.plannedStatValues[STAT_KEYS.UNIQUE_CARDS_OWNED],
  });
  const accepterLike = playerLikeWithStatOverlay(accepterPlayer, {
    [STAT_TYPES.UNIQUE_CARDS_OWNED]: accepterSide.plannedStatValues[STAT_KEYS.UNIQUE_CARDS_OWNED],
  });
  Object.assign(
    updates,
    buildLeaderboardSummaryPathsForChangedStats(
      ownerId,
      ownerLike,
      ownerSide.leaderboardStatKeys,
      now,
    ),
    buildLeaderboardSummaryPathsForChangedStats(
      accepterId,
      accepterLike,
      accepterSide.leaderboardStatKeys,
      now,
    ),
    buildTradesCompletedLeaderboardIncrementPaths(ownerId, ownerLike, now),
    buildTradesCompletedLeaderboardIncrementPaths(accepterId, accepterLike, now),
  );

  // Observational history: one leaf per player, same settlement multipath.
  const claimerUid = resolveClaimerAuthUid();
  const ownerHistory = buildTradeCompletedHistoryUpdate(ownerId, {
    tradeKind: 'listing',
    tradeId: listingId,
    listingId,
    counterpartyUsername: accepterId,
    gave: { [offeredCardId]: 1 },
    received: { [chosenCardId]: 1 },
    actorUid: claimerUid,
  });
  const accepterHistory = buildTradeCompletedHistoryUpdate(accepterId, {
    tradeKind: 'listing',
    tradeId: listingId,
    listingId,
    counterpartyUsername: ownerId,
    gave: { [chosenCardId]: 1 },
    received: { [offeredCardId]: 1 },
    actorUid: claimerUid,
  });
  Object.assign(updates, ownerHistory.updates, accepterHistory.updates);

  assertNoOverlappingUpdatePaths(updates);

  if (terminalPayloadHasAbsoluteInventoryQty(updates)) {
    return { ok: false, reason: 'INVALID_LISTING_PLAN' };
  }

  // Post-commit zero cleanup: claimer's own give leaf only (accepter).
  // Foreign owner leaf is nulled in-terminal when qty===1; never post-cleanup after grant clear.
  void ownerGive;
  const giveLeafPaths = [];
  if (!accepterGive.giveNulled) {
    giveLeafPaths.push(`players/${accepterId}/inventory/${chosenCardId}`);
  }

  const result = {
    ok: true,
    updates,
    giveLeafPaths,
    notifiedOwner: ownerSide.notified,
    notifiedAccepter: accepterSide.notified,
    unlockedOwner: ownerSide.unlocked,
    unlockedAccepter: accepterSide.unlocked,
    writeCount: 1,
  };

  if (isListingInventoryDiagEnabled()) {
    result.inventoryDiag = buildListingPlanInventoryDiag({
      ownerId,
      accepterId,
      offeredCardId,
      chosenCardId,
      ownerPlayer,
      accepterPlayer,
      updates,
    });
  }

  return result;
}

/**
 * Optional best-effort give-leaf hygiene after fulfill (missing ≡ qty 0 for ownership).
 * Never rolls back or questions a fulfilled listing; cleanup failure is non-fatal.
 * @param {string[]} giveLeafPaths
 * @param {object|null} diag
 */
export async function cleanupZeroGiveLeavesAfterListingFulfill(giveLeafPaths, diag = null) {
  const paths = Array.isArray(giveLeafPaths) ? giveLeafPaths : [];
  const results = [];
  for (const leafPath of paths) {
    try {
      const r = await db.clearInventoryLeafIfNonPositive(leafPath);
      results.push({ path: leafPath, ...r });
      if (diag) {
        diag.mark('zeroLeafCleanup', {
          path: leafPath,
          ok: r.ok === true,
          removed: r.removed === true,
          outcome: r.outcome || null,
          error: r.error || null,
        });
      }
    } catch (e) {
      results.push({ path: leafPath, ok: false, removed: false, error: e?.message || String(e) });
      if (diag) {
        diag.mark('zeroLeafCleanup', {
          path: leafPath,
          ok: false,
          removed: false,
          outcome: 'failed',
          error: e?.message || String(e),
        });
      }
    }
  }
  return results;
}

async function withListingFulfillLock(listingId, fn) {
  const lockName = `qc-listing-fulfill:${listingId}`;
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(lockName, { mode: 'exclusive' }, () => fn());
  }
  return fn();
}

function _isPermissionDenied(err) {
  return /PERMISSION_DENIED/i.test(String(err || ''));
}

/**
 * Apply only literal (non-.sv) paths from a plan after recovered fulfilled ack.
 * Never writes raw increment sentinels into local cache.
 * @param {Object} updates
 */
function applyLiteralPlanPathsLocally(updates) {
  for (const [path, value] of Object.entries(updates || {})) {
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '.sv')) {
      continue;
    }
    db.applyLocalOnly(path, value);
  }
}

/**
 * After an acknowledged fulfill error: re-read server listing before release.
 * Never replays increments.
 * @returns {Promise<{ outcome: 'success'|'released'|'uncertain'|'failed_classified', listing?: object|null, release?: object, reason?: string, error?: string }>}
 */
export async function recoverListingFulfillAfterAckError(
  listingId,
  claimId,
  accepterId,
  chosenCardId,
  { ackError = null, classifyFn = null } = {},
) {
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
    let classifiedReason = null;
    if (typeof classifyFn === 'function') {
      try {
        classifiedReason = await classifyFn(ackError, listing);
      } catch { /* ignore */ }
    }

    // Prefer release-and-restore (listing product behavior). Classification only
    // informs the friendly reason returned to the UI.
    const release = await db.releaseListingClaimIfOwned(listingId, claimId);
    if (release.ok && release.released) {
      return {
        outcome: 'released',
        listing: release.listing,
        release,
        reason: classifiedReason || 'WRITE_FAILED',
        error: ackError,
      };
    }
    return {
      outcome: 'uncertain',
      listing: release.listing ?? listing,
      release,
      reason: 'WRITE_UNCERTAIN',
      error: release.error || ackError || 'Could not release listing claim',
    };
  }

  // Terminal or claimed by someone else — never overwrite
  return { outcome: 'uncertain', listing, reason: 'WRITE_UNCERTAIN' };
}

/**
 * Commit a pre-built listing fulfill plan via updateAcknowledged.
 * On ack failure, recovers via server re-read (never blind release / never replay increments).
 *
 * @param {string} listingId
 * @param {string} claimId
 * @param {Object} plan
 * @param {{ accepterId: string, chosenCardId: string, diag?: object|null, classifyPermissionDenied?: Function }} [options]
 */
export async function commitListingFulfillPlan(listingId, claimId, plan, options = {}) {
  const { accepterId, chosenCardId } = options;
  const diag = options.diag || null;
  const classifyPermissionDenied = options.classifyPermissionDenied || null;

  return withListingFulfillLock(listingId, async () => {
    if (!plan?.ok || !plan.updates) {
      return { success: false, reason: plan?.reason || 'INVALID_LISTING_PLAN' };
    }

    const statusCheck = db.get(`trades/listings/${listingId}`);
    if (diag) {
      diag.mark('preCommitStatusRecheck', {
        status: statusCheck?.status ?? null,
        claimIdMatch: statusCheck?.claimId === claimId,
        cacheOnly: true,
      });
    }
    if (
      !statusCheck
      || statusCheck.status !== 'processing'
      || statusCheck.claimId !== claimId
    ) {
      return {
        success: false,
        reason: 'LISTING_NOT_ACTIVE',
        stale: true,
        currentStatus: statusCheck?.status ?? null,
        inventoryCommitAttempted: false,
      };
    }

    if (diag) {
      diag.inventoryCommitAttempted = true;
      diag.mark('updateAcknowledgedStarted', {
        inventoryCommitAttempted: true,
        incrementDeltas: plan.inventoryDiag?.incrementDeltas || null,
        inventoryPaths: plan.inventoryDiag?.inventoryPaths || null,
      });
    }

    const ack = await db.updateAcknowledged(plan.updates);

    if (diag) {
      diag.mark('updateAcknowledgedCompleted', {
        ok: ack.ok === true,
        error: ack.ok ? null : (ack.error || 'WRITE_FAILED'),
        transformedPaths: ack.transformedPaths || [],
        inventoryCommitAttempted: true,
      });
    }

    if (ack.ok) {
      metrics.recordTradeIndexLifecycle({
        tag: 'listing-index-dual-write',
        ops: 1,
        ok: true,
      });
      return {
        success: true,
        notifiedAccepter: plan.notifiedAccepter || [],
        notifiedOwner: plan.notifiedOwner || [],
        writeCount: 3,
        inventoryCommitAttempted: true,
        giveLeafPaths: plan.giveLeafPaths || [],
        transformedPaths: ack.transformedPaths || [],
      };
    }

    const classifyFn = async (err) => {
      if (!_isPermissionDenied(err)) return null;
      if (typeof classifyPermissionDenied === 'function') {
        return classifyPermissionDenied(err);
      }
      return null;
    };

    const recovery = await recoverListingFulfillAfterAckError(
      listingId,
      claimId,
      accepterId,
      chosenCardId,
      { ackError: ack.error, classifyFn },
    );

    if (diag) {
      diag.recoveryOutcome = recovery.outcome;
      diag.rejectionClassification = recovery.reason || null;
      diag.mark('terminalAckRecovery', {
        outcome: recovery.outcome,
        reason: recovery.reason || null,
        permissionDenied: _isPermissionDenied(ack.error),
        currentStatus: recovery.listing?.status ?? null,
      });
    }

    if (recovery.outcome === 'success') {
      applyLiteralPlanPathsLocally(plan.updates);
      return {
        success: true,
        notifiedAccepter: plan.notifiedAccepter || [],
        notifiedOwner: plan.notifiedOwner || [],
        recovered: true,
        writeCount: 3,
        inventoryCommitAttempted: true,
        giveLeafPaths: plan.giveLeafPaths || [],
      };
    }

    if (recovery.outcome === 'released') {
      return {
        success: false,
        reason: recovery.reason || 'WRITE_FAILED',
        error: recovery.error || ack.error || 'Could not save listing fulfill. Check your connection and try again.',
        released: true,
        inventoryCommitAttempted: true,
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
        recovery.error
        || ack.error
        || 'Listing fulfill may have partially completed. Please refresh before retrying.',
      uncertain: true,
      inventoryCommitAttempted: true,
      currentStatus: recovery.listing?.status ?? null,
    };
  });
}
