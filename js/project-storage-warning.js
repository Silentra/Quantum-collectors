/**
 * project-storage-warning.js — Pure copy/state for the Research Project storage
 * warning and Research Proposal blocking. No DOM, no Firebase.
 */

import {
  COMPLETED_GENERATION_CUTOFF,
  countCompletedUnclaimedProjects,
  getProjectStorageLevel,
} from './project-refresh.js';

/** Messages for Research Proposal attempts that cannot generate a project. */
export const RESEARCH_PROPOSAL_BLOCK_MESSAGES = Object.freeze({
  completed_storage_full:
    `Research Project storage is full. Claim rewards to drop below ${COMPLETED_GENERATION_CUTOFF} completed projects before using a Research Proposal.`,
  project_array_full:
    'Research Project storage is at capacity. Claim rewards and let claimed projects clear before using a Research Proposal.',
  project_cap_full: 'No available project slots for a new proposal.',
});

/**
 * @param {string|null|undefined} reason
 * @returns {string|null}
 */
export function getResearchProposalBlockMessage(reason) {
  if (reason === 'project_cap_reached') return RESEARCH_PROPOSAL_BLOCK_MESSAGES.project_cap_full;
  return Object.prototype.hasOwnProperty.call(RESEARCH_PROPOSAL_BLOCK_MESSAGES, reason)
    ? RESEARCH_PROPOSAL_BLOCK_MESSAGES[reason]
    : null;
}

/**
 * Persistent warning above the project list (null below the warning threshold).
 *
 * @param {object[]} projects
 * @param {number} [now]
 * @returns {{ level: 'warn'|'full', count: number, message: string }|null}
 */
export function getProjectStorageWarning(projects, now = Date.now()) {
  const count = countCompletedUnclaimedProjects(projects, now);
  const level = getProjectStorageLevel(count);
  if (level === 'full') {
    return {
      level,
      count,
      message: `Research Project storage is full! You have ${count} completed projects waiting to be claimed. New projects and Research Proposals are unavailable until you claim enough rewards to drop below ${COMPLETED_GENERATION_CUTOFF}.`,
    };
  }
  if (level === 'warn') {
    return {
      level,
      count,
      message: `You have ${count} completed Research Projects waiting to be claimed. Once you reach ${COMPLETED_GENERATION_CUTOFF}, you won't generate new projects until you claim some rewards.`,
    };
  }
  return null;
}
