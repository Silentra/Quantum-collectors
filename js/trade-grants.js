/**
 * S8c-1 tradeGrants — claim-scoped authorization for foreign inventory ±1.
 *
 * Path: tradeGrants/{targetUsername}/{claimerUid}
 * Security is enforced by database.rules.json after Console deploy (not automatic).
 */

import * as db from './database.js';
import { getAuth } from './firebase-config.js';
import { getSession } from './auth.js';

export const TRADE_GRANTS_ROOT = 'tradeGrants';
export const TRADE_GRANT_TTL_MS = 60_000;

/**
 * @param {string} targetUsername
 * @param {string} claimerUid
 * @returns {string}
 */
export function tradeGrantPath(targetUsername, claimerUid) {
  const t = String(targetUsername || '').trim();
  const u = String(claimerUid || '').trim();
  return `${TRADE_GRANTS_ROOT}/${t}/${u}`;
}

/**
 * Prefer Auth currentUser.uid; fall back to session.authUid.
 * @returns {string|null}
 */
export function resolveClaimerAuthUid() {
  try {
    const u = getAuth().currentUser;
    if (u?.uid) return String(u.uid);
  } catch { /* Auth not ready */ }
  try {
    const s = getSession();
    if (s?.authUid) return String(s.authUid);
  } catch { /* ignore */ }
  return null;
}

/**
 * @param {object} opts
 * @returns {Record<string, object>|null} multipath fragment or null if incomplete
 */
export function buildTradeGrantCreateUpdate({
  targetUsername,
  claimerUid,
  tradeKind,
  tradeId,
  claimId,
  claimerUsername,
  giveCardId,
  recvCardId,
  now = Date.now(),
  ttlMs = TRADE_GRANT_TTL_MS,
}) {
  const target = String(targetUsername || '').trim();
  const uid = String(claimerUid || '').trim();
  const kind = tradeKind === 'listing' ? 'listing' : 'direct';
  const tid = String(tradeId || '').trim();
  const cid = String(claimId || '').trim();
  const claimer = String(claimerUsername || '').trim();
  const give = String(giveCardId || '').trim();
  const recv = String(recvCardId || '').trim();
  if (!target || !uid || !tid || !cid || !claimer || !give || !recv || give === recv) {
    return null;
  }
  const expiresAt = Number(now) + Number(ttlMs);
  return {
    [tradeGrantPath(target, uid)]: {
      tradeKind: kind,
      tradeId: tid,
      claimId: cid,
      claimerUsername: claimer,
      targetUsername: target,
      giveCardId: give,
      recvCardId: recv,
      expiresAt,
    },
  };
}

/**
 * @param {string} targetUsername
 * @param {string} claimerUid
 * @returns {Record<string, null>}
 */
export function buildTradeGrantClearUpdate(targetUsername, claimerUid) {
  const path = tradeGrantPath(targetUsername, claimerUid);
  if (!path.endsWith('/') && path.split('/').length >= 3) {
    return { [path]: null };
  }
  return {};
}

/**
 * Best-effort create grant (separate write before terminal multipath).
 * @returns {Promise<{ ok: boolean, error?: string, skipped?: boolean }>}
 */
export async function createTradeGrant(opts) {
  const fragment = buildTradeGrantCreateUpdate(opts);
  if (!fragment) {
    return { ok: false, error: 'INVALID_GRANT_PAYLOAD' };
  }
  const ack = await db.updateAcknowledged(fragment);
  if (!ack.ok) {
    return { ok: false, error: ack.error || 'GRANT_CREATE_FAILED' };
  }
  return { ok: true };
}

/**
 * Best-effort clear grant by path keys.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function clearTradeGrant(targetUsername, claimerUid) {
  const uid = String(claimerUid || '').trim() || resolveClaimerAuthUid();
  const target = String(targetUsername || '').trim();
  if (!target || !uid) return { ok: true };
  const ack = await db.updateAcknowledged(buildTradeGrantClearUpdate(target, uid));
  if (!ack.ok) {
    console.warn('[TradeGrants] clear failed:', ack.error);
    return { ok: false, error: ack.error };
  }
  return { ok: true };
}

/**
 * Merge grant clear into an updates map (terminal / fail multipaths).
 * @param {Record<string, unknown>} updates
 * @param {string} targetUsername
 * @param {string|null|undefined} claimerUid
 */
export function mergeTradeGrantClear(updates, targetUsername, claimerUid) {
  const uid = String(claimerUid || '').trim() || resolveClaimerAuthUid();
  const target = String(targetUsername || '').trim();
  if (!updates || !target || !uid) return updates;
  Object.assign(updates, buildTradeGrantClearUpdate(target, uid));
  return updates;
}
