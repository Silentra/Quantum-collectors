/**
 * achievements-admin.js — Simplified admin CRUD for achievement definitions.
 */

import * as toast from './toast.js';
import * as packs from './packs.js';
import {
  REWARD_TYPES,
  deleteAchievementDefinition,
  generateAchievementId,
  getAchievementConfig,
  listAchievementDefinitions,
  saveAchievementDefinition,
  saveAchievementSortOrder,
} from './achievement-config.js';
import { listRegisteredStatKeys } from './achievement-stats.js';
import { validateAchievementDefinition } from './achievement-validation.js';
import {
  getCosmeticDefinition,
  getCosmeticCategoryAdminLabel,
  getMergedItemDefinitions,
  listCosmeticDefinitions,
} from './cosmetic-definitions.js';
import { ITEM_CATEGORIES, ITEM_TYPES } from './shop-definitions.js';

let editingId = null;

const STAT_LABELS = Object.freeze({
  totalResearchPoints: 'Total research points',
  projectsCompleted: 'Projects completed',
  breakthroughsAchieved: 'Breakthroughs',
  uniqueCardsOwned: 'Unique cards owned',
  tradesCompleted: 'Trades completed',
  packsOpened: 'Packs opened',
  shopPurchases: 'Shop purchases',
  cosmeticsUnlocked: 'Cosmetics unlocked',
  cosmeticsEquipped: 'Cosmetics currently equipped',
  uniqueCardsDiscovered: 'Unique cards discovered',
  maxCardAuraTier: 'Cards at max aura (tier 3)',
  bestProjectSuccessStreak: 'Best project success streak',
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateText(text, max = 72) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function statLabel(key) {
  return STAT_LABELS[key] || key;
}

function confirmDialog(message, title = 'Confirm') {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    if (!modal) {
      resolve(window.confirm(message));
      return;
    }
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    modal.classList.remove('hidden');

    const okBtn = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');

    function cleanup() {
      modal.classList.add('hidden');
      okBtn?.removeEventListener('click', onOk);
      cancelBtn?.removeEventListener('click', onCancel);
    }
    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }

    okBtn?.addEventListener('click', onOk);
    cancelBtn?.addEventListener('click', onCancel);
  });
}

function listConsumableOptions() {
  return Object.values(getMergedItemDefinitions())
    .filter(d => d?.type === ITEM_TYPES.CONSUMABLE && d.enabled !== false && d.deleted !== true)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const COSMETIC_REWARD_CATEGORIES = Object.freeze([
  ITEM_CATEGORIES.TITLE,
  ITEM_CATEGORIES.PROFILE_BANNER,
  ITEM_CATEGORIES.SHELL_BACKGROUND,
  ITEM_CATEGORIES.AURA,
  ITEM_CATEGORIES.BORDER,
]);

function listCosmeticRewardOptions(category = null) {
  return listCosmeticDefinitions({
    category: category || null,
    achievementEligibleOnly: true,
  });
}

function listPackOptions() {
  return packs.getEnabledPackTypes().sort((a, b) => a.name.localeCompare(b.name));
}

function nextSortOrder(definitions) {
  if (!definitions.length) return 0;
  return Math.max(...definitions.map(d => Number(d.sortOrder) || 0)) + 1;
}

function readFormDefinition(root, existingDef = null) {
  const config = getAchievementConfig();
  const existingIds = new Set(Object.keys(config.definitions));
  const name = root.querySelector('#ach-admin-name')?.value?.trim() || '';

  const stat = root.querySelector('.ach-cond-stat')?.value;
  const value = Number(root.querySelector('.ach-cond-value')?.value);

  const rewards = [];
  root.querySelectorAll('[data-ach-reward-row]').forEach(row => {
    const type = row.querySelector('.ach-reward-type')?.value;
    const reward = { type };
    if (type === 'rp') {
      reward.amount = Number(row.querySelector('.ach-reward-amount')?.value);
    }
    if (type === 'consumable') {
      reward.itemId = row.querySelector('.ach-reward-consumable')?.value;
      reward.quantity = Number(row.querySelector('.ach-reward-qty')?.value || 1);
    }
    if (type === 'cosmetic') {
      reward.itemId = row.querySelector('.ach-reward-cosmetic')?.value;
    }
    if (type === 'pack') {
      reward.packId = row.querySelector('.ach-reward-pack')?.value;
      reward.quantity = Number(row.querySelector('.ach-reward-qty')?.value || 1);
    }
    rewards.push(reward);
  });

  const emojiRaw = root.querySelector('#ach-admin-emoji')?.value?.trim();
  const id = editingId || generateAchievementId(name, existingIds);

  return {
    id,
    enabled: root.querySelector('#ach-admin-enabled')?.value === 'true',
    hidden: root.querySelector('#ach-admin-hidden')?.value === 'true',
    name,
    description: root.querySelector('#ach-admin-desc')?.value?.trim() || '',
    category: existingDef?.category ?? 'general',
    sortOrder: existingDef?.sortOrder ?? nextSortOrder(listAchievementDefinitions()),
    rarity: existingDef?.rarity ?? 'common',
    icon: { emoji: emojiRaw || '🏆' },
    conditions: [{ stat, op: 'gte', value }],
    conditionMode: 'all',
    rewards,
    notifyOnUnlock: true,
  };
}

function statOptions(selected) {
  return listRegisteredStatKeys()
    .map(key => `<option value="${escapeHtml(key)}"${key === selected ? ' selected' : ''}>${escapeHtml(statLabel(key))}</option>`)
    .join('');
}

function consumableOptions(selected) {
  const opts = listConsumableOptions()
    .map(d => `<option value="${escapeHtml(d.id)}"${d.id === selected ? ' selected' : ''}>${escapeHtml(d.name)}</option>`)
    .join('');
  return `<option value="">Select consumable…</option>${opts}`;
}

function resolveCosmeticRewardCategory(selectedCategory, selectedItemId) {
  if (selectedCategory) return selectedCategory;
  if (selectedItemId) {
    return getCosmeticDefinition(selectedItemId)?.category || ITEM_CATEGORIES.TITLE;
  }
  return ITEM_CATEGORIES.TITLE;
}

function cosmeticCategoryOptions(selectedCategory, selectedItemId) {
  const active = resolveCosmeticRewardCategory(selectedCategory, selectedItemId);
  const opts = COSMETIC_REWARD_CATEGORIES.map(cat => {
    const label = getCosmeticCategoryAdminLabel(cat);
    return `<option value="${escapeHtml(cat)}"${cat === active ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  return opts;
}

function cosmeticOptions(category, selectedId) {
  const opts = listCosmeticRewardOptions(category)
    .map(d => `<option value="${escapeHtml(d.id)}"${d.id === selectedId ? ' selected' : ''}>${escapeHtml(d.name)} (${escapeHtml(d.id)})</option>`)
    .join('');
  return `<option value="">Select cosmetic…</option>${opts}`;
}

function refreshRewardRowCosmeticSelect(row) {
  const category = row.querySelector('.ach-reward-cosmetic-category')?.value || ITEM_CATEGORIES.TITLE;
  const select = row.querySelector('.ach-reward-cosmetic');
  if (!select) return;
  const previous = select.value;
  select.innerHTML = cosmeticOptions(category, previous);
}

function packOptions(selected) {
  const opts = listPackOptions()
    .map(p => `<option value="${escapeHtml(p.id)}"${p.id === selected ? ' selected' : ''}>${escapeHtml(p.name)}</option>`)
    .join('');
  return `<option value="">Select pack…</option>${opts}`;
}

function rewardRowHtml(r = {}) {
  const type = r.type || 'rp';
  const types = REWARD_TYPES.map(t => `<option value="${t}"${t === type ? ' selected' : ''}>${t}</option>`).join('');
  const cosmeticCategory = type === 'cosmetic'
    ? resolveCosmeticRewardCategory(null, r.itemId)
    : ITEM_CATEGORIES.TITLE;
  return `
    <div class="ach-admin-row ach-admin-reward-row" data-ach-reward-row data-reward-type="${escapeHtml(type)}">
      <select class="admin-input ach-reward-type">${types}</select>
      <input class="admin-input ach-reward-amount" type="number" min="1" placeholder="RP amount" value="${escapeHtml(r.amount ?? '')}" />
      <select class="admin-input ach-reward-consumable">${consumableOptions(r.itemId)}</select>
      <select class="admin-input ach-reward-cosmetic-category">${cosmeticCategoryOptions(cosmeticCategory, r.itemId)}</select>
      <select class="admin-input ach-reward-cosmetic">${cosmeticOptions(cosmeticCategory, r.itemId)}</select>
      <select class="admin-input ach-reward-pack">${packOptions(r.packId)}</select>
      <input class="admin-input ach-reward-qty" type="number" min="1" placeholder="Qty" value="${escapeHtml(r.quantity ?? 1)}" />
      <button type="button" class="ach-admin-remove-row bg-surface-700 px-2 py-1 rounded text-xs">Remove</button>
    </div>
  `;
}

function conditionHtml(c = {}) {
  return `
    <div class="ach-admin-condition-block" data-ach-condition-row>
      <label class="text-xs text-surface-400 block">Reach stat
        <select class="admin-input ach-cond-stat w-full mt-1">${statOptions(c.stat || 'packsOpened')}</select>
      </label>
      <label class="text-xs text-surface-400 block mt-2">Target value
        <input class="admin-input ach-cond-value w-full mt-1" type="number" min="1" value="${escapeHtml(c.value ?? 1)}" />
      </label>
      <p class="text-[10px] text-surface-500 mt-1">Unlocks when stat is greater than or equal to this value.</p>
    </div>
  `;
}

function editorHtml(definition) {
  const isEdit = Boolean(definition);
  const def = definition || {
    enabled: true,
    hidden: false,
    name: '',
    description: '',
    icon: { emoji: '' },
    conditions: [{ stat: 'packsOpened', op: 'gte', value: 1 }],
    rewards: [{ type: 'rp', amount: 25 }],
  };

  const primary = def.conditions?.[0] || { stat: 'packsOpened', value: 1 };
  const rewards = (def.rewards?.length ? def.rewards : [{ type: 'rp', amount: 25 }])
    .map(rewardRowHtml).join('');

  return `
    <section class="bg-surface-900 rounded-xl border border-surface-700 p-4 space-y-3" id="ach-admin-editor">
      <h4 class="font-semibold">${isEdit ? 'Edit Achievement' : 'Create New Achievement'}</h4>
      <div class="grid grid-cols-1 gap-3">
        <label class="text-xs text-surface-400">Title
          <input id="ach-admin-name" class="admin-input w-full mt-1" value="${escapeHtml(def.name)}" placeholder="First Trade" />
        </label>
        <label class="text-xs text-surface-400">Description
          <textarea id="ach-admin-desc" class="admin-input w-full mt-1" rows="2" placeholder="Complete your first trade.">${escapeHtml(def.description)}</textarea>
        </label>
        <label class="text-xs text-surface-400">Emoji (optional)
          <input id="ach-admin-emoji" class="admin-input w-full mt-1" value="${escapeHtml(def.icon?.emoji || '')}" placeholder="🏆" />
        </label>
        <div class="grid grid-cols-2 gap-3">
          <label class="text-xs text-surface-400">Enabled
            <select id="ach-admin-enabled" class="admin-input w-full mt-1">
              <option value="true"${def.enabled ? ' selected' : ''}>Yes</option>
              <option value="false"${!def.enabled ? ' selected' : ''}>No</option>
            </select>
          </label>
          <label class="text-xs text-surface-400">Hidden
            <select id="ach-admin-hidden" class="admin-input w-full mt-1">
              <option value="false"${!def.hidden ? ' selected' : ''}>No</option>
              <option value="true"${def.hidden ? ' selected' : ''}>Yes</option>
            </select>
          </label>
        </div>
      </div>
      <div>
        <span class="text-sm font-medium">Condition</span>
        ${conditionHtml(primary)}
      </div>
      <div>
        <div class="flex justify-between items-center mb-2">
          <span class="text-sm font-medium">Rewards</span>
          <button type="button" id="ach-admin-add-reward" class="text-xs bg-surface-700 px-2 py-1 rounded">Add reward</button>
        </div>
        <p class="text-[10px] text-surface-500 mb-2">Cosmetic rewards unlock only — never auto-equip.</p>
        <div id="ach-admin-rewards" class="space-y-2">${rewards}</div>
      </div>
      <div class="flex gap-2 flex-wrap">
        <button type="button" id="ach-admin-save" class="bg-primary-600 px-4 py-2 rounded text-sm">Save</button>
        ${isEdit ? '<button type="button" id="ach-admin-cancel-edit" class="bg-surface-700 px-4 py-2 rounded text-sm">Cancel edit</button>' : ''}
        ${isEdit ? '<button type="button" id="ach-admin-delete" class="bg-red-700 px-4 py-2 rounded text-sm">Delete</button>' : ''}
      </div>
    </section>
  `;
}

function updateRewardRowVisibility(row) {
  const type = row.querySelector('.ach-reward-type')?.value || 'rp';
  row.dataset.rewardType = type;
  row.querySelector('.ach-reward-amount')?.classList.toggle('hidden', type !== 'rp');
  row.querySelector('.ach-reward-consumable')?.classList.toggle('hidden', type !== 'consumable');
  row.querySelector('.ach-reward-cosmetic-category')?.classList.toggle('hidden', type !== 'cosmetic');
  row.querySelector('.ach-reward-cosmetic')?.classList.toggle('hidden', type !== 'cosmetic');
  row.querySelector('.ach-reward-pack')?.classList.toggle('hidden', type !== 'pack');
  const showQty = type === 'consumable' || type === 'pack';
  row.querySelector('.ach-reward-qty')?.classList.toggle('hidden', !showQty);
}

function navigationListHtml(definitions) {
  if (!definitions.length) return '<p class="text-surface-500 text-sm">No achievements yet. Create one above.</p>';
  return `
    <ul class="ach-admin-nav-list space-y-2">
      ${definitions.map(d => `
        <li class="ach-admin-nav-item${editingId === d.id ? ' ach-admin-nav-item-active' : ''}">
          <div class="ach-admin-nav-body">
            <div class="ach-admin-nav-title">${escapeHtml(d.name)}</div>
            <div class="ach-admin-nav-desc">${escapeHtml(truncateText(d.description))}</div>
            <div class="ach-admin-nav-meta">
              <span class="${d.enabled ? 'text-green-400' : 'text-surface-500'}">${d.enabled ? 'Enabled' : 'Disabled'}</span>
              <span>·</span>
              <span class="${d.hidden ? 'text-amber-400' : 'text-surface-400'}">${d.hidden ? 'Hidden' : 'Visible'}</span>
            </div>
          </div>
          <button type="button" class="ach-admin-edit-btn text-xs bg-surface-700 px-2 py-1 rounded" data-id="${escapeHtml(d.id)}">Edit</button>
        </li>
      `).join('')}
    </ul>
  `;
}

function lockedOrderListHtml(definitions) {
  if (!definitions.length) return '';
  return `
    <div class="ach-admin-order-block">
      <div class="mb-2">
        <span class="text-sm font-medium">Locked achievement display order</span>
        <p class="text-[10px] text-surface-500 mt-0.5">Drag to reorder how locked (visible) achievements appear for players. Does not affect unlocked or starred order.</p>
      </div>
      <ul id="ach-admin-sortable-list" class="ach-admin-sortable space-y-1">
        ${definitions.map(d => `
          <li class="ach-admin-sort-item" draggable="true" data-id="${escapeHtml(d.id)}">
            <span class="ach-admin-drag-handle" aria-hidden="true">⋮⋮</span>
            <span class="ach-admin-sort-name">${escapeHtml(d.name)}</span>
            <span class="text-[10px] text-surface-500">${d.hidden ? 'hidden' : 'visible'}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  `;
}

function wireEditor(container) {
  const editor = container.querySelector('#ach-admin-editor');
  if (!editor) return;

  editor.querySelectorAll('[data-ach-reward-row]').forEach(updateRewardRowVisibility);

  editor.querySelector('#ach-admin-add-reward')?.addEventListener('click', () => {
    editor.querySelector('#ach-admin-rewards')?.insertAdjacentHTML('beforeend', rewardRowHtml());
    const rows = editor.querySelectorAll('[data-ach-reward-row]');
    updateRewardRowVisibility(rows[rows.length - 1]);
  });

  editor.addEventListener('change', e => {
    const row = e.target?.closest('[data-ach-reward-row]');
    if (!row) return;
    if (e.target?.classList?.contains('ach-reward-type')) {
      updateRewardRowVisibility(row);
    }
    if (e.target?.classList?.contains('ach-reward-cosmetic-category')) {
      refreshRewardRowCosmeticSelect(row);
    }
  });

  editor.addEventListener('click', e => {
    if (e.target?.classList?.contains('ach-admin-remove-row')) {
      e.target.closest('.ach-admin-row')?.remove();
    }
  });

  editor.querySelector('#ach-admin-save')?.addEventListener('click', () => {
    const config = getAchievementConfig();
    const existingDef = editingId ? config.definitions[editingId] : null;
    const def = readFormDefinition(editor, existingDef);
    const validation = validateAchievementDefinition(def);
    if (!validation.valid) {
      toast.error(`Invalid definition: ${validation.reason}`);
      return;
    }
    saveAchievementDefinition(def);
    toast.success('Achievement saved.');
    editingId = null;
    renderAchievementsAdminPanel(container);
  });

  editor.querySelector('#ach-admin-cancel-edit')?.addEventListener('click', () => {
    editingId = null;
    renderAchievementsAdminPanel(container);
  });

  editor.querySelector('#ach-admin-delete')?.addEventListener('click', async () => {
    if (!editingId) return;
    const config = getAchievementConfig();
    const def = config.definitions[editingId];
    const title = def?.name || editingId;
    const confirmed = await confirmDialog(
      `Delete achievement "${title}"?\nThis cannot be undone.`,
      'Delete achievement?'
    );
    if (!confirmed) return;

    const result = deleteAchievementDefinition(editingId);
    if (!result.success) {
      toast.error(result.reason === 'delete_failed' ? 'Achievement could not be removed. Try again.' : 'Could not delete achievement.');
      return;
    }
    toast.success('Achievement deleted.');
    editingId = null;
    renderAchievementsAdminPanel(container);
  });
}

function wireSortableList(container) {
  const list = container.querySelector('#ach-admin-sortable-list');
  if (!list) return;

  let dragId = null;

  list.querySelectorAll('.ach-admin-sort-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      dragId = item.dataset.id;
      item.classList.add('ach-admin-sort-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('ach-admin-sort-dragging');
      dragId = null;
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const over = e.currentTarget;
      if (!dragId || over.dataset.id === dragId) return;
      const dragging = list.querySelector(`[data-id="${dragId}"]`);
      if (!dragging) return;
      const rect = over.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      if (before) list.insertBefore(dragging, over);
      else list.insertBefore(dragging, over.nextSibling);
    });
    item.addEventListener('drop', e => {
      e.preventDefault();
      const orderedIds = [...list.querySelectorAll('.ach-admin-sort-item')].map(li => li.dataset.id);
      saveAchievementSortOrder(orderedIds);
      toast.success('Locked display order saved.');
    });
  });
}

export function renderAchievementsAdminPanel(container) {
  const target = container || document.getElementById('achievements-admin-panel');
  if (!target) return;
  container = target;

  const config = getAchievementConfig();
  const definitions = listAchievementDefinitions();
  const current = editingId ? config.definitions[editingId] : null;

  container.innerHTML = `
    <section class="bg-surface-900 rounded-xl border border-surface-700 p-6 space-y-4">
      <div class="flex justify-between items-center">
        <div>
          <h3 class="font-semibold">Achievements</h3>
          <p class="text-xs text-surface-500">System ${config.meta.enabled === false ? 'disabled' : 'enabled'} · ${definitions.length} definition(s)</p>
        </div>
        ${editingId ? '<button type="button" id="ach-admin-new" class="bg-surface-700 px-3 py-2 rounded text-sm">Create new</button>' : ''}
      </div>
      ${editorHtml(current)}
      <div class="ach-admin-list-block">
        <h4 class="text-sm font-medium mb-2">All achievements</h4>
        ${navigationListHtml(definitions)}
      </div>
      ${lockedOrderListHtml(definitions)}
    </section>
  `;

  container.querySelector('#ach-admin-new')?.addEventListener('click', () => {
    editingId = null;
    renderAchievementsAdminPanel(container);
  });

  container.querySelectorAll('.ach-admin-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      editingId = btn.dataset.id;
      renderAchievementsAdminPanel(container);
    });
  });

  wireSortableList(container);
  wireEditor(container);
}
