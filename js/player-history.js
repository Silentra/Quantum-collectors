/**
 * player-history.js — Observational provenance under playerHistory/{username}/{eventId}.
 *
 * History never mutates gameplay. Later retention may ONLY null leaves under this root.
 */

import * as db from './database.js';

export const PLAYER_HISTORY_ROOT = 'playerHistory';
export const PLAYER_HISTORY_SCHEMA_VERSION = 1;

/** Firebase RTDB server timestamp sentinel (resolved on write). */
export const HISTORY_SERVER_TIMESTAMP = Object.freeze({ '.sv': 'timestamp' });

export const HISTORY_EVENT_TYPES = Object.freeze({
  PACK_OPENED: 'pack_opened',
  PACK_GRANTED: 'pack_granted',
  PACK_REMOVED: 'pack_removed',
  CARD_GRANTED: 'card_granted',
  CARD_REMOVED: 'card_removed',
  ADMIN_STAT_CORRECT: 'admin_stat_correct',
});

export const HISTORY_ACTOR_TYPES = Object.freeze({
  SELF: 'self',
  ADMIN: 'admin',
  SYSTEM: 'system',
});

export const HISTORY_SOURCES = Object.freeze({
  PACK_OPEN: 'pack_open',
  ADMIN_GRANT_PACKS: 'admin_grant_packs',
  ADMIN_REMOVE_PACKS: 'admin_remove_packs',
  ADMIN_GRANT_CARDS: 'admin_grant_cards',
  ADMIN_REMOVE_CARDS: 'admin_remove_cards',
  ADMIN_STAT_CORRECTION: 'admin_stat_correction',
});

/** Types allowed for student (self) create under own username in v1 rules. */
export const HISTORY_SELF_CREATE_TYPES = Object.freeze([
  HISTORY_EVENT_TYPES.PACK_OPENED,
]);

/** Types allowed for Admin create. */
export const HISTORY_ADMIN_CREATE_TYPES = Object.freeze([
  HISTORY_EVENT_TYPES.PACK_OPENED,
  HISTORY_EVENT_TYPES.PACK_GRANTED,
  HISTORY_EVENT_TYPES.PACK_REMOVED,
  HISTORY_EVENT_TYPES.CARD_GRANTED,
  HISTORY_EVENT_TYPES.CARD_REMOVED,
  HISTORY_EVENT_TYPES.ADMIN_STAT_CORRECT,
]);

/**
 * @param {string} username
 * @returns {string}
 */
export function playerHistoryUserPath(username) {
  return `${PLAYER_HISTORY_ROOT}/${String(username || '').trim()}`;
}

/**
 * @param {string} username
 * @param {string} eventId
 * @returns {string}
 */
export function playerHistoryEventPath(username, eventId) {
  return `${playerHistoryUserPath(username)}/${String(eventId || '').trim()}`;
}

/**
 * Allocate a unique event path under the player's history root.
 * @param {string} username
 * @returns {{ eventId: string, path: string }}
 */
export function allocatePlayerHistoryEvent(username) {
  const key = String(username || '').trim();
  const parent = playerHistoryUserPath(key);
  const eventId = db.generatePushKey(parent);
  return { eventId, path: playerHistoryEventPath(key, eventId) };
}

/**
 * @param {{
 *   type: string,
 *   actorType: string,
 *   source: string,
 *   actorUid?: string|null,
 *   actorUsername?: string|null,
 *   sourceEventId?: string|null,
 *   payload?: Record<string, unknown>,
 * }} opts
 */
export function buildHistoryEventBody(opts) {
  const type = String(opts.type || '').trim();
  const actorType = String(opts.actorType || '').trim();
  const source = String(opts.source || '').trim();
  const body = {
    type,
    ts: HISTORY_SERVER_TIMESTAMP,
    schemaVersion: PLAYER_HISTORY_SCHEMA_VERSION,
    actorType,
    source,
  };
  if (opts.actorUid != null && String(opts.actorUid).trim()) {
    body.actorUid = String(opts.actorUid).trim();
  }
  if (opts.actorUsername != null && String(opts.actorUsername).trim()) {
    body.actorUsername = String(opts.actorUsername).trim();
  }
  if (opts.sourceEventId != null && String(opts.sourceEventId).trim()) {
    body.sourceEventId = String(opts.sourceEventId).trim();
  }
  const payload = opts.payload && typeof opts.payload === 'object' ? opts.payload : {};
  Object.assign(body, payload);
  return body;
}

/**
 * @param {string} username
 * @param {Parameters<typeof buildHistoryEventBody>[0]} opts
 * @returns {{ path: string, eventId: string, body: object, updates: Record<string, object> }}
 */
export function buildPlayerHistoryLeafUpdate(username, opts) {
  const { eventId, path } = allocatePlayerHistoryEvent(username);
  const body = buildHistoryEventBody(opts);
  return {
    path,
    eventId,
    body,
    updates: { [path]: body },
  };
}

/**
 * Aggregate card id → quantity from rolled card objects or id list.
 * @param {Array<{ id?: string }|string>} rolledCards
 * @returns {Record<string, number>}
 */
export function aggregateCardsGranted(rolledCards) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const item of Array.isArray(rolledCards) ? rolledCards : []) {
    const id = typeof item === 'string' ? item : (item && item.id != null ? String(item.id) : '');
    if (!id) continue;
    out[id] = (out[id] || 0) + 1;
  }
  return out;
}

/**
 * Pack-open history leaf for the same multipath as buildPackOpenPlan.
 */
export function buildPackOpenedHistoryUpdate(username, {
  packId,
  cardsGranted,
  packsOpenedDelta = 1,
  cardsCollectedDelta,
  actorUid = null,
}) {
  return buildPlayerHistoryLeafUpdate(username, {
    type: HISTORY_EVENT_TYPES.PACK_OPENED,
    actorType: HISTORY_ACTOR_TYPES.SELF,
    source: HISTORY_SOURCES.PACK_OPEN,
    actorUid,
    actorUsername: username,
    payload: {
      packId: String(packId || ''),
      cardsGranted: cardsGranted && typeof cardsGranted === 'object' ? cardsGranted : {},
      deltas: {
        packsOpened: packsOpenedDelta,
        cardsCollected: Number(cardsCollectedDelta) || 0,
      },
    },
  });
}

/**
 * True if every update key is under playerHistory/ (for future prune safety tests).
 * @param {Record<string, unknown>} updates
 */
export function updatesArePlayerHistoryOnly(updates) {
  const prefix = `${PLAYER_HISTORY_ROOT}/`;
  return Object.keys(updates || {}).every((k) => k === PLAYER_HISTORY_ROOT || k.startsWith(prefix));
}
