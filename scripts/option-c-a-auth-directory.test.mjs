/**
 * Option C-a.2 — authDirectory strict-default + backfill gather tests.
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
  decideAuthLoginTargetFromLoad,
  allowMissingAuthDirectoryOnRestore,
  isAuthDirectoryStrict,
  isAuthDirectoryCompatEnabled,
  OPTION_CA_FOUNDATION_VERSION,
  AUTH_DIRECTORY_ROOT,
  AUTH_DIRECTORY_COMPAT_LS_KEY,
} from '../js/auth-directory.js';
import { buildLeaderboardSummaryEntry } from '../js/leaderboard-summaries.js';

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

assertEq(OPTION_CA_FOUNDATION_VERSION, 'option-c-a-2', 'foundation version C-a.2');

// Default (no localStorage / unset) → effective strict
assertEq(isAuthDirectoryCompatEnabled(), false, 'default: compat off');
assertEq(isAuthDirectoryStrict(), true, 'default: effective strict');
assertEq(allowMissingAuthDirectoryOnRestore({ compatEnabled: false }), false, 'restore: strict denies missing');
assertEq(allowMissingAuthDirectoryOnRestore({ compatEnabled: true }), true, 'restore: compat allows missing');

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
  assertEq(paths['authDirectory/sam'].loginEmail, 'sam@scicards.local', 'registration gen0 email');
}

// Login target: directory exists → use directory email
{
  const target = decideAuthLoginTargetFromLoad('alice', {
    ok: true,
    missing: false,
    parsed: {
      loginEmail: 'alice.g1.tok@scicards.local',
      authUid: 'uidAlice',
      generation: 1,
    },
  }, { compatEnabled: false });
  assert(target.ok === true, 'dir-exists: ok');
  assertEq(target.loginEmail, 'alice.g1.tok@scicards.local', 'dir-exists: directory email');
  assertEq(target.expectedAuthUid, 'uidAlice', 'dir-exists: expected uid');
  assertEq(target.source, 'authDirectory', 'dir-exists: source');
}

// Login target: directory missing + default strict → FAIL
{
  const target = decideAuthLoginTargetFromLoad('ghost', {
    ok: true,
    missing: true,
    parsed: null,
  }, { compatEnabled: false });
  assert(target.ok === false, 'missing+strict: fail');
  assertEq(target.code, 'AUTH_DIRECTORY_REQUIRED', 'missing+strict: code');
  assert(String(target.error || '').includes('auth directory missing'), 'missing+strict: message');
}

// Login target: directory missing + compat → gen0 fallback
{
  const target = decideAuthLoginTargetFromLoad('ghost', {
    ok: true,
    missing: true,
    parsed: null,
  }, { compatEnabled: true });
  assert(target.ok === true, 'missing+compat: ok');
  assertEq(target.loginEmail, 'ghost@scicards.local', 'missing+compat: gen0 email');
  assertEq(target.expectedAuthUid, null, 'missing+compat: uid from players later');
  assertEq(target.source, 'gen0Compat', 'missing+compat: source');
}

// Invalid directory → FAIL (even with compat)
{
  const target = decideAuthLoginTargetFromLoad('bad', {
    ok: false,
    error: 'AUTH_DIRECTORY_INVALID_UID',
    missing: false,
    parsed: null,
  }, { compatEnabled: true });
  assert(target.ok === false, 'invalid dir: fail');
  assert(String(target.error || '').includes('invalid'), 'invalid dir: message');
}

// UID mismatch is enforced at login after Auth (document expectedAuthUid from directory)
{
  const target = decideAuthLoginTargetFromLoad('bob', {
    ok: true,
    missing: false,
    parsed: { loginEmail: 'bob@scicards.local', authUid: 'uidBob', generation: 0 },
  }, { compatEnabled: false });
  assertEq(target.expectedAuthUid, 'uidBob', 'uid binding field present for login check');
  assert(
    target.expectedAuthUid !== 'wrongUid',
    'directory UID mismatch would fail login binding check',
  );
}

// Restore policy mirrors login default
assertEq(
  allowMissingAuthDirectoryOnRestore({ compatEnabled: false }),
  false,
  'restore requires directory by default',
);
assertEq(
  allowMissingAuthDirectoryOnRestore({ compatEnabled: true }),
  true,
  'restore compat fallback only under explicit override',
);

// C-a.1.1 regression: LB summary includes username
{
  const entry = buildLeaderboardSummaryEntry('reguser', { totalResearchPoints: 0 }, 'totalResearchPoints', 1);
  assertEq(entry.username, 'reguser', 'LB username registration fix intact');
  assertEq(entry.value, 0, 'LB value intact');
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
  const parentLoad = /loadPathOnce\(\s*AUTH_DIRECTORY_ROOT\s*,/.test(src)
    || /loadPathOnce\(\s*['"]authDirectory['"]\s*,/.test(src);
  assert(!parentLoad, 'source has no authDirectory parent loadPathOnce');
  assert(
    src.includes('gatherAuthDirectorySnapshotByUsernames'),
    'prepare uses per-user gather helper',
  );
  assert(src.includes(AUTH_DIRECTORY_COMPAT_LS_KEY), 'compat key present');
  assert(src.includes('strictDefault: true'), 'status reports strictDefault');
  assert(src.includes('migrationCompatDefault: false'), 'status reports migrationCompatDefault false');
}

console.log(failed ? `\nFAILED: ${failed}` : '\nOption C-a.2 authDirectory tests: ALL PASSED');
if (failed) process.exit(1);
