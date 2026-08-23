/**
 * trade-index.js — Phase S5c-A/B derived trade indexes
 *
 * Canonical records remain:
 *   trades/direct/{tradeId}
 *   trades/listings/{listingId}
 *
 * Derived discovery / future reservation indexes:
 *   playerTradeIndex/{username}/_meta|direct|listings
 *   listingsByGroup/{groupId}/_meta|{listingId}
 *   tradeIndexMeta/schemaVersion + rebuiltAt
 *
 * S5c-A: builders, readiness, drift, Admin rebuild, registration/group seeds.
 * S5c-B: lifecycle dual-write path planners + shadowCompare (Trading still canonical).
 * S8d-4b: authoritative gather + pure buildTradeIndexRebuildPlan; Admin preview then
 *   Confirm RE-GATHERS and commits a fresh plan (never the stale preview plan).
 * S5c-C: Research uses verified playerTradeIndex via trade-availability
 *   buildResearchAvailabilitySnapshot.
 * S5c-D6: Trading self-availability uses the same PTI maps via
 *   buildTradingSelfAvailabilitySnapshot (current-player only; counterparty canonical until D7).
 *
 * Safety: missing / stale / unready / wrong-version must never be treated as
 * “zero reservations” by consumers (predicates exported here).
 */

import * as db from './database.js';
import {
  adminLoadCanonical,
  assertCanonicalComplete,
  canonicalChildEntries,
} from './admin-maintenance.js';
import { buildTradeReservationCounts } from './trade-availability.js';
import * as metrics from './db-metrics.js';

/** Bump when projection field shapes change; rebuild rewrites all `_meta.v`. */
export const CURRENT_TRADE_INDEX_SCHEMA_VERSION = 1;

export const TRADE_INDEX_META_ROOT = 'tradeIndexMeta';
export const PLAYER_TRADE_INDEX_ROOT = 'playerTradeIndex';
export const LISTINGS_BY_GROUP_ROOT = 'listingsByGroup';
export const TRADE_INDEX_META_KEY = '_meta';

/** Non-player infrastructure key under players/ — never seed PTI. */
const TRADE_INDEX_EXCLUDED_PLAYER_KEYS = Object.freeze(['__admin__']);

/** Hard allowlist for rebuild multipath keys (S8d-4b invariant). */
export const TRADE_INDEX_REBUILD_ALLOWED_PREFIXES = Object.freeze([
  `${PLAYER_TRADE_INDEX_ROOT}/`,
  `${LISTINGS_BY_GROUP_ROOT}/`,
  `${TRADE_INDEX_META_ROOT}/`,
]);

/** Direct statuses that belong in playerTradeIndex (mirrors reservation set). */
export const INDEXED_DIRECT_STATUSES = new Set([
  'awaiting_target_response',
  'awaiting_offerer_confirmation',
  'processing',
]);

/** Listing statuses that belong on the owner index (active reserves + processing). */
export const INDEXED_OWNER_LISTING_STATUSES = new Set(['active', 'processing']);

/**
 * @param {number|null} [rebuiltAt]
 * @returns {{ ready: true, v: number, rebuiltAt: number|null }}
 */
export function buildTradeIndexMeta(rebuiltAt = null) {
  return {
    ready: true,
    v: CURRENT_TRADE_INDEX_SCHEMA_VERSION,
    rebuiltAt: rebuiltAt == null ? null : Number(rebuiltAt),
  };
}

/**
 * @param {object|null|undefined} meta
 * @returns {boolean}
 */
export function isTradeIndexMetaReady(meta) {
  return (
    !!meta
    && meta.ready === true
    && Number(meta.v) === CURRENT_TRADE_INDEX_SCHEMA_VERSION
  );
}

/**
 * Global schema marker present and current (does not imply every player seeded).
 * @returns {boolean}
 */
export function isGlobalTradeIndexMetaCurrent() {
  const version = db.get(`${TRADE_INDEX_META_ROOT}/schemaVersion`);
  return Number(version) === CURRENT_TRADE_INDEX_SCHEMA_VERSION;
}

/**
 * Player reservation/discovery index initialized for this username.
 * Unready ≠ empty — callers must not treat false as zero reservations.
 * @param {string} username
 * @returns {boolean}
 */
export function isPlayerTradeIndexReady(username) {
  const key = String(username || '').trim();
  if (!key || key === '__admin__') return false;
  return isTradeIndexMetaReady(
    db.get(`${PLAYER_TRADE_INDEX_ROOT}/${key}/${TRADE_INDEX_META_KEY}`),
  );
}

/**
 * Group listing discovery index initialized.
 * @param {string} groupId
 * @returns {boolean}
 */
export function isGroupListingsIndexReady(groupId) {
  const key = String(groupId || '').trim();
  if (!key) return false;
  return isTradeIndexMetaReady(
    db.get(`${LISTINGS_BY_GROUP_ROOT}/${key}/${TRADE_INDEX_META_KEY}`),
  );
}

/**
 * @typedef {'index'|'canonical-fallback'|'unavailable'|'loading'} TradeIndexReservationSource
 */

/**
 * Whether bare trades/direct|listings may be used as a coexistence fallback.
 * Denied under personal cache-isolation OR S7b scoped boot (no root refill).
 * Root-on coexistence unchanged when both are off.
 * @returns {boolean}
 */
export function canAllowCanonicalTradeTreeFallback() {
  try {
    if (typeof localStorage !== 'undefined'
      && localStorage.getItem('qc-personal-cache-isolation') === 'true') {
      return false;
    }
  } catch { /* ignore */ }
  try {
    if (typeof db.isScopedOnlyMode === 'function' && db.isScopedOnlyMode()) {
      return false;
    }
  } catch { /* ignore */ }
  return true;
}

/**
 * Resolve reservation data source for a player.
 * Unready / wrong-version index must never be treated as zero reservations.
 *
 * @param {string} username
 * @param {{
 *   allowCanonicalFallback?: boolean,
 *   scopePathReady?: boolean,
 *   forceUnavailable?: boolean,
 *   hydrating?: boolean,
 * }} [opts]
 * @returns {TradeIndexReservationSource}
 */
export function getReservationIndexSource(username, opts = {}) {
  const key = String(username || '').trim();
  if (!key || key === '__admin__') return 'unavailable';
  if (opts.forceUnavailable === true) return 'unavailable';

  const pathReady = opts.scopePathReady != null
    ? opts.scopePathReady === true
    : (typeof db.isPathReady === 'function'
      ? db.isPathReady(`${PLAYER_TRADE_INDEX_ROOT}/${key}`)
      : false);

  const metaOk = isPlayerTradeIndexReady(key) && isGlobalTradeIndexMetaCurrent();

  if (metaOk && pathReady) return 'index';

  if (opts.hydrating === true || (!pathReady && metaOk)) {
    return 'loading';
  }

  if (opts.allowCanonicalFallback === true) {
    return 'canonical-fallback';
  }

  return 'unavailable';
}

/**
 * Seed paths for a new player with zero active trades (registration).
 * @param {string} username
 * @returns {Record<string, object>}
 */
export function emptyPlayerTradeIndexPaths(username) {
  const key = String(username || '').trim();
  if (!key || key === '__admin__') return {};
  return {
    [`${PLAYER_TRADE_INDEX_ROOT}/${key}/${TRADE_INDEX_META_KEY}`]: buildTradeIndexMeta(null),
  };
}

/**
 * Seed paths for a new group with zero listings.
 * @param {string} groupId
 * @returns {Record<string, object>}
 */
export function emptyGroupListingsIndexPaths(groupId) {
  const key = String(groupId || '').trim();
  if (!key) return {};
  return {
    [`${LISTINGS_BY_GROUP_ROOT}/${key}/${TRADE_INDEX_META_KEY}`]: buildTradeIndexMeta(null),
  };
}

/**
 * @param {object|null|undefined} trade
 * @param {string} tradeId
 * @returns {{
 *   id: string,
 *   status: string,
 *   offeringPlayerId: string,
 *   targetPlayerId: string,
 *   offeredCardId: string,
 *   requestedCardId: string|null,
 *   createdAt: number,
 *   respondedAt: number|null
 * }|null}
 */
export function buildDirectTradeIndexEntry(trade, tradeId) {
  if (!trade || typeof trade !== 'object') return null;
  const status = trade.status;
  if (!INDEXED_DIRECT_STATUSES.has(status)) return null;
  const id = String(trade.id || tradeId || '');
  if (!id) return null;
  const offeringPlayerId = trade.offeringPlayerId != null ? String(trade.offeringPlayerId) : '';
  const targetPlayerId = trade.targetPlayerId != null ? String(trade.targetPlayerId) : '';
  const offeredCardId = trade.offeredCardId != null ? String(trade.offeredCardId) : '';
  if (!offeringPlayerId || !targetPlayerId || !offeredCardId) return null;

  return {
    id,
    status: String(status),
    offeringPlayerId,
    targetPlayerId,
    offeredCardId,
    requestedCardId: trade.requestedCardId != null && trade.requestedCardId !== ''
      ? String(trade.requestedCardId)
      : null,
    createdAt: Number(trade.createdAt) || 0,
    respondedAt: trade.respondedAt != null ? Number(trade.respondedAt) : null,
  };
}

/**
 * Owner listing leaf (includes processing; includes requestedCardIds).
 * Soft-expired listings are omitted (match reservation skip).
 * @param {object|null|undefined} listing
 * @param {string} listingId
 * @param {number} [now]
 * @returns {object|null}
 */
export function buildOwnerListingIndexEntry(listing, listingId, now = Date.now()) {
  if (!listing || typeof listing !== 'object') return null;
  if (!INDEXED_OWNER_LISTING_STATUSES.has(listing.status)) return null;
  if (listing.expiresAt && now > Number(listing.expiresAt)) return null;
  const id = String(listing.id || listingId || '');
  const ownerId = listing.ownerId != null ? String(listing.ownerId) : '';
  const offeredCardId = listing.offeredCardId != null ? String(listing.offeredCardId) : '';
  if (!id || !ownerId || !offeredCardId) return null;

  const requestedCardIds = Array.isArray(listing.requestedCardIds)
    ? listing.requestedCardIds.map(String)
    : [];

  return {
    id,
    status: String(listing.status),
    offeredCardId,
    requestedCardIds,
    expiresAt: listing.expiresAt != null ? Number(listing.expiresAt) : null,
    groupId: listing.groupId != null && listing.groupId !== '' ? String(listing.groupId) : null,
    createdAt: Number(listing.createdAt) || 0,
  };
}

/**
 * Group browser leaf — active + not expired only (processing never browsable).
 * @param {object|null|undefined} listing
 * @param {string} listingId
 * @param {number} [now]
 * @returns {object|null}
 */
export function buildGroupListingIndexEntry(listing, listingId, now = Date.now()) {
  if (!listing || typeof listing !== 'object') return null;
  if (listing.status !== 'active') return null;
  if (listing.expiresAt && now > Number(listing.expiresAt)) return null;
  const id = String(listing.id || listingId || '');
  const ownerId = listing.ownerId != null ? String(listing.ownerId) : '';
  const offeredCardId = listing.offeredCardId != null ? String(listing.offeredCardId) : '';
  const groupId = listing.groupId != null && listing.groupId !== '' ? String(listing.groupId) : '';
  if (!id || !ownerId || !offeredCardId || !groupId) return null;

  const requestedCardIds = Array.isArray(listing.requestedCardIds)
    ? listing.requestedCardIds.map(String)
    : [];

  return {
    id,
    ownerId,
    offeredCardId,
    requestedCardIds,
    expiresAt: listing.expiresAt != null ? Number(listing.expiresAt) : null,
    status: 'active',
    createdAt: Number(listing.createdAt) || 0,
  };
}

/**
 * @param {object|null|undefined} a
 * @param {object|null|undefined} b
 * @returns {boolean}
 */
export function directTradeIndexEntriesEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.id === b.id
    && a.status === b.status
    && a.offeringPlayerId === b.offeringPlayerId
    && a.targetPlayerId === b.targetPlayerId
    && a.offeredCardId === b.offeredCardId
    && (a.requestedCardId ?? null) === (b.requestedCardId ?? null)
    && Number(a.createdAt) === Number(b.createdAt)
    && (a.respondedAt == null ? b.respondedAt == null : Number(a.respondedAt) === Number(b.respondedAt))
  );
}

/**
 * @param {object|null|undefined} a
 * @param {object|null|undefined} b
 * @returns {boolean}
 */
export function ownerListingIndexEntriesEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.id === b.id
    && a.status === b.status
    && a.offeredCardId === b.offeredCardId
    && (a.groupId ?? null) === (b.groupId ?? null)
    && Number(a.createdAt) === Number(b.createdAt)
    && (a.expiresAt == null ? b.expiresAt == null : Number(a.expiresAt) === Number(b.expiresAt))
    && _stringArraysEqual(a.requestedCardIds, b.requestedCardIds)
  );
}

/**
 * @param {object|null|undefined} a
 * @param {object|null|undefined} b
 * @returns {boolean}
 */
export function groupListingIndexEntriesEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.id === b.id
    && a.ownerId === b.ownerId
    && a.offeredCardId === b.offeredCardId
    && a.status === b.status
    && Number(a.createdAt) === Number(b.createdAt)
    && (a.expiresAt == null ? b.expiresAt == null : Number(a.expiresAt) === Number(b.expiresAt))
    && _stringArraysEqual(a.requestedCardIds, b.requestedCardIds)
  );
}

/**
 * Ready + schema version only (rebuiltAt ignored for idempotent rebuild compares).
 * @param {object|null|undefined} a
 * @param {object|null|undefined} b
 * @returns {boolean}
 */
export function tradeIndexMetaEqual(a, b) {
  if (!a || !b) return false;
  return a.ready === b.ready && Number(a.v) === Number(b.v);
}

function _stringArraysEqual(a, b) {
  const aa = Array.isArray(a) ? a.map(String) : [];
  const bb = Array.isArray(b) ? b.map(String) : [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) return false;
  }
  return true;
}

/**
 * @param {Record<string, unknown>|null|undefined} updates
 * @returns {true}
 */
export function assertTradeIndexRebuildPathsAllowed(updates) {
  const keys = updates && typeof updates === 'object' ? Object.keys(updates) : [];
  for (const path of keys) {
    const ok = TRADE_INDEX_REBUILD_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (!ok) {
      throw new Error(
        `[TradeIndex] Illegal rebuild path ${JSON.stringify(path)} — `
        + `only ${TRADE_INDEX_REBUILD_ALLOWED_PREFIXES.join(' | ')} allowed`,
      );
    }
  }
  return true;
}

/**
 * Pure: derive desired PTI/LBG projection from explicit snapshots (no DB/cache).
 *
 * @param {{
 *   playersSnapshot?: object|null,
 *   groupsSnapshot?: object|null,
 *   directTradesSnapshot?: object|null,
 *   listingsSnapshot?: object|null,
 *   now?: number,
 *   rebuiltAt?: number,
 * }} [input]
 */
export function deriveDesiredTradeIndexes(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const rebuiltAt = Number.isFinite(Number(input.rebuiltAt)) ? Number(input.rebuiltAt) : now;
  const meta = buildTradeIndexMeta(rebuiltAt);

  /** @type {Map<string, { meta: object, direct: Map<string, object>, listings: Map<string, object> }>} */
  const players = new Map();
  /** @type {Map<string, { meta: object, listings: Map<string, object> }>} */
  const groups = new Map();
  let skippedMissingGroup = 0;
  let directTradesScanned = 0;
  let listingsScanned = 0;

  const ensurePlayer = (username) => {
    if (!players.has(username)) {
      players.set(username, { meta, direct: new Map(), listings: new Map() });
    }
    return players.get(username);
  };

  const ensureGroup = (groupId) => {
    if (!groups.has(groupId)) {
      groups.set(groupId, { meta, listings: new Map() });
    }
    return groups.get(groupId);
  };

  const playerEntries = canonicalChildEntries(input.playersSnapshot, {
    exclude: [...TRADE_INDEX_EXCLUDED_PLAYER_KEYS],
  });
  for (const { key } of playerEntries) {
    ensurePlayer(key);
  }

  const groupEntries = canonicalChildEntries(input.groupsSnapshot, { exclude: [] });
  const knownGroups = new Set(groupEntries.map(({ key }) => key));
  for (const { key } of groupEntries) {
    ensureGroup(key);
  }

  const allDirect = input.directTradesSnapshot && typeof input.directTradesSnapshot === 'object'
    ? input.directTradesSnapshot
    : {};
  for (const [tradeId, trade] of Object.entries(allDirect)) {
    directTradesScanned += 1;
    const entry = buildDirectTradeIndexEntry(trade, tradeId);
    if (!entry) continue;
    // Only project under current canonical players (never invent deleted-user PTI roots)
    if (players.has(entry.offeringPlayerId)) {
      ensurePlayer(entry.offeringPlayerId).direct.set(entry.id, entry);
    }
    if (players.has(entry.targetPlayerId)) {
      ensurePlayer(entry.targetPlayerId).direct.set(entry.id, entry);
    }
  }

  const allListings = input.listingsSnapshot && typeof input.listingsSnapshot === 'object'
    ? input.listingsSnapshot
    : {};
  for (const [listingId, listing] of Object.entries(allListings)) {
    listingsScanned += 1;
    const ownerEntry = buildOwnerListingIndexEntry(listing, listingId, now);
    if (ownerEntry && listing.ownerId) {
      const ownerKey = String(listing.ownerId);
      if (players.has(ownerKey)) {
        ensurePlayer(ownerKey).listings.set(ownerEntry.id, ownerEntry);
      }
    }
    const groupEntry = buildGroupListingIndexEntry(listing, listingId, now);
    if (groupEntry && listing.groupId) {
      const gid = String(listing.groupId);
      if (knownGroups.has(gid)) {
        ensureGroup(gid).listings.set(groupEntry.id, groupEntry);
      } else {
        // Active listing points at deleted/missing group — owner PTI may still exist; no LBG
        skippedMissingGroup += 1;
      }
    }
  }

  return {
    now,
    rebuiltAt,
    meta,
    players,
    groups,
    global: {
      schemaVersion: CURRENT_TRADE_INDEX_SCHEMA_VERSION,
      rebuiltAt,
    },
    skippedMissingGroup,
    playersScanned: playerEntries.length,
    groupsScanned: groupEntries.length,
    directTradesScanned,
    listingsScanned,
  };
}

/**
 * @param {object|null|undefined} node
 * @returns {Map<string, object>}
 */
function _childMapFromNode(node) {
  if (!node || typeof node !== 'object') return new Map();
  const map = new Map();
  for (const [key, value] of Object.entries(node)) {
    if (key === TRADE_INDEX_META_KEY) continue;
    if (value != null && typeof value === 'object') map.set(key, value);
  }
  return map;
}

/**
 * Pure rebuild plan from explicit snapshots. No DB/cache reads.
 *
 * @param {{
 *   playersSnapshot?: object|null,
 *   groupsSnapshot?: object|null,
 *   directTradesSnapshot?: object|null,
 *   listingsSnapshot?: object|null,
 *   playerTradeIndexSnapshot?: object|null,
 *   listingsByGroupSnapshot?: object|null,
 *   tradeIndexMetaSnapshot?: object|null,
 *   now?: number,
 *   rebuiltAt?: number,
 * }} [input]
 */
export function buildTradeIndexRebuildPlan(input = {}) {
  const desired = deriveDesiredTradeIndexes(input);
  const ptiSnap = input.playerTradeIndexSnapshot && typeof input.playerTradeIndexSnapshot === 'object'
    ? input.playerTradeIndexSnapshot
    : {};
  const lbgSnap = input.listingsByGroupSnapshot && typeof input.listingsByGroupSnapshot === 'object'
    ? input.listingsByGroupSnapshot
    : {};
  const metaSnap = input.tradeIndexMetaSnapshot && typeof input.tradeIndexMetaSnapshot === 'object'
    ? input.tradeIndexMetaSnapshot
    : {};

  /** @type {Record<string, object|null>} */
  const updates = {};
  let ptiCreated = 0;
  let ptiUpdated = 0;
  let ptiRemoved = 0;
  let ptiUnchanged = 0;
  let ptiReadinessRepairs = 0;
  let groupCreated = 0;
  let groupUpdated = 0;
  let groupRemoved = 0;
  let groupUnchanged = 0;
  let groupReadinessRepairs = 0;
  let deletedPlayerRootsRemoved = 0;
  let deletedGroupRootsRemoved = 0;
  let metaChanged = false;
  /** @type {string[]} */
  const createdKeys = [];
  /** @type {string[]} */
  const updatedKeys = [];
  /** @type {string[]} */
  const removedKeys = [];

  const touchPtiEntry = (path, next, equalFn, existing) => {
    if (existing == null) {
      updates[path] = next;
      ptiCreated += 1;
      createdKeys.push(path);
    } else if (!equalFn(existing, next)) {
      updates[path] = next;
      ptiUpdated += 1;
      updatedKeys.push(path);
    } else {
      ptiUnchanged += 1;
    }
  };

  const touchGroupEntry = (path, next, equalFn, existing) => {
    if (existing == null) {
      updates[path] = next;
      groupCreated += 1;
      createdKeys.push(path);
    } else if (!equalFn(existing, next)) {
      updates[path] = next;
      groupUpdated += 1;
      updatedKeys.push(path);
    } else {
      groupUnchanged += 1;
    }
  };

  const existingPlayerKeys = new Set(Object.keys(ptiSnap));

  for (const [username, bucket] of desired.players) {
    existingPlayerKeys.delete(username);
    const playerNode = ptiSnap[username];
    const metaPath = `${PLAYER_TRADE_INDEX_ROOT}/${username}/${TRADE_INDEX_META_KEY}`;
    const existingMeta = playerNode && typeof playerNode === 'object'
      ? playerNode[TRADE_INDEX_META_KEY]
      : undefined;
    const nextMeta = isTradeIndexMetaReady(existingMeta)
      ? buildTradeIndexMeta(existingMeta.rebuiltAt)
      : bucket.meta;
    if (existingMeta == null) {
      updates[metaPath] = nextMeta;
      ptiReadinessRepairs += 1;
      createdKeys.push(metaPath);
    } else if (!tradeIndexMetaEqual(existingMeta, nextMeta)) {
      updates[metaPath] = nextMeta;
      ptiReadinessRepairs += 1;
      updatedKeys.push(metaPath);
    } else {
      ptiUnchanged += 1;
    }

    const existingDirect = _childMapFromNode(
      playerNode && typeof playerNode === 'object' ? playerNode.direct : null,
    );
    for (const [tradeId, entry] of bucket.direct) {
      const path = `${PLAYER_TRADE_INDEX_ROOT}/${username}/direct/${tradeId}`;
      touchPtiEntry(path, entry, directTradeIndexEntriesEqual, existingDirect.get(tradeId));
      existingDirect.delete(tradeId);
    }
    for (const tradeId of existingDirect.keys()) {
      const path = `${PLAYER_TRADE_INDEX_ROOT}/${username}/direct/${tradeId}`;
      updates[path] = null;
      ptiRemoved += 1;
      removedKeys.push(path);
    }

    const existingListings = _childMapFromNode(
      playerNode && typeof playerNode === 'object' ? playerNode.listings : null,
    );
    for (const [listingId, entry] of bucket.listings) {
      const path = `${PLAYER_TRADE_INDEX_ROOT}/${username}/listings/${listingId}`;
      touchPtiEntry(path, entry, ownerListingIndexEntriesEqual, existingListings.get(listingId));
      existingListings.delete(listingId);
    }
    for (const listingId of existingListings.keys()) {
      const path = `${PLAYER_TRADE_INDEX_ROOT}/${username}/listings/${listingId}`;
      updates[path] = null;
      ptiRemoved += 1;
      removedKeys.push(path);
    }
  }

  for (const username of existingPlayerKeys) {
    if (username === TRADE_INDEX_EXCLUDED_PLAYER_KEYS[0]) {
      // still remove __admin__ PTI if present
    }
    const path = `${PLAYER_TRADE_INDEX_ROOT}/${username}`;
    updates[path] = null;
    deletedPlayerRootsRemoved += 1;
    ptiRemoved += 1;
    removedKeys.push(path);
  }

  const existingGroupKeys = new Set(Object.keys(lbgSnap));

  for (const [groupId, bucket] of desired.groups) {
    existingGroupKeys.delete(groupId);
    const groupNode = lbgSnap[groupId];
    const metaPath = `${LISTINGS_BY_GROUP_ROOT}/${groupId}/${TRADE_INDEX_META_KEY}`;
    const existingMeta = groupNode && typeof groupNode === 'object'
      ? groupNode[TRADE_INDEX_META_KEY]
      : undefined;
    const nextMeta = isTradeIndexMetaReady(existingMeta)
      ? buildTradeIndexMeta(existingMeta.rebuiltAt)
      : bucket.meta;
    if (existingMeta == null) {
      updates[metaPath] = nextMeta;
      groupReadinessRepairs += 1;
      createdKeys.push(metaPath);
    } else if (!tradeIndexMetaEqual(existingMeta, nextMeta)) {
      updates[metaPath] = nextMeta;
      groupReadinessRepairs += 1;
      updatedKeys.push(metaPath);
    } else {
      groupUnchanged += 1;
    }

    const existingListings = _childMapFromNode(groupNode);
    for (const [listingId, entry] of bucket.listings) {
      const path = `${LISTINGS_BY_GROUP_ROOT}/${groupId}/${listingId}`;
      touchGroupEntry(path, entry, groupListingIndexEntriesEqual, existingListings.get(listingId));
      existingListings.delete(listingId);
    }
    for (const listingId of existingListings.keys()) {
      const path = `${LISTINGS_BY_GROUP_ROOT}/${groupId}/${listingId}`;
      updates[path] = null;
      groupRemoved += 1;
      removedKeys.push(path);
    }
  }

  for (const groupId of existingGroupKeys) {
    const path = `${LISTINGS_BY_GROUP_ROOT}/${groupId}`;
    updates[path] = null;
    deletedGroupRootsRemoved += 1;
    groupRemoved += 1;
    removedKeys.push(path);
  }

  const gv = metaSnap.schemaVersion;
  if (Number(gv) !== desired.global.schemaVersion) {
    updates[`${TRADE_INDEX_META_ROOT}/schemaVersion`] = desired.global.schemaVersion;
    metaChanged = true;
  }

  const gr = metaSnap.rebuiltAt;
  const contentPending = Object.keys(updates).length;
  if (contentPending > 0) {
    const stamp = desired.global.rebuiltAt;
    updates[`${TRADE_INDEX_META_ROOT}/rebuiltAt`] = stamp;
    metaChanged = true;
    const stampedMeta = buildTradeIndexMeta(stamp);
    for (const path of Object.keys(updates)) {
      if (path.endsWith(`/${TRADE_INDEX_META_KEY}`) && updates[path] != null) {
        updates[path] = stampedMeta;
      }
    }
  } else if (gr == null) {
    // First global stamp only when schemaVersion already correct but rebuiltAt never set —
    // still a meta-only write (rare). Prefer zero writes when fully clean including rebuiltAt.
    if (Number(gv) !== desired.global.schemaVersion) {
      updates[`${TRADE_INDEX_META_ROOT}/schemaVersion`] = desired.global.schemaVersion;
      updates[`${TRADE_INDEX_META_ROOT}/rebuiltAt`] = desired.global.rebuiltAt;
      metaChanged = true;
    }
    // If schema ok and only rebuiltAt null with zero content: leave clean (no stamp) for true idempotency
  }

  assertTradeIndexRebuildPathsAllowed(updates);

  return {
    ok: true,
    updates,
    playersScanned: desired.playersScanned,
    groupsScanned: desired.groupsScanned,
    directTradesScanned: desired.directTradesScanned,
    listingsScanned: desired.listingsScanned,
    ptiCreated,
    ptiUpdated,
    ptiRemoved,
    ptiUnchanged,
    ptiReadinessRepairs,
    groupCreated,
    groupUpdated,
    groupRemoved,
    groupUnchanged,
    groupReadinessRepairs,
    deletedPlayerRootsRemoved,
    deletedGroupRootsRemoved,
    skippedMissingGroup: desired.skippedMissingGroup,
    metaChanged,
    createdKeys,
    updatedKeys,
    removedKeys,
    now: desired.now,
    rebuiltAt: updates[`${TRADE_INDEX_META_ROOT}/rebuiltAt`] ?? gr ?? desired.rebuiltAt,
  };
}

/**
 * @deprecated Prefer buildTradeIndexRebuildPlan with explicit snapshots.
 * Thin alias for callers that still pass opts shaped like the old API.
 */
export function buildTradeIndexRebuildUpdates(opts = {}) {
  return buildTradeIndexRebuildPlan(opts);
}

/**
 * Gather authoritative Firebase snapshots for Trade Index rebuild (fail-closed).
 *
 * @param {{ timeoutMs?: number }} [options]
 */
export async function gatherTradeIndexRebuildSnapshots(options = {}) {
  const playersLoad = await adminLoadCanonical('players', options);
  if (!assertCanonicalComplete(playersLoad)) {
    return {
      ok: false,
      complete: false,
      error: playersLoad?.error || 'PLAYERS_CANONICAL_INCOMPLETE',
    };
  }

  const directLoad = await adminLoadCanonical('trades/direct', options);
  if (!assertCanonicalComplete(directLoad)) {
    return {
      ok: false,
      complete: false,
      error: directLoad?.error || 'DIRECT_TRADES_CANONICAL_INCOMPLETE',
    };
  }

  const listingsLoad = await adminLoadCanonical('trades/listings', options);
  if (!assertCanonicalComplete(listingsLoad)) {
    return {
      ok: false,
      complete: false,
      error: listingsLoad?.error || 'LISTINGS_CANONICAL_INCOMPLETE',
    };
  }

  const forceOnce = async (path) => {
    const load = await db.loadPathOnce(path, {
      force: true,
      timeoutMs: options.timeoutMs,
    });
    if (!load || load.ok !== true || load.mode !== 'firebase') {
      return { ok: false, error: load?.error || `${path}_LOAD_INCOMPLETE`, value: null };
    }
    return { ok: true, value: load.value == null ? null : load.value };
  };

  const groupsLoad = await forceOnce('groups');
  if (!groupsLoad.ok) {
    return { ok: false, complete: false, error: groupsLoad.error };
  }
  const ptiLoad = await forceOnce(PLAYER_TRADE_INDEX_ROOT);
  if (!ptiLoad.ok) {
    return { ok: false, complete: false, error: ptiLoad.error };
  }
  const lbgLoad = await forceOnce(LISTINGS_BY_GROUP_ROOT);
  if (!lbgLoad.ok) {
    return { ok: false, complete: false, error: lbgLoad.error };
  }
  const metaLoad = await forceOnce(TRADE_INDEX_META_ROOT);
  if (!metaLoad.ok) {
    return { ok: false, complete: false, error: metaLoad.error };
  }

  return {
    ok: true,
    complete: true,
    playersSnapshot: playersLoad.value,
    groupsSnapshot: groupsLoad.value,
    directTradesSnapshot: directLoad.value,
    listingsSnapshot: listingsLoad.value,
    playerTradeIndexSnapshot: ptiLoad.value,
    listingsByGroupSnapshot: lbgLoad.value,
    tradeIndexMetaSnapshot: metaLoad.value,
  };
}

/**
 * Advisory preview: gather + plan. Does not write.
 * Confirm path must re-gather (do not commit this plan).
 *
 * @param {{ timeoutMs?: number, now?: number }} [options]
 */
export async function prepareTradeIndexRebuild(options = {}) {
  const gathered = await gatherTradeIndexRebuildSnapshots(options);
  if (!gathered.ok || !gathered.complete) {
    return {
      ok: false,
      skipped: false,
      complete: false,
      plan: null,
      error: gathered.error || 'Gather failed',
      playersScanned: 0,
      groupsScanned: 0,
      directTradesScanned: 0,
      listingsScanned: 0,
      ptiCreated: 0,
      ptiUpdated: 0,
      ptiRemoved: 0,
      ptiReadinessRepairs: 0,
      groupCreated: 0,
      groupUpdated: 0,
      groupRemoved: 0,
      groupReadinessRepairs: 0,
    };
  }

  const plan = buildTradeIndexRebuildPlan({
    playersSnapshot: gathered.playersSnapshot,
    groupsSnapshot: gathered.groupsSnapshot,
    directTradesSnapshot: gathered.directTradesSnapshot,
    listingsSnapshot: gathered.listingsSnapshot,
    playerTradeIndexSnapshot: gathered.playerTradeIndexSnapshot,
    listingsByGroupSnapshot: gathered.listingsByGroupSnapshot,
    tradeIndexMetaSnapshot: gathered.tradeIndexMetaSnapshot,
    now: options.now,
  });

  return {
    ok: true,
    skipped: Object.keys(plan.updates).length === 0,
    complete: true,
    plan,
    advisory: true,
    error: undefined,
    playersScanned: plan.playersScanned,
    groupsScanned: plan.groupsScanned,
    directTradesScanned: plan.directTradesScanned,
    listingsScanned: plan.listingsScanned,
    ptiCreated: plan.ptiCreated,
    ptiUpdated: plan.ptiUpdated,
    ptiRemoved: plan.ptiRemoved,
    ptiUnchanged: plan.ptiUnchanged,
    ptiReadinessRepairs: plan.ptiReadinessRepairs,
    groupCreated: plan.groupCreated,
    groupUpdated: plan.groupUpdated,
    groupRemoved: plan.groupRemoved,
    groupUnchanged: plan.groupUnchanged,
    groupReadinessRepairs: plan.groupReadinessRepairs,
    deletedPlayerRootsRemoved: plan.deletedPlayerRootsRemoved,
    deletedGroupRootsRemoved: plan.deletedGroupRootsRemoved,
    skippedMissingGroup: plan.skippedMissingGroup,
    metaChanged: plan.metaChanged,
  };
}

/**
 * Commit a fresh in-memory plan (exact updates). Does not re-gather.
 * Prefer commitTradeIndexRebuildFresh() from Admin UI.
 *
 * @param {object} plan
 */
export async function commitTradeIndexRebuildPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    return {
      ok: false,
      skipped: false,
      written: 0,
      error: 'INVALID_PLAN',
    };
  }

  const updates = plan.updates && typeof plan.updates === 'object' ? plan.updates : {};
  try {
    assertTradeIndexRebuildPathsAllowed(updates);
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      written: 0,
      error: err?.message || 'ILLEGAL_REBUILD_PATH',
    };
  }

  if (Object.keys(updates).length === 0) {
    return {
      ok: true,
      skipped: true,
      written: 0,
      ..._planCounts(plan),
    };
  }

  const ack = await db.updateAcknowledged(updates);
  if (!ack.ok) {
    return {
      ok: false,
      skipped: false,
      written: 0,
      mode: ack.mode,
      error: ack.error || 'COMMIT_FAILED',
      ..._planCounts(plan),
    };
  }

  return {
    ok: true,
    skipped: false,
    written: Object.keys(updates).length,
    mode: ack.mode,
    ..._planCounts(plan),
    rebuiltAt: plan.rebuiltAt,
  };
}

function _planCounts(plan) {
  return {
    playersScanned: Number(plan.playersScanned) || 0,
    groupsScanned: Number(plan.groupsScanned) || 0,
    directTradesScanned: Number(plan.directTradesScanned) || 0,
    listingsScanned: Number(plan.listingsScanned) || 0,
    ptiCreated: Number(plan.ptiCreated) || 0,
    ptiUpdated: Number(plan.ptiUpdated) || 0,
    ptiRemoved: Number(plan.ptiRemoved) || 0,
    ptiUnchanged: Number(plan.ptiUnchanged) || 0,
    ptiReadinessRepairs: Number(plan.ptiReadinessRepairs) || 0,
    groupCreated: Number(plan.groupCreated) || 0,
    groupUpdated: Number(plan.groupUpdated) || 0,
    groupRemoved: Number(plan.groupRemoved) || 0,
    groupUnchanged: Number(plan.groupUnchanged) || 0,
    groupReadinessRepairs: Number(plan.groupReadinessRepairs) || 0,
    deletedPlayerRootsRemoved: Number(plan.deletedPlayerRootsRemoved) || 0,
    deletedGroupRootsRemoved: Number(plan.deletedGroupRootsRemoved) || 0,
    skippedMissingGroup: Number(plan.skippedMissingGroup) || 0,
    metaChanged: plan.metaChanged === true,
  };
}

/**
 * S8d-4b confirm path: re-gather → fresh plan → commit. Never commits a stale preview plan.
 *
 * @param {{ timeoutMs?: number, now?: number }} [options]
 */
export async function commitTradeIndexRebuildFresh(options = {}) {
  const gathered = await gatherTradeIndexRebuildSnapshots(options);
  if (!gathered.ok || !gathered.complete) {
    return {
      ok: false,
      skipped: false,
      written: 0,
      error: gathered.error || 'Fresh gather failed',
      ..._planCounts({}),
    };
  }

  const plan = buildTradeIndexRebuildPlan({
    playersSnapshot: gathered.playersSnapshot,
    groupsSnapshot: gathered.groupsSnapshot,
    directTradesSnapshot: gathered.directTradesSnapshot,
    listingsSnapshot: gathered.listingsSnapshot,
    playerTradeIndexSnapshot: gathered.playerTradeIndexSnapshot,
    listingsByGroupSnapshot: gathered.listingsByGroupSnapshot,
    tradeIndexMetaSnapshot: gathered.tradeIndexMetaSnapshot,
    now: options.now,
  });

  return commitTradeIndexRebuildPlan(plan);
}

/**
 * Legacy DevTools drift report (still uses scoped cache — not for Admin rebuild).
 * Prefer prepareTradeIndexRebuild for authoritative preview.
 */
export function getTradeIndexDriftReport(opts = {}) {
  const playersSnap = {};
  for (const { key, value } of db.getChildren('players')) {
    playersSnap[key] = value;
  }
  const groupsSnap = {};
  for (const { key, value } of db.getChildren('groups')) {
    groupsSnap[key] = value;
  }
  const desired = deriveDesiredTradeIndexes({
    playersSnapshot: playersSnap,
    groupsSnapshot: groupsSnap,
    directTradesSnapshot: db.get('trades/direct'),
    listingsSnapshot: db.get('trades/listings'),
    now: opts.now,
    rebuiltAt: opts.rebuiltAt,
  });

  const missing = [];
  const stale = [];
  const orphaned = [];
  const wrongParticipant = [];
  const wrongGroup = [];
  const wrongStatus = [];
  const unreadyPlayer = [];
  const unreadyGroup = [];
  let inSync = 0;

  const existingPlayerKeys = new Set(
    db.getChildren(PLAYER_TRADE_INDEX_ROOT).map(({ key }) => key),
  );
  const existingGroupKeys = new Set(
    db.getChildren(LISTINGS_BY_GROUP_ROOT).map(({ key }) => key),
  );

  for (const [username, bucket] of desired.players) {
    const metaPath = `${PLAYER_TRADE_INDEX_ROOT}/${username}/${TRADE_INDEX_META_KEY}`;
    const existingMeta = db.get(metaPath);
    if (!isTradeIndexMetaReady(existingMeta)) {
      unreadyPlayer.push(username);
    } else if (!tradeIndexMetaEqual(existingMeta, bucket.meta)) {
      stale.push(`${metaPath}`);
    } else {
      inSync += 1;
    }

    const existingDirect = _childMapFromNode(db.get(`${PLAYER_TRADE_INDEX_ROOT}/${username}/direct`));
    for (const [tradeId, entry] of bucket.direct) {
      const cur = existingDirect.get(tradeId);
      if (cur == null) {
        missing.push(`${PLAYER_TRADE_INDEX_ROOT}/${username}/direct/${tradeId}`);
      } else if (!directTradeIndexEntriesEqual(cur, entry)) {
        if (cur.offeringPlayerId !== entry.offeringPlayerId || cur.targetPlayerId !== entry.targetPlayerId) {
          wrongParticipant.push(`${PLAYER_TRADE_INDEX_ROOT}/${username}/direct/${tradeId}`);
        } else if (cur.status !== entry.status) {
          wrongStatus.push(`${PLAYER_TRADE_INDEX_ROOT}/${username}/direct/${tradeId}`);
        } else {
          stale.push(`${PLAYER_TRADE_INDEX_ROOT}/${username}/direct/${tradeId}`);
        }
      } else {
        inSync += 1;
      }
      existingDirect.delete(tradeId);
    }
    for (const tradeId of existingDirect.keys()) {
      orphaned.push(`${PLAYER_TRADE_INDEX_ROOT}/${username}/direct/${tradeId}`);
    }

    const existingListings = _childMapFromNode(db.get(`${PLAYER_TRADE_INDEX_ROOT}/${username}/listings`));
    for (const [listingId, entry] of bucket.listings) {
      const cur = existingListings.get(listingId);
      if (cur == null) {
        missing.push(`${PLAYER_TRADE_INDEX_ROOT}/${username}/listings/${listingId}`);
      } else if (!ownerListingIndexEntriesEqual(cur, entry)) {
        if (cur.status !== entry.status) {
          wrongStatus.push(`${PLAYER_TRADE_INDEX_ROOT}/${username}/listings/${listingId}`);
        } else {
          stale.push(`${PLAYER_TRADE_INDEX_ROOT}/${username}/listings/${listingId}`);
        }
      } else {
        inSync += 1;
      }
      existingListings.delete(listingId);
    }
    for (const listingId of existingListings.keys()) {
      orphaned.push(`${PLAYER_TRADE_INDEX_ROOT}/${username}/listings/${listingId}`);
    }

    existingPlayerKeys.delete(username);
  }

  for (const username of existingPlayerKeys) {
    orphaned.push(`${PLAYER_TRADE_INDEX_ROOT}/${username}`);
  }

  for (const [groupId, bucket] of desired.groups) {
    const metaPath = `${LISTINGS_BY_GROUP_ROOT}/${groupId}/${TRADE_INDEX_META_KEY}`;
    const existingMeta = db.get(metaPath);
    if (!isTradeIndexMetaReady(existingMeta)) {
      unreadyGroup.push(groupId);
    } else if (!tradeIndexMetaEqual(existingMeta, bucket.meta)) {
      stale.push(metaPath);
    } else {
      inSync += 1;
    }

    const existingListings = _childMapFromNode(db.get(`${LISTINGS_BY_GROUP_ROOT}/${groupId}`));
    for (const [listingId, entry] of bucket.listings) {
      const cur = existingListings.get(listingId);
      if (cur == null) {
        missing.push(`${LISTINGS_BY_GROUP_ROOT}/${groupId}/${listingId}`);
      } else if (!groupListingIndexEntriesEqual(cur, entry)) {
        if (cur.ownerId && entry.ownerId && cur.ownerId !== entry.ownerId) {
          wrongParticipant.push(`${LISTINGS_BY_GROUP_ROOT}/${groupId}/${listingId}`);
        } else if (cur.status !== entry.status) {
          wrongStatus.push(`${LISTINGS_BY_GROUP_ROOT}/${groupId}/${listingId}`);
        } else {
          stale.push(`${LISTINGS_BY_GROUP_ROOT}/${groupId}/${listingId}`);
        }
      } else {
        inSync += 1;
      }
      existingListings.delete(listingId);
    }
    for (const listingId of existingListings.keys()) {
      orphaned.push(`${LISTINGS_BY_GROUP_ROOT}/${groupId}/${listingId}`);
    }

    existingGroupKeys.delete(groupId);
  }

  for (const groupId of existingGroupKeys) {
    orphaned.push(`${LISTINGS_BY_GROUP_ROOT}/${groupId}`);
  }

  const globalVersion = db.get(`${TRADE_INDEX_META_ROOT}/schemaVersion`);
  const globalRebuiltAt = db.get(`${TRADE_INDEX_META_ROOT}/rebuiltAt`);
  const globalReady = Number(globalVersion) === CURRENT_TRADE_INDEX_SCHEMA_VERSION
    && globalRebuiltAt != null;

  return {
    schemaVersion: CURRENT_TRADE_INDEX_SCHEMA_VERSION,
    globalReady,
    playerCount: desired.players.size,
    groupCount: desired.groups.size,
    missing,
    stale,
    orphaned,
    wrongParticipant,
    wrongGroup,
    wrongStatus,
    unreadyPlayer,
    unreadyGroup,
    inSync,
    hasDrift:
      missing.length
      + stale.length
      + orphaned.length
      + wrongParticipant.length
      + wrongGroup.length
      + wrongStatus.length
      + unreadyPlayer.length
      + unreadyGroup.length
      > 0
      || !globalReady,
  };
}

/**
 * Admin repair: fresh gather → plan → commit (same as confirm path).
 * Prefer prepareTradeIndexRebuild + commitTradeIndexRebuildFresh for Admin UI.
 *
 * @param {{ timeoutMs?: number, now?: number }} [opts]
 */
export async function rebuildTradeIndexes(opts = {}) {
  return commitTradeIndexRebuildFresh(opts);
}

// ─── S5c-B: lifecycle path planners (single source of projection fields) ─────

/**
 * Warn once-ish when writing indexes for a player whose _meta is missing/old.
 * Does not block writes — S5c-B gameplay still uses canonical trees.
 * @param {string} username
 * @param {string} context
 */
export function warnIfPlayerTradeIndexUnready(username, context = '') {
  if (isPlayerTradeIndexReady(username)) return;
  console.warn(
    `[TradeIndex] Unready playerTradeIndex for "${username}" during ${context || 'mutation'}. ` +
      'Run Rebuild Trade Indexes. Gameplay still uses canonical trades.',
  );
}

/**
 * Set both participant direct leaves from a canonical-shaped trade object.
 * @param {object} trade - must include id + participant/card/status fields
 * @returns {Record<string, object>}
 */
export function directIndexUpdatesForTrade(trade) {
  const entry = buildDirectTradeIndexEntry(trade, trade?.id);
  if (!entry) return {};
  warnIfPlayerTradeIndexUnready(entry.offeringPlayerId, 'directIndexUpdates');
  warnIfPlayerTradeIndexUnready(entry.targetPlayerId, 'directIndexUpdates');
  return {
    [`${PLAYER_TRADE_INDEX_ROOT}/${entry.offeringPlayerId}/direct/${entry.id}`]: entry,
    [`${PLAYER_TRADE_INDEX_ROOT}/${entry.targetPlayerId}/direct/${entry.id}`]: entry,
  };
}

/**
 * Remove both participant direct leaves.
 * @param {object} trade
 * @returns {Record<string, null>}
 */
export function directIndexRemovalsForTrade(trade) {
  const id = trade?.id != null ? String(trade.id) : '';
  const offerer = trade?.offeringPlayerId != null ? String(trade.offeringPlayerId) : '';
  const target = trade?.targetPlayerId != null ? String(trade.targetPlayerId) : '';
  /** @type {Record<string, null>} */
  const updates = {};
  if (offerer && id) updates[`${PLAYER_TRADE_INDEX_ROOT}/${offerer}/direct/${id}`] = null;
  if (target && id) updates[`${PLAYER_TRADE_INDEX_ROOT}/${target}/direct/${id}`] = null;
  return updates;
}

/**
 * Owner + group listing projections for an active (browsable) listing.
 * @param {object} listing
 * @param {number} [now]
 * @returns {Record<string, object>}
 */
export function listingIndexUpdatesForListing(listing, now = Date.now()) {
  /** @type {Record<string, object>} */
  const updates = {};
  const ownerEntry = buildOwnerListingIndexEntry(listing, listing?.id, now);
  if (ownerEntry && listing?.ownerId) {
    warnIfPlayerTradeIndexUnready(String(listing.ownerId), 'listingIndexUpdates');
    updates[`${PLAYER_TRADE_INDEX_ROOT}/${listing.ownerId}/listings/${ownerEntry.id}`] = ownerEntry;
  }
  const groupEntry = buildGroupListingIndexEntry(listing, listing?.id, now);
  if (groupEntry && listing?.groupId) {
    if (!isGroupListingsIndexReady(String(listing.groupId))) {
      console.warn(
        `[TradeIndex] Unready listingsByGroup for "${listing.groupId}". Run Rebuild Trade Indexes.`,
      );
    }
    updates[`${LISTINGS_BY_GROUP_ROOT}/${listing.groupId}/${groupEntry.id}`] = groupEntry;
  }
  return updates;
}

/**
 * Remove owner + group listing projections.
 * @param {object} listing
 * @returns {Record<string, null>}
 */
export function listingIndexRemovalsForListing(listing) {
  const id = listing?.id != null ? String(listing.id) : '';
  /** @type {Record<string, null>} */
  const updates = {};
  if (listing?.ownerId && id) {
    updates[`${PLAYER_TRADE_INDEX_ROOT}/${listing.ownerId}/listings/${id}`] = null;
  }
  if (listing?.groupId && id) {
    updates[`${LISTINGS_BY_GROUP_ROOT}/${listing.groupId}/${id}`] = null;
  }
  return updates;
}

/**
 * After successful direct claim: both participant PTI leaves → status processing.
 * Leaves stay in place (reservations preserved).
 * @param {object} trade - canonical trade after claim (status processing)
 * @returns {Record<string, object>}
 */
export function directClaimIndexTransitionPaths(trade) {
  const processing = { ...trade, status: 'processing' };
  return directIndexUpdatesForTrade(processing);
}

/**
 * After release back to awaiting_offerer_confirmation: rewrite both PTI leaves.
 * @param {object} trade - canonical trade after release
 * @returns {Record<string, object>}
 */
export function directReleaseIndexRestorePaths(trade) {
  const awaiting = { ...trade, status: 'awaiting_offerer_confirmation' };
  return directIndexUpdatesForTrade(awaiting);
}

/**
 * After successful canonical claim: owner leaf → processing, group leaf removed.
 * @param {object} listing - canonical listing after claim (status processing)
 * @param {number} [now]
 * @returns {Record<string, object|null>}
 */
export function listingClaimIndexTransitionPaths(listing, now = Date.now()) {
  const processing = { ...listing, status: 'processing' };
  const ownerEntry = buildOwnerListingIndexEntry(processing, listing?.id, now);
  /** @type {Record<string, object|null>} */
  const updates = {};
  if (ownerEntry && listing?.ownerId) {
    warnIfPlayerTradeIndexUnready(String(listing.ownerId), 'listingClaimIndexTransition');
    updates[`${PLAYER_TRADE_INDEX_ROOT}/${listing.ownerId}/listings/${ownerEntry.id}`] = ownerEntry;
  }
  if (listing?.groupId && listing?.id) {
    updates[`${LISTINGS_BY_GROUP_ROOT}/${listing.groupId}/${listing.id}`] = null;
  }
  return updates;
}

/**
 * After ownership-safe release back to active: restore owner + group projections.
 * @param {object} listing - canonical listing after release (status active)
 * @param {number} [now]
 * @returns {Record<string, object>}
 */
export function listingReleaseIndexRestorePaths(listing, now = Date.now()) {
  const active = { ...listing, status: 'active' };
  return listingIndexUpdatesForListing(active, now);
}

/**
 * Build multi-path updates that terminalize a deleted player's open trades/listings
 * and clear related index leaves. Does not include players/ directory nulls.
 *
 * Avoids overlapping paths: deleted user's index is cleared via one whole-tree null;
 * counterpart direct leaves and group listing leaves are nulled individually.
 *
 * @param {string} playerKey
 * @param {number} [now]
 * @returns {Record<string, object|null>}
 */
export function buildPlayerDeleteTradeCleanupUpdates(playerKey, now = Date.now()) {
  const key = String(playerKey || '').trim();
  if (!key) return {};
  /** @type {Record<string, object|null>} */
  const updates = {};

  const allDirect = db.get('trades/direct') || {};
  for (const [tradeId, trade] of Object.entries(allDirect)) {
    if (!trade || typeof trade !== 'object') continue;
    const involves =
      trade.offeringPlayerId === key || trade.targetPlayerId === key;
    if (!involves) continue;
    if (!INDEXED_DIRECT_STATUSES.has(trade.status)) continue;

    const id = trade.id || tradeId;
    updates[`trades/direct/${id}/status`] = 'cancelled';
    updates[`trades/direct/${id}/completedAt`] = now;
    updates[`trades/direct/${id}/respondedAt`] = trade.respondedAt != null ? trade.respondedAt : now;
    updates[`trades/direct/${id}/cancellationReason`] = 'player_deleted';

    // S8c-1: clear claim-scoped grant when cancelling a processing direct involving this player
    if (trade.status === 'processing' && trade.claimerAuthUid && trade.targetPlayerId) {
      updates[`tradeGrants/${trade.targetPlayerId}/${trade.claimerAuthUid}`] = null;
    }

    const other =
      trade.offeringPlayerId === key
        ? trade.targetPlayerId
        : trade.offeringPlayerId;
    if (other && id) {
      updates[`${PLAYER_TRADE_INDEX_ROOT}/${other}/direct/${id}`] = null;
    }
  }

  const allListings = db.get('trades/listings') || {};
  for (const [listingId, listing] of Object.entries(allListings)) {
    if (!listing || listing.ownerId !== key) continue;
    if (listing.status !== 'active' && listing.status !== 'processing') continue;
    const id = listing.id || listingId;
    updates[`trades/listings/${id}/status`] = 'cancelled';
    updates[`trades/listings/${id}/respondedAt`] = now;
    updates[`trades/listings/${id}/cancellationReason`] = 'player_deleted';
    updates[`trades/listings/${id}/processingBy`] = null;
    updates[`trades/listings/${id}/processingAt`] = null;
    updates[`trades/listings/${id}/claimId`] = null;
    updates[`trades/listings/${id}/claimerAuthUid`] = null;
    updates[`trades/listings/${id}/fulfilledCardId`] = null;
    if (listing.status === 'processing' && listing.claimerAuthUid) {
      updates[`tradeGrants/${key}/${listing.claimerAuthUid}`] = null;
    }
    if (listing.groupId && id) {
      updates[`${LISTINGS_BY_GROUP_ROOT}/${listing.groupId}/${id}`] = null;
    }
  }

  // Whole-tree null covers deleted user's direct + listings + _meta
  updates[`${PLAYER_TRADE_INDEX_ROOT}/${key}`] = null;
  return updates;
}

/**
 * List processing listings owned by player that still need claim release before delete.
 * @param {string} playerKey
 * @returns {{ listingId: string, claimId: string }[]}
 */
export function listOwnedProcessingListingClaims(playerKey) {
  const key = String(playerKey || '').trim();
  const out = [];
  if (!key) return out;
  const allListings = db.get('trades/listings') || {};
  for (const [listingId, listing] of Object.entries(allListings)) {
    if (!listing || listing.ownerId !== key) continue;
    if (listing.status !== 'processing') continue;
    if (!listing.claimId) continue;
    out.push({ listingId: listing.id || listingId, claimId: String(listing.claimId) });
  }
  return out;
}

function _indexMapsForPlayer(username) {
  const direct = {};
  const listings = {};
  const directNode = db.get(`${PLAYER_TRADE_INDEX_ROOT}/${username}/direct`) || {};
  const listingNode = db.get(`${PLAYER_TRADE_INDEX_ROOT}/${username}/listings`) || {};
  for (const [id, entry] of Object.entries(directNode)) {
    if (id === TRADE_INDEX_META_KEY || !entry || typeof entry !== 'object') continue;
    direct[id] = entry;
  }
  for (const [id, entry] of Object.entries(listingNode)) {
    if (id === TRADE_INDEX_META_KEY || !entry || typeof entry !== 'object') continue;
    listings[id] = entry;
  }
  return { direct, listings };
}

function _countsToObject(map) {
  /** @type {Record<string, { outgoing: number, listing: number, incoming: number, total: number }>} */
  const obj = {};
  if (!map) return obj;
  for (const [cardId, b] of map.entries()) {
    obj[cardId] = {
      outgoing: b.outgoing || 0,
      listing: b.listing || 0,
      incoming: b.incoming || 0,
      total: (b.outgoing || 0) + (b.listing || 0) + (b.incoming || 0),
    };
  }
  return obj;
}

function _activeIdsFromMaps(directMap, listingMap) {
  return {
    direct: Object.keys(directMap || {}),
    listings: Object.keys(listingMap || {}),
  };
}

/**
 * Dev/admin: compare reservation tallies from canonical trees vs playerTradeIndex.
 * No Firebase writes. Does not change gameplay.
 * @param {string} username
 */
export function shadowCompare(username) {
  const key = String(username || '').trim();
  const indexReady = isPlayerTradeIndexReady(key);
  const canonicalDirect = db.get('trades/direct') || {};
  const canonicalListings = db.get('trades/listings') || {};
  const canonicalAvailable =
    canonicalDirect != null && typeof canonicalDirect === 'object'
    && canonicalListings != null && typeof canonicalListings === 'object';

  const canonicalCountsMap = buildTradeReservationCounts(key, {
    directTrades: canonicalDirect,
    listings: canonicalListings,
  });
  const canonicalCounts = _countsToObject(canonicalCountsMap);

  let indexCounts = null;
  let indexActiveIds = { direct: [], listings: [] };
  if (indexReady) {
    const maps = _indexMapsForPlayer(key);
    indexActiveIds = _activeIdsFromMaps(maps.direct, maps.listings);
    // Owner-listing projections omit ownerId (path implies ownership). Inject for
    // comparison-only so buildTradeReservationCounts' ownerId === username check works.
    const listingsForCompare = {};
    for (const [id, entry] of Object.entries(maps.listings)) {
      listingsForCompare[id] = { ...entry, ownerId: key };
    }
    indexCounts = _countsToObject(
      buildTradeReservationCounts(key, {
        directTrades: maps.direct,
        listings: listingsForCompare,
      }),
    );
  }

  const diffs = [];
  if (!indexReady) {
    diffs.push({ type: 'index_unready', cardId: null, detail: 'playerTradeIndex _meta not ready' });
  } else {
    const allCards = new Set([
      ...Object.keys(canonicalCounts),
      ...Object.keys(indexCounts || {}),
    ]);
    for (const cardId of allCards) {
      const c = canonicalCounts[cardId] || { outgoing: 0, listing: 0, incoming: 0, total: 0 };
      const i = (indexCounts && indexCounts[cardId]) || { outgoing: 0, listing: 0, incoming: 0, total: 0 };
      if (c.outgoing !== i.outgoing || c.listing !== i.listing || c.incoming !== i.incoming) {
        diffs.push({
          type: 'count_mismatch',
          cardId,
          canonical: c,
          index: i,
        });
      }
    }
  }

  const match = indexReady && diffs.length === 0;

  // Canonical active ids involving this user (for diagnostics)
  const canonicalActiveIds = { direct: [], listings: [] };
  for (const [id, t] of Object.entries(canonicalDirect)) {
    if (!t || !INDEXED_DIRECT_STATUSES.has(t.status)) continue;
    if (t.offeringPlayerId === key || t.targetPlayerId === key) {
      canonicalActiveIds.direct.push(t.id || id);
    }
  }
  for (const [id, l] of Object.entries(canonicalListings)) {
    if (!l || l.ownerId !== key) continue;
    if (l.status !== 'active' && l.status !== 'processing') continue;
    if (l.expiresAt && Date.now() > Number(l.expiresAt)) continue;
    canonicalActiveIds.listings.push(l.id || id);
  }

  const report = {
    username: key,
    indexReady,
    canonicalAvailable,
    match,
    canonicalCounts,
    indexCounts,
    diffs,
    canonicalActiveIds,
    indexActiveIds,
  };

  if (!match) {
    console.warn('[TradeIndex] shadowCompare mismatch', {
      username: key,
      indexReady,
      diffCount: diffs.length,
      diffs: diffs.map((d) => ({ type: d.type, cardId: d.cardId || null })),
    });
    if (typeof metrics.recordTradeIndexLifecycle === 'function') {
      metrics.recordTradeIndexLifecycle({
        tag: 'trade-index-shadow-mismatch',
        ops: 0,
        ok: false,
        username: key,
      });
    }
  }

  return report;
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcTradeIndex = {
    CURRENT_TRADE_INDEX_SCHEMA_VERSION,
    TRADE_INDEX_META_ROOT,
    PLAYER_TRADE_INDEX_ROOT,
    LISTINGS_BY_GROUP_ROOT,
    TRADE_INDEX_REBUILD_ALLOWED_PREFIXES,
    buildTradeIndexMeta,
    isTradeIndexMetaReady,
    isGlobalTradeIndexMetaCurrent,
    isPlayerTradeIndexReady,
    isGroupListingsIndexReady,
    getReservationIndexSource,
    canAllowCanonicalTradeTreeFallback,
    getTradeIndexDriftReport,
    deriveDesiredTradeIndexes,
    buildTradeIndexRebuildPlan,
    assertTradeIndexRebuildPathsAllowed,
    gatherTradeIndexRebuildSnapshots,
    prepareTradeIndexRebuild,
    commitTradeIndexRebuildFresh,
    commitTradeIndexRebuildPlan,
    rebuildTradeIndexes,
    directIndexUpdatesForTrade,
    directIndexRemovalsForTrade,
    directClaimIndexTransitionPaths,
    directReleaseIndexRestorePaths,
    listingIndexUpdatesForListing,
    listingIndexRemovalsForListing,
    listingClaimIndexTransitionPaths,
    listingReleaseIndexRestorePaths,
    buildPlayerDeleteTradeCleanupUpdates,
    shadowCompare,
    help() {
      console.info(`Trade Index (S5c + S8d-4b safe rebuild)
Roots: ${PLAYER_TRADE_INDEX_ROOT}, ${LISTINGS_BY_GROUP_ROOT}, ${TRADE_INDEX_META_ROOT}
Safe rebuild: prepareTradeIndexRebuild() → confirm → commitTradeIndexRebuildFresh()
  (Confirm RE-GATHERS; never commits stale preview plan)
API: getTradeIndexDriftReport (cache diagnostic) | rebuildTradeIndexes
S5c-B: lifecycle dual-writes keep indexes current; consumers still read canonical trades.
Safety: unready index must never mean zero reservations.`);
    },
  };
}

_installWindowApi();
