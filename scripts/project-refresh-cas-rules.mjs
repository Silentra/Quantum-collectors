/**
 * Emulator rules tests for lastProjectRefreshAt one-cycle CAS.
 *
 * Run:
 *   npx firebase emulators:exec --only database "node scripts/project-refresh-cas-rules.mjs"
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import { ref, set, update } from 'firebase/database';
import { PROJECT_REFRESH_INTERVAL_MS } from '../js/project-refresh.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(resolve(__dirname, '../database.rules.json'), 'utf8');

const I = PROJECT_REFRESH_INTERVAL_MS;
const T0 = 1_700_000_000_000;

let failed = 0;
function pass(msg) {
  console.log('PASS:', msg);
}
function fail(msg) {
  console.error('FAIL:', msg);
  failed += 1;
  process.exitCode = 1;
}

async function expectPass(label, promise) {
  try {
    await assertSucceeds(promise);
    pass(label);
  } catch (e) {
    fail(`${label} — ${e.message || e}`);
  }
}

async function expectFail(label, promise) {
  try {
    await assertFails(promise);
    pass(label);
  } catch (e) {
    fail(`${label} — expected deny — ${e.message || e}`);
  }
}

async function main() {
  if (I !== 12 * 60 * 60 * 1000) fail('interval coupling constant');
  else pass('interval constant 12h');

  const rulesObj = JSON.parse(rules);
  const v = rulesObj.rules.players.$username.lastProjectRefreshAt['.validate'];
  if (v && v.includes(String(I))) pass('rules embed interval ms');
  else fail('rules missing interval');

  const testEnv = await initializeTestEnvironment({
    projectId: 'qc-refresh-cas-test',
    database: { rules, host: '127.0.0.1', port: 9000 },
  });

  try {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'players/alice'), {
        authUid: 'aliceUid',
        lastProjectRefreshAt: T0,
        projects: [{ id: 'p0', state: 'available', title: 'Base' }],
        currencies: { currentResearchPoints: 10 },
      });
      await set(ref(ctx.database(), 'admins/adminUid'), true);
      await set(ref(ctx.database(), 'players/newbie'), {
        authUid: 'newUid',
        lastProjectRefreshAt: 0,
        projects: [],
      });
      await set(ref(ctx.database(), 'players/dave'), {
        authUid: 'daveUid',
        lastProjectRefreshAt: T0,
        currencies: { currentResearchPoints: 20 },
        projects: [],
      });
    });

    const alice = testEnv.authenticatedContext('aliceUid').database();
    const admin = testEnv.authenticatedContext('adminUid').database();
    const newbie = testEnv.authenticatedContext('newUid').database();
    const dave = testEnv.authenticatedContext('daveUid').database();

    await expectPass(
      'A) INITIALIZED NORMAL STEP T0→T1',
      update(ref(alice), {
        'players/alice/lastProjectRefreshAt': T0 + I,
        'players/alice/projects': [
          { id: 'p0', state: 'available', title: 'Base' },
          { id: 'p1', state: 'available', title: 'New' },
        ],
      }),
    );

    await expectFail(
      'B) EQUAL REPLAY T1→T1',
      update(ref(alice), {
        'players/alice/lastProjectRefreshAt': T0 + I,
      }),
    );

    await expectFail(
      'C) BACKWARD T1→T0',
      update(ref(alice), {
        'players/alice/lastProjectRefreshAt': T0,
      }),
    );

    // Stale multi-step: proposing T0+2I while server is T1 is mathematically
    // the same as T1+I — that IS a valid next step. Prove bypass of jumping
    // *more than one interval beyond server* is denied:
    await expectFail(
      'D) STALE MULTI-STEP jump T1→T0+3I (+2 intervals) DENIED',
      update(ref(alice), {
        'players/alice/lastProjectRefreshAt': T0 + 3 * I,
      }),
    );

    await expectPass(
      'E) VALID NEXT STEP T1→T2',
      update(ref(alice), {
        'players/alice/lastProjectRefreshAt': T0 + 2 * I,
      }),
    );

    // Admin cannot casually set arbitrary refreshAt (must obey CAS too)
    await expectFail(
      'F) ADMIN arbitrary jump DENIED',
      update(ref(admin), {
        'players/alice/lastProjectRefreshAt': T0 + 99 * I,
      }),
    );

    await expectPass(
      'F) ADMIN delete refreshAt for cleanup PASS',
      set(ref(admin, 'players/alice/lastProjectRefreshAt'), null),
    );

    // Restore alice refresh for further tests
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'players/alice/lastProjectRefreshAt'), T0 + 2 * I);
    });

    await expectPass(
      'G) BOOTSTRAP from 0 PASS',
      update(ref(newbie), {
        'players/newbie/lastProjectRefreshAt': T0,
        'players/newbie/projects': [
          { id: 'boot1', state: 'available', title: 'Init1' },
          { id: 'boot2', state: 'available', title: 'Init2' },
        ],
      }),
    );

    // Initialized player cannot reset to 0 (owner write requires newData.exists,
    // and validate rejects val===0)
    await expectFail(
      'G) INITIALIZED reset to 0 DENIED',
      set(ref(alice, 'players/alice/lastProjectRefreshAt'), 0),
    );

    await expectFail(
      'G) OWNER delete refreshAt DENIED',
      set(ref(alice, 'players/alice/lastProjectRefreshAt'), null),
    );

    await expectPass(
      'H) unrelated gameplay RP spend PASS',
      update(ref(dave), {
        'players/dave/currencies/currentResearchPoints': 5,
      }),
    );
  } catch (e) {
    fail(`EMULATOR ERROR: ${e?.message || e}`);
    console.error(e);
  } finally {
    await testEnv.cleanup();
  }

  if (failed) {
    console.error('\nproject-refresh-cas-rules: FAILED');
    process.exit(1);
  }
  console.log('\nproject-refresh-cas-rules: all checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
