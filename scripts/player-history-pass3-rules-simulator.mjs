/**
 * Pass 3 rules: retention leaf delete + whole-tree admin delete + student guards.
 * Run: npx firebase emulators:exec --only database "node scripts/player-history-pass3-rules-simulator.mjs"
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
import { PLAYER_HISTORY_RETENTION_MS } from '../js/player-history-retention.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(resolve(__dirname, '../database.rules.json'), 'utf8');
const now = Date.now();

function pass(msg) { console.log('PASS:', msg); }

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: 'qc-player-history-pass3',
    database: { rules, host: '127.0.0.1', port: 9000 },
  });

  try {
    await testEnv.clearDatabase();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), '/'), {
        admins: { teacherUid: true },
        players: {
          alice: {
            authUid: 'aliceUid',
            inventory: { cardKeep: 3 },
            packs: { packKeep: 2 },
            stats: { packsOpened: 9, researchPoints: 42 },
          },
          bob: { authUid: 'bobUid' },
        },
        playerHistory: {
          alice: {
            recent: {
              type: 'pack_opened',
              ts: now - 1000,
              schemaVersion: 1,
              actorType: 'self',
              source: 'pack_open',
              packId: 'p',
              cardsGranted: { c: 1 },
              deltas: { packsOpened: 1, cardsCollected: 1 },
            },
            expired: {
              type: 'pack_opened',
              ts: now - PLAYER_HISTORY_RETENTION_MS - 60_000,
              schemaVersion: 1,
              actorType: 'self',
              source: 'pack_open',
              packId: 'p',
              cardsGranted: { cardKeep: 3 },
              deltas: { packsOpened: 1, cardsCollected: 1 },
            },
            expiredStat: {
              type: 'admin_stat_correct',
              ts: now - PLAYER_HISTORY_RETENTION_MS - 120_000,
              schemaVersion: 1,
              actorType: 'admin',
              source: 'admin_stat',
              fieldId: 'packsOpened',
              before: 8,
              after: 9,
            },
          },
          bob: {
            keep: {
              type: 'shop_purchase',
              ts: now - 5000,
              schemaVersion: 1,
              actorType: 'self',
              source: 'shop_purchase',
              itemId: 'i',
              itemType: 'pack',
              pricePaid: 1,
              currency: 'rp',
            },
          },
        },
      });
    });

    const alice = testEnv.authenticatedContext('aliceUid');
    const bob = testEnv.authenticatedContext('bobUid');
    const teacher = testEnv.authenticatedContext('teacherUid');

    // Student create still works (indexOn must not break writes)
    await assertSucceeds(set(ref(alice.database(), 'playerHistory/alice/newOpen'), {
      type: 'pack_opened',
      ts: HISTORY_SERVER_TIMESTAMP,
      schemaVersion: 1,
      actorType: 'self',
      source: 'pack_open',
      packId: 'p',
      cardsGranted: { c: 1 },
      deltas: { packsOpened: 1, cardsCollected: 1 },
    }));
    pass('student pack_opened create still allowed with indexOn');

    await assertFails(set(ref(alice.database(), 'playerHistory/alice/recent'), null));
    pass('student cannot delete recent history');

    await assertSucceeds(set(ref(alice.database(), 'playerHistory/alice/expired'), null));
    pass('student can delete own expired history leaf (retention)');

    await assertSucceeds(set(ref(alice.database(), 'playerHistory/alice/expiredStat'), null));
    pass('student can delete own expired admin_stat_correct leaf');

    // Retention must not touch gameplay — inventory/packs/stats unchanged after history leaf deletes
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const inv = await get(ref(ctx.database(), 'players/alice/inventory/cardKeep'));
      const packs = await get(ref(ctx.database(), 'players/alice/packs/packKeep'));
      const stats = await get(ref(ctx.database(), 'players/alice/stats'));
      const expiredGone = await get(ref(ctx.database(), 'playerHistory/alice/expired'));
      const recentStill = await get(ref(ctx.database(), 'playerHistory/alice/recent'));
      if (inv.val() !== 3 || packs.val() !== 2 || stats.val()?.packsOpened !== 9 || stats.val()?.researchPoints !== 42) {
        throw new Error('gameplay mutated by history retention deletes');
      }
      if (expiredGone.exists()) throw new Error('expired history leaf still present');
      if (!recentStill.exists()) throw new Error('recent history incorrectly removed');
      const bobHist = await get(ref(ctx.database(), 'playerHistory/bob/keep'));
      if (!bobHist.exists()) throw new Error('unrelated player history was removed');
    });
    pass('pruning expired history leaves inventory/packs/stats + other players untouched');

    await assertFails(set(ref(alice.database(), 'playerHistory/bob/keep'), null));
    pass('student cannot delete other player history');

    await assertFails(set(ref(alice.database(), 'playerHistory/alice'), null));
    pass('student cannot delete whole history tree');

    await assertSucceeds(set(ref(teacher.database(), 'playerHistory/alice/recent'), null));
    pass('Admin can delete any history leaf');

    await assertSucceeds(set(ref(teacher.database(), 'playerHistory/bob'), null));
    pass('Admin can delete whole playerHistory/{username} tree');

    await assertFails(get(ref(bob.database(), 'playerHistory/bob')));
    pass('student still cannot read history');

    // Multipath permanent-delete shaped: player + history tree
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'players/temp'), { authUid: 'tempUid' });
      await set(ref(ctx.database(), 'playerHistory/temp/e1'), {
        type: 'pack_opened',
        ts: now,
        schemaVersion: 1,
        actorType: 'self',
        source: 'pack_open',
      });
    });
    await assertSucceeds(update(ref(teacher.database()), {
      'players/temp': null,
      'playerHistory/temp': null,
    }));
    pass('Admin multipath player + history tree delete allowed');

  } finally {
    await testEnv.cleanup();
  }

  if (process.exitCode) console.error('\npass3 rules: FAILED');
  else console.log('\npass3 rules: all checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
