/**
 * achievement-validation.js
 * Side-effect-free guards for claims and admin payloads.
 */

import { CONDITION_MODES, CONDITION_OPS, REWARD_TYPES } from './achievement-config.js';
import { listRegisteredStatKeys } from './achievement-stats.js';
import { isPlayerClaimed, isPlayerUnlocked } from './achievement-engine.js';
import { getCosmeticDefinition, getItemDefinition } from './cosmetic-definitions.js';
import { ITEM_TYPES } from './shop-definitions.js';
import * as db from './database.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const VALID_STATS = new Set(listRegisteredStatKeys());

export function validateAchievementDefinition(definition = {}) {
  if (!definition.id || typeof definition.id !== 'string') {
    return { valid: false, reason: 'invalid_id' };
  }
  if (!Array.isArray(definition.conditions) || definition.conditions.length === 0) {
    return { valid: false, reason: 'conditions_required' };
  }
  for (const cond of definition.conditions) {
    if (!cond?.stat || !VALID_STATS.has(cond.stat)) {
      return { valid: false, reason: 'invalid_stat', stat: cond?.stat };
    }
    if (!CONDITION_OPS.includes(cond.op)) {
      return { valid: false, reason: 'invalid_op', op: cond?.op };
    }
    if (!Number.isFinite(Number(cond.value))) {
      return { valid: false, reason: 'invalid_value' };
    }
  }
  if (definition.conditionMode && !CONDITION_MODES.includes(definition.conditionMode)) {
    return { valid: false, reason: 'invalid_condition_mode' };
  }
  for (const reward of definition.rewards || []) {
    const r = validateReward(reward);
    if (!r.valid) return r;
  }
  return { valid: true };
}

export function validateReward(reward = {}) {
  if (!REWARD_TYPES.includes(reward.type)) {
    return { valid: false, reason: 'invalid_reward_type' };
  }
  if (reward.type === 'rp') {
    if (!Number.isFinite(Number(reward.amount)) || Number(reward.amount) <= 0) {
      return { valid: false, reason: 'invalid_rp_amount' };
    }
    return { valid: true };
  }
  if (reward.type === 'consumable' || reward.type === 'cosmetic') {
    if (!reward.itemId) {
      return { valid: false, reason: 'invalid_item_id' };
    }
    if (reward.type === 'cosmetic') {
      const def = getCosmeticDefinition(reward.itemId);
      if (!def) return { valid: false, reason: 'invalid_item_id' };
      return { valid: true };
    }
    const def = getItemDefinition(reward.itemId);
    if (!def || def.type !== ITEM_TYPES.CONSUMABLE) {
      return { valid: false, reason: 'invalid_item_id' };
    }
    return { valid: true };
  }
  if (reward.type === 'pack') {
    if (!reward.packId || !db.get(`packs/${reward.packId}`)) {
      return { valid: false, reason: 'invalid_pack_id' };
    }
    return { valid: true };
  }
  return { valid: false, reason: 'unsupported_reward' };
}

export function canClaimAchievementReward(player, definition, achievementId) {
  if (!achievementId) return { allowed: false, reason: 'invalid_achievement_id' };
  if (!definition) return { allowed: false, reason: 'definition_not_found' };
  if (!isPlayerUnlocked(player?.achievements, achievementId)) {
    return { allowed: false, reason: 'achievement_not_unlocked' };
  }
  if (isPlayerClaimed(player?.achievements, achievementId)) {
    return { allowed: false, reason: 'already_claimed' };
  }
  if (!Array.isArray(definition.rewards) || definition.rewards.length === 0) {
    return { allowed: false, reason: 'no_rewards' };
  }
  return { allowed: true };
}
