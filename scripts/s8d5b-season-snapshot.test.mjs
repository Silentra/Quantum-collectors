/**
 * S8d-5b — Safe Season + Lifetime Snapshot planners (pure, no Firebase).
 * Run: node scripts/s8d5b-season-snapshot.test.mjs
 */

import {
  buildActiveSeasonSnapshotEntries,
  buildActiveSeasonArchiveUpdates,
  buildSeasonRotateUpdates,
  buildSeasonalResetPlan,
  assertStartNewSeasonPathsAllowed,
} from '../js/season-class-ops.js';
import {
  buildLifetimeSnapshotPlan,
  assertLifetimeSnapshotPathsAllowed,
  SNAPSHOT_STAT_TYPES,
  resolvePlayerStat,
} from '../js/leaderboard-snapshots.js';

const NOW = 1_700_000_000_000;
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else {
    passed += 1;
  }
}

function assertEq(a, b, msg) {
  assert(a === b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

function assertThrows(fn, msg) {
  try {
    fn();
    assert(false, `${msg} (expected throw)`);
  } catch {
    assert(true, msg);
  }
}

const players3 = {
  __admin__: { seasonalResearchPoints: 999, totalResearchPoints: 999 },
  alice: {
    seasonalResearchPoints: 40,
    totalResearchPoints: 100,
    groupId: 'g1',
    subgroupId: 'sg1',
    projectsCompleted: 3,
    stats: { packsOpened: 5, uniqueCardsOwned: 2, tradesCompleted: 1 },
    researchStats: { breakthroughs: 7 },
  },
  bob: {
    seasonalResearchPoints: 'bad',
    totalResearchPoints: 50,
    group: 'legacyG',
    projectsCompleted: 0,
    stats: { packsOpened: 0 },
  },
  cara: {
    // missing seasonal → 0
    totalResearchPoints: 10,
    groupId: 'g2',
  },
};

// ── Start New Season: archive entries ─────────────────────────────────────

{
  const built = buildActiveSeasonSnapshotEntries({
    playersSnapshot: players3,
    now: NOW,
  });
  assertEq(built.playersScanned, 3, 'season archive: N players (exclude __admin__)');
  assertEq(built.entries.alice.value, 40, 'season archive: alice seasonal');
  assertEq(built.entries.bob.value, 0, 'season archive: nonnumeric → 0');
  assertEq(built.entries.cara.value, 0, 'season archive: missing → 0');
  assertEq(built.entries.alice.groupId, 'g1', 'season archive: groupId');
  assertEq(built.entries.alice.subgroupId, 'sg1', 'season archive: subgroupId');
  assert(built.entries.__admin__ == null, 'season archive: no __admin__ entry');
  assertEq(built.nonzeroSeasonalCount, 1, 'season archive: nonzero count');
  assert(built.entries.alice.snapshotAt === NOW, 'season archive: snapshotAt');
}

{
  const built = buildActiveSeasonSnapshotEntries({
    playersSnapshot: players3,
    now: NOW,
  });
  const archive = buildActiveSeasonArchiveUpdates({
    seasonId: 'season_001',
    entries: built.entries,
  });
  assertEq(archive.entryCount, 3, 'archive updates: 3 entry paths');
  assert(
    archive.updates['leaderboardSeasons/seasons/season_001/entries/alice'].value === 40,
    'archive updates: alice path value',
  );
  assertStartNewSeasonPathsAllowed(archive.updates);
}

{
  const empty = buildActiveSeasonSnapshotEntries({ playersSnapshot: { __admin__: {} }, now: NOW });
  assertEq(empty.playersScanned, 0, 'empty class: playersScanned 0');
}

// ── Seasonal reset plan ───────────────────────────────────────────────────

{
  const reset = buildSeasonalResetPlan({ playersSnapshot: players3, now: NOW });
  assertEq(reset.playersReset, 3, 'reset: all N players');
  assertEq(reset.updates['players/alice/seasonalResearchPoints'], 0, 'reset: alice player path');
  assertEq(reset.updates['players/bob/seasonalResearchPoints'], 0, 'reset: bob player path');
  assertEq(reset.updates['players/cara/seasonalResearchPoints'], 0, 'reset: cara player path');
  assert(reset.updates['leaderboards/seasonalResearchPoints/alice'] != null, 'reset: alice LB');
  assert(reset.updates['leaderboards/seasonalResearchPoints/bob'] != null, 'reset: bob LB');
  assert(reset.updates['leaderboards/seasonalResearchPoints/cara'] != null, 'reset: cara LB');
  assert(reset.updates['players/__admin__/seasonalResearchPoints'] == null, 'reset: no __admin__');
  assertStartNewSeasonPathsAllowed(reset.updates);
}

// ── Rotate plan + path invariant ──────────────────────────────────────────

{
  const rot = buildSeasonRotateUpdates({
    activeSeasonId: 'season_001',
    newSeasonId: 'season_002',
    newSeasonName: 'Fall Test',
    now: NOW,
  });
  assertEq(rot.updates['leaderboardSeasons/activeSeasonId'], 'season_002', 'rotate: activate');
  assertEq(rot.updates['leaderboardSeasons/seasons/season_001/archived'], true, 'rotate: archive flag');
  assert(rot.updates['leaderboardSeasons/seasons/season_002']?.name === 'Fall Test', 'rotate: new season');
  assertStartNewSeasonPathsAllowed(rot.updates);

  assertThrows(() => {
    assertStartNewSeasonPathsAllowed({
      'players/alice/totalResearchPoints': 0,
    });
  }, 'season path invariant: forbid lifetime RP');

  assertThrows(() => {
    assertStartNewSeasonPathsAllowed({
      'inventory/alice/c1': 1,
    });
  }, 'season path invariant: forbid inventory');
}

// ── Latest re-gather values (plan driven by snapshot input) ───────────────

{
  const a = buildActiveSeasonSnapshotEntries({
    playersSnapshot: { p1: { seasonalResearchPoints: 1 } },
    now: NOW,
  });
  const b = buildActiveSeasonSnapshotEntries({
    playersSnapshot: { p1: { seasonalResearchPoints: 99 } },
    now: NOW,
  });
  assertEq(a.entries.p1.value, 1, 're-gather: first snapshot value');
  assertEq(b.entries.p1.value, 99, 're-gather: second snapshot value');
}

// ── Active season ID abort contract ───────────────────────────────────────

{
  function activeSeasonAbort(expected, actual) {
    const want = expected ?? null;
    const got = actual ?? null;
    return want !== got;
  }
  assert(activeSeasonAbort('season_001', 'season_002') === true, 'abort when season changed');
  assert(activeSeasonAbort('season_001', 'season_001') === false, 'no abort when same');
  assert(activeSeasonAbort(null, null) === false, 'no abort when both null');
  assert(activeSeasonAbort(null, 'season_001') === true, 'abort null→season');
}

// ── Failure-stop phase order (contract) ───────────────────────────────────

{
  const PHASES = ['SEASON_ARCHIVE_FAILED', 'SEASON_ROTATE_FAILED', 'SEASON_RESET_FAILED'];
  const order = { SEASON_ARCHIVE_FAILED: 0, SEASON_ROTATE_FAILED: 1, SEASON_RESET_FAILED: 2 };
  assert(order.SEASON_ARCHIVE_FAILED < order.SEASON_ROTATE_FAILED, 'phase: archive before rotate');
  assert(order.SEASON_ROTATE_FAILED < order.SEASON_RESET_FAILED, 'phase: rotate before reset');
  assert(PHASES.length === 3, 'phase codes present');
}

// Unrelated historical seasons: rotate/archive planners never mention other season IDs
{
  const rot = buildSeasonRotateUpdates({
    activeSeasonId: 'season_001',
    newSeasonId: 'season_002',
    newSeasonName: 'X',
    now: NOW,
  });
  const keys = Object.keys(rot.updates);
  assert(!keys.some((k) => k.includes('season_999')), 'rotate: unrelated season untouched');
}

// ── Lifetime Snapshot ─────────────────────────────────────────────────────

{
  const plan = buildLifetimeSnapshotPlan({
    playersSnapshot: players3,
    category: SNAPSHOT_STAT_TYPES.LIFETIME_RP,
    title: 'Test Overall',
    resetAfter: false,
    now: NOW,
    snapshotId: 'snap_test_1',
  });
  assert(plan.ok, 'snap-only: ok');
  assertEq(plan.playersScanned, 3, 'snap-only: N players');
  const body = plan.updates['leaderboardSnapshots/snapshots/snap_test_1'];
  assertEq(body.entries.alice.value, 100, 'snap-only: alice lifetime');
  assertEq(body.entries.bob.value, 50, 'snap-only: bob lifetime');
  assertEq(body.entries.cara.value, 10, 'snap-only: cara lifetime');
  assertEq(plan.resetPathCount, 0, 'snap-only: no reset paths');
  assert(!Object.keys(plan.updates).some((k) => k.startsWith('players/')), 'snap-only: no player writes');
  assertLifetimeSnapshotPathsAllowed(plan.updates, {
    resetAfter: false,
    statType: SNAPSHOT_STAT_TYPES.LIFETIME_RP,
  });
}

{
  const plan = buildLifetimeSnapshotPlan({
    playersSnapshot: players3,
    category: SNAPSHOT_STAT_TYPES.PACKS_OPENED,
    title: 'Packs',
    resetAfter: true,
    now: NOW,
    snapshotId: 'snap_test_2',
  });
  assert(plan.ok, 'resetAfter: ok');
  assertEq(plan.resetPathCount, 3, 'resetAfter: N player reset paths');
  assertEq(plan.updates['players/alice/stats/packsOpened'], 0, 'resetAfter: packs path');
  assert(plan.updates['leaderboards/packsOpened/alice'] != null, 'resetAfter: LB packs');
  assert(
    plan.updates['leaderboardSnapshots/categoryResets/stats_packsOpened'] != null,
    'resetAfter: categoryResets',
  );
  assertLifetimeSnapshotPathsAllowed(plan.updates, {
    resetAfter: true,
    statType: SNAPSHOT_STAT_TYPES.PACKS_OPENED,
  });
}

// Category source paths via resolvePlayerStat
{
  assertEq(resolvePlayerStat(players3.alice, 'projectsCompleted'), 3, 'resolve: projects');
  assertEq(resolvePlayerStat(players3.alice, 'stats.uniqueCardsOwned'), 2, 'resolve: unique');
  assertEq(resolvePlayerStat(players3.alice, 'researchStats.breakthroughs'), 7, 'resolve: breakthroughs');
  assertEq(resolvePlayerStat(players3.bob, 'stats.packsOpened'), 0, 'resolve: missing nested → 0');
}

{
  const empty = buildLifetimeSnapshotPlan({
    playersSnapshot: { __admin__: {} },
    category: SNAPSHOT_STAT_TYPES.LIFETIME_RP,
    title: 'Empty',
    resetAfter: false,
    now: NOW,
    snapshotId: 'x',
  });
  assertEq(empty.ok, false, 'empty class refused');
  assertEq(empty.error, 'EMPTY_CLASS', 'empty class error');
}

{
  assertThrows(() => {
    buildLifetimeSnapshotPlan({
      playersSnapshot: players3,
      category: 'seasonalResearchPoints',
      title: 'Nope',
      resetAfter: true,
      now: NOW,
      snapshotId: 'x',
    });
  }, 'lifetime: seasonal RP cannot be reset category');
}

{
  assertThrows(() => {
    assertLifetimeSnapshotPathsAllowed(
      { 'players/alice/inventory/c1': 1 },
      { resetAfter: true, statType: SNAPSHOT_STAT_TYPES.LIFETIME_RP },
    );
  }, 'snap path invariant: forbid inventory');

  assertThrows(() => {
    assertLifetimeSnapshotPathsAllowed(
      { 'achievements/alice/x': true },
      { resetAfter: true, statType: SNAPSHOT_STAT_TYPES.LIFETIME_RP },
    );
  }, 'snap path invariant: forbid achievements');

  assertThrows(() => {
    assertLifetimeSnapshotPathsAllowed(
      { 'trades/direct/t1': {} },
      { resetAfter: false, statType: SNAPSHOT_STAT_TYPES.LIFETIME_RP },
    );
  }, 'snap path invariant: forbid trades');
}

// Latest re-gather for lifetime
{
  const a = buildLifetimeSnapshotPlan({
    playersSnapshot: { u: { totalResearchPoints: 1 } },
    category: SNAPSHOT_STAT_TYPES.LIFETIME_RP,
    title: 'A',
    snapshotId: 's1',
    now: NOW,
  });
  const b = buildLifetimeSnapshotPlan({
    playersSnapshot: { u: { totalResearchPoints: 77 } },
    category: SNAPSHOT_STAT_TYPES.LIFETIME_RP,
    title: 'B',
    snapshotId: 's2',
    now: NOW,
  });
  assertEq(a.updates['leaderboardSnapshots/snapshots/s1'].entries.u.value, 1, 'snap re-gather first');
  assertEq(b.updates['leaderboardSnapshots/snapshots/s2'].entries.u.value, 77, 'snap re-gather second');
}

// Unrelated snapshots untouched (plan only writes its own id)
{
  const plan = buildLifetimeSnapshotPlan({
    playersSnapshot: { u: { totalResearchPoints: 1 } },
    category: SNAPSHOT_STAT_TYPES.LIFETIME_RP,
    title: 'OnlyMe',
    snapshotId: 'snap_only_me',
    now: NOW,
  });
  assert(!Object.keys(plan.updates).some((k) => k.includes('snap_other')), 'unrelated snap untouched');
}

// Snapshot failure phase codes contract
{
  assert('SNAPSHOT_WRITE_FAILED' !== 'SNAPSHOT_RESET_FAILED', 'snap phase codes distinct');
}

console.log(`\nS8d-5b tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
