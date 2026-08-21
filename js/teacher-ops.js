/**
 * S8b+ Trusted Teacher Operations — browser client (no Admin SDK / no service account).
 * P0: diagnostic ping only. Password reset / delete / promote come in later slices.
 */

import { getFunctions } from './firebase-config.js';
import { getAuth } from './firebase-config.js';

/**
 * Map Firebase callable errors to a stable client shape.
 * @param {unknown} err
 * @returns {{ ok: false, code: string, message: string, details?: unknown }}
 */
export function mapTeacherOpsError(err) {
  const code = String(err?.code || 'unknown').replace(/^functions\//, '');
  const message = String(err?.message || err || 'Teacher operation failed.');
  return {
    ok: false,
    code,
    message,
    details: err?.details,
  };
}

/**
 * Invoke a named HTTPS callable in us-central1.
 * @param {string} name
 * @param {object} [data]
 */
async function callTeacherOp(name, data = {}) {
  const callable = getFunctions().httpsCallable(name);
  try {
    const result = await callable(data);
    return { ok: true, data: result?.data ?? null };
  } catch (err) {
    return mapTeacherOpsError(err);
  }
}

/**
 * P0 diagnostic: proves admin claim gate on the deployed backend.
 * Expected:
 *   - signed-in admin:true → { ok: true, data: { ok, command: 'pingTeacherOps', ... } }
 *   - signed-in without claim → { ok: false, code: 'permission-denied', ... }
 *   - not signed in to Firebase Auth → { ok: false, code: 'unauthenticated', ... }
 */
export async function pingTeacherOps() {
  return callTeacherOp('pingTeacherOps', {});
}

/**
 * DevTools helper: show whether Firebase Auth currentUser exists (not RTDB session).
 */
export function getTeacherOpsAuthSnapshot() {
  let user = null;
  try {
    user = getAuth().currentUser;
  } catch {
    return { firebaseAuthReady: false, signedIn: false, uid: null, email: null };
  }
  return {
    firebaseAuthReady: true,
    signedIn: !!user,
    uid: user?.uid || null,
    email: user?.email || null,
  };
}

if (typeof window !== 'undefined') {
  window.qcTeacherOps = {
    pingTeacherOps,
    getTeacherOpsAuthSnapshot,
    mapTeacherOpsError,
  };
}
