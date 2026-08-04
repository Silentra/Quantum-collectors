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
} from './trade-direct-plan.js';

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
 * @returns {{ success: false, reason: string, stale?: boolean, currentStatus?: string }}
 */
function failTradeIfActionable(tradeId, reason) {
  const result = markDirectTradeFailedIfAwaiting(tradeId, reason);
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

  // ── 0. Concurrency guard — reload trade & verify awaiting offerer confirm ─
  const freshTrade = db.get(`trades/direct/${tradeId}`);
  if (!freshTrade || freshTrade.status !== 'awaiting_offerer_confirmation') {
    console.log(`[Trading] Trade ${tradeId} skipped — status is '${freshTrade?.status}', not 'awaiting_offerer_confirmation'`);
    return {
      success: false,
      reason: 'STALE_TRADE_STATE',
      stale: true,
      currentStatus: freshTrade?.status ?? null,
    };
  }

  const resolvedRequestedId = freshTrade.requestedCardId || requestedCardId;
  if (!resolvedRequestedId) {
    return failTradeIfActionable(tradeId, 'REQUESTED_CARD_NOT_FOUND');
  }

  const resolvedOfferedId = freshTrade.offeredCardId || offeredCardId;
  const resolvedOffering = freshTrade.offeringPlayerId || offeringPlayerId;
  const resolvedTarget = freshTrade.targetPlayerId || targetPlayerId;

  if (resolvedOfferedId === resolvedRequestedId) {
    return failTradeIfActionable(tradeId, 'SAME_CARD_BOTH_SIDES');
  }

  // ── 1. Reload fresh player state (cache) ──────────────────────────────────
  const freshOffering = db.get(`players/${resolvedOffering}`);
  const freshTarget = db.get(`players/${resolvedTarget}`);

  if (!freshOffering) return { success: false, reason: 'OFFERING_PLAYER_NOT_FOUND' };
  if (!freshTarget) return { success: false, reason: 'TARGET_PLAYER_NOT_FOUND' };

  // ── 2. Reload all card definitions ────────────────────────────────────────
  const allCards = db.get('cards') || {};

  // ── 3. Rerun T-1 validation with fresh data ───────────────────────────────
  const players = {
    [resolvedOffering]: _normalizePlayerForValidation(freshOffering),
    [resolvedTarget]:   _normalizePlayerForValidation(freshTarget),
  };

  const validation = validateDirectTrade({
    offeringPlayerId: resolvedOffering,
    targetPlayerId: resolvedTarget,
    offeredCardId: resolvedOfferedId,
    requestedCardId: resolvedRequestedId,
    players,
    cards: allCards,
    excludeDirectTradeId: tradeId,
  });

  if (!validation.valid) {
    if (isDetailedLogging()) {
      console.log(`[Trading][DETAIL] Trade ${tradeId} failed validation: ${validation.reason} (${resolvedOffering} → ${resolvedTarget}, offered=${resolvedOfferedId}, requested=${resolvedRequestedId})`);
    }
    return failTradeIfActionable(tradeId, validation.reason);
  }

  // ── 4. Check cooldowns for BOTH players ───────────────────────────────────
  const offeringCooldown = getDirectTradeCooldown(resolvedOffering);
  if (offeringCooldown.onCooldown) {
    return failTradeIfActionable(tradeId, 'OFFERING_PLAYER_ON_COOLDOWN');
  }
  const targetCooldown = getDirectTradeCooldown(resolvedTarget);
  if (targetCooldown.onCooldown) {
    return failTradeIfActionable(tradeId, 'TARGET_PLAYER_ON_COOLDOWN');
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
    return failTradeIfActionable(tradeId, plan.reason || 'INVALID_TRADE_PLAN');
  }

  // ── 6. Lock + revalidate + acknowledged multi-path commit ─────────────────
  const commit = await commitDirectTradeAcceptPlan(tradeId, plan);
  if (!commit.success) {
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

  if (isDetailedLogging()) {
    console.log(`[Trading][DETAIL] Trade ${tradeId} completed: ${resolvedOffering} gave ${resolvedOfferedId}, ${resolvedTarget} gave ${resolvedRequestedId}, cooldowns applied at ${now}`);
  } else {
    console.log(`[Trading] Trade ${tradeId} completed: ${resolvedOffering} gave ${resolvedOfferedId}, ${resolvedTarget} gave ${resolvedRequestedId}`);
  }

  return {
    success: true,
    // Only offerer's unlocks for the confirming client's toasts
    notifiedOfferer: commit.notifiedOfferer || [],
    writeCount: 1,
  };
}
