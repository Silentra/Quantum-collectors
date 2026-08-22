# S8b+ P0 — Trusted Teacher Operations (Functions foundation)

**Status: IMPLEMENTED — AWAITING VERIFICATION**

Browser never receives Admin SDK / service-account credentials. Teachers will eventually use the Admin panel only; this P0 ships infrastructure + a diagnostic callable only (no password reset / delete / promote yet).

## One-time developer setup (not for teachers)

### 1) Blaze plan

1. Open [Firebase Console](https://console.firebase.google.com/) → project **quantum-collectors-v2**
2. Upgrade to the **Blaze** (pay-as-you-go) plan and link a billing account  
   Cloud Functions require Blaze. Classroom call volume normally stays inside Google’s monthly free Function quotas.

### 2) Firebase CLI

```powershell
npm install -g firebase-tools
firebase login
```

From the repo root (where `firebase.json` and `.firebaserc` live):

```powershell
cd "C:\Users\Matthew Gartman\Desktop\In Progress Quantum Collectors\Quantum-collectors"
firebase use quantum-collectors-v2
```

### 3) Install Function dependencies

```powershell
cd functions
npm install
cd ..
```

### 4) Deploy (exact command)

```powershell
firebase deploy --only functions
```

Expected: deploys callable **`pingTeacherOps`** in region **`us-central1`**.

Optional list after deploy:

```powershell
firebase functions:list
```

## What this P0 includes

| Piece | Location |
|-------|----------|
| Callable `pingTeacherOps` | [`functions/index.js`](../functions/index.js) |
| `requireTeacherAdmin(request)` | [`functions/requireTeacherAdmin.js`](../functions/requireTeacherAdmin.js) |
| Browser wrapper | [`js/teacher-ops.js`](../js/teacher-ops.js) → `window.qcTeacherOps` |
| Functions SDK | `firebase-functions-compat.js` in [`index.html`](../index.html); `getFunctions()` in [`js/firebase-config.js`](../js/firebase-config.js) |
| Project config | [`firebase.json`](../firebase.json), [`.firebaserc`](../.firebaserc) |

**Not in P0:** `resetStudentPassword`, `deleteStudentAccount`, `setTeacherAdminStatus`, RTDB rule changes, S8c.

## Teacher bootstrap claim (still local script)

Before admin ping succeeds, a teacher Auth user needs custom claim `admin: true`:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\serviceAccount.json"
node scripts/s8b-auth-admin.mjs set-admin-claim teacher1
```

Then that teacher must **sign out and sign in** (or refresh ID token) so the claim appears on the Auth token.

See [`scripts/README-S8b-auth.md`](README-S8b-auth.md).

## Non-programmer verification workflow

Prerequisites: Functions deployed; Auth production default (or any session with Firebase Auth signed in); at least one teacher with `admin:true` claim; one normal student Auth account.

No `qc_firebase_auth` prep. Emergency legacy rollback (`qc_force_legacy_auth`) is unrelated to teacher-ops testing — use Auth default.

### A) Unauthenticated

1. Ensure no Firebase Auth user: sign out of the game (or `firebase.auth().signOut()` in DevTools).
2. Run:

```js
await qcTeacherOps.pingTeacherOps()
```

**Expected:**

```js
{ ok: false, code: 'unauthenticated', message: '…' }
```

### B) Authenticated non-admin (student)

1. Sign in as a normal student (Auth on).
2. Run:

```js
qcTeacherOps.getTeacherOpsAuthSnapshot()  // signedIn: true
await qcTeacherOps.pingTeacherOps()
```

**Expected:**

```js
{ ok: false, code: 'permission-denied', message: '…' }
```

### C) Authenticated admin (teacher)

1. Sign in as the teacher who has `admin: true` (after claim + re-login).
2. Run:

```js
await qcTeacherOps.pingTeacherOps()
```

**Expected success shape:**

```js
{
  ok: true,
  data: {
    ok: true,
    command: 'pingTeacherOps',
    uid: '<firebase-auth-uid>',
    admin: true,
    message: 'Trusted Teacher Operations reachable.'
  }
}
```

Pasteable status: `qcPersonalAudit.workflowS8bPlusP0()`

## Rollback

- Frontend still works if Functions are undeployed: ping returns an error; game/Auth/RTDB unchanged.
- Do not fall back to shipping service-account keys to the browser.
- RTDB rules remain open; legacy Admin UX unchanged.

## Next (not this slice)

S8b+ P1 `resetStudentPassword`, P2 `deleteStudentAccount`, P3 `setTeacherAdminStatus` — separate approvals.
