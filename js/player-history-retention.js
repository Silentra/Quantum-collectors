/**
 * player-history-retention.js — Opportunistic ~30-day prune of playerHistory ONLY.
 *
 * NEVER imports gameplay mutators. Prune updates must be history-leaf nulls only.
 * Failures are best-effort and must not affect gameplay.
 */

import * as db from './database.js';
import {
  PLAYER_HISTORY_ROOT,
  playerHistoryUserPath,
  playerHistoryEventPath,
} from './player-history.js';

/** ~30 days in ms — authoritative age uses stored event `ts`. */
export const PLAYER_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Max expired events deleted per prune trigger. */
export const PLAYER_HISTORY_PRUNE_BATCH_SIZE = 40;

/** Run prune every N successful history writes for that username (session). */
export const PLAYER_HISTORY_PRUNE_EVERY_N_WRITES = 8;

/** @type {Map<string, number>} */
const writeCountsSincePrune = new Map();

/**
 * Hard safety: ordinary retention updates may ONLY null
 * `playerHistory/{username}/{eventId}` leaves — never a whole user tree,
 * never any non-history path, never non-null values.
 *
 * @param {Record<string, unknown>} updates
 * @param {string} username
 * @throws {Error}
 */
export function assertHistoryOnlyDeleteUpdates(updates, username) {
  const key = String(username || '').trim();
  if (!key) {
    throw new Error('[HistoryRetention] username required for prune assertion');
  }
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('[HistoryRetention] updates must be a plain object');
  }
  const keys = Object.keys(updates);
  if (!keys.length) {
    throw new Error('[HistoryRetention] empty prune updates');
  }
  const userRoot = playerHistoryUserPath(key);
  const leafPrefix = `${userRoot}/`;
  for (const path of keys) {
    const value = updates[path];
    if (value !== null) {
      throw new Error(`[HistoryRetention] prune value must be null: ${path}`);
    }
    if (path === userRoot || path === PLAYER_HISTORY_ROOT) {
      throw new Error(`[HistoryRetention] whole-tree delete forbidden in retention: ${path}`);
    }
    if (!path.startsWith(leafPrefix)) {
      throw new Error(`[HistoryRetention] path outside playerHistory/${key}/: ${path}`);
    }
    const eventId = path.slice(leafPrefix.length);
    if (!eventId || eventId.includes('/')) {
      throw new Error(`[HistoryRetention] prune path must be a single event leaf: ${path}`);
    }
  }
}

/**
 * Permanent account deletion only: null the entire playerHistory/{username} tree.
 * @param {string} username
 * @returns {Record<string, null>}
 */
export function buildPlayerHistoryTreeDeleteUpdate(username) {
  const key = String(username || '').trim();
  if (!key) return {};
  return { [playerHistoryUserPath(key)]: null };
}

/**
 * @param {number} [nowMs]
 * @returns {number}
 */
export function historyRetentionCutoffTs(nowMs = Date.now()) {
  const n = Number(nowMs);
  const now = Number.isFinite(n) ? n : Date.now();
  return now - PLAYER_HISTORY_RETENTION_MS;
}

/**
 * Whether a history event body is eligible for retention delete.
 * Missing/malformed ts → skip (do not delete).
 * @param {unknown} event
 * @param {number} cutoffTs
 */
export function isHistoryEventExpired(event, cutoffTs) {
  if (!event || typeof event !== 'object') return false;
  const ts = Number(/** @type {{ ts?: unknown }} */ (event).ts);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return ts <= Number(cutoffTs);
}

/**
 * Build null-leaf updates for expired entries (bounded).
 * @param {string} username
 * @param {Array<{ key: string, value?: unknown }>} entries
 * @param {number} cutoffTs
 * @param {number} [limit]
 * @returns {{ ok: boolean, updates: Record<string, null>, deletedEventIds: string[], skipped: number }}
 */
export function buildExpiredHistoryPruneUpdates(username, entries, cutoffTs, limit = PLAYER_HISTORY_PRUNE_BATCH_SIZE) {
  const key = String(username || '').trim();
  const max = Math.max(0, Math.trunc(Number(limit) || 0));
  /** @type {Record<string, null>} */
  const updates = {};
  /** @type {string[]} */
  const deletedEventIds = [];
  let skipped = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (deletedEventIds.length >= max) break;
    const eventId = String(entry?.key || '').trim();
    if (!eventId || eventId.includes('/')) {
      skipped += 1;
      continue;
    }
    if (!isHistoryEventExpired(entry.value, cutoffTs)) {
      skipped += 1;
      continue;
    }
    updates[playerHistoryEventPath(key, eventId)] = null;
    deletedEventIds.push(eventId);
  }

  if (deletedEventIds.length) {
    assertHistoryOnlyDeleteUpdates(updates, key);
  }

  return { ok: true, updates, deletedEventIds, skipped };
}

/**
 * Usernames that received a history leaf in this updates map.
 * @param {Record<string, unknown>} updates
 * @returns {string[]}
 */
export function usernamesTouchedByHistoryUpdates(updates) {
  const prefix = `${PLAYER_HISTORY_ROOT}/`;
  const out = new Set();
  for (const path of Object.keys(updates || {})) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const username = rest.split('/')[0];
    if (username) out.add(username);
  }
  return [...out];
}

/**
 * After a successful mutation that included history leaves: cadence-gated best-effort prune.
 * Never throws to caller; never blocks gameplay.
 * @param {Record<string, unknown>|string[]|string} updatesOrUsernames
 */
export function scheduleHistoryRetentionAfterWrite(updatesOrUsernames) {
  try {
    let names = [];
    if (typeof updatesOrUsernames === 'string') {
      names = [updatesOrUsernames];
    } else if (Array.isArray(updatesOrUsernames)) {
      names = updatesOrUsernames;
    } else {
      names = usernamesTouchedByHistoryUpdates(updatesOrUsernames);
    }
    for (const raw of names) {
      const username = String(raw || '').trim();
      if (!username) continue;
      const prev = writeCountsSincePrune.get(username) || 0;
      const next = prev + 1;
      if (next < PLAYER_HISTORY_PRUNE_EVERY_N_WRITES) {
        writeCountsSincePrune.set(username, next);
        continue;
      }
      writeCountsSincePrune.set(username, 0);
      void pruneExpiredPlayerHistory(username, { trigger: 'history_write' }).catch((err) => {
        console.warn('[HistoryRetention] post-write prune failed:', username, err?.message || err);
      });
    }
  } catch (err) {
    console.warn('[HistoryRetention] schedule after write failed:', err?.message || err);
  }
}

/**
 * Admin View History trigger — always attempt one bounded batch (best-effort).
 * @param {string} username
 */
export function scheduleHistoryRetentionOnAdminView(username) {
  const key = String(username || '').trim();
  if (!key) return;
  void pruneExpiredPlayerHistory(key, { trigger: 'admin_view' }).catch((err) => {
    console.warn('[HistoryRetention] admin-view prune failed:', key, err?.message || err);
  });
}

/**
 * Query expired leaves + null them (one batch). History-only.
 * @param {string} username
 * @param {{ trigger?: string, nowMs?: number, batchSize?: number }} [opts]
 * @returns {Promise<{ ok: boolean, pruned: number, skipped?: number, error?: string, aborted?: boolean }>}
 */
export async function pruneExpiredPlayerHistory(username, opts = {}) {
  const key = String(username || '').trim();
  if (!key) {
    return { ok: false, pruned: 0, error: 'username required' };
  }

  const cutoff = historyRetentionCutoffTs(opts.nowMs);
  const batchSize = Number.isFinite(Number(opts.batchSize))
    ? Math.trunc(Number(opts.batchSize))
    : PLAYER_HISTORY_PRUNE_BATCH_SIZE;

  let queryResult;
  try {
    queryResult = await db.loadPathQueryOnce(playerHistoryUserPath(key), {
      orderByKey: false,
      orderByChild: 'ts',
      endAt: cutoff,
      limitToFirst: batchSize,
    }, { mergeCache: false });
  } catch (err) {
    return { ok: false, pruned: 0, error: err?.message || 'query failed' };
  }

  if (!queryResult.ok) {
    return { ok: false, pruned: 0, error: queryResult.error || 'query failed' };
  }

  const planned = buildExpiredHistoryPruneUpdates(
    key,
    queryResult.entries || [],
    cutoff,
    batchSize,
  );

  if (!Object.keys(planned.updates).length) {
    return { ok: true, pruned: 0, skipped: planned.skipped };
  }

  try {
    assertHistoryOnlyDeleteUpdates(planned.updates, key);
  } catch (err) {
    console.error('[HistoryRetention] STOP — unsafe prune plan aborted:', err?.message || err);
    return { ok: false, pruned: 0, aborted: true, error: err?.message || 'unsafe prune plan' };
  }

  // Defense: re-check no keys escape playerHistory
  for (const path of Object.keys(planned.updates)) {
    if (!path.startsWith(`${PLAYER_HISTORY_ROOT}/`)) {
      console.error('[HistoryRetention] STOP — non-history path in prune plan');
      return { ok: false, pruned: 0, aborted: true, error: 'non-history path' };
    }
  }

  const ack = await db.updateAcknowledged(planned.updates);
  if (!ack.ok) {
    return {
      ok: false,
      pruned: 0,
      error: ack.error || 'prune write failed',
    };
  }

  return {
    ok: true,
    pruned: planned.deletedEventIds.length,
    skipped: planned.skipped,
    trigger: opts.trigger || null,
  };
}

/** Test helper: reset session cadence counters. */
export function _resetHistoryRetentionCadenceForTests() {
  writeCountsSincePrune.clear();
}
