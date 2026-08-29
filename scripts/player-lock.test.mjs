/**
 * Player lock pure unit tests (builders + fail-closed mirror evaluation).
 * Run: node scripts/player-lock.test.mjs
 */

import {
  evaluateLockMirrors,
  buildAdminLockPlayerUpdates,
  buildAdminUnlockPlayerUpdates,
  playerLockPath,
  playerLockByUidPath,
  MSG_ACCOUNT_TEMPORARILY_UNAVAILABLE,
} from '../js/player-lock.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('PASS:', msg);
  }
}

assert(
  MSG_ACCOUNT_TEMPORARILY_UNAVAILABLE.includes('temporarily unavailable'),
  'student UX message present',
);

const now = 1_700_000_000_000;
const lockUpdates = buildAdminLockPlayerUpdates('alice', 'uidAlice', 'uidTeacher', now);
assert(
  lockUpdates[playerLockPath('alice')]?.locked === true
    && lockUpdates[playerLockPath('alice')]?.lockedAt === now
    && lockUpdates[playerLockPath('alice')]?.lockedByUid === 'uidTeacher',
  'lock multipath writes username mirror',
);
assert(
  lockUpdates[playerLockByUidPath('uidAlice')]?.locked === true
    && lockUpdates[playerLockByUidPath('uidAlice')]?.username === 'alice'
    && lockUpdates[playerLockByUidPath('uidAlice')]?.lockedByUid === 'uidTeacher',
  'lock multipath writes uid mirror with username',
);
assert(
  lockUpdates['players/alice/activeSession'] === null,
  'lock multipath clears activeSession',
);
assert(
  Object.keys(lockUpdates).length === 3,
  'lock multipath has exactly three paths',
);

const unlockUpdates = buildAdminUnlockPlayerUpdates('alice', 'uidAlice');
assert(
  unlockUpdates[playerLockPath('alice')] === null
    && unlockUpdates[playerLockByUidPath('uidAlice')] === null,
  'unlock multipath nulls both mirrors',
);
assert(Object.keys(unlockUpdates).length === 2, 'unlock multipath has exactly two paths');

const unlocked = evaluateLockMirrors('alice', 'uidAlice', null, null);
assert(unlocked.locked === false && !unlocked.reason, 'no mirrors → unlocked');

const both = evaluateLockMirrors(
  'alice',
  'uidAlice',
  { locked: true, lockedAt: now, lockedByUid: 't' },
  { locked: true, username: 'alice', lockedAt: now, lockedByUid: 't' },
);
assert(both.locked === true && !both.reason, 'consistent dual lock → locked');

const mismatch = evaluateLockMirrors(
  'alice',
  'uidAlice',
  { locked: true, lockedAt: now, lockedByUid: 't' },
  { locked: true, username: 'bob', lockedAt: now, lockedByUid: 't' },
);
assert(
  mismatch.locked === true && mismatch.reason === 'mirror_username_mismatch',
  'mismatched username on uid mirror → fail-closed locked',
);

const userOnly = evaluateLockMirrors(
  'alice',
  'uidAlice',
  { locked: true, lockedAt: now, lockedByUid: 't' },
  null,
);
assert(
  userOnly.locked === true && userOnly.reason === 'uid_mirror_missing',
  'username locked + uid missing → fail-closed',
);

const uidOnly = evaluateLockMirrors(
  'alice',
  'uidAlice',
  null,
  { locked: true, username: 'alice', lockedAt: now, lockedByUid: 't' },
);
assert(
  uidOnly.locked === true && uidOnly.reason === 'username_mirror_missing',
  'uid locked + username missing → fail-closed',
);

const malformed = evaluateLockMirrors(
  'alice',
  'uidAlice',
  { locked: false },
  { note: 'junk' },
);
assert(
  malformed.locked === true && malformed.reason === 'malformed_lock',
  'malformed mirror rows → fail-closed',
);

if (failed) {
  console.error(`\nplayer-lock.test: ${failed} failure(s)`);
  process.exit(1);
}
console.log('\nplayer-lock.test: ALL PASSED');
