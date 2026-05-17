/**
 * project-pool.js
 * Phase 3B-2 — Pure helpers for generating AVAILABLE projects and refreshing
 * the unified project pool.
 *
 * CONSTRAINTS:
 *   - No async/await
 *   - No DOM access
 *   - No timers (setInterval / setTimeout)
 *   - No Firebase / localStorage
 *   - No card assignment, reward claiming, or project completion resolution
 *   - No mutation of input arrays or objects
 *
 * Exports:
 *   generateAvailableProjects({ totalRP, slots, createdAt }) → Project[]
 *   refreshProjectPool({ projects, totalRP, lastRefreshAt, now })
 *     → { projects, refreshed, refreshAt, generatedCount }
 */

import { generateProjectTemplate, getUnlockedProjectRarities } from './project-generator.js';
import { getAvailableProjectSlots, getProjectRefreshIntervalMs } from './project-refresh.js';
import { createAvailableProject, PROJECT_STATES } from './project-state.js';
import { getProjectConfig } from './project-config.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Generates a unique project ID.
 * Combines a millisecond timestamp with a short random alphanumeric suffix to
 * minimise collision risk without requiring a UUID library.
 *
 * @returns {string}
 */
function generateProjectId() {
  return `project_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Returns a random element from a non-empty array (uniform distribution).
 *
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
function randPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Weighted random rarity selection.
 *
 * Given an array of unlocked rarity strings and a weight map from project
 * config, returns one rarity chosen proportionally to its weight.
 * Rarities missing from the weight map default to weight 1 (equal chance).
 * Falls back to uniform randPick if all weights are zero.
 *
 * @param {string[]} unlockedRarities - The eligible rarities (already filtered for unlock).
 * @param {object}   weights          - Weight map e.g. { common:60, uncommon:25, ... }
 * @returns {string}
 */
function weightedRarityPick(unlockedRarities, weights) {
  const entries = unlockedRarities.map(r => ({ rarity: r, w: Math.max(0, weights?.[r] ?? 1) }));
  const total = entries.reduce((s, e) => s + e.w, 0);
  if (total <= 0) return randPick(unlockedRarities); // fallback: all weights zero
  let roll = Math.random() * total;
  for (const { rarity, w } of entries) {
    if (roll < w) return rarity;
    roll -= w;
  }
  return entries[entries.length - 1].rarity; // floating-point safety
}

/**
 * Count projects that are AVAILABLE or ACTIVE (the only states that occupy cap slots).
 * COMPLETE and CLAIMED projects do NOT count toward the cap.
 *
 * @param {object[]} projects
 * @returns {number}
 */
function countCapProjects(projects) {
  return projects.filter(p =>
    p.state === PROJECT_STATES.AVAILABLE || p.state === PROJECT_STATES.ACTIVE
  ).length;
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Generates an array of new AVAILABLE project objects.
 *
 * Does NOT read from or write to any external state.  All values are derived
 * purely from the arguments supplied.
 *
 * @param {object}  [options]
 * @param {number}  [options.totalRP=0]        - Player's current total RP (used to
 *                                               determine which rarities are unlocked).
 * @param {number}  [options.slots=0]           - Number of projects to generate.
 *                                               Typically the result of getAvailableProjectSlots().
 * @param {number}  [options.createdAt]         - Creation timestamp applied to every generated
 *                                               project (defaults to Date.now() at call time).
 * @returns {object[]} Array of AVAILABLE project objects (may be empty if slots === 0).
 */
export function generateAvailableProjects({
  totalRP = 0,
  slots = 0,
  createdAt = Date.now(),
} = {}) {
  if (slots <= 0) return [];

  const unlockedRarities = getUnlockedProjectRarities(totalRP);

  // Nothing can be generated if no rarities are unlocked (defensive guard).
  if (unlockedRarities.length === 0) return [];

  // Read rarity weights from config (admin-configurable). Falls back to
  // uniform selection if the key is absent or all weights are zero.
  const rarityWeights = getProjectConfig().projectRarityWeights ?? {};

  const generated = [];

  for (let i = 0; i < slots; i++) {
    const rarity   = weightedRarityPick(unlockedRarities, rarityWeights);
    const template = generateProjectTemplate(rarity);
    const project  = createAvailableProject({
      id: generateProjectId(),
      template,
      createdAt,
    });
    generated.push(project);
  }

  return generated;
}

/**
 * Determines whether the project pool needs refreshing and, if so, appends
 * newly generated AVAILABLE projects up to the 7-project cap.
 *
 * Cap counting uses ONLY AVAILABLE + ACTIVE projects.
 * COMPLETE and CLAIMED projects do NOT count toward the cap.
 *
 * Existing projects are NEVER removed or mutated.
 * States other than AVAILABLE (ACTIVE, COMPLETE, CLAIMED) are never touched.
 *
 * @param {object}   [options]
 * @param {object[]} [options.projects=[]]      - Current project array.
 * @param {number}   [options.totalRP=0]        - Player's current total RP.
 * @param {number}   [options.lastRefreshAt=0]  - Timestamp of the last successful refresh.
 * @param {number}   [options.now]              - Current timestamp (defaults to Date.now()
 *                                               at call time, allowing deterministic tests).
 * @returns {{
 *   projects:       object[],
 *   refreshed:      boolean,
 *   refreshAt:      number,
 *   generatedCount: number,
 * }}
 */
export function refreshProjectPool({
  projects = [],
  totalRP = 0,
  lastRefreshAt = 0,
  now = Date.now(),
} = {}) {
  // Count only AVAILABLE + ACTIVE toward the cap
  const activeCount = countCapProjects(projects);

  // How many full refresh intervals have elapsed since the last refresh?
  const refreshInterval = getProjectRefreshIntervalMs();
  const elapsedCycles   = Math.floor((now - lastRefreshAt) / refreshInterval);

  // No full cycle has elapsed yet — nothing to do.
  if (elapsedCycles <= 0) {
    return {
      projects,
      refreshed:      false,
      refreshAt:      lastRefreshAt,
      generatedCount: 0,
    };
  }

  // Available capacity at this moment.
  const openSlots = getAvailableProjectSlots(activeCount);

  // No open slots — no projects can be added regardless of elapsed cycles.
  if (openSlots <= 0) {
    // Still advance the timestamp so drift doesn't accumulate.
    const advancedRefreshAt = lastRefreshAt + elapsedCycles * refreshInterval;
    return {
      projects,
      refreshed:      false,
      refreshAt:      advancedRefreshAt,
      generatedCount: 0,
    };
  }

  // For brand-new players (lastRefreshAt === 0 and no existing projects), cap
  // the first fill to initialProjects from config (admin-configurable, default 2).
  // All subsequent refreshes use the normal elapsedCycles cap.
  // Falls back to legacy key initialProjectSlots so old DB values are honoured.
  const isFirstEverRefresh = lastRefreshAt === 0 && projects.length === 0;
  let effectiveOpenSlots = openSlots;
  if (isFirstEverRefresh) {
    const cfg = getProjectConfig();
    // Read new key first; fall back to old key for existing DB data
    const rawInit = typeof cfg.initialProjects === 'number' ? cfg.initialProjects
                  : typeof cfg.initialProjectSlots === 'number' ? cfg.initialProjectSlots
                  : 2;
    const initCount = rawInit > 0 ? Math.min(rawInit, openSlots) : Math.min(2, openSlots);
    effectiveOpenSlots = initCount;
  }

  // One project per elapsed cycle, capped by available slots.
  const slots = Math.min(elapsedCycles, effectiveOpenSlots);

  const newProjects = generateAvailableProjects({
    totalRP,
    slots,
    createdAt: now,
  });

  // Advance by completed intervals only — prevents drift and preserves the
  // partial interval so the next cycle fires at the correct future time.
  const advancedRefreshAt = lastRefreshAt + elapsedCycles * refreshInterval;

  return {
    projects:       [...projects, ...newProjects],
    refreshed:      true,
    refreshAt:      advancedRefreshAt,
    generatedCount: newProjects.length,
  };
}
