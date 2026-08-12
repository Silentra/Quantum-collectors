/**
 * trade-direct-plan.js
 *
 * One-write acknowledged commit for direct-trade final acceptance.
 * Transitions awaiting_offerer_confirmation → accepted with both players'
 * inventory/cooldowns/stats/achievements in a single updateAcknowledged.
 *
 * Processing is not written as a separate network step — atomic multi-path
 * replaces the old fragmented-write guard (see ARCHITECTURE.md).
 *
 * Trade stats parity: tradesCompleted +1 both; uniqueCardsOwned / maxCardAuraTier
 * recomputed, written only when changed; NO uniqueCardsDiscovered / cardsCollected
 * (notifyCardInventoryChanged semantics).
 *
 * Listings use a separate two-write claim+fulfill path (trade-listing-plan.js).
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
import { directIndexRemovalsForTrade } from './trade-index.js';

/** Dev-only localStorage gate. Absent/false → identical production behavior. */
export const DIRECT_INVENTORY_DIAG_LS_KEY = 'qc-direct-inventory-diag';

let _diagAttemptSeq = 0;

/**
 * @returns {boolean}
 */
export function isDirectInventoryDiagEnabled() {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(DIRECT_INVENTORY_DIAG_LS_KEY) === 'true';
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
 * @param {string} tradeId
 * @returns {{ attemptId: string, tradeId: string, marks: Object[], log: Function, mark: Function }}
 */
export function createDirectInventoryDiagAttempt(tradeId) {
  _diagAttemptSeq += 1;
  const attemptId = `did-${Date.now()}-${_diagAttemptSeq}`;
  const tid = String(tradeId || '');
  const marks = [];
  const attempt = {
    attemptId,
    tradeId: tid,
    marks,
    locksAvailable: !!(typeof navigator !== 'undefined'
      && navigator.locks
      && typeof navigator.locks.request === 'function'),
    inventoryCommitAttempted: false,
    log(phase, payload = {}) {
      const entry = {
        tag: '[DirectInventoryDiag]',
        attemptId,
        tradeId: tid,
        phase,
        ts: Date.now(),
        locksAvailable: attempt.locksAvailable,
        inventoryCommitAttempted: attempt.inventoryCommitAttempted,
        ...payload,
      };
      marks.push({ phase, ts: entry.ts });
      console.info('[DirectInventoryDiag]', entry);
      return entry;
    },
    mark(phase, payload = {}) {
      return attempt.log(phase, payload);
    },
  };
  return attempt;
}

/**
 * Snapshot only the four swap-involved card quantities from force-loaded player objects.
 * @param {object} args
 */
export function buildLoadedSourceDiag({
  tradeId,
  offeringPlayerId,
  targetPlayerId,
  offeredCardId,
  requestedCardId,
  offeringPlayer,
  targetPlayer,
}) {
  const offerInv = offeringPlayer?.inventory || {};
  const targetInv = targetPlayer?.inventory || {};
  return {
    tradeId,
    sources: [
      {
        username: offeringPlayerId,
        cardId: offeredCardId,
        role: 'give',
        loadedQty: _invQty(offerInv, offeredCardId),
      },
      {
        username: offeringPlayerId,
        cardId: requestedCardId,
        role: 'receive',
        loadedQty: _invQty(offerInv, requestedCardId),
      },
      {
        username: targetPlayerId,
        cardId: requestedCardId,
        role: 'give',
        loadedQty: _invQty(targetInv, requestedCardId),
      },
      {
        username: targetPlayerId,
        cardId: offeredCardId,
        role: 'receive',
        loadedQty: _invQty(targetInv, offeredCardId),
      },
    ],
  };
}

/**
 * Planner before/after + exact inventory leaf paths from the same inputs used to build the plan.
 * @returns {object|null}
 */
export function buildPlanInventoryDiag({
  offeringPlayerId,
  targetPlayerId,
  offeredCardId,
  requestedCardId,
  offeringPlayer,
  targetPlayer,
  offeringInvAfter,
  targetInvAfter,
  updates,
}) {
  const offerBeforeGive = _invQty(offeringPlayer?.inventory, offeredCardId);
  const offerBeforeRecv = _invQty(offeringPlayer?.inventory, requestedCardId);
  const targetBeforeGive = _invQty(targetPlayer?.inventory, requestedCardId);
  const targetBeforeRecv = _invQty(targetPlayer?.inventory, offeredCardId);

  const offerAfterGive = _invQty(offeringInvAfter, offeredCardId);
  const offerAfterRecv = _invQty(offeringInvAfter, requestedCardId);
  const targetAfterGive = _invQty(targetInvAfter, requestedCardId);
  const targetAfterRecv = _invQty(targetInvAfter, offeredCardId);

  const offerGivePath = `players/${offeringPlayerId}/inventory/${offeredCardId}`;
  const offerRecvPath = `players/${offeringPlayerId}/inventory/${requestedCardId}`;
  const targetGivePath = `players/${targetPlayerId}/inventory/${requestedCardId}`;
  const targetRecvPath = `players/${targetPlayerId}/inventory/${offeredCardId}`;

  const inventoryPaths = {
    [offerGivePath]: Object.prototype.hasOwnProperty.call(updates, offerGivePath)
      ? updates[offerGivePath]
      : undefined,
    [offerRecvPath]: Object.prototype.hasOwnProperty.call(updates, offerRecvPath)
      ? updates[offerRecvPath]
      : undefined,
    [targetGivePath]: Object.prototype.hasOwnProperty.call(updates, targetGivePath)
      ? updates[targetGivePath]
      : undefined,
    [targetRecvPath]: Object.prototype.hasOwnProperty.call(updates, targetRecvPath)
      ? updates[targetRecvPath]
      : undefined,
  };

  return {
    offeredCardId,
    requestedCardId,
    offerer: {
      username: offeringPlayerId,
      giveCardId: offeredCardId,
      receiveCardId: requestedCardId,
      giveBefore: offerBeforeGive,
      givePlannedAfter: offerAfterGive,
      receiveBefore: offerBeforeRecv,
      receivePlannedAfter: offerAfterRecv,
      expectedGiveDelta: -1,
      expectedReceiveDelta: 1,
      involvedTotalBefore: offerBeforeGive + offerBeforeRecv,
      involvedTotalPlannedAfter: offerAfterGive + offerAfterRecv,
    },
    target: {
      username: targetPlayerId,
      giveCardId: requestedCardId,
      receiveCardId: offeredCardId,
      giveBefore: targetBeforeGive,
      givePlannedAfter: targetAfterGive,
      receiveBefore: targetBeforeRecv,
      receivePlannedAfter: targetAfterRecv,
      expectedGiveDelta: -1,
      expectedReceiveDelta: 1,
      involvedTotalBefore: targetBeforeGive + targetBeforeRecv,
      involvedTotalPlannedAfter: targetAfterGive + targetAfterRecv,
    },
    inventoryPaths,
  };
}

/**
 * Compare force-loaded before, planned after, and post-ack server quantities (four cards only).
 * Diagnostic only — never throws / never mutates.
 */
export function evaluateDirectInventoryDiagInvariants({ planDiag, serverQtys }) {
  if (!planDiag || !serverQtys) return { flags: [], participants: [] };

  const flags = [];
  const participants = [];

  for (const side of ['offerer', 'target']) {
    const p = planDiag[side];
    const s = serverQtys[side];
    if (!p || !s) continue;

    const giveDeltaLoadedToPlanned = p.givePlannedAfter - p.giveBefore;
    const recvDeltaLoadedToPlanned = p.receivePlannedAfter - p.receiveBefore;
    const serverGive = s.giveQty;
    const serverRecv = s.receiveQty;
    const involvedTotalServer = serverGive + serverRecv;

    const participant = {
      side,
      username: p.username,
      giveCardId: p.giveCardId,
      receiveCardId: p.receiveCardId,
      loadedBefore: { give: p.giveBefore, receive: p.receiveBefore, total: p.involvedTotalBefore },
      plannedAfter: {
        give: p.givePlannedAfter,
        receive: p.receivePlannedAfter,
        total: p.involvedTotalPlannedAfter,
      },
      serverAfterAck: { give: serverGive, receive: serverRecv, total: involvedTotalServer },
      giveDeltaLoadedToPlanned,
      receiveDeltaLoadedToPlanned,
      plannedGiveMatchesExpected: giveDeltaLoadedToPlanned === -1,
      plannedReceiveMatchesExpected: recvDeltaLoadedToPlanned === 1,
      plannedTotalConserved: p.involvedTotalBefore === p.involvedTotalPlannedAfter,
      serverMatchesPlannedGive: serverGive === p.givePlannedAfter,
      serverMatchesPlannedReceive: serverRecv === p.receivePlannedAfter,
      serverTotalConservedVsLoaded: involvedTotalServer === p.involvedTotalBefore,
    };

    if (!participant.plannedGiveMatchesExpected || !participant.plannedReceiveMatchesExpected) {
      flags.push('PLANNER_DELTA_UNEXPECTED');
    }
    if (!participant.plannedTotalConserved) {
      flags.push('PLANNER_INVOLVED_TOTAL_NOT_CONSERVED');
    }
    if (!participant.serverMatchesPlannedGive || !participant.serverMatchesPlannedReceive) {
      flags.push('POST_ACK_SERVER_NE_PLANNED');
    }
    if (!participant.serverTotalConservedVsLoaded) {
      flags.push('DIRECT_INVENTORY_TOTAL_DRIFT');
    }

    participants.push(participant);
  }

  return { flags: [...new Set(flags)], participants };
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
        throw new Error(`[DirectTrade] Overlapping update paths: ${paths[i]} vs ${paths[j]}`);
      }
    }
  }
}

/**
 * Append inventory leaf updates for one player after a one-for-one swap.
 * @param {Object} updates
 * @param {string} username
 * @param {Object} nextInv
 * @param {string} giveCardId - card leaving inventory
 * @param {string} receiveCardId - card entering inventory
 */
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
 * @returns {{ updates: Object, plannedStatValues: Object, achStatKeys: string[], notified: string[], unlocked: string[] }}
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
  // Overlay for achievement eval even when unchanged
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
 * Build absolute multi-path updates for a validated direct-trade accept.
 * Caller must have already validated trade eligibility and cooldowns.
 *
 * @param {Object} args
 * @param {string} args.tradeId
 * @param {string} args.offeringPlayerId
 * @param {string} args.targetPlayerId
 * @param {string} args.offeredCardId
 * @param {string} args.requestedCardId
 * @param {object} args.offeringPlayer - raw player record
 * @param {object} args.targetPlayer
 * @param {number} args.now - single timestamp for completedAt + both lastDirectTradeAt
 * @returns {{ ok: boolean, reason?: string, updates?: Object, notifiedOfferer?: string[], notifiedTarget?: string[] }}
 */
export function buildDirectTradeAcceptPlan({
  tradeId,
  offeringPlayerId,
  targetPlayerId,
  offeredCardId,
  requestedCardId,
  offeringPlayer,
  targetPlayer,
  now,
} = {}) {
  if (!tradeId || !offeringPlayerId || !targetPlayerId || !offeredCardId || !requestedCardId) {
    return { ok: false, reason: 'INVALID_TRADE_PLAN' };
  }
  if (offeredCardId === requestedCardId) {
    return { ok: false, reason: 'SAME_CARD_BOTH_SIDES' };
  }
  if (!Number.isFinite(Number(now))) {
    return { ok: false, reason: 'INVALID_TIMESTAMP' };
  }

  const offeringInv = { ...(offeringPlayer?.inventory || {}) };
  const targetInv = { ...(targetPlayer?.inventory || {}) };

  offeringInv[offeredCardId] = (offeringInv[offeredCardId] || 0) - 1;
  if (offeringInv[offeredCardId] <= 0) delete offeringInv[offeredCardId];
  offeringInv[requestedCardId] = (offeringInv[requestedCardId] || 0) + 1;

  targetInv[requestedCardId] = (targetInv[requestedCardId] || 0) - 1;
  if (targetInv[requestedCardId] <= 0) delete targetInv[requestedCardId];
  targetInv[offeredCardId] = (targetInv[offeredCardId] || 0) + 1;

  // Guard against negative quantities from stale cache
  if ((offeringPlayer?.inventory?.[offeredCardId] || 0) < 1) {
    return { ok: false, reason: 'OFFERING_CARD_NOT_AVAILABLE' };
  }
  if ((targetPlayer?.inventory?.[requestedCardId] || 0) < 1) {
    return { ok: false, reason: 'REQUESTED_CARD_NOT_AVAILABLE' };
  }

  const updates = {
    [`trades/direct/${tradeId}/status`]: 'accepted',
    [`trades/direct/${tradeId}/completedAt`]: now,
    [`players/${offeringPlayerId}/lastDirectTradeAt`]: now,
    [`players/${targetPlayerId}/lastDirectTradeAt`]: now,
    [`players/${offeringPlayerId}/progression/firstTrade`]: true,
    [`players/${targetPlayerId}/progression/firstTrade`]: true,
    ...directIndexRemovalsForTrade({
      id: tradeId,
      offeringPlayerId,
      targetPlayerId,
    }),
  };

  appendInventorySwapPaths(updates, offeringPlayerId, offeringInv, offeredCardId, requestedCardId);
  appendInventorySwapPaths(updates, targetPlayerId, targetInv, requestedCardId, offeredCardId);

  const offererSide = planPlayerPostTradeSideEffects(offeringPlayerId, offeringInv, now);
  const targetSide = planPlayerPostTradeSideEffects(targetPlayerId, targetInv, now);
  Object.assign(updates, offererSide.updates, targetSide.updates);

  assertNoOverlappingUpdatePaths(updates);

  const result = {
    ok: true,
    updates,
    notifiedOfferer: offererSide.notified,
    notifiedTarget: targetSide.notified,
    unlockedOfferer: offererSide.unlocked,
    unlockedTarget: targetSide.unlocked,
    writeCount: 1,
  };

  // Dev-only attach — never affects commit payload
  if (isDirectInventoryDiagEnabled()) {
    result.inventoryDiag = buildPlanInventoryDiag({
      offeringPlayerId,
      targetPlayerId,
      offeredCardId,
      requestedCardId,
      offeringPlayer,
      targetPlayer,
      offeringInvAfter: offeringInv,
      targetInvAfter: targetInv,
      updates,
    });
  }

  return result;
}

/**
 * Mark trade failed only while still awaiting offerer confirmation.
 * Never clobber accepted / declined / cancelled / failed / processing.
 * Removes both participant index leaves in the same acknowledged write.
 * @returns {Promise<{ marked: boolean, reason?: string, currentStatus?: string, error?: string }>}
 */
export async function markDirectTradeFailedIfAwaiting(tradeId, failureReason, now = Date.now()) {
  const trade = db.get(`trades/direct/${tradeId}`);
  if (!trade) {
    return { marked: false, reason: 'TRADE_NOT_FOUND', currentStatus: null };
  }
  if (trade.status !== 'awaiting_offerer_confirmation') {
    return {
      marked: false,
      reason: 'STALE_TRADE_STATE',
      currentStatus: trade.status,
    };
  }
  const id = trade.id || tradeId;
  const updates = {
    [`trades/direct/${id}/status`]: 'failed',
    [`trades/direct/${id}/completedAt`]: now,
    [`trades/direct/${id}/failureReason`]: failureReason,
    ...directIndexRemovalsForTrade({ ...trade, id }),
  };
  const ack = await db.updateAcknowledged(updates);
  metrics.recordTradeIndexLifecycle({
    tag: 'direct-index-dual-write',
    ops: 1,
    ok: ack.ok,
    username: trade.offeringPlayerId,
  });
  if (!ack.ok) {
    return {
      marked: false,
      reason: 'WRITE_FAILED',
      currentStatus: trade.status,
      error: ack.error,
    };
  }
  return { marked: true, currentStatus: 'failed' };
}

async function withDirectTradeLock(tradeId, fn) {
  const lockName = `qc-direct-trade:${tradeId}`;
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(lockName, { mode: 'exclusive' }, () => fn());
  }
  return fn();
}

/**
 * Commit a pre-built accept plan via updateAcknowledged.
 * @param {string} tradeId
 * @param {Object} plan - from buildDirectTradeAcceptPlan
 * @param {{ diag?: object|null }} [options] - optional inventory diagnostics (no behavior change when absent)
 */
export async function commitDirectTradeAcceptPlan(tradeId, plan, options = {}) {
  const diag = options && options.diag ? options.diag : null;
  const locksAvailable = !!(typeof navigator !== 'undefined'
    && navigator.locks
    && typeof navigator.locks.request === 'function');

  if (diag) {
    diag.locksAvailable = locksAvailable;
    diag.mark('navigatorLockRequested', { locksAvailable, lockName: `qc-direct-trade:${tradeId}` });
  }

  return withDirectTradeLock(tradeId, async () => {
    if (diag) {
      diag.mark('navigatorLockAcquired', { locksAvailable });
    }

    // Revalidate status after lock (cache, not server-fresh).
    const statusCheck = db.get(`trades/direct/${tradeId}`);
    if (diag) {
      diag.mark('preCommitStatusRecheck', {
        status: statusCheck?.status ?? null,
        cacheOnly: true,
      });
    }
    if (!statusCheck || statusCheck.status !== 'awaiting_offerer_confirmation') {
      return {
        success: false,
        reason: 'STALE_TRADE_STATE',
        currentStatus: statusCheck?.status ?? null,
        inventoryCommitAttempted: false,
      };
    }

    if (!plan?.ok || !plan.updates) {
      return {
        success: false,
        reason: plan?.reason || 'INVALID_TRADE_PLAN',
        inventoryCommitAttempted: false,
      };
    }

    if (diag) {
      diag.inventoryCommitAttempted = true;
      diag.mark('updateAcknowledgedStarted', {
        inventoryCommitAttempted: true,
        inventoryPaths: plan.inventoryDiag?.inventoryPaths || null,
      });
    }

    const ack = await db.updateAcknowledged(plan.updates);

    if (diag) {
      diag.mark('updateAcknowledgedCompleted', {
        ok: ack.ok === true,
        error: ack.ok ? null : (ack.error || 'WRITE_FAILED'),
        inventoryCommitAttempted: true,
      });
    }

    if (!ack.ok) {
      return {
        success: false,
        reason: 'WRITE_FAILED',
        error: ack.error || 'Could not save trade. Check your connection and try again.',
        inventoryCommitAttempted: true,
      };
    }

    metrics.recordTradeIndexLifecycle({
      tag: 'direct-index-dual-write',
      ops: 1,
      ok: true,
    });

    return {
      success: true,
      notifiedOfferer: plan.notifiedOfferer || [],
      notifiedTarget: plan.notifiedTarget || [],
      writeCount: 1,
      inventoryCommitAttempted: true,
    };
  });
}
