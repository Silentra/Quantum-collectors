/**
 * cosmetics-admin.js — Admin cosmetic governance (registry-backed).
 * Titles: full CRUD. Static cosmetics: acquisition/governance fields only (visuals in CSS).
 */

import * as toast from './toast.js';
import { ITEM_CATEGORIES, ITEM_RARITIES } from './shop-definitions.js';
import {
  ADMIN_COSMETIC_GRANT_CATEGORY_NAV,
  ADMIN_STATIC_COSMETIC_TAB_MAP,
  deleteTitleDefinition,
  getCosmeticCategoryAdminLabel,
  getCosmeticDefinition,
  listStaticCosmeticsByCategory,
  listTitleDefinitions,
  saveCosmeticGovernanceOverride,
  saveTitleDefinition,
  TITLE_DISPLAY_NAME_MAX_LENGTH,
} from './cosmetic-definitions.js';

let editingTitleId = null;
let activeCategory = 'titles';

const STATIC_CATEGORY_INTRO = Object.freeze({
  banners: 'Banner visuals are code/CSS-authored. Edit shop and achievement eligibility here only.',
  backgrounds: 'Background visuals are code/CSS-authored (solid colors in CSS). Edit acquisition/governance fields here.',
  glow: 'Glow cosmetics use runtime category aura. Visuals are code-authored; edit governance fields here.',
  borders: 'Border visuals are code-authored. Edit acquisition/governance fields here.',
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatLabel(value) {
  if (!value || typeof value !== 'string') return '';
  return value.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function boolSelect(className, value) {
  const yes = value !== false ? ' selected' : '';
  const no = value === false ? ' selected' : '';
  return `
    <select class="admin-input w-full ${className}">
      <option value="true"${yes}>Yes</option>
      <option value="false"${no}>No</option>
    </select>
  `;
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

function rarityOptions(selected) {
  return Object.values(ITEM_RARITIES)
    .map(r => `<option value="${escapeHtml(r)}"${r === selected ? ' selected' : ''}>${escapeHtml(formatLabel(r))}</option>`)
    .join('');
}

function placeholderPanel(title, body) {
  return `
    <section class="bg-surface-900 rounded-xl border border-surface-700 p-5">
      <h4 class="font-semibold mb-2">${escapeHtml(title)}</h4>
      <p class="text-sm text-surface-400">${escapeHtml(body)}</p>
    </section>
  `;
}

function titlesListHtml(titles) {
  if (!titles.length) {
    return '<p class="text-surface-500 text-sm">No title cosmetics yet. Create one below.</p>';
  }
  return `
    <div class="divide-y divide-surface-700 border border-surface-700 rounded-lg overflow-hidden">
      ${titles.map(t => `
        <div class="flex flex-wrap items-center justify-between gap-2 p-3 bg-surface-900/80">
          <div class="min-w-0">
            <div class="font-medium truncate">${escapeHtml(t.name)}</div>
            <div class="text-xs text-surface-500 font-mono">${escapeHtml(t.id)}</div>
            <div class="text-xs text-surface-400 mt-1">
              ${escapeHtml(formatLabel(t.rarity))}
              · ${t.source === 'admin' ? 'Admin' : 'Static'}
              · ${t.enabled ? 'Enabled' : 'Disabled'}
              ${t.deleted ? ' · <span class="text-red-400">Deleted</span>' : ''}
              ${t.shopEnabled ? ' · Shop' : ''}
              ${t.achievementEnabled !== false ? ' · Achievements' : ''}
            </div>
          </div>
          <div class="flex gap-2 flex-shrink-0">
            ${t.source === 'admin' && !t.deleted ? `
              <button type="button" class="cosmetics-edit-btn text-xs bg-surface-700 px-2 py-1 rounded" data-id="${escapeHtml(t.id)}">Edit</button>
              <button type="button" class="cosmetics-delete-btn text-xs bg-red-800 px-2 py-1 rounded" data-id="${escapeHtml(t.id)}">Delete</button>
            ` : t.deleted ? '<span class="text-xs text-surface-500">Deleted</span>' : '<span class="text-xs text-surface-500">Code-defined</span>'}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function titleEditorHtml(definition = null) {
  const isEdit = Boolean(definition);
  const def = definition || {
    name: '',
    description: '',
    rarity: ITEM_RARITIES.COMMON,
    price: 100,
    weight: 5,
    enabled: true,
    shopEnabled: true,
    achievementEnabled: true,
  };

  const previewId = isEdit ? def.id : '(generated on save)';

  return `
    <section class="bg-surface-900 rounded-xl border border-surface-700 p-4 space-y-3" id="cosmetics-title-editor">
      <h4 class="font-semibold">${isEdit ? 'Edit Title' : 'Create Title'}</h4>
      <p class="text-xs text-surface-500">Titles are text-only shell overlays. Color comes from player identity accent, not the title definition.</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="text-xs text-surface-400 sm:col-span-2">Display name (max ${TITLE_DISPLAY_NAME_MAX_LENGTH}, unique)
          <input id="cosmetics-title-name" class="admin-input w-full mt-1" value="${escapeHtml(def.name)}" maxlength="${TITLE_DISPLAY_NAME_MAX_LENGTH}" />
        </label>
        <label class="text-xs text-surface-400 sm:col-span-2">Description (admin only)
          <input id="cosmetics-title-desc" class="admin-input w-full mt-1" value="${escapeHtml(def.description || '')}" />
        </label>
        <label class="text-xs text-surface-400">ID (immutable)
          <input class="admin-input w-full mt-1 bg-surface-800 text-surface-500" readonly value="${escapeHtml(previewId)}" />
        </label>
        <label class="text-xs text-surface-400">Rarity
          <select id="cosmetics-title-rarity" class="admin-input w-full mt-1">${rarityOptions(def.rarity)}</select>
        </label>
        <label class="text-xs text-surface-400">Shop price (RP)
          <input id="cosmetics-title-price" type="number" min="0" class="admin-input w-full mt-1" value="${escapeHtml(def.price ?? 0)}" />
        </label>
        <label class="text-xs text-surface-400">Shop weight
          <input id="cosmetics-title-weight" type="number" min="0" step="any" class="admin-input w-full mt-1" value="${escapeHtml(def.weight ?? 0)}" />
        </label>
        <label class="text-xs text-surface-400">Enabled
          ${boolSelect('cosmetics-title-enabled-select', def.enabled !== false)}
        </label>
        <label class="text-xs text-surface-400">Shop enabled
          ${boolSelect('cosmetics-title-shop-enabled-select', def.shopEnabled !== false)}
        </label>
        <label class="text-xs text-surface-400">Achievement rewards
          ${boolSelect('cosmetics-title-ach-enabled-select', def.achievementEnabled !== false)}
        </label>
      </div>
      <div class="flex gap-2 flex-wrap">
        <button type="button" id="cosmetics-title-save" class="bg-primary-600 px-4 py-2 rounded text-sm">Save</button>
        ${isEdit ? '<button type="button" id="cosmetics-title-cancel" class="bg-surface-700 px-4 py-2 rounded text-sm">Cancel</button>' : ''}
      </div>
    </section>
  `;
}

function readTitleForm(editor) {
  return {
    name: editor.querySelector('#cosmetics-title-name')?.value,
    description: editor.querySelector('#cosmetics-title-desc')?.value,
    rarity: editor.querySelector('#cosmetics-title-rarity')?.value,
    price: Number(editor.querySelector('#cosmetics-title-price')?.value),
    weight: Number(editor.querySelector('#cosmetics-title-weight')?.value),
    enabled: editor.querySelector('.cosmetics-title-enabled-select')?.value === 'true',
    shopEnabled: editor.querySelector('.cosmetics-title-shop-enabled-select')?.value === 'true',
    achievementEnabled: editor.querySelector('.cosmetics-title-ach-enabled-select')?.value === 'true',
  };
}

function staticCosmeticsPanelHtml(categoryKey, runtimeCategory) {
  const items = listStaticCosmeticsByCategory(runtimeCategory);
  const label = getCosmeticCategoryAdminLabel(runtimeCategory);
  const intro = STATIC_CATEGORY_INTRO[categoryKey] || 'Visuals are code-authored. Edit governance fields only.';

  if (!items.length) {
    return `
      <section class="space-y-3">
        <p class="text-sm text-surface-400">${escapeHtml(intro)}</p>
        <p class="text-surface-500 text-sm">No static ${escapeHtml(label.toLowerCase())} cosmetics defined yet.</p>
      </section>
    `;
  }

  const rows = items.map(definition => `
    <tr class="border-t border-surface-800" data-cosmetic-id="${escapeHtml(definition.id)}">
      <td class="py-2 pr-3 align-top">
        <div class="font-medium text-sm">${escapeHtml(definition.name || definition.id)}</div>
        <div class="text-xs text-surface-500 font-mono">${escapeHtml(definition.id)}</div>
        <div class="text-xs text-surface-500 mt-1">Static · code-defined visuals</div>
      </td>
      <td class="py-2 pr-3 align-top">${boolSelect('cosm-gov-enabled', definition.enabled !== false)}</td>
      <td class="py-2 pr-3 align-top">${boolSelect('cosm-gov-shop-enabled', definition.shopEnabled !== false)}</td>
      <td class="py-2 pr-3 align-top">${boolSelect('cosm-gov-ach-enabled', definition.achievementEnabled !== false)}</td>
      <td class="py-2 pr-3 align-top">
        <select class="admin-input w-full cosm-gov-rarity">${rarityOptions(definition.rarity)}</select>
      </td>
      <td class="py-2 pr-3 align-top">
        <input type="number" min="0" class="admin-input w-24 cosm-gov-price" value="${escapeHtml(definition.price ?? 0)}">
      </td>
      <td class="py-2 pr-3 align-top">
        <input type="number" min="0" step="any" class="admin-input w-24 cosm-gov-weight" value="${escapeHtml(definition.weight ?? 0)}">
      </td>
      <td class="py-2 align-top text-right">
        <button type="button" class="cosmetics-gov-save bg-primary-600 hover:bg-primary-500 px-3 py-1.5 rounded text-xs font-medium">Save</button>
      </td>
    </tr>
  `).join('');

  return `
    <section class="space-y-3">
      <p class="text-sm text-surface-400">${escapeHtml(intro)}</p>
      <div class="overflow-x-auto border border-surface-700 rounded-lg">
        <table class="w-full text-left text-sm">
          <thead class="text-xs text-surface-500 uppercase bg-surface-900/80">
            <tr>
              <th class="p-3 pr-3">Cosmetic</th>
              <th class="p-3 pr-3">Enabled</th>
              <th class="p-3 pr-3">Shop</th>
              <th class="p-3 pr-3">Achievements</th>
              <th class="p-3 pr-3">Rarity</th>
              <th class="p-3 pr-3">Price</th>
              <th class="p-3 pr-3">Weight</th>
              <th class="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function titlesPanelHtml() {
  const titles = listTitleDefinitions();
  const editingDef = editingTitleId
    ? (titles.find(t => t.id === editingTitleId) || getCosmeticDefinition(editingTitleId))
    : null;

  return `
    <div class="space-y-4">
      ${titleEditorHtml(editingDef)}
      <section>
        <h4 class="font-semibold mb-2">All titles</h4>
        ${titlesListHtml(titles)}
      </section>
    </div>
  `;
}

function readStaticGovernanceRow(row) {
  return {
    enabled: row.querySelector('.cosm-gov-enabled')?.value === 'true',
    shopEnabled: row.querySelector('.cosm-gov-shop-enabled')?.value === 'true',
    achievementEnabled: row.querySelector('.cosm-gov-ach-enabled')?.value === 'true',
    rarity: row.querySelector('.cosm-gov-rarity')?.value,
    price: Number(row.querySelector('.cosm-gov-price')?.value || 0),
    weight: Number(row.querySelector('.cosm-gov-weight')?.value || 0),
  };
}

function wireTitlesPanel(container) {
  const editor = container.querySelector('#cosmetics-title-editor');
  if (!editor) return;

  editor.querySelector('#cosmetics-title-save')?.addEventListener('click', () => {
    const raw = readTitleForm(editor);
    const result = saveTitleDefinition(raw, editingTitleId);
    if (!result.success) {
      const msg = {
        duplicate_title_name: 'A title with that display name already exists.',
        invalid_name: 'Title display name is required.',
        id_immutable: 'Title id cannot be changed.',
      }[result.reason] || result.reason || 'Save failed.';
      toast.error(msg);
      return;
    }
    toast.success(editingTitleId ? 'Title updated.' : 'Title created.');
    editingTitleId = null;
    renderCosmeticsAdminPanel(container);
  });

  editor.querySelector('#cosmetics-title-cancel')?.addEventListener('click', () => {
    editingTitleId = null;
    renderCosmeticsAdminPanel(container);
  });

  container.querySelectorAll('.cosmetics-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      editingTitleId = btn.dataset.id;
      renderCosmeticsAdminPanel(container);
    });
  });

  container.querySelectorAll('.cosmetics-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const def = getCosmeticDefinition(id);
      const confirmed = await confirmDialog(
        `Delete title "${def?.name || id}"?\nPlayers who own it keep ownership, but it cannot be equipped or granted.`,
        'Delete title?'
      );
      if (!confirmed) return;
      const result = deleteTitleDefinition(id);
      if (!result.success) {
        toast.error('Could not delete title.');
        return;
      }
      toast.success('Title deleted.');
      if (editingTitleId === id) editingTitleId = null;
      renderCosmeticsAdminPanel(container);
    });
  });
}

function wireStaticCosmeticsPanel(container) {
  container.querySelectorAll('.cosmetics-gov-save').forEach(button => {
    button.addEventListener('click', () => {
      const row = button.closest('[data-cosmetic-id]');
      const itemId = row?.dataset.cosmeticId;
      if (!itemId) return;
      const result = saveCosmeticGovernanceOverride(itemId, readStaticGovernanceRow(row));
      if (!result.success) {
        toast.error('Could not save cosmetic settings.');
        return;
      }
      toast.success('Cosmetic settings saved.');
      renderCosmeticsAdminPanel(container);
    });
  });
}

function renderCategoryContent(container) {
  const content = container.querySelector('#cosmetics-admin-content');
  if (!content) return;

  if (activeCategory === 'titles') {
    content.innerHTML = titlesPanelHtml();
    wireTitlesPanel(container);
    return;
  }

  if (activeCategory === 'shimmer') {
    content.innerHTML = placeholderPanel(
      'Shimmer',
      'Shimmer is a future card effect category. Not available in admin yet.'
    );
    return;
  }

  const runtimeCategory = ADMIN_STATIC_COSMETIC_TAB_MAP[activeCategory];
  if (runtimeCategory) {
    content.innerHTML = staticCosmeticsPanelHtml(activeCategory, runtimeCategory);
    wireStaticCosmeticsPanel(container);
    return;
  }

  content.innerHTML = placeholderPanel(formatLabel(activeCategory), 'Coming soon.');
}

export function renderCosmeticsAdminPanel(container = document.getElementById('cosmetics-admin-panel')) {
  if (!container) return;

  const navItems = ADMIN_COSMETIC_GRANT_CATEGORY_NAV.map(({ id, label }) => ({ id, label }));

  container.innerHTML = `
    <div class="space-y-4">
      <div>
        <h3 class="text-lg font-semibold">Cosmetics</h3>
        <p class="text-sm text-surface-400">Manage cosmetic acquisition and shop eligibility. Visual rendering remains code/CSS-authored. Titles support full admin CRUD; static cosmetics support governance fields only.</p>
      </div>
      <div class="flex flex-wrap gap-2" id="cosmetics-category-nav">
        ${navItems.map(item => `
          <button type="button" class="cosmetics-cat-btn text-sm px-3 py-1.5 rounded-lg border ${item.id === activeCategory ? 'bg-primary-600 border-primary-500' : 'bg-surface-800 border-surface-600'}" data-cat="${escapeHtml(item.id)}">${escapeHtml(item.label)}</button>
        `).join('')}
      </div>
      <div id="cosmetics-admin-content"></div>
    </div>
  `;

  container.querySelectorAll('.cosmetics-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.cat;
      editingTitleId = null;
      renderCosmeticsAdminPanel(container);
    });
  });

  renderCategoryContent(container);
}
