/**
 * Project Engine — Research Projects System (Phase 2A + 2B + 2C-1 + 2C-2)
 *
 * Pure functions only. No DOM, no database, no state mutation.
 *
 * Exports:
 *   getScientistPower(card, config)                          → power breakdown for one card
 *   getTeamPower(cards, config)                              → aggregated team power
 *   calculateSuccessChance(power, difficulty, config)        → chance object
 *   getSuccessLabel(chance)                                  → human-readable label
 *   applyConceptModifiers(baseState, concepts, config)       → modified state + audit log
 *   evaluateProject({ scientists, concepts, difficulty,
 *                     rewardRP, breakthroughChance })        → full deterministic evaluation
 *   rollProjectOutcome({ successChance, breakthroughChance }) → { success, breakthrough }
 *   buildProjectRewards({ success, breakthrough,
 *                         rewardRP, breakthroughCard })      → reward result object
 *
 * All balance values come from config (project-config.js).
 * Nothing is hardcoded.
 */

import { PROJECT_CONFIG } from './project-config.js';

console.log('[ResearchProjects] Project engine initialized');

// ─────────────────────────────────────────────────────────────────────────────
// Scientist Power
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the power contribution of a single card.
 *
 * Only scientist cards contribute power.
 * Concept cards always return finalPower = 0.
 *
 * @param {Object} card   - Card object. Must have: id, name, rarity, type.
 *                          auraLevel is player-owned progression (0–3); defaults to 0.
 * @param {Object} config - Project config (defaults to PROJECT_CONFIG).
 * @returns {{
 *   cardId:     string,
 *   name:       string,
 *   rarity:     string,
 *   auraLevel:  number,
 *   basePower:  number,
 *   finalPower: number,
 * }}
 */
export function getScientistPower(card, config = PROJECT_CONFIG) {
  const cardId    = card.id   ?? card.cardId ?? '';
  const name      = card.name  ?? 'Unknown';
  const rarity    = card.rarity ?? 'common';
  const auraLevel = typeof card.auraLevel === 'number'
    ? Math.max(0, Math.min(3, Math.floor(card.auraLevel)))
    : 0;

  // Concept cards contribute zero power
  if (card.type !== 'scientist') {
    return { cardId, name, rarity, auraLevel, basePower: 0, finalPower: 0 };
  }

  const basePower  = config.rarityPower[rarity] ?? 0;
  const auraBonus  = config.auraScaling[auraLevel] ?? 0;
  const finalPower = basePower * (1 + auraBonus);

  return { cardId, name, rarity, auraLevel, basePower, finalPower };
}

// ─────────────────────────────────────────────────────────────────────────────
// Team Power
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate total team power across an array of cards.
 *
 * Concept cards are ignored entirely (not counted, not summed).
 *
 * @param {Object[]} cards  - Array of card objects.
 * @param {Object}   config - Project config (defaults to PROJECT_CONFIG).
 * @returns {{
 *   scientistCount: number,
 *   totalPower:     number,
 *   breakdown:      Array<ReturnType<getScientistPower>>,
 * }}
 */
export function getTeamPower(cards, config = PROJECT_CONFIG) {
  if (!Array.isArray(cards) || cards.length === 0) {
    return { scientistCount: 0, totalPower: 0, breakdown: [] };
  }

  const breakdown = [];
  let totalPower  = 0;

  for (const card of cards) {
    if (card.type !== 'scientist') continue;   // ignore concept cards entirely

    const entry = getScientistPower(card, config);
    breakdown.push(entry);
    totalPower += entry.finalPower;
  }

  return {
    scientistCount: breakdown.length,
    totalPower,
    breakdown,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Success Chance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the probability of project success given team power and difficulty.
 *
 * Formula (Hill / sigmoid-style diminishing returns):
 *   ratio    = totalPower / difficulty
 *   powered  = ratio ^ exponent                        (from config.successCurve)
 *   scaled   = powered / (powered + midpoint)          (from config.successCurve)
 *   chance   = clamp(scaled, min, max)                 (from config.successCurve)
 *
 * Behaviour:
 *   power == difficulty  →  ~65% (not near-100%)
 *   power == 2× diff     →  approaches max cap
 *   power == 0.5× diff   →  ~30%
 *
 * @param {number} power      - Total team power (from getTeamPower).
 * @param {number} difficulty - Project difficulty (positive number).
 * @param {Object} config     - Project config (defaults to PROJECT_CONFIG).
 * @returns {{
 *   chance:  number,   // final clamped probability [min, max]
 *   ratio:   number,   // power / difficulty (uncapped)
 *   clamped: boolean,  // true if scaled value was outside [min, max]
 * }}
 */
export function calculateSuccessChance(power, difficulty, config = PROJECT_CONFIG) {
  const { exponent, min, max } = config.successCurve;
  // Safely read midpoint; default to 0.55 if absent (backwards-compatible).
  const midpoint = typeof config.successCurve.midpoint === 'number'
    ? config.successCurve.midpoint
    : 0.55;

  // Guard against degenerate inputs
  const safePower      = typeof power      === 'number' && power      >= 0 ? power      : 0;
  const safeDifficulty = typeof difficulty === 'number' && difficulty >  0 ? difficulty : 1;

  const ratio   = safePower / safeDifficulty;
  const powered = Math.pow(ratio, exponent);
  const scaled  = powered / (powered + midpoint);

  const clampedValue = Math.min(max, Math.max(min, scaled));
  const clamped      = scaled < min || scaled > max;

  return {
    chance:  clampedValue,
    ratio,
    clamped,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Success Label
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return a human-readable label for a given success chance (0–1).
 *
 * Thresholds are inclusive on the lower bound:
 *   >= 0.85  → "Highly Likely"
 *   >= 0.70  → "Likely"
 *   >= 0.50  → "Good Odds"
 *   >= 0.35  → "Uncertain"
 *   >= 0.15  → "Risky"
 *    < 0.15  → "Very Unlikely"
 *
 * @param {number} chance - Probability value between 0 and 1 (not rounded before lookup).
 * @returns {string}
 */
export function getSuccessLabel(chance) {
  if (chance >= 0.85) return 'Highly Likely';
  if (chance >= 0.70) return 'Likely';
  if (chance >= 0.50) return 'Good Odds';
  if (chance >= 0.35) return 'Uncertain';
  if (chance >= 0.15) return 'Risky';
  return 'Very Unlikely';
}

// ─────────────────────────────────���───────────────────────────────────────────
// Concept Modifiers  (Phase 2B)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply concept card modifiers to a project base state.
 *
 * Each concept has a single, non-overlapping role:
 *   researchBoost       → % increase to rewardRP (aura-scaled)
 *   difficultyReduction → flat reduction to difficulty (NOT aura-scaled)
 *   synergyBoost        → % increase to teamPower (aura-scaled)
 *   breakthrough        → flat addition to breakthroughChance (aura-scaled)
 *   risk                → % increase to rewardRP (aura-scaled)
 *                        + % increase to difficulty (NOT aura-scaled)
 *
 * Rules:
 *   - Only concept cards (type === 'concept') are processed.
 *   - Duplicate conceptTypes: first occurrence wins; rest are silently skipped.
 *   - Percentage modifiers apply proportionally against the base values
 *     passed in (single pass, no recursive scaling).
 *   - No errors are thrown; unknown types/rarities degrade gracefully to no-op.
 *
 * @param {{
 *   teamPower:          number,
 *   difficulty:         number,
 *   rewardRP:           number,
 *   breakthroughChance: number,
 * }} baseState - Snapshot of the project state before concept application.
 *
 * @param {Object[]} concepts - Array of concept card objects. Each must have:
 *   id | cardId, name, conceptType, rarity, auraLevel (0–3).
 *
 * @param {Object} config - Project config (defaults to PROJECT_CONFIG).
 *
 * @returns {{
 *   original:        typeof baseState,
 *   modified:        typeof baseState,
 *   appliedConcepts: Array<{
 *     cardId:      string,
 *     name:        string,
 *     conceptType: string,
 *     rarity:      string,
 *     auraLevel:   number,
 *     effectValue: Object,
 *   }>,
 * }}
 */
export function applyConceptModifiers(baseState, concepts, config = PROJECT_CONFIG) {
  // Snapshot originals — never mutate inputs
  const original = {
    teamPower:          baseState.teamPower          ?? 0,
    difficulty:         baseState.difficulty         ?? 0,
    rewardRP:           baseState.rewardRP           ?? 0,
    breakthroughChance: baseState.breakthroughChance ?? 0,
  };

  // Working copy — all % modifiers apply against these base values
  let teamPower          = original.teamPower;
  let difficulty         = original.difficulty;
  let rewardRP           = original.rewardRP;
  let breakthroughChance = original.breakthroughChance;

  const appliedConcepts = [];
  const seenTypes       = new Set();   // deduplication guard

  const conceptList = Array.isArray(concepts) ? concepts : [];

  for (const card of conceptList) {
    // Only process concept cards
    if (card.type !== 'concept') continue;

    const cardId      = card.id ?? card.cardId ?? '';
    const name        = card.name        ?? 'Unknown';
    const conceptType = card.conceptType ?? '';
    const rarity      = card.rarity      ?? 'common';
    const auraLevel   = typeof card.auraLevel === 'number'
      ? Math.max(0, Math.min(3, Math.floor(card.auraLevel)))
      : 0;

    // Skip duplicates — first instance wins
    if (seenTypes.has(conceptType)) continue;
    seenTypes.add(conceptType);

    // Look up base effect values from config
    const effectTable  = config.conceptEffects?.[conceptType];
    const rarityEffect = effectTable?.[rarity];

    // Unknown conceptType or rarity — no-op, no error
    if (!rarityEffect) continue;

    // Aura multiplier — applied to positive reward-side effects only
    const auraMultiplier = 1 + (config.auraScaling?.[auraLevel] ?? 0);

    // Snapshot what this card actually changed
    const effectValue = {};

    switch (conceptType) {

      case 'researchBoost': {
        // % increase to reward RP ONLY — aura-scaled
        const pct    = (rarityEffect.rewardRPPercent ?? 0) * auraMultiplier;
        const rpGain = original.rewardRP * pct;
        rewardRP    += rpGain;
        effectValue.rewardRPPercent = pct;
        effectValue.rpGain          = rpGain;
        break;
      }

      case 'difficultyReduction': {
        // Percentage reduction to difficulty — NOT aura-scaled
        // Applies against the ORIGINAL difficulty so multiple concepts don't compound
        const pct        = rarityEffect.difficultyPercent ?? 0;
        const minFloor   = rarityEffect.minDifficulty ?? 0;
        const reduction  = original.difficulty * pct;
        difficulty       = Math.max(minFloor, difficulty - reduction);
        effectValue.difficultyPercent = pct;
        effectValue.diffReduction     = reduction;
        break;
      }

      case 'synergyBoost': {
        // % increase to team power ONLY — aura-scaled
        const pct       = (rarityEffect.teamPowerPercent ?? 0) * auraMultiplier;
        const powerGain = original.teamPower * pct;
        teamPower      += powerGain;
        effectValue.teamPowerPercent = pct;
        effectValue.powerGain        = powerGain;
        break;
      }

      case 'breakthrough': {
        // Flat addition to breakthrough chance — aura-scaled
        const chanceGain    = (rarityEffect.breakthroughChance ?? 0) * auraMultiplier;
        breakthroughChance += chanceGain;
        effectValue.breakthroughChance = chanceGain;
        break;
      }

      case 'risk': {
        // % increase to reward RP — aura-scaled
        const rpPct  = (rarityEffect.rewardRPPercent ?? 0) * auraMultiplier;
        const rpGain = original.rewardRP * rpPct;
        rewardRP    += rpGain;
        effectValue.rewardRPPercent = rpPct;
        effectValue.rpGain          = rpGain;

        // % increase to difficulty — NOT aura-scaled
        const diffPct  = rarityEffect.difficultyPercent ?? 0;
        const diffGain = original.difficulty * diffPct;
        difficulty    += diffGain;
        effectValue.difficultyPercent = diffPct;
        effectValue.diffGain          = diffGain;
        break;
      }

      default:
        // Unknown conceptType — skip silently
        seenTypes.delete(conceptType);  // don't block a future valid card of same key
        continue;
    }

    appliedConcepts.push({ cardId, name, conceptType, rarity, auraLevel, effectValue });
  }

  const modified = { teamPower, difficulty, rewardRP, breakthroughChance };

  return { original, modified, appliedConcepts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Project Evaluation  (Phase 2C-1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic orchestration: combine team power, concept modifiers,
 * success chance, and success label into a single evaluation snapshot.
 *
 * Pure function — no randomness, no side effects, no I/O.
 *
 * @param {{
 *   scientists:        Object[],  // scientist card objects
 *   concepts:          Object[],  // concept card objects
 *   difficulty:        number,    // base project difficulty
 *   rewardRP:          number,    // base RP reward
 *   breakthroughChance: number,   // base breakthrough probability (0–1)
 * }} params
 *
 * @returns {{
 *   teamPower:        ReturnType<getTeamPower>,
 *   difficulty:       number,
 *   rewardRP:         number,
 *   breakthroughChance: number,
 *   successChance:    number,
 *   successLabel:     string,
 *   conceptsApplied:  Array,
 * }}
 */
export function evaluateProject({
  scientists       = [],
  concepts         = [],
  difficulty       = 0,
  rewardRP         = 0,
  breakthroughChance = 0,
} = {}) {

  // STEP A — scientist team power
  const teamPower = getTeamPower(scientists);

  // STEP B — build initial state (no mutation of inputs)
  const baseState = {
    teamPower:          teamPower.totalPower,
    difficulty,
    rewardRP,
    breakthroughChance,
  };

  // STEP C — apply concept card modifiers
  const conceptResult = applyConceptModifiers(baseState, concepts);

  // STEP D — calculate success chance
  // Clamp difficulty minimum to 1 before passing to the formula
  const effectiveDifficulty = Math.max(1, conceptResult.modified.difficulty);
  const chanceResult = calculateSuccessChance(
    conceptResult.modified.teamPower,
    effectiveDifficulty,
  );

  // STEP E — generate success label
  const successLabel = getSuccessLabel(chanceResult.chance);

  return {
    teamPower,
    difficulty:          conceptResult.modified.difficulty,
    rewardRP:            conceptResult.modified.rewardRP,
    breakthroughChance:  conceptResult.modified.breakthroughChance,
    successChance:       chanceResult.chance,
    successLabel,
    conceptsApplied:     conceptResult.appliedConcepts,
  };
}

// ─────────────────────────────────────────────────────────────���───────────────
// Outcome Roll  (Phase 2C-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Roll for project success and breakthrough using Math.random().
 *
 * Pure function — the only intentional side effect is reading Math.random().
 * Breakthrough is gated behind success: if the project fails, breakthrough
 * is always false regardless of breakthroughChance.
 *
 * @param {{
 *   successChance:     number,  // probability of success (0–1)
 *   breakthroughChance: number, // probability of breakthrough given success (0–1)
 * }} params
 *
 * @returns {{
 *   success:     boolean,
 *   breakthrough: boolean,
 * }}
 */
export function rollProjectOutcome({
  successChance      = 0,
  breakthroughChance = 0,
} = {}) {
  // Clamp both chances to [0, 1] — no mutation of inputs
  const clampedSuccess     = Math.min(1, Math.max(0, successChance));
  const clampedBreakthrough = Math.min(1, Math.max(0, breakthroughChance));

  const success      = Math.random() <= clampedSuccess;
  // Breakthrough is only possible when the project succeeds
  const breakthrough = success && Math.random() <= clampedBreakthrough;

  return { success, breakthrough };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reward Packaging  (Phase 2C-2)
// ─────────────────────────────────────────────────────────────────────────────

// ────��────────────────────────────────────────────────────────────────────────
// RP Rounding Utility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Round a final RP value to a whole integer.
 * All player-facing RP payouts must pass through this.
 * Telemetry / intermediate calculations may remain as floats.
 * @param {number} rp
 * @returns {number}
 */
function roundRP(rp) {
  return Math.round(rp);
}

// ─────────────────────────────────────────────────────────────────────────────
// Breakthrough Config Helpers — read from PROJECT_CONFIG (admin-tunable)
// ─────────────────────────────────────────────────────────────────────────────

function getBreakthroughRPChance() {
  return PROJECT_CONFIG.breakthroughBonus?.rpChance               ?? 0.85;
}
function getBreakthroughCardChance() {
  return PROJECT_CONFIG.breakthroughBonus?.cardChance              ?? 0.15;
}
function getBreakthroughBonusPercent() {
  return PROJECT_CONFIG.breakthroughBonus?.breakthroughBonusPercent ?? 0.50;
}

/**
 * Package the reward result for a completed (or failed) project.
 *
 * Does NOT write to the database, does NOT generate cards,
 * does NOT import any external system.
 *
 * Breakthrough split (only evaluated when breakthrough === true):
 *   rpChance    → bonus RP = round(baseRP * breakthroughBonusPercent), all from config
 *   cardChance  → card reward using breakthroughCard placeholder
 *
 * @param {{
 *   success:              boolean,
 *   breakthrough:         boolean,
 *   rewardRP:             number,   // successRP to grant on success
 *   failureRP:            number,   // failureRP to grant on failure (when allowFailureRewards is true)
 *   allowFailureRewards:  boolean,  // whether failure grants any RP at all
 *   breakthroughCard:     any,      // opaque placeholder; passed through as-is
 * }} params
 *
 * @returns {{
 *   success:     boolean,
 *   rpEarned:    number,
 *   breakthrough: boolean,
 *   rewards:     Array<{ type: 'rp', amount: number }
 *                     | { type: 'card', card: any }>,
 * }}
 */
export function buildProjectRewards({
  success              = false,
  breakthrough         = false,
  rewardRP             = 0,
  failureRP            = 0,
  allowFailureRewards  = true,
  breakthroughCard     = null,
} = {}) {
  // Failed project path
  if (!success) {
    if (allowFailureRewards && failureRP > 0) {
      const roundedFailureRP = roundRP(failureRP);
      return {
        success:     false,
        rpEarned:    roundedFailureRP,
        breakthrough: false,
        rewards:     [{ type: 'rp', amount: roundedFailureRP }],
      };
    }
    return { success: false, rpEarned: 0, breakthrough: false, rewards: [] };
  }

  // Round the base success RP to a whole integer
  const baseRP  = roundRP(rewardRP);
  const rewards = [];
  let rpEarned  = baseRP;

  // Base RP reward entry
  rewards.push({ type: 'rp', amount: baseRP });

  // Breakthrough bonus (only when flagged true — caller already rolled this)
  if (breakthrough) {
    const rpChance = getBreakthroughRPChance();
    if (Math.random() <= rpChance) {
      // RP path — bonus RP is a percentage of the resolved (rounded) base reward
      const bonusPct   = getBreakthroughBonusPercent();
      const bonusRP    = roundRP(baseRP * bonusPct);
      rpEarned        += bonusRP;
      rewards.push({ type: 'rp', amount: bonusRP });
    } else {
      // Card path — placeholder; future systems resolve this
      rewards.push({ type: 'card', card: breakthroughCard ?? null });
    }
  }

  return { success, rpEarned, breakthrough, rewards };
}
