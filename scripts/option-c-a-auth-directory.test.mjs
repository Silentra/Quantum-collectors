/**
 * Option C-a.1 — authDirectory helpers / per-user backfill gather tests.
 * Run: node scripts/option-c-a-auth-directory.test.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGen0AuthDirectoryEntry,
  parseAuthDirectoryEntry,
  buildAuthDirectoryBackfillPlan,
  authDirectoryPathsForRegistration,
  usernameToAuthEmail,
  gatherAuthDirectorySnapshotByUsernames,
  OPTION_CA_FOUNDATION_VERSION,
  AUTH_DIRECTORY_ROOT,
} from '../js/auth-directory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

assertEq(OPTION_CA_FOUNDATION_VERSION, 'option-c-a-1.1', 'foundation version C-a.1');

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
  const paths = authDirectoryPathsForRegistration('sam', 'uidSam');
  assertEq(paths['authDirectory/sam'].authUid, 'uidSam', 'registration path');
  assertEq(paths['authDirectory/sam'].generation, 0, 'registration gen0');
}

// Per-user gather: 5 users, mix of present + null missing
{
  const calls = [];
  const fakeStore = {
    alice: { loginEmail: 'alice@scicards.local', authUid: 'uidA', generation: 0 },
    bob: { loginEmail: 'bob@scicards.local', authUid: 'uidB', generation: 0 },
    // cara missing
    dana: { loginEmail: 'dana@scicards.local', authUid: 'uidD', generation: 0 },
    eve: null,
  };
  const loadPathOnce = async (path) => {
    calls.push(path);
    assert(path !== AUTH_DIRECTORY_ROOT, 'gather must never load authDirectory parent');
    assert(path.startsWith(`${AUTH_DIRECTORY_ROOT}/`), 'gather loads child paths only');
    const u = path.slice(`${AUTH_DIRECTORY_ROOT}/`.length);
    return { ok: true, mode: 'firebase', value: fakeStore[u] ?? null, path };
  };

  const usernames = ['alice', 'bob', 'cara', 'dana', 'eve'];
  const g = await gatherAuthDirectorySnapshotByUsernames(usernames, { loadPathOnce });
  assert(g.ok === true, 'gather 5 users ok');
  assertEq(Object.keys(g.authDirectorySnapshot).length, 3, '3 present entries assembled');
  assert(g.authDirectorySnapshot.alice != null, 'alice present');
  assert(g.authDirectorySnapshot.cara == null, 'cara missing omitted');
  assert(g.authDirectorySnapshot.eve == null, 'eve null omitted');
  assertEq(calls.length, 5, 'five child reads');
  assert(!calls.includes(AUTH_DIRECTORY_ROOT), 'no parent path in calls');
}

// One failed child read aborts
{
  const loadPathOnce = async (path) => {
    if (path.endsWith('/bob')) {
      return { ok: false, mode: 'firebase', error: 'PERMISSION_DENIED', value: null };
    }
    return { ok: true, mode: 'firebase', value: null, path };
  };
  const g = await gatherAuthDirectorySnapshotByUsernames(['alice', 'bob', 'cara'], {
    loadPathOnce,
  });
  assert(g.ok === false, 'failed child aborts gather');
  assertEq(g.failedUsername, 'bob', 'failedUsername=bob');
  assert(g.authDirectorySnapshot == null, 'no partial snapshot on abort');
}

// mode !== firebase aborts
{
  const loadPathOnce = async () => ({ ok: true, mode: 'local', value: null });
  const g = await gatherAuthDirectorySnapshotByUsernames(['alice'], { loadPathOnce });
  assert(g.ok === false, 'non-firebase mode aborts');
}

// Planner: create / unchanged / conflict / missing authUid (5-player style)
{
  const playersSnapshot = {
    __admin__: { authUid: 'adminX' },
    a1: { authUid: 'u1' },
    a2: { authUid: 'u2' },
    a3: { authUid: 'u3' },
    a4: { authUid: 'u4' },
    a5: {},
  };
  const authDirectorySnapshot = {
    a2: {
      loginEmail: 'a2@scicards.local',
      authUid: 'u2',
      generation: 0,
    },
    a3: {
      loginEmail: 'a3.g1.x@scicards.local',
      authUid: 'other',
      generation: 1,
    },
  };
  const plan = buildAuthDirectoryBackfillPlan({
    playersSnapshot,
    authDirectorySnapshot,
  });
  assertEq(plan.scanned, 5, 'scanned 5');
  assertEq(plan.created, 2, 'create a1+a4');
  assertEq(plan.unchanged, 1, 'unchanged a2');
  assertEq(plan.conflicts, 1, 'conflict a3');
  assertEq(plan.missingAuthUid, 1, 'missing a5');
  assert(plan.updates['authDirectory/a1'] != null, 'a1 create');
  assert(plan.updates['authDirectory/a2'] == null, 'a2 no write');
  assert(plan.updates['authDirectory/a3'] == null, 'a3 no overwrite');
}

// Second backfill idempotent
{
  const playersSnapshot = {
    alice: { authUid: 'uidA' },
    bob: { authUid: 'uidB' },
  };
  const authDirectorySnapshot = {
    alice: buildGen0AuthDirectoryEntry('alice', 'uidA'),
    bob: buildGen0AuthDirectoryEntry('bob', 'uidB'),
  };
  const plan = buildAuthDirectoryBackfillPlan({ playersSnapshot, authDirectorySnapshot });
  assertEq(plan.created, 0, 'idempotent created');
  assertEq(plan.unchanged, 2, 'idempotent unchanged');
  assertEq(Object.keys(plan.updates).length, 0, 'idempotent no writes');
}

// Static: prepareAuthDirectoryBackfill source must not parent-load AUTH_DIRECTORY_ROOT alone
{
  const src = readFileSync(
    resolve(__dirname, '../js/auth-directory.js'),
    'utf8',
  );
  // Disallow loadPathOnce(AUTH_DIRECTORY_ROOT or 'authDirectory' as sole path
  const parentLoad = /loadPathOnce\(\s*AUTH_DIRECTORY_ROOT\s*,/.test(src)
    || /loadPathOnce\(\s*['"]authDirectory['"]\s*,/.test(src);
  assert(!parentLoad, 'source has no authDirectory parent loadPathOnce');
  assert(
    src.includes('gatherAuthDirectorySnapshotByUsernames'),
    'prepare uses per-user gather helper',
  );
}

console.log(failed ? `\nFAILED: ${failed}` : '\nOption C-a.1 authDirectory tests: ALL PASSED');
if (failed) process.exit(1);
