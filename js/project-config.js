/**
 * Project Config — Research Projects System
 *
 * Single source of truth for ALL project balance values.
 * Consumed by: project-engine.js, project-generator.js, admin balance panel
 *
 * Persistence:
 *   - Default values defined here as PROJECT_CONFIG_DEFAULTS
 *   - Live values persisted at DB path: config/projectBalance
 *   - getProjectConfig() returns live (DB) values merged over defaults
 *   - saveProjectConfig(cfg) writes to DB and invalidates cache
 *
 * Do NOT import UI modules here.
 */

import * as db from './database.js';

// ─────────────────────────────────────────────────────────────────────────────
// Default balance values
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_CONFIG_DEFAULTS = {

  /**
   * Hours between automatic project refresh cycles.
   * Controls how frequently new AVAILABLE projects are generated.
   */
  projectRefreshHours: 12,

  /**
   * Power contribution per rarity for scientist cards.
   * Concept cards always contribute 0 regardless of rarity.
   */
  rarityPower: {
    common:    1,
    uncommon:  2,
    rare:      4,
    epic:      8,
    legendary: 15,
  },

  /**
   * Aura bonus multipliers indexed by aura level (0–3).
   * Applied as: finalPower = basePower * (1 + auraScaling[level])
   */
  auraScaling: {
    0: 0.00,
    1: 0.10,
    2: 0.20,
    3: 0.30,
  },

  /**
   * Success chance curve parameters.
   * ratio    = totalPower / difficulty
   * scaled   = (ratio ^ exponent) / ((ratio ^ exponent) + midpoint)
   * chance   = clamp(scaled, min, max)
   *
   * midpoint: shifts the curve so equal power is no longer near-guaranteed.
   *   Default 0.55 → power == difficulty ≈ 65% success.
   */
  successCurve: {
    exponent: 0.6,
    midpoint: 0.55,
    min:      0.05,
    max:      0.95,
  },

  /**
   * Project difficulty ranges [min, max] per rarity.
   */
  projectDifficulty: {
    common:    [25,  40],
    uncommon:  [40,  65],
    rare:      [65,  95],
    epic:      [95,  130],
    legendary: [140, 180],
  },

  /**
   * RP reward ranges per rarity.
   * success: [min, max], failure: [min, max]
   */
  rpRewards: {
    common:    { success: [40,  65],  failure: [5,  12] },
    uncommon:  { success: [70,  110], failure: [10, 18] },
    rare:      { success: [130, 190], failure: [15, 28] },
    epic:      { success: [240, 340], failure: [25, 40] },
    legendary: { success: [420, 600], failure: [40, 60] },
  },

  /**
   * Project duration ranges [minHours, maxHours] per rarity.
   */
  projectDurations: {
    common:    [2, 3],
    uncommon:  [3, 4],
    rare:      [4, 5],
    epic:      [5, 6],
    legendary: [6, 8],
  },

  /**
   * Rarity weight distribution for project generation.
   * When generating new AVAILABLE projects, a rarity is rolled using these
   * weights (not uniform random). Only unlocked rarities are eligible —
   * weights for locked rarities are silently ignored until the player unlocks them.
   *
   * Higher values = more likely to appear. Values don't need to sum to 100.
   * Example: common:60, uncommon:25, rare:10, epic:4, legendary:1
   */
  projectRarityWeights: {
    common:    60,
    uncommon:  25,
    rare:      10,
    epic:       4,
    legendary:  1,
  },

  /**
   * Rarity weight distribution for breakthrough card rewards.
   * When a breakthrough event awards a card, one rarity is rolled using these
   * weights. INDEPENDENT from projectRarityWeights (project generation) and
   * from any pack rarity odds.
   *
   * Higher values = more likely. Values don't need to sum to 100.
   * Example: common:50, uncommon:25, rare:15, epic:8, legendary:2
   */
  breakthroughCardRarityWeights: {
    common:    50,
    uncommon:  25,
    rare:      15,
    epic:       8,
    legendary:  2,
  },

  /**
   * Starter pack grant for new accounts.
   * starterPackId:       DB id of the pack type to grant on registration (empty = none)
   * starterPackQuantity: how many packs to grant (0 = disabled)
   *
   * The grant happens once inside createPlayerRecord() immediately after profile
   * creation. The flag starterPacksGranted:true is written to the player record
   * so the grant never fires again (even on future logins).
   */
  starterPackId:       '',
  starterPackQuantity: 1,

  /**
   * Starter scientist card grant for new accounts.
   * starterScientistCount: how many random common scientist cards to grant (0 = disabled)
   *
   * Cards are selected randomly from enabled common scientist cards in the live
   * card pool. Duplicates are avoided when the pool is large enough.
   * The flag starterScientistsGranted:true prevents re-granting.
   */
  starterScientistCount: 5,

  /**
   * Starter concept card grant for new accounts.
   * starterConceptCount: how many random concept cards to grant (0 = disabled)
   * starterConceptPool:  conceptType values to draw from (must be enabled concept cards)
   *
   * Cards are selected randomly with no duplicates per conceptType run.
   * If the pool is smaller than starterConceptCount, the count is capped gracefully.
   * The flag starterConceptsGranted:true prevents re-granting.
   */
  starterConceptCount: 2,
  starterConceptPool:  ['synergyBoost', 'breakthrough'],

  /**
   * Weekly Research Pack config.
   *
   * weeklyRewardPackId:   DB id of the pack to grant when threshold is reached (empty = disabled)
   * weeklyRefreshDay:     0–6 (0=Sun … 6=Sat). Default 5 = Friday.
   * weeklyRefreshHour:    0–23 (local time). Default 23 = 11 PM.
   * weeklyRPRequirements: RP needed per highest-unlocked rarity stage.
   *                       common is always 1 (onboarding). Others are admin-tunable.
   */
  weeklyRewardPackId:   '',
  weeklyRefreshDay:     5,
  weeklyRefreshHour:    23,
  weeklyRPRequirements: {
    common:    1,
    uncommon:  40,
    rare:      80,
    epic:      150,
    legendary: 250,
  },

  /**
   * How many research projects a brand-new account starts with immediately
   * upon account creation — before any progression or unlocks.
   *
   * Applies ONLY during the very first project pool fill (lastRefreshAt === 0
   * and no existing projects). Existing players are NEVER affected.
   * Subsequent refreshes use normal cycle-based generation.
   *
   * Distinct from the system-wide project slot cap (getMaxStoredProjects).
   * Hard cap is always 7 (getMaxStoredProjects). Valid range: 1–7.
   */
  initialProjects: 2,

  /**
   * RP thresholds required to unlock each project rarity.
   * Exposed here so admin can tune without a code deploy.
   * These values are consumed by project-generator.js via getProjectConfig().
   */
  rarityUnlockThresholds: {
    common:    0,
    uncommon:  500,
    rare:      1250,
    epic:      2500,
    legendary: 4500,
  },

  /**
   * Flavor/lore title pools for each project rarity.
   * Stored as arrays of strings. project-generator.js picks one at random
   * when generating a new project template.
   * Admin-editable: add / edit / remove entries without a code deploy.
   */
  projectFlavorTitles: {
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
  },

  /**
   * Breakthrough reward config.
   * rpChance:             probability (0–1) that breakthrough awards RP
   * cardChance:           probability (0–1) that breakthrough awards a card
   *                       (evaluated only when rpChance roll fails)
   * breakthroughBonusPercent: bonus RP as a percentage (0–1) of the resolved
   *                       project rewardRP — scales with amplifiers / risk mods.
   *                       Example: 0.5 = 50% of the resolved rewardRP.
   */
  breakthroughBonus: {
    rpChance:               0.85,
    cardChance:             0.15,
    breakthroughBonusPercent: 0.50,
  },

  /**
   * Concept card effect values, keyed by conceptType -> rarity.
   *
   * researchBoost:       rewardRPPercent     — % increase to reward RP (aura-scaled)
   * difficultyReduction: difficultyPercent   — % reduction to difficulty (NOT aura-scaled)
   *                      minDifficulty       — floor; difficulty never goes below this
   * synergyBoost:        teamPowerPercent    — % increase to team power (aura-scaled)
   * breakthrough:        breakthroughChance  — flat addition to breakthrough chance (aura-scaled)
   * risk:                rewardRPPercent     — % increase to reward RP (aura-scaled)
   *                      difficultyPercent   — % increase to difficulty (NOT aura-scaled)
   */
  conceptEffects: {
    researchBoost: {
      common:    { rewardRPPercent: 0.08 },
      uncommon:  { rewardRPPercent: 0.15 },
      rare:      { rewardRPPercent: 0.25 },
      epic:      { rewardRPPercent: 0.40 },
      legendary: { rewardRPPercent: 0.60 },
    },
    difficultyReduction: {
      common:    { difficultyPercent: 0.06,  minDifficulty: 5 },
      uncommon:  { difficultyPercent: 0.10,  minDifficulty: 5 },
      rare:      { difficultyPercent: 0.16,  minDifficulty: 5 },
      epic:      { difficultyPercent: 0.22,  minDifficulty: 5 },
      legendary: { difficultyPercent: 0.30,  minDifficulty: 5 },
    },
    synergyBoost: {
      common:    { teamPowerPercent: 0.10 },
      uncommon:  { teamPowerPercent: 0.20 },
      rare:      { teamPowerPercent: 0.35 },
      epic:      { teamPowerPercent: 0.55 },
      legendary: { teamPowerPercent: 0.80 },
    },
    breakthrough: {
      common:    { breakthroughChance: 0.03 },
      uncommon:  { breakthroughChance: 0.06 },
      rare:      { breakthroughChance: 0.10 },
      epic:      { breakthroughChance: 0.15 },
      legendary: { breakthroughChance: 0.22 },
    },
    risk: {
      common:    { rewardRPPercent: 0.12, difficultyPercent: 0.15 },
      uncommon:  { rewardRPPercent: 0.22, difficultyPercent: 0.25 },
      rare:      { rewardRPPercent: 0.35, difficultyPercent: 0.35 },
      epic:      { rewardRPPercent: 0.50, difficultyPercent: 0.50 },
      legendary: { rewardRPPercent: 0.75, difficultyPercent: 0.70 },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal cache
// ─────────────────────────────────────────────────────────────────────────────

let _configCache = null;

/**
 * Deep-merge source into target, only filling in missing keys.
 */
function deepMergeDefaults(target, defaults) {
  const result = { ...target };
  for (const key of Object.keys(defaults)) {
    if (result[key] === undefined || result[key] === null) {
      result[key] = typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])
        ? JSON.parse(JSON.stringify(defaults[key]))
        : Array.isArray(defaults[key])
          ? [...defaults[key]]
          : defaults[key];
    } else if (
      typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key]) &&
      typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])
    ) {
      result[key] = deepMergeDefaults(result[key], defaults[key]);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Load / Get / Save
// ─────────────────────────────────────────────────────────────────────────────

const DB_PATH = 'config/projectBalance';

/**
 * Load project config from DB with safe fallback to defaults.
 * Merges remote values over defaults so any missing keys are auto-filled.
 */
function loadProjectConfig() {
  try {
    const remote = db.get(DB_PATH);
    if (remote && typeof remote === 'object' && Object.keys(remote).length > 0) {
      _configCache = deepMergeDefaults(remote, PROJECT_CONFIG_DEFAULTS);
      console.log('[ProjectConfig] Loaded from DB');
      return _configCache;
    }
  } catch (e) {
    console.warn('[ProjectConfig] DB read error:', e.message);
  }
  // Fallback to defaults
  _configCache = JSON.parse(JSON.stringify(PROJECT_CONFIG_DEFAULTS));
  console.log('[ProjectConfig] Using defaults');
  return _configCache;
}

/**
 * Get the current project config (cached, safe). Never returns null.
 * @returns {object}
 */
export function getProjectConfig() {
  if (!_configCache) loadProjectConfig();
  return _configCache;
}

/**
 * Save updated project config to the DB and invalidate cache.
 * @param {object} cfg - Full or partial config to persist.
 */
export function saveProjectConfig(cfg) {
  try {
    db.set(DB_PATH, cfg);
    _configCache = null; // invalidate so next read picks up new values
    console.log('[ProjectConfig] Saved to DB');
  } catch (e) {
    console.warn('[ProjectConfig] DB write error:', e.message);
  }
}

/**
 * Invalidate the cached config so the next getProjectConfig() re-reads from DB.
 */
export function invalidateProjectConfigCache() {
  _configCache = null;
}

/**
 * Seed defaults to DB (admin reset).
 */
export function seedProjectConfigDefaults() {
  try {
    db.set(DB_PATH, JSON.parse(JSON.stringify(PROJECT_CONFIG_DEFAULTS)));
    _configCache = null;
    console.log('[ProjectConfig] Defaults seeded to DB');
  } catch (e) {
    console.warn('[ProjectConfig] Seed failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy export — backward compat for project-engine.js import
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PROJECT_CONFIG getter that always returns the live (DB-backed) config.
 * Uses a Proxy so existing `import { PROJECT_CONFIG }` references
 * automatically read from the DB-backed cache without code changes.
 */
export const PROJECT_CONFIG = new Proxy({}, {
  get(_target, prop) {
    const cfg = getProjectConfig();
    return cfg[prop];
  },
  ownKeys() {
    return Object.keys(getProjectConfig());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const cfg = getProjectConfig();
    if (prop in cfg) {
      return { configurable: true, enumerable: true, value: cfg[prop] };
    }
    return undefined;
  },
  has(_target, prop) {
    return prop in getProjectConfig();
  },
});
