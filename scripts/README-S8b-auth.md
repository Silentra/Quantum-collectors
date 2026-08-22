# S8b Auth Admin Script

Trusted **local** Admin SDK helper for one-time migrations and temporary password resets.

**Not** part of the browser app. **Do not** commit service-account JSON.

## Setup

1. Firebase Console → Authentication → enable **Email/Password**.
2. Project settings → Service accounts → Generate new private key.
3. From repo root:

```bash
npm install firebase-admin
set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\serviceAccount.json
```

(Linux/macOS: `export GOOGLE_APPLICATION_CREDENTIALS=...`)

## Commands

```bash
# Migrate bobby (keeps RTDB players/bobby inventory; sets authUid)
node scripts/s8b-auth-admin.mjs migrate-user bobby "ChooseAPassword!"

# Teacher account + admin claim (before any S8c rules that need claims)
node scripts/s8b-auth-admin.mjs migrate-user teacher1 "ChooseAPassword!"
node scripts/s8b-auth-admin.mjs set-admin-claim teacher1

# Temporary classroom password reset while Auth is on
node scripts/s8b-auth-admin.mjs set-password student42 "NewTempPass!"

# Auth-orphan cleanup after RTDB-only Admin Delete Player (S8b transition)
# Deletes Firebase Auth user only — does NOT touch RTDB players/{username}
node scripts/s8b-auth-admin.mjs delete-auth-user testy
```

Synthetic Auth email is always `{username}@scicards.local` (internal only).

### `delete-auth-user`

Use when Admin Delete Player already removed `players/{username}` but `{username}@scicards.local` remains in Firebase Authentication (Auth orphan during S8b transition).

- Resolves `{username}@scicards.local`, deletes that Auth user only, leaves RTDB alone.
- `auth/user-not-found` is treated as idempotent success (`deleted: false`).

**Warning:** Do **not** run `delete-auth-user` against bobby, teacher, or other live classroom accounts unless you intentionally want to remove their Firebase Auth identity.

## Auth mode (production default)

Firebase Auth is the **production default** (no localStorage prep for students).

```js
// Emergency developer-only legacy RTDB hash auth:
localStorage.setItem('qc_force_legacy_auth', 'true'); location.reload();

// Return to Auth default:
localStorage.removeItem('qc_force_legacy_auth'); location.reload();
```

Stale `qc_firebase_auth` is ignored. Auth-native accounts without `players/{u}.password` cannot log in under legacy rollback.

Pasteable: `qcPersonalAudit.workflowAuthDefaultFlip()`

## Next (separate Plan-mode / implementation slices)

- **S8b+ P0** Trusted Teacher Functions foundation — see [`docs/S8b-PLUS-TEACHER-OPS.md`](../docs/S8b-PLUS-TEACHER-OPS.md)
- Later: password reset, full account delete, display-name moderation, admin claims via Admin panel callables
- Not started in this script: Cloud Functions classroom ops beyond local CLI recovery

Deep investigation of **Trusted Teacher Operations** is documented in the S8b+ architecture plan; local scripts remain bootstrap/recovery only.
