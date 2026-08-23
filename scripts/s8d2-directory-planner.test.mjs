/**
 * S8d-2 pure planner unit tests (no Firebase / no DB cache).
 *
 * Run: node scripts/s8d2-directory-planner.test.mjs
 */

import {
  buildPlayerDirectoryRebuildPlan,
  getDirectoryDriftReportFromSnapshots,
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

if (failed) {
  console.error(`\nS8d-2 planner tests: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log('\nS8d-2 planner tests: ALL PASSED');
}
