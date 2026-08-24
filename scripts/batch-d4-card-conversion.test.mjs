/**
 * Batch D4 — Firebase /cards conversion commit helpers.
 * Run: node scripts/batch-d4-card-conversion.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CARD_DEFINITIONS, BASE_CARD_COUNT } from '../js/card-data.js';
import {
  buildCardFirebaseConversionPlan,
  buildCardConversionFirebaseUpdates,
  assertCardConversionUpdatePaths,
  validateFreshPlanForD4Commit,
  commitCardFirebaseConversionPlan,
} from '../js/card-migration.js';
import { resolveAllCards } from '../js/card-override.js';
import { seedDefaultCards, normalizeConceptTypes } from '../js/cards.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCELERATION_ID = 'card_mpouka18pbhk';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('PASS:', msg);
  }
}

const sample = BASE_CARD_DEFINITIONS.find((c) => c.id !== ACCELERATION_ID)
  || BASE_CARD_DEFINITIONS[0];
const other = BASE_CARD_DEFINITIONS.find((c) => c.id !== sample.id && c.id !== ACCELERATION_ID);

function planFromSnap(snap) {
  return buildCardFirebaseConversionPlan({
    baseCards: BASE_CARD_DEFINITIONS,
    firebaseSnapshot: snap,
  });
}

{
  // 1. redundant → null updates
  const plan = planFromSnap({ [sample.id]: { ...sample, created: 1 } });
  const built = buildCardConversionFirebaseUpdates(plan);
  assert(built.ok === true, '1. build updates ok');
  assert(built.updates[`cards/${sample.id}`] === null, '1. redundant → null');
}

{
  // 2. sparse override → sparse set
  const plan = planFromSnap({ [sample.id]: { enabled: false } });
  // Gate will fail allowOverrides=false — build updates still works if we force ready
  // Fresh plan with override: readyForD4 true but validateFreshPlanForD4Commit fails
  assert(plan.readyForD4 === true, '2. plan ready despite override');
  assert(validateFreshPlanForD4Commit(plan).ok === false, '2. gate aborts unexpected override');
  const built = buildCardConversionFirebaseUpdates(plan);
  assert(built.ok && built.updates[`cards/${sample.id}`]?.enabled === false, '2. sparse set');
}

{
  // 3. Firebase-only custom → no delete in updates
  const plan = planFromSnap({
    card_custom_d4: { id: 'card_custom_d4', name: 'C', type: 'scientist', enabled: true },
  });
  assert(plan.customCount === 1, '3. custom classified');
  assert(validateFreshPlanForD4Commit(plan).ok === false, '3. gate aborts unexpected custom');
  const built = buildCardConversionFirebaseUpdates(plan);
  assert(built.ok && built.updates[`cards/card_custom_d4`] === undefined, '3. custom not deleted');
  assert(Object.keys(built.updates).length === 0, '3. no writes for custom-only snap');
}

{
  // 4. malformed → abort / no writes
  const plan = planFromSnap({ bad: 'x' });
  assert(plan.readyForD4 === false, '4. malformed not ready');
  const built = buildCardConversionFirebaseUpdates(plan);
  assert(built.ok === false, '4. build updates refused');
  const commit = await commitCardFirebaseConversionPlan(plan, {
    updateAcknowledged: async () => ({ ok: true }),
  });
  assert(commit.ok === false && commit.wrote === false, '4. commit aborted');
}

{
  // 5. absent bundled base → no action
  const plan = planFromSnap({});
  assert(plan.bundledAbsentFromFirebaseIds.includes(ACCELERATION_ID), '5. Acceleration absent');
  const built = buildCardConversionFirebaseUpdates(plan);
  assert(built.ok && Object.keys(built.updates).length === 0, '5. empty updates');
  assert(!Object.keys(built.updates).some((p) => p.includes(ACCELERATION_ID)), '5. no Acceleration write');
}

{
  // 6. allowed-path invariant
  const bad = assertCardConversionUpdatePaths({ 'players/x': null });
  assert(bad.ok === false, '6. players/ rejected');
  const bad2 = assertCardConversionUpdatePaths({ 'cards/a/b': null });
  assert(bad2.ok === false, '6. nested cards path rejected');
  const good = assertCardConversionUpdatePaths({ [`cards/${sample.id}`]: null });
  assert(good.ok === true, '6. cards/{id} allowed');
}

{
  // 7. empty update plan → no-op commit
  const plan = planFromSnap({});
  let called = false;
  const commit = await commitCardFirebaseConversionPlan(plan, {
    updateAcknowledged: async () => {
      called = true;
      return { ok: true };
    },
  });
  assert(commit.ok && commit.skipped === true && called === false, '7. empty → no-op no write');
}

{
  // 8. empty Firebase + bundled → resolved 125
  const resolved = resolveAllCards(BASE_CARD_DEFINITIONS, {});
  assert(resolved.length === 125 && BASE_CARD_COUNT === 125, '8. empty FB + base → 125');
}

{
  // 9–10. seed / normalize gates
  const before = JSON.stringify(BASE_CARD_DEFINITIONS);
  seedDefaultCards();
  normalizeConceptTypes();
  assert(JSON.stringify(BASE_CARD_DEFINITIONS) === before, '9/10. seed/normalize do not mutate base');
  const cardsSrc = readFileSync(join(root, 'js', 'cards.js'), 'utf8');
  assert(cardsSrc.includes('BASE_CARD_COUNT > 0'), '9. seed gated');
  const normStart = cardsSrc.indexOf('export function normalizeConceptTypes');
  const normEnd = cardsSrc.indexOf('export function seedDefaultCards');
  assert(!cardsSrc.slice(normStart, normEnd).includes('updateCard('), '10. normalize no writeback');
}

{
  // 11. stale preview is NOT committed — UI must re-gather (static)
  const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
  const start = ui.indexOf('async function handleAdminCardConversionCommit');
  const end = ui.indexOf('function setupCardConversionPreviewModal');
  assert(start >= 0 && end > start, '11. D4 handler located');
  const block = ui.slice(start, end);
  assert(block.includes('gatherAuthoritativeCardsForExport'), '11. fresh gather in D4');
  assert(block.includes('buildCardFirebaseConversionPlan'), '11. fresh plan in D4');
  assert(!block.includes('_d3CardConversionPreviewState.plan'), '11. does not commit stale D3 plan');
  assert(block.includes('commitCardFirebaseConversionPlan'), '11. uses commit helper');
}

{
  // 12. inputs not mutated + full clean conversion updates
  const full = {};
  for (const c of BASE_CARD_DEFINITIONS) {
    if (c.id === ACCELERATION_ID) continue;
    full[c.id] = { ...c, created: 1 };
  }
  const snapBefore = JSON.stringify(full);
  const plan = planFromSnap(full);
  assert(plan.readyForD4 && plan.redundantCount === 124 && plan.overrideCount === 0, '12. clean 124 plan');
  assert(validateFreshPlanForD4Commit(plan).ok === true, '12. gate allows clean plan');
  const built = buildCardConversionFirebaseUpdates(plan);
  assert(built.pathCount === 124, '12. 124 null deletes');
  assert(Object.values(built.updates).every((v) => v === null), '12. all nulls');
  assert(JSON.stringify(full) === snapBefore, '12. snapshot not mutated');

  let written = null;
  const commit = await commitCardFirebaseConversionPlan(plan, {
    updateAcknowledged: async (updates) => {
      written = updates;
      return { ok: true, mode: 'firebase' };
    },
  });
  assert(commit.ok && commit.wrote && written && Object.keys(written).length === 124, '12. commit wrote 124');
  assert(assertCardConversionUpdatePaths(written).ok, '12. committed paths cards-only');
}

{
  // allowOverrides path for sparse when explicitly allowed
  const plan = planFromSnap({ [sample.id]: { enabled: false }, [other.id]: { ...other } });
  const commit = await commitCardFirebaseConversionPlan(plan, {
    allowOverridesAndCustoms: true,
    updateAcknowledged: async (updates) => {
      assert(updates[`cards/${sample.id}`]?.enabled === false, 'allow: sparse written');
      assert(updates[`cards/${other.id}`] === null, 'allow: redundant null');
      return { ok: true, mode: 'firebase' };
    },
  });
  assert(commit.ok && commit.wrote, 'allowOverrides commit ok');
}

if (!process.exitCode) {
  console.log('\nAll Batch D4 conversion tests passed.');
} else {
  console.error('\nBatch D4 conversion tests failed.');
}
