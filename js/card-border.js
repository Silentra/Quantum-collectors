/**
 * card-border.js — Border cosmetic render resolution (v1 CSS borders only).
 *
 * Full-size cards only (.sci-card, .card-detail-frame). Mini-cards excluded by design.
 */

import { getEquippedBorder } from './profile-ui.js';

/** Virtual default — rarity-colored band when no cosmetic border is equipped. */
export const DEFAULT_BORDER_EFFECT_ID = 'default';

/** v1 CSS cosmetic border effect ids (excludes default and legacy ids like quantum). */
export const COSMETIC_BORDER_EFFECT_IDS = ['silver', 'sapphire', 'emerald', 'graphite', 'violet'];

/** All ids recognized by the border renderer (default + v1 cosmetics). */
export const BORDER_EFFECT_IDS = [DEFAULT_BORDER_EFFECT_ID, ...COSMETIC_BORDER_EFFECT_IDS];

/**
 * Resolve equipped border definition → data-card-border effect id.
 * null / unequipped / unknown → default.
 * @param {object|null|undefined} borderDefinition - cosmetic item definition
 * @returns {string}
 */
export function resolveBorderRenderEffectId(borderDefinition) {
  const id = borderDefinition?.renderEffectId;
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
