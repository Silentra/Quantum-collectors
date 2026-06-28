/**
 * vfx-debug — Admin-only visual effects diagnostics (Collection tab).
 */

import * as auth from '../auth.js';
import './effects/synchrotron.js';
import { mountVfxDebugPanel, updateVfxDebugPanelVisibility } from './vfx-debug-panel.js';

/** @type {boolean} */
let initialized = false;

/**
 * @returns {boolean}
 */
export function canMountVfxDebugPanel() {
  const session = auth.getSession();
  return auth.isAdmin() && !!session && session.username !== '__admin__';
}

export function initVfxDebugPanel() {
  if (!canMountVfxDebugPanel() || initialized) return;

  const collectionTab = document.getElementById('tab-collection');
  if (!collectionTab) return;

  mountVfxDebugPanel(collectionTab);
  initialized = true;

  const isCollectionActive = document.getElementById('tab-collection')?.classList.contains('active');
  updateVfxDebugPanelVisibility(!!isCollectionActive);
}

/**
 * @param {string} tabId
 */
export function onGameTabChanged(tabId) {
  if (!initialized) return;
  updateVfxDebugPanelVisibility(tabId === 'collection');
}
