/**
 * leaderboard-admin.js
 * Phase LB-3 + LB-4 + LB-5 — Admin season controls + lifetime snapshot management.
 *
 * Responsibilities:
 *   - Render the "Leaderboards" admin panel
 *   - Start a new season (snapshot → archive current → rotate → reset seasonal RP)
 *   - LB-4: Hide / Restore / Delete archived seasons
 *   - LB-4: Set visibleToGroups on archived seasons
 *   - Wire up all event handlers within the panel
 *
 * Deliberately does NOT touch:
 *   - leaderboard rendering (leaderboard-ui.js)
 *   - query helpers (leaderboard-queries.js)
 *   - RP award logic (research.js)
 *   - Player schemas
 *   - Group / subgroup systems
 */

import * as db from './database.js';
import * as auth from './auth.js';
import * as toast from './toast.js';
import * as groups from './groups.js';
import {
  getActiveSeason,
  getAllSeasons,
  rotateSeason,
  updateSeasonEntry,
  ensureLeaderboardSeasonsSchema,
  updateArchiveMetadata,
  deleteArchivedSeason,
  STAT_TYPES,
} from './leaderboard-seasons.js';
import {
  ensureSnapshotsSchema,
  createSnapshot,
  getAllSnapshots,
  getVisibleSnapshots,
  updateSnapshotMetadata,
  deleteSnapshot,
  getLastResetTime,
  SNAPSHOT_STAT_TYPES,
  SNAPSHOT_STAT_LABELS,
} from './leaderboard-snapshots.js';

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Render the full Seasons admin panel into #admin-seasons.
 * Called by renderAdminSubTab('seasons') in ui.js.
 */
export function renderAdminSeasons() {
  if (!auth.isAdmin()) return;
  ensureLeaderboardSeasonsSchema();
  ensureSnapshotsSchema();

  const panel = document.getElementById('admin-seasons');
  if (!panel) return;

  const activeSeason = getActiveSeason();
  const allSeasons   = getAllSeasons();
  const archived     = allSeasons.filter(s => s.archived);
  const allSnapshots = getAllSnapshots();

  panel.innerHTML = _buildPanelHTML(activeSeason, archived) + _buildSnapshotsPanelHTML(allSnapshots);
  _wireEvents(panel);
  _wireSnapshotEvents(panel);
}

// ─── HTML builders ─────────────────────────────────────────────────────────

function _buildPanelHTML(activeSeason, archived) {
  return `
    <!-- Active Season Card -->
    <div class="bg-surface-900 rounded-xl border border-surface-700 p-6 mb-4">
      <h3 class="font-semibold mb-4 flex items-center gap-2">
        🌸 Current Season
      </h3>
      ${activeSeason
        ? `<div class="flex items-center gap-3 mb-4">
             <span class="px-3 py-1 bg-green-700/40 text-green-300 rounded-full text-sm font-medium border border-green-600/40">
               ● Active
             </span>
             <span class="text-white font-semibold">${_esc(activeSeason.name)}</span>
             <span class="text-surface-400 text-xs">ID: ${_esc(activeSeason.id)}</span>
           </div>
           <p class="text-surface-400 text-xs mb-1">
             Started: ${activeSeason.createdAt ? new Date(activeSeason.createdAt).toLocaleString() : '—'}
           </p>`
        : `<div class="flex items-center gap-3 mb-4">
             <span class="px-3 py-1 bg-amber-700/40 text-amber-300 rounded-full text-sm font-medium border border-amber-600/40">
               ⚠ No active season
             </span>
           </div>
           <p class="text-surface-400 text-sm mb-1">
             There is currently no active season. Start one below.
           </p>`
      }
    </div>

    <!-- Start New Season -->
    <div class="bg-surface-900 rounded-xl border border-surface-700 p-6 mb-4">
      <h3 class="font-semibold mb-1">Start New Season</h3>
      <p class="text-surface-400 text-xs mb-4">
        Archives the current season (if any), creates and activates a new one,
        and resets all players' Seasonal RP to zero.
      </p>
      <div class="flex gap-3 flex-wrap items-end">
        <div class="flex-1 min-w-[200px]">
          <label class="block text-xs text-surface-400 mb-1">Season name</label>
          <input
            id="admin-season-name-input"
            type="text"
            placeholder="e.g. Fall 2026, Interval 1, Semester A"
            class="admin-input w-full"
            maxlength="60"
          >
        </div>
        <button
          id="btn-start-new-season"
          class="bg-primary-600 hover:bg-primary-500 text-white font-semibold px-5 py-2 rounded-lg text-sm transition whitespace-nowrap"
        >
          🚀 Start New Season
        </button>
      </div>
    </div>

    <!-- Archived Leaderboards -->
    <div class="bg-surface-900 rounded-xl border border-surface-700 overflow-hidden">
      <div class="p-4 border-b border-surface-700 flex items-center justify-between gap-3">
        <div>
          <h3 class="font-semibold">Archived Leaderboards</h3>
          <p class="text-surface-400 text-xs mt-0.5">Manage visibility and lifecycle of archived seasons.</p>
        </div>
        <label class="flex items-center gap-2 text-xs text-surface-400 cursor-pointer select-none">
          <input type="checkbox" id="admin-show-hidden-archives" class="rounded">
          Show hidden
        </label>
      </div>
      ${archived.length === 0
        ? `<div class="p-6 text-center text-surface-500 text-sm">No archived seasons yet.</div>`
        : `<div id="archived-seasons-list" class="divide-y divide-surface-700 max-h-[480px] overflow-y-auto">
             ${archived
               .slice()
               .reverse()
               .map(s => _buildArchivedRow(s))
               .join('')}
           </div>`
      }
    </div>
  `;
}

/**
 * Build a single archived season row with LB-4 controls.
 * @param {object} s  - season object
 */
function _buildArchivedRow(s) {
  const isHidden = s.hidden === true;
  const vg       = s.visibleToGroups ?? null;
  const allGroups = groups.getAllGroups();

  // Visibility label
  let vgLabel = '';
  if (vg === 'all') {
    vgLabel = '<span class="text-xs text-blue-400">All groups</span>';
  } else if (Array.isArray(vg) && vg.length > 0) {
    const names = vg.map(id => {
      const g = allGroups.find(x => x.id === id);
      return g ? _esc(g.name) : _esc(id);
    }).join(', ');
    vgLabel = `<span class="text-xs text-blue-400">${names}</span>`;
  } else {
    vgLabel = '<span class="text-xs text-surface-500">Default (own group)</span>';
  }

  // Build visibleToGroups options
  const groupOptions = allGroups.map(g => {
    const checked = Array.isArray(vg) && vg.includes(g.id) ? 'checked' : '';
    return `<label class="flex items-center gap-1.5 text-xs text-surface-300 cursor-pointer">
      <input type="checkbox" class="vg-group-check rounded" data-group-id="${_esc(g.id)}" ${checked}>
      ${_esc(g.name)}
    </label>`;
  }).join('');

  return `
    <div
      class="archived-season-row px-4 py-3 text-sm ${isHidden ? 'opacity-50' : ''}"
      data-season-id="${_esc(s.id)}"
      data-hidden="${isHidden}"
    >
      <!-- Top row: id, name, date, action buttons -->
      <div class="flex items-center gap-2 flex-wrap">
        <span class="px-2 py-0.5 bg-surface-700 text-surface-400 rounded text-xs font-mono flex-shrink-0">${_esc(s.id)}</span>
        ${isHidden
          ? `<span class="px-1.5 py-0.5 bg-surface-700 text-surface-500 rounded text-xs">Hidden</span>`
          : ''}
        <span class="flex-1 text-surface-200 font-medium min-w-0 truncate">${_esc(s.name)}</span>
        <span class="text-surface-500 text-xs whitespace-nowrap">
          ${s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : '—'}
        </span>

        <!-- Action buttons -->
        ${isHidden
          ? `<button
               class="btn-restore-archive px-2.5 py-1 bg-surface-700 hover:bg-surface-600 text-surface-300 rounded text-xs font-medium transition whitespace-nowrap"
               data-season-id="${_esc(s.id)}"
             >↩ Restore</button>`
          : `<button
               class="btn-hide-archive px-2.5 py-1 bg-surface-700 hover:bg-surface-600 text-surface-300 rounded text-xs font-medium transition whitespace-nowrap"
               data-season-id="${_esc(s.id)}"
             >Hide</button>`
        }
        <button
          class="btn-delete-archive px-2.5 py-1 bg-red-900/50 hover:bg-red-800/60 text-red-300 rounded text-xs font-medium transition whitespace-nowrap border border-red-800/40"
          data-season-id="${_esc(s.id)}"
          data-season-name="${_esc(s.name)}"
        >🗑 Delete</button>

        <!-- Toggle visibility panel -->
        <button
          class="btn-toggle-vg px-2.5 py-1 bg-surface-700 hover:bg-surface-600 text-surface-300 rounded text-xs font-medium transition whitespace-nowrap"
          data-season-id="${_esc(s.id)}"
          aria-expanded="false"
        >👁 Visibility</button>
      </div>

      <!-- Visibility summary (always visible) -->
      <div class="mt-1 ml-1 flex items-center gap-1.5 text-xs text-surface-500">
        Visible to: ${vgLabel}
      </div>

      <!-- Expandable group visibility panel -->
      <div class="vg-panel hidden mt-3 p-3 bg-surface-800 rounded-lg border border-surface-700" data-season-id="${_esc(s.id)}">
        <p class="text-xs text-surface-400 mb-2 font-medium">Who can see this archived season?</p>

        <div class="flex flex-col gap-1.5 mb-3">
          <label class="flex items-center gap-1.5 text-xs text-surface-300 cursor-pointer">
            <input type="radio" name="vg-scope-${_esc(s.id)}" class="vg-scope-radio" value="default" ${vg === null ? 'checked' : ''}>
            Default — only the group(s) this season was played in
          </label>
          <label class="flex items-center gap-1.5 text-xs text-surface-300 cursor-pointer">
            <input type="radio" name="vg-scope-${_esc(s.id)}" class="vg-scope-radio" value="all" ${vg === 'all' ? 'checked' : ''}>
            All groups (anyone can view)
          </label>
          <label class="flex items-center gap-1.5 text-xs text-surface-300 cursor-pointer">
            <input type="radio" name="vg-scope-${_esc(s.id)}" class="vg-scope-radio" value="custom" ${Array.isArray(vg) ? 'checked' : ''}>
            Specific groups:
          </label>
        </div>

        <!-- Group checkboxes (shown when "custom" is selected) -->
        <div class="vg-group-list ${Array.isArray(vg) ? '' : 'hidden'} ml-4 flex flex-col gap-1 mb-3">
          ${groupOptions || '<span class="text-xs text-surface-500">No groups defined yet.</span>'}
        </div>

        <button
          class="btn-save-vg px-3 py-1.5 bg-primary-600 hover:bg-primary-500 text-white rounded text-xs font-semibold transition"
          data-season-id="${_esc(s.id)}"
        >Save Visibility</button>
      </div>
    </div>
  `;
}

// ─── Event wiring ──────────────────────────────────────────────────────────

function _wireEvents(panel) {
  // ── Start new season ──
  const btn   = panel.querySelector('#btn-start-new-season');
  const input = panel.querySelector('#admin-season-name-input');
  if (btn && input) {
    btn.addEventListener('click', () => {
      const name = input.value.trim();
      if (!name) {
        toast.error('Please enter a season name before starting.');
        input.focus();
        return;
      }
      _confirmStartSeason(name);
    });
  }

  // ── Show-hidden toggle ──
  const showHiddenCheck = panel.querySelector('#admin-show-hidden-archives');
  if (showHiddenCheck) {
    showHiddenCheck.addEventListener('change', () => {
      _applyHiddenFilter(panel, showHiddenCheck.checked);
    });
    // Apply initial state (hidden rows start filtered out)
    _applyHiddenFilter(panel, false);
  }

  // ── Archive action buttons (delegated) ──
  const list = panel.querySelector('#archived-seasons-list');
  if (!list) return;

  list.addEventListener('click', e => {
    // Hide
    const hideBtn = e.target.closest('.btn-hide-archive');
    if (hideBtn) {
      const id = hideBtn.dataset.seasonId;
      _doHideArchive(id, true);
      return;
    }

    // Restore
    const restoreBtn = e.target.closest('.btn-restore-archive');
    if (restoreBtn) {
      const id = restoreBtn.dataset.seasonId;
      _doHideArchive(id, false);
      return;
    }

    // Delete
    const deleteBtn = e.target.closest('.btn-delete-archive');
    if (deleteBtn) {
      const id   = deleteBtn.dataset.seasonId;
      const name = deleteBtn.dataset.seasonName;
      _confirmDeleteArchive(id, name);
      return;
    }

    // Toggle visibility panel
    const vgBtn = e.target.closest('.btn-toggle-vg');
    if (vgBtn) {
      const id = vgBtn.dataset.seasonId;
      _toggleVgPanel(list, id, vgBtn);
      return;
    }

    // Scope radio change — show/hide group checkboxes
    const radio = e.target.closest('.vg-scope-radio');
    if (radio) {
      const row = radio.closest('[data-season-id]');
      if (row) _syncGroupListVisibility(row);
      return;
    }

    // Save visibility
    const saveBtn = e.target.closest('.btn-save-vg');
    if (saveBtn) {
      const id = saveBtn.dataset.seasonId;
      _doSaveVisibility(list, id);
      return;
    }
  });

  // Also handle radio changes via 'change' (for keyboard nav)
  list.addEventListener('change', e => {
    const radio = e.target.closest('.vg-scope-radio');
    if (radio) {
      const row = radio.closest('[data-season-id]');
      if (row) _syncGroupListVisibility(row);
    }
  });
}

// ─── Filter hidden rows ────────────────────────────────────────────────────

function _applyHiddenFilter(panel, showHidden) {
  const rows = panel.querySelectorAll('.archived-season-row[data-hidden="true"]');
  rows.forEach(row => row.classList.toggle('hidden', !showHidden));
}

// ─── Toggle vg panel ──────────────────────────────────────────────────────

function _toggleVgPanel(list, seasonId, btn) {
  const panel = list.querySelector(`.vg-panel[data-season-id="${seasonId}"]`);
  if (!panel) return;
  const isOpen = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', isOpen);
  btn.setAttribute('aria-expanded', String(!isOpen));
}

function _syncGroupListVisibility(rowEl) {
  const checkedRadio = rowEl.querySelector('.vg-scope-radio:checked');
  const groupList    = rowEl.querySelector('.vg-group-list');
  if (!checkedRadio || !groupList) return;
  groupList.classList.toggle('hidden', checkedRadio.value !== 'custom');
}

// ─── Hide / Restore ─────────────────────────��──────────────────────────────

function _doHideArchive(seasonId, hide) {
  const ok = updateArchiveMetadata(seasonId, { hidden: hide });
  if (ok) {
    toast.success(hide ? 'Season hidden from players.' : 'Season restored to players.');
    renderAdminSeasons();
  } else {
    toast.error('Could not update archive. Check console.');
  }
}

// ─── Save visibility ──────────────────────────────────────────────────────

function _doSaveVisibility(list, seasonId) {
  const panel  = list.querySelector(`.vg-panel[data-season-id="${seasonId}"]`);
  if (!panel) return;

  const scope = panel.querySelector('.vg-scope-radio:checked')?.value ?? 'default';

  let visibleToGroups;
  if (scope === 'all') {
    visibleToGroups = 'all';
  } else if (scope === 'custom') {
    const checked = [...panel.querySelectorAll('.vg-group-check:checked')];
    visibleToGroups = checked.map(c => c.dataset.groupId);
    if (visibleToGroups.length === 0) {
      toast.error('Select at least one group, or choose "Default".');
      return;
    }
  } else {
    visibleToGroups = null;
  }

  const ok = updateArchiveMetadata(seasonId, { visibleToGroups });
  if (ok) {
    toast.success('Visibility saved.');
    renderAdminSeasons();
  } else {
    toast.error('Could not save visibility. Check console.');
  }
}

// ─── Delete archive ────────────────────────────────────────────────────────

function _confirmDeleteArchive(seasonId, seasonName) {
  const modal     = document.getElementById('confirm-modal');
  const titleEl   = document.getElementById('confirm-title');
  const msgEl     = document.getElementById('confirm-message');
  const okBtn     = document.getElementById('btn-confirm-ok');
  const cancelBtn = document.getElementById('btn-confirm-cancel');

  if (!modal || !titleEl || !msgEl || !okBtn || !cancelBtn) {
    // No modal available — skip (don't delete without confirmation)
    toast.error('Confirmation modal not available. Deletion aborted.');
    return;
  }

  titleEl.textContent = 'Delete Archived Season?';
  msgEl.textContent   = `"${seasonName}" will be permanently removed. Leaderboard snapshots will be lost. Player stats and lifetime RP are unaffected. This cannot be undone.`;

  okBtn.className     = 'flex-1 bg-red-700 hover:bg-red-600 py-3 rounded-lg font-semibold transition text-sm';
  okBtn.textContent   = '🗑 Delete Permanently';

  // Clone to remove old listeners
  const newOk     = okBtn.cloneNode(true);
  const newCancel = cancelBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

  const closeModal = () => modal.classList.add('hidden');

  newOk.addEventListener('click', () => {
    closeModal();
    _doDeleteArchive(seasonId, seasonName);
  });
  newCancel.addEventListener('click', closeModal);

  modal.classList.remove('hidden');
}

function _doDeleteArchive(seasonId, seasonName) {
  const ok = deleteArchivedSeason(seasonId);
  if (ok) {
    toast.success(`Archived season "${seasonName}" deleted.`);
    renderAdminSeasons();
  } else {
    toast.error('Deletion blocked or failed. Check console.');
  }
}

// ─── Season rotation logic ─────────────────────────────────────────────────

function _confirmStartSeason(name) {
  const activeSeason = getActiveSeason();
  const modal = document.getElementById('confirm-modal');
  const titleEl   = document.getElementById('confirm-title');
  const msgEl     = document.getElementById('confirm-message');
  const okBtn     = document.getElementById('btn-confirm-ok');
  const cancelBtn = document.getElementById('btn-confirm-cancel');

  if (!modal || !titleEl || !msgEl || !okBtn || !cancelBtn) {
    // No confirm modal available — proceed directly
    _doStartSeason(name);
    return;
  }

  titleEl.textContent = 'Start New Season?';
  msgEl.textContent = activeSeason
    ? `"${activeSeason.name}" will be archived. A new season named "${name}" will begin immediately. All players' Seasonal RP will reset to 0. Lifetime RP is unaffected.`
    : `A new season named "${name}" will begin immediately. All players' Seasonal RP will reset to 0. Lifetime RP is unaffected.`;

  // Style OK button as amber (action, not destructive)
  okBtn.className = 'flex-1 bg-amber-600 hover:bg-amber-500 py-3 rounded-lg font-semibold transition text-sm';
  okBtn.textContent = 'Start Season';

  // Clone to remove old listeners
  const newOk = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);
  const newCancel = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

  const closeModal = () => modal.classList.add('hidden');

  newOk.addEventListener('click', () => {
    closeModal();
    _doStartSeason(name);
  });
  newCancel.addEventListener('click', closeModal);

  modal.classList.remove('hidden');
}

function _doStartSeason(name) {
  try {
    // 1. Snapshot all player seasonal RP into the current active season entries
    //    before archiving (so the archived season has final scores).
    _snapshotActiveSeasonRP();

    // 2. Archive current season + create + activate new season
    const { archivedSeasonId, newSeasonId } = rotateSeason({
      name,
      statType: STAT_TYPES.SEASONAL_RP,
    });

    // 3. Reset seasonalResearchPoints to 0 for all players
    _resetAllSeasonalRP();

    const archivedMsg = archivedSeasonId ? ` Previous season archived.` : '';
    toast.success(`Season "${name}" started!${archivedMsg}`);
    console.log(`[LeaderboardAdmin] Season rotated — archived: ${archivedSeasonId ?? 'none'}, new: ${newSeasonId}`);

    // 4. Re-render the panel to show updated state
    renderAdminSeasons();

  } catch (err) {
    console.error('[LeaderboardAdmin] Season rotation failed:', err);
    toast.error('Failed to start new season. See console for details.');
  }
}

// ─── Snapshot helpers ────────────────────────���─────────────────────────────

/**
 * Snapshot every player's current seasonalResearchPoints into the active
 * season's entries. This preserves scores at the moment of archiving.
 * Only called immediately before rotation — never called in isolation.
 */
function _snapshotActiveSeasonRP() {
  const season = getActiveSeason();
  if (!season) return; // nothing to snapshot

  const players = db.getChildren('players');
  for (const { key: username, value: p } of players) {
    const value     = typeof p?.seasonalResearchPoints === 'number' ? p.seasonalResearchPoints : 0;
    const groupId   = p?.groupId ?? null;
    const subgroupId = p?.subgroupId ?? null;
    updateSeasonEntry(username, value, groupId, subgroupId);
  }

  console.log(`[LeaderboardAdmin] Snapshotted ${players.length} players into season ${season.id}`);
}

/**
 * Reset seasonalResearchPoints to 0 for every player.
 * Lifetime (totalResearchPoints) is untouched.
 */
function _resetAllSeasonalRP() {
  const players = db.getChildren('players');
  for (const { key: username } of players) {
    db.set(`players/${username}/seasonalResearchPoints`, 0);
  }
  console.log(`[LeaderboardAdmin] Reset seasonal RP for ${players.length} players`);
}

// ─── LB-5: Snapshots HTML builder ─────────────────────────────────────────

/**
 * Build the "Lifetime Snapshots" admin panel section.
 * Completely separate from season controls above.
 */
function _buildSnapshotsPanelHTML(allSnapshots) {
  const statOptions = Object.entries(SNAPSHOT_STAT_TYPES).map(([, val]) => {
    return `<option value="${_esc(val)}">${_esc(SNAPSHOT_STAT_LABELS[val] ?? val)}</option>`;
  }).join('');

  return `
    <!-- ── LB-5: Lifetime Snapshots ── -->
    <div class="bg-surface-900 rounded-xl border border-surface-700 p-6 mt-4 mb-4">
      <h3 class="font-semibold mb-1">📸 Lifetime Leaderboard Snapshots</h3>
      <p class="text-surface-400 text-xs mb-4">
        Archive the current state of a non-seasonal leaderboard. Optionally reset that category to 0 after archiving.
        <span class="text-amber-400">Does not affect Seasonal RP or any other category.</span>
      </p>

      <div class="flex flex-wrap gap-3 items-end mb-2">
        <!-- Snapshot title -->
        <div class="flex-1 min-w-[180px]">
          <label class="block text-xs text-surface-400 mb-1">Snapshot name</label>
          <input
            id="snap-title-input"
            type="text"
            placeholder="e.g. 2026 Overall RP, Year 1 Packs"
            class="admin-input w-full"
            maxlength="80"
          >
        </div>

        <!-- Stat type -->
        <div class="min-w-[180px]">
          <label class="block text-xs text-surface-400 mb-1">Leaderboard category</label>
          <select id="snap-stat-select" class="admin-input w-full bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm text-white">
            ${statOptions}
          </select>
        </div>

        <!-- Create button -->
        <button
          id="btn-create-snapshot"
          class="bg-primary-600 hover:bg-primary-500 text-white font-semibold px-5 py-2 rounded-lg text-sm transition whitespace-nowrap"
        >
          📸 Create Snapshot
        </button>
      </div>

      <!-- Optional reset checkbox -->
      <label class="flex items-center gap-2 text-sm text-surface-300 cursor-pointer select-none mb-2">
        <input type="checkbox" id="snap-reset-after" class="rounded">
        Reset this leaderboard category to 0 after snapshot
      </label>
      <p class="text-xs text-surface-500 ml-6 mb-1">
        Only the selected category resets. All other leaderboards and Seasonal RP remain untouched.
      </p>
    </div>

    <!-- Snapshot list -->
    <div class="bg-surface-900 rounded-xl border border-surface-700 overflow-hidden mb-4">
      <div class="p-4 border-b border-surface-700 flex items-center justify-between gap-3">
        <div>
          <h3 class="font-semibold">Snapshot Archive</h3>
          <p class="text-surface-400 text-xs mt-0.5">Read-only archived snapshots. Manage visibility and lifecycle.</p>
        </div>
        <label class="flex items-center gap-2 text-xs text-surface-400 cursor-pointer select-none">
          <input type="checkbox" id="snap-show-hidden" class="rounded">
          Show hidden
        </label>
      </div>
      ${allSnapshots.length === 0
        ? `<div class="p-6 text-center text-surface-500 text-sm">No snapshots yet.</div>`
        : `<div id="snapshots-list" class="divide-y divide-surface-700 max-h-[480px] overflow-y-auto">
             ${allSnapshots.map(s => _buildSnapshotRow(s)).join('')}
           </div>`
      }
    </div>
  `;
}

function _buildSnapshotRow(s) {
  const isHidden = s.hidden === true;
  const label    = SNAPSHOT_STAT_LABELS[s.statType] ?? s.statType;
  const vg       = s.visibleToGroups ?? null;
  const allGroups = groups.getAllGroups();

  let vgLabel = '';
  if (vg === 'all') {
    vgLabel = '<span class="text-xs text-blue-400">All groups</span>';
  } else if (Array.isArray(vg) && vg.length > 0) {
    const names = vg.map(id => {
      const g = allGroups.find(x => x.id === id);
      return g ? _esc(g.name) : _esc(id);
    }).join(', ');
    vgLabel = `<span class="text-xs text-blue-400">${names}</span>`;
  } else {
    vgLabel = '<span class="text-xs text-surface-500">Default (own group)</span>';
  }

  const groupOptions = allGroups.map(g => {
    const checked = Array.isArray(vg) && vg.includes(g.id) ? 'checked' : '';
    return `<label class="flex items-center gap-1.5 text-xs text-surface-300 cursor-pointer">
      <input type="checkbox" class="snap-vg-group-check rounded" data-group-id="${_esc(g.id)}" ${checked}>
      ${_esc(g.name)}
    </label>`;
  }).join('');

  return `
    <div
      class="snapshot-row px-4 py-3 text-sm ${isHidden ? 'opacity-50' : ''}"
      data-snap-id="${_esc(s.id)}"
      data-snap-hidden="${isHidden}"
    >
      <div class="flex items-center gap-2 flex-wrap">
        <span class="px-2 py-0.5 bg-surface-700 text-surface-400 rounded text-xs font-mono flex-shrink-0">${_esc(label)}</span>
        ${isHidden ? `<span class="px-1.5 py-0.5 bg-surface-700 text-surface-500 rounded text-xs">Hidden</span>` : ''}
        <span class="flex-1 text-surface-200 font-medium min-w-0 truncate">${_esc(s.title)}</span>
        <span class="text-surface-500 text-xs whitespace-nowrap">
          ${s.createdAt ? new Date(s.createdAt).toLocaleDateString() : '—'}
        </span>

        ${isHidden
          ? `<button class="btn-snap-restore px-2.5 py-1 bg-surface-700 hover:bg-surface-600 text-surface-300 rounded text-xs font-medium transition whitespace-nowrap" data-snap-id="${_esc(s.id)}">↩ Restore</button>`
          : `<button class="btn-snap-hide px-2.5 py-1 bg-surface-700 hover:bg-surface-600 text-surface-300 rounded text-xs font-medium transition whitespace-nowrap" data-snap-id="${_esc(s.id)}">Hide</button>`
        }
        <button
          class="btn-snap-delete px-2.5 py-1 bg-red-900/50 hover:bg-red-800/60 text-red-300 rounded text-xs font-medium transition whitespace-nowrap border border-red-800/40"
          data-snap-id="${_esc(s.id)}"
          data-snap-title="${_esc(s.title)}"
        >🗑 Delete</button>
        <button
          class="btn-snap-toggle-vg px-2.5 py-1 bg-surface-700 hover:bg-surface-600 text-surface-300 rounded text-xs font-medium transition whitespace-nowrap"
          data-snap-id="${_esc(s.id)}"
          aria-expanded="false"
        >👁 Visibility</button>
      </div>

      <div class="mt-1 ml-1 flex items-center gap-1.5 text-xs text-surface-500">
        Visible to: ${vgLabel}
      </div>

      <!-- Expandable visibility panel -->
      <div class="snap-vg-panel hidden mt-3 p-3 bg-surface-800 rounded-lg border border-surface-700" data-snap-id="${_esc(s.id)}">
        <p class="text-xs text-surface-400 mb-2 font-medium">Who can see this snapshot?</p>
        <div class="flex flex-col gap-1.5 mb-3">
          <label class="flex items-center gap-1.5 text-xs text-surface-300 cursor-pointer">
            <input type="radio" name="snap-vg-scope-${_esc(s.id)}" class="snap-vg-scope-radio" value="default" ${vg === null ? 'checked' : ''}>
            Default — only the group(s) in this snapshot
          </label>
          <label class="flex items-center gap-1.5 text-xs text-surface-300 cursor-pointer">
            <input type="radio" name="snap-vg-scope-${_esc(s.id)}" class="snap-vg-scope-radio" value="all" ${vg === 'all' ? 'checked' : ''}>
            All groups (anyone can view)
          </label>
          <label class="flex items-center gap-1.5 text-xs text-surface-300 cursor-pointer">
            <input type="radio" name="snap-vg-scope-${_esc(s.id)}" class="snap-vg-scope-radio" value="custom" ${Array.isArray(vg) ? 'checked' : ''}>
            Specific groups:
          </label>
        </div>
        <div class="snap-vg-group-list ${Array.isArray(vg) ? '' : 'hidden'} ml-4 flex flex-col gap-1 mb-3">
          ${groupOptions || '<span class="text-xs text-surface-500">No groups defined yet.</span>'}
        </div>
        <button
          class="btn-snap-save-vg px-3 py-1.5 bg-primary-600 hover:bg-primary-500 text-white rounded text-xs font-semibold transition"
          data-snap-id="${_esc(s.id)}"
        >Save Visibility</button>
      </div>
    </div>
  `;
}

// ─── LB-5: Snapshot event wiring ──────────────────────────────────────────

function _wireSnapshotEvents(panel) {
  // Create snapshot
  const createBtn = panel.querySelector('#btn-create-snapshot');
  if (createBtn) {
    createBtn.addEventListener('click', () => {
      const title      = (panel.querySelector('#snap-title-input')?.value ?? '').trim();
      const statType   = panel.querySelector('#snap-stat-select')?.value ?? '';
      const resetAfter = panel.querySelector('#snap-reset-after')?.checked === true;

      if (!title) {
        toast.error('Please enter a snapshot name.');
        panel.querySelector('#snap-title-input')?.focus();
        return;
      }
      if (!statType) {
        toast.error('Please select a leaderboard category.');
        return;
      }
      _confirmCreateSnapshot({ title, statType, resetAfter });
    });
  }

  // Show-hidden toggle
  const showHiddenCheck = panel.querySelector('#snap-show-hidden');
  if (showHiddenCheck) {
    showHiddenCheck.addEventListener('change', () => {
      _applySnapshotHiddenFilter(panel, showHiddenCheck.checked);
    });
    _applySnapshotHiddenFilter(panel, false);
  }

  // Delegated events on snapshot list
  const list = panel.querySelector('#snapshots-list');
  if (!list) return;

  list.addEventListener('click', e => {
    const hideBtn = e.target.closest('.btn-snap-hide');
    if (hideBtn) { _doSnapshotHide(hideBtn.dataset.snapId, true); return; }

    const restoreBtn = e.target.closest('.btn-snap-restore');
    if (restoreBtn) { _doSnapshotHide(restoreBtn.dataset.snapId, false); return; }

    const deleteBtn = e.target.closest('.btn-snap-delete');
    if (deleteBtn) { _confirmDeleteSnapshot(deleteBtn.dataset.snapId, deleteBtn.dataset.snapTitle); return; }

    const vgBtn = e.target.closest('.btn-snap-toggle-vg');
    if (vgBtn) { _toggleSnapVgPanel(list, vgBtn.dataset.snapId, vgBtn); return; }

    const radio = e.target.closest('.snap-vg-scope-radio');
    if (radio) { _syncSnapGroupListVisibility(radio.closest('[data-snap-id]')); return; }

    const saveVgBtn = e.target.closest('.btn-snap-save-vg');
    if (saveVgBtn) { _doSaveSnapVisibility(list, saveVgBtn.dataset.snapId); return; }
  });

  list.addEventListener('change', e => {
    const radio = e.target.closest('.snap-vg-scope-radio');
    if (radio) { _syncSnapGroupListVisibility(radio.closest('[data-snap-id]')); }
  });
}

// ─── LB-5: Snapshot action handlers ───────────────────────────────────────

function _confirmCreateSnapshot({ title, statType, resetAfter }) {
  const modal     = document.getElementById('confirm-modal');
  const titleEl   = document.getElementById('confirm-title');
  const msgEl     = document.getElementById('confirm-message');
  const okBtn     = document.getElementById('btn-confirm-ok');
  const cancelBtn = document.getElementById('btn-confirm-cancel');

  if (!modal || !titleEl || !msgEl || !okBtn || !cancelBtn) {
    _doCreateSnapshot({ title, statType, resetAfter });
    return;
  }

  const catLabel = SNAPSHOT_STAT_LABELS[statType] ?? statType;
  titleEl.textContent = 'Create Snapshot?';
  msgEl.textContent   = resetAfter
    ? `"${title}" will archive the current ${catLabel} leaderboard, then reset ${catLabel} to 0 for all players. All other leaderboards and Seasonal RP are unaffected. This cannot be undone.`
    : `"${title}" will archive the current ${catLabel} leaderboard as a read-only snapshot. Player stats will not be changed.`;

  okBtn.className   = 'flex-1 bg-primary-600 hover:bg-primary-500 py-3 rounded-lg font-semibold transition text-sm';
  okBtn.textContent = resetAfter ? '📸 Snapshot & Reset' : '📸 Create Snapshot';

  const newOk     = okBtn.cloneNode(true);
  const newCancel = cancelBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

  const closeModal = () => modal.classList.add('hidden');
  newOk.addEventListener('click', () => { closeModal(); _doCreateSnapshot({ title, statType, resetAfter }); });
  newCancel.addEventListener('click', closeModal);

  modal.classList.remove('hidden');
}

function _doCreateSnapshot({ title, statType, resetAfter }) {
  try {
    const { snapshotId, resetDone } = createSnapshot({ title, statType, resetAfter });
    const catLabel = SNAPSHOT_STAT_LABELS[statType] ?? statType;
    const msg = resetDone
      ? `Snapshot "${title}" created and ${catLabel} reset to 0.`
      : `Snapshot "${title}" created.`;
    toast.success(msg);
    console.log(`[LB-5] Snapshot created: ${snapshotId}`);
    renderAdminSeasons();
  } catch (err) {
    console.error('[LB-5] Snapshot creation failed:', err);
    toast.error('Failed to create snapshot. See console for details.');
  }
}

function _doSnapshotHide(snapId, hide) {
  const ok = updateSnapshotMetadata(snapId, { hidden: hide });
  if (ok) {
    toast.success(hide ? 'Snapshot hidden from players.' : 'Snapshot restored to players.');
    renderAdminSeasons();
  } else {
    toast.error('Could not update snapshot. Check console.');
  }
}

function _confirmDeleteSnapshot(snapId, snapTitle) {
  const modal     = document.getElementById('confirm-modal');
  const titleEl   = document.getElementById('confirm-title');
  const msgEl     = document.getElementById('confirm-message');
  const okBtn     = document.getElementById('btn-confirm-ok');
  const cancelBtn = document.getElementById('btn-confirm-cancel');

  if (!modal || !titleEl || !msgEl || !okBtn || !cancelBtn) {
    toast.error('Confirmation modal not available. Deletion aborted.');
    return;
  }

  titleEl.textContent = 'Delete Snapshot?';
  msgEl.textContent   = `"${snapTitle}" will be permanently removed. Player stats and lifetime RP are unaffected. This cannot be undone.`;

  okBtn.className   = 'flex-1 bg-red-700 hover:bg-red-600 py-3 rounded-lg font-semibold transition text-sm';
  okBtn.textContent = '🗑 Delete Permanently';

  const newOk     = okBtn.cloneNode(true);
  const newCancel = cancelBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

  const closeModal = () => modal.classList.add('hidden');
  newOk.addEventListener('click', () => { closeModal(); _doDeleteSnapshot(snapId, snapTitle); });
  newCancel.addEventListener('click', closeModal);

  modal.classList.remove('hidden');
}

function _doDeleteSnapshot(snapId, snapTitle) {
  const ok = deleteSnapshot(snapId);
  if (ok) {
    toast.success(`Snapshot "${snapTitle}" deleted.`);
    renderAdminSeasons();
  } else {
    toast.error('Deletion failed. Check console.');
  }
}

function _applySnapshotHiddenFilter(panel, showHidden) {
  const rows = panel.querySelectorAll('.snapshot-row[data-snap-hidden="true"]');
  rows.forEach(row => row.classList.toggle('hidden', !showHidden));
}

function _toggleSnapVgPanel(list, snapId, btn) {
  const p = list.querySelector(`.snap-vg-panel[data-snap-id="${snapId}"]`);
  if (!p) return;
  const isOpen = !p.classList.contains('hidden');
  p.classList.toggle('hidden', isOpen);
  btn.setAttribute('aria-expanded', String(!isOpen));
}

function _syncSnapGroupListVisibility(rowEl) {
  if (!rowEl) return;
  const checked   = rowEl.querySelector('.snap-vg-scope-radio:checked');
  const groupList = rowEl.querySelector('.snap-vg-group-list');
  if (!checked || !groupList) return;
  groupList.classList.toggle('hidden', checked.value !== 'custom');
}

function _doSaveSnapVisibility(list, snapId) {
  const p = list.querySelector(`.snap-vg-panel[data-snap-id="${snapId}"]`);
  if (!p) return;

  const scope = p.querySelector('.snap-vg-scope-radio:checked')?.value ?? 'default';
  let visibleToGroups;

  if (scope === 'all') {
    visibleToGroups = 'all';
  } else if (scope === 'custom') {
    const checked = [...p.querySelectorAll('.snap-vg-group-check:checked')];
    visibleToGroups = checked.map(c => c.dataset.groupId);
    if (visibleToGroups.length === 0) {
      toast.error('Select at least one group, or choose "Default".');
      return;
    }
  } else {
    visibleToGroups = null;
  }

  const ok = updateSnapshotMetadata(snapId, { visibleToGroups });
  if (ok) {
    toast.success('Snapshot visibility saved.');
    renderAdminSeasons();
  } else {
    toast.error('Could not save visibility. Check console.');
  }
}

// ─── Util ─────────────────────────────��────────────────────────────────────

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
