// project-refresh.js
// Phase 3A-2 — Pure scheduling helper for project refresh cadence and capacity.
// NO side effects, NO storage, NO timers, NO Firebase, NO DOM.

import { getProjectConfig } from './project-config.js';

/**
 * Canonical max stored projects array length.
 *
 * RTDB claim rules in database.rules.json inspect fixed indices 0..6 only
 * (see PROJECT_RULES_ARRAY_INDEX_MAX in project-claims.js). Raising this
 * without updating those rules would leave higher slots unenforced.
 */
export const MAX_STORED_PROJECTS = 7;

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
