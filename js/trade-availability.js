/**
 * trade-availability.js
 *
 * Hybrid availability model:
 *   - Projects: binary per cardId (one active project maximum per card identity)
 *   - Trades/listings: copy-aware reservations (inventory minus reserved copies)
 *
 * S5c-C: Research Projects resolve reservations via playerTradeIndex/{me} when verified.
 * S5c-D6: Trading self-availability uses the same PTI maps via buildTradingSelfAvailabilitySnapshot
 * (current-player only).
 * S5c-D7a: Action-scoped loadTradingCounterpartyContext for players/{other} + PTI/{other}.
 * Canonical-by-ID: loadDirectTradeByIdOnce / loadListingByIdOnce before public action gates
 * (scoped cold cache must not treat miss as NOT_FOUND).
 *
 * No inventory subtraction at reservation time — all math is derived.
 */

import * as db from './database.js';
import { getSession } from './auth.js';
import { PROJECT_STATES } from './project-state.js';
import {
  PLAYER_TRADE_INDEX_ROOT,
  getReservationIndexSource,
  isGlobalTradeIndexMetaCurrent,
  isPlayerTradeIndexReady,
  canAllowCanonicalTradeTreeFallback,
} from './trade-index.js';
import * as metrics from './db-metrics.js';

/** @type {Set<string>} */
const _fallbackWarningsShown = new Set();

/** @type {Set<string>} */
const _tradingFallbackWarningsShown = new Set();

/**
 * Whether legacy root coexistence can supply canonical trade trees for fallback.
 * S7c: denied under cache-isolation or scoped boot (see canAllowCanonicalTradeTreeFallback).
 * @returns {boolean}
 */
function _canUseCanonicalFallback() {
  return canAllowCanonicalTradeTreeFallback();
}

function _isTradeIndexHydrating(username) {
  try {
    const report = typeof window !== 'undefined'
      && window.qcDbHydration
      && typeof window.qcDbHydration.getPlayerTradeIndexHydrationReport === 'function'
      ? window.qcDbHydration.getPlayerTradeIndexHydrationReport()
      : null;
    if (!report) return false;
    if (report.inFlight === true) return true;
    const key = String(username || '').trim().toLowerCase();
    if (report.username && key && report.username !== key) return false;
    return false;
  } catch {
    return false;
  }
}

function _recordResearchSource(source) {
  if (typeof metrics.recordTradeIndexLifecycle !== 'function') return;
  metrics.recordTradeIndexLifecycle({
    tag: `researchReservationSource:${source}`,
    ops: 0,
    ok: source === 'index' || source === 'canonical-fallback',
  });
  if (source === 'canonical-fallback' && typeof metrics.recordTradeIndexFallback === 'function') {
    metrics.recordTradeIndexFallback({ reason: 'index-unready-or-wrong-version' });
  }
  if (source === 'unavailable' && typeof metrics.recordTradeIndexFailClosed === 'function') {
    metrics.recordTradeIndexFailClosed({ reason: 'no-index-no-canonical-fallback' });
  }
}

function _warnFallbackOnce(reason) {
  const key = String(reason || 'default');
  if (_fallbackWarningsShown.has(key)) return;
  _fallbackWarningsShown.add(key);
  console.warn(
    `[TradeAvailability] Research using canonical-fallback (${key}). ` +
      'Resolve trade-index readiness before S7. Gameplay still correct under root coexistence.',
  );
}

/**
 * Owner listing index leaves omit ownerId — inject comparison/assignment-only copies.
 * @param {string} username
 * @param {object} listingMap
 * @returns {object}
 */
export function listingsWithOwnerIdForReservation(username, listingMap) {
  const key = String(username || '');
  const out = {};
  for (const [id, entry] of Object.entries(listingMap || {})) {
    if (!entry || typeof entry !== 'object') continue;
    out[id] = { ...entry, ownerId: key };
  }
  return out;
}

/**
 * Resolve reservation source for Research Projects (S5c-C).
 * @param {string} username
 * @param {{ forceUnavailable?: boolean }} [opts]
 * @returns {'index'|'canonical-fallback'|'unavailable'|'loading'}
 */
export function resolveResearchReservationSource(username, opts = {}) {
  const key = String(username || '').trim().toLowerCase();
  if (!key || key === '__admin__') return 'unavailable';

  const pathReady = db.isPathReady(`${PLAYER_TRADE_INDEX_ROOT}/${key}`);
  const hydrating = _isTradeIndexHydrating(key);

  const source = getReservationIndexSource(key, {
    scopePathReady: pathReady,
    hydrating,
    allowCanonicalFallback: _canUseCanonicalFallback(),
    forceUnavailable: opts.forceUnavailable === true,
  });

  if (source === 'canonical-fallback') {
    const reason = !isPlayerTradeIndexReady(key)
      ? 'player-meta-unready'
      : (!isGlobalTradeIndexMetaCurrent() ? 'global-schema-mismatch' : 'scope-path-unready');
    _warnFallbackOnce(reason);
  }

  _recordResearchSource(source);
  return source;
}

/**
 * Load current-player trade-index maps for reservation counting (no cache mutation).
 * @param {string} username
 * @returns {{ direct: object, listings: object }}
 */
export function loadPlayerTradeIndexReservationMaps(username) {
  const key = String(username || '').trim();
  const direct = db.get(`${PLAYER_TRADE_INDEX_ROOT}/${key}/direct`) || {};
  const rawListings = db.get(`${PLAYER_TRADE_INDEX_ROOT}/${key}/listings`) || {};
  return {
    direct,
    listings: listingsWithOwnerIdForReservation(key, rawListings),
  };
}

/**
 * Research Projects availability snapshot — uses verified index when ready.
 *
 * @param {string} username
 * @param {object} [opts] — same as buildAvailabilitySnapshot extras
 * @returns {AvailabilitySnapshot & { reservationSource: string }}
 */
export function buildResearchAvailabilitySnapshot(username, opts = {}) {
  const source = resolveResearchReservationSource(username);

  if (source === 'loading' || source === 'unavailable') {
    const playerData = opts.playerData ?? db.get(`players/${username}`);
    return {
      username,
      inventory: { ...(opts.inventory ?? playerData?.inventory ?? {}) },
      projects: opts.projects ?? playerData?.projects ?? [],
      tradeCounts: new Map(),
      excludeDirectTradeIds: opts.excludeDirectTradeIds ?? [],
      excludeListingIds: opts.excludeListingIds ?? [],
      reservationSource: source,
      reservationsTrusted: false,
    };
  }

  if (source === 'index') {
    const maps = loadPlayerTradeIndexReservationMaps(username);
    const snap = buildAvailabilitySnapshot(username, {
      ...opts,
      directTrades: maps.direct,
      listings: maps.listings,
    });
    snap.reservationSource = 'index';
    snap.reservationsTrusted = true;
    return snap;
  }

  // canonical-fallback — existing algorithm over trades/* (root coexistence)
  const snap = buildAvailabilitySnapshot(username, opts);
  snap.reservationSource = 'canonical-fallback';
  snap.reservationsTrusted = true;
  return snap;
}

/**
 * Authenticated current-player username (Trading self-scope guard).
 * @returns {string}
 */
function _getAuthenticatedUsername() {
  try {
    const session = getSession();
    if (session?.username && session.username !== '__admin__') {
      return String(session.username).trim();
    }
  } catch { /* ignore */ }
  try {
    const report = typeof window !== 'undefined'
      && window.qcDbHydration
      && typeof window.qcDbHydration.getCurrentPlayerHydrationReport === 'function'
      ? window.qcDbHydration.getCurrentPlayerHydrationReport()
      : null;
    if (report?.username) return String(report.username).trim();
  } catch { /* ignore */ }
  return '';
}

function _recordTradingAvailabilitySource(source) {
  if (typeof metrics.recordTradeIndexLifecycle !== 'function') return;
  metrics.recordTradeIndexLifecycle({
    tag: `tradingAvailabilitySource:${source}`,
    ops: 0,
    ok: source === 'index' || source === 'canonical-fallback',
  });
  if (source === 'canonical-fallback' && typeof metrics.recordTradeIndexFallback === 'function') {
    metrics.recordTradeIndexFallback({ reason: 'trading-availability-index-unready' });
  }
  if (source === 'unavailable' && typeof metrics.recordTradeIndexFailClosed === 'function') {
    metrics.recordTradeIndexFailClosed({ reason: 'trading-availability-no-index-no-fallback' });
  }
}

function _warnTradingAvailabilityFallbackOnce(reason) {
  const key = String(reason || 'default');
  if (_tradingFallbackWarningsShown.has(key)) return;
  _tradingFallbackWarningsShown.add(key);
  console.warn(
    `[TradeAvailability] Trading self-availability using canonical-fallback (${key}). ` +
      'Resolve playerTradeIndex readiness before S7. Gameplay still correct under root coexistence.',
  );
}

/**
 * S5c-D6: resolve reservation source for Trading current-player availability.
 * Reuses getReservationIndexSource — same readiness as Research.
 *
 * @param {string} username
 * @param {{ forceUnavailable?: boolean }} [opts]
 * @returns {'index'|'canonical-fallback'|'unavailable'|'loading'}
 */
export function resolveTradingReservationSource(username, opts = {}) {
  const key = String(username || '').trim().toLowerCase();
  if (!key || key === '__admin__') return 'unavailable';

  const pathReady = typeof db.isPathReady === 'function'
    ? db.isPathReady(`${PLAYER_TRADE_INDEX_ROOT}/${key}`)
    : false;
  const hydrating = _isTradeIndexHydrating(key);

  const source = getReservationIndexSource(key, {
    scopePathReady: pathReady,
    hydrating,
    allowCanonicalFallback: _canUseCanonicalFallback(),
    forceUnavailable: opts.forceUnavailable === true,
  });

  if (source === 'canonical-fallback') {
    const reason = !isPlayerTradeIndexReady(key)
      ? 'player-meta-unready'
      : (!isGlobalTradeIndexMetaCurrent() ? 'global-schema-mismatch' : 'scope-path-unready');
    _warnTradingAvailabilityFallbackOnce(reason);
  }

  _recordTradingAvailabilitySource(source);
  return source;
}

/**
 * Untrusted empty snap used when self-scope is rejected or index is loading/unavailable.
 * @param {string} username
 * @param {object} [opts]
 * @param {string} source
 * @param {boolean} [selfScopedRejected]
 */
function _untrustedTradingSelfSnapshot(username, opts, source, selfScopedRejected = false) {
  const playerData = opts.playerData ?? db.get(`players/${username}`);
  return {
    username,
    inventory: { ...(opts.inventory ?? playerData?.inventory ?? {}) },
    projects: opts.projects ?? playerData?.projects ?? [],
    tradeCounts: new Map(),
    excludeDirectTradeIds: opts.excludeDirectTradeIds ?? [],
    excludeListingIds: opts.excludeListingIds ?? [],
    reservationSource: source,
    reservationsTrusted: false,
    selfScopedRejected: selfScopedRejected === true,
  };
}

/**
 * S5c-D6: Trading current-player availability snapshot.
 * Self-scoped only — username must equal the authenticated player.
 * Non-self callers receive fail-closed untrusted (never silent PTI for another user).
 * Reservation counting reuses buildAvailabilitySnapshot + loadPlayerTradeIndexReservationMaps
 * (same algorithm as Research).
 *
 * @param {string} username — must be the logged-in player
 * @param {object} [opts]
 * @returns {AvailabilitySnapshot & { reservationSource: string, reservationsTrusted: boolean, selfScopedRejected?: boolean }}
 */
export function buildTradingSelfAvailabilitySnapshot(username, opts = {}) {
  const key = String(username || '').trim();
  const me = _getAuthenticatedUsername();
  if (!key || !me || key.toLowerCase() !== me.toLowerCase()) {
    console.warn(
      '[TradeAvailability] buildTradingSelfAvailabilitySnapshot refused non-self username; ' +
        'use buildAvailabilitySnapshot for counterparty (canonical until D7).',
    );
    _recordTradingAvailabilitySource('unavailable');
    return _untrustedTradingSelfSnapshot(key || me || '', opts, 'unavailable', true);
  }

  const source = resolveTradingReservationSource(key, opts);

  if (source === 'loading' || source === 'unavailable') {
    return _untrustedTradingSelfSnapshot(key, opts, source);
  }

  if (source === 'index') {
    const maps = loadPlayerTradeIndexReservationMaps(key);
    const snap = buildAvailabilitySnapshot(key, {
      ...opts,
      directTrades: maps.direct,
      listings: maps.listings,
    });
    snap.reservationSource = 'index';
    snap.reservationsTrusted = true;
    return snap;
  }

  const snap = buildAvailabilitySnapshot(key, opts);
  snap.reservationSource = 'canonical-fallback';
  snap.reservationsTrusted = true;
  return snap;
}

function _recordForeignPlayerLoad(ok) {
  if (typeof metrics.recordTradeIndexLifecycle !== 'function') return;
  metrics.recordTradeIndexLifecycle({
    tag: ok ? 'foreignPlayerScopedLoad:ok' : 'foreignPlayerScopedLoad:fail',
    ops: 1,
    ok: ok === true,
  });
}

function _recordForeignTradeIndexLoad(ok) {
  if (typeof metrics.recordTradeIndexLifecycle !== 'function') return;
  metrics.recordTradeIndexLifecycle({
    tag: ok ? 'foreignTradeIndexScopedLoad:ok' : 'foreignTradeIndexScopedLoad:fail',
    ops: 1,
    ok: ok === true,
  });
}

function _recordForeignReservationSource(source) {
  if (typeof metrics.recordTradeIndexLifecycle !== 'function') return;
  metrics.recordTradeIndexLifecycle({
    tag: `foreignReservationSource:${source}`,
    ops: 0,
    ok: source === 'index' || source === 'canonical-fallback',
  });
  if (source === 'canonical-fallback' && typeof metrics.recordTradeIndexFallback === 'function') {
    metrics.recordTradeIndexFallback({ reason: 'foreign-pti-index-unready' });
  }
  if ((source === 'unavailable' || source === 'loading')
    && typeof metrics.recordTradeIndexFailClosed === 'function') {
    metrics.recordTradeIndexFailClosed({ reason: 'foreign-pti-untrusted' });
  }
}

/**
 * @typedef {object} TradingCounterpartyContext
 * @property {boolean} ok
 * @property {string|null} [reason]
 * @property {object|null} player
 * @property {{ direct: object, listings: object }|null} reservationMaps
 * @property {string} reservationSource
 * @property {boolean} reservationsTrusted
 */

/**
 * S5c-D7a: action-scoped once-load of a counterparty player (+ optional PTI).
 * No subscribe / no permanent listener. Mutation paths should pass `{ force: true }`.
 *
 * @param {string} username
 * @param {{ force?: boolean, reservations?: boolean, forceUnavailable?: boolean }} [options]
 *   - reservations: default true — set false for create-offer (player flags only)
 * @returns {Promise<TradingCounterpartyContext>}
 */
export async function loadTradingCounterpartyContext(username, options = {}) {
  const key = String(username || '').trim();
  const force = options.force === true;
  const needReservations = options.reservations !== false;

  if (!key || key === '__admin__') {
    return {
      ok: false,
      reason: 'COUNTERPARTY_INVALID',
      player: null,
      reservationMaps: null,
      reservationSource: 'unavailable',
      reservationsTrusted: false,
    };
  }

  if (typeof db.loadPathOnce !== 'function') {
    _recordForeignPlayerLoad(false);
    return {
      ok: false,
      reason: 'COUNTERPARTY_LOAD_FAILED',
      player: null,
      reservationMaps: null,
      reservationSource: 'unavailable',
      reservationsTrusted: false,
    };
  }

  const playerLoad = await db.loadPathOnce(`players/${key}`, { force });
  _recordForeignPlayerLoad(playerLoad?.ok === true);
  if (!playerLoad || playerLoad.ok !== true) {
    return {
      ok: false,
      reason: 'COUNTERPARTY_LOAD_FAILED',
      player: null,
      reservationMaps: null,
      reservationSource: 'unavailable',
      reservationsTrusted: false,
    };
  }

  const player = playerLoad.value;
  if (!player || typeof player !== 'object') {
    return {
      ok: false,
      reason: 'COUNTERPARTY_NOT_FOUND',
      player: null,
      reservationMaps: null,
      reservationSource: 'unavailable',
      reservationsTrusted: false,
    };
  }

  if (!needReservations) {
    return {
      ok: true,
      reason: null,
      player,
      reservationMaps: { direct: {}, listings: {} },
      reservationSource: 'skipped',
      reservationsTrusted: true,
    };
  }

  const ptiPath = `${PLAYER_TRADE_INDEX_ROOT}/${key}`;
  const ptiLoad = await db.loadPathOnce(ptiPath, { force });
  _recordForeignTradeIndexLoad(ptiLoad?.ok === true);

  const pathReady = ptiLoad?.ok === true
    && (typeof db.isPathReady === 'function' ? db.isPathReady(ptiPath) : true);

  const source = getReservationIndexSource(key, {
    scopePathReady: pathReady,
    hydrating: false,
    allowCanonicalFallback: _canUseCanonicalFallback(),
    forceUnavailable: options.forceUnavailable === true,
  });

  if (source === 'index') {
    _recordForeignReservationSource('index');
    const maps = loadPlayerTradeIndexReservationMaps(key);
    return {
      ok: true,
      reason: null,
      player,
      reservationMaps: maps,
      reservationSource: 'index',
      reservationsTrusted: true,
    };
  }

  if (source === 'canonical-fallback') {
    _recordForeignReservationSource('canonical-fallback');
    return {
      ok: true,
      reason: null,
      player,
      reservationMaps: null,
      reservationSource: 'canonical-fallback',
      reservationsTrusted: true,
    };
  }

  _recordForeignReservationSource('unavailable');
  return {
    ok: false,
    reason: 'COUNTERPARTY_TRADE_INDEX_UNAVAILABLE',
    player,
    reservationMaps: null,
    reservationSource: source,
    reservationsTrusted: false,
  };
}

/**
 * Shared ID-specific canonical leaf once-load (no bare trees, no subscribe).
 * Distinguishes load failure vs successful null (genuine NOT_FOUND) vs object.
 *
 * @param {'direct'|'listings'} kind
 * @param {string} id
 * @param {string} notFoundReason
 * @returns {Promise<{ ok: boolean, value: object|null, reason: string|null, mode?: string }>}
 */
async function _loadCanonicalTradeLeafByIdOnce(kind, id, notFoundReason) {
  const key = String(id || '').trim();
  if (!key) {
    return { ok: false, value: null, reason: notFoundReason };
  }
  if (typeof db.loadPathOnce !== 'function') {
    return { ok: false, value: null, reason: 'TRADE_INDEX_UNAVAILABLE' };
  }
  const path = kind === 'listings'
    ? `trades/listings/${key}`
    : `trades/direct/${key}`;
  const load = await db.loadPathOnce(path, { force: true });
  if (!load || load.ok !== true) {
    return {
      ok: false,
      value: null,
      reason: 'TRADE_INDEX_UNAVAILABLE',
      mode: load?.mode,
    };
  }
  if (load.value == null || typeof load.value !== 'object') {
    return {
      ok: false,
      value: null,
      reason: notFoundReason,
      mode: load.mode,
    };
  }
  return {
    ok: true,
    value: load.value,
    reason: null,
    mode: load.mode,
  };
}

/**
 * Force once-load `trades/direct/{tradeId}` for public direct-trade actions.
 * @param {string} tradeId
 * @returns {Promise<{ ok: boolean, trade: object|null, reason: string|null, mode?: string }>}
 */
export async function loadDirectTradeByIdOnce(tradeId) {
  const result = await _loadCanonicalTradeLeafByIdOnce('direct', tradeId, 'TRADE_NOT_FOUND');
  return {
    ok: result.ok,
    trade: result.ok ? result.value : null,
    reason: result.reason,
    mode: result.mode,
  };
}

/**
 * Force once-load `trades/listings/{listingId}` for public listing actions.
 * @param {string} listingId
 * @returns {Promise<{ ok: boolean, listing: object|null, reason: string|null, mode?: string }>}
 */
export async function loadListingByIdOnce(listingId) {
  const result = await _loadCanonicalTradeLeafByIdOnce('listings', listingId, 'LISTING_NOT_FOUND');
  return {
    ok: result.ok,
    listing: result.ok ? result.value : null,
    reason: result.reason,
    mode: result.mode,
  };
}

/**
 * Build availability snapshot from a successful counterparty context (D7a).
 * Reuses buildAvailabilitySnapshot / buildTradeReservationCounts — no second algorithm.
 *
 * @param {string} username
 * @param {TradingCounterpartyContext} ctx
 * @param {object} [opts]
 * @returns {AvailabilitySnapshot & { reservationSource: string, reservationsTrusted: boolean }}
 */
export function buildCounterpartyAvailabilitySnapshot(username, ctx, opts = {}) {
  const key = String(username || '').trim();
  if (!ctx?.ok || ctx.reservationsTrusted === false) {
    const playerData = opts.playerData ?? ctx?.player ?? null;
    return {
      username: key,
      inventory: { ...(opts.inventory ?? playerData?.inventory ?? {}) },
      projects: opts.projects ?? playerData?.projects ?? [],
      tradeCounts: new Map(),
      excludeDirectTradeIds: opts.excludeDirectTradeIds ?? [],
      excludeListingIds: opts.excludeListingIds ?? [],
      reservationSource: ctx?.reservationSource || 'unavailable',
      reservationsTrusted: false,
    };
  }

  if (ctx.reservationSource === 'index' && ctx.reservationMaps) {
    const snap = buildAvailabilitySnapshot(key, {
      ...opts,
      playerData: opts.playerData ?? ctx.player,
      directTrades: ctx.reservationMaps.direct,
      listings: ctx.reservationMaps.listings,
    });
    snap.reservationSource = 'index';
    snap.reservationsTrusted = true;
    return snap;
  }

  if (ctx.reservationSource === 'skipped') {
    // Player-only context (e.g. create offer) — not valid for reservation math.
    const playerData = opts.playerData ?? ctx.player;
    return {
      username: key,
      inventory: { ...(opts.inventory ?? playerData?.inventory ?? {}) },
      projects: opts.projects ?? playerData?.projects ?? [],
      tradeCounts: new Map(),
      excludeDirectTradeIds: opts.excludeDirectTradeIds ?? [],
      excludeListingIds: opts.excludeListingIds ?? [],
      reservationSource: 'skipped',
      reservationsTrusted: false,
    };
  }

  // canonical-fallback — shared counting over trades/* during root coexistence
  const snap = buildAvailabilitySnapshot(key, {
    ...opts,
    playerData: opts.playerData ?? ctx.player,
  });
  snap.reservationSource = ctx.reservationSource || 'canonical-fallback';
  snap.reservationsTrusted = true;
  return snap;
}

/**
 * Compare Research vs Trading self reservation outputs for DevTools parity proof.
 * @param {string} [username]
 * @returns {object}
 */
export function compareResearchTradingSelfAvailability(username) {
  const key = String(username || _getAuthenticatedUsername() || '').trim();
  const research = buildResearchAvailabilitySnapshot(key);
  const trading = buildTradingSelfAvailabilitySnapshot(key);

  // Ownership = Number(qty) > 0; ignore zero-only inventory keys in parity scans.
  const cards = new Set([
    ..._positiveInventoryCardIds(research.inventory),
    ..._positiveInventoryCardIds(trading.inventory),
    ...(research.tradeCounts ? [...research.tradeCounts.keys()] : []),
    ...(trading.tradeCounts ? [...trading.tradeCounts.keys()] : []),
  ]);

  const countDiffs = [];
  const availableDiffs = [];
  for (const cardId of cards) {
    const rc = research.tradeCounts?.get(cardId) || { outgoing: 0, listing: 0, incoming: 0 };
    const tc = trading.tradeCounts?.get(cardId) || { outgoing: 0, listing: 0, incoming: 0 };
    if (rc.outgoing !== tc.outgoing || rc.listing !== tc.listing || rc.incoming !== tc.incoming) {
      countDiffs.push({ cardId, research: rc, trading: tc });
    }
    const ra = getAvailableCopyCount(research, cardId);
    const ta = getAvailableCopyCount(trading, cardId);
    if (ra !== ta) {
      availableDiffs.push({ cardId, research: ra, trading: ta });
    }
  }

  const match = countDiffs.length === 0
    && availableDiffs.length === 0
    && research.reservationsTrusted === trading.reservationsTrusted
    && (research.reservationSource === trading.reservationSource
      || (research.reservationsTrusted && trading.reservationsTrusted
        && research.reservationSource !== 'loading'
        && trading.reservationSource !== 'loading'));

  const report = {
    username: key,
    match,
    researchSource: research.reservationSource,
    tradingSource: trading.reservationSource,
    researchTrusted: research.reservationsTrusted === true,
    tradingTrusted: trading.reservationsTrusted === true,
    countDiffs,
    availableDiffs,
  };
  if (!match) {
    console.warn('[TradeAvailability] Research/Trading self parity mismatch', report);
  } else {
    console.info('[TradeAvailability] Research/Trading self reservation parity OK', {
      username: key,
      researchSource: report.researchSource,
      tradingSource: report.tradingSource,
    });
  }
  return report;
}

// ─── Project uniqueness (binary per cardId) ───────────────────────────────────

/**
 * True when cardId appears in ANY ACTIVE project's assignments.
 * Projects consume the entire card identity — not per-copy slots.
 *
 * @param {string} cardId
 * @param {object[]} [projects]
 * @returns {boolean}
 */
export function isCardLockedByActiveProject(cardId, projects = []) {
  for (const project of projects) {
    if (project.state !== PROJECT_STATES.ACTIVE) continue;
    for (const id of project.assignedScientists ?? []) {
      if (id === cardId) return true;
    }
    for (const id of project.assignedConcepts ?? []) {
      if (id === cardId) return true;
    }
  }
  return false;
}

/**
 * @deprecated Use isCardLockedByActiveProject — projects are binary, not copy-counted.
 * @returns {number} 0 or 1
 */
export function countProjectCommittedCopies(cardId, projects = []) {
  return isCardLockedByActiveProject(cardId, projects) ? 1 : 0;
}

// ─── Trade reservation tallies (copy-aware) ───────────────────────────────────

/**
 * @typedef {{ outgoing: number, listing: number, incoming: number }} CardReservationBreakdown
 */

/**
 * Direct-trade statuses that reserve card copies.
 * Terminal statuses (accepted/declined/cancelled/failed) reserve nothing.
 */
export const ACTIVE_DIRECT_TRADE_STATUSES = new Set([
  'awaiting_target_response',
  'awaiting_offerer_confirmation',
  'processing',
]);

/**
 * @param {string} username
 * @param {object} [opts]
 * @param {object} [opts.directTrades]
 * @param {object} [opts.listings]
 * @param {number} [opts.now]
 * @param {string[]} [opts.excludeDirectTradeIds]
 * @param {string[]} [opts.excludeListingIds]
 * @returns {Map<string, CardReservationBreakdown>}
 */
export function buildTradeReservationCounts(username, {
  directTrades = null,
  listings = null,
  now = Date.now(),
  excludeDirectTradeIds = [],
  excludeListingIds = [],
} = {}) {
  const excludeDirect = new Set(excludeDirectTradeIds);
  const excludeListing = new Set(excludeListingIds);
  const counts = new Map();

  const bump = (cardId, field) => {
    if (!cardId) return;
    const cur = counts.get(cardId) ?? { outgoing: 0, listing: 0, incoming: 0 };
    cur[field]++;
    counts.set(cardId, cur);
  };

  const allDirect = directTrades ?? db.get('trades/direct') ?? {};
  for (const [tradeId, trade] of Object.entries(allDirect)) {
    if (!trade || !ACTIVE_DIRECT_TRADE_STATUSES.has(trade.status)) continue;
    if (excludeDirect.has(tradeId) || excludeDirect.has(trade.id)) continue;

    // awaiting_target_response: offered only
    // awaiting_offerer_confirmation / processing: offered + requested (if set)
    if (trade.offeringPlayerId === username) {
      bump(trade.offeredCardId, 'outgoing');
    }
    if (
      trade.targetPlayerId === username &&
      (trade.status === 'awaiting_offerer_confirmation' || trade.status === 'processing')
    ) {
      bump(trade.requestedCardId, 'incoming');
    }
  }

  // active + processing both reserve the creator's offered card (fulfill in flight).
  // Terminal statuses reserve nothing. excludeListingIds skips the listing under validation.
  const allListings = listings ?? db.get('trades/listings') ?? {};
  for (const [listingId, listing] of Object.entries(allListings)) {
    if (!listing) continue;
    if (listing.status !== 'active' && listing.status !== 'processing') continue;
    if (excludeListing.has(listingId) || excludeListing.has(listing.id)) continue;
    if (listing.expiresAt && now > listing.expiresAt) continue;
    if (listing.ownerId === username) {
      bump(listing.offeredCardId, 'listing');
    }
  }

  return counts;
}

/**
 * @param {Map<string, CardReservationBreakdown>} tradeCounts
 * @param {string} cardId
 * @returns {number}
 */
export function getTradeReservedCopies(tradeCounts, cardId) {
  const b = tradeCounts.get(cardId);
  if (!b) return 0;
  return b.outgoing + b.listing + b.incoming;
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} AvailabilitySnapshot
 * @property {string} username
 * @property {object} inventory
 * @property {object[]} projects
 * @property {Map<string, CardReservationBreakdown>} tradeCounts
 */

export function buildAvailabilitySnapshot(username, opts = {}) {
  const playerData = opts.playerData ?? db.get(`players/${username}`);
  return {
    username,
    inventory: { ...(opts.inventory ?? playerData?.inventory ?? {}) },
    projects: opts.projects ?? playerData?.projects ?? [],
    tradeCounts: buildTradeReservationCounts(username, {
      directTrades: opts.directTrades,
      listings: opts.listings,
      now: opts.now,
      excludeDirectTradeIds: opts.excludeDirectTradeIds ?? [],
      excludeListingIds: opts.excludeListingIds ?? [],
    }),
    excludeDirectTradeIds: opts.excludeDirectTradeIds ?? [],
    excludeListingIds: opts.excludeListingIds ?? [],
    reservationSource: opts.reservationSource || 'canonical',
    reservationsTrusted: opts.reservationsTrusted !== false,
  };
}

export function getOwnedCopyCount(snapshot, cardId) {
  return snapshot.inventory[cardId] || 0;
}

// ─── Trade availability (copy-aware) ──────────────────────────────────────────

/**
 * Copies available to offer in trade/listings.
 * One active project assignment consumes one physical copy; trade reservations consume copies.
 *
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @returns {number}
 */
export function getAvailableCopyCount(snapshot, cardId) {
  // Fail closed: untrusted reservation maps must never look like free inventory.
  if (snapshot?.reservationsTrusted === false) return 0;
  if (snapshot?.reservationSource === 'unavailable' || snapshot?.reservationSource === 'loading') {
    return 0;
  }
  const owned = getOwnedCopyCount(snapshot, cardId);
  const projectCopy = isCardLockedByActiveProject(cardId, snapshot.projects) ? 1 : 0;
  const trade = getTradeReservedCopies(snapshot.tradeCounts, cardId);
  return Math.max(0, owned - projectCopy - trade);
}

export function canOfferCardInTrade(snapshot, cardId) {
  if (snapshot?.reservationsTrusted === false) return false;
  if (snapshot?.reservationSource === 'unavailable' || snapshot?.reservationSource === 'loading') {
    return false;
  }
  return getAvailableCopyCount(snapshot, cardId) >= 1;
}

export function isLastAvailableCopy(snapshot, cardId) {
  if (snapshot?.reservationsTrusted === false) return false;
  return getAvailableCopyCount(snapshot, cardId) === 1;
}

// ─── Project assignment availability (binary project + copy-aware trade) ──────

/**
 * Whether a cardId may be assigned to a new ACTIVE project.
 *   - Blocked if cardId is already on ANY active project (binary)
 *   - Blocked if trade reservations leave no free copy
 *
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @returns {boolean}
 */
export function canAssignCardToProject(snapshot, cardId) {
  if (snapshot?.reservationsTrusted === false) return false;
  if (snapshot?.reservationSource === 'unavailable' || snapshot?.reservationSource === 'loading') {
    return false;
  }
  if (isCardLockedByActiveProject(cardId, snapshot.projects)) return false;
  const owned = getOwnedCopyCount(snapshot, cardId);
  const trade = getTradeReservedCopies(snapshot.tradeCounts, cardId);
  return (owned - trade) >= 1;
}

export function isProjectAssignmentLocked(snapshot, cardId) {
  return !canAssignCardToProject(snapshot, cardId);
}

/**
 * Assignment-panel tooltip when the card cannot be assigned.
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @returns {string|null}
 */
export function getProjectAssignmentLockTooltip(snapshot, cardId) {
  if (snapshot?.reservationSource === 'loading') {
    return 'Checking card availability…';
  }
  if (snapshot?.reservationSource === 'unavailable' || snapshot?.reservationsTrusted === false) {
    return 'Trade reservation data is unavailable';
  }
  if (getOwnedCopyCount(snapshot, cardId) < 1) return null;

  if (isCardLockedByActiveProject(cardId, snapshot.projects)) {
    return 'Assigned to an active research project';
  }

  const owned = getOwnedCopyCount(snapshot, cardId);
  const trade = getTradeReservedCopies(snapshot.tradeCounts, cardId);
  if ((owned - trade) >= 1) return null;

  const b = snapshot.tradeCounts.get(cardId) ?? { outgoing: 0, listing: 0, incoming: 0 };
  if (b.incoming > 0) return 'Last remaining card is reserved for an incoming trade';
  if (b.listing > 0) return 'Last remaining card is listed for trade';
  if (b.outgoing > 0) return 'Last remaining card is offered in a trade';

  return 'No copies available';
}

/**
 * @param {AvailabilitySnapshot} snapshot
 * @param {string} cardId
 * @param {'offer'|'assign'} context
 * @returns {string|null}
 */
export function getAvailabilityFailureReason(snapshot, cardId, context = 'offer') {
  // loading before untrusted: Research/Trading untrusted snaps set reservationsTrusted=false
  if (snapshot?.reservationSource === 'loading') {
    return 'TRADE_RESERVATION_DATA_LOADING';
  }
  if (snapshot?.reservationSource === 'unavailable' || snapshot?.reservationsTrusted === false) {
    return 'TRADE_RESERVATION_DATA_UNAVAILABLE';
  }

  if (context === 'assign') {
    if (isCardLockedByActiveProject(cardId, snapshot.projects)) {
      return 'locked_cards_present';
    }
    const owned = getOwnedCopyCount(snapshot, cardId);
    const trade = getTradeReservedCopies(snapshot.tradeCounts, cardId);
    if ((owned - trade) >= 1) return null;

    const b = snapshot.tradeCounts.get(cardId) ?? { outgoing: 0, listing: 0, incoming: 0 };
    if (b.incoming > 0) return 'CARD_RESERVED_BY_INCOMING_TRADE';
    if (b.listing > 0) return 'CARD_RESERVED_BY_LISTING';
    if (b.outgoing > 0) return 'CARD_RESERVED_BY_OUTGOING_TRADE';
    return 'INSUFFICIENT_AVAILABLE_COPIES';
  }

  // Trade / listing offer context — copy-aware including project copy consumption
  if (getAvailableCopyCount(snapshot, cardId) >= 1) return null;

  const b = snapshot.tradeCounts.get(cardId) ?? { outgoing: 0, listing: 0, incoming: 0 };
  if (b.incoming > 0) return 'CARD_RESERVED_BY_INCOMING_TRADE';
  if (b.listing > 0) return 'CARD_RESERVED_BY_LISTING';
  if (b.outgoing > 0) return 'CARD_RESERVED_BY_OUTGOING_TRADE';

  if (isCardLockedByActiveProject(cardId, snapshot.projects)) {
    return 'OFFERED_CARD_LOCKED_BY_PROJECT';
  }

  return 'INSUFFICIENT_AVAILABLE_COPIES';
}

export function validateCardsAssignableToProject(snapshot, cardIds) {
  for (const cardId of cardIds) {
    if (!cardId) continue;
    if (!canAssignCardToProject(snapshot, cardId)) {
      const reason = getAvailabilityFailureReason(snapshot, cardId, 'assign');
      return { valid: false, reason: reason ?? 'locked_cards_present', cardId };
    }
  }
  return { valid: true, reason: null };
}

/**
 * Positive-quantity inventory card IDs (canonical ownership: Number(qty) > 0).
 * Missing and numeric 0 are both non-owned — never treat key presence alone as ownership.
 * @param {Object} [inventory]
 * @returns {string[]}
 */
function _positiveInventoryCardIds(inventory) {
  const out = [];
  for (const [cardId, qty] of Object.entries(inventory || {})) {
    if (Number(qty) > 0) out.push(cardId);
  }
  return out;
}

/**
 * Card IDs with zero trade-available copies (for trade UI filtering).
 * When `cardIds` is omitted, only positive-qty inventory entries are considered so a
 * zero-valued leaf never appears as owned-but-unavailable/locked.
 * @param {AvailabilitySnapshot} snapshot
 * @param {string[]} [cardIds]
 * @returns {Set<string>}
 */
export function getUnavailableCardIds(snapshot, cardIds = null) {
  const ids = cardIds ?? _positiveInventoryCardIds(snapshot?.inventory);
  const out = new Set();
  for (const cardId of ids) {
    if (getAvailableCopyCount(snapshot, cardId) < 1) out.add(cardId);
  }
  return out;
}

export function countHiddenByReservations(snapshot, ownedTradableCardIds) {
  let hidden = 0;
  for (const cardId of ownedTradableCardIds) {
    const owned = getOwnedCopyCount(snapshot, cardId);
    if (owned < 1) continue;
    if (getAvailableCopyCount(snapshot, cardId) < 1) hidden++;
  }
  return hidden;
}

// ─── DevTools / parity surface ───────────────────────────────────────────────

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcTradeAvailability = {
    buildAvailabilitySnapshot,
    buildResearchAvailabilitySnapshot,
    buildTradingSelfAvailabilitySnapshot,
    buildCounterpartyAvailabilitySnapshot,
    loadTradingCounterpartyContext,
    loadDirectTradeByIdOnce,
    loadListingByIdOnce,
    resolveResearchReservationSource,
    resolveTradingReservationSource,
    loadPlayerTradeIndexReservationMaps,
    compareResearchTradingSelfAvailability,
    canOfferCardInTrade,
    getAvailableCopyCount,
    getAvailabilityFailureReason,
  };
}

_installWindowApi();
