/**
 * UI Module - Screen management, tab navigation, rendering
 *
 * This is the main UI controller that wires DOM events to game modules.
 */

import * as auth from './auth.js';
import { resetPlayerPassword, isFirebaseAuthEnabled } from './auth.js';
import * as player from './player.js';
import * as cards from './cards.js';
import {
  buildCardFirebaseConversionPlan,
  downloadRawCardsPreMigrationBackup,
  formatCardConversionPlanSummary,
  CARD_PRE_MIGRATION_BACKUP_FILENAME,
  validateFreshPlanForD4Commit,
  commitCardFirebaseConversionPlan,
} from './card-migration.js';
import { initCardDetailModal, openCardDetailModal } from './card-detail-modal.js';
import { initCosmeticPreviewModal } from './cosmetic-preview-modal.js';
import {
  getAdminCardImageOverride,
  getLocalCardArtPath,
  normalizeCardArtSlug,
  resolveCardArt,
} from './card-art.js';
import { resolvePackArt, renderPackTileArtHtml } from './pack-art.js';
import { buildCardRenderModel, renderPackCardWrapper, renderSciCard } from './card-render.js';
import { resolveBorderRenderEffectIdFromPlayer } from './card-border.js';
import { spawnRevealParticles } from './pack-reveal-effects.js';
import * as packs from './packs.js';
import * as groups from './groups.js';
import * as config from './config.js';
import * as db from './database.js';
import * as toast from './toast.js';
import * as metrics from './db-metrics.js';
import {
  buildAdminRegistryUpdates,
  loadAdminRegistryEntryOnce,
} from './admin-registry.js';
import {
  preparePlayerDirectoryRebuild,
  commitPlayerDirectoryRebuildPlan,
  syncDirectoryUpdateFromPlayer,
  resolvePlayerDirectoryKey,
  DIRECTORY_ROOT,
} from './player-directory.js';
import {
  getPlayerDisplayName,
  validateDisplayName,
  validateDisplayNameChangeMessage,
  playerRequiresDisplayNameChange,
  getDisplayNameChangeMessage,
  buildAdminSetDisplayNamePlayerPaths,
  buildAdminRequireDisplayNameChangePaths,
  buildStudentAuthorizedDisplayNameChangePaths,
  formatAdminIdentityLabel,
  getDirectoryDisplayName,
  compareDirectoryPlayersByDisplayName,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_CHANGE_MESSAGE_MAX_LENGTH,
} from './player-display-name.js';
import {
  filterAndSortAdminDirectoryPlayers,
  buildAdminPlayersSubgroupFilterOptions,
  pruneDraftSubgroupIds,
  countAdminPlayersActiveFilters,
} from './admin-players-filter.js';
import {
  prepareTradeIndexRebuild,
  commitTradeIndexRebuildFresh,
} from './trade-index.js';
import {
  ensureAdminDirectoryScope,
  releaseAdminDirectoryScope,
  isAdminDirectoryReady,
  ensureAdminSelectedPlayerScope,
  releaseAdminSelectedPlayerScope,
  loadAdminAccessCodesOnce,
} from './db-hydration.js';
import { toastAchievementUnlocks } from './achievements.js';
import { getProjectConfig, saveProjectConfig, seedProjectConfigDefaults } from './project-config.js';
import { initLeaderboardUI, renderLeaderboard, enterLeaderboardTab, cleanupLeaderboard } from './leaderboard-ui.js';
import { renderAdminSeasons } from './leaderboard-admin.js';
import { cleanupTrading, enterTradingTab } from './trade-ui.js';
import { ITEM_TYPES } from './shop-definitions.js';
import { renderShopAdminPanel } from './shop-admin.js';
import { renderAchievementsAdminPanel } from './achievements-admin.js';
import { renderCosmeticsAdminPanel } from './cosmetics-admin.js';
import {
  ADMIN_COSMETIC_GRANT_CATEGORY_NAV,
  getCosmeticDefinition,
  getItemDefinition,
  getMergedItemDefinitions,
  listCosmeticDefinitions,
  listGrantableCosmeticsForAdminCategory,
} from './cosmetic-definitions.js';
import { applyShellTheme, resetShellTheme } from './shell-theme.js';
import {
  adminCompleteActiveProject,
  adminGrantResearchPoints,
  adminGrantShopItem,
} from './admin-player-tools.js';
import {
  adminLockPlayer,
  adminUnlockPlayer,
  isPlayerAdminLocked,
  getPlayerLockConsistency,
  playerLockPath,
  playerLockByUidPath,
} from './player-lock.js';
import {
  ADMIN_STAT_CORRECTION_FIELDS,
  ADMIN_STAT_CORRECTION_FIELD_IDS,
  MSG_LOCK_BEFORE_STAT_CORRECTION,
  adminCorrectPlayerStat,
  buildAdminStatCorrectionConfirmOptions,
  previewStatCorrection,
  readPlayerRelativeNumber,
  isConsistentlyAdminLockedForCorrection,
} from './admin-stat-correction.js';

// Project UI subsystem (extracted — Phase 1 refactor)
import {
  renderResearchProjects,
  startProjectHeartbeat,
  stopProjectHeartbeat,
} from './project-ui.js';

// Profile & Shop UI subsystems (extracted — Phase 2 refactor)
import { getEquippedAura, getEquippedShimmer, initFeaturedCardPicker, renderProfile } from './profile-ui.js';
import { renderShop, cleanupShop } from './shop-ui.js';
import { confirmAction } from './confirm-modal.js';
import { confirmAdminPackGrantIfNeeded } from './admin-pack-grant-confirm.js';

// Shared #confirm-modal — re-export for existing importers (project-ui, etc.)
export { confirmAction } from './confirm-modal.js';

// ===================== ADMIN TELEMETRY HELPER =====================

/**
 * Returns true if the current session is a persistent admin player account
 * (NOT the standalone __admin__ emergency session).
 * Used to gate developer-facing telemetry overlays.
 */
function _isPersistentAdmin() {
  const s = auth.getSession();
  return s && s.isAdmin === true && s.username !== '__admin__';
}
// ===================== SCREEN MANAGEMENT =====================

export function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`screen-${screenId}`);
  if (el) el.classList.add('active');

  const isGame = screenId === 'game';
  document.documentElement.classList.toggle('app-mode-game', isGame);
  document.body.classList.toggle('app-mode-game', isGame);
  document.getElementById('app')?.classList.toggle('app-mode-game', isGame);
  if (!isGame) resetShellTheme();
}

// Tab management
function setupTabs() {
  // Main tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const el = document.getElementById(`tab-${tab}`);
      if (el) el.classList.add('active');
      const gameScroll = document.getElementById('game-content-scroll');
      if (gameScroll) gameScroll.scrollTop = 0;
      if (tab === 'collection') renderCollection();
      if (tab === 'packs') renderPacks();
      if (tab === 'research-projects') { renderResearchProjects(); startProjectHeartbeat(); }
      else { stopProjectHeartbeat(); }
      // S5c-D1: release Admin directory before Trading acquires the same path
      if (tab === 'trading') {
        cleanupAdmin();
        void enterTradingTab();
      } else {
        cleanupTrading();
      }
      if (tab === 'shop') { renderShop(); }
      else { cleanupShop(); }
      if (tab === 'profile') renderProfile();
      if (tab === 'leaderboard') { void enterLeaderboardTab(); }
      else { cleanupLeaderboard(); }
      // Leaving Trading already ran cleanupTrading above when tab !== trading
      if (tab === 'admin') { void enterAdminTab(); }
      else { cleanupAdmin(); }
    });
  });

  // Admin sub-tabs
  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.adminTab;
      document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
      const el = document.getElementById(`admin-${tab}`);
      if (el) el.classList.add('active');
      void renderAdminSubTab(tab);
    });
  });
}

// ===================== LOGIN SCREEN =====================

export function setupLoginScreen() {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const adminLoginForm = document.getElementById('admin-login-form');

  document.getElementById('btn-show-register').addEventListener('click', () => {
    loginForm.classList.add('hidden');
    registerForm.classList.remove('hidden');
    adminLoginForm.classList.add('hidden');
    clearLoginMessage();
  });
  document.getElementById('btn-show-login').addEventListener('click', () => {
    loginForm.classList.remove('hidden');
    registerForm.classList.add('hidden');
    clearLoginMessage();
  });
  document.getElementById('btn-show-admin-login').addEventListener('click', () => {
    loginForm.classList.add('hidden');
    adminLoginForm.classList.remove('hidden');
    clearLoginMessage();
  });
  document.getElementById('btn-back-login').addEventListener('click', () => {
    loginForm.classList.remove('hidden');
    adminLoginForm.classList.add('hidden');
    clearLoginMessage();
  });

  document.getElementById('btn-login').addEventListener('click', async () => {
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const result = await auth.login(username, password);
    if (result.success) {
      enterGame();
    } else {
      showLoginMessage(result.error, 'error');
    }
  });

  document.getElementById('btn-register').addEventListener('click', async () => {
    const username = document.getElementById('register-username').value;
    const password = document.getElementById('register-password').value;
    const code = document.getElementById('register-access-code').value;
    const result = await auth.register(username, password, code);
    if (result.success) {
      toast.success('Account created! Welcome to Quantum Collectors!');
      enterGame();
    } else {
      showLoginMessage(result.error, 'error');
    }
  });

  document.getElementById('btn-admin-login').addEventListener('click', async () => {
    const pw = document.getElementById('admin-password').value;
    const result = await auth.adminLogin(pw);
    if (result.success) {
      toast.success('Admin access granted');
      enterGame();
    } else {
      showLoginMessage(result.error, 'error');
    }
  });

  // Enter on keypress
  ['login-username', 'login-password', 'register-username', 'register-password', 'register-access-code', 'admin-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') el.closest('.bg-surface-900')?.querySelector('button')?.click(); });
  });

  // Game closed notice
  if (!config.isGameOpen()) {
    document.getElementById('game-closed-notice')?.classList.remove('hidden');
  }

  const pendingAuthMessage = auth.consumePendingAuthMessage();
  if (pendingAuthMessage) {
    showLoginMessage(pendingAuthMessage, 'error');
  }
}

function showLoginMessage(msg, type) {
  const el = document.getElementById('login-message');
  el.classList.remove('hidden');
  el.className = `mb-4 p-3 rounded-lg text-sm ${type === 'error' ? 'bg-red-900/30 border border-red-700 text-red-300' : 'bg-green-900/30 border border-green-700 text-green-300'}`;
  el.textContent = msg;
}

function clearLoginMessage() {
  document.getElementById('login-message')?.classList.add('hidden');
}

// ===================== GAME SCREEN =====================

/**
 * Slice C — blocking display-name form. Resolves true after successful rename.
 * Resolves false if the user logs out (does not unlock gameplay).
 * @param {string} username
 * @returns {Promise<boolean>}
 */
function presentMandatoryDisplayNameChange(username) {
  return new Promise((resolve) => {
    const modal = document.getElementById('display-name-required-modal');
    const loginEl = document.getElementById('dn-required-login-username');
    const teacherBlock = document.getElementById('dn-required-teacher-block');
    const teacherMsgEl = document.getElementById('dn-required-teacher-message');
    const input = document.getElementById('dn-required-input');
    const errEl = document.getElementById('dn-required-error');
    const saveBtn = document.getElementById('dn-required-save');
    const logoutBtn = document.getElementById('dn-required-logout');

    if (!modal || !saveBtn || !input) {
      resolve(false);
      return;
    }

    const p = player.getPlayer(username) || {};
    if (loginEl) loginEl.textContent = username;
    const teacherMsg = getDisplayNameChangeMessage(p);
    if (teacherBlock && teacherMsgEl) {
      if (teacherMsg) {
        teacherMsgEl.textContent = teacherMsg;
        teacherBlock.classList.remove('hidden');
      } else {
        teacherMsgEl.textContent = '';
        teacherBlock.classList.add('hidden');
      }
    }
    input.value = '';
    if (errEl) {
      errEl.textContent = '';
      errEl.classList.add('hidden');
    }
    saveBtn.disabled = false;

    modal.classList.remove('hidden');

    let settled = false;
    function finish(ok) {
      if (settled) return;
      settled = true;
      modal.classList.add('hidden');
      saveBtn.removeEventListener('click', onSave);
      logoutBtn?.removeEventListener('click', onLogout);
      input.removeEventListener('keydown', onKey);
      resolve(ok);
    }

    async function onSave() {
      const validated = validateDisplayName(input.value);
      if (!validated.ok) {
        if (errEl) {
          errEl.textContent = validated.error;
          errEl.classList.remove('hidden');
        }
        toast.error(validated.error);
        return;
      }

      const current = player.getPlayer(username) || {};
      if (typeof current.displayName === 'string'
        && current.displayName.trim() === validated.displayName) {
        if (errEl) {
          errEl.textContent = 'Choose a different display name than your current one.';
          errEl.classList.remove('hidden');
        }
        return;
      }

      saveBtn.disabled = true;
      if (errEl) errEl.classList.add('hidden');

      const playerKey = resolvePlayerDirectoryKey(username);
      const playerData = player.getPlayer(playerKey) || current;
      const result = await db.updateAcknowledged({
        ...buildStudentAuthorizedDisplayNameChangePaths(playerKey, validated.displayName),
        ...syncDirectoryUpdateFromPlayer(playerKey, {
          ...playerData,
          displayName: validated.displayName,
          requiresDisplayNameChange: false,
          displayNameChangeMessage: null,
        }),
      });

      if (!result.ok) {
        saveBtn.disabled = false;
        const msg = result.error || 'Could not save display name. Try again.';
        if (errEl) {
          errEl.textContent = msg;
          errEl.classList.remove('hidden');
        }
        toast.error(msg);
        return;
      }

      toast.success(`Display name set to "${validated.displayName}"`);
      finish(true);
    }

    async function onLogout() {
      cleanupTrading();
      await auth.logout();
      finish(false);
      location.reload();
    }

    function onKey(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        void onSave();
      }
    }

    saveBtn.addEventListener('click', onSave);
    logoutBtn?.addEventListener('click', onLogout);
    input.addEventListener('keydown', onKey);
    input.focus();
  });
}

export function enterGame() {
  void _enterGameAsync();
}

async function _enterGameAsync() {
  metrics.mark('enterGame');
  const session = auth.getSession();
  if (!session) return;

  // Slice C gate: must complete before unlocking game shell (covers login/register/restore)
  if (session.username && session.username !== '__admin__') {
    let p = player.getPlayer(session.username);
    if (!p) {
      await db.loadPathOnce(`players/${session.username}`, { force: true });
      p = player.getPlayer(session.username);
    }
    while (playerRequiresDisplayNameChange(p)) {
      const ok = await presentMandatoryDisplayNameChange(session.username);
      if (!ok) return;
      p = player.getPlayer(session.username);
      if (playerRequiresDisplayNameChange(p)) {
        toast.error('Display name change is still required.');
      }
    }
  }

  showScreen('game');

  // Phase 5A — derive admin status from persistent player flag OR session flag
  let isAdminUser = session.isAdmin === true;
  if (!isAdminUser && session.username && session.username !== '__admin__') {
    const p = player.getPlayer(session.username);
    if (p && p.isAdmin === true) {
      isAdminUser = true;
      // Sync session to match persisted flag so downstream checks work
      session.isAdmin = true;
    }
  }

  const isStandaloneAdmin = session.username === '__admin__';

  // Persistent admins use normal session enforcement; only __admin__ is exempt.
  auth.ensureSessionGuard();

  document.getElementById('nav-username').textContent = isStandaloneAdmin
    ? '\u2699\uFE0F Admin'
    : getPlayerDisplayName(player.getPlayer(session.username), session.username);

  if (isAdminUser) {
    document.getElementById('admin-tab-btn')?.classList.remove('hidden');
  }

  if (!isStandaloneAdmin) {
    const p = player.getPlayer(session.username);
    if (p && p.group) {
      const badge = document.getElementById('nav-group-badge');
      badge.textContent = groups.getGroupName(p.group);
      badge.classList.remove('hidden');
    }
    applyShellTheme(player.getPlayer(session.username));
  } else {
    resetShellTheme();
  }

  document.getElementById('btn-logout').addEventListener('click', async () => {
    cleanupTrading();
    await auth.logout();
    location.reload();
  });

  renderCollection();
}

// ===================== COLLECTION =====================

function renderCollection() {
  const session = auth.getSession();
  if (!session || session.username === '__admin__') {
    document.getElementById('collection-grid').innerHTML = '<div class="col-span-full text-center text-surface-500 py-8">Admin mode \u2014 use Admin tab to manage.</div>';
    return;
  }

  const inventory = player.getInventory(session.username);
  const filterRarity = document.getElementById('filter-rarity').value;
  const filterType = document.getElementById('filter-type').value;
  const filterSearch = document.getElementById('filter-search').value.toLowerCase();

  // Build owned card map from inventory (enabled cards only)
  const ownedMap = {};
  for (const { cardId, quantity } of inventory) {
    const card = cards.getCard(cardId);
    if (!card) continue;
    if (card.enabled === false) continue;
    if (!ownedMap[cardId]) ownedMap[cardId] = { card, quantity: 0 };
    ownedMap[cardId].quantity += quantity;
  }

  // Build full entry list: all enabled canonical cards, marking unowned ones
  const allEnabled = cards.getEnabledCards();
  const allEntries = allEnabled.map(card => {
    const owned = ownedMap[card.id];
    return {
      card,
      quantity: owned ? owned.quantity : 0,
      undiscovered: !owned || owned.quantity <= 0,
    };
  });

  // Apply filters across both owned and unowned
  let entries = allEntries;
  if (filterRarity !== 'all') entries = entries.filter(e => e.card.rarity === filterRarity);
  if (filterType !== 'all') entries = entries.filter(e => e.card.type === filterType);
  if (filterSearch) entries = entries.filter(e => e.card.name.toLowerCase().includes(filterSearch));

  entries.sort((a, b) => {
    const aOrder = cards.RARITY_ORDER[a.card.rarity] ?? 5;
    const bOrder = cards.RARITY_ORDER[b.card.rarity] ?? 5;
    // Within same rarity: owned cards before unowned, then alphabetical
    if (aOrder !== bOrder) return aOrder - bOrder;
    if (a.undiscovered !== b.undiscovered) return a.undiscovered ? 1 : -1;
    return a.card.name.localeCompare(b.card.name);
  });

  const grid = document.getElementById('collection-grid');
  const empty = document.getElementById('collection-empty');

  if (entries.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');

    // Group entries by rarity, preserving sort order
    const rarityGroups = [];
    let currentRarity = null;
    let currentGroup = [];
    for (const entry of entries) {
      if (entry.card.rarity !== currentRarity) {
        if (currentGroup.length > 0) rarityGroups.push({ rarity: currentRarity, entries: currentGroup });
        currentRarity = entry.card.rarity;
        currentGroup = [entry];
      } else {
        currentGroup.push(entry);
      }
    }
    if (currentGroup.length > 0) rarityGroups.push({ rarity: currentRarity, entries: currentGroup });

    // Render each rarity as a separate row container
    grid.innerHTML = rarityGroups.map(({ rarity, entries: groupEntries }) => `
      <div class="collection-rarity-group" data-rarity="${rarity}">
        <div class="collection-rarity-marker" aria-hidden="true"></div>
        <div class="collection-rarity-content">
          <div class="collection-rarity-label rarity-label-${rarity}">${rarity}</div>
          <div class="collection-rarity-row">
            ${groupEntries.map(({ card, quantity, undiscovered }) => renderPlayerCard(card, quantity, false, undiscovered)).join('')}
          </div>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.sci-card').forEach(el => {
      el.addEventListener('click', () => {
        const cardId = el.dataset.cardId;
        const qty = parseInt(el.dataset.qty, 10) || 1;
        openCardDetailModal(cardId, qty);
      });
    });
  }

  // Stats: owned unique vs total enabled canonical cards
  const enabledCards = cards.getEnabledCards();
  const uniqueOwned = Object.keys(ownedMap).length;
  const totalCards = inventory.reduce((sum, i) => sum + i.quantity, 0);
  document.getElementById('collection-stats').innerHTML = `
    <span>\uD83D\uDCCA ${uniqueOwned}/${enabledCards.length} unique</span>
    <span>\uD83C\uDCCF ${totalCards} total cards</span>
  `;
}

/**
 * Render a player-facing card.
 * Uses the SAME internal structure as the detail modal (card-detail-* classes)
 * wrapped in a .sci-card shell for grid sizing, aura visuals, and click behavior.
 * The modal proportions are the visual reference standard.
 *
 * Collection cards represent ownership state only (project-assigned visuals are hidden here).
 */
function renderPlayerCard(card, quantity = 1, isLocked = false, isUndiscovered = false) {
  const session = auth.getSession();
  const playerData = session && session.username !== '__admin__'
    ? player.getPlayer(session.username)
    : null;
  const borderRenderEffectId = playerData
    ? resolveBorderRenderEffectIdFromPlayer(playerData)
    : null;
  const equippedShimmerDefinition = playerData
    ? getEquippedShimmer(playerData)?.definition ?? null
    : null;
  const equippedGlowDefinition = playerData
    ? getEquippedAura(playerData)?.definition ?? null
    : null;

  const model = buildCardRenderModel(card, {
    quantity,
    isLocked,
    isUndiscovered,
    variant: 'collection',
    borderRenderEffectId,
    equippedShimmerDefinition,
    equippedGlowDefinition,
  });
  return renderSciCard(model);
}

// ===================== PACKS =====================

function renderPacks() {
  const session = auth.getSession();
  if (!session || session.username === '__admin__') return;

  const playerPacksData = player.getPlayerPacks(session.username);
  const allPacks = packs.getEnabledPackTypes();
  const grid = document.getElementById('packs-grid');
  const empty = document.getElementById('packs-empty');

  if (allPacks.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  grid.innerHTML = allPacks.map(pack => {
    const owned = playerPacksData[pack.id] || 0;
    const packArt = resolvePackArt(pack);
    return `
      <div class="bg-surface-900 rounded-xl border border-surface-700 p-5 flex flex-col">
        <div class="text-center mb-3">
          ${renderPackTileArtHtml(packArt)}
          <h3 class="font-bold text-lg">${pack.name}</h3>
          <p class="text-sm text-surface-400">${pack.cardsPerPack} cards per pack</p>
        </div>
        <div class="mt-auto">
          <div class="text-center text-sm mb-2 ${owned > 0 ? 'text-green-400' : 'text-surface-500'}">
            ${owned > 0 ? `You have ${owned}` : 'None owned'}
          </div>
          <button class="btn-open-pack w-full py-2 rounded-lg font-semibold text-sm transition
            ${owned > 0 ? 'bg-primary-600 hover:bg-primary-500 cursor-pointer' : 'bg-surface-700 text-surface-500 cursor-not-allowed'}"
            data-pack-id="${pack.id}" ${owned <= 0 ? 'disabled' : ''}>
            ${owned > 0 ? 'Open Pack' : 'No Packs'}
          </button>
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.btn-open-pack:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => openPackUI(btn.dataset.packId));
  });
}

/** Per-tab mutex — blocks overlapping opens in this tab (navigator.locks covers cross-tab). */
let packOpenInFlight = false;

async function openPackUI(packId) {
  const session = auth.getSession();
  if (!session) return;
  if (packOpenInFlight) return;

  packOpenInFlight = true;
  document.querySelectorAll('.btn-open-pack').forEach(btn => {
    btn.disabled = true;
  });

  try {
    const result = await packs.openPack(session.username, packId);
    if (!result.success) {
      toast.error(result.error || 'Could not open pack.');
      return;
    }

    toastAchievementUnlocks(result.notified || []);

    const packType = packs.getPackType(packId);
    document.getElementById('pack-opening-title').textContent = `${packType?.name || 'Pack'} Opened!`;

    const cardsContainer = document.getElementById('pack-opening-cards');

    const borderRenderEffectId = resolveBorderRenderEffectIdFromPlayer(player.getPlayer(session.username));

    cardsContainer.innerHTML = result.cards
      .map((card, i) => renderPackCardWrapper(card, i, { borderRenderEffectId, pack: packType }))
      .join('');

    // Show overlay only after acknowledged commit
    document.getElementById('pack-opening-overlay').classList.remove('hidden');

    // Stagger fade-in, then auto-flip common/uncommon
    const wrappers = cardsContainer.querySelectorAll('.pack-card-wrapper');
    wrappers.forEach((wrapper, i) => {
      const rarity = wrapper.dataset.rarity;
      const needsClick = ['rare', 'epic', 'legendary'].includes(rarity);
      const flipper = wrapper.querySelector('.pack-card-flipper');

      // Phase in with stagger
      setTimeout(() => {
        wrapper.classList.add('phase-in');

        // Auto-flip common + uncommon after they appear
        if (!needsClick) {
          setTimeout(() => {
            flipper.classList.add('flipped');
            wrapper.classList.add('flipped');
          }, 250);
        }
      }, i * 125);

      // Click-to-reveal for rare, epic, legendary
      if (needsClick) {
        const revealHandler = () => {
          if (flipper.classList.contains('flipped')) return;
          flipper.classList.add('flipped');
          wrapper.classList.add('flipped');

          // Spawn particles for epic/legendary
          if (rarity === 'epic' || rarity === 'legendary') {
            spawnRevealParticles(wrapper, rarity);
          }

          wrapper.removeEventListener('click', revealHandler);
        };
        wrapper.addEventListener('click', revealHandler);
      }
    });
  } finally {
    packOpenInFlight = false;
    renderPacks();
  }
}

// ===================== RESEARCH PROJECTS (delegated to project-ui.js) =====================
// All project-specific rendering, heartbeat, assignment, report, and breakthrough code
// has been extracted to js/project-ui.js (Phase 1 refactor).
// renderResearchProjects, startProjectHeartbeat, stopProjectHeartbeat are imported above.

// ===================== ADMIN =====================

/**
 * Admin main-tab entry: sole network owner for playerDirectory scope.
 * Sub-tab renders (including renderAdminPlayers) must only read cached directory data.
 */
async function enterAdminTab() {
  if (!auth.isAdmin()) return;

  const listEl = document.getElementById('admin-players-list');
  if (listEl) {
    listEl.innerHTML = '<div class="p-4 text-surface-500 text-center">Loading player directory…</div>';
  }

  const scoped = await ensureAdminDirectoryScope();
  if (!scoped.ok) {
    toast.error(scoped.error || 'Failed to load player directory');
    if (listEl) {
      listEl.innerHTML = `<div class="p-4 text-amber-400 text-center text-sm">
        Player directory failed to load. Use <strong>Rebuild Directory</strong> on the Players tab, then re-open Admin.
      </div>`;
    }
    // Still show overview chrome without player count from /players
    renderAdminSubTab('overview');
    return;
  }

  renderAdmin();
}

/**
 * Leave Admin main tab: release Admin-owned directory + selected-player scopes.
 * Does not release auth current-player scope.
 */
function cleanupAdmin() {
  releaseAdminSelectedPlayerScope();
  releaseAdminDirectoryScope();
  document.getElementById('player-detail-modal')?.classList.add('hidden');
  _resetAdminPlayersFilterState();
  _setAdminPlayersFilterPanelOpen(false);
}

function renderAdmin() {
  if (!auth.isAdmin()) return;
  // Prefer currently active admin sub-tab if any; default overview
  const activeBtn = document.querySelector('.admin-tab-btn.active');
  const tab = activeBtn?.dataset?.adminTab || 'overview';
  void renderAdminSubTab(tab);
}

async function renderAdminSubTab(tab) {
  if (tab !== 'players') {
    _resetAdminPlayersFilterState();
    _setAdminPlayersFilterPanelOpen(false);
  }
  switch (tab) {
    case 'overview': renderAdminOverview(); break;
    case 'players': _setupPlayerFilters(); renderAdminPlayers(); break;
    case 'cards': renderAdminCards(); break;
    case 'packs-admin': renderAdminPacks(); break;
    case 'groups': renderAdminGroups(); break;
    case 'access': await renderAdminAccess(); break;
    case 'config': renderAdminConfig(); break;
    case 'balance': renderAdminBalance(); break;
    case 'shop-admin': renderShopAdminPanel(); break;
    case 'achievements-admin': renderAchievementsAdminPanel(); break;
    case 'cosmetics-admin': renderCosmeticsAdminPanel(); break;
    case 'trading-controls': renderAdminTradingControls(); break;
    case 'seasons': await renderAdminSeasons(); break;
  }
}

function renderAdminOverview() {
  // Player count from directory only — never getAllPlayers() during browsing
  const directoryEntries = isAdminDirectoryReady()
    ? db.getChildren(DIRECTORY_ROOT)
    : [];
  const playerCount = directoryEntries.length;
  const allCards = cards.getAllCards();
  const allPacks = packs.getAllPackTypes();
  const allGroups = groups.getAllGroups();

  document.getElementById('admin-stats-grid').innerHTML = `
    <div class="stat-card"><div class="stat-value text-blue-400">${playerCount}</div><div class="stat-label">Players</div></div>
    <div class="stat-card"><div class="stat-value text-green-400">${allCards.length}</div><div class="stat-label">Cards</div></div>
    <div class="stat-card"><div class="stat-value text-purple-400">${allPacks.length}</div><div class="stat-label">Pack Types</div></div>
    <div class="stat-card"><div class="stat-value text-amber-400">${allGroups.length}</div><div class="stat-label">Groups</div></div>
  `;

  const gameOpen = config.isGameOpen();
  const regOpen = config.isRegistrationOpen();

  const toggleGameBtn = document.getElementById('btn-toggle-game');
  toggleGameBtn.textContent = gameOpen ? '🔴 Close Game' : '🟢 Open Game';
  toggleGameBtn.className = `px-4 py-2 rounded-lg font-medium text-sm transition ${gameOpen ? 'bg-red-600 hover:bg-red-500' : 'bg-green-600 hover:bg-green-500'}`;
  toggleGameBtn.onclick = () => {
    config.setValue('gameOpen', !gameOpen);
    toast.info(`Game ${!gameOpen ? 'opened' : 'closed'}`);
    renderAdminOverview();
  };

  const toggleRegBtn = document.getElementById('btn-toggle-registration');
  toggleRegBtn.textContent = regOpen ? '🔒 Close Registration' : '🔓 Open Registration';
  toggleRegBtn.className = `px-4 py-2 rounded-lg font-medium text-sm transition ${regOpen ? 'bg-red-600 hover:bg-red-500' : 'bg-green-600 hover:bg-green-500'}`;
  toggleRegBtn.onclick = () => {
    config.setValue('registrationOpen', !regOpen);
    toast.info(`Registration ${!regOpen ? 'opened' : 'closed'}`);
    renderAdminOverview();
  };
}

// ===================== ADMIN PLAYERS =====================

/** Module-local Admin Players filter state (presentation only; not persisted). */
const _adminPlayersFilter = {
  selectedGroupIds: [],
  selectedSubgroupIds: [],
  includeNoSubgroup: false,
  draftGroupIds: [],
  draftSubgroupIds: [],
  draftIncludeNoSubgroup: false,
  panelOpen: false,
  wired: false,
};

function _resetAdminPlayersFilterState() {
  _adminPlayersFilter.selectedGroupIds = [];
  _adminPlayersFilter.selectedSubgroupIds = [];
  _adminPlayersFilter.includeNoSubgroup = false;
  _adminPlayersFilter.draftGroupIds = [];
  _adminPlayersFilter.draftSubgroupIds = [];
  _adminPlayersFilter.draftIncludeNoSubgroup = false;
  _updateAdminPlayersFilterButton();
}

function _copyIds(ids) {
  return [...new Set((ids || []).map((id) => String(id)).filter(Boolean))];
}

/**
 * Keep Filter popover inside the visible viewport so Clear/Apply stay reachable
 * on short screens and when the Players card is short (sparse/zero results).
 */
function _layoutAdminPlayersFilterPanel() {
  const panel = document.getElementById('admin-player-filter-panel');
  const btn = document.getElementById('admin-player-filter-btn');
  if (!panel || !btn || panel.classList.contains('hidden')) return;

  const rect = btn.getBoundingClientRect();
  const margin = 12;
  const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - margin);
  const spaceAbove = Math.max(0, rect.top - margin);
  const minUsable = 160;
  const preferBelow = spaceBelow >= minUsable || spaceBelow >= spaceAbove;
  const available = Math.max(minUsable, preferBelow ? spaceBelow : spaceAbove);
  const capped = Math.min(available, 28 * 16); // 28rem soft cap
  panel.style.setProperty('--admin-filter-max-h', `${Math.round(capped)}px`);
  panel.classList.toggle('admin-player-filter-panel--above', !preferBelow);
}

function _setAdminPlayersFilterPanelOpen(open) {
  _adminPlayersFilter.panelOpen = !!open;
  const panel = document.getElementById('admin-player-filter-panel');
  const btn = document.getElementById('admin-player-filter-btn');
  if (panel) {
    panel.classList.toggle('hidden', !_adminPlayersFilter.panelOpen);
    if (!_adminPlayersFilter.panelOpen) {
      panel.classList.remove('admin-player-filter-panel--above');
      panel.style.removeProperty('--admin-filter-max-h');
    }
  }
  if (btn) btn.setAttribute('aria-expanded', _adminPlayersFilter.panelOpen ? 'true' : 'false');
  if (_adminPlayersFilter.panelOpen) _layoutAdminPlayersFilterPanel();
}

function _updateAdminPlayersFilterButton() {
  const btn = document.getElementById('admin-player-filter-btn');
  if (!btn) return;
  const count = countAdminPlayersActiveFilters({
    groupIds: _adminPlayersFilter.selectedGroupIds,
    subgroupIds: _adminPlayersFilter.selectedSubgroupIds,
    includeNoSubgroup: _adminPlayersFilter.includeNoSubgroup,
  });
  btn.textContent = count > 0 ? `Filter (${count})` : 'Filter';
  btn.classList.toggle('border-primary-500', count > 0);
  btn.classList.toggle('text-primary-300', count > 0);
}

function _syncDraftFromCommitted() {
  _adminPlayersFilter.draftGroupIds = _copyIds(_adminPlayersFilter.selectedGroupIds);
  _adminPlayersFilter.draftSubgroupIds = _copyIds(_adminPlayersFilter.selectedSubgroupIds);
  _adminPlayersFilter.draftIncludeNoSubgroup = _adminPlayersFilter.includeNoSubgroup === true;
}

function _readDraftFromPanel() {
  const groupIds = [...document.querySelectorAll('#admin-player-filter-groups input[type="checkbox"]:checked')]
    .map((el) => el.value)
    .filter(Boolean);
  const subgroupIds = [...document.querySelectorAll('#admin-player-filter-subgroups input[data-subgroup-id]:checked')]
    .map((el) => el.getAttribute('data-subgroup-id') || el.value)
    .filter(Boolean);
  const includeNoSubgroup = !!document.getElementById('admin-player-filter-no-subgroup')?.checked;
  _adminPlayersFilter.draftGroupIds = _copyIds(groupIds);
  _adminPlayersFilter.draftSubgroupIds = _copyIds(subgroupIds);
  _adminPlayersFilter.draftIncludeNoSubgroup = includeNoSubgroup;
}

function _renderAdminPlayersFilterPanelOptions() {
  const groupsEl = document.getElementById('admin-player-filter-groups');
  const subsEl = document.getElementById('admin-player-filter-subgroups');
  if (!groupsEl || !subsEl) return;

  const allGroups = groups.getAllGroups();
  const draftGroups = _copyIds(_adminPlayersFilter.draftGroupIds);
  const draftSubs = _copyIds(_adminPlayersFilter.draftSubgroupIds);

  groupsEl.innerHTML = allGroups.length
    ? allGroups.map((g) => {
      const checked = draftGroups.includes(String(g.id)) ? 'checked' : '';
      const safeId = String(g.id).replace(/"/g, '&quot;');
      const safeName = String(g.name || g.id)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
      return `<label class="flex items-center gap-2 text-surface-200 cursor-pointer">
        <input type="checkbox" class="admin-player-filter-group-cb accent-primary-500" value="${safeId}" ${checked}>
        <span>${safeName}</span>
      </label>`;
    }).join('')
    : '<p class="text-xs text-surface-500">No groups configured.</p>';

  const subOptions = buildAdminPlayersSubgroupFilterOptions(allGroups, draftGroups);
  const prunedSubs = pruneDraftSubgroupIds(draftSubs, subOptions);
  _adminPlayersFilter.draftSubgroupIds = prunedSubs;

  const noSubChecked = _adminPlayersFilter.draftIncludeNoSubgroup ? 'checked' : '';
  const subRows = [
    `<label class="flex items-center gap-2 text-surface-200 cursor-pointer">
      <input type="checkbox" id="admin-player-filter-no-subgroup" class="accent-primary-500" ${noSubChecked}>
      <span>No Subgroup</span>
    </label>`,
  ];
  for (const opt of subOptions) {
    const checked = prunedSubs.includes(opt.id) ? 'checked' : '';
    const safeId = String(opt.id).replace(/"/g, '&quot;');
    const safeLabel = String(opt.label)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
    subRows.push(`<label class="flex items-center gap-2 text-surface-200 cursor-pointer">
      <input type="checkbox" class="admin-player-filter-sub-cb accent-primary-500" data-subgroup-id="${safeId}" value="${safeId}" ${checked}>
      <span>${safeLabel}</span>
    </label>`);
  }
  subsEl.innerHTML = subRows.join('');

  groupsEl.querySelectorAll('.admin-player-filter-group-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      _readDraftFromPanel();
      _renderAdminPlayersFilterPanelOptions();
      if (_adminPlayersFilter.panelOpen) _layoutAdminPlayersFilterPanel();
    });
  });
}

function _openAdminPlayersFilterPanel() {
  _syncDraftFromCommitted();
  _renderAdminPlayersFilterPanelOptions();
  _setAdminPlayersFilterPanelOpen(true);
  _layoutAdminPlayersFilterPanel();
}

function _setupPlayerFilters() {
  _updateAdminPlayersFilterButton();

  const searchEl = document.getElementById('admin-player-search');
  if (searchEl && !searchEl.dataset.filterWired) {
    searchEl.dataset.filterWired = '1';
    searchEl.addEventListener('input', () => renderAdminPlayers());
  }

  if (!_adminPlayersFilter.wired) {
    _adminPlayersFilter.wired = true;
    const filterBtn = document.getElementById('admin-player-filter-btn');
    filterBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_adminPlayersFilter.panelOpen) {
        _setAdminPlayersFilterPanelOpen(false);
      } else {
        _openAdminPlayersFilterPanel();
      }
    });
    document.getElementById('admin-player-filter-apply')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _readDraftFromPanel();
      _adminPlayersFilter.selectedGroupIds = _copyIds(_adminPlayersFilter.draftGroupIds);
      _adminPlayersFilter.selectedSubgroupIds = _copyIds(_adminPlayersFilter.draftSubgroupIds);
      _adminPlayersFilter.includeNoSubgroup = _adminPlayersFilter.draftIncludeNoSubgroup === true;
      _updateAdminPlayersFilterButton();
      _setAdminPlayersFilterPanelOpen(false);
      renderAdminPlayers();
    });
    document.getElementById('admin-player-filter-clear')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _adminPlayersFilter.selectedGroupIds = [];
      _adminPlayersFilter.selectedSubgroupIds = [];
      _adminPlayersFilter.includeNoSubgroup = false;
      _adminPlayersFilter.draftGroupIds = [];
      _adminPlayersFilter.draftSubgroupIds = [];
      _adminPlayersFilter.draftIncludeNoSubgroup = false;
      _updateAdminPlayersFilterButton();
      _renderAdminPlayersFilterPanelOptions();
      renderAdminPlayers();
    });
    document.getElementById('admin-player-filter-panel')?.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    document.addEventListener('click', () => {
      if (_adminPlayersFilter.panelOpen) _setAdminPlayersFilterPanelOpen(false);
    });
    window.addEventListener('resize', () => {
      if (_adminPlayersFilter.panelOpen) _layoutAdminPlayersFilterPanel();
    });
  }

  const rebuildBtn = document.getElementById('btn-rebuild-player-directory');
  if (rebuildBtn && !rebuildBtn.dataset.wired) {
    rebuildBtn.dataset.wired = '1';
    rebuildBtn.addEventListener('click', async () => {
      rebuildBtn.disabled = true;
      try {
        const prepared = await preparePlayerDirectoryRebuild();
        if (!prepared.ok || !prepared.plan) {
          toast.error(prepared.error || 'Could not load players/directory for rebuild');
          return;
        }

        const confirmed = await confirmAction(
          `Players scanned: ${prepared.scanned}\n`
            + `Create: ${prepared.created}\n`
            + `Update: ${prepared.updated}\n`
            + `Remove: ${prepared.removed}\n`
            + `Unchanged: ${prepared.unchanged}\n\n`
            + 'This does not change player records. Stale directory entries will be removed.',
          'Rebuild Player Directory?'
        );
        if (!confirmed) return;

        const result = await commitPlayerDirectoryRebuildPlan(prepared.plan);
        if (!result.ok) {
          toast.error(result.error || 'Directory rebuild failed');
          return;
        }
        if (result.skipped) {
          toast.info(`Directory already in sync (unchanged: ${result.unchanged})`);
        } else {
          toast.success(
            `Directory rebuilt — created: ${result.created}, updated: ${result.updated}, `
              + `removed: ${result.removed}, unchanged: ${result.unchanged}`,
          );
        }
        renderAdminPlayers();
      } finally {
        rebuildBtn.disabled = false;
      }
    });
  }

  const rebuildTradeIdxBtn = document.getElementById('btn-rebuild-trade-indexes');
  if (rebuildTradeIdxBtn && !rebuildTradeIdxBtn.dataset.wired) {
    rebuildTradeIdxBtn.dataset.wired = '1';
    rebuildTradeIdxBtn.addEventListener('click', async () => {
      rebuildTradeIdxBtn.disabled = true;
      try {
        const prepared = await prepareTradeIndexRebuild();
        if (!prepared.ok) {
          toast.error(prepared.error || 'Could not load trade indexes for rebuild');
          return;
        }

        const confirmed = await confirmAction(
          `Players scanned: ${prepared.playersScanned}\n`
            + `Direct trades scanned: ${prepared.directTradesScanned}\n`
            + `Listings scanned: ${prepared.listingsScanned}\n\n`
            + 'Player Trade Index\n'
            + `  Entries create: ${prepared.ptiCreated}\n`
            + `  Entries update: ${prepared.ptiUpdated}\n`
            + `  Entries remove: ${prepared.ptiRemoved}\n`
            + `  Readiness repairs: ${prepared.ptiReadinessRepairs}\n\n`
            + 'Group Listing Index\n'
            + `  Entries create: ${prepared.groupCreated}\n`
            + `  Entries update: ${prepared.groupUpdated}\n`
            + `  Entries remove: ${prepared.groupRemoved}\n`
            + `  Readiness repairs: ${prepared.groupReadinessRepairs}\n\n`
            + 'This repairs derived Trading indexes only.\n'
            + 'Trade records and inventories are not changed.\n\n'
            + 'Confirm will refresh current Trading data from Firebase before writing.\n'
            + 'Final counts may differ slightly from this preview.',
          'Rebuild Trade Indexes?',
        );
        if (!confirmed) return;

        // S8d-4b: re-gather + fresh plan — never commit the advisory preview plan
        const result = await commitTradeIndexRebuildFresh();
        if (!result.ok) {
          toast.error(result.error || 'Trade index rebuild failed');
          return;
        }
        if (result.skipped) {
          toast.info(
            `Trade indexes already in sync `
            + `(PTI unchanged entries: ${result.ptiUnchanged}, group unchanged: ${result.groupUnchanged})`,
          );
        } else {
          toast.success(
            `Trade indexes rebuilt — `
              + `PTI create/update/remove: ${result.ptiCreated}/${result.ptiUpdated}/${result.ptiRemoved}, `
              + `readiness: ${result.ptiReadinessRepairs}; `
              + `Group create/update/remove: ${result.groupCreated}/${result.groupUpdated}/${result.groupRemoved}, `
              + `readiness: ${result.groupReadinessRepairs}; `
              + `written: ${result.written}`,
          );
        }
      } finally {
        rebuildTradeIdxBtn.disabled = false;
      }
    });
  }
}

function renderAdminPlayers() {
  // Cache-only directory read — never ensureAdminDirectoryScope() here (Admin tab owns network).
  const list = document.getElementById('admin-players-list');
  if (!list) return;

  if (!isAdminDirectoryReady()) {
    list.innerHTML = `<div class="p-4 text-amber-400 text-center text-sm">
      Player directory is not ready. Re-open the Admin tab, or use <strong>Rebuild Directory</strong>.
      Do not fall back to scanning all players.
    </div>`;
    return;
  }

  const allDirectory = db.getChildren(DIRECTORY_ROOT);
  const searchEl = document.getElementById('admin-player-search');
  const search = searchEl?.value || '';

  if (allDirectory.length === 0) {
    list.innerHTML = `<div class="p-4 text-amber-400 text-center text-sm">
      Player directory is empty. Click <strong>Rebuild Directory</strong> to project entries from players
      (one-time admin repair). Normal browsing will not scan /players.
    </div>`;
    return;
  }

  const filtered = filterAndSortAdminDirectoryPlayers(allDirectory, {
    search,
    groupIds: _adminPlayersFilter.selectedGroupIds,
    subgroupIds: _adminPlayersFilter.selectedSubgroupIds,
    includeNoSubgroup: _adminPlayersFilter.includeNoSubgroup,
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="p-4 text-surface-500 text-center">No players found</div>';
    return;
  }

  list.innerHTML = filtered.map(({ key, value: p }) => {
    const visibleLabel = getPlayerDisplayName(p, key);
    const adminBadge = p?.isAdmin === true ? '<span class="ml-2 px-1.5 py-0.5 text-[10px] font-bold bg-yellow-600 text-white rounded uppercase">Admin</span>' : '';
    const tradeBadge = p?.isTradeRestricted === true ? '<span class="ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-red-700 text-white rounded uppercase">Trade Locked</span>' : '';
    const groupLabel = groups.getGroupName(p?.groupId);
    const subgroupLabel = p?.subgroupId ? ` / ${groups.getSubgroupName(p.groupId, p.subgroupId)}` : '';
    const safeKey = String(key).replace(/"/g, '&quot;');
    return `
      <div class="p-3 flex flex-wrap items-center justify-between gap-2 hover:bg-surface-800 player-row" data-username="${safeKey}">
        <div class="min-w-0">
          <span class="font-medium">${visibleLabel}</span>${adminBadge}${tradeBadge}
          <span class="text-xs text-surface-500 ml-2">${groupLabel}${subgroupLabel}</span>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs text-surface-400">
          <button type="button" class="btn-admin-quick-give-packs bg-green-700 hover:bg-green-600 px-2 py-1 rounded text-white" data-username="${safeKey}">
            Give Packs
          </button>
          <button type="button" class="btn-admin-player-detail bg-surface-700 hover:bg-surface-600 px-2 py-1 rounded text-white" data-username="${safeKey}">
            Manage
          </button>
        </div>
      </div>
    `;
  }).join('');

  _updateAdminPlayersFilterButton();

  list.querySelectorAll('.btn-admin-player-detail').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void showPlayerDetail(btn.dataset.username);
    });
  });
  list.querySelectorAll('.btn-admin-quick-give-packs').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAdminQuickGivePacksModal(btn.dataset.username);
    });
  });
}

/** Stable username for the open Quick Give Packs modal (cleared on close). */
let _aqgpUsername = null;

function closeAdminQuickGivePacksModal() {
  _aqgpUsername = null;
  const modal = document.getElementById('admin-quick-give-packs-modal');
  modal?.classList.add('hidden');
  const err = document.getElementById('aqgp-error');
  if (err) {
    err.textContent = '';
    err.classList.add('hidden');
  }
}

/**
 * Open Quick Give Packs for a directory/player key (stable login username).
 * @param {string} usernameKey
 */
function openAdminQuickGivePacksModal(usernameKey) {
  const username = resolvePlayerDirectoryKey(String(usernameKey || '').trim());
  if (!username) {
    toast.error('Player identity missing.');
    return;
  }

  const modal = document.getElementById('admin-quick-give-packs-modal');
  const packSelect = document.getElementById('aqgp-pack-select');
  const qtyInput = document.getElementById('aqgp-pack-qty');
  const displayEl = document.getElementById('aqgp-display-name');
  const loginEl = document.getElementById('aqgp-login-username');
  const errEl = document.getElementById('aqgp-error');
  if (!modal || !packSelect || !qtyInput) {
    toast.error('Give Packs dialog is unavailable.');
    return;
  }

  _aqgpUsername = username;
  const dirEntry = db.get(`${DIRECTORY_ROOT}/${username}`);
  const visible = getPlayerDisplayName(dirEntry || player.getPlayer(username), username);
  if (displayEl) displayEl.textContent = `Give Packs to ${visible}`;
  if (loginEl) loginEl.textContent = `Login Username: ${username}`;

  const allPackTypes = packs.getAllPackTypes();
  packSelect.innerHTML = allPackTypes.length
    ? allPackTypes.map(p => `<option value="${p.id}">${p.name}</option>`).join('')
    : '<option value="">No pack types available</option>';
  qtyInput.value = '1';
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
  modal.classList.remove('hidden');
  packSelect.focus();
}

function setupAdminQuickGivePacksModal() {
  document.getElementById('aqgp-cancel')?.addEventListener('click', () => {
    closeAdminQuickGivePacksModal();
  });
  document.getElementById('admin-quick-give-packs-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAdminQuickGivePacksModal();
  });
  document.getElementById('aqgp-confirm')?.addEventListener('click', async () => {
    const username = _aqgpUsername;
    if (!username) {
      toast.error('No player selected.');
      closeAdminQuickGivePacksModal();
      return;
    }
    const packId = document.getElementById('aqgp-pack-select')?.value;
    const qtyRaw = document.getElementById('aqgp-pack-qty')?.value;
    const errEl = document.getElementById('aqgp-error');
    const quantity = player.parseAdminPackGrantQuantity(qtyRaw);
    const packDef = packs.getPackType(packId);
    const packName = packDef?.name || packId || 'pack';
    const currentQuantity = (() => {
      const raw = player.getPlayerPacks(username)?.[packId];
      const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
    })();
    const dirEntry = db.get(`${DIRECTORY_ROOT}/${username}`);
    const visible = getPlayerDisplayName(dirEntry || player.getPlayer(username), username);
    const confirmed = await confirmAdminPackGrantIfNeeded({
      displayName: visible,
      loginUsername: username,
      packName,
      grantQuantity: quantity,
      currentQuantity,
    });
    if (!confirmed) return;
    const result = player.adminGrantPacks(username, packId, quantity);
    if (!result.ok) {
      if (errEl) {
        errEl.textContent = result.error || 'Could not give packs.';
        errEl.classList.remove('hidden');
      }
      toast.error(result.error || 'Could not give packs.');
      return;
    }
    toast.success(`Gave ${result.quantity} pack(s) to ${visible}`);
    closeAdminQuickGivePacksModal();
  });
}

function _formatAdminLabel(value) {
  if (!value || typeof value !== 'string') return 'Unknown';
  return value.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function _pickInitialAdminGrantCosmeticCategory() {
  for (const { id } of ADMIN_COSMETIC_GRANT_CATEGORY_NAV) {
    if (listGrantableCosmeticsForAdminCategory(id).length) return id;
  }
  return ADMIN_COSMETIC_GRANT_CATEGORY_NAV[0]?.id ?? 'titles';
}

function _renderAdminGrantCosmeticCategoryOptions(selectedId) {
  return ADMIN_COSMETIC_GRANT_CATEGORY_NAV.map(({ id, label }) => `
      <option value="${id}"${id === selectedId ? ' selected' : ''}>${label}</option>
    `).join('');
}

function _renderAdminGrantCosmeticItemOptions(navId) {
  const items = listGrantableCosmeticsForAdminCategory(navId);
  if (!items.length) {
    return '<option value="">— No cosmetics —</option>';
  }
  return items.map(def => {
    const safeName = String(def.name || def.id || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
    return `<option value="${String(def.id).replace(/"/g, '&quot;')}">${safeName}</option>`;
  }).join('');
}

function _renderShopItemOptions(type) {
  const items = type === ITEM_TYPES.COSMETIC
    ? listCosmeticDefinitions({ shopEligibleOnly: true })
    : Object.values(getMergedItemDefinitions()).filter(d => d?.type === type && d.enabled !== false && d.deleted !== true);

  return items
    .map(definition => {
      const category = _formatAdminLabel(definition.category);
      return `<option value="${definition.id}">${definition.name || definition.id} (${category})</option>`;
    })
    .join('');
}

function _renderAdminRuntimeSnapshot(p) {
  const items = p.items || {};
  const ownedCosmetics = p.cosmetics?.owned || {};
  const profile = p.profile || {};
  const slots = Array.isArray(p.shop?.currentRotation?.slots)
    ? p.shop.currentRotation.slots
    : [];
  const consumables = Object.entries(items)
    .filter(([, qty]) => Number(qty) > 0)
    .map(([itemId, qty]) => {
      const def = getItemDefinition(itemId);
      return `<div class="flex justify-between"><span>${def?.name || itemId}</span><span>${qty}</span></div>`;
    })
    .join('');
  const cosmeticsOwned = Object.entries(ownedCosmetics)
    .filter(([, owned]) => owned === true)
    .map(([itemId]) => {
      const def = getCosmeticDefinition(itemId);
      return `<div>${def?.name || itemId} <span class="text-surface-500">(${_formatAdminLabel(def?.category)})</span></div>`;
    })
    .join('');
  const shopSnapshot = slots.slice(0, 12).map((slot, index) => {
    const def = getItemDefinition(slot?.itemId);
    const flags = [
      slot?.purchased ? 'purchased' : '',
      slot?.frozen ? 'frozen' : '',
      slot?.discountApplied ? 'discount' : '',
    ].filter(Boolean).join(', ') || 'open';
    return `<div class="flex justify-between gap-2"><span>#${index + 1} ${def?.name || slot?.itemId || 'Unknown'}</span><span class="text-surface-500">${flags}</span></div>`;
  }).join('');

  return `
    <div class="bg-surface-800 rounded-lg p-4">
      <h4 class="font-semibold text-sm mb-2">Shop / Economy Snapshot <span class="text-xs text-surface-500 font-normal">(read only)</span></h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div class="bg-surface-900 rounded p-3">
          <div class="font-semibold mb-2 text-primary-400">RP Balances</div>
          <div class="flex justify-between"><span>Lifetime RP</span><span>${typeof p.totalResearchPoints === 'number' ? p.totalResearchPoints : 0}</span></div>
          <div class="flex justify-between"><span>Spendable RP</span><span>${typeof p.currencies?.currentResearchPoints === 'number' ? p.currencies.currentResearchPoints : 0}</span></div>
        </div>
        <div class="bg-surface-900 rounded p-3">
          <div class="font-semibold mb-2 text-primary-400">Equipped Profile</div>
          <div>Aura: ${profile.equippedAura || 'None'}</div>
          <div>Border: ${profile.equippedBorder || 'None'}</div>
          <div>Banner: ${profile.equippedBanner ? (getCosmeticDefinition(profile.equippedBanner)?.name || profile.equippedBanner) : 'Default chrome'}</div>
          <div>Background: ${profile.equippedBackground || 'None'}</div>
          <div>Title: ${profile.equippedTitle || 'None'}</div>
        </div>
        <div class="bg-surface-900 rounded p-3">
          <div class="font-semibold mb-2 text-primary-400">Consumables</div>
          <div class="space-y-1">${consumables || '<div class="text-surface-500">None owned</div>'}</div>
        </div>
        <div class="bg-surface-900 rounded p-3">
          <div class="font-semibold mb-2 text-primary-400">Owned Cosmetics</div>
          <div class="space-y-1">${cosmeticsOwned || '<div class="text-surface-500">None owned</div>'}</div>
        </div>
        <div class="bg-surface-900 rounded p-3 sm:col-span-2">
          <div class="font-semibold mb-2 text-primary-400">Current Shop Snapshot</div>
          <div class="space-y-1">${shopSnapshot || '<div class="text-surface-500">No current rotation</div>'}</div>
        </div>
      </div>
    </div>
  `;
}

async function showPlayerDetail(username) {
  const modal = document.getElementById('player-detail-modal');
  const content = document.getElementById('player-detail-content');
  const nameEl = document.getElementById('player-detail-name');
  if (nameEl) nameEl.textContent = 'Loading…';
  if (modal) modal.classList.remove('hidden');
  if (content) {
    content.innerHTML = '<div class="p-4 text-surface-500 text-center text-sm">Loading player…</div>';
  }

  const scoped = await ensureAdminSelectedPlayerScope(username);
  if (!scoped.ok) {
    if (scoped.superseded) return;
    toast.error(scoped.error || 'Failed to load selected player');
    if (content) {
      content.innerHTML = `<div class="p-4 text-amber-400 text-center text-sm">
        ${scoped.error || 'Selected player failed to hydrate.'}
        Close and try again. Admin will not fall back to the root-populated cache.
      </div>`;
    }
    return;
  }

  username = scoped.username || resolvePlayerDirectoryKey(username);
  const p = player.getPlayer(username);
  if (!p) {
    toast.error('Player data missing after scoped load');
    if (content) {
      content.innerHTML = `<div class="p-4 text-amber-400 text-center text-sm">
        Selected player did not hydrate. Close and try again — no root-cache fallback.
      </div>`;
    }
    return;
  }

  const authUidForLock = p.authUid != null ? String(p.authUid).trim() : '';
  await db.loadPathOnce(playerLockPath(username), { force: true });
  if (authUidForLock) {
    await db.loadPathOnce(playerLockByUidPath(authUidForLock), { force: true });
  }
  const lockConsistency = getPlayerLockConsistency(username, authUidForLock || null);
  const accountLocked = isPlayerAdminLocked(username) || lockConsistency.locked === true;
  const correctionLockGate = authUidForLock
    ? isConsistentlyAdminLockedForCorrection(username, authUidForLock)
    : { ok: false, reason: 'unlocked' };
  const correctionLockOk = correctionLockGate.ok === true;
  const lockStatusLabel = accountLocked ? 'Locked' : 'Unlocked';
  const lockStatusClass = accountLocked ? 'text-red-400 font-bold' : 'text-green-400';
  const lockMetaBits = [];
  if (accountLocked && lockConsistency.usernameMirror?.lockedAt) {
    try {
      lockMetaBits.push(`Since ${new Date(lockConsistency.usernameMirror.lockedAt).toLocaleString()}`);
    } catch { /* ignore */ }
  }
  if (lockConsistency.reason) {
    lockMetaBits.push(`Mirror note: ${lockConsistency.reason}`);
  }

  const visibleName = getPlayerDisplayName(p, username);
  if (nameEl) nameEl.textContent = visibleName;

  const allCardsList = cards.sortCardsByRarityAndName([...cards.getAllCards()]);
  const allPackTypes = packs.getAllPackTypes();
  const allGroupsList = groups.getAllGroups();
  const inv = player.getInventory(username);
  const sortedInventoryCards = cards.sortCardsByRarityAndName(
    inv
      .map(({ cardId, quantity }) => {
        const card = cards.getCard(cardId);
        if (!card) return null;
        return { ...card, quantity };
      })
      .filter(Boolean)
  );

  const pdGrantCosmeticCat = _pickInitialAdminGrantCosmeticCategory();

  const ownedPackEntries = Object.entries(player.getPlayerPacks(username) || {})
    .map(([packId, rawQty]) => {
      const qty = typeof rawQty === 'number' && Number.isFinite(rawQty)
        ? Math.trunc(rawQty)
        : parseInt(String(rawQty ?? ''), 10);
      if (!Number.isFinite(qty) || qty <= 0) return null;
      const def = packs.getPackType(packId);
      return {
        packId,
        qty,
        label: (def && def.name) ? def.name : packId,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));

  if (!content) return;
  content.innerHTML = `
    <div class="space-y-4">
      <!-- Display Name vs Login Username -->
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-3">Player Identity</h4>
        <div class="space-y-3">
          <div>
            <label class="text-xs text-surface-400 block mb-1">Display Name</label>
            <div class="flex flex-wrap items-center gap-2">
              <span id="pd-display-name-value" class="font-medium text-sm">${visibleName}</span>
              <button type="button" id="pd-change-display-name" class="bg-primary-600 hover:bg-primary-500 px-3 py-1 rounded text-xs font-medium">
                Change Display Name
              </button>
            </div>
            <div id="pd-change-display-name-form" class="hidden mt-2 space-y-2">
              <input id="pd-new-display-name" type="text" maxlength="${DISPLAY_NAME_MAX_LENGTH}"
                placeholder="New display name (3–${DISPLAY_NAME_MAX_LENGTH} letters, numbers, _)"
                class="admin-input w-full" autocomplete="off">
              <p id="pd-display-name-msg" class="text-xs text-surface-500 hidden"></p>
              <div class="flex gap-2">
                <button type="button" id="pd-save-display-name" class="bg-primary-600 hover:bg-primary-500 px-3 py-1 rounded text-xs">Save</button>
                <button type="button" id="pd-cancel-display-name" class="bg-surface-700 hover:bg-surface-600 px-3 py-1 rounded text-xs">Cancel</button>
              </div>
            </div>
          </div>
          <div>
            <label class="text-xs text-surface-400 block mb-1">Login Username</label>
            <span class="font-mono text-sm text-surface-300">${username}</span>
            <p class="text-xs text-surface-500 mt-1">Stable account login — not changed by display name.</p>
          </div>
          <div class="border-t border-surface-700 pt-3">
            <h5 class="text-xs font-semibold text-surface-300 mb-2">Require Display Name Change</h5>
            ${playerRequiresDisplayNameChange(p) ? `
              <p class="text-xs text-amber-400 mb-2">Pending — student must choose a new display name before playing.</p>
              ${getDisplayNameChangeMessage(p) ? `
                <p class="text-xs text-surface-400 mb-1">Current teacher message:</p>
                <p class="text-xs text-surface-200 mb-2 whitespace-pre-wrap">${getDisplayNameChangeMessage(p).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
              ` : '<p class="text-xs text-surface-500 mb-2">No teacher message set.</p>'}
              <button type="button" id="pd-clear-require-display-name" class="bg-surface-600 hover:bg-surface-500 px-3 py-1 rounded text-xs font-medium mb-2">
                Clear Requirement
              </button>
            ` : `
              <p class="text-xs text-surface-500 mb-2">No outstanding name-change requirement.</p>
            `}
            <button type="button" id="pd-require-display-name" class="bg-amber-700 hover:bg-amber-600 px-3 py-1 rounded text-xs font-medium">
              Require Name Change
            </button>
            <div id="pd-require-display-name-form" class="hidden mt-2 space-y-2">
              <label class="text-xs text-surface-400 block" for="pd-require-message">Message to student (optional)</label>
              <textarea id="pd-require-message" rows="3" maxlength="${DISPLAY_NAME_CHANGE_MESSAGE_MAX_LENGTH}"
                placeholder="Example: Use last initial + first initial + nickname"
                class="admin-input w-full text-sm"></textarea>
              <p class="text-xs text-surface-500">${DISPLAY_NAME_CHANGE_MESSAGE_MAX_LENGTH} characters max. Plain text only.</p>
              <p id="pd-require-msg" class="text-xs text-surface-500 hidden"></p>
              <div class="flex gap-2">
                <button type="button" id="pd-confirm-require-display-name" class="bg-amber-700 hover:bg-amber-600 px-3 py-1 rounded text-xs">Continue</button>
                <button type="button" id="pd-cancel-require-display-name" class="bg-surface-700 hover:bg-surface-600 px-3 py-1 rounded text-xs">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Group & Subgroup Assignment -->
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-3">Group &amp; Subgroup</h4>
        <div class="space-y-2">
          <div class="flex gap-2">
            <select id="pd-group-select" class="admin-input flex-1">
              <option value="">None</option>
              ${allGroupsList.map(g => `<option value="${g.id}" ${p.groupId === g.id ? 'selected' : ''}>${g.name}</option>`).join('')}
            </select>
          </div>
          <div class="flex gap-2">
            <select id="pd-subgroup-select" class="admin-input flex-1" ${!p.groupId ? 'disabled' : ''}>
              <option value="">No Subgroup</option>
              ${p.groupId ? groups.getSubgroups(p.groupId).map(s => `<option value="${s.id}" ${p.subgroupId === s.id ? 'selected' : ''}>${s.name}</option>`).join('') : ''}
            </select>
          </div>
          <button id="pd-set-group" class="bg-primary-600 hover:bg-primary-500 px-3 py-1.5 rounded text-sm w-full">Save Group Assignment</button>
        </div>
      </div>

      <!-- Give Card -->
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-2">Give Card</h4>
        <div class="flex gap-2">
          <select id="pd-card-select" class="admin-input flex-1">
            ${allCardsList.map(c => `<option value="${c.id}">${c.name} (${c.rarity})</option>`).join('')}
          </select>
          <input id="pd-card-qty" type="number" value="1" min="1" class="admin-input w-16">
          <button id="pd-give-card" class="bg-green-600 hover:bg-green-500 px-3 py-1 rounded text-sm">Give</button>
        </div>
      </div>

      <!-- Unopened Packs -->
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-2">Unopened Packs</h4>
        <div class="space-y-2 max-h-40 overflow-y-auto">
          ${ownedPackEntries.length === 0
            ? '<div class="text-surface-500 text-xs">No unopened packs.</div>'
            : ownedPackEntries.map((row) => `
              <div class="flex flex-wrap items-center gap-2 text-xs py-1 border-b border-surface-700/60 last:border-0">
                <span class="flex-1 min-w-[8rem]">${row.label} ×${row.qty}</span>
                <input type="number" min="1" max="${row.qty}" value="1"
                  class="pd-remove-pack-qty admin-input w-16" data-pack-id="${row.packId}" aria-label="Remove quantity for ${row.label}">
                <button type="button" class="pd-remove-pack bg-surface-600 hover:bg-surface-500 px-2 py-1 rounded text-xs"
                  data-pack-id="${row.packId}" data-pack-label="${String(row.label).replace(/"/g, '&quot;')}" data-owned="${row.qty}">
                  Remove
                </button>
              </div>
            `).join('')}
        </div>
      </div>

      <!-- Give Pack -->
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-2">Give Pack</h4>
        <div class="flex gap-2">
          <select id="pd-pack-select" class="admin-input flex-1">
            ${allPackTypes.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
          </select>
          <input id="pd-pack-qty" type="number" value="1" min="1" class="admin-input w-16">
          <button id="pd-give-pack" class="bg-green-600 hover:bg-green-500 px-3 py-1 rounded text-sm">Give</button>
        </div>
      </div>

      <!-- Shop / Economy Admin Tools -->
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-2">Shop / Economy Tools</h4>
        <div class="space-y-3">
          <div>
            <label class="text-xs text-surface-400 block mb-1">Give Research Points</label>
            <div class="flex gap-2">
              <input id="pd-rp-amount" type="number" value="50" min="1" class="admin-input flex-1">
              <button id="pd-give-rp" class="bg-green-600 hover:bg-green-500 px-3 py-1 rounded text-sm">Give RP</button>
            </div>
            <p class="text-xs text-surface-500 mt-1">Uses the research helper so lifetime and spendable RP stay aligned.</p>
          </div>
          <div>
            <label class="text-xs text-surface-400 block mb-1">Give Consumable</label>
            <div class="flex gap-2">
              <select id="pd-consumable-select" class="admin-input flex-1">
                ${_renderShopItemOptions(ITEM_TYPES.CONSUMABLE)}
              </select>
              <input id="pd-consumable-qty" type="number" value="1" min="1" class="admin-input w-16">
              <button id="pd-give-consumable" class="bg-green-600 hover:bg-green-500 px-3 py-1 rounded text-sm">Give</button>
            </div>
          </div>
          <div>
            <label class="text-xs text-surface-400 block mb-1">Give Cosmetic Ownership</label>
            <div class="flex flex-col gap-2">
              <select id="pd-cosmetic-category" class="admin-input w-full max-w-xs">
                ${_renderAdminGrantCosmeticCategoryOptions(pdGrantCosmeticCat)}
              </select>
              <div class="flex gap-2">
                <select id="pd-cosmetic-select" class="admin-input flex-1">
                  ${_renderAdminGrantCosmeticItemOptions(pdGrantCosmeticCat)}
                </select>
                <button id="pd-give-cosmetic" class="bg-green-600 hover:bg-green-500 px-3 py-1 rounded text-sm">Unlock</button>
              </div>
            </div>
            <p class="text-xs text-surface-500 mt-1">Unlocks ownership only; equipped profile state is not changed.</p>
          </div>
        </div>
      </div>

      <!-- Account Lock (server-enforced) -->
      <div class="bg-surface-800 rounded-lg p-4 border ${accountLocked ? 'border-red-800/60' : 'border-transparent'}">
        <h4 class="font-semibold text-sm mb-2">Account Lock</h4>
        <p class="text-xs text-surface-400 mb-2">
          Server-enforced. Login username
          <span class="font-mono text-surface-200">${username}</span>
          is the lock identity (display name is presentation only).
        </p>
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <span class="text-xs ${lockStatusClass}">${lockStatusLabel}</span>
          ${lockMetaBits.length
            ? `<span class="text-xs text-surface-500">${lockMetaBits.join(' · ')}</span>`
            : ''}
        </div>
        <div class="flex flex-wrap gap-2">
          <button type="button" id="pd-lock-account"
            class="bg-red-700 hover:bg-red-600 px-3 py-1.5 rounded text-xs font-medium ${accountLocked ? 'opacity-40 cursor-not-allowed' : ''}"
            ${accountLocked ? 'disabled' : ''}>
            Lock Account
          </button>
          <button type="button" id="pd-unlock-account"
            class="bg-surface-600 hover:bg-surface-500 px-3 py-1.5 rounded text-xs font-medium ${!accountLocked ? 'opacity-40 cursor-not-allowed' : ''}"
            ${!accountLocked ? 'disabled' : ''}>
            Unlock Account
          </button>
        </div>
      </div>

      <!-- Account Corrections (requires consistent Admin lock) -->
      <div class="bg-surface-800 rounded-lg p-4 border border-amber-900/40">
        <h4 class="font-semibold text-sm mb-1">Account Corrections</h4>
        <p class="text-xs text-surface-400 mb-3">
          Historical stats and resources. Requires a consistent account lock.
          Inventory and packs use the Give/Remove tools above (no lock required).
        </p>
        ${correctionLockOk ? '' : `
          <p class="text-xs text-amber-400 mb-3" id="pd-correction-lock-hint">
            ${MSG_LOCK_BEFORE_STAT_CORRECTION}
            Use <span class="font-medium">Lock Account</span> above, then return here.
          </p>
        `}
        <div class="space-y-2">
          <label class="text-xs text-surface-400 block" for="pd-correction-field">Field</label>
          <select id="pd-correction-field" class="admin-input w-full" ${correctionLockOk ? '' : 'disabled'}>
            ${ADMIN_STAT_CORRECTION_FIELD_IDS.map((id) => {
              const f = ADMIN_STAT_CORRECTION_FIELDS[id];
              return `<option value="${f.id}">${f.label}</option>`;
            }).join('')}
          </select>
          <div class="grid grid-cols-3 gap-2 text-xs">
            <div>
              <span class="text-surface-500 block">Current</span>
              <span id="pd-correction-current" class="font-mono text-surface-200">—</span>
            </div>
            <div>
              <label class="text-surface-500 block" for="pd-correction-adjustment">Adjustment</label>
              <input id="pd-correction-adjustment" type="number" step="1" value="0"
                class="admin-input w-full" ${correctionLockOk ? '' : 'disabled'} placeholder="-20">
            </div>
            <div>
              <span class="text-surface-500 block">New</span>
              <span id="pd-correction-after" class="font-mono text-surface-200">—</span>
            </div>
          </div>
          <p id="pd-correction-preview-msg" class="text-xs text-surface-500 hidden"></p>
          <button type="button" id="pd-apply-correction"
            class="bg-amber-700 hover:bg-amber-600 px-3 py-1.5 rounded text-xs font-medium w-full disabled:opacity-40 disabled:cursor-not-allowed"
            ${correctionLockOk ? '' : 'disabled'}>
            Apply Correction
          </button>
        </div>
      </div>

      <!-- Admin Status -->
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-2">Admin Status</h4>
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-xs ${p.isAdmin ? 'text-yellow-400 font-bold' : 'text-surface-500'}">${p.isAdmin ? 'ADMIN' : 'Not admin'}</span>
          ${(() => {
            const currentUser = auth.getCurrentUsername();
            const isSelf = currentUser === username;
            if (p.isAdmin && isSelf) {
              return '<span class="text-xs text-surface-500 italic ml-2">(Cannot remove own admin)</span>';
            }
            if (p.isAdmin) {
              return '<button id="pd-remove-admin" class="bg-red-600 hover:bg-red-500 px-3 py-1 rounded text-xs font-medium ml-auto">Remove Admin</button>';
            }
            return '<button id="pd-promote-admin" class="bg-yellow-600 hover:bg-yellow-500 px-3 py-1 rounded text-xs font-medium ml-auto">Promote to Admin</button>';
          })()}
        </div>
      </div>

      <!-- Trade Restriction -->
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-2">Trade Restriction</h4>
        <div class="flex items-center gap-2">
          <span class="text-xs ${p.isTradeRestricted ? 'text-red-400 font-bold' : 'text-green-400'}">${p.isTradeRestricted ? 'TRADE LOCKED' : 'Trading allowed'}</span>
          <button id="pd-toggle-trade" class="bg-surface-600 hover:bg-surface-500 px-3 py-1 rounded text-xs font-medium ml-auto">
            ${p.isTradeRestricted ? 'Remove Restriction' : 'Restrict Trading'}
          </button>
        </div>
      </div>

      <!-- Reset Password -->
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-2">Reset Password</h4>
        <p id="pd-reset-password-auth-note" class="text-xs text-surface-400 mb-2 hidden">
          Sets a new password by rotating the student's login identity.
          Their inventory and progress are unchanged; their current session is invalidated.
        </p>
        <div class="flex flex-col gap-2">
          <input id="pd-new-password" type="password" placeholder="New password (min 6 chars)" class="admin-input w-full" autocomplete="new-password">
          <input id="pd-confirm-password" type="password" placeholder="Confirm new password" class="admin-input w-full" autocomplete="new-password">
          <button id="pd-reset-password" class="bg-orange-600 hover:bg-orange-500 px-3 py-1 rounded text-sm whitespace-nowrap self-start">Reset Password</button>
        </div>
        <p id="pd-reset-password-msg" class="text-xs mt-1 hidden"></p>
      </div>

      <!-- Danger Zone -->
      <div class="bg-surface-800 rounded-lg p-4 border border-red-900/50">
        <h4 class="font-semibold text-sm mb-2 text-red-400">Danger Zone</h4>
        <p class="text-xs text-surface-400 mb-2">
          Deletes RTDB player data (inventory, indexes, directory, auth directory).
          Firebase Auth users may remain until optional administrator cleanup.
          Deleted usernames may require administrator cleanup before being reused.
        </p>
        <button id="pd-delete-player" class="bg-red-600 hover:bg-red-500 px-4 py-2 rounded text-sm font-medium">
          Delete Player
        </button>
      </div>

      ${_renderAdminRuntimeSnapshot(p)}

      <!-- Inventory -->
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-2">Inventory (${sortedInventoryCards.length} unique cards)</h4>
        <div class="max-h-48 overflow-y-auto space-y-1">
          ${sortedInventoryCards.length === 0 ? '<div class="text-surface-500 text-xs">Empty</div>' :
            sortedInventoryCards.map(c => `
                <div class="flex flex-wrap items-center justify-between gap-2 text-xs py-1">
                  <span class="min-w-0 flex-1"><span style="color:${cards.RARITY_COLORS[c.rarity]}">●</span> ${c.name} ×${c.quantity}</span>
                  <div class="flex items-center gap-1 shrink-0">
                    <input type="number" min="1" max="${c.quantity}" value="1"
                      class="pd-remove-card-qty admin-input w-14" data-card-id="${c.id}" aria-label="Remove quantity for ${c.name}">
                    <button type="button" class="pd-remove-card text-red-400 hover:text-red-300 px-2 py-1 rounded border border-red-900/40"
                      data-card-id="${c.id}" data-owned="${c.quantity}">Remove</button>
                  </div>
                </div>
              `).join('')}
        </div>
      </div>

      <!-- Stats -->
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-2">Stats</h4>
        <div class="grid grid-cols-2 gap-2 text-xs">
          ${Object.entries(p.stats || {})
            .filter(([k]) => k !== 'xp' && k !== 'level')
            .map(([k, v]) => `
              <div class="flex justify-between"><span class="text-surface-400 capitalize">${k.replace(/([A-Z])/g, ' $1')}</span><span>${v}</span></div>
            `).join('')}
          <div class="flex justify-between col-span-2 border-t border-surface-700 pt-1 mt-1"><span class="text-surface-400">Total Research RP</span><span class="text-primary-400 font-medium">${typeof p.totalResearchPoints === 'number' ? p.totalResearchPoints : 0}</span></div>
          <div class="flex justify-between"><span class="text-surface-400">Projects Completed</span><span>${p.projectsCompleted || 0}</span></div>
          <div class="flex justify-between"><span class="text-surface-400">Breakthroughs</span><span>${(p.researchStats || {}).breakthroughs || 0}</span></div>
        </div>
      </div>
    </div>
  `;

  // Dynamic subgroup population when group changes
  // Display name — Admin direct change (Slice A)
  const changeDnBtn = content.querySelector('#pd-change-display-name');
  const changeDnForm = content.querySelector('#pd-change-display-name-form');
  const newDnInput = content.querySelector('#pd-new-display-name');
  const dnMsg = content.querySelector('#pd-display-name-msg');
  changeDnBtn?.addEventListener('click', () => {
    if (!changeDnForm) return;
    changeDnForm.classList.remove('hidden');
    if (newDnInput) {
      newDnInput.value = getPlayerDisplayName(p, username);
      newDnInput.focus();
      newDnInput.select();
    }
    if (dnMsg) {
      dnMsg.classList.add('hidden');
      dnMsg.textContent = '';
    }
  });
  content.querySelector('#pd-cancel-display-name')?.addEventListener('click', () => {
    changeDnForm?.classList.add('hidden');
    if (dnMsg) {
      dnMsg.classList.add('hidden');
      dnMsg.textContent = '';
    }
  });
  content.querySelector('#pd-save-display-name')?.addEventListener('click', async () => {
    const validated = validateDisplayName(newDnInput?.value);
    if (!validated.ok) {
      if (dnMsg) {
        dnMsg.textContent = validated.error;
        dnMsg.className = 'text-xs text-red-400';
        dnMsg.classList.remove('hidden');
      }
      toast.error(validated.error);
      return;
    }
    const oldLabel = getPlayerDisplayName(p, username);
    const nextName = validated.displayName;
    if (oldLabel === nextName && typeof p.displayName === 'string' && p.displayName.trim() === nextName) {
      changeDnForm?.classList.add('hidden');
      return;
    }
    const confirmed = await confirmAction({
      title: 'Change Display Name?',
      message: `Change display name from "${oldLabel}" to "${nextName}"?`,
      confirmText: 'Change Display Name',
      destructive: false,
    });
    if (!confirmed) return;

    const playerKey = resolvePlayerDirectoryKey(username);
    const playerData = player.getPlayer(playerKey) || p;
    const result = await db.updateAcknowledged({
      ...buildAdminSetDisplayNamePlayerPaths(playerKey, nextName),
      ...syncDirectoryUpdateFromPlayer(playerKey, {
        ...playerData,
        displayName: nextName,
        requiresDisplayNameChange: false,
        displayNameChangeMessage: null,
      }),
    });
    if (!result.ok) {
      toast.error(result.error || 'Failed to update display name');
      return;
    }
    toast.success(`Display name updated to "${nextName}"`);
    renderAdminPlayers();
    void showPlayerDetail(username);
  });

  // Require Name Change (Slice C)
  const requireDnForm = content.querySelector('#pd-require-display-name-form');
  const requireMsgInput = content.querySelector('#pd-require-message');
  const requireMsgEl = content.querySelector('#pd-require-msg');
  content.querySelector('#pd-require-display-name')?.addEventListener('click', () => {
    requireDnForm?.classList.remove('hidden');
    if (requireMsgInput) {
      requireMsgInput.value = getDisplayNameChangeMessage(p) || '';
      requireMsgInput.focus();
    }
    if (requireMsgEl) {
      requireMsgEl.classList.add('hidden');
      requireMsgEl.textContent = '';
    }
  });
  content.querySelector('#pd-cancel-require-display-name')?.addEventListener('click', () => {
    requireDnForm?.classList.add('hidden');
  });
  content.querySelector('#pd-confirm-require-display-name')?.addEventListener('click', async () => {
    const msgValidated = validateDisplayNameChangeMessage(requireMsgInput?.value);
    if (!msgValidated.ok) {
      if (requireMsgEl) {
        requireMsgEl.textContent = msgValidated.error;
        requireMsgEl.className = 'text-xs text-red-400';
        requireMsgEl.classList.remove('hidden');
      }
      toast.error(msgValidated.error);
      return;
    }
    const label = getPlayerDisplayName(p, username);
    const confirmed = await confirmAction({
      title: 'Require Name Change?',
      message: `Require "${label}" to choose a new display name the next time they enter the game?`,
      confirmText: 'Require Name Change',
      destructive: false,
    });
    if (!confirmed) return;

    const playerKey = resolvePlayerDirectoryKey(username);
    const result = await db.updateAcknowledged(
      buildAdminRequireDisplayNameChangePaths(playerKey, msgValidated.message),
    );
    if (!result.ok) {
      toast.error(result.error || 'Failed to require name change');
      return;
    }
    toast.success(`Name change required for "${label}"`);
    renderAdminPlayers();
    void showPlayerDetail(username);
  });
  content.querySelector('#pd-clear-require-display-name')?.addEventListener('click', async () => {
    const label = getPlayerDisplayName(p, username);
    const confirmed = await confirmAction({
      title: 'Clear Name Change Requirement?',
      message: `Clear the pending display-name requirement for "${label}"? They will not be asked to rename.`,
      confirmText: 'Clear Requirement',
      destructive: false,
    });
    if (!confirmed) return;
    const playerKey = resolvePlayerDirectoryKey(username);
    const result = await db.updateAcknowledged({
      [`players/${playerKey}/requiresDisplayNameChange`]: null,
      [`players/${playerKey}/displayNameChangeMessage`]: null,
    });
    if (!result.ok) {
      toast.error(result.error || 'Failed to clear requirement');
      return;
    }
    toast.success('Name-change requirement cleared');
    renderAdminPlayers();
    void showPlayerDetail(username);
  });

  content.querySelector('#pd-group-select').addEventListener('change', () => {
    const grpId = content.querySelector('#pd-group-select').value;
    const subSel = content.querySelector('#pd-subgroup-select');
    if (grpId) {
      const subs = groups.getSubgroups(grpId);
      subSel.innerHTML = `<option value="">No Subgroup</option>` +
        subs.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
      subSel.disabled = false;
    } else {
      subSel.innerHTML = '<option value="">No Subgroup</option>';
      subSel.disabled = true;
    }
  });

  // Wire up actions
  content.querySelector('#pd-set-group').addEventListener('click', async () => {
    const grpId = content.querySelector('#pd-group-select').value || null;
    const subId = content.querySelector('#pd-subgroup-select').value || null;
    const result = await player.setPlayerGroup(username, grpId, subId);
    if (!result.ok) {
      toast.error(result.error || 'Failed to update group assignment');
      return;
    }
    toast.success(`Group assignment updated for ${visibleName}`);
    renderAdminPlayers();
    void showPlayerDetail(username);
  });

  content.querySelector('#pd-give-card').addEventListener('click', () => {
    const cardId = content.querySelector('#pd-card-select').value;
    const qty = parseInt(content.querySelector('#pd-card-qty').value) || 1;
    player.addCard(username, cardId, qty);
    toast.success(`Gave ${qty} card(s) to ${visibleName}`);
    void showPlayerDetail(username);
  });

  content.querySelector('#pd-give-pack').addEventListener('click', async () => {
    const packId = content.querySelector('#pd-pack-select').value;
    const qtyRaw = content.querySelector('#pd-pack-qty').value;
    const quantity = player.parseAdminPackGrantQuantity(qtyRaw);
    const packDef = packs.getPackType(packId);
    const packName = packDef?.name || packId || 'pack';
    const currentRaw = player.getPlayerPacks(username)?.[packId];
    const currentParsed = typeof currentRaw === 'number' && Number.isFinite(currentRaw)
      ? Math.trunc(currentRaw)
      : parseInt(String(currentRaw ?? ''), 10);
    const currentQuantity = Number.isFinite(currentParsed) && currentParsed > 0 ? currentParsed : 0;
    const confirmed = await confirmAdminPackGrantIfNeeded({
      displayName: visibleName,
      loginUsername: username,
      packName,
      grantQuantity: quantity,
      currentQuantity,
    });
    if (!confirmed) return;
    const result = player.adminGrantPacks(username, packId, quantity);
    if (!result.ok) {
      toast.error(result.error || 'Could not give packs.');
      return;
    }
    toast.success(`Gave ${result.quantity} pack(s) to ${visibleName}`);
    void showPlayerDetail(username);
  });

  content.querySelectorAll('.pd-remove-pack').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const packId = btn.dataset.packId;
      const packLabel = btn.dataset.packLabel || packId;
      const owned = parseInt(btn.dataset.owned, 10) || 0;
      const qtyInput = content.querySelector(`.pd-remove-pack-qty[data-pack-id="${packId}"]`);
      const qty = parseInt(qtyInput?.value, 10);
      if (!Number.isFinite(qty) || qty < 1) {
        toast.error('Enter a positive quantity to remove.');
        return;
      }
      if (qty > owned) {
        toast.error(`Cannot remove more than owned (${owned}).`);
        return;
      }
      const confirmed = await confirmAction({
        title: `Remove ${qty} ${packLabel}?`,
        message: `Remove ${qty} unopened ${packLabel} from ${visibleName}?\n\nOwned: ${owned}\nAfter: ${owned - qty}`,
        confirmText: 'Remove Packs',
        destructive: true,
      });
      if (!confirmed) return;
      const result = player.adminRemovePacks(username, packId, qty);
      if (!result.ok) {
        toast.error(result.error || 'Could not remove packs.');
        return;
      }
      toast.info(`Removed ${result.removed} ${packLabel} from ${visibleName}`);
      void showPlayerDetail(username);
    });
  });

  content.querySelector('#pd-give-rp')?.addEventListener('click', () => {
    const amount = parseInt(content.querySelector('#pd-rp-amount')?.value, 10) || 0;
    const result = adminGrantResearchPoints(username, amount);
    if (!result.success) {
      toast.error('Could not grant RP');
      return;
    }
    toast.success(`Gave ${result.amount} RP to ${visibleName}`);
    void showPlayerDetail(username);
  });

  content.querySelector('#pd-give-consumable')?.addEventListener('click', () => {
    const itemId = content.querySelector('#pd-consumable-select')?.value;
    const qty = parseInt(content.querySelector('#pd-consumable-qty')?.value, 10) || 1;
    const result = adminGrantShopItem(username, itemId, qty);
    if (!result.success) {
      toast.error('Could not grant consumable');
      return;
    }
    toast.success(`Granted ${qty} item(s) to ${visibleName}`);
    void showPlayerDetail(username);
  });

  content.querySelector('#pd-give-cosmetic')?.addEventListener('click', () => {
    const itemId = content.querySelector('#pd-cosmetic-select')?.value;
    if (!itemId) {
      toast.error('Select a cosmetic to grant.');
      return;
    }
    const result = adminGrantShopItem(username, itemId, 1);
    if (!result.success) {
      toast.error('Could not unlock cosmetic');
      return;
    }
    toast.success(`Cosmetic unlocked for ${visibleName}`);
    void showPlayerDetail(username);
  });

  content.querySelector('#pd-cosmetic-category')?.addEventListener('change', () => {
    const cat = content.querySelector('#pd-cosmetic-category').value;
    const sel = content.querySelector('#pd-cosmetic-select');
    if (sel) sel.innerHTML = _renderAdminGrantCosmeticItemOptions(cat);
  });

  content.querySelector('#pd-lock-account')?.addEventListener('click', async () => {
    const confirmed = await confirmAction({
      title: `Lock account ${username}?`,
      message:
        `Lock LOGIN USERNAME "${username}"`
        + (visibleName !== username ? ` (display name: ${visibleName})` : '')
        + '?\n\n'
        + 'This ends their active session and blocks student writes until unlocked. '
        + 'Admin can still manage this account while locked.\n\n'
        + `Confirm you mean login username: ${username}`,
      confirmText: 'Lock Account',
      destructive: true,
    });
    if (!confirmed) return;
    const result = await adminLockPlayer(username);
    if (!result.ok) {
      toast.error(result.error || 'Failed to lock account');
      return;
    }
    toast.success(`Locked ${username}`);
    void showPlayerDetail(username);
  });

  content.querySelector('#pd-unlock-account')?.addEventListener('click', async () => {
    const confirmed = await confirmAction({
      title: `Unlock account ${username}?`,
      message:
        `Unlock LOGIN USERNAME "${username}"`
        + (visibleName !== username ? ` (display name: ${visibleName})` : '')
        + '?\n\n'
        + `Confirm you mean login username: ${username}`,
      confirmText: 'Unlock Account',
      destructive: false,
    });
    if (!confirmed) return;
    const result = await adminUnlockPlayer(username);
    if (!result.ok) {
      toast.error(result.error || 'Failed to unlock account');
      return;
    }
    if (result.hadInconsistentMirrors) {
      toast.info(`Unlocked ${username} (cleared inconsistent mirrors: ${(result.warnings || []).join(', ')})`);
    } else if (result.alreadyUnlocked) {
      toast.info(`${username} was already unlocked`);
    } else {
      toast.success(`Unlocked ${username}`);
    }
    void showPlayerDetail(username);
  });

  // Account Corrections (Phase B) — requires consistent dual lock
  {
    const fieldSel = content.querySelector('#pd-correction-field');
    const adjInput = content.querySelector('#pd-correction-adjustment');
    const currentEl = content.querySelector('#pd-correction-current');
    const afterEl = content.querySelector('#pd-correction-after');
    const msgEl = content.querySelector('#pd-correction-preview-msg');
    const applyBtn = content.querySelector('#pd-apply-correction');

    const refreshCorrectionPreview = () => {
      if (!fieldSel || !currentEl || !afterEl) return null;
      const field = ADMIN_STAT_CORRECTION_FIELDS[fieldSel.value];
      if (!field) return null;
      const freshPlayer = player.getPlayer(username) || p;
      const before = readPlayerRelativeNumber(freshPlayer, field.relativePath);
      currentEl.textContent = String(before);
      const preview = previewStatCorrection(before, adjInput?.value);
      if (!preview.ok) {
        afterEl.textContent = preview.after != null ? String(preview.after) : '—';
        afterEl.classList.add('text-red-400');
        afterEl.classList.remove('text-green-400');
        if (msgEl) {
          msgEl.textContent = preview.error || 'Invalid adjustment.';
          msgEl.className = 'text-xs text-red-400';
          msgEl.classList.remove('hidden');
        }
        if (applyBtn) applyBtn.disabled = true;
        return preview;
      }
      afterEl.textContent = String(preview.after);
      afterEl.classList.remove('text-red-400');
      afterEl.classList.add('text-green-400');
      if (msgEl) {
        msgEl.textContent = '';
        msgEl.classList.add('hidden');
      }
      if (applyBtn) applyBtn.disabled = !correctionLockOk;
      return preview;
    };

    fieldSel?.addEventListener('change', () => {
      if (adjInput) adjInput.value = '0';
      refreshCorrectionPreview();
    });
    adjInput?.addEventListener('input', () => refreshCorrectionPreview());
    refreshCorrectionPreview();

    applyBtn?.addEventListener('click', async () => {
      if (!correctionLockOk) {
        toast.error(MSG_LOCK_BEFORE_STAT_CORRECTION);
        content.querySelector('#pd-lock-account')?.focus();
        return;
      }
      const field = ADMIN_STAT_CORRECTION_FIELDS[fieldSel?.value];
      if (!field) {
        toast.error('Select a field to correct.');
        return;
      }
      const preview = refreshCorrectionPreview();
      if (!preview || !preview.ok) {
        toast.error(preview?.error || 'Invalid correction.');
        return;
      }
      const confirmed = await confirmAction(buildAdminStatCorrectionConfirmOptions({
        displayName: visibleName,
        loginUsername: username,
        fieldLabel: field.label,
        before: preview.before,
        adjustment: preview.adjustment,
        after: preview.after,
      }));
      if (!confirmed) return;
      const result = await adminCorrectPlayerStat(username, field.id, preview.adjustment);
      if (!result.ok) {
        toast.error(result.error || 'Correction failed.');
        if (result.requiresLock) {
          content.querySelector('#pd-lock-account')?.focus();
        }
        return;
      }
      toast.success(
        `Corrected ${result.fieldLabel}: ${result.before} → ${result.after}`,
      );
      void showPlayerDetail(username);
    });
  }

  // Delete player — DESTRUCTIVE (requires confirmation); clears directory + authDirectory
  content.querySelector('#pd-delete-player').addEventListener('click', async () => {
    const identityLabel = formatAdminIdentityLabel(p, username);
    const confirmed = await confirmAction({
      title: `Delete player ${identityLabel}?`,
      message:
        `This will permanently delete ${identityLabel} and all their game data. `
        + 'Deleted usernames may require administrator cleanup before being reused. '
        + 'This cannot be undone.',
      confirmText: '🗑 Delete Permanently',
      destructive: true,
    });
    if (!confirmed) return;
    const result = await player.deletePlayer(username);
    if (!result.ok) {
      toast.error(result.error || 'Failed to delete player');
      return;
    }
    toast.info(`Player ${identityLabel} deleted`);
    document.getElementById('player-detail-modal').classList.add('hidden');
    releaseAdminSelectedPlayerScope();
    renderAdminPlayers();
  });

  // Remove card from inventory — quantity-aware (canonical removeCard)
  content.querySelectorAll('.pd-remove-card').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cardId = btn.dataset.cardId;
      const owned = parseInt(btn.dataset.owned, 10) || 0;
      const c = cards.getCard(cardId);
      const cardName = c ? c.name : cardId;
      const qtyInput = content.querySelector(`.pd-remove-card-qty[data-card-id="${cardId}"]`);
      const qty = parseInt(qtyInput?.value, 10);
      if (!Number.isFinite(qty) || qty < 1) {
        toast.error('Enter a positive quantity to remove.');
        return;
      }
      if (qty > owned) {
        toast.error(`Cannot remove more than owned (${owned}).`);
        return;
      }
      const confirmed = await confirmAction({
        title: `Remove ${qty}× ${cardName}?`,
        message:
          `Remove ${qty}× "${cardName}" from ${visibleName}'s inventory?\n\n`
          + `Owned: ${owned}\nAfter: ${owned - qty}\n\n`
          + 'Lifetime counters (cards collected / discovered) are not reduced.',
        confirmText: 'Remove Cards',
        destructive: true,
      });
      if (!confirmed) return;
      const ok = player.removeCard(username, cardId, qty);
      if (!ok) {
        toast.error('Could not remove cards (insufficient quantity).');
        return;
      }
      toast.info(`Removed ${qty}× ${cardName} from ${visibleName}`);
      void showPlayerDetail(username);
    });
  });

  // Promote to Admin — registry + UI mirror (S8c-0; secure only after S8c-1 rules)
  const promoteBtn = content.querySelector('#pd-promote-admin');
  if (promoteBtn) {
    promoteBtn.addEventListener('click', async () => {
      const confirmed = await confirmAction({
        title: 'Promote to admin?',
        message: `Grant admin access to "${visibleName}"? They will have full admin panel access.`,
        confirmText: 'Promote to Admin',
        destructive: false,
      });
      if (!confirmed) return;
      const playerKey = resolvePlayerDirectoryKey(username);
      const playerData = player.getPlayer(playerKey) || {};
      const targetUid = playerData.authUid != null && playerData.authUid !== ''
        ? String(playerData.authUid)
        : null;
      if (!targetUid) {
        toast.error(
          'This player has no Firebase Auth binding (authUid). Migrate them before promoting.',
        );
        return;
      }
      const result = await db.updateAcknowledged({
        ...buildAdminRegistryUpdates(targetUid, true),
        [`players/${playerKey}/isAdmin`]: true,
        ...syncDirectoryUpdateFromPlayer(playerKey, { ...playerData, isAdmin: true }),
      });
      if (!result.ok) {
        toast.error(result.error || 'Failed to promote admin');
        return;
      }
      await loadAdminRegistryEntryOnce(targetUid, { force: true });
      toast.success(`${visibleName} promoted to admin`);
      void showPlayerDetail(username);
      renderAdminPlayers();
    });
  }

  // Remove Admin — registry + UI mirror (blocked for self)
  const removeAdminBtn = content.querySelector('#pd-remove-admin');
  if (removeAdminBtn) {
    removeAdminBtn.addEventListener('click', async () => {
      const confirmed = await confirmAction({
        title: 'Remove admin access?',
        message: `Remove admin access from "${visibleName}"? They will lose all admin panel access.`,
        confirmText: 'Remove Admin',
        destructive: true,
      });
      if (!confirmed) return;
      const playerKey = resolvePlayerDirectoryKey(username);
      const playerData = player.getPlayer(playerKey) || {};
      const targetUid = playerData.authUid != null && playerData.authUid !== ''
        ? String(playerData.authUid)
        : null;
      if (!targetUid) {
        toast.error('This player has no Firebase Auth binding (authUid). Cannot clear registry entry.');
        return;
      }
      const result = await db.updateAcknowledged({
        ...buildAdminRegistryUpdates(targetUid, false),
        [`players/${playerKey}/isAdmin`]: false,
        ...syncDirectoryUpdateFromPlayer(playerKey, { ...playerData, isAdmin: false }),
      });
      if (!result.ok) {
        toast.error(result.error || 'Failed to remove admin');
        return;
      }
      await loadAdminRegistryEntryOnce(targetUid, { force: true });
      toast.success(`Admin access removed from ${visibleName}`);
      void showPlayerDetail(username);
      renderAdminPlayers();
    });
  }

  // Toggle Trade Restriction — requires confirmation
  const toggleTradeBtn = content.querySelector('#pd-toggle-trade');
  if (toggleTradeBtn) {
    toggleTradeBtn.addEventListener('click', async () => {
      const playerKey = resolvePlayerDirectoryKey(username);
      const currentPlayer = player.getPlayer(playerKey);
      const isRestricted = currentPlayer && currentPlayer.isTradeRestricted === true;
      const action = isRestricted ? 'Remove' : 'Enable';
      const confirmed = await confirmAction(
        `${action} trade restriction for "${visibleName}"?${!isRestricted ? ' They will not be able to trade.' : ' They will be able to trade again.'}`,
        `${action} trade restriction?`
      );
      if (!confirmed) return;
      const next = !isRestricted;
      const result = await db.updateAcknowledged({
        [`players/${playerKey}/isTradeRestricted`]: next,
        ...syncDirectoryUpdateFromPlayer(playerKey, { ...(currentPlayer || {}), isTradeRestricted: next }),
      });
      if (!result.ok) {
        toast.error(result.error || 'Failed to update trade restriction');
        return;
      }
      toast.success(`Trade restriction ${isRestricted ? 'removed from' : 'enabled for'} ${visibleName}`);
      void showPlayerDetail(username);
      renderAdminPlayers();
    });
  }

  // Reset Password — Option C-b identity rotation when Firebase Auth is on
  const resetPwBtn = content.querySelector('#pd-reset-password');
  const resetPwInput = content.querySelector('#pd-new-password');
  const resetPwConfirm = content.querySelector('#pd-confirm-password');
  const resetPwMsg = content.querySelector('#pd-reset-password-msg');
  const resetPwAuthNote = content.querySelector('#pd-reset-password-auth-note');
  if (resetPwAuthNote && isFirebaseAuthEnabled()) {
    resetPwAuthNote.classList.remove('hidden');
  }
  if (resetPwBtn && resetPwInput) {
    resetPwBtn.addEventListener('click', async () => {
      const newPw = resetPwInput.value;
      const confirmPw = resetPwConfirm ? resetPwConfirm.value : newPw;
      if (isFirebaseAuthEnabled()) {
        if (!newPw || !String(newPw).trim()) {
          resetPwMsg.textContent = 'Please enter a new password.';
          resetPwMsg.className = 'text-xs mt-1 text-red-400';
          resetPwMsg.classList.remove('hidden');
          return;
        }
        if (String(newPw).trim().length < 6) {
          resetPwMsg.textContent = 'Password must be at least 6 characters.';
          resetPwMsg.className = 'text-xs mt-1 text-red-400';
          resetPwMsg.classList.remove('hidden');
          return;
        }
        if (String(confirmPw) !== String(newPw)) {
          resetPwMsg.textContent = 'Password confirmation does not match.';
          resetPwMsg.className = 'text-xs mt-1 text-red-400';
          resetPwMsg.classList.remove('hidden');
          return;
        }
      } else if (!newPw || newPw.trim().length < 4) {
        resetPwMsg.textContent = 'Password must be at least 4 characters.';
        resetPwMsg.className = 'text-xs mt-1 text-red-400';
        resetPwMsg.classList.remove('hidden');
        return;
      }

      const identityLabel = formatAdminIdentityLabel(p, username);
      const confirmed = await confirmAction(
        isFirebaseAuthEnabled()
          ? `Reset login for ${identityLabel}? Their password will change, their current session will be invalidated, and inventory/progress stay the same.`
          : `Reset the password for ${identityLabel}? They will need to use the new password on next login.`,
        'Reset player password?'
      );
      if (!confirmed) return;

      resetPwBtn.disabled = true;
      if (resetPwInput) resetPwInput.disabled = true;
      if (resetPwConfirm) resetPwConfirm.disabled = true;
      resetPwMsg.textContent = 'Resetting…';
      resetPwMsg.className = 'text-xs mt-1 text-amber-300';
      resetPwMsg.classList.remove('hidden');

      try {
        const result = await resetPlayerPassword(username, newPw, {
          confirmPassword: isFirebaseAuthEnabled() ? confirmPw : undefined,
        });
        if (result.success) {
          resetPwInput.value = '';
          if (resetPwConfirm) resetPwConfirm.value = '';
          resetPwMsg.textContent = 'Password reset successfully.';
          resetPwMsg.className = 'text-xs mt-1 text-green-400';
          resetPwMsg.classList.remove('hidden');
          toast.success(`Password reset for ${formatAdminIdentityLabel(p, username)}`);
        } else {
          if (result.code) {
            console.warn('[Admin] Password reset failed:', result.code, result.detail || result.error);
          }
          resetPwMsg.textContent = result.error || 'Password reset failed.';
          resetPwMsg.className = 'text-xs mt-1 text-red-400';
          resetPwMsg.classList.remove('hidden');
          toast.error(result.error || 'Password reset failed');
        }
      } finally {
        resetPwBtn.disabled = false;
        if (resetPwInput) resetPwInput.disabled = false;
        if (resetPwConfirm) resetPwConfirm.disabled = false;
      }
    });
  }

  document.getElementById('player-detail-modal').classList.remove('hidden');
}

// ===================== ADMIN CARDS =====================

/**
 * Batch D1 — Admin-only authoritative /cards JSON export (zero Firebase writes).
 */
async function handleAdminCardCatalogExport() {
  if (!auth.isAdmin()) {
    toast.error('Admin only.');
    return;
  }

  const exportBtn = document.getElementById('btn-export-card-data');
  if (exportBtn) exportBtn.disabled = true;

  try {
    const gather = await cards.gatherAuthoritativeCardsForExport();
    if (!gather.ok) {
      toast.error(`Card export failed: ${gather.error || 'authoritative read unavailable'}`);
      console.warn('[D1 Export]', gather);
      return;
    }

    const built = cards.buildCardCatalogExport(gather.snapshot);
    if (!built.ok) {
      toast.error('Card export aborted — validation failed (see console).');
      console.error('[D1 Export] validation failed', built.fatalIssues, built.diagnostics);
      return;
    }

    cards.downloadCardCatalogJson(built.cards);
    const n = built.diagnostics.exportedCount;
    const disabled = built.diagnostics.disabledCount;
    toast.success(
      disabled > 0
        ? `Exported ${n} cards (${disabled} disabled).`
        : `Exported ${n} cards.`,
    );
    console.info('[D1 Export] success', built.diagnostics);
  } catch (err) {
    toast.error('Card export failed unexpectedly.');
    console.error('[D1 Export]', err);
  } finally {
    if (exportBtn) exportBtn.disabled = false;
  }
}

/** @type {{ snapshot: object, plan: object }|null} */
let _d3CardConversionPreviewState = null;

/**
 * Batch D3 — Admin-only Firebase /cards conversion preview + raw backup (ZERO writes).
 */
async function handleAdminCardConversionPreview() {
  if (!auth.isAdmin()) {
    toast.error('Admin only.');
    return;
  }

  const previewBtn = document.getElementById('btn-preview-card-conversion');
  if (previewBtn) previewBtn.disabled = true;

  try {
    const gather = await cards.gatherAuthoritativeCardsForExport();
    if (!gather.ok) {
      toast.error(`Card conversion preview failed: ${gather.error || 'authoritative read unavailable'}`);
      console.warn('[D3 Preview]', gather);
      return;
    }

    const plan = buildCardFirebaseConversionPlan({
      baseCards: cards.BASE_CARD_DEFINITIONS,
      firebaseSnapshot: gather.snapshot,
    });

    _d3CardConversionPreviewState = {
      snapshot: gather.snapshot,
      plan,
    };

    const body = document.getElementById('card-conversion-preview-body');
    const banner = document.getElementById('card-conversion-preview-banner');
    if (banner) banner.textContent = plan.message;
    if (body) body.textContent = formatCardConversionPlanSummary(plan);

    document.getElementById('card-conversion-preview-modal')?.classList.remove('hidden');

    toast.info(
      plan.readyForD4
        ? `Preview ready — ${plan.firebaseCount} Firebase records. Download backup before any D4.`
        : `Preview ready — review issues (readyForD4=${plan.readyForD4}).`,
    );
    console.info('[D3 Preview]', plan);
  } catch (err) {
    toast.error('Card conversion preview failed unexpectedly.');
    console.error('[D3 Preview]', err);
  } finally {
    if (previewBtn) previewBtn.disabled = false;
  }
}

function closeCardConversionPreviewModal() {
  document.getElementById('card-conversion-preview-modal')?.classList.add('hidden');
}

function downloadCardConversionPreviewBackup() {
  if (!_d3CardConversionPreviewState?.snapshot) {
    toast.error('No preview snapshot — run Preview first.');
    return;
  }
  try {
    downloadRawCardsPreMigrationBackup(_d3CardConversionPreviewState.snapshot);
    toast.success(`Downloaded ${CARD_PRE_MIGRATION_BACKUP_FILENAME}`);
    console.info('[D3 Backup] downloaded', CARD_PRE_MIGRATION_BACKUP_FILENAME, {
      keys: Object.keys(_d3CardConversionPreviewState.snapshot).length,
    });
  } catch (err) {
    toast.error('Backup download failed.');
    console.error('[D3 Backup]', err);
  }
}

/**
 * Batch D4 — convert Firebase /cards to sparse overrides (fresh gather+plan; acknowledged write).
 * Never commits a stale D3 preview plan.
 */
async function handleAdminCardConversionCommit() {
  if (!auth.isAdmin()) {
    toast.error('Admin only.');
    return;
  }

  const convertBtn = document.getElementById('btn-convert-firebase-cards');
  if (convertBtn) convertBtn.disabled = true;

  try {
    const warned = await confirmAction(
      'This will convert Firebase /cards to the new sparse override/addition format.\n\n'
        + 'Bundled base cards remain in the game.\n\n'
        + 'Redundant Firebase copies will be removed.\n'
        + 'Intentional overrides and Firebase-only cards will be preserved.\n\n'
        + 'A pre-migration backup should already be saved '
        + `(${CARD_PRE_MIGRATION_BACKUP_FILENAME}).\n\n`
        + 'On confirm, Firebase /cards will be re-gathered and a FRESH plan built '
        + '(the D3 preview plan is never committed).\n\n'
        + 'Continue?',
      'Convert Firebase Cards to Overrides?',
    );
    if (!warned) return;

    const gather = await cards.gatherAuthoritativeCardsForExport();
    if (!gather.ok) {
      toast.error(`D4 aborted: ${gather.error || 'authoritative read unavailable'}`);
      console.warn('[D4 Convert] gather failed', gather);
      return;
    }

    const freshPlan = buildCardFirebaseConversionPlan({
      baseCards: cards.BASE_CARD_DEFINITIONS,
      firebaseSnapshot: gather.snapshot,
    });
    console.info('[D4 Convert] fresh plan', freshPlan);

    const gate = validateFreshPlanForD4Commit(freshPlan);
    if (!gate.ok) {
      toast.error(
        `D4 aborted (${gate.error}): ${gate.reason || 'fresh plan not safe'}. `
          + 'Re-run Preview and review before converting.',
      );
      console.error('[D4 Convert] gate failed', gate, freshPlan);
      return;
    }

    const confirmFresh = await confirmAction(
      `Fresh plan (re-gathered — not the D3 preview):\n\n`
        + `Firebase records: ${freshPlan.firebaseCount}\n`
        + `Redundant to remove: ${freshPlan.redundantCount}\n`
        + `Overrides to keep sparse: ${freshPlan.overrideCount}\n`
        + `Customs to preserve: ${freshPlan.customCount}\n`
        + `Expected Firebase records after: ${freshPlan.finalFirebaseRecordCount}\n`
        + `Bundled absent (no action): ${freshPlan.bundledAbsentFromFirebaseCount}\n\n`
        + 'Commit this fresh plan now?',
      'Confirm fresh conversion plan?',
    );
    if (!confirmFresh) return;

    const commit = await commitCardFirebaseConversionPlan(freshPlan, {
      updateAcknowledged: (updates) => db.updateAcknowledged(updates),
      allowOverridesAndCustoms: false,
    });

    if (!commit.ok) {
      toast.error(`D4 write failed: ${commit.error || 'unknown'}`);
      console.error('[D4 Convert] commit failed', commit);
      return;
    }

    if (commit.skipped) {
      toast.info(commit.message || 'No card updates needed.');
    } else {
      toast.success(
        `Converted Firebase cards — removed ${commit.deletes} redundant, `
          + `wrote ${commit.sparseSets} sparse override(s) (${commit.pathCount} paths).`,
      );
    }

    // Post-commit force-read verification
    const verify = await cards.gatherAuthoritativeCardsForExport();
    if (verify.ok) {
      const remaining = Object.keys(verify.snapshot || {}).length;
      const verifyPlan = buildCardFirebaseConversionPlan({
        baseCards: cards.BASE_CARD_DEFINITIONS,
        firebaseSnapshot: verify.snapshot,
      });
      console.info('[D4 Convert] post-verify', {
        firebaseRecordCount: remaining,
        overrideCount: verifyPlan.overrideCount,
        customCount: verifyPlan.customCount,
        resolvedCatalog: cards.getAllCards().length,
      });
      toast.info(
        `Post-verify: Firebase /cards = ${remaining} record(s); `
          + `resolved catalog = ${cards.getAllCards().length}.`,
      );
    } else {
      console.warn('[D4 Convert] post-verify gather failed', verify);
      toast.info(`Resolved catalog = ${cards.getAllCards().length} (post-verify gather failed).`);
    }

    renderAdminCards();
  } catch (err) {
    toast.error('D4 conversion failed unexpectedly.');
    console.error('[D4 Convert]', err);
  } finally {
    if (convertBtn) convertBtn.disabled = false;
  }
}

function setupCardConversionPreviewModal() {
  document.getElementById('btn-close-card-conversion-preview')?.addEventListener('click', closeCardConversionPreviewModal);
  document.getElementById('btn-dismiss-card-conversion-preview')?.addEventListener('click', closeCardConversionPreviewModal);
  document.getElementById('btn-download-cards-pre-migration-backup')?.addEventListener('click', downloadCardConversionPreviewBackup);
}

function renderAdminCards() {
  const allCards = cards.getAllCards();
  document.getElementById('card-count').textContent = allCards.length;

  const list = document.getElementById('admin-cards-list');

  // Apply filters
  const filterRarity = document.getElementById('admin-card-filter-rarity')?.value || 'all';
  const searchTerm = (document.getElementById('admin-card-search')?.value || '').toLowerCase();

  let filtered = allCards;
  if (filterRarity !== 'all') filtered = filtered.filter(c => c.rarity === filterRarity);
  if (searchTerm) filtered = filtered.filter(c =>
    c.name.toLowerCase().includes(searchTerm) ||
    (c.field || '').toLowerCase().includes(searchTerm)
  );

  if (filtered.length === 0) {
    list.innerHTML = `<div class="p-4 text-surface-500 text-center">${allCards.length === 0 ? 'No cards. Add some above!' : 'No cards match your filters.'}</div>`;
    return;
  }

  const sorted = cards.sortCardsByRarityAndName([...filtered]);

  // Phase 1D: auraLabel removed from admin card list — aura is no longer per-card admin data

  list.innerHTML = sorted.map(c => {
    const disabledBadge = c.enabled === false ? '<span class="text-[10px] text-red-400 ml-1">[disabled]</span>' : '';
    return `
      <div class="p-3 flex items-center justify-between hover:bg-surface-800">
        <div class="flex items-center gap-2 flex-wrap min-w-0">
          <span style="color:${cards.RARITY_COLORS[c.rarity]}">●</span>
          <span class="font-medium text-sm truncate">${c.name}</span>
          <span class="rarity-badge ${c.rarity} text-[10px]">${c.rarity}</span>
          <span class="text-xs text-surface-500 capitalize">${c.type} · ${c.field}</span>
          ${disabledBadge}
        </div>
        <div class="flex gap-2 shrink-0 ml-2">
          <button class="btn-edit-card text-xs px-2 py-1 rounded bg-primary-600/30 text-primary-400 hover:bg-primary-600/50" data-card-id="${c.id}">Edit</button>
          <button class="btn-delete-card text-red-400 hover:text-red-300 text-xs px-2 py-1" data-card-id="${c.id}">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  // Edit card — opens modal
  list.querySelectorAll('.btn-edit-card').forEach(btn => {
    btn.addEventListener('click', () => openEditCardModal(btn.dataset.cardId));
  });

  // Delete card — bundled base cannot be hard-deleted (would reappear from bundle)
  list.querySelectorAll('.btn-delete-card').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cardId = btn.dataset.cardId;
      const c = cards.getCard(cardId);
      const cardName = c ? c.name : cardId;

      if (cards.isBundledBaseCard(cardId)) {
        const confirmed = await confirmAction(
          `Bundled base cards cannot be deleted. Disable "${cardName}" instead? (Players who own it keep copies; it will no longer appear in packs/new awards.)`,
          `Disable bundled card "${cardName}"?`,
        );
        if (!confirmed) return;
        const result = cards.deleteCard(cardId, { asDisable: true });
        if (!result.ok) {
          toast.error('Could not disable card');
          return;
        }
        toast.info(`Card "${cardName}" disabled`);
        renderAdminCards();
        return;
      }

      const confirmed = await confirmAction(
        `This will permanently delete the card "${cardName}" from the database. Players who own it will keep copies in inventory.`,
        `Delete card "${cardName}"?`,
      );
      if (!confirmed) return;
      cards.deleteCard(cardId);
      toast.info('Card deleted');
      renderAdminCards();
    });
  });

  // Wire filter listeners (re-wired each render; uses direct assignment to avoid stacking)
  const filterRarityEl = document.getElementById('admin-card-filter-rarity');
  const searchEl = document.getElementById('admin-card-search');
  if (filterRarityEl) filterRarityEl.onchange = () => renderAdminCards();
  if (searchEl) searchEl.oninput = () => renderAdminCards();

  // Batch D1 — temporary read-only Firebase /cards export (Admin Cards tab only)
  const exportBtn = document.getElementById('btn-export-card-data');
  if (exportBtn) {
    exportBtn.onclick = () => { void handleAdminCardCatalogExport(); };
  }

  // Batch D3 — temporary read-only conversion preview (no D4 execute)
  const previewConversionBtn = document.getElementById('btn-preview-card-conversion');
  if (previewConversionBtn) {
    previewConversionBtn.onclick = () => { void handleAdminCardConversionPreview(); };
  }

  // Batch D4 — convert (fresh gather+plan; never commits stale D3 preview)
  const convertCardsBtn = document.getElementById('btn-convert-firebase-cards');
  if (convertCardsBtn) {
    convertCardsBtn.onclick = () => { void handleAdminCardConversionCommit(); };
  }

  // Wire up type dropdown to show/hide conceptType in create form
  const newCardTypeEl = document.getElementById('new-card-type');
  const newCardConceptTypeEl = document.getElementById('new-card-conceptType');
  if (newCardTypeEl && newCardConceptTypeEl) {
    const toggleNewConceptType = () => {
      if (newCardTypeEl.value === 'concept') {
        newCardConceptTypeEl.classList.remove('hidden');
      } else {
        newCardConceptTypeEl.classList.add('hidden');
      }
      updateCardArtAdminHints('new');
      updateImagePreview('new-card-imageUrl', 'new-card-image-preview', 'new-card-preview-img', getNewCardDraft());
    };
    newCardTypeEl.onchange = toggleNewConceptType;
    toggleNewConceptType(); // set initial state
  }

  // Add card button
  document.getElementById('btn-add-card').onclick = () => {
    const name = document.getElementById('new-card-name').value.trim();
    if (!name) { toast.error('Card name required'); return; }

    const imageUrl = document.getElementById('new-card-imageUrl').value.trim();
    const keyFact = document.getElementById('new-card-keyFact').value.trim();
    const type = document.getElementById('new-card-type').value;

    // Build card data
    const cardData = {
      name,
      rarity: document.getElementById('new-card-rarity').value,
      type,
      field: document.getElementById('new-card-field').value.trim() || 'General',
      effect: document.getElementById('new-card-effect').value.trim(),
      image: imageUrl,
      imageUrl,
      keyFact,
      flavor: keyFact, // backward compat: flavor = keyFact for legacy display
      // Phase 1D: auraType no longer admin-controlled; omit from card data
      enabled: document.getElementById('new-card-enabled').value === 'true',
    };

    // Concept cards: validate conceptType
    if (type === 'concept') {
      const conceptType = document.getElementById('new-card-conceptType').value;
      if (!cards.isValidConceptType(conceptType)) {
        console.warn(`[ResearchProjects] Invalid conceptType on create: "${conceptType}"`);
        toast.error('Invalid concept type selected');
        return;
      }
      cardData.conceptType = conceptType;
    }

    cards.createCard(cardData);
    toast.success(`Card "${name}" created`);

    // Reset form
    document.getElementById('new-card-name').value = '';
    document.getElementById('new-card-field').value = '';
    document.getElementById('new-card-effect').value = '';
    document.getElementById('new-card-imageUrl').value = '';
    document.getElementById('new-card-keyFact').value = '';
    document.getElementById('new-card-enabled').value = 'true';
    document.getElementById('new-card-type').value = 'scientist';
    document.getElementById('new-card-conceptType').value = 'researchBoost';
    document.getElementById('new-card-conceptType').classList.add('hidden');
    document.getElementById('new-card-image-preview')?.classList.add('hidden');
    renderAdminCards();
  };
}

// ===================== EDIT CARD MODAL =====================

/**
 * Open Edit Card modal and populate all fields from existing card data.
 */
function openEditCardModal(cardId) {
  const card = cards.getCard(cardId);
  if (!card) { toast.error('Card not found'); return; }

  document.getElementById('edit-card-id').value = cardId;
  document.getElementById('edit-card-name').value = card.name || '';
  document.getElementById('edit-card-rarity').value = card.rarity || 'common';
  document.getElementById('edit-card-type').value = card.type || 'concept';
  document.getElementById('edit-card-field').value = card.field || '';
  document.getElementById('edit-card-imageUrl').value = card.imageUrl || card.image || '';
  document.getElementById('edit-card-keyFact').value = card.keyFact || card.flavor || '';
  // Phase 1D: edit-card-auraType removed — aura is no longer per-card admin data
  document.getElementById('edit-card-enabled').value = card.enabled !== false ? 'true' : 'false';
  document.getElementById('edit-card-effect').value = card.effect || '';

  // conceptType: show/hide and populate
  const conceptTypeRow = document.getElementById('edit-card-conceptType-row');
  const conceptTypeSelect = document.getElementById('edit-card-conceptType');
  const flavorTextRow = document.getElementById('edit-card-flavorText-row');
  const flavorTextArea = document.getElementById('edit-card-flavorText');
  if (card.type === 'concept') {
    conceptTypeRow?.classList.remove('hidden');
    flavorTextRow?.classList.remove('hidden');
    if (conceptTypeSelect) {
      conceptTypeSelect.value = cards.isValidConceptType(card.conceptType) ? card.conceptType : 'researchBoost';
    }
    if (flavorTextArea) {
      flavorTextArea.value = card.flavorText || '';
    }
  } else {
    conceptTypeRow?.classList.add('hidden');
    flavorTextRow?.classList.add('hidden');
  }

  updateCardArtAdminHints('edit');
  updateImagePreview('edit-card-imageUrl', 'edit-card-image-preview', 'edit-card-preview-img', getEditCardDraft());

  document.getElementById('edit-card-modal').classList.remove('hidden');
}

/**
 * Wire up the Edit Card modal (called once during init).
 */
function setupEditCardModal() {
  // Close button
  document.getElementById('btn-close-edit-card')?.addEventListener('click', () => {
    document.getElementById('edit-card-modal').classList.add('hidden');
  });

  // Live image preview in edit modal
  document.getElementById('edit-card-imageUrl')?.addEventListener('input', () => {
    updateCardArtAdminHints('edit');
    updateImagePreview('edit-card-imageUrl', 'edit-card-image-preview', 'edit-card-preview-img', getEditCardDraft());
  });

  document.getElementById('edit-card-name')?.addEventListener('input', () => {
    updateCardArtAdminHints('edit');
    updateImagePreview('edit-card-imageUrl', 'edit-card-image-preview', 'edit-card-preview-img', getEditCardDraft());
  });

  document.getElementById('edit-card-type')?.addEventListener('change', () => {
    updateCardArtAdminHints('edit');
    updateImagePreview('edit-card-imageUrl', 'edit-card-image-preview', 'edit-card-preview-img', getEditCardDraft());
  });

  // Live image preview in create form
  document.getElementById('new-card-imageUrl')?.addEventListener('input', () => {
    updateCardArtAdminHints('new');
    updateImagePreview('new-card-imageUrl', 'new-card-image-preview', 'new-card-preview-img', getNewCardDraft());
  });

  document.getElementById('new-card-name')?.addEventListener('input', () => {
    updateCardArtAdminHints('new');
    updateImagePreview('new-card-imageUrl', 'new-card-image-preview', 'new-card-preview-img', getNewCardDraft());
  });

  document.getElementById('new-card-type')?.addEventListener('change', () => {
    updateCardArtAdminHints('new');
    updateImagePreview('new-card-imageUrl', 'new-card-image-preview', 'new-card-preview-img', getNewCardDraft());
  });

  // Toggle conceptType + flavorText row visibility when type changes in edit modal
  document.getElementById('edit-card-type')?.addEventListener('change', () => {
    const type = document.getElementById('edit-card-type').value;
    const row = document.getElementById('edit-card-conceptType-row');
    const ftRow = document.getElementById('edit-card-flavorText-row');
    if (row) {
      if (type === 'concept') {
        row.classList.remove('hidden');
        ftRow?.classList.remove('hidden');
      } else {
        row.classList.add('hidden');
        ftRow?.classList.add('hidden');
      }
    }
  });

  // Save button
  document.getElementById('btn-save-edit-card')?.addEventListener('click', () => {
    const cardId = document.getElementById('edit-card-id').value;
    if (!cardId) return;

    const name = document.getElementById('edit-card-name').value.trim();
    if (!name) { toast.error('Card name required'); return; }

    const imageUrl = document.getElementById('edit-card-imageUrl').value.trim();
    const keyFact = document.getElementById('edit-card-keyFact').value.trim();
    const type = document.getElementById('edit-card-type').value;

    const updates = {
      name,
      rarity: document.getElementById('edit-card-rarity').value,
      type,
      field: document.getElementById('edit-card-field').value.trim() || 'General',
      imageUrl,
      image: imageUrl, // keep legacy field in sync
      keyFact,
      flavor: keyFact, // keep legacy field in sync
      // Phase 1D: auraType no longer admin-controlled; omitted from updates
      enabled: document.getElementById('edit-card-enabled').value === 'true',
      effect: document.getElementById('edit-card-effect').value.trim(),
    };

    // Concept cards: validate conceptType + save optional flavorText before saving
    if (type === 'concept') {
      const conceptType = document.getElementById('edit-card-conceptType').value;
      if (!cards.isValidConceptType(conceptType)) {
        console.warn(`[ResearchProjects] Invalid conceptType on save: "${conceptType}" — blocking save, falling back to researchBoost`);
        toast.error('Invalid concept type selected');
        return;
      }
      updates.conceptType = conceptType;
      // flavorText is presentational-only — save it directly, no validation needed
      const flavorText = (document.getElementById('edit-card-flavorText')?.value ?? '').trim();
      updates.flavorText = flavorText; // empty string clears override; falsy → fall back to default
    }

    cards.updateCard(cardId, updates);
    const sparseNote = cards.isBundledBaseCard(cardId)
      ? ' (bundled base — sparse Firebase override)'
      : '';
    toast.success(`Card "${name}" updated${sparseNote}`);
    document.getElementById('edit-card-modal').classList.add('hidden');
    renderAdminCards();
  });
}

function getEditCardDraft() {
  return {
    name: document.getElementById('edit-card-name')?.value?.trim() || '',
    type: document.getElementById('edit-card-type')?.value || 'scientist',
    imageUrl: document.getElementById('edit-card-imageUrl')?.value?.trim() || '',
  };
}

function getNewCardDraft() {
  return {
    name: document.getElementById('new-card-name')?.value?.trim() || '',
    type: document.getElementById('new-card-type')?.value || 'scientist',
    imageUrl: document.getElementById('new-card-imageUrl')?.value?.trim() || '',
  };
}

/**
 * Show resolved local asset path and slug for admin card forms.
 * @param {'edit'|'new'} mode
 */
function updateCardArtAdminHints(mode) {
  const draft = mode === 'edit' ? getEditCardDraft() : getNewCardDraft();
  const prefix = mode === 'edit' ? 'edit-card' : 'new-card';
  const hintEl = document.getElementById(`${prefix}-local-art-hint`);
  const slugEl = document.getElementById(`${prefix}-art-slug-hint`);
  if (!hintEl || !slugEl) return;

  const slug = normalizeCardArtSlug(draft.name);
  slugEl.textContent = slug ? `Slug: ${slug}` : 'Slug: —';

  if (getAdminCardImageOverride(draft)) {
    hintEl.textContent = 'Image URL override active — local asset is not used until URL is cleared.';
    return;
  }

  const localPath = getLocalCardArtPath(draft);
  hintEl.textContent = localPath
    ? `Default local asset: ${localPath}`
    : 'No local path (set a valid name and scientist/concept type). Placeholder emoji is used until art exists.';
}

/**
 * Update an image preview element (effective resolved URL: override or local).
 * @param {object} [draftCard] - when omitted, uses raw input URL only
 */
function updateImagePreview(inputId, previewContainerId, previewImgId, draftCard) {
  const rawUrl = document.getElementById(inputId)?.value?.trim() || '';
  const container = document.getElementById(previewContainerId);
  const img = document.getElementById(previewImgId);
  if (!container || !img) return;

  const previewSrc = draftCard
    ? resolveCardArt({ ...draftCard, imageUrl: rawUrl, image: rawUrl }).src
    : rawUrl;

  if (previewSrc) {
    img.src = previewSrc;
    img.onerror = () => container.classList.add('hidden');
    img.onload = () => container.classList.remove('hidden');
    container.classList.remove('hidden');
  } else {
    container.classList.add('hidden');
  }
}

// ===================== ADMIN PACKS =====================

function renderAdminPacks() {
  const allPacks = packs.getAllPackTypes();
  const list = document.getElementById('admin-packs-list');

  if (allPacks.length === 0) {
    list.innerHTML = '<div class="p-4 text-surface-500 text-center">No pack types created yet.</div>';
    return;
  }

  list.innerHTML = allPacks.map(p => `
    <div class="p-4">
      <div class="flex items-center justify-between mb-2">
        <div>
          <span class="font-medium">${p.name}</span>
          <span class="text-xs ml-2 ${p.enabled ? 'text-green-400' : 'text-red-400'}">${p.enabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        <div class="flex gap-2">
          <button class="btn-edit-pack text-xs px-2 py-1 rounded bg-primary-600/30 text-primary-400 hover:bg-primary-600/50" data-pack-id="${p.id}">Edit</button>
          <button class="btn-toggle-pack text-xs px-2 py-1 rounded ${p.enabled ? 'bg-red-600/30 text-red-400' : 'bg-green-600/30 text-green-400'}" data-pack-id="${p.id}">
            ${p.enabled ? 'Disable' : 'Enable'}
          </button>
          <button class="btn-delete-pack text-xs px-2 py-1 rounded bg-red-600/30 text-red-400" data-pack-id="${p.id}" data-pack-name="${p.name}">Delete</button>
        </div>
      </div>
      <div class="text-xs text-surface-400">
        ${p.cardsPerPack} cards/pack · Odds: ${Object.entries(p.odds || {}).map(([r, v]) => `${r}: ${v}%`).join(', ')}
      </div>
    </div>
  `).join('');

  // Edit pack
  list.querySelectorAll('.btn-edit-pack').forEach(btn => {
    btn.addEventListener('click', () => openEditPackModal(btn.dataset.packId));
  });

  list.querySelectorAll('.btn-toggle-pack').forEach(btn => {
    btn.addEventListener('click', () => {
      packs.togglePack(btn.dataset.packId);
      toast.info('Pack toggled');
      renderAdminPacks();
    });
  });

  // Delete pack — DESTRUCTIVE (requires confirmation)
  list.querySelectorAll('.btn-delete-pack').forEach(btn => {
    btn.addEventListener('click', async () => {
      const packId = btn.dataset.packId;
      const packName = btn.dataset.packName || packId;
      const confirmed = await confirmAction(
        `This will permanently delete the pack type "${packName}". Players who own this pack will lose it.`,
        `Delete pack "${packName}"?`
      );
      if (!confirmed) return;
      packs.deletePackType(packId);
      toast.info('Pack deleted');
      renderAdminPacks();
    });
  });

  // Create pack
  document.getElementById('btn-create-pack').onclick = () => {
    const name = document.getElementById('new-pack-name').value.trim();
    if (!name) { toast.error('Pack name required'); return; }
    packs.createPackType({
      name,
      cardsPerPack: parseInt(document.getElementById('new-pack-cards-per').value) || 5,
      odds: {
        common: parseFloat(document.getElementById('new-pack-common').value) || 50,
        uncommon: parseFloat(document.getElementById('new-pack-uncommon').value) || 25,
        rare: parseFloat(document.getElementById('new-pack-rare').value) || 15,
        epic: parseFloat(document.getElementById('new-pack-epic').value) || 8,
        legendary: parseFloat(document.getElementById('new-pack-legendary').value) || 2,
      }
    });
    toast.success(`Pack type "${name}" created`);
    document.getElementById('new-pack-name').value = '';
    renderAdminPacks();
  };
}

/**
 * Open the Edit Pack modal and populate fields with current pack data.
 */
function openEditPackModal(packId) {
  const pack = packs.getPackType(packId);
  if (!pack) { toast.error('Pack not found'); return; }

  const odds = pack.odds || {};

  document.getElementById('edit-pack-id').value = packId;
  document.getElementById('edit-pack-name').value = pack.name || '';
  document.getElementById('edit-pack-cards-per').value = pack.cardsPerPack || 5;
  document.getElementById('edit-pack-enabled').value = pack.enabled ? 'true' : 'false';
  const shop = pack.shop || {};
  document.getElementById('edit-pack-shop-enabled').value = shop.enabled === true ? 'true' : 'false';
  document.getElementById('edit-pack-shop-rarity').value = shop.rarity || 'common';
  document.getElementById('edit-pack-shop-price').value = shop.price ?? 0;
  document.getElementById('edit-pack-shop-weight').value = shop.weight ?? 0;
  document.getElementById('edit-pack-common').value = odds.common ?? 50;
  document.getElementById('edit-pack-uncommon').value = odds.uncommon ?? 25;
  document.getElementById('edit-pack-rare').value = odds.rare ?? 15;
  document.getElementById('edit-pack-epic').value = odds.epic ?? 8;
  document.getElementById('edit-pack-legendary').value = odds.legendary ?? 2;

  updateEditPackOddsTotal();
  document.getElementById('edit-pack-modal').classList.remove('hidden');
}

/**
 * Show the odds total so the admin can verify they sum correctly.
 */
function updateEditPackOddsTotal() {
  const rarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const total = rarities.reduce((sum, r) => sum + (parseFloat(document.getElementById(`edit-pack-${r}`).value) || 0), 0);
  const el = document.getElementById('edit-pack-odds-total');
  el.textContent = `Total: ${total}%`;
  el.className = `text-xs text-right mt-1 ${total === 100 ? 'text-green-400' : 'text-amber-400'}`;
}

/**
 * Wire up the Edit Pack modal save/close and odds live-total.
 * Called once during init().
 */
function setupEditPackModal() {
  // Close button
  document.getElementById('btn-close-edit-pack')?.addEventListener('click', () => {
    document.getElementById('edit-pack-modal').classList.add('hidden');
  });

  // Live odds total update
  ['edit-pack-common', 'edit-pack-uncommon', 'edit-pack-rare', 'edit-pack-epic', 'edit-pack-legendary'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateEditPackOddsTotal);
  });

  // Save button
  document.getElementById('btn-save-edit-pack')?.addEventListener('click', () => {
    const packId = document.getElementById('edit-pack-id').value;
    if (!packId) return;

    const name = document.getElementById('edit-pack-name').value.trim();
    if (!name) { toast.error('Pack name required'); return; }

    const updates = {
      name,
      cardsPerPack: parseInt(document.getElementById('edit-pack-cards-per').value) || 5,
      enabled: document.getElementById('edit-pack-enabled').value === 'true',
      shop: {
        enabled: document.getElementById('edit-pack-shop-enabled').value === 'true',
        rarity: document.getElementById('edit-pack-shop-rarity').value || 'common',
        price: parseFloat(document.getElementById('edit-pack-shop-price').value) || 0,
        weight: parseFloat(document.getElementById('edit-pack-shop-weight').value) || 0,
      },
      odds: {
        common: parseFloat(document.getElementById('edit-pack-common').value) || 0,
        uncommon: parseFloat(document.getElementById('edit-pack-uncommon').value) || 0,
        rare: parseFloat(document.getElementById('edit-pack-rare').value) || 0,
        epic: parseFloat(document.getElementById('edit-pack-epic').value) || 0,
        legendary: parseFloat(document.getElementById('edit-pack-legendary').value) || 0,
      }
    };

    packs.updatePackType(packId, updates);
    toast.success(`Pack "${name}" updated`);
    document.getElementById('edit-pack-modal').classList.add('hidden');
    renderAdminPacks();
  });
}

// ===================== ADMIN GROUPS =====================

function renderAdminGroups() {
  const allGroupsList = groups.getAllGroups();
  const list = document.getElementById('admin-groups-list');

  if (allGroupsList.length === 0) {
    list.innerHTML = '<div class="p-4 text-surface-500 text-center">No groups yet. Create one above.</div>';
  } else {
    list.innerHTML = allGroupsList.map(g => {
      const subs = groups.getSubgroups(g.id);
      return `
        <div class="p-4">
          <div class="flex items-center justify-between">
            <span class="font-medium text-white">📁 ${g.name}</span>
            <div class="flex gap-2">
              <button class="btn-edit-group bg-surface-700 hover:bg-surface-600 text-xs px-3 py-1 rounded" data-group-id="${g.id}">Edit</button>
            </div>
          </div>
          ${subs.length > 0 ? `
            <div class="ml-5 mt-2 space-y-1">
              ${subs.map(sub => `
                <div class="flex items-center gap-2 text-sm text-surface-300">
                  <span class="text-surface-500">└</span>
                  <span>📄 ${sub.name}</span>
                </div>
              `).join('')}
            </div>
          ` : '<div class="ml-5 mt-1 text-xs text-surface-600 italic">No subgroups</div>'}
        </div>
      `;
    }).join('');

    list.querySelectorAll('.btn-edit-group').forEach(btn => {
      btn.addEventListener('click', () => openGroupEditModal(btn.dataset.groupId));
    });
  }

  // Create group
  document.getElementById('btn-create-group').onclick = async () => {
    const name = document.getElementById('new-group-name').value.trim();
    if (!name) { toast.error('Group name required'); return; }
    const id = await groups.createGroup(name);
    if (!id) {
      toast.error('Failed to create group');
      return;
    }
    toast.success(`Group "${name}" created`);
    document.getElementById('new-group-name').value = '';
    renderAdminGroups();
    refreshAccessCodeGroupDropdown();
  };
}

function openGroupEditModal(groupId) {
  const group = groups.getGroup(groupId);
  if (!group) return;

  const modal = document.getElementById('group-edit-modal');
  document.getElementById('group-edit-id').value = groupId;
  document.getElementById('group-edit-name').value = group.name;
  modal.classList.remove('hidden');

  renderGroupEditSubgroups(groupId);

  // Rename group
  document.getElementById('btn-group-rename').onclick = () => {
    const newName = document.getElementById('group-edit-name').value.trim();
    if (!newName) { toast.error('Name required'); return; }
    groups.renameGroup(groupId, newName);
    toast.success('Group renamed');
    renderAdminGroups();
    refreshAccessCodeGroupDropdown();
  };

  // Add subgroup
  document.getElementById('btn-add-subgroup').onclick = () => {
    const subName = document.getElementById('group-edit-new-subgroup').value.trim();
    if (!subName) { toast.error('Subgroup name required'); return; }
    groups.createSubgroup(groupId, subName);
    toast.success(`Subgroup "${subName}" added`);
    document.getElementById('group-edit-new-subgroup').value = '';
    renderGroupEditSubgroups(groupId);
    renderAdminGroups();
  };

  // Delete group
  document.getElementById('btn-group-delete').onclick = async () => {
    const confirmed = await confirmAction(
      `Delete group "${group.name}" and all its subgroups? Players will become ungrouped.`,
      `Delete "${group.name}"?`
    );
    if (!confirmed) return;
    const result = await groups.deleteGroup(groupId);
    if (!result.ok) {
      toast.error(result.error || 'Failed to delete group');
      return;
    }
    toast.info('Group deleted');
    modal.classList.add('hidden');
    renderAdminGroups();
    refreshAccessCodeGroupDropdown();
  };

  // Close
  document.getElementById('btn-close-group-edit').onclick = () => modal.classList.add('hidden');
}

function renderGroupEditSubgroups(groupId) {
  const subs = groups.getSubgroups(groupId);
  const container = document.getElementById('group-edit-subgroups-list');
  if (subs.length === 0) {
    container.innerHTML = '<div class="text-xs text-surface-500 italic">No subgroups yet.</div>';
    return;
  }
  container.innerHTML = subs.map(sub => `
    <div class="flex items-center gap-2 bg-surface-800 rounded px-3 py-2">
      <span class="flex-1 text-sm" id="sub-label-${sub.id}">${sub.name}</span>
      <input type="text" class="sub-rename-input admin-input py-1 text-sm hidden flex-1" data-sub-id="${sub.id}" value="${sub.name}">
      <button class="btn-sub-rename-toggle text-primary-400 hover:text-primary-300 text-xs" data-sub-id="${sub.id}" data-group-id="${groupId}">Rename</button>
      <button class="btn-sub-delete text-red-400 hover:text-red-300 text-xs" data-sub-id="${sub.id}" data-sub-name="${sub.name}" data-group-id="${groupId}">Delete</button>
    </div>
  `).join('');

  container.querySelectorAll('.btn-sub-rename-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const subId = btn.dataset.subId;
      const label = container.querySelector(`#sub-label-${subId}`);
      const input = container.querySelector(`.sub-rename-input[data-sub-id="${subId}"]`);
      if (btn.textContent === 'Rename') {
        label.classList.add('hidden');
        input.classList.remove('hidden');
        btn.textContent = 'Save';
      } else {
        const newName = input.value.trim();
        if (!newName) { toast.error('Name required'); return; }
        groups.renameSubgroup(groupId, subId, newName);
        toast.success('Subgroup renamed');
        renderGroupEditSubgroups(groupId);
        renderAdminGroups();
      }
    });
  });

  container.querySelectorAll('.btn-sub-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const subId = btn.dataset.subId;
      const subName = btn.dataset.subName || subId;
      const confirmed = await confirmAction(
        `Delete subgroup "${subName}"? Students in this subgroup will have their subgroup cleared.`,
        `Delete subgroup?`
      );
      if (!confirmed) return;
      groups.deleteSubgroup(groupId, subId);
      toast.info('Subgroup deleted');
      renderGroupEditSubgroups(groupId);
      renderAdminGroups();
    });
  });
}

// ===================== ADMIN ACCESS =====================

/**
 * S7c: once-load accessCodes before listing. Failure ≠ empty.
 * @param {{ skipHydrate?: boolean }} [options]
 */
async function renderAdminAccess(options = {}) {
  const list = document.getElementById('admin-access-list');
  if (!list) return;

  refreshAccessCodeGroupDropdown();

  if (options.skipHydrate !== true) {
    list.innerHTML = '<div class="p-4 text-surface-400 text-center">Loading access codes…</div>';
    const load = await loadAdminAccessCodesOnce({ force: true });
    if (!load.ok) {
      list.innerHTML = `<div class="p-4 text-amber-400 text-center">Access codes unavailable. ${load.error ? String(load.error) : 'Once-load failed.'} Leave and re-open Access to retry.</div>`;
      _wireAdminAccessButtons([]);
      return;
    }
  }

  const codesData = db.getChildren('accessCodes') || [];

  if (codesData.length === 0) {
    list.innerHTML = '<div class="p-4 text-surface-500 text-center">No access codes generated yet.</div>';
    _wireAdminAccessButtons([]);
    return;
  }

  const sorted = [...codesData].sort((a, b) => (b.value.created || 0) - (a.value.created || 0));

  list.innerHTML = sorted.map(({ key, value }) => `
    <div class="p-2 px-4 flex items-center justify-between text-sm ${value.used ? 'opacity-50' : ''}">
      <div class="font-mono font-bold">${key}</div>
      <div class="flex items-center gap-3 text-xs">
        ${value.group ? `<span class="text-surface-400">${groups.getGroupName(value.group)}</span>` : ''}
        ${value.used ? `<span class="text-red-400">Used by ${getDirectoryDisplayName(db.get(`${DIRECTORY_ROOT}/${value.usedBy}`), value.usedBy || '')}</span>` : '<span class="text-green-400">Available</span>'}
      </div>
    </div>
  `).join('');

  _wireAdminAccessButtons(codesData);
}

function _wireAdminAccessButtons(codesData) {
  const genBtn = document.getElementById('btn-gen-codes');
  if (genBtn) {
    genBtn.onclick = () => {
      const count = parseInt(document.getElementById('access-code-count').value) || 10;
      const group = document.getElementById('access-code-group').value || null;
      auth.generateAccessCodes(count, group);
      toast.success(`${count} access codes generated`);
      // Local writes already updated cache — skip network re-hydrate
      void renderAdminAccess({ skipHydrate: true });
    };
  }

  const copyBtn = document.getElementById('btn-copy-codes');
  if (copyBtn) {
    copyBtn.onclick = () => {
      const unused = (codesData || []).filter(c => !c.value.used).map(c => c.key);
      if (unused.length === 0) { toast.info('No unused codes'); return; }
      navigator.clipboard.writeText(unused.join('\n')).then(() => {
        toast.success(`${unused.length} codes copied!`);
      }).catch(() => toast.error('Copy failed'));
    };
  }
}

function refreshAccessCodeGroupDropdown() {
  const select = document.getElementById('access-code-group');
  if (!select) return;
  const allGroupsList = groups.getAllGroups();
  select.innerHTML = `<option value="">No group</option>` +
    allGroupsList.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
}

// ===================== ADMIN CONFIG (DYNAMIC 1:1 EDITOR) =====================

/**
 * Recursively renders ALL fields from /config in Firebase.
 * No hardcoded keys — reads whatever is in the config object.
 * Supports booleans (toggle), numbers, strings, and nested objects.
 */
function renderAdminConfig() {
  const cfg = config.getConfig();
  if (!cfg) return;

  const editor = document.getElementById('config-editor');
  editor.innerHTML = buildConfigEditor(cfg, '');

  // Wire up toggle switches
  editor.querySelectorAll('.config-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const path = toggle.dataset.configPath;
      const current = config.getValue(path);
      config.setValue(path, !current);
      toast.success(`${path} set to ${!current}`);
      renderAdminConfig(); // re-render to update toggle state
    });
  });

  // Save button
  document.getElementById('btn-save-config').onclick = () => {
    editor.querySelectorAll('[data-config-path]:not(.config-toggle)').forEach(input => {
      const path = input.dataset.configPath;
      let val = input.value;

      // Type coercion: numbers stay numbers, "true"/"false" stay as entered strings
      // (booleans are handled by toggles, not text inputs)
      if (input.type === 'number' || (!isNaN(val) && val !== '' && val.trim() !== '')) {
        val = Number(val);
      }
      // null handling
      if (val === 'null' || val === '') {
        val = input.type === 'number' ? 0 : (input.dataset.wasNull === 'true' ? null : val);
      }

      config.setValue(path, val);
    });
    toast.success('Config saved to Firebase');
    renderAdminConfig(); // refresh to show updated values
  };
}

/**
 * Centralized config-ownership map.
 *
 * Keys are dot-paths (matching the `path` variable inside buildConfigEditor).
 * Values are human-readable admin section names — purely informational today,
 * but ready to power future admin routing / help-text.
 *
 * Any config key whose dot-path appears here (or whose dot-path is a CHILD of
 * a path listed here) will be hidden from the generic Config tab because it
 * already has a dedicated admin UI.
 *
 * To hide a new config from the generic tab, add one line here.
 */
const ADMIN_CONFIG_SECTIONS = {
  // Entire sub-trees owned by the Balance admin tab
  'projectBalance':                             'balance',
  'quests':                                     'balance',

  // Entire sub-tree owned by the Trading Controls admin tab
  'trading':                                    'trading-controls',

  // Individual economy keys owned by the Trading Controls admin tab
  'economy.directTradeCooldownMinutes':         'trading-controls',
  'economy.listingCooldownMinutes':             'trading-controls',
  'economy.listingAcceptCooldownMinutes':        'trading-controls',
  'economy.listingExpirationHours':             'trading-controls',
  'economy.maxActiveListingsPerPlayer':         'trading-controls',
};

/**
 * Check whether a given dot-path is owned by a specialized admin section.
 * Returns true if the path (or any ancestor) appears in ADMIN_CONFIG_SECTIONS.
 */
function _isOwnedByAdminSection(dotPath) {
  if (ADMIN_CONFIG_SECTIONS[dotPath]) return true;
  // Check ancestors (e.g. "projectBalance.rarityPower.common" is owned
  // because "projectBalance" is in the map)
  const parts = dotPath.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join('.');
    if (ADMIN_CONFIG_SECTIONS[ancestor]) return true;
  }
  return false;
}

/**
 * Recursively build HTML for config fields.
 * @param {object} obj - config object or sub-object
 * @param {string} prefix - dot-separated path prefix
 * @returns {string} HTML string
 */
function buildConfigEditor(obj, prefix) {
  if (!obj || typeof obj !== 'object') return '';

  const sections = [];
  // Separate top-level scalars from nested objects for cleaner layout
  const scalarEntries = [];
  const objectEntries = [];

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    // Skip configs that belong to a dedicated admin section
    if (_isOwnedByAdminSection(path)) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      objectEntries.push({ key, value, path });
    } else {
      scalarEntries.push({ key, value, path });
    }
  }

  // Render scalar fields
  if (scalarEntries.length > 0) {
    const fieldHTML = scalarEntries.map(({ key, value, path }) => {
      return buildFieldInput(key, value, path);
    }).join('');

    if (prefix) {
      // Nested scalars — rendered inline in parent section
      sections.push(fieldHTML);
    } else {
      // Top-level scalars — wrap in a section
      sections.push(`
        <div class="bg-surface-800 rounded-lg p-4">
          <h4 class="font-semibold text-sm mb-3 text-primary-400">General</h4>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${fieldHTML}
          </div>
        </div>
      `);
    }
  }

  // Render nested objects as collapsible sections
  for (const { key, value, path } of objectEntries) {
    const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
    const innerHTML = buildConfigEditor(value, path);
    // Skip section if all children were filtered out by ownership map
    if (!innerHTML.trim()) continue;
    // Mark packOdds as deprecated in the config UI
    const isDeprecated = (key === 'packOdds');
    sections.push(`
      <div class="bg-surface-800 rounded-lg p-4 ${isDeprecated ? 'opacity-60 border border-amber-800/50' : ''}">
        <h4 class="font-semibold text-sm mb-3 text-primary-400 capitalize">
          ${label}
          ${isDeprecated ? '<span class="text-amber-400 text-[10px] ml-2 font-normal">(DEPRECATED — per-pack odds control drops)</span>' : ''}
        </h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${innerHTML}
        </div>
      </div>
    `);
  }

  return sections.join('');
}

/**
 * Build a single input field for a config value.
 */
function buildFieldInput(key, value, path) {
  const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());

  // Boolean → toggle switch
  if (typeof value === 'boolean') {
    return `
      <div class="flex items-center justify-between gap-2 sm:col-span-2">
        <label class="text-xs text-surface-400">${label}</label>
        <button class="config-toggle relative w-12 h-6 rounded-full transition-colors ${value ? 'bg-green-600' : 'bg-surface-600'}" data-config-path="${path}">
          <span class="absolute top-0.5 ${value ? 'left-6' : 'left-0.5'} w-5 h-5 bg-white rounded-full transition-all shadow"></span>
        </button>
      </div>
    `;
  }

  // Number
  if (typeof value === 'number') {
    return `
      <div class="flex items-center gap-2">
        <label class="text-xs text-surface-400 w-36 shrink-0">${label}</label>
        <input type="number" value="${value}" data-config-path="${path}" class="admin-input flex-1 text-xs">
      </div>
    `;
  }

  // Null
  if (value === null || value === undefined) {
    return `
      <div class="flex items-center gap-2">
        <label class="text-xs text-surface-400 w-36 shrink-0">${label}</label>
        <input type="text" value="" placeholder="null" data-config-path="${path}" data-was-null="true" class="admin-input flex-1 text-xs italic text-surface-500">
      </div>
    `;
  }

  // String (default)
  return `
    <div class="flex items-center gap-2">
      <label class="text-xs text-surface-400 w-36 shrink-0">${label}</label>
      <input type="text" value="${String(value).replace(/"/g, '&quot;')}" data-config-path="${path}" class="admin-input flex-1 text-xs">
    </div>
  `;
}

// ===================== ADMIN BALANCE =====================

/**
 * Renders the Research Balance editor in the admin panel.
 * Reads live values from project-config.js (DB-backed), renders numeric inputs,
 * and wires Save / Reset buttons.
 */
function renderAdminBalance() {
  const container = document.getElementById('balance-editor');
  if (!container) return;

  const cfg = getProjectConfig();
  const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

  // Helper: build a labeled numeric input
  function numInput(id, value, step) {
    const s = step != null ? step : (Math.abs(value) < 1 && value !== 0 ? '0.01' : '1');
    return `<input type="number" id="${id}" value="${value}" step="${s}" class="admin-input text-xs w-24">`;
  }

  // Helper: build a rarity table row
  function rarityRow(label, inputsHTML) {
    return `<tr><td class="text-xs text-surface-400 pr-3 py-1 capitalize font-medium">${label}</td>${inputsHTML}</tr>`;
  }

  // Helper: section wrapper
  function section(title, content) {
    return `
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-3 text-primary-400">${title}</h4>
        ${content}
      </div>
    `;
  }

  // ─── 1. Scientist Power ───
  const scientistPowerRows = RARITIES.map(r => {
    const val = cfg.rarityPower?.[r] ?? 0;
    return rarityRow(r, `<td>${numInput('bal-rp-' + r, val, '1')}</td>`);
  }).join('');
  const scientistPowerHTML = section('Scientist Power',
    `<table><thead><tr><th class="text-xs text-surface-500 text-left pr-3 pb-1">Rarity</th><th class="text-xs text-surface-500 text-left pb-1">Base Power</th></tr></thead><tbody>${scientistPowerRows}</tbody></table>`
  );

  // ─── 2. Aura Scaling ───
  const auraLevels = [0, 1, 2, 3];
  const auraRows = auraLevels.map(lvl => {
    const val = cfg.auraScaling?.[lvl] ?? 0;
    return rarityRow(`Level ${lvl}`, `<td>${numInput('bal-aura-' + lvl, val, '0.01')}</td>`);
  }).join('');
  const auraHTML = section('Aura Scaling',
    `<p class="text-[10px] text-surface-500 mb-2">Multiplier bonus per aura level. Applied as: power * (1 + bonus)</p>` +
    `<table><thead><tr><th class="text-xs text-surface-500 text-left pr-3 pb-1">Level</th><th class="text-xs text-surface-500 text-left pb-1">Bonus Multiplier</th></tr></thead><tbody>${auraRows}</tbody></table>`
  );

  // ─── 3. Success Curve ───
  const sc = cfg.successCurve ?? {};
  const successCurveHTML = section('Success Curve',
    `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div>
        <div class="flex items-center gap-2 mb-1">
          <label class="text-xs text-surface-400 w-28 shrink-0">Exponent</label>
          ${numInput('bal-sc-exponent', sc.exponent ?? 0.6, '0.01')}
        </div>
        <p class="text-[10px] text-surface-500">Higher = stronger scaling from team power.</p>
      </div>
      <div>
        <div class="flex items-center gap-2 mb-1">
          <label class="text-xs text-surface-400 w-28 shrink-0">Midpoint</label>
          ${numInput('bal-sc-midpoint', sc.midpoint ?? 0.55, '0.01')}
        </div>
        <p class="text-[10px] text-surface-500">Controls baseline success near equal power.</p>
      </div>
      <div>
        <div class="flex items-center gap-2 mb-1">
          <label class="text-xs text-surface-400 w-28 shrink-0">Min Success</label>
          ${numInput('bal-sc-min', sc.min ?? 0.05, '0.01')}
        </div>
        <p class="text-[10px] text-surface-500">Lowest possible project success chance.</p>
      </div>
      <div>
        <div class="flex items-center gap-2 mb-1">
          <label class="text-xs text-surface-400 w-28 shrink-0">Max Success</label>
          ${numInput('bal-sc-max', sc.max ?? 0.95, '0.01')}
        </div>
        <p class="text-[10px] text-surface-500">Highest possible project success chance.</p>
      </div>
    </div>`
  );

  // ─── 4. Project Difficulty ───
  const diffRows = RARITIES.map(r => {
    const range = cfg.projectDifficulty?.[r] ?? [0, 0];
    // Handle both array [min, max] and object {0: min, 1: max} from Firebase
    const mn = Array.isArray(range) ? range[0] : (range[0] ?? range['0'] ?? 0);
    const mx = Array.isArray(range) ? range[1] : (range[1] ?? range['1'] ?? 0);
    return rarityRow(r,
      `<td class="pr-2">${numInput('bal-diff-min-' + r, mn, '1')}</td>` +
      `<td>${numInput('bal-diff-max-' + r, mx, '1')}</td>`
    );
  }).join('');
  const diffHTML = section('Project Difficulty',
    `<table><thead><tr><th class="text-xs text-surface-500 text-left pr-3 pb-1">Rarity</th><th class="text-xs text-surface-500 text-left pr-2 pb-1">Min Difficulty</th><th class="text-xs text-surface-500 text-left pb-1">Max Difficulty</th></tr></thead><tbody>${diffRows}</tbody></table>`
  );

  // ─── 5. RP Rewards ───
  const rpRows = RARITIES.map(r => {
    const rw = cfg.rpRewards?.[r] ?? { success: [0, 0], failure: [0, 0] };
    const sArr = rw.success ?? [0, 0];
    const fArr = rw.failure ?? [0, 0];
    const sMin = Array.isArray(sArr) ? sArr[0] : (sArr[0] ?? sArr['0'] ?? 0);
    const sMax = Array.isArray(sArr) ? sArr[1] : (sArr[1] ?? sArr['1'] ?? 0);
    const fMin = Array.isArray(fArr) ? fArr[0] : (fArr[0] ?? fArr['0'] ?? 0);
    const fMax = Array.isArray(fArr) ? fArr[1] : (fArr[1] ?? fArr['1'] ?? 0);
    return rarityRow(r,
      `<td class="pr-2">${numInput('bal-rw-smin-' + r, sMin, '1')}</td>` +
      `<td class="pr-2">${numInput('bal-rw-smax-' + r, sMax, '1')}</td>` +
      `<td class="pr-2">${numInput('bal-rw-fmin-' + r, fMin, '1')}</td>` +
      `<td>${numInput('bal-rw-fmax-' + r, fMax, '1')}</td>`
    );
  }).join('');
  const rpHTML = section('RP Rewards',
    `<table><thead><tr>
      <th class="text-xs text-surface-500 text-left pr-3 pb-1">Rarity</th>
      <th class="text-xs text-surface-500 text-left pr-2 pb-1">Success Min</th>
      <th class="text-xs text-surface-500 text-left pr-2 pb-1">Success Max</th>
      <th class="text-xs text-surface-500 text-left pr-2 pb-1">Failure Min</th>
      <th class="text-xs text-surface-500 text-left pb-1">Failure Max</th>
    </tr></thead><tbody>${rpRows}</tbody></table>`
  );

  // ─── 6. Project Duration ───
  const durRows = RARITIES.map(r => {
    const range = cfg.projectDurations?.[r] ?? [0, 0];
    const mn = Array.isArray(range) ? range[0] : (range[0] ?? range['0'] ?? 0);
    const mx = Array.isArray(range) ? range[1] : (range[1] ?? range['1'] ?? 0);
    return rarityRow(r,
      `<td class="pr-2">${numInput('bal-dur-min-' + r, mn, '1')}</td>` +
      `<td>${numInput('bal-dur-max-' + r, mx, '1')}</td>`
    );
  }).join('');
  const durHTML = section('Project Duration',
    `<p class="text-[10px] text-surface-500 mb-2">Duration range in hours per rarity</p>` +
    `<table><thead><tr><th class="text-xs text-surface-500 text-left pr-3 pb-1">Rarity</th><th class="text-xs text-surface-500 text-left pr-2 pb-1">Min Hours</th><th class="text-xs text-surface-500 text-left pb-1">Max Hours</th></tr></thead><tbody>${durRows}</tbody></table>`
  );

  // ─── 7. Project Refresh Cadence ───
  const refreshHoursVal = cfg.projectRefreshHours ?? 12;
  const refreshHTML = section('Project Refresh Cadence',
    `<div class="flex items-center gap-3">
      <label class="text-xs text-surface-400 shrink-0">Refresh Interval (hours)</label>
      ${numInput('bal-refresh-hours', refreshHoursVal, '0.5')}
      <span class="text-[10px] text-surface-500">How often new projects generate</span>
    </div>`
  );

  // ─── 8. Breakthrough Bonus ───
  const bb = cfg.breakthroughBonus ?? {};
  const breakthroughBonusHTML = section('Breakthrough Bonus',
    `<p class="text-[10px] text-surface-500 mb-3">Controls what players receive when a project results in a breakthrough.</p>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div class="flex items-center gap-2">
        <label class="text-xs text-surface-400 w-36 shrink-0">RP Reward Chance</label>
        ${numInput('bal-bt-rpchance', bb.rpChance ?? 0.85, '0.01')}
        <span class="text-[10px] text-surface-500">0–1</span>
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs text-surface-400 w-36 shrink-0">Card Reward Chance</label>
        ${numInput('bal-bt-cardchance', bb.cardChance ?? 0.15, '0.01')}
        <span class="text-[10px] text-surface-500">0–1</span>
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs text-surface-400 w-36 shrink-0">Bonus RP %</label>
        ${numInput('bal-bt-bonuspct', bb.breakthroughBonusPercent ?? 0.50, '0.01')}
        <span class="text-[10px] text-surface-500">% of resolved RP (e.g. 0.5 = 50%)</span>
      </div>
    </div>`
  );

  // ─── 9. Project Rarity Weights ───
  const rw = cfg.projectRarityWeights ?? {};
  const rarityWeightRows = RARITIES.map(r => {
    const w = rw[r] ?? 0;
    return rarityRow(r, `<td>${numInput('bal-rw-weight-' + r, w, '1')}</td>`);
  }).join('');
  const rarityWeightsHTML = section('Project Rarity Generation Weights',
    `<p class="text-[10px] text-surface-500 mb-3">Controls how often each rarity appears when new projects generate. Higher values = more likely. Only unlocked rarities are eligible — locked rarities are ignored regardless of their weight.</p>` +
    `<table><thead><tr>
      <th class="text-xs text-surface-500 text-left pr-3 pb-1">Rarity</th>
      <th class="text-xs text-surface-500 text-left pb-1">Weight</th>
    </tr></thead><tbody>${rarityWeightRows}</tbody></table>`
  );

  // ─── 10. Breakthrough Card Rarity Weights ───
  const bcrw = cfg.breakthroughCardRarityWeights ?? {};
  const btCardWeightRows = RARITIES.map(r => {
    const w = bcrw[r] ?? 0;
    return rarityRow(r, `<td>${numInput('bal-btc-weight-' + r, w, '1')}</td>`);
  }).join('');
  const btCardWeightsHTML = section('Breakthrough Card Rarity Weights',
    `<p class="text-[10px] text-surface-500 mb-3">Controls rarity odds when a breakthrough event awards a card. <strong class="text-surface-400">Independent from pack odds and project generation weights.</strong> Higher values = more likely. Values don't need to sum to 100.</p>` +
    `<table><thead><tr>
      <th class="text-xs text-surface-500 text-left pr-3 pb-1">Rarity</th>
      <th class="text-xs text-surface-500 text-left pb-1">Weight</th>
    </tr></thead><tbody>${btCardWeightRows}</tbody></table>`
  );

  // ─── 11. Concept Modifiers ───
  const CONCEPT_TYPE_LABELS = {
    researchBoost:       'Research Amplifier',
    difficultyReduction: 'Complexity Reducer',
    synergyBoost:        'Synergy Booster',
    breakthrough:        'Breakthrough Catalyst',
    risk:                'Risk Enhancer',
  };
  const CONCEPT_EFFECT_PROPERTY_LABELS = {
    rewardRPPercent:    'Reward % Increase',
    difficulty:         'Difficulty Reduction',
    teamPowerPercent:   'Team Power % Increase',
    breakthroughChance: 'Breakthrough %',
    difficultyPercent:  'Difficulty % Increase',
  };
  const conceptTypes = Object.keys(cfg.conceptEffects ?? {});
  let conceptHTML = '';
  for (const cType of conceptTypes) {
    const typeEffects = cfg.conceptEffects[cType] ?? {};
    // Determine the property keys from the first available rarity
    const sampleRarity = RARITIES.find(r => typeEffects[r]) || 'common';
    const propKeys = Object.keys(typeEffects[sampleRarity] ?? {});
    if (propKeys.length === 0) continue;

    const headerCols = propKeys.map(pk =>
      `<th class="text-xs text-surface-500 text-left pr-2 pb-1">${CONCEPT_EFFECT_PROPERTY_LABELS[pk] || pk}</th>`
    ).join('');

    const rows = RARITIES.map(r => {
      const eff = typeEffects[r] ?? {};
      const cells = propKeys.map(pk => {
        const v = eff[pk] ?? 0;
        const step = Math.abs(v) < 1 && v !== 0 ? '0.01' : '1';
        return `<td class="pr-2">${numInput('bal-ce-' + cType + '-' + r + '-' + pk, v, step)}</td>`;
      }).join('');
      return rarityRow(r, cells);
    }).join('');

    conceptHTML += `
      <div class="mb-3">
        <h5 class="text-xs font-semibold text-surface-300 mb-2">${CONCEPT_TYPE_LABELS[cType] || cType}</h5>
        <table><thead><tr>
          <th class="text-xs text-surface-500 text-left pr-3 pb-1">Rarity</th>
          ${headerCols}
        </tr></thead><tbody>${rows}</tbody></table>
      </div>
    `;
  }
  const conceptModifiersHTML = conceptHTML
    ? section('Concept Modifiers', conceptHTML)
    : '';

  // ─── 12. Starter Pack Config ───
  const starterPackId  = cfg.starterPackId  ?? '';
  const starterPackQty = cfg.starterPackQuantity ?? 1;
  const allPackTypes   = packs.getAllPackTypes();
  const packOptions    = allPackTypes.map(p =>
    `<option value="${p.id}" ${p.id === starterPackId ? 'selected' : ''}>${p.name} (${p.id})</option>`
  ).join('');
  const starterPackHTML = section('Starter Pack Grant',
    `<p class="text-[10px] text-surface-500 mb-3">
      Packs granted to brand-new student accounts at registration — once only, never again on login.
      Set quantity to 0 or leave Pack ID blank to disable.
    </p>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div class="flex items-center gap-2 sm:col-span-2">
        <label class="text-xs text-surface-400 w-36 shrink-0">Pack Type</label>
        <select id="bal-starter-pack-id" class="admin-input flex-1 text-xs">
          <option value="">— None (disabled) —</option>
          ${packOptions}
        </select>
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs text-surface-400 w-36 shrink-0">Quantity</label>
        ${numInput('bal-starter-pack-qty', starterPackQty, '1')}
        <span class="text-[10px] text-surface-500">packs per new account</span>
      </div>
    </div>`
  );

  // ─── 12b. Starter Card Grants (new accounts) ───
  const starterScientistCount = cfg.starterScientistCount ?? 5;
  const starterConceptCount   = cfg.starterConceptCount   ?? 2;
  // Normalize pool (Firebase may store as object)
  let starterConceptPool = cfg.starterConceptPool;
  if (starterConceptPool && typeof starterConceptPool === 'object' && !Array.isArray(starterConceptPool)) {
    starterConceptPool = Object.values(starterConceptPool);
  }
  if (!Array.isArray(starterConceptPool)) starterConceptPool = ['synergyBoost', 'breakthrough'];

  const CONCEPT_TYPE_INFO = [
    { label: 'Research Amplifier',   value: 'researchBoost' },
    { label: 'Complexity Reducer',   value: 'difficultyReduction' },
    { label: 'Synergy Booster',      value: 'synergyBoost' },
    { label: 'Breakthrough Catalyst',value: 'breakthrough' },
    { label: 'Risk Enhancer',        value: 'risk' },
  ];
  const conceptPoolCheckboxes = CONCEPT_TYPE_INFO.map(ct => {
    const checked = starterConceptPool.includes(ct.value) ? 'checked' : '';
    return `
      <label class="flex items-center gap-2 cursor-pointer select-none">
        <input type="checkbox" class="bal-concept-pool-cb" value="${ct.value}" ${checked}
          style="accent-color:#6366f1;">
        <span class="text-xs text-surface-300">${ct.label}</span>
        <span class="text-[10px] text-surface-500">(${ct.value})</span>
      </label>`;
  }).join('');

  const starterCardsHTML = section('Starter Card Grants (New Accounts)',
    `<p class="text-[10px] text-surface-500 mb-3">
      Cards granted once to brand-new accounts at registration — never again on login.
      Scientists are drawn randomly from <strong>enabled common scientist</strong> cards.
      Concepts are drawn randomly from <strong>enabled concept cards</strong> matching the selected types below.
      Set a count to 0 to disable that grant type.
    </p>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <div class="flex items-center gap-2 mb-2">
          <label class="text-xs text-surface-400 w-44 shrink-0">Starter Scientist Count</label>
          ${numInput('bal-starter-scientist-count', starterScientistCount, '1')}
          <span class="text-[10px] text-surface-500">common scientists per new account</span>
        </div>
        <div class="flex items-center gap-2">
          <label class="text-xs text-surface-400 w-44 shrink-0">Starter Concept Count</label>
          ${numInput('bal-starter-concept-count', starterConceptCount, '1')}
          <span class="text-[10px] text-surface-500">concept cards per new account</span>
        </div>
      </div>
      <div>
        <p class="text-xs text-surface-400 mb-2 font-medium">Concept Type Pool</p>
        <p class="text-[10px] text-surface-500 mb-2">One card per selected type is granted (up to Count). Types with no enabled cards are skipped.</p>
        <div class="flex flex-col gap-1.5">
          ${conceptPoolCheckboxes}
        </div>
      </div>
    </div>`
  );

  // ─── 13. Initial Projects (new accounts) ───
  // Read new key; fall back to old key so existing saved DB values are shown correctly.
  const initialProjectsVal = cfg.initialProjects ?? cfg.initialProjectSlots ?? 2;
  const initialSlotsHTML = section('Starting Projects (New Accounts)',
    `<p class="text-[10px] text-surface-500 mb-3">
      How many research projects a brand-new account receives immediately upon registration —
      before any progression or unlocks. <strong>Existing players are never affected.</strong>
      This is separate from the system-wide project slot cap.
    </p>
    <div class="flex items-center gap-2">
      <label class="text-xs text-surface-400 w-36 shrink-0">Initial Projects</label>
      ${numInput('bal-initial-projects', initialProjectsVal, '1')}
      <span class="text-[10px] text-surface-500">projects on first login (1–7)</span>
    </div>`
  );

  // ─── 14. Rarity Unlock Thresholds ───
  const thresholds = cfg.rarityUnlockThresholds ?? {};
  const unlockRows = RARITIES.map(r => {
    const t = thresholds[r] ?? 0;
    return rarityRow(r, `<td>${numInput('bal-unlock-' + r, t, '50')}</td>`);
  }).join('');
  const unlockHTML = section('Rarity Unlock Thresholds',
    `<p class="text-[10px] text-surface-500 mb-3">
      Total RP a player needs to unlock each project rarity tier.
      common must always be 0. Existing progression logic is unchanged.
    </p>
    <table><thead><tr>
      <th class="text-xs text-surface-500 text-left pr-3 pb-1">Rarity</th>
      <th class="text-xs text-surface-500 text-left pb-1">RP Required</th>
    </tr></thead><tbody>${unlockRows}</tbody></table>`
  );

  // ─── 15. Project Flavor Titles ───
  const flavorTitles = cfg.projectFlavorTitles ?? {};
  const flavorSections = RARITIES.map(r => {
    // Normalize Firebase object-stored arrays
    let pool = flavorTitles[r];
    if (pool && typeof pool === 'object' && !Array.isArray(pool)) pool = Object.values(pool);
    const entries = Array.isArray(pool) ? pool : [];
    const rows = entries.map((text, i) => `
      <div class="flex items-center gap-2 mb-1 flavor-row" data-rarity="${r}" data-index="${i}">
        <input type="text" class="admin-input flex-1 text-xs flavor-title-input"
          data-rarity="${r}" data-index="${i}" value="${String(text).replace(/"/g, '&quot;')}">
        <button class="btn-flavor-remove text-red-400 hover:text-red-300 text-xs px-2 py-1 shrink-0"
          data-rarity="${r}" data-index="${i}">✕</button>
      </div>
    `).join('');
    return `
      <div class="mb-4">
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs font-semibold capitalize" style="color:${{common:'#4b5563',uncommon:'#22c55e',rare:'#3b82f6',epic:'#a855f7',legendary:'#f59e0b'}[r]}">${r}</span>
          <button class="btn-flavor-add text-xs text-primary-400 hover:text-primary-300 px-2 py-0.5"
            data-rarity="${r}">+ Add Entry</button>
        </div>
        <div id="flavor-list-${r}">${rows || '<div class="text-[10px] text-surface-500 italic">No entries — will use built-in defaults.</div>'}</div>
      </div>
    `;
  }).join('');
  const flavorHTML = section('Project Flavor Titles',
    `<p class="text-[10px] text-surface-500 mb-3">
      Title pool for each project rarity. One is picked at random when generating a project.
      Removing all entries for a rarity falls back to built-in defaults.
      Save Balance to persist changes.
    </p>
    ${flavorSections}`
  );

  // ─── 16. Weekly Reward Pack ───
  const weeklyPackId     = cfg.weeklyRewardPackId  ?? '';
  const weeklyRefreshDay = cfg.weeklyRefreshDay     ?? 5;
  const weeklyRefreshHour= cfg.weeklyRefreshHour    ?? 23;
  const weeklyRPReqs     = cfg.weeklyRPRequirements ?? { common:1, uncommon:40, rare:80, epic:150, legendary:250 };

  const weeklyPackOptions = allPackTypes.map(p =>
    `<option value="${p.id}" ${p.id === weeklyPackId ? 'selected' : ''}>${p.name} (${p.id})</option>`
  ).join('');

  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const weeklyDayOptions = dayNames.map((d, i) =>
    `<option value="${i}" ${i === weeklyRefreshDay ? 'selected' : ''}>${d}</option>`
  ).join('');

  // RP requirement rows — common is always locked to 1
  const weeklyRPRows = ['uncommon','rare','epic','legendary'].map(r => `
    <div class="flex items-center gap-2 mb-1">
      <label class="text-xs capitalize w-24 shrink-0" style="color:${{uncommon:'#22c55e',rare:'#3b82f6',epic:'#a855f7',legendary:'#f59e0b'}[r]}">${r}</label>
      ${numInput('bal-weekly-rp-req-' + r, weeklyRPReqs[r] ?? 0, '10')}
      <span class="text-[10px] text-surface-500">RP</span>
    </div>
  `).join('');

  const weeklyPackHTML = section('Weekly Reward Pack',
    `<p class="text-[10px] text-surface-500 mb-3">
      Players earn one reward pack per weekly cycle by accumulating Research Points.
      The RP threshold scales with the player's highest unlocked rarity tier.
      Common tier is always 1 RP (onboarding). Leave Pack Type blank to disable.
    </p>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
      <div class="flex items-center gap-2 sm:col-span-2">
        <label class="text-xs text-surface-400 w-36 shrink-0">Pack Type</label>
        <select id="bal-weekly-pack-id" class="admin-input flex-1 text-xs">
          <option value="">— None (disabled) —</option>
          ${weeklyPackOptions}
        </select>
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs text-surface-400 w-36 shrink-0">Refresh Day</label>
        <select id="bal-weekly-refresh-day" class="admin-input flex-1 text-xs">
          ${weeklyDayOptions}
        </select>
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs text-surface-400 w-36 shrink-0">Refresh Hour (0–23)</label>
        ${numInput('bal-weekly-refresh-hour', weeklyRefreshHour, '0')}
        <span class="text-[10px] text-surface-500">24h clock</span>
      </div>
    </div>
    <p class="text-[10px] text-surface-400 font-semibold mb-2">RP Requirements by Rarity Stage</p>
    <div class="flex items-center gap-2 mb-1">
      <label class="text-xs text-surface-400 w-24 shrink-0">common</label>
      <span class="text-xs text-surface-500 italic">1 RP (hardcoded — onboarding)</span>
    </div>
    ${weeklyRPRows}`
  );

  // ─── Assemble ───
  container.innerHTML = starterPackHTML + starterCardsHTML + weeklyPackHTML + initialSlotsHTML + refreshHTML + scientistPowerHTML + auraHTML + successCurveHTML + diffHTML + rpHTML + durHTML + breakthroughBonusHTML + rarityWeightsHTML + btCardWeightsHTML + unlockHTML + flavorHTML + conceptModifiersHTML;

  // ─── Wire flavor title add/remove buttons (dynamic, must run after innerHTML) ───
  container.querySelectorAll('.btn-flavor-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const rarity = btn.dataset.rarity;
      const listEl = document.getElementById(`flavor-list-${rarity}`);
      if (!listEl) return;
      // Remove "no entries" placeholder if present
      listEl.querySelectorAll('.text-surface-500.italic').forEach(el => el.remove());
      const idx = listEl.querySelectorAll('.flavor-row').length;
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 mb-1 flavor-row';
      row.dataset.rarity = rarity;
      row.dataset.index = idx;
      row.innerHTML = `
        <input type="text" class="admin-input flex-1 text-xs flavor-title-input"
          data-rarity="${rarity}" data-index="${idx}" placeholder="New title…">
        <button class="btn-flavor-remove text-red-400 hover:text-red-300 text-xs px-2 py-1 shrink-0"
          data-rarity="${rarity}">✕</button>
      `;
      row.querySelector('.btn-flavor-remove').addEventListener('click', () => row.remove());
      listEl.appendChild(row);
    });
  });

  container.querySelectorAll('.btn-flavor-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.flavor-row');
      if (row) row.remove();
    });
  });

  // ─── Wire Save button ───
  document.getElementById('btn-save-balance').onclick = () => {
    const updated = collectBalanceValues();
    saveProjectConfig(updated);
    toast.success('Research balance saved');
    renderAdminBalance(); // re-render to confirm
  };

  // ─── Wire Reset button ───
  document.getElementById('btn-reset-balance').onclick = async () => {
    const confirmed = await confirmAction(
      'This will overwrite all balance values with factory defaults. Are you sure?',
      'Reset Balance to Defaults'
    );
    if (confirmed) {
      seedProjectConfigDefaults();
      toast.success('Balance reset to defaults');
      renderAdminBalance();
    }
  };
}

/**
 * Collect all balance numeric inputs from the DOM and build a config object.
 * Called by the Save Balance button handler.
 * @returns {object} Full project config object
 */
function collectBalanceValues() {
  const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

  function val(id) {
    const el = document.getElementById(id);
    return el ? Number(el.value) : 0;
  }

  // Preserve the existing config and only update the fields we expose
  const existing = getProjectConfig();

  const cfg = JSON.parse(JSON.stringify(existing));

  // Project Refresh Cadence
  const refreshVal = val('bal-refresh-hours');
  cfg.projectRefreshHours = refreshVal > 0 ? refreshVal : 12;

  // Scientist Power
  cfg.rarityPower = {};
  for (const r of RARITIES) cfg.rarityPower[r] = val('bal-rp-' + r);

  // Aura Scaling
  cfg.auraScaling = {};
  for (let lvl = 0; lvl <= 3; lvl++) cfg.auraScaling[lvl] = val('bal-aura-' + lvl);

  // Success Curve
  cfg.successCurve = {
    exponent: val('bal-sc-exponent'),
    midpoint: val('bal-sc-midpoint'),
    min:      val('bal-sc-min'),
    max:      val('bal-sc-max'),
  };

  // Project Difficulty
  cfg.projectDifficulty = {};
  for (const r of RARITIES) cfg.projectDifficulty[r] = [val('bal-diff-min-' + r), val('bal-diff-max-' + r)];

  // RP Rewards
  cfg.rpRewards = {};
  for (const r of RARITIES) {
    cfg.rpRewards[r] = {
      success: [val('bal-rw-smin-' + r), val('bal-rw-smax-' + r)],
      failure: [val('bal-rw-fmin-' + r), val('bal-rw-fmax-' + r)],
    };
  }

  // Project Durations
  cfg.projectDurations = {};
  for (const r of RARITIES) cfg.projectDurations[r] = [val('bal-dur-min-' + r), val('bal-dur-max-' + r)];

  // Breakthrough Bonus
  cfg.breakthroughBonus = {
    rpChance:                 val('bal-bt-rpchance'),
    cardChance:               val('bal-bt-cardchance'),
    breakthroughBonusPercent: val('bal-bt-bonuspct'),
  };

  // Project Rarity Weights
  cfg.projectRarityWeights = {};
  for (const r of RARITIES) cfg.projectRarityWeights[r] = val('bal-rw-weight-' + r);

  // Breakthrough Card Rarity Weights (independent from pack odds and project rarity weights)
  cfg.breakthroughCardRarityWeights = {};
  for (const r of RARITIES) cfg.breakthroughCardRarityWeights[r] = val('bal-btc-weight-' + r);

  // Starter Pack Grant
  const starterPackIdEl = document.getElementById('bal-starter-pack-id');
  cfg.starterPackId       = starterPackIdEl ? starterPackIdEl.value.trim() : (cfg.starterPackId ?? '');
  cfg.starterPackQuantity = val('bal-starter-pack-qty');

  // Starter Card Grants
  const rawScientistCount = val('bal-starter-scientist-count');
  cfg.starterScientistCount = Math.max(0, Math.floor(rawScientistCount || 0));
  const rawConceptCount = val('bal-starter-concept-count');
  cfg.starterConceptCount = Math.max(0, Math.floor(rawConceptCount || 0));
  // Collect checked concept types
  const conceptPoolSelected = [];
  document.querySelectorAll('.bal-concept-pool-cb:checked').forEach(cb => {
    if (cb.value) conceptPoolSelected.push(cb.value);
  });
  cfg.starterConceptPool = conceptPoolSelected.length > 0 ? conceptPoolSelected : (cfg.starterConceptPool ?? ['synergyBoost', 'breakthrough']);

  // Weekly Reward Pack
  const weeklyPackIdEl = document.getElementById('bal-weekly-pack-id');
  cfg.weeklyRewardPackId  = weeklyPackIdEl ? weeklyPackIdEl.value.trim() : (cfg.weeklyRewardPackId ?? '');
  const weeklyDayEl = document.getElementById('bal-weekly-refresh-day');
  cfg.weeklyRefreshDay  = weeklyDayEl  ? parseInt(weeklyDayEl.value,  10) : (cfg.weeklyRefreshDay  ?? 5);
  cfg.weeklyRefreshHour = val('bal-weekly-refresh-hour') ?? 23;
  cfg.weeklyRPRequirements = { common: 1 };
  for (const r of ['uncommon', 'rare', 'epic', 'legendary']) {
    cfg.weeklyRPRequirements[r] = val('bal-weekly-rp-req-' + r);
  }

  // Initial Projects (new accounts only — separate from max slot cap)
  const rawInitProjects = val('bal-initial-projects');
  cfg.initialProjects = Math.max(1, Math.min(7, rawInitProjects || 2));
  // Keep legacy key in sync so old DB reads still work during transition
  cfg.initialProjectSlots = cfg.initialProjects;

  // Rarity Unlock Thresholds
  cfg.rarityUnlockThresholds = {};
  for (const r of RARITIES) cfg.rarityUnlockThresholds[r] = val('bal-unlock-' + r);
  cfg.rarityUnlockThresholds.common = 0; // common must always be 0

  // Project Flavor Titles — collect from live DOM (add/remove applied before Save)
  cfg.projectFlavorTitles = {};
  for (const r of RARITIES) {
    const listEl = document.getElementById(`flavor-list-${r}`);
    if (!listEl) continue;
    const titles = [];
    listEl.querySelectorAll('.flavor-title-input').forEach(input => {
      const text = input.value.trim();
      if (text) titles.push(text);
    });
    cfg.projectFlavorTitles[r] = titles.length > 0 ? titles : (cfg.projectFlavorTitles[r] ?? []);
  }

  // Concept Effects — collect from DOM inputs keyed as bal-ce-{type}-{rarity}-{prop}
  const existingCE = cfg.conceptEffects ?? {};
  cfg.conceptEffects = {};
  for (const cType of Object.keys(existingCE)) {
    cfg.conceptEffects[cType] = {};
    for (const r of RARITIES) {
      const sampleProps = existingCE[cType]?.[r] ?? {};
      cfg.conceptEffects[cType][r] = {};
      for (const pk of Object.keys(sampleProps)) {
        cfg.conceptEffects[cType][r][pk] = val('bal-ce-' + cType + '-' + r + '-' + pk);
      }
    }
  }

  return cfg;
}

// ===================== ADMIN TRADING CONTROLS (Phase T-8) =====================

function renderAdminTradingControls() {
  const container = document.getElementById('trading-controls-editor');
  if (!container) return;

  // Read current values from DB config
  const tradingCfg = db.get('config/trading') || {};
  const economyCfg = db.get('config/economy') || {};

  // Helper: toggle switch for a boolean config value
  function toggleSwitch(id, label, value, hint) {
    return `
      <div class="flex items-center justify-between gap-2">
        <div>
          <span class="text-xs text-surface-300 font-medium">${label}</span>
          ${hint ? `<p class="text-[10px] text-surface-500 mt-0.5">${hint}</p>` : ''}
        </div>
        <button id="${id}" class="trade-ctrl-toggle relative w-12 h-6 rounded-full transition-colors ${value ? 'bg-green-600' : 'bg-surface-600'}" data-value="${value ? 'true' : 'false'}">
          <span class="absolute top-0.5 ${value ? 'left-6' : 'left-0.5'} w-5 h-5 bg-white rounded-full transition-all shadow"></span>
        </button>
      </div>`;
  }

  // Helper: numeric input
  function numField(id, label, value, hint, step) {
    const s = step ?? '1';
    return `
      <div class="flex items-center gap-2">
        <div class="w-52 shrink-0">
          <label class="text-xs text-surface-300 font-medium">${label}</label>
          ${hint ? `<p class="text-[10px] text-surface-500 mt-0.5">${hint}</p>` : ''}
        </div>
        <input type="number" id="${id}" value="${value}" step="${s}" min="0" class="admin-input text-xs w-28">
      </div>`;
  }

  // Helper: section wrapper
  function section(title, content) {
    return `
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-3 text-primary-400">${title}</h4>
        <div class="space-y-3">${content}</div>
      </div>`;
  }

  // ─── 1. Global Toggles ───
  const togglesHTML = section('Global Toggles', [
    toggleSwitch('tc-trading-enabled', 'Trading Enabled',
      tradingCfg.enabled !== false,
      'Master switch — disables ALL trading when off'),
    toggleSwitch('tc-direct-trades', 'Direct Trades Enabled',
      tradingCfg.directTradesEnabled !== false,
      'Disable 1-on-1 direct trades only'),
    toggleSwitch('tc-listings', 'Listings Enabled',
      tradingCfg.listingsEnabled !== false,
      'Disable anonymous trade listings only'),
    toggleSwitch('tc-default-hidden', 'Default Hidden Profile',
      tradingCfg.defaultHiddenProfile === true,
      'New players start with hidden trade profiles'),
    toggleSwitch('tc-detailed-logs', 'Detailed Trade Logs',
      tradingCfg.enableDetailedLogs === true,
      'Verbose console logging for trade actions'),
  ].join(''));

  // ─── 2. Cooldowns & Limits ───
  const directCd = economyCfg.directTradeCooldownMinutes ?? 10080;
  const listingCd = economyCfg.listingCooldownMinutes ?? 10080;
  const acceptCd = economyCfg.listingAcceptCooldownMinutes ?? 10080;
  const expireHrs = economyCfg.listingExpirationHours ?? 168;
  const maxListings = economyCfg.maxActiveListingsPerPlayer ?? 1;

  function minutesHint(mins) {
    if (mins >= 1440) return `≈ ${(mins / 1440).toFixed(1)} days`;
    if (mins >= 60) return `≈ ${(mins / 60).toFixed(1)} hours`;
    return `${mins} minutes`;
  }

  const cooldownsHTML = section('Cooldowns &amp; Limits', [
    numField('tc-direct-cd', 'Direct Trade Cooldown',
      directCd, `Minutes between direct trades (${minutesHint(directCd)})`),
    numField('tc-listing-cd', 'Listing Post Cooldown',
      listingCd, `Minutes between posting listings (${minutesHint(listingCd)})`),
    numField('tc-accept-cd', 'Listing Accept Cooldown',
      acceptCd, `Minutes between accepting listings (${minutesHint(acceptCd)})`),
    numField('tc-expire-hrs', 'Listing Expiration',
      expireHrs, `Hours before an active listing expires (${(expireHrs / 24).toFixed(1)} days)`),
    numField('tc-max-listings', 'Max Active Listings Per Player',
      maxListings, 'Maximum number of active trade listings per player'),
  ].join(''));

  container.innerHTML = togglesHTML + cooldownsHTML;

  // ─── Wire toggle switches ───
  container.querySelectorAll('.trade-ctrl-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const current = btn.dataset.value === 'true';
      const next = !current;
      btn.dataset.value = next ? 'true' : 'false';
      btn.classList.toggle('bg-green-600', next);
      btn.classList.toggle('bg-surface-600', !next);
      const dot = btn.querySelector('span');
      dot.classList.toggle('left-6', next);
      dot.classList.toggle('left-0.5', !next);
    });
  });

  // ─── Wire Save button ───
  document.getElementById('btn-save-trading-controls').onclick = () => {
    // Collect toggle values
    const getBool = (id) => document.getElementById(id)?.dataset.value === 'true';
    const getNum = (id) => {
      const el = document.getElementById(id);
      return el ? Number(el.value) : 0;
    };

    // Write trading toggles
    db.set('config/trading/enabled', getBool('tc-trading-enabled'));
    db.set('config/trading/directTradesEnabled', getBool('tc-direct-trades'));
    db.set('config/trading/listingsEnabled', getBool('tc-listings'));
    db.set('config/trading/defaultHiddenProfile', getBool('tc-default-hidden'));
    db.set('config/trading/enableDetailedLogs', getBool('tc-detailed-logs'));

    // Write economy values
    db.set('config/economy/directTradeCooldownMinutes', getNum('tc-direct-cd'));
    db.set('config/economy/listingCooldownMinutes', getNum('tc-listing-cd'));
    db.set('config/economy/listingAcceptCooldownMinutes', getNum('tc-accept-cd'));
    db.set('config/economy/listingExpirationHours', getNum('tc-expire-hrs'));
    db.set('config/economy/maxActiveListingsPerPlayer', getNum('tc-max-listings'));

    toast.success('Trading settings saved');
    renderAdminTradingControls(); // re-render to confirm
  };
}

// ===================== INIT =====================

export function init() {
  setupTabs();
  setupLoginScreen();
  initLeaderboardUI();

  // Close modals
  document.getElementById('btn-close-pack')?.addEventListener('click', () => {
    document.getElementById('pack-opening-overlay').classList.add('hidden');
  });
  initCardDetailModal();
  initCosmeticPreviewModal();
  initFeaturedCardPicker();
  document.getElementById('btn-close-player-detail')?.addEventListener('click', () => {
    document.getElementById('player-detail-modal').classList.add('hidden');
    releaseAdminSelectedPlayerScope();
  });
  setupAdminQuickGivePacksModal();

  // Edit Card modal wiring
  setupEditCardModal();
  setupCardConversionPreviewModal();

  // Edit Pack modal wiring
  setupEditPackModal();

  // Collection filters
  ['filter-rarity', 'filter-type'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', renderCollection);
  });
  document.getElementById('filter-search')?.addEventListener('input', renderCollection);

  // Check existing session
  const session = auth.getSession();
  if (session) {
    enterGame();
  } else {
    showScreen('login');
  }
}
