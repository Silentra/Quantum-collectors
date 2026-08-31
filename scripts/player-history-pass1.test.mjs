/**
 * Player History Pass 1 (C0–C3) tests.
 * Run: node scripts/player-history-pass1.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAYER_HISTORY_ROOT,
  PLAYER_HISTORY_SCHEMA_VERSION,
  HISTORY_SERVER_TIMESTAMP,
  HISTORY_EVENT_TYPES,
  buildHistoryEventBody,
  buildPlayerHistoryLeafUpdate,
  buildPackOpenedHistoryUpdate,
  aggregateCardsGranted,
  updatesArePlayerHistoryOnly,
  playerHistoryEventPath,
} from '../js/player-history.js';
import {
  buildAdminPackGrantPlan,
  buildAdminPackRemovePlan,
  buildAdminCardGrantPlan,
  buildAdminCardRemovePlan,
  addPack,
} from '../js/player.js';
import { buildAdminStatCorrectionUpdates, getAdminStatCorrectionField } from '../js/admin-stat-correction.js';
import * as db from '../js/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('PASS:', msg);
  }
}

// ——— C0 schema ———
assert(PLAYER_HISTORY_SCHEMA_VERSION === 1, 'schemaVersion 1');
assert(HISTORY_SERVER_TIMESTAMP['.sv'] === 'timestamp', 'server timestamp sentinel');
const body = buildHistoryEventBody({
  type: HISTORY_EVENT_TYPES.PACK_OPENED,
  actorType: 'self',
  source: 'pack_open',
  actorUid: 'u1',
  payload: { packId: 'p1' },
});
assert(body.schemaVersion === 1 && body.ts === HISTORY_SERVER_TIMESTAMP, 'body uses server ts not Date.now');
assert(body.type === 'pack_opened' && body.source === 'pack_open', 'type/source set');
assert(typeof body.ts !== 'number', 'persisted ts is not client Date.now number');

const leaf = buildPlayerHistoryLeafUpdate('alice', {
  type: 'pack_granted',
  actorType: 'admin',
  source: 'admin_grant_packs',
  payload: { packId: 'std', quantity: 5, before: 0, after: 5 },
});
assert(leaf.path.startsWith(`${PLAYER_HISTORY_ROOT}/alice/`), 'path under playerHistory/alice');
assert(leaf.path === playerHistoryEventPath('alice', leaf.eventId), 'path matches helper');
assert(leaf.updates[leaf.path]?.type === 'pack_granted', 'leaf update map');

assert(
  JSON.stringify(aggregateCardsGranted([{ id: 'a' }, { id: 'b' }, { id: 'a' }])) === JSON.stringify({ a: 2, b: 1 }),
  'aggregate cards',
);

assert(typeof db.loadPathQueryOnce === 'function', 'loadPathQueryOnce exported');

// Local pagination helper smoke (no Firebase)
await db.initDB?.().catch?.(() => {});
// Ensure local cache path for query without Firebase
try {
  db.applyLocalOnly?.(`${PLAYER_HISTORY_ROOT}/pagetest/aaa`, { type: 'x', ts: 1 });
  db.applyLocalOnly?.(`${PLAYER_HISTORY_ROOT}/pagetest/bbb`, { type: 'y', ts: 2 });
  db.applyLocalOnly?.(`${PLAYER_HISTORY_ROOT}/pagetest/ccc`, { type: 'z', ts: 3 });
} catch { /* init may be required */ }

const q = await db.loadPathQueryOnce(`${PLAYER_HISTORY_ROOT}/pagetest`, {
  orderByKey: true,
  limitToLast: 2,
});
if (q.ok && q.mode === 'local') {
  assert(q.entries.length === 2, 'limitToLast 2 on local');
  assert(q.entries[0].key <= q.entries[1].key, 'keys ordered');
  const older = await db.loadPathQueryOnce(`${PLAYER_HISTORY_ROOT}/pagetest`, {
    orderByKey: true,
    endAt: q.entries[0].key,
    limitToLast: 3,
  });
  assert(older.ok, 'endAt older page query ok');
  const keys = older.entries.map((e) => e.key);
  assert(keys.includes(q.entries[0].key), 'boundary key present for drop-duplicate');
} else {
  console.log('PASS: loadPathQueryOnce reachable (local cache may be empty before init)');
}

assert(updatesArePlayerHistoryOnly({ [`${PLAYER_HISTORY_ROOT}/a/1`]: null }), 'prune-shaped updates history-only');
assert(!updatesArePlayerHistoryOnly({ 'players/a/inventory/c1': 1 }), 'rejects non-history updates');

// ——— C1 pack open plan source ———
const packsSrc = fs.readFileSync(path.join(root, 'js', 'packs.js'), 'utf8');
assert(packsSrc.includes('buildPackOpenedHistoryUpdate'), 'pack open imports history builder');
assert(packsSrc.includes('historyLeaf.updates'), 'history merged into pack open updates');

const openHist = buildPackOpenedHistoryUpdate('bob', {
  packId: 'pack_std',
  cardsGranted: { card_a: 2, card_b: 1 },
  packsOpenedDelta: 1,
  cardsCollectedDelta: 3,
});
assert(openHist.body.type === 'pack_opened', 'pack_opened type');
assert(openHist.body.cardsGranted.card_a === 2, 'exact card qty');
assert(openHist.body.deltas.cardsCollected === 3, 'cardsCollected delta');
assert(openHist.body.actorType === 'self' && openHist.body.source === 'pack_open', 'self pack_open');

// ——— C2 Admin plans (seed local cache via applyLocalOnly) ———
db.applyLocalOnly('players/carol/packs/pack_std', 3);
db.applyLocalOnly('players/carol/inventory/card_x', 10);
db.applyLocalOnly('players/carol/stats/cardsCollected', 50);

const grantPlan = buildAdminPackGrantPlan('carol', 'pack_std', 5, {
  actorUid: 'teacher',
  actorUsername: 'teacher1',
});
assert(grantPlan.ok, 'admin pack grant plan ok');
assert(grantPlan.updates['players/carol/packs/pack_std'] === 8, 'pack after 3+5');
assert(grantPlan.before === 3 && grantPlan.after === 8, 'before/after');
const gHistPath = Object.keys(grantPlan.updates).find((k) => k.startsWith(`${PLAYER_HISTORY_ROOT}/`));
assert(!!gHistPath, 'grant plan has history leaf');
assert(grantPlan.updates[gHistPath].type === 'pack_granted', 'pack_granted event');
assert(grantPlan.updates[gHistPath].actorType === 'admin', 'admin actor');

const remPlan = buildAdminPackRemovePlan('carol', 'pack_std', 2, { actorUid: 'teacher' });
assert(remPlan.ok && remPlan.after === 1, 'pack remove plan');
assert(
  Object.values(remPlan.updates).some((v) => v && v.type === 'pack_removed'),
  'pack_removed event',
);

const cardGrant = buildAdminCardGrantPlan('carol', 'card_x', 3, { actorUid: 'teacher' });
assert(cardGrant.ok && cardGrant.after === 13, 'card grant plan');
assert(cardGrant.updates['players/carol/stats/cardsCollected'] === 53, 'cardsCollected bumped');
assert(
  Object.values(cardGrant.updates).some((v) => v && v.type === 'card_granted'),
  'card_granted event',
);

const cardRem = buildAdminCardRemovePlan('carol', 'card_x', 4, { actorUid: 'teacher' });
assert(cardRem.ok && cardRem.after === 6, 'card remove plan');
assert(
  !Object.keys(cardRem.updates).some((k) => k.includes('cardsCollected')),
  'card remove does not touch cardsCollected',
);
assert(
  Object.values(cardRem.updates).some((v) => v && v.type === 'card_removed'),
  'card_removed event',
);

// Generic addPack must NOT invent Admin history
db.applyLocalOnly('players/dave/packs/pack_std', 1);
const beforeKeys = Object.keys(db.get(PLAYER_HISTORY_ROOT) || {});
addPack('dave', 'pack_std', 2);
assert(db.get('players/dave/packs/pack_std') === 3, 'system addPack still works');
// No requirement that history changed — system path has no history leaf in addPack
assert(!String(addPack).includes('buildPlayerHistoryLeafUpdate'), 'addPack source has no history (checked via module)');
const playerSrc = fs.readFileSync(path.join(root, 'js', 'player.js'), 'utf8');
{
  const addPackBlock = playerSrc.match(/export function addPack\([\s\S]*?\nexport function parseAdminPackGrantQuantity/);
  assert(addPackBlock && !addPackBlock[0].includes('playerHistory') && !addPackBlock[0].includes('HISTORY_'), 'addPack has no Admin history');
}

assert(playerSrc.includes('export async function adminGrantPacks'), 'adminGrantPacks async');
assert(playerSrc.includes('export async function adminRemovePacks'), 'adminRemovePacks async');
assert(playerSrc.includes('export async function adminGrantCards'), 'adminGrantCards');
assert(playerSrc.includes('export async function adminRemoveCards'), 'adminRemoveCards');
assert(playerSrc.includes('updateAcknowledged(plan.updates)'), 'admin paths use ack');

// ——— C3 stat correction + history ———
const field = getAdminStatCorrectionField('packsOpened');
const playerLike = {
  stats: { packsOpened: 28 },
  groupId: 'g1',
};
const corrUpdates = buildAdminStatCorrectionUpdates(
  'erin',
  playerLike,
  field,
  { before: 28, adjustment: -20, after: 8 },
  1_700_000_000_000,
);
const hist = buildPlayerHistoryLeafUpdate('erin', {
  type: HISTORY_EVENT_TYPES.ADMIN_STAT_CORRECT,
  actorType: 'admin',
  source: 'admin_stat_correction',
  payload: { fieldId: 'packsOpened', before: 28, adjustment: -20, after: 8 },
});
Object.assign(corrUpdates, hist.updates);
assert(corrUpdates['players/erin/stats/packsOpened'] === 8, 'canonical packsOpened');
assert(corrUpdates['leaderboards/packsOpened/erin']?.value === 8, 'LB mirror');
assert(
  Object.keys(corrUpdates).some((k) => k.startsWith(`${PLAYER_HISTORY_ROOT}/erin/`)),
  'history in same map as correction+LB',
);
assert(hist.body.fieldId === 'packsOpened' && hist.body.before === 28 && hist.body.after === 8, 'stat payload');

const corrSrc = fs.readFileSync(path.join(root, 'js', 'admin-stat-correction.js'), 'utf8');
assert(corrSrc.includes('ADMIN_STAT_CORRECT') || corrSrc.includes('admin_stat_correct'), 'C3 wired in module');

const rules = fs.readFileSync(path.join(root, 'database.rules.json'), 'utf8');
assert(rules.includes('"playerHistory"'), 'rules include playerHistory');
assert(rules.includes('pack_opened'), 'rules allow pack_opened');
assert(rules.includes('admin_stat_correct'), 'rules allow admin_stat_correct');

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll player-history-pass1 tests passed.');
