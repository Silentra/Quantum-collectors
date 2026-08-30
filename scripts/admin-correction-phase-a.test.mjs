/**
 * Phase A — Admin correction QoL + pack safety tests.
 * Run: node scripts/admin-correction-phase-a.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  coercePositiveIntegerQuantity,
  readNonNegativeIntCount,
  computePackQuantityAfterAdd,
  computePackQuantityAfterRemove,
  parseAdminPackGrantQuantity,
} from '../js/player.js';
import {
  ADMIN_PACK_GRANT_CONFIRM_ABOVE,
  adminPackGrantNeedsConfirmation,
  buildAdminPackGrantConfirmOptions,
  confirmAdminPackGrantIfNeeded,
} from '../js/admin-pack-grant-confirm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('PASS:', msg);
  }
}

// ——— Quantity hardening ———
assert(coercePositiveIntegerQuantity(5).ok && coercePositiveIntegerQuantity(5).quantity === 5, 'coerce number 5');
assert(coercePositiveIntegerQuantity('5').ok && coercePositiveIntegerQuantity('5').quantity === 5, 'coerce string "5"');
assert(!coercePositiveIntegerQuantity(0).ok, 'reject 0');
assert(!coercePositiveIntegerQuantity(-3).ok, 'reject negative');
assert(!coercePositiveIntegerQuantity('abc').ok, 'reject NaN string');
assert(!coercePositiveIntegerQuantity('').ok, 'reject empty');
assert(readNonNegativeIntCount('12') === 12, 'read count from string');
assert(readNonNegativeIntCount('x') === 0, 'invalid count → 0');

const addStr = computePackQuantityAfterAdd('5', '5');
assert(addStr.ok && addStr.next === 10, 'add "5"+"5" numeric → 10 (not "55")');
assert(!computePackQuantityAfterAdd(3, 0).ok, 'add rejects non-positive qty');

const remPartial = computePackQuantityAfterRemove(30, 20);
assert(remPartial.ok && remPartial.next === 10 && remPartial.removeLeaf === false, 'pack remove partial');
const remAll = computePackQuantityAfterRemove(5, 5);
assert(remAll.ok && remAll.next === 0 && remAll.removeLeaf === true, 'pack remove all → leaf delete');
const remOver = computePackQuantityAfterRemove(3, 4);
assert(!remOver.ok && remOver.current === 3, 'pack remove reject > owned');
assert(!computePackQuantityAfterRemove(5, 0).ok, 'pack remove reject 0');

// ——— Bulk card removal semantics (source + coerce used by removeCard) ———
const playerSrc = fs.readFileSync(path.join(root, 'js', 'player.js'), 'utf8');
assert(playerSrc.includes('notifyCardInventoryChanged(username)'), 'removeCard refreshes derived unique/aura');
assert(
  /export function removeCard[\s\S]*?notifyCardInventoryChanged/.test(playerSrc)
  && !/export function removeCard[\s\S]*?cardsCollected\s*=/.test(playerSrc),
  'removeCard does not mutate cardsCollected',
);
assert(
  /export function removeCard[\s\S]*?notifyCardInventoryChanged/.test(playerSrc)
  && !/export function removeCard[\s\S]*?uniqueCardsDiscovered/.test(playerSrc),
  'removeCard does not mutate uniqueCardsDiscovered',
);
assert(playerSrc.includes('export function adminRemovePacks'), 'adminRemovePacks exported');
{
  const m = playerSrc.match(
    /export function removePack\([\s\S]*?\nexport function adminRemovePacks/,
  );
  assert(!!m, 'removePack precedes adminRemovePacks');
  assert(m && !m[0].includes('packsOpened'), 'removePack does not touch packsOpened');
}

// ——— >10 confirmation ———
assert(ADMIN_PACK_GRANT_CONFIRM_ABOVE === 10, 'threshold is 10');
assert(adminPackGrantNeedsConfirmation(10) === false, 'qty 10 → no confirmation');
assert(adminPackGrantNeedsConfirmation(11) === true, 'qty 11 → confirmation');
assert(adminPackGrantNeedsConfirmation('11') === true, 'qty "11" → confirmation');

const confirmOpts = buildAdminPackGrantConfirmOptions({
  displayName: 'StudentName',
  loginUsername: 'student1',
  packName: 'Standard Pack',
  grantQuantity: 55,
  currentQuantity: 3,
});
assert(confirmOpts.message.includes('Current: 3'), 'confirm shows current');
assert(confirmOpts.message.includes('After: 58'), 'confirm shows after 3+55');
assert(confirmOpts.message.includes('55'), 'confirm shows grant qty');
assert(confirmOpts.message.includes('StudentName'), 'confirm shows display name');

let confirmCalls = 0;
const skipConfirm = await confirmAdminPackGrantIfNeeded({
  displayName: 'A',
  loginUsername: 'a',
  packName: 'P',
  grantQuantity: 10,
  currentQuantity: 1,
  confirmFn: async () => { confirmCalls += 1; return false; },
});
assert(skipConfirm === true && confirmCalls === 0, 'qty 10 skips confirmFn');

confirmCalls = 0;
const cancelled = await confirmAdminPackGrantIfNeeded({
  displayName: 'A',
  loginUsername: 'a',
  packName: 'P',
  grantQuantity: 11,
  currentQuantity: 2,
  confirmFn: async () => { confirmCalls += 1; return false; },
});
assert(cancelled === false && confirmCalls === 1, 'qty 11 cancel → false (no write)');

const accepted = await confirmAdminPackGrantIfNeeded({
  displayName: 'A',
  loginUsername: 'a',
  packName: 'P',
  grantQuantity: 11,
  currentQuantity: 2,
  confirmFn: async () => true,
});
assert(accepted === true, 'qty 11 confirm → true');

// ——— UI wiring both grant paths ———
const ui = fs.readFileSync(path.join(root, 'js', 'ui.js'), 'utf8');
assert((ui.match(/confirmAdminPackGrantIfNeeded/g) || []).length >= 2, 'both Admin grant paths use shared confirm');
assert(ui.includes('Unopened Packs'), 'Manage shows Unopened Packs');
assert(ui.includes('No unopened packs.'), 'empty pack state');
assert(ui.includes('pd-remove-card-qty'), 'bulk card qty input');
assert(ui.includes('player.removeCard(username, cardId, qty)'), 'removeCard called with quantity');
assert(ui.includes('player.adminRemovePacks'), 'Manage uses adminRemovePacks');
assert(ui.includes('getPlayerPacks(username)'), 'pack display from loaded packs');
assert(!ui.includes('firebase-hosting-prod'), 'no hosting-prod coupling');

assert(parseAdminPackGrantQuantity('10') === 10, 'grant parser still floors invalid to 1 for empty only');
assert(parseAdminPackGrantQuantity(0) === 1, 'grant parser 0 → 1 (Admin UX floor)');

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll admin-correction-phase-a tests passed.');
