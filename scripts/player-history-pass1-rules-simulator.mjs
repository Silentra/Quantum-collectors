/**
 * Player History Pass 1 RTDB rules proofs (C0–C3 writers).
 *
 * Run:
 *   npx firebase emulators:exec --only database "node scripts/player-history-pass1-rules-simulator.mjs"
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
const PROJECT_ID = 'qc-player-history-pass1';
const now = Date.now();

function fail(msg) {
  console.error('FAIL:', msg);
  process.exitCode = 1;
}
function pass(msg) {
  console.log('PASS:', msg);
}

function packOpenedEvent() {
  return {
    type: 'pack_opened',
    ts: HISTORY_SERVER_TIMESTAMP,
    schemaVersion: 1,
    actorType: 'self',
    source: 'pack_open',
    actorUid: 'aliceUid',
    actorUsername: 'alice',
    packId: 'pack_std',
    cardsGranted: { c1: 2, c2: 1 },
    deltas: { packsOpened: 1, cardsCollected: 3 },
  };
}

function adminGrantEvent() {
  return {
    type: 'pack_granted',
    ts: HISTORY_SERVER_TIMESTAMP,
    schemaVersion: 1,
    actorType: 'admin',
    source: 'admin_grant_packs',
    actorUid: 'teacherUid',
    packId: 'pack_std',
    quantity: 5,
    before: 0,
    after: 5,
  };
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
      });
    });

    const alice = testEnv.authenticatedContext('aliceUid');
    const bob = testEnv.authenticatedContext('bobUid');
    const teacher = testEnv.authenticatedContext('teacherUid');
    const stranger = testEnv.authenticatedContext('strangerUid');

    await assertSucceeds(
      set(ref(alice.database(), 'playerHistory/alice/evt1'), packOpenedEvent()),
    );
    pass('self pack_opened create allowed');

    await assertFails(
      set(ref(alice.database(), 'playerHistory/bob/evt2'), packOpenedEvent()),
    );
    pass('student cannot write another player history');

    await assertFails(
      set(ref(alice.database(), 'playerHistory/alice/evt1'), {
        ...packOpenedEvent(),
        type: 'pack_granted',
      }),
    );
    pass('student cannot overwrite existing history');

    await assertFails(
      set(ref(alice.database(), 'playerHistory/alice/evt1'), null),
    );
    pass('student cannot delete history');

    await assertFails(get(ref(alice.database(), 'playerHistory/alice')));
    pass('student cannot read history');

    await assertSucceeds(get(ref(teacher.database(), 'playerHistory/alice/evt1')));
    pass('Admin can read history');

    await assertSucceeds(
      set(ref(teacher.database(), 'playerHistory/alice/evt3'), adminGrantEvent()),
    );
    pass('Admin can create pack_granted');

    await assertSucceeds(
      set(ref(teacher.database(), 'playerHistory/alice/evt3'), null),
    );
    pass('Admin can delete history leaf');

    await assertFails(
      set(ref(bob.database(), 'playerHistory/bob/bad'), {
        type: 'pack_opened',
        ts: HISTORY_SERVER_TIMESTAMP,
        schemaVersion: 1,
        actorType: 'admin',
        source: 'pack_open',
      }),
    );
    pass('self create requires actorType self for pack_opened');

    await assertFails(
      set(ref(stranger.database(), 'playerHistory/alice/x'), adminGrantEvent()),
    );
    pass('non-admin stranger cannot write admin events');

    // Atomic multipath sample: gameplay + history together (Admin)
    await assertSucceeds(
      update(ref(teacher.database()), {
        'players/alice/packs/pack_std': 5,
        'playerHistory/alice/evt_multi': adminGrantEvent(),
      }),
    );
    pass('Admin multipath pack + history allowed');

    if (process.exitCode) console.error('\nplayer-history-pass1 rules: FAILED');
    else console.log('\nplayer-history-pass1 rules: ALL REQUIRED PROOFS PASSED');
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
