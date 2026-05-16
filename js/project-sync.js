// Phase 3F — Deterministic synchronization pipeline
// Single backend entry point for the ResearchProjects lifecycle.
// Pure orchestration only: no side effects, no Firebase, no DOM, no timers.

import { refreshProjectPool } from './project-pool.js';
import { resolveProjectPool } from './project-resolution.js';
import { pruneProjects }      from './project-claiming.js';

/**
 * syncProjects — runs the three-stage lifecycle pipeline in strict order:
 *   A. refresh  → replenish AVAILABLE slots
 *   B. resolve  → complete ACTIVE projects whose deadline has passed
 *   C. prune    → remove CLAIMED projects older than 24 h
 *
 * All steps are executed unconditionally and in order.
 * Original arrays are never mutated.
 *
 * @param {object} opts
 * @param {Array}  opts.projects       - current project list
 * @param {number} opts.totalRP        - player's total RP (passed to refresh)
 * @param {number} opts.lastRefreshAt  - timestamp of the last pool refresh
 * @param {number} opts.now            - current timestamp (default: Date.now())
 * @returns {{ projects, refreshAt, generatedCount, resolvedCount, prunedCount }}
 */
export function syncProjects({
  projects     = [],
  totalRP      = 0,
  lastRefreshAt = 0,
  now          = Date.now(),
} = {}) {
  // ── Step A: Refresh available project pool ──────────────────────────────
  const {
    projects:      refreshedProjects,
    refreshAt,
    generatedCount,
  } = refreshProjectPool({ projects, totalRP, lastRefreshAt, now });

  // ── Step B: Resolve completed active projects ───────────────────────────
  const {
    projects:    resolvedProjects,
    resolvedCount,
  } = resolveProjectPool({ projects: refreshedProjects, now });

  // ── Step C: Prune expired claimed projects ─────────────��────────────────
  const {
    projects:  prunedProjects,
    prunedCount,
  } = pruneProjects({ projects: resolvedProjects, now });

  // ── Return fully synchronized state ────────────────────────────────────
  return {
    projects:      prunedProjects,
    refreshAt,
    generatedCount,
    resolvedCount,
    prunedCount,
  };
}
