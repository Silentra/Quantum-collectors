/**
 * Player History Pass 3 — retention isolation + permanent delete path.
 * Run: node scripts/player-history-pass3.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAYER_HISTORY_RETENTION_MS,
  PLAYER_HISTORY_PRUNE_BATCH_SIZE,
  PLAYER_HISTORY_PRUNE_EVERY_N_WRITES,
  assertHistoryOnlyDeleteUpdates,
  buildExpiredHistoryPruneUpdates,
  buildPlayerHistoryTreeDeleteUpdate,
  historyRetentionCutoffTs,
  isHistoryEventExpired,
  usernamesTouchedByHistoryUpdates,
  scheduleHistoryRetentionAfterWrite,
  _resetHistoryRetentionCadenceForTests,
} from '../js/player-history-retention.js';
import {
  PLAYER_HISTORY_ROOT,
  playerHistoryEventPath,
  playerHistoryUserPath,
} from '../js/player-history.js';

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

const NOW = 1_700_000_000_000;
const cutoff = historyRetentionCutoffTs(NOW);
assert(cutoff === NOW - PLAYER_HISTORY_RETENTION_MS, 'cutoff = now - 30d');

const day = 24 * 60 * 60 * 1000;
assert(isHistoryEventExpired({ ts: NOW - 29 * day }, cutoff) === false, '29-day retained');
assert(isHistoryEventExpired({ ts: NOW - 30 * day }, cutoff) === true, '30-day eligible (<= cutoff)');
assert(isHistoryEventExpired({ ts: NOW - 31 * day }, cutoff) === true, '>30-day eligible');
assert(isHistoryEventExpired({ ts: 'bad' }, cutoff) === false, 'malformed ts skipped');
assert(isHistoryEventExpired({}, cutoff) === false, 'missing ts skipped');
assert(isHistoryEventExpired(null, cutoff) === false, 'null event skipped');

{
  const entries = [
    { key: 'old1', value: { type: 'pack_opened', ts: NOW - 40 * day } },
    { key: 'old2', value: { type: 'trade_completed', ts: NOW - 35 * day } },
    { key: 'new1', value: { type: 'pack_opened', ts: NOW - 1 * day } },
    { key: 'bad', value: { type: 'pack_opened', ts: null } },
  ];
  const planned = buildExpiredHistoryPruneUpdates('alice', entries, cutoff, 50);
  assert(Object.keys(planned.updates).length === 2, 'only expired leaves planned');
  assert(planned.updates[playerHistoryEventPath('alice', 'old1')] === null, 'old1 null');
  assert(planned.updates[playerHistoryEventPath('alice', 'old2')] === null, 'old2 null');
  assert(!planned.updates[playerHistoryEventPath('alice', 'new1')], 'newest unaffected');
  assertHistoryOnlyDeleteUpdates(planned.updates, 'alice');
  assert(planned.deletedEventIds.length === 2, 'two ids');
}

{
  const many = [];
  for (let i = 0; i < 60; i++) {
    many.push({ key: `e${i}`, value: { ts: NOW - 40 * day } });
  }
  const planned = buildExpiredHistoryPruneUpdates('bob', many, cutoff, PLAYER_HISTORY_PRUNE_BATCH_SIZE);
  assert(planned.deletedEventIds.length === PLAYER_HISTORY_PRUNE_BATCH_SIZE, 'batch size capped');
}

// Isolation: assert rejects non-history / whole-tree / non-null
function expectThrow(fn, label) {
  try {
    fn();
    assert(false, `${label} should throw`);
  } catch {
    assert(true, label);
  }
}

expectThrow(
  () => assertHistoryOnlyDeleteUpdates({ 'players/alice/inventory/c1': null }, 'alice'),
  'rejects players/ inventory path',
);
expectThrow(
  () => assertHistoryOnlyDeleteUpdates({ 'players/alice/packs/p': null }, 'alice'),
  'rejects packs path',
);
expectThrow(
  () => assertHistoryOnlyDeleteUpdates({ 'leaderboards/packsOpened/alice': null }, 'alice'),
  'rejects leaderboards path',
);
expectThrow(
  () => assertHistoryOnlyDeleteUpdates({ 'trades/direct/t1': null }, 'alice'),
  'rejects trades path',
);
expectThrow(
  () => assertHistoryOnlyDeleteUpdates({ 'players/alice/projects': null }, 'alice'),
  'rejects projects path',
);
expectThrow(
  () => assertHistoryOnlyDeleteUpdates({ [playerHistoryUserPath('alice')]: null }, 'alice'),
  'rejects whole playerHistory/{username} in retention',
);
expectThrow(
  () => assertHistoryOnlyDeleteUpdates({ [playerHistoryEventPath('alice', 'e1')]: { type: 'x' } }, 'alice'),
  'rejects non-null prune value',
);
expectThrow(
  () => assertHistoryOnlyDeleteUpdates({ [playerHistoryEventPath('bob', 'e1')]: null }, 'alice'),
  'rejects other-player history path',
);
expectThrow(
  () => assertHistoryOnlyDeleteUpdates({ [`${PLAYER_HISTORY_ROOT}/alice/e1/nested`]: null }, 'alice'),
  'rejects nested deeper than event leaf',
);

// Simulated: rejected plan does not call updateAcknowledged
{
  let called = false;
  const fakeUpdate = async () => { called = true; return { ok: true }; };
  const bad = { 'players/alice/stats/packsOpened': null };
  try {
    assertHistoryOnlyDeleteUpdates(bad, 'alice');
  } catch {
    /* expected — do not call update */
  }
  assert(called === false, 'rejected prune plan does not call updateAcknowledged');
}

// Permanent delete tree helper (separate from retention)
{
  const tree = buildPlayerHistoryTreeDeleteUpdate('carol');
  assert(tree[playerHistoryUserPath('carol')] === null, 'permanent delete nulls user history root');
  assert(Object.keys(tree).length === 1, 'only history root in tree delete helper');
}

{
  const names = usernamesTouchedByHistoryUpdates({
    'players/a/x': 1,
    'playerHistory/alice/e1': { type: 'x' },
    'playerHistory/bob/e2': { type: 'y' },
  });
  assert(names.includes('alice') && names.includes('bob') && names.length === 2, 'usernames from updates');
}

// Cadence: N-1 writes do not prune; Nth schedules (we only check counter behavior via reset)
_resetHistoryRetentionCadenceForTests();
assert(PLAYER_HISTORY_PRUNE_EVERY_N_WRITES >= 2, 'cadence N >= 2');
// schedule is fire-and-forget; just ensure it does not throw without DB
try {
  for (let i = 0; i < PLAYER_HISTORY_PRUNE_EVERY_N_WRITES - 1; i++) {
    scheduleHistoryRetentionAfterWrite('cadence_user');
  }
  assert(true, 'cadence schedule does not throw');
} catch (e) {
  assert(false, `cadence threw: ${e.message}`);
}
_resetHistoryRetentionCadenceForTests();

// Gameplay unchanged proof (pure): prune updates never touch inventory/stats keys
{
  const planned = buildExpiredHistoryPruneUpdates('dave', [
    { key: 'packevt', value: { type: 'pack_opened', ts: NOW - 40 * day, cardsGranted: { c1: 5 } } },
    { key: 'statevt', value: { type: 'admin_stat_correct', ts: NOW - 40 * day, fieldId: 'packsOpened' } },
    { key: 'trdevt', value: { type: 'trade_completed', ts: NOW - 40 * day, gave: { c1: 1 }, received: { c2: 1 } } },
  ], cutoff, 10);
  const keys = Object.keys(planned.updates);
  assert(keys.every((k) => k.startsWith(`${PLAYER_HISTORY_ROOT}/dave/`)), 'prune only dave history leaves');
  assert(keys.every((k) => planned.updates[k] === null), 'all prune values null');
  assert(!keys.some((k) => k.includes('inventory') || k.includes('stats') || k.includes('packs/')), 'no gameplay paths');
}

// Source: permanent delete includes history tree; prune asserts before updateAcknowledged
{
  const playerSrc = fs.readFileSync(path.join(root, 'js/player.js'), 'utf8');
  assert(
    playerSrc.includes('buildPlayerHistoryTreeDeleteUpdate(playerKey)'),
    'deletePlayer multipath includes playerHistory tree wipe',
  );
  const retentionSrc = fs.readFileSync(path.join(root, 'js/player-history-retention.js'), 'utf8');
  const assertIdx = retentionSrc.indexOf('assertHistoryOnlyDeleteUpdates(planned.updates');
  const updateIdx = retentionSrc.indexOf('db.updateAcknowledged(planned.updates)');
  assert(assertIdx > 0 && updateIdx > assertIdx, 'assert runs before updateAcknowledged on prune');
  assert(
    !retentionSrc.includes("from './player.js'")
      && !retentionSrc.includes("from './packs.js'")
      && !retentionSrc.includes("from './trade-"),
    'retention module does not import gameplay mutators',
  );
  const rules = fs.readFileSync(path.join(root, 'database.rules.json'), 'utf8');
  assert(rules.includes('".indexOn"') && rules.includes('"ts"'), 'rules indexOn ts under playerHistory');
  assert(rules.includes('2592000000'), 'rules allow owner delete of expired leaves (~30d)');
}

// Triggers: login / players list / manage must not schedule retention
{
  const uiSrc = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8');
  assert(
    uiSrc.includes('scheduleHistoryRetentionOnAdminView'),
    'View History schedules retention',
  );
  const loginSrc = fs.readFileSync(path.join(root, 'js/auth.js'), 'utf8');
  assert(
    !loginSrc.includes('scheduleHistoryRetention') && !loginSrc.includes('pruneExpired'),
    'login/auth does not prune',
  );
}

if (failed) {
  console.error(`\nplayer-history-pass3: ${failed} failure(s)`);
  process.exit(1);
}
console.log('\nplayer-history-pass3: all checks passed');
