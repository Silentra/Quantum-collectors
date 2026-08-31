/**
 * Editable registration instructions — config helpers + UI/DOM wiring checks.
 * Run: node scripts/registration-instructions.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getRegistrationInstructions,
  normalizeRegistrationInstructions,
  REGISTRATION_INSTRUCTIONS_MAX_LENGTH,
  setValue,
  loadConfig,
} from '../js/config.js';
import * as db from '../js/database.js';
import { PUBLIC_GATE_PATHS } from '../js/db-hydration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('PASS:', msg);
  }
}

await db.initDB();
loadConfig();

assert(normalizeRegistrationInstructions(null) === '', 'null → blank');
assert(normalizeRegistrationInstructions('   ') === '', 'whitespace → blank');
assert(normalizeRegistrationInstructions('  Hello  ') === 'Hello', 'trim');
assert(
  normalizeRegistrationInstructions('a'.repeat(REGISTRATION_INSTRUCTIONS_MAX_LENGTH + 20)).length
    === REGISTRATION_INSTRUCTIONS_MAX_LENGTH,
  'clamps max length',
);

setValue('registrationInstructions', '');
loadConfig();
assert(getRegistrationInstructions() === '', 'blank config → empty getter');

const sample = 'Use your first name and last initial.\nDo not use your full last name.';
setValue('registrationInstructions', `  ${sample}  `);
loadConfig();
assert(getRegistrationInstructions() === sample, 'populated + trim + newlines preserved');

const xss = '<script>alert(1)</script> & "quotes" \'apos\'';
setValue('registrationInstructions', xss);
loadConfig();
assert(getRegistrationInstructions() === xss, 'special chars preserved as plain text');

assert(
  PUBLIC_GATE_PATHS.includes('config/registrationInstructions'),
  'public gate paths include registrationInstructions',
);

const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(indexHtml.includes('id="register-instructions"'), 'register-instructions element in index');
assert(
  /id="register-heading"[\s\S]*?id="register-instructions"[\s\S]*?id="register-username"/.test(indexHtml),
  'instruction sits between Register heading and first input',
);
assert(indexHtml.includes('admin-registration-instructions'), 'Admin textarea present');
assert(indexHtml.includes('Student Registration Instructions'), 'Admin label present');

const uiSrc = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8');
assert(uiSrc.includes('syncRegistrationInstructionsUi'), 'UI sync helper present');
assert(uiSrc.includes('el.textContent = text'), 'uses textContent (not innerHTML) for instructions');
assert(!/getElementById\('register-instructions'\)[\s\S]{0,200}innerHTML\s*=/.test(uiSrc), 'no innerHTML assign to instructions');
assert(uiSrc.includes('syncRegistrationInstructionsUi()'), 'sync on show register');

const rules = fs.readFileSync(path.join(root, 'database.rules.json'), 'utf8');
assert(rules.includes('"registrationInstructions"'), 'rules include registrationInstructions');

const dbSrc = fs.readFileSync(path.join(root, 'js/database.js'), 'utf8');
assert(
  /registrationInstructions:\s*''/.test(dbSrc) || /registrationInstructions:\s*""/.test(dbSrc),
  'default instructions blank (not a hard-coded naming rule)',
);

if (failed) {
  console.error(`\nregistration-instructions: ${failed} failure(s)`);
  process.exit(1);
}
console.log('\nregistration-instructions: all checks passed');
