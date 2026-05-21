/**
 * card-render.js — Canonical full-card HTML generation
 *
 * Phase 1: collection grid (.sci-card) only. Modal, pack, and breakthrough paths
 * still use inline templates until later normalization phases.
 *
 * Dependencies: cards.js only (no ui.js / project-ui.js imports).
 */

import {
  CONCEPT_EFFECT_LABELS,
  TYPE_EMOJIS,
  getAuraCSSClass,
  getAuraTier,
  resolveVisualAura,
} from './cards.js';

/**
 * @typedef {Object} CardRenderOptions
 * @property {number} [quantity=1]
 * @property {boolean} [isLocked=false]
 * @property {boolean} [isUndiscovered=false]
 * @property {string|null} [profileCosmeticAura=null] - future profile override for resolveVisualAura
 * @property {boolean} [clampKeyFact=true] - grid-clamp class on keyFact (collection default)
 */

/**
 * Normalized view-model for full-card rendering.
 * @param {object} card
 * @param {CardRenderOptions} [options]
 * @returns {object}
 */
export function buildCardRenderModel(card, options = {}) {
  const {
    quantity = 1,
    isLocked = false,
    isUndiscovered = false,
    profileCosmeticAura = null,
    clampKeyFact = true,
  } = options;

  const imageUrl = card.imageUrl || card.image || '';
  const keyFact = card.keyFact || card.flavor || '';
  const field = card.field || 'General';
  const visualAura = resolveVisualAura(profileCosmeticAura);
  const auraTier = isUndiscovered ? 0 : getAuraTier(card.rarity, quantity);
  const auraClass = auraTier > 0 ? getAuraCSSClass(visualAura) : '';
  const emoji = TYPE_EMOJIS[card.type] || '\uD83D\uDD2C';

  const showConceptLabel =
    !isUndiscovered && card.type === 'concept' && card.conceptType;
  const conceptEffectLabel = showConceptLabel
    ? (CONCEPT_EFFECT_LABELS[card.conceptType] || '')
    : '';

  return {
    cardId: card.id,
    name: card.name,
    rarity: card.rarity,
    imageUrl,
    keyFact,
    field,
    emoji,
    quantity,
    auraTier,
    auraClass,
    isLocked,
    isUndiscovered,
    clampKeyFact,
    conceptEffectLabel,
    lockedClass: isLocked ? 'sci-card--locked' : '',
    undiscoveredClass: isUndiscovered ? 'sci-card--undiscovered' : '',
    showQty: !isUndiscovered && quantity > 1,
    showAuraDots: auraTier > 0,
    showLockedBadge: isLocked,
    showUndiscoveredBadge: isUndiscovered,
  };
}

/**
 * Shared card-detail-* inner tree (no shell, no overlays).
 * @param {ReturnType<typeof buildCardRenderModel>} model
 * @returns {string}
 */
export function renderCardContent(model) {
  const conceptEffectLabelHtml = model.conceptEffectLabel
    ? `<div class="concept-effect-label">${model.conceptEffectLabel}</div>`
    : '';

  const artHtml = model.imageUrl
    ? `<img src="${model.imageUrl}" alt="${model.name}">`
    : `<span style="font-size:2rem;opacity:0.4">${model.emoji}</span>`;

  const keyFactClass = model.clampKeyFact ? 'card-detail-keyfact grid-clamp' : 'card-detail-keyfact';
  const keyFactHtml = model.keyFact
    ? `<div class="${keyFactClass}">${model.keyFact}</div>`
    : '';

  return `
      <div class="card-detail-inner">
        <div class="card-detail-header">
          <span class="card-detail-name">${model.name}</span>
          <span class="sci-card-rarity-badge ${model.rarity}">${model.rarity}</span>
        </div>
        ${conceptEffectLabelHtml}
        <div class="card-detail-art">
          ${artHtml}
        </div>
        <div class="card-detail-divider"></div>
        <div class="card-detail-body">
          <div class="card-detail-field">${model.field}</div>
          ${keyFactHtml}
        </div>
      </div>`;
}

/**
 * Collection / grid full card (.sci-card shell).
 * @param {ReturnType<typeof buildCardRenderModel>} model
 * @returns {string}
 */
export function renderSciCard(model) {
  const auraDots = model.showAuraDots
    ? `<div class="sci-card-aura-dots">${
        [1, 2, 3].map(i => `<span class="dot ${i <= model.auraTier ? 'filled' : ''}"></span>`).join('')
      }</div>`
    : '';

  const lockedBadge = model.showLockedBadge
    ? `<div class="sci-card-locked-badge" title="On active research project">\uD83D\uDD2C</div>`
    : '';

  const undiscoveredBadge = model.showUndiscoveredBadge
    ? `<div class="sci-card-undiscovered-badge">Undiscovered</div>`
    : '';

  const qtyBadge = model.showQty
    ? `<div class="sci-card-qty">\u00D7${model.quantity}</div>`
    : '';

  return `
    <div class="sci-card rarity-${model.rarity} ${model.auraClass} ${model.lockedClass} ${model.undiscoveredClass}" data-card-id="${model.cardId}" data-qty="${model.quantity}" data-aura-tier="${model.auraTier}">
      ${qtyBadge}
      ${lockedBadge}
      ${undiscoveredBadge}
      ${renderCardContent(model)}
      ${auraDots}
    </div>
  `;
}

/**
 * Convenience: build model + render collection sci-card in one call.
 * @param {object} card
 * @param {CardRenderOptions} [options]
 * @returns {string}
 */
export function renderCollectionCard(card, options = {}) {
  return renderSciCard(buildCardRenderModel(card, options));
}
