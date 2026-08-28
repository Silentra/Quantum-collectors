/**
 * Admin Players multi-select filter — pure helper tests.
 * Run: node scripts/admin-players-filter.test.mjs
 */

import {
  isAbsentSubgroupId,
  directoryEntryMatchesGroupSubgroupFilter,
  filterAndSortAdminDirectoryPlayers,
  buildAdminPlayersSubgroupFilterOptions,
  pruneDraftSubgroupIds,
  countAdminPlayersActiveFilters,
} from '../js/admin-players-filter.js';
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

const entries = [
  { key: 'alpha', value: { displayName: 'Zebra', groupId: 'g1', subgroupId: 's1' } },
  { key: 'bravo', value: { displayName: 'Apple', groupId: 'g1', subgroupId: null } },
  { key: 'charlie', value: { displayName: 'Mango', groupId: 'g2', subgroupId: 's2' } },
  { key: 'delta', value: { displayName: 'Berry', groupId: 'g2' } }, // missing subgroup
  { key: 'echo', value: { displayName: 'Kumquat', groupId: 'g3', subgroupId: 'stale_sub' } },
  { key: 'foxtrot', value: { displayName: 'apple', groupId: 'g1', subgroupId: 's1' } }, // dup display case
];

assert(isAbsentSubgroupId(null) === true, 'null subgroup absent');
assert(isAbsentSubgroupId(undefined) === true, 'undefined subgroup absent');
assert(isAbsentSubgroupId('') === true, 'blank subgroup absent');
assert(isAbsentSubgroupId('   ') === true, 'whitespace subgroup absent');
assert(isAbsentSubgroupId('stale_sub') === false, 'stale non-empty is NOT No Subgroup');

// 1. No filters
assert(
  filterAndSortAdminDirectoryPlayers(entries, {}).map((e) => e.key).length === entries.length,
  'no filters → all eligible',
);

// 2. Single group
assert(
  filterAndSortAdminDirectoryPlayers(entries, { groupIds: ['g1'] }).every((e) => e.value.groupId === 'g1'),
  'single group only',
);

// 3. Multiple groups OR
{
  const keys = filterAndSortAdminDirectoryPlayers(entries, { groupIds: ['g1', 'g3'] }).map((e) => e.key).sort();
  assert(keys.join(',') === 'alpha,bravo,echo,foxtrot', 'multiple groups OR');
}

// 4–5. Subgroup OR
{
  const keys = filterAndSortAdminDirectoryPlayers(entries, { subgroupIds: ['s1', 's2'] }).map((e) => e.key).sort();
  assert(keys.join(',') === 'alpha,charlie,foxtrot', 'multiple subgroups OR');
}

// 6. Group AND subgroup
{
  const keys = filterAndSortAdminDirectoryPlayers(entries, {
    groupIds: ['g1', 'g2'],
    subgroupIds: ['s2'],
  }).map((e) => e.key);
  assert(keys.join(',') === 'charlie', 'group OR-set AND subgroup');
}

// 7. No Subgroup only
{
  const keys = filterAndSortAdminDirectoryPlayers(entries, {
    includeNoSubgroup: true,
  }).map((e) => e.key).sort();
  assert(keys.join(',') === 'bravo,delta', 'No Subgroup only includes absent');
}

// 8. No Subgroup + named subgroup OR
{
  const keys = filterAndSortAdminDirectoryPlayers(entries, {
    subgroupIds: ['s1'],
    includeNoSubgroup: true,
  }).map((e) => e.key).sort();
  assert(keys.join(',') === 'alpha,bravo,delta,foxtrot', 'No Subgroup OR named subgroup');
}

// 9. Stale does not match No Subgroup
assert(
  directoryEntryMatchesGroupSubgroupFilter(
    { key: 'echo', value: { subgroupId: 'stale_sub' } },
    { includeNoSubgroup: true },
  ) === false,
  'stale subgroup ID excluded from No Subgroup',
);

// 10. Search + filters
{
  const keys = filterAndSortAdminDirectoryPlayers(entries, {
    search: 'app',
    groupIds: ['g1'],
  }).map((e) => e.key).sort();
  assert(keys.join(',') === 'bravo,foxtrot', 'search AND group filter');
}

// 11–12. Sort by display name + username tiebreak
{
  const keys = filterAndSortAdminDirectoryPlayers(entries, { groupIds: ['g1'] }).map((e) => e.key);
  assert(keys[0] === 'bravo', 'Apple first');
  // apple vs Apple — case-insensitive primary; foxtrot vs ... foxtrot has 'apple', bravo 'Apple'
  // both Apple-like; order by username: bravo before foxtrot for same label case-insensitive
  // actually 'Apple'.toLowerCase() === 'apple'.toLowerCase() so tiebreak username: bravo, foxtrot
  assert(keys.indexOf('bravo') < keys.indexOf('foxtrot'), 'duplicate displayName tiebreak by username');
  assert(keys[keys.length - 1] === 'alpha', 'Zebra last among g1');
}

// Options / prune / count
const groups = [
  { id: 'g1', name: 'Period 1', subgroups: { s1: { id: 's1', name: 'Team A' }, s9: { id: 's9', name: 'Team B' } } },
  { id: 'g2', name: 'Period 2', subgroups: { s2: { id: 's2', name: 'Team A' } } },
];
const allSubs = buildAdminPlayersSubgroupFilterOptions(groups, []);
assert(allSubs.some((o) => o.label === 'Period 1 / Team A'), 'disambiguated subgroup label');
assert(allSubs.some((o) => o.label === 'Period 2 / Team A'), 'cross-group same name disambiguated');
const g1Subs = buildAdminPlayersSubgroupFilterOptions(groups, ['g1']);
assert(g1Subs.every((o) => o.groupId === 'g1'), 'selected groups limit subgroup union');
assert(
  pruneDraftSubgroupIds(['s1', 's2'], g1Subs).join(',') === 's1',
  'prune removes incompatible draft subgroup',
);
assert(countAdminPlayersActiveFilters({
  groupIds: ['g1', 'g2'],
  subgroupIds: ['s1'],
  includeNoSubgroup: true,
}) === 4, 'badge count groups+subs+NoSubgroup');

// Markup / wiring smoke
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(html.includes('id="admin-player-filter-btn"'), 'Filter button present');
assert(html.includes('id="admin-player-filter-panel"'), 'Filter panel present');
assert(!html.includes('id="admin-player-filter-group"'), 'old group select removed');
assert(!html.includes('id="admin-player-filter-subgroup"'), 'old subgroup select removed');

const ui = fs.readFileSync(path.join(root, 'js', 'ui.js'), 'utf8');
assert(ui.includes('filterAndSortAdminDirectoryPlayers'), 'ui uses pure filter pipeline');
assert(ui.includes('_resetAdminPlayersFilterState'), 'filter state reset helper');
assert(ui.includes('admin-player-filter-no-subgroup'), 'No Subgroup checkbox wired in ui');
assert(ui.includes('No Subgroup'), 'No Subgroup label in ui');
assert(ui.includes('data-username="${safeKey}"'), 'actions remain username-keyed');
assert(
  !/function renderAdminPlayers[\s\S]*?getAllPlayers\(/.test(ui),
  'renderAdminPlayers does not call getAllPlayers',
);

const prodUi = path.join(root, 'firebase-hosting-prod', 'js', 'ui.js');
if (fs.existsSync(prodUi)) {
  assert(
    !fs.readFileSync(prodUi, 'utf8').includes('filterAndSortAdminDirectoryPlayers'),
    'firebase-hosting-prod not synced for this filter (correct)',
  );
}

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll admin-players-filter tests passed.');
