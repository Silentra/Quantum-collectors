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
import {
  buildProjectClaimedHistoryUpdate,
  buildProjectClaimFailedHistoryUpdate,
  buildProjectRefreshForfeitSkippedHistoryUpdate,
  sanitizeProjectClaimFailureError,
  PLAYER_HISTORY_ROOT,
} from './player-history.js';
import { scheduleHistoryRetentionAfterWrite } from './player-history-retention.js';
import { getAuth } from './firebase-config.js';
import {
  buildProjectClaimMarkerUpdate,
  loadProjectClaimMarkerExists,
  prepareProjectsForPersist,
  reconcileAlreadyClaimedProject,
} from './project-claims.js';
import {
  commitProjectLifecycleMaintenance,
  commitScheduledRefreshCatchUp,
} from './project-refresh-commit.js';
import {
  PROJECT_REFRESH_FORFEIT_THROUGH_FIELD,
  PROJECT_REFRESH_INTERVAL_MS,
  computeRefreshForfeitTarget,
  getProjectGenerationBlock,
} from './project-refresh.js';
import {
  STAT_KEYS,
  getPlayerStat,
  computeCardsAtMaxAuraFromInventory,
} from './achievement-stats.js';
import { planAchievementUpdatesForStats } from './achievement-mutations.js';

export { sanitizeProjectClaimFailureError };

/**
 * Best-effort observational history leaf after a genuine claim write_failed.
 * Never mutates gameplay paths; never throws.
 *
 * @param {string} username
 * @param {object} facts
 * @param {{
 *   writeUpdate?: (updates: object) => Promise<{ ok: boolean, error?: string }>,
 * }} [deps]
 * @returns {Promise<{ attempted: boolean, ok: boolean, error?: string, updates?: object }>}
 */
export async function persistProjectClaimFailedDiagnostic(username, facts, deps = {}) {
  try {
    const leaf = buildProjectClaimFailedHistoryUpdate(username, facts);
    const updates = leaf.updates || {};
    const paths = Object.keys(updates);
    for (const p of paths) {
      if (!p.startsWith(`${PLAYER_HISTORY_ROOT}/`)) {
        console.warn('[ProjectClaim] diagnostic history refused illegal path', p);
        return { attempted: false, ok: false, error: 'illegal_path' };
      }
    }
    const writeUpdate = deps.writeUpdate || ((u) => db.updateAcknowledged(u));
    const ack = await writeUpdate(updates);
    if (!ack.ok) {
      console.warn(
        '[ProjectClaim] diagnostic history write failed',
        { error: ack.error || 'unknown', projectId: facts?.projectId || null },
      );
      return { attempted: true, ok: false, error: ack.error || 'write_failed', updates };
    }
    return { attempted: true, ok: true, updates };
  } catch (err) {
    console.warn(
      '[ProjectClaim] diagnostic history write failed',
      { error: err?.message || String(err), projectId: facts?.projectId || null },
    );
    return { attempted: true, ok: false, error: err?.message || String(err) };
  }
}
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
 * Force-read server projects and locate one id.
 * @param {string} username
 * @param {string} projectId
 * @returns {Promise<{ projects: object[], project: object|null }>}
 */
export async function loadAuthoritativeProject(username, projectId) {
  const key = String(username || '').trim();
  const id = String(projectId || '').trim();
  try {
    await db.loadPathOnce(`players/${key}/projects`, { force: true });
  } catch { /* best-effort */ }
  const projects = Array.isArray(db.get(`players/${key}/projects`))
    ? db.get(`players/${key}/projects`)
    : [];
  const project = id
    ? (projects.find((p) => p && String(p.id) === id) || null)
    : null;
  return { projects, project };
}

/**
 * Force-read the refresh clock + pending forfeit marker (claim-time forfeiture).
 * @param {string} username
 * @returns {Promise<{ lastProjectRefreshAt: number, forfeitThrough: number }>}
 */
export async function loadClaimRefreshState(username) {
  const key = String(username || '').trim();
  await Promise.all([
    db.loadPathOnce(`players/${key}/lastProjectRefreshAt`, { force: true }).catch(() => {}),
    db.loadPathOnce(`players/${key}/${PROJECT_REFRESH_FORFEIT_THROUGH_FIELD}`, { force: true }).catch(() => {}),
  ]);
  return {
    lastProjectRefreshAt: Number(db.get(`players/${key}/lastProjectRefreshAt`)) || 0,
    forfeitThrough: Number(db.get(`players/${key}/${PROJECT_REFRESH_FORFEIT_THROUGH_FIELD}`)) || 0,
  };
}

/**
 * Pure: refresh-forfeit paths for the claim multipath, or null.
 *
 * Only when the student is at/over the completed storage cutoff BEFORE this
 * claim and at least one refresh cycle is due. Claiming is the only way to
 * fall below the cutoff, so forfeiting here guarantees blocked cycles never
 * become catch-up generation afterwards.
 *
 * @param {string} username
 * @param {object[]} projectsBeforeClaim - server-fresh array
 * @param {{ lastProjectRefreshAt: number, forfeitThrough?: number }|null} refreshState
 * @param {number} now
 * @returns {{
 *   updates: Record<string, unknown>,
 *   refreshAt: number,
 *   cycles: number,
 *   previousRefreshAt: number,
 *   forfeitThrough: number,
 *   completedCount: number,
 * }|null}
 */
export function planClaimRefreshForfeit(username, projectsBeforeClaim, refreshState, now) {
  const block = getProjectGenerationBlock(projectsBeforeClaim, now);
  if (block.reason !== 'completed_storage_full') return null;
  const last = Number(refreshState?.lastProjectRefreshAt) || 0;
  const target = computeRefreshForfeitTarget(last, now);
  if (!target) return null;
  const forfeitThrough = Number(refreshState?.forfeitThrough) || 0;
  /** @type {Record<string, unknown>} */
  const updates = {
    [`players/${username}/lastProjectRefreshAt`]: target.refreshAt,
  };
  if (forfeitThrough > 0 && target.refreshAt + PROJECT_REFRESH_INTERVAL_MS > forfeitThrough) {
    updates[`players/${username}/${PROJECT_REFRESH_FORFEIT_THROUGH_FIELD}`] = null;
  }
  return {
    updates,
    refreshAt: target.refreshAt,
    cycles: target.cycles,
    previousRefreshAt: last,
    forfeitThrough,
    completedCount: block.completedCount,
  };
}

/**
 * Build plan + acknowledged commit. Reveal only after ok.
 * @param {string} username
 * @param {string} projectId
 * @param {Object} [options]
 * @param {{
 *   loadMarkerExists?: typeof loadProjectClaimMarkerExists,
 *   loadAuthoritative?: typeof loadAuthoritativeProject,
 *   runLifecycle?: typeof commitProjectLifecycleMaintenance,
 *   prepareProjects?: typeof prepareProjectsForPersist,
 *   writeUpdate?: (updates: object) => Promise<{ ok: boolean, error?: string }>,
 *   buildPlan?: typeof buildProjectClaimPlan,
 *   persistFailureDiagnostic?: typeof persistProjectClaimFailedDiagnostic,
 *   loadRefreshState?: typeof loadClaimRefreshState,
 *   persistForfeitSkippedDiagnostic?: (username: string, facts: object) => Promise<unknown>,
 *   runCatchUp?: (username: string) => Promise<unknown>,
 * }} [deps] - injectable for unit tests
 * @returns {Promise<object>}
 */
export async function commitProjectClaim(username, projectId, options = {}, deps = {}) {
  return withProjectClaimLock(username, projectId, async () => {
    const loadMarkerExists = deps.loadMarkerExists || loadProjectClaimMarkerExists;
    const loadAuthoritative = deps.loadAuthoritative || loadAuthoritativeProject;
    const runLifecycle = deps.runLifecycle || commitProjectLifecycleMaintenance;
    const prepareProjects = deps.prepareProjects || prepareProjectsForPersist;
    const writeUpdate = deps.writeUpdate || ((updates) => db.updateAcknowledged(updates));
    const buildPlan = deps.buildPlan || buildProjectClaimPlan;
    const persistFailureDiagnostic = deps.persistFailureDiagnostic || persistProjectClaimFailedDiagnostic;
    const loadRefreshState = deps.loadRefreshState || loadClaimRefreshState;
    const persistForfeitSkippedDiagnostic = deps.persistForfeitSkippedDiagnostic
      || persistProjectRefreshForfeitSkippedDiagnostic;
    const runCatchUp = deps.runCatchUp || ((u) => commitScheduledRefreshCatchUp(u));
    const claimNow = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();

    // Fast local gate; server ledger is the real idempotency authority.
    if (await loadMarkerExists(username, projectId)) {
      await reconcileAlreadyClaimedProject(username, projectId);
      return {
        success: false,
        reason: 'already_claimed',
      };
    }

    // Authoritative server guard: never send ACTIVE→CLAIMED (or other illegal shapes).
    const authoritative = await loadAuthoritative(username, projectId);
    const serverProject = authoritative?.project ?? null;
    const serverProjectsBeforeClaim = Array.isArray(authoritative?.projects) ? authoritative.projects : [];
    if (serverProject && serverProject.state === PROJECT_STATES.CLAIMED) {
      await reconcileAlreadyClaimedProject(username, projectId);
      return {
        success: false,
        reason: 'already_claimed',
      };
    }
    if (!serverProject || serverProject.state !== PROJECT_STATES.COMPLETE) {
      try {
        await runLifecycle(username, { now: options.now });
      } catch { /* best-effort reconcile */ }
      return {
        success: false,
        reason: 'server_not_complete',
        serverState: serverProject?.state ?? null,
      };
    }

    const serverStateBeforeWrite = serverProject.state ?? null;
    const markerExistedBeforeWrite = false;
    const projectTitleBefore = serverProject.title != null ? String(serverProject.title) : null;

    // Revalidate from cache after lock (cache now matches force-read above).
    const plan = buildPlan(username, projectId, options);
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
      plan.updates[projectsPath] = await prepareProjects(username, plan.updates[projectsPath]);
      // After lifecycle-safe merge, target must still be CLAIMED intent on a prior COMPLETE.
      const merged = plan.updates[projectsPath];
      const mergedRow = Array.isArray(merged)
        ? merged.find((p) => p && String(p.id) === String(projectId))
        : null;
      if (!mergedRow || mergedRow.state !== PROJECT_STATES.CLAIMED) {
        try {
          await runLifecycle(username, { now: options.now });
        } catch { /* best-effort */ }
        return {
          success: false,
          reason: 'server_not_complete',
          serverState: mergedRow?.state ?? null,
        };
      }
    }

    // Overdue refresh forfeit rides in the SAME atomic claim write when the
    // student is at/over the storage cutoff before this claim.
    let forfeit = null;
    let refreshState = null;
    if (getProjectGenerationBlock(serverProjectsBeforeClaim, claimNow).reason === 'completed_storage_full') {
      try {
        refreshState = await loadRefreshState(username);
        forfeit = planClaimRefreshForfeit(username, serverProjectsBeforeClaim, refreshState, claimNow);
      } catch { /* forfeit is best-effort; claim proceeds */ }
    }

    const baseUpdates = plan.updates;
    /** @type {'none'|'atomic'|'atomic_retry'|'not_needed'|'skipped_marker_written'|'skipped_no_marker'} */
    let forfeitOutcome = 'none';
    let forfeitError = null;
    let ack;
    if (!forfeit) {
      ack = await writeUpdate(baseUpdates);
    } else {
      ack = await writeUpdate({ ...baseUpdates, ...forfeit.updates });
      if (ack.ok) {
        forfeitOutcome = 'atomic';
      } else {
        forfeitError = ack.error;
        if (!(await loadMarkerExists(username, projectId))) {
          // Another tab may have moved the refresh clock: recompute once.
          let freshRefresh = null;
          try { freshRefresh = await loadRefreshState(username); } catch { /* ignore */ }
          if (freshRefresh && freshRefresh.lastProjectRefreshAt !== forfeit.previousRefreshAt) {
            const retryForfeit = planClaimRefreshForfeit(
              username, serverProjectsBeforeClaim, freshRefresh, claimNow,
            );
            ack = await writeUpdate(retryForfeit ? { ...baseUpdates, ...retryForfeit.updates } : baseUpdates);
            if (ack.ok) {
              forfeitOutcome = retryForfeit ? 'atomic_retry' : 'not_needed';
            } else if (retryForfeit) {
              forfeit = retryForfeit;
              refreshState = freshRefresh;
            }
          }
          // Rewards first: commit the claim with a durable forfeit marker instead
          // of the clock write, then (last resort) exactly today's claim write.
          if (!ack.ok && !(await loadMarkerExists(username, projectId))) {
            const markerValue = Math.max(forfeit.refreshAt, Number(refreshState?.forfeitThrough) || 0);
            ack = await writeUpdate({
              ...baseUpdates,
              [`players/${username}/${PROJECT_REFRESH_FORFEIT_THROUGH_FIELD}`]: markerValue,
            });
            if (ack.ok) {
              forfeitOutcome = 'skipped_marker_written';
            } else if (!(await loadMarkerExists(username, projectId))) {
              ack = await writeUpdate(baseUpdates);
              if (ack.ok) forfeitOutcome = 'skipped_no_marker';
            }
          }
        }
      }
    }

    if (!ack.ok) {
      // Classify duplicate claim vs generic write failure via ledger / project state.
      if (await loadMarkerExists(username, projectId)) {
        console.warn('[ProjectClaim] claim write failed', {
          projectId: String(projectId || ''),
          reason: 'already_claimed',
          serverStateBeforeWrite,
          markerExistedBeforeWrite,
          serverStateAfterFailure: PROJECT_STATES.CLAIMED,
          markerExistsAfterFailure: true,
          ...sanitizeProjectClaimFailureError(ack.error),
        });
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
        console.warn('[ProjectClaim] claim write failed', {
          projectId: String(projectId || ''),
          reason: 'already_claimed',
          serverStateBeforeWrite,
          markerExistedBeforeWrite,
          serverStateAfterFailure: PROJECT_STATES.CLAIMED,
          markerExistsAfterFailure: false,
          ...sanitizeProjectClaimFailureError(ack.error),
        });
        return {
          success: false,
          reason: 'already_claimed',
        };
      }

      const sanitized = sanitizeProjectClaimFailureError(ack.error);
      const serverStateAfterFailure = live?.state ?? null;
      const markerExistsAfterFailure = false;
      const diagnostic = {
        projectId: String(projectId || ''),
        projectTitle: plan.claimedProject?.title || projectTitleBefore,
        reason: 'write_failed',
        serverStateBeforeWrite,
        markerExistedBeforeWrite,
        serverStateAfterFailure,
        markerExistsAfterFailure,
        errorCode: sanitized.errorCode,
        errorMessage: sanitized.errorMessage,
      };
      console.warn('[ProjectClaim] claim write failed', diagnostic);

      let actorUid = null;
      try {
        actorUid = getAuth()?.currentUser?.uid || null;
      } catch { /* ignore */ }

      try {
        await persistFailureDiagnostic(username, {
          ...diagnostic,
          actorUid,
        });
      } catch (err) {
        console.warn(
          '[ProjectClaim] diagnostic history write failed',
          { error: err?.message || String(err), projectId: String(projectId || '') },
        );
      }

      return {
        success: false,
        reason: 'write_failed',
        error: ack.error || 'Could not save claim. Check your connection and try again.',
      };
    }

    scheduleHistoryRetentionAfterWrite(plan.updates);

    if (forfeitOutcome === 'skipped_marker_written' || forfeitOutcome === 'skipped_no_marker') {
      await handleSkippedClaimRefreshForfeit(username, {
        projectId,
        projectTitle: plan.claimedProject?.title || projectTitleBefore,
        forfeit,
        markerWritten: forfeitOutcome === 'skipped_marker_written',
        error: forfeitError,
      }, { writeUpdate, persistForfeitSkippedDiagnostic, runCatchUp });
    }

    return {
      success: true,
      project: plan.claimedProject,
      rewards: plan.rewards,
      rpEarned: plan.rpEarned,
      revealCard: plan.revealCard,
      unlocked: plan.unlocked,
      notified: plan.notified,
      writeCount: 1,
      refreshForfeit: forfeitOutcome,
    };
  });
}

/**
 * Best-effort observational leaf for a claim that committed without its
 * atomic refresh forfeit. Never mutates gameplay; never throws.
 * @param {string} username
 * @param {object} facts
 * @param {{ writeUpdate?: (updates: object) => Promise<{ ok: boolean, error?: string }> }} [deps]
 */
export async function persistProjectRefreshForfeitSkippedDiagnostic(username, facts, deps = {}) {
  try {
    const leaf = buildProjectRefreshForfeitSkippedHistoryUpdate(username, facts);
    const updates = leaf.updates || {};
    for (const p of Object.keys(updates)) {
      if (!p.startsWith(`${PLAYER_HISTORY_ROOT}/`)) {
        return { attempted: false, ok: false, error: 'illegal_path' };
      }
    }
    const writeUpdate = deps.writeUpdate || ((u) => db.updateAcknowledged(u));
    const ack = await writeUpdate(updates);
    return { attempted: true, ok: ack.ok === true, error: ack.ok ? undefined : ack.error, updates };
  } catch (err) {
    return { attempted: true, ok: false, error: err?.message || String(err) };
  }
}

/**
 * After a claim committed without its refresh forfeit:
 * 1. diagnostic history leaf (monitoring),
 * 2. if the durable forfeit marker could not ride with the claim, write it alone,
 * 3. kick a catch-up run, which burns (never generates) cycles up to the marker.
 */
async function handleSkippedClaimRefreshForfeit(username, info, deps) {
  const markerPath = `players/${username}/${PROJECT_REFRESH_FORFEIT_THROUGH_FIELD}`;
  let markerWritten = info.markerWritten === true;
  if (!markerWritten && info.forfeit) {
    try {
      const markerValue = Math.max(info.forfeit.refreshAt, Number(info.forfeit.forfeitThrough) || 0);
      const ack = await deps.writeUpdate({ [markerPath]: markerValue });
      markerWritten = ack.ok === true;
    } catch { /* ignore */ }
  }

  const sanitized = sanitizeProjectClaimFailureError(info.error);
  console.warn('[ProjectClaim] claim committed without refresh forfeit', {
    projectId: String(info.projectId || ''),
    forfeitCycles: info.forfeit?.cycles ?? 0,
    forfeitThroughMarkerWritten: markerWritten,
    ...sanitized,
  });

  let actorUid = null;
  try {
    actorUid = getAuth()?.currentUser?.uid || null;
  } catch { /* ignore */ }
  try {
    await deps.persistForfeitSkippedDiagnostic(username, {
      projectId: String(info.projectId || ''),
      projectTitle: info.projectTitle || null,
      errorCode: sanitized.errorCode,
      errorMessage: sanitized.errorMessage,
      forfeitCycles: info.forfeit?.cycles ?? 0,
      forfeitThroughMarkerWritten: markerWritten,
      completedCountBeforeClaim: info.forfeit?.completedCount ?? 0,
      actorUid,
    });
  } catch { /* observational only */ }

  try {
    Promise.resolve(deps.runCatchUp(username)).catch(() => {});
  } catch { /* ignore */ }
}
