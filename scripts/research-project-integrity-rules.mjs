/**
 * Research Project Integrity — Firebase RTDB rules verification (A+B mutual gate).
 *
 * Run:
 *   npx firebase emulators:exec --only database "node scripts/research-project-integrity-rules.mjs"
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { ref, set, update, get } from 'firebase/database';
import { HISTORY_SERVER_TIMESTAMP } from '../js/player-history.js';
import {
  MAX_STORED_PROJECTS,
  getMaxStoredProjects,
} from '../js/project-refresh.js';
import { PROJECT_RULES_ARRAY_INDEX_MAX } from '../js/project-claims.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(resolve(__dirname, '../database.rules.json'), 'utf8');
const rulesJson = JSON.parse(rules);

function pass(msg) { console.log('PASS:', msg); }
function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }

async function expectPass(label, promise) {
  try {
    await assertSucceeds(promise);
    pass(label);
    return true;
  } catch (e) {
    fail(`${label}: ${e?.message || e}`);
    return false;
  }
}

async function expectFail(label, promise) {
  try {
    await assertFails(promise);
    pass(label);
    return true;
  } catch (e) {
    fail(`${label} (expected deny): ${e?.message || e}`);
    return false;
  }
}

async function readPath(db, path) {
  return (await get(ref(db, path))).val();
}

function marker(claimedAt) {
  return { claimedAt, schemaVersion: 1 };
}

function lb(username, value, updatedAt) {
  return { username, value, groupId: null, subgroupId: null, updatedAt };
}

function histClaim(username, projectId, rpDelta) {
  return {
    type: 'project_claimed',
    ts: HISTORY_SERVER_TIMESTAMP,
    schemaVersion: 1,
    actorType: 'self',
    source: 'project_claim',
    actorUsername: username,
    projectId,
    rpDelta,
    breakthrough: false,
    success: true,
  };
}

function histProposal(username, projectId, extra = {}) {
  return {
    type: 'research_proposal_used',
    ts: HISTORY_SERVER_TIMESTAMP,
    schemaVersion: 1,
    actorType: 'self',
    source: 'research_proposal',
    actorUsername: username,
    projectId,
    consumableId: 'research_proposal',
    quantity: 1,
    ...extra,
  };
}

function newClientClaim(o) {
  return {
    [`players/${o.username}/projects`]: o.projectsAfter,
    [`players/${o.username}/totalResearchPoints`]: o.toRp,
    [`players/${o.username}/currencies/currentResearchPoints`]: o.toRp,
    [`players/${o.username}/seasonalResearchPoints`]: o.toRp - o.fromRp,
    [`players/${o.username}/projectsCompleted`]: o.toCompleted,
    [`players/${o.username}/stats/projectSuccessStreak`]: o.toStreak,
    [`projectClaims/${o.username}/${o.projectId}`]: marker(o.claimedAt),
    [`playerHistory/${o.username}/${o.histId}`]: histClaim(o.username, o.projectId, o.toRp - o.fromRp),
    [`leaderboards/totalResearchPoints/${o.username}`]: lb(o.username, o.toRp, o.claimedAt),
    [`leaderboards/projectsCompleted/${o.username}`]: lb(o.username, o.toCompleted, o.claimedAt),
  };
}

function oldClientClaim(o) {
  const u = newClientClaim(o);
  delete u[`projectClaims/${o.username}/${o.projectId}`];
  return u;
}

function assertCapCoupling() {
  if (MAX_STORED_PROJECTS !== 7 || getMaxStoredProjects() !== 7) {
    fail(`app cap expected 7, got MAX=${MAX_STORED_PROJECTS} get=${getMaxStoredProjects()}`);
    return;
  }
  if (PROJECT_RULES_ARRAY_INDEX_MAX !== 6) {
    fail(`PROJECT_RULES_ARRAY_INDEX_MAX expected 6, got ${PROJECT_RULES_ARRAY_INDEX_MAX}`);
    return;
  }
  const validate = rulesJson.rules.players.$username.projects['.validate'] || '';
  if (!validate.includes(".child('6')")) {
    fail("rules projects.validate missing child('6')");
    return;
  }
  if (validate.includes(".child('7')")) {
    fail("rules projects.validate unexpectedly references child('7')");
    return;
  }
  if (validate.startsWith("root.child('admins')")) {
    fail('projects.validate must not short-circuit true for admins');
    return;
  }
  pass('array-cap coupling: app MAX=7 ↔ rules indices 0..6');
  pass('projects.validate has no admin claim bypass prefix');
}

async function seedAlice(testEnv) {
  await testEnv.clearDatabase();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await set(ref(ctx.database(), '/'), {
      admins: { adminUid: true },
      players: {
        alice: {
          authUid: 'aliceUid',
          totalResearchPoints: 100,
          seasonalResearchPoints: 0,
          currencies: { currentResearchPoints: 100 },
          projectsCompleted: 1,
          stats: { projectSuccessStreak: 2, bestProjectSuccessStreak: 2 },
          projects: [{ id: 'project_x', state: 'complete', title: 'Concurrent Target' }],
          items: { research_proposal: 1 },
        },
        bob: { authUid: 'bobUid', projects: [], items: {} },
      },
      leaderboards: {
        totalResearchPoints: { alice: lb('alice', 100, 1) },
        projectsCompleted: { alice: lb('alice', 1, 1) },
      },
    });
  });
}

async function main() {
  assertCapCoupling();

  const testEnv = await initializeTestEnvironment({
    projectId: 'qc-research-project-integrity',
    database: { rules, host: '127.0.0.1', port: 9000 },
  });

  try {
    // ------------------------------------------------------------------
    // 1 + 3) First claim + concurrent stale B
    // ------------------------------------------------------------------
    await seedAlice(testEnv);
    const claimedAt = 1700000000400;

    const clientA = newClientClaim({
      username: 'alice',
      projectId: 'project_x',
      claimedAt,
      histId: 'hist_claim_a',
      fromRp: 100,
      toRp: 140,
      toCompleted: 2,
      toStreak: 3,
      projectsAfter: [{ id: 'project_x', state: 'claimed', title: 'Concurrent Target', claimedAt }],
    });

    const clientB = newClientClaim({
      username: 'alice',
      projectId: 'project_x',
      claimedAt: claimedAt + 1,
      histId: 'hist_claim_b',
      fromRp: 100,
      toRp: 140,
      toCompleted: 2,
      toStreak: 3,
      projectsAfter: [{
        id: 'project_x',
        state: 'claimed',
        title: 'Concurrent Target',
        claimedAt: claimedAt + 1,
      }],
    });

    const alice = testEnv.authenticatedContext('aliceUid').database();
    await expectPass('1) NON-ADMIN NORMAL CLAIM SUCCESS', update(ref(alice), clientA));
    await expectFail('1b) DUPLICATE / concurrent stale B DENIED', update(ref(alice), clientB));

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      const m = await readPath(db, 'projectClaims/alice/project_x');
      const rp = await readPath(db, 'players/alice/totalResearchPoints');
      const done = await readPath(db, 'players/alice/projectsCompleted');
      const streak = await readPath(db, 'players/alice/stats/projectSuccessStreak');
      const projects = await readPath(db, 'players/alice/projects');
      const ha = await readPath(db, 'playerHistory/alice/hist_claim_a');
      const hb = await readPath(db, 'playerHistory/alice/hist_claim_b');
      const lbRp = await readPath(db, 'leaderboards/totalResearchPoints/alice');
      const lbPc = await readPath(db, 'leaderboards/projectsCompleted/alice');

      if (m?.schemaVersion === 1 && m?.claimedAt === claimedAt) pass('canonical: one marker');
      else fail(`marker=${JSON.stringify(m)}`);
      if (rp === 140) pass('canonical: one RP increase');
      else fail(`RP=${rp}`);
      if (done === 2) pass('canonical: one projectsCompleted increase');
      else fail(`projectsCompleted=${done}`);
      if (streak === 3) pass('canonical: one streak consequence');
      else fail(`streak=${streak}`);
      if (projects?.[0]?.state === 'claimed') pass('canonical: project CLAIMED');
      else fail(`projects=${JSON.stringify(projects)}`);
      if (ha && !hb) pass('canonical: one project_claimed history');
      else fail(`histA=${!!ha} histB=${!!hb}`);
      if (lbRp?.value === 140 && lbPc?.value === 2) pass('canonical: one LB consequence pair');
      else fail(`lbRp=${JSON.stringify(lbRp)} lbPc=${JSON.stringify(lbPc)}`);
    });

    // ------------------------------------------------------------------
    // Marker guards (post-claim)
    // ------------------------------------------------------------------
    {
      const a = testEnv.authenticatedContext('aliceUid').database();
      const b = testEnv.authenticatedContext('bobUid').database();
      const admin = testEnv.authenticatedContext('adminUid').database();

      await expectFail('11) MARKER OVERWRITE DENIED', set(ref(a, 'projectClaims/alice/project_x'), marker(999)));
      await expectFail('12) MARKER STUDENT DELETE DENIED', set(ref(a, 'projectClaims/alice/project_x'), null));
      await expectFail('student cannot write foreign marker', set(ref(b, 'projectClaims/alice/forged'), marker(1)));
      await expectFail('duplicate marker create denied', set(ref(a, 'projectClaims/alice/project_x'), marker(claimedAt)));
      await expectFail('8) MARKER PRE-CREATE (marker-only) DENIED', set(ref(a, 'projectClaims/alice/marker_only'), marker(2)));

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await set(ref(ctx.database(), 'projectClaims/bob/keep'), marker(1));
      });
      await expectPass('13) ADMIN wipe alice claim tree', set(ref(admin, 'projectClaims/alice'), null));
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const at = await readPath(ctx.database(), 'projectClaims/alice');
        const bk = await readPath(ctx.database(), 'projectClaims/bob/keep');
        if (at == null) pass('alice claim tree wiped');
        else fail('alice claim tree remains');
        if (bk != null) pass('bob ledger untouched');
        else fail('bob ledger wiped');
      });
    }

    // ------------------------------------------------------------------
    // 4) Old-client marker-less
    // ------------------------------------------------------------------
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'players/carol'), {
        authUid: 'carolUid',
        totalResearchPoints: 50,
        seasonalResearchPoints: 0,
        currencies: { currentResearchPoints: 50 },
        projectsCompleted: 0,
        stats: { projectSuccessStreak: 0, bestProjectSuccessStreak: 0 },
        projects: [{ id: 'project_old', state: 'complete', title: 'Old Client Target' }],
        items: { research_proposal: 2 },
      });
      await set(ref(ctx.database(), 'leaderboards/totalResearchPoints/carol'), lb('carol', 50, 1));
      await set(ref(ctx.database(), 'leaderboards/projectsCompleted/carol'), lb('carol', 0, 1));
    });

    const carol = testEnv.authenticatedContext('carolUid').database();
    const t0 = 1700000100000;

    await expectFail(
      '2) NON-ADMIN OLD-CLIENT marker-less claim DENIED',
      update(ref(carol), oldClientClaim({
        username: 'carol',
        projectId: 'project_old',
        claimedAt: t0,
        histId: 'hist_old_first',
        fromRp: 50,
        toRp: 90,
        toCompleted: 1,
        toStreak: 1,
        projectsAfter: [{ id: 'project_old', state: 'claimed', title: 'Old Client Target', claimedAt: t0 }],
      })),
    );

    // ------------------------------------------------------------------
    // 3–7) Admin bypass closed + Admin Complete two-phase shapes
    // ------------------------------------------------------------------
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      // Player whose authUid is also an admin — previously could bypass validate.
      await set(ref(ctx.database(), 'players/teach'), {
        authUid: 'adminUid',
        totalResearchPoints: 20,
        seasonalResearchPoints: 0,
        currencies: { currentResearchPoints: 20 },
        projectsCompleted: 0,
        stats: { projectSuccessStreak: 0 },
        projects: [
          { id: 'project_admin_claim', state: 'complete', title: 'Admin Claim Target' },
          { id: 'project_admin_active', state: 'active', title: 'Admin Active', startedAt: 1, completesAt: 9 },
        ],
      });
      await set(ref(ctx.database(), 'leaderboards/totalResearchPoints/teach'), lb('teach', 20, 1));
      await set(ref(ctx.database(), 'leaderboards/projectsCompleted/teach'), lb('teach', 0, 1));
    });

    const teachAdmin = testEnv.authenticatedContext('adminUid').database();
    const tAdmin = 1700000150000;

    await expectFail(
      '3) ADMIN OLD CLIENT marker-less COMPLETE→CLAIMED DENIED',
      update(ref(teachAdmin), oldClientClaim({
        username: 'teach',
        projectId: 'project_admin_claim',
        claimedAt: tAdmin,
        histId: 'hist_admin_old',
        fromRp: 20,
        toRp: 60,
        toCompleted: 1,
        toStreak: 1,
        projectsAfter: [
          { id: 'project_admin_claim', state: 'claimed', title: 'Admin Claim Target', claimedAt: tAdmin },
          { id: 'project_admin_active', state: 'active', title: 'Admin Active', startedAt: 1, completesAt: 9 },
        ],
      })),
    );

    await expectPass(
      '4) ADMIN LEGITIMATE COMPLETE→CLAIMED WITH MARKER PASS',
      update(ref(teachAdmin), newClientClaim({
        username: 'teach',
        projectId: 'project_admin_claim',
        claimedAt: tAdmin + 1,
        histId: 'hist_admin_ok',
        fromRp: 20,
        toRp: 60,
        toCompleted: 1,
        toStreak: 1,
        projectsAfter: [
          { id: 'project_admin_claim', state: 'claimed', title: 'Admin Claim Target', claimedAt: tAdmin + 1 },
          { id: 'project_admin_active', state: 'active', title: 'Admin Active', startedAt: 1, completesAt: 9 },
        ],
      })),
    );

    await expectPass(
      '5) ADMIN FORCE COMPLETE Phase1 ACTIVE→COMPLETE only PASS',
      update(ref(teachAdmin), {
        'players/teach/projects': [
          { id: 'project_admin_claim', state: 'claimed', title: 'Admin Claim Target', claimedAt: tAdmin + 1 },
          {
            id: 'project_admin_active',
            state: 'complete',
            title: 'Admin Active',
            startedAt: 1,
            completesAt: 9,
            completedAt: tAdmin + 2,
            outcome: { success: true },
            rewards: { success: true, rpEarned: 15 },
          },
        ],
      }),
    );

    await expectPass(
      '6) ADMIN COMPLETE Phase2 canonical claim PASS',
      update(ref(teachAdmin), newClientClaim({
        username: 'teach',
        projectId: 'project_admin_active',
        claimedAt: tAdmin + 3,
        histId: 'hist_admin_phase2',
        fromRp: 60,
        toRp: 75,
        toCompleted: 2,
        toStreak: 2,
        projectsAfter: [
          { id: 'project_admin_claim', state: 'claimed', title: 'Admin Claim Target', claimedAt: tAdmin + 1 },
          {
            id: 'project_admin_active',
            state: 'claimed',
            title: 'Admin Active',
            claimedAt: tAdmin + 3,
            outcome: { success: true },
            rewards: { success: true, rpEarned: 15 },
          },
        ],
      })),
    );

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'players/teach2'), {
        authUid: 'adminUid',
        totalResearchPoints: 0,
        currencies: { currentResearchPoints: 0 },
        projectsCompleted: 0,
        stats: { projectSuccessStreak: 0 },
        projects: [{
          id: 'project_one_step',
          state: 'active',
          title: 'Broken One Step',
          startedAt: 1,
          completesAt: 2,
        }],
      });
      await set(ref(ctx.database(), 'leaderboards/totalResearchPoints/teach2'), lb('teach2', 0, 1));
      await set(ref(ctx.database(), 'leaderboards/projectsCompleted/teach2'), lb('teach2', 0, 1));
    });

    await expectFail(
      '7) OLD BROKEN one-step ACTIVE→CLAIMED+marker DENIED',
      update(ref(teachAdmin), newClientClaim({
        username: 'teach2',
        projectId: 'project_one_step',
        claimedAt: tAdmin + 9,
        histId: 'hist_one_step',
        fromRp: 0,
        toRp: 10,
        toCompleted: 1,
        toStreak: 1,
        projectsAfter: [{
          id: 'project_one_step',
          state: 'claimed',
          title: 'Broken One Step',
          claimedAt: tAdmin + 9,
        }],
      })),
    );

    // Admin cannot resurrect CLAIMED either
    await expectFail(
      '9b) ADMIN CLAIMED→COMPLETE resurrection DENIED',
      update(ref(teachAdmin), {
        'players/teach/projects': [
          { id: 'project_admin_claim', state: 'complete', title: 'Admin Claim Target' },
          {
            id: 'project_admin_active',
            state: 'claimed',
            title: 'Admin Active',
            claimedAt: tAdmin + 3,
          },
        ],
      }),
    );

    // ------------------------------------------------------------------
    // 8) CRITICAL: COMPLETE + preexisting marker → CLAIMED DENIED
    // ------------------------------------------------------------------
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'players/erin'), {
        authUid: 'erinUid',
        totalResearchPoints: 10,
        seasonalResearchPoints: 0,
        currencies: { currentResearchPoints: 10 },
        projectsCompleted: 0,
        stats: { projectSuccessStreak: 0 },
        projects: [{ id: 'project_p', state: 'complete', title: 'Inconsistent' }],
      });
      await set(ref(ctx.database(), 'projectClaims/erin/project_p'), marker(1));
      await set(ref(ctx.database(), 'leaderboards/totalResearchPoints/erin'), lb('erin', 10, 1));
      await set(ref(ctx.database(), 'leaderboards/projectsCompleted/erin'), lb('erin', 0, 1));
    });
    const erin = testEnv.authenticatedContext('erinUid').database();
    const tErin = 1700000200000;
    await expectFail(
      '8) COMPLETE + preexisting marker + rewards DENIED',
      update(ref(erin), {
        'players/erin/projects': [{ id: 'project_p', state: 'claimed', title: 'Inconsistent', claimedAt: tErin }],
        'players/erin/totalResearchPoints': 50,
        'players/erin/currencies/currentResearchPoints': 50,
        'players/erin/projectsCompleted': 1,
        'players/erin/stats/projectSuccessStreak': 1,
        'playerHistory/erin/hist_erin': histClaim('erin', 'project_p', 40),
        'leaderboards/totalResearchPoints/erin': lb('erin', 50, tErin),
        'leaderboards/projectsCompleted/erin': lb('erin', 1, tErin),
      }),
    );
    await expectFail(
      '8b) COMPLETE + preexisting marker projects-only heal DENIED',
      update(ref(erin), {
        'players/erin/projects': [{ id: 'project_p', state: 'claimed', title: 'Inconsistent', claimedAt: tErin }],
      }),
    );

    // ------------------------------------------------------------------
    // 6 persistence / 9 resurrection (fran)
    // ------------------------------------------------------------------
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'players/fran'), {
        authUid: 'franUid',
        projects: [
          { id: 'project_c', state: 'claimed', title: 'Done', claimedAt: 1 },
          { id: 'project_a', state: 'available', title: 'Open' },
        ],
      });
      await set(ref(ctx.database(), 'projectClaims/fran/project_c'), marker(1));
    });
    const fran = testEnv.authenticatedContext('franUid').database();
    await expectPass(
      '10) EXISTING CLAIMED persistence SUCCESS',
      update(ref(fran), {
        'players/fran/projects': [
          { id: 'project_c', state: 'claimed', title: 'Done', claimedAt: 1, reportViewed: true },
          { id: 'project_a', state: 'available', title: 'Open' },
        ],
      }),
    );

    // ------------------------------------------------------------------
    // 9) Resurrection
    // ------------------------------------------------------------------
    await expectFail(
      '9) CLAIMED → COMPLETE resurrection DENIED',
      update(ref(fran), {
        'players/fran/projects': [
          { id: 'project_c', state: 'complete', title: 'Done' },
          { id: 'project_a', state: 'available', title: 'Open' },
        ],
      }),
    );

    // ------------------------------------------------------------------
    // 9–10) Marker A / claim B; nonexistent
    // ------------------------------------------------------------------
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'players/gina'), {
        authUid: 'ginaUid',
        projects: [
          { id: 'project_a', state: 'complete', title: 'A' },
          { id: 'project_b', state: 'complete', title: 'B' },
        ],
        totalResearchPoints: 0,
        currencies: { currentResearchPoints: 0 },
        projectsCompleted: 0,
        stats: { projectSuccessStreak: 0 },
      });
      await set(ref(ctx.database(), 'leaderboards/totalResearchPoints/gina'), lb('gina', 0, 1));
      await set(ref(ctx.database(), 'leaderboards/projectsCompleted/gina'), lb('gina', 0, 1));
    });
    const gina = testEnv.authenticatedContext('ginaUid').database();

    await expectFail(
      '9) MARKER A while claiming B DENIED',
      update(ref(gina), {
        'players/gina/projects': [
          { id: 'project_a', state: 'complete', title: 'A' },
          { id: 'project_b', state: 'claimed', title: 'B', claimedAt: 10 },
        ],
        'projectClaims/gina/project_a': marker(10),
      }),
    );
    await expectFail(
      '10) NONEXISTENT PROJECT MARKER DENIED',
      set(ref(gina, 'projectClaims/gina/no_such_project'), marker(11)),
    );

    // ------------------------------------------------------------------
    // 14) Unrelated project transitions + Proposal
    // ------------------------------------------------------------------
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'players/dave'), {
        authUid: 'daveUid',
        totalResearchPoints: 10,
        currencies: { currentResearchPoints: 10 },
        projectsCompleted: 0,
        lastProjectRefreshAt: 1700000000000,
        projects: [{ id: 'project_existing', state: 'available', title: 'Existing' }],
        items: { research_proposal: 1 },
      });
    });

    const dave = testEnv.authenticatedContext('daveUid').database();
    const bob = testEnv.authenticatedContext('bobUid').database();

    await expectPass(
      '14a) AVAILABLE → ACTIVE',
      update(ref(dave), {
        'players/dave/projects': [{
          id: 'project_existing',
          state: 'active',
          title: 'Existing',
          startedAt: 1,
          completesAt: 2,
        }],
      }),
    );
    await expectPass(
      '14b) ACTIVE → COMPLETE',
      update(ref(dave), {
        'players/dave/projects': [{
          id: 'project_existing',
          state: 'complete',
          title: 'Existing',
          startedAt: 1,
          completesAt: 2,
          completedAt: 3,
        }],
      }),
    );

    const genId = 'project_proposal_gen_1';
    await expectPass(
      '14c) Proposal multipath succeeds',
      update(ref(dave), {
        'players/dave/projects': [
          { id: 'project_existing', state: 'complete', title: 'Existing', completedAt: 3 },
          { id: genId, state: 'available', title: 'From Proposal' },
        ],
        'players/dave/items/research_proposal': 0,
        'playerHistory/dave/hist_proposal_ok': histProposal('dave', genId),
      }),
    );

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      const qty = await readPath(db, 'players/dave/items/research_proposal');
      const projects = await readPath(db, 'players/dave/projects');
      const hist = await readPath(db, 'playerHistory/dave/hist_proposal_ok');
      const refresh = await readPath(db, 'players/dave/lastProjectRefreshAt');
      if (qty === 0) pass('proposal consumed once');
      else fail(`qty=${qty}`);
      if (Array.isArray(projects) && projects.length === 2 && projects.some((p) => p?.id === genId)) {
        pass('exactly one additional proposal project');
      } else fail(`projects=${JSON.stringify(projects)}`);
      if (hist?.type === 'research_proposal_used' && hist?.projectId === genId) {
        pass('research_proposal_used history present');
      } else fail(`hist=${JSON.stringify(hist)}`);
      if (refresh === 1700000000000) pass('lastProjectRefreshAt unchanged');
      else fail(`refresh=${refresh}`);
    });

    await expectFail(
      'forged Proposal history denied',
      set(ref(dave, 'playerHistory/dave/hist_proposal_bad'), histProposal('dave', genId, { source: 'forged' })),
    );
    await expectFail(
      'foreign Proposal history denied',
      set(ref(bob, 'playerHistory/dave/hist_proposal_foreign'), histProposal('dave', genId)),
    );

    // Claim then prune
    const tDaveClaim = 1700000300000;
    await expectPass(
      '14e) claim COMPLETE project_existing',
      update(ref(dave), newClientClaim({
        username: 'dave',
        projectId: 'project_existing',
        claimedAt: tDaveClaim,
        histId: 'hist_dave_claim',
        fromRp: 10,
        toRp: 25,
        toCompleted: 1,
        toStreak: 1,
        projectsAfter: [
          { id: 'project_existing', state: 'claimed', title: 'Existing', claimedAt: tDaveClaim },
          { id: genId, state: 'available', title: 'From Proposal' },
        ],
      })),
    );
    await expectPass(
      '14f) prune CLAIMED from array',
      update(ref(dave), {
        'players/dave/projects': [
          { id: genId, state: 'available', title: 'From Proposal' },
        ],
      }),
    );
    await expectPass(
      '14d) scheduled generation (extra AVAILABLE)',
      update(ref(dave), {
        'players/dave/projects': [
          { id: genId, state: 'available', title: 'From Proposal' },
          { id: 'project_gen', state: 'available', title: 'Generated' },
        ],
      }),
    );

    // ------------------------------------------------------------------
    // 15) Unrelated gameplay
    // ------------------------------------------------------------------
    await expectPass(
      '15a) shop-shaped RP spend',
      update(ref(dave), {
        'players/dave/currencies/currentResearchPoints': 5,
        'players/dave/items/some_cosmetic': 1,
      }),
    );
    await expectPass(
      '15b) pack-shaped inventory bump',
      update(ref(dave), {
        'players/dave/inventory/card_demo': 1,
        'players/dave/stats/cardsCollected': 1,
      }),
    );
    await expectPass(
      '15c) weekly pack_granted history',
      set(ref(dave, 'playerHistory/dave/hist_weekly'), {
        type: 'pack_granted',
        ts: HISTORY_SERVER_TIMESTAMP,
        schemaVersion: 1,
        actorType: 'system',
        source: 'weekly_research_pack',
        reason: 'weekly',
        actorUsername: 'dave',
        packId: 'weekly_pack',
      }),
    );
    await expectPass(
      '15d) profile/cosmetic owner field',
      update(ref(dave), {
        'players/dave/equippedFrame': 'frame_1',
      }),
    );
  } catch (e) {
    fail(`EMULATOR/TEST ERROR: ${e?.message || e}`);
    console.error(e);
  } finally {
    await testEnv.cleanup();
  }

  if (process.exitCode) {
    console.error('\nresearch-project-integrity-rules: FAILED');
    process.exit(1);
  }
  console.log('\nresearch-project-integrity-rules: all checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
