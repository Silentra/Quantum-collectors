/**
 * card-render.js — Canonical full-card HTML generation
 *
 * Phase 1: collection grid (.sci-card)
 * Phase 2: detail modal (.card-detail-frame + modal extras)
 * Phase 3: overflow/layering contract (.card-cosmetic-effects host, inner clip, z-index)
 * Phase 4: pack/breakthrough reveal via variant pack-reveal (tier 0, no duplicate aura)
 * Phase A: proportional CSS Grid on .card-detail-inner (geometry only; typography unchanged)
 *
 * Dependencies: cards.js only (no ui.js / project-ui.js imports).
 */

import {
  AURA_CSS_MAP,
  AURA_THRESHOLDS,
  CONCEPT_EFFECT_LABELS,
  CONCEPT_FLAVOR_TEXT,
  TYPE_EMOJIS,
  getAuraCSSClass,
  getAuraTier,
  resolveVisualAura,
} from './cards.js';

/** Inert host for future equipped glow/border/shimmer (Phase 3 — no visuals yet). */
const CARD_COSMETIC_HOST_HTML = '<div class="card-cosmetic-effects" aria-hidden="true"></div>';

/** Pip colors for modal aura tier bar (keyed by AURA_CSS_MAP suffix). */
const MODAL_AURA_PIP_COLORS = {
  holographic: '#c084fc',
  prismatic: '#e0e7ff',
  shadow: '#a855f7',
  radiant: '#fbbf24',
  cosmic: '#60a5fa',
};

/**
 * @typedef {Object} CardRenderOptions
 * @property {number} [quantity=1]
 * @property {boolean} [isLocked=false]
 * @property {boolean} [isUndiscovered=false]
 * @property {string|null} [profileCosmeticAura=null] - future profile override for resolveVisualAura
 * @property {boolean} [clampKeyFact] - grid-clamp on keyFact; default false for modal, true for collection
 * @property {'collection'|'modal'|'pack-reveal'} [variant='collection'] - layout/context preset
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
    variant = 'collection',
  } = options;

  const isModal = variant === 'modal';
  const isPackReveal = variant === 'pack-reveal';
  const clampKeyFact = options.clampKeyFact ?? (isPackReveal || !isModal);

  const imageUrl = card.imageUrl || card.image || '';
  const keyFact = card.keyFact || card.flavor || '';
  const field = card.field || 'General';
  const visualAura = resolveVisualAura(profileCosmeticAura);
  const auraCssKey = AURA_CSS_MAP[visualAura] || 'prismatic';

  let auraTier;
  let auraClass;
  if (isPackReveal) {
    auraTier = 0;
    auraClass = '';
  } else {
    auraTier = isUndiscovered ? 0 : getAuraTier(card.rarity, quantity);
    auraClass = auraTier > 0 ? getAuraCSSClass(visualAura) : '';
  }

  const emoji = TYPE_EMOJIS[card.type] || '\uD83D\uDD2C';

  const showConceptLabel = isPackReveal
    ? false
    : isModal
      ? (card.type === 'concept' && card.conceptType)
      : (!isUndiscovered && card.type === 'concept' && card.conceptType);
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
    auraCssKey,
    visualAura,
    variant,
    isLocked,
    isUndiscovered,
    clampKeyFact,
    conceptEffectLabel,
    conceptLabelClass: isModal && conceptEffectLabel ? 'concept-effect-label--modal' : '',
    artFallbackFontSize: isModal ? '3rem' : '2rem',
    extraBodyHtml: '',
    lockedClass: isPackReveal ? '' : (isLocked ? 'sci-card--locked' : ''),
    undiscoveredClass: isPackReveal ? '' : (isUndiscovered ? 'sci-card--undiscovered' : ''),
    showQty: !isPackReveal && !isUndiscovered && quantity > 1,
    showAuraDots: !isPackReveal && auraTier > 0,
    showLockedBadge: !isPackReveal && isLocked,
    showUndiscoveredBadge: !isPackReveal && isUndiscovered,
  };
}

/**
 * Shared card-detail-* inner tree (no shell, no overlays).
 * @param {ReturnType<typeof buildCardRenderModel>} model
 * @returns {string}
 */
export function renderCardContent(model) {
  const conceptLabelClasses = model.conceptLabelClass
    ? `concept-effect-label ${model.conceptLabelClass}`
    : 'concept-effect-label';
  const conceptEffectLabelHtml = model.conceptEffectLabel
    ? `<div class="card-detail-header-meta"><div class="${conceptLabelClasses}">${model.conceptEffectLabel}</div></div>`
    : '';

  const artHtml = model.imageUrl
    ? `<img src="${model.imageUrl}" alt="${model.name}">`
    : `<span style="font-size:${model.artFallbackFontSize};opacity:0.4">${model.emoji}</span>`;

  const keyFactClass = model.clampKeyFact ? 'card-detail-keyfact grid-clamp' : 'card-detail-keyfact';
  const keyFactHtml = model.keyFact
    ? `<div class="${keyFactClass}">${model.keyFact}</div>`
    : '';

  return `
      <div class="card-detail-inner">
        <div class="card-detail-header">
          <div class="card-detail-header-row">
            <span class="card-detail-name">${model.name}</span>
            <span class="sci-card-rarity-badge ${model.rarity}">${model.rarity}</span>
          </div>
          ${conceptEffectLabelHtml}
        </div>
        <div class="card-detail-art">
          ${artHtml}
        </div>
        <div class="card-detail-divider"></div>
        <div class="card-detail-body">
          <div class="card-detail-field">${model.field}</div>
          ${keyFactHtml}
          ${model.extraBodyHtml || ''}
        </div>
      </div>`;
}

/**
 * Modal-only aura tier pip bar + next-tier hint (inside card-detail-body).
 * @param {ReturnType<typeof buildCardRenderModel>} model
 * @param {object} card
 * @returns {string}
 */
export function renderModalAuraInfoHtml(model, card) {
  const nextThresholds = AURA_THRESHOLDS[card.rarity] || [];
  let nextTierInfo = '';
  if (model.auraTier < 3 && nextThresholds[model.auraTier]) {
    nextTierInfo = `<span class="text-surface-500 text-[0.6rem]">Next tier at ${nextThresholds[model.auraTier]}\u00D7</span>`;
  } else if (model.auraTier >= 3) {
    nextTierInfo = `<span class="text-amber-400/70 text-[0.6rem]">Max tier!</span>`;
  }

  const pipColor = MODAL_AURA_PIP_COLORS[model.auraCssKey] || '#94a3b8';

  return `
    <div class="card-detail-aura-info">
      <span>💎 aura</span>
      <div class="card-detail-aura-tier-bar" style="color:${pipColor}">
        ${[1, 2, 3].map(i => `<span class="pip ${i <= model.auraTier ? 'filled' : ''}"></span>`).join('')}
      </div>
      ${nextTierInfo}
    </div>
  `;
}

/**
 * Concept flavor block below the modal frame (unchanged placement).
 * @param {object} card
 * @returns {string}
 */
export function renderConceptFlavorBlock(card) {
  const resolvedFlavorText = (card.type === 'concept')
    ? (card.flavorText || CONCEPT_FLAVOR_TEXT[card.conceptType] || '')
    : '';
  return resolvedFlavorText
    ? `<div class="concept-flavor-text">${resolvedFlavorText}</div>`
    : '';
}

/**
 * Owned quantity line below modal card.
 * @param {number} quantity
 * @returns {string}
 */
export function renderCardDetailOwnershipLine(quantity) {
  return quantity > 1
    ? `<div class="mt-3 text-center text-xs text-surface-500">Owned: \u00D7${quantity}</div>`
    : '';
}

/**
 * Detail modal shell (.card-detail-frame) with shared inner content.
 * @param {ReturnType<typeof buildCardRenderModel>} model
 * @returns {string}
 */
export function renderDetailFrame(model) {
  return `
    <div class="card-detail-frame rarity-${model.rarity}">
      ${CARD_COSMETIC_HOST_HTML}
      ${renderCardContent(model)}
    </div>
  `;
}

/**
 * Full #card-detail-content HTML: frame + flavor block + ownership line.
 * @param {object} card
 * @param {CardRenderOptions} [options]
 * @returns {string}
 */
export function renderCardDetailView(card, options = {}) {
  const { quantity = 1, profileCosmeticAura = null } = options;
  const model = buildCardRenderModel(card, {
    quantity,
    variant: 'modal',
    profileCosmeticAura,
  });
  model.extraBodyHtml = renderModalAuraInfoHtml(model, card);

  return `
    ${renderDetailFrame(model)}
    ${renderConceptFlavorBlock(card)}
    ${renderCardDetailOwnershipLine(quantity)}
  `;
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
      ${CARD_COSMETIC_HOST_HTML}
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

/**
 * Pack/breakthrough face card — tier 0 reveal, no duplicate-tier aura visuals.
 * @param {object} card
 * @returns {string}
 */
export function renderPackRevealSciCard(card) {
  return renderSciCard(buildCardRenderModel(card, { variant: 'pack-reveal' }));
}

/**
 * Full pack flip wrapper (back + front with canonical sci-card).
 * @param {object} card
 * @param {number} index
 * @returns {string}
 */
export function renderPackCardWrapper(card, index) {
  const needsClick = ['rare', 'epic', 'legendary'].includes(card.rarity);
  const glowClass = needsClick ? `rarity-glow-${card.rarity}` : '';

  return `
      <div class="pack-card-wrapper ${glowClass}" data-rarity="${card.rarity}" data-index="${index}">
        <div class="pack-card-flipper">
          <div class="pack-card-back"></div>
          <div class="pack-card-front">
            ${renderPackRevealSciCard(card)}
          </div>
        </div>
      </div>
    `;
}
