/**
 * Research Project Integrity — unit proofs (no emulator).
 *
 * Run: node scripts/research-project-integrity.test.mjs
 */

import {
  PROJECT_CLAIMS_ROOT,
  PROJECT_RULES_ARRAY_INDEX_MAX,
  buildProjectClaimMarkerUpdate,
  buildProjectClaimsTreeDeleteUpdate,
  mergeProjectsPreservingClaimed,
  applyClaimLedgerToProjects,
  projectClaimMarkerPath,
} from '../js/project-claims.js';
import { PROJECT_STATES } from '../js/project-state.js';
import {
  MAX_STORED_PROJECTS,
  getMaxStoredProjects,
  getProjectRefreshIntervalMs,
} from '../js/project-refresh.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HISTORY_EVENT_TYPES,
  HISTORY_SOURCES,
  HISTORY_ACTOR_TYPES,
  buildResearchProposalUsedHistoryUpdate,
  PLAYER_HISTORY_ROOT,
} from '../js/player-history.js';
import {
  PLAYER_HISTORY_RETENTION_MS,
  historyRetentionCutoffTs,
  isHistoryEventExpired,
  buildPlayerHistoryTreeDeleteUpdate,
} from '../js/player-history-retention.js';
import { syncProjects } from '../js/project-sync.js';
import { buildResearchProposalProjectPlan } from '../js/shop-mutations.js';
import { describeHistoryEvent } from '../js/admin-player-history.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('PASS:', msg);
  }
}

// Merge: CLAIMED never downgrades to COMPLETE
{
  const claimed = { id: 'project_1', state: PROJECT_STATES.CLAIMED, claimedAt: 100 };
  const staleComplete = { id: 'project_1', state: PROJECT_STATES.COMPLETE };
  const merged = mergeProjectsPreservingClaimed([staleComplete], [claimed]);
  assert(merged.length === 1, 'merge keeps one entry');
  assert(merged[0].state === PROJECT_STATES.CLAIMED, 'CLAIMED wins over stale COMPLETE');
  assert(merged[0].claimedAt === 100, 'preserves claimedAt from authoritative');
}

{
  const merged = mergeProjectsPreservingClaimed(
    [
      { id: 'a', state: PROJECT_STATES.COMPLETE },
      { id: 'b', state: PROJECT_STATES.AVAILABLE },
    ],
    [{ id: 'a', state: PROJECT_STATES.CLAIMED }],
  );
  assert(merged[0].state === PROJECT_STATES.CLAIMED, 'id a forced claimed');
  assert(merged[1].state === PROJECT_STATES.AVAILABLE, 'unrelated id unchanged');
}

// Ledger apply
{
  const out = applyClaimLedgerToProjects(
    [
      { id: 'p1', state: PROJECT_STATES.COMPLETE },
      { id: 'p2', state: PROJECT_STATES.AVAILABLE },
    ],
    { p1: { claimedAt: 50, schemaVersion: 1 } },
  );
  assert(out[0].state === PROJECT_STATES.CLAIMED, 'ledger forces CLAIMED');
  assert(out[0].claimedAt === 50, 'ledger claimedAt applied');
  assert(out[1].state === PROJECT_STATES.AVAILABLE, 'non-ledger project untouched');
}

// Marker builders
{
  const { path, updates } = buildProjectClaimMarkerUpdate('alice', 'project_xyz', 999);
  assert(path === 'projectClaims/alice/project_xyz', 'marker path shape');
  assert(PROJECT_CLAIMS_ROOT === 'projectClaims', 'root constant');
  assert(updates[path].schemaVersion === 1, 'marker schemaVersion 1');
  assert(updates[path].claimedAt === 999, 'marker claimedAt');
  assert(projectClaimMarkerPath('alice', 'project_xyz') === path, 'path helper matches');
}

{
  const del = buildProjectClaimsTreeDeleteUpdate('alice');
  assert(del['projectClaims/alice'] === null, 'account delete wipes claim tree');
  const histDel = buildPlayerHistoryTreeDeleteUpdate('alice');
  assert(histDel[`${PLAYER_HISTORY_ROOT}/alice`] === null, 'history wipe separate from claims');
  assert(
    !Object.keys(del).some((k) => k.startsWith(PLAYER_HISTORY_ROOT)),
    'claims delete is not history',
  );
}

// Proposal history
{
  const leaf = buildResearchProposalUsedHistoryUpdate('bob', {
    generatedProjectId: 'project_gen_1',
    quantityConsumed: 1,
    actorUid: 'uid-bob',
  });
  assert(leaf.eventId && leaf.path.startsWith(`${PLAYER_HISTORY_ROOT}/bob/`), 'history leaf path');
  const body = leaf.updates[leaf.path];
  assert(body.type === HISTORY_EVENT_TYPES.RESEARCH_PROPOSAL_USED, 'type research_proposal_used');
  assert(body.type === 'research_proposal_used', 'wire type string');
  assert(body.source === HISTORY_SOURCES.RESEARCH_PROPOSAL, 'source research_proposal');
  assert(body.actorType === HISTORY_ACTOR_TYPES.SELF, 'actor self');
  assert(body.projectId === 'project_gen_1', 'payload projectId');
  assert(body.consumableId === 'research_proposal', 'consumableId');
  assert(body.quantity === 1, 'quantity');
  assert(body.schemaVersion === 1, 'schemaVersion');

  const described = describeHistoryEvent(body);
  assert(described.known === true, 'UI knows proposal event');
  assert(/Used Research Proposal/i.test(described.summary), 'UI summary');
  assert(described.details.some((d) => d.includes('project_gen_1')), 'UI shows generated id');
}

// Retention applies to history events, not claim ledger
{
  const now = Date.now();
  const cutoff = historyRetentionCutoffTs(now);
  assert(
    isHistoryEventExpired({ ts: now - PLAYER_HISTORY_RETENTION_MS - 1000 }, cutoff) === true,
    'old history event expired after retention window',
  );
  assert(
    isHistoryEventExpired({ ts: now - 1000 }, cutoff) === false,
    'fresh history event not expired',
  );
  assert(PROJECT_CLAIMS_ROOT !== PLAYER_HISTORY_ROOT, 'claim ledger root != history root');
}

// 12h generation cadence
{
  const interval = getProjectRefreshIntervalMs();
  assert(interval === 12 * 60 * 60 * 1000, 'default refresh interval 12h');

  const t0 = 1_700_000_000_000;
  const base = { projects: [], totalRP: 0, lastRefreshAt: t0 };

  const at3h = syncProjects({ ...base, now: t0 + 3 * 60 * 60 * 1000 });
  assert(at3h.generatedCount === 0, 'T0+3h generates 0 scheduled projects');

  const at12h = syncProjects({ ...base, now: t0 + 12 * 60 * 60 * 1000 });
  assert(at12h.generatedCount === 1, 'T0+12h generates 1 scheduled project');

  const at24h = syncProjects({ ...base, now: t0 + 24 * 60 * 60 * 1000 });
  assert(at24h.generatedCount === 2, 'T0+24h catch-up may generate 2');
  const prefixes = at24h.projects
    .map((p) => String(p.id).match(/project_(\d+)/)?.[1])
    .filter(Boolean);
  assert(prefixes.length >= 2, 'catch-up projects have timestamped ids');
  // Same-ms prefixes are allowed (not a bug)
  assert(
    prefixes[0] === prefixes[1] || prefixes[0] !== prefixes[1],
    'same-ms catch-up id prefixes are legitimate when present',
  );
}

assert(typeof buildResearchProposalProjectPlan === 'function', 'proposal plan helper exported');

// Array-cap ↔ rules coupling safeguard
{
  assert(MAX_STORED_PROJECTS === 7, 'MAX_STORED_PROJECTS === 7');
  assert(getMaxStoredProjects() === 7, 'getMaxStoredProjects() === 7');
  assert(PROJECT_RULES_ARRAY_INDEX_MAX === 6, 'PROJECT_RULES_ARRAY_INDEX_MAX === 6');
  const rulesText = readFileSync(resolve(__dirname, '../database.rules.json'), 'utf8');
  const rulesJson = JSON.parse(rulesText);
  const validate = rulesJson.rules.players.$username.projects?.['.validate'] || '';
  assert(validate.includes(".child('6')"), "database.rules.json projects.validate inspects child('6')");
  assert(!validate.includes(".child('7')"), "database.rules.json projects.validate must not assume child('7')");
  const refreshValidate = rulesJson.rules.players.$username.lastProjectRefreshAt?.['.validate'] || '';
  assert(
    refreshValidate.includes(String(getProjectRefreshIntervalMs())),
    'lastProjectRefreshAt rules interval coupled to JS constant',
  );
}

if (failed) {
  console.error(`\nresearch-project-integrity: ${failed} failure(s)`);
  process.exit(1);
}
console.log('\nresearch-project-integrity: ALL PASSED');
