/**
 * Admin shared #confirm-modal isolation tests.
 * Run: node scripts/admin-confirm-modal-isolation.test.mjs
 */

import {
  confirmAction,
  normalizeConfirmActionArgs,
  resolveConfirmOkClassName,
  CONFIRM_OK_CLASS,
} from '../js/confirm-modal.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ─── Minimal DOM for confirmAction ─────────────────────────────────────────

function createEl(id, tag = 'div') {
  const listeners = new Map(); // type -> Set<fn>
  const el = {
    id,
    tagName: tag.toUpperCase(),
    textContent: '',
    className: '',
    disabled: false,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    parentNode: null,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    click() {
      const set = listeners.get('click');
      if (!set) return;
      for (const fn of [...set]) fn();
    },
    cloneNode() {
      const c = createEl(this.id, tag);
      c.textContent = this.textContent;
      c.className = this.className;
      c.disabled = this.disabled;
      for (const cls of this.classList._set) c.classList.add(cls);
      // Intentionally do NOT copy listeners (matches DOM cloneNode)
      return c;
    },
    _listenerCount(type = 'click') {
      return listeners.get(type)?.size ?? 0;
    },
    _hasListener(fn, type = 'click') {
      return listeners.get(type)?.has(fn) ?? false;
    },
  };
  return el;
}

function installConfirmDom() {
  const modal = createEl('confirm-modal');
  modal.classList.add('hidden');
  const title = createEl('confirm-title', 'h3');
  const message = createEl('confirm-message', 'p');
  const icon = createEl('confirm-icon', 'div');
  icon.textContent = '⚠️';
  const ok = createEl('btn-confirm-ok', 'button');
  ok.textContent = 'Confirm';
  ok.className = CONFIRM_OK_CLASS.safe;
  const cancel = createEl('btn-confirm-cancel', 'button');
  cancel.textContent = 'Cancel';

  const row = {
    children: [cancel, ok],
    replaceChild(newChild, oldChild) {
      const i = this.children.indexOf(oldChild);
      if (i < 0) throw new Error('replaceChild: old not found');
      newChild.parentNode = this;
      oldChild.parentNode = null;
      this.children[i] = newChild;
      byId[newChild.id] = newChild;
    },
  };
  ok.parentNode = row;
  cancel.parentNode = row;

  const byId = {
    'confirm-modal': modal,
    'confirm-title': title,
    'confirm-message': message,
    'confirm-icon': icon,
    'btn-confirm-ok': ok,
    'btn-confirm-cancel': cancel,
  };

  globalThis.document = {
    getElementById(id) {
      return byId[id] || null;
    },
  };

  return {
    byId,
    getOk: () => byId['btn-confirm-ok'],
    getCancel: () => byId['btn-confirm-cancel'],
    getModal: () => byId['confirm-modal'],
    getTitle: () => byId['confirm-title'],
    getMessage: () => byId['confirm-message'],
  };
}

// ─── Normalize / class helpers ─────────────────────────────────────────────

{
  const legacy = normalizeConfirmActionArgs('Body text', 'Title?');
  assert(legacy.message === 'Body text' && legacy.title === 'Title?', 'legacy (message, title)');
  assert(legacy.confirmText === 'Confirm' && legacy.destructive === false, 'legacy defaults');

  const opts = normalizeConfirmActionArgs({
    title: 'Promote to admin?',
    message: 'Grant admin access to "mr_g"?',
    confirmText: 'Promote to Admin',
    destructive: false,
  });
  assert(opts.confirmText === 'Promote to Admin', 'options confirmText');
  assert(resolveConfirmOkClassName(opts) === CONFIRM_OK_CLASS.safe, 'promote non-destructive class');

  const del = normalizeConfirmActionArgs({
    title: 'Delete?',
    message: 'Gone',
    confirmText: '🗑 Delete Permanently',
    destructive: true,
  });
  assert(resolveConfirmOkClassName(del) === CONFIRM_OK_CLASS.destructive, 'delete destructive class');
}

// ─── A. DELETE → CANCEL → PROMOTE ──────────────────────────────────────────

{
  const dom = installConfirmDom();
  let deleteCalls = 0;
  let promoteCalls = 0;

  // Simulate prior destructive open then cancel
  const pDelete = confirmAction({
    title: 'Delete Snapshot?',
    message: 'snap will be removed',
    confirmText: '🗑 Delete Permanently',
    destructive: true,
  });
  assert(dom.getOk().textContent === '🗑 Delete Permanently', 'A1. delete label');
  assert(dom.getOk().className === CONFIRM_OK_CLASS.destructive, 'A2. delete red class');
  // Attach side-effect tracker as if caller would delete on true
  pDelete.then((ok) => { if (ok) deleteCalls += 1; });
  dom.getCancel().click();
  await pDelete;
  assert(deleteCalls === 0, 'A3. cancel → no delete');

  const pPromote = confirmAction({
    title: 'Promote to admin?',
    message: 'Grant admin access to "mr_g"? They will have full admin panel access.',
    confirmText: 'Promote to Admin',
    destructive: false,
  });
  assert(dom.getTitle().textContent === 'Promote to admin?', 'A4. promote title');
  assert(dom.getOk().textContent === 'Promote to Admin', 'A5. promote label (not Delete Permanently)');
  assert(!dom.getOk().textContent.includes('Delete'), 'A6. no Delete in label');
  assert(dom.getOk().className === CONFIRM_OK_CLASS.safe, 'A7. promote primary class');
  pPromote.then((ok) => { if (ok) promoteCalls += 1; });
  dom.getOk().click();
  await pPromote;
  assert(promoteCalls === 1 && deleteCalls === 0, 'A8. only promote callback effect');
}

// ─── B. Foreign listener stripped by clone ─────────────────────────────────

{
  const dom = installConfirmDom();
  let foreign = 0;
  const foreignFn = () => { foreign += 1; };
  dom.getOk().addEventListener('click', foreignFn);
  assert(dom.getOk()._hasListener(foreignFn), 'B1. foreign listener attached');

  const p = confirmAction({
    title: 'Promote to admin?',
    message: 'msg',
    confirmText: 'Promote to Admin',
    destructive: false,
  });
  // Old node replaced — foreign listener must not be on current OK
  assert(!dom.getOk()._hasListener(foreignFn), 'B2. foreign listener gone after open');
  dom.getOk().click();
  await p;
  assert(foreign === 0, 'B3. foreign listener never fired');
}

// ─── C. Promote first ──────────────────────────────────────────────────────

{
  const dom = installConfirmDom();
  const p = confirmAction({
    title: 'Promote to admin?',
    message: 'Grant admin access to "mr_g"? They will have full admin panel access.',
    confirmText: 'Promote to Admin',
    destructive: false,
  });
  assert(dom.getTitle().textContent === 'Promote to admin?', 'C1. title');
  assert(dom.getMessage().textContent.includes('mr_g'), 'C2. body');
  assert(dom.getOk().textContent === 'Promote to Admin', 'C3. button');
  assert(dom.getOk().className === CONFIRM_OK_CLASS.safe, 'C4. style');
  dom.getCancel().click();
  await p;
}

// ─── D. Promote → Cancel → Delete ──────────────────────────────────────────

{
  const dom = installConfirmDom();
  const p1 = confirmAction({
    title: 'Promote to admin?',
    message: 'x',
    confirmText: 'Promote to Admin',
    destructive: false,
  });
  dom.getCancel().click();
  await p1;

  let deletes = 0;
  const p2 = confirmAction({
    title: 'Delete player "mr_g"?',
    message: 'permanent',
    confirmText: '🗑 Delete Permanently',
    destructive: true,
  });
  assert(dom.getOk().textContent === '🗑 Delete Permanently', 'D1. delete label');
  assert(dom.getOk().className === CONFIRM_OK_CLASS.destructive, 'D2. destructive style');
  p2.then((ok) => { if (ok) deletes += 1; });
  dom.getOk().click();
  await p2;
  assert(deletes === 1, 'D3. delete confirms once');
}

// ─── E. Demote ─────────────────────────────────────────────────────────────

{
  const dom = installConfirmDom();
  // Pollute with delete label first
  const dirty = confirmAction({
    title: 'Delete Snapshot?',
    message: 'x',
    confirmText: '🗑 Delete Permanently',
    destructive: true,
  });
  dom.getCancel().click();
  await dirty;

  const p = confirmAction({
    title: 'Remove admin access?',
    message: 'Remove admin access from "x"?',
    confirmText: 'Remove Admin',
    destructive: true,
  });
  assert(dom.getOk().textContent === 'Remove Admin', 'E1. demote label');
  assert(!dom.getOk().textContent.includes('Delete Permanently'), 'E2. not Delete Permanently');
  dom.getCancel().click();
  await p;
}

// ─── F. Delete Player config ───────────────────────────────────────────────

{
  const dom = installConfirmDom();
  const p = confirmAction({
    title: 'Delete player "mr_g"?',
    message: 'This will permanently delete "mr_g"',
    confirmText: '🗑 Delete Permanently',
    destructive: true,
  });
  assert(dom.getOk().textContent === '🗑 Delete Permanently', 'F1. delete player label');
  assert(dom.getOk().className === CONFIRM_OK_CLASS.destructive, 'F2. destructive');
  dom.getCancel().click();
  await p;
}

// ─── G. Snapshot/Archive cancel leaves no persistent listener for Promote ─

{
  const dom = installConfirmDom();
  let archiveDeletes = 0;
  const pArch = confirmAction({
    title: 'Delete Archived Season?',
    message: 'gone',
    confirmText: '🗑 Delete Permanently',
    destructive: true,
  });
  pArch.then((ok) => { if (ok) archiveDeletes += 1; });
  dom.getCancel().click();
  await pArch;

  let promotes = 0;
  const pProm = confirmAction({
    title: 'Promote to admin?',
    message: 'y',
    confirmText: 'Promote to Admin',
    destructive: false,
  });
  pProm.then((ok) => { if (ok) promotes += 1; });
  dom.getOk().click();
  await pProm;
  assert(promotes === 1 && archiveDeletes === 0, 'G1. promote only after archive cancel');
}

// ─── H. Non-destructive after delete ───────────────────────────────────────

{
  const dom = installConfirmDom();
  const d = confirmAction({
    title: 'Delete?',
    message: 'x',
    confirmText: '🗑 Delete Permanently',
    destructive: true,
  });
  dom.getCancel().click();
  await d;

  const shop = confirmAction({
    title: 'Confirm Purchase',
    message: 'Purchase this shop item?',
    confirmText: 'Confirm',
    destructive: false,
  });
  assert(dom.getOk().textContent === 'Confirm', 'H1. shop label');
  assert(dom.getOk().className === CONFIRM_OK_CLASS.safe, 'H2. shop non-destructive');
  dom.getCancel().click();
  await shop;
}

// ─── I. Promise resolves once ──────────────────────────────────────────────

{
  const dom = installConfirmDom();
  let resolves = 0;
  const p = confirmAction({ title: 'T', message: 'M', confirmText: 'Confirm', destructive: false });
  p.then(() => { resolves += 1; });
  dom.getOk().click();
  dom.getOk().click();
  dom.getCancel().click();
  await p;
  // allow microtasks
  await Promise.resolve();
  assert(resolves === 1, 'I1. confirm resolves once despite double-click');
  assert(dom.getModal().classList.contains('hidden'), 'I2. modal hidden after settle');
}

// ─── Source: no manual shared-modal ownership outside confirm-modal.js ─────

{
  const files = [
    'js/leaderboard-admin.js',
    'js/shop-ui.js',
    'js/achievements-admin.js',
    'js/cosmetics-admin.js',
    'js/ui.js',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert(
      !src.includes("getElementById('confirm-modal')")
        && !src.includes('getElementById("confirm-modal")'),
      `source: ${rel} does not own #confirm-modal DOM`,
    );
  }
  const uiSrc = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8');
  assert(uiSrc.includes("confirmText: 'Promote to Admin'"), 'source: Promote confirmText');
  assert(uiSrc.includes("confirmText: 'Remove Admin'"), 'source: Remove Admin confirmText');
  assert(uiSrc.includes("confirmText: '🗑 Delete Permanently'"), 'source: Delete Player confirmText');

  const lbSrc = fs.readFileSync(path.join(root, 'js/leaderboard-admin.js'), 'utf8');
  assert(lbSrc.includes("from './confirm-modal.js'"), 'source: leaderboard uses confirm-modal');
  assert(!lbSrc.includes('cloneNode'), 'source: leaderboard no longer clones confirm buttons');
}

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll admin confirm-modal isolation tests passed.');
