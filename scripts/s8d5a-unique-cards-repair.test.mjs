/**
 * S8d-5a pure Unique Cards repair planner tests (no Firebase / no DB cache).
 *
 * Run: node scripts/s8d5a-unique-cards-repair.test.mjs
 */

import {
  buildUniqueCardsRepairPlan,
  countUniqueCardsOwnedFromSnapshots,
  assertUniqueCardsRepairPathsAllowed,
} from '../js/research.js';

let failed = 0;
const NOW = 1_700_000_000_000;

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

const catalog = {
  c1: { id: 'c1', enabled: true },
  c2: { id: 'c2', enabled: true },
  cOff: { id: 'cOff', enabled: false },
};

// Inventory-derived count rules
{
  assertEq(
    countUniqueCardsOwnedFromSnapshots({ c1: 1, c2: 5, cOff: 2, orphan: 9, z: 0 }, catalog),
    2,
    'count: enabled known only; qty>1 once; zero/orphan/disabled ignored',
  );
  assertEq(
    countUniqueCardsOwnedFromSnapshots({ c1: -1, c2: '3' }, catalog),
    1,
    'count: negative ignored; numeric string >0 counts',
  );
  assertEq(countUniqueCardsOwnedFromSnapshots(null, catalog), 0, 'count: missing inventory → 0');
  assertEq(countUniqueCardsOwnedFromSnapshots('x', catalog), 0, 'count: malformed inventory → 0');
}

// Already-correct → unchanged
{
  const plan = buildUniqueCardsRepairPlan({
    playersSnapshot: {
      alice: { inventory: { c1: 2 }, stats: { uniqueCardsOwned: 1 } },
    },
    cardsSnapshot: catalog,
    leaderboardSnapshot: {
      alice: { value: 1, groupId: null, subgroupId: null, updatedAt: 1 },
    },
    now: NOW,
  });
  assertEq(plan.playersChanged, 0, 'correct: changed');
  assertEq(plan.unchanged, 1, 'correct: unchanged');
  assertEq(Object.keys(plan.updates).length, 0, 'correct: no writes');
}

// Stale / missing stored stat → repair + LB
{
  const plan = buildUniqueCardsRepairPlan({
    playersSnapshot: {
      bob: { inventory: { c1: 1, c2: 1 }, stats: { uniqueCardsOwned: 0 } },
      cara: { inventory: { c1: 1 }, stats: {} },
    },
    cardsSnapshot: catalog,
    leaderboardSnapshot: {},
    now: NOW,
  });
  assertEq(plan.playersChanged, 2, 'stale: changed');
  assertEq(plan.statRepairs, 2, 'stale: statRepairs');
  assertEq(plan.updates['players/bob/stats/uniqueCardsOwned'], 2, 'stale: bob count');
  assertEq(plan.updates['players/cara/stats/uniqueCardsOwned'], 1, 'missing-stat: cara');
  assert(plan.updates['leaderboards/uniqueCardsOwned/bob'] != null, 'stale: LB bob');
  assertEq(plan.leaderboardCreates, 2, 'stale: LB creates');
}

// Nonnumeric stored → repair
{
  const plan = buildUniqueCardsRepairPlan({
    playersSnapshot: {
      dana: { inventory: { c1: 1 }, stats: { uniqueCardsOwned: '1' } },
    },
    cardsSnapshot: catalog,
    leaderboardSnapshot: { dana: { value: 9 } },
    now: NOW,
  });
  assertEq(plan.playersChanged, 1, 'nonnumeric: repair');
  assertEq(plan.leaderboardUpdates, 1, 'nonnumeric: LB update');
}

// Path invariant
{
  let threw = false;
  try {
    assertUniqueCardsRepairPathsAllowed({
      'players/alice/achievements/x': true,
    });
  } catch {
    threw = true;
  }
  assert(threw, 'invariant: achievements rejected');

  threw = false;
  try {
    assertUniqueCardsRepairPathsAllowed({
      'players/alice/inventory/c1': 1,
    });
  } catch {
    threw = true;
  }
  assert(threw, 'invariant: inventory rejected');

  assert(
    assertUniqueCardsRepairPathsAllowed({
      'players/alice/stats/uniqueCardsOwned': 2,
      'leaderboards/uniqueCardsOwned/alice': { value: 2 },
    }) === true,
    'invariant: allowed paths ok',
  );
}

// Planner never writes achievements/inventory; second pass zero
{
  const players = {
    eve: {
      inventory: { c1: 1, c2: 1 },
      stats: { uniqueCardsOwned: 99 },
      groupId: 'g1',
    },
  };
  const pass1 = buildUniqueCardsRepairPlan({
    playersSnapshot: players,
    cardsSnapshot: catalog,
    leaderboardSnapshot: {},
    now: NOW,
  });
  for (const path of Object.keys(pass1.updates)) {
    assert(
      path === 'players/eve/stats/uniqueCardsOwned'
      || path === 'leaderboards/uniqueCardsOwned/eve',
      `pass1 path allowed: ${path}`,
    );
    assert(!path.includes('achievement'), 'no achievement path');
    assert(!path.includes('inventory'), 'no inventory path');
  }

  // Apply repair into snapshots
  players.eve.stats.uniqueCardsOwned = pass1.updates['players/eve/stats/uniqueCardsOwned'];
  const lb = {
    eve: pass1.updates['leaderboards/uniqueCardsOwned/eve'],
  };
  const pass2 = buildUniqueCardsRepairPlan({
    playersSnapshot: players,
    cardsSnapshot: catalog,
    leaderboardSnapshot: lb,
    now: NOW + 1,
  });
  assertEq(Object.keys(pass2.updates).length, 0, 'two-pass: zero updates');
  assertEq(pass2.playersChanged, 0, 'two-pass: playersChanged');
}

// __admin__ excluded
{
  const plan = buildUniqueCardsRepairPlan({
    playersSnapshot: {
      __admin__: { inventory: { c1: 1 }, stats: { uniqueCardsOwned: 0 } },
      real: { inventory: { c1: 1 }, stats: { uniqueCardsOwned: 1 } },
    },
    cardsSnapshot: catalog,
    leaderboardSnapshot: {},
    now: NOW,
  });
  assertEq(plan.playersScanned, 1, '__admin__: scanned');
  assertEq(plan.playersChanged, 0, '__admin__: no repair of real');
}

if (failed) {
  console.error(`\nS8d-5a unique-cards repair tests: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log('\nS8d-5a unique-cards repair tests: ALL PASSED');
}
