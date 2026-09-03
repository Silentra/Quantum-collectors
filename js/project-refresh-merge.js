/**
 * project-refresh-merge.js
 * Server-fresh merge helpers for scheduled refresh persistence.
 *
 * Refresh must never replace the server projects array with a stale client array.
 */

import { PROJECT_STATES } from './project-state.js';

const LIFECYCLE_RANK = {
  [PROJECT_STATES.AVAILABLE]: 1,
  [PROJECT_STATES.ACTIVE]: 2,
  [PROJECT_STATES.COMPLETE]: 3,
  [PROJECT_STATES.CLAIMED]: 4,
};

/**
 * @param {object|null|undefined} project
 * @returns {number}
 */
export function projectLifecycleRank(project) {
  if (!project || typeof project !== 'object') return 0;
  return LIFECYCLE_RANK[project.state] || 0;
}

/**
 * Prefer higher lifecycle; on equal rank prefer server (first arg).
 * Never strip outcome/rewards from COMPLETE/CLAIMED when keeping that side.
 *
 * @param {object} serverProject
 * @param {object} localProject
 * @returns {object}
 */
export function preferProjectForRefreshMerge(serverProject, localProject) {
  if (!serverProject) return localProject;
  if (!localProject) return serverProject;

  const sRank = projectLifecycleRank(serverProject);
  const lRank = projectLifecycleRank(localProject);

  if (lRank > sRank) {
    return preserveRewardPackage(localProject, serverProject);
  }
  // Equal or server higher: keep server, but restore reward package if local has it
  // and server somehow lost it on same COMPLETE/CLAIMED id (defensive).
  return preserveRewardPackage(serverProject, localProject);
}

/**
 * @param {object} primary
 * @param {object} secondary
 * @returns {object}
 */
function preserveRewardPackage(primary, secondary) {
  if (!primary || typeof primary !== 'object') return primary;
  const needPackage =
    primary.state === PROJECT_STATES.COMPLETE
    || primary.state === PROJECT_STATES.CLAIMED;
  if (!needPackage) return primary;
  if (primary.rewards != null || primary.outcome != null) return primary;
  if (secondary && (secondary.rewards != null || secondary.outcome != null)) {
    return {
      ...primary,
      ...(secondary.outcome != null ? { outcome: secondary.outcome } : {}),
      ...(secondary.rewards != null ? { rewards: secondary.rewards } : {}),
    };
  }
  return primary;
}

/**
 * Build the projects array for a scheduled refresh persist.
 *
 * - Preserves every server-only row (AVAILABLE/ACTIVE/COMPLETE/CLAIMED)
 * - Appends only newly minted scheduled projects from this accepted plan
 * - Same-id: lifecycle precedence (CLAIMED > COMPLETE > ACTIVE > AVAILABLE);
 *   equal rank prefers server
 * - Does NOT re-union pruned CLAIMED from a stale local list (refresh does not prune;
 *   prune is a separate mutation that writes its own server-fresh list)
 *
 * @param {object[]} serverProjects
 * @param {object[]} newlyGeneratedProjects
 * @returns {object[]}
 */
export function buildRefreshPersistProjects(serverProjects, newlyGeneratedProjects = []) {
  const server = Array.isArray(serverProjects) ? serverProjects.filter(Boolean) : [];
  const generated = Array.isArray(newlyGeneratedProjects)
    ? newlyGeneratedProjects.filter((p) => p && p.id != null)
    : [];

  const serverById = new Map();
  for (const p of server) {
    if (p.id == null) continue;
    serverById.set(String(p.id), p);
  }

  const out = server.map((p) => p);
  for (const neu of generated) {
    const id = String(neu.id);
    if (serverById.has(id)) {
      const idx = out.findIndex((p) => p && String(p.id) === id);
      if (idx >= 0) {
        out[idx] = preferProjectForRefreshMerge(out[idx], neu);
      }
      continue;
    }
    out.push(neu);
  }
  return out;
}

/**
 * Merge local lifecycle intent onto a server-fresh list without dropping
 * server-only ids. Used when resolve/prune compute a next array from a
 * server snapshot (prune may omit CLAIMED — that omit is intentional).
 *
 * @param {object[]} serverProjects - force-read server list before local intent
 * @param {object[]} intendedProjects - resolve/prune output from that same snapshot
 * @returns {object[]}
 */
export function mergeLifecyclePersistProjects(serverProjects, intendedProjects) {
  const server = Array.isArray(serverProjects) ? serverProjects.filter(Boolean) : [];
  const intended = Array.isArray(intendedProjects) ? intendedProjects.filter(Boolean) : [];

  const intendedById = new Map();
  for (const p of intended) {
    if (p?.id == null) continue;
    intendedById.set(String(p.id), p);
  }

  // Intentional prune: ids absent from intended are dropped (CLAIMED age-out).
  // For ids present on both, apply lifecycle precedence preferring upgrades.
  const out = [];
  const seen = new Set();

  for (const p of intended) {
    if (!p || p.id == null) continue;
    const id = String(p.id);
    seen.add(id);
    const serverP = server.find((s) => s && String(s.id) === id);
    out.push(serverP ? preferProjectForRefreshMerge(serverP, p) : p);
  }

  // Preserve server-only non-CLAIMED rows that resolve/prune forgot
  // (should not happen if intended was derived from server; defensive).
  for (const s of server) {
    if (!s || s.id == null) continue;
    const id = String(s.id);
    if (seen.has(id)) continue;
    if (s.state === PROJECT_STATES.CLAIMED) {
      // Omitted CLAIMED from prune intent — stay omitted.
      continue;
    }
    out.push(s);
  }

  return out;
}
