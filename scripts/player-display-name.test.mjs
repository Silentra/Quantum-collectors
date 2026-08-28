/**
 * Display-name foundation unit tests (Slice A + Slice C + Slice B presentation helpers).
 * Run: node scripts/player-display-name.test.mjs
 */

import {
  validateDisplayName,
  validateDisplayNameChangeMessage,
  getPlayerDisplayName,
  getDirectoryDisplayName,
  getDisplayNameChangeMessage,
  playerRequiresDisplayNameChange,
  projectDisplayNameForDirectory,
  buildAdminSetDisplayNamePlayerPaths,
  buildAdminRequireDisplayNameChangePaths,
  buildStudentAuthorizedDisplayNameChangePaths,
  buildTradePartnerPickerLabels,
  formatAdminIdentityLabel,
  compareDirectoryPlayersByDisplayName,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_CHANGE_MESSAGE_MAX_LENGTH,
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
assert(getPlayerDisplayName(null, 'orphan') === 'orphan', 'null source → username');
assert(getPlayerDisplayName(undefined, 'orphan2') === 'orphan2', 'undefined source → username');

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

// Slice C — teacher message
assert(DISPLAY_NAME_CHANGE_MESSAGE_MAX_LENGTH === 200, 'teacher message max 200');
assert(validateDisplayNameChangeMessage('').ok && validateDisplayNameChangeMessage('').message === null, 'blank message → null');
assert(validateDisplayNameChangeMessage('  Use initials  ').message === 'Use initials', 'message trims');
assert(validateDisplayNameChangeMessage('x'.repeat(200)).ok === true, 'message accepts 200');
assert(validateDisplayNameChangeMessage('x'.repeat(201)).ok === false, 'message rejects 201');

// Slice C — require flag helpers
assert(playerRequiresDisplayNameChange({ requiresDisplayNameChange: true }) === true, 'require true');
assert(playerRequiresDisplayNameChange({ requiresDisplayNameChange: false }) === false, 'require false');
assert(playerRequiresDisplayNameChange({}) === false, 'require absent');
assert(getDisplayNameChangeMessage({ displayNameChangeMessage: ' Hi ' }) === 'Hi', 'get message trims');
assert(getDisplayNameChangeMessage({ displayNameChangeMessage: '   ' }) === null, 'whitespace message → null');
assert(getDisplayNameChangeMessage({}) === null, 'missing message → null');

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

// Slice B — directory resolver (cache-shaped; no network)
assert(getDirectoryDisplayName({ displayName: 'BJ_Quantum' }, 'bobby') === 'BJ_Quantum', 'directory helper uses displayName');
assert(getDirectoryDisplayName({}, 'bobby') === 'bobby', 'directory missing displayName → username');
assert(getDirectoryDisplayName(null, 'bobby') === 'bobby', 'missing directory entry → username');
assert(getDirectoryDisplayName({ displayName: '   ' }, 'bobby') === 'bobby', 'blank directory displayName → username');

// Admin Players sort by resolved display name
const noDnSorted = [
  { key: 'charlie', value: {} },
  { key: 'alpha', value: {} },
  { key: 'bravo', value: {} },
].sort(compareDirectoryPlayersByDisplayName);
assert(
  noDnSorted.map((p) => p.key).join(',') === 'alpha,bravo,charlie',
  'no displayNames → sort by username fallback',
);

const withDnSorted = [
  { key: 'alpha', value: { displayName: 'Zebra' } },
  { key: 'bravo', value: { displayName: 'Apple' } },
  { key: 'charlie', value: { displayName: 'Mango' } },
].sort(compareDirectoryPlayersByDisplayName);
assert(
  withDnSorted.map((p) => getPlayerDisplayName(p.value, p.key)).join(',') === 'Apple,Mango,Zebra',
  'displayNames → Apple, Mango, Zebra',
);
assert(
  withDnSorted.map((p) => p.key).join(',') === 'bravo,charlie,alpha',
  'keys remain stable usernames after display sort',
);

const mixedSorted = [
  { key: 'zebra_login', value: {} },
  { key: 'mid', value: { displayName: 'Banana' } },
  { key: 'aaa', value: { displayName: '  ' } },
].sort(compareDirectoryPlayersByDisplayName);
assert(
  mixedSorted.map((p) => getPlayerDisplayName(p.value, p.key)).join(',') === 'aaa,Banana,zebra_login',
  'mixed legacy/display resolve labels for sort',
);

const caseSorted = [
  { key: 'u2', value: { displayName: 'mango' } },
  { key: 'u1', value: { displayName: 'Apple' } },
  { key: 'u3', value: { displayName: 'MANGO' } },
].sort(compareDirectoryPlayersByDisplayName);
assert(
  caseSorted[0].key === 'u1'
    && caseSorted.slice(1).map((p) => p.key).join(',') === 'u2,u3',
  'case-insensitive primary; duplicate MANGO/mango tiebreak by username',
);

const dupSorted = [
  { key: 'sam', value: { displayName: 'NewtonFan' } },
  { key: 'bobby', value: { displayName: 'NewtonFan' } },
].sort(compareDirectoryPlayersByDisplayName);
assert(
  dupSorted.map((p) => p.key).join(',') === 'bobby,sam',
  'duplicate displayNames tiebreak by login username',
);

// Slice B — trade picker labels (value stays username; dups disambiguate)
const uniquePeers = buildTradePartnerPickerLabels([
  { key: 'bobby', value: { displayName: 'BJ_Quantum' } },
  { key: 'sam', value: { displayName: 'SamStar' } },
]);
assert(uniquePeers.length === 2, 'picker labels length');
assert(uniquePeers[0].username === 'bobby' && uniquePeers[0].label === 'BJ_Quantum', 'unique label clean');
assert(uniquePeers[1].username === 'sam' && uniquePeers[1].label === 'SamStar', 'unique second clean');

const dupPeers = buildTradePartnerPickerLabels([
  { key: 'bobby', value: { displayName: 'NewtonFan' } },
  { key: 'sam', value: { displayName: 'NewtonFan' } },
  { key: 'alex', value: { displayName: 'AlexOnly' } },
]);
assert(dupPeers.find((p) => p.username === 'bobby')?.label === 'NewtonFan (bobby)', 'dup gets login suffix');
assert(dupPeers.find((p) => p.username === 'sam')?.label === 'NewtonFan (sam)', 'dup peer distinct suffix');
assert(dupPeers.find((p) => p.username === 'alex')?.label === 'AlexOnly', 'non-dup stays clean');
assert(new Set(dupPeers.map((p) => p.username)).size === 3, 'option values remain distinct usernames');

const noDnPeers = buildTradePartnerPickerLabels([
  { key: 'legacy1', value: {} },
  { key: 'legacy2', value: null },
]);
assert(noDnPeers[0].label === 'legacy1' && noDnPeers[0].username === 'legacy1', 'no displayName → username label=value');
assert(noDnPeers[1].label === 'legacy2', 'null directory → username');

// Slice B — admin identity label
assert(
  formatAdminIdentityLabel({ displayName: 'BJ_Quantum' }, 'bobby') === '"BJ_Quantum" (login: bobby)',
  'admin identity shows display + login',
);
assert(
  formatAdminIdentityLabel({}, 'bobby') === '"bobby" (login: bobby)',
  'admin identity fallback still shows login clarification',
);

// Admin multipath helper (Slice C–ready clears)
const paths = buildAdminSetDisplayNamePlayerPaths('badname94', 'GJ_QuantumDuck');
assert(paths['players/badname94/displayName'] === 'GJ_QuantumDuck', 'admin path sets displayName');
assert(paths['players/badname94/requiresDisplayNameChange'] === null, 'admin path clears require flag');
assert(paths['players/badname94/displayNameChangeMessage'] === null, 'admin path clears message');

const requirePaths = buildAdminRequireDisplayNameChangePaths('bobby', 'Use initials');
assert(requirePaths['players/bobby/requiresDisplayNameChange'] === true, 'require path sets flag');
assert(requirePaths['players/bobby/displayNameChangeMessage'] === 'Use initials', 'require path sets message');
assert(!Object.prototype.hasOwnProperty.call(requirePaths, 'players/bobby/displayName'), 'require does not touch displayName');

const requireBlank = buildAdminRequireDisplayNameChangePaths('bobby', null);
assert(requireBlank['players/bobby/displayNameChangeMessage'] === null, 'blank message stored as null');

const studentPaths = buildStudentAuthorizedDisplayNameChangePaths('bobby', 'NewName');
assert(studentPaths['players/bobby/displayName'] === 'NewName', 'student path sets displayName');
assert(studentPaths['players/bobby/requiresDisplayNameChange'] === null, 'student path clears flag');
assert(studentPaths['players/bobby/displayNameChangeMessage'] === null, 'student path clears message');

// Register maxlength in authoritative index.html
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const regBlock = html.slice(html.indexOf('id="register-username"'), html.indexOf('id="register-username"') + 350);
assert(regBlock.includes('maxlength="20"'), 'register username maxlength=20');

// Profile secondary login markup (Slice B)
assert(html.includes('id="profile-login-username"'), 'profile has login username secondary element');
assert(html.includes('id="profile-username"'), 'profile has primary display name element');

// Mandatory modal markup (Slice C gate UI)
assert(html.includes('id="display-name-required-modal"'), 'mandatory modal present');
assert(html.includes('id="dn-required-login-username"'), 'modal shows login username element');
assert(html.includes('id="dn-required-teacher-message"'), 'modal has teacher message element');
assert(html.includes('id="dn-required-save"'), 'modal has save button');
assert(html.includes('id="dn-required-logout"'), 'modal allows logout');
assert(!html.includes('id="dn-required-cancel"'), 'modal has no cancel-into-game control');
assert(!html.includes('id="dn-required-close"'), 'modal has no close-into-game control');

// Presentation modules import resolver (Slice B)
const lbUi = fs.readFileSync(path.join(root, 'js', 'leaderboard-ui.js'), 'utf8');
assert(lbUi.includes('getDirectoryDisplayName'), 'leaderboard-ui uses directory display helper');
assert(lbUi.includes('row.username'), 'leaderboard keeps row.username identity');
const tradeUi = fs.readFileSync(path.join(root, 'js', 'trade-ui.js'), 'utf8');
assert(tradeUi.includes('buildTradePartnerPickerLabels'), 'trade-ui uses picker label helper');
assert(tradeUi.includes('Anonymous Listing'), 'listings remain anonymous');
assert(tradeUi.includes('createTradeOffer(username, _selectedTarget'), 'trade offer still uses username target');
const profileUi = fs.readFileSync(path.join(root, 'js', 'profile-ui.js'), 'utf8');
assert(profileUi.includes('getPlayerDisplayName'), 'profile-ui uses resolver');
assert(profileUi.includes('Login Username:'), 'profile shows labeled login username');

const adminUi = fs.readFileSync(path.join(root, 'js', 'ui.js'), 'utf8');
assert(adminUi.includes('compareDirectoryPlayersByDisplayName'), 'Admin Players sorts by display-name comparator');
assert(adminUi.includes('btn-admin-quick-give-packs'), 'Quick Give Packs button retained');
assert(adminUi.includes('data-username="${safeKey}"'), 'Manage/Give Packs remain username-keyed');

// Rules carve-out present — Slice B must not require rules edits
const rules = fs.readFileSync(path.join(root, 'database.rules.json'), 'utf8');
assert(rules.includes('"displayName"'), 'rules include displayName leaf');
assert(rules.includes('"requiresDisplayNameChange"'), 'rules include require flag leaf');
assert(rules.includes('"displayNameChangeMessage"'), 'rules include message leaf');
assert(rules.includes('^[A-Za-z0-9_]{3,20}$'), 'rules validate displayName charset/length');

assert(fs.existsSync(path.join(root, 'js', 'player-display-name.js')), 'helper module exists');

// firebase-hosting-prod is generated separately — this sort fix must not be manually patched there
const prodUi = path.join(root, 'firebase-hosting-prod', 'js', 'ui.js');
if (fs.existsSync(prodUi)) {
  const prodUiSrc = fs.readFileSync(prodUi, 'utf8');
  assert(
    !prodUiSrc.includes('filterAndSortAdminDirectoryPlayers'),
    'firebase-hosting-prod ui.js does not yet include multi-select filter (unsynced — correct)',
  );
}

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll player-display-name Slice A+B+C tests passed.');
