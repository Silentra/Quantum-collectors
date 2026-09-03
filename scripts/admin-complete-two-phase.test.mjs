/**
 * Admin Complete two-phase orchestration unit tests (no Firebase emulator).
 *
 * Run: node scripts/admin-complete-two-phase.test.mjs
 */

import {
  buildAdminForceCompleteProjects,
  adminCompleteActiveProject,
} from '../js/admin-player-tools.js';
import { PROJECT_STATES } from '../js/project-state.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('PASS:', msg);
  }
}

const activeProject = {
  id: 'project_a',
  state: PROJECT_STATES.ACTIVE,
  title: 'Force Me',
  startedAt: 1,
  completesAt: 999,
  assignedScientists: [],
  assignedConcepts: [],
};

// Pure Phase-1 builder
{
  const built = buildAdminForceCompleteProjects([activeProject], 'project_a', 1000);
  assert(built.ok === true, 'A) buildAdminForceCompleteProjects ok');
  assert(built.projects[0].state === PROJECT_STATES.COMPLETE, 'A) Phase1 array is COMPLETE');
  assert(built.completedProject.state === PROJECT_STATES.COMPLETE, 'A) completedProject COMPLETE');
}

{
  const built = buildAdminForceCompleteProjects(
    [{ ...activeProject, state: PROJECT_STATES.COMPLETE }],
    'project_a',
    1000,
  );
  assert(built.ok === false && built.reason === 'project_not_active', 'rejects non-ACTIVE');
}

// Orchestration with injectable deps
{
  let persistCalls = 0;
  let claimCalls = 0;
  let claimAfterPersist = false;

  const result = await adminCompleteActiveProject(
    'alice',
    'project_a',
    { now: 2000 },
    {
      getProjects: () => [activeProject],
      persistComplete: async (_user, projects) => {
        persistCalls += 1;
        assert(projects[0].state === PROJECT_STATES.COMPLETE, 'B) Phase1 persists COMPLETE only');
        assert(claimCalls === 0, 'B) Phase2 not called before Phase1 ack');
        return { ok: true };
      },
      commitClaim: async () => {
        claimCalls += 1;
        claimAfterPersist = persistCalls === 1;
        return {
          success: true,
          project: { id: 'project_a', state: PROJECT_STATES.CLAIMED, title: 'Force Me' },
          rpEarned: 12,
          revealCard: null,
          notified: [],
          writeCount: 1,
        };
      },
    },
  );

  assert(persistCalls === 1, 'C) Phase1 called once');
  assert(claimCalls === 1, 'C) Phase2 called once');
  assert(claimAfterPersist === true, 'C) Phase2 after Phase1');
  assert(result.success === true, 'C) overall success');
  assert(result.rpEarned === 12, 'E) rewards only from claim result');
  assert(result.completed === true && result.claimed === true, 'C) completed+claimed flags');
}

{
  let claimCalls = 0;
  const result = await adminCompleteActiveProject(
    'alice',
    'project_a',
    { now: 2000 },
    {
      getProjects: () => [activeProject],
      persistComplete: async () => ({ ok: false, error: 'denied' }),
      commitClaim: async () => {
        claimCalls += 1;
        return { success: true };
      },
    },
  );
  assert(result.success === false, 'B) Phase1 failure stops');
  assert(result.phase === 1, 'B) phase=1');
  assert(result.reason === 'complete_write_failed', 'B) complete_write_failed');
  assert(claimCalls === 0, 'B) Phase2 never called after Phase1 fail');
}

{
  let lastProjects = null;
  const result = await adminCompleteActiveProject(
    'alice',
    'project_a',
    { now: 2000 },
    {
      getProjects: () => [activeProject],
      persistComplete: async (_u, projects) => {
        lastProjects = projects;
        return { ok: true };
      },
      commitClaim: async () => ({
        success: false,
        reason: 'write_failed',
        error: 'permission_denied',
      }),
    },
  );
  assert(result.success === false, 'D) Phase2 failure overall fail');
  assert(result.phase === 2, 'D) phase=2');
  assert(result.completed === true, 'D) completed flag true (no rollback)');
  assert(lastProjects[0].state === PROJECT_STATES.COMPLETE, 'D) Phase1 left COMPLETE shape');
  assert(result.reason === 'write_failed', 'D) surfaces claim reason');
}

{
  const result = await adminCompleteActiveProject(
    'alice',
    'project_a',
    { now: 2000 },
    {
      getProjects: () => [activeProject],
      persistComplete: async () => ({ ok: true }),
      commitClaim: async () => ({
        success: false,
        reason: 'already_claimed',
      }),
    },
  );
  assert(result.reason === 'already_claimed', 'G) already_claimed forwarded');
  assert(result.phase === 2 && result.completed === true, 'G) completed but not claimed');
}

// H) Student claim remains separate module — Admin Complete must call commitClaim dep once
{
  let commitArgs = null;
  await adminCompleteActiveProject(
    'alice',
    'project_a',
    { now: 3333 },
    {
      getProjects: () => [activeProject],
      persistComplete: async () => ({ ok: true }),
      commitClaim: async (username, projectId, options) => {
        commitArgs = { username, projectId, options };
        return { success: true, project: { id: projectId }, rpEarned: 1, writeCount: 1 };
      },
    },
  );
  assert(commitArgs.username === 'alice', 'H) claim username');
  assert(commitArgs.projectId === 'project_a', 'H) claim projectId');
  assert(commitArgs.options?.projects === undefined, 'H) claim does not pass in-memory projects override');
  assert(commitArgs.options?.now === 3333, 'H) claim receives now');
}

if (failed) {
  console.error(`\nadmin-complete-two-phase: ${failed} failure(s)`);
  process.exit(1);
}
console.log('\nadmin-complete-two-phase: ALL PASSED');
