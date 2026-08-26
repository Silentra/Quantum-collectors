/**
 * Rebuild firebase-hosting-prod/ from authoritative root runtime files.
 *
 * Usage (from repo root):
 *   node scripts/sync-firebase-hosting-prod.mjs
 *
 * No Firebase CLI, no network, no writes outside firebase-hosting-prod/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEST_DIR = path.join(REPO_ROOT, 'firebase-hosting-prod');

/** @type {readonly string[]} */
const REQUIRED_FILES = Object.freeze(['index.html', 'main.js', 'style.css']);

/** @type {readonly string[]} */
const REQUIRED_DIRS = Object.freeze(['js', 'assets']);

const GENERATED_README = `GENERATED DEPLOYMENT OUTPUT — DO NOT EDIT MANUALLY

This folder is rebuilt from the authoritative Quantum Collectors root files:

  index.html
  main.js
  style.css
  js/
  assets/

Edit those sources instead. Then regenerate:

  node scripts/sync-firebase-hosting-prod.mjs

GitHub Pages / root files = development & staging.
firebase-hosting-prod/ = Firebase Hosting student production snapshot only.
`;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function assertExists(absPath, label) {
  if (!fs.existsSync(absPath)) {
    fail(`Required ${label} missing: ${path.relative(REPO_ROOT, absPath)}`);
  }
}

function removeDestIfPresent() {
  if (fs.existsSync(DEST_DIR)) {
    fs.rmSync(DEST_DIR, { recursive: true, force: true });
  }
}

function copyRuntime() {
  fs.mkdirSync(DEST_DIR, { recursive: true });

  const copied = [];

  for (const name of REQUIRED_FILES) {
    const src = path.join(REPO_ROOT, name);
    assertExists(src, 'file');
    const dest = path.join(DEST_DIR, name);
    fs.copyFileSync(src, dest);
    copied.push(name);
  }

  for (const name of REQUIRED_DIRS) {
    const src = path.join(REPO_ROOT, name);
    assertExists(src, 'directory');
    if (!fs.statSync(src).isDirectory()) {
      fail(`Expected directory but found non-directory: ${name}`);
    }
    const dest = path.join(DEST_DIR, name);
    fs.cpSync(src, dest, { recursive: true });
    copied.push(`${name}/`);
  }

  fs.writeFileSync(path.join(DEST_DIR, 'README-GENERATED.txt'), GENERATED_README, 'utf8');
  copied.push('README-GENERATED.txt');

  return copied;
}

function main() {
  console.log('[sync-firebase-hosting-prod] repo root:', REPO_ROOT);
  console.log('[sync-firebase-hosting-prod] target:   ', DEST_DIR);

  for (const name of REQUIRED_FILES) {
    assertExists(path.join(REPO_ROOT, name), 'source file');
  }
  for (const name of REQUIRED_DIRS) {
    assertExists(path.join(REPO_ROOT, name), 'source directory');
  }

  removeDestIfPresent();
  const copied = copyRuntime();

  // Post-copy sanity
  for (const name of REQUIRED_FILES) {
    assertExists(path.join(DEST_DIR, name), 'copied file');
  }
  for (const name of REQUIRED_DIRS) {
    assertExists(path.join(DEST_DIR, name), 'copied directory');
  }

  console.log('[sync-firebase-hosting-prod] copied:');
  for (const item of copied) {
    console.log('  -', item);
  }
  console.log('[sync-firebase-hosting-prod] DONE — firebase-hosting-prod/ rebuilt.');
}

main();
