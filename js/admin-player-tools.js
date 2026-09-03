/**
 * admin-player-tools.js
 * Canonical admin-only wrappers for testing and competition operations.
 *
 * UI should call these helpers instead of writing player/shop/project paths
 * directly for the admin tools added after the shop runtime layers.
 *
 * adminCompleteActiveProject (two-phase):
 *   Phase 1 — persist ACTIVE → COMPLETE (no marker, no rewards)
 *   Phase 2 — canonical commitProjectClaim COMPLETE → CLAIMED + marker + rewards
 */

import * as db from './database.js';
import * as player from './player.js';
import { getItemDefinition } from './cosmetic-definitions.js';
import { ITEM_TYPES } from './shop-definitions.js';
import { grantConsumable, unlockCosmetic } from './shop-mutations.js';
import { resolveCompletedProject } from './project-resolution.js';
import { PROJECT_STATES } from './project-state.js';
import { addResearchPoints } from './research.js';
import { commitProjectClaim } from './project-claim-plan.js';
import { prepareProjectsForPersist } from './project-claims.js';

function toPositiveInteger(value, fallback = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function adminGrantResearchPoints(username, amount) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }
  const safeAmount = toPositiveInteger(amount, 0);
  if (safeAmount <= 0) return { success: false, reason: 'invalid_amount' };

  const totalResearchPoints = addResearchPoints(username, safeAmount);
  const currentResearchPoints = db.get(`players/${username}/currencies/currentResearchPoints`) || 0;
  return { success: true, amount: safeAmount, totalResearchPoints, currentResearchPoints };
}

export function adminGrantShopItem(username, itemId, quantity = 1) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }
  const definition = getItemDefinition(itemId);
  if (!definition) return { success: false, reason: 'invalid_item_id' };

  if (definition.type === ITEM_TYPES.CONSUMABLE) {
    return grantConsumable(username, itemId, toPositiveInteger(quantity, 1));
  }
  if (definition.type === ITEM_TYPES.COSMETIC) {
    return unlockCosmetic(username, itemId);
  }

  return { success: false, reason: 'unsupported_item_type', itemType: definition.type };
}

/**
 * Pure: apply force-timer resolve into a new projects array (ACTIVE → COMPLETE only).
 * Does not claim, grant rewards, or write Firebase.
 *
 * @param {object[]} projects
 * @param {string} projectId
 * @param {number} now
 * @returns {{ ok: boolean, reason?: string, projects?: object[], completedProject?: object }}
 */
export function buildAdminForceCompleteProjects(projects, projectId, now = Date.now()) {
  const list = Array.isArray(projects) ? projects : [];
  const activeProject = list.find((project) => project?.id === projectId);
  if (!activeProject) return { ok: false, reason: 'project_not_found' };
  if (activeProject.state !== PROJECT_STATES.ACTIVE) {
    return { ok: false, reason: 'project_not_active' };
  }

  const resolutionInput = {
    ...activeProject,
    completesAt: now,
  };
  const resolved = resolveCompletedProject({ project: resolutionInput, now });
  if (!resolved.resolved) {
    return { ok: false, reason: resolved.reason || 'project_resolution_failed' };
  }

  const nextProjects = list.map((project) =>
    project.id === resolved.project.id ? resolved.project : project
  );
  return {
    ok: true,
    projects: nextProjects,
    completedProject: resolved.project,
  };
}

/**
 * Force-complete an ACTIVE project (Phase 1), then claim via canonical claim batcher (Phase 2).
 *
 * @param {string} username
 * @param {string} projectId
 * @param {Object} [options]
 * @param {number} [options.now]
 * @param {{
 *   getProjects?: (username: string) => object[],
 *   persistComplete?: (username: string, projects: object[]) => Promise<{ ok: boolean, error?: string }>,
 *   commitClaim?: typeof commitProjectClaim,
 * }} [deps] - injectable for unit tests
 * @returns {Promise<object>}
 */
export async function adminCompleteActiveProject(username, projectId, options = {}, deps = {}) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }
  if (!projectId || typeof projectId !== 'string') {
    return { success: false, reason: 'invalid_project_id' };
  }

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const getProjects = deps.getProjects || ((user) => {
    const freshPlayer = player.getPlayer(user);
    return Array.isArray(freshPlayer?.projects) ? freshPlayer.projects : [];
  });
  const persistComplete = deps.persistComplete || (async (user, nextProjects) => {
    const safeProjects = await prepareProjectsForPersist(user, nextProjects);
    const ack = await db.updateAcknowledged({
      [`players/${user}/projects`]: safeProjects,
    });
    return { ok: ack.ok === true, error: ack.error };
  });
  const commitClaim = deps.commitClaim || commitProjectClaim;

  const built = buildAdminForceCompleteProjects(getProjects(username), projectId, now);
  if (!built.ok) {
    return { success: false, reason: built.reason || 'project_resolution_failed', phase: 1 };
  }

  // Phase 1: ACTIVE → COMPLETE only (no marker, no rewards).
  const phase1 = await persistComplete(username, built.projects);
  if (!phase1.ok) {
    return {
      success: false,
      reason: 'complete_write_failed',
      phase: 1,
      error: phase1.error || 'Could not save project completion.',
    };
  }

  // Phase 2: canonical COMPLETE → CLAIMED (+ fresh marker + rewards).
  // Do not pass in-memory projects — claim must see server COMPLETE after Phase 1.
  const claim = await commitClaim(username, projectId, { now });

  if (!claim.success) {
    return {
      success: false,
      reason: claim.reason || 'project_claim_failed',
      phase: 2,
      completed: true,
      error: claim.error,
      // Project remains COMPLETE; no rollback to ACTIVE.
    };
  }

  return {
    success: true,
    phase: 2,
    completed: true,
    claimed: true,
    project: claim.project,
    rpEarned: claim.rpEarned,
    revealCard: claim.revealCard || null,
    breakthroughCardGranted: claim.revealCard || null,
    notified: claim.notified || [],
    writeCount: (claim.writeCount || 0) + 1,
  };
}
