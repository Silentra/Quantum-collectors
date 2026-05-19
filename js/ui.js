/**
 * UI Module - Screen management, tab navigation, rendering
 *
 * This is the main UI controller that wires DOM events to game modules.
 */

import * as auth from './auth.js';
import { resetPlayerPassword } from './auth.js';
import * as player from './player.js';
import * as cards from './cards.js';
import * as packs from './packs.js';
import * as groups from './groups.js';
import * as config from './config.js';
import * as db from './database.js';
import * as toast from './toast.js';
import { getLockedCardIds } from './project-state.js';
import { refreshUniqueCardsOwned } from './research.js';
import { getProjectConfig, saveProjectConfig, seedProjectConfigDefaults } from './project-config.js';
import { initLeaderboardUI, renderLeaderboard } from './leaderboard-ui.js';
import { renderAdminSeasons } from './leaderboard-admin.js';
import { renderTrading, cleanupTrading } from './trade-ui.js';
import { ITEM_DEFINITIONS, ITEM_TYPES } from './shop-definitions.js';
import { renderShopAdminPanel } from './shop-admin.js';
import {
  adminCompleteActiveProject,
  adminGrantResearchPoints,
  adminGrantShopItem,
} from './admin-player-tools.js';

// Project UI subsystem (extracted — Phase 1 refactor)
import {
  renderResearchProjects,
  startProjectHeartbeat,
  stopProjectHeartbeat,
} from './project-ui.js';

// Profile & Shop UI subsystems (extracted — Phase 2 refactor)
import { renderProfile } from './profile-ui.js';
import { renderShop, cleanupShop } from './shop-ui.js';

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

// ===================== CONFIRM MODAL =====================

/**
 * Show a confirmation modal before a destructive action.
 * Returns a Promise that resolves to true (confirm) or false (cancel).
 */
export function confirmAction(message, title = 'Are you sure?') {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    modal.classList.remove('hidden');

    const okBtn = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');

    function cleanup() {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
    }
    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// ===================== SCREEN MANAGEMENT =====================

export function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`screen-${screenId}`);
  if (el) el.classList.add('active');
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
      if (tab === 'collection') renderCollection();
      if (tab === 'packs') renderPacks();
      if (tab === 'research-projects') { renderResearchProjects(); startProjectHeartbeat(); }
      else { stopProjectHeartbeat(); }
      if (tab === 'trading') { renderTrading(); }
      else { cleanupTrading(); }
      if (tab === 'shop') { renderShop(); }
      else { cleanupShop(); }
      if (tab === 'profile') renderProfile();
      if (tab === 'leaderboard') renderLeaderboard();
      if (tab === 'admin') renderAdmin();
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
      renderAdminSubTab(tab);
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
      toast.success('Account created! Welcome to SciCards!');
      enterGame();
    } else {
      showLoginMessage(result.error, 'error');
    }
  });

  document.getElementById('btn-admin-login').addEventListener('click', () => {
    const pw = document.getElementById('admin-password').value;
    const result = auth.adminLogin(pw);
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

export function enterGame() {
  showScreen('game');
  const session = auth.getSession();
  if (!session) return;

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

  document.getElementById('nav-username').textContent = isStandaloneAdmin ? '\u2699\uFE0F Admin' : session.username;

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
  }

  document.getElementById('btn-logout').addEventListener('click', () => {
    auth.logout();
    showScreen('login');
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

  // Phase 4C — derive locked card IDs from ACTIVE ResearchProjects (read-only)
  const p = player.getPlayer(session.username);
  const lockedCardIds = new Set(getLockedCardIds(p?.projects ?? []));

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
      <div class="collection-rarity-group">
        <div class="collection-rarity-label rarity-label-${rarity}">${rarity}</div>
        <div class="collection-rarity-row">
          ${groupEntries.map(({ card, quantity, undiscovered }) => renderPlayerCard(card, quantity, lockedCardIds.has(card.id), undiscovered)).join('')}
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.sci-card').forEach(el => {
      el.addEventListener('click', () => {
        const cardId = el.dataset.cardId;
        const qty = parseInt(el.dataset.qty) || 1;
        showCardDetail(cardId, qty);
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
 * Phase 4C: isLocked is derived from ACTIVE ResearchProjects — purely visual,
 * never stored on the card itself. Card remains fully viewable when locked.
 */
// Concept display maps — imported from cards.js (shared between collection + project rendering)
const CONCEPT_EFFECT_LABELS = cards.CONCEPT_EFFECT_LABELS;
const CONCEPT_FLAVOR_TEXT = cards.CONCEPT_FLAVOR_TEXT;

function renderPlayerCard(card, quantity = 1, isLocked = false, isUndiscovered = false) {
  const imageUrl = card.imageUrl || card.image || '';
  const keyFact = card.keyFact || card.flavor || '';
  const field = card.field || 'General';
  // Phase 1D: All cards always render with a visual aura (default_prismatic).
  // Undiscovered cards get tier 0 (no glow) but still receive the aura class for future profile cosmetics.
  const visualAura = cards.resolveVisualAura(null); // null = no profile cosmetic override yet
  const auraTier = isUndiscovered ? 0 : cards.getAuraTier(card.rarity, quantity);
  const auraClass = auraTier > 0 ? cards.getAuraCSSClass(visualAura) : '';
  const lockedClass = isLocked ? 'sci-card--locked' : '';
  const undiscoveredClass = isUndiscovered ? 'sci-card--undiscovered' : '';
  const emoji = cards.TYPE_EMOJIS[card.type] || '\uD83D\uDD2C';

  // Aura tier dots (shown for all cards when tier > 0)
  let auraDots = '';
  if (auraTier > 0) {
    auraDots = `<div class="sci-card-aura-dots">${
      [1,2,3].map(i => `<span class="dot ${i <= auraTier ? 'filled' : ''}"></span>`).join('')
    }</div>`;
  }

  // Phase 4C: small corner badge shown only when card is on an active project
  const lockedBadge = isLocked
    ? `<div class="sci-card-locked-badge" title="On active research project">\uD83D\uDD2C</div>`
    : '';

  // Undiscovered badge — subtle overlay tag
  const undiscoveredBadge = isUndiscovered
    ? `<div class="sci-card-undiscovered-badge">Undiscovered</div>`
    : '';

  // FIX 4: concept effect label badge (compact, non-intrusive)
  const conceptEffectLabel = (!isUndiscovered && card.type === 'concept' && card.conceptType)
    ? `<div class="concept-effect-label">${CONCEPT_EFFECT_LABELS[card.conceptType] || ''}</div>`
    : '';

  return `
    <div class="sci-card rarity-${card.rarity} ${auraClass} ${lockedClass} ${undiscoveredClass}" data-card-id="${card.id}" data-qty="${quantity}" data-aura-tier="${auraTier}">
      ${!isUndiscovered && quantity > 1 ? `<div class="sci-card-qty">\u00D7${quantity}</div>` : ''}
      ${lockedBadge}
      ${undiscoveredBadge}
      <div class="card-detail-inner">
        <div class="card-detail-header">
          <span class="card-detail-name">${card.name}</span>
          <span class="sci-card-rarity-badge ${card.rarity}">${card.rarity}</span>
        </div>
        ${conceptEffectLabel}
        <div class="card-detail-art">
          ${imageUrl ? `<img src="${imageUrl}" alt="${card.name}">` : `<span style="font-size:2rem;opacity:0.4">${emoji}</span>`}
        </div>
        <div class="card-detail-divider"></div>
        <div class="card-detail-body">
          <div class="card-detail-field">${field}</div>
          ${keyFact ? `<div class="card-detail-keyfact grid-clamp">${keyFact}</div>` : ''}
        </div>
      </div>
      ${auraDots}
    </div>
  `;
}

/**
 * Show the enlarged card detail modal with full card info + aura tier display.
 */
function showCardDetail(cardId, quantity = 1) {
  const card = cards.getCard(cardId);
  if (!card) return;

  // If quantity wasn't passed, look it up from player inventory
  if (quantity <= 1) {
    const session = auth.getSession();
    if (session && session.username !== '__admin__') {
      const inv = player.getInventory(session.username);
      const entry = inv.find(i => i.cardId === cardId);
      if (entry) quantity = entry.quantity;
    }
  }

  const imageUrl = card.imageUrl || card.image || '';
  const keyFact = card.keyFact || card.flavor || '';
  const field = card.field || 'General';
  // Phase 1D: All cards always have a visual aura tier derived from duplicate count
  const visualAura = cards.resolveVisualAura(null); // null = no profile cosmetic override yet
  const auraCssKey = cards.AURA_CSS_MAP[visualAura] || 'prismatic';
  const auraTier = cards.getAuraTier(card.rarity, quantity);
  const emoji = cards.TYPE_EMOJIS[card.type] || '\uD83D\uDD2C';

  // Build aura info section — always shown for all cards
  const nextThresholds = cards.AURA_THRESHOLDS[card.rarity] || [];
  let nextTierInfo = '';
  if (auraTier < 3 && nextThresholds[auraTier]) {
    nextTierInfo = `<span class="text-surface-500 text-[0.6rem]">Next tier at ${nextThresholds[auraTier]}\u00D7</span>`;
  } else if (auraTier >= 3) {
    nextTierInfo = `<span class="text-amber-400/70 text-[0.6rem]">Max tier!</span>`;
  }

  // Color for pips depends on resolved visual aura
  const pipColors = {
    holographic: '#c084fc', prismatic: '#e0e7ff', shadow: '#a855f7',
    radiant: '#fbbf24', cosmic: '#60a5fa'
  };
  const pipColor = pipColors[auraCssKey] || '#94a3b8';

  const auraHTML = `
    <div class="card-detail-aura-info">
      <span>💎 aura</span>
      <div class="card-detail-aura-tier-bar" style="color:${pipColor}">
        ${[1,2,3].map(i => `<span class="pip ${i <= auraTier ? 'filled' : ''}"></span>`).join('')}
      </div>
      ${nextTierInfo}
    </div>
  `;

  // FIX 5: concept effect label + flavor text for concept cards
  const conceptEffectLabelModal = (card.type === 'concept' && card.conceptType && CONCEPT_EFFECT_LABELS[card.conceptType])
    ? `<div class="concept-effect-label concept-effect-label--modal">${CONCEPT_EFFECT_LABELS[card.conceptType]}</div>`
    : '';
  // flavorText: use card-level override if present; fall back to per-conceptType default
  const resolvedFlavorText = (card.type === 'concept')
    ? (card.flavorText || CONCEPT_FLAVOR_TEXT[card.conceptType] || '')
    : '';
  const conceptFlavorText = resolvedFlavorText
    ? `<div class="concept-flavor-text">${resolvedFlavorText}</div>`
    : '';

  const modal = document.getElementById('card-detail-modal');
  document.getElementById('card-detail-content').innerHTML = `
    <div class="card-detail-frame rarity-${card.rarity}">
      <div class="card-detail-inner">
        <div class="card-detail-header">
          <span class="card-detail-name">${card.name}</span>
          <span class="sci-card-rarity-badge ${card.rarity}">${card.rarity}</span>
        </div>
        ${conceptEffectLabelModal}
        <div class="card-detail-art">
          ${imageUrl ? `<img src="${imageUrl}" alt="${card.name}">` : `<span style="font-size:3rem;opacity:0.4">${emoji}</span>`}
        </div>
        <div class="card-detail-divider"></div>
        <div class="card-detail-body">
          <div class="card-detail-field">${field}</div>
          ${keyFact ? `<div class="card-detail-keyfact">${keyFact}</div>` : ''}
          ${auraHTML}
        </div>
      </div>
    </div>
    ${conceptFlavorText}
    <div class="mt-3 text-center text-xs text-surface-500">
      ${quantity > 1 ? `Owned: \u00D7${quantity}` : ''}
    </div>
  `;
  modal.classList.remove('hidden');
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
    return `
      <div class="bg-surface-900 rounded-xl border border-surface-700 p-5 flex flex-col">
        <div class="text-center mb-3">
          <div class="text-4xl mb-2">\uD83C\uDCB4</div>
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

function openPackUI(packId) {
  const session = auth.getSession();
  if (!session) return;

  const result = packs.openPack(session.username, packId);
  if (!result.success) {
    toast.error(result.error);
    return;
  }

  // LB-1: refresh uniqueCardsOwned stat after any pack opening
  refreshUniqueCardsOwned(session.username);

  const packType = packs.getPackType(packId);
  document.getElementById('pack-opening-title').textContent = `${packType?.name || 'Pack'} Opened!`;

  const cardsContainer = document.getElementById('pack-opening-cards');

  // Build all card HTML — each card wrapped in a flip container
  cardsContainer.innerHTML = result.cards.map((card, i) => {
    const imageUrl = card.imageUrl || card.image || '';
    const keyFact = card.keyFact || card.flavor || '';
    const field = card.field || 'General';
    const emoji = cards.TYPE_EMOJIS[card.type] || '\uD83D\uDD2C';
    const needsClick = ['rare', 'epic', 'legendary'].includes(card.rarity);
    const glowClass = needsClick ? `rarity-glow-${card.rarity}` : '';

    return `
      <div class="pack-card-wrapper ${glowClass}" data-rarity="${card.rarity}" data-index="${i}">
        <div class="pack-card-flipper">
          <div class="pack-card-back"></div>
          <div class="pack-card-front">
            <div class="sci-card rarity-${card.rarity}" data-aura-tier="0">
              <div class="card-detail-inner">
                <div class="card-detail-header">
                  <span class="card-detail-name">${card.name}</span>
                  <span class="sci-card-rarity-badge ${card.rarity}">${card.rarity}</span>
                </div>
                <div class="card-detail-art">
                  ${imageUrl ? `<img src="${imageUrl}" alt="${card.name}">` : `<span style="font-size:2rem;opacity:0.4">${emoji}</span>`}
                </div>
                <div class="card-detail-divider"></div>
                <div class="card-detail-body">
                  <div class="card-detail-field">${field}</div>
                  ${keyFact ? `<div class="card-detail-keyfact grid-clamp">${keyFact}</div>` : ''}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Show overlay first
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
        }, 250);
      }
    }, i * 125);

    // Click-to-reveal for rare, epic, legendary
    if (needsClick) {
      const revealHandler = () => {
        if (flipper.classList.contains('flipped')) return;
        flipper.classList.add('flipped');
        wrapper.classList.remove(`rarity-glow-${rarity}`);

        // Spawn particles for epic/legendary
        if (rarity === 'epic' || rarity === 'legendary') {
          spawnRevealParticles(wrapper, rarity);
        }

        wrapper.removeEventListener('click', revealHandler);
      };
      wrapper.addEventListener('click', revealHandler);
    }
  });

  renderPacks();
}

/**
 * Spawn celebratory firework particles around a card element.
 * Epic = ~10 particles, Legendary = ~20 particles + lightning flash.
 */
export function spawnRevealParticles(wrapperEl, rarity) {
  const isLegendary = rarity === 'legendary';
  const count = isLegendary ? 20 : 10;
  const colors = isLegendary
    ? ['#f59e0b', '#fbbf24', '#fcd34d', '#f97316', '#fff7ed']
    : ['#a855f7', '#c084fc', '#d8b4fe', '#7c3aed', '#e9d5ff'];

  // Create a container positioned over the card
  const container = document.createElement('div');
  container.className = 'pack-particles-container';
  wrapperEl.style.position = 'relative';
  wrapperEl.appendChild(container);

  // Legendary-only: brief lightning/energy flash overlay
  if (isLegendary) {
    const flash = document.createElement('div');
    flash.className = 'legendary-reveal-flash';
    container.appendChild(flash);
  }

  const rect = wrapperEl.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;

  for (let i = 0; i < count; i++) {
    const particle = document.createElement('div');
    particle.className = 'pack-particle' + (isLegendary ? ' pack-particle--legendary' : '');
    particle.style.background = colors[i % colors.length];
    particle.style.left = cx + 'px';
    particle.style.top = cy + 'px';

    // Vary particle sizes for visual richness
    const size = isLegendary ? (4 + Math.random() * 6) : (4 + Math.random() * 4);
    particle.style.width = size + 'px';
    particle.style.height = size + 'px';

    // Random direction — wider spread for legendary
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.9;
    const dist = isLegendary ? (50 + Math.random() * 70) : (40 + Math.random() * 55);
    particle.style.setProperty('--px', `${Math.cos(angle) * dist}px`);
    particle.style.setProperty('--py', `${Math.sin(angle) * dist}px`);

    // Slight stagger so particles don't all fire at once
    particle.style.animationDelay = (Math.random() * 0.08) + 's';

    container.appendChild(particle);
  }

  // Clean up after animation (duration + delay headroom)
  setTimeout(() => container.remove(), isLegendary ? 1200 : 1000);
}

// ===================== RESEARCH PROJECTS (delegated to project-ui.js) =====================
// All project-specific rendering, heartbeat, assignment, report, and breakthrough code
// has been extracted to js/project-ui.js (Phase 1 refactor).
// renderResearchProjects, startProjectHeartbeat, stopProjectHeartbeat are imported above.

// ===================== ADMIN =====================

function renderAdmin() {
  if (!auth.isAdmin()) return;
  renderAdminSubTab('overview');
}

function renderAdminSubTab(tab) {
  switch (tab) {
    case 'overview': renderAdminOverview(); break;
    case 'players': _setupPlayerFilters(); renderAdminPlayers(); break;
    case 'cards': renderAdminCards(); break;
    case 'packs-admin': renderAdminPacks(); break;
    case 'groups': renderAdminGroups(); break;
    case 'access': renderAdminAccess(); break;
    case 'config': renderAdminConfig(); break;
    case 'balance': renderAdminBalance(); break;
    case 'shop-admin': renderShopAdminPanel(); break;
    case 'trading-controls': renderAdminTradingControls(); break;
    case 'seasons': renderAdminSeasons(); break;
  }
}

function renderAdminOverview() {
  const allPlayers = player.getAllPlayers();
  const allCards = cards.getAllCards();
  const allPacks = packs.getAllPackTypes();
  const allGroups = groups.getAllGroups();

  document.getElementById('admin-stats-grid').innerHTML = `
    <div class="stat-card"><div class="stat-value text-blue-400">${allPlayers.length}</div><div class="stat-label">Players</div></div>
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

function _setupPlayerFilters() {
  const groupSel = document.getElementById('admin-player-filter-group');
  const subSel = document.getElementById('admin-player-filter-subgroup');
  if (!groupSel || !subSel) return;

  // Populate group dropdown
  const allGroupsList = groups.getAllGroups();
  groupSel.innerHTML = `<option value="">All Groups</option>` +
    allGroupsList.map(g => `<option value="${g.id}">${g.name}</option>`).join('');

  groupSel.onchange = () => {
    const selectedGroupId = groupSel.value;
    if (selectedGroupId) {
      const subs = groups.getSubgroups(selectedGroupId);
      subSel.innerHTML = `<option value="">All Subgroups</option>` +
        subs.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
      subSel.disabled = false;
    } else {
      subSel.innerHTML = '<option value="">All Subgroups</option>';
      subSel.disabled = true;
    }
    renderAdminPlayers();
  };

  subSel.onchange = () => renderAdminPlayers();
}

function renderAdminPlayers() {
  const allPlayers = player.getAllPlayers();
  const searchEl = document.getElementById('admin-player-search');
  const search = (searchEl?.value || '').toLowerCase();
  const filterGroupId = document.getElementById('admin-player-filter-group')?.value || '';
  const filterSubgroupId = document.getElementById('admin-player-filter-subgroup')?.value || '';

  let filtered = allPlayers;
  if (search) {
    filtered = filtered.filter(p => p.value.username.toLowerCase().includes(search));
  }
  if (filterGroupId) {
    filtered = filtered.filter(p => p.value.groupId === filterGroupId);
  }
  if (filterSubgroupId) {
    filtered = filtered.filter(p => p.value.subgroupId === filterSubgroupId);
  }

  const list = document.getElementById('admin-players-list');
  if (filtered.length === 0) {
    list.innerHTML = '<div class="p-4 text-surface-500 text-center">No players found</div>';
    return;
  }

  list.innerHTML = filtered.map(({ key, value: p }) => {
    const inv = Object.keys(p.inventory || {}).length;
    const packCount = Object.values(p.packs || {}).reduce((s, v) => s + v, 0);
    const adminBadge = p.isAdmin === true ? '<span class="ml-2 px-1.5 py-0.5 text-[10px] font-bold bg-yellow-600 text-white rounded uppercase">Admin</span>' : '';
    const tradeBadge = p.isTradeRestricted === true ? '<span class="ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-red-700 text-white rounded uppercase">Trade Locked</span>' : '';
    const groupLabel = groups.getGroupName(p.groupId);
    const subgroupLabel = p.subgroupId ? ` / ${groups.getSubgroupName(p.groupId, p.subgroupId)}` : '';
    return `
      <div class="p-3 flex items-center justify-between hover:bg-surface-800 cursor-pointer player-row" data-username="${p.username}">
        <div>
          <span class="font-medium">${p.username}</span>${adminBadge}${tradeBadge}
          <span class="text-xs text-surface-500 ml-2">${groupLabel}${subgroupLabel}</span>
        </div>
        <div class="flex items-center gap-3 text-xs text-surface-400">
          <span>🃏 ${inv} unique</span>
          <span>📦 ${packCount} packs</span>
          <button class="btn-admin-player-detail bg-surface-700 hover:bg-surface-600 px-2 py-1 rounded text-white" data-username="${p.username}">
            Manage
          </button>
        </div>
      </div>
    `;
  }).join('');

  if (searchEl) searchEl.oninput = () => renderAdminPlayers();

  list.querySelectorAll('.btn-admin-player-detail').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showPlayerDetail(btn.dataset.username);
    });
  });
}

function _formatAdminLabel(value) {
  if (!value || typeof value !== 'string') return 'Unknown';
  return value.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function _renderShopItemOptions(type) {
  return Object.values(ITEM_DEFINITIONS)
    .filter(definition => definition.type === type)
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
      const def = ITEM_DEFINITIONS[itemId];
      return `<div class="flex justify-between"><span>${def?.name || itemId}</span><span>${qty}</span></div>`;
    })
    .join('');
  const cosmeticsOwned = Object.entries(ownedCosmetics)
    .filter(([, owned]) => owned === true)
    .map(([itemId]) => {
      const def = ITEM_DEFINITIONS[itemId];
      return `<div>${def?.name || itemId} <span class="text-surface-500">(${_formatAdminLabel(def?.category)})</span></div>`;
    })
    .join('');
  const shopSnapshot = slots.slice(0, 12).map((slot, index) => {
    const def = ITEM_DEFINITIONS[slot?.itemId];
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
          <div>Banner: ${profile.equippedBanner || 'None'}</div>
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

function showPlayerDetail(username) {
  const p = player.getPlayer(username);
  if (!p) return;

  document.getElementById('player-detail-name').textContent = username;

  const allCardsList = cards.sortCardsByRarityAndName([...cards.getAllCards()]);
  const allPackTypes = packs.getAllPackTypes();
  const allGroupsList = groups.getAllGroups();
  const inv = player.getInventory(username);

  const content = document.getElementById('player-detail-content');
  content.innerHTML = `
    <div class="space-y-4">
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
            <div class="flex gap-2">
              <select id="pd-cosmetic-select" class="admin-input flex-1">
                ${_renderShopItemOptions(ITEM_TYPES.COSMETIC)}
              </select>
              <button id="pd-give-cosmetic" class="bg-green-600 hover:bg-green-500 px-3 py-1 rounded text-sm">Unlock</button>
            </div>
            <p class="text-xs text-surface-500 mt-1">Unlocks ownership only; equipped profile state is not changed.</p>
          </div>
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
        <div class="flex gap-2">
          <input id="pd-new-password" type="password" placeholder="New password (min 4 chars)" class="admin-input flex-1" autocomplete="new-password">
          <button id="pd-reset-password" class="bg-orange-600 hover:bg-orange-500 px-3 py-1 rounded text-sm whitespace-nowrap">Reset</button>
        </div>
        <p id="pd-reset-password-msg" class="text-xs mt-1 hidden"></p>
      </div>

      <!-- Danger Zone -->
      <div class="bg-surface-800 rounded-lg p-4 border border-red-900/50">
        <h4 class="font-semibold text-sm mb-2 text-red-400">Danger Zone</h4>
        <button id="pd-delete-player" class="bg-red-600 hover:bg-red-500 px-4 py-2 rounded text-sm font-medium">
          Delete Player
        </button>
      </div>

      ${_renderAdminRuntimeSnapshot(p)}

      <!-- Inventory -->
      <div class="bg-surface-800 rounded-lg p-4">
        <h4 class="font-semibold text-sm mb-2">Inventory (${inv.length} unique cards)</h4>
        <div class="max-h-48 overflow-y-auto space-y-1">
          ${inv.length === 0 ? '<div class="text-surface-500 text-xs">Empty</div>' :
            inv.map(({ cardId, quantity }) => {
              const c = cards.getCard(cardId);
              if (!c) return '';
              return `
                <div class="flex items-center justify-between text-xs py-1">
                  <span><span style="color:${cards.RARITY_COLORS[c.rarity]}">●</span> ${c.name} ×${quantity}</span>
                  <button class="pd-remove-card text-red-400 hover:text-red-300 px-1" data-card-id="${cardId}">✕</button>
                </div>
              `;
            }).join('')}
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
  content.querySelector('#pd-set-group').addEventListener('click', () => {
    const grpId = content.querySelector('#pd-group-select').value || null;
    const subId = content.querySelector('#pd-subgroup-select').value || null;
    player.setPlayerGroup(username, grpId, subId);
    toast.success(`Group assignment updated for ${username}`);
    renderAdminPlayers();
    showPlayerDetail(username);
  });

  content.querySelector('#pd-give-card').addEventListener('click', () => {
    const cardId = content.querySelector('#pd-card-select').value;
    const qty = parseInt(content.querySelector('#pd-card-qty').value) || 1;
    player.addCard(username, cardId, qty);
    toast.success(`Gave ${qty} card(s) to ${username}`);
    showPlayerDetail(username);
  });

  content.querySelector('#pd-give-pack').addEventListener('click', () => {
    const packId = content.querySelector('#pd-pack-select').value;
    const qty = parseInt(content.querySelector('#pd-pack-qty').value) || 1;
    player.addPack(username, packId, qty);
    toast.success(`Gave ${qty} pack(s) to ${username}`);
    showPlayerDetail(username);
  });

  content.querySelector('#pd-give-rp')?.addEventListener('click', () => {
    const amount = parseInt(content.querySelector('#pd-rp-amount')?.value, 10) || 0;
    const result = adminGrantResearchPoints(username, amount);
    if (!result.success) {
      toast.error('Could not grant RP');
      return;
    }
    toast.success(`Gave ${result.amount} RP to ${username}`);
    showPlayerDetail(username);
  });

  content.querySelector('#pd-give-consumable')?.addEventListener('click', () => {
    const itemId = content.querySelector('#pd-consumable-select')?.value;
    const qty = parseInt(content.querySelector('#pd-consumable-qty')?.value, 10) || 1;
    const result = adminGrantShopItem(username, itemId, qty);
    if (!result.success) {
      toast.error('Could not grant consumable');
      return;
    }
    toast.success(`Granted ${qty} item(s) to ${username}`);
    showPlayerDetail(username);
  });

  content.querySelector('#pd-give-cosmetic')?.addEventListener('click', () => {
    const itemId = content.querySelector('#pd-cosmetic-select')?.value;
    const result = adminGrantShopItem(username, itemId, 1);
    if (!result.success) {
      toast.error('Could not unlock cosmetic');
      return;
    }
    toast.success(`Cosmetic unlocked for ${username}`);
    showPlayerDetail(username);
  });

  // Delete player — DESTRUCTIVE (requires confirmation)
  content.querySelector('#pd-delete-player').addEventListener('click', async () => {
    const confirmed = await confirmAction(
      `This will permanently delete "${username}" and all their data. This cannot be undone.`,
      `Delete player "${username}"?`
    );
    if (!confirmed) return;
    db.remove(`players/${username}`);
    toast.info(`Player "${username}" deleted`);
    document.getElementById('player-detail-modal').classList.add('hidden');
    renderAdminPlayers();
  });

  // Remove card from inventory — DESTRUCTIVE (requires confirmation)
  content.querySelectorAll('.pd-remove-card').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cardId = btn.dataset.cardId;
      const c = cards.getCard(cardId);
      const cardName = c ? c.name : cardId;
      const confirmed = await confirmAction(
        `Remove "${cardName}" from ${username}'s inventory?`,
        'Remove inventory item?'
      );
      if (!confirmed) return;
      player.removeCard(username, cardId);
      toast.info(`Removed card from ${username}`);
      showPlayerDetail(username);
    });
  });

  // Promote to Admin — requires confirmation
  const promoteBtn = content.querySelector('#pd-promote-admin');
  if (promoteBtn) {
    promoteBtn.addEventListener('click', async () => {
      const confirmed = await confirmAction(
        `Grant admin access to "${username}"? They will have full admin panel access.`,
        'Promote to admin?'
      );
      if (!confirmed) return;
      db.update(`players/${username}`, { isAdmin: true });
      toast.success(`${username} promoted to admin`);
      showPlayerDetail(username);
      renderAdminPlayers();
    });
  }

  // Remove Admin — requires confirmation (blocked for self)
  const removeAdminBtn = content.querySelector('#pd-remove-admin');
  if (removeAdminBtn) {
    removeAdminBtn.addEventListener('click', async () => {
      const confirmed = await confirmAction(
        `Remove admin access from "${username}"? They will lose all admin panel access.`,
        'Remove admin access?'
      );
      if (!confirmed) return;
      db.update(`players/${username}`, { isAdmin: false });
      toast.success(`Admin access removed from ${username}`);
      showPlayerDetail(username);
      renderAdminPlayers();
    });
  }

  // Toggle Trade Restriction — requires confirmation
  const toggleTradeBtn = content.querySelector('#pd-toggle-trade');
  if (toggleTradeBtn) {
    toggleTradeBtn.addEventListener('click', async () => {
      const currentPlayer = player.getPlayer(username);
      const isRestricted = currentPlayer && currentPlayer.isTradeRestricted === true;
      const action = isRestricted ? 'Remove' : 'Enable';
      const confirmed = await confirmAction(
        `${action} trade restriction for "${username}"?${!isRestricted ? ' They will not be able to trade.' : ' They will be able to trade again.'}`,
        `${action} trade restriction?`
      );
      if (!confirmed) return;
      db.update(`players/${username}`, { isTradeRestricted: !isRestricted });
      toast.success(`Trade restriction ${isRestricted ? 'removed from' : 'enabled for'} ${username}`);
      showPlayerDetail(username);
      renderAdminPlayers();
    });
  }

  // Reset Password — admin sets a new password (existing password never shown)
  const resetPwBtn = content.querySelector('#pd-reset-password');
  const resetPwInput = content.querySelector('#pd-new-password');
  const resetPwMsg = content.querySelector('#pd-reset-password-msg');
  if (resetPwBtn && resetPwInput) {
    resetPwBtn.addEventListener('click', async () => {
      const newPw = resetPwInput.value;
      if (!newPw || newPw.trim().length < 4) {
        resetPwMsg.textContent = 'Password must be at least 4 characters.';
        resetPwMsg.className = 'text-xs mt-1 text-red-400';
        resetPwMsg.classList.remove('hidden');
        return;
      }
      const confirmed = await confirmAction(
        `Reset the password for "${username}"? They will need to use the new password on next login.`,
        'Reset player password?'
      );
      if (!confirmed) return;
      const result = await resetPlayerPassword(username, newPw);
      if (result.success) {
        resetPwInput.value = '';
        resetPwMsg.textContent = 'Password reset successfully.';
        resetPwMsg.className = 'text-xs mt-1 text-green-400';
        resetPwMsg.classList.remove('hidden');
        toast.success(`Password reset for ${username}`);
      } else {
        resetPwMsg.textContent = result.error || 'Reset failed.';
        resetPwMsg.className = 'text-xs mt-1 text-red-400';
        resetPwMsg.classList.remove('hidden');
      }
    });
  }

  document.getElementById('player-detail-modal').classList.remove('hidden');
}

// ===================== ADMIN CARDS =====================

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

  // Delete card — DESTRUCTIVE (requires confirmation)
  list.querySelectorAll('.btn-delete-card').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cardId = btn.dataset.cardId;
      const c = cards.getCard(cardId);
      const cardName = c ? c.name : cardId;
      const confirmed = await confirmAction(
        `This will permanently delete the card "${cardName}" from the database. Players who own it will keep copies in inventory.`,
        `Delete card "${cardName}"?`
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

  // Show image preview if URL exists
  updateImagePreview('edit-card-imageUrl', 'edit-card-image-preview', 'edit-card-preview-img');

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
    updateImagePreview('edit-card-imageUrl', 'edit-card-image-preview', 'edit-card-preview-img');
  });

  // Live image preview in create form
  document.getElementById('new-card-imageUrl')?.addEventListener('input', () => {
    updateImagePreview('new-card-imageUrl', 'new-card-image-preview', 'new-card-preview-img');
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
    toast.success(`Card "${name}" updated`);
    document.getElementById('edit-card-modal').classList.add('hidden');
    renderAdminCards();
  });
}

/**
 * Update an image preview element based on a URL input.
 */
function updateImagePreview(inputId, previewContainerId, previewImgId) {
  const url = document.getElementById(inputId)?.value?.trim() || '';
  const container = document.getElementById(previewContainerId);
  const img = document.getElementById(previewImgId);
  if (!container || !img) return;

  if (url) {
    img.src = url;
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
  document.getElementById('btn-create-group').onclick = () => {
    const name = document.getElementById('new-group-name').value.trim();
    if (!name) { toast.error('Group name required'); return; }
    groups.createGroup(name);
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
    groups.deleteGroup(groupId);
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

function renderAdminAccess() {
  const codesData = db.getChildren('accessCodes');
  const list = document.getElementById('admin-access-list');

  refreshAccessCodeGroupDropdown();

  if (codesData.length === 0) {
    list.innerHTML = '<div class="p-4 text-surface-500 text-center">No access codes generated yet.</div>';
    return;
  }

  const sorted = [...codesData].sort((a, b) => (b.value.created || 0) - (a.value.created || 0));

  list.innerHTML = sorted.map(({ key, value }) => `
    <div class="p-2 px-4 flex items-center justify-between text-sm ${value.used ? 'opacity-50' : ''}">
      <div class="font-mono font-bold">${key}</div>
      <div class="flex items-center gap-3 text-xs">
        ${value.group ? `<span class="text-surface-400">${groups.getGroupName(value.group)}</span>` : ''}
        ${value.used ? `<span class="text-red-400">Used by ${value.usedBy}</span>` : '<span class="text-green-400">Available</span>'}
      </div>
    </div>
  `).join('');

  // Generate codes
  document.getElementById('btn-gen-codes').onclick = () => {
    const count = parseInt(document.getElementById('access-code-count').value) || 10;
    const group = document.getElementById('access-code-group').value || null;
    auth.generateAccessCodes(count, group);
    toast.success(`${count} access codes generated`);
    renderAdminAccess();
  };

  // Copy unused codes
  document.getElementById('btn-copy-codes').onclick = () => {
    const unused = codesData.filter(c => !c.value.used).map(c => c.key);
    if (unused.length === 0) { toast.info('No unused codes'); return; }
    navigator.clipboard.writeText(unused.join('\n')).then(() => {
      toast.success(`${unused.length} codes copied!`);
    }).catch(() => toast.error('Copy failed'));
  };
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
  document.getElementById('btn-close-card-detail')?.addEventListener('click', () => {
    document.getElementById('card-detail-modal').classList.add('hidden');
  });
  document.getElementById('btn-close-player-detail')?.addEventListener('click', () => {
    document.getElementById('player-detail-modal').classList.add('hidden');
  });

  // Edit Card modal wiring
  setupEditCardModal();

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
