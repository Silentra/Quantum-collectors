/**
 * Option C-b — auth identity rotation helpers / path invariants.
 * Run: node scripts/option-c-b-auth-rotation.test.mjs
 */

import {
  OPTION_CB_VERSION,
  nextAuthDirectoryGeneration,
  generateRotationTokenHex,
  buildRotatedLoginEmail,
  validateResetPasswordInput,
  buildIdentityRebindUpdates,
  assertResetRebindPathInvariant,
  evaluateStaleBinding,
  buildAuthLifecycleDeleteUpdates,
  findForbiddenHistoricalDeletePaths,
  getOptionCbStatus,
} from '../js/auth-rotation.js';
import { decideAuthLoginTargetFromLoad } from '../js/auth-directory.js';
import { buildLeaderboardSummaryEntry } from '../js/leaderboard-summaries.js';
import { authDirectoryPathsForRegistration } from '../js/auth-directory.js';

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else {
    console.log('PASS:', msg);
  }
}

function assertEq(a, b, msg) {
  assert(a === b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

assertEq(OPTION_CB_VERSION, 'option-c-b-1', 'C-b version');
const status = getOptionCbStatus();
assertEq(status.identityRotation, true, 'status identityRotation');
assertEq(status.deleteUnbindsAuthDirectory, true, 'status delete unbind');
assertEq(status.sameUsernameReregisterGuaranteed, false, 'same-username not guaranteed');

assertEq(nextAuthDirectoryGeneration(0), 1, 'gen 0→1');
assertEq(nextAuthDirectoryGeneration(1), 2, 'gen 1→2');
assertEq(nextAuthDirectoryGeneration(-1), 1, 'invalid gen → 1');

{
  const tok = generateRotationTokenHex();
  assertEq(tok.length, 12, 'token length 12');
  assert(/^[0-9a-f]+$/.test(tok), 'token hex');
  const email = buildRotatedLoginEmail('bobby6', 1, tok);
  assertEq(email, `bobby6.g1.${tok}@scicards.local`, 'rotated email format');
  assert(!email.includes('..'), 'email no double dots');
}

{
  let threw = false;
  try {
    buildRotatedLoginEmail('Bad User!', 1, 'abcdefghijkl');
  } catch {
    threw = true;
  }
  assert(threw, 'invalid username rejected for email');
}

assert(validateResetPasswordInput('').ok === false, 'empty password');
assert(validateResetPasswordInput('12345').ok === false, 'short password');
assert(validateResetPasswordInput('123456').ok === true, 'min 6 ok');
assert(
  validateResetPasswordInput('123456', '1234567').ok === false,
  'confirm mismatch',
);
assert(
  validateResetPasswordInput('sameold', 'sameold').ok === true,
  'same-as-old style password allowed',
);

{
  const updates = buildIdentityRebindUpdates({
    username: 'alice',
    newLoginEmail: 'alice.g1.aabbccddeeff@scicards.local',
    newUid: 'uidNew',
    newGeneration: 1,
  });
  assertEq(Object.keys(updates).length, 3, 'exactly 3 rebind paths');
  assert(updates['authDirectory/alice'] != null, 'authDirectory path');
  assertEq(updates['authDirectory/alice'].authUid, 'uidNew', 'directory uid');
  assertEq(updates['authDirectory/alice'].generation, 1, 'directory gen');
  assertEq(updates['players/alice/authUid'], 'uidNew', 'player authUid');
  assertEq(updates['players/alice/activeSession'], null, 'activeSession null');
  assert(
    !Object.keys(updates).some((p) => p.includes('inventory') || p.includes('stats')),
    'no inventory/stats',
  );
  assert(assertResetRebindPathInvariant(updates, 'alice').ok === true, 'invariant ok');

  const bad = { ...updates, 'players/alice/inventory/c1': 1 };
  assert(assertResetRebindPathInvariant(bad, 'alice').ok === false, 'invariant rejects extras');
}

{
  const ok = evaluateStaleBinding({
    observedOldUid: 'uidOld',
    observedGeneration: 0,
    directoryAuthUid: 'uidOld',
    directoryGeneration: 0,
    playerAuthUid: 'uidOld',
  });
  assert(ok.ok === true, 'stale: unchanged may rebind');

  const uidChanged = evaluateStaleBinding({
    observedOldUid: 'uidOld',
    observedGeneration: 0,
    directoryAuthUid: 'uidOther',
    directoryGeneration: 0,
    playerAuthUid: 'uidOld',
  });
  assert(uidChanged.ok === false && uidChanged.code === 'STALE_BINDING', 'stale: uid change');

  const genChanged = evaluateStaleBinding({
    observedOldUid: 'uidOld',
    observedGeneration: 0,
    directoryAuthUid: 'uidOld',
    directoryGeneration: 1,
    playerAuthUid: 'uidOld',
  });
  assert(genChanged.ok === false, 'stale: generation change');
}

{
  const del = buildAuthLifecycleDeleteUpdates({
    username: 'carol',
    oldUid: 'uidCarolRotated',
    clearAdminRegistry: false,
  });
  assertEq(del['authDirectory/carol'], null, 'delete authDirectory null');
  assert(
    !Object.keys(del).some((p) => p.startsWith('admins/')),
    'v1 no admins clear when not requested',
  );
  const withAdmin = buildAuthLifecycleDeleteUpdates({
    username: 'carol',
    oldUid: 'uidCarolRotated',
    clearAdminRegistry: true,
  });
  assertEq(withAdmin['admins/uidCarolRotated'], null, 'optional admins clear uses CURRENT uid');
  assert(
    findForbiddenHistoricalDeletePaths({
      ...del,
      'leaderboardSeasons/x': null,
    }).length === 1,
    'historical seasons flagged',
  );
}

// C-a regression: generation > 0 directory login
{
  const t = decideAuthLoginTargetFromLoad('dave', {
    ok: true,
    missing: false,
    parsed: {
      loginEmail: 'dave.g1.aabbccddeeff@scicards.local',
      authUid: 'uidDave1',
      generation: 1,
    },
  }, { compatEnabled: false });
  assert(t.ok === true, 'C-a strict accepts generation>0');
  assertEq(t.loginEmail, 'dave.g1.aabbccddeeff@scicards.local', 'uses directory email');
  assertEq(t.source, 'authDirectory', 'source authDirectory');
}

// Registration still gen0
{
  const paths = authDirectoryPathsForRegistration('eve', 'uidEve');
  assertEq(paths['authDirectory/eve'].generation, 0, 'registration gen0');
  assertEq(paths['authDirectory/eve'].loginEmail, 'eve@scicards.local', 'registration gen0 email');
}

// LB username registration fix intact
{
  const entry = buildLeaderboardSummaryEntry('frank', {}, 'packsOpened', 1);
  assertEq(entry.username, 'frank', 'LB username present');
}

console.log(failed ? `\nFAILED: ${failed}` : '\nOption C-b auth-rotation tests: ALL PASSED');
if (failed) process.exit(1);
