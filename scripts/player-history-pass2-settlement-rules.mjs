/**
 * Player History Pass 2 — REAL settlement-shaped multipath rules proofs.
 *
 * Covers direct trade, listing fulfill, project claim, shop purchase, weekly claim
 * with playerHistory leaves in the SAME update as gameplay mutations.
 *
 * Also proves Pass-1-shaped allowlist would reject Pass 2 event types (regression guard).
 *
 * Run:
 *   npx firebase emulators:exec --only database "node scripts/player-history-pass2-settlement-rules.mjs"
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { ref, set, update, increment, serverTimestamp } from 'firebase/database';
import { HISTORY_SERVER_TIMESTAMP } from '../js/player-history.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const rules = readFileSync(resolve(root, 'database.rules.json'), 'utf8');
const now = Date.now();

function pass(msg) { console.log('PASS:', msg); }
function fail(msg) {
  console.error('FAIL:', msg);
  process.exitCode = 1;
}

function histBase(extra) {
  return {
    ts: HISTORY_SERVER_TIMESTAMP,
    schemaVersion: 1,
    ...extra,
  };
}

function tradeHist(kind, tradeId, counterparty, gave, received) {
  return histBase({
    type: 'trade_completed',
    actorType: 'self',
    source: kind === 'listing' ? 'trade_listing' : 'trade_direct',
    tradeKind: kind,
    tradeId,
    ...(kind === 'listing' ? { listingId: tradeId } : {}),
    counterpartyUsername: counterparty,
    gave,
    received,
  });
}

function projectHist() {
  return histBase({
    type: 'project_claimed',
    actorType: 'self',
    source: 'project_claim',
    actorUsername: 'alice',
    projectId: 'proj1',
    rpDelta: 120,
    breakthrough: true,
    success: true,
    cardsGranted: { cardA: 1 },
  });
}

function shopHist() {
  return histBase({
    type: 'shop_purchase',
    actorType: 'self',
    source: 'shop_purchase',
    actorUsername: 'alice',
    itemId: 'item_pack',
    itemType: 'pack',
    pricePaid: 200,
    currency: 'rp',
    packId: 'pack_std',
    quantity: 1,
  });
}

function weeklyHist() {
  return histBase({
    type: 'pack_granted',
    actorType: 'system',
    source: 'weekly_research_pack',
    actorUsername: 'alice',
    reason: 'weekly',
    packId: 'pack_weekly',
    quantity: 1,
    before: 0,
    after: 1,
  });
}

/** Build Pass-1-only playerHistory write allowlist (for negative proof). */
function buildPass1OnlyRulesJson() {
  const j = JSON.parse(rules);
  const write =
    "auth != null && ((!data.exists() && newData.exists() && ((root.child('admins').child(auth.uid).val() === true && (newData.child('type').val() === 'pack_opened' || newData.child('type').val() === 'pack_granted' || newData.child('type').val() === 'pack_removed' || newData.child('type').val() === 'card_granted' || newData.child('type').val() === 'card_removed' || newData.child('type').val() === 'admin_stat_correct')) || (root.child('players').child($username).child('authUid').val() === auth.uid && newData.child('type').val() === 'pack_opened' && newData.child('actorType').val() === 'self' && newData.child('source').val() === 'pack_open'))) || (root.child('admins').child(auth.uid).val() === true && !newData.exists()))";
  j.rules.playerHistory.$username.$eventId['.write'] = write;
  return JSON.stringify(j);
}

async function seedCommon(testEnv) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await set(ref(ctx.database(), '/'), {
      admins: { teacherUid: true },
      players: {
        alice: {
          authUid: 'aliceUid',
          inventory: { cardA: 1, cardB: 0 },
          packs: { pack_std: 1, pack_weekly: 0 },
          stats: { tradesCompleted: 0, shopPurchases: 0 },
          currencies: { currentResearchPoints: 500 },
          projects: [],
          weeklyPackClaimed: false,
          weeklyRPProgress: 999,
          weeklyResetAt: now + 86400000,
          totalResearchPoints: 10,
          progression: {},
          achievements: {},
          purchaseHistory: [],
          shop: { currentRotation: { slots: [], generatedAt: 1 } },
        },
        bob: {
          authUid: 'bobUid',
          inventory: { cardA: 0, cardB: 1 },
          stats: { tradesCompleted: 0 },
          progression: {},
          achievements: {},
        },
      },
      trades: {
        direct: {
          t1: {
            status: 'processing',
            claimId: 'claim1',
            claimerAuthUid: 'aliceUid',
            processingBy: 'alice',
            offeringPlayerId: 'alice',
            targetPlayerId: 'bob',
            offeredCardId: 'cardA',
            requestedCardId: 'cardB',
          },
        },
        listings: {
          L1: {
            status: 'processing',
            claimId: 'claimL',
            claimerAuthUid: 'aliceUid',
            processingBy: 'alice',
            ownerId: 'bob',
            offeredCardId: 'cardB',
            fulfilledCardId: 'cardA',
            groupId: 'g1',
          },
        },
      },
      tradeGrants: {
        bob: {
          aliceUid: {
            tradeKind: 'direct',
            tradeId: 't1',
            claimId: 'claim1',
            claimerUsername: 'alice',
            targetUsername: 'bob',
            giveCardId: 'cardB',
            recvCardId: 'cardA',
            expiresAt: now + 60_000,
          },
        },
      },
    });
  });
}

async function main() {
  // ── Negative: Pass-1 allowlist rejects Pass 2 types ───────────────────────
  {
    const pass1Path = resolve(root, '_tmp_pass1_rules.json');
    writeFileSync(pass1Path, buildPass1OnlyRulesJson());
    const env1 = await initializeTestEnvironment({
      projectId: 'qc-hist-pass1-neg',
      database: { rules: readFileSync(pass1Path, 'utf8'), host: '127.0.0.1', port: 9000 },
    });
    try {
      await env1.clearDatabase();
      await env1.withSecurityRulesDisabled(async (ctx) => {
        await set(ref(ctx.database(), '/'), {
          players: { alice: { authUid: 'aliceUid' } },
        });
      });
      const alice = env1.authenticatedContext('aliceUid');
      await assertSucceeds(set(ref(alice.database(), 'playerHistory/alice/ok'), histBase({
        type: 'pack_opened',
        actorType: 'self',
        source: 'pack_open',
        packId: 'p',
        cardsGranted: { c: 1 },
        deltas: { packsOpened: 1, cardsCollected: 1 },
      })));
      pass('Pass1 rules: pack_opened still allowed');

      await assertFails(set(ref(alice.database(), 'playerHistory/alice/t'), tradeHist('direct', 't1', 'bob', { a: 1 }, { b: 1 })));
      pass('Pass1 rules: trade_completed DENIED (explains live regression if rules undeployed)');

      await assertFails(set(ref(alice.database(), 'playerHistory/alice/p'), projectHist()));
      pass('Pass1 rules: project_claimed DENIED');

      await assertFails(set(ref(alice.database(), 'playerHistory/alice/s'), shopHist()));
      pass('Pass1 rules: shop_purchase DENIED');

      await assertFails(set(ref(alice.database(), 'playerHistory/alice/w'), weeklyHist()));
      pass('Pass1 rules: weekly pack_granted DENIED');
    } finally {
      await env1.cleanup();
      try { unlinkSync(pass1Path); } catch { /* */ }
    }
  }

  // ── Positive: Pass 2 rules + full settlement multipaths ───────────────────
  const testEnv = await initializeTestEnvironment({
    projectId: 'qc-hist-pass2-settle',
    database: { rules, host: '127.0.0.1', port: 9000 },
  });

  try {
    await testEnv.clearDatabase();
    await seedCommon(testEnv);
    const alice = testEnv.authenticatedContext('aliceUid');

    // DIRECT settlement-shaped multipath + dual history
    await assertSucceeds(update(ref(alice.database()), {
      'players/bob/inventory/cardB': null,
      'players/bob/inventory/cardA': increment(1),
      'players/alice/inventory/cardA': null,
      'players/alice/inventory/cardB': increment(1),
      'trades/direct/t1/status': 'accepted',
      'trades/direct/t1/completedAt': now,
      'trades/direct/t1/processingBy': null,
      'trades/direct/t1/claimId': null,
      'trades/direct/t1/claimerAuthUid': null,
      'tradeGrants/bob/aliceUid': null,
      'players/alice/stats/tradesCompleted': increment(1),
      'players/bob/stats/tradesCompleted': increment(1),
      'players/alice/lastDirectTradeAt': now,
      'players/bob/lastDirectTradeAt': now,
      'players/alice/progression/firstTrade': true,
      'players/bob/progression/firstTrade': true,
      'playerHistory/alice/dA': tradeHist('direct', 't1', 'bob', { cardA: 1 }, { cardB: 1 }),
      'playerHistory/bob/dB': tradeHist('direct', 't1', 'alice', { cardB: 1 }, { cardA: 1 }),
    }));
    pass('REAL-shaped direct settlement + dual history succeeds');

    // LISTING — reset grant/listing state
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'trades/listings/L1/status'), 'processing');
      await set(ref(ctx.database(), 'trades/listings/L1/claimId'), 'claimL');
      await set(ref(ctx.database(), 'trades/listings/L1/claimerAuthUid'), 'aliceUid');
      await set(ref(ctx.database(), 'players/bob/inventory'), { cardA: 1, cardB: 1 });
      await set(ref(ctx.database(), 'players/alice/inventory'), { cardA: 0, cardB: 1 });
      await set(ref(ctx.database(), 'tradeGrants/bob/aliceUid'), {
        tradeKind: 'listing',
        tradeId: 'L1',
        claimId: 'claimL',
        claimerUsername: 'alice',
        targetUsername: 'bob',
        giveCardId: 'cardB',
        recvCardId: 'cardA',
        expiresAt: now + 60_000,
      });
    });

    await assertSucceeds(update(ref(alice.database()), {
      'players/bob/inventory/cardB': null,
      'players/bob/inventory/cardA': increment(1),
      'players/alice/inventory/cardB': null,
      'players/alice/inventory/cardA': increment(1),
      'trades/listings/L1/status': 'fulfilled',
      'trades/listings/L1/respondedAt': now,
      'trades/listings/L1/fulfilledBy': 'alice',
      'trades/listings/L1/fulfilledCardId': 'cardA',
      'trades/listings/L1/processingBy': null,
      'trades/listings/L1/claimId': null,
      'trades/listings/L1/claimerAuthUid': null,
      'tradeGrants/bob/aliceUid': null,
      'players/alice/lastListingAcceptAt': now,
      'players/alice/stats/tradesCompleted': increment(1),
      'players/bob/stats/tradesCompleted': increment(1),
      'players/alice/progression/firstTrade': true,
      'players/bob/progression/firstTrade': true,
      'playerHistory/bob/lOwner': tradeHist('listing', 'L1', 'alice', { cardB: 1 }, { cardA: 1 }),
      'playerHistory/alice/lAcc': tradeHist('listing', 'L1', 'bob', { cardA: 1 }, { cardB: 1 }),
    }));
    pass('REAL-shaped listing fulfillment + dual history succeeds');

    // PROJECT CLAIM — gameplay + history
    await assertSucceeds(update(ref(alice.database()), {
      'players/alice/projects': [{ id: 'proj1', state: 'claimed' }],
      'players/alice/totalResearchPoints': 130,
      'players/alice/currencies/currentResearchPoints': 620,
      'players/alice/inventory/cardA': 2,
      'players/alice/stats/cardsCollected': 1,
      'playerHistory/alice/proj': projectHist(),
    }));
    pass('REAL-shaped project claim + history succeeds');

    // SHOP PURCHASE — gameplay + history (purchaseHistory preserved)
    await assertSucceeds(update(ref(alice.database()), {
      'players/alice/currencies/currentResearchPoints': 420,
      'players/alice/packs/pack_std': 2,
      'players/alice/shop/currentRotation/slots': [],
      'players/alice/purchaseHistory': [{ itemId: 'item_pack' }],
      'players/alice/stats/shopPurchases': 1,
      'playerHistory/alice/shop': shopHist(),
    }));
    pass('REAL-shaped shop purchase + history succeeds');

    // WEEKLY pack claim
    await assertSucceeds(update(ref(alice.database()), {
      'players/alice/packs/pack_weekly': 1,
      'players/alice/weeklyPackClaimed': true,
      'playerHistory/alice/week': weeklyHist(),
    }));
    pass('REAL-shaped weekly claim + history succeeds');

    // Unauthorized foreign history still denied
    await assertFails(update(ref(alice.database()), {
      'playerHistory/bob/evil': tradeHist('direct', 'nope', 'alice', { x: 1 }, { y: 1 }),
    }));
    pass('arbitrary foreign history still denied');

    await assertFails(set(ref(alice.database(), 'playerHistory/alice/shop'), null));
    pass('student history delete still denied');

  } finally {
    await testEnv.cleanup();
  }

  if (process.exitCode) {
    console.error('\nplayer-history-pass2-settlement-rules: FAILED');
  } else {
    console.log('\nplayer-history-pass2-settlement-rules: all checks passed');
  }
}

main().catch((e) => {
  fail(e?.message || String(e));
  console.error(e);
  process.exit(1);
});
