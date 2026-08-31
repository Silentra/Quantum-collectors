/**
 * Admin Quick Give Packs — focused architecture tests.
 * Run: node scripts/admin-quick-give-packs.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAdminPackGrantQuantity } from '../js/player.js';

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

assert(parseAdminPackGrantQuantity('3') === 3, 'qty 3');
assert(parseAdminPackGrantQuantity('1') === 1, 'qty 1');
assert(parseAdminPackGrantQuantity('0') === 1, 'qty 0 → 1 (same floor as detail path)');
assert(parseAdminPackGrantQuantity('-2') === 1, 'negative → 1');
assert(parseAdminPackGrantQuantity('') === 1, 'empty → 1');
assert(parseAdminPackGrantQuantity('abc') === 1, 'NaN → 1');
assert(parseAdminPackGrantQuantity(2.9) === 2, 'parseInt truncates');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(html.includes('id="admin-quick-give-packs-modal"'), 'quick give packs modal present');
assert(html.includes('id="aqgp-pack-select"'), 'pack select present');
assert(html.includes('id="aqgp-pack-qty"'), 'qty input present');
assert(html.includes('id="aqgp-login-username"'), 'login username line present');

const ui = fs.readFileSync(path.join(root, 'js', 'ui.js'), 'utf8');
assert(ui.includes('btn-admin-quick-give-packs'), 'Players list Give Packs button');
assert(ui.includes('btn-admin-player-detail'), 'Manage button preserved');
assert(ui.includes('openAdminQuickGivePacksModal'), 'quick modal opener');
assert(ui.includes('player.adminGrantPacks'), 'UI uses adminGrantPacks');
assert(
  (ui.match(/player\.adminGrantPacks/g) || []).length >= 2,
  'both detail and quick paths call adminGrantPacks',
);
assert(
  (ui.match(/confirmAdminPackGrantIfNeeded/g) || []).length >= 2,
  'both grant paths use shared >10 confirmation helper',
);
assert(ui.includes('packs.getAllPackTypes()'), 'pack types from canonical packs module');
assert(ui.includes('_aqgpUsername = null'), 'clears selected username on close');
assert(ui.includes('_aqgpUsername = username'), 'stores stable username on open');
assert(!ui.includes('firebase-hosting-prod'), 'no hosting-prod coupling in ui');

const playerSrc = fs.readFileSync(path.join(root, 'js', 'player.js'), 'utf8');
assert(playerSrc.includes('export async function adminGrantPacks'), 'adminGrantPacks exported async');
assert(playerSrc.includes('buildAdminPackGrantPlan'), 'adminGrantPacks uses plan builder');
assert(playerSrc.includes('updateAcknowledged'), 'admin pack grant uses updateAcknowledged');

const prodUi = path.join(root, 'firebase-hosting-prod', 'js', 'ui.js');
if (fs.existsSync(prodUi)) {
  // Quick Give Packs may already be in a prior snapshot; do not require it absent.
  assert(fs.existsSync(prodUi), 'firebase-hosting-prod ui.js readable when present');
}

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll admin-quick-give-packs tests passed.');
