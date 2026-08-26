/**
 * Firebase Hosting production sync pipeline tests.
 * Run: node scripts/firebase-hosting-prod-sync.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROD = path.join(REPO_ROOT, 'firebase-hosting-prod');
const SYNC = path.join(REPO_ROOT, 'scripts', 'sync-firebase-hosting-prod.mjs');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('PASS:', msg);
  }
}

function runSync() {
  const r = spawnSync(process.execPath, [SYNC], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
    failHard(`sync exited ${r.status}`);
  }
  return r;
}

function failHard(msg) {
  console.error('FATAL:', msg);
  process.exit(1);
}

// Source must exist and stay authoritative
assert(fs.existsSync(path.join(REPO_ROOT, 'index.html')), 'source index.html exists');
assert(fs.existsSync(path.join(REPO_ROOT, 'main.js')), 'source main.js exists');
assert(fs.existsSync(path.join(REPO_ROOT, 'style.css')), 'source style.css exists');
assert(fs.existsSync(path.join(REPO_ROOT, 'js')), 'source js/ exists');
assert(fs.existsSync(path.join(REPO_ROOT, 'assets')), 'source assets/ exists');

const srcIndexBefore = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');

// Stale file in prod must be removed on rebuild
fs.mkdirSync(PROD, { recursive: true });
const stale = path.join(PROD, 'STALE-SHOULD-VANISH.txt');
fs.writeFileSync(stale, 'stale', 'utf8');
assert(fs.existsSync(stale), 'planted stale file');

runSync();

assert(!fs.existsSync(stale), 'stale file removed on sync');
assert(fs.existsSync(path.join(PROD, 'index.html')), 'prod index.html');
assert(fs.existsSync(path.join(PROD, 'main.js')), 'prod main.js');
assert(fs.existsSync(path.join(PROD, 'style.css')), 'prod style.css');
assert(fs.existsSync(path.join(PROD, 'js')), 'prod js/');
assert(fs.existsSync(path.join(PROD, 'assets')), 'prod assets/');
assert(fs.existsSync(path.join(PROD, 'README-GENERATED.txt')), 'generated marker present');

const sensitive = [
  'firebase.json',
  '.firebaserc',
  'database.rules.json',
  'database.rules.open-rollback.json',
  'functions',
  'scripts',
  'docs',
  'ARCHITECTURE.md',
  'DESIGN.md',
  'FIREBASE_SETUP.md',
  'firebase-hosting-test',
  'node_modules',
  'quantum-collectors-card-data.json',
];
for (const name of sensitive) {
  assert(!fs.existsSync(path.join(PROD, name)), `sensitive absent: ${name}`);
}

const srcIndexAfter = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
assert(srcIndexBefore === srcIndexAfter, 'source index.html unchanged by sync');

const prodIndex = fs.readFileSync(path.join(PROD, 'index.html'), 'utf8');
assert(prodIndex === srcIndexAfter, 'prod index.html matches source');
assert(prodIndex.includes('cdn.tailwindcss.com'), 'CDN Tailwind still present');
assert(prodIndex.includes('gstatic.com/firebasejs'), 'CDN Firebase still present');
assert(prodIndex.includes('./main.js'), 'relative main.js entry');

const firebaseJson = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'firebase.json'), 'utf8'),
);
assert(firebaseJson.hosting?.public === 'firebase-hosting-prod', 'hosting.public = firebase-hosting-prod');
assert(firebaseJson.database?.rules === 'database.rules.json', 'database.rules preserved');
assert(Array.isArray(firebaseJson.functions) && firebaseJson.functions[0]?.source === 'functions', 'functions preserved');
assert(
  Array.isArray(firebaseJson.hosting?.ignore)
    && firebaseJson.hosting.ignore.includes('README-GENERATED.txt'),
  'README-GENERATED.txt ignored by Hosting',
);
const headers = firebaseJson.hosting?.headers || [];
const hasNoCache = headers.some((h) =>
  (h.source === '/' || h.source === '/index.html')
  && (h.headers || []).some((x) => x.key === 'Cache-Control' && String(x.value).includes('no-cache')),
);
assert(hasNoCache, 'Cache-Control no-cache for app shell');

assert(fs.existsSync(path.join(REPO_ROOT, 'firebase-hosting-test', 'index.html')), 'PoC test folder preserved');

const syncSrc = fs.readFileSync(SYNC, 'utf8');
assert(!syncSrc.includes('firebase deploy'), 'sync script has no firebase deploy');
assert(!syncSrc.includes('firebase serve'), 'sync script has no firebase serve');

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll firebase-hosting-prod sync tests passed.');
