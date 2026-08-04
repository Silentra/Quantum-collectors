/**
 * admin-player-tools.js
 * Canonical admin-only wrappers for testing and competition operations.
 *
 * UI should call these helpers instead of writing player/shop/project paths
 * directly for the admin tools added after the shop runtime layers.
 *
 * adminCompleteActiveProject: force-timer resolve in memory, then claim through
 * the canonical batched claim planner (same streaks/achievements/RP/cards as
 * student Claim Rewards). This intentionally corrects the former admin path that
 * skipped recordProjectOutcome / recordBreakthroughEarned.
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
 * Force-complete an ACTIVE project and claim rewards via the canonical claim batcher.
 * @returns {Promise<object>}
 */
export async function adminCompleteActiveProject(username, projectId, options = {}) {
  if (!username || typeof username !== 'string') {
    return { success: false, reason: 'invalid_username' };
  }
  if (!projectId || typeof projectId !== 'string') {
    return { success: false, reason: 'invalid_project_id' };
  }

  const freshPlayer = player.getPlayer(username);
  const projects = Array.isArray(freshPlayer?.projects) ? freshPlayer.projects : [];
  const activeProject = projects.find(project => project?.id === projectId);
  if (!activeProject) return { success: false, reason: 'project_not_found' };
  if (activeProject.state !== PROJECT_STATES.ACTIVE) {
    return { success: false, reason: 'project_not_active' };
  }

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const resolutionInput = {
    ...activeProject,
    completesAt: now,
  };
  const resolved = resolveCompletedProject({ project: resolutionInput, now });
  if (!resolved.resolved) {
    return { success: false, reason: resolved.reason || 'project_resolution_failed' };
  }

  // In-memory COMPLETE snapshot for claim planner (student path reads COMPLETE from DB).
  const projectsWithComplete = projects.map(project =>
    project.id === resolved.project.id ? resolved.project : project
  );

  const claim = await commitProjectClaim(username, projectId, {
    now,
    projects: projectsWithComplete,
  });

  if (!claim.success) {
    return {
      success: false,
      reason: claim.reason || 'project_claim_failed',
      error: claim.error,
    };
  }

  return {
    success: true,
    project: claim.project,
    rpEarned: claim.rpEarned,
    revealCard: claim.revealCard || null,
    breakthroughCardGranted: claim.revealCard || null,
    notified: claim.notified || [],
    writeCount: claim.writeCount,
  };
}
