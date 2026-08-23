/**
 * player-facing-display.js — pure display helpers (Batch B UI polish).
 * No Firebase writes. No mutations. Safe for unit tests.
 */

/**
 * Player-facing consumable visibility:
 * hide only when enabled === false AND quantity === 0.
 *
 * @param {object|null|undefined} definition
 * @param {number} quantity
 * @returns {boolean}
 */
export function shouldDisplayConsumable(definition, quantity) {
  if (!definition || typeof definition !== 'object') return false;
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (definition.enabled === false && qty === 0) return false;
  return true;
}

/**
 * Reverse-map cosmetic itemId → achievement definitions that award it.
 *
 * @param {string} itemId
 * @param {Array<object>} [definitions]
 * @returns {Array<{ id: string, name: string }>}
 */
export function getAchievementSourcesForCosmetic(itemId, definitions = []) {
  if (!itemId || typeof itemId !== 'string') return [];
  const list = Array.isArray(definitions) ? definitions : [];
  const out = [];
  const seen = new Set();

  for (const def of list) {
    if (!def || typeof def !== 'object') continue;
    const rewards = Array.isArray(def.rewards) ? def.rewards : [];
    const matches = rewards.some(
      reward => reward && reward.type === 'cosmetic' && reward.itemId === itemId,
    );
    if (!matches) continue;

    const id = typeof def.id === 'string' ? def.id : '';
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);

    const name = typeof def.name === 'string' && def.name.trim()
      ? def.name.trim()
      : (id || 'Achievement');
    out.push({ id, name });
  }

  return out;
}

/**
 * Muted secondary line for title picker (empty when no achievement source).
 *
 * @param {Array<{ id?: string, name?: string }>} sources
 * @returns {string}
 */
export function formatTitleAchievementSourceLine(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return '';
  const names = sources
    .map(source => (typeof source?.name === 'string' ? source.name.trim() : ''))
    .filter(Boolean);
  if (!names.length) return '';
  return `Earned from: ${names.join(', ')}`;
}

/**
 * Trophy / icon emoji for achievement rows.
 * Unearned → empty (no trophy). Earned/unlocked → definition emoji or 🏆.
 *
 * @param {boolean} unlocked
 * @param {object|null|undefined} definition
 * @returns {string}
 */
export function resolveAchievementRowIconEmoji(unlocked, definition) {
  if (!unlocked) return '';
  const emoji = (definition?.icon?.emoji || '').trim();
  return emoji || '🏆';
}
