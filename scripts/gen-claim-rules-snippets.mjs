/**
 * Generates RTDB rule expression snippets for project claim A+B coupling
 * and lastProjectRefreshAt one-cycle CAS.
 * Indices 0..6 match getMaxStoredProjects() === 7.
 *
 * COUPLING: PROJECT_REFRESH_INTERVAL_MS must match js/project-refresh.js
 * (12 * 60 * 60 * 1000). Do not change one without the other.
 */
import { writeFileSync } from 'node:fs';

const IDX = [0, 1, 2, 3, 4, 5, 6];

/** Must match PROJECT_REFRESH_INTERVAL_MS in js/project-refresh.js */
export const PROJECT_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

function hasState(arrExpr, idExpr, state) {
  return `(${IDX.map((i) =>
    `(${arrExpr}.child('${i}').child('id').val() === ${idExpr} && ${arrExpr}.child('${i}').child('state').val() === '${state}')`
  ).join(' || ')})`;
}

function present(arrExpr, idExpr) {
  return `(${IDX.map((i) =>
    `(${arrExpr}.child('${i}').child('id').val() === ${idExpr})`
  ).join(' || ')})`;
}

const newRootClaims = "newData.parent().parent().parent().child('projectClaims').child($username)";
const rootClaims = "root.child('projectClaims').child($username)";
const rootProjects = "root.child('players').child($username).child('projects')";
const newRootProjectsFromMarker = "newData.parent().parent().parent().child('players').child($username).child('projects')";

const newlyOk = IDX.map((j) => {
  const id = `newData.child('${j}').child('id').val()`;
  return `(!newData.child('${j}').exists() || newData.child('${j}').child('state').val() !== 'claimed' || !newData.child('${j}').child('id').isString() || ${hasState('data', id, 'claimed')} || (${hasState('data', id, 'complete')} && !${rootClaims}.child(${id}).exists() && ${newRootClaims}.child(${id}).exists()))`;
}).join(' && ');

const noResurrect = IDX.map((i) => {
  const id = `data.child('${i}').child('id').val()`;
  return `(!data.child('${i}').exists() || data.child('${i}').child('state').val() !== 'claimed' || !data.child('${i}').child('id').isString() || !${present('newData', id)} || ${hasState('newData', id, 'claimed')})`;
}).join(' && ');

// Claim-once + no-resurrection bind ALL writers including admins.
const projectsValidate = `!newData.exists() || ((${newlyOk}) && (${noResurrect}))`;

const markerClaimGate = `${hasState(rootProjects, '$projectId', 'complete')} && !${hasState(rootProjects, '$projectId', 'claimed')} && ${hasState(newRootProjectsFromMarker, '$projectId', 'claimed')}`;

const ownerWrite =
  "auth != null && (root.child('admins').child(auth.uid).val() === true || (root.child('players').child($username).child('authUid').val() === auth.uid && root.child('playerLocks').child($username).child('locked').val() !== true && root.child('playerLocksByUid').child(auth.uid).child('locked').val() !== true) || (!root.child('players').child($username).exists() && newData.parent().child('authUid').val() === auth.uid))";

const markerWrite =
  `auth != null && ((!data.exists() && newData.exists() && root.child('players').child($username).child('authUid').val() === auth.uid && root.child('playerLocks').child($username).child('locked').val() !== true && root.child('playerLocksByUid').child(auth.uid).child('locked').val() !== true && (${markerClaimGate})) || (root.child('admins').child(auth.uid).val() === true && !newData.exists()))`;

// lastProjectRefreshAt: owner may not delete (no bootstrap abuse via clear→reinit).
// Admin may delete for account cleanup. Sets obey bootstrap OR exact one-interval step.
const refreshAtWrite =
  "auth != null && (root.child('admins').child(auth.uid).val() === true || ((root.child('players').child($username).child('authUid').val() === auth.uid && root.child('playerLocks').child($username).child('locked').val() !== true && root.child('playerLocksByUid').child(auth.uid).child('locked').val() !== true) && newData.exists()) || (!root.child('players').child($username).exists() && newData.parent().child('authUid').val() === auth.uid))";

const refreshAtValidate =
  `!newData.exists() || (newData.isNumber() && newData.val() > 0 && newData.val() <= now && (((!data.exists() || data.val() == null || data.val() === 0) && newData.val() > 0) || (data.exists() && data.isNumber() && data.val() > 0 && newData.val() === data.val() + ${PROJECT_REFRESH_INTERVAL_MS})))`;

console.log('projectsValidate length', projectsValidate.length);
console.log('markerWrite length', markerWrite.length);
console.log('refreshAtValidate length', refreshAtValidate.length);
console.log('PROJECT_REFRESH_INTERVAL_MS', PROJECT_REFRESH_INTERVAL_MS);

writeFileSync(
  new URL('./.claim-rules-snippets.json', import.meta.url),
  JSON.stringify({
    projectsValidate,
    ownerWrite,
    markerWrite,
    markerClaimGate,
    refreshAtWrite,
    refreshAtValidate,
    PROJECT_REFRESH_INTERVAL_MS,
  }, null, 2),
);
console.log('wrote scripts/.claim-rules-snippets.json');
