# Before distribution

Genuine blockers for shipping Quantum Collectors as an **independent self-hosted** product (each teacher’s own free Firebase + GitHub Pages).  
**Not** a general TODO list. Classroom deployment with developer-assisted setup may proceed without solving these.

## 1. First-admin bootstrap (required for independent installs)

After S8c locks RTDB writes behind `admins/{authUid}: true`, a brand-new Firebase project needs a **teacher-friendly** way to create the first registry entry **without**:

- terminal / DevTools
- Firebase Console manual JSON editing
- developer remote assistance
- shipping a service-account file to the teacher’s browser

**Current classroom:** developer one-time write of `admins/{uid}` (Console, Admin SDK script, or promote while rules are still open) is acceptable.

**Distribution:** must ship a polished first-run bootstrap before independent installs are supportable.

## 2. Option C — Spark identity rotation (in-panel Auth lifecycle)

Teachers must eventually reset passwords and finish account deletion **from the Admin panel** with:

- no Blaze / Cloud Functions requirement
- no terminal / Console for routine use
- no real student emails

Planned approach: disposable Auth identities + `authDirectory` rebind (Option C).

**Option C-a (foundation):** `authDirectory/{username} = { loginEmail, authUid, generation }` with public pre-auth **child** read; production Firebase Auth login/register/restore resolve `loginEmail` via `authDirectory`. Gen0 emails remain `{username}@scicards.local`. Ownership stays `players/{username}.authUid`.

- **C-a.1:** migration-compat release + per-username backfill child reads. **C-a.1.1** (`option-c-a-1.1.1`): registration multipath fix — live LB summary entries include `username` (no rules republish). Backfill then verify logins; then verify disposable registration.
- **C-a.2:** production-default strict micro-deploy after C-a.1.1 registration verification. `qc_auth_directory_strict` / `enableAuthDirectoryStrict()` is **this-browser localStorage only** and is **not** the final global production mechanism.
- **C-b** (reset/delete rotation) must not start until C-a (incl. C-a.2) is verified.

Until C-b:

- Auth password reset → `scripts/s8b-auth-admin.mjs set-password` (developer)
- Delete Player → RTDB only; Auth orphan optional `delete-auth-user` cleanup

**Distribution:** Option C (C-a + C-b, or equivalent Spark-native lifecycle) is required before claiming teacher self-sufficiency.

## Out of scope for this file

Ordinary bugs, polish, tradeGrants (S8c-1), scoped-loading history, Auth production-default flip (students need no localStorage; emergency `qc_force_legacy_auth` is developer-only), and optional Console Auth tidy-up are **not** listed here.

**Classroom Auth note:** With Auth as production default, a fresh browser can open the site and log in/register without DevTools. That is a launch requirement for the shared classroom deploy — not a distribution (independent Firebase) blocker.

## Future Admin UX (not a distribution blocker)

- Add dedicated “Repair Game” Admin tab.
- Move maintenance/rebuild tools there.
- Add short plain-language explanation beside each repair action.
- Review Admin tab organization for obsolete/redundant sections.
- Review whether Config should be removed or repurposed now that settings live in purpose-specific tabs.

Do **not** treat the above as a shipping blocker for classroom or independent installs; it is deferred product polish only.
