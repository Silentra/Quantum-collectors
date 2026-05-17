// Phase 3E-1: Project Claiming
// Pure helpers — no persistence, no UI, no side effects.

import { PROJECT_STATES, shouldPruneProject } from './project-state.js';

// ---------------------------------------------------------------------------
// claimProjectRewards
// Transitions a COMPLETE project to CLAIMED and extracts the stored rewards.
// Original project object is never mutated.
// ---------------------------------------------------------------------------
export function claimProjectRewards({
  project,
  claimedAt = Date.now(),
} = {}) {
  // Guard: project must exist and be a non-null object
  if (project == null || typeof project !== 'object') {
    return { claimed: false, reason: 'invalid_project', project: null, rewards: null };
  }

  // Guard: project must be in COMPLETE state
  if (project.state !== PROJECT_STATES.COMPLETE) {
    return { claimed: false, reason: 'invalid_project_state', project, rewards: null };
  }

  // Guard: rewards must already be packaged on the project
  if (project.rewards == null) {
    return { claimed: false, reason: 'missing_rewards', project, rewards: null };
  }

  // Extract rewards from the stored project (no recalculation)
  const rewards = project.rewards;

  // Build the claimed project as a new spread object — original never mutated
  const claimedProject = {
    ...project,
    state: PROJECT_STATES.CLAIMED,
    reportViewed: true,
    claimedAt,
  };

  return {
    claimed: true,
    reason: null,
    project: claimedProject,
    rewards,
  };
}

// ---------------------------------------------------------------------------
// pruneProjects
// Removes CLAIMED projects older than 24 h (delegated to shouldPruneProject).
// Original array is never mutated.
// ---------------------------------------------------------------------------
export function pruneProjects({
  projects = [],
  now = Date.now(),
} = {}) {
  const kept = projects.filter((p) => !shouldPruneProject(p, now));
  return {
    projects: kept,
    prunedCount: projects.length - kept.length,
  };
}
