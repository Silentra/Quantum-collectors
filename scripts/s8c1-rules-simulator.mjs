/**
 * S8c-1 + S8c-2 local RTDB rules proof (Firebase emulator + @firebase/rules-unit-testing).
 *
 * Proves S8c-1 inventory/grant + S8c-2 grant-bound foreign stats/achievements/progression/
 * cooldowns/leaderboards (PTI/LBG intentionally still auth-writable) + S8d-1 admin-only
 * parent reads on players / trades/direct / trades/listings + S8d-4a admin-only parent
 * reads on playerTradeIndex / listingsByGroup (child R/W unchanged; no write tighten).
 *
 * Run (from repo root, with Java available for emulator):
 *   npx firebase emulators:exec --only database "node scripts/s8c1-rules-simulator.mjs"
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { ref, set, update, get, increment } from 'firebase/database';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const rules = readFileSync(resolve(root, 'database.rules.json'), 'utf8');

const PROJECT_ID = 'qc-s8c1-rules-sim';
const now = Date.now();

function fail(msg) {
  console.error('FAIL:', msg);
  process.exitCode = 1;
}

function pass(msg) {
  console.log('PASS:', msg);
}

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { rules, host: '127.0.0.1', port: 9000 },
  });

  try {
    await testEnv.clearDatabase();

    // Seed via admin (bypasses rules)
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, '/'), {
        admins: { teacherUid: true },
        tradeIndexMeta: { schemaVersion: 1, rebuiltAt: now },
        config: {
          gameOpen: true,
          registrationOpen: true,
          adminPassword: 'secret',
        },
        cards: { c1: { id: 'c1', name: 'Card' } },
        packs: {},
        groups: {},
        playerDirectory: {
          offerer: {
            username: 'offerer',
            groupId: 'g1',
            subgroupId: null,
            isAdmin: false,
            isTradeRestricted: false,
            isTradeProfileHidden: false,
          },
          target: {
            username: 'target',
            groupId: 'g1',
            subgroupId: null,
            isAdmin: false,
            isTradeRestricted: false,
            isTradeProfileHidden: false,
          },
        },
        accessCodes: {
          ABC123: { used: false, created: now, group: null },
        },
        players: {
          offerer: {
            authUid: 'offererUid',
            inventory: { cardGive: 2, cardRecv: 1 },
            stats: { tradesCompleted: 0, uniqueCardsOwned: 2 },
          },
          target: {
            authUid: 'targetUid',
            inventory: { cardGive: 1, cardRecv: 3, unrelated: 5 },
            stats: { tradesCompleted: 0, uniqueCardsOwned: 2 },
          },
          owner: {
            authUid: 'ownerUid',
            inventory: { listOffer: 1, listChosen: 0 },
            stats: { tradesCompleted: 0, uniqueCardsOwned: 1 },
          },
          accepter: {
            authUid: 'accepterUid',
            inventory: { listOffer: 0, listChosen: 2 },
            stats: { tradesCompleted: 0, uniqueCardsOwned: 1 },
          },
        },
        trades: {
          direct: {
            t1: {
              id: 't1',
              status: 'processing',
              offeringPlayerId: 'offerer',
              targetPlayerId: 'target',
              offeredCardId: 'cardRecv',
              requestedCardId: 'cardGive',
              processingBy: 'offerer',
              claimId: 'claim-direct-1',
              claimerAuthUid: 'offererUid',
            },
          },
          listings: {
            l1: {
              id: 'l1',
              status: 'processing',
              ownerId: 'owner',
              offeredCardId: 'listOffer',
              fulfilledCardId: 'listChosen',
              processingBy: 'accepter',
              claimId: 'claim-listing-1',
              claimerAuthUid: 'accepterUid',
            },
          },
        },
      });
    });

    const offerer = testEnv.authenticatedContext('offererUid');
    const stranger = testEnv.authenticatedContext('strangerUid');
    const accepter = testEnv.authenticatedContext('accepterUid');

    // --- 2) Fake grant must fail ---
    await assertFails(
      set(ref(offerer.database(), 'tradeGrants/target/offererUid'), {
        tradeKind: 'direct',
        tradeId: 'nope',
        claimId: 'fake',
        claimerUsername: 'offerer',
        targetUsername: 'target',
        giveCardId: 'cardGive',
        recvCardId: 'cardRecv',
        expiresAt: now + 60_000,
      }),
    );
    pass('fake grant create denied');

    // Honest grant create (live processing + matching claim)
    await assertSucceeds(
      set(ref(offerer.database(), 'tradeGrants/target/offererUid'), {
        tradeKind: 'direct',
        tradeId: 't1',
        claimId: 'claim-direct-1',
        claimerUsername: 'offerer',
        targetUsername: 'target',
        giveCardId: 'cardGive',
        recvCardId: 'cardRecv',
        expiresAt: now + 60_000,
      }),
    );
    pass('honest direct grant create allowed');

    // --- 3) Unrelated foreign inventory write fails ---
    await assertFails(
      set(ref(offerer.database(), 'players/target/inventory/unrelated'), 4),
    );
    pass('unrelated foreign inventory write denied');

    // Absolute non-exact delta on give card denied (1 → 99 is not −1)
    await assertFails(
      set(ref(offerer.database(), 'players/target/inventory/cardGive'), 99),
    );
    pass('absolute wrong-delta foreign inventory denied');

    // Malicious foreign null of give card when qty !== 1 denied
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'players/target/inventory/cardGive'), 5);
    });
    {
      const q = (await get(ref(offerer.database(), 'players/target/inventory/cardGive'))).val();
      if (q !== 5) fail(`expected cardGive=5 before malicious null, got ${q}`);
    }
    await assertFails(
      set(ref(offerer.database(), 'players/target/inventory/cardGive'), null),
    );
    pass('malicious foreign null of qty>1 give denied');
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'players/target/inventory/cardGive'), 1);
    });

    // Malicious unrelated-card delete denied
    await assertFails(
      set(ref(offerer.database(), 'players/target/inventory/unrelated'), null),
    );
    pass('malicious unrelated foreign inventory delete denied');

    // Honest foreign null when qty===1 allowed (semantic 1-1=0)
    await assertSucceeds(
      set(ref(offerer.database(), 'players/target/inventory/cardGive'), null),
    );
    pass('honest foreign null of qty===1 give allowed');
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'players/target/inventory/cardGive'), 1);
    });

    // --- 1) ServerValue.increment(±1) satisfies exact-delta ---
    await assertSucceeds(
      update(ref(offerer.database()), {
        'players/target/inventory/cardGive': increment(-1),
        'players/target/inventory/cardRecv': increment(1),
      }),
    );
    pass('ServerValue.increment(±1) accepted under exact-delta rules');

    // Confirm resolved values
    const after = await get(ref(offerer.database(), 'players/target/inventory'));
    const inv = after.val();
    if (inv.cardGive !== 0 || inv.cardRecv !== 4) {
      fail(`increment resolved unexpectedly: ${JSON.stringify(inv)}`);
    } else {
      pass(`increment resolved to exact qtys give=0 recv=4 (from 1/3)`);
    }

    // Replay without resetting grant would allow another ±1 — clear grant then deny
    await assertSucceeds(
      set(ref(offerer.database(), 'tradeGrants/target/offererUid'), null),
    );
    await assertFails(
      update(ref(offerer.database()), {
        'players/target/inventory/cardGive': increment(-1),
        'players/target/inventory/cardRecv': increment(1),
      }),
    );
    pass('foreign inventory denied after grant cleared');

    // Stranger cannot touch foreign inventory
    await assertFails(
      set(ref(stranger.database(), 'players/target/inventory/cardGive'), 99),
    );
    pass('stranger foreign inventory write denied');

    // --- 4a) Honest direct settlement multipath (reseed grant + processing) ---
    // Seed foreign tradesCompleted > 0 to match live S8c-2 blocker (cache-blind absolute 1).
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, 'players/target/inventory'), {
        cardGive: 1,
        cardRecv: 3,
        unrelated: 5,
      });
      await set(ref(db, 'players/offerer/inventory'), {
        cardGive: 2,
        cardRecv: 1,
      });
      await set(ref(db, 'players/target/stats'), {
        tradesCompleted: 5,
        uniqueCardsOwned: 2,
      });
      await set(ref(db, 'players/offerer/stats'), {
        tradesCompleted: 20,
        uniqueCardsOwned: 2,
      });
      await set(ref(db, 'players/offerer/groupId'), 'g1');
      await set(ref(db, 'players/target/groupId'), 'g1');
      await set(ref(db, 'leaderboards/tradesCompleted/offerer'), {
        value: 20,
        groupId: 'g1',
        subgroupId: null,
        updatedAt: now,
      });
      await set(ref(db, 'leaderboards/tradesCompleted/target'), {
        value: 5,
        groupId: 'g1',
        subgroupId: 'sgA',
        updatedAt: now,
      });
      await set(ref(db, 'trades/direct/t1/status'), 'processing');
      await set(ref(db, 'trades/direct/t1/claimId'), 'claim-direct-1');
      await set(ref(db, 'trades/direct/t1/claimerAuthUid'), 'offererUid');
      await set(ref(db, 'trades/direct/t1/processingBy'), 'offerer');
    });

    await assertSucceeds(
      set(ref(offerer.database(), 'tradeGrants/target/offererUid'), {
        tradeKind: 'direct',
        tradeId: 't1',
        claimId: 'claim-direct-1',
        claimerUsername: 'offerer',
        targetUsername: 'target',
        giveCardId: 'cardGive',
        recvCardId: 'cardRecv',
        expiresAt: Date.now() + 60_000,
      }),
    );

    // Live blocker shape: foreign absolute tradesCompleted=1 while server is 5 → denied
    await assertFails(
      update(ref(offerer.database()), {
        'players/target/inventory/cardGive': null,
        'players/target/inventory/cardRecv': increment(1),
        'players/offerer/inventory/cardRecv': null,
        'players/offerer/inventory/cardGive': increment(1),
        'trades/direct/t1/status': 'accepted',
        'trades/direct/t1/processingBy': null,
        'trades/direct/t1/processingAt': null,
        'trades/direct/t1/claimId': null,
        'trades/direct/t1/claimerAuthUid': null,
        'tradeGrants/target/offererUid': null,
        'players/offerer/stats/tradesCompleted': 1,
        'players/target/stats/tradesCompleted': 1,
        'players/offerer/lastDirectTradeAt': Date.now(),
        'players/target/lastDirectTradeAt': Date.now(),
      }),
    );
    pass('S8c-2 blocker: complete Direct multipath with foreign absolute tradesCompleted=1 denied');

    // Fixed planner shape: BOTH sides tradesCompleted via increment(1) (no cache-blind absolute)
    await assertSucceeds(
      update(ref(offerer.database()), {
        'players/target/inventory/cardGive': null,
        'players/target/inventory/cardRecv': increment(1),
        'players/offerer/inventory/cardRecv': null,
        'players/offerer/inventory/cardGive': increment(1),
        'trades/direct/t1/status': 'accepted',
        'trades/direct/t1/processingBy': null,
        'trades/direct/t1/processingAt': null,
        'trades/direct/t1/claimId': null,
        'trades/direct/t1/claimerAuthUid': null,
        'tradeGrants/target/offererUid': null,
        'players/offerer/stats/tradesCompleted': increment(1),
        'players/target/stats/tradesCompleted': increment(1),
        'players/target/stats/uniqueCardsOwned': 2,
        'players/offerer/progression/firstTrade': true,
        'players/target/progression/firstTrade': true,
        'players/offerer/achievements/first_trade_badge': {
          unlocked: true,
          unlockedAt: Date.now(),
          claimed: true,
          claimedAt: 123456,
        },
        'players/offerer/lastDirectTradeAt': Date.now(),
        'players/target/lastDirectTradeAt': Date.now(),
        'leaderboards/tradesCompleted/offerer/value': increment(1),
        'leaderboards/tradesCompleted/offerer/updatedAt': Date.now(),
        'leaderboards/tradesCompleted/offerer/groupId': 'g1',
        'leaderboards/tradesCompleted/offerer/subgroupId': null,
        'leaderboards/tradesCompleted/target/value': increment(1),
        'leaderboards/tradesCompleted/target/updatedAt': Date.now(),
        'leaderboards/tradesCompleted/target/groupId': 'g1',
        'leaderboards/tradesCompleted/target/subgroupId': 'sgA',
        'leaderboards/uniqueCardsOwned/target': {
          username: 'target',
          value: 2,
          updatedAt: Date.now(),
        },
      }),
    );
    pass('honest complete Direct terminal multipath allowed (both tradesCompleted increment)');

    {
      let tStats = null;
      let oStats = null;
      let oLb = null;
      let tLb = null;
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        tStats = (await get(ref(ctx.database(), 'players/target/stats/tradesCompleted'))).val();
        oStats = (await get(ref(ctx.database(), 'players/offerer/stats/tradesCompleted'))).val();
        oLb = (await get(ref(ctx.database(), 'leaderboards/tradesCompleted/offerer'))).val();
        tLb = (await get(ref(ctx.database(), 'leaderboards/tradesCompleted/target'))).val();
      });
      if (tStats !== 6) {
        fail(`direct foreign tradesCompleted increment expected 6, got ${tStats}`);
      } else if (oStats !== 21) {
        fail(`direct claimer tradesCompleted 20→21 via increment expected 21, got ${oStats}`);
      } else if (!oLb || oLb.value !== 21) {
        fail(`direct claimer LB 20→21 expected, got ${JSON.stringify(oLb)}`);
      } else if (!tLb || tLb.value !== 6) {
        fail(`direct foreign LB 5→6 expected, got ${JSON.stringify(tLb)}`);
      } else if (tLb.subgroupId !== 'sgA' || tLb.groupId !== 'g1') {
        fail(`direct foreign LB group fields not preserved: ${JSON.stringify(tLb)}`);
      } else if (oStats !== oLb.value || tStats !== tLb.value) {
        fail(`direct canonical/LB mismatch o=${oStats}/${oLb.value} t=${tStats}/${tLb.value}`);
      } else {
        pass('direct tradesCompleted both sides increment (foreign 5→6, claimer 20→21)');
        pass('direct LB both sides increment + group/subgroup preserved; canonical===LB');
      }
    }

    {
      let claimedAt = null;
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        claimedAt = (await get(ref(ctx.database(), 'players/offerer/achievements/first_trade_badge/claimedAt'))).val();
      });
      if (claimedAt !== 123456) {
        fail(`direct settle must preserve claimedAt, got ${claimedAt}`);
      } else {
        pass('direct settle achievement claimedAt preserved under unlock-shaped write');
      }
    }

    {
      const tInv = (await get(ref(offerer.database(), 'players/target/inventory'))).val() || {};
      const oInv = (await get(ref(offerer.database(), 'players/offerer/inventory'))).val() || {};
      if (Object.prototype.hasOwnProperty.call(tInv, 'cardGive') || tInv.cardRecv !== 4) {
        fail(`direct qty1 canonical zero failed: target=${JSON.stringify(tInv)}`);
      } else if (Object.prototype.hasOwnProperty.call(oInv, 'cardRecv') || oInv.cardGive !== 3) {
        fail(`direct qty1 canonical zero failed: offerer=${JSON.stringify(oInv)}`);
      } else {
        pass('direct qty1 give leaves absent; recv qtys exact');
      }
    }

    // Post-settlement replay denied (grant cleared + trade not processing)
    await assertFails(
      update(ref(offerer.database()), {
        'players/target/inventory/cardRecv': increment(-1),
      }),
    );
    pass('post-settlement foreign inventory replay denied');

    // --- 4b) Honest listing settlement ---
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, 'players/owner/inventory'), { listOffer: 1, listChosen: 0 });
      await set(ref(db, 'players/accepter/inventory'), { listOffer: 0, listChosen: 2 });
      await set(ref(db, 'players/owner/stats'), {
        tradesCompleted: 4,
        uniqueCardsOwned: 1,
      });
      await set(ref(db, 'players/accepter/stats'), {
        tradesCompleted: 20,
        uniqueCardsOwned: 1,
      });
      await set(ref(db, 'players/owner/groupId'), 'g1');
      await set(ref(db, 'players/accepter/groupId'), 'g1');
      await set(ref(db, 'leaderboards/tradesCompleted/owner'), {
        value: 4,
        groupId: 'g1',
        subgroupId: null,
        updatedAt: now,
      });
      await set(ref(db, 'leaderboards/tradesCompleted/accepter'), {
        value: 20,
        groupId: 'g1',
        subgroupId: null,
        updatedAt: now,
      });
      await set(ref(db, 'trades/listings/l1/status'), 'processing');
      await set(ref(db, 'trades/listings/l1/claimId'), 'claim-listing-1');
      await set(ref(db, 'trades/listings/l1/claimerAuthUid'), 'accepterUid');
      await set(ref(db, 'trades/listings/l1/processingBy'), 'accepter');
      await set(ref(db, 'trades/listings/l1/fulfilledCardId'), 'listChosen');
    });

    await assertSucceeds(
      set(ref(accepter.database(), 'tradeGrants/owner/accepterUid'), {
        tradeKind: 'listing',
        tradeId: 'l1',
        claimId: 'claim-listing-1',
        claimerUsername: 'accepter',
        targetUsername: 'owner',
        giveCardId: 'listOffer',
        recvCardId: 'listChosen',
        expiresAt: Date.now() + 60_000,
      }),
    );
    pass('honest listing grant create allowed');

    await assertFails(
      update(ref(accepter.database()), {
        'players/owner/inventory/listOffer': null,
        'players/owner/inventory/listChosen': increment(1),
        'players/accepter/inventory/listChosen': increment(-1),
        'players/accepter/inventory/listOffer': increment(1),
        'trades/listings/l1/status': 'fulfilled',
        'trades/listings/l1/fulfilledBy': 'accepter',
        'trades/listings/l1/processingBy': null,
        'trades/listings/l1/processingAt': null,
        'trades/listings/l1/claimId': null,
        'trades/listings/l1/claimerAuthUid': null,
        'tradeGrants/owner/accepterUid': null,
        'players/accepter/lastListingAcceptAt': Date.now(),
        'players/owner/stats/tradesCompleted': 1,
        'players/accepter/stats/tradesCompleted': 1,
      }),
    );
    pass('S8c-2 blocker: complete Listing multipath with foreign absolute tradesCompleted=1 denied');

    // owner give qty===1 → null; accepter give qty>1 → increment(-1); BOTH tradesCompleted via increment
    await assertSucceeds(
      update(ref(accepter.database()), {
        'players/owner/inventory/listOffer': null,
        'players/owner/inventory/listChosen': increment(1),
        'players/accepter/inventory/listChosen': increment(-1),
        'players/accepter/inventory/listOffer': increment(1),
        'trades/listings/l1/status': 'fulfilled',
        'trades/listings/l1/fulfilledBy': 'accepter',
        'trades/listings/l1/processingBy': null,
        'trades/listings/l1/processingAt': null,
        'trades/listings/l1/claimId': null,
        'trades/listings/l1/claimerAuthUid': null,
        'tradeGrants/owner/accepterUid': null,
        'players/accepter/lastListingAcceptAt': Date.now(),
        'players/owner/stats/tradesCompleted': increment(1),
        'players/accepter/stats/tradesCompleted': increment(1),
        'players/owner/progression/firstTrade': true,
        'players/accepter/progression/firstTrade': true,
        'leaderboards/tradesCompleted/owner/value': increment(1),
        'leaderboards/tradesCompleted/owner/updatedAt': Date.now(),
        'leaderboards/tradesCompleted/owner/groupId': 'g1',
        'leaderboards/tradesCompleted/owner/subgroupId': null,
        'leaderboards/tradesCompleted/accepter/value': increment(1),
        'leaderboards/tradesCompleted/accepter/updatedAt': Date.now(),
        'leaderboards/tradesCompleted/accepter/groupId': 'g1',
        'leaderboards/tradesCompleted/accepter/subgroupId': null,
      }),
    );
    pass('honest complete Listing terminal multipath allowed (both tradesCompleted increment)');

    {
      let oStats = null;
      let aStats = null;
      let oLb = null;
      let aLb = null;
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        oStats = (await get(ref(ctx.database(), 'players/owner/stats/tradesCompleted'))).val();
        aStats = (await get(ref(ctx.database(), 'players/accepter/stats/tradesCompleted'))).val();
        oLb = (await get(ref(ctx.database(), 'leaderboards/tradesCompleted/owner'))).val();
        aLb = (await get(ref(ctx.database(), 'leaderboards/tradesCompleted/accepter'))).val();
      });
      if (oStats !== 5) {
        fail(`listing foreign tradesCompleted increment expected 5, got ${oStats}`);
      } else if (aStats !== 21) {
        fail(`listing claimer tradesCompleted 20→21 via increment expected 21, got ${aStats}`);
      } else if (!oLb || oLb.value !== 5 || !aLb || aLb.value !== 21) {
        fail(`listing LB mismatch owner=${JSON.stringify(oLb)} accepter=${JSON.stringify(aLb)}`);
      } else if (oStats !== oLb.value || aStats !== aLb.value) {
        fail(`listing canonical/LB mismatch`);
      } else {
        pass('listing tradesCompleted both sides increment (owner 4→5, accepter 20→21)');
        pass('listing LB both sides increment; canonical===LB');
      }
    }

    {
      const oInv = (await get(ref(accepter.database(), 'players/owner/inventory'))).val() || {};
      const aInv = (await get(ref(accepter.database(), 'players/accepter/inventory'))).val() || {};
      if (Object.prototype.hasOwnProperty.call(oInv, 'listOffer') || oInv.listChosen !== 1) {
        fail(`listing qty1 canonical zero failed: owner=${JSON.stringify(oInv)}`);
      } else if (aInv.listChosen !== 1 || aInv.listOffer !== 1) {
        fail(`listing qty>1 preserve failed: accepter=${JSON.stringify(aInv)}`);
      } else {
        pass('listing owner give absent; accepter remaining qty preserved');
      }
    }

    // --- First trade: missing LB row → increment creates value 1 + group projection ---
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, 'players/offerer/inventory'), { cardGive: 2, cardRecv: 1 });
      await set(ref(db, 'players/target/inventory'), { cardGive: 1, cardRecv: 3 });
      await set(ref(db, 'players/offerer/stats/tradesCompleted'), 0);
      await set(ref(db, 'players/target/stats/tradesCompleted'), 0);
      await set(ref(db, 'players/offerer/groupId'), 'g1');
      await set(ref(db, 'players/target/groupId'), 'g1');
      await set(ref(db, 'players/offerer/subgroupId'), 'sgNew');
      await set(ref(db, 'leaderboards/tradesCompleted/offerer'), null);
      await set(ref(db, 'leaderboards/tradesCompleted/target'), null);
      await set(ref(db, 'trades/direct/t1/status'), 'processing');
      await set(ref(db, 'trades/direct/t1/claimId'), 'claim-first-lb');
      await set(ref(db, 'trades/direct/t1/claimerAuthUid'), 'offererUid');
      await set(ref(db, 'trades/direct/t1/processingBy'), 'offerer');
    });

    await assertSucceeds(
      set(ref(offerer.database(), 'tradeGrants/target/offererUid'), {
        tradeKind: 'direct',
        tradeId: 't1',
        claimId: 'claim-first-lb',
        claimerUsername: 'offerer',
        targetUsername: 'target',
        giveCardId: 'cardGive',
        recvCardId: 'cardRecv',
        expiresAt: Date.now() + 60_000,
      }),
    );

    await assertSucceeds(
      update(ref(offerer.database()), {
        'players/target/inventory/cardGive': null,
        'players/target/inventory/cardRecv': increment(1),
        'players/offerer/inventory/cardRecv': null,
        'players/offerer/inventory/cardGive': increment(1),
        'trades/direct/t1/status': 'accepted',
        'trades/direct/t1/processingBy': null,
        'trades/direct/t1/processingAt': null,
        'trades/direct/t1/claimId': null,
        'trades/direct/t1/claimerAuthUid': null,
        'tradeGrants/target/offererUid': null,
        'players/offerer/stats/tradesCompleted': increment(1),
        'players/target/stats/tradesCompleted': increment(1),
        'leaderboards/tradesCompleted/offerer/value': increment(1),
        'leaderboards/tradesCompleted/offerer/updatedAt': Date.now(),
        'leaderboards/tradesCompleted/offerer/groupId': 'g1',
        'leaderboards/tradesCompleted/offerer/subgroupId': 'sgNew',
        'leaderboards/tradesCompleted/target/value': increment(1),
        'leaderboards/tradesCompleted/target/updatedAt': Date.now(),
        'leaderboards/tradesCompleted/target/groupId': 'g1',
        'leaderboards/tradesCompleted/target/subgroupId': null,
      }),
    );

    {
      let oLb = null;
      let tLb = null;
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        oLb = (await get(ref(ctx.database(), 'leaderboards/tradesCompleted/offerer'))).val();
        tLb = (await get(ref(ctx.database(), 'leaderboards/tradesCompleted/target'))).val();
      });
      if (!oLb || oLb.value !== 1 || oLb.groupId !== 'g1' || oLb.subgroupId !== 'sgNew') {
        fail(`first-trade missing LB row offerer expected value1+group, got ${JSON.stringify(oLb)}`);
      } else if (!tLb || tLb.value !== 1 || tLb.groupId !== 'g1') {
        fail(`first-trade missing LB row target expected value1+group, got ${JSON.stringify(tLb)}`);
      } else {
        pass('first-trade missing LB row creates value:1 with group/subgroup projection');
      }
    }


    // --- Zero-leaf: direct foreign give qty>1 uses increment, leaf remains positive ---
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, 'players/target/inventory'), {
        cardGive: 3,
        cardRecv: 3,
        unrelated: 5,
      });
      await set(ref(db, 'players/offerer/inventory'), {
        cardGive: 2,
        cardRecv: 2,
      });
      await set(ref(db, 'trades/direct/t1/status'), 'processing');
      await set(ref(db, 'trades/direct/t1/claimId'), 'claim-direct-2');
      await set(ref(db, 'trades/direct/t1/claimerAuthUid'), 'offererUid');
      await set(ref(db, 'trades/direct/t1/processingBy'), 'offerer');
    });

    await assertSucceeds(
      set(ref(offerer.database(), 'tradeGrants/target/offererUid'), {
        tradeKind: 'direct',
        tradeId: 't1',
        claimId: 'claim-direct-2',
        claimerUsername: 'offerer',
        targetUsername: 'target',
        giveCardId: 'cardGive',
        recvCardId: 'cardRecv',
        expiresAt: Date.now() + 60_000,
      }),
    );

    await assertSucceeds(
      update(ref(offerer.database()), {
        'players/target/inventory/cardGive': increment(-1),
        'players/target/inventory/cardRecv': increment(1),
        'players/offerer/inventory/cardRecv': increment(-1),
        'players/offerer/inventory/cardGive': increment(1),
        'trades/direct/t1/status': 'accepted',
        'trades/direct/t1/processingBy': null,
        'trades/direct/t1/processingAt': null,
        'trades/direct/t1/claimId': null,
        'trades/direct/t1/claimerAuthUid': null,
        'tradeGrants/target/offererUid': null,
      }),
    );
    {
      const tInv = (await get(ref(offerer.database(), 'players/target/inventory'))).val() || {};
      if (tInv.cardGive !== 2 || tInv.cardRecv !== 4) {
        fail(`direct qty>1 preserve failed: ${JSON.stringify(tInv)}`);
      } else {
        pass('direct qty>1 give decremented; remaining positive preserved');
      }
    }


    // ========== S8c-2: grant-bound foreign side effects ==========
    // Reseed processing + grant for side-effect deny/allow tests (after prior settles cleared grant)
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, 'players/target/stats'), { tradesCompleted: 3, uniqueCardsOwned: 2 });
      await set(ref(db, 'players/target/progression'), { firstTrade: true });
      await set(ref(db, 'players/target/achievements'), {});
      await set(ref(db, 'players/target/lastDirectTradeAt'), 1000);
      await set(ref(db, 'players/target/lastListingAcceptAt'), 1000);
      await set(ref(db, 'leaderboards/tradesCompleted/target'), {
        username: 'target',
        value: 3,
        updatedAt: now,
      });
      await set(ref(db, 'trades/direct/t1/status'), 'processing');
      await set(ref(db, 'trades/direct/t1/claimId'), 'claim-s8c2');
      await set(ref(db, 'trades/direct/t1/claimerAuthUid'), 'offererUid');
      await set(ref(db, 'trades/direct/t1/processingBy'), 'offerer');
    });

    // Foreign stats without grant denied
    await assertFails(
      set(ref(offerer.database(), 'players/target/stats/tradesCompleted'), 99),
    );
    pass('S8c-2: foreign tradesCompleted without grant denied');

    await assertFails(
      set(ref(offerer.database(), 'players/target/achievements/x'), { unlocked: true }),
    );
    pass('S8c-2: foreign achievement without grant denied');

    await assertFails(
      set(ref(offerer.database(), 'players/target/progression/firstTrade'), true),
    );
    pass('S8c-2: foreign progression without grant denied');

    await assertFails(
      set(ref(offerer.database(), 'players/target/lastDirectTradeAt'), Date.now()),
    );
    pass('S8c-2: foreign lastDirectTradeAt without grant denied');

    await assertFails(
      set(ref(offerer.database(), 'players/target/lastListingAcceptAt'), Date.now()),
    );
    pass('S8c-2: foreign lastListingAcceptAt denied (owner/admin only)');

    await assertFails(
      set(ref(offerer.database(), 'leaderboards/tradesCompleted/target'), {
        username: 'target',
        value: 999,
        updatedAt: Date.now(),
      }),
    );
    pass('S8c-2: arbitrary foreign leaderboard write denied');

    // Own lastListingAcceptAt allowed
    await assertSucceeds(
      set(ref(accepter.database(), 'players/accepter/lastListingAcceptAt'), Date.now()),
    );
    pass('S8c-2: own lastListingAcceptAt allowed');

    // Create live grant for allow tests
    await assertSucceeds(
      set(ref(offerer.database(), 'tradeGrants/target/offererUid'), {
        tradeKind: 'direct',
        tradeId: 't1',
        claimId: 'claim-s8c2',
        claimerUsername: 'offerer',
        targetUsername: 'target',
        giveCardId: 'cardGive',
        recvCardId: 'cardRecv',
        expiresAt: Date.now() + 60_000,
      }),
    );
    pass('S8c-2: live grant created for side-effect allows');

    // Exact +1 tradesCompleted under grant (absolute when known)
    await assertSucceeds(
      set(ref(offerer.database(), 'players/target/stats/tradesCompleted'), 4),
    );
    pass('S8c-2: grant-authorized tradesCompleted +1 allowed');

    // ServerValue.increment(1) also satisfies exact +1 validate (settlement fix path)
    await assertSucceeds(
      set(ref(offerer.database(), 'players/target/stats/tradesCompleted'), increment(1)),
    );
    pass('S8c-2: grant-authorized tradesCompleted ServerValue.increment(1) allowed');

    // Cache-blind absolute 1 while server is 5 → denied (live blocker leaf)
    await assertFails(
      set(ref(offerer.database(), 'players/target/stats/tradesCompleted'), 1),
    );
    pass('S8c-2: grant-authorized absolute tradesCompleted=1 when server=5 denied');

    // +2 / arbitrary under grant denied
    await assertFails(
      set(ref(offerer.database(), 'players/target/stats/tradesCompleted'), 10),
    );
    pass('S8c-2: grant-authorized tradesCompleted +2/arbitrary denied');

    // Absolute unique under grant (short-window residual) allowed
    await assertSucceeds(
      set(ref(offerer.database(), 'players/target/stats/uniqueCardsOwned'), 5),
    );
    pass('S8c-2: grant-authorized uniqueCardsOwned absolute allowed');

    await assertSucceeds(
      set(ref(offerer.database(), 'players/target/achievements/trade_milestone'), {
        unlocked: true,
        unlockedAt: Date.now(),
      }),
    );
    pass('S8c-2: grant-authorized achievement write allowed');

    await assertSucceeds(
      set(ref(offerer.database(), 'players/target/progression/firstTrade'), true),
    );
    pass('S8c-2: grant-authorized progression firstTrade=true allowed');

    await assertSucceeds(
      set(ref(offerer.database(), 'players/target/lastDirectTradeAt'), Date.now()),
    );
    pass('S8c-2: grant-authorized lastDirectTradeAt allowed');

    await assertSucceeds(
      set(ref(offerer.database(), 'leaderboards/tradesCompleted/target'), {
        username: 'target',
        value: 4,
        updatedAt: Date.now(),
      }),
    );
    pass('S8c-2: grant-authorized leaderboard write allowed');

    // PTI/LBG still auth-writable (accepted residual)
    await assertSucceeds(
      set(ref(offerer.database(), 'playerTradeIndex/target/direct/fake'), { id: 'fake' }),
    );
    pass('S8c-2: PTI still auth-writable (accepted residual)');
    await assertSucceeds(
      set(ref(offerer.database(), 'listingsByGroup/g1/fakeListing'), { id: 'fakeListing' }),
    );
    pass('S8c-2: listingsByGroup still auth-writable (accepted residual)');

    // tradeGrants parent read: claimer may not enumerate parent (hygiene); leaf still readable
    await assertFails(get(ref(offerer.database(), 'tradeGrants/target')));
    pass('S8c-2: tradeGrants parent read denied to non-target/non-admin');
    await assertSucceeds(get(ref(offerer.database(), 'tradeGrants/target/offererUid')));
    pass('S8c-2: tradeGrants claimer leaf still readable');

    // Clear grant
    await assertSucceeds(
      set(ref(offerer.database(), 'tradeGrants/target/offererUid'), null),
    );

    // --- S8c-1 live-blocker compatibility reads ---
    await assertSucceeds(get(ref(offerer.database(), 'playerDirectory')));
    pass('authenticated parent playerDirectory read allowed');

    await assertSucceeds(get(ref(offerer.database(), 'tradeIndexMeta')));
    pass('authenticated tradeIndexMeta read allowed');

    await assertFails(get(ref(offerer.database(), 'accessCodes')));
    pass('student parent accessCodes enumeration denied');

    const teacher = testEnv.authenticatedContext('teacherUid');
    await assertSucceeds(get(ref(teacher.database(), 'accessCodes')));
    pass('admin parent accessCodes read allowed');

    // Foreign full player still denied for students
    await assertFails(get(ref(offerer.database(), 'players/target')));
    pass('student full foreign players/{other} read denied');

    // Trade-visible foreign leaves
    await assertSucceeds(get(ref(offerer.database(), 'players/target/username')));
    pass('foreign username leaf readable');
    await assertSucceeds(get(ref(offerer.database(), 'players/target/inventory')));
    pass('foreign inventory readable');
    await assertSucceeds(get(ref(offerer.database(), 'players/target/groupId')));
    pass('foreign groupId readable');
    await assertSucceeds(get(ref(offerer.database(), 'players/target/isTradeRestricted')));
    pass('foreign isTradeRestricted readable');
    await assertFails(get(ref(offerer.database(), 'players/target/password')));
    pass('foreign password denied');
    await assertFails(get(ref(offerer.database(), 'players/target/activeSession')));
    pass('foreign activeSession denied');
    await assertFails(get(ref(offerer.database(), 'players/target/stats')));
    pass('foreign stats denied');

    // --- Pre-auth public gates vs locked defs ---
    const anon = testEnv.unauthenticatedContext();
    await assertSucceeds(get(ref(anon.database(), 'config/gameOpen')));
    pass('unauthenticated config/gameOpen read allowed');
    await assertSucceeds(get(ref(anon.database(), 'config/registrationOpen')));
    pass('unauthenticated config/registrationOpen read allowed');
    await assertFails(get(ref(anon.database(), 'config')));
    pass('unauthenticated full /config read denied');
    await assertFails(get(ref(anon.database(), 'cards')));
    pass('unauthenticated /cards read denied');
    await assertFails(get(ref(anon.database(), 'playerDirectory/bobby10')));
    pass('unauthenticated playerDirectory leaf read denied');

    await assertSucceeds(get(ref(offerer.database(), 'leaderboards')));
    pass('authenticated parent /leaderboards read allowed');

    // --- Registration multipath (Auth-first; mirrors js/auth.js register update) ---
    const registrant = testEnv.authenticatedContext('bobby10Uid');
    const regNow = Date.now();
    const regPlayer = {
      username: 'bobby10',
      authUid: 'bobby10Uid',
      createdAt: regNow,
      lastLogin: regNow,
      isAdmin: false,
      group: null,
      subgroup: null,
      inventory: { starterA: 1, starterB: 2 },
      packs: {},
      stats: { packsOpened: 0, cardsCollected: 3, tradesCompleted: 0, projectsCompleted: 0 },
      badges: {},
      achievements: {},
      progression: { tutorialComplete: false, firstTrade: false },
      activeSession: { id: 'sess-reg-1', issuedAt: regNow },
    };
    await assertSucceeds(
      update(ref(registrant.database()), {
        'players/bobby10': regPlayer,
        'accessCodes/ABC123': {
          used: true,
          usedBy: 'bobby10',
          usedAt: regNow,
          created: now,
          group: null,
        },
        'playerDirectory/bobby10': {
          username: 'bobby10',
          groupId: null,
          subgroupId: null,
          isAdmin: false,
          isTradeRestricted: false,
          isTradeProfileHidden: false,
        },
        'playerTradeIndex/bobby10/_meta': {
          schemaVersion: 1,
          rebuiltAt: regNow,
        },
        'leaderboards/tradesCompleted/bobby10': {
          username: 'bobby10',
          score: 0,
          updatedAt: regNow,
        },
      }),
    );
    pass('honest Auth registration multipath allowed');

    // No legacy password hash on Auth-native create
    const created = await get(ref(registrant.database(), 'players/bobby10'));
    if (created.val() && Object.prototype.hasOwnProperty.call(created.val(), 'password')) {
      fail('registration wrote unexpected password field');
    } else {
      pass('Auth registration omitted password hash');
    }

    // Arbitrary create must bind authUid to auth.uid; foreign uid denied
    await assertFails(
      update(ref(registrant.database()), {
        'players/victim': {
          username: 'victim',
          authUid: 'notBobby10Uid',
          isAdmin: false,
          inventory: { x: 1 },
        },
      }),
    );
    pass('cannot create player with foreign authUid');

    // Cannot overwrite an existing player
    await assertFails(
      update(ref(registrant.database()), {
        'players/offerer': {
          username: 'offerer',
          authUid: 'bobby10Uid',
          isAdmin: false,
          inventory: { x: 99 },
        },
      }),
    );
    pass('cannot overwrite existing foreign player on register-shaped write');

    // Used access code cannot be consumed again
    await assertFails(
      update(ref(offerer.database()), {
        'accessCodes/ABC123': {
          used: true,
          usedBy: 'offerer',
          usedAt: regNow,
          created: now,
          group: null,
        },
      }),
    );
    pass('already-used access code consume denied');

    // --- S8d-1: admin-only canonical parent reads ---
    const teacherS8d1 = testEnv.authenticatedContext('teacherUid');
    const anonS8d1 = testEnv.unauthenticatedContext();

    await assertFails(get(ref(anonS8d1.database(), 'players')));
    pass('S8d-1: unauthenticated /players parent denied');

    await assertFails(get(ref(offerer.database(), 'players')));
    pass('S8d-1: student /players parent denied');

    await assertSucceeds(get(ref(teacherS8d1.database(), 'players')));
    pass('S8d-1: admin /players parent allowed');

    const adminPlayers = (await get(ref(teacherS8d1.database(), 'players'))).val() || {};
    if (!adminPlayers.offerer || !adminPlayers.target) {
      fail('S8d-1: admin /players snapshot missing expected usernames');
    } else {
      pass('S8d-1: admin /players enumerates class players');
    }

    await assertSucceeds(get(ref(offerer.database(), 'players/offerer')));
    pass('S8d-1: student own players/{self} still allowed');

    await assertFails(get(ref(offerer.database(), 'players/target')));
    pass('S8d-1: student foreign full player still denied');

    await assertFails(get(ref(offerer.database(), 'players/target/password')));
    pass('S8d-1: student foreign password still denied');

    await assertFails(get(ref(offerer.database(), 'players/target/stats')));
    pass('S8d-1: student foreign stats still denied');

    await assertFails(get(ref(offerer.database(), 'trades/direct')));
    pass('S8d-1: student trades/direct parent denied');

    await assertSucceeds(get(ref(teacherS8d1.database(), 'trades/direct')));
    pass('S8d-1: admin trades/direct parent allowed');

    await assertSucceeds(get(ref(offerer.database(), 'trades/direct/t1')));
    pass('S8d-1: student known trades/direct/{id} child still allowed');

    await assertFails(get(ref(offerer.database(), 'trades/listings')));
    pass('S8d-1: student trades/listings parent denied');

    await assertSucceeds(get(ref(teacherS8d1.database(), 'trades/listings')));
    pass('S8d-1: admin trades/listings parent allowed');

    await assertSucceeds(get(ref(accepter.database(), 'trades/listings/l1')));
    pass('S8d-1: student known trades/listings/{id} child still allowed');

    // Write spot-check: parent-read change must not broaden student writes
    await assertFails(
      set(ref(offerer.database(), 'players/target/stats/packsOpened'), 99),
    );
    pass('S8d-1: student foreign stats write still denied (no write broaden)');

    await assertFails(
      set(ref(stranger.database(), 'trades/direct/t1/status'), 'accepted'),
    );
    pass('S8d-1: stranger trade write still denied (no write broaden)');

    // --- S8d-4a: admin-only parent reads on derived Trade Index roots ---
    // Child R/W and any-auth write residuals unchanged (accepted S8c classroom residual).
    const teacherS8d4a = testEnv.authenticatedContext('teacherUid');
    const anonS8d4a = testEnv.unauthenticatedContext();

    await assertFails(get(ref(anonS8d4a.database(), 'playerTradeIndex')));
    pass('S8d-4a: unauthenticated /playerTradeIndex parent denied');

    await assertFails(get(ref(offerer.database(), 'playerTradeIndex')));
    pass('S8d-4a: student /playerTradeIndex parent denied');

    await assertSucceeds(get(ref(teacherS8d4a.database(), 'playerTradeIndex')));
    pass('S8d-4a: admin /playerTradeIndex parent allowed');

    const adminPti = (await get(ref(teacherS8d4a.database(), 'playerTradeIndex'))).val() || {};
    if (!adminPti.target && !adminPti.bobby10) {
      fail('S8d-4a: admin /playerTradeIndex snapshot missing expected usernames');
    } else {
      pass('S8d-4a: admin /playerTradeIndex enumerates PTI roots');
    }

    // Child read still any-auth (unchanged)
    await assertSucceeds(get(ref(offerer.database(), 'playerTradeIndex/target')));
    pass('S8d-4a: student known playerTradeIndex/{username} child still allowed');

    await assertFails(get(ref(anonS8d4a.database(), 'listingsByGroup')));
    pass('S8d-4a: unauthenticated /listingsByGroup parent denied');

    await assertFails(get(ref(offerer.database(), 'listingsByGroup')));
    pass('S8d-4a: student /listingsByGroup parent denied');

    await assertSucceeds(get(ref(teacherS8d4a.database(), 'listingsByGroup')));
    pass('S8d-4a: admin /listingsByGroup parent allowed');

    const adminLbg = (await get(ref(teacherS8d4a.database(), 'listingsByGroup'))).val() || {};
    if (!adminLbg.g1) {
      fail('S8d-4a: admin /listingsByGroup snapshot missing expected groupId');
    } else {
      pass('S8d-4a: admin /listingsByGroup enumerates group roots');
    }

    await assertSucceeds(get(ref(offerer.database(), 'listingsByGroup/g1')));
    pass('S8d-4a: student known listingsByGroup/{groupId} child still allowed');

    // Write spot-check: parent-read must not change accepted residual writes
    await assertSucceeds(
      set(ref(offerer.database(), 'playerTradeIndex/target/direct/s8d4aProbe'), { id: 's8d4aProbe' }),
    );
    pass('S8d-4a: PTI still auth-writable (accepted residual unchanged)');
    await assertSucceeds(
      set(ref(offerer.database(), 'listingsByGroup/g1/s8d4aProbe'), { id: 's8d4aProbe' }),
    );
    pass('S8d-4a: listingsByGroup still auth-writable (accepted residual unchanged)');

    if (process.exitCode) {
      console.error('\nS8c-1 rules simulator: FAILED — do not weaken inventory rules; fix before deploy.');
    } else {
      console.log('\nS8c-1+S8c-2+S8d-1+S8d-4a rules simulator: ALL REQUIRED PROOFS PASSED');
    }
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((e) => {
  console.error('Simulator crashed:', e);
  process.exitCode = 1;
});
