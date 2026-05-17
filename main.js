/**
 * SciCards - Main Entry Point
 *
 * Initializes all systems in correct order:
 * 1. Database (Firebase RTDB or localStorage fallback)
 * 2. Auth (session restore from localStorage)
 * 3. Config
 * 4. Seed data
 * 5. UI
 */

import * as db from './js/database.js';
import * as config from './js/config.js';
import * as cards from './js/cards.js';
import * as packs from './js/packs.js';
import * as auth from './js/auth.js';
import * as ui from './js/ui.js';

// Research Points infrastructure
import { migrateAllPlayersRP, migrateAllPlayersLeaderboardStats } from './js/research.js';

// Weekly Research Pack
import { migrateAllPlayersWeeklyPack } from './js/weekly-research-pack.js';

// Phase 2A — expanded player schema migration
import { migrateAllPlayersPhase2A } from './js/player-schema.js';

// LB-1: Leaderboard season schema bootstrap
import { ensureLeaderboardSeasonsSchema } from './js/leaderboard-seasons.js';

// Placeholder module init (safe to call, no-ops)
import { initTrading } from './js/trading.js';
import { initQuests } from './js/quests.js';
import { initAchievements } from './js/achievements.js';
import { initSeasonal } from './js/seasonal.js';

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[SciCards] Initializing...');

  try {
    // 1. Initialize database (async — connects to Firebase or falls back)
    await db.initDB();
    console.log('[SciCards] Database initialized');

    // 2. Initialize Auth (async — restores session from localStorage)
    await auth.initAuth();
    console.log('[SciCards] Auth initialized');

    // 3. Load config
    config.loadConfig();
    console.log('[SciCards] Config loaded');

    // 4. Seed default data if empty
    cards.seedDefaultCards();
    packs.seedDefaultPacks();

    // 4b. Normalize existing concept card types (safe, never crashes)
    cards.normalizeConceptTypes();

    // 4c. Migrate existing players to include RP fields (safe, never crashes)
    migrateAllPlayersRP();

    // 4d. LB-1: Migrate players to include leaderboard stat fields (safe, never crashes)
    migrateAllPlayersLeaderboardStats();

    // 4e-2. Weekly Research Pack — migrate existing players to include weekly fields
    migrateAllPlayersWeeklyPack();

    // 4f. Phase 2A — migrate existing players to include expanded schema fields
    migrateAllPlayersPhase2A();

    // 4e. LB-1: Ensure leaderboardSeasons DB schema exists
    ensureLeaderboardSeasonsSchema();

    // 5. Generate starter access codes if none exist
    const existingCodes = db.getChildren('accessCodes');
    if (existingCodes.length === 0) {
      auth.generateAccessCodes(10);
      console.log('[SciCards] Generated 10 starter access codes');
    }

    console.log('[SciCards] Seed data ready');

    // 6. Init placeholder modules
    initTrading();
    initQuests();
    initAchievements();
    initSeasonal();

    // 7. Initialize UI
    ui.init();
    console.log('[SciCards] UI initialized');

    console.log('[SciCards] Ready!');

  } catch (e) {
    console.error('[SciCards] Initialization error:', e);
    const loadingText = document.querySelector('#screen-loading .text-surface-400');
    if (loadingText) {
      loadingText.textContent = 'Error loading game. Please refresh.';
      loadingText.classList.add('text-red-400');
    }
  }
});
