/**
 * admin-stat-correction.js — Phase B Admin account stat/resource correction.
 *
 * Corrects canonical player fields (+ live leaderboard mirrors when applicable)
 * via one updateAcknowledged multipath. Requires consistent dual Admin lock.
 *
 * Does NOT award/re-evaluate achievements (avoids duplicate one-time rewards).
 * Attaches an atomic playerHistory leaf on the same multipath commit.
 */

import * as db from './database.js';
import { getAuth } from './firebase-config.js';
import { isUidInAdminRegistry } from './admin-registry.js';
import {
  getPlayerLockConsistency,
  playerLockPath,
  playerLockByUidPath,
  resolvePlayerLockIdentity,
} from './player-lock.js';
import {
  buildLeaderboardSummaryPathsForChangedStats,
  playerLikeWithStatOverlay,
} from './leaderboard-summaries.js';
import {
  buildPlayerHistoryLeafUpdate,
  HISTORY_EVENT_TYPES,
  HISTORY_ACTOR_TYPES,
  HISTORY_SOURCES,
} from './player-history.js';

export const MSG_LOCK_BEFORE_STAT_CORRECTION =
  'Lock this account before changing historical stats.';

/** @typedef {'spendableResearchPoints'|'lifetimeResearchPoints'|'seasonalResearchPoints'|'breakthroughs'|'projectsCompleted'|'tradesCompleted'|'packsOpened'|'cardsCollected'|'uniqueCardsDiscovered'} AdminStatCorrectionFieldId */

/**
 * Allowlist only. Excludes derived uniqueCardsOwned / maxCardAuraTier, weekly RP, orphans.
 * relativePath = under players/{username}/
 * leaderboardStatKey = live LB safe key or null
 */
export const ADMIN_STAT_CORRECTION_FIELDS = Object.freeze({
  spendableResearchPoints: Object.freeze({
    id: 'spendableResearchPoints',
    label: 'Spendable Research Points',
    relativePath: 'currencies/currentResearchPoints',
    leaderboardStatKey: null,
  }),
  lifetimeResearchPoints: Object.freeze({
    id: 'lifetimeResearchPoints',
    label: 'Lifetime Research Points',
    relativePath: 'totalResearchPoints',
    leaderboardStatKey: 'totalResearchPoints',
  }),
  seasonalResearchPoints: Object.freeze({
    id: 'seasonalResearchPoints',
    label: 'Seasonal Research Points',
    relativePath: 'seasonalResearchPoints',
    leaderboardStatKey: 'seasonalResearchPoints',
  }),
  breakthroughs: Object.freeze({
    id: 'breakthroughs',
    label: 'Breakthroughs',
    relativePath: 'researchStats/breakthroughs',
    leaderboardStatKey: 'breakthroughs',
  }),
  projectsCompleted: Object.freeze({
    id: 'projectsCompleted',
    label: 'Projects Completed',
    relativePath: 'projectsCompleted',
    leaderboardStatKey: 'projectsCompleted',
  }),
  tradesCompleted: Object.freeze({
    id: 'tradesCompleted',
    label: 'Trades Completed',
    relativePath: 'stats/tradesCompleted',
    leaderboardStatKey: 'tradesCompleted',
  }),
  packsOpened: Object.freeze({
    id: 'packsOpened',
    label: 'Packs Opened',
    relativePath: 'stats/packsOpened',
    leaderboardStatKey: 'packsOpened',
  }),
  cardsCollected: Object.freeze({
    id: 'cardsCollected',
    label: 'Cards Collected',
    relativePath: 'stats/cardsCollected',
    leaderboardStatKey: null,
  }),
  uniqueCardsDiscovered: Object.freeze({
    id: 'uniqueCardsDiscovered',
    label: 'Unique Cards Discovered',
    relativePath: 'stats/uniqueCardsDiscovered',
    leaderboardStatKey: null,
  }),
});

export const ADMIN_STAT_CORRECTION_FIELD_IDS = Object.freeze(
  Object.keys(ADMIN_STAT_CORRECTION_FIELDS),
);

const EXCLUDED_FIELD_IDS = Object.freeze([
  'uniqueCardsOwned',
  'maxCardAuraTier',
  'weeklyRPProgress',
  'weeklyPackClaimed',
  'failedProjects',
  'researchPoints',
]);

/**
 * @param {string} fieldId
 * @returns {typeof ADMIN_STAT_CORRECTION_FIELDS[string]|null}
 */
export function getAdminStatCorrectionField(fieldId) {
  const id = String(fieldId || '').trim();
  if (!id || !Object.prototype.hasOwnProperty.call(ADMIN_STAT_CORRECTION_FIELDS, id)) {
    return null;
  }
  return ADMIN_STAT_CORRECTION_FIELDS[id];
}

/**
 * Parse a signed integer adjustment (may be negative). Rejects non-integers / non-finite.
 * @param {unknown} raw
 * @returns {{ ok: true, adjustment: number } | { ok: false, error: string }}
 */
export function parseStatCorrectionAdjustment(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
      return { ok: false, error: 'Adjustment must be a whole number.' };
    }
    return { ok: true, adjustment: raw };
  }
  const text = String(raw ?? '').trim();
  if (!text || !/^[+-]?\d+$/.test(text)) {
    return { ok: false, error: 'Adjustment must be a whole number.' };
  }
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: 'Adjustment must be a whole number.' };
  }
  return { ok: true, adjustment: n };
}

/**
 * @param {unknown} current
 * @param {unknown} adjustmentRaw
 * @returns {{ ok: true, before: number, adjustment: number, after: number } | { ok: false, error: string, before?: number, adjustment?: number, after?: number }}
 */
export function previewStatCorrection(current, adjustmentRaw) {
  const before = typeof current === 'number' && Number.isFinite(current)
    ? Math.trunc(current)
    : (() => {
      const n = parseInt(String(current ?? ''), 10);
      return Number.isFinite(n) ? n : 0;
    })();
  if (!Number.isFinite(before) || before < 0) {
    return { ok: false, error: 'Current value is invalid.', before };
  }

  const adj = parseStatCorrectionAdjustment(adjustmentRaw);
  if (!adj.ok) return { ok: false, error: adj.error, before };

  if (adj.adjustment === 0) {
    return {
      ok: false,
      error: 'Adjustment cannot be zero.',
      before,
      adjustment: 0,
      after: before,
    };
  }

  const after = before + adj.adjustment;
  if (!Number.isFinite(after) || !Number.isInteger(after)) {
    return { ok: false, error: 'Result must be a whole number.', before, adjustment: adj.adjustment, after };
  }
  if (after < 0) {
    return {
      ok: false,
      error: 'Result cannot be negative.',
      before,
      adjustment: adj.adjustment,
      after,
    };
  }

  return { ok: true, before, adjustment: adj.adjustment, after };
}

/**
 * Read nested player value for a relative path (slash-separated).
 * @param {object|null|undefined} player
 * @param {string} relativePath
 * @returns {number}
 */
export function readPlayerRelativeNumber(player, relativePath) {
  const parts = String(relativePath || '').split('/').filter(Boolean);
  let cur = player;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return 0;
    cur = cur[part];
  }
  if (typeof cur === 'number' && Number.isFinite(cur)) return Math.trunc(cur);
  const n = parseInt(String(cur ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * @param {{
 *   displayName: string,
 *   loginUsername: string,
 *   fieldLabel: string,
 *   before: number,
 *   adjustment: number,
 *   after: number,
 * }} opts
 */
export function buildAdminStatCorrectionConfirmOptions(opts) {
  const sign = opts.adjustment > 0 ? `+${opts.adjustment}` : String(opts.adjustment);
  return {
    title: `Correct ${opts.fieldLabel}?`,
    message:
      `Correct ${opts.fieldLabel} for ${opts.displayName}?\n\n`
      + `Login username: ${opts.loginUsername}\n`
      + `Field: ${opts.fieldLabel}\n`
      + `Before: ${opts.before}\n`
      + `Adjustment: ${sign}\n`
      + `After: ${opts.after}`,
    confirmText: 'Apply Correction',
    destructive: true,
  };
}

/**
 * True only when both mirrors are locked and username relationship matches.
 * @param {string} username
 * @param {string} authUid
 */
export function isConsistentlyAdminLockedForCorrection(username, authUid) {
  const consistency = getPlayerLockConsistency(username, authUid);
  const userRow = consistency.usernameMirror;
  const uidRow = consistency.uidMirror;
  if (!(userRow && userRow.locked === true && uidRow && uidRow.locked === true)) {
    return { ok: false, reason: 'unlocked', consistency };
  }
  if (consistency.reason) {
    return { ok: false, reason: consistency.reason, consistency };
  }
  if (uidRow.username && String(uidRow.username) !== String(username)) {
    return { ok: false, reason: 'mirror_username_mismatch', consistency };
  }
  return { ok: true, consistency };
}

async function _callerIsAdmin() {
  const authMod = await import('./auth.js');
  if (!authMod.isAdmin()) return false;
  try {
    const uid = getAuth().currentUser?.uid;
    if (uid && isUidInAdminRegistry(uid)) return true;
  } catch { /* Auth not ready */ }
  return authMod.isAdmin();
}

/**
 * Build multipath updates for a validated correction (no I/O except reading player for LB group fields).
 * @param {string} username
 * @param {object} playerSnapshot
 * @param {ReturnType<typeof getAdminStatCorrectionField>} field
 * @param {{ before: number, adjustment: number, after: number }} preview
 * @param {number} [now]
 */
export function buildAdminStatCorrectionUpdates(username, playerSnapshot, field, preview, now = Date.now()) {
  const key = String(username || '').trim();
  const playerPath = `players/${key}/${field.relativePath}`;
  /** @type {Record<string, unknown>} */
  const updates = {
    [playerPath]: preview.after,
  };

  if (field.leaderboardStatKey) {
    const playerLike = playerLikeWithStatOverlay(playerSnapshot || {}, {
      [field.leaderboardStatKey]: preview.after,
    });
    Object.assign(
      updates,
      buildLeaderboardSummaryPathsForChangedStats(
        key,
        playerLike,
        [field.leaderboardStatKey],
        now,
      ),
    );
  }

  return updates;
}

/**
 * Canonical Admin stat/resource correction.
 * @param {string} username
 * @param {string} fieldId
 * @param {unknown} adjustmentRaw
 * @returns {Promise<object>}
 */
export async function adminCorrectPlayerStat(username, fieldId, adjustmentRaw) {
  if (!(await _callerIsAdmin())) {
    return { ok: false, error: 'Admin authorization required.' };
  }

  if (EXCLUDED_FIELD_IDS.includes(String(fieldId || '').trim())) {
    return { ok: false, error: 'This field cannot be corrected directly.' };
  }

  const field = getAdminStatCorrectionField(fieldId);
  if (!field) {
    return { ok: false, error: 'Unknown or unsupported correction field.' };
  }

  const identity = resolvePlayerLockIdentity(username);
  if (!identity.ok) return { ok: false, error: identity.error };

  await db.loadPathOnce(`players/${identity.username}`, { force: true });
  await db.loadPathOnce(playerLockPath(identity.username), { force: true });
  await db.loadPathOnce(playerLockByUidPath(identity.authUid), { force: true });

  const refreshed = resolvePlayerLockIdentity(username);
  if (!refreshed.ok) return { ok: false, error: refreshed.error };

  const lockGate = isConsistentlyAdminLockedForCorrection(
    refreshed.username,
    refreshed.authUid,
  );
  if (!lockGate.ok) {
    return {
      ok: false,
      error: MSG_LOCK_BEFORE_STAT_CORRECTION,
      lockReason: lockGate.reason,
      requiresLock: true,
    };
  }

  const playerSnap = db.get(`players/${refreshed.username}`) || {};
  const before = readPlayerRelativeNumber(playerSnap, field.relativePath);
  const preview = previewStatCorrection(before, adjustmentRaw);
  if (!preview.ok) {
    return {
      ok: false,
      error: preview.error,
      fieldId: field.id,
      before: preview.before,
      adjustment: preview.adjustment,
      after: preview.after,
    };
  }

  const now = Date.now();
  const updates = buildAdminStatCorrectionUpdates(
    refreshed.username,
    playerSnap,
    field,
    preview,
    now,
  );

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

  const historyLeaf = buildPlayerHistoryLeafUpdate(refreshed.username, {
    type: HISTORY_EVENT_TYPES.ADMIN_STAT_CORRECT,
    actorType: HISTORY_ACTOR_TYPES.ADMIN,
    source: HISTORY_SOURCES.ADMIN_STAT_CORRECTION,
    actorUid,
    actorUsername,
    payload: {
      fieldId: field.id,
      before: preview.before,
      adjustment: preview.adjustment,
      after: preview.after,
    },
  });
  Object.assign(updates, historyLeaf.updates);

  const ack = await db.updateAcknowledged(updates);
  if (!ack.ok) {
    return {
      ok: false,
      error: ack.error || 'Correction write failed.',
      mode: ack.mode,
      fieldId: field.id,
      before: preview.before,
      adjustment: preview.adjustment,
      after: preview.after,
    };
  }

  return {
    ok: true,
    username: refreshed.username,
    authUid: refreshed.authUid,
    fieldId: field.id,
    fieldLabel: field.label,
    relativePath: field.relativePath,
    leaderboardStatKey: field.leaderboardStatKey,
    before: preview.before,
    adjustment: preview.adjustment,
    after: preview.after,
    mode: ack.mode,
    achievementsTouched: false,
    historyEventId: historyLeaf.eventId,
  };
}
