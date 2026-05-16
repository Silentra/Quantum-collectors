/**
 * leaderboard-ui.js
 * Phase LB-2 + LB-5 — Leaderboard tab UI.
 *
 * Renders group-scoped leaderboards for:
 *   - Overall RP (lifetime)
 *   - Seasonal RP (active + archived seasons)
 *   - Projects Completed
 *   - Packs Opened
 *   - Unique Cards Owned
 *   - Trades Completed
 *   - Breakthroughs
 *
 * LB-5 adds: snapshot history selector for non-seasonal categories.
 * NEVER writes to DB. Read-only rendering on top of LB-1 query helpers.
 */

import * as auth from './auth.js';
import * as player from './player.js';
import * as groups from './groups.js';
import {
  STAT_TYPES,
  getLeaderboardByStat,
  getSeasonLeaderboard,
  getSeasonSummaries,
  getVisibleArchivedSeasons,
  getSnapshotLeaderboard,
  getVisibleSnapshots,
  getSnapshotMeta,
} from './leaderboard-queries.js';
import { getActiveSeason } from './leaderboard-seasons.js';

// ─── Category config ───────────────────────────────────────────────────────

const CATEGORIES = [
  { id: 'overall-rp',    label: '🏆 Overall RP',       statType: STAT_TYPES.LIFETIME_RP,        seasonal: false },
  { id: 'seasonal-rp',   label: '🌸 Seasonal RP',       statType: STAT_TYPES.SEASONAL_RP,        seasonal: true  },
  { id: 'projects',      label: '🔬 Projects',           statType: STAT_TYPES.PROJECTS_COMPLETED, seasonal: false },
  { id: 'breakthroughs', label: '💥 Breakthroughs',     statType: STAT_TYPES.BREAKTHROUGHS,      seasonal: false },
  { id: 'trades',        label: '🤝 Trades',             statType: STAT_TYPES.TRADES_COMPLETED,   seasonal: false },
  { id: 'packs',         label: '🎴 Packs Opened',       statType: STAT_TYPES.PACKS_OPENED,       seasonal: false },
  { id: 'unique-cards',  label: '🃏 Unique Cards',       statType: STAT_TYPES.UNIQUE_CARDS_OWNED, seasonal: false },
];

// ─── Module state ──────────────────────────────────────────────────────────

let _activeCategory = 'overall-rp';
let _activeSeasonId   = null; // null = live/current season for seasonal-rp
let _activeSnapshotId = null; // null = live/current data for non-seasonal cats

// ─── Public init ──────────────────────────────────────────────────────────

/**
 * Called once by ui.js during init() to wire up the static event listeners.
 */
export function initLeaderboardUI() {
  // Category button clicks — delegated from the container
  const container = document.getElementById('lb-category-tabs');
  if (container) {
    container.addEventListener('click', e => {
      const btn = e.target.closest('[data-lb-cat]');
      if (!btn || btn.disabled) return;
      _activeCategory   = btn.dataset.lbCat;
      _activeSeasonId   = null; // reset to current season when switching
      _activeSnapshotId = null; // reset to live data when switching
      renderLeaderboard();
    });
  }

  // Season selector (seasonal-rp only)
  const seasonSelect = document.getElementById('lb-season-select');
  if (seasonSelect) {
    seasonSelect.addEventListener('change', () => {
      _activeSeasonId = seasonSelect.value || null;
      renderLeaderboard();
    });
  }

  // Snapshot selector (non-seasonal categories — LB-5)
  const snapSelect = document.getElementById('lb-snapshot-select');
  if (snapSelect) {
    snapSelect.addEventListener('change', () => {
      _activeSnapshotId = snapSelect.value || null;
      renderLeaderboard();
    });
  }
}

// ─── Main render entry ─────────────────────────────────────────────────────

/**
 * Render the full leaderboard tab.
 * Called by ui.js whenever the Leaderboard tab becomes active.
 */
export function renderLeaderboard() {
  const session = auth.getSession();
  if (!session || session.username === '__admin__') {
    _renderMessage('Sign in as a player to view leaderboards.');
    return;
  }

  const p = player.getPlayer(session.username);
  const groupId = p?.groupId ?? null;

  _renderCategoryTabs();
  _renderSeasonSelector(groupId);
  _renderSnapshotSelector(groupId);
  _renderTable(session.username, groupId);
}

// ─── Category tabs ─────────────────────────────────────────────────────────

function _renderCategoryTabs() {
  const container = document.getElementById('lb-category-tabs');
  if (!container) return;

  container.innerHTML = CATEGORIES.map(cat => {
    const isActive   = cat.id === _activeCategory;
    const isDisabled = !!cat.disabled;
    const activeClass = isActive
      ? 'bg-primary-600 border-primary-500 text-white'
      : 'bg-surface-800 border-surface-600 text-surface-300 hover:bg-surface-700';
    const disabledAttr = isDisabled ? 'disabled title="Coming soon"' : '';
    return `<button
      class="lb-cat-btn px-3 py-1.5 rounded-lg border text-sm font-medium transition whitespace-nowrap ${activeClass} ${isDisabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}"
      data-lb-cat="${cat.id}"
      ${disabledAttr}
    >${cat.label}${isDisabled ? ' 🔒' : ''}</button>`;
  }).join('');
}

// ─── Season selector ───────────────────────────────────────────────────────

function _renderSeasonSelector(groupId) {
  const wrapper = document.getElementById('lb-season-wrapper');
  const select  = document.getElementById('lb-season-select');
  if (!wrapper || !select) return;

  const isSeasonalCat = _activeCategory === 'seasonal-rp';
  wrapper.classList.toggle('hidden', !isSeasonalCat);

  if (!isSeasonalCat) return;

  const activeSeason = getActiveSeason();

  // Phase LB-4: only show archives the player is permitted to see
  // (hidden archives and out-of-group archives are excluded)
  const visibleArchived = getVisibleArchivedSeasons(groupId).reverse(); // newest first

  // Build options: current season first, then permitted archived seasons
  const options = [];

  if (activeSeason) {
    options.push(`<option value="">${_escHtml(activeSeason.name)} (Current)</option>`);
  } else {
    options.push(`<option value="">No active season</option>`);
  }

  if (visibleArchived.length > 0) {
    options.push('<option disabled>── Archived ──</option>');
    visibleArchived.forEach(s => {
      const date = s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : '';
      options.push(`<option value="${_escHtml(s.id)}">${_escHtml(s.name)}${date ? ' (' + date + ')' : ''}</option>`);
    });
  }

  select.innerHTML = options.join('');

  // If the previously selected season is no longer visible, reset to current
  const validIds = new Set(visibleArchived.map(s => s.id));
  if (_activeSeasonId && !validIds.has(_activeSeasonId)) {
    _activeSeasonId = null;
  }
  select.value = _activeSeasonId || '';
}

// ─── Snapshot selector (LB-5 — non-seasonal categories) ────────────────────

/**
 * Show/populate the snapshot history dropdown for non-seasonal categories.
 * Hidden when no snapshots exist or when seasonal-rp is active.
 */
function _renderSnapshotSelector(groupId) {
  const wrapper  = document.getElementById('lb-snapshot-wrapper');
  const select   = document.getElementById('lb-snapshot-select');
  if (!wrapper || !select) return;

  const cat = CATEGORIES.find(c => c.id === _activeCategory);
  // Only show for non-seasonal, non-disabled categories
  const showForCat = cat && !cat.seasonal && !cat.disabled && cat.statType;
  if (!showForCat) {
    wrapper.classList.add('hidden');
    return;
  }

  // Get snapshots for this stat type visible to this player
  const visibleSnaps = getVisibleSnapshots(groupId, cat.statType);

  if (visibleSnaps.length === 0) {
    // No history available — hide the selector
    wrapper.classList.add('hidden');
    return;
  }

  wrapper.classList.remove('hidden');

  const options = [`<option value="">Live (Current)</option>`];
  options.push('<option disabled>── Snapshots ──</option>');
  for (const snap of visibleSnaps) {
    const date = snap.createdAt ? new Date(snap.createdAt).toLocaleDateString() : '';
    options.push(`<option value="${_escHtml(snap.id)}">${_escHtml(snap.title)}${date ? ' (' + date + ')' : ''}</option>`);
  }

  select.innerHTML = options.join('');

  // If previously selected snapshot is no longer valid, reset to live
  const validIds = new Set(visibleSnaps.map(s => s.id));
  if (_activeSnapshotId && !validIds.has(_activeSnapshotId)) {
    _activeSnapshotId = null;
  }
  select.value = _activeSnapshotId || '';
}

// ─── Table render ──��───────────────────────────────────────────────────────

function _renderTable(currentUsername, groupId) {
  const tableEl = document.getElementById('lb-table-body');
  const emptyEl = document.getElementById('lb-empty');
  const titleEl = document.getElementById('lb-table-title');
  if (!tableEl) return;

  const cat = CATEGORIES.find(c => c.id === _activeCategory);
  if (!cat) return;

  // Disabled category placeholder
  if (cat.disabled) {
    tableEl.innerHTML = '';
    if (emptyEl) { emptyEl.classList.remove('hidden'); emptyEl.textContent = '🤝 Trades leaderboard — coming soon!'; }
    if (titleEl) titleEl.textContent = cat.label;
    return;
  }

  // Fetch rows
  let rows = [];
  let subtitleText = '';

  if (cat.seasonal) {
    // ── Seasonal RP (seasonal system — untouched by LB-5) ──
    if (_activeSeasonId) {
      rows = getSeasonLeaderboard({ seasonId: _activeSeasonId, groupId, limit: 100 });
      const summaries = getSeasonSummaries();
      const s = summaries.find(x => x.id === _activeSeasonId);
      subtitleText = s ? s.name : _activeSeasonId;
    } else {
      rows = getLeaderboardByStat({ statType: STAT_TYPES.SEASONAL_RP, groupId, limit: 100 });
      const activeSeason = getActiveSeason();
      subtitleText = activeSeason ? activeSeason.name + ' (Current)' : 'Current Season';
    }
  } else if (_activeSnapshotId) {
    // ── LB-5: Viewing a historical snapshot ──
    rows = getSnapshotLeaderboard({ snapshotId: _activeSnapshotId, groupId, limit: 100 });
    const meta = getSnapshotMeta(_activeSnapshotId);
    subtitleText = meta ? meta.title : _activeSnapshotId;
  } else {
    // ── Live non-seasonal data ──
    rows = getLeaderboardByStat({ statType: cat.statType, groupId, limit: 100 });
  }

  // Title
  if (titleEl) {
    titleEl.textContent = subtitleText || cat.label;
  }

  // Group scope label
  const scopeEl = document.getElementById('lb-scope-label');
  if (scopeEl) {
    if (groupId) {
      scopeEl.textContent = `Group: ${groups.getGroupName(groupId)}`;
      scopeEl.classList.remove('hidden');
    } else {
      scopeEl.classList.add('hidden');
    }
  }

  if (rows.length === 0) {
    tableEl.innerHTML = '';
    if (emptyEl) { emptyEl.classList.remove('hidden'); emptyEl.textContent = 'No data yet for this leaderboard.'; }
    return;
  }

  if (emptyEl) emptyEl.classList.add('hidden');

  tableEl.innerHTML = rows.map(row => {
    const isMe = row.username === currentUsername;
    const rankDisplay = _rankDisplay(row.rank);
    const valueDisplay = _formatValue(cat.id, row.value);
    const rowClass = isMe
      ? 'bg-primary-900/40 border-l-2 border-primary-500'
      : 'hover:bg-surface-800/50';

    return `<tr class="lb-row ${rowClass} transition">
      <td class="lb-rank px-3 py-2.5 text-center w-12 font-mono text-sm ${row.rank <= 3 ? 'text-amber-400 font-bold' : 'text-surface-400'}">${rankDisplay}</td>
      <td class="lb-name px-3 py-2.5 text-sm ${isMe ? 'text-primary-300 font-semibold' : 'text-surface-200'}">
        ${_escHtml(row.username)}${isMe ? ' <span class="text-xs text-primary-500">(you)</span>' : ''}
      </td>
      <td class="lb-value px-3 py-2.5 text-right font-mono text-sm font-medium ${isMe ? 'text-primary-300' : 'text-surface-300'}">${valueDisplay}</td>
    </tr>`;
  }).join('');
}

// ─── Helpers ───────────────────────────────��───────────────────────────────

function _rankDisplay(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

function _formatValue(catId, value) {
  if (typeof value !== 'number') return '—';
  if (value === 0) return '0';
  // RP categories get "RP" suffix
  if (catId === 'overall-rp' || catId === 'seasonal-rp') return value.toLocaleString() + ' RP';
  return value.toLocaleString();
}

function _escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _renderMessage(msg) {
  const tableEl = document.getElementById('lb-table-body');
  if (tableEl) tableEl.innerHTML = '';
  const emptyEl = document.getElementById('lb-empty');
  if (emptyEl) { emptyEl.classList.remove('hidden'); emptyEl.textContent = msg; }
}
