/**
 * Trading Module
 *
 * Phase T-1: Pure validation helpers.
 * Phase T-2: Direct trade lifecycle (create, respond, confirm, decline, cancel).
 *
 * T-1 helpers are:
 *   - Pure (no side effects)
 *   - Repeatable (safe to call multiple times, including immediately before trade completion)
 *   - Side-effect free (no Firebase writes, no inventory mutation, no UI rerenders)
 *
 * T-2 lifecycle functions use DB reads/writes and delegate inventory mutation
 * exclusively to trade-execution.js → executeDirectTrade().
 *
 * Return shape (T-1): { valid: boolean, reason: string | null }
 */

import * as db from './database.js';
import * as config from './config.js';
import * as metrics from './db-metrics.js';
import { executeDirectTrade, getDirectTradeCooldown } from './trade-execution.js';
import {
  buildAvailabilitySnapshot,
  canOfferCardInTrade,
  getAvailabilityFailureReason,
} from './trade-availability.js';
import {
  directIndexUpdatesForTrade,
  directIndexRemovalsForTrade,
} from './trade-index.js';

// ─── Phase T-8: Trading config helpers ───────────────────────────────────────

/** Check if trading is globally enabled. */
export function isTradingEnabled() {
  return config.getValue('trading.enabled') !== false;
}
/** Check if direct trades are enabled (also requires global). */
export function isDirectTradesEnabled() {
  if (!isTradingEnabled()) return false;
  return config.getValue('trading.directTradesEnabled') !== false;
}
/** Check if listings are enabled (also requires global). */
export function isListingsEnabled() {
  if (!isTradingEnabled()) return false;
  return config.getValue('trading.listingsEnabled') !== false;
}
/** Check if detailed trade logging is on. */
export function isDetailedLogging() {
  return config.getValue('trading.enableDetailedLogs') === true;
}

// ─── Result helpers ──────────────────────────────────────────────────────────

/**
 * @param {string} reason
 * @returns {{ valid: false, reason: string }}
 */
function fail(reason) {
  return { valid: false, reason };
}

/** @returns {{ valid: true, reason: null }} */
function pass() {
  return { valid: true, reason: null };
}

// ─── Card tradability ─────────────────────────────────────────────────────────

/**
 * Determine whether a card definition allows trading.
 *
 * A card is tradable unless it explicitly sets `tradable: false`.
 * Absent or undefined `tradable` is treated as tradable (opt-out model),
 * which keeps all existing cards tradable by default and allows individual
 * cards to be restricted in future without a schema rewrite.
 *
 * @param {object} cardDef - Canonical card definition from cards.js
 * @returns {boolean}
 */
export function isCardTradable(cardDef) {
  return cardDef.tradable !== false;
}

// ─── validateDirectTradeOffer (create — no target inventory) ─────────────────

/**
 * Validate creating a one-card offer (Player A → Player B).
 * Does not require or inspect the target player's inventory.
 *
 * @returns {{ valid: boolean, reason: string | null }}
 */
export function validateDirectTradeOffer({
  offeringPlayerId,
  targetPlayerId,
  offeredCardId,
  players,
  cards,
  excludeDirectTradeId = null,
}) {
  if (offeringPlayerId === targetPlayerId) return fail('SELF_TRADE');

  const offering = players[offeringPlayerId];
  if (!offering) return fail('OFFERING_PLAYER_NOT_FOUND');

  const target = players[targetPlayerId];
  if (!target) return fail('TARGET_PLAYER_NOT_FOUND');

  if (!offering.groupId || !target.groupId || offering.groupId !== target.groupId) {
    return fail('DIFFERENT_GROUPS');
  }

  if (offering.isTradeRestricted) return fail('OFFERING_PLAYER_TRADE_RESTRICTED');
  if (target.isTradeRestricted) return fail('TARGET_PLAYER_TRADE_RESTRICTED');
  if (target.isTradeProfileHidden) return fail('TARGET_PLAYER_HIDDEN');

  const offeredCard = cards[offeredCardId];
  if (!offeredCard) return fail('OFFERED_CARD_NOT_FOUND');
  if (!isCardTradable(offeredCard)) return fail('OFFERED_CARD_NOT_TRADABLE');

  const offeringInventory = offering.inventory || {};
  if ((offeringInventory[offeredCardId] || 0) < 1) {
    return fail('OFFERING_PLAYER_MISSING_OFFERED_CARD');
  }

  const excludeIds = excludeDirectTradeId ? [excludeDirectTradeId] : [];
  const offeringSnapshot = buildAvailabilitySnapshot(offeringPlayerId, {
    playerData: offering,
    excludeDirectTradeIds: excludeIds,
  });
  if (!canOfferCardInTrade(offeringSnapshot, offeredCardId)) {
    const reason = getAvailabilityFailureReason(offeringSnapshot, offeredCardId, 'offer');
    return fail(reason ?? 'INSUFFICIENT_AVAILABLE_COPIES');
  }

  return pass();
}

// ─── validateDirectTrade ──────────────────────────────────────────────────────

/**
 * Validate a complete direct trade (both cards known).
 * Used at respond-time (partially) and final execution.
 *
 * All data is passed in explicitly so this function is fully pure and can be
 * rerun safely immediately before completing a trade (stale UI state is fine).
 *
 * @returns {{ valid: boolean, reason: string | null }}
 */
export function validateDirectTrade({
  offeringPlayerId,
  targetPlayerId,
  offeredCardId,
  requestedCardId,
  players,
  cards,
  excludeDirectTradeId = null,
  skipHiddenTargetCheck = false,
}) {
  // ── 1. Players must not be the same person ──────────────────────────────────
  if (offeringPlayerId === targetPlayerId) {
    return fail('SELF_TRADE');
  }

  // ── 2. Both players must exist ──────────────────────────────────────────────
  const offering = players[offeringPlayerId];
  if (!offering) return fail('OFFERING_PLAYER_NOT_FOUND');

  const target = players[targetPlayerId];
  if (!target) return fail('TARGET_PLAYER_NOT_FOUND');

  // ── 3. Both players must be in the same group ───────────────────────────────
  if (!offering.groupId || !target.groupId || offering.groupId !== target.groupId) {
    return fail('DIFFERENT_GROUPS');
  }

  // ── 4. Neither player may be trade-restricted ───────────────────────────────
  if (offering.isTradeRestricted) return fail('OFFERING_PLAYER_TRADE_RESTRICTED');
  if (target.isTradeRestricted)   return fail('TARGET_PLAYER_TRADE_RESTRICTED');

  // ── 5. Target hidden check (create/respond; optional skip at final if already in-flight)
  if (!skipHiddenTargetCheck && target.isTradeProfileHidden) {
    return fail('TARGET_PLAYER_HIDDEN');
  }

  // ── 6. Both card definitions must exist ─────────────────────────────────────
  const offeredCard = cards[offeredCardId];
  if (!offeredCard) return fail('OFFERED_CARD_NOT_FOUND');

  if (!requestedCardId) return fail('REQUESTED_CARD_NOT_FOUND');
  const requestedCard = cards[requestedCardId];
  if (!requestedCard) return fail('REQUESTED_CARD_NOT_FOUND');

  // ── 7. Both cards must be tradable ──────────────────────────────────────────
  if (!isCardTradable(offeredCard))    return fail('OFFERED_CARD_NOT_TRADABLE');
  if (!isCardTradable(requestedCard))  return fail('REQUESTED_CARD_NOT_TRADABLE');

  // ── 8. Offering player must own at least one copy of the offered card ────────
  const offeringInventory = offering.inventory || {};
  const offeredQty = offeringInventory[offeredCardId] || 0;
  if (offeredQty < 1) return fail('OFFERING_PLAYER_MISSING_OFFERED_CARD');

  // ── 9. Target player must own at least one copy of the requested card ────────
  const targetInventory = target.inventory || {};
  const requestedQty = targetInventory[requestedCardId] || 0;
  if (requestedQty < 1) return fail('TARGET_PLAYER_MISSING_REQUESTED_CARD');

  // ── 10. Cards must be of equal rarity ───────────────────────────────────────
  if (offeredCard.rarity !== requestedCard.rarity) {
    return fail('RARITY_MISMATCH');
  }

  // ── 11. Copy-aware availability (project + trade reservations) ───────────
  const excludeIds = excludeDirectTradeId ? [excludeDirectTradeId] : [];

  const offeringSnapshot = buildAvailabilitySnapshot(offeringPlayerId, {
    playerData: offering,
    excludeDirectTradeIds: excludeIds,
  });
  if (!canOfferCardInTrade(offeringSnapshot, offeredCardId)) {
    const reason = getAvailabilityFailureReason(offeringSnapshot, offeredCardId, 'offer');
    return fail(reason ?? 'INSUFFICIENT_AVAILABLE_COPIES');
  }

  const targetSnapshot = buildAvailabilitySnapshot(targetPlayerId, {
    playerData: target,
    excludeDirectTradeIds: excludeIds,
  });
  if (!canOfferCardInTrade(targetSnapshot, requestedCardId)) {
    const reason = getAvailabilityFailureReason(targetSnapshot, requestedCardId, 'offer');
    if (reason === 'locked_cards_present') {
      return fail('REQUESTED_CARD_LOCKED_BY_PROJECT');
    }
    return fail(reason ?? 'INSUFFICIENT_AVAILABLE_COPIES');
  }

  return pass();
}

// ─── validateListingTrade ─────────────────────────────────────────────────────

/**
 * Validate accepting an existing trade listing (Phase T-4).
 *
 * A "listing" is an anonymous open offer posted by one player advertising:
 *   - a card they will give (listing.offeredCardId)
 *   - 1–3 cards they would accept in return (listing.requestedCardIds)
 *
 * The accepter fulfills the listing by providing EXACTLY ONE of the requested cards.
 *
 * All data is passed in explicitly so this function is fully pure and can be
 * rerun safely immediately before completing a trade (stale UI state is fine).
 *
 * @param {object} params
 * @param {object}  params.listing        - The listing object
 * @param {string}  params.accepterId     - Username of the player accepting the listing
 * @param {string}  params.chosenCardId   - The specific card the accepter is providing (must be one of listing.requestedCardIds)
 * @param {object}  params.players        - Map of { [username]: playerObject }
 * @param {object}  params.cards          - Map of { [cardId]: cardDefinitionObject }
 *
 * @returns {{ valid: boolean, reason: string | null }}
 */
export function validateListingTrade({
  listing,
  accepterId,
  chosenCardId,
  players,
  cards,
  excludeListingId = null,
}) {
  // ── 1. Listing must exist ───────────────────────────────────────────────────
  if (!listing) return fail('LISTING_NOT_FOUND');

  // ── 2. Listing must be active (or processing for the listing under fulfill) ─
  // After claim, status is processing; allow validation when excludeListingId
  // matches so reservation math can exclude this listing without failing status.
  const listingKey = listing.id || excludeListingId;
  const isOwnProcessingClaim =
    listing.status === 'processing' &&
    excludeListingId &&
    listingKey === excludeListingId;
  if (listing.status !== 'active' && !isOwnProcessingClaim) {
    return fail('LISTING_NOT_ACTIVE');
  }

  // ── 3. Listing must not be expired ─────────────────────────────────────────
  if (listing.expiresAt && Date.now() > listing.expiresAt) return fail('LISTING_EXPIRED');

  // ── 4. Listing owner must exist ─────────────────────────────────────────────
  const owner = players[listing.ownerId];
  if (!owner) return fail('LISTING_OWNER_NOT_FOUND');

  // ── 5. Accepter must exist ──────────────────────────────────────────────────
  const accepter = players[accepterId];
  if (!accepter) return fail('ACCEPTER_NOT_FOUND');

  // ── 6. Accepter must not be the listing owner ───────────────────────────────
  if (accepterId === listing.ownerId) {
    return fail('SELF_TRADE');
  }

  // ── 7. Both players must be in the same group ───────────────────────────────
  if (!owner.groupId || !accepter.groupId || owner.groupId !== accepter.groupId) {
    return fail('DIFFERENT_GROUPS');
  }

  // ── 8. Listing must be scoped to the accepter's group ──────────────────────
  if (listing.groupId && listing.groupId !== (accepter.groupId || accepter.group)) {
    return fail('LISTING_WRONG_GROUP');
  }

  // ── 9. Neither player may be trade-restricted ───────────────────────────────
  if (owner.isTradeRestricted)    return fail('LISTING_OWNER_TRADE_RESTRICTED');
  if (accepter.isTradeRestricted) return fail('ACCEPTER_TRADE_RESTRICTED');

  // ── 10. Offered card definition must exist ─────────────────────────────────
  const offeredCard = cards[listing.offeredCardId];
  if (!offeredCard) return fail('OFFERED_CARD_NOT_FOUND');

  // ── 11. Offered card must be tradable ──────────────────────────────────────
  if (!isCardTradable(offeredCard)) return fail('OFFERED_CARD_NOT_TRADABLE');

  // ── 12. Chosen card must be one of the listing's requestedCardIds ──────────
  const requestedIds = listing.requestedCardIds || [];
  if (!requestedIds.includes(chosenCardId)) {
    return fail('CHOSEN_CARD_NOT_IN_REQUESTED');
  }

  // ── 13. Chosen card definition must exist ──────────────────────────────────
  const chosenCard = cards[chosenCardId];
  if (!chosenCard) return fail('CHOSEN_CARD_NOT_FOUND');

  // ── 14. Chosen card must be tradable ───────────────────────────────────────
  if (!isCardTradable(chosenCard)) return fail('CHOSEN_CARD_NOT_TRADABLE');

  // ── 15. Listing owner must still own the offered card ──────────────────────
  const ownerInventory = owner.inventory || {};
  const offeredQty = ownerInventory[listing.offeredCardId] || 0;
  if (offeredQty < 1) return fail('LISTING_OWNER_MISSING_OFFERED_CARD');

  // ── 16. Accepter must own the chosen card ──────────────────────────────────
  const accepterInventory = accepter.inventory || {};
  const chosenQty = accepterInventory[chosenCardId] || 0;
  if (chosenQty < 1) return fail('ACCEPTER_MISSING_CHOSEN_CARD');

  // ── 17. Cards must be of equal rarity ──────────────────────────────────────
  if (offeredCard.rarity !== chosenCard.rarity) {
    return fail('RARITY_MISMATCH');
  }

  // ── 18. Copy-aware availability (project + trade reservations) ───────────
  const excludeIds = excludeListingId ? [excludeListingId] : [];

  const ownerSnapshot = buildAvailabilitySnapshot(listing.ownerId, {
    playerData: owner,
    excludeListingIds: excludeIds,
  });
  if (!canOfferCardInTrade(ownerSnapshot, listing.offeredCardId)) {
    const reason = getAvailabilityFailureReason(ownerSnapshot, listing.offeredCardId, 'offer');
    return fail(reason ?? 'INSUFFICIENT_AVAILABLE_COPIES');
  }

  const accepterSnapshot = buildAvailabilitySnapshot(accepterId, {
    playerData: accepter,
    excludeListingIds: excludeIds,
  });
  if (!canOfferCardInTrade(accepterSnapshot, chosenCardId)) {
    const reason = getAvailabilityFailureReason(accepterSnapshot, chosenCardId, 'offer');
    if (reason === 'locked_cards_present') {
      return fail('REQUESTED_CARD_LOCKED_BY_PROJECT');
    }
    return fail(reason ?? 'INSUFFICIENT_AVAILABLE_COPIES');
  }

  return pass();
}

// ─── Phase T-2: Direct Trade Lifecycle ──────────────────────────────────────

/**
 * Normalize a player record so T-1 validators (which reference `groupId`)
 * work with the actual DB field (`group`).
 */
function _normalizePlayer(p) {
  if (!p) return p;
  return { ...p, groupId: p.groupId || p.group || null };
}

/**
 * Initialize the trading module.
 * Migrates trades from flat /trades/ to /trades/direct/ if needed.
 */
export function initTrading() {
  // Ensure config.economy keys exist (additive migration)
  const economy = db.get('config/economy') || {};
  if (economy.directTradeCooldownMinutes === undefined) {
    db.set('config/economy/directTradeCooldownMinutes', 10080);
    console.log('[Trading] Migrated config: economy.directTradeCooldownMinutes = 10080');
  }
  if (economy.listingExpirationHours === undefined) {
    db.set('config/economy/listingExpirationHours', 168);
    console.log('[Trading] Migrated config: economy.listingExpirationHours = 168');
  }
  if (economy.listingCooldownMinutes === undefined) {
    db.set('config/economy/listingCooldownMinutes', 10080);
    console.log('[Trading] Migrated config: economy.listingCooldownMinutes = 10080');
  }
  if (economy.listingAcceptCooldownMinutes === undefined) {
    db.set('config/economy/listingAcceptCooldownMinutes', 10080);
    console.log('[Trading] Migrated config: economy.listingAcceptCooldownMinutes = 10080');
  }
  if (economy.maxActiveListingsPerPlayer === undefined) {
    db.set('config/economy/maxActiveListingsPerPlayer', 1);
    console.log('[Trading] Migrated config: economy.maxActiveListingsPerPlayer = 1');
  }

  // Ensure config.trading section exists (Phase T-8)
  const trading = db.get('config/trading') || {};
  if (trading.enabled === undefined) db.set('config/trading/enabled', true);
  if (trading.directTradesEnabled === undefined) db.set('config/trading/directTradesEnabled', true);
  if (trading.listingsEnabled === undefined) db.set('config/trading/listingsEnabled', true);
  if (trading.defaultHiddenProfile === undefined) db.set('config/trading/defaultHiddenProfile', false);
  if (trading.enableDetailedLogs === undefined) db.set('config/trading/enableDetailedLogs', false);

  // ── Migrate flat /trades/ to /trades/direct/ ──────────────────────────────
  _migrateTradesStructure();

  console.log('[Trading] Module loaded (Phase T-8 — trading admin controls active)');
}

/**
 * One-time migration: flat /trades/{tradeId} → /trades/direct/{tradeId}
 * Only runs if legacy flat trades exist (records with `offeringPlayerId` at top level).
 */
function _migrateTradesStructure() {
  const tradesRoot = db.get('trades') || {};

  // Check if already migrated (has 'direct' or 'listings' sub-node)
  if (tradesRoot.direct !== undefined || tradesRoot.listings !== undefined) {
    return; // Already in new structure
  }

  // Check if there are any legacy flat trade records
  const legacyKeys = Object.keys(tradesRoot).filter(k =>
    tradesRoot[k] && typeof tradesRoot[k] === 'object' && tradesRoot[k].offeringPlayerId
  );

  if (legacyKeys.length === 0) {
    // No legacy trades — just ensure the structure exists
    db.set('trades/direct', {});
    db.set('trades/listings', {});
    return;
  }

  // Migrate: move all legacy trade records into /trades/direct/
  const directTrades = {};
  for (const key of legacyKeys) {
    directTrades[key] = tradesRoot[key];
  }
  db.set('trades', { direct: directTrades, listings: {} });
  console.log(`[Trading] Migrated ${legacyKeys.length} legacy trades to trades/direct/`);
}

/**
 * Create a one-card direct trade offer (no requested card yet).
 * One acknowledged multi-path: canonical trade + both participant index leaves.
 *
 * @param {string} offeringPlayerId
 * @param {string} targetPlayerId
 * @param {string} offeredCardId
 * @returns {Promise<{ success: boolean, tradeId?: string, reason?: string, error?: string, writeCount?: number }>}
 */
export async function createTradeOffer(offeringPlayerId, targetPlayerId, offeredCardId) {
  if (!isTradingEnabled()) return { success: false, reason: 'TRADING_DISABLED' };
  if (!isDirectTradesEnabled()) return { success: false, reason: 'DIRECT_TRADES_DISABLED' };

  const cooldown = getDirectTradeCooldown(offeringPlayerId);
  if (cooldown.onCooldown) {
    return { success: false, reason: 'SENDER_ON_COOLDOWN' };
  }

  const freshOffering = db.get(`players/${offeringPlayerId}`);
  const freshTarget = db.get(`players/${targetPlayerId}`);
  const allCards = db.get('cards') || {};

  const players = {
    [offeringPlayerId]: _normalizePlayer(freshOffering),
    [targetPlayerId]:   _normalizePlayer(freshTarget),
  };

  const validation = validateDirectTradeOffer({
    offeringPlayerId,
    targetPlayerId,
    offeredCardId,
    players,
    cards: allCards,
  });

  if (!validation.valid) {
    return { success: false, reason: validation.reason };
  }

  // Duplicate: same offerer + same offered card already awaiting response/confirmation
  const existingTrades = db.get('trades/direct') || {};
  for (const t of Object.values(existingTrades)) {
    if (
      t &&
      (t.status === 'awaiting_target_response' || t.status === 'awaiting_offerer_confirmation') &&
      t.offeringPlayerId === offeringPlayerId &&
      t.offeredCardId === offeredCardId
    ) {
      return { success: false, reason: 'DUPLICATE_PENDING_TRADE' };
    }
  }

  const tradeId = db.generatePushKey('trades/direct');
  const now = Date.now();
  const trade = {
    id: tradeId,
    offeringPlayerId,
    targetPlayerId,
    offeredCardId,
    requestedCardId: null,
    status: 'awaiting_target_response',
    createdAt: now,
    respondedAt: null,
    completedAt: null,
  };

  const updates = {
    [`trades/direct/${tradeId}`]: trade,
    ...directIndexUpdatesForTrade(trade),
  };

  const ack = await db.updateAcknowledged(updates);
  metrics.recordTradeIndexLifecycle({
    tag: 'direct-index-dual-write',
    ops: 1,
    ok: ack.ok,
    username: offeringPlayerId,
  });
  if (!ack.ok) {
    return {
      success: false,
      reason: 'WRITE_FAILED',
      error: ack.error || 'Could not create trade',
    };
  }

  if (isDetailedLogging()) {
    console.log(`[Trading][DETAIL] Trade ${tradeId} created: ${offeringPlayerId} → ${targetPlayerId}, offered=${offeredCardId}`);
  } else {
    console.log(`[Trading] Trade ${tradeId} created: ${offeringPlayerId} → ${targetPlayerId}`);
  }
  return { success: true, tradeId, writeCount: 1 };
}

/**
 * Player B submits a same-rarity return card for an open offer.
 *
 * @param {string} tradeId
 * @param {string} targetPlayerId
 * @param {string} requestedCardId
 * @returns {Promise<{ success: boolean, reason?: string, error?: string, writeCount?: number }>}
 */
export async function respondToTrade(tradeId, targetPlayerId, requestedCardId) {
  if (!isTradingEnabled()) return { success: false, reason: 'TRADING_DISABLED' };
  if (!isDirectTradesEnabled()) return { success: false, reason: 'DIRECT_TRADES_DISABLED' };

  const trade = db.get(`trades/direct/${tradeId}`);
  if (!trade) return { success: false, reason: 'TRADE_NOT_FOUND' };
  if (trade.status !== 'awaiting_target_response') {
    return { success: false, reason: 'TRADE_NOT_AWAITING_TARGET' };
  }
  if (trade.targetPlayerId !== targetPlayerId) {
    return { success: false, reason: 'NOT_TARGET_PLAYER' };
  }

  const cooldown = getDirectTradeCooldown(targetPlayerId);
  if (cooldown.onCooldown) {
    return { success: false, reason: 'RESPONDER_ON_COOLDOWN' };
  }

  const freshOffering = db.get(`players/${trade.offeringPlayerId}`);
  const freshTarget = db.get(`players/${targetPlayerId}`);
  const allCards = db.get('cards') || {};

  const players = {
    [trade.offeringPlayerId]: _normalizePlayer(freshOffering),
    [targetPlayerId]:         _normalizePlayer(freshTarget),
  };

  if (players[targetPlayerId]?.isTradeRestricted) {
    return { success: false, reason: 'TARGET_PLAYER_TRADE_RESTRICTED' };
  }

  const validation = validateDirectTrade({
    offeringPlayerId: trade.offeringPlayerId,
    targetPlayerId,
    offeredCardId: trade.offeredCardId,
    requestedCardId,
    players,
    cards: allCards,
    excludeDirectTradeId: tradeId,
  });

  if (!validation.valid) {
    return { success: false, reason: validation.reason };
  }

  // Re-check status to avoid double-respond races
  const freshTrade = db.get(`trades/direct/${tradeId}`);
  if (!freshTrade || freshTrade.status !== 'awaiting_target_response') {
    return { success: false, reason: 'TRADE_NOT_AWAITING_TARGET' };
  }

  if (
    freshTrade.offeringPlayerId == null
    || freshTrade.targetPlayerId == null
    || freshTrade.offeredCardId == null
  ) {
    return {
      success: false,
      reason: 'WRITE_FAILED',
      error: 'Trade missing participant fields for index dual-write',
    };
  }

  const now = Date.now();
  // Build the post-response canonical object first (explicit fields only — never
  // pass the pre-response trade into the index planner).
  const postResponseTrade = {
    id: String(freshTrade.id || tradeId),
    offeringPlayerId: String(freshTrade.offeringPlayerId),
    targetPlayerId: String(freshTrade.targetPlayerId),
    offeredCardId: String(freshTrade.offeredCardId),
    requestedCardId: String(requestedCardId),
    status: 'awaiting_offerer_confirmation',
    createdAt: Number(freshTrade.createdAt) || now,
    respondedAt: now,
    completedAt: freshTrade.completedAt != null ? freshTrade.completedAt : null,
  };

  // Both participant projections from the post-response object only.
  const indexUpdates = directIndexUpdatesForTrade(postResponseTrade);
  if (Object.keys(indexUpdates).length !== 2) {
    return {
      success: false,
      reason: 'WRITE_FAILED',
      error: 'Could not build post-response trade index projections',
    };
  }

  // One ack: full canonical trade + both participant index leaves (create-style).
  const updates = {
    [`trades/direct/${postResponseTrade.id}`]: postResponseTrade,
    ...indexUpdates,
  };

  const ack = await db.updateAcknowledged(updates);
  metrics.recordTradeIndexLifecycle({
    tag: 'direct-index-dual-write',
    ops: 1,
    ok: ack.ok,
    username: targetPlayerId,
  });
  if (!ack.ok) {
    return {
      success: false,
      reason: 'WRITE_FAILED',
      error: ack.error || 'Could not respond to trade',
    };
  }

  if (isDetailedLogging()) {
    console.log(`[Trading][DETAIL] Trade ${tradeId} response: ${targetPlayerId} offered return ${requestedCardId}`);
  } else {
    console.log(`[Trading] Trade ${tradeId} response submitted by ${targetPlayerId}`);
  }
  return { success: true, writeCount: 1 };
}

/**
 * Player A confirms the completed proposal. Delegates to executeDirectTrade().
 *
 * @param {string} tradeId
 * @param {string} offeringPlayerId
 * @returns {Promise<{ success: boolean, reason?: string, notifiedOfferer?: string[], stale?: boolean }>}
 */
export async function confirmTrade(tradeId, offeringPlayerId) {
  if (!isTradingEnabled()) return { success: false, reason: 'TRADING_DISABLED' };
  if (!isDirectTradesEnabled()) return { success: false, reason: 'DIRECT_TRADES_DISABLED' };

  const trade = db.get(`trades/direct/${tradeId}`);
  if (!trade) return { success: false, reason: 'TRADE_NOT_FOUND' };
  if (trade.status !== 'awaiting_offerer_confirmation') {
    return {
      success: false,
      reason: 'STALE_TRADE_STATE',
      stale: true,
      currentStatus: trade.status,
    };
  }
  if (trade.offeringPlayerId !== offeringPlayerId) {
    return { success: false, reason: 'NOT_OFFERING_PLAYER' };
  }
  if (!trade.requestedCardId) {
    return { success: false, reason: 'REQUESTED_CARD_NOT_FOUND' };
  }

  return executeDirectTrade(trade);
}

/**
 * Decline a trade.
 * - Target may decline in awaiting_target_response
 * - Offerer may decline in awaiting_offerer_confirmation
 *
 * @param {string} tradeId
 * @param {string} decliningPlayerId
 * @returns {Promise<{ success: boolean, reason?: string, error?: string, writeCount?: number }>}
 */
export async function declineTrade(tradeId, decliningPlayerId) {
  const trade = db.get(`trades/direct/${tradeId}`);
  if (!trade) return { success: false, reason: 'TRADE_NOT_FOUND' };

  const now = Date.now();
  const id = trade.id || tradeId;
  /** @type {Record<string, object|null|number|string>} */
  let updates = null;

  if (trade.status === 'awaiting_target_response') {
    if (trade.targetPlayerId !== decliningPlayerId) {
      return { success: false, reason: 'NOT_TARGET_PLAYER' };
    }
    updates = {
      [`trades/direct/${id}/status`]: 'declined',
      [`trades/direct/${id}/respondedAt`]: now,
      [`trades/direct/${id}/completedAt`]: now,
      ...directIndexRemovalsForTrade({ ...trade, id }),
    };
  } else if (trade.status === 'awaiting_offerer_confirmation') {
    if (trade.offeringPlayerId !== decliningPlayerId) {
      return { success: false, reason: 'NOT_OFFERING_PLAYER' };
    }
    updates = {
      [`trades/direct/${id}/status`]: 'declined',
      [`trades/direct/${id}/completedAt`]: now,
      ...directIndexRemovalsForTrade({ ...trade, id }),
    };
  } else {
    return { success: false, reason: 'TRADE_NOT_DECLINABLE' };
  }

  const ack = await db.updateAcknowledged(updates);
  metrics.recordTradeIndexLifecycle({
    tag: 'direct-index-dual-write',
    ops: 1,
    ok: ack.ok,
    username: decliningPlayerId,
  });
  if (!ack.ok) {
    return {
      success: false,
      reason: 'WRITE_FAILED',
      error: ack.error || 'Could not decline trade',
    };
  }

  if (isDetailedLogging()) {
    console.log(`[Trading][DETAIL] Trade ${tradeId} declined by ${decliningPlayerId}`);
  } else {
    console.log(`[Trading] Trade ${tradeId} declined by ${decliningPlayerId}`);
  }
  return { success: true, writeCount: 1 };
}

/**
 * Cancel an offer before the target responds (offerer only).
 *
 * @param {string} tradeId
 * @param {string} cancellingPlayerId
 * @returns {Promise<{ success: boolean, reason?: string, error?: string, writeCount?: number }>}
 */
export async function cancelTrade(tradeId, cancellingPlayerId) {
  const trade = db.get(`trades/direct/${tradeId}`);
  if (!trade) return { success: false, reason: 'TRADE_NOT_FOUND' };
  if (trade.status !== 'awaiting_target_response') {
    return { success: false, reason: 'TRADE_NOT_CANCELLABLE' };
  }
  if (trade.offeringPlayerId !== cancellingPlayerId) {
    return { success: false, reason: 'NOT_OFFERING_PLAYER' };
  }

  const now = Date.now();
  const id = trade.id || tradeId;
  const updates = {
    [`trades/direct/${id}/status`]: 'cancelled',
    [`trades/direct/${id}/respondedAt`]: now,
    [`trades/direct/${id}/completedAt`]: now,
    ...directIndexRemovalsForTrade({ ...trade, id }),
  };

  const ack = await db.updateAcknowledged(updates);
  metrics.recordTradeIndexLifecycle({
    tag: 'direct-index-dual-write',
    ops: 1,
    ok: ack.ok,
    username: cancellingPlayerId,
  });
  if (!ack.ok) {
    return {
      success: false,
      reason: 'WRITE_FAILED',
      error: ack.error || 'Could not cancel trade',
    };
  }

  if (isDetailedLogging()) {
    console.log(`[Trading][DETAIL] Trade ${tradeId} cancelled by ${cancellingPlayerId}`);
  } else {
    console.log(`[Trading] Trade ${tradeId} cancelled by ${cancellingPlayerId}`);
  }
  return { success: true, writeCount: 1 };
}

const _ACTIVE_DIRECT_STATUSES = new Set([
  'awaiting_target_response',
  'awaiting_offerer_confirmation',
]);

/**
 * Get active direct trades for a player (as sender or target).
 *
 * @param {string} username
 * @returns {{ incoming: object[], outgoing: object[] }}
 */
export function getPendingTrades(username) {
  const allTrades = db.get('trades/direct') || {};
  const incoming = [];
  const outgoing = [];

  for (const trade of Object.values(allTrades)) {
    if (!trade || !_ACTIVE_DIRECT_STATUSES.has(trade.status)) continue;
    if (trade.targetPlayerId === username && trade.status === 'awaiting_target_response') {
      incoming.push(trade);
    } else if (trade.offeringPlayerId === username) {
      outgoing.push(trade);
    }
  }

  incoming.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  outgoing.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return { incoming, outgoing };
}
