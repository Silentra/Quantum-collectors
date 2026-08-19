/**
 * SciCards - Main Entry Point
 *
 * Initializes all systems in correct order:
 * 1. Database (Firebase RTDB or localStorage fallback)
 * 1b. Shared defs hydration (S2 — beside root listener)
 * 2. Auth (session restore from localStorage)
 * 3. Config
 * 4. Seed data
 * 5. UI
 */

import * as db from './js/database.js';
import * as metrics from './js/db-metrics.js';
import './js/db-read-audit.js'; // S4 personal read-audit / isolation (off by default)
import './js/trade-index.js'; // S5c-A trade index builders + qcTradeIndex DevTools
import {
  hydrateSharedDefs,
  isSharedDefsReady,
  bootstrapAccessCodesOnce,
} from './js/db-hydration.js';
import * as config from './js/config.js';
import * as cards from './js/cards.js';
import * as packs from './js/packs.js';
import * as auth from './js/auth.js';
import * as ui from './js/ui.js';
import { initCardArtFallback } from './js/card-art.js';
import { initPackArtFallback } from './js/pack-art.js';

// LB-1: Leaderboard season schema bootstrap
import { ensureLeaderboardSeasonsSchema } from './js/leaderboard-seasons.js';

// Placeholder module init (safe to call, no-ops)
import { initTrading } from './js/trading.js';
import { initQuests } from './js/quests.js';
import { initAchievements } from './js/achievements.js';
import { initSeasonal } from './js/seasonal.js';

document.addEventListener('DOMContentLoaded', async () => {
  metrics.mark('dom-content-loaded');
  console.log('[SciCards] Initializing...');

  try {
    // 1. Initialize database (async — connects to Firebase or falls back)
    // Production default: scoped (skip root). Emergency: qc_force_root_loading → root once+on.
    await db.initDB();
    console.log('[SciCards] Database initialized');

    // 1b. Phase S2 — explicit sharedDefs once-loads beside root (config/cards/packs/groups).
    // accessCodes intentionally excluded. No current-player or social subscriptions.
    metrics.mark('shared-hydrate-start');
    const sharedHydration = await hydrateSharedDefs();
    metrics.mark('shared-hydrate-complete');
    console.log(
      '[SciCards] Shared hydration:',
      sharedHydration.status,
      'paths=',
      (sharedHydration.pathsHydrated || []).join(','),
      'ready=',
      isSharedDefsReady(),
    );

    // 2. Initialize Auth (async — restores session from localStorage)
    metrics.mark('initAuth-start');
    await auth.initAuth();
    metrics.mark('initAuth-complete');
    console.log('[SciCards] Auth initialized');

    // 3. Load config
    metrics.mark('config-load');
    config.loadConfig();
    console.log('[SciCards] Config loaded');

    // 4. Seed default data if empty — only after that shared path's scoped load completed
    metrics.mark('migrations-start');
    if (db.isPathReady('cards')) {
      cards.seedDefaultCards();
      cards.normalizeConceptTypes();
    } else {
      console.warn('[SciCards] Skipping card seed/normalize — cards path not scoped-ready');
    }
    if (db.isPathReady('packs')) {
      packs.seedDefaultPacks();
    } else {
      console.warn('[SciCards] Skipping pack seed — packs path not scoped-ready');
    }

    // Phase B: bulk all-player migrators removed from ordinary startup.
    // Per-player schema/RP/weekly backfill runs on login via applyPostLoginPlayerMaintenance
    // (normalizePlayerSchema + related). Exported migrateAll* helpers remain for admin/manual use.

    // 4e. LB-1: Ensure leaderboardSeasons DB schema exists (root-on only).
    // S7c scoped: unready ≠ empty — schema ensure runs after archive once-load on LB/Admin enter.
    if (typeof db.isScopedOnlyMode === 'function' && db.isScopedOnlyMode()) {
      console.info('[SciCards S7c] Skipping seasons schema ensure under scoped boot');
    } else {
      ensureLeaderboardSeasonsSchema();
    }

    // 5. Generate starter access codes if none exist (S6a: scoped once-load; not root-dependent)
    const accessBootstrap = await bootstrapAccessCodesOnce();
    if (!accessBootstrap.ok) {
      console.warn(
        '[SciCards] Skipping access-code seed — accessCodes once-load failed:',
        accessBootstrap.error || 'unknown',
      );
    } else if (accessBootstrap.empty) {
      auth.generateAccessCodes(10);
      console.log('[SciCards] Generated 10 starter access codes');
    }

    metrics.mark('migrations-complete');
    console.log('[SciCards] Seed data ready');

    // 6. Init placeholder modules
    initTrading();
    initQuests();
    initAchievements();
    initSeasonal();

    // 6b. Card artwork — delegated img onerror → emoji placeholder
    initCardArtFallback();
    // 6c. Pack card-backs — delegated img onerror → emoji / CSS ::after
    initPackArtFallback();

    // 7. Initialize UI
    metrics.mark('ui-init-start');
    ui.init();
    metrics.mark('ui-init-complete');
    if (auth.getSession()) {
      metrics.mark('enterGame');
    }
    console.log('[SciCards] UI initialized');

    metrics.mark('app-ready');
    console.log('[SciCards] Ready!');
    if (metrics.isEnabled()) {
      console.info('[DB Metrics] Active. Run qcDbMetrics.summary() or qcDbMetrics.help()');
    }

  } catch (e) {
    console.error('[SciCards] Initialization error:', e);
    const loadingText = document.querySelector('#screen-loading .text-surface-400');
    if (loadingText) {
      loadingText.textContent = 'Error loading game. Please refresh.';
      loadingText.classList.add('text-red-400');
    }
  }
});
