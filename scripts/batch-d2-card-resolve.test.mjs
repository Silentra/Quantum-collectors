/**
 * Batch D2 — bundled base + override resolve/diff.
 * Run: node scripts/batch-d2-card-resolve.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_CARD_COUNT,
  BASE_CARD_DEFINITIONS,
} from '../js/card-data.js';
import {
  applyCardOverride,
  buildCardOverride,
  effectiveCardFlavor,
  effectiveCardImage,
  resolveAllCards,
} from '../js/card-override.js';
import {
  isBundledBaseCard,
  normalizeConceptTypes,
  seedDefaultCards,
} from '../js/cards.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('PASS:', msg);
  }
}

const exportCards = JSON.parse(
  readFileSync(join(root, 'quantum-collectors-card-data.json'), 'utf8'),
);
const exportIds = new Set(exportCards.map((c) => c.id));

// --- BASE DATA ---
{
  assert(BASE_CARD_COUNT === 125, 'BASE_CARD_COUNT === 125');
  assert(BASE_CARD_DEFINITIONS.length === 125, 'BASE_CARD_DEFINITIONS length 125');
  const ids = BASE_CARD_DEFINITIONS.map((c) => c.id);
  assert(new Set(ids).size === 125, 'bundled IDs unique');
  assert(
    ids.every((id) => exportIds.has(id)) && exportIds.size === 125,
    'ID set equals root export',
  );
  assert(
    [...ids].sort().join(',') === [...exportIds].sort().join(','),
    'exact ID equality with export',
  );
  const sci = BASE_CARD_DEFINITIONS.filter((c) => c.type === 'scientist').length;
  const con = BASE_CARD_DEFINITIONS.filter((c) => c.type === 'concept').length;
  assert(sci === 62 && con === 63, '62 scientists / 63 concepts');

  const newton = BASE_CARD_DEFINITIONS.find((c) => c.name === 'Isaac Newton');
  assert(!!newton && newton.type === 'scientist', 'representative scientist present');
  assert(newton.effect === 'Gravity Master', 'scientist effect preserved');
  assert(newton.flavor === newton.keyFact, 'scientist flavor===keyFact');

  const darkEnergy = BASE_CARD_DEFINITIONS.find((c) => c.name === 'Dark Energy');
  assert(!!darkEnergy && darkEnergy.type === 'concept', 'representative concept present');
  assert(typeof darkEnergy.flavorText === 'string' && darkEnergy.flavorText.length > 0, 'concept flavorText');
  assert(typeof darkEnergy.conceptType === 'string', 'concept conceptType');

  const emptyEffect = BASE_CARD_DEFINITIONS.filter((c) => c.effect === '').length;
  assert(emptyEffect === 101, '101 empty effects preserved');
}

// --- MERGE ---
{
  const baseOnly = resolveAllCards(BASE_CARD_DEFINITIONS, {});
  assert(baseOnly.length === 125, 'empty Firebase → 125 resolved');
  assert(new Set(baseOnly.map((c) => c.id)).size === 125, 'empty Firebase unique IDs');

  const fullDup = {};
  for (const c of BASE_CARD_DEFINITIONS) {
    fullDup[c.id] = { ...c, created: 999, auraType: 'none' };
  }
  const mergedDup = resolveAllCards(BASE_CARD_DEFINITIONS, fullDup);
  assert(mergedDup.length === 125, 'full Firebase duplicate → 125');
  const sample = BASE_CARD_DEFINITIONS[0];
  const resolved = applyCardOverride(sample, fullDup[sample.id]);
  assert(resolved.name === sample.name && resolved.enabled === sample.enabled, 'duplicate merge identity name/enabled');
  assert(resolved.id === sample.id, 'duplicate merge preserves id');

  const disabled = applyCardOverride(sample, { enabled: false });
  assert(disabled.enabled === false, 'partial {enabled:false} after merge');
  assert(disabled.name === sample.name, 'partial keep base name');

  const named = applyCardOverride(sample, { name: 'Renamed' });
  assert(named.name === 'Renamed', 'name-only override');

  const emptyFx = applyCardOverride(
    { ...sample, effect: 'Something' },
    { effect: '' },
  );
  assert(emptyFx.effect === '', 'empty-string override survives');

  const fbOnly = applyCardOverride(null, {
    id: 'card_custom_test',
    name: 'Custom',
    type: 'scientist',
    rarity: 'common',
    field: 'X',
    effect: '',
    image: '',
    imageUrl: '',
    flavor: 'f',
    keyFact: 'f',
    enabled: true,
  });
  const withFbOnly = resolveAllCards(BASE_CARD_DEFINITIONS, {
    card_custom_test: {
      id: 'card_custom_test',
      name: 'Custom',
      type: 'scientist',
      rarity: 'common',
      enabled: true,
    },
  });
  assert(fbOnly.id === 'card_custom_test', 'Firebase-only resolve');
  assert(withFbOnly.length === 126, 'Firebase-only addition increases count');
  assert(withFbOnly.filter((c) => c.id === 'card_custom_test').length === 1, 'no duplicate custom');

  const concept = BASE_CARD_DEFINITIONS.find((c) => c.type === 'concept');
  const cOver = applyCardOverride(concept, { flavorText: 'Override FT', conceptType: 'risk' });
  assert(cOver.flavorText === 'Override FT', 'concept flavorText override');
  assert(cOver.conceptType === 'risk', 'concept conceptType override');
}

// --- ALIASES / DIFF ---
{
  const base = BASE_CARD_DEFINITIONS.find((c) => c.name === 'Isaac Newton');
  const aliasDrift = {
    ...base,
    image: '',
    imageUrl: '',
    flavor: base.flavor,
    keyFact: base.keyFact,
  };
  // Representation swapped but same semantic
  const swapped = {
    ...base,
    image: base.imageUrl || base.image,
    imageUrl: '',
    flavor: '',
    keyFact: base.keyFact || base.flavor,
  };
  assert(effectiveCardImage(base) === effectiveCardImage(swapped), 'image semantic equal');
  assert(effectiveCardFlavor(base) === effectiveCardFlavor(swapped), 'flavor semantic equal');
  assert(Object.keys(buildCardOverride(base, swapped)).length === 0, 'alias-only → no override');
  assert(Object.keys(buildCardOverride(base, aliasDrift)).length === 0, 'unchanged → {}');

  const oneField = buildCardOverride(base, { ...base, name: 'Sir Isaac' });
  assert(oneField.name === 'Sir Isaac' && Object.keys(oneField).length === 1, 'one field override');

  const dis = buildCardOverride(base, { ...base, enabled: false });
  assert(dis.enabled === false, 'false preserved in override');

  const withEffect = BASE_CARD_DEFINITIONS.find((c) => c.effect && c.effect.length > 0);
  const clearFx = buildCardOverride(withEffect, { ...withEffect, effect: '' });
  assert(clearFx.effect === '', 'empty string effect override');

  const restored = buildCardOverride(base, { ...base });
  assert(Object.keys(restored).length === 0, 'restore to base → {}');

  const multi = buildCardOverride(base, { ...base, enabled: false, name: 'X' });
  assert(multi.enabled === false && multi.name === 'X', 'other override fields survive together');

  const imgChange = buildCardOverride(base, {
    ...base,
    imageUrl: 'https://example.com/n.png',
    image: 'https://example.com/n.png',
  });
  assert(imgChange.image === 'https://example.com/n.png' && imgChange.imageUrl === imgChange.image, 'semantic image writes both aliases');
}

// --- PACKS (enabled filter via resolved catalog) ---
{
  const sample = BASE_CARD_DEFINITIONS[0];
  const layer = {
    [sample.id]: { enabled: false },
    card_fb_disabled: {
      id: 'card_fb_disabled',
      name: 'FB Off',
      type: 'scientist',
      rarity: 'common',
      enabled: false,
    },
  };
  const resolved = resolveAllCards(BASE_CARD_DEFINITIONS, layer);
  const enabled = resolved.filter((c) => c.enabled !== false);
  assert(!enabled.some((c) => c.id === sample.id), 'bundled+disabled excluded');
  assert(enabled.every((c) => c.enabled !== false), 'enabled pool only');
  assert(!enabled.some((c) => c.id === 'card_fb_disabled'), 'Firebase-only disabled excluded');
  assert(enabled.some((c) => c.id !== sample.id), 'other enabled still included');
}

// --- TRADING / COSMETIC raw consumer source check ---
{
  for (const rel of [
    'js/trading.js',
    'js/trade-execution.js',
    'js/trade-listings.js',
    'js/trade-listing-execution.js',
    'js/cosmetic-preview.js',
  ]) {
    const src = readFileSync(join(root, rel), 'utf8');
    assert(!src.includes("db.get('cards')"), `${rel} no db.get('cards')`);
    assert(!src.includes('db.get("cards")'), `${rel} no db.get("cards")`);
    assert(!src.includes("getChildren('cards')"), `${rel} no getChildren('cards')`);
  }
  assert(
    readFileSync(join(root, 'js/cosmetic-preview.js'), 'utf8').includes('getEnabledCards'),
    'cosmetic-preview uses getEnabledCards',
  );
  assert(
    readFileSync(join(root, 'js/trading.js'), 'utf8').includes('getCardsMap'),
    'trading uses getCardsMap',
  );
  assert(
    readFileSync(join(root, 'js/packs.js'), 'utf8').includes('getEnabledCards'),
    'packs uses getEnabledCards',
  );
}

// --- BOOT gates ---
{
  const before = JSON.stringify(BASE_CARD_DEFINITIONS);
  seedDefaultCards();
  assert(JSON.stringify(BASE_CARD_DEFINITIONS) === before, 'seed does not mutate bundle');
  // seedDefaultCards returns early when BASE_CARD_COUNT > 0 — no createCard path
  const seedSrc = readFileSync(join(root, 'js/cards.js'), 'utf8');
  assert(seedSrc.includes('BASE_CARD_COUNT > 0'), 'seed gated on BASE_CARD_COUNT');
  normalizeConceptTypes();
  const normSrc = seedSrc.slice(seedSrc.indexOf('export function normalizeConceptTypes'));
  const normFn = normSrc.slice(0, normSrc.indexOf('export function seedDefaultCards'));
  assert(!normFn.includes('updateCard('), 'normalizeConceptTypes has no updateCard writeback');
  assert(isBundledBaseCard(BASE_CARD_DEFINITIONS[0].id) === true, 'isBundledBaseCard true');
  assert(isBundledBaseCard('card_not_real') === false, 'isBundledBaseCard false');
}

if (!process.exitCode) {
  console.log('\nAll Batch D2 resolve tests passed.');
} else {
  console.error('\nBatch D2 resolve tests failed.');
}
