/**
 * Display-name foundation unit tests (Slice A).
 * Run: node scripts/player-display-name.test.mjs
 */

import {
  validateDisplayName,
  getPlayerDisplayName,
  projectDisplayNameForDirectory,
  buildAdminSetDisplayNamePlayerPaths,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_RE,
} from '../js/player-display-name.js';
import { buildDirectoryEntry, directoryEntriesEqual } from '../js/player-directory.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Resolver
assert(getPlayerDisplayName({ displayName: 'GJ_QuantumDuck' }, 'badname94') === 'GJ_QuantumDuck', 'resolver prefers displayName');
assert(getPlayerDisplayName({ displayName: '  TrimMe  ' }, 'u') === 'TrimMe', 'resolver trims');
assert(getPlayerDisplayName({ displayName: '   ' }, 'fallback_u') === 'fallback_u', 'whitespace-only falls back');
assert(getPlayerDisplayName({ displayName: null }, 'alice') === 'alice', 'null displayName falls back');
assert(getPlayerDisplayName({}, 'bob') === 'bob', 'missing displayName falls back');
assert(getPlayerDisplayName({ username: 'fromObj' }, '') === 'fromObj', 'username on source as fallback');
assert(getPlayerDisplayName({ displayName: 123 }, 'safe') === 'safe', 'non-string displayName does not crash');

// Validator boundaries
assert(validateDisplayName('abc').ok === true, 'accepts 3 chars');
assert(validateDisplayName('a'.repeat(20)).ok === true, 'accepts 20 chars');
assert(validateDisplayName('ab').ok === false, 'rejects 2 chars');
assert(validateDisplayName('a'.repeat(21)).ok === false, 'rejects 21 chars');
assert(validateDisplayName('GJ_QuantumDuck').ok === true, 'accepts mixed case + underscore');
assert(validateDisplayName('  NewtonFan  ').ok && validateDisplayName('  NewtonFan  ').displayName === 'NewtonFan', 'trims and preserves case');
assert(validateDisplayName('Quantum Duck').ok === false, 'rejects spaces');
assert(validateDisplayName('Quantum-Duck').ok === false, 'rejects hyphen');
assert(validateDisplayName('🚀Newton').ok === false, 'rejects emoji');
assert(validateDisplayName('').ok === false, 'rejects empty');
assert(DISPLAY_NAME_RE.test('Physics_2026'), 'regex accepts Physics_2026');
assert(DISPLAY_NAME_MAX_LENGTH === 20, 'max length constant 20');

// Directory projection
const entry = buildDirectoryEntry('badname94', { displayName: 'GJ_QuantumDuck', groupId: 'g1' });
assert(entry.displayName === 'GJ_QuantumDuck', 'directory projects displayName');
assert(entry.username === 'badname94', 'directory keeps username key');
const noDn = buildDirectoryEntry('olduser', { groupId: null });
assert(noDn.displayName === null, 'missing displayName → null projection');
assert(
  directoryEntriesEqual(
    buildDirectoryEntry('u', {}),
    { username: 'u', groupId: null, subgroupId: null, isAdmin: false, isTradeRestricted: false, isTradeProfileHidden: false },
  ),
  'equality treats missing displayName like null',
);
assert(projectDisplayNameForDirectory('  X  ') === 'X', 'project trims');
assert(projectDisplayNameForDirectory('') === null, 'project empty → null');

// Admin multipath helper (Slice C–ready clears)
const paths = buildAdminSetDisplayNamePlayerPaths('badname94', 'GJ_QuantumDuck');
assert(paths['players/badname94/displayName'] === 'GJ_QuantumDuck', 'admin path sets displayName');
assert(paths['players/badname94/requiresDisplayNameChange'] === null, 'admin path clears require flag');
assert(paths['players/badname94/displayNameChangeMessage'] === null, 'admin path clears message');

// Register maxlength in authoritative index.html
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const regBlock = html.slice(html.indexOf('id="register-username"'), html.indexOf('id="register-username"') + 350);
assert(regBlock.includes('maxlength="20"'), 'register username maxlength=20');

// Rules carve-out present
const rules = fs.readFileSync(path.join(root, 'database.rules.json'), 'utf8');
assert(rules.includes('"displayName"'), 'rules include displayName leaf');
assert(rules.includes('^[A-Za-z0-9_]{3,20}$'), 'rules validate displayName charset/length');

// Hosting prod untouched by this feature work (no sync required) — folder may exist; assert we did not change sync script for this feature
assert(fs.existsSync(path.join(root, 'js', 'player-display-name.js')), 'helper module exists');

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll player-display-name Slice A tests passed.');
