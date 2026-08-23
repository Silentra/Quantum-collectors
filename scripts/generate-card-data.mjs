/**
 * One-shot generator: quantum-collectors-card-data.json → js/card-data.js
 * Run: node scripts/generate-card-data.mjs
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cards = JSON.parse(readFileSync(join(root, 'quantum-collectors-card-data.json'), 'utf8'));
if (!Array.isArray(cards) || cards.length !== 125) {
  throw new Error(`Expected 125 cards, got ${cards?.length}`);
}
cards.sort((a, b) => String(a.id).localeCompare(String(b.id)));
const body = JSON.stringify(cards, null, 2);
const out = `/**
 * Bundled base card catalog (Batch D2).
 * Generated from quantum-collectors-card-data.json (D1 authoritative Firebase export).
 * Runtime source of truth for base definitions — do NOT fetch the root JSON at runtime.
 * Firebase /cards is overrides + Firebase-only additions until D4 migration.
 */

export const BASE_CARD_COUNT = ${cards.length};

/** @type {ReadonlyArray<object>} */
export const BASE_CARD_DEFINITIONS = Object.freeze(
  ${body}.map((c) => Object.freeze({ ...c })),
);
`;
const dest = join(root, 'js', 'card-data.js');
writeFileSync(dest, out);
console.log('wrote', cards.length, 'cards to', dest, `(${statSync(dest).size} bytes)`);
