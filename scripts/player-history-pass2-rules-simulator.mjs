/**
 * Player History Pass 2 RTDB rules proofs (trade foreign history + new self types).
 *
 * Run:
 *   npx firebase emulators:exec --only database "node scripts/player-history-pass2-rules-simulator.mjs"
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { ref, set, update, get } from 'firebase/database';
import { HISTORY_SERVER_TIMESTAMP } from '../js/player-history.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const rules = readFileSync(resolve(root, 'database.rules.json'), 'utf8');
const PROJECT_ID = 'qc-player-history-pass2';
const now = Date.now();

function fail(msg) {
  console.error('FAIL:', msg);
  process.exitCode = 1;
}
function pass(msg) {
  console.log('PASS:', msg);
}

function baseMeta(extra = {}) {
  return {
    ts: HISTORY_SERVER_TIMESTAMP,
    schemaVersion: 1,
    ...extra,
  };
}

function tradeCompleted(kind, tradeId, counterparty) {
  return baseMeta({
    type: 'trade_completed',
    actorType: 'self',
    source: kind === 'listing' ? 'trade_listing' : 'trade_direct',
    tradeKind: kind,
    tradeId,
    counterpartyUsername: counterparty,
    gave: { cardGive: 1 },
    received: { cardRecv: 1 },
  });
}

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { rules, host: '127.0.0.1', port: 9000 },
  });

  try {
    await testEnv.clearDatabase();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), '/'), {
        admins: { teacherUid: true },
        players: {
          alice: { authUid: 'aliceUid' },
          bob: { authUid: 'bobUid' },
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
              offeredCardId: 'cardRecv',
              requestedCardId: 'cardGive',
            },
          },
          listings: {
            L1: {
              status: 'processing',
              claimId: 'claimL',
              claimerAuthUid: 'aliceUid',
              processingBy: 'alice',
              ownerId: 'bob',
              offeredCardId: 'cardGive',
              fulfilledCardId: 'cardRecv',
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
              giveCardId: 'cardGive',
              recvCardId: 'cardRecv',
              expiresAt: now + 60_000,
            },
          },
        },
      });
    });

    const alice = testEnv.authenticatedContext('aliceUid');
    const bob = testEnv.authenticatedContext('bobUid');
    const teacher = testEnv.authenticatedContext('teacherUid');
    const stranger = testEnv.authenticatedContext('strangerUid');

    // Owner self trade history
    await assertSucceeds(
      set(ref(alice.database(), 'playerHistory/alice/ownTrade'), tradeCompleted('direct', 't1', 'bob')),
    );
    pass('owner can create own trade_completed');

    // Foreign via tradeGrant (alice writes bob during direct settlement)
    await assertSucceeds(
      set(ref(alice.database(), 'playerHistory/bob/viaGrant'), tradeCompleted('direct', 't1', 'alice')),
    );
    pass('claimer can create counterparty trade_completed under valid tradeGrant');

    // Arbitrary foreign denied
    await assertFails(
      set(ref(alice.database(), 'playerHistory/bob/bad'), tradeCompleted('direct', 'other', 'alice')),
    );
    pass('arbitrary foreign trade history denied (tradeId mismatch)');

    await assertFails(
      set(ref(stranger.database(), 'playerHistory/bob/x'), tradeCompleted('direct', 't1', 'alice')),
    );
    pass('stranger cannot write trade history');

    // Overwrite / delete denied for students
    await assertFails(
      set(ref(alice.database(), 'playerHistory/alice/ownTrade'), {
        ...tradeCompleted('direct', 't1', 'bob'),
        source: 'trade_listing',
      }),
    );
    pass('student cannot overwrite history');

    await assertFails(set(ref(alice.database(), 'playerHistory/alice/ownTrade'), null));
    pass('student cannot delete history');

    await assertFails(get(ref(bob.database(), 'playerHistory/bob')));
    pass('student cannot read history');

    await assertSucceeds(get(ref(teacher.database(), 'playerHistory/bob/viaGrant')));
    pass('Admin can read history');

    // Project / shop / weekly self creates
    await assertSucceeds(
      set(ref(alice.database(), 'playerHistory/alice/proj1'), baseMeta({
        type: 'project_claimed',
        actorType: 'self',
        source: 'project_claim',
        projectId: 'p1',
        rpDelta: 10,
        breakthrough: false,
        success: true,
      })),
    );
    pass('owner project_claimed create allowed');

    await assertSucceeds(
      set(ref(alice.database(), 'playerHistory/alice/shop1'), baseMeta({
        type: 'shop_purchase',
        actorType: 'self',
        source: 'shop_purchase',
        itemId: 'item1',
        itemType: 'pack',
        pricePaid: 50,
        currency: 'rp',
        packId: 'pack_std',
        quantity: 1,
      })),
    );
    pass('owner shop_purchase create allowed');

    await assertSucceeds(
      set(ref(alice.database(), 'playerHistory/alice/week1'), baseMeta({
        type: 'pack_granted',
        actorType: 'system',
        source: 'weekly_research_pack',
        reason: 'weekly',
        packId: 'pack_std',
        quantity: 1,
        before: 0,
        after: 1,
      })),
    );
    pass('owner weekly pack_granted create allowed');

    await assertFails(
      set(ref(alice.database(), 'playerHistory/alice/fakeAdmin'), baseMeta({
        type: 'pack_granted',
        actorType: 'admin',
        source: 'admin_grant_packs',
        packId: 'pack_std',
        quantity: 5,
        before: 0,
        after: 5,
      })),
    );
    pass('student cannot spoof Admin pack_granted');

    // Listing grant path
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'tradeGrants/bob/aliceUid'), {
        tradeKind: 'listing',
        tradeId: 'L1',
        claimId: 'claimL',
        claimerUsername: 'alice',
        targetUsername: 'bob',
        giveCardId: 'cardGive',
        recvCardId: 'cardRecv',
        expiresAt: now + 60_000,
      });
    });

    await assertSucceeds(
      set(
        ref(alice.database(), 'playerHistory/bob/viaListing'),
        tradeCompleted('listing', 'L1', 'alice'),
      ),
    );
    pass('listing tradeGrant may create counterparty history');

    // Restore direct grant; dual history leaves only (settlement status has its own rules)
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'tradeGrants/bob/aliceUid'), {
        tradeKind: 'direct',
        tradeId: 't1',
        claimId: 'claim1',
        claimerUsername: 'alice',
        targetUsername: 'bob',
        giveCardId: 'cardGive',
        recvCardId: 'cardRecv',
        expiresAt: now + 60_000,
      });
    });

    await assertSucceeds(
      update(ref(alice.database()), {
        'playerHistory/alice/multiA': tradeCompleted('direct', 't1', 'bob'),
        'playerHistory/bob/multiB': tradeCompleted('direct', 't1', 'alice'),
      }),
    );
    pass('multipath dual history leaves allowed under valid direct tradeGrant');

    if (process.exitCode) console.error('\nplayer-history-pass2 rules: FAILED');
    else console.log('\nplayer-history-pass2 rules: all checks passed');
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((e) => {
  fail(e?.message || String(e));
  console.error(e);
  process.exit(1);
});
