/**
 * Profile UI — renders the player profile tab
 * Extracted from ui.cleaned.js (Phase 1 refactor)
 */

import * as auth from './auth.js';
import * as player from './player.js';
import * as cards from './cards.js';
import * as groups from './groups.js';

export function renderProfile() {
  const session = auth.getSession();
  if (!session || session.username === '__admin__') return;

  const p = player.getPlayer(session.username);
  if (!p) return;

  document.getElementById('profile-username').textContent = p.username;
  const groupEl = document.getElementById('profile-group');
  const groupName = p.group ? groups.getGroupName(p.group) : null;
  if (groupName) {
    groupEl.textContent = groupName;
    groupEl.style.display = '';
  } else {
    groupEl.textContent = '';
    groupEl.style.display = 'none';
  }

  const stats = p.stats || {};
  const researchStats = p.researchStats || {};
  const totalRP = typeof p.totalResearchPoints === 'number' ? p.totalResearchPoints : 0;
  const projectsCompleted = p.projectsCompleted || researchStats.successfulProjects || 0;
  const breakthroughs = researchStats.breakthroughs || 0;
  const tradesCompleted = stats.tradesCompleted || 0;
  document.getElementById('profile-stats').innerHTML = `
    <div class="stat-card"><div class="stat-value">${totalRP}</div><div class="stat-label">Total Research</div></div>
    <div class="stat-card"><div class="stat-value">${projectsCompleted}</div><div class="stat-label">Projects Completed</div></div>
    <div class="stat-card"><div class="stat-value">${breakthroughs}</div><div class="stat-label">Breakthroughs</div></div>
    <div class="stat-card"><div class="stat-value">${tradesCompleted}</div><div class="stat-label">Trades Completed</div></div>
  `;

  const inventory = player.getInventory(session.username);
  const allCardsList = cards.getEnabledCards();
  const ownedIds = new Set(inventory.map(i => i.cardId));

  const progressHTML = cards.RARITIES.map(rarity => {
    const total = allCardsList.filter(c => c.rarity === rarity).length;
    const owned = allCardsList.filter(c => c.rarity === rarity && ownedIds.has(c.id)).length;
    const pct = total > 0 ? Math.round((owned / total) * 100) : 0;
    return `
      <div>
        <div class="flex justify-between text-sm mb-1">
          <span class="capitalize" style="color:${cards.RARITY_COLORS[rarity]}">${rarity}</span>
          <span class="text-surface-400">${owned}/${total}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${pct}%;background:${cards.RARITY_COLORS[rarity]}"></div>
        </div>
      </div>
    `;
  }).join('');
  document.getElementById('profile-progress').innerHTML = progressHTML;
}
