/**
 * Trade Execution Module — Phase T-2
 *
 * Isolated helper for atomic direct-trade card swaps.
 * All inventory mutation is contained here. UI handlers must NEVER
 * directly modify inventories for trades.
 *
 * Final acceptance commits via one updateAcknowledged multi-path write
 * (see trade-direct-plan.js). Listings use claim+fulfill via trade-listing-plan.js.
 */

import * as db from './database.js';
import * as config from './config.js';
import { validateDirectTrade, isDetailedLogging } from './trading.js';
import {
  buildDirectTradeAcceptPlan,
  commitDirectTradeAcceptPlan,
  markDirectTradeFailedIfAwaiting,
  isDirectInventoryDiagEnabled,
  createDirectInventoryDiagAttempt,
  buildLoadedSourceDiag,
  evaluateDirectInventoryDiagInvariants,
} from './trade-direct-plan.js';
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
 * Attempt to mark trade failed only if still awaiting offerer confirmation.
 * @returns {Promise<{ success: false, reason: string, stale?: boolean, currentStatus?: string }>}
 */
async function failTradeIfActionable(tradeId, reason, diag = null) {
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

// ─── Atomic Trade Execution ─────────────────────────────────────────────────

/**
 * Execute a direct trade atomically (one acknowledged multi-path update).
 *
 * This is the ONLY function that mutates inventories for direct trades.
 *
 * Requires trade.status === awaiting_offerer_confirmation and a non-null requestedCardId.
 *
 * @param {object} trade - The trade object from /trades/direct/{id}
 * @returns {Promise<{ success: boolean, reason?: string, notifiedOfferer?: string[], stale?: boolean }>}
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

  // ── 0. Concurrency guard — reload trade & verify awaiting offerer confirm ─
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
    return await failTradeIfActionable(tradeId, 'REQUESTED_CARD_NOT_FOUND', diag);
  }

  const resolvedOfferedId = freshTrade.offeredCardId || offeredCardId;
  const resolvedOffering = freshTrade.offeringPlayerId || offeringPlayerId;
  const resolvedTarget = freshTrade.targetPlayerId || targetPlayerId;

  if (resolvedOfferedId === resolvedRequestedId) {
    return await failTradeIfActionable(tradeId, 'SAME_CARD_BOTH_SIDES', diag);
  }

  // ── 1. S5c-D7a: force once-load both participants (player + PTI) ───────────
  let me = '';
  try {
    const session = getSession();
    if (session?.username && session.username !== '__admin__') {
      me = String(session.username).trim();
    }
  } catch { /* ignore */ }

  if (diag) {
    diag.mark('forcePlayerLoadsStarted', {
      offeringPlayerId: resolvedOffering,
      targetPlayerId: resolvedTarget,
    });
  }

  const offeringCtx = await loadTradingCounterpartyContext(resolvedOffering, { force: true });
  if (!offeringCtx.ok) {
    if (diag) {
      diag.mark('exitBeforeInventoryCommit', {
        reason: offeringCtx.reason || 'COUNTERPARTY_LOAD_FAILED',
        inventoryCommitAttempted: false,
      });
    }
    return { success: false, reason: offeringCtx.reason || 'COUNTERPARTY_LOAD_FAILED' };
  }
  const targetCtx = await loadTradingCounterpartyContext(resolvedTarget, { force: true });
  if (!targetCtx.ok) {
    if (diag) {
      diag.mark('exitBeforeInventoryCommit', {
        reason: targetCtx.reason || 'COUNTERPARTY_LOAD_FAILED',
        inventoryCommitAttempted: false,
      });
    }
    return { success: false, reason: targetCtx.reason || 'COUNTERPARTY_LOAD_FAILED' };
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
    if (diag) {
      diag.mark('exitBeforeInventoryCommit', {
        reason: 'OFFERING_PLAYER_NOT_FOUND',
        inventoryCommitAttempted: false,
      });
    }
    return { success: false, reason: 'OFFERING_PLAYER_NOT_FOUND' };
  }
  if (!freshTarget) {
    if (diag) {
      diag.mark('exitBeforeInventoryCommit', {
        reason: 'TARGET_PLAYER_NOT_FOUND',
        inventoryCommitAttempted: false,
      });
    }
    return { success: false, reason: 'TARGET_PLAYER_NOT_FOUND' };
  }

  // Exact quantities the planner will receive (force-load return objects).
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

  // ── 2. Reload all card definitions ────────────────────────────────────────
  const allCards = db.get('cards') || {};

  // ── 3. Rerun T-1 validation with fresh scoped data ───────────────────────
  const players = {
    [resolvedOffering]: _normalizePlayerForValidation(freshOffering),
    [resolvedTarget]:   _normalizePlayerForValidation(freshTarget),
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
  });

  if (!validation.valid) {
    if (isDetailedLogging()) {
      console.log(`[Trading][DETAIL] Trade ${tradeId} failed validation: ${validation.reason} (${resolvedOffering} → ${resolvedTarget}, offered=${resolvedOfferedId}, requested=${resolvedRequestedId})`);
    }
    return await failTradeIfActionable(tradeId, validation.reason, diag);
  }

  // ── 4. Check cooldowns for BOTH players ───────────────────────────────────
  const offeringCooldown = getDirectTradeCooldown(resolvedOffering);
  if (offeringCooldown.onCooldown) {
    return await failTradeIfActionable(tradeId, 'OFFERING_PLAYER_ON_COOLDOWN', diag);
  }
  const targetCooldown = getDirectTradeCooldown(resolvedTarget);
  if (targetCooldown.onCooldown) {
    return await failTradeIfActionable(tradeId, 'TARGET_PLAYER_ON_COOLDOWN', diag);
  }

  // ── 5. One shared timestamp for completedAt + both lastDirectTradeAt ─────
  const now = Date.now();

  const plan = buildDirectTradeAcceptPlan({
    tradeId,
    offeringPlayerId: resolvedOffering,
    targetPlayerId: resolvedTarget,
    offeredCardId: resolvedOfferedId,
    requestedCardId: resolvedRequestedId,
    offeringPlayer: freshOffering,
    targetPlayer: freshTarget,
    now,
  });

  if (!plan.ok) {
    return await failTradeIfActionable(tradeId, plan.reason || 'INVALID_TRADE_PLAN', diag);
  }

  if (diag) {
    diag.mark('planBuilt', {
      inventoryDiag: plan.inventoryDiag || null,
      note: 'No extra pre-commit server refresh — planner used force-load objects above',
    });
  }

  // ── 6. Lock + revalidate + acknowledged multi-path commit ─────────────────
  const commit = await commitDirectTradeAcceptPlan(tradeId, plan, { diag });
  if (!commit.success) {
    if (diag) {
      diag.mark('commitFailed', {
        reason: commit.reason || 'WRITE_FAILED',
        inventoryCommitAttempted: commit.inventoryCommitAttempted === true,
        currentStatus: commit.currentStatus ?? null,
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
    return {
      success: false,
      reason: commit.reason || 'WRITE_FAILED',
      error: commit.error,
    };
  }

  // Observation-only: do not alter/retry based on this read.
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
    });
  }

  return {
    success: true,
    // Only offerer's unlocks for the confirming client's toasts
    notifiedOfferer: commit.notifiedOfferer || [],
    writeCount: 1,
  };
}
