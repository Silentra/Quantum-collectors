/**
 * card-border.js — Border cosmetic render resolution (CSS frame borders).
 *
 * Full-size cards only (.sci-card, .card-detail-frame). Mini-cards excluded by design.
 * Unequipped / null → graphite (virtual default frame).
 */

import { getEquippedBorder } from './profile-ui.js';
import { INTERNAL_DEFAULT_BORDER_ITEM_ID } from './shop-definitions.js';

export { INTERNAL_DEFAULT_BORDER_ITEM_ID };

/** Virtual default — matte graphite frame when no cosmetic border is equipped. */
export const DEFAULT_BORDER_EFFECT_ID = 'graphite';

/** Player-ownable / purchasable border effect ids (excludes internal default graphite). */
export const COSMETIC_BORDER_EFFECT_IDS = [
  'silver',
  'sapphire',
  'emerald',
  'violet',
  'spectrum',
  'diamond_etched',
  'brushed_aluminum',
  'leather_stitch',
  'carbon_weave',
  'stone_slate',
  'marble_inlay',
];

/** All ids recognized by the border renderer (default + purchasable). */
export const BORDER_EFFECT_IDS = [DEFAULT_BORDER_EFFECT_ID, ...COSMETIC_BORDER_EFFECT_IDS];

/**
 * Resolve equipped border definition → data-card-border effect id.
 * null / unequipped / unknown → graphite default.
 * @param {object|null|undefined} borderDefinition - cosmetic item definition
 * @returns {string}
 */
export function resolveBorderRenderEffectId(borderDefinition) {
  const id = borderDefinition?.renderEffectId;
  if (id === DEFAULT_BORDER_EFFECT_ID) {
    return DEFAULT_BORDER_EFFECT_ID;
  }
  if (id && COSMETIC_BORDER_EFFECT_IDS.includes(id)) {
    return id;
  }
  return DEFAULT_BORDER_EFFECT_ID;
}

/**
 * @param {object|null|undefined} playerData
 * @returns {string}
 */
export function resolveBorderRenderEffectIdFromPlayer(playerData) {
  return resolveBorderRenderEffectId(getEquippedBorder(playerData)?.definition);
}

/**
 * @param {string|null|undefined} renderEffectId
 * @returns {Record<string, string>}
 */
export function getCardBorderDataAttrs(renderEffectId) {
  const effect = renderEffectId && BORDER_EFFECT_IDS.includes(renderEffectId)
    ? renderEffectId
    : DEFAULT_BORDER_EFFECT_ID;
  return { 'data-card-border': effect };
}

/**
 * @param {string|null|undefined} renderEffectId
 * @returns {string}
 */
export function formatCardBorderAttr(renderEffectId) {
  const attrs = getCardBorderDataAttrs(renderEffectId);
  return `data-card-border="${attrs['data-card-border']}"`;
}
