/**
 * achievements-admin.js — Admin CRUD for achievement definitions.
 */

import * as toast from './toast.js';
import {
  CONDITION_MODES,
  CONDITION_OPS,
  REWARD_TYPES,
  deleteAchievementDefinition,
  getAchievementConfig,
  listAchievementDefinitions,
  saveAchievementDefinition,
} from './achievement-config.js';
import { listRegisteredStatKeys } from './achievement-stats.js';
import { validateAchievementDefinition } from './achievement-validation.js';

let editingId = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readFormDefinition(root) {
  const conditions = [];
  root.querySelectorAll('[data-ach-condition-row]').forEach(row => {
    conditions.push({
      stat: row.querySelector('.ach-cond-stat')?.value,
      op: row.querySelector('.ach-cond-op')?.value,
      value: Number(row.querySelector('.ach-cond-value')?.value),
    });
  });

  const rewards = [];
  root.querySelectorAll('[data-ach-reward-row]').forEach(row => {
    const type = row.querySelector('.ach-reward-type')?.value;
    const reward = { type };
    if (type === 'rp') reward.amount = Number(row.querySelector('.ach-reward-amount')?.value);
    if (type === 'consumable' || type === 'cosmetic') {
      reward.itemId = row.querySelector('.ach-reward-item')?.value?.trim();
      reward.quantity = Number(row.querySelector('.ach-reward-qty')?.value || 1);
    }
    if (type === 'pack') {
      reward.packId = row.querySelector('.ach-reward-pack')?.value?.trim();
      reward.quantity = Number(row.querySelector('.ach-reward-qty')?.value || 1);
    }
    rewards.push(reward);
  });

  return {
    id: root.querySelector('#ach-admin-id')?.value?.trim(),
    enabled: root.querySelector('#ach-admin-enabled')?.value === 'true',
    hidden: root.querySelector('#ach-admin-hidden')?.value === 'true',
    name: root.querySelector('#ach-admin-name')?.value?.trim(),
    description: root.querySelector('#ach-admin-desc')?.value?.trim(),
    category: root.querySelector('#ach-admin-category')?.value?.trim() || 'general',
    sortOrder: Number(root.querySelector('#ach-admin-sort')?.value || 0),
    rarity: root.querySelector('#ach-admin-rarity')?.value || 'common',
    conditionMode: root.querySelector('#ach-admin-mode')?.value || 'all',
    icon: { emoji: root.querySelector('#ach-admin-emoji')?.value?.trim() || '🏆' },
    conditions,
    rewards,
    notifyOnUnlock: root.querySelector('#ach-admin-notify')?.value === 'true',
  };
}

function statOptions(selected) {
  return listRegisteredStatKeys()
    .map(key => `<option value="${escapeHtml(key)}"${key === selected ? ' selected' : ''}>${escapeHtml(key)}</option>`)
    .join('');
}

function opOptions(selected) {
  return CONDITION_OPS
    .map(op => `<option value="${op}"${op === selected ? ' selected' : ''}>${op}</option>`)
    .join('');
}

function conditionRowHtml(c = {}) {
  return [
    '<div class="ach-admin-row" data-ach-condition-row>',
    `<select class="admin-input ach-cond-stat">${statOptions(c.stat || 'packsOpened')}</select>`,
    `<select class="admin-input ach-cond-op">${opOptions(c.op || 'gte')}</select>`,
    `<input class="admin-input ach-cond-value" type="number" value="${escapeHtml(c.value ?? 1)}" />`,
    '<button type="button" class="ach-admin-remove-row bg-surface-700 px-2 py-1 rounded text-xs">Remove</button>',
    '</div>',
  ].join('');
}

function rewardRowHtml(r = {}) {
  const type = r.type || 'rp';
  const types = REWARD_TYPES.map(t => `<option value="${t}"${t === type ? ' selected' : ''}>${t}</option>`).join('');
  return [
    '<div class="ach-admin-row" data-ach-reward-row>',
    `<select class="admin-input ach-reward-type">${types}</select>`,
    `<input class="admin-input ach-reward-amount" type="number" placeholder="RP" value="${escapeHtml(r.amount ?? '')}" />`,
    `<input class="admin-input ach-reward-item" placeholder="itemId" value="${escapeHtml(r.itemId ?? '')}" />`,
    `<input class="admin-input ach-reward-pack" placeholder="packId" value="${escapeHtml(r.packId ?? '')}" />`,
    `<input class="admin-input ach-reward-qty" type="number" min="1" value="${escapeHtml(r.quantity ?? 1)}" />`,
    '<button type="button" class="ach-admin-remove-row bg-surface-700 px-2 py-1 rounded text-xs">Remove</button>',
    '</div>',
  ].join('');
}

function editorHtml(definition) {
  const def = definition || {
    id: '',
    enabled: true,
    hidden: false,
    name: '',
    description: '',
    category: 'general',
    sortOrder: 0,
    rarity: 'common',
    conditionMode: 'all',
    icon: { emoji: '🏆' },
    conditions: [{ stat: 'packsOpened', op: 'gte', value: 1 }],
    rewards: [{ type: 'rp', amount: 25 }],
    notifyOnUnlock: true,
  };

  const modes = CONDITION_MODES.map(m => `<option value="${m}"${m === def.conditionMode ? ' selected' : ''}>${m}</option>`).join('');
  const conditions = (def.conditions?.length ? def.conditions : [{ stat: 'packsOpened', op: 'gte', value: 1 }])
    .map(conditionRowHtml).join('');
  const rewards = (def.rewards?.length ? def.rewards : [{ type: 'rp', amount: 25 }])
    .map(rewardRowHtml).join('');

  return [
    '<section class="bg-surface-900 rounded-xl border border-surface-700 p-4 space-y-3" id="ach-admin-editor">',
    `<h4 class="font-semibold">${definition ? 'Edit Achievement' : 'New Achievement'}</h4>`,
    '<div class="grid grid-cols-1 md:grid-cols-2 gap-3">',
    `<label class="text-xs text-surface-400">ID<input id="ach-admin-id" class="admin-input w-full" value="${escapeHtml(def.id)}"${definition ? ' readonly' : ''}></label>`,
    `<label class="text-xs text-surface-400">Name<input id="ach-admin-name" class="admin-input w-full" value="${escapeHtml(def.name)}"></label>`,
    `<label class="text-xs text-surface-400 md:col-span-2">Description<textarea id="ach-admin-desc" class="admin-input w-full" rows="2">${escapeHtml(def.description)}</textarea></label>`,
    `<label class="text-xs text-surface-400">Category<input id="ach-admin-category" class="admin-input w-full" value="${escapeHtml(def.category)}"></label>`,
    `<label class="text-xs text-surface-400">Sort<input id="ach-admin-sort" type="number" class="admin-input w-full" value="${escapeHtml(def.sortOrder)}"></label>`,
    `<label class="text-xs text-surface-400">Rarity<input id="ach-admin-rarity" class="admin-input w-full" value="${escapeHtml(def.rarity)}"></label>`,
    `<label class="text-xs text-surface-400">Emoji<input id="ach-admin-emoji" class="admin-input w-full" value="${escapeHtml(def.icon?.emoji || '🏆')}"></label>`,
    `<label class="text-xs text-surface-400">Enabled<select id="ach-admin-enabled" class="admin-input w-full"><option value="true"${def.enabled ? ' selected' : ''}>Yes</option><option value="false"${!def.enabled ? ' selected' : ''}>No</option></select></label>`,
    `<label class="text-xs text-surface-400">Hidden<select id="ach-admin-hidden" class="admin-input w-full"><option value="false"${!def.hidden ? ' selected' : ''}>No</option><option value="true"${def.hidden ? ' selected' : ''}>Yes</option></select></label>`,
    `<label class="text-xs text-surface-400">Mode<select id="ach-admin-mode" class="admin-input w-full">${modes}</select></label>`,
    `<label class="text-xs text-surface-400">Notify<select id="ach-admin-notify" class="admin-input w-full"><option value="true"${def.notifyOnUnlock ? ' selected' : ''}>Yes</option><option value="false"${!def.notifyOnUnlock ? ' selected' : ''}>No</option></select></label>`,
    '</div>',
    '<div><div class="flex justify-between items-center"><span class="text-sm font-medium">Conditions</span><button type="button" id="ach-admin-add-condition" class="text-xs bg-surface-700 px-2 py-1 rounded">Add</button></div>',
    `<div id="ach-admin-conditions" class="space-y-2 mt-2">${conditions}</div></div>`,
    '<div><div class="flex justify-between items-center"><span class="text-sm font-medium">Rewards</span><button type="button" id="ach-admin-add-reward" class="text-xs bg-surface-700 px-2 py-1 rounded">Add</button></div>',
    '<p class="text-[10px] text-surface-500">Cosmetic rewards unlock only — never auto-equip.</p>',
    `<div id="ach-admin-rewards" class="space-y-2 mt-2">${rewards}</div></div>`,
    '<div class="flex gap-2">',
    '<button type="button" id="ach-admin-save" class="bg-primary-600 px-4 py-2 rounded text-sm">Save</button>',
    definition ? '<button type="button" id="ach-admin-delete" class="bg-red-700 px-4 py-2 rounded text-sm">Delete</button>' : '',
    '</div>',
    '</section>',
  ].join('');
}

function wireEditor(container) {
  const editor = container.querySelector('#ach-admin-editor');
  if (!editor) return;

  editor.querySelector('#ach-admin-add-condition')?.addEventListener('click', () => {
    editor.querySelector('#ach-admin-conditions')?.insertAdjacentHTML('beforeend', conditionRowHtml());
  });
  editor.querySelector('#ach-admin-add-reward')?.addEventListener('click', () => {
    editor.querySelector('#ach-admin-rewards')?.insertAdjacentHTML('beforeend', rewardRowHtml());
  });
  editor.addEventListener('click', e => {
    if (e.target?.classList?.contains('ach-admin-remove-row')) {
      e.target.closest('.ach-admin-row')?.remove();
    }
  });
  editor.querySelector('#ach-admin-save')?.addEventListener('click', () => {
    const def = readFormDefinition(editor);
    const validation = validateAchievementDefinition(def);
    if (!validation.valid) {
      toast.error(`Invalid definition: ${validation.reason}`);
      return;
    }
    saveAchievementDefinition(def);
    toast.success('Achievement saved.');
    editingId = def.id;
    renderAchievementsAdminPanel(container);
  });
  editor.querySelector('#ach-admin-delete')?.addEventListener('click', () => {
    if (!editingId) return;
    deleteAchievementDefinition(editingId);
    toast.success('Achievement deleted.');
    editingId = null;
    renderAchievementsAdminPanel(container);
  });
}

function listHtml(definitions) {
  if (!definitions.length) return '<p class="text-surface-500 text-sm">No achievements defined.</p>';
  return `<ul class="space-y-2">${definitions.map(d => `
    <li class="flex justify-between items-center bg-surface-800 border border-surface-700 rounded-lg px-3 py-2">
      <div>
        <div class="font-medium text-sm">${escapeHtml(d.name)} <span class="text-surface-500">(${escapeHtml(d.id)})</span></div>
        <div class="text-xs text-surface-500">${d.enabled ? 'Enabled' : 'Disabled'} · ${d.hidden ? 'Hidden' : 'Visible'} · ${escapeHtml(d.category)}</div>
      </div>
      <button type="button" class="ach-admin-edit-btn text-xs bg-surface-700 px-2 py-1 rounded" data-id="${escapeHtml(d.id)}">Edit</button>
    </li>
  `).join('')}</ul>`;
}

export function renderAchievementsAdminPanel(container) {
  const target = container || document.getElementById('achievements-admin-panel');
  if (!target) return;
  container = target;
  const config = getAchievementConfig();
  const definitions = listAchievementDefinitions();
  const current = editingId ? config.definitions[editingId] : null;

  container.innerHTML = [
    '<section class="bg-surface-900 rounded-xl border border-surface-700 p-6 space-y-4">',
    '<div class="flex justify-between items-center">',
    '<div><h3 class="font-semibold">Achievements</h3>',
    `<p class="text-xs text-surface-500">System ${config.meta.enabled === false ? 'disabled' : 'enabled'} · ${definitions.length} definition(s)</p></div>`,
    '<button type="button" id="ach-admin-new" class="bg-primary-600 px-3 py-2 rounded text-sm">New</button>',
    '</div>',
    listHtml(definitions),
    editorHtml(current),
    '</section>',
  ].join('');

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
  wireEditor(container);
}
