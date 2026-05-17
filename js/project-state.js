/**
 * project-state.js
 * Phase 3B-1 — Project state contract and pure helper utilities.
 *
 * NO async, NO DOM, NO timers, NO Firebase, NO localStorage.
 * This module defines the storage contract only.
 */

// ---------------------------------------------------------------------------
// State constants
// ---------------------------------------------------------------------------

export const PROJECT_STATES = {
  AVAILABLE: 'available',
  ACTIVE:    'active',
  COMPLETE:  'complete',
  CLAIMED:   'claimed',
};

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const PRUNE_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Step 2 — createAvailableProject
// ---------------------------------------------------------------------------

/**
 * Build a fresh AVAILABLE project object from a generated template.
 *
 * @param {object} options
 * @param {string}  options.id         - Unique project ID (caller-supplied).
 * @param {object}  options.template   - Output of generateProjectTemplate().
 * @param {number} [options.createdAt] - Creation timestamp (defaults to now).
 * @returns {object} Project in AVAILABLE state.
 */
export function createAvailableProject({
  id,
  template,
  createdAt = Date.now(),
} = {}) {
  const {
    rarity,
    title,
    difficulty,
    successRP,
    failureRP,
    durationHours,
  } = template;

  return {
    id,

    rarity,
    title,

    difficulty,
    successRP,
    failureRP,
    durationHours,

    createdAt,

    state: PROJECT_STATES.AVAILABLE,

    assignedScientists: [],
    assignedConcepts:   [],

    startedAt:    null,
    completesAt:  null,

    projectedSuccessChance: null,
    projectedSuccessLabel:  null,

    completedAt: null,
    outcome:     null,
    rewards:     null,

    reportViewed: false,
  };
}

// ---------------------------------------------------------------------------
// Step 3 — isProjectComplete
// ---------------------------------------------------------------------------

/**
 * Returns true only if the project is ACTIVE and its completion time has passed.
 * Pure — does NOT mutate the project.
 *
 * @param {object} project
 * @param {number} [now]
 * @returns {boolean}
 */
export function isProjectComplete(project, now = Date.now()) {
  return (
    project.state === PROJECT_STATES.ACTIVE &&
    project.completesAt != null &&
    now >= project.completesAt
  );
}

// ---------------------------------------------------------------------------
// Step 4 — shouldPruneProject
// ---------------------------------------------------------------------------

/**
 * Returns true only if the project is CLAIMED and 24 hours have elapsed
 * since completedAt.
 * Pure — returns boolean only.
 *
 * @param {object} project
 * @param {number} [now]
 * @returns {boolean}
 */
export function shouldPruneProject(project, now = Date.now()) {
  if (project.state !== PROJECT_STATES.CLAIMED) return false;
  if (project.completedAt == null) return false;
  return now >= project.completedAt + PRUNE_DELAY_MS;
}

// ---------------------------------------------------------------------------
// Step 5 — getLockedCardIds
// ---------------------------------------------------------------------------

/**
 * Returns a flat array of all card IDs locked by ACTIVE projects.
 * Includes both assignedScientists and assignedConcepts.
 * No deduplication performed.
 *
 * @param {object[]} [projects]
 * @returns {string[]}
 */
export function getLockedCardIds(projects = []) {
  const locked = [];
  for (const project of projects) {
    if (project.state !== PROJECT_STATES.ACTIVE) continue;
    for (const id of project.assignedScientists) locked.push(id);
    for (const id of project.assignedConcepts)   locked.push(id);
  }
  return locked;
}
