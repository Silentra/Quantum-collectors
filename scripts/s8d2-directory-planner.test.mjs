/**
 * S8d-2 pure planner unit tests (no Firebase / no DB cache).
 *
 * Run: node scripts/s8d2-directory-planner.test.mjs
 */

import {
  buildPlayerDirectoryRebuildPlan,
  getDirectoryDriftReportFromSnapshots,
  diffDirectoryRebuildRows,
  DIRECTORY_ROOT,
} from '../js/player-directory.js';

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
  const ok = JSON.stringify(a) === JSON.stringify(b);
  assert(ok, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

// Matching → unchanged
{
  const players = {
    alice: { groupId: 'g1', isAdmin: false, isTradeRestricted: false, isTradeProfileHidden: false },
    bob: { groupId: 'g1', subgroupId: 's1', isAdmin: true },
    cara: { group: 'legacyG', subgroup: 'legacyS' },
  };
  const directory = {
    alice: {
      username: 'alice',
      groupId: 'g1',
      subgroupId: null,
      isAdmin: false,
      isTradeRestricted: false,
      isTradeProfileHidden: false,
    },
    bob: {
      username: 'bob',
      groupId: 'g1',
      subgroupId: 's1',
      isAdmin: true,
      isTradeRestricted: false,
      isTradeProfileHidden: false,
    },
    cara: {
      username: 'cara',
      groupId: 'legacyG',
      subgroupId: 'legacyS',
      isAdmin: false,
      isTradeRestricted: false,
      isTradeProfileHidden: false,
    },
  };
  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: players,
    directorySnapshot: directory,
  });
  assert(plan.ok === true, 'matching: ok');
  assertEq(plan.scanned, 3, 'matching: scanned');
  assertEq(plan.created, 0, 'matching: created');
  assertEq(plan.updated, 0, 'matching: updated');
  assertEq(plan.removed, 0, 'matching: removed');
  assertEq(plan.unchanged, 3, 'matching: unchanged');
  assertEq(Object.keys(plan.updates).length, 0, 'matching: empty updates');
}

// Missing directory row → create
{
  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: {
      dana: { groupId: 'g2', isTradeRestricted: true },
    },
    directorySnapshot: {},
  });
  assertEq(plan.created, 1, 'create: created');
  assertEq(plan.updates[`${DIRECTORY_ROOT}/dana`].username, 'dana', 'create: username');
  assertEq(plan.updates[`${DIRECTORY_ROOT}/dana`].groupId, 'g2', 'create: groupId');
  assertEq(plan.updates[`${DIRECTORY_ROOT}/dana`].isTradeRestricted, true, 'create: restricted');
}

// Field drift → update
{
  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: {
      eve: { groupId: 'newG', isAdmin: true },
    },
    directorySnapshot: {
      eve: {
        username: 'eve',
        groupId: 'oldG',
        subgroupId: null,
        isAdmin: false,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
      },
    },
  });
  assertEq(plan.updated, 1, 'update: updated');
  assertEq(plan.updates[`${DIRECTORY_ROOT}/eve`].groupId, 'newG', 'update: groupId');
  assertEq(plan.updates[`${DIRECTORY_ROOT}/eve`].isAdmin, true, 'update: isAdmin mirror');
}

// Ghost directory → remove
{
  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: { frank: {} },
    directorySnapshot: {
      frank: {
        username: 'frank',
        groupId: null,
        subgroupId: null,
        isAdmin: false,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
      },
      ghost: {
        username: 'ghost',
        groupId: null,
        subgroupId: null,
        isAdmin: false,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
      },
    },
  });
  assertEq(plan.removed, 1, 'ghost: removed');
  assertEq(plan.updates[`${DIRECTORY_ROOT}/ghost`], null, 'ghost: null update');
  assert(plan.removedKeys.includes('ghost'), 'ghost: removedKeys');
}

// Legacy no authUid retained
{
  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: {
      legacy: { groupId: 'g1' }, // no authUid
    },
    directorySnapshot: {},
  });
  assertEq(plan.created, 1, 'legacy: created not deleted');
  assertEq(plan.removed, 0, 'legacy: no remove');
  assert(plan.updates[`${DIRECTORY_ROOT}/legacy`] != null, 'legacy: projected');
}

// __admin__ excluded; __admin__ dir ghost removed
{
  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: {
      __admin__: { isAdmin: true },
      gil: {},
    },
    directorySnapshot: {
      gil: {
        username: 'gil',
        groupId: null,
        subgroupId: null,
        isAdmin: false,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
      },
      __admin__: {
        username: '__admin__',
        groupId: null,
        subgroupId: null,
        isAdmin: true,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
      },
    },
  });
  assertEq(plan.scanned, 1, '__admin__: scanned excludes infra');
  assertEq(plan.removed, 1, '__admin__: dir ghost removed');
  assertEq(plan.updates[`${DIRECTORY_ROOT}/__admin__`], null, '__admin__: null');
}

// Empty players → remove all directory
{
  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: null,
    directorySnapshot: {
      a: { username: 'a', groupId: null, subgroupId: null, isAdmin: false, isTradeRestricted: false, isTradeProfileHidden: false },
      b: { username: 'b', groupId: null, subgroupId: null, isAdmin: false, isTradeRestricted: false, isTradeProfileHidden: false },
    },
  });
  assertEq(plan.scanned, 0, 'empty: scanned');
  assertEq(plan.removed, 2, 'empty: remove all');
  assertEq(plan.updates[`${DIRECTORY_ROOT}/a`], null, 'empty: a');
  assertEq(plan.updates[`${DIRECTORY_ROOT}/b`], null, 'empty: b');
}

// Malformed player body → retained username, safe projection
{
  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: {
      broken: null,
      alsoBad: 'string',
    },
    directorySnapshot: {
      broken: {
        username: 'broken',
        groupId: 'keep-me-from-orphan',
        subgroupId: null,
        isAdmin: true,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
      },
    },
  });
  assertEq(plan.scanned, 2, 'malformed: scanned');
  assertEq(plan.skippedMalformed, 2, 'malformed: skippedMalformed');
  assertEq(plan.removed, 0, 'malformed: not orphan-deleted');
  assertEq(plan.updated, 1, 'malformed: broken updated to defaults');
  assertEq(plan.created, 1, 'malformed: alsoBad created');
  assertEq(plan.updates[`${DIRECTORY_ROOT}/broken`].isAdmin, false, 'malformed: safe isAdmin');
  assertEq(plan.updates[`${DIRECTORY_ROOT}/broken`].groupId, null, 'malformed: safe groupId');
}

// Drift helper from snapshots
{
  const drift = getDirectoryDriftReportFromSnapshots(
    { x: { groupId: 'g' } },
    {
      y: {
        username: 'y',
        groupId: null,
        subgroupId: null,
        isAdmin: false,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
      },
    },
  );
  assertEq(drift.missing, ['x'], 'drift: missing');
  assertEq(drift.orphans, ['y'], 'drift: orphans');
}

// Planner purity: no accidental db import side-effect required for plan
{
  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: { zed: {} },
    directorySnapshot: null,
  });
  assert(plan.ok && plan.created === 1, 'purity: plans without directory object');
}

// Idempotency: desired null group vs stored missing keys → unchanged
{
  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: {
      alice: {}, // no group → desired groupId/subgroupId null
    },
    directorySnapshot: {
      // Firebase-style: null fields omitted after write
      alice: {
        username: 'alice',
        isAdmin: false,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
      },
    },
  });
  assertEq(plan.updated, 0, 'idempotency null-group: updated');
  assertEq(plan.unchanged, 1, 'idempotency null-group: unchanged');
  assertEq(Object.keys(plan.updates).length, 0, 'idempotency null-group: no writes');
}

// Idempotency: desired null subgroup vs stored missing subgroupId
{
  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: {
      bob: { groupId: 'g1' }, // subgroup null
    },
    directorySnapshot: {
      bob: {
        username: 'bob',
        groupId: 'g1',
        isAdmin: false,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
      },
    },
  });
  assertEq(plan.updated, 0, 'idempotency null-subgroup: updated');
  assertEq(plan.unchanged, 1, 'idempotency null-subgroup: unchanged');
}

// Idempotency: desired false booleans vs stored missing booleans
{
  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: {
      cara: { groupId: 'g1', subgroupId: 's1' },
    },
    directorySnapshot: {
      cara: {
        username: 'cara',
        groupId: 'g1',
        subgroupId: 's1',
        // booleans omitted
      },
    },
  });
  assertEq(plan.updated, 0, 'idempotency missing-bools: updated');
  assertEq(plan.unchanged, 1, 'idempotency missing-bools: unchanged');
}

// Real group drift still updates
{
  const plan = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: {
      dana: { groupId: 'gNew' },
    },
    directorySnapshot: {
      dana: {
        username: 'dana',
        groupId: 'gOld',
        isAdmin: false,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
      },
    },
  });
  assertEq(plan.updated, 1, 'real drift: updated');
  assertEq(plan.updates[`${DIRECTORY_ROOT}/dana`].groupId, 'gNew', 'real drift: groupId');
}

// Two-pass Firebase-style: write strips null keys, second plan is no-op
{
  const players = {
    p1: {},
    p2: { groupId: 'g1' },
    p3: { groupId: 'g1', subgroupId: 's1', isAdmin: true },
    p4: { isTradeRestricted: true },
    p5: { group: 'legacyG' },
  };
  let directory = {};

  const pass1 = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: players,
    directorySnapshot: directory,
  });
  assertEq(pass1.created, 5, 'two-pass: first creates 5');

  // Apply like RTDB: delete null-valued keys from written objects; null path deletes leaf
  directory = { ...directory };
  for (const [path, value] of Object.entries(pass1.updates)) {
    const key = path.slice(`${DIRECTORY_ROOT}/`.length);
    if (value == null) {
      delete directory[key];
      continue;
    }
    const stored = {};
    for (const [fk, fv] of Object.entries(value)) {
      if (fv !== null && fv !== undefined) stored[fk] = fv;
    }
    directory[key] = stored;
  }

  const pass2 = buildPlayerDirectoryRebuildPlan({
    playersSnapshot: players,
    directorySnapshot: directory,
  });
  assertEq(pass2.created, 0, 'two-pass: second created');
  assertEq(pass2.updated, 0, 'two-pass: second updated');
  assertEq(pass2.removed, 0, 'two-pass: second removed');
  assertEq(pass2.unchanged, 5, 'two-pass: second unchanged');
  assertEq(Object.keys(pass2.updates).length, 0, 'two-pass: second empty updates');
}

// Diagnostic: real field difference reported
{
  const players = {
    alice: { groupId: 'g1', isAdmin: false },
  };
  const directory = {
    alice: {
      username: 'alice',
      groupId: 'g2',
      isAdmin: false,
      isTradeRestricted: false,
      isTradeProfileHidden: false,
    },
  };
  const beforePlayers = JSON.stringify(players);
  const beforeDir = JSON.stringify(directory);
  const diff = diffDirectoryRebuildRows(players, directory);
  assert(diff.readOnly === true, 'diag real-diff: readOnly');
  assertEq(diff.updatedCount, 1, 'diag real-diff: updatedCount');
  assertEq(diff.updated.length, 1, 'diag real-diff: updated rows');
  assertEq(diff.updated[0].username, 'alice', 'diag real-diff: username');
  assert(diff.updated[0].differences.groupId != null, 'diag real-diff: groupId difference');
  assertEq(diff.updated[0].differences.groupId.desiredNormalized, 'g1', 'diag real-diff: desired groupId');
  assertEq(diff.updated[0].differences.groupId.actualNormalized, 'g2', 'diag real-diff: actual groupId');
  assertEq(JSON.stringify(players), beforePlayers, 'diag real-diff: players snapshot unchanged');
  assertEq(JSON.stringify(directory), beforeDir, 'diag real-diff: directory snapshot unchanged');
}

// Diagnostic: null/missing group equivalence → no updated rows / no differences
{
  const diff = diffDirectoryRebuildRows(
    { alice: {} },
    {
      alice: {
        username: 'alice',
        isAdmin: false,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
      },
    },
  );
  assertEq(diff.updatedCount, 0, 'diag null-group: updatedCount');
  assertEq(diff.updated.length, 0, 'diag null-group: no updated rows');
  assertEq(diff.unchanged, 1, 'diag null-group: unchanged');
}

// Diagnostic: missing false booleans → no difference
{
  const diff = diffDirectoryRebuildRows(
    { bob: { groupId: 'g1' } },
    {
      bob: {
        username: 'bob',
        groupId: 'g1',
      },
    },
  );
  assertEq(diff.updatedCount, 0, 'diag missing-bool: updatedCount');
  assertEq(diff.updated.length, 0, 'diag missing-bool: no updated rows');
}

// Diagnostic: extra irrelevant keys do not create false drift
{
  const diff = diffDirectoryRebuildRows(
    {
      cara: {
        groupId: 'g1',
        isAdmin: false,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
      },
    },
    {
      cara: {
        username: 'cara',
        groupId: 'g1',
        subgroupId: null,
        isAdmin: false,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
        legacyNoise: 'ignore-me',
        score: 99,
      },
    },
  );
  assertEq(diff.updatedCount, 0, 'diag extra-keys: updatedCount');
  assertEq(diff.updated.length, 0, 'diag extra-keys: no false drift');
}

// Diagnostic: when drift exists, extra keys reported separately (not as projected differences)
{
  const diff = diffDirectoryRebuildRows(
    { dave: { groupId: 'newG' } },
    {
      dave: {
        username: 'dave',
        groupId: 'oldG',
        isAdmin: false,
        isTradeRestricted: false,
        isTradeProfileHidden: false,
        noise: 1,
      },
    },
  );
  assertEq(diff.updatedCount, 1, 'diag extra+drift: updatedCount');
  assert(diff.updated[0].differences.groupId != null, 'diag extra+drift: groupId in differences');
  assert(diff.updated[0].differences.noise == null, 'diag extra+drift: noise not in differences');
  assert(diff.updated[0].extraActualKeys.includes('noise'), 'diag extra+drift: noise in extraActualKeys');
  assert(diff.readOnly === true, 'diag extra+drift: readOnly');
}

if (failed) {
  console.error(`\nS8d-2 planner tests: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log('\nS8d-2 planner tests: ALL PASSED');
}
