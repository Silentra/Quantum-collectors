/**
 * card-render.js — Canonical full-card HTML generation
 *
 * Phase 1: collection grid (.sci-card)
 * Phase 2: detail modal (.card-detail-frame + modal extras)
 * Phase 3: overflow/layering contract (.card-cosmetic-effects host, inner clip, z-index)
 * Phase 4: pack/breakthrough reveal via variant pack-reveal (tier 0, no duplicate-tier indicators on face)
 * Phase A: proportional CSS Grid on .card-detail-inner (geometry only)
 * Phase B: container-query typography (clamp + cqw/cqh); geometry unchanged
 *
 * Dependencies: cards.js, card-art.js, card-border.js, card-glow.js, card-shimmer.js (no ui.js / project-ui.js imports).
 */

import { renderCardDetailArtHtml, resolveCardArt } from './card-art.js';
import {
  AURA_THRESHOLDS,
  CONCEPT_EFFECT_LABELS,
  CONCEPT_FLAVOR_TEXT,
  TYPE_EMOJIS,
  getAuraTier,
} from './cards.js';
import {
  DEFAULT_BORDER_EFFECT_ID,
  resolveBorderRenderEffectId,
} from './card-border.js';
import {
  formatCardGlowAttr,
  renderGlowHaloLayerHtml,
  renderMoltenEmberLayerHtml,
  resolveGlowRenderEffectIdFromOptions,
} from './card-glow.js';
import {
  formatCardShimmerAttr,
  renderShimmerFaceLayerHtml,
  resolveShimmerRenderEffectId,
} from './card-shimmer.js';

/** Border mount — equipped border paints on .card-cosmetic-effects::before (v1). */
const CARD_COSMETIC_HOST_HTML = '<div class="card-cosmetic-effects" aria-hidden="true"></div>';

/** Pip color for Mathematical Aura tier indicators (modal + collection dots). */
const MATH_AURA_TIER_PIP_COLOR = '#e0e7ff';

/**
 * @typedef {Object} CardRenderOptions
 * @property {number} [quantity=1]
 * @property {boolean} [isLocked=false]
 * @property {boolean} [isUndiscovered=false]
 * @property {string|null} [borderRenderEffectId=null] - resolved data-card-border id; null → graphite default
 * @property {object|null} [equippedBorderDefinition=null] - cosmetic definition; resolved when borderRenderEffectId omitted
 * @property {object|null} [equippedGlowDefinition=null] - equipped glow; resolved when glowRenderEffectId omitted
 * @property {object|null} [equippedShimmerDefinition=null] - equipped shimmer; resolved when shimmerRenderEffectId omitted
 * @property {string|null} [glowRenderEffectId=null] - explicit data-card-glow id (preview overrides)
 * @property {string|null} [shimmerRenderEffectId=null] - explicit data-card-shimmer id (preview overrides)
 * @property {number|null} [auraTierOverride=null] - force Mathematical Aura tier (shimmer preview only)
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
    borderRenderEffectId = null,
    equippedBorderDefinition = null,
    equippedGlowDefinition = null,
    equippedShimmerDefinition = null,
    glowRenderEffectId: glowRenderEffectIdOption = null,
    shimmerRenderEffectId: shimmerRenderEffectIdOption = null,
    auraTierOverride = null,
    variant = 'collection',
  } = options;

  const resolvedBorderRenderEffectId = borderRenderEffectId != null
    ? borderRenderEffectId
    : resolveBorderRenderEffectId(equippedBorderDefinition);

  const isModal = variant === 'modal';
  const isPackReveal = variant === 'pack-reveal';
  const clampKeyFact = options.clampKeyFact ?? (isPackReveal || !isModal);

  const art = resolveCardArt(card);
  const keyFact = card.keyFact || card.flavor || '';
  const field = card.field || 'General';
  let auraTier;
  if (auraTierOverride != null) {
    auraTier = auraTierOverride;
  } else if (isPackReveal) {
    auraTier = 0;
  } else {
    auraTier = isUndiscovered ? 0 : getAuraTier(card.rarity, quantity);
  }

  const emoji = TYPE_EMOJIS[card.type] || '\uD83D\uDD2C';
  const nameLength = (card.name || '').trim().length;
  const nameScaleClass = nameLength >= 30
    ? 'card-detail-name--ultra-long'
    : nameLength >= 22
      ? 'card-detail-name--long'
      : '';

  const hasConceptType = !isUndiscovered && card.type === 'concept' && card.conceptType;
  const conceptEffectLabel = hasConceptType
    ? (CONCEPT_EFFECT_LABELS[card.conceptType] || '')
    : '';
  const showOnCardConceptChip = !isModal && !isPackReveal && !!conceptEffectLabel;

  const shimmerRenderEffectId = shimmerRenderEffectIdOption != null
    ? resolveShimmerRenderEffectId({ auraTier, shimmerDefinition: { renderEffectId: shimmerRenderEffectIdOption } })
    : resolveShimmerRenderEffectId({ auraTier, shimmerDefinition: equippedShimmerDefinition });

  const glowRenderEffectId = glowRenderEffectIdOption != null
    ? resolveGlowRenderEffectIdFromOptions({
      auraTier,
      glowDefinition: { renderEffectId: glowRenderEffectIdOption },
    })
    : resolveGlowRenderEffectIdFromOptions({ auraTier, glowDefinition: equippedGlowDefinition });

  return {
    cardId: card.id,
    name: card.name,
    rarity: card.rarity,
    cardType: card.type,
    artSrc: art.src,
    artSource: art.source,
    artSlug: art.slug,
    /** @deprecated use artSrc — kept for callers that read model.imageUrl */
    imageUrl: art.src || '',
    keyFact,
    field,
    emoji,
    quantity,
    auraTier,
    variant,
    isLocked,
    isUndiscovered,
    clampKeyFact,
    conceptEffectLabel,
    showOnCardConceptChip,
    conceptLabelClass: isModal && conceptEffectLabel ? 'concept-effect-label--modal' : '',
    extraBodyHtml: '',
    lockedClass: isPackReveal ? '' : (isLocked ? 'sci-card--locked' : ''),
    undiscoveredClass: isPackReveal ? '' : (isUndiscovered ? 'sci-card--undiscovered' : ''),
    showQty: !isPackReveal && !isUndiscovered && quantity > 1,
    showAuraDots: !isPackReveal && auraTier > 0,
    showLockedBadge: !isPackReveal && isLocked,
    showUndiscoveredBadge: !isPackReveal && isUndiscovered,
    showRarityDot: true,
    rarityDotClass: `rarity-dot-${card.rarity || 'common'}`,
    nameScaleClass,
    borderRenderEffectId: resolvedBorderRenderEffectId,
    glowRenderEffectId,
    showGlowHalo: glowRenderEffectId != null,
    shimmerRenderEffectId,
    showShimmerFace: shimmerRenderEffectId != null,
  };
}

/**
 * Shared card-detail-* inner tree (no shell, no overlays).
 * @param {ReturnType<typeof buildCardRenderModel>} model
 * @returns {string}
 */
export function renderCardContent(model) {
  const conceptOverlayHtml = model.showOnCardConceptChip
    ? `<div class="card-detail-concept-chip"><div class="concept-effect-label">${model.conceptEffectLabel}</div></div>`
    : '';

  const artHtml = model.artSrc
    ? renderCardDetailArtHtml(
        { name: model.name, type: model.cardType },
        { src: model.artSrc, source: model.artSource, slug: model.artSlug }
      )
    : `<span class="card-detail-art-emoji" aria-hidden="true">${model.emoji}</span>`;

  const keyFactClass = model.clampKeyFact ? 'card-detail-keyfact grid-clamp' : 'card-detail-keyfact';
  const keyFactHtml = model.keyFact
    ? `<div class="${keyFactClass}">${model.keyFact}</div>`
    : '';

  const shimmerFaceHtml = model.showShimmerFace
    ? renderShimmerFaceLayerHtml(model.shimmerRenderEffectId)
    : '';

  return `
      <div class="card-detail-inner">
        <div class="card-detail-header">
          <div class="card-detail-header-row">
            <span class="card-detail-name ${model.nameScaleClass}">${model.name}</span>
          </div>
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
        ${shimmerFaceHtml}
        ${conceptOverlayHtml}
      </div>`;
}

/**
 * Modal aura tier pip bar + next-tier hint (rendered below card frame in .card-detail-meta).
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

  const pipColor = MATH_AURA_TIER_PIP_COLOR;

  return `
    <div class="card-detail-aura-info">
      <span>💎 aura</span>
      <span class="sci-card-rarity-dot ${model.rarityDotClass}" aria-hidden="true"></span>
      <div class="card-detail-aura-tier-bar" style="color:${pipColor}">
        ${[1, 2, 3].map(i => `<span class="pip ${i <= model.auraTier ? 'filled' : ''}"></span>`).join('')}
      </div>
      ${nextTierInfo}
    </div>
  `;
}

/**
 * Concept label in modal metadata region (keeps artwork unobstructed).
 * @param {object} card
 * @returns {string}
 */
export function renderModalConceptTypeBlock(card) {
  if (card.type !== 'concept' || !card.conceptType) return '';
  const label = CONCEPT_EFFECT_LABELS[card.conceptType] || '';
  if (!label) return '';
  return `<section class="card-detail-meta-section card-detail-meta-concept"><div class="concept-effect-label concept-effect-label--modal">${label}</div></section>`;
}

const CARD_DETAIL_AURA_HELPER_TEXT =
  'Duplicate cards enhance visual effects and increase research project strength.';

/**
 * Aura metadata block below the card frame (pips + next-tier hint + helper copy).
 * @param {ReturnType<typeof buildCardRenderModel>} model
 * @param {object} card
 * @returns {string}
 */
export function renderModalAuraMetaSection(model, card) {
  return `
    <section class="card-detail-meta-section card-detail-meta-aura">
      ${renderModalAuraInfoHtml(model, card)}
      <p class="card-detail-aura-helper">${CARD_DETAIL_AURA_HELPER_TEXT}</p>
    </section>
  `;
}

/**
 * Concept flavor block in modal metadata region (below card frame).
 * @param {object} card
 * @returns {string}
 */
export function renderConceptFlavorBlock(card) {
  const resolvedFlavorText = (card.type === 'concept')
    ? (card.flavorText || CONCEPT_FLAVOR_TEXT[card.conceptType] || '')
    : '';
  return resolvedFlavorText
    ? `<section class="card-detail-meta-section card-detail-meta-flavor"><div class="concept-flavor-text">${resolvedFlavorText}</div></section>`
    : '';
}

/**
 * Owned quantity line below modal card.
 * @param {number} quantity
 * @returns {string}
 */
export function renderCardDetailOwnershipLine(quantity) {
  return quantity > 1
    ? `<section class="card-detail-meta-section card-detail-meta-owned"><p class="card-detail-owned-line">Owned: \u00D7${quantity}</p></section>`
    : '';
}

/**
 * Detail modal shell (.card-detail-frame) with shared inner content.
 * @param {ReturnType<typeof buildCardRenderModel>} model
 * @returns {string}
 */
export function renderDetailFrame(model) {
  const borderEffect = model.borderRenderEffectId || DEFAULT_BORDER_EFFECT_ID;
  const glowAttr = formatCardGlowAttr(model.glowRenderEffectId);
  const shimmerAttr = formatCardShimmerAttr(model.shimmerRenderEffectId);
  const glowHaloHtml = model.showGlowHalo
    ? renderGlowHaloLayerHtml(model.glowRenderEffectId)
    : '';
  const moltenEmberHtml = model.showGlowHalo
    ? renderMoltenEmberLayerHtml(model.glowRenderEffectId)
    : '';
  return `
    <div class="card-detail-frame rarity-${model.rarity}" data-aura-tier="${model.auraTier}" data-card-border="${borderEffect}"${glowAttr}${shimmerAttr}>
      ${glowHaloHtml}
      ${CARD_COSMETIC_HOST_HTML}
      ${moltenEmberHtml}
      ${renderCardContent(model)}
    </div>
  `;
}

/**
 * Supplemental metadata below the card asset (aura, flavor, ownership).
 * @param {object} card
 * @param {ReturnType<typeof buildCardRenderModel>} model
 * @param {number} quantity
 * @returns {string}
 */
export function renderCardDetailMeta(card, model, quantity) {
  return `
    <div class="card-detail-meta">
      ${renderModalAuraMetaSection(model, card)}
      ${renderModalConceptTypeBlock(card)}
      ${renderConceptFlavorBlock(card)}
      ${renderCardDetailOwnershipLine(quantity)}
    </div>
  `;
}

/**
 * Full #card-detail-content HTML: clean card asset + metadata stack below.
 * @param {object} card
 * @param {CardRenderOptions} [options]
 * @returns {string}
 */
export function renderCardDetailView(card, options = {}) {
  const {
    quantity = 1,
    borderRenderEffectId = null,
    equippedBorderDefinition = null,
    equippedGlowDefinition = null,
    equippedShimmerDefinition = null,
    glowRenderEffectId = null,
    shimmerRenderEffectId = null,
    auraTierOverride = null,
  } = options;
  const model = buildCardRenderModel(card, {
    quantity,
    variant: 'modal',
    borderRenderEffectId,
    equippedBorderDefinition,
    equippedGlowDefinition,
    equippedShimmerDefinition,
    glowRenderEffectId,
    shimmerRenderEffectId,
    auraTierOverride,
  });

  return `
    <div class="card-detail-view">
      <div class="card-detail-asset">
        ${renderDetailFrame(model)}
      </div>
      ${renderCardDetailMeta(card, model, quantity)}
    </div>
  `;
}

/**
 * Collection / grid full card (.sci-card shell).
 * @param {ReturnType<typeof buildCardRenderModel>} model
 * @returns {string}
 */
export function renderSciCard(model) {
  const auraDots = `
    <div class="sci-card-aura-dots">
      ${model.showRarityDot ? `<span class="sci-card-rarity-dot ${model.rarityDotClass}" aria-hidden="true"></span>` : ''}
      ${model.showAuraDots
        ? [1, 2, 3].map(i => `<span class="dot ${i <= model.auraTier ? 'filled' : ''}"></span>`).join('')
        : ''}
    </div>
  `;

  const lockedBadge = model.showLockedBadge
    ? `<div class="sci-card-locked-badge" title="On active research project">\uD83D\uDD2C</div>`
    : '';

  const undiscoveredBadge = model.showUndiscoveredBadge
    ? `<div class="sci-card-undiscovered-badge">Undiscovered</div>`
    : '';

  const qtyBadge = model.showQty
    ? `<div class="sci-card-qty">\u00D7${model.quantity}</div>`
    : '';

  const borderEffect = model.borderRenderEffectId || DEFAULT_BORDER_EFFECT_ID;
  const glowAttr = formatCardGlowAttr(model.glowRenderEffectId);
  const shimmerAttr = formatCardShimmerAttr(model.shimmerRenderEffectId);
  const glowHaloHtml = model.showGlowHalo
    ? renderGlowHaloLayerHtml(model.glowRenderEffectId)
    : '';
  const moltenEmberHtml = model.showGlowHalo
    ? renderMoltenEmberLayerHtml(model.glowRenderEffectId)
    : '';

  return `
    <div class="sci-card rarity-${model.rarity} ${model.lockedClass} ${model.undiscoveredClass}" data-card-id="${model.cardId}" data-qty="${model.quantity}" data-aura-tier="${model.auraTier}" data-card-border="${borderEffect}"${glowAttr}${shimmerAttr}>
      ${qtyBadge}
      ${lockedBadge}
      ${undiscoveredBadge}
      ${glowHaloHtml}
      ${CARD_COSMETIC_HOST_HTML}
      ${moltenEmberHtml}
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
export function renderPackRevealSciCard(card, options = {}) {
  return renderSciCard(buildCardRenderModel(card, { variant: 'pack-reveal', ...options }));
}

/**
 * Full pack flip wrapper (back + front with canonical sci-card).
 * @param {object} card
 * @param {number} index
 * @returns {string}
 */
export function renderPackCardWrapper(card, index, options = {}) {
  const needsClick = ['rare', 'epic', 'legendary'].includes(card.rarity);
  const glowClass = needsClick ? `rarity-glow-${card.rarity}` : '';

  return `
      <div class="pack-card-wrapper ${glowClass}" data-rarity="${card.rarity}" data-index="${index}">
        <div class="pack-card-flipper">
          <div class="pack-card-back"></div>
          <div class="pack-card-front">
            ${renderPackRevealSciCard(card, options)}
          </div>
        </div>
      </div>
    `;
}
