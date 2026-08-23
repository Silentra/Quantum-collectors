/**
 * S8d-3 pure leaderboard rebuild planner tests (no Firebase / no DB cache).
 *
 * Run: node scripts/s8d3-leaderboard-planner.test.mjs
 */

import {
  buildLeaderboardRebuildPlan,
  LIVE_LEADERBOARD_STAT_KEYS,
  LEADERBOARDS_ROOT,
  leaderboardEntriesEqual,
  normalizeLeaderboardEntry,
} from '../js/leaderboard-summaries.js';

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

const NOW = 1_700_000_000_000;

function denseMatchingLb(players, now = NOW) {
  /** @type {Record<string, object>} */
  const lb = {};
  for (const statKey of LIVE_LEADERBOARD_STAT_KEYS) {
    lb[statKey] = {};
  }
  for (const [username, player] of Object.entries(players)) {
    const plan = buildLeaderboardRebuildPlan({
      playersSnapshot: { [username]: player },
      leaderboardSnapshot: null,
      now,
    });
    for (const [path, entry] of Object.entries(plan.updates)) {
      const [, statKey, user] = path.split('/');
      if (!lb[statKey]) lb[statKey] = {};
      lb[statKey][user] = { ...entry };
    }
  }
  return lb;
}

// Matching rows → unchanged
{
  const players = {
    alice: {
      totalResearchPoints: 10,
      seasonalResearchPoints: 2,
      projectsCompleted: 1,
      stats: { packsOpened: 3, tradesCompleted: 4, uniqueCardsOwned: 5 },
      researchStats: { breakthroughs: 0 },
      groupId: 'g1',
      subgroupId: 's1',
    },
  };
  const lb = denseMatchingLb(players);
  const plan = buildLeaderboardRebuildPlan({
    playersSnapshot: players,
    leaderboardSnapshot: lb,
    now: NOW + 999,
  });
  assert(plan.ok === true, 'matching: ok');
  assertEq(plan.created, 0, 'matching: created');
  assertEq(plan.updated, 0, 'matching: updated');
  assertEq(plan.removed, 0, 'matching: removed');
  assertEq(plan.unchanged, LIVE_LEADERBOARD_STAT_KEYS.length, 'matching: unchanged');
  assertEq(Object.keys(plan.updates).length, 0, 'matching: no writes');
}

// Missing row → create
{
  const players = { bob: { stats: { packsOpened: 7 } } };
  const lb = denseMatchingLb(players);
  delete lb.packsOpened.bob;
  const plan = buildLeaderboardRebuildPlan({
    playersSnapshot: players,
    leaderboardSnapshot: lb,
    now: NOW,
  });
  assertEq(plan.created, 1, 'missing-row: created');
  assertEq(plan.updated, 0, 'missing-row: updated');
  const path = `${LEADERBOARDS_ROOT}/packsOpened/bob`;
  assert(plan.updates[path] != null, 'missing-row: packsOpened path');
  assertEq(plan.updates[path].value, 7, 'missing-row: value');
}

// Wrong value → update
{
  const players = { cara: { totalResearchPoints: 50 } };
  const lb = denseMatchingLb(players);
  lb.totalResearchPoints.cara.value = 1;
  const plan = buildLeaderboardRebuildPlan({
    playersSnapshot: players,
    leaderboardSnapshot: lb,
    now: NOW,
  });
  assertEq(plan.updated, 1, 'wrong-value: updated');
  assertEq(plan.updates[`${LEADERBOARDS_ROOT}/totalResearchPoints/cara`].value, 50, 'wrong-value: repaired');
}

// Wrong groupId → update
{
  const players = { dana: { groupId: 'newG', totalResearchPoints: 0 } };
  const lb = denseMatchingLb(players);
  for (const sk of LIVE_LEADERBOARD_STAT_KEYS) {
    lb[sk].dana.groupId = 'oldG';
  }
  const plan = buildLeaderboardRebuildPlan({
    playersSnapshot: players,
    leaderboardSnapshot: lb,
    now: NOW,
  });
  assertEq(plan.updated, LIVE_LEADERBOARD_STAT_KEYS.length, 'wrong-groupId: all stats updated');
  assertEq(plan.updates[`${LEADERBOARDS_ROOT}/totalResearchPoints/dana`].groupId, 'newG', 'wrong-groupId: repaired');
}

// Wrong subgroupId → update
{
  const players = { eve: { groupId: 'g1', subgroupId: 'newS' } };
  const lb = denseMatchingLb(players);
  for (const sk of LIVE_LEADERBOARD_STAT_KEYS) {
    lb[sk].eve.subgroupId = 'oldS';
  }
  const plan = buildLeaderboardRebuildPlan({
    playersSnapshot: players,
    leaderboardSnapshot: lb,
    now: NOW,
  });
  assertEq(plan.updated, LIVE_LEADERBOARD_STAT_KEYS.length, 'wrong-subgroupId: all updated');
  assertEq(
    plan.updates[`${LEADERBOARDS_ROOT}/projectsCompleted/eve`].subgroupId,
    'newS',
    'wrong-subgroupId: repaired',
  );
}

// Deleted-player ghost → remove
{
  const players = { alive: {} };
  const lb = denseMatchingLb({
    alive: {},
    ghost: {},
  });
  const plan = buildLeaderboardRebuildPlan({
    playersSnapshot: players,
    leaderboardSnapshot: lb,
    now: NOW,
  });
  assertEq(plan.removed, LIVE_LEADERBOARD_STAT_KEYS.length, 'ghost: remove all ghost rows');
  for (const sk of LIVE_LEADERBOARD_STAT_KEYS) {
    assertEq(plan.updates[`${LEADERBOARDS_ROOT}/${sk}/ghost`], null, `ghost: null ${sk}`);
  }
}

// Missing canonical stat → value 0
{
  const players = { frank: {} }; // no stats
  const plan = buildLeaderboardRebuildPlan({
    playersSnapshot: players,
    leaderboardSnapshot: null,
    now: NOW,
  });
  assertEq(plan.created, LIVE_LEADERBOARD_STAT_KEYS.length, 'missing-stat: create dense zeros');
  for (const sk of LIVE_LEADERBOARD_STAT_KEYS) {
    assertEq(plan.updates[`${LEADERBOARDS_ROOT}/${sk}/frank`].value, 0, `missing-stat: ${sk}=0`);
  }
}

// Malformed player → retained with safe zero projection
{
  const plan = buildLeaderboardRebuildPlan({
    playersSnapshot: { broken: null },
    leaderboardSnapshot: null,
    now: NOW,
  });
  assertEq(plan.scannedPlayers, 1, 'malformed: still a player key');
  assertEq(plan.created, LIVE_LEADERBOARD_STAT_KEYS.length, 'malformed: dense create');
  assertEq(plan.updates[`${LEADERBOARDS_ROOT}/packsOpened/broken`].value, 0, 'malformed: packs 0');
  assertEq(plan.updates[`${LEADERBOARDS_ROOT}/packsOpened/broken`].groupId, null, 'malformed: null group');
}

// Confirmed empty players → remove known live rows
{
  const lb = {
    totalResearchPoints: { x: { value: 1, groupId: null, subgroupId: null, updatedAt: 1 } },
    packsOpened: { y: { value: 2, groupId: 'g', subgroupId: null, updatedAt: 1 } },
    // unknown future root — must not be orphan-scanned
    futureStat: { z: { value: 9, updatedAt: 1 } },
  };
  const plan = buildLeaderboardRebuildPlan({
    playersSnapshot: {},
    leaderboardSnapshot: lb,
    now: NOW,
  });
  assertEq(plan.scannedPlayers, 0, 'empty-players: scannedPlayers');
  assertEq(plan.removed, 2, 'empty-players: remove only known live leaves');
  assertEq(plan.updates[`${LEADERBOARDS_ROOT}/totalResearchPoints/x`], null, 'empty-players: x');
  assertEq(plan.updates[`${LEADERBOARDS_ROOT}/packsOpened/y`], null, 'empty-players: y');
  assert(
    !Object.keys(plan.updates).some((p) => p.includes('futureStat')),
    'empty-players: ignore unknown roots',
  );
}

// updatedAt difference alone → unchanged
{
  const players = { gina: { totalResearchPoints: 3, groupId: 'g1' } };
  const lb = denseMatchingLb(players, NOW);
  for (const sk of LIVE_LEADERBOARD_STAT_KEYS) {
    lb[sk].gina.updatedAt = NOW - 99999;
  }
  const plan = buildLeaderboardRebuildPlan({
    playersSnapshot: players,
    leaderboardSnapshot: lb,
    now: NOW,
  });
  assertEq(plan.updated, 0, 'updatedAt-only: updated');
  assertEq(plan.unchanged, LIVE_LEADERBOARD_STAT_KEYS.length, 'updatedAt-only: unchanged');
  assertEq(Object.keys(plan.updates).length, 0, 'updatedAt-only: no writes');
}

// null/missing group fields → unchanged
{
  const players = { hank: { totalResearchPoints: 1 } }; // null groups
  const lb = {};
  for (const sk of LIVE_LEADERBOARD_STAT_KEYS) {
    // Firebase-style: omit null group keys
    lb[sk] = {
      hank: {
        value: sk === 'totalResearchPoints' ? 1 : 0,
        updatedAt: NOW,
      },
    };
  }
  const plan = buildLeaderboardRebuildPlan({
    playersSnapshot: players,
    leaderboardSnapshot: lb,
    now: NOW,
  });
  assertEq(plan.updated, 0, 'null-group: updated');
  assertEq(plan.unchanged, LIVE_LEADERBOARD_STAT_KEYS.length, 'null-group: unchanged');
}

// Equality helper sanity
{
  assert(
    leaderboardEntriesEqual(
      { value: 1, groupId: null, subgroupId: null, updatedAt: 1 },
      { value: 1, updatedAt: 2 },
    ),
    'equal: null vs missing groups + different updatedAt',
  );
  assertEq(normalizeLeaderboardEntry({ value: 'x' }).value, 0, 'normalize: non-finite → 0');
}

// Historical season/snapshot roots never appear in updates
{
  const plan = buildLeaderboardRebuildPlan({
    playersSnapshot: { iris: {} },
    leaderboardSnapshot: {
      packsOpened: {},
    },
    now: NOW,
  });
  for (const path of Object.keys(plan.updates)) {
    assert(path.startsWith(`${LEADERBOARDS_ROOT}/`), `paths under leaderboards: ${path}`);
    assert(!path.startsWith('leaderboardSeasons'), 'no seasons path');
    assert(!path.startsWith('leaderboardSnapshots'), 'no snapshots path');
  }
}

// Two-pass Firebase-style simulation
{
  const players = {
    a: { totalResearchPoints: 5, groupId: 'g1' },
    b: { stats: { packsOpened: 2 } },
    c: {},
  };
  let lb = {
    totalResearchPoints: {
      ghost: { value: 99, updatedAt: 1 },
    },
  };

  const pass1 = buildLeaderboardRebuildPlan({
    playersSnapshot: players,
    leaderboardSnapshot: lb,
    now: NOW,
  });
  assert(pass1.created > 0, 'two-pass: first creates');
  assert(pass1.removed >= 1, 'two-pass: first removes ghost');

  // Apply like RTDB: delete null paths; strip null fields from written objects
  lb = { ...lb };
  for (const [path, value] of Object.entries(pass1.updates)) {
    const [, statKey, username] = path.split('/');
    if (!lb[statKey]) lb[statKey] = {};
    if (value == null) {
      delete lb[statKey][username];
      continue;
    }
    const stored = {};
    for (const [fk, fv] of Object.entries(value)) {
      if (fv !== null && fv !== undefined) stored[fk] = fv;
    }
    lb[statKey][username] = stored;
  }

  const pass2 = buildLeaderboardRebuildPlan({
    playersSnapshot: players,
    leaderboardSnapshot: lb,
    now: NOW + 1,
  });
  assertEq(pass2.created, 0, 'two-pass: second created');
  assertEq(pass2.updated, 0, 'two-pass: second updated');
  assertEq(pass2.removed, 0, 'two-pass: second removed');
  assertEq(
    pass2.unchanged,
    Object.keys(players).length * LIVE_LEADERBOARD_STAT_KEYS.length,
    'two-pass: second unchanged',
  );
  assertEq(Object.keys(pass2.updates).length, 0, 'two-pass: empty updates');
}

// __admin__ excluded
{
  const plan = buildLeaderboardRebuildPlan({
    playersSnapshot: {
      __admin__: { totalResearchPoints: 999 },
      real: {},
    },
    leaderboardSnapshot: {
      totalResearchPoints: {
        __admin__: { value: 999, updatedAt: 1 },
      },
    },
    now: NOW,
  });
  assertEq(plan.scannedPlayers, 1, '__admin__: scannedPlayers');
  assert(
    plan.removedKeys.includes('totalResearchPoints/__admin__')
      || plan.updates[`${LEADERBOARDS_ROOT}/totalResearchPoints/__admin__`] === null,
    '__admin__: orphan-removed from LB',
  );
}

if (failed) {
  console.error(`\nS8d-3 leaderboard planner tests: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log('\nS8d-3 leaderboard planner tests: ALL PASSED');
}
