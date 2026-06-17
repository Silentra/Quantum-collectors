/**
 * admin-player-tools.js
 * Canonical admin-only wrappers for testing and competition operations.
 *
 * UI should call these helpers instead of writing player/shop/project paths
 * directly for the admin tools added after the shop runtime layers.
 */

import * as db from './database.js';
import * as player from './player.js';
import * as cards from './cards.js';
import { getItemDefinition } from './cosmetic-definitions.js';
import { ITEM_TYPES } from './shop-definitions.js';
import { grantConsumable, unlockCosmetic } from './shop-mutations.js';
import { resolveCompletedProject } from './project-resolution.js';
import { claimProjectRewards } from './project-claiming.js';
import { PROJECT_STATES } from './project-state.js';
import { getProjectConfig } from './project-config.js';
import { addResearchPoints, addSeasonalResearchPoints, refreshUniqueCardsOwned } from './research.js';
import { addWeeklyPackRP, checkAndResetWeeklyCycle } from './weekly-research-pack.js';

function toPositiveInteger(value, fallback = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getBreakthroughCard(username) {
  const allCards = cards.getAllCards().filter(card => card.enabled !== false);
  if (allCards.length === 0) return null;

  const cfg = getProjectConfig();
  const odds = {
    common: 50,
    uncommon: 25,
    rare: 15,
    epic: 8,
    legendary: 2,
    ...(cfg.breakthroughCardRarityWeights || {}),
  };
  const total = Object.values(odds).reduce((sum, value) => sum + Number(value || 0), 0);
  let roll = Math.random() * (total > 0 ? total : 1);
  const rarityOrder = ['legendary', 'epic', 'rare', 'uncommon', 'common'];
  let rarity = 'common';
  for (const candidate of rarityOrder) {
    const weight = Number(odds[candidate] || 0);
    if (roll < weight) {
      rarity = candidate;
      break;
    }
    roll -= weight;
  }

  const matching = allCards.filter(card => card.rarity === rarity);
  const pool = matching.length > 0 ? matching : allCards;
  const card = pool[Math.floor(Math.random() * pool.length)];
  if (!card?.id) return null;

  player.addCard(username, card.id, 1);
  refreshUniqueCardsOwned(username);
  return card;
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

export function adminCompleteActiveProject(username, projectId, options = {}) {
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

  const claimed = claimProjectRewards({ project: resolved.project, claimedAt: now });
  if (!claimed.claimed) {
    return { success: false, reason: claimed.reason || 'project_claim_failed' };
  }

  let rpEarned = 0;
  let breakthroughCardGranted = null;
  const updates = {};
  if (claimed.rewards?.success === true) {
    rpEarned = Number(claimed.rewards.rpEarned || 0);
    if (rpEarned > 0) {
      addResearchPoints(username, rpEarned);
      addSeasonalResearchPoints(username, rpEarned);
      checkAndResetWeeklyCycle(username);
      addWeeklyPackRP(username, rpEarned);
    }
    updates.projectsCompleted = (freshPlayer.projectsCompleted || 0) + 1;

    if (claimed.rewards?.breakthrough === true) {
      updates.researchStats = {
        ...(freshPlayer.researchStats || {}),
        breakthroughs: Number(freshPlayer.researchStats?.breakthroughs || 0) + 1,
      };
    }
  }

  for (const reward of claimed.rewards?.rewards || []) {
    if (reward?.type !== 'card') continue;
    if (reward.card != null) {
      const cardId = reward.card.id || reward.card.cardId || null;
      if (cardId) {
        player.addCard(username, cardId, 1);
        refreshUniqueCardsOwned(username);
        breakthroughCardGranted = reward.card;
      }
    } else {
      breakthroughCardGranted = getBreakthroughCard(username);
    }
  }

  const updatedProjects = projects.map(project =>
    project.id === claimed.project.id ? claimed.project : project
  );
  player.updatePlayer(username, {
    ...updates,
    projects: updatedProjects,
  });

  return {
    success: true,
    project: claimed.project,
    rpEarned,
    breakthroughCardGranted,
  };
}
