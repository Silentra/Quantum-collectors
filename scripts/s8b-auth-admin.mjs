#!/usr/bin/env node
/**
 * S8b trusted local Admin SDK helper (NOT shipped to browsers).
 *
 * Prerequisites:
 *   1) Enable Email/Password in Firebase Console → Authentication
 *   2) Create a service account (Console → Project settings → Service accounts)
 *      and download JSON; never commit it.
 *   3) npm install firebase-admin  (from repo root or this folder)
 *
 * Usage examples:
 *   set GOOGLE_APPLICATION_CREDENTIALS=C:\path\serviceAccount.json
 *   node scripts/s8b-auth-admin.mjs migrate-user bobby "TempPass123!"
 *   node scripts/s8b-auth-admin.mjs set-password bobby "NewPass123!"
 *   node scripts/s8b-auth-admin.mjs set-admin-claim teacher1 true
 *   node scripts/s8b-auth-admin.mjs clear-admin-claim teacher1
 *
 * migrate-user:
 *   - Creates Auth user {username}@scicards.local with the given password
 *     (or updates password if the Auth user already exists)
 *   - Preserves existing RTDB players/{username} inventory/stats
 *   - Writes players/{username}/authUid for diagnostics
 *   - Does NOT delete legacy password hashes
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAdmin() {
  try {
    return require('firebase-admin');
  } catch {
    console.error(
      'Missing firebase-admin. From repo root run:\n  npm install firebase-admin\n',
    );
    process.exit(1);
  }
}

const AUTH_DOMAIN = 'scicards.local';

function usernameToEmail(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(u)) {
    throw new Error(`Invalid username: ${username}`);
  }
  return `${u}@${AUTH_DOMAIN}`;
}

function initApp(admin) {
  if (admin.apps.length) return admin.app();

  const credPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.QC_FIREBASE_SERVICE_ACCOUNT ||
    '';

  if (!credPath || !fs.existsSync(credPath)) {
    console.error(
      'Set GOOGLE_APPLICATION_CREDENTIALS (or QC_FIREBASE_SERVICE_ACCOUNT) to your service-account JSON path.',
    );
    process.exit(1);
  }

  const sa = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  // databaseURL from common project configs (override with QC_DATABASE_URL if needed)
  const databaseURL =
    process.env.QC_DATABASE_URL ||
    'https://quantum-collectors-v2-default-rtdb.firebaseio.com/';

  return admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL,
  });
}

async function getOrCreateAuthUser(admin, username, password) {
  const email = usernameToEmail(username);
  try {
    const existing = await admin.auth().getUserByEmail(email);
    if (password) {
      await admin.auth().updateUser(existing.uid, { password, displayName: username });
    }
    return existing;
  } catch (err) {
    if (err?.code !== 'auth/user-not-found') throw err;
    if (!password) {
      throw new Error(`Auth user ${email} not found; provide a password to create.`);
    }
    return admin.auth().createUser({
      email,
      password,
      displayName: username,
      emailVerified: false,
      disabled: false,
    });
  }
}

async function cmdMigrateUser(admin, username, password) {
  const db = admin.database();
  const snap = await db.ref(`players/${username}`).once('value');
  if (!snap.exists()) {
    throw new Error(`RTDB players/${username} does not exist — create/register first or check spelling.`);
  }
  const user = await getOrCreateAuthUser(admin, username, password);
  await db.ref(`players/${username}/authUid`).set(user.uid);
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: 'migrate-user',
        username,
        email: usernameToEmail(username),
        authUid: user.uid,
        rtdbPreserved: true,
        legacyPasswordHashUntouched: true,
      },
      null,
      2,
    ),
  );
}

async function cmdSetPassword(admin, username, password) {
  if (!password || password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  const user = await getOrCreateAuthUser(admin, username, password);
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: 'set-password',
        username,
        email: usernameToEmail(username),
        authUid: user.uid,
      },
      null,
      2,
    ),
  );
}

async function cmdSetAdminClaim(admin, username, value) {
  const email = usernameToEmail(username);
  const user = await admin.auth().getUserByEmail(email);
  const claims = { ...(user.customClaims || {}) };
  if (value) claims.admin = true;
  else delete claims.admin;
  await admin.auth().setCustomUserClaims(user.uid, claims);
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: value ? 'set-admin-claim' : 'clear-admin-claim',
        username,
        authUid: user.uid,
        claims,
        note: 'User must refresh ID token (sign out/in) before claim is visible client-side.',
      },
      null,
      2,
    ),
  );
}

function usage() {
  console.log(`S8b Auth Admin (local trusted script)

Commands:
  migrate-user <username> <password>   Create/update Auth user; set players/{u}/authUid; keep RTDB
  set-password <username> <password>   Set Auth password (create if missing)
  set-admin-claim <username>           Set custom claim admin:true
  clear-admin-claim <username>         Remove admin claim

Env:
  GOOGLE_APPLICATION_CREDENTIALS   Path to service account JSON (required)
  QC_DATABASE_URL                  Optional RTDB URL override
`);
}

async function main() {
  const [cmd, username, arg2] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(0);
  }

  const admin = loadAdmin();
  initApp(admin);

  const u = String(username || '').trim().toLowerCase();
  if (!u) {
    usage();
    process.exit(1);
  }

  if (cmd === 'migrate-user') {
    await cmdMigrateUser(admin, u, arg2);
  } else if (cmd === 'set-password') {
    await cmdSetPassword(admin, u, arg2);
  } else if (cmd === 'set-admin-claim') {
    await cmdSetAdminClaim(admin, u, true);
  } else if (cmd === 'clear-admin-claim') {
    await cmdSetAdminClaim(admin, u, false);
  } else {
    console.error('Unknown command:', cmd);
    usage();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
