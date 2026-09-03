/**
 * Regenerate + inject A+B claim coupling rules and lastProjectRefreshAt CAS
 * into database.rules.json.
 *
 * Usage: node scripts/inject-claim-rules.mjs
 *
 * COUPLING DOC:
 * - App cap: getMaxStoredProjects() === 7 (js/project-refresh.js)
 * - Rules inspect projects array indices 0..6 only (PROJECT_RULES_ARRAY_INDEX_MAX = 6)
 * - Newly CLAIMED by projectId requires a FRESH projectClaims marker in the SAME write
 * - Preexisting marker does NOT authorize COMPLETE → CLAIMED
 * - lastProjectRefreshAt step === PROJECT_REFRESH_INTERVAL_MS (12h) in js/project-refresh.js
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rulesPath = resolve(__dirname, '../database.rules.json');
const snippetsPath = resolve(__dirname, './.claim-rules-snippets.json');

const gen = spawnSync(process.execPath, [resolve(__dirname, './gen-claim-rules-snippets.mjs')], {
  cwd: resolve(__dirname, '..'),
  encoding: 'utf8',
});
if (gen.status !== 0) {
  console.error(gen.stderr || gen.stdout);
  process.exit(gen.status || 1);
}

const snippets = JSON.parse(readFileSync(snippetsPath, 'utf8'));
const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
const userNode = rules.rules.players.$username;
if (!userNode || !userNode.$other) {
  throw new Error('Expected rules.players.$username.$other');
}

const projectsRule = {
  '.write': snippets.ownerWrite,
  '.validate': snippets.projectsValidate,
};

const refreshAtRule = {
  '.write': snippets.refreshAtWrite,
  '.validate': snippets.refreshAtValidate,
};

const ordered = {};
for (const [key, value] of Object.entries(userNode)) {
  if (key === 'projects' || key === 'lastProjectRefreshAt') continue;
  if (key === '$other') {
    ordered.projects = projectsRule;
    ordered.lastProjectRefreshAt = refreshAtRule;
    ordered.$other = value;
    continue;
  }
  ordered[key] = value;
}
if (!ordered.projects) ordered.projects = projectsRule;
if (!ordered.lastProjectRefreshAt) ordered.lastProjectRefreshAt = refreshAtRule;
if (!ordered.$other) ordered.$other = userNode.$other;

rules.rules.players.$username = ordered;

const claimLeaf = rules.rules.projectClaims.$username.$projectId;
if (!claimLeaf) {
  throw new Error('Expected rules.projectClaims.$username.$projectId');
}
claimLeaf['.write'] = snippets.markerWrite;

writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`);
console.log('Updated', rulesPath);
const keys = Object.keys(ordered);
console.log('projects idx', keys.indexOf('projects'), 'refreshAt idx', keys.indexOf('lastProjectRefreshAt'), '$other idx', keys.indexOf('$other'));
console.log('interval ms', snippets.PROJECT_REFRESH_INTERVAL_MS);
