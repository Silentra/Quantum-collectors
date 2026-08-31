/**
 * Phase B — Admin stat/resource correction tests.
 * Run: node scripts/admin-stat-correction.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_STAT_CORRECTION_FIELDS,
  ADMIN_STAT_CORRECTION_FIELD_IDS,
  MSG_LOCK_BEFORE_STAT_CORRECTION,
  getAdminStatCorrectionField,
  parseStatCorrectionAdjustment,
  previewStatCorrection,
  readPlayerRelativeNumber,
  buildAdminStatCorrectionConfirmOptions,
  buildAdminStatCorrectionUpdates,
  isConsistentlyAdminLockedForCorrection,
} from '../js/admin-stat-correction.js';
import { evaluateLockMirrors } from '../js/player-lock.js';

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

// ——— Allowlist ———
assert(ADMIN_STAT_CORRECTION_FIELD_IDS.length === 9, 'nine approved fields');
assert(getAdminStatCorrectionField('packsOpened')?.relativePath === 'stats/packsOpened', 'packsOpened path');
assert(getAdminStatCorrectionField('spendableResearchPoints')?.leaderboardStatKey == null, 'spendable no LB');
assert(getAdminStatCorrectionField('lifetimeResearchPoints')?.leaderboardStatKey === 'totalResearchPoints', 'lifetime LB');
assert(getAdminStatCorrectionField('uniqueCardsOwned') == null, 'uniqueCardsOwned excluded');
assert(getAdminStatCorrectionField('maxCardAuraTier') == null, 'maxCardAuraTier excluded');
assert(getAdminStatCorrectionField('weeklyRPProgress') == null, 'weeklyRPProgress excluded');

for (const id of ADMIN_STAT_CORRECTION_FIELD_IDS) {
  const f = ADMIN_STAT_CORRECTION_FIELDS[id];
  assert(!!f.relativePath && !!f.label, `field ${id} has path+label`);
}

// ——— Value preview ———
assert(parseStatCorrectionAdjustment('-20').ok && parseStatCorrectionAdjustment('-20').adjustment === -20, 'adj -20');
assert(parseStatCorrectionAdjustment('+50').ok && parseStatCorrectionAdjustment('+50').adjustment === 50, 'adj +50');
assert(!parseStatCorrectionAdjustment('1.5').ok, 'reject non-integer adj');
assert(!parseStatCorrectionAdjustment('abc').ok, 'reject NaN adj');
assert(!parseStatCorrectionAdjustment(Infinity).ok, 'reject Infinity');

const up = previewStatCorrection(28, -20);
assert(up.ok && up.before === 28 && up.after === 8, '28-20=8 valid');
const neg = previewStatCorrection(3, -5);
assert(!neg.ok && neg.after === -2, '3-5 rejected');
assert(previewStatCorrection(100, 50).ok && previewStatCorrection(100, 50).after === 150, '100+50=150');
assert(!previewStatCorrection(10, 0).ok, 'zero adjustment rejected');
assert(!previewStatCorrection(5, 'nope').ok, 'malformed adjustment rejected');

const playerLike = {
  currencies: { currentResearchPoints: 310 },
  totalResearchPoints: 500,
  seasonalResearchPoints: 40,
  researchStats: { breakthroughs: 2 },
  projectsCompleted: 7,
  stats: {
    tradesCompleted: 4,
    packsOpened: 28,
    cardsCollected: 143,
    uniqueCardsDiscovered: 40,
  },
  groupId: 'g1',
};
assert(readPlayerRelativeNumber(playerLike, 'stats/packsOpened') === 28, 'read nested packsOpened');
assert(readPlayerRelativeNumber(playerLike, 'currencies/currentResearchPoints') === 310, 'read spendable RP');
assert(readPlayerRelativeNumber(playerLike, 'researchStats/breakthroughs') === 2, 'read breakthroughs');

// ——— Confirm payload ———
const confirmOpts = buildAdminStatCorrectionConfirmOptions({
  displayName: 'Duck',
  loginUsername: 'student1',
  fieldLabel: 'Packs Opened',
  before: 28,
  adjustment: -20,
  after: 8,
});
assert(confirmOpts.message.includes('Before: 28'), 'confirm before');
assert(confirmOpts.message.includes('Adjustment: -20'), 'confirm adj');
assert(confirmOpts.message.includes('After: 8'), 'confirm after');
assert(confirmOpts.message.includes('student1'), 'confirm login');
assert(MSG_LOCK_BEFORE_STAT_CORRECTION.includes('Lock this account'), 'lock message');

// ——— Lock consistency (pure mirrors) ———
const both = evaluateLockMirrors(
  'alice',
  'uidA',
  { locked: true, lockedAt: 1, lockedByUid: 't' },
  { locked: true, username: 'alice', lockedAt: 1, lockedByUid: 't' },
);
assert(both.locked === true && !both.reason, 'consistent dual lock');

const unlocked = evaluateLockMirrors('alice', 'uidA', null, null);
assert(unlocked.locked === false, 'no mirrors unlocked');

const oneSide = evaluateLockMirrors(
  'alice',
  'uidA',
  { locked: true, lockedAt: 1, lockedByUid: 't' },
  null,
);
assert(oneSide.locked === true && oneSide.reason === 'uid_mirror_missing', 'one-sided fail-closed');

// isConsistentlyAdminLockedForCorrection uses db cache — exercise via evaluate path indirectly:
// buildAdminStatCorrectionUpdates for mirror routing
const packsField = getAdminStatCorrectionField('packsOpened');
const packsUpdates = buildAdminStatCorrectionUpdates(
  'alice',
  playerLike,
  packsField,
  { before: 28, adjustment: -20, after: 8 },
  1_700_000_000_000,
);
assert(packsUpdates['players/alice/stats/packsOpened'] === 8, 'canonical packsOpened write');
assert(packsUpdates['leaderboards/packsOpened/alice']?.value === 8, 'packsOpened LB mirror');
assert(packsUpdates['leaderboards/packsOpened/alice']?.username === 'alice', 'LB entry username');

const spendField = getAdminStatCorrectionField('spendableResearchPoints');
const spendUpdates = buildAdminStatCorrectionUpdates(
  'alice',
  playerLike,
  spendField,
  { before: 310, adjustment: -100, after: 210 },
  1_700_000_000_000,
);
assert(spendUpdates['players/alice/currencies/currentResearchPoints'] === 210, 'spendable path');
assert(
  !Object.keys(spendUpdates).some((k) => k.startsWith('leaderboards/')),
  'spendable has no LB writes',
);

const lifeField = getAdminStatCorrectionField('lifetimeResearchPoints');
const lifeUpdates = buildAdminStatCorrectionUpdates(
  'alice',
  playerLike,
  lifeField,
  { before: 500, adjustment: -100, after: 400 },
  1_700_000_000_000,
);
assert(lifeUpdates['players/alice/totalResearchPoints'] === 400, 'lifetime path');
assert(lifeUpdates['leaderboards/totalResearchPoints/alice']?.value === 400, 'lifetime LB');

const seasonField = getAdminStatCorrectionField('seasonalResearchPoints');
assert(
  buildAdminStatCorrectionUpdates('alice', playerLike, seasonField, { before: 40, adjustment: -10, after: 30 }, 1)
    ['leaderboards/seasonalResearchPoints/alice']?.value === 30,
  'seasonal LB',
);

const btField = getAdminStatCorrectionField('breakthroughs');
assert(
  buildAdminStatCorrectionUpdates('alice', playerLike, btField, { before: 2, adjustment: 1, after: 3 }, 1)
    ['leaderboards/breakthroughs/alice']?.value === 3,
  'breakthroughs LB',
);

const projField = getAdminStatCorrectionField('projectsCompleted');
assert(
  buildAdminStatCorrectionUpdates('alice', playerLike, projField, { before: 7, adjustment: -2, after: 5 }, 1)
    ['leaderboards/projectsCompleted/alice']?.value === 5,
  'projectsCompleted LB',
);

const tradeField = getAdminStatCorrectionField('tradesCompleted');
assert(
  buildAdminStatCorrectionUpdates('alice', playerLike, tradeField, { before: 4, adjustment: 1, after: 5 }, 1)
    ['leaderboards/tradesCompleted/alice']?.value === 5,
  'tradesCompleted LB',
);

const cardsField = getAdminStatCorrectionField('cardsCollected');
const cardsUpdates = buildAdminStatCorrectionUpdates(
  'alice',
  playerLike,
  cardsField,
  { before: 143, adjustment: -20, after: 123 },
  1,
);
assert(cardsUpdates['players/alice/stats/cardsCollected'] === 123, 'cardsCollected path');
assert(!Object.keys(cardsUpdates).some((k) => k.startsWith('leaderboards/')), 'cardsCollected no LB');

const discField = getAdminStatCorrectionField('uniqueCardsDiscovered');
assert(
  !Object.keys(
    buildAdminStatCorrectionUpdates('alice', playerLike, discField, { before: 40, adjustment: -1, after: 39 }, 1),
  ).some((k) => k.startsWith('leaderboards/')),
  'discovery no LB',
);

// ——— Source / UI ———
const modSrc = fs.readFileSync(path.join(root, 'js', 'admin-stat-correction.js'), 'utf8');
assert(modSrc.includes('achievementsTouched: false'), 'achievements intentionally untouched');
assert(modSrc.includes('buildPlayerHistoryLeafUpdate') || modSrc.includes('admin_stat_correct'), 'stat correction attaches history');
assert(modSrc.includes('updateAcknowledged'), 'uses acknowledged multipath');
assert(modSrc.includes('isConsistentlyAdminLockedForCorrection'), 'lock gate exported');

const ui = fs.readFileSync(path.join(root, 'js', 'ui.js'), 'utf8');
assert(ui.includes('Account Corrections'), 'Manage has Account Corrections');
assert(ui.includes('adminCorrectPlayerStat'), 'UI calls canonical correction');
assert(ui.includes('MSG_LOCK_BEFORE_STAT_CORRECTION'), 'UI shows lock requirement');
assert(ui.includes('buildAdminStatCorrectionConfirmOptions'), 'UI confirm payload');
assert(!ui.includes('firebase-hosting-prod'), 'no hosting-prod coupling');

// Silence unused import if tree-shaken analysis complains — exercise export
assert(typeof isConsistentlyAdminLockedForCorrection === 'function', 'lock helper exported');

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll admin-stat-correction tests passed.');
