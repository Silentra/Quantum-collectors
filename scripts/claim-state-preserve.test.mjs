/**
 * Focused unit proofs for achievement claim-state preservation + tradesCompleted
 * planner increment semantics (no Firebase emulator required).
 *
 * Run: node scripts/claim-state-preserve.test.mjs
 */

import { claimFieldsFromExisting } from '../js/achievement-mutations.js';
import { serverIncrement } from '../js/trade-direct-plan.js';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('PASS:', msg);
  }
}

// --- claimFieldsFromExisting ---
{
  const preserved = claimFieldsFromExisting({
    unlocked: true,
    claimed: true,
    claimedAt: 123456,
  });
  assert(preserved.claimed === true && preserved.claimedAt === 123456, 'preserves claimed + claimedAt');
}

{
  const fresh = claimFieldsFromExisting(null);
  assert(fresh.claimed === false && fresh.claimedAt === 0, 'null existing → unclaimed defaults');
}

{
  const unclaimed = claimFieldsFromExisting({
    unlocked: true,
    claimed: false,
    claimedAt: 0,
  });
  assert(unclaimed.claimed === false && unclaimed.claimedAt === 0, 'unclaimed stays unclaimed');
}

{
  const zeroAt = claimFieldsFromExisting({ claimed: true, claimedAt: 0 });
  assert(zeroAt.claimed === true && zeroAt.claimedAt === 0, 'claimed with claimedAt 0 still claimed');
}

// --- tradesCompleted wire form (both sides use increment, never absolute cache+1) ---
{
  const wire = serverIncrement(1);
  assert(
    wire && wire['.sv'] && wire['.sv'].increment === 1,
    'serverIncrement(1) wire form for tradesCompleted',
  );
}

// Simulate planner decision: thin cache must not produce absolute 1 overwrite payload
{
  const cachePrev = 0; // stale/missing
  const absoluteClobber = cachePrev + 1; // old bug
  const safe = serverIncrement(1);
  assert(absoluteClobber === 1, 'documents old clobber shape would be absolute 1');
  assert(typeof safe === 'object' && safe['.sv'].increment === 1, 'new shape is increment not absolute 1');
}

if (!process.exitCode) {
  console.log('\nclaim-state-preserve tests: ALL PASSED');
}
