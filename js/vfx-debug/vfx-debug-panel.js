/**
 * vfx-debug-panel.js — Admin-only Collection tab floating debug UI.
 */

import { applyAllVfxDebugEffects } from './vfx-debug-applicator.js';
import { sampleVfxDebugMetrics } from './vfx-debug-metrics.js';
import { listVfxDebugEffects } from './vfx-debug-registry.js';
import {
  getActiveVfxDebugEffectId,
  getVfxDebugValues,
  loadVfxDebugStore,
  setActiveVfxDebugEffectId,
  setVfxDebugValue,
} from './vfx-debug-store.js';

/** @type {HTMLElement|null} */
let panelEl = null;

/** @type {number|null} */
let metricsRafId = null;

/** @type {boolean} */
let collectionTabActive = false;

function ensureDebugStylesheet() {
  if (document.getElementById('vfx-debug-styles')) return;
  const link = document.createElement('link');
  link.id = 'vfx-debug-styles';
  link.rel = 'stylesheet';
  link.href = './style-vfx-debug.css';
  document.head.appendChild(link);
}

function renderMetrics() {
  if (!panelEl) return;
  const m = sampleVfxDebugMetrics();
  const cardsEl = panelEl.querySelector('[data-vfx-metric="cards"]');
  const packetsEl = panelEl.querySelector('[data-vfx-metric="packets"]');
  const animsEl = panelEl.querySelector('[data-vfx-metric="anims"]');
  const heapEl = panelEl.querySelector('[data-vfx-metric="heap"]');
  if (cardsEl) cardsEl.textContent = String(m.synchrotronCards);
  if (packetsEl) packetsEl.textContent = String(m.visiblePackets);
  if (animsEl) animsEl.textContent = String(m.activeAnimations);
  if (heapEl) heapEl.textContent = m.jsHeapMb;
}

function metricsLoop() {
  renderMetrics();
  metricsRafId = requestAnimationFrame(metricsLoop);
}

function startMetricsLoop() {
  if (metricsRafId != null) return;
  metricsRafId = requestAnimationFrame(metricsLoop);
}

function stopMetricsLoop() {
  if (metricsRafId != null) {
    cancelAnimationFrame(metricsRafId);
    metricsRafId = null;
  }
}

function renderControls() {
  if (!panelEl) return;
  const effectId = getActiveVfxDebugEffectId();
  const effect = listVfxDebugEffects().find((e) => e.id === effectId);
  const container = panelEl.querySelector('[data-vfx-controls]');
  if (!container || !effect) return;

  const values = getVfxDebugValues(effectId);
  container.innerHTML = effect.controls.map((control) => {
    const value = values[control.id] ?? control.default ?? 100;
    return `
      <label class="vfx-debug-control">
        <span class="vfx-debug-control-label">
          <span>${control.label}</span>
          <span class="vfx-debug-control-value" data-vfx-value-for="${control.id}">${value}%</span>
        </span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value="${value}"
          data-vfx-effect="${effectId}"
          data-vfx-control="${control.id}"
          aria-label="${control.label}"
        />
      </label>
    `;
  }).join('');

  container.querySelectorAll('input[type="range"]').forEach((input) => {
    input.addEventListener('input', () => {
      const el = /** @type {HTMLInputElement} */ (input);
      const eid = el.dataset.vfxEffect || effectId;
      const cid = el.dataset.vfxControl || '';
      const v = Number(el.value);
      setVfxDebugValue(eid, cid, v);
      const valueLabel = panelEl?.querySelector(`[data-vfx-value-for="${cid}"]`);
      if (valueLabel) valueLabel.textContent = `${v}%`;
      applyAllVfxDebugEffects();
    });
  });
}

function buildPanelHtml() {
  const effects = listVfxDebugEffects();
  const activeId = getActiveVfxDebugEffectId();
  const options = effects.map((e) => (
    `<option value="${e.id}"${e.id === activeId ? ' selected' : ''}>${e.label}</option>`
  )).join('');

  return `
    <div class="vfx-debug-panel" role="region" aria-label="Visual Effects Debug">
      <div class="vfx-debug-header">
        <span class="vfx-debug-title">Visual Effects Debug</span>
        <span class="vfx-debug-badge">Admin</span>
        <button type="button" class="vfx-debug-collapse" data-vfx-collapse aria-expanded="true" title="Collapse panel">−</button>
      </div>
      <div class="vfx-debug-body" data-vfx-body>
        <label class="vfx-debug-effect-select">
          <span>Effect</span>
          <select data-vfx-effect-select>${options}</select>
        </label>
        <div class="vfx-debug-controls" data-vfx-controls></div>
        <div class="vfx-debug-metrics">
          <div class="vfx-debug-metrics-title">Metrics</div>
          <div class="vfx-debug-metric-row"><span>Visible Synchrotron Cards</span><strong data-vfx-metric="cards">0</strong></div>
          <div class="vfx-debug-metric-row"><span>Visible Packets</span><strong data-vfx-metric="packets">0</strong></div>
          <div class="vfx-debug-metric-row"><span>Active Animations</span><strong data-vfx-metric="anims">0</strong></div>
          <div class="vfx-debug-metric-row"><span>JS Heap</span><strong data-vfx-metric="heap">N/A</strong></div>
        </div>
        <p class="vfx-debug-hint">Equip Synchrotron with Mathematical Aura T1+ on collection cards. Watch Chrome Task Manager for renderer memory.</p>
      </div>
    </div>
  `;
}

/**
 * @param {HTMLElement} collectionTab
 */
export function mountVfxDebugPanel(collectionTab) {
  if (panelEl) return;

  ensureDebugStylesheet();
  loadVfxDebugStore();

  panelEl = document.createElement('div');
  panelEl.id = 'vfx-debug-panel-host';
  panelEl.className = 'vfx-debug-panel-host';
  panelEl.innerHTML = buildPanelHtml();
  collectionTab.appendChild(panelEl);

  const effectSelect = panelEl.querySelector('[data-vfx-effect-select]');
  effectSelect?.addEventListener('change', () => {
    const select = /** @type {HTMLSelectElement} */ (effectSelect);
    setActiveVfxDebugEffectId(select.value);
    renderControls();
    applyAllVfxDebugEffects();
  });

  const collapseBtn = panelEl.querySelector('[data-vfx-collapse]');
  const body = panelEl.querySelector('[data-vfx-body]');
  collapseBtn?.addEventListener('click', () => {
    const expanded = collapseBtn.getAttribute('aria-expanded') === 'true';
    collapseBtn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    collapseBtn.textContent = expanded ? '+' : '−';
    body?.classList.toggle('vfx-debug-body--collapsed', expanded);
  });

  renderControls();
  applyAllVfxDebugEffects();
  updateVfxDebugPanelVisibility(collectionTabActive);
}

/**
 * @param {boolean} visible
 */
export function updateVfxDebugPanelVisibility(visible) {
  collectionTabActive = visible;
  if (!panelEl) return;
  panelEl.classList.toggle('vfx-debug-panel-host--hidden', !visible);
  if (visible) {
    startMetricsLoop();
    renderMetrics();
  } else {
    stopMetricsLoop();
  }
}

export function destroyVfxDebugPanel() {
  stopMetricsLoop();
  panelEl?.remove();
  panelEl = null;
}
