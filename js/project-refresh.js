// project-refresh.js
// Phase 3A-2 — Pure scheduling helper for project refresh cadence and capacity.
// NO side effects, NO storage, NO timers, NO Firebase, NO DOM.

import { getProjectConfig } from './project-config.js';

const MAX_STORED_PROJECTS = 7;

/**
 * Returns the configured refresh interval in hours.
 * Reads from the DB-backed project config (projectRefreshHours).
 * @returns {number}
 */
export function getProjectRefreshHours() {
  const cfg = getProjectConfig();
  const h = cfg.projectRefreshHours;
  return (typeof h === 'number' && h > 0) ? h : 12;
}

/**
 * Returns the refresh interval in milliseconds.
 * @returns {number}
 */
export function getProjectRefreshIntervalMs() {
  return getProjectRefreshHours() * 60 * 60 * 1000;
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
