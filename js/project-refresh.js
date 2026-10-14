// project-refresh.js
// Phase 3A-2 — Pure scheduling helper for project refresh cadence and capacity.
// NO side effects, NO storage, NO timers, NO Firebase, NO DOM.

import { getProjectConfig } from './project-config.js';
import { PROJECT_STATES } from './project-state.js';

/**
 * Cap on AVAILABLE + ACTIVE projects (the "Projects: X / 7 Active" slots).
 * COMPLETE and CLAIMED rows do not count toward this cap.
 */
export const MAX_STORED_PROJECTS = 7;

/**
 * Technical capacity of the stored projects array (all states combined).
 *
 * COUPLING: database.rules.json per-row project rules accept indices
 * 0..PROJECT_ARRAY_CAPACITY-1 only and scan that range for claim/transition
 * history (scripts/gen-claim-rules-snippets.mjs). Generation must never grow
 * the array past this length.
 */
export const PROJECT_ARRAY_CAPACITY = 40;

/** Completed-but-unclaimed count at which the storage warning appears. */
export const COMPLETED_STORAGE_WARNING_THRESHOLD = 10;

/** Completed-but-unclaimed count at which all new project generation stops. */
export const COMPLETED_GENERATION_CUTOFF = 14;

/**
 * players/{u}/<field>: refresh cycles at or before this timestamp are forfeited
 * and must never generate. Written when a claim had to commit without its
 * atomic refresh forfeit; cleared once lastProjectRefreshAt reaches it.
 */
export const PROJECT_REFRESH_FORFEIT_THROUGH_FIELD = 'projectRefreshForfeitThrough';

/**
 * Canonical scheduled refresh interval (production CAS + RTDB rules).
 *
 * COUPLING: database.rules.json `lastProjectRefreshAt` validate uses this
 * exact millisecond literal (12h). Keep in sync via
 * scripts/gen-claim-rules-snippets.mjs + inject-claim-rules.mjs and the
 * integrity regression that asserts equality.
 *
 * Live admin `projectRefreshHours` does NOT change the CAS step size; a
 * non-12h config would desync client intent from rules. Scheduling always
 * uses this constant.
 */
export const PROJECT_REFRESH_INTERVAL_HOURS = 12;
export const PROJECT_REFRESH_INTERVAL_MS =
  PROJECT_REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;

/** Max one-cycle CAS catch-up iterations per login/heartbeat invocation. */
export const PROJECT_REFRESH_CATCHUP_MAX_STEPS = MAX_STORED_PROJECTS;

/**
 * Returns the configured refresh interval in hours (UI/config display).
 * Scheduling / CAS uses {@link PROJECT_REFRESH_INTERVAL_HOURS} exclusively.
 * @returns {number}
 */
export function getProjectRefreshHours() {
  const cfg = getProjectConfig();
  const h = cfg.projectRefreshHours;
  return (typeof h === 'number' && h > 0) ? h : PROJECT_REFRESH_INTERVAL_HOURS;
}

/**
 * Returns the refresh interval in milliseconds used for scheduled generation CAS.
 * Always the canonical 12h constant (must match RTDB rules).
 * @returns {number}
 */
export function getProjectRefreshIntervalMs() {
  return PROJECT_REFRESH_INTERVAL_MS;
}

/**
 * Determines whether enough time has elapsed since the last refresh.
 * @param {{ lastRefreshAt?: number, now?: number }} options
 * @returns {boolean}
 */
export function needsProjectRefresh({ lastRefreshAt = 0, now = Date.now() } = {}) {
  return (now - lastRefreshAt) >= getProjectRefreshIntervalMs();
}

/**
 * Returns the maximum number of stored projects (the cap).
 * @returns {number}
 */
export function getMaxStoredProjects() {
  return MAX_STORED_PROJECTS;
}

/**
 * Returns the number of available project slots remaining before hitting the cap.
 * Minimum return value is 0.
 *
 * IMPORTANT: activeProjectCount should include ONLY projects in AVAILABLE or
 * ACTIVE states. COMPLETE and CLAIMED projects do NOT count toward the cap.
 *
 * @param {number} activeProjectCount - Count of AVAILABLE + ACTIVE projects only.
 * @returns {number}
 */
export function getAvailableProjectSlots(activeProjectCount = 0) {
  return Math.max(0, MAX_STORED_PROJECTS - activeProjectCount);
}

/**
 * Returns true only if the project count is below the cap AND the refresh
 * interval has elapsed. Both conditions must be met.
 *
 * @param {{ currentActiveProjects?: number, lastRefreshAt?: number, now?: number }} options
 * @returns {boolean}
 */
export function shouldGenerateProjects({
  currentActiveProjects = 0,
  lastRefreshAt = 0,
  now = Date.now()
} = {}) {
  return getAvailableProjectSlots(currentActiveProjects) > 0
    && needsProjectRefresh({ lastRefreshAt, now });
}

/**
 * Completed-but-unclaimed projects: COMPLETE rows plus ACTIVE rows whose
 * completesAt has passed (finished but not yet resolved by maintenance).
 *
 * @param {object[]} projects
 * @param {number} [now]
 * @returns {number}
 */
export function countCompletedUnclaimedProjects(projects, now = Date.now()) {
  const list = Array.isArray(projects) ? projects : [];
  let count = 0;
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    if (p.state === PROJECT_STATES.COMPLETE) {
      count++;
    } else if (
      p.state === PROJECT_STATES.ACTIVE
      && p.completesAt != null
      && Number(now) >= Number(p.completesAt)
    ) {
      count++;
    }
  }
  return count;
}

/**
 * @param {number} completedCount
 * @returns {'none'|'warn'|'full'}
 */
export function getProjectStorageLevel(completedCount) {
  const n = Number(completedCount) || 0;
  if (n >= COMPLETED_GENERATION_CUTOFF) return 'full';
  if (n >= COMPLETED_STORAGE_WARNING_THRESHOLD) return 'warn';
  return 'none';
}

/**
 * Remaining rows before the technical array capacity is reached.
 * @param {object[]} projects
 * @returns {number}
 */
export function getProjectArrayRoom(projects) {
  const len = Array.isArray(projects) ? projects.length : 0;
  return Math.max(0, PROJECT_ARRAY_CAPACITY - len);
}

/**
 * Whether ANY new project may be generated (refresh, catch-up, bootstrap, Proposal).
 * Existing projects stay fully usable regardless.
 *
 * @param {object[]} projects
 * @param {number} [now]
 * @returns {{
 *   blocked: boolean,
 *   reason: 'completed_storage_full'|'project_array_full'|null,
 *   completedCount: number,
 *   arrayLength: number,
 * }}
 */
export function getProjectGenerationBlock(projects, now = Date.now()) {
  const list = Array.isArray(projects) ? projects : [];
  const completedCount = countCompletedUnclaimedProjects(list, now);
  const arrayLength = list.length;
  let reason = null;
  if (completedCount >= COMPLETED_GENERATION_CUTOFF) {
    reason = 'completed_storage_full';
  } else if (arrayLength >= PROJECT_ARRAY_CAPACITY) {
    reason = 'project_array_full';
  }
  return { blocked: reason !== null, reason, completedCount, arrayLength };
}

/**
 * @param {object[]} projects
 * @param {number} [now]
 * @returns {boolean}
 */
export function isProjectGenerationBlocked(projects, now = Date.now()) {
  return getProjectGenerationBlock(projects, now).blocked;
}

/**
 * Forfeit every elapsed refresh cycle in one aligned jump.
 *
 * Returns the greatest `lastRefreshAt + k * interval` (k >= 1) that is <= now,
 * or null when no cycle is due / the clock is uninitialized. Matches the
 * rules' forward-only, 12h-aligned fast-forward validation.
 *
 * @param {number} lastRefreshAt
 * @param {number} [now]
 * @returns {{ refreshAt: number, cycles: number }|null}
 */
export function computeRefreshForfeitTarget(lastRefreshAt, now = Date.now()) {
  const last = Number(lastRefreshAt) || 0;
  if (last <= 0) return null;
  const cycles = Math.floor((Number(now) - last) / PROJECT_REFRESH_INTERVAL_MS);
  if (!Number.isFinite(cycles) || cycles < 1) return null;
  return { refreshAt: last + cycles * PROJECT_REFRESH_INTERVAL_MS, cycles };
}
