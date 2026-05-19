/**
 * shop-admin.js
 * =============
 * Future admin economy/config UI boundary.
 *
 * This module will provide admin-only panels for configuring and
 * managing the shop economy. All rendering targets a dedicated
 * admin container — it does NOT touch or refactor ui.cleaned.js.
 *
 * Architectural decisions (finalized):
 * - Config-driven economy: all shop behavior (weights, costs, constraints)
 *   is driven by shop-config.js values, not hard-coded logic. Admin panels
 *   read and write to that config layer.
 * - Admin-adjustable weights: item generation weights can be tuned per-item
 *   from the admin panel without code changes.
 * - Admin-adjustable reroll costs: reroll RP costs are configurable per
 *   reroll type (shop_reroll, cosmetic_reroll, etc.) from the admin UI.
 * - Slot constraint controls: admins can adjust minimumCosmeticSlots,
 *   minimumUtilitySlots, maximumPackAndCardSlots, and shopSlotCount.
 * - Item enable/disable behavior: individual items can be toggled on/off
 *   from the admin panel. Disabled items are excluded from generation
 *   but remain in definitions for historical data integrity.
 *
 * Dependencies (future):
 *   - js/shop-config.js       (DEFAULT_SHOP_CONFIG for reading/writing economy values)
 *   - js/shop-definitions.js  (ITEM_DEFINITIONS for item listing and weight editing)
 *
 * NO admin rendering, gameplay logic, Firebase mutations, or ui.cleaned.js refactors in this file.
 */

import * as toast from './toast.js';
import { ITEM_RARITIES } from './shop-definitions.js';
import {
  ALL_RARITIES,
  DEFAULT_SHOP_CONFIG,
  getShopConfig,
  getShopItemDefinitions,
  resetShopConfigOverrides,
  saveShopConfig,
  saveShopItemOverride,
} from './shop-config.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatLabel(value) {
  if (!value || typeof value !== 'string') return 'Unknown';
  return value.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function numberValue(id, fallback = 0) {
  const value = Number(document.getElementById(id)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function boolValue(id) {
  return document.getElementById(id)?.value === 'true';
}

function renderNumberField(id, label, value, options = {}) {
  return `
    <label class="block">
      <span class="text-xs text-surface-400 block mb-1">${escapeHtml(label)}</span>
      <input id="${escapeHtml(id)}" type="number" step="${escapeHtml(options.step ?? '1')}" min="${escapeHtml(options.min ?? '0')}" value="${escapeHtml(value)}" class="admin-input w-full">
    </label>
  `;
}

function renderSelect(id, label, value, options) {
  return `
    <label class="block">
      <span class="text-xs text-surface-400 block mb-1">${escapeHtml(label)}</span>
      <select id="${escapeHtml(id)}" class="admin-input w-full">
        ${options.map(option => `<option value="${escapeHtml(option.value)}" ${String(value) === String(option.value) ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
      </select>
    </label>
  `;
}

function renderShopEconomyConfig(config) {
  return `
    <section class="bg-surface-900 rounded-xl border border-surface-700 p-6">
      <div class="flex items-center justify-between gap-3 mb-4">
        <div>
          <h3 class="font-semibold">Shop Economy Balance</h3>
          <p class="text-xs text-surface-500 mt-1">Persists admin overrides under config/shop.</p>
        </div>
        <div class="flex gap-2">
          <button id="shop-admin-reset" class="bg-amber-700 hover:bg-amber-600 px-4 py-2 rounded-lg font-medium text-xs transition">Reset Overrides</button>
          <button id="shop-admin-save-config" class="bg-primary-600 hover:bg-primary-500 px-5 py-2 rounded-lg font-medium text-sm transition">Save Shop Config</button>
        </div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label class="text-xs text-surface-400 block mb-1">Shop Rotation Refresh</label>
          <p class="text-xs text-surface-300 bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 leading-relaxed">
            Shop rotations refresh on the <strong>weekly schedule</strong> configured in Admin → Project Balance → Weekly Reward Pack (day and hour). No separate shop timer.
          </p>
        </div>
        ${renderNumberField('shop-cfg-slot-count', 'Shop Slot Count', config.shopSlotCount, { min: '3' })}
        ${renderNumberField('shop-cfg-min-cosmetics', 'Minimum Cosmetic Slots', config.minimumCosmeticSlots)}
        ${renderNumberField('shop-cfg-min-utility', 'Minimum Utility Slots', config.minimumUtilitySlots)}
        ${renderNumberField('shop-cfg-max-card-slots', 'Max Card Slots', config.maxCardSlots ?? config.maximumPackAndCardSlots ?? 1)}
        ${renderNumberField('shop-cfg-max-pack-slots', 'Max Pack Slots', config.maxPackSlots ?? config.maximumPackAndCardSlots ?? 1)}
        ${renderNumberField('shop-cfg-max-frozen', 'Max Frozen Slots', config.maxFrozenSlots)}
        ${renderSelect('shop-cfg-owned-cosmetics', 'Owned Cosmetics Can Appear', config.allowOwnedCosmeticsInShop, [
          { value: 'false', label: 'No' },
          { value: 'true', label: 'Yes' },
        ])}
      </div>
      <div class="mt-4">
        <h4 class="font-semibold text-sm mb-2 text-primary-400">Built-In Shop Rerolls</h4>
        <p class="text-xs text-surface-500 mb-3">RP-only sequential rerolls per rotation. Token rerolls remain independent.</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          ${renderNumberField('shop-cfg-builtin-total', 'Total Built-In Rerolls (0-3)', (config.builtInRerolls || DEFAULT_SHOP_CONFIG.builtInRerolls).total ?? 3, { min: '0' })}
          ${renderNumberField('shop-cfg-builtin-cost-1', 'Reroll 1 Cost (RP)', (config.builtInRerolls || DEFAULT_SHOP_CONFIG.builtInRerolls).costs?.[0] ?? 0)}
          ${renderNumberField('shop-cfg-builtin-cost-2', 'Reroll 2 Cost (RP)', (config.builtInRerolls || DEFAULT_SHOP_CONFIG.builtInRerolls).costs?.[1] ?? 0)}
          ${renderNumberField('shop-cfg-builtin-cost-3', 'Reroll 3 Cost (RP)', (config.builtInRerolls || DEFAULT_SHOP_CONFIG.builtInRerolls).costs?.[2] ?? 0)}
        </div>
      </div>
    </section>
  `;
}

function renderCardRarityControls(config) {
  const controls = config.cardRarityControls || DEFAULT_SHOP_CONFIG.cardRarityControls;
  const rows = ALL_RARITIES.map(rarity => {
    const entry = controls[rarity] || {};
    return `
      <tr class="border-t border-surface-800" data-rarity="${escapeHtml(rarity)}">
        <td class="py-2 pr-3 font-medium text-sm">${escapeHtml(formatLabel(rarity))}</td>
        <td class="py-2 pr-3">
          <select class="admin-input w-full shop-rarity-enabled">
            <option value="true" ${entry.enabled === true ? 'selected' : ''}>Enabled</option>
            <option value="false" ${entry.enabled !== true ? 'selected' : ''}>Disabled</option>
          </select>
        </td>
        <td class="py-2 pr-3"><input type="number" min="0" class="admin-input w-24 shop-rarity-price" value="${escapeHtml(entry.price ?? 0)}"></td>
        <td class="py-2 pr-3"><input type="number" min="0" step="any" class="admin-input w-24 shop-rarity-weight" value="${escapeHtml(entry.weight ?? 0)}"></td>
      </tr>
    `;
  }).join('');

  return `
    <section class="bg-surface-900 rounded-xl border border-surface-700 p-6">
      <div class="mb-4">
        <h3 class="font-semibold">Card Shop Rarity Controls</h3>
        <p class="text-xs text-surface-500 mt-1">Rarity-driven inclusion for all current and future cards of each rarity.</p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs text-surface-500 uppercase">
            <tr>
              <th class="pb-2 pr-3">Rarity</th>
              <th class="pb-2 pr-3">Enabled</th>
              <th class="pb-2 pr-3">Price (RP)</th>
              <th class="pb-2 pr-3">Weight</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderItemEditor(definitions) {
  const rows = Object.values(definitions).map(definition => `
    <tr class="border-t border-surface-800" data-shop-item-id="${escapeHtml(definition.id)}">
      <td class="py-2 pr-3">
        <div class="font-medium text-sm">${escapeHtml(definition.name || definition.id)}</div>
        <div class="text-xs text-surface-500">${escapeHtml(definition.type)} · ${escapeHtml(definition.category)}</div>
      </td>
      <td class="py-2 pr-3">
        <select class="admin-input w-full shop-item-enabled">
          <option value="true" ${definition.enabled !== false ? 'selected' : ''}>Enabled</option>
          <option value="false" ${definition.enabled === false ? 'selected' : ''}>Disabled</option>
        </select>
      </td>
      <td class="py-2 pr-3"><input type="number" min="0" class="admin-input w-24 shop-item-price" value="${escapeHtml(definition.price ?? 0)}"></td>
      <td class="py-2 pr-3"><input type="number" min="0" step="any" class="admin-input w-24 shop-item-weight" value="${escapeHtml(definition.weight ?? 0)}"></td>
      <td class="py-2 pr-3">
        <select class="admin-input w-full shop-item-rarity">
          ${Object.values(ITEM_RARITIES).map(rarity => `<option value="${escapeHtml(rarity)}" ${definition.rarity === rarity ? 'selected' : ''}>${escapeHtml(formatLabel(rarity))}</option>`).join('')}
        </select>
      </td>
      <td class="py-2 text-right">
        <button class="shop-admin-save-item bg-primary-600 hover:bg-primary-500 px-3 py-1.5 rounded text-xs font-medium">Save</button>
      </td>
    </tr>
  `).join('');

  return `
    <section class="bg-surface-900 rounded-xl border border-surface-700 p-6">
      <div class="mb-4">
        <h3 class="font-semibold">Item Balance</h3>
        <p class="text-xs text-surface-500 mt-1">Per-item overrides are stored separately from static item definitions.</p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs text-surface-500 uppercase">
            <tr>
              <th class="pb-2 pr-3">Item</th>
              <th class="pb-2 pr-3">Enabled</th>
              <th class="pb-2 pr-3">Price</th>
              <th class="pb-2 pr-3">Weight</th>
              <th class="pb-2 pr-3">Rarity</th>
              <th class="pb-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderConsumableConfig(definitions) {
  const discount = definitions.discount_chip || {};
  const freeze = definitions.freeze_token || {};
  const proposal = definitions.research_proposal || {};
  return `
    <section class="bg-surface-900 rounded-xl border border-surface-700 p-6">
      <h3 class="font-semibold mb-4">Consumable Balance</h3>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        ${renderNumberField('shop-cons-discount-percent', 'Discount Chip %', discount.behaviorConfig?.percent ?? 25)}
        ${renderNumberField('shop-cons-discount-max', 'Discount Max Reduction', discount.behaviorConfig?.maxReductionAmount ?? 0)}
        ${renderNumberField('shop-cons-freeze-allowance', 'Freeze Token Allowance Amount', freeze.behaviorConfig?.allowanceAmount ?? 1)}
        ${renderNumberField('shop-cons-proposal-amount', 'Research Proposal Amount', proposal.behaviorConfig?.amount ?? 50)}
      </div>
      <p class="text-xs text-surface-500 mt-3">These controls persist behaviorConfig overrides only. Runtime behavior changes only where existing backend logic consumes the field.</p>
      <button id="shop-admin-save-consumables" class="mt-4 bg-primary-600 hover:bg-primary-500 px-5 py-2 rounded-lg font-medium text-sm transition">Save Consumables</button>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// renderShopAdminPanel
// ---------------------------------------------------------------------------
/**
 * Renders the top-level shop admin panel.
 *
 * Future behavior:
 * - Displays economy overview (current config values, active item count).
 * - Provides navigation to sub-panels (economy config, item editor, generation controls).
 * - Admin-only access gated by role check.
 *
 * @returns {void} Placeholder — no-op.
 */
export function renderShopAdminPanel() {
  const container = document.getElementById('shop-admin-panel');
  if (!container) return;

  const config = getShopConfig();
  const definitions = getShopItemDefinitions();
  container.innerHTML = `
    ${renderShopEconomyConfig(config)}
    ${renderCardRarityControls(config)}
    ${renderConsumableConfig(definitions)}
    ${renderItemEditor(definitions)}
  `;

  document.getElementById('shop-admin-save-config')?.addEventListener('click', () => {
    const cardRarityControls = {};
    for (const rarity of ALL_RARITIES) {
      const row = container.querySelector(`[data-rarity="${rarity}"]`);
      cardRarityControls[rarity] = {
        enabled: row?.querySelector('.shop-rarity-enabled')?.value === 'true',
        price: Number(row?.querySelector('.shop-rarity-price')?.value || 0),
        weight: Number(row?.querySelector('.shop-rarity-weight')?.value || 0),
      };
    }
    saveShopConfig({
      shopSlotCount: numberValue('shop-cfg-slot-count', DEFAULT_SHOP_CONFIG.shopSlotCount),
      minimumCosmeticSlots: numberValue('shop-cfg-min-cosmetics', DEFAULT_SHOP_CONFIG.minimumCosmeticSlots),
      minimumUtilitySlots: numberValue('shop-cfg-min-utility', DEFAULT_SHOP_CONFIG.minimumUtilitySlots),
      maxCardSlots: numberValue('shop-cfg-max-card-slots', DEFAULT_SHOP_CONFIG.maxCardSlots),
      maxPackSlots: numberValue('shop-cfg-max-pack-slots', DEFAULT_SHOP_CONFIG.maxPackSlots),
      maxFrozenSlots: numberValue('shop-cfg-max-frozen', DEFAULT_SHOP_CONFIG.maxFrozenSlots),
      allowOwnedCosmeticsInShop: boolValue('shop-cfg-owned-cosmetics'),
      builtInRerolls: {
        total: numberValue('shop-cfg-builtin-total', DEFAULT_SHOP_CONFIG.builtInRerolls.total),
        costs: [
          numberValue('shop-cfg-builtin-cost-1', DEFAULT_SHOP_CONFIG.builtInRerolls.costs[0]),
          numberValue('shop-cfg-builtin-cost-2', DEFAULT_SHOP_CONFIG.builtInRerolls.costs[1]),
          numberValue('shop-cfg-builtin-cost-3', DEFAULT_SHOP_CONFIG.builtInRerolls.costs[2]),
        ],
      },
      cardRarityControls,
    });
    toast.success('Shop config saved');
    renderShopAdminPanel();
  });

  document.getElementById('shop-admin-reset')?.addEventListener('click', () => {
    resetShopConfigOverrides();
    toast.info('Shop config overrides reset');
    renderShopAdminPanel();
  });

  document.getElementById('shop-admin-save-consumables')?.addEventListener('click', () => {
    saveShopItemOverride('discount_chip', {
      behaviorConfig: {
        percent: numberValue('shop-cons-discount-percent', 25),
        maxReductionAmount: numberValue('shop-cons-discount-max', 0),
      },
    });
    saveShopItemOverride('freeze_token', {
      behaviorConfig: {
        allowanceAmount: numberValue('shop-cons-freeze-allowance', 1),
      },
    });
    saveShopItemOverride('research_proposal', {
      behaviorConfig: {
        amount: numberValue('shop-cons-proposal-amount', 50),
      },
    });
    toast.success('Consumable overrides saved');
    renderShopAdminPanel();
  });

  container.querySelectorAll('.shop-admin-save-item').forEach(button => {
    button.addEventListener('click', () => {
      const row = button.closest('[data-shop-item-id]');
      const itemId = row?.dataset.shopItemId;
      const result = saveShopItemOverride(itemId, {
        enabled: row.querySelector('.shop-item-enabled')?.value === 'true',
        price: Number(row.querySelector('.shop-item-price')?.value || 0),
        weight: Number(row.querySelector('.shop-item-weight')?.value || 0),
        rarity: row.querySelector('.shop-item-rarity')?.value,
      });
      if (!result.success) {
        toast.error('Could not save item override');
        return;
      }
      toast.success('Item override saved');
    });
  });
}

// ---------------------------------------------------------------------------
// renderEconomyConfig
// ---------------------------------------------------------------------------
/**
 * Renders the economy configuration sub-panel.
 *
 * Future behavior:
 * - Displays editable fields for reroll costs (per type), shop refresh interval,
 *   frozen slot limits, and slot counts.
 * - Changes are staged locally and committed via a save action.
 * - Validates constraints (e.g., slot minimums cannot exceed total slot count).
 *
 * @returns {void} Placeholder — no-op.
 */
export function renderEconomyConfig() {
  // TODO: Phase 3+ — implement economy config panel rendering
}

// ---------------------------------------------------------------------------
// renderShopItemEditor
// ---------------------------------------------------------------------------
/**
 * Renders the item editor sub-panel.
 *
 * Future behavior:
 * - Lists all ITEM_DEFINITIONS with current weight, price, rarity, and enabled status.
 * - Allows inline editing of weight and price.
 * - Toggle to enable/disable individual items.
 * - Filtering and sorting by type, category, rarity.
 *
 * @returns {void} Placeholder — no-op.
 */
export function renderShopItemEditor() {
  // TODO: Phase 3+ — implement item editor panel rendering
}

// ---------------------------------------------------------------------------
// renderShopGenerationControls
// ---------------------------------------------------------------------------
/**
 * Renders the generation controls sub-panel.
 *
 * Future behavior:
 * - Displays current slot constraint configuration.
 * - Allows adjusting minimumCosmeticSlots, minimumUtilitySlots, maximumPackAndCardSlots.
 * - Provides a "preview generation" button that runs generateShopRotation()
 *   in dry-run mode to preview what a rotation would look like with current settings.
 * - Shows generation statistics (pool size, effective weights after filtering).
 *
 * @returns {void} Placeholder — no-op.
 */
export function renderShopGenerationControls() {
  // TODO: Phase 3+ — implement generation controls panel rendering
}
