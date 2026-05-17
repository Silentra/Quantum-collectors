/**
 * Trade Lock Helpers — Phase T-6
 *
 * Centralized pure helpers for checking whether cards are locked
 * by active research projects. Used by validators, execution modules,
 * and the trade UI to prevent trading project-locked cards.
 *
 * CONSTRAINTS:
 *   - Pure functions only (no DB writes, no DOM, no timers)
 *   - DB reads are explicit and contained
 *   - Never modifies project state
 */

import * as db from './database.js';
import { getLockedCardIds } from './project-state.js';

// ─── Core helper: get locked card IDs for a player ──────────────────────────

/**
 * Returns a Set of card IDs currently locked by ACTIVE research projects
 * for a given player. Reads fresh project data from DB.
 *
 * @param {string} username
 * @returns {Set<string>}
 */
export function getPlayerLockedCardIds(username) {
  const playerData = db.get(`players/${username}`);
  const projects = playerData?.projects ?? [];
  return new Set(getLockedCardIds(projects));
}

// ─── Validation helpers (pure — take a Set, no DB) ──────────────────────────

/**
 * Check if a specific card is locked by the player's active projects.
 *
 * @param {string} cardId
 * @param {Set<string>} lockedSet - From getPlayerLockedCardIds()
 * @returns {boolean}
 */
export function isCardLockedByProject(cardId, lockedSet) {
  return lockedSet.has(cardId);
}

/**
 * Validate that neither the offered nor requested card in a direct trade
 * are locked by active projects. Returns null if OK, or a failure reason string.
 *
 * @param {string} offeredCardId
 * @param {string} requestedCardId
 * @param {Set<string>} offeringLockedSet
 * @param {Set<string>} targetLockedSet
 * @returns {string|null} - null = OK, string = failure reason
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
 * Validate that neither the listing owner's offered card nor the accepter's
 * chosen card are locked by active projects.
 *
 * @param {string} offeredCardId
 * @param {string} chosenCardId
 * @param {Set<string>} ownerLockedSet
 * @param {Set<string>} accepterLockedSet
 * @returns {string|null} - null = OK, string = failure reason
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
