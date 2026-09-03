/**
 * project-claim-plan.js
 *
 * Pure claim write-plan + acknowledged commit for Research Project rewards.
 * Preserves COMPLETE → CLAIMED product boundary; does not resolve ACTIVE projects.
 *
 * Parity sources (field-by-field):
 *   claimProjectRewards          — state flip + reward extraction
 *   addResearchPoints            — totalResearchPoints + currencies.currentResearchPoints
 *   addSeasonalResearchPoints    — seasonalResearchPoints
 *   checkAndResetWeeklyCycle + addWeeklyPackRP — weekly reset then progress add
 *     (does NOT auto-claim weekly pack when crossing getWeeklyRPRequired)
 *   recordProjectResolution      — streak / best / projectsCompleted (failure resets streak only)
 *   recordBreakthrough           — researchStats/breakthroughs += 1
 *   player.addCard + discovery   — inventory, cardsCollected, unique/aura stats
 *   planAchievementUpdatesForStats — same evaluator as pack-open / live eval
 *
 * Admin note: historically adminCompleteActiveProject bumped projectsCompleted /
 * breakthroughs inline and skipped recordProjectOutcome / recordBreakthroughEarned
 * (no streak, weaker achievements). Routing admin through this planner intentionally
 * corrects that divergence to match the student claim path.
 */

import * as db from './database.js';
import * as cards from './cards.js';
import { claimProjectRewards } from './project-claiming.js';
import { PROJECT_STATES } from './project-state.js';
import { getProjectConfig } from './project-config.js';
import {
  buildResearchPointGrantUpdates,
  buildSeasonalResearchPointGrantUpdates,
  computeUniqueCardsOwnedFromInventory,
} from './research.js';
import { buildWeeklyPackRpGrantUpdates } from './weekly-research-pack.js';
import { buildProjectClaimedHistoryUpdate } from './player-history.js';
import { scheduleHistoryRetentionAfterWrite } from './player-history-retention.js';
import { getAuth } from './firebase-config.js';
import {
  buildProjectClaimMarkerUpdate,
  loadProjectClaimMarkerExists,
  prepareProjectsForPersist,
  reconcileAlreadyClaimedProject,
} from './project-claims.js';
import {
  STAT_KEYS,
  getPlayerStat,
  computeCardsAtMaxAuraFromInventory,
} from './achievement-stats.js';
import { planAchievementUpdatesForStats } from './achievement-mutations.js';
import {
  STAT_TYPES,
  buildLeaderboardSummaryPathsForChangedStats,
  playerLikeWithStatOverlay,
} from './leaderboard-summaries.js';

/**
 * Pick one breakthrough reward card (pack-style rarity weights). No inventory writes.
 * Shared by student/admin claim planning.
 * @returns {object|null}
 */
export function pickBreakthroughRewardCard() {
  const allCards = cards.getAllCards().filter(c => c.enabled !== false);
  if (allCards.length === 0) {
    console.warn('[ResearchProjects] Breakthrough card: no enabled cards in DB');
    return null;
  }

  const cfg = getProjectConfig();
  const odds = Object.assign(
    { common: 50, uncommon: 25, rare: 15, epic: 8, legendary: 2 },
    cfg.breakthroughCardRarityWeights ?? {}
  );

  const total = Object.values(odds).reduce((s, v) => s + (Number(v) || 0), 0);
  let roll = Math.random() * (total > 0 ? total : 1);
  const rarityOrder = ['legendary', 'epic', 'rare', 'uncommon', 'common'];
  let rarity = 'common';
  for (const r of rarityOrder) {
    const weight = Number(odds[r] || 0);
    if (roll < weight) {
      rarity = r;
      break;
    }
    roll -= weight;
  }

  const matching = allCards.filter(c => c.rarity === rarity);
  const pool = matching.length > 0 ? matching : allCards;
  const card = pool[Math.floor(Math.random() * pool.length)];
  return card?.id ? card : null;
}

/**
 * RTDB multi-path updates cannot include both an ancestor and a descendant.
 * @param {Object} updates
 */
export function assertNoOverlappingUpdatePaths(updates) {
  const paths = Object.keys(updates || {}).sort();
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (paths[j].startsWith(`${paths[i]}/`) || paths[i].startsWith(`${paths[j]}/`)) {
        throw new Error(`[ProjectClaim] Overlapping update paths: ${paths[i]} vs ${paths[j]}`);
      }
    }
  }
}

/**
 * @param {string} username
 * @param {string} projectId
 * @param {Object} [options]
 * @param {number} [options.now]
 * @param {object[]} [options.projects] - cache/override list (admin in-memory resolve)
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   updates?: Object,
 *   claimedProject?: object,
 *   rewards?: object,
 *   rpEarned?: number,
 *   revealCard?: object|null,
 *   unlocked?: string[],
 *   notified?: string[],
 * }}
 */
export function buildProjectClaimPlan(username, projectId, options = {}) {
  if (!username || !projectId) {
    return { ok: false, reason: 'invalid_request' };
  }

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const allProjects = Array.isArray(options.projects)
    ? options.projects
    : (db.get(`players/${username}/projects`) || []);

  const freshProject = allProjects.find(pr => pr?.id === projectId);
  if (!freshProject) {
    return { ok: false, reason: 'project_not_found' };
  }
  if (freshProject.state === PROJECT_STATES.CLAIMED) {
    return { ok: false, reason: 'already_claimed' };
  }
  if (freshProject.state !== PROJECT_STATES.COMPLETE) {
    return { ok: false, reason: 'invalid_project_state' };
  }

  const claimResult = claimProjectRewards({ project: freshProject, claimedAt: now });
  if (!claimResult.claimed) {
    return { ok: false, reason: claimResult.reason || 'claim_failed' };
  }

  let claimedProject = claimResult.project;
  const rewards = claimResult.rewards;
  const success = rewards?.success === true;
  const rpEarned = success ? Number(rewards?.rpEarned ?? 0) : 0;
  const isBreakthrough = success && rewards?.breakthrough === true;

  // Resolve all card reward rows; generate once for null breakthrough placeholders.
  const rewardItems = Array.isArray(rewards?.rewards) ? [...rewards.rewards] : [];
  const gainsByCardId = {};
  let revealCard = null;
  const resolvedRewardItems = [];

  for (const row of rewardItems) {
    if (!row || row.type !== 'card') {
      resolvedRewardItems.push(row);
      continue;
    }

    let cardObj = row.card;
    if (cardObj == null) {
      cardObj = pickBreakthroughRewardCard();
    }
    const cardId = cardObj?.id ?? cardObj?.cardId ?? null;
    if (cardId) {
      gainsByCardId[cardId] = (gainsByCardId[cardId] || 0) + 1;
      revealCard = cardObj;
      resolvedRewardItems.push({ ...row, card: cardObj });
    } else {
      resolvedRewardItems.push(row);
    }
  }

  // Persist generated card identities on the CLAIMED project (UI must match DB).
  if (rewards && Array.isArray(rewards.rewards)) {
    claimedProject = {
      ...claimedProject,
      rewards: {
        ...rewards,
        rewards: resolvedRewardItems,
      },
    };
  }

  const updatedProjects = allProjects.map(pr =>
    pr.id === claimedProject.id ? claimedProject : pr
  );

  const updates = {
    [`players/${username}/projects`]: updatedProjects,
  };

  // Immutable claim-once ledger leaf (same multipath as rewards).
  Object.assign(
    updates,
    buildProjectClaimMarkerUpdate(username, claimedProject.id || projectId, now).updates,
  );

  const plannedStatValues = {};
  const achStatKeys = [];

  // ── RP grants (success + rpEarned > 0 only) — same gate as project-ui claim ──
  if (success && rpEarned > 0) {
    const lifetime = buildResearchPointGrantUpdates(username, rpEarned);
    Object.assign(updates, lifetime.updates);
    plannedStatValues[STAT_KEYS.TOTAL_RESEARCH_POINTS] = lifetime.newTotal;
    achStatKeys.push(STAT_KEYS.TOTAL_RESEARCH_POINTS);

    const seasonal = buildSeasonalResearchPointGrantUpdates(username, rpEarned);
    Object.assign(updates, seasonal.updates);

    // Parity: checkAndResetWeeklyCycle then addWeeklyPackRP (folded; no mid-write).
    // Crossing getWeeklyRPRequired does not grant a pack here — claimWeeklyPack is separate.
    const weekly = buildWeeklyPackRpGrantUpdates(username, rpEarned, now);
    Object.assign(updates, weekly.updates);
  }

  // ── Project outcome stats (recordProjectResolution parity) ──
  if (success) {
    const prevStreak = Number(db.get(`players/${username}/stats/projectSuccessStreak`)) || 0;
    const nextStreak = prevStreak + 1;
    updates[`players/${username}/stats/projectSuccessStreak`] = nextStreak;

    const prevBest = getPlayerStat(username, STAT_KEYS.BEST_PROJECT_SUCCESS_STREAK);
    const nextBest = Math.max(prevBest, nextStreak);
    if (nextBest !== prevBest) {
      updates[`players/${username}/stats/bestProjectSuccessStreak`] = nextBest;
      plannedStatValues[STAT_KEYS.BEST_PROJECT_SUCCESS_STREAK] = nextBest;
      achStatKeys.push(STAT_KEYS.BEST_PROJECT_SUCCESS_STREAK);
    }

    const prevCompleted = getPlayerStat(username, STAT_KEYS.PROJECTS_COMPLETED);
    const nextCompleted = prevCompleted + 1;
    updates[`players/${username}/projectsCompleted`] = nextCompleted;
    plannedStatValues[STAT_KEYS.PROJECTS_COMPLETED] = nextCompleted;
    achStatKeys.push(STAT_KEYS.PROJECTS_COMPLETED);

    if (isBreakthrough) {
      const prevBreak = getPlayerStat(username, STAT_KEYS.BREAKTHROUGHS_ACHIEVED);
      const nextBreak = prevBreak + 1;
      // Child path only — never write whole researchStats (overlap hazard).
      updates[`players/${username}/researchStats/breakthroughs`] = nextBreak;
      plannedStatValues[STAT_KEYS.BREAKTHROUGHS_ACHIEVED] = nextBreak;
      achStatKeys.push(STAT_KEYS.BREAKTHROUGHS_ACHIEVED);
    }
  } else {
    const prevStreak = Number(db.get(`players/${username}/stats/projectSuccessStreak`)) || 0;
    if (prevStreak !== 0) {
      updates[`players/${username}/stats/projectSuccessStreak`] = 0;
    }
    // Failure path historically did not push achievement statKeys — preserve that.
  }

  // ── Card inventory (all card reward rows; aggregate duplicates) ──
  const prevInventory = { ...(db.get(`players/${username}/inventory`) || {}) };
  const nextInventory = { ...prevInventory };
  let discoveryDelta = 0;
  let cardsGrantedCount = 0;

  for (const [cardId, gain] of Object.entries(gainsByCardId)) {
    const prevQty = typeof prevInventory[cardId] === 'number' ? prevInventory[cardId] : 0;
    const nextQty = prevQty + gain;
    nextInventory[cardId] = nextQty;
    updates[`players/${username}/inventory/${cardId}`] = nextQty;
    cardsGrantedCount += gain;
    if (prevQty === 0 && nextQty > 0) discoveryDelta += 1;
  }

  if (cardsGrantedCount > 0) {
    const prevCollected = Number(db.get(`players/${username}/stats/cardsCollected`)) || 0;
    updates[`players/${username}/stats/cardsCollected`] = prevCollected + cardsGrantedCount;

    const prevDiscovered = getPlayerStat(username, STAT_KEYS.UNIQUE_CARDS_DISCOVERED);
    const nextDiscovered = prevDiscovered + discoveryDelta;
    if (discoveryDelta > 0) {
      updates[`players/${username}/stats/uniqueCardsDiscovered`] = nextDiscovered;
      plannedStatValues[STAT_KEYS.UNIQUE_CARDS_DISCOVERED] = nextDiscovered;
      achStatKeys.push(STAT_KEYS.UNIQUE_CARDS_DISCOVERED);
    }

    const prevUnique = getPlayerStat(username, STAT_KEYS.UNIQUE_CARDS_OWNED);
    const nextUnique = computeUniqueCardsOwnedFromInventory(nextInventory);
    if (nextUnique !== prevUnique) {
      updates[`players/${username}/stats/uniqueCardsOwned`] = nextUnique;
    }
    plannedStatValues[STAT_KEYS.UNIQUE_CARDS_OWNED] = nextUnique;
    achStatKeys.push(STAT_KEYS.UNIQUE_CARDS_OWNED);

    const prevAura = getPlayerStat(username, STAT_KEYS.MAX_CARD_AURA_TIER);
    const nextAura = computeCardsAtMaxAuraFromInventory(nextInventory);
    if (nextAura !== prevAura) {
      updates[`players/${username}/stats/maxCardAuraTier`] = nextAura;
      plannedStatValues[STAT_KEYS.MAX_CARD_AURA_TIER] = nextAura;
      achStatKeys.push(STAT_KEYS.MAX_CARD_AURA_TIER);
    }
  }

  const getStat = (statKey) => {
    if (Object.prototype.hasOwnProperty.call(plannedStatValues, statKey)) {
      return plannedStatValues[statKey];
    }
    return getPlayerStat(username, statKey);
  };

  const achPlan = planAchievementUpdatesForStats(username, [...new Set(achStatKeys)], {
    getStat,
    now,
  });
  Object.assign(updates, achPlan.updates);

  const playerBefore = db.get(`players/${username}`) || {};
  /** @type {Record<string, number>} */
  const lbOverlay = {};
  /** @type {string[]} */
  const lbChanged = [];
  // Lifetime/seasonal summary paths already come from RP grant builders when assigned above.
  if (Object.prototype.hasOwnProperty.call(plannedStatValues, STAT_KEYS.PROJECTS_COMPLETED)) {
    lbOverlay[STAT_TYPES.PROJECTS_COMPLETED] = plannedStatValues[STAT_KEYS.PROJECTS_COMPLETED];
    lbChanged.push(STAT_TYPES.PROJECTS_COMPLETED);
  }
  if (Object.prototype.hasOwnProperty.call(plannedStatValues, STAT_KEYS.BREAKTHROUGHS_ACHIEVED)) {
    lbOverlay[STAT_TYPES.BREAKTHROUGHS] = plannedStatValues[STAT_KEYS.BREAKTHROUGHS_ACHIEVED];
    lbChanged.push(STAT_TYPES.BREAKTHROUGHS);
  }
  if (Object.prototype.hasOwnProperty.call(plannedStatValues, STAT_KEYS.UNIQUE_CARDS_OWNED)) {
    lbOverlay[STAT_TYPES.UNIQUE_CARDS_OWNED] = plannedStatValues[STAT_KEYS.UNIQUE_CARDS_OWNED];
    lbChanged.push(STAT_TYPES.UNIQUE_CARDS_OWNED);
  }
  if (lbChanged.length > 0) {
    Object.assign(
      updates,
      buildLeaderboardSummaryPathsForChangedStats(
        username,
        playerLikeWithStatOverlay(playerBefore, lbOverlay),
        lbChanged,
        now,
      ),
    );
  }

  let actorUid = null;
  try {
    actorUid = getAuth().currentUser?.uid || null;
  } catch { /* Auth not ready */ }

  const history = buildProjectClaimedHistoryUpdate(username, {
    projectId: claimedProject.id || projectId,
    rpDelta: success ? rpEarned : 0,
    breakthrough: isBreakthrough,
    cardsGranted: gainsByCardId,
    success,
    actorUid,
  });
  Object.assign(updates, history.updates);

  assertNoOverlappingUpdatePaths(updates);

  return {
    ok: true,
    updates,
    claimedProject,
    rewards: claimedProject.rewards,
    rpEarned: success ? rpEarned : 0,
    revealCard,
    unlocked: achPlan.unlocked,
    notified: achPlan.notified,
    historyEventId: history.eventId,
    writeCount: 1,
  };
}

/**
 * Serialize claim for username+projectId across tabs when navigator.locks exists.
 * @template T
 * @param {string} username
 * @param {string} projectId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withProjectClaimLock(username, projectId, fn) {
  const lockName = `qc-project-claim:${username}:${projectId}`;
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(lockName, { mode: 'exclusive' }, () => fn());
  }
  return fn();
}

/**
 * Build plan + acknowledged commit. Reveal only after ok.
 * @param {string} username
 * @param {string} projectId
 * @param {Object} [options]
 * @returns {Promise<object>}
 */
export async function commitProjectClaim(username, projectId, options = {}) {
  return withProjectClaimLock(username, projectId, async () => {
    // Fast local gate; server ledger is the real idempotency authority.
    if (await loadProjectClaimMarkerExists(username, projectId)) {
      await reconcileAlreadyClaimedProject(username, projectId);
      return {
        success: false,
        reason: 'already_claimed',
      };
    }

    // Revalidate from cache after lock (Option B for project array; ledger is create-once).
    const plan = buildProjectClaimPlan(username, projectId, options);
    if (!plan.ok) {
      if (plan.reason === 'already_claimed') {
        await reconcileAlreadyClaimedProject(username, projectId);
      }
      return {
        success: false,
        reason: plan.reason || 'claim_failed',
      };
    }

    const projectsPath = `players/${username}/projects`;
    if (plan.updates[projectsPath]) {
      plan.updates[projectsPath] = await prepareProjectsForPersist(
        username,
        plan.updates[projectsPath],
      );
    }

    const ack = await db.updateAcknowledged(plan.updates);
    if (!ack.ok) {
      // Classify duplicate claim vs generic write failure via ledger / project state.
      if (await loadProjectClaimMarkerExists(username, projectId)) {
        await reconcileAlreadyClaimedProject(username, projectId);
        return {
          success: false,
          reason: 'already_claimed',
        };
      }
      try {
        await db.loadPathOnce(`players/${username}/projects`, { force: true });
      } catch { /* best-effort */ }
      const projects = db.get(`players/${username}/projects`) || [];
      const live = Array.isArray(projects)
        ? projects.find((p) => p && String(p.id) === String(projectId))
        : null;
      if (live && live.state === PROJECT_STATES.CLAIMED) {
        return {
          success: false,
          reason: 'already_claimed',
        };
      }
      return {
        success: false,
        reason: 'write_failed',
        error: ack.error || 'Could not save claim. Check your connection and try again.',
      };
    }

    scheduleHistoryRetentionAfterWrite(plan.updates);

    return {
      success: true,
      project: plan.claimedProject,
      rewards: plan.rewards,
      rpEarned: plan.rpEarned,
      revealCard: plan.revealCard,
      unlocked: plan.unlocked,
      notified: plan.notified,
      writeCount: 1,
    };
  });
}
