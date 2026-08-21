/**
 * S8c-1 local RTDB rules proof (Firebase emulator + @firebase/rules-unit-testing).
 *
 * Proves:
 *  1) ServerValue.increment(±1) yields newData that satisfies exact-delta inventory rules
 *  2) Fake grant create fails
 *  3) Unrelated foreign inventory write fails
 *  4) Honest direct + listing settlement multipaths pass under locked rules
 *
 * Run (from repo root, with Java available for emulator):
 *   npm install --no-save firebase @firebase/rules-unit-testing firebase-tools
 *   npx firebase emulators:exec --only database "node scripts/s8c1-rules-simulator.mjs"
 *
 * STOP condition: if increment exact-delta cannot be proven, do not weaken inventory rules.
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
        'players/offerer/stats/tradesCompleted': 1,
        'players/target/stats/tradesCompleted': 1,
        'players/offerer/progression/firstTrade': true,
        'players/target/progression/firstTrade': true,
        'players/offerer/lastDirectTradeAt': Date.now(),
        'players/target/lastDirectTradeAt': Date.now(),
      }),
    );
    pass('honest direct settlement multipath allowed');

    // --- 4b) Honest listing settlement ---
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, 'players/owner/inventory'), { listOffer: 1, listChosen: 0 });
      await set(ref(db, 'players/accepter/inventory'), { listOffer: 0, listChosen: 2 });
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

    await assertSucceeds(
      update(ref(accepter.database()), {
        'players/owner/inventory/listOffer': increment(-1),
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
        'players/owner/progression/firstTrade': true,
        'players/accepter/progression/firstTrade': true,
      }),
    );
    pass('honest listing settlement multipath allowed');

    if (process.exitCode) {
      console.error('\nS8c-1 rules simulator: FAILED — do not weaken inventory rules; fix before deploy.');
    } else {
      console.log('\nS8c-1 rules simulator: ALL REQUIRED PROOFS PASSED');
    }
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((e) => {
  console.error('Simulator crashed:', e);
  process.exitCode = 1;
});
