/**
 * project-resolution.js
 * Phase 3D — ACTIVE → COMPLETE transition
 *
 * Pure helpers only. No side effects, no async, no DOM, no Firebase,
 * no localStorage, no RP granting, no card granting, no UI.
 */

import { PROJECT_STATES } from './project-state.js';
import { isProjectComplete } from './project-state.js';
import { rollProjectOutcome, buildProjectRewards } from './project-engine.js';

// ---------------------------------------------------------------------------
// resolveCompletedProject
// ---------------------------------------------------------------------------

/**
 * Attempt to transition a single ACTIVE project to COMPLETE.
 *
 * @param {object}  options
 * @param {object}  options.project - The project object to evaluate.
 * @param {number}  [options.now]   - Reference timestamp (ms). Defaults to Date.now().
 *
 * @returns {{ resolved: boolean, reason: string|null, project: object }}
 *   resolved  — true only when the project was successfully transitioned.
 *   reason    — null on success; one of the failure-reason strings otherwise.
 *   project   — the (possibly updated) project object, never the original
 *               reference when resolved (a new spread object is returned).
 */
export function resolveCompletedProject({
  project,
  now = Date.now(),
} = {}) {
  // Guard: project must exist and be a plain object.
  if (project == null || typeof project !== 'object') {
    return { resolved: false, reason: 'invalid_project', project };
  }

  // Guard: project must currently be ACTIVE.
  if (project.state !== PROJECT_STATES.ACTIVE) {
    return { resolved: false, reason: 'invalid_project_state', project };
  }

  // Guard: project timer must have elapsed.
  if (!isProjectComplete(project, now)) {
    return { resolved: false, reason: 'project_not_complete', project };
  }

  // --- Roll the outcome --------------------------------------------------
  // IMPORTANT: always prefer the concept-modified values (stored during
  // activation) over the base template values.  This ensures Research
  // Amplifier, Breakthrough Catalyst, Risk Enhancer, etc. affect the ACTUAL
  // payout and not just the telemetry preview.
  const successChance      = project.projectedSuccessChance       ?? 0;
  const breakthroughChance = project.modifiedBreakthroughChance   // concept-modified
                          ?? project.breakthroughChance           // base template fallback
                          ?? 0;

  const { success, breakthrough } = rollProjectOutcome({
    successChance,
    breakthroughChance,
  });

  // --- Package rewards ---------------------------------------------------
  // Use modifiedRewardRP (set during activation) so that concept effects
  // (Research Amplifier, Risk Enhancer) are reflected in the final payout.
  // Fall back to successRP / rewardRP for projects activated before this fix.
  const rewardRP = project.modifiedRewardRP      // concept-modified (preferred)
                ?? project.successRP             // base template field
                ?? project.rewardRP              // legacy field name
                ?? 0;

  const rewards = buildProjectRewards({
    success,
    breakthrough,
    rewardRP,
    failureRP:           project.failureRP         ?? 0,
    allowFailureRewards: true,
    breakthroughCard:    project.breakthroughCard  ?? null,
  });

  // --- Build the resolved project (no mutation of the original) ----------
  const resolvedProject = {
    ...project,
    state:       PROJECT_STATES.COMPLETE,
    completedAt: now,
    outcome: {
      success,
      breakthrough,
    },
    rewards,
  };

  return { resolved: true, reason: null, project: resolvedProject };
}

// ---------------------------------------------------------------------------
// resolveProjectPool
// ---------------------------------------------------------------------------

/**
 * Iterate a project array and resolve every ACTIVE project whose timer has
 * elapsed. All other projects are passed through unchanged.
 *
 * @param {object}   options
 * @param {object[]} [options.projects] - Full project list. Never mutated.
 * @param {number}   [options.now]      - Reference timestamp (ms). Defaults to Date.now().
 *
 * @returns {{ projects: object[], resolvedCount: number }}
 *   projects      — new array (originals untouched) with resolved projects
 *                   replaced by their COMPLETE counterparts.
 *   resolvedCount — number of projects successfully transitioned to COMPLETE.
 */
export function resolveProjectPool({
  projects = [],
  now = Date.now(),
} = {}) {
  let resolvedCount = 0;

  const updatedProjects = projects.map((project) => {
    // Only attempt resolution for ACTIVE projects.
    if (project == null || project.state !== PROJECT_STATES.ACTIVE) {
      return project;
    }

    const result = resolveCompletedProject({ project, now });

    if (result.resolved) {
      resolvedCount += 1;
      return result.project;
    }

    return project;
  });

  return { projects: updatedProjects, resolvedCount };
}
