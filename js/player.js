/**
 * Player Module - Player profiles, inventories, statistics
 */

import * as db from './database.js';
import * as metrics from './db-metrics.js';
import { notifyCardInventoryChanged, recordCardCollectionGain } from './achievements.js';
import {
  resolvePlayerDirectoryKey,
  syncDirectoryUpdateFromPlayer,
} from './player-directory.js';
import {
  buildPlayerDeleteTradeCleanupUpdates,
  listOwnedProcessingListingClaims,
  PLAYER_TRADE_INDEX_ROOT,
} from './trade-index.js';
import { TRADE_GRANTS_ROOT, clearTradeGrant } from './trade-grants.js';
import {
  buildLeaderboardGroupProjectionPaths,
  buildLeaderboardSummaryDeletePaths,
} from './leaderboard-summaries.js';
import {
  preparePlayerDeleteLifecycle,
  buildAuthLifecycleDeleteUpdates,
} from './auth-rotation.js';
import { getAuth } from './firebase-config.js';
import {
  buildPlayerHistoryLeafUpdate,
  HISTORY_EVENT_TYPES,
  HISTORY_ACTOR_TYPES,
  HISTORY_SOURCES,
} from './player-history.js';
import {
  buildPlayerHistoryTreeDeleteUpdate,
  scheduleHistoryRetentionAfterWrite,
} from './player-history-retention.js';

/**
 * Create a new player profile
 */
export function createPlayer(username, groupId = null) {
  const player = {
    username,
    created: Date.now(),
    lastLogin: Date.now(),
    groupId: groupId || null,
    subgroupId: null,
    inventory: {},       // cardId -> quantity
    packs: {},           // packId -> quantity
    stats: {
      packsOpened: 0,
      cardsCollected: 0,
      tradesCompleted: 0,
      projectsCompleted: 0
    },
    badges: {},
    achievements: {},
    progression: {
      tutorialComplete: false,
      firstPackOpened: false,
      firstTrade: false
    },
    totalResearchPoints: 0,
    seasonalResearchPoints: 0,
    researchStats: {
      totalProjects: 0,
      successfulProjects: 0,
      failedProjects: 0,
      breakthroughs: 0,
      highestTierCompleted: null
    }
  };
  db.set(`players/${username}`, player);
  return player;
}

/**
 * Get player data
 */
export function getPlayer(username) {
  return db.get(`players/${username}`);
}

/**
 * Update player data (shallow merge)
 */
export function updatePlayer(username, updates) {
  db.update(`players/${username}`, updates);
}

/**
 * Get player inventory as array of { cardId, quantity }.
 * Canonical ownership: only Number(quantity) > 0 (missing leaf ≡ quantity 0 ≡ not owned).
 */
export function getInventory(username) {
  const inv = db.get(`players/${username}/inventory`) || {};
  return Object.entries(inv)
    .filter(([, quantity]) => typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0)
    .map(([cardId, quantity]) => ({ cardId, quantity }));
}

/**
 * Coerce mutation quantity to a positive integer (no silent default).
 * Accepts numeric strings without concatenation risk.
 * @param {unknown} raw
 * @returns {{ ok: true, quantity: number } | { ok: false, error: string }}
 */
export function coercePositiveIntegerQuantity(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = Math.trunc(raw);
    if (n >= 1) return { ok: true, quantity: n };
    return { ok: false, error: 'Quantity must be a positive integer.' };
  }
  const n = parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n < 1) {
    return { ok: false, error: 'Quantity must be a positive integer.' };
  }
  return { ok: true, quantity: n };
}

/**
 * Read a stored count as a non-negative integer (invalid → 0).
 * @param {unknown} raw
 * @returns {number}
 */
export function readNonNegativeIntCount(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, Math.trunc(raw));
  }
  const n = parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Pure pack-add next-quantity planner (prevents "5"+"5"→"55").
 * @param {unknown} currentRaw
 * @param {unknown} quantityRaw
 */
export function computePackQuantityAfterAdd(currentRaw, quantityRaw) {
  const qty = coercePositiveIntegerQuantity(quantityRaw);
  if (!qty.ok) return qty;
  const current = readNonNegativeIntCount(currentRaw);
  return {
    ok: true,
    current,
    quantity: qty.quantity,
    next: current + qty.quantity,
  };
}

/**
 * Pure pack-remove planner.
 * @param {unknown} currentRaw
 * @param {unknown} quantityRaw
 */
export function computePackQuantityAfterRemove(currentRaw, quantityRaw) {
  const qty = coercePositiveIntegerQuantity(quantityRaw);
  if (!qty.ok) return qty;
  const current = readNonNegativeIntCount(currentRaw);
  if (current < qty.quantity) {
    return {
      ok: false,
      error: 'Cannot remove more packs than owned.',
      current,
      quantity: qty.quantity,
    };
  }
  const next = current - qty.quantity;
  return {
    ok: true,
    current,
    quantity: qty.quantity,
    next,
    removeLeaf: next <= 0,
  };
}

/**
 * Add card(s) to player inventory
 */
export function addCard(username, cardId, quantity = 1) {
  const qty = coercePositiveIntegerQuantity(quantity);
  if (!qty.ok) return;
  const current = readNonNegativeIntCount(db.get(`players/${username}/inventory/${cardId}`));
  const next = current + qty.quantity;
  db.set(`players/${username}/inventory/${cardId}`, next);

  // Update stats
  const stats = db.get(`players/${username}/stats`) || {};
  stats.cardsCollected = readNonNegativeIntCount(stats.cardsCollected) + qty.quantity;
  db.set(`players/${username}/stats`, stats);

  recordCardCollectionGain(username, cardId, current, next);
}

/**
 * Remove card(s) from player inventory
 * Returns true if successful, false if insufficient / invalid qty
 */
export function removeCard(username, cardId, quantity = 1) {
  const qty = coercePositiveIntegerQuantity(quantity);
  if (!qty.ok) return false;
  const current = readNonNegativeIntCount(db.get(`players/${username}/inventory/${cardId}`));
  if (current < qty.quantity) return false;

  if (current - qty.quantity <= 0) {
    db.remove(`players/${username}/inventory/${cardId}`);
  } else {
    db.set(`players/${username}/inventory/${cardId}`, current - qty.quantity);
  }

  notifyCardInventoryChanged(username);
  return true;
}

/**
 * Add pack(s) to player. Returns false if quantity invalid (no write).
 * @returns {boolean}
 */
export function addPack(username, packId, quantity = 1) {
  const plan = computePackQuantityAfterAdd(
    db.get(`players/${username}/packs/${packId}`),
    quantity,
  );
  if (!plan.ok) return false;
  db.set(`players/${username}/packs/${packId}`, plan.next);
  return true;
}

/**
 * Parse pack grant quantity the same way Admin Player Details does.
 * @param {unknown} raw
 * @returns {number} integer >= 1
 */
export function parseAdminPackGrantQuantity(raw) {
  const qty = parseInt(raw, 10);
  return Number.isFinite(qty) && qty >= 1 ? qty : 1;
}

async function _resolveAdminActorMeta() {
  let actorUid = null;
  let actorUsername = null;
  try {
    actorUid = getAuth().currentUser?.uid || null;
  } catch { /* ignore */ }
  try {
    const authMod = await import('./auth.js');
    actorUsername = authMod.getCurrentUsername?.() || null;
    if (actorUsername === '__admin__') actorUsername = null;
  } catch { /* ignore */ }
  return { actorUid, actorUsername };
}

/**
 * Pure/planner: Admin pack grant + history leaf (no write).
 */
export function buildAdminPackGrantPlan(username, packId, quantity, actorMeta = {}) {
  const key = String(username || '').trim();
  const id = String(packId || '').trim();
  if (!key) return { ok: false, error: 'Player identity missing.' };
  if (!id) return { ok: false, error: 'Select a pack type.' };
  const qtyPlan = computePackQuantityAfterAdd(
    db.get(`players/${key}/packs/${id}`),
    quantity,
  );
  if (!qtyPlan.ok) return { ok: false, error: qtyPlan.error || 'Invalid quantity.' };

  const history = buildPlayerHistoryLeafUpdate(key, {
    type: HISTORY_EVENT_TYPES.PACK_GRANTED,
    actorType: HISTORY_ACTOR_TYPES.ADMIN,
    source: HISTORY_SOURCES.ADMIN_GRANT_PACKS,
    actorUid: actorMeta.actorUid || null,
    actorUsername: actorMeta.actorUsername || null,
    payload: {
      packId: id,
      quantity: qtyPlan.quantity,
      before: qtyPlan.current,
      after: qtyPlan.next,
    },
  });

  return {
    ok: true,
    username: key,
    packId: id,
    quantity: qtyPlan.quantity,
    before: qtyPlan.current,
    after: qtyPlan.next,
    historyEventId: history.eventId,
    updates: {
      [`players/${key}/packs/${id}`]: qtyPlan.next,
      ...history.updates,
    },
  };
}

/**
 * Canonical Admin pack grant (Player Details + Quick Give Packs) — atomic + history.
 * @returns {Promise<object>}
 */
export async function adminGrantPacks(username, packId, quantityRaw) {
  const quantity = parseAdminPackGrantQuantity(quantityRaw);
  const actorMeta = await _resolveAdminActorMeta();
  const plan = buildAdminPackGrantPlan(username, packId, quantity, actorMeta);
  if (!plan.ok) return plan;
  const ack = await db.updateAcknowledged(plan.updates);
  if (!ack.ok) {
    return { ok: false, error: ack.error || 'Could not grant packs.', mode: ack.mode };
  }
  scheduleHistoryRetentionAfterWrite(plan.updates);
  return {
    ok: true,
    username: plan.username,
    packId: plan.packId,
    quantity: plan.quantity,
    before: plan.before,
    after: plan.after,
    historyEventId: plan.historyEventId,
    mode: ack.mode,
  };
}

/**
 * Pure/planner: Admin pack remove + history.
 */
export function buildAdminPackRemovePlan(username, packId, quantity, actorMeta = {}) {
  const key = String(username || '').trim();
  const id = String(packId || '').trim();
  if (!key) return { ok: false, error: 'Player identity missing.' };
  if (!id) return { ok: false, error: 'Select a pack type.' };
  const qtyPlan = computePackQuantityAfterRemove(
    db.get(`players/${key}/packs/${id}`),
    quantity,
  );
  if (!qtyPlan.ok) {
    return {
      ok: false,
      error: qtyPlan.error || 'Could not remove packs.',
      current: qtyPlan.current,
    };
  }

  const history = buildPlayerHistoryLeafUpdate(key, {
    type: HISTORY_EVENT_TYPES.PACK_REMOVED,
    actorType: HISTORY_ACTOR_TYPES.ADMIN,
    source: HISTORY_SOURCES.ADMIN_REMOVE_PACKS,
    actorUid: actorMeta.actorUid || null,
    actorUsername: actorMeta.actorUsername || null,
    payload: {
      packId: id,
      quantity: qtyPlan.quantity,
      before: qtyPlan.current,
      after: qtyPlan.next,
    },
  });

  return {
    ok: true,
    username: key,
    packId: id,
    removed: qtyPlan.quantity,
    remaining: qtyPlan.next,
    before: qtyPlan.current,
    after: qtyPlan.next,
    historyEventId: history.eventId,
    updates: {
      [`players/${key}/packs/${id}`]: qtyPlan.removeLeaf ? null : qtyPlan.next,
      ...history.updates,
    },
  };
}

/**
 * Canonical Admin pack removal — atomic + history. Does not touch packsOpened.
 */
export async function adminRemovePacks(username, packId, quantityRaw) {
  const qty = coercePositiveIntegerQuantity(quantityRaw);
  if (!qty.ok) return { ok: false, error: qty.error };
  const actorMeta = await _resolveAdminActorMeta();
  const plan = buildAdminPackRemovePlan(username, packId, qty.quantity, actorMeta);
  if (!plan.ok) return plan;
  const ack = await db.updateAcknowledged(plan.updates);
  if (!ack.ok) {
    return { ok: false, error: ack.error || 'Could not remove packs.', mode: ack.mode };
  }
  scheduleHistoryRetentionAfterWrite(plan.updates);
  return {
    ok: true,
    username: plan.username,
    packId: plan.packId,
    removed: plan.removed,
    remaining: plan.remaining,
    before: plan.before,
    after: plan.after,
    historyEventId: plan.historyEventId,
    mode: ack.mode,
  };
}

/**
 * Pure/planner: Admin card grant + history (inventory + cardsCollected leaf).
 * Derived unique/aura refreshed after ack via recordCardCollectionGain.
 */
export function buildAdminCardGrantPlan(username, cardId, quantity, actorMeta = {}) {
  const key = String(username || '').trim();
  const id = String(cardId || '').trim();
  if (!key) return { ok: false, error: 'Player identity missing.' };
  if (!id) return { ok: false, error: 'Select a card.' };
  const qty = coercePositiveIntegerQuantity(quantity);
  if (!qty.ok) return { ok: false, error: qty.error };

  const before = readNonNegativeIntCount(db.get(`players/${key}/inventory/${id}`));
  const after = before + qty.quantity;
  const prevCollected = readNonNegativeIntCount(db.get(`players/${key}/stats/cardsCollected`));

  const history = buildPlayerHistoryLeafUpdate(key, {
    type: HISTORY_EVENT_TYPES.CARD_GRANTED,
    actorType: HISTORY_ACTOR_TYPES.ADMIN,
    source: HISTORY_SOURCES.ADMIN_GRANT_CARDS,
    actorUid: actorMeta.actorUid || null,
    actorUsername: actorMeta.actorUsername || null,
    payload: {
      cardId: id,
      quantity: qty.quantity,
      before,
      after,
    },
  });

  return {
    ok: true,
    username: key,
    cardId: id,
    quantity: qty.quantity,
    before,
    after,
    historyEventId: history.eventId,
    updates: {
      [`players/${key}/inventory/${id}`]: after,
      [`players/${key}/stats/cardsCollected`]: prevCollected + qty.quantity,
      ...history.updates,
    },
  };
}

/**
 * Canonical Admin card grant — atomic + history.
 */
export async function adminGrantCards(username, cardId, quantity = 1) {
  const actorMeta = await _resolveAdminActorMeta();
  const plan = buildAdminCardGrantPlan(username, cardId, quantity, actorMeta);
  if (!plan.ok) return plan;
  const ack = await db.updateAcknowledged(plan.updates);
  if (!ack.ok) {
    return { ok: false, error: ack.error || 'Could not grant cards.', mode: ack.mode };
  }
  recordCardCollectionGain(plan.username, plan.cardId, plan.before, plan.after);
  scheduleHistoryRetentionAfterWrite(plan.updates);
  return {
    ok: true,
    username: plan.username,
    cardId: plan.cardId,
    quantity: plan.quantity,
    before: plan.before,
    after: plan.after,
    historyEventId: plan.historyEventId,
    mode: ack.mode,
  };
}

/**
 * Pure/planner: Admin card remove + history. Does not touch cardsCollected/discovery.
 */
export function buildAdminCardRemovePlan(username, cardId, quantity, actorMeta = {}) {
  const key = String(username || '').trim();
  const id = String(cardId || '').trim();
  if (!key) return { ok: false, error: 'Player identity missing.' };
  if (!id) return { ok: false, error: 'Select a card.' };
  const qty = coercePositiveIntegerQuantity(quantity);
  if (!qty.ok) return { ok: false, error: qty.error };

  const before = readNonNegativeIntCount(db.get(`players/${key}/inventory/${id}`));
  if (before < qty.quantity) {
    return { ok: false, error: 'Cannot remove more cards than owned.', current: before };
  }
  const after = before - qty.quantity;

  const history = buildPlayerHistoryLeafUpdate(key, {
    type: HISTORY_EVENT_TYPES.CARD_REMOVED,
    actorType: HISTORY_ACTOR_TYPES.ADMIN,
    source: HISTORY_SOURCES.ADMIN_REMOVE_CARDS,
    actorUid: actorMeta.actorUid || null,
    actorUsername: actorMeta.actorUsername || null,
    payload: {
      cardId: id,
      quantity: qty.quantity,
      before,
      after,
    },
  });

  return {
    ok: true,
    username: key,
    cardId: id,
    quantity: qty.quantity,
    before,
    after,
    historyEventId: history.eventId,
    updates: {
      [`players/${key}/inventory/${id}`]: after <= 0 ? null : after,
      ...history.updates,
    },
  };
}

/**
 * Canonical Admin card remove — atomic + history.
 */
export async function adminRemoveCards(username, cardId, quantity = 1) {
  const actorMeta = await _resolveAdminActorMeta();
  const plan = buildAdminCardRemovePlan(username, cardId, quantity, actorMeta);
  if (!plan.ok) return plan;
  const ack = await db.updateAcknowledged(plan.updates);
  if (!ack.ok) {
    return { ok: false, error: ack.error || 'Could not remove cards.', mode: ack.mode };
  }
  notifyCardInventoryChanged(plan.username);
  scheduleHistoryRetentionAfterWrite(plan.updates);
  return {
    ok: true,
    username: plan.username,
    cardId: plan.cardId,
    quantity: plan.quantity,
    before: plan.before,
    after: plan.after,
    historyEventId: plan.historyEventId,
    mode: ack.mode,
  };
}

/**
 * Remove unopened pack(s). Does not touch packsOpened.
 * System/gameplay helper (no Admin history). Prefer adminRemovePacks for Admin UI.
 */
export function removePack(username, packId, quantity = 1) {
  const key = String(username || '').trim();
  const id = String(packId || '').trim();
  if (!key) return { ok: false, error: 'Player identity missing.' };
  if (!id) return { ok: false, error: 'Pack type missing.' };

  const plan = computePackQuantityAfterRemove(
    db.get(`players/${key}/packs/${id}`),
    quantity,
  );
  if (!plan.ok) {
    return {
      ok: false,
      error: plan.error || 'Could not remove packs.',
      current: plan.current,
    };
  }

  if (plan.removeLeaf) {
    db.remove(`players/${key}/packs/${id}`);
  } else {
    db.set(`players/${key}/packs/${id}`, plan.next);
  }

  return {
    ok: true,
    username: key,
    packId: id,
    removed: plan.quantity,
    remaining: plan.next,
  };
}

/**
 * Get player's packs
 */
export function getPlayerPacks(username) {
  return db.get(`players/${username}/packs`) || {};
}

/**
 * Get all players
 */
export function getAllPlayers() {
  return db.getChildren('players');
}

/**
 * Set player group and optional subgroup (canonical + directory, one ack).
 * @param {string} username
 * @param {string|null} groupId
 * @param {string|null} subgroupId
 * @returns {Promise<{ ok: boolean, mode?: string, error?: string }>}
 */
export async function setPlayerGroup(username, groupId, subgroupId = null) {
  const playerKey = resolvePlayerDirectoryKey(username);
  const playerData = db.get(`players/${playerKey}`) || {};
  const nextGroupId = groupId || null;
  const nextSubgroupId = subgroupId || null;
  return db.updateAcknowledged({
    [`players/${playerKey}/groupId`]: nextGroupId,
    [`players/${playerKey}/subgroupId`]: nextSubgroupId,
    ...syncDirectoryUpdateFromPlayer(playerKey, {
      ...playerData,
      groupId: nextGroupId,
      subgroupId: nextSubgroupId,
    }),
    ...buildLeaderboardGroupProjectionPaths(playerKey, {
      ...playerData,
      groupId: nextGroupId,
      subgroupId: nextSubgroupId,
    }),
  });
}

/**
 * Increment a stat
 */
export function incrementStat(username, statKey, amount = 1) {
  const stats = db.get(`players/${username}/stats`) || {};
  stats[statKey] = (stats[statKey] || 0) + amount;
  db.set(`players/${username}/stats`, stats);
}

/**
 * Delete a player: terminalize open trades/listings as cancelled, clear indexes,
 * remove player + directory + authDirectory. Processing listings are claim-released
 * first when possible. Browser does NOT delete Firebase Auth users (orphans OK).
 * v1: refuse self, Admin targets, __admin__; require authDirectory/player UID match.
 * @param {string} username
 * @returns {Promise<{ ok: boolean, mode?: string, error?: string, code?: string, claimReleases?: number }>}
 */
export async function deletePlayer(username) {
  const playerKey = resolvePlayerDirectoryKey(username);
  if (!playerKey) {
    return { ok: false, error: 'Invalid username', code: 'INVALID_USERNAME' };
  }

  const lifecycle = await preparePlayerDeleteLifecycle({ username: playerKey });
  if (!lifecycle.ok) {
    return {
      ok: false,
      error: lifecycle.error || 'Delete precheck failed',
      code: lifecycle.code,
    };
  }

  let claimReleases = 0;
  const processingClaims = listOwnedProcessingListingClaims(playerKey);
  for (const { listingId, claimId } of processingClaims) {
    const listing = db.get(`trades/listings/${listingId}`);
    const grantUid = listing?.claimerAuthUid || null;
    const release = await db.releaseListingClaimIfOwned(listingId, claimId);
    if (release.ok && release.released) {
      claimReleases += 1;
      // S8c-1: clear grant tied to this processing claim (owner = deleted player)
      if (grantUid) {
        await clearTradeGrant(playerKey, grantUid);
      }
    } else {
      console.warn(
        `[Player] Could not release processing claim on listing ${listingId} before delete; ` +
          'continuing with cancel+clear in multi-path.',
        release.error,
      );
    }
  }

  const now = Date.now();
  const tradeCleanup = buildPlayerDeleteTradeCleanupUpdates(playerKey, now);
  // tradeCleanup already nulls playerTradeIndex/{key}; avoid overlapping with directory/player
  const updates = {
    ...tradeCleanup,
    [`players/${playerKey}`]: null,
    [`playerDirectory/${playerKey}`]: null,
    // S8c-1: drop any grants targeting this player
    [`${TRADE_GRANTS_ROOT}/${playerKey}`]: null,
    ...buildLeaderboardSummaryDeletePaths(playerKey),
    // Pass 3: wipe observational history tree with the account (not retention)
    ...buildPlayerHistoryTreeDeleteUpdate(playerKey),
    // Option C-b: unbind login directory (Auth user may remain orphaned)
    ...buildAuthLifecycleDeleteUpdates({
      username: playerKey,
      oldUid: lifecycle.oldUid,
      clearAdminRegistry: false, // v1 refuses Admin targets
    }),
  };

  // Safety: ensure trade index root for deleted user is cleared even if no actives
  if (!Object.prototype.hasOwnProperty.call(updates, `${PLAYER_TRADE_INDEX_ROOT}/${playerKey}`)) {
    updates[`${PLAYER_TRADE_INDEX_ROOT}/${playerKey}`] = null;
  }

  const ack = await db.updateAcknowledged(updates);
  metrics.recordTradeIndexLifecycle({
    tag: 'trade-index-delete-cleanup',
    ops: 1 + claimReleases,
    ok: ack.ok,
    username: playerKey,
  });
  if (!ack.ok) {
    return {
      ok: false,
      mode: ack.mode,
      error: ack.error || 'Player delete failed',
      claimReleases,
    };
  }
  return { ok: true, mode: ack.mode, claimReleases };
}
