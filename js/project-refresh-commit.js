/**
 * project-refresh-commit.js
 * Canonical scheduled refresh mutation: one-cycle CAS + server-fresh merge.
 *
 * Login + research heartbeat must call commitScheduledRefreshCatchUp (and
 * optionally commitProjectLifecycleMaintenance for resolve/prune).
 */

import * as db from './database.js';
import * as player from './player.js';
import { planOneCycleRefresh } from './project-pool.js';
import { resolveProjectPool } from './project-resolution.js';
import { pruneProjects } from './project-claiming.js';
import {
  PROJECT_REFRESH_CATCHUP_MAX_STEPS,
  PROJECT_REFRESH_INTERVAL_MS,
} from './project-refresh.js';
import {
  buildRefreshPersistProjects,
  mergeLifecyclePersistProjects,
} from './project-refresh-merge.js';

/**
 * Force-read server projects + lastProjectRefreshAt into cache.
 * @param {string} username
 * @returns {Promise<{ projects: object[], lastProjectRefreshAt: number, totalRP: number }>}
 */
export async function loadServerRefreshState(username) {
  const key = String(username || '').trim();
  await Promise.all([
    db.loadPathOnce(`players/${key}/projects`, { force: true }).catch(() => {}),
    db.loadPathOnce(`players/${key}/lastProjectRefreshAt`, { force: true }).catch(() => {}),
    db.loadPathOnce(`players/${key}/totalResearchPoints`, { force: true }).catch(() => {}),
  ]);
  const projects = db.get(`players/${key}/projects`) || [];
  const lastProjectRefreshAt = Number(db.get(`players/${key}/lastProjectRefreshAt`)) || 0;
  const totalRP = Number(db.get(`players/${key}/totalResearchPoints`)) || 0;
  return {
    projects: Array.isArray(projects) ? projects : [],
    lastProjectRefreshAt,
    totalRP,
  };
}

/**
 * One acknowledged scheduled refresh step (exactly one cycle, or bootstrap).
 *
 * @param {string} username
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {{
 *   loadState?: typeof loadServerRefreshState,
 *   writeUpdate?: (updates: object) => Promise<{ ok: boolean, error?: string }>,
 * }} [deps]
 * @returns {Promise<object>}
 */
export async function commitScheduledRefreshStep(username, options = {}, deps = {}) {
  const key = String(username || '').trim();
  if (!key) return { ok: false, reason: 'invalid_username', wrote: false };

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const loadState = deps.loadState || loadServerRefreshState;
  const writeUpdate = deps.writeUpdate || (async (updates) => db.updateAcknowledged(updates));

  const state = await loadState(key);
  const plan = planOneCycleRefresh({
    projects: state.projects,
    totalRP: state.totalRP,
    lastRefreshAt: state.lastProjectRefreshAt,
    now,
  });

  if (!plan.due) {
    return {
      ok: true,
      wrote: false,
      reason: 'not_due',
      generatedCount: 0,
      refreshAt: state.lastProjectRefreshAt,
      previousRefreshAt: state.lastProjectRefreshAt,
      bootstrap: false,
      burned: false,
      generated: [],
    };
  }

  // Guard: non-bootstrap step must be exactly +INTERVAL from server value.
  if (!plan.bootstrap) {
    const expected = state.lastProjectRefreshAt + PROJECT_REFRESH_INTERVAL_MS;
    if (plan.refreshAt !== expected) {
      return {
        ok: false,
        wrote: false,
        reason: 'invalid_step_plan',
        generatedCount: 0,
        refreshAt: state.lastProjectRefreshAt,
      };
    }
  }

  const persistProjects = buildRefreshPersistProjects(state.projects, plan.generated);
  /** @type {Record<string, unknown>} */
  const updates = {
    [`players/${key}/lastProjectRefreshAt`]: plan.refreshAt,
  };
  if (plan.bootstrap || plan.generatedCount > 0) {
    updates[`players/${key}/projects`] = persistProjects;
  }
  // Full-pool burn: timestamp only (projects unchanged).

  const ack = await writeUpdate(updates);
  if (!ack.ok) {
    const errText = String(ack.error || '');
    const conflict = /permission_denied|PERMISSION_DENIED|denied/i.test(errText);
    return {
      ok: false,
      wrote: false,
      reason: conflict ? 'cas_rejected' : 'write_failed',
      error: ack.error,
      generatedCount: 0,
      plannedGenerated: plan.generated,
      refreshAt: state.lastProjectRefreshAt,
      previousRefreshAt: state.lastProjectRefreshAt,
      bootstrap: plan.bootstrap,
      conflict,
    };
  }

  return {
    ok: true,
    wrote: true,
    reason: plan.bootstrap ? 'bootstrap' : (plan.burned ? 'burned' : 'generated'),
    generatedCount: plan.generatedCount,
    generated: plan.generated,
    refreshAt: plan.refreshAt,
    previousRefreshAt: plan.previousRefreshAt,
    bootstrap: plan.bootstrap,
    burned: plan.burned,
  };
}

/**
 * Bounded catch-up: repeated one-cycle steps with one conflict retry per step.
 *
 * @param {string} username
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.maxSteps]
 * @param {object} [deps] - injectable for tests
 * @returns {Promise<object>}
 */
export async function commitScheduledRefreshCatchUp(username, options = {}, deps = {}) {
  const key = String(username || '').trim();
  if (!key) return { ok: false, reason: 'invalid_username', steps: [] };

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const maxSteps = Number.isFinite(Number(options.maxSteps))
    ? Math.max(0, Math.floor(Number(options.maxSteps)))
    : PROJECT_REFRESH_CATCHUP_MAX_STEPS;

  const stepFn = deps.commitStep || commitScheduledRefreshStep;
  const steps = [];
  let totalGenerated = 0;
  let lastRefreshAt = null;
  let networkFailed = false;

  for (let i = 0; i < maxSteps; i++) {
    let result = await stepFn(key, { now }, deps);

    if (!result.ok && (result.conflict || result.reason === 'cas_rejected')) {
      // Discard stale plan (do not reuse plannedGenerated). Force-read + one retry.
      result = await stepFn(key, { now }, deps);
      if (!result.ok && result.conflict) {
        // Peer likely won; treat as clean stop if not due after failed retry path
        const after = await (deps.loadState || loadServerRefreshState)(key);
        const replan = planOneCycleRefresh({
          projects: after.projects,
          totalRP: after.totalRP,
          lastRefreshAt: after.lastProjectRefreshAt,
          now,
        });
        if (!replan.due) {
          steps.push({ ...result, resolvedConflict: true, peerConsumed: true });
          lastRefreshAt = after.lastProjectRefreshAt;
          break;
        }
        networkFailed = true;
        steps.push(result);
        break;
      }
    }

    if (!result.ok && result.reason === 'write_failed' && !result.conflict) {
      networkFailed = true;
      steps.push(result);
      break;
    }

    if (!result.ok) {
      steps.push(result);
      break;
    }

    steps.push(result);
    if (result.refreshAt != null) lastRefreshAt = result.refreshAt;
    totalGenerated += result.generatedCount || 0;

    if (!result.wrote || result.reason === 'not_due') break;
    // Bootstrap is a single write; further steps may still be due if clock is old — allow loop
    if (!result.bootstrap && !result.wrote) break;
  }

  return {
    ok: !networkFailed,
    reason: networkFailed ? 'network_or_write_failed' : 'ok',
    steps,
    totalGenerated,
    refreshAt: lastRefreshAt,
    stepCount: steps.filter((s) => s.wrote).length,
  };
}

/**
 * ACTIVE→COMPLETE resolve + CLAIMED prune only (does not touch lastProjectRefreshAt).
 *
 * @param {string} username
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
export async function commitProjectLifecycleMaintenance(username, options = {}, deps = {}) {
  const key = String(username || '').trim();
  if (!key) return { ok: false, reason: 'invalid_username', wrote: false };

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const loadState = deps.loadState || loadServerRefreshState;
  const writeUpdate = deps.writeUpdate || (async (updates) => db.updateAcknowledged(updates));

  const state = await loadState(key);
  const resolved = resolveProjectPool({ projects: state.projects, now });
  const pruned = pruneProjects({ projects: resolved.projects, now });

  if (resolved.resolvedCount <= 0 && pruned.prunedCount <= 0) {
    return {
      ok: true,
      wrote: false,
      resolvedCount: 0,
      prunedCount: 0,
    };
  }

  const persistProjects = mergeLifecyclePersistProjects(state.projects, pruned.projects);
  const ack = await writeUpdate({
    [`players/${key}/projects`]: persistProjects,
  });

  if (!ack.ok) {
    return {
      ok: false,
      wrote: false,
      reason: 'write_failed',
      error: ack.error,
      resolvedCount: resolved.resolvedCount,
      prunedCount: pruned.prunedCount,
    };
  }

  // Best-effort cache hint for callers using player.getPlayer
  try {
    player.getPlayer(key);
  } catch { /* ignore */ }

  return {
    ok: true,
    wrote: true,
    resolvedCount: resolved.resolvedCount,
    prunedCount: pruned.prunedCount,
  };
}

/**
 * Login / heartbeat entry: catch-up refresh then lifecycle maintenance.
 * @param {string} username
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function runScheduledProjectMaintenance(username, options = {}, deps = {}) {
  const refresh = await commitScheduledRefreshCatchUp(username, options, deps);
  const lifecycle = await commitProjectLifecycleMaintenance(username, options, deps);
  return {
    ok: refresh.ok !== false && lifecycle.ok !== false,
    refresh,
    lifecycle,
    generatedCount: refresh.totalGenerated || 0,
    resolvedCount: lifecycle.resolvedCount || 0,
    prunedCount: lifecycle.prunedCount || 0,
    refreshAt: refresh.refreshAt,
  };
}
