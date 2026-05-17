/**
 * project-generator.js
 * Phase 3A-1 — Pure deterministic project template generation.
 *
 * CONSTRAINTS:
 *   - No async/await
 *   - No DOM access
 *   - No timers
 *   - No persistence / localStorage / Firebase
 *   - No card locking, reward claiming, project assignment, or UI rendering
 *   - No ID generation, timestamps, or active/completed states
 *
 * All balance values (difficulty, rewards, durations) now come from
 * project-config.js (DB-backed). Hardcoded constants removed.
 *
 * Exports:
 *   getUnlockedProjectRarities(totalRP) → string[]
 *   generateProjectTemplate(rarity)     → ProjectTemplate
 */

import { getProjectConfig } from './project-config.js';

// ---------------------------------------------------------------------------
// Rarity unlock thresholds (total RP required)
// ---------------------------------------------------------------------------
// Fallback defaults — the live values come from project-config.js
// (cfg.rarityUnlockThresholds) so admins can tune them without a code deploy.
const PROJECT_UNLOCKS_DEFAULTS = {
  common:    0,
  uncommon:  500,
  rare:      1250,
  epic:      2500,
  legendary: 4500,
};

/**
 * Returns the live rarity unlock threshold map.
 * Reads from DB-backed config first; falls back to compiled defaults.
 * @returns {{ common:number, uncommon:number, rare:number, epic:number, legendary:number }}
 */
function _getUnlockThresholds() {
  const cfg = getProjectConfig();
  const thresholds = cfg.rarityUnlockThresholds;
  if (thresholds && typeof thresholds === 'object' && 'common' in thresholds) {
    return thresholds;
  }
  return PROJECT_UNLOCKS_DEFAULTS;
}

// Keep a named const for internal usage (via the helper above) and for export.
// Do NOT reference PROJECT_UNLOCKS_DEFAULTS directly in exported/public code.
/** @deprecated use getUnlockThresholds() or getUnlockedProjectRarities() */
const PROJECT_UNLOCKS = PROJECT_UNLOCKS_DEFAULTS; // kept for allRarities() key order

// ---------------------------------------------------------------------------
// Flavor title pools per rarity
// ---------------------------------------------------------------------------
// These are the compile-time fallbacks only. The live pool is read from
// cfg.projectFlavorTitles (DB-backed) so admins can add/edit/remove entries
// without a code deploy. See project-config.js for the stored defaults.
const PROJECT_TITLES_FALLBACK = {
  common: [
    'Sorting Biological Samples',
    'Organizing Experiment Data',
    'Basic Lab Measurements',
    'Documenting Field Observations',
    'Calibrating Instruments',
  ],
  uncommon: [
    'Controlled Chemical Reactions',
    'Tracking Variable Responses',
    'Intermediate Circuit Analysis',
    'Specimen Classification Study',
  ],
  rare: [
    'Comparative Model Analysis',
    'Wave Interference Mapping',
    'Thermal Conductivity Experiment',
    'Multi-Variable Pressure Study',
  ],
  epic: [
    'Relativity Simulation',
    'Plasma Containment Test',
    'Quantum Field Observation',
    'Dark Matter Density Probe',
  ],
  legendary: [
    'Quantum Uncertainty Study',
    'Unified Field Hypothesis Test',
    'Singularity Boundary Research',
    'Multidimensional Energy Mapping',
  ],
};

/**
 * Returns the live flavor title pool for a given rarity.
 * Reads from cfg.projectFlavorTitles (DB-backed); falls back to compiled defaults.
 * @param {string} rarity
 * @param {object} cfg - result of getProjectConfig()
 * @returns {string[]}
 */
function _getTitlesForRarity(rarity, cfg) {
  const pool = cfg.projectFlavorTitles?.[rarity];
  if (Array.isArray(pool) && pool.length > 0) return pool;
  // Firebase converts arrays → objects; handle that case
  if (pool && typeof pool === 'object' && !Array.isArray(pool)) {
    const arr = Object.values(pool).filter(v => typeof v === 'string' && v.trim());
    if (arr.length > 0) return arr;
  }
  return PROJECT_TITLES_FALLBACK[rarity] ?? ['Research Project'];
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Returns a random integer in [min, max] (inclusive).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Returns a random element from an array.
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
function randPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Returns the ordered list of valid rarity keys.
 * @returns {string[]}
 */
function allRarities() {
  return Object.keys(PROJECT_UNLOCKS); // insertion order preserved in modern JS
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Returns every rarity whose RP threshold the player has met.
 * Thresholds are read from the DB-backed config (admin-configurable).
 *
 * @param {number} [totalRP=0] - The player's current total RP.
 * @returns {string[]} Ordered array of unlocked rarity strings.
 *
 * @example
 * getUnlockedProjectRarities(0)    // ['common']
 * getUnlockedProjectRarities(600)  // ['common', 'uncommon']
 * getUnlockedProjectRarities(9999) // ['common', 'uncommon', 'rare', 'epic', 'legendary']
 */
export function getUnlockedProjectRarities(totalRP = 0) {
  const thresholds = _getUnlockThresholds();
  return allRarities().filter(rarity => totalRP >= (thresholds[rarity] ?? 0));
}

/**
 * Generates a raw project template for the given rarity.
 * All numeric values are randomly sampled from the rarity's defined ranges
 * in project-config.js (DB-backed).
 *
 * Does NOT produce IDs, timestamps, states, card assignments, or timers.
 *
 * @param {string} rarity - One of: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
 * @returns {{
 *   rarity: string,
 *   title: string,
 *   difficulty: number,
 *   successRP: number,
 *   failureRP: number,
 *   durationHours: number
 * }}
 * @throws {Error} If rarity is not a recognised value.
 */
export function generateProjectTemplate(rarity) {
  if (!PROJECT_UNLOCKS.hasOwnProperty(rarity)) {
    throw new Error(
      `generateProjectTemplate: unknown rarity "${rarity}". ` +
      `Valid rarities: ${allRarities().join(', ')}.`
    );
  }

  const cfg = getProjectConfig();

  const titles     = _getTitlesForRarity(rarity, cfg);
  const rewards    = cfg.rpRewards?.[rarity]          ?? { success: [40, 65], failure: [5, 12] };
  const durations  = cfg.projectDurations?.[rarity]   ?? [2, 3];
  const difficulty = cfg.projectDifficulty?.[rarity]  ?? [25, 40];

  return {
    rarity,
    title:         randPick(titles),
    difficulty:    randInt(difficulty[0],  difficulty[1]),
    successRP:     randInt(rewards.success[0], rewards.success[1]),
    failureRP:     randInt(rewards.failure[0], rewards.failure[1]),
    durationHours: randInt(durations[0],  durations[1]),
  };
}
