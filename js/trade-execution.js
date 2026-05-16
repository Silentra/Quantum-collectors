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
import * as config from './config.js';
import { validateDirectTrade, isDetailedLogging } from './trading.js';
import { getPlayerLockedCardIds } from './trade-lock-helpers.js';

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
 * @param {object} trade - The trade object from /trades/direct/{id}
 *   { id, offeringPlayerId, targetPlayerId, offeredCardId, requestedCardId }
 *
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

  // ── 0. Concurrency guard — reload trade & verify still pending ─────────
  const freshTrade = db.get(`trades/direct/${tradeId}`);
  if (!freshTrade || freshTrade.status !== 'pending') {
    console.log(`[Trading] Trade ${tradeId} skipped — status is '${freshTrade?.status}', not 'pending'`);
    return { success: false, reason: 'TRADE_NOT_PENDING' };
  }

  // ── 1. Reload fresh player state ──────────────────────────────────────────
  const freshOffering = db.get(`players/${offeringPlayerId}`);
  const freshTarget = db.get(`players/${targetPlayerId}`);

  if (!freshOffering) return { success: false, reason: 'OFFERING_PLAYER_NOT_FOUND' };
  if (!freshTarget) return { success: false, reason: 'TARGET_PLAYER_NOT_FOUND' };

  // ── 2. Reload all card definitions ────────────────────────────────────────
  const allCards = db.get('cards') || {};

  // ── 3. Rerun T-1 validation with fresh data (includes project-lock check) ──
  const players = {
    [offeringPlayerId]: { ..._normalizePlayerForValidation(freshOffering), _lockedCardIds: getPlayerLockedCardIds(offeringPlayerId) },
    [targetPlayerId]:   { ..._normalizePlayerForValidation(freshTarget),   _lockedCardIds: getPlayerLockedCardIds(targetPlayerId) },
  };

  const validation = validateDirectTrade({
    offeringPlayerId,
    targetPlayerId,
    offeredCardId,
    requestedCardId,
    players,
    cards: allCards,
  });

  if (!validation.valid) {
    if (isDetailedLogging()) {
      console.log(`[Trading][DETAIL] Trade ${tradeId} failed validation: ${validation.reason} (${offeringPlayerId} → ${targetPlayerId}, offered=${offeredCardId}, requested=${requestedCardId})`);
    }
    // Mark trade as failed in DB
    db.update(`trades/direct/${tradeId}`, {
      status: 'failed',
      respondedAt: Date.now(),
      failureReason: validation.reason,
    });
    return { success: false, reason: validation.reason };
  }

  // ── 4. Check cooldowns for BOTH players ───────────────────────────────────
  const offeringCooldown = getDirectTradeCooldown(offeringPlayerId);
  if (offeringCooldown.onCooldown) {
    db.update(`trades/direct/${tradeId}`, { status: 'failed', respondedAt: Date.now(), failureReason: 'OFFERING_PLAYER_ON_COOLDOWN' });
    return { success: false, reason: 'OFFERING_PLAYER_ON_COOLDOWN' };
  }
  const targetCooldown = getDirectTradeCooldown(targetPlayerId);
  if (targetCooldown.onCooldown) {
    db.update(`trades/direct/${tradeId}`, { status: 'failed', respondedAt: Date.now(), failureReason: 'TARGET_PLAYER_ON_COOLDOWN' });
    return { success: false, reason: 'TARGET_PLAYER_ON_COOLDOWN' };
  }

  // ── 5. Compute new inventories (no DB writes yet) ─────────────────────────
  const offeringInv = { ...(freshOffering.inventory || {}) };
  const targetInv = { ...(freshTarget.inventory || {}) };

  // Decrement offered card from offering player
  offeringInv[offeredCardId] = (offeringInv[offeredCardId] || 0) - 1;
  if (offeringInv[offeredCardId] <= 0) delete offeringInv[offeredCardId];

  // Increment requested card for offering player (they receive what they asked for)
  offeringInv[requestedCardId] = (offeringInv[requestedCardId] || 0) + 1;

  // Decrement requested card from target player
  targetInv[requestedCardId] = (targetInv[requestedCardId] || 0) - 1;
  if (targetInv[requestedCardId] <= 0) delete targetInv[requestedCardId];

  // Increment offered card for target player (they receive what was offered)
  targetInv[offeredCardId] = (targetInv[offeredCardId] || 0) + 1;

  // ── 6. Prepare stats updates ──────────────────────────────────────────────
  const offeringStats = { ...(freshOffering.stats || {}) };
  offeringStats.tradesCompleted = (offeringStats.tradesCompleted || 0) + 1;

  const targetStats = { ...(freshTarget.stats || {}) };
  targetStats.tradesCompleted = (targetStats.tradesCompleted || 0) + 1;

  const now = Date.now();

  // ── 7. Write ALL mutations together ───────────────────────────────────────
  // Lock trade as 'processing' before any inventory writes
  db.update(`trades/direct/${tradeId}`, { status: 'processing' });

  // Offering player: inventory + stats + cooldown + progression
  db.set(`players/${offeringPlayerId}/inventory`, offeringInv);
  db.set(`players/${offeringPlayerId}/stats`, offeringStats);
  db.set(`players/${offeringPlayerId}/lastDirectTradeAt`, now);
  db.update(`players/${offeringPlayerId}/progression`, { firstTrade: true });

  // Target player: inventory + stats + cooldown + progression
  db.set(`players/${targetPlayerId}/inventory`, targetInv);
  db.set(`players/${targetPlayerId}/stats`, targetStats);
  db.set(`players/${targetPlayerId}/lastDirectTradeAt`, now);
  db.update(`players/${targetPlayerId}/progression`, { firstTrade: true });

  // ── 8. Mark trade as accepted ─────────────────────────────��───────────────
  db.update(`trades/direct/${tradeId}`, {
    status: 'accepted',
    respondedAt: now,
  });

  if (isDetailedLogging()) {
    console.log(`[Trading][DETAIL] Trade ${tradeId} completed: ${offeringPlayerId} gave ${offeredCardId}, ${targetPlayerId} gave ${requestedCardId}, cooldowns applied at ${now}`);
  } else {
    console.log(`[Trading] Trade ${tradeId} completed: ${offeringPlayerId} gave ${offeredCardId}, ${targetPlayerId} gave ${requestedCardId}`);
  }

  return { success: true };
}
