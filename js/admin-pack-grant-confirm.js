/**
 * Shared Admin pack-grant confirmation (UI safety only).
 * Threshold lives here — not in player.addPack / gameplay grants.
 */

import { confirmAction } from './confirm-modal.js';
import { parseAdminPackGrantQuantity } from './player.js';

/** Grants of this quantity or less are frictionless; above requires confirm. */
export const ADMIN_PACK_GRANT_CONFIRM_ABOVE = 10;

/**
 * @param {unknown} quantity
 * @returns {boolean}
 */
export function adminPackGrantNeedsConfirmation(quantity) {
  const n = typeof quantity === 'number' && Number.isFinite(quantity)
    ? Math.trunc(quantity)
    : parseAdminPackGrantQuantity(quantity);
  return n > ADMIN_PACK_GRANT_CONFIRM_ABOVE;
}

/**
 * @param {{
 *   displayName: string,
 *   loginUsername: string,
 *   packName: string,
 *   grantQuantity: number,
 *   currentQuantity: number,
 * }} opts
 */
export function buildAdminPackGrantConfirmOptions(opts) {
  const displayName = String(opts.displayName || opts.loginUsername || 'player');
  const loginUsername = String(opts.loginUsername || '');
  const packName = String(opts.packName || 'pack');
  const grantQuantity = Math.trunc(Number(opts.grantQuantity)) || 0;
  const currentQuantity = Math.max(0, Math.trunc(Number(opts.currentQuantity)) || 0);
  const afterQuantity = currentQuantity + grantQuantity;

  return {
    title: `Give ${grantQuantity} ${packName}?`,
    message:
      `Give ${grantQuantity} ${packName} to ${displayName}?\n\n`
      + `Login username: ${loginUsername}\n`
      + `Current: ${currentQuantity}\n`
      + `After: ${afterQuantity}`,
    confirmText: 'Give Packs',
    destructive: false,
  };
}

/**
 * Confirm when grant quantity > 10; otherwise returns true immediately.
 * Cancel → false (caller must not mutate).
 *
 * @param {{
 *   displayName: string,
 *   loginUsername: string,
 *   packName: string,
 *   grantQuantity: number,
 *   currentQuantity: number,
 *   confirmFn?: typeof confirmAction,
 * }} opts
 * @returns {Promise<boolean>}
 */
export async function confirmAdminPackGrantIfNeeded(opts) {
  const grantQuantity = typeof opts.grantQuantity === 'number' && Number.isFinite(opts.grantQuantity)
    ? Math.trunc(opts.grantQuantity)
    : parseAdminPackGrantQuantity(opts.grantQuantity);
  if (!adminPackGrantNeedsConfirmation(grantQuantity)) return true;
  const confirmFn = typeof opts.confirmFn === 'function' ? opts.confirmFn : confirmAction;
  return !!(await confirmFn(buildAdminPackGrantConfirmOptions({
    ...opts,
    grantQuantity,
  })));
}
