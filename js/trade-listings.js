/**
 * Trade Listings Module — Phase T-4
 *
 * Anonymous trade listing lifecycle: create, cancel, accept, query, expire.
 * Listings are stored at /trades/listings/{listingId}.
 * Inventory mutation is delegated to trade-listing-execution.js.
 *
 * Rules:
 *   - Max 1 active listing per player
 *   - Listings are group-scoped and anonymous
 *   - requestedCardIds: 1–3 exact card IDs, all must match offered card rarity
 *   - Listings expire after configurable duration
 *   - Hidden players MAY create and accept listings
 *   - Manual cancellation does NOT remove posting cooldown
 */

import * as db from './database.js';
import * as config from './config.js';
import * as metrics from './db-metrics.js';
import { validateListingTrade, isCardTradable, isTradingEnabled, isListingsEnabled, isDetailedLogging } from './trading.js';
import { executeListingTrade } from './trade-listing-execution.js';
import {
  buildAvailabilitySnapshot,
  canOfferCardInTrade,
  getAvailabilityFailureReason,
} from './trade-availability.js';
import {
  listingIndexUpdatesForListing,
  listingIndexRemovalsForListing,
  getReservationIndexSource,
  PLAYER_TRADE_INDEX_ROOT,
  LISTINGS_BY_GROUP_ROOT,
  TRADE_INDEX_META_KEY,
  isPlayerTradeIndexReady,
  isGlobalTradeIndexMetaCurrent,
  isGroupListingsIndexReady,
} from './trade-index.js';

/** @type {Set<string>} */
const _tradingListingFallbackWarnings = new Set();

/** @type {Set<string>} */
const _tradingGroupListingsFallbackWarnings = new Set();

/** Last source used by max-active validation (audit / DevTools). */
let _lastMaxActiveListingSource = null;

// ─── Helpers ─────────────────────────────────���──────────────────────────────

function _normalizePlayer(p) {
  if (!p) return p;
  return { ...p, groupId: p.groupId || p.group || null };
}

/**
 * Get listing expiration duration in ms from config.
 * Default: 24 hours.
 */
function _getListingExpirationMs() {
  const hours = config.getValue('economy.listingExpirationHours');
  return (typeof hours === 'number' ? hours : 24) * 60 * 60 * 1000;
}

/**
 * Get listing cooldown in minutes from config.
 * Default: 30 minutes.
 */
function _getListingCooldownMinutes() {
  const val = config.getValue('economy.listingCooldownMinutes');
  return typeof val === 'number' ? val : 30;
}

/**
 * Get max active listings per player from config.
 * Default: 1.
 */
function _getMaxActiveListings() {
  const val = config.getValue('economy.maxActiveListingsPerPlayer');
  return typeof val === 'number' && val >= 1 ? Math.floor(val) : 1;
}

/** Exported accessor for UI to read max active listings. */
export function getMaxActiveListingsPerPlayer() {
  return _getMaxActiveListings();
}

/**
 * Check whether a player is on listing cooldown.
 * Returns { onCooldown, remainingMs, readyAt }
 */
export function getListingCooldown(username) {
  const p = db.get(`players/${username}`);
  if (!p) return { onCooldown: false, remainingMs: 0, readyAt: 0 };

  const lastListingAt = p.lastListingCreatedAt || 0;
  const cooldownMs = _getListingCooldownMinutes() * 60 * 1000;
  const readyAt = lastListingAt + cooldownMs;
  const now = Date.now();

  if (now >= readyAt) return { onCooldown: false, remainingMs: 0, readyAt };
  return { onCooldown: true, remainingMs: readyAt - now, readyAt };
}

// ─── Expire stale listings ──────────────────────────────────────────────────

/**
 * Scan all active listings and expire any past their expiresAt.
 * One acknowledged multi-path per expired listing (canonical + index removals).
 * Safe to call frequently (e.g., on tab render).
 * @returns {Promise<number>} number expired
 */
export async function expireStaleListings() {
  const allListings = db.get('trades/listings') || {};
  const now = Date.now();
  let expired = 0;

  for (const [id, listing] of Object.entries(allListings)) {
    if (!listing || listing.status !== 'active') continue;
    if (listing.expiresAt && now > listing.expiresAt) {
      const listingId = listing.id || id;
      const updates = {
        [`trades/listings/${listingId}/status`]: 'expired',
        [`trades/listings/${listingId}/respondedAt`]: now,
        ...listingIndexRemovalsForListing({ ...listing, id: listingId }),
      };
      const ack = await db.updateAcknowledged(updates);
      metrics.recordTradeIndexLifecycle({
        tag: 'listing-index-dual-write',
        ops: 1,
        ok: ack.ok,
        username: listing.ownerId,
      });
      if (ack.ok) expired += 1;
    }
  }

  if (expired > 0) {
    console.log(`[Listings] Expired ${expired} stale listing(s)`);
  }
  return expired;
}

// ─── Listing Lifecycle ──────────────────────────────────────────────────────

/**
 * Validate listing creation inputs against current cache state.
 * @returns {{ ok: true, ownerGroup: string } | { ok: false, reason: string }}
 */
function _validateCreateListing(ownerId, offeredCardId, requestedCardIds) {
  if (!isTradingEnabled()) return { ok: false, reason: 'TRADING_DISABLED' };
  if (!isListingsEnabled()) return { ok: false, reason: 'LISTINGS_DISABLED' };

  if (!Array.isArray(requestedCardIds) || requestedCardIds.length < 1 || requestedCardIds.length > 3) {
    return { ok: false, reason: 'INVALID_REQUESTED_CARDS_COUNT' };
  }

  const uniqueIds = new Set(requestedCardIds);
  if (uniqueIds.size !== requestedCardIds.length) {
    return { ok: false, reason: 'DUPLICATE_REQUESTED_CARDS' };
  }

  if (requestedCardIds.includes(offeredCardId)) {
    return { ok: false, reason: 'OFFERED_CARD_IN_REQUESTED' };
  }

  const freshOwner = db.get(`players/${ownerId}`);
  if (!freshOwner) return { ok: false, reason: 'OWNER_NOT_FOUND' };

  const owner = _normalizePlayer(freshOwner);
  if (owner.isTradeRestricted) return { ok: false, reason: 'OWNER_TRADE_RESTRICTED' };

  const ownerGroup = owner.groupId;
  if (!ownerGroup) return { ok: false, reason: 'OWNER_NO_GROUP' };

  const cooldown = getListingCooldown(ownerId);
  if (cooldown.onCooldown) {
    return { ok: false, reason: 'LISTING_ON_COOLDOWN' };
  }

  const maxListings = _getMaxActiveListings();
  const listingSource = resolveTradingListingSource(ownerId);
  _lastMaxActiveListingSource = listingSource;
  if (listingSource !== 'index' && listingSource !== 'canonical-fallback') {
    return { ok: false, reason: 'TRADE_INDEX_UNAVAILABLE' };
  }
  let activeCount = 0;
  if (listingSource === 'index') {
    const indexMap = db.get(`${PLAYER_TRADE_INDEX_ROOT}/${ownerId}/listings`) || {};
    for (const listing of Object.values(indexMap)) {
      if (listing && listing.status === 'active') activeCount++;
    }
  } else {
    const allListings = db.get('trades/listings') || {};
    for (const listing of Object.values(allListings)) {
      if (listing && listing.ownerId === ownerId && listing.status === 'active') {
        activeCount++;
      }
    }
  }
  if (activeCount >= maxListings) {
    return { ok: false, reason: 'MAX_ACTIVE_LISTINGS_REACHED' };
  }

  const allCards = db.get('cards') || {};

  const offeredCard = allCards[offeredCardId];
  if (!offeredCard) return { ok: false, reason: 'OFFERED_CARD_NOT_FOUND' };
  if (offeredCard.enabled === false) return { ok: false, reason: 'OFFERED_CARD_DISABLED' };
  if (!isCardTradable(offeredCard)) return { ok: false, reason: 'OFFERED_CARD_NOT_TRADABLE' };

  const ownerInv = owner.inventory || {};
  if ((ownerInv[offeredCardId] || 0) < 1) {
    return { ok: false, reason: 'OWNER_MISSING_OFFERED_CARD' };
  }

  const ownerSnapshot = buildAvailabilitySnapshot(ownerId, { playerData: owner });
  if (!canOfferCardInTrade(ownerSnapshot, offeredCardId)) {
    const reason = getAvailabilityFailureReason(ownerSnapshot, offeredCardId, 'offer');
    return { ok: false, reason: reason ?? 'INSUFFICIENT_AVAILABLE_COPIES' };
  }

  for (const reqId of requestedCardIds) {
    const reqCard = allCards[reqId];
    if (!reqCard) return { ok: false, reason: `REQUESTED_CARD_NOT_FOUND:${reqId}` };
    if (reqCard.enabled === false) return { ok: false, reason: `REQUESTED_CARD_DISABLED:${reqId}` };
    if (!isCardTradable(reqCard)) return { ok: false, reason: `REQUESTED_CARD_NOT_TRADABLE:${reqId}` };
    if (reqCard.rarity !== offeredCard.rarity) {
      return { ok: false, reason: `RARITY_MISMATCH:${reqId}` };
    }
  }

  return { ok: true, ownerGroup };
}

async function withListingCreateLock(ownerId, fn) {
  const lockName = `qc-listing-create:${ownerId}`;
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(lockName, { mode: 'exclusive' }, () => fn());
  }
  return fn();
}

/**
 * Create an anonymous trade listing (one acknowledged multi-path update).
 *
 * @param {string}   ownerId         - Username of the listing creator
 * @param {string}   offeredCardId   - Card the owner is offering
 * @param {string[]} requestedCardIds - 1–3 card IDs the owner would accept (any ONE fulfills)
 * @returns {Promise<{ success: boolean, listingId?: string, reason?: string, error?: string, writeCount?: number }>}
 */
export async function createListing(ownerId, offeredCardId, requestedCardIds) {
  const pre = _validateCreateListing(ownerId, offeredCardId, requestedCardIds);
  if (!pre.ok) return { success: false, reason: pre.reason };

  return withListingCreateLock(ownerId, async () => {
    // Revalidate after lock (cache Option B) so double-submit fails cleanly
    const check = _validateCreateListing(ownerId, offeredCardId, requestedCardIds);
    if (!check.ok) return { success: false, reason: check.reason };

    const now = Date.now();
    const expiresAt = now + _getListingExpirationMs();
    const listingId = db.generatePushKey('trades/listings');

    const listing = {
      id: listingId,
      ownerId,
      offeredCardId,
      requestedCardIds,
      createdAt: now,
      expiresAt,
      groupId: check.ownerGroup,
      status: 'active',
    };

    const updates = {
      [`trades/listings/${listingId}`]: listing,
      [`players/${ownerId}/lastListingCreatedAt`]: now,
      ...listingIndexUpdatesForListing(listing, now),
    };

    const ack = await db.updateAcknowledged(updates);
    metrics.recordTradeIndexLifecycle({
      tag: 'listing-index-dual-write',
      ops: 1,
      ok: ack.ok,
      username: ownerId,
    });
    if (!ack.ok) {
      return {
        success: false,
        reason: 'WRITE_FAILED',
        error: ack.error || 'Could not save listing. Check your connection and try again.',
      };
    }

    if (isDetailedLogging()) {
      console.log(
        `[Listings][DETAIL] Listing ${listingId} created by ${ownerId}: offers ${offeredCardId}, ` +
          `wants [${requestedCardIds.join(', ')}], group=${check.ownerGroup}, ` +
          `expires=${new Date(expiresAt).toISOString()}`,
      );
    } else {
      console.log(
        `[Listings] Listing ${listingId} created by ${ownerId}: offers ${offeredCardId}, wants [${requestedCardIds.join(', ')}]`,
      );
    }

    return { success: true, listingId, writeCount: 1 };
  });
}

/**
 * Cancel an active listing (by the owner).
 * NOTE: Does NOT remove the posting cooldown.
 *
 * @param {string} listingId
 * @param {string} cancellingPlayerId
 * @returns {Promise<{ success: boolean, reason?: string, error?: string, writeCount?: number }>}
 */
export async function cancelListing(listingId, cancellingPlayerId) {
  // Phase T-8: Global toggle check (allow cancellation even if listings disabled — player should be able to clean up)
  const listing = db.get(`trades/listings/${listingId}`);
  if (!listing) return { success: false, reason: 'LISTING_NOT_FOUND' };
  if (listing.status !== 'active') return { success: false, reason: 'LISTING_NOT_ACTIVE' };
  if (listing.ownerId !== cancellingPlayerId) return { success: false, reason: 'NOT_LISTING_OWNER' };

  const now = Date.now();
  const id = listing.id || listingId;
  const updates = {
    [`trades/listings/${id}/status`]: 'cancelled',
    [`trades/listings/${id}/respondedAt`]: now,
    ...listingIndexRemovalsForListing({ ...listing, id }),
  };

  const ack = await db.updateAcknowledged(updates);
  metrics.recordTradeIndexLifecycle({
    tag: 'listing-index-dual-write',
    ops: 1,
    ok: ack.ok,
    username: cancellingPlayerId,
  });
  if (!ack.ok) {
    return {
      success: false,
      reason: 'WRITE_FAILED',
      error: ack.error || 'Could not cancel listing',
    };
  }

  if (isDetailedLogging()) {
    console.log(`[Listings][DETAIL] Listing ${listingId} cancelled by ${cancellingPlayerId}, offeredCard=${listing.offeredCardId}`);
  } else {
    console.log(`[Listings] Listing ${listingId} cancelled by ${cancellingPlayerId}`);
  }
  return { success: true, writeCount: 1 };
}

/**
 * Accept an active listing by providing one of the requested cards.
 *
 * @param {string} listingId
 * @param {string} accepterId
 * @param {string} chosenCardId - Must be one of listing.requestedCardIds that the accepter owns
 * @returns {Promise<{ success: boolean, reason?: string, notifiedAccepter?: string[] }>}
 */
export async function acceptListing(listingId, accepterId, chosenCardId) {
  // Phase T-8: Global / listing toggle enforcement
  if (!isTradingEnabled()) return { success: false, reason: 'TRADING_DISABLED' };
  if (!isListingsEnabled()) return { success: false, reason: 'LISTINGS_DISABLED' };

  const listing = db.get(`trades/listings/${listingId}`);
  if (!listing) return { success: false, reason: 'LISTING_NOT_FOUND' };
  if (listing.status !== 'active') return { success: false, reason: 'LISTING_NOT_ACTIVE' };

  // Check expiry — only mark expired while still active (never overwrite terminals).
  // S5c-D5a: acknowledged multi-path (canonical + index removals) — parity with expireStaleListings.
  if (listing.expiresAt && Date.now() > listing.expiresAt) {
    const still = db.get(`trades/listings/${listingId}`);
    if (still && still.status === 'active') {
      const id = still.id || listingId;
      const now = Date.now();
      const updates = {
        [`trades/listings/${id}/status`]: 'expired',
        [`trades/listings/${id}/respondedAt`]: now,
        ...listingIndexRemovalsForListing({ ...still, id }),
      };
      const ack = await db.updateAcknowledged(updates);
      metrics.recordTradeIndexLifecycle({
        tag: 'listing-index-dual-write',
        ops: 1,
        ok: ack.ok,
        username: still.ownerId,
      });
    }
    return { success: false, reason: 'LISTING_EXPIRED' };
  }

  // Cannot accept own listing
  if (accepterId === listing.ownerId) {
    return { success: false, reason: 'SELF_TRADE' };
  }

  // Accepter trade restriction check
  const freshAccepter = db.get(`players/${accepterId}`);
  if (!freshAccepter) return { success: false, reason: 'ACCEPTER_NOT_FOUND' };
  if (freshAccepter.isTradeRestricted) return { success: false, reason: 'ACCEPTER_TRADE_RESTRICTED' };

  // Delegate to isolated listing execution (claim + fulfill)
  return executeListingTrade(listing, accepterId, chosenCardId);
}

// ─── Queries ────────────────────────────────────────────────────────────────

/**
 * Whether legacy root coexistence can supply canonical trades/listings for Available discovery.
 * Personal isolation without a verified index → fail closed.
 * @returns {boolean}
 */
function _canUseCanonicalGroupListingsFallback() {
  try {
    if (typeof localStorage !== 'undefined'
      && localStorage.getItem('qc-personal-cache-isolation') === 'true') {
      return false;
    }
  } catch { /* ignore */ }
  return true;
}

function _isGroupListingsHydrating(groupId) {
  try {
    const report = typeof window !== 'undefined'
      && window.qcDbHydration
      && typeof window.qcDbHydration.getGroupListingsHydrationReport === 'function'
      ? window.qcDbHydration.getGroupListingsHydrationReport()
      : null;
    if (!report || report.inFlight !== true) return false;
    const key = String(groupId || '').trim();
    const desired = report.desiredGroupId != null ? String(report.desiredGroupId) : '';
    if (key && desired && desired !== key) return false;
    return true;
  } catch {
    return false;
  }
}

function _recordTradingGroupListingsSource(source) {
  if (typeof metrics.recordTradeIndexLifecycle !== 'function') return;
  metrics.recordTradeIndexLifecycle({
    tag: `tradingGroupListingsSource:${source}`,
    ops: 0,
    ok: source === 'index' || source === 'canonical-fallback',
  });
  if (source === 'canonical-fallback' && typeof metrics.recordTradeIndexFallback === 'function') {
    metrics.recordTradeIndexFallback({ reason: 'trading-group-listings-index-unready' });
  }
  if (source === 'unavailable' && typeof metrics.recordTradeIndexFailClosed === 'function') {
    metrics.recordTradeIndexFailClosed({ reason: 'trading-group-listings-no-index-no-fallback' });
  }
}

function _warnTradingGroupListingsFallbackOnce(reason) {
  const key = String(reason || 'default');
  if (_tradingGroupListingsFallbackWarnings.has(key)) return;
  _tradingGroupListingsFallbackWarnings.add(key);
  console.warn(
    `[Listings] Available discovery using canonical-fallback (${key}). ` +
      'Resolve listingsByGroup readiness before S7. Gameplay still correct under root coexistence.',
  );
}

/**
 * S5c-D5b: resolve source for Available Listings discovery via listingsByGroup/{groupId}.
 *
 * @param {string} username
 * @param {{ forceUnavailable?: boolean }} [opts]
 * @returns {'index'|'canonical-fallback'|'loading'|'unavailable'}
 */
export function resolveTradingGroupListingsSource(username, opts = {}) {
  const key = String(username || '').trim();
  if (!key || key === '__admin__') return 'unavailable';

  const me = db.get(`players/${key}`);
  const myGroup = me ? (me.groupId || me.group || null) : null;
  if (!myGroup) return 'unavailable';

  if (opts.forceUnavailable === true) {
    _recordTradingGroupListingsSource('unavailable');
    return 'unavailable';
  }

  let report = null;
  try {
    report = typeof window !== 'undefined'
      && window.qcDbHydration
      && typeof window.qcDbHydration.getGroupListingsHydrationReport === 'function'
      ? window.qcDbHydration.getGroupListingsHydrationReport()
      : null;
  } catch { /* ignore */ }

  const scopeActive = !!(report && report.active === true && report.groupId === myGroup);
  const pathReady = typeof db.isPathReady === 'function'
    ? db.isPathReady(`${LISTINGS_BY_GROUP_ROOT}/${myGroup}`)
    : false;
  const metaOk = isGroupListingsIndexReady(myGroup) && isGlobalTradeIndexMetaCurrent();
  const hydrating = _isGroupListingsHydrating(myGroup);

  let source;
  if (scopeActive && pathReady && metaOk) {
    source = 'index';
  } else if (hydrating || (scopeActive && !pathReady && metaOk)) {
    source = 'loading';
  } else if (_canUseCanonicalGroupListingsFallback()) {
    source = 'canonical-fallback';
    const reason = !scopeActive
      ? 'scope-inactive'
      : (!metaOk
        ? (!isGroupListingsIndexReady(myGroup) ? 'group-meta-unready' : 'global-schema-mismatch')
        : 'scope-path-unready');
    _warnTradingGroupListingsFallbackOnce(reason);
  } else if (hydrating) {
    source = 'loading';
  } else {
    source = 'unavailable';
  }

  _recordTradingGroupListingsSource(source);
  return source;
}

/**
 * Collect visible active listings from a map (newest-first).
 * @param {object} listingMap
 * @param {string|null} requireGroupId - when set, require listing.groupId match (canonical map)
 * @returns {object[]}
 */
function _collectVisibleListings(listingMap, requireGroupId = null) {
  const now = Date.now();
  const result = [];
  for (const [id, listing] of Object.entries(listingMap || {})) {
    if (id === TRADE_INDEX_META_KEY || id === '_meta') continue;
    if (!listing || typeof listing !== 'object') continue;
    if (listing.status !== 'active') continue;
    if (requireGroupId != null && listing.groupId !== requireGroupId) continue;
    if (listing.expiresAt && now > Number(listing.expiresAt)) continue;
    result.push(listing);
  }
  result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return result;
}

/**
 * Get active listings visible to a player (same group).
 * S5c-D5b: verified listingsByGroup/{myGroup} when ready; never treat untrusted as empty.
 * Own listings included (UI hides them for Available). Anonymous display is UI-only.
 *
 * @param {string} username
 * @returns {{
 *   listings: object[],
 *   source: 'index'|'canonical-fallback'|'loading'|'unavailable',
 *   trusted: boolean
 * }}
 */
export function getVisibleListings(username) {
  const key = String(username || '').trim();
  const me = db.get(`players/${key}`);
  if (!me) {
    return { listings: [], source: 'unavailable', trusted: false };
  }
  const myGroup = me.groupId || me.group || null;
  if (!myGroup) {
    return { listings: [], source: 'unavailable', trusted: false };
  }

  const source = resolveTradingGroupListingsSource(key);
  const trusted = source === 'index' || source === 'canonical-fallback';
  if (!trusted) {
    return { listings: [], source, trusted: false };
  }

  const listings = source === 'index'
    ? _collectVisibleListings(db.get(`${LISTINGS_BY_GROUP_ROOT}/${myGroup}`) || {})
    : _collectVisibleListings(db.get('trades/listings') || {}, myGroup);

  return { listings, source, trusted: true };
}

/**
 * Whether legacy root coexistence can supply canonical trades/listings for fallback.
 * Personal isolation without a verified index → fail closed.
 * @returns {boolean}
 */
function _canUseCanonicalListingFallback() {
  try {
    if (typeof localStorage !== 'undefined'
      && localStorage.getItem('qc-personal-cache-isolation') === 'true') {
      return false;
    }
  } catch { /* ignore */ }
  return true;
}

function _isPlayerTradeIndexHydrating(username) {
  try {
    const report = typeof window !== 'undefined'
      && window.qcDbHydration
      && typeof window.qcDbHydration.getPlayerTradeIndexHydrationReport === 'function'
      ? window.qcDbHydration.getPlayerTradeIndexHydrationReport()
      : null;
    if (!report) return false;
    if (report.inFlight === true) return true;
    const key = String(username || '').trim().toLowerCase();
    if (report.username && key && String(report.username).toLowerCase() !== key) return false;
    return false;
  } catch {
    return false;
  }
}

function _recordTradingListingSource(source) {
  if (typeof metrics.recordTradeIndexLifecycle !== 'function') return;
  metrics.recordTradeIndexLifecycle({
    tag: `tradingListingSource:${source}`,
    ops: 0,
    ok: source === 'index' || source === 'canonical-fallback',
  });
  if (source === 'canonical-fallback' && typeof metrics.recordTradeIndexFallback === 'function') {
    metrics.recordTradeIndexFallback({ reason: 'trading-listing-index-unready' });
  }
  if (source === 'unavailable' && typeof metrics.recordTradeIndexFailClosed === 'function') {
    metrics.recordTradeIndexFailClosed({ reason: 'trading-listing-no-index-no-fallback' });
  }
}

function _warnTradingListingFallbackOnce(reason) {
  const key = String(reason || 'default');
  if (_tradingListingFallbackWarnings.has(key)) return;
  _tradingListingFallbackWarnings.add(key);
  console.warn(
    `[Listings] My Listings / max-active using canonical-fallback (${key}). ` +
      'Resolve playerTradeIndex readiness before S7. Gameplay still correct under root coexistence.',
  );
}

/**
 * S5c-D4: resolve source for My Listings + create max-active count.
 * Reuses getReservationIndexSource — does not create another PTI subscription.
 *
 * @param {string} username
 * @param {{ forceUnavailable?: boolean }} [opts]
 * @returns {'index'|'canonical-fallback'|'loading'|'unavailable'}
 */
export function resolveTradingListingSource(username, opts = {}) {
  const key = String(username || '').trim();
  if (!key || key === '__admin__') return 'unavailable';

  const pathReady = typeof db.isPathReady === 'function'
    ? db.isPathReady(`${PLAYER_TRADE_INDEX_ROOT}/${key}`)
    : false;
  const hydrating = _isPlayerTradeIndexHydrating(key);

  const source = getReservationIndexSource(key, {
    scopePathReady: pathReady,
    hydrating,
    allowCanonicalFallback: _canUseCanonicalListingFallback(),
    forceUnavailable: opts.forceUnavailable === true,
  });

  if (source === 'canonical-fallback') {
    const reason = !isPlayerTradeIndexReady(key)
      ? 'player-meta-unready'
      : (!isGlobalTradeIndexMetaCurrent() ? 'global-schema-mismatch' : 'scope-path-unready');
    _warnTradingListingFallbackOnce(reason);
  }

  _recordTradingListingSource(source);
  return source;
}

/**
 * Last source used by `_validateCreateListing` max-active check (DevTools / audit).
 * @returns {'index'|'canonical-fallback'|'loading'|'unavailable'|null}
 */
export function getLastMaxActiveListingSource() {
  return _lastMaxActiveListingSource;
}

/**
 * Collect status===active listings for an owner from a listing map.
 * Does not filter expiresAt — matches pre-D4 getMyActiveListings (expireStaleListings owns soft-expire).
 * @param {object} listingMap
 * @param {string} [ownerId] - when set, require listing.ownerId match (canonical map)
 * @returns {object[]}
 */
function _collectActiveOwnedListings(listingMap, ownerId = null) {
  const result = [];
  for (const listing of Object.values(listingMap || {})) {
    if (!listing || listing.status !== 'active') continue;
    if (ownerId != null && listing.ownerId !== ownerId) continue;
    result.push(listing);
  }
  result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return result;
}

/**
 * Get the active listing for a specific player (max 1).
 * @deprecated Use getMyActiveListings() for multi-listing support.
 *
 * @param {string} username
 * @returns {object|null}
 */
export function getMyActiveListing(username) {
  const { listings, trusted } = getMyActiveListings(username);
  if (!trusted || !listings.length) return null;
  return listings[0];
}

/**
 * Get ALL active listings for a specific player.
 * S5c-D4: verified playerTradeIndex/{me}/listings when ready; never treat untrusted as zero.
 * Filters status === 'active' only (processing excluded). Soft-expire wall-clock is not
 * filtered here — same as pre-D4; expireStaleListings clears canonical + index leaves.
 *
 * @param {string} username
 * @returns {{
 *   listings: object[],
 *   source: 'index'|'canonical-fallback'|'loading'|'unavailable',
 *   trusted: boolean
 * }}
 */
export function getMyActiveListings(username) {
  const key = String(username || '').trim();
  const source = resolveTradingListingSource(key);
  const trusted = source === 'index' || source === 'canonical-fallback';

  if (!trusted) {
    return { listings: [], source, trusted: false };
  }

  const listings = source === 'index'
    ? _collectActiveOwnedListings(db.get(`${PLAYER_TRADE_INDEX_ROOT}/${key}/listings`) || {})
    : _collectActiveOwnedListings(db.get('trades/listings') || {}, key);

  return { listings, source, trusted: true };
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcTradeListings = {
    resolveTradingListingSource,
    resolveTradingGroupListingsSource,
    getMyActiveListings,
    getMyActiveListing,
    getMaxActiveListingsPerPlayer,
    getLastMaxActiveListingSource,
    createListing,
    cancelListing,
    getVisibleListings,
    expireStaleListings,
  };
}

_installWindowApi();
