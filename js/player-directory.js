/**
 * player-directory.js — Phase S5a derived playerDirectory projection
 *
 * players/{username} remains canonical. playerDirectory/{username} is a
 * lightweight derived projection only (no private/full player data).
 *
 * Key contract: directory map keys MUST match existing players/* keys exactly.
 * Do not lowercase a legacy key into a different path (duplicate risk).
 * New registrations already store lowercase keys (auth.register).
 */

import * as db from './database.js';

export const DIRECTORY_ROOT = 'playerDirectory';

/**
 * @param {string} usernameKey - Exact Firebase players/* map key
 * @param {object|null|undefined} playerLike
 * @returns {{
 *   username: string,
 *   groupId: string|null,
 *   subgroupId: string|null,
 *   isAdmin: boolean,
 *   isTradeRestricted: boolean,
 *   isTradeProfileHidden: boolean
 * }}
 */
export function buildDirectoryEntry(usernameKey, playerLike) {
  const p = playerLike && typeof playerLike === 'object' ? playerLike : {};
  const groupId = p.groupId != null && p.groupId !== ''
    ? String(p.groupId)
    : (p.group != null && p.group !== '' ? String(p.group) : null);
  const subgroupId = p.subgroupId != null && p.subgroupId !== ''
    ? String(p.subgroupId)
    : (p.subgroup != null && p.subgroup !== '' ? String(p.subgroup) : null);

  return {
    username: String(usernameKey),
    groupId,
    subgroupId,
    isAdmin: p.isAdmin === true,
    isTradeRestricted: p.isTradeRestricted === true,
    isTradeProfileHidden: p.isTradeProfileHidden === true,
  };
}

/**
 * @param {string} usernameKey
 * @param {object} entry - full directory entry from buildDirectoryEntry
 * @returns {Record<string, object>}
 */
export function directoryPathsForPlayer(usernameKey, entry) {
  return {
    [`${DIRECTORY_ROOT}/${usernameKey}`]: entry,
  };
}

/**
 * Resolve the canonical players/* key for writes.
 * Prefer an existing exact-key hit; never invent a lowercased sibling key
 * when the exact key already exists under a different casing.
 *
 * @param {string} usernameOrKey
 * @returns {string}
 */
export function resolvePlayerDirectoryKey(usernameOrKey) {
  const raw = String(usernameOrKey || '').trim();
  if (!raw) return '';
  if (db.get(`players/${raw}`) != null) return raw;
  const lower = raw.toLowerCase();
  if (lower !== raw && db.get(`players/${lower}`) != null) return lower;
  // New write path (e.g. registration already lowercased): use caller key as-is
  return raw;
}

/**
 * @param {object|null|undefined} a
 * @param {object|null|undefined} b
 * @returns {boolean}
 */
export function directoryEntriesEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.username === b.username
    && a.groupId === b.groupId
    && a.subgroupId === b.subgroupId
    && a.isAdmin === b.isAdmin
    && a.isTradeRestricted === b.isTradeRestricted
    && a.isTradeProfileHidden === b.isTradeProfileHidden
  );
}

/**
 * Build multi-path updates that sync directory projection with a player snapshot.
 * @param {string} usernameKey
 * @param {object} playerLike - player fields after the canonical mutation
 * @returns {Record<string, object>}
 */
export function syncDirectoryUpdateFromPlayer(usernameKey, playerLike) {
  return directoryPathsForPlayer(usernameKey, buildDirectoryEntry(usernameKey, playerLike));
}

/**
 * Compare players vs directory without writing.
 * @returns {{
 *   playerCount: number,
 *   directoryCount: number,
 *   missing: string[],
 *   orphans: string[],
 *   stale: string[],
 *   inSync: number
 * }}
 */
export function getDirectoryDriftReport() {
  const players = db.getChildren('players');
  const directory = db.getChildren(DIRECTORY_ROOT);
  const dirMap = new Map(directory.map(({ key, value }) => [key, value]));

  const missing = [];
  const stale = [];
  let inSync = 0;

  for (const { key, value } of players) {
    if (key === '__admin__') continue;
    const desired = buildDirectoryEntry(key, value);
    const existing = dirMap.get(key);
    if (existing == null) {
      missing.push(key);
    } else if (!directoryEntriesEqual(desired, existing)) {
      stale.push(key);
    } else {
      inSync += 1;
    }
    dirMap.delete(key);
  }

  // Remaining dir keys with no player (also drop stray __admin__ dir if present)
  const orphans = [...dirMap.keys()];

  return {
    playerCount: players.filter((p) => p.key !== '__admin__').length,
    directoryCount: directory.length,
    missing,
    orphans,
    stale,
    inSync,
  };
}

/**
 * Admin-only repair: create missing, update stale, remove orphans.
 * Omits unchanged paths. Skips Firebase entirely when no drift.
 * Never writes players/* or activeSession.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped: boolean,
 *   created: number,
 *   updated: number,
 *   removed: number,
 *   unchanged: number,
 *   mode?: string,
 *   error?: string
 * }>}
 */
export async function rebuildPlayerDirectory() {
  const players = db.getChildren('players');
  const directory = db.getChildren(DIRECTORY_ROOT);
  const dirMap = new Map(directory.map(({ key, value }) => [key, value]));

  /** @type {Record<string, object|null>} */
  const updates = {};
  let created = 0;
  let updated = 0;
  let removed = 0;
  let unchanged = 0;

  const seenPlayerKeys = new Set();

  for (const { key, value } of players) {
    if (key === '__admin__') continue;
    seenPlayerKeys.add(key);
    const desired = buildDirectoryEntry(key, value);
    const existing = dirMap.get(key);
    const path = `${DIRECTORY_ROOT}/${key}`;

    if (existing == null) {
      updates[path] = desired;
      created += 1;
    } else if (!directoryEntriesEqual(desired, existing)) {
      updates[path] = desired;
      updated += 1;
    } else {
      unchanged += 1;
    }
  }

  for (const { key } of directory) {
    if (seenPlayerKeys.has(key)) continue;
    // Orphan (including any accidental __admin__ directory row)
    updates[`${DIRECTORY_ROOT}/${key}`] = null;
    removed += 1;
  }

  if (Object.keys(updates).length === 0) {
    return {
      ok: true,
      skipped: true,
      created: 0,
      updated: 0,
      removed: 0,
      unchanged,
    };
  }

  const ack = await db.updateAcknowledged(updates);
  if (!ack.ok) {
    return {
      ok: false,
      skipped: false,
      created,
      updated,
      removed,
      unchanged,
      mode: ack.mode,
      error: ack.error || 'Rebuild write failed',
    };
  }

  return {
    ok: true,
    skipped: false,
    created,
    updated,
    removed,
    unchanged,
    mode: ack.mode,
  };
}
