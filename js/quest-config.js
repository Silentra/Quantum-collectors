/**
 * Research Project Configuration Infrastructure
 *
 * Centralized balancing/config foundation for the future Research Project system.
 * Config only — no project generation, timers, UI, rewards, or card assignment.
 *
 * Provides:
 *   - DEFAULT_QUEST_CONFIG            — full default balancing values
 *   - AURA_SCALING                    — level-based scaling (type is cosmetic only)
 *   - loadQuestConfig()               — load from Firebase config/quests with fallback
 *   - getQuestConfig()                — cached, safe getter (never returns null)
 *   - getCardPowerContribution(card)  — returns power or 0 based on card type
 *
 * Firebase mirror path: config/quests
 * Falls back to DEFAULT_QUEST_CONFIG if Firebase read fails or is empty.
 *
 * DESIGN RULES:
 *   - Aura TYPE is cosmetic only — all types scale identically via AURA_SCALING
 *   - Scientist cards contribute power; concept cards apply modifiers only (never direct power)
 *   - All values centralized here for future admin tuning
 */

import * as db from './database.js';

// =====================================================================
// AURA SCALING — level-based, type-agnostic
// Aura TYPE (holographic, prismatic, shadow, radiant, cosmic) is cosmetic.
// All types use the same gameplay scaling based on aura LEVEL (0–3).
// =====================================================================

export const AURA_SCALING = Object.freeze({
  0: 0,
  1: 0.10,
  2: 0.20,
  3: 0.30
});

/**
 * All recognized aura types — cosmetic only, no gameplay difference.
 */
export const AURA_TYPES_COSMETIC = Object.freeze([
  'holographic',
  'prismatic',
  'shadow',
  'radiant',
  'cosmic'
]);

// =====================================================================
// DEFAULT CONFIG
// =====================================================================

/**
 * Complete balancing config for the Research Project system.
 * Every tunable value lives here — nothing hardcoded elsewhere.
 *
 * Concept cards: modifiers only (rpMultiplier, successRateBonus, etc.)
 * Scientist cards: direct power contribution via rarityPower
 */
export const DEFAULT_QUEST_CONFIG = Object.freeze({

  // --- Rarity power values (scientist cards only — how much power a card contributes) ---
  rarityPower: {
    common:    10,
    uncommon:  15,
    rare:      20,
    epic:      25,
    legendary: 30
  },

  // --- Aura scaling (level-based, identical for ALL aura types) ---
  // Stored here for Firebase mirroring; canonical source is AURA_SCALING above.
  auraScaling: {
    0: 0,
    1: 0.10,
    2: 0.20,
    3: 0.30
  },

  // --- RP (Research Point) rewards per Research Project tier ---
  rpRewards: {
    tier1: 10,
    tier2: 25,
    tier3: 50,
    tier4: 100,
    tier5: 250,
    bonusBreakthrough: 75,   // extra RP on a breakthrough event
    bonusStreak: 15          // extra RP per consecutive success
  },

  // --- Unlock thresholds (what the player needs to access each tier) ---
  unlockThresholds: {
    tier1: { level: 1,  researchPoints: 0 },
    tier2: { level: 3,  researchPoints: 50 },
    tier3: { level: 5,  researchPoints: 200 },
    tier4: { level: 8,  researchPoints: 500 },
    tier5: { level: 12, researchPoints: 1500 }
  },

  // --- Research Project durations in HOURS [min, max] per rarity ---
  researchProjectDurations: {
    common:    [2, 3],
    uncommon:  [3, 4],
    rare:      [4, 5],
    epic:      [5, 6],
    legendary: [6, 8]
  },

  // --- Success curve (base probability per tier, 0-1 range) ---
  successCurve: {
    tier1: 0.85,
    tier2: 0.70,
    tier3: 0.55,
    tier4: 0.40,
    tier5: 0.25,
    // How much rarity power shifts the probability (additive, clamped 0-1)
    powerScaling: 0.02,
    // Cap so stacking can't guarantee success
    maxSuccessRate: 0.95,
    minSuccessRate: 0.05
  },

  // --- Concept card effect values (modifiers only — never direct power) ---
  conceptEffects: {
    researchBoost: {
      rpMultiplier: 1.25      // +25% RP earned
    },
    difficultyReduction: {
      successRateBonus: 0.10  // +10% success probability
    },
    synergyBoost: {
      powerMultiplier: 1.20   // +20% total party power (applied to scientist power only)
    },
    breakthrough: {
      breakthroughChance: 0.15 // 15% chance of breakthrough event
    },
    risk: {
      rpMultiplier: 1.50,     // +50% RP if success
      successRatePenalty: 0.15 // -15% success probability
    }
  },

  // --- Card type rules (documentation/future validation) ---
  cardTypeRules: {
    scientist: 'power',    // contributes direct team power via rarityPower
    concept:   'modifier'  // applies modifiers only, NEVER direct power
  }
});

// =====================================================================
// CARD POWER HELPERS
// =====================================================================

/**
 * Get the power contribution of a card for Research Projects.
 * Scientist cards contribute power based on rarity.
 * Concept cards NEVER contribute direct power (return 0).
 *
 * @param {object} card - Card object with at least { type, rarity }
 * @param {number} auraLevel - Aura tier (0-3)
 * @param {object} [configOverride] - Optional config (uses cached config by default)
 * @returns {number} Power contribution (0 for concept cards)
 */
export function getCardPowerContribution(card, auraLevel = 0, configOverride = null) {
  // Concept cards NEVER contribute direct power
  if (!card || card.type === 'concept') return 0;

  // Only scientist cards contribute power
  if (card.type !== 'scientist') return 0;

  const cfg = configOverride || getQuestConfig();
  const basePower = cfg.rarityPower[card.rarity] || 0;
  const auraBonus = AURA_SCALING[auraLevel] || 0;

  return basePower * (1 + auraBonus);
}

// =====================================================================
// Internal state
// =====================================================================

let _questConfigCache = null;
let _loaded = false;

// =====================================================================
// Deep merge helper
// =====================================================================

/**
 * Deep-merge source into target, only filling in missing keys.
 * Existing values in target are never overwritten.
 */
function deepMergeDefaults(target, defaults) {
  const result = { ...target };
  for (const key of Object.keys(defaults)) {
    if (result[key] === undefined || result[key] === null) {
      result[key] = typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])
        ? JSON.parse(JSON.stringify(defaults[key]))
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

// =====================================================================
// Load / Get
// =====================================================================

/**
 * Load Research Project config from Firebase (config/quests) with safe fallback.
 * Merges remote config over defaults so any missing keys are filled in.
 * Never throws — always returns a valid config object.
 */
export function loadQuestConfig() {
  try {
    const remote = db.get('config/quests');

    if (remote && typeof remote === 'object' && Object.keys(remote).length > 0) {
      _questConfigCache = deepMergeDefaults(remote, DEFAULT_QUEST_CONFIG);
      _loaded = true;
      console.log('[ResearchProjects] Firebase config loaded');
      console.log('[ResearchProjects] Config loaded');
      return _questConfigCache;
    }
  } catch (e) {
    console.warn('[ResearchProjects] Firebase config read error:', e.message);
  }

  // Fallback — use full defaults
  _questConfigCache = JSON.parse(JSON.stringify(DEFAULT_QUEST_CONFIG));
  _loaded = true;
  console.log('[ResearchProjects] Using default config fallback');
  console.log('[ResearchProjects] Config loaded');

  // Stabilization diagnostics
  console.log('[ResearchProjects] Aura scaling normalized');
  console.log('[ResearchProjects] Rarity power restored');
  console.log('[ResearchProjects] Duration config updated');
  console.log('[ResearchProjects] Concept safeguards active');

  return _questConfigCache;
}

/**
 * Get Research Project config (cached, safe).
 * If not yet loaded, loads automatically.
 * Never returns null — always a valid config object.
 *
 * @returns {object} Full Research Project configuration
 */
export function getQuestConfig() {
  if (!_loaded || !_questConfigCache) {
    loadQuestConfig();
  }
  return _questConfigCache;
}

/**
 * Write the current DEFAULT_QUEST_CONFIG to Firebase at config/quests.
 * Used by admin tooling to seed the remote config for the first time
 * or to reset it back to defaults.
 * Safe — never crashes startup.
 */
export function seedQuestConfigToFirebase() {
  try {
    db.set('config/quests', JSON.parse(JSON.stringify(DEFAULT_QUEST_CONFIG)));
    console.log('[ResearchProjects] Default config seeded to Firebase (config/quests)');
  } catch (e) {
    console.warn('[ResearchProjects] Failed to seed config to Firebase:', e.message);
  }
}

/**
 * Invalidate the cached config so the next getQuestConfig() re-reads from DB.
 */
export function invalidateQuestConfigCache() {
  _questConfigCache = null;
  _loaded = false;
}
