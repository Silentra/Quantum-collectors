/**
 * Trade Execution Module — Phase T-2 / Hybrid C+ Gate B
 *
 * Isolated helper for atomic direct-trade card swaps.
 * All inventory mutation is contained here. UI handlers must NEVER
 * directly modify inventories for trades.
 *
 * Flow:
 *   claim (awaiting_offerer_confirmation → processing)
 *   → force-load + validate (excludeDirectTradeId)
 *   → one updateAcknowledged with ServerValue.increment(±1) + accepted
 *   → optional zero-leaf cleanup on give cards (never rolls back accept)
 *
 * Listings use claim+fulfill via trade-listing-plan.js (Gate C later).
 */

import * as db from './database.js';
import * as config from './config.js';
import * as metrics from './db-metrics.js';
import { validateDirectTrade, isDetailedLogging } from './trading.js';
import {
  buildDirectTradeAcceptPlan,
  commitDirectTradeAcceptPlan,
  markDirectTradeFailedIfAwaiting,
  markDirectTradeFailedIfProcessingOwned,
  releaseDirectClaimAndRestoreIndex,
  cleanupZeroGiveLeavesAfterAccept,
  isDirectInventoryDiagEnabled,
  createDirectInventoryDiagAttempt,
  buildLoadedSourceDiag,
  evaluateDirectInventoryDiagInvariants,
} from './trade-direct-plan.js';
import { directClaimIndexTransitionPaths } from './trade-index.js';
import {
  loadTradingCounterpartyContext,
  buildCounterpartyAvailabilitySnapshot,
  buildTradingSelfAvailabilitySnapshot,
} from './trade-availability.js';
import { getSession } from './auth.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize a player record so that T-1 validators (which reference `groupId`)
 * work with the actual DB field (`group`).
 */
function _normalizePlayerForValidation(p) {
  if (!p) return p;
  return {
    ...p,
    groupId: p.groupId || p.group || null,
  };
}

function _newClaimId(username) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${username}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {object|null} player
 * @param {string} cardId
 * @returns {number}
 */
function _diagCardQty(player, cardId) {
  const n = player?.inventory?.[cardId];
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * Observation-only post-ack force loads of the two participants (four cards).
 * Never used to retry/recover/alter the trade.
 */
async function _diagPostAckVerify(diag, {
  offeringPlayerId,
  targetPlayerId,
  offeredCardId,
  requestedCardId,
  planDiag,
}) {
  if (!diag || !planDiag) return;

  diag.mark('postAckVerificationStarted', { observationOnly: true });

  let offerPlayer = null;
  let targetPlayer = null;
  let offerOk = false;
  let targetOk = false;

  if (typeof db.loadPathOnce === 'function') {
    const offerLoad = await db.loadPathOnce(`players/${offeringPlayerId}`, { force: true });
    offerOk = !!(offerLoad && offerLoad.ok === true);
    offerPlayer = offerOk ? offerLoad.value : null;

    const targetLoad = await db.loadPathOnce(`players/${targetPlayerId}`, { force: true });
    targetOk = !!(targetLoad && targetLoad.ok === true);
    targetPlayer = targetOk ? targetLoad.value : null;
  }

  const serverQtys = {
    offerer: {
      giveQty: _diagCardQty(offerPlayer, offeredCardId),
      receiveQty: _diagCardQty(offerPlayer, requestedCardId),
    },
    target: {
      giveQty: _diagCardQty(targetPlayer, requestedCardId),
      receiveQty: _diagCardQty(targetPlayer, offeredCardId),
    },
  };

  const invariants = evaluateDirectInventoryDiagInvariants({ planDiag, serverQtys });

  diag.mark('postAckVerificationCompleted', {
    observationOnly: true,
    loadsOk: { offerer: offerOk, target: targetOk },
    serverQtys: {
      offerer: {
        username: offeringPlayerId,
        giveCardId: offeredCardId,
        giveQty: serverQtys.offerer.giveQty,
        receiveCardId: requestedCardId,
        receiveQty: serverQtys.offerer.receiveQty,
      },
      target: {
        username: targetPlayerId,
        giveCardId: requestedCardId,
        giveQty: serverQtys.target.giveQty,
        receiveCardId: offeredCardId,
        receiveQty: serverQtys.target.receiveQty,
      },
    },
    invariants,
    DIRECT_INVENTORY_TOTAL_DRIFT: invariants.flags.includes('DIRECT_INVENTORY_TOTAL_DRIFT'),
    POST_ACK_DELTA_NE_EXPECTED: invariants.flags.includes('POST_ACK_DELTA_NE_EXPECTED'),
  });
}

/**
 * Read the directTradeCooldownMinutes from config.
 * Falls back to 30 if not set.
 */
export function getDirectTradeCooldownMinutes() {
  const val = config.getValue('economy.directTradeCooldownMinutes');
  return typeof val === 'number' ? val : 30;
}

/**
 * Check whether a player is currently on direct-trade cooldown.
 * Returns { onCooldown: boolean, remainingMs: number, readyAt: number }
 */
export function getDirectTradeCooldown(username) {
  const p = db.get(`players/${username}`);
  if (!p) return { onCooldown: false, remainingMs: 0, readyAt: 0 };

  const lastTradeAt = p.lastDirectTradeAt || 0;
  const cooldownMs = getDirectTradeCooldownMinutes() * 60 * 1000;
  const readyAt = lastTradeAt + cooldownMs;
  const now = Date.now();

  if (now >= readyAt) return { onCooldown: false, remainingMs: 0, readyAt };
  return { onCooldown: true, remainingMs: readyAt - now, readyAt };
}

/**
 * Format remaining cooldown as human-readable string.
 * Adapts to duration: days+hours for long cooldowns, minutes+seconds for short.
 */
export function formatCooldown(remainingMs) {
  if (remainingMs <= 0) return 'Ready';
  const totalSec = Math.ceil(remainingMs / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const totalHrs = Math.floor(totalMin / 60);
  const totalDays = Math.floor(totalHrs / 24);

  if (totalDays > 0) {
    const hrs = totalHrs % 24;
    return `${totalDays}d ${hrs}h`;
  }
  if (totalHrs > 0) {
    const mins = totalMin % 60;
    return `${totalHrs}h ${mins}m`;
  }
  const s = totalSec % 60;
  const m = totalMin;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Format a readyAt timestamp as a human-readable date string.
 */
export function formatReadyAt(readyAtMs) {
  if (!readyAtMs || readyAtMs <= Date.now()) return '';
  const d = new Date(readyAtMs);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Pre-claim: mark failed only if still awaiting offerer confirmation.
 * @returns {Promise<{ success: false, reason: string, stale?: boolean, currentStatus?: string }>}
 */
async function failTradeIfAwaiting(tradeId, reason, diag = null) {
  if (diag) {
    diag.mark('exitBeforeInventoryCommit', {
      reason,
      inventoryCommitAttempted: false,
    });
  }
  const result = await markDirectTradeFailedIfAwaiting(tradeId, reason);
  if (!result.marked) {
    return {
      success: false,
      reason: result.reason === 'STALE_TRADE_STATE' ? 'STALE_TRADE_STATE' : reason,
      stale: result.reason === 'STALE_TRADE_STATE',
      currentStatus: result.currentStatus,
    };
  }
  return { success: false, reason };
}

/**
 * Post-claim permanent failure: fail while still owning processing + remove indexes.
 */
async function failTradeIfProcessingOwned(tradeId, claimId, reason, diag = null) {
  if (diag) {
    diag.mark('permanentPostClaimFailure', {
      reason,
      claimId,
      inventoryCommitAttempted: false,
    });
  }
  const result = await markDirectTradeFailedIfProcessingOwned(tradeId, claimId, reason);
  if (!result.marked) {
    // Still try release so we do not leave processing stuck
    await releaseDirectClaimAndRestoreIndex(tradeId, claimId, `FAIL_MARK_MISSED:${reason}`);
    return {
      success: false,
      reason: result.reason === 'STALE_TRADE_STATE' ? 'STALE_TRADE_STATE' : reason,
      stale: result.reason === 'STALE_TRADE_STATE',
      currentStatus: result.currentStatus,
    };
  }
  return { success: false, reason };
}

/**
 * Transient post-claim: release back to awaiting_offerer_confirmation.
 */
async function releaseAfterTransient(tradeId, claimId, reason, diag = null) {
  if (diag) {
    diag.mark('transientPostClaimRelease', { reason, claimId });
  }
  const released = await releaseDirectClaimAndRestoreIndex(tradeId, claimId, reason);
  return {
    success: false,
    reason,
    claimReleased: !!released.released,
    error: released.error,
  };
}

/**
 * Revalidate after PERMISSION_DENIED: if a give copy is unavailable → INSUFFICIENT_AVAILABLE_COPIES.
 * Otherwise null (generic recoverable rejection).
 */
async function classifyPermissionDeniedForDirect({
  tradeId,
  offeringPlayerId,
  targetPlayerId,
  offeredCardId,
  requestedCardId,
}) {
  const offeringCtx = await loadTradingCounterpartyContext(offeringPlayerId, { force: true });
  const targetCtx = await loadTradingCounterpartyContext(targetPlayerId, { force: true });
  if (!offeringCtx.ok || !targetCtx.ok || !offeringCtx.player || !targetCtx.player) {
    return null;
  }

  const players = {
    [offeringPlayerId]: _normalizePlayerForValidation(offeringCtx.player),
    [targetPlayerId]: _normalizePlayerForValidation(targetCtx.player),
  };
  const allCards = db.get('cards') || {};
  const excludeIds = tradeId ? [tradeId] : [];

  const offeringSnapshot = buildCounterpartyAvailabilitySnapshot(offeringPlayerId, offeringCtx, {
    playerData: players[offeringPlayerId],
    excludeDirectTradeIds: excludeIds,
  });
  const targetSnapshot = buildCounterpartyAvailabilitySnapshot(targetPlayerId, targetCtx, {
    playerData: players[targetPlayerId],
    excludeDirectTradeIds: excludeIds,
  });

  const validation = validateDirectTrade({
    offeringPlayerId,
    targetPlayerId,
    offeredCardId,
    requestedCardId,
    players,
    cards: allCards,
    excludeDirectTradeId: tradeId,
    offeringAvailabilitySnapshot: offeringSnapshot,
    targetAvailabilitySnapshot: targetSnapshot,
    skipHiddenTargetCheck: true,
  });

  if (!validation.valid) {
    const r = validation.reason;
    if (
      r === 'INSUFFICIENT_AVAILABLE_COPIES'
      || r === 'OFFERING_PLAYER_MISSING_OFFERED_CARD'
      || r === 'TARGET_PLAYER_MISSING_REQUESTED_CARD'
      || r === 'OFFERING_CARD_NOT_AVAILABLE'
      || r === 'REQUESTED_CARD_NOT_AVAILABLE'
    ) {
      return 'INSUFFICIENT_AVAILABLE_COPIES';
    }
  }

  // Soft qty on give cards
  if ((offeringCtx.player.inventory?.[offeredCardId] || 0) < 1) {
    return 'INSUFFICIENT_AVAILABLE_COPIES';
  }
  if ((targetCtx.player.inventory?.[requestedCardId] || 0) < 1) {
    return 'INSUFFICIENT_AVAILABLE_COPIES';
  }

  return null;
}

// ─── Atomic Trade Execution ─────────────────────────────────────────────────

/**
 * Execute a direct trade (claim + relative inventory terminal write).
 *
 * This is the ONLY function that mutates inventories for direct trades.
 *
 * Requires trade.status === awaiting_offerer_confirmation (pre-claim) and a non-null requestedCardId.
 *
 * @param {object} trade - The trade object from /trades/direct/{id}
 * @returns {Promise<{ success: boolean, reason?: string, notifiedOfferer?: string[], stale?: boolean, uncertain?: boolean }>}
 */
export async function executeDirectTrade(trade) {
  const {
    id: tradeId,
    offeringPlayerId,
    targetPlayerId,
    offeredCardId,
    requestedCardId,
  } = trade;

  const diag = isDirectInventoryDiagEnabled()
    ? createDirectInventoryDiagAttempt(tradeId)
    : null;
  if (diag) {
    diag.mark('executeEntered', { inventoryCommitAttempted: false });
  }

  // ── 0. Cache precheck — awaiting offerer confirm ───────────────────────────
  const freshTrade = db.get(`trades/direct/${tradeId}`);
  if (diag) {
    diag.mark('cacheStatusChecked', {
      status: freshTrade?.status ?? null,
      cacheOnly: true,
    });
  }
  if (!freshTrade || freshTrade.status !== 'awaiting_offerer_confirmation') {
    console.log(`[Trading] Trade ${tradeId} skipped — status is '${freshTrade?.status}', not 'awaiting_offerer_confirmation'`);
    if (diag) {
      diag.mark('exitBeforeInventoryCommit', {
        reason: 'STALE_TRADE_STATE',
        inventoryCommitAttempted: false,
        currentStatus: freshTrade?.status ?? null,
      });
      diag.claimWon = false;
    }
    return {
      success: false,
      reason: 'STALE_TRADE_STATE',
      stale: true,
      currentStatus: freshTrade?.status ?? null,
    };
  }

  const resolvedRequestedId = freshTrade.requestedCardId || requestedCardId;
  if (!resolvedRequestedId) {
    return await failTradeIfAwaiting(tradeId, 'REQUESTED_CARD_NOT_FOUND', diag);
  }

  const resolvedOfferedId = freshTrade.offeredCardId || offeredCardId;
  const resolvedOffering = freshTrade.offeringPlayerId || offeringPlayerId;
  const resolvedTarget = freshTrade.targetPlayerId || targetPlayerId;

  if (resolvedOfferedId === resolvedRequestedId) {
    return await failTradeIfAwaiting(tradeId, 'SAME_CARD_BOTH_SIDES', diag);
  }

  let me = '';
  try {
    const session = getSession();
    if (session?.username && session.username !== '__admin__') {
      me = String(session.username).trim();
    }
  } catch { /* ignore */ }

  const processingBy = me || resolvedOffering;
  const claimId = _newClaimId(processingBy);
  if (diag) {
    diag.claimId = claimId;
  }

  // ── 1. Server claim: awaiting_offerer_confirmation → processing ────────────
  const claimNow = Date.now();
  const claim = await db.claimDirectTradeIfAwaiting(tradeId, {
    processingBy,
    claimId,
    now: claimNow,
  });

  if (!claim.ok) {
    if (diag) {
      diag.claimWon = false;
      diag.mark('claimFailed', { error: claim.error || 'WRITE_FAILED' });
    }
    return {
      success: false,
      reason: 'WRITE_FAILED',
      error: claim.error || 'Could not claim trade',
    };
  }
  if (!claim.claimed) {
    if (diag) {
      diag.claimWon = false;
      diag.mark('claimLost', {
        reason: claim.reason || 'STALE_TRADE_STATE',
        currentStatus: claim.trade?.status ?? null,
      });
    }
    return {
      success: false,
      reason: 'STALE_TRADE_STATE',
      stale: true,
      currentStatus: claim.trade?.status ?? null,
    };
  }

  if (diag) {
    diag.claimWon = true;
    diag.mark('claimWon', {
      claimId,
      processingBy,
      sameTradeClaimWinnerProof: {
        tradeId,
        claimId,
        processingBy,
        status: 'processing',
      },
    });
  }

  const claimedTrade = claim.trade || db.get(`trades/direct/${tradeId}`);

  // ── 1b. PTI leaves stay; update status → processing ────────────────────────
  const transitionPaths = directClaimIndexTransitionPaths({
    ...claimedTrade,
    id: claimedTrade?.id || tradeId,
    status: 'processing',
  });
  if (Object.keys(transitionPaths).length === 0) {
    console.warn(`[TradeIndex] Empty claim index transition for direct ${tradeId}; releasing claim.`);
    return await releaseAfterTransient(tradeId, claimId, 'WRITE_FAILED', diag);
  }
  const transitionAck = await db.updateAcknowledged(transitionPaths);
  metrics.recordTradeIndexLifecycle({
    tag: 'direct-claim-index-transition',
    ops: 1,
    ok: transitionAck.ok,
    username: resolvedOffering,
  });
  if (!transitionAck.ok) {
    console.warn(
      `[TradeIndex] Post-claim index transition failed for direct ${tradeId}; releasing claim.`,
      transitionAck.error,
    );
    return await releaseAfterTransient(tradeId, claimId, 'WRITE_FAILED', diag);
  }

  // ── 2. Force-load both participants (player + PTI) after claim ─────────────
  if (diag) {
    diag.mark('forcePlayerLoadsStarted', {
      offeringPlayerId: resolvedOffering,
      targetPlayerId: resolvedTarget,
    });
  }

  const offeringCtx = await loadTradingCounterpartyContext(resolvedOffering, { force: true });
  if (!offeringCtx.ok) {
    return await releaseAfterTransient(
      tradeId,
      claimId,
      offeringCtx.reason || 'COUNTERPARTY_LOAD_FAILED',
      diag,
    );
  }
  const targetCtx = await loadTradingCounterpartyContext(resolvedTarget, { force: true });
  if (!targetCtx.ok) {
    return await releaseAfterTransient(
      tradeId,
      claimId,
      targetCtx.reason || 'COUNTERPARTY_LOAD_FAILED',
      diag,
    );
  }

  const freshOffering = offeringCtx.player;
  const freshTarget = targetCtx.player;

  if (diag) {
    diag.mark('forcePlayerLoadsCompleted', {
      offeringOk: !!freshOffering,
      targetOk: !!freshTarget,
    });
  }

  if (!freshOffering) {
    return await releaseAfterTransient(tradeId, claimId, 'OFFERING_PLAYER_NOT_FOUND', diag);
  }
  if (!freshTarget) {
    return await releaseAfterTransient(tradeId, claimId, 'TARGET_PLAYER_NOT_FOUND', diag);
  }

  if (diag) {
    diag.mark('forceLoadedSourceQuantities', buildLoadedSourceDiag({
      tradeId,
      offeringPlayerId: resolvedOffering,
      targetPlayerId: resolvedTarget,
      offeredCardId: resolvedOfferedId,
      requestedCardId: resolvedRequestedId,
      offeringPlayer: freshOffering,
      targetPlayer: freshTarget,
    }));
  }

  // ── 3. Card defs + T-1 validation (exclude this trade from reservation math) ─
  const allCards = db.get('cards') || {};
  const players = {
    [resolvedOffering]: _normalizePlayerForValidation(freshOffering),
    [resolvedTarget]: _normalizePlayerForValidation(freshTarget),
  };

  const excludeIds = tradeId ? [tradeId] : [];
  const meKey = me.toLowerCase();
  const offeringSnapshot = (meKey && resolvedOffering.toLowerCase() === meKey)
    ? buildTradingSelfAvailabilitySnapshot(resolvedOffering, {
      playerData: players[resolvedOffering],
      excludeDirectTradeIds: excludeIds,
    })
    : buildCounterpartyAvailabilitySnapshot(resolvedOffering, offeringCtx, {
      playerData: players[resolvedOffering],
      excludeDirectTradeIds: excludeIds,
    });
  const targetSnapshot = (meKey && resolvedTarget.toLowerCase() === meKey)
    ? buildTradingSelfAvailabilitySnapshot(resolvedTarget, {
      playerData: players[resolvedTarget],
      excludeDirectTradeIds: excludeIds,
    })
    : buildCounterpartyAvailabilitySnapshot(resolvedTarget, targetCtx, {
      playerData: players[resolvedTarget],
      excludeDirectTradeIds: excludeIds,
    });

  const validation = validateDirectTrade({
    offeringPlayerId: resolvedOffering,
    targetPlayerId: resolvedTarget,
    offeredCardId: resolvedOfferedId,
    requestedCardId: resolvedRequestedId,
    players,
    cards: allCards,
    excludeDirectTradeId: tradeId,
    offeringAvailabilitySnapshot: offeringSnapshot,
    targetAvailabilitySnapshot: targetSnapshot,
    skipHiddenTargetCheck: true,
  });

  if (!validation.valid) {
    if (isDetailedLogging()) {
      console.log(`[Trading][DETAIL] Trade ${tradeId} failed validation after claim: ${validation.reason} (${resolvedOffering} → ${resolvedTarget}, offered=${resolvedOfferedId}, requested=${resolvedRequestedId})`);
    }
    return await failTradeIfProcessingOwned(tradeId, claimId, validation.reason, diag);
  }

  // ── 4. Cooldowns (permanent fail — same as pre-Gate-B behavior) ────────────
  const offeringCooldown = getDirectTradeCooldown(resolvedOffering);
  if (offeringCooldown.onCooldown) {
    return await failTradeIfProcessingOwned(tradeId, claimId, 'OFFERING_PLAYER_ON_COOLDOWN', diag);
  }
  const targetCooldown = getDirectTradeCooldown(resolvedTarget);
  if (targetCooldown.onCooldown) {
    return await failTradeIfProcessingOwned(tradeId, claimId, 'TARGET_PLAYER_ON_COOLDOWN', diag);
  }

  // ── 5. Relative plan (no absolute inventory quantities) ────────────────────
  const now = Date.now();
  const plan = buildDirectTradeAcceptPlan({
    tradeId,
    claimId,
    offeringPlayerId: resolvedOffering,
    targetPlayerId: resolvedTarget,
    offeredCardId: resolvedOfferedId,
    requestedCardId: resolvedRequestedId,
    offeringPlayer: freshOffering,
    targetPlayer: freshTarget,
    now,
  });

  if (!plan.ok) {
    return await failTradeIfProcessingOwned(tradeId, claimId, plan.reason || 'INVALID_TRADE_PLAN', diag);
  }

  if (diag) {
    diag.mark('planBuilt', {
      inventoryDiag: plan.inventoryDiag || null,
      giveLeafPaths: plan.giveLeafPaths || null,
      note: 'Relative increments; no absolute planned-after inventory authority',
    });
  }

  // ── 6. Lock (UX) + terminal updateAcknowledged under owned claim ───────────
  const commit = await commitDirectTradeAcceptPlan(tradeId, claimId, plan, {
    diag,
    classifyPermissionDenied: async () => classifyPermissionDeniedForDirect({
      tradeId,
      offeringPlayerId: resolvedOffering,
      targetPlayerId: resolvedTarget,
      offeredCardId: resolvedOfferedId,
      requestedCardId: resolvedRequestedId,
    }),
  });

  if (!commit.success) {
    if (diag) {
      diag.mark('commitFailed', {
        reason: commit.reason || 'WRITE_FAILED',
        inventoryCommitAttempted: commit.inventoryCommitAttempted === true,
        currentStatus: commit.currentStatus ?? null,
        uncertain: commit.uncertain === true,
        released: commit.released === true,
      });
    }
    if (commit.reason === 'STALE_TRADE_STATE') {
      return {
        success: false,
        reason: 'STALE_TRADE_STATE',
        stale: true,
        currentStatus: commit.currentStatus,
      };
    }
    if (commit.uncertain || commit.reason === 'WRITE_UNCERTAIN') {
      return {
        success: false,
        reason: 'WRITE_UNCERTAIN',
        uncertain: true,
        error: commit.error,
        currentStatus: commit.currentStatus,
      };
    }
    return {
      success: false,
      reason: commit.reason || 'WRITE_FAILED',
      error: commit.error,
    };
  }

  // ── 7. Zero-leaf cleanup (give cards only; never undoes accept) ────────────
  await cleanupZeroGiveLeavesAfterAccept(commit.giveLeafPaths || plan.giveLeafPaths || [], diag);

  // Optional UI convergence: refresh transformed inventory paths without synthesizing deltas
  if (Array.isArray(commit.transformedPaths) && commit.transformedPaths.length > 0
    && typeof db.loadPathOnce === 'function') {
    const playerRoots = new Set();
    for (const p of commit.transformedPaths) {
      const m = String(p).match(/^players\/([^/]+)\//);
      if (m) playerRoots.add(`players/${m[1]}`);
    }
    for (const root of playerRoots) {
      try {
        await db.loadPathOnce(root, { force: true });
      } catch { /* ignore — accept already committed */ }
    }
  }

  if (diag && plan.inventoryDiag) {
    await _diagPostAckVerify(diag, {
      offeringPlayerId: resolvedOffering,
      targetPlayerId: resolvedTarget,
      offeredCardId: resolvedOfferedId,
      requestedCardId: resolvedRequestedId,
      planDiag: plan.inventoryDiag,
    });
  }

  if (isDetailedLogging()) {
    console.log(`[Trading][DETAIL] Trade ${tradeId} completed: ${resolvedOffering} gave ${resolvedOfferedId}, ${resolvedTarget} gave ${resolvedRequestedId}, cooldowns applied at ${now}`);
  } else {
    console.log(`[Trading] Trade ${tradeId} completed: ${resolvedOffering} gave ${resolvedOfferedId}, ${resolvedTarget} gave ${resolvedRequestedId}`);
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
    notifiedOfferer: commit.notifiedOfferer || [],
    writeCount: 1,
  };
}
