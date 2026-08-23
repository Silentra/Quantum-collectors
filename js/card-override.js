/**
 * Pure card override helpers (Batch D2).
 * No Firebase / DB / cards.js imports — safe for unit tests and cards.js composition.
 *
 * Runtime: BASE + raw Firebase layer → applyCardOverride → resolved card.
 * Admin:  edited resolved vs base → buildCardOverride → sparse Firebase child.
 */

/** Persisted semantic fields compared for sparse overrides (from D1 export contract). */
export const CARD_OVERRIDE_COMPARE_KEYS = Object.freeze([
  'name',
  'rarity',
  'type',
  'field',
  'effect',
  'enabled',
  'conceptType',
  'flavorText',
]);

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const CARD_TYPES = ['scientist', 'concept'];
const VALID_CONCEPT_TYPES = [
  'researchBoost',
  'difficultyReduction',
  'risk',
  'synergyBoost',
  'breakthrough',
];

/**
 * Effective art URL for semantic comparison / display preference.
 * @param {object|null|undefined} card
 * @returns {string}
 */
export function effectiveCardImage(card) {
  if (!card || typeof card !== 'object') return '';
  return String(card.imageUrl || card.image || '');
}

/**
 * Effective fact/flavor text for semantic comparison.
 * @param {object|null|undefined} card
 * @returns {string}
 */
export function effectiveCardFlavor(card) {
  if (!card || typeof card !== 'object') return '';
  return String(card.keyFact || card.flavor || '');
}

/**
 * Sync compatibility aliases from semantic values (Admin / export style).
 * @param {object} card
 * @returns {object}
 */
export function syncCardAliases(card) {
  const image = effectiveCardImage(card);
  const flavor = effectiveCardFlavor(card);
  return {
    ...card,
    image,
    imageUrl: image,
    flavor,
    keyFact: flavor,
  };
}

/**
 * Finalize a complete (already merged) card definition for runtime.
 * Mirrors cards.js normalizeCard defaults; preserves flavorText + id.
 * @param {object} data
 * @returns {object}
 */
export function finalizeCompleteCard(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('finalizeCompleteCard requires an object');
  }

  const synced = syncCardAliases(data);
  const type = CARD_TYPES.includes(synced.type) ? synced.type : 'concept';
  const card = {
    id: synced.id,
    name: synced.name || 'Unnamed Card',
    rarity: RARITIES.includes(synced.rarity) ? synced.rarity : 'common',
    type,
    field: synced.field || 'General',
    effect: synced.effect != null ? String(synced.effect) : '',
    image: synced.image || '',
    flavor: synced.flavor || '',
    imageUrl: synced.imageUrl || synced.image || '',
    keyFact: synced.keyFact || synced.flavor || '',
    enabled: synced.enabled !== undefined ? !!synced.enabled : true,
  };

  if (type === 'concept') {
    if (synced.conceptType && VALID_CONCEPT_TYPES.includes(synced.conceptType)) {
      card.conceptType = synced.conceptType;
    } else {
      card.conceptType = 'researchBoost';
    }
    if (typeof synced.flavorText === 'string') {
      card.flavorText = synced.flavorText;
    }
  }

  return syncCardAliases(card);
}

/**
 * Resolve full catalog from bundled base + raw Firebase layer (pure).
 * @param {Iterable<object>} baseDefinitions
 * @param {object|null|undefined} firebaseLayer
 * @returns {object[]}
 */
export function resolveAllCards(baseDefinitions, firebaseLayer) {
  const baseById = new Map();
  for (const card of baseDefinitions || []) {
    if (card && card.id) baseById.set(card.id, card);
  }
  const layer =
    firebaseLayer != null && typeof firebaseLayer === 'object' && !Array.isArray(firebaseLayer)
      ? firebaseLayer
      : {};
  const ids = new Set([...baseById.keys(), ...Object.keys(layer)]);
  const cards = [];
  for (const id of ids) {
    const hasRaw = Object.prototype.hasOwnProperty.call(layer, id);
    const raw = hasRaw ? layer[id] : undefined;
    const resolved = applyCardOverride(baseById.get(id) || null, hasRaw ? raw : null);
    if (resolved) cards.push(resolved);
  }
  cards.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return cards;
}

/**
 * Apply raw Firebase layer onto optional bundled base (merge BEFORE finalize).
 *
 * @param {object|null|undefined} baseCard - bundled base or null
 * @param {object|null|undefined} rawOverride - Firebase child or null/undefined
 * @returns {object|null} resolved card, or null if neither base nor raw
 */
export function applyCardOverride(baseCard, rawOverride) {
  const hasBase = baseCard != null && typeof baseCard === 'object';
  const hasRaw = rawOverride != null && typeof rawOverride === 'object' && !Array.isArray(rawOverride);

  if (!hasBase && !hasRaw) return null;

  if (!hasBase && hasRaw) {
    const id = rawOverride.id != null ? String(rawOverride.id) : undefined;
    return finalizeCompleteCard({ ...rawOverride, ...(id ? { id } : {}) });
  }

  if (hasBase && !hasRaw) {
    return finalizeCompleteCard({ ...baseCard });
  }

  // base + raw: shallow merge raw on top, then finalize COMPLETE record
  const pathId = baseCard.id;
  const merged = {
    ...baseCard,
    ...rawOverride,
    id: pathId,
  };
  return finalizeCompleteCard(merged);
}

/**
 * Build sparse Firebase override for a bundled base card from an edited resolved card.
 * Alias-only representation differences do not generate overrides.
 *
 * @param {object} baseCard
 * @param {object} editedResolvedCard
 * @returns {object} sparse override ({} if unchanged)
 */
export function buildCardOverride(baseCard, editedResolvedCard) {
  if (!baseCard || typeof baseCard !== 'object') {
    throw new Error('buildCardOverride requires baseCard');
  }
  if (!editedResolvedCard || typeof editedResolvedCard !== 'object') {
    throw new Error('buildCardOverride requires editedResolvedCard');
  }

  const override = {};

  for (const key of CARD_OVERRIDE_COMPARE_KEYS) {
    if (key === 'conceptType' || key === 'flavorText') {
      if (baseCard.type !== 'concept' && editedResolvedCard.type !== 'concept') continue;
    }

    if (key === 'enabled') {
      const baseEn = baseCard.enabled !== false;
      const editEn = editedResolvedCard.enabled !== false;
      if (baseEn !== editEn) override.enabled = editEn;
      continue;
    }

    if (key === 'flavorText') {
      const bs = typeof baseCard.flavorText === 'string' ? baseCard.flavorText : '';
      const es = typeof editedResolvedCard.flavorText === 'string' ? editedResolvedCard.flavorText : '';
      if (es !== bs) override.flavorText = es;
      continue;
    }

    if (key === 'conceptType') {
      const bs = baseCard.conceptType == null ? '' : String(baseCard.conceptType);
      const es = editedResolvedCard.conceptType == null ? '' : String(editedResolvedCard.conceptType);
      if (es !== bs) override.conceptType = editedResolvedCard.conceptType;
      continue;
    }

    const baseVal = baseCard[key];
    const editVal = editedResolvedCard[key];
    if (baseVal === undefined && editVal === undefined) continue;
    // Preserve intentional empty string when it differs from base
    if (editVal !== baseVal) {
      override[key] = editVal === undefined ? '' : editVal;
    }
  }

  // Semantic image / flavor (aliases) — representation-only drift does not emit
  const baseImg = effectiveCardImage(baseCard);
  const editImg = effectiveCardImage(editedResolvedCard);
  if (editImg !== baseImg) {
    override.image = editImg;
    override.imageUrl = editImg;
  }

  const baseFlav = effectiveCardFlavor(baseCard);
  const editFlav = effectiveCardFlavor(editedResolvedCard);
  if (editFlav !== baseFlav) {
    override.flavor = editFlav;
    override.keyFact = editFlav;
  }

  return override;
}
