/**
 * vfx-debug-metrics.js — Read-only runtime metrics for VFX debug panel.
 */

const SYNCHROTRON_CARD_SELECTOR = '.sci-card[data-card-glow="synchrotron"], .card-detail-frame[data-card-glow="synchrotron"]';
const PACKET_SELECTOR = '.sync-packet';

/**
 * @param {Element} el
 * @returns {boolean}
 */
function isElementVisible(el) {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (el.getClientRects().length === 0) return false;
  return true;
}

/**
 * @returns {{ synchrotronCards: number, visiblePackets: number, activeAnimations: number, jsHeapMb: string }}
 */
export function sampleVfxDebugMetrics() {
  const synchrotronCards = document.querySelectorAll(SYNCHROTRON_CARD_SELECTOR).length;

  let visiblePackets = 0;
  document.querySelectorAll(PACKET_SELECTOR).forEach((el) => {
    if (isElementVisible(el)) visiblePackets += 1;
  });

  let activeAnimations = 0;
  try {
    activeAnimations = document.getAnimations().length;
  } catch {
    activeAnimations = 0;
  }

  let jsHeapMb = 'N/A';
  const mem = performance.memory;
  if (mem && typeof mem.usedJSHeapSize === 'number') {
    jsHeapMb = `${(mem.usedJSHeapSize / (1024 * 1024)).toFixed(1)} MB`;
  }

  return {
    synchrotronCards,
    visiblePackets,
    activeAnimations,
    jsHeapMb,
  };
}
