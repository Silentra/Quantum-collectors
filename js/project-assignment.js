/**
 * project-assignment.js
 * Phase 3C-1 — Assign cards to AVAILABLE projects and transition to ACTIVE.
 *
 * Exports:
 *   canAssignProject({ project, scientistCards, conceptCards, lockedCardIds })
 *     → { valid, reason }
 *
 *   activateProject({ project, scientistCards, conceptCards, allProjects, startedAt })
 *     → { success, reason, project }
 *
 * Rules:
 *   - Pure functions only. No async, no DOM, no timers.
 *   - No Firebase, no localStorage, no UI rendering.
 *   - Original project object is never mutated.
 *   - Project arrays are never mutated.
 *   - No outcome resolution, no reward granting.
 */

import { PROJECT_STATES }  from './project-state.js';
import { getLockedCardIds } from './project-state.js';
import { evaluateProject }  from './project-engine.js';
import { validateCardsAssignableToProject } from './trade-availability.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUIRED_SCIENTIST_COUNT = 5;
const REQUIRED_CONCEPT_COUNT   = 2;

// ---------------------------------------------------------------------------
// canAssignProject
// ---------------------------------------------------------------------------

/**
 * Validate whether the given cards can be assigned to the given project.
 *
 * Checks (in order):
 *   1. project exists and its state is AVAILABLE
 *   2. exactly REQUIRED_SCIENTIST_COUNT scientist cards are provided
 *   3. exactly REQUIRED_CONCEPT_COUNT concept cards are provided
 *   4. none of the provided cards appear in lockedCardIds
 *
 * @param {{
 *   project:        object,
 *   scientistCards: object[],
 *   conceptCards:   object[],
 *   lockedCardIds:  string[],
 *   availabilitySnapshot?: import('./trade-availability.js').AvailabilitySnapshot,
 * }} params
 *
 * @returns {{ valid: boolean, reason: string | null }}
 */
export function canAssignProject({
  project,
  scientistCards = [],
  conceptCards   = [],
  lockedCardIds  = [],
  availabilitySnapshot = null,
} = {}) {

  // 1. Project must exist and be in AVAILABLE state
  if (!project || project.state !== PROJECT_STATES.AVAILABLE) {
    return { valid: false, reason: 'invalid_project_state' };
  }

  // 2. Exactly 5 scientist cards required
  if (!Array.isArray(scientistCards) || scientistCards.length !== REQUIRED_SCIENTIST_COUNT) {
    return { valid: false, reason: 'invalid_scientist_count' };
  }

  // 3. Exactly 2 concept cards required
  if (!Array.isArray(conceptCards) || conceptCards.length !== REQUIRED_CONCEPT_COUNT) {
    return { valid: false, reason: 'invalid_concept_count' };
  }

  const allCards = [...scientistCards, ...conceptCards];
  const cardIds = allCards.map(c => c.id ?? c.cardId ?? null).filter(Boolean);

  // 4. Copy-aware availability (preferred) or legacy project-ID lock set
  if (availabilitySnapshot) {
    const avail = validateCardsAssignableToProject(availabilitySnapshot, cardIds);
    if (!avail.valid) {
      return { valid: false, reason: avail.reason ?? 'locked_cards_present' };
    }
  } else {
    const lockedSet = new Set(lockedCardIds);
    for (const cardId of cardIds) {
      if (lockedSet.has(cardId)) {
        return { valid: false, reason: 'locked_cards_present' };
      }
    }
  }

  return { valid: true, reason: null };
}

// ---------------------------------------------------------------------------
// activateProject
// ---------------------------------------------------------------------------

/**
 * Transition an AVAILABLE project to ACTIVE by assigning cards to it.
 *
 * Steps:
 *   1. Derive locked card IDs from all currently ACTIVE projects.
 *   2. Validate the assignment via canAssignProject().
 *   3. Evaluate the project (success chance snapshot) via evaluateProject().
 *   4. Build and return a new project object in ACTIVE state.
 *      The original project object is NOT mutated.
 *
 * @param {{
 *   project:        object,    - The AVAILABLE project to activate.
 *   scientistCards: object[],  - Exactly 5 scientist card objects.
 *   conceptCards:   object[],  - Exactly 2 concept card objects.
 *   allProjects:    object[],  - Full project pool (used to derive locked IDs).
 *   startedAt:      number,    - Activation timestamp (defaults to Date.now()).
 *   availabilitySnapshot?: import('./trade-availability.js').AvailabilitySnapshot,
 * }} params
 *
 * @returns {{
 *   success: boolean,
 *   reason:  string | null,
 *   project: object | null,
 * }}
 */
export function activateProject({
  project,
  scientistCards = [],
  conceptCards   = [],
  allProjects    = [],
  startedAt      = Date.now(),
  availabilitySnapshot = null,
} = {}) {

  // STEP 1 — Derive locked card IDs from all currently ACTIVE projects.
  const lockedCardIds = getLockedCardIds(allProjects);

  // STEP 2 — Validate the assignment (copy-aware when snapshot provided).
  const { valid, reason } = canAssignProject({
    project,
    scientistCards,
    conceptCards,
    lockedCardIds,
    availabilitySnapshot,
  });

  if (!valid) {
    return { success: false, reason, project: null };
  }

  // STEP 3 — Evaluate the project to snapshot projected success values.
  //
  // evaluateProject() expects:
  //   scientists        → scientist card objects
  //   concepts          → concept card objects
  //   difficulty        → project difficulty
  //   rewardRP          → project successRP (base reward)
  //   breakthroughChance → not stored on the project template; default to 0
  const evaluation = evaluateProject({
    scientists:         scientistCards,
    concepts:           conceptCards,
    difficulty:         project.difficulty,
    rewardRP:           project.successRP,
    breakthroughChance: project.breakthroughChance ?? 0,
  });

  // STEP 4 — Build the updated ACTIVE project (no mutation of original).
  const durationMs = (project.durationHours ?? 0) * 60 * 60 * 1000;

  const activatedProject = {
    ...project,

    // Card assignments — snapshot the IDs only (cards themselves live elsewhere)
    assignedScientists: scientistCards.map(c => c.id ?? c.cardId ?? null),
    assignedConcepts:   conceptCards.map(c => c.id ?? c.cardId ?? null),

    // Timing
    startedAt,
    completesAt: startedAt + durationMs,

    // Projected success snapshot (deterministic, no randomness here)
    projectedSuccessChance: evaluation.successChance,
    projectedSuccessLabel:  evaluation.successLabel,

    // ── Modified values after concept card effects are applied ──────────────
    // Resolution MUST use these fields instead of successRP / breakthroughChance
    // so that Research Amplifier, Breakthrough Catalyst, Risk Enhancer, etc.
    // actually affect the final payout and not just the telemetry display.
    modifiedRewardRP:          evaluation.rewardRP,
    modifiedBreakthroughChance: evaluation.breakthroughChance,
    modifiedDifficulty:         evaluation.difficulty,

    // State transition
    state: PROJECT_STATES.ACTIVE,
  };

  return {
    success: true,
    reason:  null,
    project: activatedProject,
  };
}
