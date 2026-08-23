/**
 * Batch D1 — authoritative card catalog export (read-only).
 * Run: node scripts/batch-d1-card-catalog-export.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCardCatalogExport,
  gatherAuthoritativeCardsForExport,
} from '../js/cards.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('PASS:', msg);
  }
}

function sampleSnapshot() {
  return {
    card_zulu: {
      id: 'card_zulu',
      name: 'Zulu Concept',
      rarity: 'rare',
      type: 'concept',
      field: 'Algebra',
      effect: 'Boost research',
      imageUrl: 'https://example.com/z.png',
      keyFact: 'Z fact',
      enabled: true,
      conceptType: 'researchBoost',
      flavorText: 'Concept flavor text',
      created: 111,
      auraType: 'none',
    },
    card_alpha: {
      id: 'card_alpha',
      name: 'Ada Lovelace',
      rarity: 'legendary',
      type: 'scientist',
      field: 'Computing',
      effect: '',
      image: 'https://example.com/a.png',
      flavor: 'Poetical scientist',
      enabled: false,
      created: 222,
    },
  };
}

// --- complete map → deterministic sorted array + exact IDs ---
{
  const built = buildCardCatalogExport(sampleSnapshot());
  assert(built.ok === true, 'sample snapshot exports ok');
  assert(built.cards.length === 2, 'exported count 2');
  assert(built.cards[0].id === 'card_alpha' && built.cards[1].id === 'card_zulu', 'sorted by id');
  assert(built.diagnostics.firebaseChildCount === 2, 'firebase child count');
  assert(built.diagnostics.uniqueIdCount === 2, 'unique id count');
  assert(built.diagnostics.exportedCount === 2, 'exported count diagnostic');
}

// --- disabled included ---
{
  const built = buildCardCatalogExport(sampleSnapshot());
  const disabled = built.cards.find((c) => c.id === 'card_alpha');
  assert(disabled && disabled.enabled === false, 'disabled scientist included');
  assert(built.diagnostics.disabledCount === 1, 'disabled count');
}

// --- representative scientist retained ---
{
  const sci = buildCardCatalogExport(sampleSnapshot()).cards.find((c) => c.id === 'card_alpha');
  assert(sci.name === 'Ada Lovelace', 'scientist name');
  assert(sci.type === 'scientist', 'scientist type');
  assert(sci.rarity === 'legendary', 'scientist rarity');
  assert(sci.image === 'https://example.com/a.png', 'scientist image');
  assert(sci.imageUrl === 'https://example.com/a.png', 'scientist imageUrl alias');
  assert(sci.flavor === 'Poetical scientist', 'scientist flavor');
  assert(sci.keyFact === 'Poetical scientist', 'scientist keyFact alias');
  assert(!('conceptType' in sci), 'scientist has no conceptType');
  assert(!('flavorText' in sci), 'scientist has no flavorText');
  assert(!('created' in sci), 'created stripped');
  assert(!('auraType' in sci), 'auraType stripped');
}

// --- representative concept fields retained ---
{
  const concept = buildCardCatalogExport(sampleSnapshot()).cards.find((c) => c.id === 'card_zulu');
  assert(concept.conceptType === 'researchBoost', 'conceptType retained');
  assert(concept.flavorText === 'Concept flavor text', 'flavorText retained');
  assert(concept.effect === 'Boost research', 'effect retained');
  assert(concept.keyFact === 'Z fact', 'concept keyFact');
  assert(concept.flavor === 'Z fact', 'concept flavor alias from keyFact');
}

// --- malformed child ---
{
  const built = buildCardCatalogExport({
    good: { id: 'good', name: 'G', type: 'scientist', rarity: 'common' },
    bad: 'not-an-object',
  });
  assert(built.ok === false, 'malformed child fails closed');
  assert(built.diagnostics.malformedChildren.includes('bad'), 'malformed path recorded');
}

// --- path/id mismatch ---
{
  const built = buildCardCatalogExport({
    path_a: { id: 'path_b', name: 'Mismatch', type: 'scientist', rarity: 'common' },
  });
  assert(built.ok === false, 'path/id mismatch fails closed');
  assert(built.diagnostics.pathIdMismatches.length === 1, 'mismatch recorded');
}

// --- missing id on raw is OK (path becomes id) ---
{
  const built = buildCardCatalogExport({
    path_only: { name: 'No Id Field', type: 'scientist', rarity: 'common' },
  });
  assert(built.ok === true, 'missing raw.id ok');
  assert(built.cards[0].id === 'path_only', 'path id used');
}

// --- duplicate export id invariant (uniqueIdCount === exportedCount on success) ---
{
  const built = buildCardCatalogExport(sampleSnapshot());
  assert(
    built.diagnostics.uniqueIdCount === built.diagnostics.exportedCount,
    'unique/export id invariant',
  );
  const ids = built.cards.map((c) => c.id);
  assert(new Set(ids).size === ids.length, 'no duplicate ids in array');
}

// --- transient fields stripped ---
{
  const built = buildCardCatalogExport({
    t1: {
      id: 't1',
      name: 'T',
      type: 'scientist',
      rarity: 'common',
      created: 1,
      auraType: 'cosmic',
      power: 9,
      tags: ['x'],
      metadata: { a: 1 },
      schemaVersion: 2,
    },
  });
  assert(built.ok === true, 'strip-only extras ok');
  const c = built.cards[0];
  for (const k of ['created', 'auraType', 'power', 'tags', 'metadata', 'schemaVersion']) {
    assert(!(k in c), `${k} stripped`);
  }
}

// --- unexpected meaningful field → fail closed ---
{
  const built = buildCardCatalogExport({
    u1: {
      id: 'u1',
      name: 'U',
      type: 'scientist',
      rarity: 'common',
      secretMechanic: true,
    },
  });
  assert(built.ok === false, 'unexpected field fails closed');
  assert(
    built.diagnostics.unexpectedFields.some((x) => x.fields.includes('secretMechanic')),
    'unexpected field recorded',
  );
}

// --- JSON round-trip ---
{
  const built = buildCardCatalogExport(sampleSnapshot());
  const json = JSON.stringify(built.cards, null, 2);
  const parsed = JSON.parse(json);
  assert(Array.isArray(parsed) && parsed.length === 2, 'JSON round-trip array');
  assert(parsed[0].id === 'card_alpha', 'JSON round-trip first id');
}

// --- helper does not mutate input snapshot ---
{
  const snap = sampleSnapshot();
  const before = JSON.stringify(snap);
  buildCardCatalogExport(snap);
  assert(JSON.stringify(snap) === before, 'snapshot not mutated');
}

// --- null / empty catalog ---
{
  assert(buildCardCatalogExport(null).ok === true, 'null → empty ok');
  assert(buildCardCatalogExport(null).cards.length === 0, 'null → []');
  assert(buildCardCatalogExport({}).ok === true, 'empty map ok');
}

// --- gatherAuthoritativeCardsForExport fail-closed / empty ---
{
  const denied = await gatherAuthoritativeCardsForExport({
    loadPathOnce: async () => ({ ok: false, error: 'PERMISSION_DENIED', mode: 'error' }),
  });
  assert(denied.ok === false && denied.error === 'PERMISSION_DENIED', 'permission denied aborts');

  const local = await gatherAuthoritativeCardsForExport({
    loadPathOnce: async () => ({ ok: true, mode: 'local', value: { a: 1 } }),
  });
  assert(local.ok === false && local.error === 'CARDS_LOAD_NOT_FIREBASE', 'local-only aborts');

  const empty = await gatherAuthoritativeCardsForExport({
    loadPathOnce: async () => ({ ok: true, mode: 'firebase', value: null }),
  });
  assert(empty.ok === true && Object.keys(empty.snapshot).length === 0, 'firebase null → empty snapshot');

  let calledWith;
  await gatherAuthoritativeCardsForExport({
    loadPathOnce: async (path, opts) => {
      calledWith = { path, opts };
      return { ok: true, mode: 'firebase', value: {} };
    },
  });
  assert(calledWith.path === 'cards' && calledWith.opts?.force === true, 'force:true once-load');
}

// --- source invariant: export workflow helpers do not call write APIs ---
{
  const cardsSrc = readFileSync(join(root, 'js', 'cards.js'), 'utf8');
  const start = cardsSrc.indexOf('// Batch D1 — authoritative card catalog export');
  const end = cardsSrc.indexOf('/**\n * Get cards by rarity');
  assert(start >= 0 && end > start, 'D1 block located in cards.js');
  const block = cardsSrc.slice(start, end);
  for (const bad of [
    'db.set(',
    'db.update(',
    'db.remove(',
    'db.push(',
    'createCard(',
    'updateCard(',
    'seedDefaultCards(',
    'setAcknowledged(',
    'updateAcknowledged(',
  ]) {
    assert(!block.includes(bad), `D1 cards.js block has no ${bad}`);
  }

  const uiSrc = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
  const uiStart = uiSrc.indexOf('async function handleAdminCardCatalogExport');
  const uiEnd = uiSrc.indexOf('function renderAdminCards');
  assert(uiStart >= 0 && uiEnd > uiStart, 'D1 handler located in ui.js');
  const uiBlock = uiSrc.slice(uiStart, uiEnd);
  for (const bad of ['db.set(', 'db.update(', 'db.remove(', 'createCard(', 'updateCard(', 'seedDefaultCards(']) {
    assert(!uiBlock.includes(bad), `D1 ui handler has no ${bad}`);
  }
}

if (!process.exitCode) {
  console.log('\nAll Batch D1 export tests passed.');
} else {
  console.error('\nBatch D1 export tests failed.');
}
