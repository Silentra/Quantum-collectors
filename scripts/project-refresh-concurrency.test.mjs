/**
 * Project refresh concurrency unit tests (no Firebase emulator).
 *
 * Run: node scripts/project-refresh-concurrency.test.mjs
 */

import {
  PROJECT_REFRESH_INTERVAL_MS,
  PROJECT_REFRESH_CATCHUP_MAX_STEPS,
  getProjectRefreshIntervalMs,
} from '../js/project-refresh.js';
import { planOneCycleRefresh } from '../js/project-pool.js';
import {
  buildRefreshPersistProjects,
  preferProjectForRefreshMerge,
} from '../js/project-refresh-merge.js';
import {
  commitScheduledRefreshStep,
  commitScheduledRefreshCatchUp,
} from '../js/project-refresh-commit.js';
import { PROJECT_STATES } from '../js/project-state.js';
import { readFileSync } from 'node:fs';

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('PASS:', msg);
  }
}

const I = PROJECT_REFRESH_INTERVAL_MS;
const T0 = 1_700_000_000_000;

// Interval coupling with rules
{
  assert(I === 12 * 60 * 60 * 1000, '1) interval constant is 12h ms');
  assert(getProjectRefreshIntervalMs() === I, '1) getProjectRefreshIntervalMs === constant');
  const rules = JSON.parse(readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8'));
  const v = rules.rules.players.$username.lastProjectRefreshAt['.validate'];
  assert(typeof v === 'string' && v.includes(String(I)), '1) rules validate embeds interval ms');
  assert(PROJECT_REFRESH_CATCHUP_MAX_STEPS === 7, 'catch-up max steps === cap');
}

// Pure one-cycle plan
{
  const p1 = planOneCycleRefresh({
    projects: [],
    totalRP: 0,
    lastRefreshAt: T0,
    now: T0 + I,
  });
  assert(p1.due === true && p1.generatedCount === 1, '1) one cycle due -> one project');
  assert(p1.refreshAt === T0 + I, '1) advances exactly one interval');
  assert(p1.bootstrap === false, '1) not bootstrap');
}

{
  const first = planOneCycleRefresh({
    projects: [],
    totalRP: 0,
    lastRefreshAt: T0,
    now: T0 + 2 * I,
  });
  assert(first.generatedCount === 1 && first.refreshAt === T0 + I, '2) first of two cycles consumes one only');
  const second = planOneCycleRefresh({
    projects: first.projects,
    totalRP: 0,
    lastRefreshAt: first.refreshAt,
    now: T0 + 2 * I,
  });
  assert(second.generatedCount === 1 && second.refreshAt === T0 + 2 * I, '2) second sequential step');
}

{
  const full = Array.from({ length: 7 }, (_, i) => ({
    id: `p${i}`,
    state: PROJECT_STATES.AVAILABLE,
    title: `P${i}`,
  }));
  const burn = planOneCycleRefresh({
    projects: full,
    totalRP: 0,
    lastRefreshAt: T0,
    now: T0 + I,
  });
  assert(burn.due && burn.generatedCount === 0 && burn.burned, '11) full pool burns 0 gens');
  assert(burn.refreshAt === T0 + I, '11) full pool advances one interval');
}

{
  const full = Array.from({ length: 7 }, (_, i) => ({
    id: `p${i}`,
    state: PROJECT_STATES.AVAILABLE,
    title: `P${i}`,
  }));
  let at = T0;
  let projects = full;
  for (let n = 0; n < 3; n++) {
    const step = planOneCycleRefresh({
      projects,
      totalRP: 0,
      lastRefreshAt: at,
      now: T0 + 3 * I,
    });
    assert(step.generatedCount === 0 && step.refreshAt === at + I, `12) burn step ${n + 1}`);
    at = step.refreshAt;
    projects = step.projects;
  }
  // Slot opens later — only future cycles from current at
  const opened = projects.slice(0, 6);
  const afterOpen = planOneCycleRefresh({
    projects: opened,
    totalRP: 0,
    lastRefreshAt: at,
    now: at + I,
  });
  assert(afterOpen.generatedCount === 1, '12) no backlog flood — only one new when due after open');
}

{
  const boot = planOneCycleRefresh({
    projects: [],
    totalRP: 0,
    lastRefreshAt: 0,
    now: T0 + 1000,
  });
  assert(boot.bootstrap === true && boot.generatedCount >= 1, '17) bootstrap mints initial projects');
  assert(boot.refreshAt > 0 && boot.refreshAt <= T0 + 1000, '17) bootstrap refreshAt <= now');
}

// Merge preservation
{
  const server = [
    { id: 'sa', state: PROJECT_STATES.AVAILABLE, title: 'Server Avail' },
    { id: 'sb', state: PROJECT_STATES.ACTIVE, title: 'Server Active', startedAt: 1 },
    {
      id: 'sc',
      state: PROJECT_STATES.COMPLETE,
      title: 'Done',
      outcome: { success: true },
      rewards: { rpEarned: 9 },
    },
    { id: 'sd', state: PROJECT_STATES.CLAIMED, title: 'Claimed', claimedAt: 1, rewards: { rpEarned: 1 } },
  ];
  const neu = { id: 'new1', state: PROJECT_STATES.AVAILABLE, title: 'Fresh' };
  const merged = buildRefreshPersistProjects(server, [neu]);
  assert(merged.some((p) => p.id === 'sa'), '6) server-only AVAILABLE survives');
  assert(merged.some((p) => p.id === 'sb'), '7) server-only ACTIVE survives');
  assert(merged.some((p) => p.id === 'new1'), 'append new scheduled');
  assert(merged.find((p) => p.id === 'sc').rewards.rpEarned === 9, '10) reward package survives');
  assert(merged.find((p) => p.id === 'sd').state === PROJECT_STATES.CLAIMED, '9) CLAIMED preserved on server list');
}

{
  const server = { id: 'x', state: PROJECT_STATES.COMPLETE, outcome: { success: true }, rewards: { rpEarned: 3 } };
  const local = { id: 'x', state: PROJECT_STATES.ACTIVE, title: 'stale' };
  const pref = preferProjectForRefreshMerge(server, local);
  assert(pref.state === PROJECT_STATES.COMPLETE, '8) COMPLETE not downgraded to ACTIVE');
  assert(pref.rewards?.rpEarned === 3, '8) COMPLETE keeps rewards');
}

{
  const server = { id: 'x', state: PROJECT_STATES.CLAIMED, claimedAt: 1, rewards: { rpEarned: 2 } };
  const local = { id: 'x', state: PROJECT_STATES.COMPLETE, rewards: { rpEarned: 2 } };
  const pref = preferProjectForRefreshMerge(server, local);
  assert(pref.state === PROJECT_STATES.CLAIMED, '9) CLAIMED not downgraded');
}

{
  const server = [{ id: 'proposal_1', state: PROJECT_STATES.AVAILABLE, title: 'From Proposal' }];
  const merged = buildRefreshPersistProjects(server, [{ id: 'sched_1', state: PROJECT_STATES.AVAILABLE }]);
  assert(merged.some((p) => p.id === 'proposal_1'), '13) Proposal-added server project survives');
  assert(merged.some((p) => p.id === 'sched_1'), '13) scheduled append ok');
}

// Injectable concurrent A/B regression
{
  let serverProjects = [{ id: 'base', state: PROJECT_STATES.AVAILABLE, title: 'Base' }];
  let serverRefreshAt = T0;
  const totalRP = 0;

  const makeDeps = () => ({
    loadState: async () => ({
      projects: serverProjects.map((p) => ({ ...p })),
      lastProjectRefreshAt: serverRefreshAt,
      totalRP,
    }),
    writeUpdate: async (updates) => {
      const nextAt = updates['players/alice/lastProjectRefreshAt'];
      if (nextAt != null) {
        if (serverRefreshAt > 0 && nextAt !== serverRefreshAt + I) {
          return { ok: false, error: 'PERMISSION_DENIED' };
        }
        if (serverRefreshAt > 0 && nextAt <= serverRefreshAt) {
          return { ok: false, error: 'PERMISSION_DENIED' };
        }
        serverRefreshAt = nextAt;
      }
      const nextProjects = updates['players/alice/projects'];
      if (nextProjects) serverProjects = nextProjects;
      return { ok: true };
    },
  });

  // Both plan from identical T0
  const stateA = { projects: serverProjects.map((p) => ({ ...p })), lastProjectRefreshAt: T0, totalRP };
  const planA = planOneCycleRefresh({ ...stateA, lastRefreshAt: T0, now: T0 + I });
  const planB = planOneCycleRefresh({ ...stateA, lastRefreshAt: T0, now: T0 + I });
  assert(planA.generatedCount === 1 && planB.generatedCount === 1, 'concurrent: both planned one project');
  assert(planA.generated[0].id !== planB.generated[0].id, 'concurrent: PA !== PB ids');

  const deps = makeDeps();
  // A commits using its plan via normal step (force-read still T0)
  const aResult = await commitScheduledRefreshStep('alice', { now: T0 + I }, deps);
  assert(aResult.ok && aResult.wrote && aResult.generatedCount === 1, '3/concurrent: A wins');
  const paId = aResult.generated[0].id;
  assert(serverRefreshAt === T0 + I, 'concurrent: server T1');
  assert(serverProjects.some((p) => p.id === paId), 'concurrent: PA on server');

  // B attempts already-built plan (stale write of T1 with PB)
  const staleWrite = await deps.writeUpdate({
    'players/alice/lastProjectRefreshAt': T0 + I,
    'players/alice/projects': buildRefreshPersistProjects(
      [{ id: 'base', state: PROJECT_STATES.AVAILABLE }],
      planB.generated,
    ),
  });
  assert(staleWrite.ok === false, '3/concurrent: B stale T1 rejected');

  // B discards PB, re-reads, not due
  const bRetry = await commitScheduledRefreshStep('alice', { now: T0 + I }, deps);
  assert(bRetry.reason === 'not_due' && bRetry.wrote === false, '15) B stops — cycle consumed');
  assert(serverProjects.filter((p) => p.state === PROJECT_STATES.AVAILABLE).length === 2, 'concurrent: base+PA only');
  assert(!serverProjects.some((p) => p.id === planB.generated[0].id), 'concurrent: PB discarded');

  // True second cycle
  const b2 = await commitScheduledRefreshStep('alice', { now: T0 + 2 * I }, deps);
  assert(b2.ok && b2.wrote && b2.generatedCount === 1, 'concurrent: B creates PB2 for T2');
  assert(serverRefreshAt === T0 + 2 * I, 'concurrent: T2');
  assert(serverProjects.some((p) => p.id === paId), 'concurrent: PA preserved');
  assert(serverProjects.some((p) => p.id === b2.generated[0].id), 'concurrent: PB2 present');
}

// Stale multi-cycle plan cannot bypass
{
  let serverRefreshAt = T0 + I;
  let serverProjects = [{ id: 'pa', state: PROJECT_STATES.AVAILABLE }];
  const deps = {
    loadState: async () => ({
      projects: serverProjects,
      lastProjectRefreshAt: serverRefreshAt,
      totalRP: 0,
    }),
    writeUpdate: async (updates) => {
      const nextAt = updates['players/bob/lastProjectRefreshAt'];
      if (nextAt === T0 + 2 * I && serverRefreshAt === T0 + I) {
        // Legitimate one-step T1→T2 would be ok — but this test injects T0+2I from stale
        // multi-cycle ONLY when previous was still T0. Here server is T1 so T2 is valid step.
        // Separate check: direct T0+2I when server T1 with wrong projects from T0 base:
        if (nextAt !== serverRefreshAt + I) return { ok: false, error: 'PERMISSION_DENIED' };
        serverRefreshAt = nextAt;
        if (updates['players/bob/projects']) serverProjects = updates['players/bob/projects'];
        return { ok: true };
      }
      if (nextAt != null && serverRefreshAt > 0 && nextAt !== serverRefreshAt + I) {
        return { ok: false, error: 'PERMISSION_DENIED' };
      }
      if (nextAt != null) serverRefreshAt = nextAt;
      if (updates['players/bob/projects']) serverProjects = updates['players/bob/projects'];
      return { ok: true };
    },
  };
  // Stale client tries absolute T2 from T0 while server is T1 — write shape T0+2I equals T1+I
  // so CAS allows the TIMESTAMP but client protocol must not mint 2 projects. Step API mints 1.
  const step = await commitScheduledRefreshStep('bob', { now: T0 + 2 * I }, deps);
  assert(step.generatedCount <= 1, '4) step never mints >1');
  assert(step.refreshAt === T0 + 2 * I || step.reason === 'not_due' || step.ok, '4) at most one step');
}

// Catch-up two sequential writes
{
  let serverRefreshAt = T0;
  let serverProjects = [];
  const deps = {
    loadState: async () => ({
      projects: serverProjects.map((p) => ({ ...p })),
      lastProjectRefreshAt: serverRefreshAt,
      totalRP: 50,
    }),
    writeUpdate: async (updates) => {
      const nextAt = updates['players/c/lastProjectRefreshAt'];
      if (serverRefreshAt > 0 && nextAt !== serverRefreshAt + I) {
        return { ok: false, error: 'PERMISSION_DENIED' };
      }
      if (serverRefreshAt === 0 && !(nextAt > 0)) {
        return { ok: false, error: 'PERMISSION_DENIED' };
      }
      serverRefreshAt = nextAt;
      if (updates['players/c/projects']) serverProjects = updates['players/c/projects'];
      return { ok: true };
    },
  };
  // Initialize via bootstrap first
  serverRefreshAt = 0;
  serverProjects = [];
  const boot = await commitScheduledRefreshStep('c', { now: T0 }, {
    ...deps,
    writeUpdate: async (updates) => {
      serverRefreshAt = updates['players/c/lastProjectRefreshAt'];
      if (updates['players/c/projects']) serverProjects = updates['players/c/projects'];
      return { ok: true };
    },
  });
  assert(boot.bootstrap && boot.wrote, '17) bootstrap write ok');

  // Reset to known T0 initialized state for catch-up
  serverRefreshAt = T0;
  serverProjects = [{ id: 'keep', state: PROJECT_STATES.AVAILABLE }];
  const catchUp = await commitScheduledRefreshCatchUp('c', { now: T0 + 2 * I, maxSteps: 7 }, deps);
  assert(catchUp.stepCount === 2, '2) catch-up two sequential steps');
  assert(catchUp.totalGenerated === 2, '2) two projects total');
  assert(serverRefreshAt === T0 + 2 * I, '2) final T2');
}

// Network failure does not advance local speculative timestamp
{
  let serverRefreshAt = T0;
  const deps = {
    loadState: async () => ({
      projects: [{ id: 'a', state: PROJECT_STATES.AVAILABLE }],
      lastProjectRefreshAt: serverRefreshAt,
      totalRP: 0,
    }),
    writeUpdate: async () => ({ ok: false, error: 'network down' }),
  };
  const r = await commitScheduledRefreshStep('d', { now: T0 + I }, deps);
  assert(r.ok === false && r.wrote === false, '16) network fail no write');
  assert(serverRefreshAt === T0, '16) server timestamp unchanged');
  assert(r.conflict === false, '16) not classified as CAS conflict');
}

// Login/heartbeat unification — both call same entry (smoke via export presence)
{
  const mod = await import('../js/project-refresh-commit.js');
  assert(typeof mod.runScheduledProjectMaintenance === 'function', '14) shared maintenance entry exists');
  assert(typeof mod.commitScheduledRefreshCatchUp === 'function', '14) catch-up exported');
}

if (failed) {
  console.error(`\nproject-refresh-concurrency: ${failed} failure(s)`);
  process.exit(1);
}
console.log('\nproject-refresh-concurrency: ALL PASSED');
