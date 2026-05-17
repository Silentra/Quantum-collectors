/**
 * Research Projects Module
 *
 * Currently: config infrastructure only (no project generation, timers, UI, or rewards).
 * Future implementation will add Research Project lifecycle on top of this foundation.
 *
 * Delegates all configuration to quest-config.js:
 *   - DEFAULT_QUEST_CONFIG
 *   - loadQuestConfig()
 *   - getQuestConfig()
 *   - getCardPowerContribution()
 *
 * Internal file name kept as quests.js to avoid risky import-path renaming.
 */

import { loadQuestConfig, getQuestConfig } from './quest-config.js';

/**
 * Initialize Research Project system.
 * Currently loads config only — never crashes startup.
 */
export function initQuests() {
  try {
    loadQuestConfig();
    console.log('[ResearchProjects] Module loaded');
  } catch (e) {
    console.warn('[ResearchProjects] Init error (non-fatal):', e.message);
  }
}

/**
 * Re-export getQuestConfig for convenience so consumers can import from quests.js.
 */
export { getQuestConfig } from './quest-config.js';

/**
 * Re-export power helper for future Research Project calculations.
 */
export { getCardPowerContribution } from './quest-config.js';

/**
 * Placeholder — returns empty array until Research Project system is built.
 */
export function getActiveQuests() {
  return [];
}

/**
 * Placeholder — throws until Research Project system is built.
 */
export function completeQuest() {
  throw new Error('Research Project system not yet implemented');
}
