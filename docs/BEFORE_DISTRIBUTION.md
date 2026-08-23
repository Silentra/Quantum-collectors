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

## 2. Option C — Spark identity rotation (COMPLETE for classroom)

**Status: COMPLETE + LIVE VERIFIED** (C-a + C-b). Classroom teachers reset passwords and delete players from the Admin panel with:

- no Blaze / Cloud Functions requirement for routine use
- no terminal / Console for routine reset/delete
- no real student emails

**Mechanics:** disposable Auth identities + `authDirectory` rebind.

**Option C-a (foundation):** `authDirectory/{username} = { loginEmail, authUid, generation }` with public pre-auth **child** read; production Firebase Auth login/register/restore resolve `loginEmail` via `authDirectory` (strict-by-default). Gen0 emails remain `{username}@scicards.local`. Ownership stays `players/{username}.authUid`.

- **C-a.1 / C-a.1.1 / C-a.2:** LIVE VERIFIED.
- **C-b:** LIVE VERIFIED — Reset Password = secondary Auth **identity rotation** (teacher session intact). Delete Player = game identity unbind (`authDirectory` cleared); does **not** delete arbitrary Firebase Auth users. Same-username reuse may require Console/Admin SDK Auth cleanup — immediate re-register can hit `EMAIL_EXISTS`. **Live verified:** after manual Auth cleanup, same username successfully registered as a fresh account. Future read-only orphan Auth report remains deferred. Freshness: `qcAuth.getOptionCbStatus()`.

**Still deferred (distribution / polish — not classroom infrastructure blockers):**

- first-admin / empty-database bootstrap
- Repair Game / Admin UX cleanup
- Config-tab review
- end-of-year orphan Auth report/tooling

**Distribution:** Option C classroom lifecycle is done. Independent self-hosted installs still need first-admin bootstrap before claiming full teacher self-sufficiency.

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
