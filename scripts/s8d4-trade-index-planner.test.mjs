/**
 * S8d-4b pure Trade Index rebuild planner tests (no Firebase / no DB cache).
 *
 * Run: node scripts/s8d4-trade-index-planner.test.mjs
 */

import {
  buildTradeIndexRebuildPlan,
  deriveDesiredTradeIndexes,
  assertTradeIndexRebuildPathsAllowed,
  PLAYER_TRADE_INDEX_ROOT,
  LISTINGS_BY_GROUP_ROOT,
  TRADE_INDEX_META_ROOT,
  CURRENT_TRADE_INDEX_SCHEMA_VERSION,
  buildTradeIndexMeta,
  tradeIndexMetaEqual,
} from '../js/trade-index.js';

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

function basePlan(extra = {}) {
  return buildTradeIndexRebuildPlan({
    playersSnapshot: { alice: {}, bob: {} },
    groupsSnapshot: { g1: { name: 'G1' } },
    directTradesSnapshot: null,
    listingsSnapshot: null,
    playerTradeIndexSnapshot: null,
    listingsByGroupSnapshot: null,
    tradeIndexMetaSnapshot: { schemaVersion: 1, rebuiltAt: NOW - 1 },
    now: NOW,
    ...extra,
  });
}

// No trades/listings → readiness only for current players/groups
{
  const plan = basePlan();
  assert(plan.ok === true, 'empty: ok');
  assertEq(plan.playersScanned, 2, 'empty: playersScanned');
  assertEq(plan.groupsScanned, 1, 'empty: groupsScanned');
  assertEq(plan.ptiCreated, 0, 'empty: pti entry create');
  assert(plan.ptiReadinessRepairs >= 2, 'empty: player readiness');
  assert(plan.groupReadinessRepairs >= 1, 'empty: group readiness');
  assert(
    Object.keys(plan.updates).every((p) => (
      p.startsWith(`${PLAYER_TRADE_INDEX_ROOT}/`)
      || p.startsWith(`${LISTINGS_BY_GROUP_ROOT}/`)
      || p.startsWith(`${TRADE_INDEX_META_ROOT}/`)
    )),
    'empty: allowed prefixes only',
  );
}

// Direct open → PTI both participants
{
  const plan = buildTradeIndexRebuildPlan({
    playersSnapshot: { alice: {}, bob: {} },
    groupsSnapshot: {},
    directTradesSnapshot: {
      t1: {
        id: 't1',
        status: 'awaiting_target_response',
        offeringPlayerId: 'alice',
        targetPlayerId: 'bob',
        offeredCardId: 'c1',
        requestedCardId: 'c2',
        createdAt: NOW,
      },
    },
    listingsSnapshot: null,
    playerTradeIndexSnapshot: {
      alice: { _meta: buildTradeIndexMeta(NOW - 1) },
      bob: { _meta: buildTradeIndexMeta(NOW - 1) },
    },
    listingsByGroupSnapshot: null,
    tradeIndexMetaSnapshot: { schemaVersion: 1, rebuiltAt: NOW - 1 },
    now: NOW,
  });
  assertEq(plan.ptiCreated, 2, 'direct-open: create both');
  assert(plan.updates[`${PLAYER_TRADE_INDEX_ROOT}/alice/direct/t1`] != null, 'direct-open: alice');
  assert(plan.updates[`${PLAYER_TRADE_INDEX_ROOT}/bob/direct/t1`] != null, 'direct-open: bob');
}

// Direct terminal → no PTI
{
  const desired = deriveDesiredTradeIndexes({
    playersSnapshot: { alice: {}, bob: {} },
    groupsSnapshot: {},
    directTradesSnapshot: {
      tDone: {
        id: 'tDone',
        status: 'accepted',
        offeringPlayerId: 'alice',
        targetPlayerId: 'bob',
        offeredCardId: 'c1',
        createdAt: NOW,
      },
    },
    now: NOW,
  });
  assertEq(desired.players.get('alice').direct.size, 0, 'direct-terminal: alice empty');
  assertEq(desired.players.get('bob').direct.size, 0, 'direct-terminal: bob empty');
}

// Listing active/unexpired → owner PTI + LBG
{
  const plan = buildTradeIndexRebuildPlan({
    playersSnapshot: { owner: {} },
    groupsSnapshot: { g1: {} },
    directTradesSnapshot: null,
    listingsSnapshot: {
      L1: {
        id: 'L1',
        status: 'active',
        ownerId: 'owner',
        offeredCardId: 'c1',
        requestedCardIds: ['c2'],
        groupId: 'g1',
        expiresAt: NOW + 60_000,
        createdAt: NOW,
      },
    },
    playerTradeIndexSnapshot: {
      owner: { _meta: buildTradeIndexMeta(NOW - 1) },
    },
    listingsByGroupSnapshot: {
      g1: { _meta: buildTradeIndexMeta(NOW - 1) },
    },
    tradeIndexMetaSnapshot: { schemaVersion: 1, rebuiltAt: NOW - 1 },
    now: NOW,
  });
  assert(plan.updates[`${PLAYER_TRADE_INDEX_ROOT}/owner/listings/L1`] != null, 'listing-active: owner PTI');
  assert(plan.updates[`${LISTINGS_BY_GROUP_ROOT}/g1/L1`] != null, 'listing-active: LBG');
}

// Listing processing → owner PTI, no LBG
{
  const desired = deriveDesiredTradeIndexes({
    playersSnapshot: { owner: {} },
    groupsSnapshot: { g1: {} },
    listingsSnapshot: {
      Lp: {
        id: 'Lp',
        status: 'processing',
        ownerId: 'owner',
        offeredCardId: 'c1',
        groupId: 'g1',
        createdAt: NOW,
      },
    },
    now: NOW,
  });
  assertEq(desired.players.get('owner').listings.size, 1, 'listing-proc: owner PTI');
  assertEq(desired.groups.get('g1').listings.size, 0, 'listing-proc: no LBG');
}

// Soft-expired active → absent
{
  const desired = deriveDesiredTradeIndexes({
    playersSnapshot: { owner: {} },
    groupsSnapshot: { g1: {} },
    listingsSnapshot: {
      Lx: {
        id: 'Lx',
        status: 'active',
        ownerId: 'owner',
        offeredCardId: 'c1',
        groupId: 'g1',
        expiresAt: NOW - 1,
        createdAt: NOW - 100,
      },
    },
    now: NOW,
  });
  assertEq(desired.players.get('owner').listings.size, 0, 'soft-expired: no owner PTI');
  assertEq(desired.groups.get('g1').listings.size, 0, 'soft-expired: no LBG');
}

// Stale PTI leaf → remove
{
  const plan = buildTradeIndexRebuildPlan({
    playersSnapshot: { alice: {} },
    groupsSnapshot: {},
    directTradesSnapshot: {},
    listingsSnapshot: {},
    playerTradeIndexSnapshot: {
      alice: {
        _meta: buildTradeIndexMeta(NOW - 1),
        direct: {
          ghost: {
            id: 'ghost',
            status: 'awaiting_target_response',
            offeringPlayerId: 'alice',
            targetPlayerId: 'bob',
            offeredCardId: 'c1',
            createdAt: NOW,
          },
        },
      },
    },
    listingsByGroupSnapshot: null,
    tradeIndexMetaSnapshot: { schemaVersion: 1, rebuiltAt: NOW - 1 },
    now: NOW,
  });
  assertEq(plan.updates[`${PLAYER_TRADE_INDEX_ROOT}/alice/direct/ghost`], null, 'stale-pti: remove');
  assert(plan.ptiRemoved >= 1, 'stale-pti: removed count');
}

// Deleted player PTI root → remove
{
  const plan = buildTradeIndexRebuildPlan({
    playersSnapshot: { alice: {} },
    groupsSnapshot: {},
    directTradesSnapshot: {},
    listingsSnapshot: {},
    playerTradeIndexSnapshot: {
      alice: { _meta: buildTradeIndexMeta(NOW - 1) },
      ghostUser: { _meta: buildTradeIndexMeta(NOW - 1), direct: {} },
    },
    listingsByGroupSnapshot: null,
    tradeIndexMetaSnapshot: { schemaVersion: 1, rebuiltAt: NOW - 1 },
    now: NOW,
  });
  assertEq(plan.updates[`${PLAYER_TRADE_INDEX_ROOT}/ghostUser`], null, 'deleted-player: null root');
  assertEq(plan.deletedPlayerRootsRemoved, 1, 'deleted-player: count');
}

// Deleted group LBG root → remove
{
  const plan = buildTradeIndexRebuildPlan({
    playersSnapshot: { alice: {} },
    groupsSnapshot: { g1: {} },
    listingsSnapshot: {},
    playerTradeIndexSnapshot: {
      alice: { _meta: buildTradeIndexMeta(NOW - 1) },
    },
    listingsByGroupSnapshot: {
      g1: { _meta: buildTradeIndexMeta(NOW - 1) },
      ghostG: { _meta: buildTradeIndexMeta(NOW - 1), Lx: { id: 'Lx' } },
    },
    tradeIndexMetaSnapshot: { schemaVersion: 1, rebuiltAt: NOW - 1 },
    now: NOW,
  });
  assertEq(plan.updates[`${LISTINGS_BY_GROUP_ROOT}/ghostG`], null, 'deleted-group: null root');
  assertEq(plan.deletedGroupRootsRemoved, 1, 'deleted-group: count');
}

// Active listing referencing deleted group → owner PTI only, no LBG; skippedMissingGroup
{
  const desired = deriveDesiredTradeIndexes({
    playersSnapshot: { owner: {} },
    groupsSnapshot: {}, // no gGone
    listingsSnapshot: {
      Lg: {
        id: 'Lg',
        status: 'active',
        ownerId: 'owner',
        offeredCardId: 'c1',
        groupId: 'gGone',
        expiresAt: NOW + 99999,
        createdAt: NOW,
      },
    },
    now: NOW,
  });
  assertEq(desired.players.get('owner').listings.size, 1, 'missing-group: owner PTI');
  assertEq(desired.groups.size, 0, 'missing-group: no LBG buckets');
  assertEq(desired.skippedMissingGroup, 1, 'missing-group: skipped count');
}

// Wrong _meta → readiness repair; rebuiltAt alone no drift
{
  const planWrong = buildTradeIndexRebuildPlan({
    playersSnapshot: { alice: {} },
    groupsSnapshot: {},
    playerTradeIndexSnapshot: {
      alice: { _meta: { ready: false, v: 1, rebuiltAt: NOW - 1 } },
    },
    tradeIndexMetaSnapshot: { schemaVersion: 1, rebuiltAt: NOW - 1 },
    now: NOW,
  });
  assert(planWrong.ptiReadinessRepairs >= 1, 'meta-wrong: readiness repair');

  const readyMeta = buildTradeIndexMeta(NOW - 999);
  const planStamp = buildTradeIndexRebuildPlan({
    playersSnapshot: { alice: {} },
    groupsSnapshot: {},
    playerTradeIndexSnapshot: {
      alice: { _meta: readyMeta },
    },
    listingsByGroupSnapshot: null,
    tradeIndexMetaSnapshot: { schemaVersion: 1, rebuiltAt: NOW - 1 },
    now: NOW,
  });
  // Only readiness equal → should not rewrite _meta solely for rebuiltAt
  assert(
    !Object.prototype.hasOwnProperty.call(
      planStamp.updates,
      `${PLAYER_TRADE_INDEX_ROOT}/alice/_meta`,
    ),
    'meta-rebuiltAt: no false readiness write',
  );
  assert(
    tradeIndexMetaEqual(readyMeta, buildTradeIndexMeta(NOW)),
    'meta-equal ignores rebuiltAt',
  );
}

// Canonical path invariant
{
  let threw = false;
  try {
    assertTradeIndexRebuildPathsAllowed({
      'trades/direct/t1': null,
    });
  } catch {
    threw = true;
  }
  assert(threw, 'invariant: trades path rejected');

  threw = false;
  try {
    assertTradeIndexRebuildPathsAllowed({
      'players/alice/inventory/c1': 1,
    });
  } catch {
    threw = true;
  }
  assert(threw, 'invariant: inventory path rejected');

  assert(
    assertTradeIndexRebuildPathsAllowed({
      [`${PLAYER_TRADE_INDEX_ROOT}/a/_meta`]: buildTradeIndexMeta(1),
      [`${LISTINGS_BY_GROUP_ROOT}/g/_meta`]: buildTradeIndexMeta(1),
      [`${TRADE_INDEX_META_ROOT}/schemaVersion`]: CURRENT_TRADE_INDEX_SCHEMA_VERSION,
    }) === true,
    'invariant: allowed paths ok',
  );
}

// Two-pass Firebase-style idempotency
{
  const players = { a: {}, b: {} };
  const groups = { g1: {} };
  const directs = {
    t1: {
      id: 't1',
      status: 'processing',
      offeringPlayerId: 'a',
      targetPlayerId: 'b',
      offeredCardId: 'c1',
      createdAt: NOW,
    },
  };
  const listings = {
    L1: {
      id: 'L1',
      status: 'active',
      ownerId: 'a',
      offeredCardId: 'c2',
      requestedCardIds: [],
      groupId: 'g1',
      expiresAt: NOW + 999999,
      createdAt: NOW,
    },
  };

  let pti = {};
  let lbg = {};
  let meta = { schemaVersion: 1, rebuiltAt: null };

  const pass1 = buildTradeIndexRebuildPlan({
    playersSnapshot: players,
    groupsSnapshot: groups,
    directTradesSnapshot: directs,
    listingsSnapshot: listings,
    playerTradeIndexSnapshot: pti,
    listingsByGroupSnapshot: lbg,
    tradeIndexMetaSnapshot: meta,
    now: NOW,
  });
  assert(Object.keys(pass1.updates).length > 0, 'two-pass: first writes');

  // Apply Firebase-style: null deletes; strip null fields from objects
  pti = { ...pti };
  lbg = { ...lbg };
  meta = { ...meta };
  for (const [path, value] of Object.entries(pass1.updates)) {
    const parts = path.split('/');
    if (parts[0] === TRADE_INDEX_META_ROOT) {
      if (value == null) delete meta[parts[1]];
      else meta[parts[1]] = value;
      continue;
    }
    if (parts[0] === PLAYER_TRADE_INDEX_ROOT) {
      const user = parts[1];
      if (value == null && parts.length === 2) {
        delete pti[user];
        continue;
      }
      if (!pti[user]) pti[user] = {};
      if (parts[2] === '_meta') {
        pti[user]._meta = value;
        continue;
      }
      if (parts[2] === 'direct' || parts[2] === 'listings') {
        if (!pti[user][parts[2]]) pti[user][parts[2]] = {};
        if (value == null) delete pti[user][parts[2]][parts[3]];
        else {
          const stored = {};
          for (const [fk, fv] of Object.entries(value)) {
            if (fv !== null && fv !== undefined) stored[fk] = fv;
          }
          pti[user][parts[2]][parts[3]] = stored;
        }
      }
      continue;
    }
    if (parts[0] === LISTINGS_BY_GROUP_ROOT) {
      const gid = parts[1];
      if (value == null && parts.length === 2) {
        delete lbg[gid];
        continue;
      }
      if (!lbg[gid]) lbg[gid] = {};
      if (parts[2] === '_meta') {
        lbg[gid]._meta = value;
        continue;
      }
      if (value == null) delete lbg[gid][parts[2]];
      else {
        const stored = {};
        for (const [fk, fv] of Object.entries(value)) {
          if (fv !== null && fv !== undefined) stored[fk] = fv;
        }
        lbg[gid][parts[2]] = stored;
      }
    }
  }

  const pass2 = buildTradeIndexRebuildPlan({
    playersSnapshot: players,
    groupsSnapshot: groups,
    directTradesSnapshot: directs,
    listingsSnapshot: listings,
    playerTradeIndexSnapshot: pti,
    listingsByGroupSnapshot: lbg,
    tradeIndexMetaSnapshot: meta,
    now: NOW + 1,
  });
  assertEq(Object.keys(pass2.updates).length, 0, 'two-pass: second empty updates');
  assertEq(pass2.ptiCreated, 0, 'two-pass: ptiCreated');
  assertEq(pass2.ptiUpdated, 0, 'two-pass: ptiUpdated');
  assertEq(pass2.ptiRemoved, 0, 'two-pass: ptiRemoved');
  assertEq(pass2.ptiReadinessRepairs, 0, 'two-pass: ptiReadiness');
  assertEq(pass2.groupCreated, 0, 'two-pass: groupCreated');
  assertEq(pass2.groupRemoved, 0, 'two-pass: groupRemoved');
  assertEq(pass2.groupReadinessRepairs, 0, 'two-pass: groupReadiness');
}

// __admin__ excluded from seed
{
  const desired = deriveDesiredTradeIndexes({
    playersSnapshot: { __admin__: {}, real: {} },
    groupsSnapshot: {},
    now: NOW,
  });
  assertEq(desired.playersScanned, 1, '__admin__: scanned');
  assert(!desired.players.has('__admin__'), '__admin__: not seeded');
}

if (failed) {
  console.error(`\nS8d-4b trade-index planner tests: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log('\nS8d-4b trade-index planner tests: ALL PASSED');
}
