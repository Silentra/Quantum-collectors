/**
 * Automatic finalization of failed Research Projects.
 *
 * A failed COMPLETE project is finalized (COMPLETE → CLAIMED, zero rewards)
 * through the normal commitProjectClaim path when the student closes its
 * report. Nothing is changed locally unless the acknowledged write succeeds;
 * on any failure the project stays COMPLETE and is retried on the next close.
 */

import { PROJECT_STATES } from './project-state.js';
import { commitProjectClaim } from './project-claim-plan.js';

/** @type {Set<string>} */
const _inFlight = new Set();

/**
 * Only COMPLETE projects with an explicit `outcome.success === false`.
 * Missing or malformed outcome data is never treated as a failure.
 * @param {object} project
 * @returns {boolean}
 */
export function isAutoFinalizableFailedProject(project) {
  if (!project || typeof project !== 'object') return false;
  if (project.state !== PROJECT_STATES.COMPLETE) return false;
  const outcome = project.outcome;
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return false;
  return outcome.success === false;
}

/**
 * @param {string} username
 * @param {string} projectId
 * @param {{
 *   getProject?: (username: string, projectId: string) => object|null,
 *   commitClaim?: typeof commitProjectClaim,
 * }} deps
 * @returns {Promise<{ finalized: boolean, reason: string|null }>}
 */
export async function finalizeFailedProject(username, projectId, deps = {}) {
  const commitClaim = deps.commitClaim || commitProjectClaim;
  if (!username || !projectId) return { finalized: false, reason: 'invalid_args' };

  const project = typeof deps.getProject === 'function'
    ? deps.getProject(username, projectId)
    : null;
  if (!isAutoFinalizableFailedProject(project)) {
    return { finalized: false, reason: 'not_failed_complete' };
  }

  const key = `${username}/${projectId}`;
  if (_inFlight.has(key)) return { finalized: false, reason: 'in_flight' };
  _inFlight.add(key);
  try {
    const result = await commitClaim(username, projectId);
    if (result?.success) return { finalized: true, reason: null };
    if (result?.reason === 'already_claimed') return { finalized: true, reason: 'already_claimed' };
    console.warn('[ResearchProjects] Failed-project finalization did not complete:', result?.reason ?? 'unknown');
    return { finalized: false, reason: result?.reason ?? 'claim_failed' };
  } catch (e) {
    console.warn('[ResearchProjects] Failed-project finalization error:', e?.message ?? e);
    return { finalized: false, reason: 'error' };
  } finally {
    _inFlight.delete(key);
  }
}
