/**
 * project-claims.js — Canonical claim-once ledger + CLAIMED-preserving project merges.
 *
 * Ledger path: projectClaims/{username}/{projectId}
 * - Create-once on successful claim (same multipath as rewards)
 * - Never expires with history retention
 * - Not observational history
 *
 * Server invariant (database.rules.json A+B coupling):
 * - COMPLETE → CLAIMED requires a FRESH marker create in the same atomic write
 * - A preexisting marker does NOT authorize COMPLETE → CLAIMED (already consumed)
 * - Rules inspect projects array indices 0..PROJECT_RULES_ARRAY_INDEX_MAX only
 *   (must stay aligned with MAX_STORED_PROJECTS in project-refresh.js)
 */

import * as db from './database.js';
import { PROJECT_STATES } from './project-state.js'; // AVAILABLE | ACTIVE | COMPLETE | CLAIMED
import { MAX_STORED_PROJECTS } from './project-refresh.js';

export const PROJECT_CLAIMS_ROOT = 'projectClaims';

/** Inclusive max array index inspected by RTDB claim rules (0..6 for cap 7). */
export const PROJECT_RULES_ARRAY_INDEX_MAX = MAX_STORED_PROJECTS - 1;

if (PROJECT_RULES_ARRAY_INDEX_MAX !== 6) {
  throw new Error(
    `[project-claims] PROJECT_RULES_ARRAY_INDEX_MAX=${PROJECT_RULES_ARRAY_INDEX_MAX} but database.rules.json claim coupling hardcodes indices 0..6`,
  );
}

/**
 * @param {string} username
 * @returns {string}
 */
export function projectClaimsUserPath(username) {
  return `${PROJECT_CLAIMS_ROOT}/${String(username || '').trim()}`;
}

/**
 * @param {string} username
 * @param {string} projectId
 * @returns {string}
 */
export function projectClaimMarkerPath(username, projectId) {
  return `${projectClaimsUserPath(username)}/${String(projectId || '').trim()}`;
}

/**
 * Permanent account deletion: wipe the whole claim ledger for a username.
 * @param {string} username
 * @returns {Record<string, null>}
 */
export function buildProjectClaimsTreeDeleteUpdate(username) {
  const key = String(username || '').trim();
  if (!key) return {};
  return { [projectClaimsUserPath(key)]: null };
}

/**
 * Leaf for first successful claim of projectId (immutable thereafter).
 * @param {string} username
 * @param {string} projectId
 * @param {number} [claimedAt]
 * @returns {{ path: string, updates: Record<string, object> }}
 */
export function buildProjectClaimMarkerUpdate(username, projectId, claimedAt = Date.now()) {
  const path = projectClaimMarkerPath(username, projectId);
  const ts = Number.isFinite(Number(claimedAt)) ? Number(claimedAt) : Date.now();
  return {
    path,
    updates: {
      [path]: {
        claimedAt: ts,
        schemaVersion: 1,
      },
    },
  };
}

/**
 * Never downgrade CLAIMED → COMPLETE (or other non-CLAIMED) when both sides share an id.
 * Intentional omission of a CLAIMED id from incoming (prune) is allowed.
 *
 * @param {object[]} incoming
 * @param {object[]} authoritative
 * @returns {object[]}
 */
export function mergeProjectsPreservingClaimed(incoming, authoritative) {
  const incomingList = Array.isArray(incoming) ? incoming : [];
  const authList = Array.isArray(authoritative) ? authoritative : [];
  /** @type {Map<string, object>} */
  const authById = new Map();
  for (const p of authList) {
    const id = p && p.id != null ? String(p.id) : '';
    if (id) authById.set(id, p);
  }

  return incomingList.map((p) => {
    if (!p || p.id == null) return p;
    const id = String(p.id);
    const prior = authById.get(id);
    if (
      prior
      && prior.state === PROJECT_STATES.CLAIMED
      && p.state !== PROJECT_STATES.CLAIMED
    ) {
      return prior;
    }
    return p;
  });
}

/**
 * If a claim ledger marker exists for a project still shown as COMPLETE (etc.),
 * force CLAIMED so rewards cannot be offered again.
 *
 * @param {object[]} projects
 * @param {Record<string, unknown>|null|undefined} claimMap
 * @returns {object[]}
 */
export function applyClaimLedgerToProjects(projects, claimMap) {
  const list = Array.isArray(projects) ? projects : [];
  if (!claimMap || typeof claimMap !== 'object') return list;
  return list.map((p) => {
    if (!p || p.id == null) return p;
    const id = String(p.id);
    if (!Object.prototype.hasOwnProperty.call(claimMap, id)) return p;
    if (p.state === PROJECT_STATES.CLAIMED) return p;
    const claimedAt = claimMap[id] && typeof claimMap[id] === 'object'
      ? Number(/** @type {{ claimedAt?: unknown }} */ (claimMap[id]).claimedAt)
      : NaN;
    return {
      ...p,
      state: PROJECT_STATES.CLAIMED,
      claimedAt: Number.isFinite(claimedAt) ? claimedAt : (p.claimedAt ?? Date.now()),
      reportViewed: true,
    };
  });
}

/**
 * Server-fresh projects, then merge local intended array safely for persist.
 *
 * Does NOT applyClaimLedgerToProjects before write: RTDB denies COMPLETE→CLAIMED
 * when a marker already exists (claim right consumed). Ledger force-CLAIMED is
 * for UI / local reconcile only.
 *
 * @param {string} username
 * @param {object[]} localProjects
 * @returns {Promise<object[]>}
 */
export async function prepareProjectsForPersist(username, localProjects) {
  const key = String(username || '').trim();
  if (!key) return Array.isArray(localProjects) ? localProjects : [];

  try {
    await db.loadPathOnce(`players/${key}/projects`, { force: true });
  } catch { /* best-effort */ }

  const serverProjects = db.get(`players/${key}/projects`) || [];
  return mergeProjectsPreservingClaimed(localProjects, serverProjects);
}

/**
 * After a rejected duplicate / already-consumed claim: force CLAIMED in the
 * local cache only (no rewards).
 *
 * Server rules reject COMPLETE→CLAIMED when the marker already exists, so this
 * must not attempt an acknowledged projects write for that heal.
 *
 * @param {string} username
 * @param {string} projectId
 * @returns {Promise<{ ok: boolean, repaired: boolean, localOnly?: boolean }>}
 */
export async function reconcileAlreadyClaimedProject(username, projectId) {
  const key = String(username || '').trim();
  const id = String(projectId || '').trim();
  if (!key || !id) return { ok: false, repaired: false };

  try {
    await db.loadPathOnce(`players/${key}/projects`, { force: true });
    await db.loadPathOnce(projectClaimMarkerPath(key, id), { force: true });
  } catch { /* best-effort */ }

  const marker = db.get(projectClaimMarkerPath(key, id));
  const projects = Array.isArray(db.get(`players/${key}/projects`))
    ? [...db.get(`players/${key}/projects`)]
    : [];
  const idx = projects.findIndex((p) => p && String(p.id) === id);
  if (idx < 0) {
    return { ok: true, repaired: false, localOnly: true };
  }

  const current = projects[idx];
  if (current.state === PROJECT_STATES.CLAIMED) {
    return { ok: true, repaired: false, localOnly: true };
  }

  const claimedAt = marker && typeof marker === 'object'
    ? Number(marker.claimedAt)
    : Date.now();
  projects[idx] = {
    ...current,
    state: PROJECT_STATES.CLAIMED,
    claimedAt: Number.isFinite(claimedAt) ? claimedAt : Date.now(),
    reportViewed: true,
  };

  // Local cache only — server forbids COMPLETE→CLAIMED with preexisting marker.
  db.set(`players/${key}/projects`, projects);
  return { ok: true, repaired: true, localOnly: true };
}

/**
 * @param {string} username
 * @param {string} projectId
 * @returns {Promise<boolean>}
 */
export async function loadProjectClaimMarkerExists(username, projectId) {
  const path = projectClaimMarkerPath(username, projectId);
  try {
    await db.loadPathOnce(path, { force: true });
  } catch {
    return false;
  }
  return db.get(path) != null;
}
