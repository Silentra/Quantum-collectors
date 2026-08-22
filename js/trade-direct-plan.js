/**
 * trade-direct-plan.js
 *
 * Hybrid C+ Gate B — direct-trade final acceptance under a processing claim:
 *   1) claimDirectTradeIfAwaiting (awaiting_offerer_confirmation → processing)
 *   2) updateAcknowledged terminal — inventory ServerValue.increment(±1) + accepted
 *
 * No absolute inventory card quantities in the terminal payload.
 * navigator.locks is UX/local only; the RTDB claim is the correctness boundary.
 *
 * Trade stats parity: tradesCompleted +1 both; uniqueCardsOwned / maxCardAuraTier
 * from logical ±1 inventory image (not written as absolute card leaves).
 *
 * Listings remain on the separate absolute claim+fulfill path (Gate C later).
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
import {
  directIndexRemovalsForTrade,
  directReleaseIndexRestorePaths,
} from './trade-index.js';
import {
  STAT_TYPES,
  buildLeaderboardSummaryPathsForChangedStats,
  playerLikeWithStatOverlay,
} from './leaderboard-summaries.js';
import {
  clearTradeGrant,
  mergeTradeGrantClear,
  resolveClaimerAuthUid,
} from './trade-grants.js';

/** Dev-only localStorage gate. Absent/false → identical production behavior. */
export const DIRECT_INVENTORY_DIAG_LS_KEY = 'qc-direct-inventory-diag';

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
    claimWon: null,
    claimId: null,
    recoveryOutcome: null,
    rejectionClassification: null,
    log(phase, payload = {}) {
      const entry = {
        tag: '[DirectInventoryDiag]',
        attemptId,
        tradeId: tid,
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
 * Planner diag for relative increments — no authoritative “planned absolute after”.
 * @returns {object|null}
 */
export function buildPlanInventoryDiag({
  offeringPlayerId,
  targetPlayerId,
  offeredCardId,
  requestedCardId,
  offeringPlayer,
  targetPlayer,
  updates,
}) {
  const offerBeforeGive = _invQty(offeringPlayer?.inventory, offeredCardId);
  const offerBeforeRecv = _invQty(offeringPlayer?.inventory, requestedCardId);
  const targetBeforeGive = _invQty(targetPlayer?.inventory, requestedCardId);
  const targetBeforeRecv = _invQty(targetPlayer?.inventory, offeredCardId);

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

  const incrementDeltas = {
    [offerGivePath]: -1,
    [offerRecvPath]: 1,
    [targetGivePath]: -1,
    [targetRecvPath]: 1,
  };

  return {
    offeredCardId,
    requestedCardId,
    model: 'relative-increment',
    incrementDeltas,
    offerer: {
      username: offeringPlayerId,
      giveCardId: offeredCardId,
      receiveCardId: requestedCardId,
      giveBefore: offerBeforeGive,
      receiveBefore: offerBeforeRecv,
      expectedGiveDelta: -1,
      expectedReceiveDelta: 1,
      involvedTotalBefore: offerBeforeGive + offerBeforeRecv,
    },
    target: {
      username: targetPlayerId,
      giveCardId: requestedCardId,
      receiveCardId: offeredCardId,
      giveBefore: targetBeforeGive,
      receiveBefore: targetBeforeRecv,
      expectedGiveDelta: -1,
      expectedReceiveDelta: 1,
      involvedTotalBefore: targetBeforeGive + targetBeforeRecv,
    },
    inventoryPaths,
  };
}

/**
 * Compare force-loaded before vs post-ack server quantities (four cards).
 * Uses expected deltas — does not assume authoritative planned absolute after.
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

    const serverGive = s.giveQty;
    const serverRecv = s.receiveQty;
    const involvedTotalServer = serverGive + serverRecv;
    const observedGiveDelta = serverGive - p.giveBefore;
    const observedReceiveDelta = serverRecv - p.receiveBefore;

    const participant = {
      side,
      username: p.username,
      giveCardId: p.giveCardId,
      receiveCardId: p.receiveCardId,
      loadedBefore: { give: p.giveBefore, receive: p.receiveBefore, total: p.involvedTotalBefore },
      expectedDeltas: { give: p.expectedGiveDelta, receive: p.expectedReceiveDelta },
      serverAfterAck: { give: serverGive, receive: serverRecv, total: involvedTotalServer },
      observedGiveDelta,
      observedReceiveDelta,
      expectedGiveDeltaMatches: p.expectedGiveDelta === -1,
      expectedReceiveDeltaMatches: p.expectedReceiveDelta === 1,
      observedGiveDeltaMatchesExpected: observedGiveDelta === p.expectedGiveDelta,
      observedReceiveDeltaMatchesExpected: observedReceiveDelta === p.expectedReceiveDelta,
      serverTotalConservedVsLoaded: involvedTotalServer === p.involvedTotalBefore,
    };

    if (!participant.expectedGiveDeltaMatches || !participant.expectedReceiveDeltaMatches) {
      flags.push('PLANNER_DELTA_UNEXPECTED');
    }
    if (!participant.observedGiveDeltaMatchesExpected || !participant.observedReceiveDeltaMatchesExpected) {
      flags.push('POST_ACK_DELTA_NE_EXPECTED');
    }
    if (!participant.serverTotalConservedVsLoaded) {
      flags.push('DIRECT_INVENTORY_TOTAL_DRIFT');
    }

    participants.push(participant);
  }

  // Same-rarity conservation across both participants' involved totals
  if (participants.length === 2) {
    const t0 = participants[0].loadedBefore.total;
    const t1 = participants[1].loadedBefore.total;
    const s0 = participants[0].serverAfterAck.total;
    const s1 = participants[1].serverAfterAck.total;
    if (t0 === t1 && s0 === s1 && s0 === t0) {
      /* conserved */
    } else if (t0 + t1 !== s0 + s1) {
      flags.push('CROSS_PLAYER_INVOLVED_TOTAL_NOT_CONSERVED');
    }
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
 *   statsReadable=true (own player): absolute tradesCompleted + achievements + LB overlays.
 *   statsReadable=false (foreign counterparty): claimer cannot read foreign stats under S8c-1;
 *   use ServerValue.increment(1) for tradesCompleted; skip achievements; caller must omit
 *   foreign tradesCompleted leaderboard absolute row (would be wrong).
 * @returns {{ updates: Object, plannedStatValues: Object, leaderboardStatKeys: string[], notified: string[], unlocked: string[] }}
 */
function planPlayerPostTradeSideEffects(username, nextInventory, now, options = {}) {
  const statsReadable = options.statsReadable !== false;
  const updates = {};
  const plannedStatValues = {};
  const achStatKeys = [];
  /** @type {string[]} */
  const leaderboardStatKeys = [];

  if (statsReadable) {
    const prevTrades = getPlayerStat(username, STAT_KEYS.TRADES_COMPLETED);
    const nextTrades = prevTrades + 1;
    updates[`players/${username}/stats/tradesCompleted`] = nextTrades;
    plannedStatValues[STAT_KEYS.TRADES_COMPLETED] = nextTrades;
    achStatKeys.push(STAT_KEYS.TRADES_COMPLETED);
    leaderboardStatKeys.push(STAT_TYPES.TRADES_COMPLETED);
  } else {
    // Foreign: exact +1 via increment (client cannot read foreign stats for absolute write).
    updates[`players/${username}/stats/tradesCompleted`] = serverIncrement(1);
  }

  const prevUnique = getPlayerStat(username, STAT_KEYS.UNIQUE_CARDS_OWNED);
  const nextUnique = computeUniqueCardsOwnedFromInventory(nextInventory);
  if (nextUnique !== prevUnique) {
    updates[`players/${username}/stats/uniqueCardsOwned`] = nextUnique;
  }
  plannedStatValues[STAT_KEYS.UNIQUE_CARDS_OWNED] = nextUnique;
  achStatKeys.push(STAT_KEYS.UNIQUE_CARDS_OWNED);
  if (nextUnique !== prevUnique || statsReadable) {
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
    });
    Object.assign(updates, achPlan.updates);
    notified = achPlan.notified;
    unlocked = achPlan.unlocked;
  }
  // Foreign achievements deferred: claimer cannot read foreign achievement map / trade stats.

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
 * Build relative multi-path updates for a claimed direct-trade accept.
 * Caller must have claimed (processing) and validated eligibility + cooldowns.
 *
 * @returns {{ ok: boolean, reason?: string, updates?: Object, giveLeafPaths?: string[], notifiedOfferer?: string[], notifiedTarget?: string[] }}
 */
export function buildDirectTradeAcceptPlan({
  tradeId,
  claimId,
  offeringPlayerId,
  targetPlayerId,
  offeredCardId,
  requestedCardId,
  offeringPlayer,
  targetPlayer,
  now,
} = {}) {
  if (!tradeId || !claimId || !offeringPlayerId || !targetPlayerId || !offeredCardId || !requestedCardId) {
    return { ok: false, reason: 'INVALID_TRADE_PLAN' };
  }
  if (offeredCardId === requestedCardId) {
    return { ok: false, reason: 'SAME_CARD_BOTH_SIDES' };
  }
  if (!Number.isFinite(Number(now))) {
    return { ok: false, reason: 'INVALID_TIMESTAMP' };
  }

  // Soft precheck only — server inventory >=0 validate is the hard oversell guard.
  if ((offeringPlayer?.inventory?.[offeredCardId] || 0) < 1) {
    return { ok: false, reason: 'OFFERING_CARD_NOT_AVAILABLE' };
  }
  if ((targetPlayer?.inventory?.[requestedCardId] || 0) < 1) {
    return { ok: false, reason: 'REQUESTED_CARD_NOT_AVAILABLE' };
  }

  const offeringLogical = logicalInventoryAfterSwap(
    offeringPlayer?.inventory,
    offeredCardId,
    requestedCardId,
  );
  const targetLogical = logicalInventoryAfterSwap(
    targetPlayer?.inventory,
    requestedCardId,
    offeredCardId,
  );

  const updates = {
    [`trades/direct/${tradeId}/status`]: 'accepted',
    [`trades/direct/${tradeId}/completedAt`]: now,
    [`trades/direct/${tradeId}/processingBy`]: null,
    [`trades/direct/${tradeId}/processingAt`]: null,
    [`trades/direct/${tradeId}/claimId`]: null,
    [`trades/direct/${tradeId}/claimerAuthUid`]: null,
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

  // S8c-1: clear claim-scoped foreign inventory grant in the same terminal multipath
  mergeTradeGrantClear(updates, targetPlayerId, resolveClaimerAuthUid());

  const offererGive = appendInventoryIncrementSwapPaths(
    updates,
    offeringPlayerId,
    offeredCardId,
    requestedCardId,
    offeringPlayer?.inventory,
  );
  appendInventoryIncrementSwapPaths(
    updates,
    targetPlayerId,
    requestedCardId,
    offeredCardId,
    targetPlayer?.inventory,
  );

  // Claimer is offerer (confirm path). Target is foreign under tradeGrant — cannot read target stats.
  const offererSide = planPlayerPostTradeSideEffects(offeringPlayerId, offeringLogical, now, {
    statsReadable: true,
  });
  const targetSide = planPlayerPostTradeSideEffects(targetPlayerId, targetLogical, now, {
    statsReadable: false,
  });
  Object.assign(updates, offererSide.updates, targetSide.updates);

  const offererLike = playerLikeWithStatOverlay(offeringPlayer, {
    [STAT_TYPES.TRADES_COMPLETED]: offererSide.plannedStatValues[STAT_KEYS.TRADES_COMPLETED],
    [STAT_TYPES.UNIQUE_CARDS_OWNED]: offererSide.plannedStatValues[STAT_KEYS.UNIQUE_CARDS_OWNED],
  });
  const targetLike = playerLikeWithStatOverlay(targetPlayer, {
    [STAT_TYPES.UNIQUE_CARDS_OWNED]: targetSide.plannedStatValues[STAT_KEYS.UNIQUE_CARDS_OWNED],
  });
  Object.assign(
    updates,
    buildLeaderboardSummaryPathsForChangedStats(
      offeringPlayerId,
      offererLike,
      offererSide.leaderboardStatKeys,
      now,
    ),
    buildLeaderboardSummaryPathsForChangedStats(
      targetPlayerId,
      targetLike,
      targetSide.leaderboardStatKeys,
      now,
    ),
  );

  assertNoOverlappingUpdatePaths(updates);

  if (terminalPayloadHasAbsoluteInventoryQty(updates)) {
    return { ok: false, reason: 'INVALID_TRADE_PLAN' };
  }

  // Post-commit zero cleanup: own give leaf only (claimer = offerer). Foreign leaf
  // is already nulled in-terminal when qty===1; after grant clear, foreign cleanup is denied.
  // When qty>1, foreign remaining positive needs no cleanup.
  const giveLeafPaths = [];
  if (!offererGive.giveNulled) {
    giveLeafPaths.push(`players/${offeringPlayerId}/inventory/${offeredCardId}`);
  }

  const result = {
    ok: true,
    updates,
    giveLeafPaths,
    notifiedOfferer: offererSide.notified,
    notifiedTarget: targetSide.notified,
    unlockedOfferer: offererSide.unlocked,
    unlockedTarget: targetSide.unlocked,
    writeCount: 1,
  };

  if (isDirectInventoryDiagEnabled()) {
    result.inventoryDiag = buildPlanInventoryDiag({
      offeringPlayerId,
      targetPlayerId,
      offeredCardId,
      requestedCardId,
      offeringPlayer,
      targetPlayer,
      updates,
    });
  }

  return result;
}

/**
 * Mark trade failed only while still awaiting offerer confirmation (pre-claim).
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

/**
 * Mark failed only while this claim still owns processing. Clears claim fields + removes indexes.
 * @returns {Promise<{ marked: boolean, reason?: string, currentStatus?: string, error?: string }>}
 */
export async function markDirectTradeFailedIfProcessingOwned(
  tradeId,
  claimId,
  failureReason,
  now = Date.now(),
) {
  const trade = db.get(`trades/direct/${tradeId}`);
  if (!trade) {
    return { marked: false, reason: 'TRADE_NOT_FOUND', currentStatus: null };
  }
  if (trade.status !== 'processing' || trade.claimId !== claimId) {
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
    [`trades/direct/${id}/processingBy`]: null,
    [`trades/direct/${id}/processingAt`]: null,
    [`trades/direct/${id}/claimId`]: null,
    [`trades/direct/${id}/claimerAuthUid`]: null,
    ...directIndexRemovalsForTrade({ ...trade, id }),
  };
  // S8c-1: clear grant on permanent post-claim failure
  const grantUid = trade.claimerAuthUid || resolveClaimerAuthUid();
  if (trade.targetPlayerId && grantUid) {
    mergeTradeGrantClear(updates, trade.targetPlayerId, grantUid);
  }
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

/**
 * Release owned processing claim and restore both PTI leaves to awaiting_offerer_confirmation.
 * @returns {Promise<{ ok: boolean, released?: boolean, indexRestored?: boolean, error?: string }>}
 */
export async function releaseDirectClaimAndRestoreIndex(tradeId, claimId, reason) {
  const preTrade = db.get(`trades/direct/${tradeId}`);
  const grantTarget = preTrade?.targetPlayerId || null;
  const grantUid = preTrade?.claimerAuthUid || resolveClaimerAuthUid();

  const release = await db.releaseDirectTradeClaimIfOwned(tradeId, claimId);
  if (!release.ok) {
    console.warn(`[Trading] Failed to release claim ${claimId} on ${tradeId}:`, release.error);
    return { ok: false, released: false, indexRestored: false, error: release.error };
  }
  if (!release.released) {
    return { ok: true, released: false, indexRestored: false };
  }
  const restored = release.trade || db.get(`trades/direct/${tradeId}`);
  if (!restored) {
    if (grantTarget && grantUid) {
      await clearTradeGrant(grantTarget, grantUid);
    }
    return { ok: true, released: true, indexRestored: false, error: 'Trade missing after release' };
  }
  const restorePaths = directReleaseIndexRestorePaths({
    ...restored,
    id: restored.id || tradeId,
    status: 'awaiting_offerer_confirmation',
  });
  // S8c-1: clear grant on release (same multipath when possible)
  if (grantTarget && grantUid) {
    mergeTradeGrantClear(restorePaths, grantTarget, grantUid);
  }
  if (Object.keys(restorePaths).length === 0) {
    return { ok: true, released: true, indexRestored: true };
  }
  const ack = await db.updateAcknowledged(restorePaths);
  metrics.recordTradeIndexLifecycle({
    tag: 'direct-release-index-restore',
    ops: 1,
    ok: ack.ok,
    username: restored.offeringPlayerId,
  });
  if (!ack.ok) {
    console.warn(
      `[TradeIndex] Claim released but index restore failed for trade ${tradeId} (${reason}). ` +
        'Rebuild Trade Indexes. Trade is awaiting_offerer_confirmation canonical.',
      ack.error,
    );
    return { ok: false, released: true, indexRestored: false, error: ack.error };
  }
  return { ok: true, released: true, indexRestored: true };
}

/**
 * Optional best-effort give-leaf hygiene after accept (missing ≡ qty 0 for ownership).
 * Never rolls back or replays the accepted trade; cleanup failure is non-fatal.
 * @param {string[]} giveLeafPaths
 * @param {object|null} diag
 */
export async function cleanupZeroGiveLeavesAfterAccept(giveLeafPaths, diag = null) {
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

async function withDirectTradeLock(tradeId, fn) {
  const lockName = `qc-direct-trade:${tradeId}`;
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(lockName, { mode: 'exclusive' }, () => fn());
  }
  return fn();
}

function _isPermissionDenied(err) {
  return /PERMISSION_DENIED/i.test(String(err || ''));
}

/**
 * Apply only literal (non-.sv) paths from a plan after recovered accepted ack.
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
 * Reread canonical trade after uncertain terminal ack. Never replays increments.
 * @returns {Promise<{ outcome: 'success'|'released'|'uncertain'|'failed_classified', trade?: object|null, reason?: string, error?: string }>}
 */
export async function recoverDirectAcceptAfterAckError(tradeId, claimId, ackError, classifyFn) {
  const remote = await db.getAcknowledged(`trades/direct/${tradeId}`);
  if (!remote.ok) {
    return {
      outcome: 'uncertain',
      trade: null,
      error: remote.error || 'Could not re-read trade after write failure',
    };
  }

  const trade = remote.value;
  if (trade && trade.status === 'accepted') {
    return { outcome: 'success', trade };
  }

  if (trade && trade.status === 'processing' && trade.claimId === claimId) {
    let classifiedReason = null;
    if (typeof classifyFn === 'function') {
      try {
        classifiedReason = await classifyFn(ackError, trade);
      } catch { /* ignore */ }
    }

    if (classifiedReason === 'INSUFFICIENT_AVAILABLE_COPIES') {
      const marked = await markDirectTradeFailedIfProcessingOwned(
        tradeId,
        claimId,
        'INSUFFICIENT_AVAILABLE_COPIES',
      );
      if (marked.marked) {
        return {
          outcome: 'failed_classified',
          trade: db.get(`trades/direct/${tradeId}`),
          reason: 'INSUFFICIENT_AVAILABLE_COPIES',
        };
      }
      // Fall through to release attempt if fail write itself failed
    }

    const release = await releaseDirectClaimAndRestoreIndex(
      tradeId,
      claimId,
      classifiedReason || 'TERMINAL_WRITE_FAILED',
    );
    if (release.released) {
      return {
        outcome: 'released',
        trade: db.get(`trades/direct/${tradeId}`),
        reason: classifiedReason || 'WRITE_FAILED',
        error: ackError,
      };
    }
    return {
      outcome: 'uncertain',
      trade,
      reason: 'WRITE_UNCERTAIN',
      error: release.error || ackError || 'Could not release direct claim',
    };
  }

  return { outcome: 'uncertain', trade, reason: 'WRITE_UNCERTAIN' };
}

/**
 * Commit a pre-built accept plan while claim owns processing.
 * On ack failure: never replay increments; reread → accepted / release / uncertain.
 *
 * @param {string} tradeId
 * @param {string} claimId
 * @param {Object} plan
 * @param {{ diag?: object|null, classifyPermissionDenied?: Function }} [options]
 */
export async function commitDirectTradeAcceptPlan(tradeId, claimId, plan, options = {}) {
  const diag = options && options.diag ? options.diag : null;
  const classifyPermissionDenied = options.classifyPermissionDenied || null;
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

    const statusCheck = db.get(`trades/direct/${tradeId}`);
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
        giveLeafPaths: plan.giveLeafPaths || [],
        transformedPaths: ack.transformedPaths || [],
      };
    }

    // Never replay increments. Classify / release / uncertain via reread.
    const classifyFn = async (err) => {
      if (!_isPermissionDenied(err)) return null;
      if (typeof classifyPermissionDenied === 'function') {
        return classifyPermissionDenied(err);
      }
      return null;
    };

    const recovery = await recoverDirectAcceptAfterAckError(
      tradeId,
      claimId,
      ack.error,
      classifyFn,
    );

    if (diag) {
      diag.recoveryOutcome = recovery.outcome;
      diag.rejectionClassification = recovery.reason || null;
      diag.mark('terminalAckRecovery', {
        outcome: recovery.outcome,
        reason: recovery.reason || null,
        permissionDenied: _isPermissionDenied(ack.error),
        currentStatus: recovery.trade?.status ?? null,
      });
    }

    if (recovery.outcome === 'success') {
      applyLiteralPlanPathsLocally(plan.updates);
      return {
        success: true,
        notifiedOfferer: plan.notifiedOfferer || [],
        notifiedTarget: plan.notifiedTarget || [],
        recovered: true,
        writeCount: 1,
        inventoryCommitAttempted: true,
        giveLeafPaths: plan.giveLeafPaths || [],
      };
    }

    if (recovery.outcome === 'failed_classified') {
      return {
        success: false,
        reason: recovery.reason || 'INSUFFICIENT_AVAILABLE_COPIES',
        inventoryCommitAttempted: true,
        classified: true,
      };
    }

    if (recovery.outcome === 'released') {
      return {
        success: false,
        reason: recovery.reason || 'WRITE_FAILED',
        error: recovery.error || ack.error || 'Could not save trade. Check your connection and try again.',
        inventoryCommitAttempted: true,
        released: true,
      };
    }

    console.warn(
      `[Trading] Direct accept ack uncertain for ${tradeId} claim=${claimId}; leaving processing. ` +
        `status=${recovery.trade?.status ?? 'null'}`,
    );
    return {
      success: false,
      reason: 'WRITE_UNCERTAIN',
      error:
        recovery.error
        || ack.error
        || 'Trade may still be processing. Please refresh before retrying.',
      uncertain: true,
      inventoryCommitAttempted: true,
      currentStatus: recovery.trade?.status ?? null,
    };
  });
}
