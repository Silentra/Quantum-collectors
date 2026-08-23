/**
 * Option C-a — authDirectory pure helpers / backfill planner tests.
 * Run: node scripts/option-c-a-auth-directory.test.mjs
 */

import {
  buildGen0AuthDirectoryEntry,
  buildAuthDirectoryEntry,
  parseAuthDirectoryEntry,
  buildAuthDirectoryBackfillPlan,
  authDirectoryPathsForRegistration,
  usernameToAuthEmail,
  OPTION_CA_FOUNDATION_VERSION,
} from '../js/auth-directory.js';

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

assert(OPTION_CA_FOUNDATION_VERSION === 'option-c-a-1', 'foundation version');

assertEq(usernameToAuthEmail('Bobby'), 'bobby@scicards.local', 'gen0 email');

{
  const e = buildGen0AuthDirectoryEntry('alice', 'uidAlice');
  assertEq(e.loginEmail, 'alice@scicards.local', 'gen0 entry email');
  assertEq(e.authUid, 'uidAlice', 'gen0 entry uid');
  assertEq(e.generation, 0, 'gen0 entry generation');
}

{
  const ok = parseAuthDirectoryEntry({
    loginEmail: 'a@scicards.local',
    authUid: 'u1',
    generation: 0,
  });
  assert(ok.ok === true, 'parse valid');
  assertEq(ok.authUid, 'u1', 'parse uid');
}

{
  const bad = parseAuthDirectoryEntry(null);
  assert(bad.ok === false && bad.error === 'AUTH_DIRECTORY_MISSING', 'parse missing');
}

{
  const bad = parseAuthDirectoryEntry({ loginEmail: 'x', authUid: '', generation: 0 });
  assert(bad.ok === false, 'parse empty uid rejected');
}

{
  const paths = authDirectoryPathsForRegistration('sam', 'uidSam');
  assertEq(
    paths['authDirectory/sam'].authUid,
    'uidSam',
    'registration path includes authDirectory',
  );
  assertEq(paths['authDirectory/sam'].generation, 0, 'registration gen0');
}

// Backfill plan
{
  const plan = buildAuthDirectoryBackfillPlan({
    playersSnapshot: {
      __admin__: { authUid: 'adminX' },
      alice: { authUid: 'uidA' },
      bob: { authUid: 'uidB' },
      cara: {},
    },
    authDirectorySnapshot: {},
  });
  assertEq(plan.scanned, 3, 'scanned excludes __admin__');
  assertEq(plan.created, 2, 'created alice+bob');
  assertEq(plan.missingAuthUid, 1, 'cara missing authUid');
  assert(plan.updates['authDirectory/alice'] != null, 'alice update');
  assert(plan.updates['authDirectory/__admin__'] == null, 'no __admin__ entry');
}

// Matching gen0 unchanged
{
  const plan = buildAuthDirectoryBackfillPlan({
    playersSnapshot: { alice: { authUid: 'uidA' } },
    authDirectorySnapshot: {
      alice: {
        loginEmail: 'alice@scicards.local',
        authUid: 'uidA',
        generation: 0,
      },
    },
  });
  assertEq(plan.created, 0, 'idempotent created');
  assertEq(plan.unchanged, 1, 'idempotent unchanged');
  assertEq(Object.keys(plan.updates).length, 0, 'idempotent no writes');
}

// Conflict non-gen0
{
  const plan = buildAuthDirectoryBackfillPlan({
    playersSnapshot: { alice: { authUid: 'uidA' } },
    authDirectorySnapshot: {
      alice: {
        loginEmail: 'alice.g1.tok@scicards.local',
        authUid: 'uidNew',
        generation: 1,
      },
    },
  });
  assertEq(plan.conflicts, 1, 'conflict counted');
  assertEq(Object.keys(plan.updates).length, 0, 'conflict no overwrite');
  assertEq(plan.conflictDetails[0].reason, 'CONFLICT_NOT_GEN0_MATCH', 'conflict reason');
}

// UID mismatch vs desired gen0
{
  const plan = buildAuthDirectoryBackfillPlan({
    playersSnapshot: { alice: { authUid: 'uidA' } },
    authDirectorySnapshot: {
      alice: {
        loginEmail: 'alice@scicards.local',
        authUid: 'OTHER',
        generation: 0,
      },
    },
  });
  assertEq(plan.conflicts, 1, 'uid mismatch is conflict');
}

console.log(failed ? `\nFAILED: ${failed}` : '\nOption C-a authDirectory tests: ALL PASSED');
if (failed) process.exit(1);
