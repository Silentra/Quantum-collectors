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

**Firebase Auth production default — IMPLEMENTED — AWAITING VERIFICATION.** Fresh browsers use Firebase Auth with no localStorage prep (synthetic `{username}@scicards.local`). Legacy RTDB username/password hashes remain for **developer emergency rollback** only (`qc_force_legacy_auth='true'`). Stale `qc_firebase_auth` is ignored.

- Auth path: Firebase Email/Password; no new `players/{username}.password` on Auth-native register ([`js/auth.js`](js/auth.js))
- Legacy hashes: SHA-256 at `players/{username}.password` retained for emergency rollback of migrated accounts
- Session: `localStorage` `scicards_session` + RTDB `players/{username}/activeSession`
- Admin: plaintext `config.adminPassword` and/or `players/{u}.isAdmin` / `admins/{uid}` (flag-independent `__admin__`)
- Scripts loaded: `firebase-app` + `firebase-database` + `firebase-auth` + `firebase-functions` (Auth is production default; Functions for S8b+ teacher callables)

Client session / scoped loading / `qc_force_legacy_auth` are **invisible to security rules**.
(`qc_force_root_loading` was removed in S8d-0 and is ignored if still set.)

**S8d-1:** After publishing locked rules, admins (`admins/{uid}`) may parent-read `players`, `trades/direct`, and `trades/listings` for maintenance. Students cannot enumerate those parents. Helper: `qcAdminMaintenance` / `qcPersonalAudit.workflowS8d1()`.
### S8b (Auth foundation)

### Auth mode + emergency legacy rollback

```js
// Production default: Firebase Auth (no flag needed)

// Emergency developer-only legacy hash auth:
localStorage.setItem('qc_force_legacy_auth','true'); location.reload();

// Return to Auth default:
localStorage.removeItem('qc_force_legacy_auth'); location.reload();
```

**Limitation:** Auth-native accounts with no RTDB password hash cannot log in while `qc_force_legacy_auth='true'`.

Trusted local Admin script (migrate bobby / teacher, set password, set `admin:true` claim, Auth orphan cleanup):
[`scripts/s8b-auth-admin.mjs`](scripts/s8b-auth-admin.mjs) — see [`scripts/README-S8b-auth.md`](scripts/README-S8b-auth.md).

Enable **Email/Password** in Firebase Console Authentication (required for classroom).
In-game Admin “Reset Password” is disabled while Auth is authoritative (use the script temporarily until S8b+ P1).
`__admin__` / `config.adminPassword` remain.

Pasteable: `qcPersonalAudit.workflowAuthDefaultFlip()` (also `workflowS8b()`)

### S8b+ P0 (Trusted Teacher Functions foundation) — IMPLEMENTED — AWAITING VERIFICATION

Callable Cloud Functions scaffolding + `pingTeacherOps` diagnostic only. **No** password reset / delete / promote yet. **No** RTDB rule changes. **Not** a Monday/Spark launch dependency (Blaze optional later).

Full setup + verification: [`docs/S8b-PLUS-TEACHER-OPS.md`](docs/S8b-PLUS-TEACHER-OPS.md)  
Pasteable: `qcPersonalAudit.workflowS8bPlusP0()`

### S8c-0 (client prep) — COMPLETE + VERIFIED

- Trade counterparties: trade-visible child loads only (not full `players/{other}`)
- Admin registry path `admins/{authUid}` + Promote/Demote writes
- Register taken-check via directory / authUid leaves
- Pasteable: `qcPersonalAudit.workflowS8c0()`
- Distribution debt: [`docs/BEFORE_DISTRIBUTION.md`](docs/BEFORE_DISTRIBUTION.md)

### S8c-1 (tradeGrants + locked rules) — COMPLETE + VERIFIED

- Client: `claimerAuthUid` on claims; `tradeGrants/{target}/{claimerUid}` CREATE/CLEAR lifecycle ([`js/trade-grants.js`](js/trade-grants.js))
- In-repo locked rules: [`database.rules.json`](database.rules.json) — **Console paste required for each rules change**
- Rollback: [`database.rules.open-rollback.json`](database.rules.open-rollback.json)
- Local emulator proof: `scripts/s8c1-rules-simulator.mjs`
- Pasteable: `qcPersonalAudit.workflowS8c1()`

### S8c-2 (residual foreign stats/achievements/LB) — IMPLEMENTED — AWAITING RULE DEPLOYMENT / VERIFICATION

- Grant-bound foreign writes: `stats`, `achievements`, `progression`, `lastDirectTradeAt`, `leaderboards/{stat}/{u}`
- `lastListingAcceptAt`: owner/admin only
- `tradesCompleted` under grant: exact +1
- **Accepted residuals:** `playerTradeIndex` + `listingsByGroup` remain any-auth writable (rebuildable indexes)
- Pasteable: `qcPersonalAudit.workflowS8c2()`
- **Republish full `database.rules.json` after pulling this slice**

### Auth production-default flip — COMPLETE + VERIFIED

- Fresh browser → Firebase Auth; emergency `qc_force_legacy_auth`
- Pasteable: `qcPersonalAudit.workflowAuthDefaultFlip()`

### Future (post Auth-default verify)

Legacy hash retirement after post-launch confidence. Option C password-reset path deferred ([`docs/BEFORE_DISTRIBUTION.md`](docs/BEFORE_DISTRIBUTION.md)).

Authoritative S8 plan: [`docs/DATABASE_SCOPING_ROADMAP.md`](docs/DATABASE_SCOPING_ROADMAP.md) §8.

## 5. Security Rules

**Console is the source of truth for what is deployed.** In-repo locked rules: [`database.rules.json`](database.rules.json). Open rollback: [`database.rules.open-rollback.json`](database.rules.open-rollback.json).

### Classroom open rules (rollback / pre-deploy) — S8a snapshot

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

**After S8c-1 Console deploy:** locked Auth + `admins/{uid}` + tradeGrants exact foreign inventory rules apply. Until you paste, live classroom remains open.
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

Production boot loads **scoped** paths only (not full `/`). `qc_force_root_loading` was removed in S8d-0.

## 7. How It Works (current)

- [`js/database.js`](js/database.js) maintains an in-memory cache for synchronous reads
- Production: scoped hydration (sharedDefs + `players/{me}` + tab scopes); no root `/` listener
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
