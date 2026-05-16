/**
 * Project UI Module — Research Projects subsystem rendering
 *
 * Extracted from ui.js (Phase 1 refactor).
 * Owns: project list, assignment panel, report panel, heartbeat lifecycle,
 *       project telemetry, breakthrough reveal flow, project-specific state/timers.
 *
 * Exports: renderResearchProjects, startProjectHeartbeat, stopProjectHeartbeat
 */

import * as auth from './auth.js';
import * as player from './player.js';
import * as cards from './cards.js';
import * as packs from './packs.js';
import * as toast from './toast.js';
import * as db from './database.js';
import { getLockedCardIds, PROJECT_STATES } from './project-state.js';
import { activateProject } from './project-assignment.js';
import { evaluateProject } from './project-engine.js';
import { claimProjectRewards } from './project-claiming.js';
import { addSeasonalResearchPoints, refreshUniqueCardsOwned } from './research.js';
import { getProjectConfig } from './project-config.js';
import {
  addWeeklyPackRP,
  claimWeeklyPack,
  checkAndResetWeeklyCycle,
  getWeeklyRPProgress,
  getWeeklyRPRequired,
  hasClaimedWeeklyPack,
  getWeeklyRefreshLabel,
  getWeeklyRewardPackId,
} from './weekly-research-pack.js';
import { getProjectRefreshHours, getProjectRefreshIntervalMs, getMaxStoredProjects } from './project-refresh.js';
import { syncProjects } from './project-sync.js';

// These are imported from ui.js — kept there per extraction spec
import { spawnRevealParticles, confirmAction } from './ui.js';

// ===================== ADMIN TELEMETRY HELPER =====================

/**
 * Returns true if the current session is a persistent admin player account
 * (NOT the standalone __admin__ emergency session).
 * Duplicated locally per extraction spec to avoid over-engineering shared utils.
 */
function _isPersistentAdmin() {
  const s = auth.getSession();
  return s && s.isAdmin === true && s.username !== '__admin__';
}

// ===================== PROJECT-SPECIFIC LOCAL STATE =====================

let _projectHeartbeatId = null;
const PROJECT_HEARTBEAT_INTERVAL_MS = 20_000; // 20 seconds

let _assigningProjectId = null;
let _viewingReportProjectId = null;
let _refreshTimerInterval = null;

// ===================== RESEARCH PROJECT HEARTBEAT =====================

export function startProjectHeartbeat() {
  if (_projectHeartbeatId !== null) return; // already running
  _projectHeartbeatId = setInterval(() => {
    const session = auth.getSession();
    if (!session || !session.username || session.username === '__admin__') {
      stopProjectHeartbeat();
      return;
    }
    // Only run while the research-projects tab is the visible tab
    const tab = document.getElementById('tab-research-projects');
    if (!tab || !tab.classList.contains('active')) {
      stopProjectHeartbeat();
      return;
    }
    // Run the sync pipeline to transition project states, then re-render
    const p = player.getPlayer(session.username);
    if (!p) return;
    const syncResult = syncProjects({
      projects:      p.projects      ?? [],
      totalRP:       p.totalResearchPoints ?? 0,
      lastRefreshAt: p.lastProjectRefreshAt ?? 0,
      now:           Date.now(),
    });
    // Only write + re-render if something actually changed
    if (syncResult.generatedCount > 0 || syncResult.resolvedCount > 0 || syncResult.prunedCount > 0) {
      db.update(`players/${session.username}`, {
        projects:             syncResult.projects,
        lastProjectRefreshAt: syncResult.refreshAt,
      });
      // Do not interrupt the player while they are in an interactive sub-mode
      // (assigning scientists/cards or viewing a completed-project report).
      if (_assigningProjectId !== null || _viewingReportProjectId !== null) {
        return;
      }
      renderResearchProjects();
    }
  }, PROJECT_HEARTBEAT_INTERVAL_MS);
}

export function stopProjectHeartbeat() {
  if (_projectHeartbeatId !== null) {
    clearInterval(_projectHeartbeatId);
    _projectHeartbeatId = null;
  }
}

// ===================== BREAKTHROUGH CARD HELPERS =====================

/**
 * Generate one breakthrough card using the same pack pipeline (rollRarity + pickCardOfRarity).
 * Adds the card to the player's inventory immediately.
 * Returns the card object, or null if no cards are in the DB.
 *
 * Uses the Standard Pack odds as the default breakthrough rarity distribution.
 * This is intentionally the same pipeline as packs — no separate inventory path.
 *
 * @param {string} username
 * @returns {object|null}
 */
function _generateBreakthroughCard(username) {
  const allCards = cards.getAllCards().filter(c => c.enabled !== false);
  if (allCards.length === 0) {
    console.warn('[ResearchProjects] Breakthrough card: no enabled cards in DB');
    return null;
  }

  // Load breakthrough card rarity weights from config (admin-configurable, independent of pack odds)
  const cfg = getProjectConfig();
  const odds = Object.assign(
    { common: 50, uncommon: 25, rare: 15, epic: 8, legendary: 2 },
    cfg.breakthroughCardRarityWeights ?? {}
  );

  // Roll rarity
  const total = Object.values(odds).reduce((s, v) => s + v, 0);
  let roll = Math.random() * total;
  const rarityOrder = ['legendary', 'epic', 'rare', 'uncommon', 'common'];
  let rarity = 'common';
  for (const r of rarityOrder) {
    const weight = odds[r] || 0;
    if (roll < weight) { rarity = r; break; }
    roll -= weight;
  }

  // Pick a card of that rarity (fallback to any card)
  const matching = allCards.filter(c => c.rarity === rarity);
  const pool = matching.length > 0 ? matching : allCards;
  const card = pool[Math.floor(Math.random() * pool.length)];

  if (!card?.id) return null;

  // Add to inventory via the same path as pack openings
  player.addCard(username, card.id, 1);
  refreshUniqueCardsOwned(username);

  console.log(`[ResearchProjects] Breakthrough card granted: ${card.name} (${card.rarity})`);
  return card;
}

/**
 * Show a single-card breakthrough reveal overlay.
 * Reuses the existing pack-opening overlay, styles, and flip animations.
 * Feels like opening a 1-card mini-pack.
 *
 * @param {object} card - The card object to reveal.
 */
function showBreakthroughCardReveal(card) {
  const overlay = document.getElementById('pack-opening-overlay');
  if (!overlay) return;

  // Update title
  const titleEl = document.getElementById('pack-opening-title');
  if (titleEl) titleEl.textContent = '⭐ Breakthrough Card!';

  const cardsContainer = document.getElementById('pack-opening-cards');
  if (!cardsContainer) return;

  const imageUrl  = card.imageUrl || card.image || '';
  const keyFact   = card.keyFact  || card.flavor || '';
  const field     = card.field    || 'General';
  const emoji     = cards.TYPE_EMOJIS[card.type] || '🔬';
  const needsClick = ['rare', 'epic', 'legendary'].includes(card.rarity);
  const glowClass  = needsClick ? `rarity-glow-${card.rarity}` : '';

  cardsContainer.innerHTML = `
    <div class="pack-card-wrapper ${glowClass}" data-rarity="${card.rarity}" data-index="0">
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

  overlay.classList.remove('hidden');

  const wrapper = cardsContainer.querySelector('.pack-card-wrapper');
  const flipper  = wrapper?.querySelector('.pack-card-flipper');
  if (!wrapper || !flipper) return;

  setTimeout(() => {
    wrapper.classList.add('phase-in');

    if (!needsClick) {
      // common/uncommon — auto-flip
      setTimeout(() => flipper.classList.add('flipped'), 250);
    } else {
      // rare/epic/legendary — click to reveal
      const revealHandler = () => {
        if (flipper.classList.contains('flipped')) return;
        flipper.classList.add('flipped');
        wrapper.classList.remove(`rarity-glow-${card.rarity}`);
        if (card.rarity === 'epic' || card.rarity === 'legendary') {
          spawnRevealParticles(wrapper, card.rarity);
        }
        wrapper.removeEventListener('click', revealHandler);
      };
      wrapper.addEventListener('click', revealHandler);
    }
  }, 80);
}

// ===================== PROJECT STATUS BAR =====================

/**
 * Renders a compact status bar above the project list showing:
 *   - Projects: X / 7 Active (AVAILABLE + ACTIVE only)
 *   - Next refresh: Xh Xm
 *   - (Admin only) Refresh interval: Xh
 */
function _renderProjectStatusBar(container, projects, playerData, session) {
  // Clean up previous timer
  if (_refreshTimerInterval) {
    clearInterval(_refreshTimerInterval);
    _refreshTimerInterval = null;
  }

  let bar = container.querySelector('.rp-status-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'rp-status-bar';
    // Insert before the project list or empty state
    const list = container.querySelector('#research-projects-list');
    const empty = container.querySelector('#research-projects-empty');
    const insertBefore = list || empty;
    if (insertBefore) {
      insertBefore.parentNode.insertBefore(bar, insertBefore);
    } else {
      container.appendChild(bar);
    }
  }

  const capCount = projects.filter(p =>
    p.state === PROJECT_STATES.AVAILABLE || p.state === PROJECT_STATES.ACTIVE
  ).length;
  const maxProjects = getMaxStoredProjects();

  const lastRefreshAt = playerData?.lastProjectRefreshAt ?? 0;
  const refreshMs = getProjectRefreshIntervalMs();
  const isAdmin = _isPersistentAdmin() || (session && session.username === '__admin__');
  const username = session?.username;

  function formatTimeRemaining() {
    const now = Date.now();
    const nextRefreshAt = lastRefreshAt + refreshMs;
    const remaining = nextRefreshAt - now;
    if (remaining <= 0) return 'now';
    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const mins = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  function buildWeeklyPackWidget() {
    if (!username || username === '__admin__') return '';

    const weeklyPackId = getWeeklyRewardPackId();
    if (!weeklyPackId) return ''; // Not configured yet — hide widget entirely

    const progress  = getWeeklyRPProgress(username);
    const required  = getWeeklyRPRequired(username);
    const claimed   = hasClaimedWeeklyPack(username);
    const refreshLbl = getWeeklyRefreshLabel();

    // Look up the pack name from pack definitions
    const allPacks  = packs.getAllPackTypes();
    const packDef   = allPacks.find(p => p.id === weeklyPackId);
    const packName  = packDef?.name ?? weeklyPackId;

    const pct = Math.min(100, required > 0 ? Math.round((progress / required) * 100) : 0);

    const claimable = !claimed && progress >= required;

    const claimBtn = claimable
      ? `<button id="btn-claim-weekly-pack" class="rp-weekly-claim-btn rp-weekly-claim-btn--ready">Claim Pack</button>`
      : claimed
        ? `<button class="rp-weekly-claim-btn rp-weekly-claim-btn--claimed" disabled>Claimed ✓</button>`
        : `<button class="rp-weekly-claim-btn rp-weekly-claim-btn--locked" disabled>${progress} / ${required} RP</button>`;

    return `
      <div class="rp-weekly-widget">
        <div class="rp-weekly-header">
          <span class="rp-weekly-title">Weekly Reward Pack</span>
          <span class="rp-weekly-pack-name">${packName}</span>
        </div>
        <div class="rp-weekly-progress-row">
          <div class="rp-weekly-progress-bar-wrap">
            <div class="rp-weekly-progress-bar" style="width:${pct}%"></div>
          </div>
          <span class="rp-weekly-progress-label">${claimed ? 'Complete' : `${progress} / ${required} RP`}</span>
        </div>
        <div class="rp-weekly-footer">
          <span class="rp-weekly-refresh-label">Refreshes ${refreshLbl}</span>
          ${claimBtn}
        </div>
      </div>
    `;
  }

  function render() {
    const adminExtra = isAdmin
      ? `<span class="rp-status-admin">Refresh interval: ${getProjectRefreshHours()}h</span>`
      : '';
    bar.innerHTML = `
      <span class="rp-status-item">Projects: <strong>${capCount}</strong> / ${maxProjects} Active</span>
      <span class="rp-status-sep">·</span>
      <span class="rp-status-item">Next refresh: <strong id="rp-refresh-timer">${formatTimeRemaining()}</strong></span>
      ${adminExtra}
      ${buildWeeklyPackWidget()}
    `;

    // Wire claim button after innerHTML rebuild
    const claimBtn = bar.querySelector('#btn-claim-weekly-pack');
    if (claimBtn) {
      claimBtn.addEventListener('click', () => {
        const result = claimWeeklyPack(username);
        if (result.success) {
          toast.success('Weekly reward pack claimed! Check your inventory.');
          renderResearchProjects(); // re-render so widget updates to "Claimed ✓"
        } else {
          toast.error(result.error ?? 'Could not claim pack.');
        }
      });
    }
  }

  render();

  // Live-update the timer every 30 seconds while the tab is open
  _refreshTimerInterval = setInterval(() => {
    const timerEl = document.getElementById('rp-refresh-timer');
    if (!timerEl) {
      clearInterval(_refreshTimerInterval);
      _refreshTimerInterval = null;
      return;
    }
    timerEl.textContent = formatTimeRemaining();
  }, 30000);
}

// ===================== RESEARCH PROJECTS (main render) =====================

export function renderResearchProjects() {
  const session = auth.getSession();
  const container = document.getElementById('tab-research-projects');
  const list = document.getElementById('research-projects-list');
  const empty = document.getElementById('research-projects-empty');

  if (!session || session.username === '__admin__' || !list || !empty) return;

  // If we're in assignment mode, render assignment panel instead of list
  if (_assigningProjectId !== null) {
    const p = player.getPlayer(session.username);
    const project = (p?.projects ?? []).find(pr => pr.id === _assigningProjectId);
    if (project && project.state === PROJECT_STATES.AVAILABLE) {
      list.classList.add('hidden');
      empty.classList.add('hidden');
      document.getElementById('rp-cards-panel')?.classList.add('hidden');
      renderProjectAssignmentPanel(container, project, p, session.username);
      return;
    }
    // Project no longer available — fall back to list view
    _assigningProjectId = null;
  }

  // If we're in report mode, render the report panel instead of list
  if (_viewingReportProjectId !== null) {
    const p = player.getPlayer(session.username);
    const project = (p?.projects ?? []).find(pr => pr.id === _viewingReportProjectId);
    if (project && (project.state === PROJECT_STATES.COMPLETE || project.state === PROJECT_STATES.CLAIMED)) {
      list.classList.add('hidden');
      empty.classList.add('hidden');
      document.getElementById('rp-cards-panel')?.classList.add('hidden');
      renderProjectReportPanel(container, project, session.username);
      return;
    }
    // Project no longer in reportable state — fall back
    _viewingReportProjectId = null;
  }

  // Remove any stale panels; restore cards panel visibility
  container.querySelector('.rp-assign-panel')?.remove();
  container.querySelector('.rp-report-panel')?.remove();
  document.getElementById('rp-cards-panel')?.classList.remove('hidden');
  list.classList.remove('hidden');

  const p = player.getPlayer(session.username);
  const projects = p?.projects ?? [];

  // ── Compact status telemetry ─────────────────────────────────────────────
  _renderProjectStatusBar(container, projects, p, session);

  if (projects.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  // Sort: ACTIVE first, then COMPLETE, AVAILABLE, CLAIMED
  const stateOrder = {
    [PROJECT_STATES.ACTIVE]:    0,
    [PROJECT_STATES.COMPLETE]:  1,
    [PROJECT_STATES.AVAILABLE]: 2,
    [PROJECT_STATES.CLAIMED]:   3,
  };
  const sorted = [...projects].sort((a, b) =>
    (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9)
  );

  list.innerHTML = sorted.map(proj => renderProjectCard(proj)).join('');

  // Wire "Start Project" buttons for AVAILABLE projects
  list.querySelectorAll('.rp-btn-start').forEach(btn => {
    btn.addEventListener('click', () => {
      _assigningProjectId = btn.dataset.projectId;
      renderResearchProjects();
    });
  });

  // Wire "View Report" buttons for COMPLETE projects
  list.querySelectorAll('.rp-btn-report').forEach(btn => {
    btn.addEventListener('click', () => {
      _viewingReportProjectId = btn.dataset.projectId;
      renderResearchProjects();
    });
  });

  // Render right-side Available Cards panel
  _renderCardsAvailabilityPanel(projects, session.username);
}

// ===================== CARDS AVAILABILITY PANEL =====================

/**
 * Render the informational "Available Cards" panel on the right side of the
 * projects tab. Shows all owned cards grouped as scientists / concepts with
 * locked state reflected visually for cards assigned to active projects.
 */
function _renderCardsAvailabilityPanel(projects, username) {
  const panelBody = document.getElementById('rp-cards-panel-body');
  if (!panelBody) return;

  // Build locked set from active projects
  const lockedIds = new Set(getLockedCardIds(projects));

  // Build owned card lists from inventory
  const inventory = player.getInventory(username);
  const scientistCards = [];
  const conceptCards   = [];

  for (const { cardId, quantity } of inventory) {
    const card = cards.getCard(cardId);
    if (!card || card.enabled === false) continue;
    // Phase 1D: All cards always have an aura tier derived from duplicate count
    const auraTier = cards.getAuraTier(card.rarity, quantity);
    const enriched = { ...card, id: card.id ?? cardId, auraLevel: auraTier };
    if (card.type === 'scientist')    scientistCards.push(enriched);
    else if (card.type === 'concept') conceptCards.push(enriched);
  }

  // Sort both lists: legendary first, then alphabetical by name
  cards.sortCardsByRarityAndName(scientistCards);
  cards.sortCardsByRarityAndName(conceptCards);

  // Build a mini card element (read-only — no click handlers)
  function buildInfoMiniCard(card) {
    const isLocked = lockedIds.has(card.id);
    const el = document.createElement('div');
    el.className = `rp-mini-card rarity-${card.rarity}${isLocked ? ' rp-mini-card--unavailable' : ''}`;
    el.title = isLocked ? `${card.name} — assigned to active project` : card.name;

    const imageUrl = card.imageUrl || card.image || '';
    const emoji    = cards.TYPE_EMOJIS[card.type] || '🔬';
    const imgHTML  = imageUrl
      ? `<img class="rp-mini-img" src="${imageUrl}" alt="${card.name}" loading="lazy">`
      : `<div class="rp-mini-emoji">${emoji}</div>`;

    const roleLabel = (card.type === 'concept' && card.conceptType)
      ? `<div class="rp-mini-concept-role">${cards.CONCEPT_EFFECT_LABELS[card.conceptType] || ''}</div>`
      : '';

    el.innerHTML = `
      ${imgHTML}
      <div class="rp-mini-name">${card.name}</div>
      <div class="rp-mini-rarity rarity-${card.rarity}">${card.rarity}</div>
      ${roleLabel}
    `;
    return el;
  }

  // Build section HTML
  function buildSection(label, cardList) {
    const section = document.createElement('div');
    section.className = 'rp-cp-section';

    const heading = document.createElement('div');
    heading.className = 'rp-cp-section-label';
    heading.textContent = label;
    section.appendChild(heading);

    if (cardList.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rp-cp-empty';
      empty.textContent = 'None';
      section.appendChild(empty);
      return section;
    }

    const grid = document.createElement('div');
    grid.className = 'rp-cp-grid';
    for (const card of cardList) {
      grid.appendChild(buildInfoMiniCard(card));
    }
    section.appendChild(grid);
    return section;
  }

  // Count locked for header badge
  const totalLocked = [...scientistCards, ...conceptCards].filter(c => lockedIds.has(c.id)).length;
  const totalOwned  = scientistCards.length + conceptCards.length;

  panelBody.innerHTML = '';

  // Status line
  if (totalOwned > 0) {
    const statusLine = document.createElement('div');
    statusLine.className = 'rp-cp-status';
    statusLine.innerHTML = totalLocked > 0
      ? `<span class="rp-cp-available">${totalOwned - totalLocked} available</span> · <span class="rp-cp-locked">${totalLocked} in use</span>`
      : `<span class="rp-cp-available">${totalOwned} available</span>`;
    panelBody.appendChild(statusLine);
  }

  panelBody.appendChild(buildSection('Scientists', scientistCards));
  panelBody.appendChild(buildSection('Concepts', conceptCards));
}

// ===================== PROJECT CARD =====================

/**
 * Build HTML for a single research project card.
 * AVAILABLE projects show a "Start Project" button.
 * All other states are read-only.
 */
function renderProjectCard(project) {
  const { id, state, rarity, title, durationHours, projectedSuccessLabel, completesAt, outcome } = project;
  const now = Date.now();

  const rarityColors = {
    common:    '#4b5563',
    uncommon:  '#22c55e',
    rare:      '#3b82f6',
    epic:      '#a855f7',
    legendary: '#f59e0b',
  };
  const accentColor = rarityColors[rarity] || '#64748b';

  const stateBadges = {
    [PROJECT_STATES.AVAILABLE]: { label: 'Available', cls: 'rp-badge--available' },
    [PROJECT_STATES.ACTIVE]:    { label: 'Active',    cls: 'rp-badge--active'    },
    [PROJECT_STATES.COMPLETE]:  { label: 'Complete',  cls: 'rp-badge--complete'  },
    [PROJECT_STATES.CLAIMED]:   { label: 'Claimed',   cls: 'rp-badge--claimed'   },
  };
  const badge = stateBadges[state] || { label: state, cls: '' };

  // Status line
  let statusLine = '';
  if (state === PROJECT_STATES.ACTIVE && completesAt != null) {
    if (now >= completesAt) {
      statusLine = `<div class="rp-timer rp-timer--done">⏱ Ready to resolve</div>`;
    } else {
      const remaining = completesAt - now;
      const totalHours = Math.floor(remaining / 3_600_000);
      const mins = Math.floor((remaining % 3_600_000) / 60_000);
      const timeText = totalHours > 0 ? `${totalHours}h ${mins}m remaining` : `${mins}m remaining`;
      statusLine = `<div class="rp-timer">${timeText}</div>`;
    }
  } else if (state === PROJECT_STATES.COMPLETE) {
    const outcomeText = outcome === 'success' ? '✅ Success' : outcome === 'failure' ? '❌ Failure' : '—';
    statusLine = `<div class="rp-timer rp-timer--done">${outcomeText}</div>`;
  } else if (state === PROJECT_STATES.CLAIMED) {
    statusLine = `<div class="rp-timer rp-timer--claimed">Claimed</div>`;
  }

  // Admin telemetry: append raw percentage to the flavor label
  let displaySuccessLabel = projectedSuccessLabel || '';
  if (_isPersistentAdmin() && projectedSuccessLabel && project.projectedSuccessChance != null) {
    const pct = Math.round(project.projectedSuccessChance * 100);
    displaySuccessLabel = `${projectedSuccessLabel} (${pct}%)`;
  }

  const successLabel = (state === PROJECT_STATES.ACTIVE && displaySuccessLabel)
    ? `<div class="rp-success-label">Projected: <span>${displaySuccessLabel}</span></div>`
    : '';

  const durationText = durationHours != null ? `${durationHours}h` : '—';

  // "Start Project" button only for AVAILABLE
  const startBtn = state === PROJECT_STATES.AVAILABLE
    ? `<button class="rp-btn-start" data-project-id="${id}">▶ Start Project</button>`
    : '';

  // "View Report" button only for COMPLETE
  const reportBtn = state === PROJECT_STATES.COMPLETE
    ? `<button class="rp-btn-report" data-project-id="${id}">📋 View Report</button>`
    : '';

  return `
    <div class="rp-card" style="border-left-color: ${accentColor}">
      <div class="rp-card-header">
        <div class="rp-card-title">${title || 'Unnamed Project'}</div>
        <div class="rp-badge ${badge.cls}">${badge.label}</div>
      </div>
      <div class="rp-card-meta">
        <span class="rp-rarity" style="color:${accentColor}">${rarity}</span>
        <span class="rp-duration">⏳ ${durationText}</span>
      </div>
      ${successLabel}
      ${statusLine}
      ${startBtn}
      ${reportBtn}
    </div>
  `;
}

// ===================== REPORT PANEL =====================

/**
 * Render the project report panel for a COMPLETE or CLAIMED project.
 * COMPLETE projects show a "Claim Rewards" button.
 * CLAIMED projects are read-only and visually subdued.
 */
function renderProjectReportPanel(container, project, username) {
  // Remove any pre-existing report panel
  container.querySelector('.rp-report-panel')?.remove();

  const isClaimed  = project.state === PROJECT_STATES.CLAIMED;
  const outcome    = project.outcome  ?? {};
  const rewards    = project.rewards  ?? {};
  const rewardList = rewards.rewards  ?? [];

  const success      = outcome.success      === true;
  const breakthrough = outcome.breakthrough === true;

  const rarityColors = {
    common: '#4b5563', uncommon: '#22c55e', rare: '#3b82f6',
    epic: '#a855f7',   legendary: '#f59e0b',
  };
  const accentColor = rarityColors[project.rarity] || '#64748b';

  // Build reward rows from stored backend data only
  function buildRewardRows(list) {
    if (!Array.isArray(list) || list.length === 0) return '<div class="rp-report-reward-row">No rewards.</div>';
    return list.map(r => {
      if (r.type === 'rp') {
        return `<div class="rp-report-reward-row rp-reward-rp">+${r.amount ?? 0} Research Points</div>`;
      }
      if (r.type === 'card') {
        const cardObj = r.card;
        const cardName = cardObj?.name ?? cardObj?.id ?? null;
        if (cardName) {
          return `<div class="rp-report-reward-row rp-reward-card">🃏 ${cardName}</div>`;
        }
        // card not yet generated (null) — show as a bonus card to be revealed on claim
        return `<div class="rp-report-reward-row rp-reward-card">🃏 Bonus Card — claim to reveal!</div>`;
      }
      return `<div class="rp-report-reward-row">${r.type ?? 'Unknown reward'}</div>`;
    }).join('');
  }

  // Assigned card name helpers — IDs only stored on project; look up names gracefully
  function cardNamesFromIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return '<span class="rp-report-card-name">None</span>';
    return ids.map(id => {
      if (!id) return '<span class="rp-report-card-name">—</span>';
      const card = cards.getCard(id);
      const name = card?.name ?? id;
      return `<span class="rp-report-card-name">${name}</span>`;
    }).join('');
  }

  const outcomeLabel = success ? '✅ Success' : '❌ Failure';
  const breakthroughHTML = breakthrough
    ? `<div class="rp-report-breakthrough">⭐ Breakthrough!</div>`
    : '';

  const claimBtn = (!isClaimed)
    ? `<button class="rp-btn-claim" id="rp-btn-claim">🏆 Claim Rewards</button>`
    : '';

  const claimedNote = isClaimed
    ? `<div class="rp-report-claimed-note">Rewards already claimed.</div>`
    : '';

  const panel = document.createElement('div');
  panel.className = `rp-report-panel${isClaimed ? ' rp-report-panel--claimed' : ''}`;

  panel.innerHTML = `
    <!-- Back nav -->
    <div class="rp-assign-back">
      <button class="rp-assign-back-btn" id="rp-report-btn-back">← Back to Projects</button>
      <span class="text-xs text-surface-500">${isClaimed ? 'Claimed — read only' : 'Project complete — claim your rewards'}</span>
    </div>

    <!-- Report card -->
    <div class="rp-report-card" style="border-left: 4px solid ${accentColor}">
      <div class="rp-report-title">${project.title || 'Unnamed Project'}</div>
      <div class="rp-report-rarity" style="color:${accentColor}">${project.rarity}</div>

      <!-- Outcome -->
      <div class="rp-report-section-label">Outcome</div>
      <div class="rp-report-outcome ${success ? 'rp-outcome--success' : 'rp-outcome--failure'}">${outcomeLabel}</div>
      ${breakthroughHTML}

      <!-- Rewards -->
      <div class="rp-report-section-label">Rewards Earned</div>
      <div class="rp-report-rewards">
        ${success ? buildRewardRows(rewardList) : '<div class="rp-report-reward-row">No rewards — project failed.</div>'}
      </div>

      <!-- Assigned Scientists -->
      <div class="rp-report-section-label">Assigned Scientists</div>
      <div class="rp-report-cards">${cardNamesFromIds(project.assignedScientists)}</div>

      <!-- Assigned Concepts -->
      <div class="rp-report-section-label">Assigned Concepts</div>
      <div class="rp-report-cards">${cardNamesFromIds(project.assignedConcepts)}</div>

      <!-- Claim / claimed note -->
      <div class="rp-report-actions">
        ${claimBtn}
        ${claimedNote}
      </div>
    </div>
  `;

  container.appendChild(panel);

  // Back button
  panel.querySelector('#rp-report-btn-back').addEventListener('click', () => {
    _viewingReportProjectId = null;
    panel.remove();
    const list = document.getElementById('research-projects-list');
    if (list) list.classList.remove('hidden');
    renderResearchProjects();
  });

  // Claim button (only present for COMPLETE)
  const claimBtnEl = panel.querySelector('#rp-btn-claim');
  if (claimBtnEl) {
    claimBtnEl.addEventListener('click', () => {
      // Re-read fresh player state
      const freshPlayer  = player.getPlayer(username);
      const allProjects  = freshPlayer?.projects ?? [];
      const freshProject = allProjects.find(pr => pr.id === project.id);

      if (!freshProject) {
        toast.error('Project not found.');
        return;
      }

      const result = claimProjectRewards({ project: freshProject });

      if (!result.claimed) {
        toast.error(`Could not claim rewards: ${result.reason ?? 'unknown error'}`);
        return;
      }

      // Replace only the updated project in player.projects
      const updatedProjects = allProjects.map(pr =>
        pr.id === result.project.id ? result.project : pr
      );

      // Build player stat updates
      const playerUpdates = { projects: updatedProjects };

      // Add RP only on success
      if (result.rewards?.success === true) {
        console.log('[DEBUG CLAIM] result.rewards =', result.rewards);
        const rpEarned = result.rewards.rpEarned ?? 0;
        console.log('[DEBUG CLAIM] rpEarned =', rpEarned);
        if (rpEarned > 0) {
          const currentRP = typeof freshPlayer.totalResearchPoints === 'number' ? freshPlayer.totalResearchPoints : 0;
          playerUpdates.totalResearchPoints = currentRP + rpEarned;
          // LB-1: also write to seasonalResearchPoints (additive, separate from lifetime)
          addSeasonalResearchPoints(username, rpEarned);
          // Weekly pack tracking — additive only, never touches lifetime/seasonal RP
          checkAndResetWeeklyCycle(username);
          addWeeklyPackRP(username, rpEarned);
        }
        // Increment projectsCompleted
        playerUpdates.projectsCompleted =
          (freshPlayer.projectsCompleted || 0) + 1;

        // Increment breakthroughs if this was a breakthrough
        if (result.rewards?.breakthrough === true) {
          const currentBreakthroughs = freshPlayer?.researchStats?.breakthroughs ?? 0;
          playerUpdates.researchStats = {
            ...(freshPlayer.researchStats ?? {}),
            breakthroughs: currentBreakthroughs + 1,
          };
        }
      }

      console.log('[DEBUG CLAIM] playerUpdates =', playerUpdates);
      player.updatePlayer(username, playerUpdates);
      console.log('[DEBUG CLAIM] fresh DB player =', player.getPlayer(username));

      // Handle card rewards using existing inventory system
      // Breakthrough card: card is null at resolution time — generate it now at claim.
      const rewardItems = result.rewards?.rewards ?? [];
      let breakthroughCardGranted = null;
      for (const r of rewardItems) {
        if (r.type === 'card') {
          if (r.card != null) {
            // Already a real card object (future-proof path)
            const cardId = r.card.id ?? r.card.cardId ?? null;
            if (cardId) {
              player.addCard(username, cardId, 1);
              refreshUniqueCardsOwned(username);
              breakthroughCardGranted = r.card;
            }
          } else {
            // Null card = breakthrough card — generate one now using pack pipeline
            const granted = _generateBreakthroughCard(username);
            if (granted) {
              breakthroughCardGranted = granted;
            }
          }
        }
      }

      console.log('[ResearchProjects] Rewards claimed');
      toast.success(`Rewards claimed for "${result.project.title}"!`);

      // Transition to CLAIMED view (read-only)
      _viewingReportProjectId = result.project.id;
      panel.remove();
      renderResearchProjects();

      // Show single-card reveal if a breakthrough card was granted.
      // Deferred one frame so renderResearchProjects() fully paints before
      // the overlay appears — avoids a race where the overlay title/cards
      // get wiped by a synchronous DOM rebuild.
      if (breakthroughCardGranted) {
        const _capturedCard = breakthroughCardGranted;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            showBreakthroughCardReveal(_capturedCard);
          });
        });
      }
    });
  }
}

// ===================== ASSIGNMENT PANEL =====================

/**
 * Render the project assignment panel into the tab container.
 * Replaces the project list. Handles selection state internally via DOM.
 */
function renderProjectAssignmentPanel(container, project, playerData, username) {
  // Remove any pre-existing panel
  container.querySelector('.rp-assign-panel')?.remove();

  // --- Derive locked card IDs from existing ACTIVE projects ---
  const lockedIds = new Set(getLockedCardIds(playerData.projects ?? []));

  // --- Build inventory card lists, typed ---
  const inventory = player.getInventory(username);
  const scientistCards = [];
  const conceptCards   = [];

  for (const { cardId, quantity } of inventory) {
    const card = cards.getCard(cardId);
    if (!card || card.enabled === false) continue;
    // Phase 1D: All cards always have an aura tier derived from duplicate count
    const auraTier = cards.getAuraTier(card.rarity, quantity);
    const enriched = { ...card, id: card.id ?? cardId, auraLevel: auraTier };
    if (card.type === 'scientist') scientistCards.push(enriched);
    else if (card.type === 'concept')   conceptCards.push(enriched);
  }

  // Sort both card lists: rarity first (legendary→common), then alphabetical by name
  cards.sortCardsByRarityAndName(scientistCards);
  // Concepts: rarity first, then conceptType alphabetically as tiebreaker
  const rarityRankForSort = cards.RARITY_ORDER;
  conceptCards.sort((a, b) => {
    const ra = rarityRankForSort[a.rarity] ?? 5;
    const rb = rarityRankForSort[b.rarity] ?? 5;
    if (ra !== rb) return ra - rb;
    return (a.conceptType ?? '').localeCompare(b.conceptType ?? '');
  });

  // Selection state (mutable, panel-local)
  let selectedScientists = []; // card objects
  let selectedConcepts   = []; // card objects

  // --- Build panel DOM ---
  const panel = document.createElement('div');
  panel.className = 'rp-assign-panel';

  const rarityColors = {
    common: '#4b5563', uncommon: '#22c55e', rare: '#3b82f6',
    epic: '#a855f7',   legendary: '#f59e0b',
  };
  const accentColor = rarityColors[project.rarity] || '#64748b';

  panel.innerHTML = `
    <!-- Back nav -->
    <div class="rp-assign-back">
      <button class="rp-assign-back-btn" id="rp-btn-back">← Back to Projects</button>
      <span class="text-xs text-surface-500">Assign cards to start this project</span>
    </div>

    <!-- Two-column layout -->
    <div class="rp-assign-layout">

      <!-- LEFT: Project details + preview + submit -->
      <div class="rp-assign-details" style="border-left: 4px solid ${accentColor}">
        <div class="rp-assign-title">${project.title || 'Unnamed Project'}</div>

        <div class="rp-assign-stat">
          Rarity <span style="color:${accentColor}">${project.rarity}</span>
        </div>
        <div class="rp-assign-stat">
          Difficulty <span>${project.difficulty ?? '—'}</span>
        </div>
        <div class="rp-assign-stat">
          Duration <span>${project.durationHours != null ? project.durationHours + 'h' : '—'}</span>
        </div>
        <div class="rp-assign-stat">
          Base Reward <span>${project.successRP ?? '—'} RP</span>
        </div>

        <!-- Live preview box -->
        <div class="rp-preview-box" id="rp-preview-box">
          <div class="rp-preview-label">Projected Outcome</div>
          <div class="rp-preview-chance" id="rp-preview-chance">— select cards —</div>
          <div class="rp-preview-rp" id="rp-preview-rp">Projected RP: <span>—</span></div>
        </div>

        ${_isPersistentAdmin() ? `
        <!-- Admin telemetry (persistent admin only) -->
        <div class="rp-admin-telemetry" id="rp-admin-telemetry">
          <div class="rp-telemetry-label">🔧 Dev Telemetry</div>
          <div class="rp-telemetry-row"><span>Team Power</span><span id="rp-tel-power">—</span></div>
          <div class="rp-telemetry-row"><span>Eff. Difficulty</span><span id="rp-tel-diff">—</span></div>
          <div class="rp-telemetry-row"><span>Success %</span><span id="rp-tel-chance">—</span></div>
          <div class="rp-telemetry-row"><span>Breakthrough</span><span id="rp-tel-bt">—</span></div>
          <div class="rp-telemetry-row"><span>Reward RP</span><span id="rp-tel-rp">—</span></div>
          <div class="rp-telemetry-row"><span>Concepts Applied</span><span id="rp-tel-concepts">—</span></div>
        </div>
        ` : ''}

        <!-- Validation error -->
        <div class="rp-assign-error" id="rp-assign-error"></div>

        <!-- Submit -->
        <button class="rp-btn-activate" id="rp-btn-activate" disabled>
          Start Project
        </button>
      </div>

      <!-- RIGHT: Card picker -->
      <div class="rp-assign-picker">

        <!-- Scientist slots -->
        <div>
          <div class="rp-picker-section-label">Scientists — <span id="sci-count">0</span>/5 selected</div>
          <div class="rp-slots" id="rp-sci-slots">
            ${[0,1,2,3,4].map(i => `<div class="rp-slot" id="rp-sci-slot-${i}">empty</div>`).join('')}
          </div>
        </div>

        <!-- Concept slots -->
        <div>
          <div class="rp-picker-section-label">Concepts — <span id="con-count">0</span>/2 selected</div>
          <div class="rp-slots" id="rp-con-slots">
            ${[0,1].map(i => `<div class="rp-slot" id="rp-con-slot-${i}">empty</div>`).join('')}
          </div>
        </div>

        <!-- Scientist card grid -->
        <div>
          <div class="rp-picker-section-label">Your Scientist Cards</div>
          <!-- Rarity filter for scientists -->
          <div class="rp-filter-row" id="rp-sci-filters">
            <button class="rp-filter-btn rp-filter-btn--active" data-rarity="all">All</button>
            <button class="rp-filter-btn" data-rarity="common">Common</button>
            <button class="rp-filter-btn" data-rarity="uncommon">Uncommon</button>
            <button class="rp-filter-btn" data-rarity="rare">Rare</button>
            <button class="rp-filter-btn" data-rarity="epic">Epic</button>
            <button class="rp-filter-btn" data-rarity="legendary">Legendary</button>
          </div>
          <div class="rp-pick-grid" id="rp-sci-grid"></div>
        </div>

        <!-- Concept card grid -->
        <div>
          <div class="rp-picker-section-label">Your Concept Cards</div>
          <!-- Rarity + concept-type filters for concepts -->
          <div class="rp-filter-row" id="rp-con-rarity-filters">
            <button class="rp-filter-btn rp-filter-btn--active" data-rarity="all">All</button>
            <button class="rp-filter-btn" data-rarity="common">Common</button>
            <button class="rp-filter-btn" data-rarity="uncommon">Uncommon</button>
            <button class="rp-filter-btn" data-rarity="rare">Rare</button>
            <button class="rp-filter-btn" data-rarity="epic">Epic</button>
            <button class="rp-filter-btn" data-rarity="legendary">Legendary</button>
          </div>
          <div class="rp-filter-row" id="rp-con-type-filters">
            <button class="rp-filter-btn rp-filter-btn--active" data-ctype="all">All</button>
            <button class="rp-filter-btn" data-ctype="difficultyReduction">Complexity Reducer</button>
            <button class="rp-filter-btn" data-ctype="synergyBoost">Synergy Booster</button>
            <button class="rp-filter-btn" data-ctype="researchBoost">Research Amplifier</button>
            <button class="rp-filter-btn" data-ctype="risk">Risk Enhancer</button>
            <button class="rp-filter-btn" data-ctype="breakthrough">Breakthrough</button>
          </div>
          <div class="rp-pick-grid" id="rp-con-grid"></div>
        </div>

      </div>
    </div>
  `;

  container.appendChild(panel);

  // --- Helper: render a mini card element ---
  function buildMiniCard(card, isLocked) {
    const el = document.createElement('div');
    el.className = `rp-mini-card rarity-${card.rarity}${isLocked ? ' locked-card' : ''}`;
    el.dataset.cardId = card.id;

    const imageUrl = card.imageUrl || card.image || '';
    const emoji    = cards.TYPE_EMOJIS[card.type] || '🔬';
    const imgHTML  = imageUrl
      ? `<img class="rp-mini-img" src="${imageUrl}" alt="${card.name}" loading="lazy">`
      : `<div class="rp-mini-emoji">${emoji}</div>`;

    // Surface concept effect role label on concept mini cards
    const roleLabel = (card.type === 'concept' && card.conceptType)
      ? `<div class="rp-mini-concept-role">${cards.CONCEPT_EFFECT_LABELS[card.conceptType] || ''}</div>`
      : '';

    el.innerHTML = `
      ${imgHTML}
      <div class="rp-mini-name">${card.name}</div>
      <div class="rp-mini-rarity rarity-${card.rarity}">${card.rarity}</div>
      ${roleLabel}
    `;
    return el;
  }

  // --- Helper: update the preview and button state ---
  function updatePreview() {
    const previewChance = panel.querySelector('#rp-preview-chance');
    const previewRP     = panel.querySelector('#rp-preview-rp span');
    const activateBtn   = panel.querySelector('#rp-btn-activate');
    const sciCountEl    = panel.querySelector('#sci-count');
    const conCountEl    = panel.querySelector('#con-count');

    sciCountEl.textContent = selectedScientists.length;
    conCountEl.textContent = selectedConcepts.length;

    // Update slot pills
    for (let i = 0; i < 5; i++) {
      const slot = panel.querySelector(`#rp-sci-slot-${i}`);
      if (!slot) continue;
      if (selectedScientists[i]) {
        slot.textContent = selectedScientists[i].name;
        slot.className = 'rp-slot filled';
        slot.dataset.cardId = selectedScientists[i].id;
      } else {
        slot.textContent = 'empty';
        slot.className = 'rp-slot';
        delete slot.dataset.cardId;
      }
    }
    for (let i = 0; i < 2; i++) {
      const slot = panel.querySelector(`#rp-con-slot-${i}`);
      if (!slot) continue;
      if (selectedConcepts[i]) {
        slot.textContent = selectedConcepts[i].name;
        slot.className = 'rp-slot filled';
        slot.dataset.cardId = selectedConcepts[i].id;
      } else {
        slot.textContent = 'empty';
        slot.className = 'rp-slot';
        delete slot.dataset.cardId;
      }
    }

    // Build set of conceptTypes already assigned
    const usedConceptTypes = new Set(selectedConcepts.map(c => c.conceptType).filter(Boolean));

    // Update selected highlights and duplicate-concept unavailability
    panel.querySelectorAll('.rp-mini-card').forEach(el => {
      const id = el.dataset.cardId;
      const isSel = selectedScientists.some(c => c.id === id)
                 || selectedConcepts.some(c => c.id === id);
      el.classList.toggle('selected', isSel);

      // Duplicate concept restriction: if this concept card's conceptType is already
      // used by a DIFFERENT selected card, mark it unavailable for this project
      if (!isSel && el.closest('#rp-con-grid')) {
        const matchCard = conceptCards.find(c => c.id === id);
        if (matchCard && matchCard.conceptType && usedConceptTypes.has(matchCard.conceptType)) {
          el.classList.add('duplicate-concept');
          el.title = `A "${cards.CONCEPT_EFFECT_LABELS[matchCard.conceptType] || matchCard.conceptType}" is already assigned`;
        } else {
          el.classList.remove('duplicate-concept');
          el.title = '';
        }
      }
    });

    // Call evaluateProject when we have any cards selected
    if (selectedScientists.length === 0 && selectedConcepts.length === 0) {
      previewChance.textContent = '— select cards —';
      previewRP.textContent = '—';
      activateBtn.disabled = true;
      return;
    }

    const evaluation = evaluateProject({
      scientists:         selectedScientists,
      concepts:           selectedConcepts,
      difficulty:         project.difficulty ?? 0,
      rewardRP:           project.successRP  ?? 0,
      breakthroughChance: project.breakthroughChance ?? 0,
    });

    // Admin telemetry: append percentage to success label
    if (_isPersistentAdmin()) {
      const pct = Math.round(evaluation.successChance * 100);
      previewChance.textContent = `${evaluation.successLabel} (${pct}%)`;
    } else {
      previewChance.textContent = evaluation.successLabel;
    }
    previewRP.textContent = `${Math.round(evaluation.rewardRP)} RP`;

    // Populate admin telemetry panel (if present)
    if (_isPersistentAdmin()) {
      const telPower    = panel.querySelector('#rp-tel-power');
      const telDiff     = panel.querySelector('#rp-tel-diff');
      const telChance   = panel.querySelector('#rp-tel-chance');
      const telBt       = panel.querySelector('#rp-tel-bt');
      const telRP       = panel.querySelector('#rp-tel-rp');
      const telConcepts = panel.querySelector('#rp-tel-concepts');
      if (telPower) telPower.textContent       = evaluation.teamPower?.totalPower?.toFixed(1) ?? '—';
      if (telDiff)  telDiff.textContent        = evaluation.difficulty?.toFixed(1) ?? '—';
      if (telChance) telChance.textContent     = `${(evaluation.successChance * 100).toFixed(1)}%`;
      if (telBt)    telBt.textContent          = `${(evaluation.breakthroughChance * 100).toFixed(1)}%`;
      if (telRP)    telRP.textContent          = `${Math.round(evaluation.rewardRP)} RP`;
      if (telConcepts) telConcepts.textContent = `${evaluation.conceptsApplied?.length ?? 0}`;
    }

    // Enable button only when selection is complete
    const ready = selectedScientists.length === 5 && selectedConcepts.length === 2;
    activateBtn.disabled = !ready;

    // Clear error on any change
    const errEl = panel.querySelector('#rp-assign-error');
    errEl.textContent = '';
    errEl.classList.remove('visible');
  }

  // --- Filter state ---
  let sciRarityFilter = 'all';
  let conRarityFilter = 'all';
  let conTypeFilter   = 'all';

  // --- Helper: apply filter visibility to a grid of mini-card elements ---
  // Selected cards are ALWAYS shown regardless of filter.
  function applyFilterVisibility(gridEl, allCardEls, selectedArr, rarityFilter, ctypeFilter) {
    allCardEls.forEach(({ el, card }) => {
      const isSelected = selectedArr.some(c => c.id === card.id);
      const rarityMatch = rarityFilter === 'all' || card.rarity === rarityFilter;
      const ctypeMatch  = ctypeFilter  === undefined || ctypeFilter === 'all'
        || card.conceptType === ctypeFilter;
      el.style.display = (isSelected || (rarityMatch && ctypeMatch)) ? '' : 'none';
    });
  }

  function applyFilterBtn(container, activeBtn) {
    container.querySelectorAll('.rp-filter-btn').forEach(b =>
      b.classList.toggle('rp-filter-btn--active', b === activeBtn)
    );
  }

  // --- Wire scientist grid ---
  const sciGrid = panel.querySelector('#rp-sci-grid');
  const sciCardEls = [];
  if (scientistCards.length === 0) {
    sciGrid.innerHTML = '<div class="text-xs text-surface-500 col-span-full py-2">No scientist cards.</div>';
  }
  for (const card of scientistCards) {
    const isLocked = lockedIds.has(card.id);
    const el = buildMiniCard(card, isLocked);
    sciCardEls.push({ el, card });
    if (!isLocked) {
      el.addEventListener('click', () => {
        const idx = selectedScientists.findIndex(c => c.id === card.id);
        if (idx !== -1) {
          // Deselect
          selectedScientists.splice(idx, 1);
        } else if (selectedScientists.length < 5) {
          selectedScientists.push(card);
        }
        applyFilterVisibility(sciGrid, sciCardEls, selectedScientists, sciRarityFilter, undefined);
        updatePreview();
      });
    }
    sciGrid.appendChild(el);
  }

  // Wire scientist rarity filter
  const sciFiltRow = panel.querySelector('#rp-sci-filters');
  sciFiltRow?.querySelectorAll('.rp-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sciRarityFilter = btn.dataset.rarity ?? 'all';
      applyFilterBtn(sciFiltRow, btn);
      applyFilterVisibility(sciGrid, sciCardEls, selectedScientists, sciRarityFilter, undefined);
    });
  });

  // --- Wire concept grid ---
  const conGrid = panel.querySelector('#rp-con-grid');
  const conCardEls = [];
  if (conceptCards.length === 0) {
    conGrid.innerHTML = '<div class="text-xs text-surface-500 col-span-full py-2">No concept cards.</div>';
  }
  for (const card of conceptCards) {
    const isLocked = lockedIds.has(card.id);
    const el = buildMiniCard(card, isLocked);
    conCardEls.push({ el, card });
    if (!isLocked) {
      el.addEventListener('click', () => {
        // Ignore clicks on cards blocked by duplicate-concept restriction
        if (el.classList.contains('duplicate-concept')) return;
        const idx = selectedConcepts.findIndex(c => c.id === card.id);
        if (idx !== -1) {
          selectedConcepts.splice(idx, 1);
        } else if (selectedConcepts.length < 2) {
          selectedConcepts.push(card);
        }
        applyFilterVisibility(conGrid, conCardEls, selectedConcepts, conRarityFilter, conTypeFilter);
        updatePreview();
      });
    }
    conGrid.appendChild(el);
  }

  // Wire concept rarity filter
  const conRarityFiltRow = panel.querySelector('#rp-con-rarity-filters');
  conRarityFiltRow?.querySelectorAll('.rp-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      conRarityFilter = btn.dataset.rarity ?? 'all';
      applyFilterBtn(conRarityFiltRow, btn);
      applyFilterVisibility(conGrid, conCardEls, selectedConcepts, conRarityFilter, conTypeFilter);
    });
  });

  // Wire concept type filter
  const conTypeFiltRow = panel.querySelector('#rp-con-type-filters');
  conTypeFiltRow?.querySelectorAll('.rp-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      conTypeFilter = btn.dataset.ctype ?? 'all';
      applyFilterBtn(conTypeFiltRow, btn);
      applyFilterVisibility(conGrid, conCardEls, selectedConcepts, conRarityFilter, conTypeFilter);
    });
  });

  // --- Slot click = deselect (re-apply filters after deselect so hidden card becomes visible again) ---
  panel.querySelectorAll('#rp-sci-slots .rp-slot').forEach((slot, i) => {
    slot.addEventListener('click', () => {
      if (selectedScientists[i]) {
        selectedScientists.splice(i, 1);
        applyFilterVisibility(sciGrid, sciCardEls, selectedScientists, sciRarityFilter, undefined);
        updatePreview();
      }
    });
  });
  panel.querySelectorAll('#rp-con-slots .rp-slot').forEach((slot, i) => {
    slot.addEventListener('click', () => {
      if (selectedConcepts[i]) {
        selectedConcepts.splice(i, 1);
        applyFilterVisibility(conGrid, conCardEls, selectedConcepts, conRarityFilter, conTypeFilter);
        updatePreview();
      }
    });
  });

  // --- Back button ---
  panel.querySelector('#rp-btn-back').addEventListener('click', () => {
    _assigningProjectId = null;
    panel.remove();
    const list = document.getElementById('research-projects-list');
    if (list) list.classList.remove('hidden');
    renderResearchProjects();
  });

  // --- Submit / Activate ---
  panel.querySelector('#rp-btn-activate').addEventListener('click', () => {
    const errEl = panel.querySelector('#rp-assign-error');

    // Re-read fresh player state for activation
    const freshPlayer = player.getPlayer(username);
    const allProjects = freshPlayer?.projects ?? [];
    const freshProject = allProjects.find(pr => pr.id === project.id);

    if (!freshProject) {
      errEl.textContent = 'Project no longer available.';
      errEl.classList.add('visible');
      return;
    }

    const result = activateProject({
      project:        freshProject,
      scientistCards: selectedScientists,
      conceptCards:   selectedConcepts,
      allProjects,
      startedAt:      Date.now(),
    });

    if (!result.success) {
      // Translate backend reason to human-readable message
      const reasons = {
        invalid_project_state:  'This project is no longer available to start.',
        invalid_scientist_count:'5 scientist cards required.',
        invalid_concept_count:  '2 concept cards required.',
        locked_cards_present:   'One or more selected cards are already assigned to an active project.',
      };
      errEl.textContent = reasons[result.reason] ?? result.reason;
      errEl.classList.add('visible');
      return;
    }

    // Replace ONLY the updated project in player.projects
    const updatedProjects = allProjects.map(pr =>
      pr.id === result.project.id ? result.project : pr
    );
    player.updatePlayer(username, { projects: updatedProjects });

    toast.success(`"${result.project.title}" is now Active!`);

    // Return to list
    _assigningProjectId = null;
    panel.remove();
    const list = document.getElementById('research-projects-list');
    if (list) list.classList.remove('hidden');
    renderResearchProjects();
  });

  // Initial preview render
  updatePreview();
}
