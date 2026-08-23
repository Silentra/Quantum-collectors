/**
 * player-directory.js — Phase S5a derived playerDirectory projection
 *
 * players/{username} remains canonical. playerDirectory/{username} is a
 * lightweight derived projection only (no private/full player data).
 *
 * Key contract: directory map keys MUST match existing players/* keys exactly.
 * Do not lowercase a legacy key into a different path (duplicate risk).
 * New registrations already store lowercase keys (auth.register).
 *
 * S8d-2 rebuild: gather authoritative Firebase snapshots (adminLoadCanonical players +
 * loadPathOnce playerDirectory), plan purely from those snapshots, commit once.
 * Never treat db.getChildren('players') / local cache as the player universe.
 */

import * as db from './database.js';
import {
  adminLoadCanonical,
  assertCanonicalComplete,
  canonicalChildEntries,
} from './admin-maintenance.js';

export const DIRECTORY_ROOT = 'playerDirectory';

/** Non-player infrastructure key under players/* — never projected as a student. */
export const DIRECTORY_EXCLUDED_PLAYER_KEYS = Object.freeze(['__admin__']);

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
 * Normalize a directory-shaped object for semantic comparison.
 * Firebase RTDB drops null keys on write, so stored rows often omit groupId/subgroupId
 * while buildDirectoryEntry emits explicit null — treat those as equal.
 * Missing boolean keys are equivalent to false (same as === true projection).
 *
 * @param {string} usernameKey
 * @param {object|null|undefined} entryLike
 * @returns {{
 *   username: string,
 *   groupId: string|null,
 *   subgroupId: string|null,
 *   isAdmin: boolean,
 *   isTradeRestricted: boolean,
 *   isTradeProfileHidden: boolean
 * }}
 */
export function normalizeDirectoryEntry(usernameKey, entryLike) {
  return buildDirectoryEntry(usernameKey, entryLike);
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
  const na = normalizeDirectoryEntry(a.username != null ? a.username : b.username, a);
  const nb = normalizeDirectoryEntry(b.username != null ? b.username : a.username, b);
  return (
    na.username === nb.username
    && na.groupId === nb.groupId
    && na.subgroupId === nb.subgroupId
    && na.isAdmin === nb.isAdmin
    && na.isTradeRestricted === nb.isTradeRestricted
    && na.isTradeProfileHidden === nb.isTradeProfileHidden
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
 * Pure planner: no Firebase / DB cache reads.
 * Orphans only vs the explicit complete playersSnapshot keys.
 *
 * @param {{
 *   playersSnapshot?: object|null,
 *   directorySnapshot?: object|null,
 * }} [input]
 * @returns {{
 *   ok: true,
 *   updates: Record<string, object|null>,
 *   created: number,
 *   updated: number,
 *   removed: number,
 *   unchanged: number,
 *   scanned: number,
 *   skippedMalformed: number,
 *   createdKeys: string[],
 *   updatedKeys: string[],
 *   removedKeys: string[],
 * }}
 */
export function buildPlayerDirectoryRebuildPlan(input = {}) {
  const playersSnapshot = input.playersSnapshot == null ? null : input.playersSnapshot;
  const directorySnapshot = input.directorySnapshot == null ? null : input.directorySnapshot;

  const dirMap = new Map();
  if (directorySnapshot && typeof directorySnapshot === 'object') {
    for (const [key, value] of Object.entries(directorySnapshot)) {
      dirMap.set(key, value);
    }
  }

  /** @type {Record<string, object|null>} */
  const updates = {};
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skippedMalformed = 0;
  /** @type {string[]} */
  const createdKeys = [];
  /** @type {string[]} */
  const updatedKeys = [];
  /** @type {string[]} */
  const removedKeys = [];

  const seenPlayerKeys = new Set();
  const playerEntries = canonicalChildEntries(playersSnapshot, {
    exclude: [...DIRECTORY_EXCLUDED_PLAYER_KEYS],
  });

  for (const { key, value } of playerEntries) {
    seenPlayerKeys.add(key);
    const malformed = value == null || typeof value !== 'object';
    if (malformed) skippedMalformed += 1;
    const desired = buildDirectoryEntry(key, malformed ? {} : value);
    const existing = dirMap.get(key);
    const path = `${DIRECTORY_ROOT}/${key}`;

    if (existing == null) {
      updates[path] = desired;
      created += 1;
      createdKeys.push(key);
    } else if (!directoryEntriesEqual(desired, existing)) {
      updates[path] = desired;
      updated += 1;
      updatedKeys.push(key);
    } else {
      unchanged += 1;
    }
    dirMap.delete(key);
  }

  for (const key of dirMap.keys()) {
    updates[`${DIRECTORY_ROOT}/${key}`] = null;
    removedKeys.push(key);
  }
  const removed = removedKeys.length;

  return {
    ok: true,
    updates,
    created,
    updated,
    removed,
    unchanged,
    scanned: playerEntries.length,
    skippedMalformed,
    createdKeys,
    updatedKeys,
    removedKeys,
  };
}

/**
 * Gather authoritative Firebase snapshots for directory rebuild.
 * Fail-closed: incomplete loads never become empty universes.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   complete: boolean,
 *   playersSnapshot: object|null,
 *   directorySnapshot: object|null,
 *   error?: string,
 * }>}
 */
export async function gatherPlayerDirectoryRebuildSnapshots(options = {}) {
  const playersLoad = await adminLoadCanonical('players', options);
  if (!assertCanonicalComplete(playersLoad)) {
    return {
      ok: false,
      complete: false,
      playersSnapshot: null,
      directorySnapshot: null,
      error: playersLoad?.error || 'PLAYERS_CANONICAL_INCOMPLETE',
    };
  }

  const dirLoad = await db.loadPathOnce(DIRECTORY_ROOT, {
    force: true,
    timeoutMs: options.timeoutMs,
  });
  if (!dirLoad || dirLoad.ok !== true || dirLoad.mode !== 'firebase') {
    return {
      ok: false,
      complete: false,
      playersSnapshot: playersLoad.value,
      directorySnapshot: null,
      error: dirLoad?.error || 'DIRECTORY_LOAD_INCOMPLETE',
    };
  }

  return {
    ok: true,
    complete: true,
    playersSnapshot: playersLoad.value,
    directorySnapshot: dirLoad.value == null ? null : dirLoad.value,
  };
}

/**
 * Gather + plan (no writes). For Admin preview / DevTools.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object>}
 */
export async function preparePlayerDirectoryRebuild(options = {}) {
  const gathered = await gatherPlayerDirectoryRebuildSnapshots(options);
  if (!gathered.ok || !gathered.complete) {
    return {
      ok: false,
      skipped: false,
      complete: false,
      created: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      scanned: 0,
      skippedMalformed: 0,
      updates: {},
      plan: null,
      error: gathered.error || 'Gather failed',
    };
  }

  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: gathered.playersSnapshot,
    directorySnapshot: gathered.directorySnapshot,
  });

  return {
    ok: true,
    skipped: Object.keys(plan.updates).length === 0,
    complete: true,
    created: plan.created,
    updated: plan.updated,
    removed: plan.removed,
    unchanged: plan.unchanged,
    scanned: plan.scanned,
    skippedMalformed: plan.skippedMalformed,
    updates: plan.updates,
    plan,
    error: undefined,
  };
}

/**
 * Commit an already-prepared plan (exact in-memory updates). No re-gather.
 *
 * @param {{ updates: Record<string, object|null>, created?: number, updated?: number, removed?: number, unchanged?: number, scanned?: number, skippedMalformed?: number }} plan
 * @returns {Promise<object>}
 */
export async function commitPlayerDirectoryRebuildPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    return {
      ok: false,
      skipped: false,
      created: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      scanned: 0,
      error: 'INVALID_PLAN',
    };
  }

  const updates = plan.updates && typeof plan.updates === 'object' ? plan.updates : {};
  const created = Number(plan.created) || 0;
  const updated = Number(plan.updated) || 0;
  const removed = Number(plan.removed) || 0;
  const unchanged = Number(plan.unchanged) || 0;
  const scanned = Number(plan.scanned) || 0;
  const skippedMalformed = Number(plan.skippedMalformed) || 0;

  if (Object.keys(updates).length === 0) {
    return {
      ok: true,
      skipped: true,
      created: 0,
      updated: 0,
      removed: 0,
      unchanged,
      scanned,
      skippedMalformed,
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
      scanned,
      skippedMalformed,
      mode: ack.mode,
      error: ack.error || 'Directory rebuild write failed',
    };
  }

  return {
    ok: true,
    skipped: false,
    created,
    updated,
    removed,
    unchanged,
    scanned,
    skippedMalformed,
    mode: ack.mode,
  };
}

/**
 * Admin repair: gather → plan → one multipath commit.
 * Prefer prepare + confirm + commitPlayerDirectoryRebuildPlan from UI so the
 * previewed plan is the exact commit.
 *
 * @param {{ timeoutMs?: number, plan?: object }} [options]
 * @returns {Promise<object>}
 */
export async function rebuildPlayerDirectory(options = {}) {
  if (options.plan) {
    return commitPlayerDirectoryRebuildPlan(options.plan);
  }
  const prepared = await preparePlayerDirectoryRebuild(options);
  if (!prepared.ok) {
    return {
      ok: false,
      skipped: false,
      created: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      scanned: 0,
      skippedMalformed: 0,
      error: prepared.error || 'Directory rebuild gather failed',
    };
  }
  return commitPlayerDirectoryRebuildPlan(prepared.plan);
}

/**
 * Drift report from explicit snapshots (no cache). Prefer this + prepare for DevTools.
 *
 * @param {object|null|undefined} playersSnapshot
 * @param {object|null|undefined} directorySnapshot
 */
export function getDirectoryDriftReportFromSnapshots(playersSnapshot, directorySnapshot) {
  const plan = buildPlayerDirectoryRebuildPlan({ playersSnapshot, directorySnapshot });
  const directoryCount = directorySnapshot && typeof directorySnapshot === 'object'
    ? Object.keys(directorySnapshot).length
    : 0;
  return {
    playerCount: plan.scanned,
    directoryCount,
    missing: [...plan.createdKeys],
    orphans: [...plan.removedKeys],
    stale: [...plan.updatedKeys],
    inSync: plan.unchanged,
    skippedMalformed: plan.skippedMalformed,
  };
}

/**
 * Authoritative drift report (async gather). Never uses scoped cache as class truth.
 *
 * @param {{ timeoutMs?: number }} [options]
 */
export async function getDirectoryDriftReport(options = {}) {
  const gathered = await gatherPlayerDirectoryRebuildSnapshots(options);
  if (!gathered.ok || !gathered.complete) {
    return {
      ok: false,
      error: gathered.error || 'Gather failed',
      playerCount: 0,
      directoryCount: 0,
      missing: [],
      orphans: [],
      stale: [],
      inSync: 0,
      skippedMalformed: 0,
    };
  }
  return {
    ok: true,
    ...getDirectoryDriftReportFromSnapshots(
      gathered.playersSnapshot,
      gathered.directorySnapshot,
    ),
  };
}
