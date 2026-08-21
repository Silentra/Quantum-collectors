# Firebase Setup for Quantum Collectors

## 1. Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **Add project** and follow the wizard
3. Once created, click the **Web** icon (`</>`) to register a web app
4. Copy the config object

## 2. Add Your Config

Edit `js/firebase-config.js` and replace the placeholder values:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project-default-rtdb.firebaseio.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

**Important:** The `databaseURL` field is required for Realtime Database. If it's missing from your config, find it in Firebase Console > Realtime Database.

## 3. Enable Realtime Database

1. Firebase Console > **Build** > **Realtime Database**
2. Click **Create Database**
3. Choose a location close to your users
4. Start in **test mode** (lockdown is a later S8 track — see below)

## 4. Authentication (current vs future)

### Current (live app)

**S8b Firebase Auth foundation — IMPLEMENTED — AWAITING VERIFICATION.** Default remains legacy RTDB hashes until `localStorage.qc_firebase_auth='true'`. With the flag on, Firebase Auth is authoritative (synthetic `{username}@scicards.local`). Legacy RTDB username/password hashes still exist for rollback:

- Player passwords: SHA-256 hash at `players/{username}.password` ([`js/auth.js`](js/auth.js))
- Session: `localStorage` `scicards_session` + RTDB `players/{username}/activeSession`
- Admin: plaintext `config.adminPassword` and/or `players/{u}.isAdmin` (client-enforced only)
- Scripts loaded: `firebase-app` + `firebase-database` + `firebase-auth` + `firebase-functions` (Auth used only when `qc_firebase_auth=true`; Functions used for S8b+ teacher callables).

Client session / scoped loading / `qc_force_root_loading` are **invisible to security rules**.

### S8b (Auth foundation)

### S8b feature flag + migration

```js
localStorage.setItem('qc_firebase_auth','true'); location.reload();  // Auth ON
localStorage.removeItem('qc_firebase_auth'); location.reload();       // legacy rollback
```

Trusted local Admin script (migrate bobby / teacher, set password, set `admin:true` claim, Auth orphan cleanup):
[`scripts/s8b-auth-admin.mjs`](scripts/s8b-auth-admin.mjs) — see [`scripts/README-S8b-auth.md`](scripts/README-S8b-auth.md).

Enable **Email/Password** in Firebase Console Authentication before turning the flag on.
In-game Admin “Reset Password” is disabled while Auth is on (use the script temporarily until S8b+ P1).
Do **not** deploy authorization rules in S8b. `__admin__` / `config.adminPassword` remain.

Pasteable: `qcPersonalAudit.workflowS8b()`

### S8b+ P0 (Trusted Teacher Functions foundation) — IMPLEMENTED — AWAITING VERIFICATION

Callable Cloud Functions scaffolding + `pingTeacherOps` diagnostic only. **No** password reset / delete / promote yet. **No** RTDB rule changes. **Not** a Monday/Spark launch dependency (Blaze optional later).

Full setup + verification: [`docs/S8b-PLUS-TEACHER-OPS.md`](docs/S8b-PLUS-TEACHER-OPS.md)  
Pasteable: `qcPersonalAudit.workflowS8bPlusP0()`

### S8c-0 (client prep) — IMPLEMENTED — AWAITING VERIFICATION

- Trade counterparties: trade-visible child loads only (not full `players/{other}`)
- Admin registry path `admins/{authUid}` + Promote/Demote writes (rules still open — **not secure yet**)
- Register taken-check via directory / authUid leaves
- Pasteable: `qcPersonalAudit.workflowS8c0()`
- Distribution debt: [`docs/BEFORE_DISTRIBUTION.md`](docs/BEFORE_DISTRIBUTION.md)

**S8c-1** (tradeGrants + locked rules) — NOT STARTED.

### Future (S8c-1+ — not implemented)

Firebase Auth is layered under the same username/password UX when `qc_firebase_auth` is enabled. Enable Email/Password in Console before Auth-on testing. S8a docs unchanged; S8b is the Auth wiring slice.

Authoritative S8 plan: [`docs/DATABASE_SCOPING_ROADMAP.md`](docs/DATABASE_SCOPING_ROADMAP.md) §8.

## 5. Security Rules

**Console is the source of truth for what is deployed.** In-repo snapshot: [`database.rules.json`](database.rules.json) (live classroom rules only).

### Classroom / development rules (currently live) — S8a snapshot

Open read/write for the classroom custom-auth model, plus a **data-integrity** invariant on inventory quantity leaves (not authorization):

```json
{
  "rules": {
    ".read": true,
    ".write": true,
    "players": {
      "$username": {
        "inventory": {
          "$cardId": {
            ".validate": "newData.isNumber() && newData.val() >= 0"
          }
        }
      }
    }
  }
}
```

- **Integrity (now):** inventory card leaves must be numeric and `>= 0`. Deletes/`null` skip `.validate` and remain legal. Supports Hybrid C+ Gate A (`ServerValue.increment` cannot drive a leaf below 0 without rejecting the whole multi-path write).
- **Authorization:** **not** enforced. Anyone with the public web config can read/write the database (except writing negative inventory numbers).
- **S8a:** docs + this snapshot only. No authz tighten.
- **S8b:** Firebase Auth client wiring + flag (does **not** change these open rules).

### Live Gate A Firebase proofs (Console + DevTools)

1. `2 → 1` via `ServerValue.increment(-1)` — PASS  
2. `1 → 0` via `increment(-1)` — PASS  
3. `0 → -1` — PERMISSION_DENIED; value remained `0` — PASS  
4. Multi-path `increment(-1)` from `0` + sibling literal — entire update rejected; sibling remained null — PASS  

### What rules cannot do today (without Firebase Auth)

| Goal | Enforceable now? |
|------|------------------|
| Per-user write ownership | **No** |
| Hide other players’ private fields | **No** (open `.read`) |
| Admin-only `config` / promote | **No** |
| Protect `activeSession` / access codes | **No** |
| Inventory qty `>= 0` | **Yes** (`.validate`) |

Path samples that “look tight” without `auth` are **security theater**. True lockdown needs Firebase Auth (or Admin SDK / Cloud Functions) — **S8b → S8c**, separate approvals.

### Aspirational Auth-gated sample — NOT LIVE / NOT DEPLOY

The historical sample below assumed Firebase Auth and is **incomplete** (omits `playerDirectory`, `playerTradeIndex`, `listingsByGroup`, `tradeIndexMeta`, `leaderboards`, seasons/snapshots). It is also **too weak** (`auth != null` alone does not bind writes to `$username`) and would break anonymous register / Admin bulk under current clients.

**Do not paste into Console** until S8b Auth + Admin custom-claim provisioning exist and S8c is separately approved.

Kept only as a reminder that earlier docs overstated Auth readiness:

```json
{
  "rules": {
    "config": {
      ".read": true,
      ".write": "auth != null && root.child('players').child(auth.token.email.replace('.', ',').replace('@scicards,local', '')).child('isAdmin').val() === true"
    },
    "players": {
      "$username": {
        ".read": true,
        ".write": "auth != null"
      }
    }
  }
}
```

**Ordering (S8b → S8c):** trusted Admin SDK / custom-claim provisioning must exist **before** S8c rules rely on an admin claim. Do not use RTDB `isAdmin` alone as the rules admin check (attacker can set it under open writes).

## 6. Database Structure (live roots)

```
/
├── config/                 # Game settings; adminPassword (plaintext today)
├── players/                # Profiles keyed by username (password hash, inventory, …)
├── cards/ / packs/ / groups/
├── accessCodes/            # Registration codes
├── trades/                 # Canonical direct/ + listings/
├── playerDirectory/        # Derived public-ish directory (no passwords)
├── playerTradeIndex/       # Per-user trade projections
├── listingsByGroup/        # Group marketplace projections
├── tradeIndexMeta/
├── leaderboards/           # Live summary rankings
├── leaderboardSeasons/ / leaderboardSnapshots/
└── admin/                  # Legacy stub (largely unused)
```

Production boot loads **scoped** paths (not full `/`) unless `localStorage.qc_force_root_loading='true'`.

## 7. How It Works (current)

- [`js/database.js`](js/database.js) maintains an in-memory cache for synchronous reads
- Production default: scoped hydration (sharedDefs + `players/{me}` + tab scopes); emergency root via `qc_force_root_loading`
- Writes update cache and Firebase; acknowledged paths used where required for races
- If Firebase is unreachable / unconfigured, falls back to localStorage
- [`js/auth.js`](js/auth.js): **custom RTDB auth only** — does **not** map usernames to Firebase Auth emails

## 8. Fallback Behavior

If `firebase-config.js` still has placeholder keys (`YOUR_API_KEY`), the system falls back to localStorage — identical local behavior.

## 9. Verify It Works

1. Open browser console
2. Look for: `[DB] Firebase Realtime Database connected`
3. If you see: `[DB] Using localStorage fallback` — check your config
4. Open Firebase Console > Realtime Database to see data appearing in real time
5. Security posture smoke: `qcPersonalAudit.workflowS8a()`
