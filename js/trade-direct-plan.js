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

  return {
    ok: true,
    updates,
    notifiedOfferer: offererSide.notified,
    notifiedTarget: targetSide.notified,
    unlockedOfferer: offererSide.unlocked,
    unlockedTarget: targetSide.unlocked,
    writeCount: 1,
  };
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
 */
export async function commitDirectTradeAcceptPlan(tradeId, plan) {
  return withDirectTradeLock(tradeId, async () => {
    // Revalidate status after lock (cache, not server-fresh).
    const statusCheck = db.get(`trades/direct/${tradeId}`);
    if (!statusCheck || statusCheck.status !== 'awaiting_offerer_confirmation') {
      return {
        success: false,
        reason: 'STALE_TRADE_STATE',
        currentStatus: statusCheck?.status ?? null,
      };
    }

    if (!plan?.ok || !plan.updates) {
      return { success: false, reason: plan?.reason || 'INVALID_TRADE_PLAN' };
    }

    const ack = await db.updateAcknowledged(plan.updates);
    if (!ack.ok) {
      return {
        success: false,
        reason: 'WRITE_FAILED',
        error: ack.error || 'Could not save trade. Check your connection and try again.',
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
    };
  });
}
