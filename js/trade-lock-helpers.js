/**
 * Trade Lock Helpers — Phase T-6 (legacy compatibility)
 *
 * Prefer trade-availability.js for copy-aware availability.
 * This module retains thin wrappers for older call sites.
 */

import {
  buildAvailabilitySnapshot,
  getUnavailableCardIds,
  isCardLockedByActiveProject,
} from './trade-availability.js';
import * as db from './database.js';
import { getLockedCardIds } from './project-state.js';

/**
 * Returns card IDs with zero available copies (project + trade reservations).
 *
 * @param {string} username
 * @returns {Set<string>}
 */
export function getPlayerLockedCardIds(username) {
  const snapshot = buildAvailabilitySnapshot(username);
  return getUnavailableCardIds(snapshot);
}

/**
 * @deprecated Use countProjectCommittedCopies from trade-availability.js
 */
export function isCardLockedByProject(cardId, lockedSet) {
  return lockedSet.has(cardId);
}

/**
 * @deprecated Use validateDirectTrade / trade-availability.js
 */
export function checkDirectTradeProjectLocks(offeredCardId, requestedCardId, offeringLockedSet, targetLockedSet) {
  if (offeringLockedSet.has(offeredCardId)) {
    return 'OFFERED_CARD_LOCKED_BY_PROJECT';
  }
  if (targetLockedSet.has(requestedCardId)) {
    return 'REQUESTED_CARD_LOCKED_BY_PROJECT';
  }
  return null;
}

/**
 * @deprecated Use validateListingTrade / trade-availability.js
 */
export function checkListingTradeProjectLocks(offeredCardId, chosenCardId, ownerLockedSet, accepterLockedSet) {
  if (ownerLockedSet.has(offeredCardId)) {
    return 'OFFERED_CARD_LOCKED_BY_PROJECT';
  }
  if (accepterLockedSet.has(chosenCardId)) {
    return 'REQUESTED_CARD_LOCKED_BY_PROJECT';
  }
  return null;
}

/**
 * Project-only committed count for a card (no trade reservations).
 * @param {string} username
 * @param {string} cardId
 * @returns {number}
 */
export function getPlayerProjectCommittedCount(username, cardId) {
  const playerData = db.get(`players/${username}`);
  return isCardLockedByActiveProject(cardId, playerData?.projects ?? []) ? 1 : 0;
}

/**
 * @deprecated Binary Set from getLockedCardIds — use getPlayerLockedCardIds for full unavailability
 */
export function getPlayerProjectLockedCardIds(username) {
  const playerData = db.get(`players/${username}`);
  return new Set(getLockedCardIds(playerData?.projects ?? []));
}
