/**
 * Batch D3 — Firebase /cards conversion preview (read-only).
 * Run: node scripts/batch-d3-card-migration-preview.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CARD_DEFINITIONS } from '../js/card-data.js';
import {
  buildCardFirebaseConversionPlan,
  serializeRawCardsPreMigrationBackup,
  PREVIEW_ONLY_MESSAGE,
} from '../js/card-migration.js';

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

const sampleBase = BASE_CARD_DEFINITIONS.find((c) => c.id === ACCELERATION_ID)
  || BASE_CARD_DEFINITIONS[0];
const otherBase = BASE_CARD_DEFINITIONS.find((c) => c.id !== sampleBase.id);

{
  // 1. identical full base record → redundant
  const snap = {
    [sampleBase.id]: { ...sampleBase, created: 12345, auraType: 'none' },
  };
  const plan = buildCardFirebaseConversionPlan({
    baseCards: BASE_CARD_DEFINITIONS,
    firebaseSnapshot: snap,
  });
  assert(plan.redundantIds.includes(sampleBase.id), '1. identical → redundant');
  assert(plan.updates.deletes.includes(sampleBase.id), '1. delete listed');
  assert(!plan.overrideDetails.some((o) => o.id === sampleBase.id), '1. not override');
}

{
  // 2. sparse enabled:false → override
  const plan = buildCardFirebaseConversionPlan({
    baseCards: BASE_CARD_DEFINITIONS,
    firebaseSnapshot: { [sampleBase.id]: { enabled: false } },
  });
  const detail = plan.overrideDetails.find((o) => o.id === sampleBase.id);
  assert(!!detail && detail.override.enabled === false, '2. enabled:false → override');
  assert(plan.updates.sparseSets[sampleBase.id]?.enabled === false, '2. sparseSets');
}

{
  // 3. name override
  const plan = buildCardFirebaseConversionPlan({
    baseCards: BASE_CARD_DEFINITIONS,
    firebaseSnapshot: { [sampleBase.id]: { name: 'Renamed Card' } },
  });
  const detail = plan.overrideDetails.find((o) => o.id === sampleBase.id);
  assert(detail?.override.name === 'Renamed Card', '3. name override');
}

{
  // 4. alias-only image → redundant
  const plan = buildCardFirebaseConversionPlan({
    baseCards: [sampleBase],
    firebaseSnapshot: {
      [sampleBase.id]: {
        ...sampleBase,
        image: sampleBase.imageUrl || sampleBase.image || '',
        imageUrl: '',
      },
    },
  });
  // With only one base card, bundledCount !== 125 → readyForD4 false, but classification ok
  assert(plan.redundantIds.includes(sampleBase.id), '4. alias-only image → redundant');
}

{
  // 5. alias-only flavor → redundant
  const plan = buildCardFirebaseConversionPlan({
    baseCards: [sampleBase],
    firebaseSnapshot: {
      [sampleBase.id]: {
        ...sampleBase,
        flavor: '',
        keyFact: sampleBase.keyFact || sampleBase.flavor,
      },
    },
  });
  assert(plan.redundantIds.includes(sampleBase.id), '5. alias-only flavor → redundant');
}

{
  // 6. empty-string effect difference → override
  const withEffect = BASE_CARD_DEFINITIONS.find((c) => c.effect && c.effect.length > 0);
  const plan = buildCardFirebaseConversionPlan({
    baseCards: BASE_CARD_DEFINITIONS,
    firebaseSnapshot: { [withEffect.id]: { effect: '' } },
  });
  const detail = plan.overrideDetails.find((o) => o.id === withEffect.id);
  assert(detail?.override.effect === '', '6. empty effect override');
}

{
  // 7. Firebase-only → custom
  const plan = buildCardFirebaseConversionPlan({
    baseCards: BASE_CARD_DEFINITIONS,
    firebaseSnapshot: {
      card_custom_only: {
        id: 'card_custom_only',
        name: 'Custom',
        type: 'scientist',
        rarity: 'common',
        enabled: true,
      },
    },
  });
  assert(plan.customDetails.some((c) => c.id === 'card_custom_only'), '7. custom classified');
  assert(plan.updates.preserveIds.includes('card_custom_only'), '7. preserveIds');
  assert(!BASE_CARD_DEFINITIONS.some((c) => c.id === 'card_custom_only'), '7. not in base');
}

{
  // 8. malformed → readyForD4 false
  const plan = buildCardFirebaseConversionPlan({
    baseCards: BASE_CARD_DEFINITIONS,
    firebaseSnapshot: { bad_child: 'not-an-object' },
  });
  assert(plan.malformedCount >= 1, '8. malformed count');
  assert(plan.readyForD4 === false, '8. readyForD4 false');
}

{
  // 9. path/id mismatch → malformed
  const plan = buildCardFirebaseConversionPlan({
    baseCards: BASE_CARD_DEFINITIONS,
    firebaseSnapshot: {
      [sampleBase.id]: { ...sampleBase, id: 'card_other_id' },
    },
  });
  assert(plan.malformedDetails.some((m) => m.pathId === sampleBase.id), '9. path/id mismatch');
  assert(plan.readyForD4 === false, '9. readyForD4 false');
}

{
  // 10–11. bundled with no Firebase child / Acceleration — no migration action
  const snap = { [otherBase.id]: { ...otherBase } };
  const plan = buildCardFirebaseConversionPlan({
    baseCards: BASE_CARD_DEFINITIONS,
    firebaseSnapshot: snap,
  });
  assert(!plan.redundantIds.includes(sampleBase.id), '10. absent base not in deletes');
  assert(!plan.overrideDetails.some((o) => o.id === sampleBase.id), '10. absent not override');
  assert(plan.bundledAbsentFromFirebaseIds.includes(sampleBase.id), '10. listed as absent');

  const accel = BASE_CARD_DEFINITIONS.find((c) => c.id === ACCELERATION_ID);
  assert(!!accel, '11. Acceleration in bundled base');
  const accelPlan = buildCardFirebaseConversionPlan({
    baseCards: BASE_CARD_DEFINITIONS,
    firebaseSnapshot: {},
  });
  assert(
    !accelPlan.redundantIds.includes(ACCELERATION_ID)
      && !accelPlan.overrideDetails.some((o) => o.id === ACCELERATION_ID)
      && accelPlan.bundledAbsentFromFirebaseIds.includes(ACCELERATION_ID),
    '11. Acceleration-style: no recreate/delete/override',
  );
}

{
  // 12. finalFirebaseRecordCount === override + custom
  const plan = buildCardFirebaseConversionPlan({
    baseCards: BASE_CARD_DEFINITIONS,
    firebaseSnapshot: {
      [sampleBase.id]: { enabled: false },
      card_custom_z: { id: 'card_custom_z', name: 'Z', type: 'concept', enabled: false },
      [otherBase.id]: { ...otherBase },
    },
  });
  assert(
    plan.finalFirebaseRecordCount === plan.overrideCount + plan.customCount,
    '12. finalFirebaseRecordCount === override + custom',
  );
}

{
  // 13. raw backup round-trip
  const snap = {
    [sampleBase.id]: { ...sampleBase, created: 99, secretRaw: 'keep-me' },
  };
  const before = JSON.stringify(snap);
  const json = serializeRawCardsPreMigrationBackup(snap);
  assert(JSON.stringify(snap) === before, '13. snapshot not mutated by serialize');
  const parsed = JSON.parse(json);
  assert(parsed[sampleBase.id].secretRaw === 'keep-me', '13. raw field preserved');
  assert(parsed[sampleBase.id].created === 99, '13. created preserved');
}

{
  // 14. planner does not mutate inputs
  const bases = BASE_CARD_DEFINITIONS.slice(0, 3).map((c) => ({ ...c }));
  const snap = { [bases[0].id]: { ...bases[0], created: 1 } };
  const bBefore = JSON.stringify(bases);
  const sBefore = JSON.stringify(snap);
  buildCardFirebaseConversionPlan({ baseCards: bases, firebaseSnapshot: snap });
  assert(JSON.stringify(bases) === bBefore && JSON.stringify(snap) === sBefore, '14. inputs not mutated');
}

{
  // Full base duplicate tree readiness (125)
  const full = {};
  for (const c of BASE_CARD_DEFINITIONS) {
    full[c.id] = { ...c, created: 1 };
  }
  delete full[ACCELERATION_ID];
  const plan = buildCardFirebaseConversionPlan({
    baseCards: BASE_CARD_DEFINITIONS,
    firebaseSnapshot: full,
  });
  assert(plan.bundledCount === 125, 'transition bundled 125');
  assert(plan.firebaseCount === 124, 'transition firebase 124 without Acceleration');
  assert(plan.redundantCount === 124, 'transition 124 redundant');
  assert(plan.overrideCount === 0 && plan.customCount === 0 && plan.malformedCount === 0, 'transition clean');
  assert(plan.readyForD4 === true, 'transition readyForD4');
  assert(plan.bundledAbsentFromFirebaseIds.includes(ACCELERATION_ID), 'transition Acceleration absent');
  assert(plan.message === PREVIEW_ONLY_MESSAGE, 'preview message');
}

{
  // 15. D3 source has no mutation APIs in preview workflow
  const mig = readFileSync(join(root, 'js', 'card-migration.js'), 'utf8');
  for (const bad of [
    'db.set(',
    'db.update(',
    'db.remove(',
    'createCard(',
    'updateCard(',
    'deleteCard(',
    'seedDefaultCards(',
    'setAcknowledged(',
    'updateAcknowledged(',
  ]) {
    assert(!mig.includes(bad), `card-migration.js has no ${bad}`);
  }

  const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
  const start = ui.indexOf('async function handleAdminCardConversionPreview');
  const end = ui.indexOf('function closeCardConversionPreviewModal');
  assert(start >= 0 && end > start, 'D3 handler located');
  const block = ui.slice(start, end);
  for (const bad of ['db.set(', 'db.update(', 'db.remove(', 'createCard(', 'updateCard(', 'deleteCard(']) {
    assert(!block.includes(bad), `D3 ui handler has no ${bad}`);
  }
}

if (!process.exitCode) {
  console.log('\nAll Batch D3 migration preview tests passed.');
} else {
  console.error('\nBatch D3 migration preview tests failed.');
}
