/**
 * Phase 1F player-lock RTDB rules proofs.
 *
 * Run (from repo root, Java required for emulator):
 *   npx firebase emulators:exec --only database "node scripts/player-lock-rules-simulator.mjs"
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
import {
  buildAdminLockPlayerUpdates,
  buildAdminUnlockPlayerUpdates,
} from '../js/player-lock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const rules = readFileSync(resolve(root, 'database.rules.json'), 'utf8');

const PROJECT_ID = 'qc-player-lock-rules-sim';
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

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, '/'), {
        admins: { teacherUid: true },
        tradeIndexMeta: { schemaVersion: 1, rebuiltAt: now },
        config: { gameOpen: true, registrationOpen: true },
        cards: { c1: { id: 'c1', name: 'Card' } },
        packs: { std: { id: 'std', name: 'Standard' } },
        players: {
          alice: {
            authUid: 'aliceUid',
            inventory: { c1: 2 },
            packs: { p1: { packTypeId: 'std', quantity: 1 } },
            projects: { proj1: { status: 'ACTIVE' } },
            shop: { owned: { item1: true } },
            researchPoints: 10,
            stats: { packsOpened: 1, cardsCollected: 2, uniqueCardsOwned: 1 },
            achievements: { a1: { unlockedAt: now } },
            progression: { tier: 1 },
            profile: { featuredCardId: 'c1' },
            cosmetics: { owned: { cos1: true } },
            activeSession: { id: 'sess-alice', issuedAt: now },
            displayName: 'AliceShow',
          },
          bob: {
            authUid: 'bobUid',
            inventory: { c1: 3 },
            packs: {},
            stats: { packsOpened: 0, uniqueCardsOwned: 1 },
            activeSession: { id: 'sess-bob', issuedAt: now },
          },
          carol: {
            authUid: 'carolUid',
            inventory: { c1: 1 },
            stats: { uniqueCardsOwned: 1 },
          },
        },
        playerDirectory: {
          alice: { username: 'alice', displayName: 'AliceShow', groupId: null },
          bob: { username: 'bob', displayName: 'Bob', groupId: null },
          carol: { username: 'carol', displayName: 'Carol', groupId: null },
        },
        leaderboards: {
          packsOpened: {
            alice: { username: 'alice', value: 1 },
            bob: { username: 'bob', value: 0 },
          },
        },
        playerTradeIndex: {
          alice: { _meta: { ready: true } },
          bob: { _meta: { ready: true } },
        },
        listingsByGroup: {
          g1: { _meta: { ready: true } },
        },
        trades: {
          direct: {},
          listings: {},
        },
      });
    });

    const alice = testEnv.authenticatedContext('aliceUid');
    const bob = testEnv.authenticatedContext('bobUid');
    const carol = testEnv.authenticatedContext('carolUid');
    const teacher = testEnv.authenticatedContext('teacherUid');
    const stranger = testEnv.authenticatedContext('strangerUid');

    // ========== UNLOCKED baseline ==========
    await assertSucceeds(update(ref(alice.database()), {
      'players/alice/inventory/c1': 3,
    }));
    pass('UNLOCKED: alice inventory write allowed');

    await assertSucceeds(update(ref(alice.database()), {
      'players/alice/packs/p2': { packTypeId: 'std', quantity: 1 },
    }));
    pass('UNLOCKED: alice pack write allowed');

    await assertSucceeds(update(ref(alice.database()), {
      'players/alice/projects/proj2': { status: 'ACTIVE' },
    }));
    pass('UNLOCKED: alice project write allowed');

    await assertSucceeds(update(ref(alice.database()), {
      'players/alice/researchPoints': 11,
      'players/alice/shop/owned/item2': true,
    }));
    pass('UNLOCKED: alice shop/currency write allowed');

    await assertSucceeds(
      set(ref(alice.database(), 'trades/direct/td_unlocked'), {
        id: 'td_unlocked',
        status: 'pending',
        offeringPlayerId: 'alice',
        targetPlayerId: 'bob',
        offeredCardId: 'c1',
        requestedCardId: 'c1',
        createdAt: now,
      }),
    );
    pass('UNLOCKED: alice→bob direct trade create allowed');

    await assertSucceeds(
      update(ref(bob.database()), {
        'trades/direct/td_unlocked/status': 'accepted',
      }),
    );
    pass('UNLOCKED: bob accept/update direct trade allowed');

    // ========== ADMIN LOCK alice (atomic mirrors + clear session) ==========
    const lockBody = buildAdminLockPlayerUpdates('alice', 'aliceUid', 'teacherUid', now);
    await assertSucceeds(update(ref(teacher.database()), lockBody));
    pass('ADMIN: lock multipath succeeds');

    const lockUser = (await get(ref(teacher.database(), 'playerLocks/alice'))).val();
    const lockUid = (await get(ref(teacher.database(), 'playerLocksByUid/aliceUid'))).val();
    const sess = (await get(ref(teacher.database(), 'players/alice/activeSession'))).val();
    if (!(lockUser && lockUser.locked === true)) fail('ADMIN: username mirror missing after lock');
    else pass('ADMIN: username mirror created');
    if (!(lockUid && lockUid.locked === true && lockUid.username === 'alice')) {
      fail('ADMIN: uid mirror missing/wrong after lock');
    } else pass('ADMIN: uid mirror created');
    if (sess != null) fail('ADMIN: activeSession not cleared');
    else pass('SESSION: lock clears activeSession');

    // ========== LOCKED SELF denials ==========
    await assertFails(update(ref(alice.database()), {
      'players/alice/inventory/c1': 99,
    }));
    pass('LOCKED SELF: inventory write denied');

    await assertFails(update(ref(alice.database()), {
      'players/alice/packs/p1/quantity': 9,
    }));
    pass('LOCKED SELF: pack write denied');

    await assertFails(update(ref(alice.database()), {
      'players/alice/projects/proj1/status': 'DONE',
    }));
    pass('LOCKED SELF: project write denied');

    await assertFails(update(ref(alice.database()), {
      'players/alice/researchPoints': 999,
      'players/alice/shop/owned/hack': true,
    }));
    pass('LOCKED SELF: shop/currency write denied');

    await assertFails(update(ref(alice.database()), {
      'players/alice/achievements/a2': { unlockedAt: now },
      'players/alice/progression/tier': 99,
    }));
    pass('LOCKED SELF: achievement/progression write denied');

    await assertFails(update(ref(alice.database()), {
      'players/alice/profile/featuredCardId': 'x',
      'players/alice/cosmetics/owned/x': true,
      'playerDirectory/alice/displayName': 'Hacked',
    }));
    pass('LOCKED SELF: profile/directory write denied');

    await assertFails(update(ref(alice.database()), {
      'leaderboards/packsOpened/alice/value': 999,
    }));
    pass('LOCKED SELF: leaderboard write denied');

    await assertFails(
      set(ref(alice.database(), 'trades/direct/td_locked'), {
        id: 'td_locked',
        status: 'pending',
        offeringPlayerId: 'alice',
        targetPlayerId: 'bob',
        offeredCardId: 'c1',
        requestedCardId: 'c1',
        createdAt: now,
      }),
    );
    pass('LOCKED SELF: direct trade create denied');

    await assertFails(
      set(ref(alice.database(), 'trades/listings/ll_locked'), {
        id: 'll_locked',
        status: 'open',
        ownerId: 'alice',
        offeredCardId: 'c1',
        createdAt: now,
      }),
    );
    pass('LOCKED SELF: listing create denied');

    await assertFails(update(ref(alice.database()), {
      'playerTradeIndex/alice/direct/x': { id: 'x' },
    }));
    pass('LOCKED SELF: trade index write denied');

    await assertFails(
      set(ref(alice.database(), 'tradeGrants/bob/aliceUid'), {
        tradeKind: 'direct',
        tradeId: 'nope',
        claimId: 'c',
        claimerUsername: 'alice',
        targetUsername: 'bob',
        giveCardId: 'c1',
        recvCardId: 'c1',
        expiresAt: now + 60_000,
      }),
    );
    pass('LOCKED SELF: trade grant write denied');

    await assertFails(update(ref(alice.database()), {
      'players/alice/activeSession': { id: 'stale-reclaim', issuedAt: now },
    }));
    pass('SESSION: stale authenticated student activeSession write rejected by rules');

    await assertFails(update(ref(alice.database()), {
      'listingsByGroup/g1/listingX': { id: 'listingX' },
    }));
    pass('LOCKED SELF: listingsByGroup write denied');

    // ========== CROSS-PLAYER ==========
    await assertFails(
      set(ref(bob.database(), 'trades/direct/td_to_locked'), {
        id: 'td_to_locked',
        status: 'pending',
        offeringPlayerId: 'bob',
        targetPlayerId: 'alice',
        offeredCardId: 'c1',
        requestedCardId: 'c1',
        createdAt: now,
      }),
    );
    pass('CROSS: unlocked bob cannot create direct trade targeting locked alice');

    await assertFails(
      set(ref(bob.database(), 'tradeGrants/alice/bobUid'), {
        tradeKind: 'direct',
        tradeId: 'x',
        claimId: 'c',
        claimerUsername: 'bob',
        targetUsername: 'alice',
        giveCardId: 'c1',
        recvCardId: 'c1',
        expiresAt: now + 60_000,
      }),
    );
    pass('CROSS: unlocked bob cannot create grant against locked alice');

    await assertFails(update(ref(bob.database()), {
      'players/alice/inventory/c1': 0,
    }));
    pass('CROSS: unlocked bob cannot mutate locked alice inventory');

    await assertFails(update(ref(bob.database()), {
      'playerTradeIndex/alice/direct/y': { id: 'y' },
    }));
    pass('CROSS: unlocked bob cannot mutate locked alice trade index');

    await assertSucceeds(update(ref(bob.database()), {
      'players/bob/inventory/c1': 4,
    }));
    pass('CROSS: unrelated unlocked bob still writable');

    await assertSucceeds(
      set(ref(bob.database(), 'trades/direct/td_bob_carol'), {
        id: 'td_bob_carol',
        status: 'pending',
        offeringPlayerId: 'bob',
        targetPlayerId: 'carol',
        offeredCardId: 'c1',
        requestedCardId: 'c1',
        createdAt: now,
      }),
    );
    pass('CROSS: trade between two unlocked players still allowed');

    // ========== ADMIN manage while locked ==========
    await assertSucceeds(update(ref(teacher.database()), {
      'players/alice/inventory/c1': 5,
      'players/alice/packs/adminPack': { packTypeId: 'std', quantity: 2 },
      'players/alice/researchPoints': 50,
    }));
    pass('ADMIN: can manage locked alice player data');

    await assertFails(update(ref(stranger.database()), {
      'playerLocks/alice': { locked: true, lockedAt: now, lockedByUid: 'strangerUid' },
    }));
    pass('ADMIN: student cannot write playerLocks');

    await assertFails(update(ref(alice.database()), {
      'playerLocksByUid/aliceUid': null,
    }));
    pass('ADMIN: locked student cannot clear own uid lock');

    // ========== UNLOCK ==========
    const unlockBody = buildAdminUnlockPlayerUpdates('alice', 'aliceUid');
    await assertSucceeds(update(ref(teacher.database()), unlockBody));
    pass('ADMIN: unlock multipath succeeds');

    const afterUser = (await get(ref(teacher.database(), 'playerLocks/alice'))).val();
    const afterUid = (await get(ref(teacher.database(), 'playerLocksByUid/aliceUid'))).val();
    if (afterUser != null || afterUid != null) fail('ADMIN: unlock did not remove both mirrors');
    else pass('ADMIN: unlock removes both mirrors');

    await assertSucceeds(update(ref(alice.database()), {
      'players/alice/inventory/c1': 6,
    }));
    pass('UNLOCKED after unlock: alice inventory write allowed again');

    const carolSnap = (await get(ref(teacher.database(), 'players/carol'))).val();
    if (carolSnap?.inventory?.c1 !== 1) fail('ADMIN: unrelated carol inventory changed');
    else pass('ADMIN: unrelated carol inventory unchanged');

    // Re-lock for mirror malformed tests via admin seed
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, 'playerLocks/alice'), {
        locked: true,
        lockedAt: now,
        lockedByUid: 'teacherUid',
      });
      // intentionally omit uid mirror
    });

    await assertFails(update(ref(alice.database()), {
      'players/alice/inventory/c1': 1,
    }));
    pass('MIRRORS: username-only lock still denies player writes (fail-closed)');

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, 'playerLocks/alice'), null);
      await set(ref(db, 'playerLocksByUid/aliceUid'), {
        locked: true,
        username: 'alice',
        lockedAt: now,
        lockedByUid: 'teacherUid',
      });
    });

    await assertFails(update(ref(alice.database()), {
      'players/alice/inventory/c1': 1,
    }));
    pass('MIRRORS: uid-only lock still denies player writes (fail-closed)');

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, 'playerLocks/alice'), {
        locked: true,
        lockedAt: now,
        lockedByUid: 'teacherUid',
      });
      await set(ref(db, 'playerLocksByUid/aliceUid'), {
        locked: true,
        username: 'not-alice',
        lockedAt: now,
        lockedByUid: 'teacherUid',
      });
    });

    await assertFails(update(ref(alice.database()), {
      'players/alice/inventory/c1': 1,
    }));
    pass('MIRRORS: mismatched mirrors still deny player writes');

    // Teacher can still clear mismatched state via unlock paths
    await assertSucceeds(update(ref(teacher.database()), buildAdminUnlockPlayerUpdates('alice', 'aliceUid')));
    pass('ADMIN: can clear mismatched mirrors via unlock multipath');

    if (process.exitCode) {
      console.error('\nplayer-lock rules simulator: FAILED');
    } else {
      console.log('\nplayer-lock rules simulator: ALL REQUIRED PROOFS PASSED');
    }
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
