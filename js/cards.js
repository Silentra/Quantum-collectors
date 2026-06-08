/**
 * Cards Module - Card database management
 *
 * Cards are stored in Firebase at /cards/{cardId}
 *
 * Phase 3 Schema:
 *   id, name, rarity, type, field, effect, image, flavor, created
 *   + imageUrl, keyFact, auraType, enabled
 *
 * NOTE: auraLevel is player-owned progression data (Mathematical Aura), NOT part of the card schema.
 *       auraType on the card definition is DEPRECATED for admin control (Phase 1D).
 *       Legacy shell aura visuals (aura-prismatic, etc.) are RETIRED — see ARCHITECTURE.md.
 *       Future card-surface effects use Shimmer; perimeter effects use Glow (runtime category: aura).
 *
 * Legacy fields (type, effect, image, flavor) preserved for backward compat.
 * New cards should use the Phase 3 fields.
 *
 * Rarities: common, uncommon, rare, epic, legendary
 * Types: scientist, concept
 * auraType (DB legacy): holographic, prismatic, shadow, radiant, cosmic — not read by render pipeline
 */

import * as db from './database.js';

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const CARD_TYPES = ['scientist', 'concept'];
export const AURA_TYPES = ['none', 'holographic', 'prismatic', 'shadow', 'radiant', 'cosmic'];

// ─── Legacy shell aura visuals (RETIRED) ─────────────────────────────────────
// Preserved as compatibility stubs only. Do not use for new rendering.
// Forensic CSS archive: style.css LEGACY_SHELL_AURA_VISUALS block.
// Future default surface effect id: shimmer_prismatic (not yet implemented).

/** @deprecated Legacy shell aura id — retired from render pipeline */
export const DEFAULT_VISUAL_AURA = 'default_prismatic';

/** @deprecated Legacy aura-* CSS class map — retired from render pipeline */
export const AURA_CSS_MAP = {
  default_prismatic: 'prismatic',
  holographic: 'holographic',
  prismatic: 'prismatic',
  shadow: 'shadow',
  radiant: 'radiant',
  cosmic: 'cosmic',
};

/**
 * @deprecated Legacy shell aura resolver — retired. Returns historical id only.
 * @param {string|null} _profileCosmeticAura
 * @returns {string}
 */
export function resolveVisualAura(_profileCosmeticAura = null) {
  return DEFAULT_VISUAL_AURA;
}

/**
 * @deprecated Legacy aura-* CSS class — retired. Always returns empty string.
 * @param {string} [_visualAura]
 * @returns {string}
 */
export function getAuraCSSClass(_visualAura) {
  return '';
}

/**
 * Valid conceptType values for concept cards.
 * Display labels are UI-only; only internal values are stored.
 */
export const VALID_CONCEPT_TYPES = [
  { label: 'Research Amplifier', value: 'researchBoost' },
  { label: 'Complexity Reducer', value: 'difficultyReduction' },
  { label: 'Synergy Booster', value: 'synergyBoost' },
  { label: 'Breakthrough Catalyst', value: 'breakthrough' },
  { label: 'Risk Enhancer', value: 'risk' },
];

const VALID_CONCEPT_TYPE_VALUES = VALID_CONCEPT_TYPES.map(ct => ct.value);

export const RARITY_COLORS = {
  common: '#9ca3af',
  uncommon: '#22c55e',
  rare: '#3b82f6',
  epic: '#a855f7',
  legendary: '#f59e0b'
};

export const RARITY_EMOJIS = {
  common: '⚪',
  uncommon: '🟢',
  rare: '🔵',
  epic: '🟣',
  legendary: '🟡'
};

export const TYPE_EMOJIS = {
  scientist: '🔬',
  concept: '⚡'
};

export const AURA_EMOJIS = {
  none: '',
  holographic: '🌈',
  prismatic: '💎',
  shadow: '🌑',
  radiant: '☀️',
  cosmic: '🌌'
};

/**
 * Aura tier thresholds by rarity.
 * Each array contains the duplicate counts needed for tier 1, 2, 3.
 * Tier 0 = below first threshold (no aura).
 */
export const AURA_THRESHOLDS = {
  legendary:  [1, 2, 3],
  epic:       [1, 3, 5],
  rare:       [2, 4, 6],
  uncommon:   [2, 5, 8],
  common:     [3, 7, 10],
};

/**
 * Compute the aura tier (0–3) for a card based on how many duplicates the player owns.
 * @param {string} rarity - card rarity
 * @param {number} quantity - total copies owned
 * @returns {number} 0 | 1 | 2 | 3
 */
export function getAuraTier(rarity, quantity) {
  const thresholds = AURA_THRESHOLDS[rarity];
  if (!thresholds) return 0;
  let tier = 0;
  for (const t of thresholds) {
    if (quantity >= t) tier++;
    else break;
  }
  return tier;
}

/**
 * Build a normalized card object from partial input.
 * Ensures all Phase 3 fields exist with safe defaults.
 */
function normalizeCard(data) {
  const type = CARD_TYPES.includes(data.type) ? data.type : 'concept';
  const card = {
    name: data.name || 'Unnamed Card',
    rarity: RARITIES.includes(data.rarity) ? data.rarity : 'common',
    type,
    field: data.field || 'General',
    effect: data.effect || '',
    image: data.image || '',
    flavor: data.flavor || '',
    // Phase 3 fields
    imageUrl: data.imageUrl || data.image || '',
    keyFact: data.keyFact || data.flavor || '',
    // Phase 1D: auraType preserved in DB for backward compat but no longer admin-controlled.
    // auraType: legacy DB field only — not used by render pipeline
    auraType: AURA_TYPES.includes(data.auraType) ? data.auraType : 'none',
    enabled: data.enabled !== undefined ? !!data.enabled : true,
  };

  // conceptType — only meaningful for concept cards
  if (type === 'concept') {
    if (data.conceptType && VALID_CONCEPT_TYPE_VALUES.includes(data.conceptType)) {
      card.conceptType = data.conceptType;
    } else if (data.conceptType) {
      // Malformed value — normalize safely
      console.warn(`[ResearchProjects] Invalid conceptType normalized: "${data.conceptType}" → "researchBoost"`);
      card.conceptType = 'researchBoost';
    } else {
      card.conceptType = data.conceptType || 'researchBoost';
    }
  }

  return card;
}

/**
 * Create a new card in the database
 * Returns the card ID
 */
export function createCard(data) {
  const id = 'card_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
  const card = {
    id,
    ...normalizeCard(data),
    created: Date.now()
  };
  db.set(`cards/${id}`, card);
  return id;
}

/**
 * Get a card by ID
 */
export function getCard(id) {
  return db.get(`cards/${id}`);
}

/**
 * Get all cards
 */
export function getAllCards() {
  return db.getChildren('cards').map(c => c.value);
}

/**
 * Get all enabled cards (for pack generation, collection display)
 */
export function getEnabledCards() {
  return getAllCards().filter(c => c.enabled !== false);
}

/**
 * Get cards by rarity
 */
export function getCardsByRarity(rarity) {
  return getAllCards().filter(c => c.rarity === rarity);
}

/**
 * Get cards by type
 */
export function getCardsByType(type) {
  return getAllCards().filter(c => c.type === type);
}

/**
 * Get unique field/category values across all cards
 */
export function getAllFields() {
  const fields = new Set();
  for (const c of getAllCards()) {
    if (c.field) fields.add(c.field);
  }
  return [...fields].sort();
}

/**
 * Update a card (partial update — shallow merge)
 */
export function updateCard(id, updates) {
  db.update(`cards/${id}`, updates);
}

/**
 * Delete a card
 */
export function deleteCard(id) {
  db.remove(`cards/${id}`);
}

/**
 * Get card count
 */
export function getCardCount() {
  return getAllCards().length;
}

// ---------------------------------------------------------------------------
// Concept display maps (shared between collection + project rendering)
// ---------------------------------------------------------------------------

/** Map conceptType internal values to display labels */
export const CONCEPT_EFFECT_LABELS = {
  researchBoost:      'Research Amplifier',
  difficultyReduction:'Complexity Reducer',
  synergyBoost:       'Synergy Booster',
  breakthrough:       'Breakthrough Catalyst',
  risk:               'Risk Enhancer',
};

/** Map conceptType internal values to flavor text */
export const CONCEPT_FLAVOR_TEXT = {
  researchBoost:      'Amplifies research rewards by a percentage.',
  difficultyReduction:'Reduces the difficulty of projects.',
  synergyBoost:       'Boosts your team\'s effective power by a percentage.',
  breakthrough:       'Increases chances of bonus rewards.',
  risk:               'Increases rewards and difficulty by a percentage — higher stakes.',
};

// ---------------------------------------------------------------------------
// Shared sort helper
// ---------------------------------------------------------------------------

/**
 * Rarity rank map used by sortCardsByRarityAndName.
 * Exported so callers can reference it without re-declaring.
 */
export const RARITY_ORDER = {
  legendary: 0,
  epic:      1,
  rare:      2,
  uncommon:  3,
  common:    4,
};

/**
 * Sort a card array in-place: rarity ascending (legendary first),
 * then alphabetical by name as a tiebreaker.
 *
 * Uses nullish coalescing (??) so legendary (rank 0) is never treated as falsy.
 *
 * @param {object[]} cardArr - Array of card objects with `.rarity` and `.name`.
 * @returns {object[]} The same array, sorted in-place.
 */
export function sortCardsByRarityAndName(cardArr) {
  return cardArr.sort((a, b) => {
    const ra = RARITY_ORDER[a.rarity] ?? 5;
    const rb = RARITY_ORDER[b.rarity] ?? 5;
    if (ra !== rb) return ra - rb;
    return (a.name ?? '').localeCompare(b.name ?? '');
  });
}

// ---------------------------------------------------------------------------

/**
 * Validate that a conceptType value is valid.
 * @param {string} value
 * @returns {boolean}
 */
export function isValidConceptType(value) {
  return VALID_CONCEPT_TYPE_VALUES.includes(value);
}

/**
 * Load-time normalization: scan all existing cards and fix malformed conceptType values.
 * Safe to call at startup — never crashes, logs fixes.
 */
export function normalizeConceptTypes() {
  try {
    const allCards = getAllCards();
    for (const card of allCards) {
      if (card.type !== 'concept') continue;
      if (!card.conceptType || !VALID_CONCEPT_TYPE_VALUES.includes(card.conceptType)) {
        const oldVal = card.conceptType;
        const fixedVal = 'researchBoost';
        console.warn(`[ResearchProjects] Invalid conceptType normalized: "${oldVal}" → "${fixedVal}" (card: ${card.name || card.id})`);
        updateCard(card.id, { conceptType: fixedVal });
      }
    }
  } catch (e) {
    console.warn('[ResearchProjects] conceptType normalization failed gracefully:', e);
  }
}

/**
 * Seed the database with starter science cards
 */
export function seedDefaultCards() {
  if (getAllCards().length > 0) return; // Already seeded

  const starterCards = [
    // Scientists
    { name: 'Isaac Newton', rarity: 'legendary', type: 'scientist', field: 'Physics', effect: 'Gravity Master', flavor: 'Discovered the laws of motion and universal gravitation. Legend says an apple started it all.' },
    { name: 'Albert Einstein', rarity: 'legendary', type: 'scientist', field: 'Physics', effect: 'Relativity Warp', flavor: 'E=mc². Changed our understanding of space, time, and energy forever.' },
    { name: 'Marie Curie', rarity: 'legendary', type: 'scientist', field: 'Chemistry', effect: 'Radioactive Boost', flavor: 'First person to win Nobel Prizes in two different sciences. Pioneer of radioactivity research.' },
    { name: 'Nikola Tesla', rarity: 'epic', type: 'scientist', field: 'Physics', effect: 'Electric Surge', flavor: 'Master of alternating current. Envisioned wireless power over 100 years ago.' },
    { name: 'Niels Bohr', rarity: 'epic', type: 'scientist', field: 'Physics', effect: 'Quantum Shell', flavor: 'His model of the atom introduced quantum mechanics to atomic structure.' },
    { name: 'Richard Feynman', rarity: 'epic', type: 'scientist', field: 'Physics', effect: 'Diagram Draw', flavor: 'Made quantum electrodynamics understandable. Also cracked safes and played bongos.' },
    { name: 'Rosalind Franklin', rarity: 'epic', type: 'scientist', field: 'Biology', effect: 'X-Ray Vision', flavor: 'Her X-ray crystallography was key to discovering DNA\'s double helix structure.' },
    { name: 'Galileo Galilei', rarity: 'rare', type: 'scientist', field: 'Physics', effect: 'Telescope Scan', flavor: 'Father of observational astronomy. Proved the Earth orbits the Sun.' },
    { name: 'Michael Faraday', rarity: 'rare', type: 'scientist', field: 'Physics', effect: 'Induction Field', flavor: 'Discovered electromagnetic induction. Made electric motors possible.' },
    { name: 'James Clerk Maxwell', rarity: 'rare', type: 'scientist', field: 'Physics', effect: 'Wave Unifier', flavor: 'Unified electricity, magnetism, and optics into one theory.' },
    { name: 'Werner Heisenberg', rarity: 'rare', type: 'scientist', field: 'Physics', effect: 'Uncertainty', flavor: 'You can never know both the position and momentum of a particle exactly.' },
    { name: 'Dmitri Mendeleev', rarity: 'rare', type: 'scientist', field: 'Chemistry', effect: 'Periodic Arrange', flavor: 'Created the periodic table and predicted elements that hadn\'t been discovered yet.' },
    { name: 'Ada Lovelace', rarity: 'rare', type: 'scientist', field: 'Computing', effect: 'Algorithm Prime', flavor: 'Wrote the first computer algorithm in 1843, over a century before modern computers.' },
    { name: 'Robert Hooke', rarity: 'uncommon', type: 'scientist', field: 'Physics', effect: 'Spring Force', flavor: 'Hooke\'s Law: F = -kx. Also coined the term "cell" in biology.' },
    { name: 'Ernest Rutherford', rarity: 'uncommon', type: 'scientist', field: 'Physics', effect: 'Nuclear Split', flavor: 'Discovered the atomic nucleus with his gold foil experiment.' },
    { name: 'Archimedes', rarity: 'uncommon', type: 'scientist', field: 'Physics', effect: 'Buoyancy Lift', flavor: 'Eureka! Discovered the principle of buoyancy while taking a bath.' },
    { name: 'Johannes Kepler', rarity: 'uncommon', type: 'scientist', field: 'Astronomy', effect: 'Orbit Predict', flavor: 'Described planetary motion with three elegant mathematical laws.' },
    { name: 'Benjamin Franklin', rarity: 'uncommon', type: 'scientist', field: 'Physics', effect: 'Lightning Rod', flavor: 'Flew a kite in a thunderstorm. Proved lightning is electrical.' },
    { name: 'Tycho Brahe', rarity: 'common', type: 'scientist', field: 'Astronomy', effect: 'Star Chart', flavor: 'Made the most precise astronomical observations before the telescope.' },
    { name: 'Blaise Pascal', rarity: 'common', type: 'scientist', field: 'Physics', effect: 'Pressure Wave', flavor: 'Pascal\'s principle: pressure applied to a fluid is transmitted equally in all directions.' },

    // Concepts
    { name: 'Gravity', rarity: 'rare', type: 'concept', field: 'Physics', effect: 'Pull Force', flavor: 'The force that keeps your feet on the ground and planets in orbit. 9.8 m/s²' },
    { name: 'Electromagnetic Wave', rarity: 'rare', type: 'concept', field: 'Physics', effect: 'Spectrum Blast', flavor: 'Light, radio, X-rays — all the same thing at different wavelengths.' },
    { name: 'Conservation of Energy', rarity: 'epic', type: 'concept', field: 'Physics', effect: 'Energy Shield', flavor: 'Energy cannot be created or destroyed, only transformed from one form to another.' },
    { name: 'Entropy', rarity: 'epic', type: 'concept', field: 'Physics', effect: 'Chaos Increase', flavor: 'The universe tends toward disorder. The second law of thermodynamics in action.' },
    { name: 'Speed of Light', rarity: 'legendary', type: 'concept', field: 'Physics', effect: 'Light Speed', flavor: '299,792,458 m/s. The universe\'s ultimate speed limit.' },
    { name: 'Newton\'s First Law', rarity: 'common', type: 'concept', field: 'Physics', effect: 'Inertia', flavor: 'An object at rest stays at rest. An object in motion stays in motion. Unless a force acts on it.' },
    { name: 'Newton\'s Second Law', rarity: 'common', type: 'concept', field: 'Physics', effect: 'Force = ma', flavor: 'F = ma. The relationship between force, mass, and acceleration.' },
    { name: 'Newton\'s Third Law', rarity: 'common', type: 'concept', field: 'Physics', effect: 'Reaction', flavor: 'For every action, there is an equal and opposite reaction.' },
    { name: 'Kinetic Energy', rarity: 'common', type: 'concept', field: 'Physics', effect: 'Motion Power', flavor: 'KE = ½mv². The energy of movement.' },
    { name: 'Potential Energy', rarity: 'common', type: 'concept', field: 'Physics', effect: 'Stored Power', flavor: 'Energy stored by position or state. Ready to be unleashed.' },
    { name: 'Ohm\'s Law', rarity: 'uncommon', type: 'concept', field: 'Physics', effect: 'Circuit Flow', flavor: 'V = IR. Voltage equals current times resistance.' },
    { name: 'Wave-Particle Duality', rarity: 'rare', type: 'concept', field: 'Physics', effect: 'Dual Nature', flavor: 'Light is both a wave AND a particle. Quantum mechanics is weird.' },
    { name: 'Photosynthesis', rarity: 'uncommon', type: 'concept', field: 'Biology', effect: 'Solar Convert', flavor: '6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂. How plants turn sunlight into food.' },
    { name: 'DNA Double Helix', rarity: 'rare', type: 'concept', field: 'Biology', effect: 'Gene Code', flavor: 'The twisted ladder of life. 3 billion base pairs carry your entire genetic code.' },
    { name: 'Atomic Model', rarity: 'uncommon', type: 'concept', field: 'Chemistry', effect: 'Shell Config', flavor: 'Protons and neutrons in the nucleus, electrons in shells around it.' },
    { name: 'Chemical Bond', rarity: 'common', type: 'concept', field: 'Chemistry', effect: 'Bond Form', flavor: 'Atoms share or transfer electrons to form stable molecules.' },
    { name: 'Friction', rarity: 'common', type: 'concept', field: 'Physics', effect: 'Slow Down', flavor: 'The force that opposes motion between surfaces. Both helpful and annoying.' },
    { name: 'Momentum', rarity: 'uncommon', type: 'concept', field: 'Physics', effect: 'Impact Force', flavor: 'p = mv. The heavier and faster something is, the harder it is to stop.' },
    { name: 'Thermodynamics', rarity: 'rare', type: 'concept', field: 'Physics', effect: 'Heat Engine', flavor: 'The science of heat, energy, and work. Four laws govern everything.' },
    { name: 'Quantum Superposition', rarity: 'legendary', type: 'concept', field: 'Physics', effect: 'Both States', flavor: 'A particle can be in multiple states at once — until you look at it.' },
  ];

  for (const card of starterCards) {
    createCard(card);
  }
}
