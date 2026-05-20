/**
 * achievement-rewards.js
 * Routes achievement rewards through existing authoritative grant systems only.
 */

import { addResearchPoints } from './research.js';
import { addPack } from './player.js';
import { grantConsumable, unlockCosmetic } from './shop-mutations.js';
import { validateReward } from './achievement-validation.js';

/**
 * Grant a single validated reward payload.
 * @param {string} username
 * @param {Object} reward
 */
export function grantAchievementReward(username, reward) {
  const validation = validateReward(reward);
  if (!validation.valid) {
    return { success: false, reason: validation.reason };
  }

  if (reward.type === 'rp') {
    const amount = Math.floor(Number(reward.amount) || 0);
    addResearchPoints(username, amount);
    return { success: true, type: 'rp', amount };
  }

  if (reward.type === 'consumable') {
    const quantity = Math.max(1, Math.floor(Number(reward.quantity) || 1));
    const result = grantConsumable(username, reward.itemId, quantity);
    if (!result.success) return result;
    return { success: true, type: 'consumable', itemId: reward.itemId, quantity };
  }

  if (reward.type === 'cosmetic') {
    const result = unlockCosmetic(username, reward.itemId);
    if (!result.success) return result;
    return { success: true, type: 'cosmetic', itemId: reward.itemId };
  }

  if (reward.type === 'pack') {
    const quantity = Math.max(1, Math.floor(Number(reward.quantity) || 1));
    addPack(username, reward.packId, quantity);
    return { success: true, type: 'pack', packId: reward.packId, quantity };
  }

  return { success: false, reason: 'unsupported_reward' };
}

/**
 * @param {string} username
 * @param {Array} rewards
 */
export function grantAchievementRewards(username, rewards = []) {
  const results = [];
  for (const reward of rewards) {
    results.push(grantAchievementReward(username, reward));
  }
  const failed = results.find(r => !r.success);
  if (failed) {
    return { success: false, reason: failed.reason, results };
  }
  return { success: true, results };
}
