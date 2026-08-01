/**
 * Trade Execution Module — Phase T-2
 *
 * Isolated helper for atomic direct-trade card swaps.
 * All inventory mutation is contained here. UI handlers must NEVER
 * directly modify inventories for trades.
 *
 * Responsibilities:
 *   - Reload fresh player state from DB
 *   - Rerun T-1 validation helpers (pure, safe)
 *   - Decrement/increment inventories atomically
 *   - Clean up zero-quantity entries
 *   - Apply cooldown timestamps
 *   - Increment stats.tradesCompleted for both players
 */

import * as db from './database.js';
import { bumpPlayerStat, notifyCardInventoryChanged, STAT_KEYS } from './achievements.js';
import * as config from './config.js';
import { validateDirectTrade, isDetailedLogging } from './trading.js';

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

// ─── Atomic Trade Execution ─────────────────────────────────────────────────

/**
 * Execute a direct trade atomically.
 *
 * This is the ONLY function that mutates inventories for direct trades.
 *
 * Requires trade.status === awaiting_offerer_confirmation and a non-null requestedCardId.
 *
 * @param {object} trade - The trade object from /trades/direct/{id}
 * @returns {{ success: boolean, reason?: string }}
 */
export function executeDirectTrade(trade) {
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
    return { success: false, reason: 'TRADE_NOT_AWAITING_OFFERER' };
  }

  const resolvedRequestedId = freshTrade.requestedCardId || requestedCardId;
  if (!resolvedRequestedId) {
    return { success: false, reason: 'REQUESTED_CARD_NOT_FOUND' };
  }

  // Prefer fresh trade fields for the rest of execution
  const resolvedOfferedId = freshTrade.offeredCardId || offeredCardId;
  const resolvedOffering = freshTrade.offeringPlayerId || offeringPlayerId;
  const resolvedTarget = freshTrade.targetPlayerId || targetPlayerId;

  // ── 1. Reload fresh player state ──────────────────────────────────────────
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
    const now = Date.now();
    db.update(`trades/direct/${tradeId}`, {
      status: 'failed',
      completedAt: now,
      failureReason: validation.reason,
    });
    return { success: false, reason: validation.reason };
  }

  // ── 4. Check cooldowns for BOTH players ───────────────────────────────────
  const offeringCooldown = getDirectTradeCooldown(resolvedOffering);
  if (offeringCooldown.onCooldown) {
    const now = Date.now();
    db.update(`trades/direct/${tradeId}`, {
      status: 'failed',
      completedAt: now,
      failureReason: 'OFFERING_PLAYER_ON_COOLDOWN',
    });
    return { success: false, reason: 'OFFERING_PLAYER_ON_COOLDOWN' };
  }
  const targetCooldown = getDirectTradeCooldown(resolvedTarget);
  if (targetCooldown.onCooldown) {
    const now = Date.now();
    db.update(`trades/direct/${tradeId}`, {
      status: 'failed',
      completedAt: now,
      failureReason: 'TARGET_PLAYER_ON_COOLDOWN',
    });
    return { success: false, reason: 'TARGET_PLAYER_ON_COOLDOWN' };
  }

  // ── 5. Compute new inventories (no DB writes yet) ─────────────────────────
  const offeringInv = { ...(freshOffering.inventory || {}) };
  const targetInv = { ...(freshTarget.inventory || {}) };

  offeringInv[resolvedOfferedId] = (offeringInv[resolvedOfferedId] || 0) - 1;
  if (offeringInv[resolvedOfferedId] <= 0) delete offeringInv[resolvedOfferedId];

  offeringInv[resolvedRequestedId] = (offeringInv[resolvedRequestedId] || 0) + 1;

  targetInv[resolvedRequestedId] = (targetInv[resolvedRequestedId] || 0) - 1;
  if (targetInv[resolvedRequestedId] <= 0) delete targetInv[resolvedRequestedId];

  targetInv[resolvedOfferedId] = (targetInv[resolvedOfferedId] || 0) + 1;

  // ── 6. Prepare stats updates ──────────────────────────────────────────────
  const offeringStats = { ...(freshOffering.stats || {}) };
  const targetStats = { ...(freshTarget.stats || {}) };

  const now = Date.now();

  // ── 7. Write ALL mutations together ───────────────────────────────────────
  // Re-confirm status then lock as processing (duplicate-accept guard)
  const statusCheck = db.get(`trades/direct/${tradeId}`);
  if (!statusCheck || statusCheck.status !== 'awaiting_offerer_confirmation') {
    return { success: false, reason: 'TRADE_NOT_AWAITING_OFFERER' };
  }
  db.update(`trades/direct/${tradeId}`, { status: 'processing' });

  db.set(`players/${resolvedOffering}/inventory`, offeringInv);
  db.set(`players/${resolvedOffering}/stats`, offeringStats);
  db.set(`players/${resolvedOffering}/lastDirectTradeAt`, now);
  db.update(`players/${resolvedOffering}/progression`, { firstTrade: true });

  db.set(`players/${resolvedTarget}/inventory`, targetInv);
  db.set(`players/${resolvedTarget}/stats`, targetStats);
  db.set(`players/${resolvedTarget}/lastDirectTradeAt`, now);
  db.update(`players/${resolvedTarget}/progression`, { firstTrade: true });

  // ── 8. Mark trade as accepted ─────────────────────────────────────────────
  db.update(`trades/direct/${tradeId}`, {
    status: 'accepted',
    completedAt: now,
  });

  bumpPlayerStat(resolvedOffering, STAT_KEYS.TRADES_COMPLETED, 1);
  bumpPlayerStat(resolvedTarget, STAT_KEYS.TRADES_COMPLETED, 1);
  notifyCardInventoryChanged(resolvedOffering);
  notifyCardInventoryChanged(resolvedTarget);

  if (isDetailedLogging()) {
    console.log(`[Trading][DETAIL] Trade ${tradeId} completed: ${resolvedOffering} gave ${resolvedOfferedId}, ${resolvedTarget} gave ${resolvedRequestedId}, cooldowns applied at ${now}`);
  } else {
    console.log(`[Trading] Trade ${tradeId} completed: ${resolvedOffering} gave ${resolvedOfferedId}, ${resolvedTarget} gave ${resolvedRequestedId}`);
  }

  return { success: true };
}
