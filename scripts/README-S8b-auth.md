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
```

Synthetic Auth email is always `{username}@scicards.local` (internal only).

## Feature flag

```js
// ON — Firebase Auth login/register
localStorage.setItem('qc_firebase_auth', 'true'); location.reload();

// OFF — legacy RTDB hash auth (rollback while rules remain open)
localStorage.removeItem('qc_firebase_auth'); location.reload();
```
