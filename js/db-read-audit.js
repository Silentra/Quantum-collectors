/**
 * db-read-audit.js — Phase S4 development-only cache read audit + optional isolation
 *
 * Disabled by default. Never logs values, passwords, hashes, sessions, inventories,
 * or other payloads — only operation + redacted path.
 *
 * Flags (localStorage):
 *   qc-personal-scope-audit=true       — enable auditing (hooks become active)
 *   qc-personal-cache-isolation=true   — during an active begin()/start() session,
 *                                        forbidden reads throw instead of returning data
 *
 * Isolation is NOT applied at cold startup (avoids breaking accessCodes seed / init).
 * It only gates reads while a labeled personal-audit session is active.
 *
 * S5c-C: Research Projects use playerTradeIndex/{me} when verified. Canonical
 * trades/* reads during Research are fallback-only and must be flagged — not
 * accepted as a permanent blocker.
 */

const AUDIT_LS_KEY = 'qc-personal-scope-audit';
const ISOLATION_LS_KEY = 'qc-personal-cache-isolation';
const SESSION_KEY = 'scicards_session';

/**
 * Historical S4 blocker — remediated by S5c-C index-backed Research reservations.
 * Kept empty so unexplained trades/* reads during projects FAIL (or PARTIAL only
 * when explicitly classified as canonical-fallback via workflow notes).
 */
export const KNOWN_SCOPED_BLOCKERS = Object.freeze([]);

/** @deprecated Use empty KNOWN_SCOPED_BLOCKERS; retained for DevTools docs. */
export const REMEDIATED_SCOPED_BLOCKERS = Object.freeze([
  {
    id: 'projects-trade-reservations',
    surfaces: ['projects'],
    paths: ['trades/direct', 'trades/listings'],
    source: 'js/trade-availability.js → buildResearchAvailabilitySnapshot (index) / canonical-fallback',
    callers: ['js/project-ui.js'],
    note: 'S5c-C: verified index → no trades/* reads. Canonical fallback is measured, not an accepted blocker.',
    remediatedIn: 'S5c-C',
  },
]);

export const PERSONAL_AUDIT_LS_KEY = AUDIT_LS_KEY;
export const PERSONAL_ISOLATION_LS_KEY = ISOLATION_LS_KEY;

/** @type {boolean} */
let _auditEnabled = false;
/** @type {boolean} */
let _isolationFlag = false;
/** @type {boolean} */
let _bootedLogged = false;

/** @type {null | { label: string, username: string, startedAt: number, counts: Map<string, object>, unexpected: object[], allowedTotal: number, unexpectedTotal: number, hardViolations: number }} */
let _active = null;

/** @type {object[]} */
let _completed = [];

function _lsTrue(key) {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function _normalizePath(path) {
  if (path == null || path === '' || path === '/') return '';
  return String(path).split('/').filter(Boolean).join('/');
}

function _sessionUsername() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.username && s.username !== '__admin__' ? String(s.username).toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Build allowlist prefixes for a username (exact-or-descendant matching).
 * Use trailing `/` or `/*` in custom begin() allowlists for children-only rules.
 * @param {string} username
 * @returns {string[]}
 */
export function defaultAllowedPrefixes(username) {
  const u = String(username || '').trim().toLowerCase();
  const prefixes = ['config', 'cards', 'packs', 'groups', 'tradeIndexMeta'];
  if (u) {
    prefixes.push(`players/${u}`);
    prefixes.push(`playerTradeIndex/${u}`);
  }
  return prefixes;
}

/**
 * Parse a raw allowlist entry into a match rule.
 * Children-only intent (detected BEFORE normalize):
 *   - ends with `/*`  → descendants only
 *   - ends with `/`   → descendants only
 * Normal entries: exact path OR any descendant (existing behavior).
 *
 * @param {string} raw
 * @returns {{ prefix: string, childrenOnly: boolean, display: string }|null}
 */
function _parseAllowRule(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || s === '/') return null;

  let childrenOnly = false;
  if (s.endsWith('/*')) {
    childrenOnly = true;
    s = s.slice(0, -2);
  } else if (s.endsWith('/')) {
    childrenOnly = true;
    s = s.slice(0, -1);
  }

  const prefix = _normalizePath(s);
  if (!prefix) return null;
  return {
    prefix,
    childrenOnly,
    display: childrenOnly ? `${prefix}/*` : prefix,
  };
}

/**
 * @param {string} normalizedPath
 * @param {Array<{ prefix: string, childrenOnly: boolean }|string>} allowedRules
 * @returns {boolean}
 */
function _isAllowed(normalizedPath, allowedRules) {
  if (!normalizedPath) return false; // root / empty — not personal-scoped
  for (const rule of allowedRules) {
    if (!rule) continue;
    // Backward-compatible: plain string = normal exact-or-descendant
    if (typeof rule === 'string') {
      if (normalizedPath === rule || normalizedPath.startsWith(`${rule}/`)) return true;
      continue;
    }
    const { prefix, childrenOnly } = rule;
    if (!prefix) continue;
    if (childrenOnly) {
      // ALLOW prefix/{id…}; FORBID exact bare prefix
      if (normalizedPath.startsWith(`${prefix}/`)) return true;
    } else if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function _formatAllowRules(rules) {
  return (rules || []).map((r) => (typeof r === 'string' ? r : r.display || r.prefix)).join(',');
}

/**
 * Redact path for reports — never emit raw other-user names beyond placeholder.
 * @param {string} normalizedPath
 * @param {string|null} me
 */
function _redactPath(normalizedPath, me) {
  if (!normalizedPath) return '/';
  const parts = normalizedPath.split('/');
  if (parts[0] === 'players' && parts.length >= 2) {
    const user = parts[1];
    if (me && user === me) {
      parts[1] = '{me}';
    } else if (user !== '{me}' && user !== '{other-user}') {
      parts[1] = '{other-user}';
    }
  }
  if (parts[0] === 'playerTradeIndex' && parts.length >= 2) {
    const user = parts[1];
    if (me && user === me) {
      parts[1] = '{me}';
    } else if (user !== '{me}' && user !== '{other-user}') {
      parts[1] = '{other-user}';
    }
  }
  // Never leave session id segments in reports
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === 'activeSession' && i + 1 < parts.length) {
      parts[i + 1] = '{redacted}';
    }
    if (parts[i] === 'password') {
      return parts.slice(0, i + 1).join('/') + '/*';
    }
  }
  return parts.join('/');
}

function _topLevel(normalizedPath) {
  if (!normalizedPath) return '/';
  return normalizedPath.split('/')[0] || '/';
}

/**
 * Refresh enablement from localStorage (call on load and when flags change).
 */
export function refreshFlagsFromStorage() {
  _auditEnabled = _lsTrue(AUDIT_LS_KEY);
  _isolationFlag = _lsTrue(ISOLATION_LS_KEY);
  if ((_auditEnabled || _isolationFlag) && !_bootedLogged) {
    _bootedLogged = true;
    console.info(
      `[PersonalAudit] ACTIVE audit=${_auditEnabled} isolation=${_isolationFlag} ` +
        '(isolation only gates during begin/start sessions; root listener unchanged)',
    );
    if (KNOWN_SCOPED_BLOCKERS.length) {
      console.info('[PersonalAudit] Known scoped blockers:', KNOWN_SCOPED_BLOCKERS.map((b) => b.id));
    }
  }
}

export function isAuditEnabled() {
  return _auditEnabled;
}

export function isIsolationEnabled() {
  return _isolationFlag;
}

/**
 * Whether isolation should throw on forbidden reads right now.
 */
export function isIsolationActive() {
  return _isolationFlag && _active != null;
}

export function enableAudit() {
  try { localStorage.setItem(AUDIT_LS_KEY, 'true'); } catch { /* ignore */ }
  refreshFlagsFromStorage();
}

export function disableAudit() {
  try { localStorage.setItem(AUDIT_LS_KEY, 'false'); } catch { /* ignore */ }
  _auditEnabled = false;
}

export function enableIsolation() {
  try { localStorage.setItem(ISOLATION_LS_KEY, 'true'); } catch { /* ignore */ }
  refreshFlagsFromStorage();
}

export function disableIsolation() {
  try { localStorage.setItem(ISOLATION_LS_KEY, 'false'); } catch { /* ignore */ }
  _isolationFlag = false;
}

/**
 * @param {'get'|'getChildren'|'query'} op
 * @param {string} path
 * @returns {{ block: boolean, error?: Error }}
 */
export function beforeRead(op, path) {
  if (!_auditEnabled && !_isolationFlag) {
    return { block: false };
  }
  // Isolation only while a labeled session is active
  if (!isIsolationActive()) {
    return { block: false };
  }

  const normalized = _normalizePath(path);
  const allowed = _active.allowedPrefixes;
  if (_isAllowed(normalized, allowed)) {
    return { block: false };
  }

  const redacted = _redactPath(normalized, _active.username);
  const err = new Error(
    `[PersonalAudit] ISOLATION forbidden ${op}('${redacted}') during label="${_active.label}". ` +
      'This is a development read-gate — not a silent empty result.',
  );
  _active.hardViolations += 1;
  _active.unexpected.push({
    op,
    pathRedacted: redacted,
    topLevel: _topLevel(normalized),
    isolationThrow: true,
    ts: Date.now(),
  });
  console.error(err.message);
  return { block: true, error: err };
}

/**
 * Record a cache read (paths only). No-op when audit disabled or no active session.
 * @param {'get'|'getChildren'|'query'} op
 * @param {string} path
 */
export function record(op, path) {
  if (!_auditEnabled || !_active) return;

  const normalized = _normalizePath(path);
  const redacted = _redactPath(normalized, _active.username);
  const allowed = _isAllowed(normalized, _active.allowedPrefixes);
  const key = `${op}|${redacted}`;

  let entry = _active.counts.get(key);
  if (!entry) {
    entry = {
      op,
      pathRedacted: redacted,
      topLevel: _topLevel(normalized),
      allowed,
      count: 0,
    };
    _active.counts.set(key, entry);
  }
  entry.count += 1;

  if (allowed) {
    _active.allowedTotal += 1;
  } else {
    _active.unexpectedTotal += 1;
    _active.unexpected.push({
      op,
      pathRedacted: redacted,
      topLevel: _topLevel(normalized),
      isolationThrow: false,
      ts: Date.now(),
    });
  }
}

/**
 * Start a labeled audit session.
 * @param {string|object} labelOrOpts
 * @param {{ username?: string, allowedPrefixes?: string[] }} [opts]
 */
export function begin(labelOrOpts, opts = {}) {
  refreshFlagsFromStorage();
  if (!_auditEnabled) {
    console.warn(
      `[PersonalAudit] begin() called but ${AUDIT_LS_KEY} is not true. ` +
        `localStorage.setItem('${AUDIT_LS_KEY}','true'); then reload or enableAudit().`,
    );
  }

  let label;
  let options = opts;
  if (labelOrOpts && typeof labelOrOpts === 'object') {
    label = labelOrOpts.label || 'unnamed';
    options = { ...labelOrOpts, ...opts };
  } else {
    label = labelOrOpts || 'unnamed';
  }

  if (_active) {
    console.warn(`[PersonalAudit] Ending prior label "${_active.label}" before begin("${label}")`);
    end();
  }

  const username = (options.username || _sessionUsername() || '').toLowerCase() || null;
  const allowedPrefixes = Array.isArray(options.allowedPrefixes)
    ? options.allowedPrefixes.map(_parseAllowRule).filter(Boolean)
    : defaultAllowedPrefixes(username || '').map((p) => _parseAllowRule(p)).filter(Boolean);

  _active = {
    label: String(label),
    username,
    allowedPrefixes,
    startedAt: Date.now(),
    counts: new Map(),
    unexpected: [],
    allowedTotal: 0,
    unexpectedTotal: 0,
    hardViolations: 0,
  };

  console.info(
    `[PersonalAudit] begin("${_active.label}") me=${username || '(none)'} ` +
      `isolation=${isIsolationActive()} allow=${_formatAllowRules(allowedPrefixes)}`,
  );

  return { ok: true, label: _active.label, username, isolation: isIsolationActive() };
}

/** Alias */
export function start(labelOrOpts, opts) {
  return begin(labelOrOpts, opts);
}

/**
 * End active session and store report.
 * @returns {object|null}
 */
export function end(expectedLabel) {
  if (!_active) {
    console.warn('[PersonalAudit] end() with no active session');
    return null;
  }
  if (expectedLabel != null && String(expectedLabel) !== _active.label) {
    console.warn(
      `[PersonalAudit] end("${expectedLabel}") but active label is "${_active.label}"`,
    );
  }

  const report = _buildSessionReport(_active);
  _completed.push(report);
  _active = null;

  const status = report.pass ? 'PASS' : 'FAIL';
  console.info(`[PersonalAudit] end("${report.label}") → ${status}`, report.brief);
  return report;
}

/** Alias */
export function stop() {
  return end();
}

function _buildSessionReport(session) {
  const unique = [...session.counts.values()].sort((a, b) => b.count - a.count);
  const unexpectedUnique = unique.filter((e) => !e.allowed);
  const allowedUnique = unique.filter((e) => e.allowed);
  const byTopLevel = {};
  for (const e of unique) {
    byTopLevel[e.topLevel] = (byTopLevel[e.topLevel] || 0) + e.count;
  }

  const knownForLabel = KNOWN_SCOPED_BLOCKERS.filter((b) =>
    b.surfaces.includes(session.label) || session.label === 'projects',
  );

  const matchedKnown = [];
  for (const blocker of KNOWN_SCOPED_BLOCKERS) {
    const hit = unexpectedUnique.some((e) =>
      blocker.paths.some((p) => e.pathRedacted === p || e.pathRedacted.startsWith(`${p}/`)),
    );
    if (hit || (blocker.surfaces.includes(session.label) && unexpectedUnique.some((e) => e.topLevel === 'trades'))) {
      matchedKnown.push(blocker.id);
    }
  }

  const unexpectedUnexplained = unexpectedUnique.filter((e) => {
    return !KNOWN_SCOPED_BLOCKERS.some((b) =>
      b.paths.some((p) => e.pathRedacted === p || e.pathRedacted.startsWith(`${p}/`)),
    );
  });

  const pass = session.unexpectedTotal === 0 && session.hardViolations === 0;
  const partialOk = pass || (
    unexpectedUnexplained.length === 0
    && session.hardViolations === 0
    && matchedKnown.length > 0
  );

  return {
    label: session.label,
    username: session.username,
    startedAt: session.startedAt,
    endedAt: Date.now(),
    durationMs: Date.now() - session.startedAt,
    pass,
    /** Clean, or only known blockers (e.g. projects→trades) */
    partialPass: partialOk,
    allowedTotal: session.allowedTotal,
    unexpectedTotal: session.unexpectedTotal,
    hardViolations: session.hardViolations,
    uniquePathCount: unique.length,
    byTopLevel,
    allowed: allowedUnique,
    unexpected: unexpectedUnique,
    knownBlockersMatched: matchedKnown,
    unexpectedUnexplained: unexpectedUnexplained.map((e) => e.pathRedacted),
    brief: {
      pass,
      partialPass: partialOk,
      allowed: session.allowedTotal,
      unexpected: session.unexpectedTotal,
      knownBlockers: matchedKnown,
      unexplained: unexpectedUnexplained.map((e) => `${e.op} ${e.pathRedacted}`),
    },
    knownBlockersNote: knownForLabel.length
      ? knownForLabel.map((b) => b.note).join(' ')
      : undefined,
  };
}

export function report() {
  return {
    auditEnabled: _auditEnabled,
    isolationFlag: _isolationFlag,
    isolationActive: isIsolationActive(),
    activeLabel: _active ? _active.label : null,
    completed: _completed.slice(),
    knownScopedBlockers: KNOWN_SCOPED_BLOCKERS,
  };
}

/**
 * Final PASS / PARTIAL / FAIL table across completed labels.
 */
export function summary() {
  refreshFlagsFromStorage();
  if (_active) {
    console.warn(`[PersonalAudit] summary() with open session "${_active.label}" — call end() first`);
  }

  const rows = _completed.map((r) => ({
    label: r.label,
    result: r.pass ? 'PASS' : r.partialPass ? 'PARTIAL' : 'FAIL',
    allowed: r.allowedTotal,
    unexpected: r.unexpectedTotal,
    knownBlockers: r.knownBlockersMatched,
    unexplained: r.unexpectedUnexplained,
  }));

  const allPass = rows.length > 0 && rows.every((r) => r.result === 'PASS');
  const allAcceptable = rows.length > 0 && rows.every((r) => r.result === 'PASS' || r.result === 'PARTIAL');
  const anyFail = rows.some((r) => r.result === 'FAIL');

  const out = {
    phase: 'S4+',
    overall: allPass ? 'PASS' : allAcceptable && !anyFail ? 'PARTIAL' : rows.length ? 'FAIL' : 'EMPTY',
    note: 'phase S4+ = audit helper origin (not current roadmap phase). PARTIAL only if knownScopedBlockers match; with empty blockers, expect PASS or FAIL only.',
    knownScopedBlockers: KNOWN_SCOPED_BLOCKERS,
    rows,
    rootListenerNote: 'Legacy root listener unchanged; audit does not disable it.',
  };

  console.info('[PersonalAudit] summary', out);
  console.table(rows);
  return out;
}

export function reset() {
  _active = null;
  _completed = [];
  console.info('[PersonalAudit] reset');
}

export function help() {
  console.info(`Personal cache-read audit (Phase S4 — infrastructure only)
Enable audit:      localStorage.setItem('${AUDIT_LS_KEY}','true'); location.reload()
Enable isolation:  localStorage.setItem('${ISOLATION_LS_KEY}','true'); location.reload()
  (isolation throws on forbidden reads only during begin/start — not at cold boot)

API:
  qcPersonalAudit.begin('collection')
  qcPersonalAudit.end('collection')
  qcPersonalAudit.summary()
  qcPersonalAudit.report()
  qcPersonalAudit.reset()
  qcPersonalAudit.workflow()   // print guided steps (S4 personal tabs)
  qcPersonalAudit.workflowS5b() // Admin directory + selected-player scopes
  qcPersonalAudit.workflowS5cC() // Research reservation cutover
  qcPersonalAudit.workflowS5cD2() // Direct-trade picker → playerDirectory
  qcPersonalAudit.workflowS5cD3() // Pending directs + duplicate → PTI
  qcPersonalAudit.workflowS5cD4() // My Listings + max-active → PTI listings
  qcPersonalAudit.workflowS5cD5b() // Available → listingsByGroup
  qcPersonalAudit.workflowS5cD6() // Trading self-reservations → PTI
  qcPersonalAudit.workflowS5cD7a() // Counterparty once-loads
  qcPersonalAudit.workflowS5cD7b() // Scoped listing expiry
  qcPersonalAudit.workflowS5cD7()  // Final S5c-D Trading isolation umbrella
  qcPersonalAudit.workflowS6e()    // S6e final isolation matrix (alias: workflowS6)
  qcPersonalAudit.workflowClassroomDefaultFlip()
  qcPersonalAudit.workflowCardArtRetry()
  qcPersonalAudit.workflowS8a()    // S8a security docs + live rules snapshot
  qcPersonalAudit.workflowS8b()    // S8b Firebase Auth foundation
  qcPersonalAudit.workflowAuthDefaultFlip() // Auth production default + legacy rollback
  qcPersonalAudit.workflowS8bPlusP0() // S8b+ P0 Trusted Teacher Functions
  qcPersonalAudit.workflowS8c0()   // S8c-0 client prep (foreign reads + admins registry)
  qcPersonalAudit.workflowS8c1()   // S8c-1 tradeGrants + locked rules
  qcPersonalAudit.workflowS8c2()   // S8c-2 grant-bound foreign stats/LB
  qcPersonalAudit.workflowS8d1()   // S8d-1 admin canonical parent reads
  qcPersonalAudit.workflowS8d2()   // S8d-2 Player Directory rebuild (COMPLETE + VERIFIED)
  qcPersonalAudit.workflowS8d3()   // S8d-3 safe live leaderboard rebuild
  qcPersonalAudit.workflowS8d4a()  // S8d-4a admin PTI/LBG parent reads (rules)
  qcPersonalAudit.workflowS8d4b()  // S8d-4b safe Trade Index rebuild
  qcPersonalAudit.workflowS8d5a()  // S8d-5a safe Unique Cards repair
  qcPersonalAudit.workflowS8d5b()  // S8d-5b safe Season + Lifetime Snapshot class ops
  qcPersonalAudit.workflowOptionCa() // Option C-a authDirectory foundation

Never logs values/passwords/sessions/inventories. Root listener unchanged in historical S4 notes.
S8a is docs-only — no Auth / no authz rule deploy.
`);
}

/**
 * Print guided pasteable workflow for Shell + personal tabs.
 */
export function workflow() {
  console.info(`
=== S4 Personal Scope Verification Workflow ===

0) Enable (reload once):
   localStorage.setItem('${AUDIT_LS_KEY}','true');
   // optional final proof (throws on forbidden reads during begin):
   // localStorage.setItem('${ISOLATION_LS_KEY}','true');
   location.reload();

1) After login / app ready:
   qcDbHydration.getSharedHydrationReport();
   qcDbHydration.getCurrentPlayerHydrationReport();
   // expect sharedDefs ready; currentPlayerReady; subscriptionRefCount===1

2) Shell / header (after enterGame):
   qcPersonalAudit.begin('shell');
   // glance header: username, RP, packs, banner — no tab switch required
   qcPersonalAudit.end('shell');   // expect PASS

3) Collection:
   qcPersonalAudit.begin('collection');
   // open Collection tab; change filters; open one card detail
   qcPersonalAudit.end('collection');   // expect PASS

4) Packs:
   qcPersonalAudit.begin('packs');
   // open Packs; open one pack (1 write)
   qcPersonalAudit.end('packs');   // expect PASS

5) Projects (S5c-C index-backed):
   qcPersonalAudit.begin('projects');
   // open Research Projects; browse cards panel / assignment (do not require claim)
   qcPersonalAudit.end('projects');
   // expect PASS when index verified (playerTradeIndex/{me} + tradeIndexMeta only)
   // canonical-fallback → PARTIAL/FAIL if trades/direct|listings appear (not an accepted blocker)
   // See also: qcPersonalAudit.workflowS5cC()

6) Shop:
   qcPersonalAudit.begin('shop');
   // open Shop; optional one purchase or reroll
   qcPersonalAudit.end('shop');   // expect PASS

7) Profile:
   qcPersonalAudit.begin('profile');
   // open Profile; optional one appearance change
   qcPersonalAudit.end('profile');   // expect PASS

8) Achievements:
   qcPersonalAudit.begin('achievements');
   // view achievements on Profile; optional claim
   qcPersonalAudit.end('achievements');   // expect PASS

9) Final:
   qcPersonalAudit.summary();
   // overall PARTIAL is success for S4 audit-infra if only projects→trades is unexplained-none
   // Do NOT open Trading / Leaderboard / Admin during personal labels

Disable: localStorage flags false + reload
`);
}

/**
 * Print guided pasteable workflow for Phase S5b Admin directory + selected-player scopes.
 */
export function workflowS5b() {
  console.info(`
=== S5b Admin Directory + Selected-Player Verification ===

Prereq: logged in as a player-admin (has players/{me}) OR standalone __admin__.
Optional audit: localStorage.setItem('qc-personal-scope-audit','true'); location.reload();

----- A) Directory scope (Admin list) -----
1) Before Admin:
   qcDbHydration.getSubscriptionRegistry()
   // player-admin: only players/{me} refCount 1
   // __admin__: no players/{me}

2) Open Admin main tab (once):
   qcDbHydration.getAdminDirectoryHydrationReport()
   // expect: path 'playerDirectory', active true, refCount 1, ready true
   qcDbHydration.getSubscriptionRegistry()
   // + playerDirectory refCount 1

3) Switch Admin sub-tabs (Overview ↔ Players) and change filters / search.
   Re-check registry — playerDirectory refCount must stay 1 (no bump).
   renderAdminPlayers must NOT call ensureAdminDirectoryScope.

4) Overview Players count must match directory children (not getAllPlayers).

----- B) Selected-player switching -----
5) Manage player A (not self):
   qcDbHydration.getAdminSelectedPlayerReport()
   // borrowedFromCurrentPlayer false; path players/{A}; refCount 1
   Registry: players/{me}? + playerDirectory + players/{A}

6) Manage player B:
   // A released before B loads — no players/{A} left; players/{B} refCount 1

7) Close detail (X):
   getAdminSelectedPlayerReport() → username null / inactive
   // playerDirectory still active while Admin open

----- C) Self-selection borrow -----
8) As player-admin, Manage your own username:
   getAdminSelectedPlayerReport()
   // borrowedFromCurrentPlayer true; subscriptionActive false (no Admin-owned sub)
   Registry: still exactly one players/{me} (refCount 1) — no second listener

9) Standalone __admin__: skip self-borrow; managing others uses Admin selected scope only.
   // no current-player scope ever

----- D) Read auditing (Admin browsing) -----
10) qcPersonalAudit.begin('admin-s5b', { allowedPrefixes: ['config','cards','packs','groups','playerDirectory','players/'] });
    // Browse Admin overview + Players list only (do not open Trading/LB).
    // List/overview should read playerDirectory — not bare players dump.
    // Opening Manage {other} may read players/{selected} after scoped hydrate.
    qcPersonalAudit.end('admin-s5b');

----- E) Cleanup -----
11) Leave Admin (open Collection/Packs/etc.):
    getAdminDirectoryHydrationReport() → active false
    getAdminSelectedPlayerReport() → inactive
    Registry: only players/{me} for player-admin; none of those for __admin__

12) Re-enter Admin repeatedly — directory refCount must remain 1 each visit (not accumulate).

PASS when A–E match Expected subscription states in ARCHITECTURE Phase S5b.
`);
}

/**
 * Pasteable verification workflow for Phase S5c-C (Research reservation cutover).
 */
export function workflowS5cC() {
  console.info(`
=== S5c-C Current-Player Trade Index + Research Cutover ===

Prereq: normal player (not __admin__). Prefer hard reload after login.
Optional: localStorage.setItem('qc-personal-scope-audit','true');
Optional metrics: localStorage.setItem('qc-db-metrics-enabled','true');
location.reload();

DEFERRED (do not require for S5c-C pass):
  - listing acceptance happy path
  - two-browser listing-claim race

----- 1) Registry after login -----
qcDbHydration.getSubscriptionRegistry()
// expect exactly:
//   players/{me}            refCount 1
//   playerTradeIndex/{me}   refCount 1
// (no listingsByGroup, no playerDirectory unless Admin)

qcDbHydration.getPlayerTradeIndexHydrationReport()
// expect: ready true, metaReady true, globalVersionCurrent true, usable true,
//         active true, refCount 1

----- 2) Index readiness -----
qcTradeIndex.isPlayerTradeIndexReady(qcDbHydration.getPlayerTradeIndexHydrationReport().username)
// true
// global: tradeIndexMeta schema matches CURRENT_TRADE_INDEX_SCHEMA_VERSION

----- 3) Research audit (verified index) -----
qcPersonalAudit.begin('projects');
// Open Research Projects; open Available Cards panel; open one Start Project assignment UI
// Do NOT open Trading during this begin()
qcPersonalAudit.end('projects');
// expect PASS
// unexpected must NOT include trades/direct or trades/listings
// allowed may include playerTradeIndex/{me} and tradeIndexMeta

----- 4) Last-copy direct reservation -----
// Create a direct offer that reserves your last copy of card X (Trading UI).
// Return to Research — card X must show locked / not assignable.
// Cancel or complete the trade — card X available again.

----- 5) Last-copy listing reservation -----
// Create a listing that reserves your last copy of card Y.
// Research must block Y. Cancel listing — Y available again.
// (Processing listing: if practical, same lock while processing.)

----- 6) Fallback vs unavailable -----
// While root coexistence is active, unready meta → canonical-fallback:
//   Research still works; console may warn once per reason;
//   qcDbMetrics.summary().tradeIndexLifecycle.fallbackCount increases (if metrics on)
// With isolation ON and index forced unready → unavailable fail-closed:
//   localStorage.setItem('qc-personal-cache-isolation','true'); // then reload / force unready
//   Start Project / assign disabled; Retry calls ensurePlayerTradeIndexScope

----- 7) Subscription stability -----
// Re-open Research / re-render several times
qcDbHydration.getSubscriptionRegistry()
// playerTradeIndex/{me} refCount still 1

----- 8) Logout cleanup -----
// Logout
qcDbHydration.getSubscriptionRegistry()
// no playerTradeIndex/{me}

----- 9) Trading unchanged -----
// Trading tab still uses canonical getPendingTrades / listings APIs
// Do not expect Trading to subscribe to playerTradeIndex

PASS when 1–5 and 7–9 hold; 6 documents fallback/fail-closed policy.
`);
}

/**
 * Pasteable verification workflow for Phase S5c-D2 (direct-trade picker → playerDirectory).
 * Does NOT claim all Trading is scoped-clean — pending/listings/reservations remain canonical.
 */
export function workflowS5cD2() {
  console.info(`
=== S5c-D2 Direct Trade Picker → playerDirectory ===

Prereq: normal player (not __admin__). D1 COMPLETE + VERIFIED.
Optional: localStorage.setItem('qc-personal-scope-audit','true');
location.reload();

DEFERRED (still canonical — do not require for D2 pass):
  - getPendingTrades / listings / expire / reservations
  - listingsByGroup subscription

----- 1) Registry while Trading open -----
qcDbHydration.getSubscriptionRegistry()
// players/{me} ×1, playerTradeIndex/{me} ×1, playerDirectory ×1
// NO listingsByGroup

qcDbHydration.getTradeDirectoryHydrationReport()
// active true, ready true, refCount 1

----- 2) Picker audit (options only — do not send offer yet) -----
qcPersonalAudit.begin('trading-picker', {
  allowedPrefixes: [
    'config', 'cards', 'packs', 'groups', 'tradeIndexMeta',
    'playerDirectory',
    'players/' + (qcDbHydration.getCurrentPlayerHydrationReport().username || ''),
    'playerTradeIndex/' + (qcDbHydration.getCurrentPlayerHydrationReport().username || ''),
  ],
});
// Open Trading → Direct Trades; open the target <select> only
// Do NOT send an offer (createTradeOffer still reads players/{target} canonically)
qcPersonalAudit.end('trading-picker');
// unexpected must NOT include bare path 'players' or players/{other-user}
// allowed may include playerDirectory

----- 3) Semantics -----
// Same-group peers appear; self / __admin__ / restricted / hidden excluded
// Persistent player-admin accounts still appear for others
// Legitimate empty group → "No other players in your group to trade with."

----- 4) Untrusted ≠ empty -----
// If directory ensure fails / active false: unavailable message
// must NOT show the legitimate-empty copy

----- 5) Reactive refresh (~5s) -----
// Peer hides profile / Admin trade-locks / group change:
//   options update without full tab wipe
// If that peer was selected: selection clears; card pickers clear
// If another peer still selected: offered-card UI preserved

----- 6) Canonical create still authoritative -----
// Send offer to a visible peer → createTradeOffer validates players/{target}
// Orphan directory row (if any) may appear but create rejects missing player

----- 7) Unchanged -----
// Pending trades, listings, expire, reservations still scan canonical trades/*
// playerDirectory refCount stays 1 (D1 ownership); no new Firebase listener

PASS when 1–6 hold; 7 documents deferred consumers.
`);
}

/**
 * Pasteable verification workflow for Phase S5c-D3 (pending directs + duplicate → PTI).
 * Narrow: Direct Trades only. trades/listings hits are expected from later phases — not a D3 fail.
 */
export function workflowS5cD3() {
  console.info(`
=== S5c-D3 Pending Directs + Duplicate → playerTradeIndex/{me}/direct ===

Prereq: normal player; D2 COMPLETE + VERIFIED.
Optional: localStorage.setItem('qc-personal-scope-audit','true');
location.reload();

STAY ON DIRECT TRADES — do not open Listings during the pending audit.

----- 1) Registry -----
qcDbHydration.getSubscriptionRegistry()
// players/{me} ×1, playerTradeIndex/{me} ×1, playerDirectory ×1 (Trading open)
// playerTradeIndex refCount === 1 (no second PTI sub)
// NO listingsByGroup

qcTradeIndex.isPlayerTradeIndexReady(meUsername) // true
qcTradeIndex.shadowCompare(meUsername) // match preferred

----- 2) Pending panel audit (Direct tab only; do NOT send offer yet) -----
const me = qcDbHydration.getCurrentPlayerHydrationReport().username;
qcPersonalAudit.begin('trading-pending', {
  allowedPrefixes: [
    'config','cards','packs','groups','tradeIndexMeta','playerDirectory',
    'players/' + me,
    'playerTradeIndex/' + me,
  ],
});
// View Incoming + Outgoing only
qcPersonalAudit.end('trading-pending');
// FAIL if unexpected includes bare 'trades/direct' (full tree)
// IGNORE trades/listings if somehow present — out of D3 scope
// PASS when no full trades/direct read

----- 3) Parity -----
// Incoming/outgoing/status/sort/toasts match pre-D3
// processing trades do not appear as pending

----- 4) Duplicate-offer step (separate) -----
// Create offer for card X → success
// Try second offer same card X → DUPLICATE_PENDING_TRADE
// With verified index, create path must not full-scan trades/direct for duplicate
// (per-id trades/direct/{id} on later actions is OK)

----- 5) Untrusted ≠ empty -----
// If PTI unready + isolation ON: unavailable panels, not "No incoming/outgoing"
// Send Offer blocked with TRADE_INDEX_UNAVAILABLE

----- 6) Actions still canonical -----
// respond / confirm / decline / cancel still use trades/direct/{id}
// Write counts unchanged from S5c-B

----- 7) Metrics -----
// qcDbMetrics.summary() — tradingDirectSource:index present when healthy
// fallbackCount should be 0 during healthy verified-index use

PASS when 1–6 hold; listings remaining canonical is expected until D4+.
`);
}

/**
 * Pasteable verification workflow for Phase S5c-D4 (My Listings + max-active → PTI).
 * Narrow: My Listings reader + max-active source proof only.
 * Full Listings-tab trades/listings hits from getVisibleListings / expireStaleListings /
 * create-path reservations are EXPECTED D5/D6 noise — not a D4 fail.
 */
export function workflowS5cD4() {
  console.info(`
=== S5c-D4 My Listings + Max-Active → playerTradeIndex/{me}/listings ===

Prereq: normal player; D3 COMPLETE + VERIFIED.
Optional: localStorage.setItem('qc-personal-scope-audit','true');
location.reload();

----- 1) Registry -----
qcDbHydration.getSubscriptionRegistry()
// players/{me} ×1, playerTradeIndex/{me} ×1, playerDirectory ×1 (Trading open)
// playerTradeIndex refCount === 1 (no second PTI sub)
// NO listingsByGroup

qcTradeIndex.isPlayerTradeIndexReady(meUsername) // true
qcTradeIndex.shadowCompare(meUsername) // match preferred

----- 2) Isolated My Listings reader (D4 claim) -----
const me = qcDbHydration.getCurrentPlayerHydrationReport().username;
qcPersonalAudit.begin('trading-my-listings', {
  allowedPrefixes: [
    'config','cards','packs','groups','tradeIndexMeta','playerDirectory',
    'players/' + me,
    'playerTradeIndex/' + me,
  ],
});
qcTradeListings.getMyActiveListings(me);
qcPersonalAudit.end('trading-my-listings');
// PASS: no bare 'trades/listings' in unexpected
// FAIL only if getMyActiveListings itself full-scanned trades/listings while verified

NOTE: Opening/rendering the full Listings tab ALWAYS also runs expireStaleListings
+ getVisibleListings (D5). Those trades/listings hits are EXPECTED — ignore for D4.

----- 3) UI parity -----
// Trusted empty → "You have no active listings."
// Trusted with listings → cards, expires, cancel ids, (n/max) count
// processing listings do NOT appear as active/cancellable
// Untrusted → amber unavailable panel, NOT empty copy; count shows (—/max); no create form

----- 4) Create + max-active (behavioral + source proof) -----
// Create listing → success; appears in My Listings
// At maxActiveListingsPerPlayer → create blocked (MAX_ACTIVE_LISTINGS_REACHED)
// After create attempt at max (or any create), prove max-active used index:
qcTradeListings.getLastMaxActiveListingSource()  // expect 'index'
// Also: qcDbMetrics.summary() / lifecycle tags include tradingListingSource:index

DO NOT require zero trades/listings during full create — create validation
now uses buildTradingSelfAvailabilitySnapshot (D6). expireStaleListings /
Available discovery noise may still appear until D7.

// Cancel → frees capacity; create works again
qcTradeIndex.shadowCompare(me) // still clean after create/cancel

----- 5) Untrusted ≠ zero -----
// Isolation ON + unready index: unavailable UI; create → TRADE_INDEX_UNAVAILABLE

----- 6) Canonical actions + unchanged D5+ -----
// cancelListing still trades/listings/{id}
// Available Listings / expireStaleListings / listingsByGroup unchanged
// Root unchanged; PTI refCount still 1

PASS when 1–6 hold for D4 consumers; D5/D6 listings scans remain expected.
`);
}

/**
 * Pasteable verification workflow for Phase S5c-D5b (Available → listingsByGroup).
 * Narrow: isolated getVisibleListings only. Full Listings-tab expire + reservation
 * trades/listings hits are EXPECTED D7/D6 noise — not a D5b fail.
 */
export function workflowS5cD5b() {
  console.info(`
=== S5c-D5b Available Listings → listingsByGroup/{groupId} ===

Prereq: normal player; D5a COMPLETE + VERIFIED.
Optional: localStorage.setItem('qc-personal-scope-audit','true');
location.reload();

----- 1) Registry (Trading open) -----
qcDbHydration.getSubscriptionRegistry()
// players/{me} ×1, playerTradeIndex/{me} ×1, playerDirectory ×1,
// listingsByGroup/{groupId} ×1
// PTI refCount === 1; NO second group listener

qcDbHydration.getGroupListingsHydrationReport()
// ready, metaReady, globalVersionCurrent, active, groupId match

----- 2) Isolated Available discovery (D5b claim) -----
const me = qcDbHydration.getCurrentPlayerHydrationReport().username;
const g = (qcDbHydration.getCached('players/' + me) || {}).groupId;
qcPersonalAudit.begin('trading-visible-listings', {
  allowedPrefixes: [
    'config','cards','packs','groups','tradeIndexMeta','playerDirectory',
    'players/' + me,
    'playerTradeIndex/' + me,
    'listingsByGroup/' + g,
  ],
});
const visible = qcTradeListings.getVisibleListings(me);
console.log(visible.source, visible.trusted, visible.listings && visible.listings.length);
qcPersonalAudit.end('trading-visible-listings');
// PASS: source==='index', trusted===true, no bare 'trades/listings' in unexpected
// FAIL only if getVisibleListings itself full-scanned trades/listings while verified

NOTE: Full Listings-tab render ALWAYS also runs expireStaleListings (D7).
Create/accept may still scan trades/listings for reservations (D6).
Those are EXPECTED — ignore for D5b.

----- 3) UI parity -----
// Trusted empty → "No listings available in your group right now."
// Untrusted → amber unavailable (not empty copy); no accept buttons
// Accept still uses trades/listings/{id} (canonical)

----- 4) Leave Trading -----
// Switch away from Trading
qcDbHydration.getSubscriptionRegistry()
// listingsByGroup + playerDirectory gone; auth pair remains

----- 5) Optional group switch -----
// Admin reassign group → within ~5s: old group released, new subscribed, Trading full reset
// Never two listingsByGroup paths at once

PASS when 1–4 hold; expire listings scans remain expected until D7.
Reservation self-scans remediated in D6 (see workflowS5cD6).
`);
}

/**
 * Pasteable verification workflow for Phase S5c-D6 (Trading self-reservations → PTI).
 * Narrow: isolated buildTradingSelfAvailabilitySnapshot only.
 * Full Trading render may still hit trades/listings via expireStaleListings (D7)
 * and counterparty validation (canonical/D7) — those are NOT D6 fails.
 */
export function workflowS5cD6() {
  console.info(`
=== S5c-D6 Trading self-reservations → playerTradeIndex/{me} ===

Prereq: normal player; D5 COMPLETE + VERIFIED. Open Trading once so modules load
(or open Research — both install qcTradeAvailability).

Optional: localStorage.setItem('qc-personal-scope-audit','true');
location.reload();

----- 1) Registry -----
qcDbHydration.getSubscriptionRegistry()
// players/{me} ×1, playerTradeIndex/{me} ×1 (refCount === 1)
// + directory / listingsByGroup while Trading open — NO second PTI listener

----- 2) Isolated Trading self availability (D6 claim) -----
const me = qcDbHydration.getCurrentPlayerHydrationReport().username;
qcPersonalAudit.begin('trading-self-availability', {
  allowedPrefixes: [
    'config','cards','packs','groups','tradeIndexMeta',
    'players/' + me,
    'playerTradeIndex/' + me,
  ],
});
const tradingSnap = qcTradeAvailability.buildTradingSelfAvailabilitySnapshot(me);
console.log({
  source: tradingSnap.reservationSource,
  trusted: tradingSnap.reservationsTrusted,
  tradeCountSize: tradingSnap.tradeCounts && tradingSnap.tradeCounts.size,
});
qcPersonalAudit.end('trading-self-availability');
// PASS: source==='index', trusted===true
// PASS: no bare trades/direct or trades/listings full-tree reads in unexpected
// FAIL if isolated snapshot scanned trades/direct or trades/listings while verified

NOTE: Full Trading tab render ALWAYS also runs expireStaleListings (D7).
Accept/respond counterparty validation may still scan trades/* (canonical/D7).
Those are EXPECTED — ignore for D6.

----- 3) Trading / Research parity -----
const researchSnap = qcTradeAvailability.buildResearchAvailabilitySnapshot(me);
const parity = qcTradeAvailability.compareResearchTradingSelfAvailability(me);
console.log(parity);
// Expect: tradingSnap.reservationSource === 'index'
//         researchSnap.reservationSource === 'index'
//         parity.match === true
qcTradeIndex.shadowCompare(me)
// Expect: .match === true

----- 4) Misuse guard (self-scoped API) -----
const other = 'definitely_not_me_xyz';
const rejected = qcTradeAvailability.buildTradingSelfAvailabilitySnapshot(other);
console.log(rejected.reservationsTrusted, rejected.selfScopedRejected, rejected.reservationSource);
// Expect: trusted===false, selfScopedRejected===true, source==='unavailable'

----- 5) Behavioral (manual / non-programmer) -----
// No open trades/listings → pickers show available owned copies
// Create outgoing direct → offered card reserved (qty 2 → 1 available)
// Cancel direct → released
// Active listing → owner offered card reserved; cancel → released
// Direct + listing on different cards (or qty) add correctly
// Target respond → their requested card incoming-reserved after response
// Listing processing (if testable) → owner copy stays reserved
// Untrusted/isolation: pickers disabled + amber message (NOT empty-free list)
// create offer / create listing blocked with reservation unavailable/loading toast

----- 6) Metrics -----
// Healthy: tradingAvailabilitySource:index (and researchAvailabilitySource:index)
// Zero tradingAvailabilitySource:canonical-fallback / unavailable in normal use
qcDbMetrics.summary()

PASS when 1–4 hold for D6 self path; D7b expiry scans remain expected;
D7a remediates action-time foreign reservation trees (see workflowS5cD7a).
`);
}

/**
 * Pasteable verification workflow for Phase S5c-D7a (counterparty once-loads).
 * Narrow: action-scoped players/{other} + playerTradeIndex/{other}.
 * Scoped expiry may read trades/listings/{id} (D7b) — not a D7a fail.
 */
export function workflowS5cD7a() {
  console.info(`
=== S5c-D7a Counterparty once-loads + foreign PTI ===

Prereq: D6 COMPLETE + VERIFIED. Two players same group (e.g. Bobby / Bobby2).
Open Trading so modules load.

Optional: localStorage.setItem('qc-personal-scope-audit','true');
location.reload();

----- 1) Registry while browsing (no foreign action yet) -----
qcDbHydration.getSubscriptionRegistry()
// players/{me} ×1, playerTradeIndex/{me} ×1 (refCount === 1),
// playerDirectory ×1, listingsByGroup/{g} ×1
// NO players/{other} or playerTradeIndex/{other} subscriptions

----- 2) Isolated counterparty load helper -----
const me = qcDbHydration.getCurrentPlayerHydrationReport().username;
const other = 'PASTE_OTHER_USERNAME';
qcPersonalAudit.begin('trading-counterparty-load', {
  allowedPrefixes: [
    'config','cards','packs','groups','tradeIndexMeta',
    'players/' + me,
    'playerTradeIndex/' + me,
    'players/' + other,
    'playerTradeIndex/' + other,
  ],
});
const ctx = await qcTradeAvailability.loadTradingCounterpartyContext(other, { force: true });
console.log(ctx.ok, ctx.reservationSource, ctx.reservationsTrusted);
qcPersonalAudit.end('trading-counterparty-load');
// PASS: ok===true, source==='index', trusted===true
// PASS: no bare players / trades/direct / trades/listings

----- 3) Direct smoke (two browsers) -----
// Browser A (Bobby): send offer to Bobby2
// Browser B (Bobby2): respond with a card
// Browser A: confirm
// Optional: cancel/decline on a fresh offer
// After each action check registry still has NO foreign subscriptions
qcTradeIndex.shadowCompare('Bobby')
qcTradeIndex.shadowCompare('Bobby2')
// Inventories swapped correctly on confirm

----- 4) Listing smoke accept -----
// Owner creates listing; peer accepts → claim/fulfill
// Owner foreign context loaded via players/{owner} + playerTradeIndex/{owner} only
// Indexes + inventories clean
// Full two-browser race is D7c — not required to pass D7a

----- 5) Metrics -----
// foreignPlayerScopedLoad:ok, foreignTradeIndexScopedLoad:ok
// foreignReservationSource:index (healthy)
qcDbMetrics.summary()

NOTE: Full Trading render still runs expireKnownStaleListings (D7b) which may
read trades/listings/{specific id} only — not bare trades/listings.

PASS when 1–2 hold and 3–4 smoke succeed without bare-tree counterparty reads.
`);
}

/**
 * Pasteable verification workflow for Phase S5c-D7b (scoped listing expiry).
 * Distinguishes allowed trades/listings/{id} from forbidden bare trades/listings.
 */
export function workflowS5cD7b() {
  console.info(`
=== S5c-D7b Scoped listing expiry (no student full-tree scan) ===

Prereq: D7a COMPLETE + VERIFIED. Normal player; open Trading.

Optional: localStorage.setItem('qc-personal-scope-audit','true');
location.reload();

----- 1) Idle Trading ≥2 reactive cycles (~10s+) -----
const me = qcDbHydration.getCurrentPlayerHydrationReport().username;
const g = (qcDbHydration.getCached('players/' + me) || {}).groupId;
qcPersonalAudit.begin('trading-expiry-idle', {
  allowedPrefixes: [
    'config','cards','packs','groups','tradeIndexMeta','playerDirectory',
    'players/' + me,
    'playerTradeIndex/' + me,
    'listingsByGroup/' + g,
    'trades/listings/*', // children-only: allows trades/listings/{id}; FORBIDS bare trades/listings
  ],
});
// Wait ~12 seconds with Trading open (two+ 5s ticks)
qcPersonalAudit.end('trading-expiry-idle');
// PASS: no bare path 'trades/listings' (full tree) from expiry
// Allowed: trades/listings/{specificId} if any scoped cleanup ran

----- 2) Soft-expired own listing -----
// Create listing; force expiresAt in the past (Admin/DevTools on that listing id)
// Re-open / wait reactive tick:
// - disappears from My Listings
// - can create again (max-active free)
// - card available to offer (not reserved)
qcTradeListings.getMyActiveListings(me)
// After cleanup: canonical status expired; PTI + group leaves gone
qcTradeIndex.shadowCompare(me)

----- 3) Soft-expired group listing -----
// Peer Available: listing hidden
// Accept attempt → LISTING_EXPIRED / fail (D5a soft-expire still works)
// Indexes reconciled after scoped cleanup

----- 4) Processing listing -----
// If a listing is processing: D7b must NOT write expired
// status remains processing
// (Static inspection: expireKnownStaleListings only writes when status==='active')

----- 5) Full-tree repair still available (Admin/dev only) -----
// qcTradeListings.expireStaleListings  // explicit repair — not student runtime

----- 6) Registry -----
qcDbHydration.getSubscriptionRegistry()
// Still: players/{me}, playerTradeIndex/{me} refCount 1, directory, listingsByGroup
// NO new listeners from D7b

PASS when 1–4 hold; student Trading never full-scans trades/listings for expiry.
`);
}

/**
 * Pasteable final umbrella for Phase S5c-D7c / S5c-D Trading scoped cutover proof.
 * Children-only prefixes (trades/direct/*, trades/listings/*) forbid bare trees.
 * Healthy verified indexes must resolve source:index — any canonical-fallback FAILS the gate.
 */
export function workflowS5cD7() {
  console.info(`
=== S5c-D7 / S5c-D Final Trading Isolation Umbrella ===

Prereq: D7a + D7b COMPLETE + VERIFIED. Two same-group players (e.g. Bobby / Bobby2).
NOTE: S5c-D7c / S5c-D7 / S5c-D are COMPLETE + VERIFIED. Hybrid C+ Gates A/B/C COMPLETE + VERIFIED.
Final isolation G PASSED (audit + cache isolation ON; representative Trading action;
unexpectedTotal===0; hardViolations===0; no bare trees; no healthy canonical-fallback).
B/C/D gameplay + shadowCompare credited from Gate B/C relative-inventory verification
(not required to replay for D7c closure). Keep qc-direct-inventory-diag /
qc-listing-inventory-diag available for inventory proofs if re-checking.
Critical inventory regression (historical): sequential same-card directs ~3s apart
(prior “Black Hole” stale absolute write) must compose −2/+2 — enable:
  localStorage.setItem('qc-direct-inventory-diag','true');
Listing fulfill relative proof (Gate C):
  localStorage.setItem('qc-listing-inventory-diag','true');

Enable audit (+ optional isolation):
  localStorage.setItem('qc-personal-scope-audit','true');
  // localStorage.setItem('qc-personal-cache-isolation','true');
  location.reload();

Helper — paste before each labeled begin (edit OTHER):
const me = qcDbHydration.getCurrentPlayerHydrationReport().username;
const g = (qcDbHydration.getCached('players/' + me) || {}).groupId;
const OTHER = 'PASTE_COUNTERPARTY_USERNAME';
const allowTrading = [
  'config','cards','packs','groups','tradeIndexMeta',
  'playerDirectory',
  'players/' + me,
  'playerTradeIndex/' + me,
  'listingsByGroup/' + g,
  'players/' + OTHER,
  'playerTradeIndex/' + OTHER,
  'trades/direct/*',    // children-only — FORBIDS bare trades/direct
  'trades/listings/*',  // children-only — FORBIDS bare trades/listings
];

===== A) Registry / isolation baseline =====
Open Trading. Do not start a foreign action yet.
qcDbHydration.getSubscriptionRegistry()
// EXPECT: players/{me}×1, playerTradeIndex/{me}×1 (refCount===1),
//         playerDirectory×1, listingsByGroup/{g}×1
// EXPECT: NO foreign player/PTI subscriptions

qcPersonalAudit.begin('d7-registry', { allowedPrefixes: allowTrading });
// Idle ~5s
qcPersonalAudit.end('d7-registry');
// PASS: unexpectedTotal===0; no exact bare players|trades/direct|trades/listings

===== B) Two-browser direct happy path =====
// Browser A (Bobby): create offer → Bobby2
// Browser B (Bobby2): respond with a card
// Browser A: confirm
qcPersonalAudit.begin('d7-direct', { allowedPrefixes: allowTrading });
// …perform create/respond/confirm while session active…
qcPersonalAudit.end('d7-direct');
qcTradeIndex.shadowCompare('Bobby');
qcTradeIndex.shadowCompare('Bobby2');
// PASS: inventories correct; statuses terminal; shadows match===true
// PASS: no bare trees; foreign reads only players/{OTHER} + playerTradeIndex/{OTHER}
// FAIL if tradingDirectSource / tradingAvailabilitySource / foreignReservationSource
//      shows canonical-fallback during this healthy run

===== C) Listing happy path =====
// Owner creates listing; peer browses Available; peer accepts → claim → fulfill
qcPersonalAudit.begin('d7-listing', { allowedPrefixes: allowTrading });
// …perform create + accept…
qcPersonalAudit.end('d7-listing');
qcTradeIndex.shadowCompare(owner);
qcTradeIndex.shadowCompare(accepter);
// PASS: one swap; listing fulfilled; PTI+group leaves gone; shadows clean; no bare trees

===== D) Two-browser same-listing race =====
// Owner posts ONE listing. Two accepters each hold a requested card.
// Both open Available, select card, sync countdown, BOTH click Accept.
// PASS: exactly one success; other clean fail (LISTING_NOT_ACTIVE / stale);
//       one inventory exchange; listing fulfilled once; indexes removed;
//       shadowCompare both accepters + owner match===true

===== E) Processing protection =====
// STATIC ONLY — do not hand-edit processing.
// Code: expireKnownStaleListings only expires canonical status==='active'.
// PASS by inspection (no test-only lifecycle).

===== F) Expiry =====
// INHERIT D7b COMPLETE + VERIFIED.
// Optional smoke: qcPersonalAudit.workflowS5cD7b() idle step with trades/listings/*

===== G) Final isolation run =====
// Representative flow under isolation (create direct OR accept listing) with:
localStorage.setItem('qc-personal-cache-isolation','true'); // then reload once if needed
qcPersonalAudit.begin('d7-isolation', { allowedPrefixes: allowTrading });
// …one representative Trading action…
qcPersonalAudit.end('d7-isolation');
// PASS only if:
//   - no exact bare players / trades/direct / trades/listings
//   - no healthy canonical-fallback from Trading consumers
//   - specific-ID canonical reads ARE allowed (trades/direct/{id}, trades/listings/{id})

===== H) Group / lifecycle =====
// INHERIT D5b + static: leave Trading releases directory + listingsByGroup;
// auth PTI/players remain; no duplicate group listeners.

===== Metrics =====
qcDbMetrics.summary()
// Healthy: *Source:index tags; zero unexpected *canonical-fallback during gates

FINAL PASS when A–D and G hold; E static; F inherited; H inherited.
Historical close: S5c-D7c + S5c-D7 + S5c-D marked COMPLETE + VERIFIED after G PASS
(with B/C/D gameplay credited from Gate B/C). S5d also COMPLETE + VERIFIED.
Next roadmap phase: S6 (investigate/plan before implement).
`);
}

/**
 * Pasteable S5d live leaderboard summaries verification record (historical; do not replay D7 / Gate B/C).
 */
export function workflowS5d() {
  console.info(`
=== S5d Live Leaderboard Summaries ===

Status: COMPLETE + VERIFIED.
statKeys (Firebase-safe): totalResearchPoints, seasonalResearchPoints, projectsCompleted,
  packsOpened, tradesCompleted, uniqueCardsOwned, breakthroughs

Verification PASSED (do not re-run as a gate unless regressing):
- Firebase-safe statKey rebuild (ok===true; no dotted path segments)
- Seven summary values match player source fields
- Live Leaderboard rendering/ranking
- leaderboards ×1 while Leaderboard tab mounted
- Leaderboard hydration releases on leave (getLeaderboardsHydrationReport().active===false)
- Incremental RP summary updates
- Nested-stat writer (packsOpened) updates without rebuild
- Group/subgroup projection across all seven leaves
- Archived season/snapshot still render
- No foreign player subscriptions introduced
- Live leaderboard no longer depends on full players scan

Subscription expectations (not LB leaks):
- players/{me} ×1 — auth/session (expected while logged in)
- playerTradeIndex/{me} ×1 — auth/session (expected while logged in)
- leaderboards — tab-owned; must release when leaving Leaderboard

Replay helpers (optional regression only):
   await qcLeaderboardSummaries.rebuildLeaderboardSummaries()
   qcDbHydration.getCached('leaderboards/packsOpened/<you>')
   qcDbHydration.getSubscriptionRegistry()
   qcDbHydration.getLeaderboardsHydrationReport()

Next: S7 root-off investigate/plan (do not implement until approved). Do not begin S8 yet.
`);
}

/**
 * Pasteable S6a accessCodes scoped once-load verification (register + bootstrap).
 */
export function workflowS6a() {
  console.info(`
=== S6a accessCodes scoped once-load ===

Status: COMPLETE + VERIFIED.
Verification PASSED: no accessCodes subscription; valid/invalid/used register; login unaffected;
registration load report uses accessCodes/{code}; isolation audit unexpectedTotal===0, hardViolations===0.
Root remains ON. Next: S7 investigate/plan. Do not begin S7 implementation until approved.

Prereq: unused access code from Admin → Access (or starter seed).

1) Registry — no accessCodes subscription
   qcDbHydration.getSubscriptionRegistry()
   // PASS: no entry whose path is "accessCodes" or starts with "accessCodes/"

2) Valid unused code → register succeeds
   // On auth screen: new username + password + unused code → Register
   // PASS: account created; enters game (or prompts to continue)
   qcDbHydration.getAccessCodesLoadReport()
   // PASS: lastLoad.purpose === "register"
   // PASS: lastLoad.path === "accessCodes/<CODE>" (single leaf, not bare "accessCodes")
   // PASS: lastLoad.ok === true

3) Invalid code → rejected
   // Register with nonsense code
   // PASS: "Invalid access code." (or load-failure message if network failed)
   // PASS: no new player created

4) Already-used code → rejected
   // Reuse the code from step 2 (or any used code)
   // PASS: "This access code has already been used."

5) Normal login — no accessCodes dependency
   // Logout (or reload) → login with the new account
   // PASS: login works
   // PASS: getAccessCodesLoadReport().lastLoad is NOT updated by login
   //       (or purpose stays from last register/bootstrap — login never calls loadAccessCodeOnce)

6) Optional — distinguish bootstrap vs register
   // After fresh page load (before any register):
   qcDbHydration.getAccessCodesLoadReport()
   // Bootstrap seed: lastLoad.purpose === "bootstrap", path === "accessCodes"
   // After a register attempt: purpose === "register", path === "accessCodes/<CODE>"

7) Optional audit of registration get (not a subscribe)
   localStorage.setItem('qc-personal-scope-audit','true'); location.reload();
   // Stay on auth screen; begin before clicking Register.
   // Include the candidate username path — register legitimately checks players/{candidate} exists.
   const candidate = 'PASTE_CANDIDATE_USERNAME'; // lowercase trimmed username you will type
   qcPersonalAudit.begin('s6a-register', { allowedPrefixes: [
     'config','cards','packs','groups','tradeIndexMeta','accessCodes',
     'players/' + candidate
   ]});
   // Attempt register with that username + a test code (valid or invalid)
   const end = qcPersonalAudit.end('s6a-register');
   // PASS: unexpectedTotal===0, hardViolations===0
   // PASS: reads include get accessCodes/<CODE> (leaf), not a student subscribe
   // PASS: players/{candidate} get is allowed (username-taken check)
   // PASS: no accessCodes entry in getSubscriptionRegistry()

Historical close only — do not re-run as a gate unless regressing. Next: S7 investigate/plan.
`);
}

/**
 * Pasteable S6b logout personal-cache clear verification.
 */
export function workflowS6b() {
  console.info(`
=== S6b Logout / forced-exit personal cache clear ===

Status: COMPLETE + VERIFIED.
Verification PASSED: foreign personal cache cleared at logout; shared scopes preserved;
self scopes restore on login; no session-restore regression.
Root remains ON. Next: S7 investigate/plan. Do not begin S7 implementation until approved.

Historical regression checklist (do not re-run as a gate unless regressing):

1) While logged in as a normal player, open Trading and load a foreign counterparty
   (create/offer/accept path that once-loads players/{OTHER}).
   const OTHER = 'PASTE_COUNTERPARTY';
   qcDbHydration.getCached('players/' + OTHER)
   // PASS: foreign player object present (and often playerTradeIndex/{OTHER} after reservations load)

2) Note shared indexes still present (will be rechecked after logout):
   ['config','cards','packs','groups','playerDirectory','tradeIndexMeta','leaderboards']
     .map(p => [p, qcDbHydration.getCached(p) != null])

3) Logout (UI button). Console should log: [Auth S6b] Personal cache cleared
   After reload (auth screen), BEFORE logging back in:
   const r = qcAuthS6b.getLastPersonalCacheClearReport()
   // PASS: r.reason === 'logout'
   // PASS: r.playersCleared === true
   // PASS: r.playerTradeIndexCleared === true
   // PASS: r.sharedScopesPreserved === true
   // PASS: r.before.playerKeyCount >= 1 (included self and/or OTHER)
   // Note: after reload, root may refill players — the REPORT is the boundary proof.

4) Shared indexes were not targeted by clear (report.after.sharedPresent)
   // PASS: paths that were present before remain present in the report

5) Log back in as the same player
   // PASS: players/{me} + playerTradeIndex/{me} scopes restore (auth pair ×1)
   qcDbHydration.getSubscriptionRegistry()
   qcDbHydration.getCurrentPlayerHydrationReport()
   // PASS: no session-restore regression

Optional: forceLocalExit / cross-tab wipe should set reason forceLocalExit | crossTab
(same clear + report).
`);
}

/**
 * Pasteable S6d persist-allowlist preparation verification (read-only; enforcement OFF).
 */
export function workflowS6d() {
  console.info(`
=== S6d Persist allowlist preparation ===

Status: COMPLETE + VERIFIED.
Policy checks PASSED: enforcement OFF; personal paths allow/deny correct; shared roots allowed;
accessCodes/trades never; filterDbForPersist S7-ready; _persistLocal unchanged.
S6c intentionally deferred. Next: S7 investigate/plan (S6 COMPLETE). Do not begin S7 implementation until approved.

Historical regression checklist (do not re-run as a gate unless regressing):

1) Inspect policy
   qcPersistAllowlist.help()
   qcPersistAllowlist.getPersistAllowlistReport()
   // PASS: enforcementEnabled === false
   // PASS: alwaysRoots includes config,cards,packs,groups,tradeIndexMeta,
   //       playerDirectory,listingsByGroup,leaderboards,leaderboardSeasons,leaderboardSnapshots
   // PASS: personalRoots === ['players','playerTradeIndex']
   // PASS: neverRoots includes accessCodes (and trades)

2) Personal path tests (session user bobby)
   qcPersistAllowlist.shouldPersistPath('players/bobby', 'bobby')          // true
   qcPersistAllowlist.shouldPersistPath('players/bobby2', 'bobby')         // false
   qcPersistAllowlist.shouldPersistPath('playerTradeIndex/bobby', 'bobby') // true
   qcPersistAllowlist.shouldPersistPath('playerTradeIndex/bobby2', 'bobby')// false
   qcPersistAllowlist.shouldPersistPath('players', 'bobby')                // false (no bare tree)

3) Shared roots allowed
   qcPersistAllowlist.shouldPersistPath('config', 'bobby')                 // true
   qcPersistAllowlist.shouldPersistPath('leaderboards', 'bobby')           // true
   qcPersistAllowlist.shouldPersistPath('playerDirectory', 'bobby')        // true

4) accessCodes explicit never
   qcPersistAllowlist.shouldPersistPath('accessCodes', 'bobby')            // false
   qcPersistAllowlist.shouldPersistPath('accessCodes/ABC123', 'bobby')     // false

5) Persistence behavior unchanged
   // PASS: PERSIST_ENFORCEMENT_ENABLED === false
   // PASS: scicards_db may still contain full _db while root is ON
   // PASS: no localStorage migration/clear performed by S6d
`);
}

/**
 * Pasteable S7a persist-enforcement + sanitize-on-load verification (non-programmer).
 */
export function workflowS7a() {
  console.info(`
=== S7a Persist enforcement + sanitize-on-load ===

Status: COMPLETE + VERIFIED.
All checks passed: synthetic filtering; logged-out projection; enforced localStorage filtering;
logout flush; session/reload restoration; rollback to default-off/root-on.
Root stayed ON throughout S7a. Persist policy unchanged.
Next: S7 COMPLETE — optional default-flip plan or S8 (separate approvals).

Authority (reload-latched):
  localStorage.qc_persist_enforce === 'true'  OR  boot mode === scoped
  → enforcement ON
  Emergency root without persist flag → OFF
  (Historical S7a also accepted qc_scoped_loading; that key is deprecated for authority.)

Historical regression (do not re-run as a gate unless regressing):
  qcPersistAllowlist.getPersistEnforcementReport()
  qcPersistAllowlist.previewPersistFilter(synthetic, 'bobby')
`);
}

/**
 * Pasteable S7b dual-mode boot / root-skip verification (non-programmer).
 */
export function workflowS7b() {
  console.info(`
=== S7b Dual-mode boot (reload-required root skip) ===

Status: COMPLETE + VERIFIED.
All prescribed checks passed: default/root-on regression; scoped boot (mode===scoped,
rootListenerAttached===false, firebaseActive===true, rootSnapshots.total===0);
persist auto-on under qc_scoped_loading; allowlist-shaped cache; scoped self-hydration;
flag OFF + reload restored root-on. Full tab matrix intentionally deferred to later S7.
S7c is COMPLETE + VERIFIED. S7d + S7 overall COMPLETE + VERIFIED.
Scoped classroom default flip — COMPLETE + VERIFIED. S8a COMPLETE; S8b not started.

Historical authority was qc_scoped_loading opt-in; production default is now scoped.
S8d-0: qc_force_root_loading emergency root removed (ignored if still set in localStorage).

Historical regression: qcDbHydration.getBootModeReport() / qcDbMetrics.summary().bootMode
`);
}

/**
 * Pasteable S7c fail-closed + Admin access + LB archives verification.
 */
export function workflowS7c() {
  console.info(`
=== S7c Fail-closed fallbacks + Admin access + LB archives ===

Status: COMPLETE + VERIFIED.
All checks passed: root-on regression; scoped Trading canonical fallback denied;
no unsafe empty trades/* migration writes; Admin Access purpose admin-access;
student LB + Admin Seasons archive hydration; rollback to root-on.
No remaining S7c blocker. S7d + S7 COMPLETE + VERIFIED.
Scoped classroom default flip — COMPLETE + VERIFIED. S8a COMPLETE; S8b not started.

Historical regression (do not re-run as a gate unless regressing):
  qcTradeIndex.canAllowCanonicalTradeTreeFallback() under scoped → false
  qcDbHydration.getAccessCodesLoadReport() / getLeaderboardArchivesHydrationReport()
`);
}

/**
 * Pasteable S7d final evidence matrix (non-programmer). Alias: workflowS7().
 * Historical closure — COMPLETE + VERIFIED. Classroom default flip is separate.
 */
export function workflowS7d() {
  console.info(`
=== S7d Final Evidence Matrix ===

Status: COMPLETE + VERIFIED. S7 overall COMPLETE + VERIFIED.
D1–D11 PASSED (incl. auth scoped once-load before login/register cache checks).
Classroom default flip is separate (see workflowClassroomDefaultFlip). S8a COMPLETE; do not begin S8b until approved.

CREDITED: S7a persist; S7b dual-mode; S7c fail-closed/Admin/archives; Gate B/C; S6e.
Unique Cards correctness repair — COMPLETE + VERIFIED.

Historical regression (do not re-run as a gate unless regressing):
  Former opt-in: qc_scoped_loading=true → scoped; removeItem → root-on
`);
}

/** Alias for workflowS7d — umbrella print for S7 final evidence matrix. */
export function workflowS7() {
  return workflowS7d();
}

/**
 * Pasteable classroom scoped-default flip verification (non-programmer).
 * Do not replay Gate B/C or full S7d unless execution paths change unexpectedly.
 */
export function workflowClassroomDefaultFlip() {
  console.info(`
=== Scoped classroom default flip ===

Status: COMPLETE + VERIFIED.
Production-default scoped gameplay fully playable; trade hydration + claim
null-safety verified. S8c COMPLETE + VERIFIED.
S8d-0: emergency qc_force_root_loading removed — localStorage flag is ignored;
boot is always scoped / production-default.

Authority:
  default (any flags) → mode=scoped, reason=production-default, persist ON
  config/firebase/scopedLoadingEnabled → diagnostic only (not boot)
  qc_scoped_loading → deprecated / redundant for boot
  qc_force_root_loading → removed (S8d-0); no effect

Regression smoke:
  1) getBootModeReport() → scoped / production-default / rootListenerAttached false / persist true
  2) root snapshots total 0 (qcDbMetrics if enabled)
  3) login or session restore
  4) one personal surface
  5) Leaderboard smoke
  6) Trading idle — canAllowCanonicalTradeTreeFallback() === false
  7) one Trading action (Respond or Accept)
  8) logout / user-switch smoke
`);
}

/**
 * Pasteable scoped trade/listing canonical-by-ID hydration verification.
 */
export function workflowTradeCanonicalHydration() {
  console.info(`
=== Scoped trade/listing canonical-by-ID hydration ===

Status: COMPLETE + VERIFIED.
Classroom default flip — COMPLETE + VERIFIED. S8a COMPLETE; do not begin S8b until approved.

Evidence: cold Accept/Cancel (listing); cold Respond/Cancel/Confirm (direct);
missing IDs still NOT_FOUND; no bare trade-tree fallback.
Helpers: qcTradeAvailability.loadDirectTradeByIdOnce(id)
         qcTradeAvailability.loadListingByIdOnce(id)
Wired: respondToTrade, confirmTrade, declineTrade, cancelTrade,
       acceptListing, cancelListing

Prereq: production-default scoped (qc_force_root_loading removed / ignored after S8d-0).
Cold cache: after reload, PTI/index shows item but
  db.get('trades/direct/'+id) or trades/listings/{id} is null until action.

Smoke:
  1) Direct Respond from cold canonical cache → success (not TRADE_NOT_FOUND)
  2) Direct Cancel from cold canonical cache → success
  3) Listing Accept from cold canonical cache → reaches claim (not LISTING_NOT_FOUND)
  4) Listing Cancel from cold canonical cache → success
  5) Fake ID → still TRADE_NOT_FOUND / LISTING_NOT_FOUND after once-load null
  6) Audit/metrics: only trades/direct/{id} or trades/listings/{id} once-loads
  7) canAllowCanonicalTradeTreeFallback() === false under scoped
`);
}

/**
 * Pasteable scoped RTDB claim null-safety verification (listing + direct).
 */
export function workflowClaimNullSafety() {
  console.info(`
=== Scoped RTDB claim null-safety ===

Status: COMPLETE + VERIFIED.
Classroom default flip — COMPLETE + VERIFIED. S8a COMPLETE; do not begin S8b until approved.

Evidence: cold Listing Accept (sawSpeculativeNull → committed → fulfill);
cold Direct Confirm; same-listing one winner; missing IDs.
(Historical note: root-on claim regression was verified before S8d-0 removed emergency root.)
Fix: claimListingIfActive / claimDirectTradeIfAwaiting
  speculative null → return null (retry), not undefined (abort)
  win only if committed && status==='processing' && claimId matches
Console: [DB] listing-claim|direct-claim lost|committed { sawSpeculativeNull, ... }

Smoke (production-default scoped):
  1) Listing Accept, cold canonical cache
     - index active; db.get(trades/listings/id) null before action
     - hydrates by ID; claim wins; fulfillment succeeds
     - expect [DB] listing-claim committed (sawSpeculativeNull may be true)
  2) Direct Confirm, cold canonical cache → claim succeeds
  3) Same-listing race: two accepters → exactly one claim winner
  4) Genuine missing ID → not claimed / LISTING_NOT_ACTIVE or STALE (no synthetic processing)
  5) Inactive/expired listing → still rejected
  6) Resume workflowClassroomDefaultFlip with one Trading action
`);
}

/**
 * Pasteable card-art bounded retry verification (non-programmer).
 */
export function workflowCardArtRetry() {
  console.info(`
=== Card-art transient retry hardening ===

Status: COMPLETE + VERIFIED.

Behavior: first img error → emoji immediately → one same-URL retry after ~500ms
  (no cache-bust). Success restores art; failure keeps emoji. Max one retry.
Surfaces: any data-card-art-fallback=1 (Collection, modal, pack face, Research mini).

Recovery proof (deterministic):
  localStorage.setItem('qc_card_art_diag','true'); location.reload();
  // open Collection with art visible, then:
  await qcCardArtDiag.simulateTransientFailure()
Expect [CardArtDiag]: initial_failure → retry_attempted → retry_recovered
  and artwork restored without page reload.

Also verified: persistent fail / one-retry / no-loop; Collection + Research mini + modal.
`);
}

/**
 * Pasteable S8a security-docs / live-rules snapshot status (non-programmer).
 * Docs only — no Firebase Auth, no authorization rule tighten.
 */
export function workflowS8a() {
  console.info(`
=== S8a Rules docs + live snapshot ===

Status: COMPLETE. No authz deploy. No Firebase Auth yet.
Live rules (Console SoT; repo: database.rules.json):
  .read true / .write true + inventory leaf .validate numeric >= 0

SPLIT tracks (see docs/DATABASE_SCOPING_ROADMAP.md §8):
  S8a COMPLETE — honest docs, threat model, root matrix, snapshot
  S8b COMPLETE (Auth foundation; production default — see workflowAuthDefaultFlip)
  S8b+ P0 IMPLEMENTED — AWAITING VERIFICATION (see workflowS8bPlusP0)
  S8c-0 COMPLETE + VERIFIED (see workflowS8c0)
  S8c-1 COMPLETE + VERIFIED (locked rules live; see workflowS8c1)
  Auth production-default flip — COMPLETE + VERIFIED (workflowAuthDefaultFlip)
  S8c-2 IMPLEMENTED — AWAITING RULE DEPLOYMENT / VERIFICATION (workflowS8c2)
  S8d-0 COMPLETE + VERIFIED (force-root removed)
  S8d-1 IMPLEMENTED — AWAITING RULE DEPLOYMENT / VERIFICATION (workflowS8d1)
  S8d-2 COMPLETE + VERIFIED (workflowS8d2; directory rebuild safe)
  S8d-3 COMPLETE + VERIFIED (workflowS8d3; live LB rebuild safe)
  S8d-4a COMPLETE + VERIFIED (workflowS8d4a; admin PTI/LBG parent reads)
  S8d-4b COMPLETE + VERIFIED (workflowS8d4b; Trade Index rebuild safe)
  S8d-5a COMPLETE + VERIFIED (workflowS8d5a; Unique Cards repair safe)
  S8d-5b COMPLETE + VERIFIED (workflowS8d5b; Season + Lifetime Snapshot safe)
  S8d COMPLETE (Admin maintenance umbrella)

  S8b migration preference (planning only):
  Nearly all accounts disposable. Preserve at most bobby, one teacher, optional bobby2.
  Prefer one-time/manual reset over a large lazy dual-auth migration.
  New accounts → Auth native; long-term remove players/{u}.password after confidence.
  Admin authority after S8c-1: admins/{authUid} registry (not custom claims alone).

STOP: do not paste auth!=null rules from old theater samples; deploy only database.rules.json after S8c-1 verify checklist.
Foreign-PTI readiness warnings = diagnostic noise (not index corruption).
`);
}

/**
 * Pasteable S6e final isolation audit matrix (short labeled sessions; root stays ON).
 * Alias: workflowS6()
 */
/**
 * Pasteable S8b Firebase Auth foundation status (non-programmer).
 * Rules remain open. No S8c.
 */
export function workflowS8b() {
  console.info(`
=== S8b Firebase Auth foundation ===

Status: COMPLETE (foundation). Auth is now the production default — see workflowAuthDefaultFlip().
RTDB authorization is separate (S8c-1 locked rules).

Historical transitional flag qc_firebase_auth is RETIRED / IGNORED.
Production: Firebase Auth on by default (no localStorage prep).
Emergency developer rollback: localStorage.qc_force_legacy_auth='true' + reload.

Identity: username/password forms unchanged.
Internal Auth email: {username}@scicards.local (never shown to students).

Verification (historical S8b matrix; prefer workflowAuthDefaultFlip for launch):
  1) Default (no force-legacy) → Auth login for migrated accounts.
  2) Migrate with trusted script if needed: scripts/README-S8b-auth.md
  3) Wrong password → rejected by Firebase Auth.
  4) Logout / reload → session restore; forced exit signs out Auth.
  5) Fresh student register → Auth user + RTDB player + access code used;
     no new players/{u}.password hash.
  6) If RTDB write fails after Auth create → Auth user deleted (rollback).
  7) Teacher: migrate-user + set-admin-claim; __admin__ / config.adminPassword still work.
  8) Admin Players → Reset Password disabled while Auth authoritative;
     use: node scripts/s8b-auth-admin.mjs set-password <user> "NewPass!"
  9) Emergency: qc_force_legacy_auth='true' → hash login for accounts that still have hashes;
     Auth-native (no hash) cannot log in until flag removed.

Trusted script: scripts/s8b-auth-admin.mjs (+ scripts/README-S8b-auth.md)
Pasteable flip verify: qcPersonalAudit.workflowAuthDefaultFlip()
`);
}

/**
 * Pasteable Auth production-default flip status + clean-browser / rollback verify.
 */
export function workflowAuthDefaultFlip() {
  console.info(`
=== Firebase Auth production-default flip ===

Status: IMPLEMENTED — AWAITING VERIFICATION.
S8c-2 / Option C / Blaze / Functions: NOT in this slice.

Mode:
  Fresh browser / no flag     → Firebase Auth (production default)
  qc_force_legacy_auth=true   → legacy RTDB SHA-256 hash auth (developer only)
  Stale qc_firebase_auth=*    → IGNORED (does not control mode)

Emergency rollback (developer only — students never do this):
  localStorage.setItem('qc_force_legacy_auth','true'); location.reload();
Return to normal:
  localStorage.removeItem('qc_force_legacy_auth'); location.reload();

Known limitation:
  Auth-native accounts with no players/{u}.password cannot log in while
  qc_force_legacy_auth='true'. Restore Auth default (removeItem) to log them in.
  Migrated accounts that retained hashes can still use legacy rollback.

Legacy hashes are retained for emergency rollback — do not mass-delete in this slice.
__admin__ / config.adminPassword are independent of this flag.

Clean-browser verification (e.g. fresh Edge profile or InPrivate — NO localStorage prep):
  1) Open site → login/register UI (public gates hydrate; sharedDefs deferred).
  2) Confirm no need for qc_firebase_auth or qc_force_legacy_auth.
  3) Log in as Auth-migrated player (username + password) → succeeds.
  4) Reload → session restores.
  5) Logout → login screen; Auth signed out.
  6) Optional: register fresh username + password + access code → Auth user,
     RTDB player, no new password hash.
  7) Optional second InPrivate window: same login smoke.

Rollback verification (developer):
  A) setItem qc_force_legacy_auth=true + reload
  B) Migrated account WITH retained hash → legacy login works
  C) Auth-native WITHOUT hash → fails (expected)
  D) removeItem qc_force_legacy_auth + reload → Auth login works again
  E) __admin__ works in both modes

STOP: no RTDB rules changes; no tradeGrants; no S8c-2; no Option C.
`);
}

/**
 * Pasteable S8c-0 status (client prep before locked rules).
 * Rules still open. No tradeGrants. No Console rules deploy.
 */
export function workflowS8c0() {
  console.info(`
=== S8c-0 Spark client prep (foreign reads + admins registry) ===

Status: COMPLETE + VERIFIED.
S8c-1 (tradeGrants + locked database.rules.json) — see workflowS8c1().

What changed:
  - Trading counterparties load trade-visible children only
    (inventory, groupId/group, subgroupId, isTradeRestricted, isTradeProfileHidden)
    + separate PTI load — NOT the full players/{other} root.
  - Registration username-taken uses playerDirectory + players/{u}/authUid leaves.
  - Admin authority transitioning to admins/{authUid}: true
    Promote/Demote writes registry + players.isAdmin UI mirror.
  - Auth password reset still script-only; Delete Player = RTDB only (Auth orphan possible).

Legacy isAdmin() fallbacks (UNTIL S8c-1 rules lock):
  - session.isAdmin (incl. __admin__ password login)
  - players/{u}.isAdmin mirror
  Preferred when present: admins/{authUid} === true
  After S8c-1: only admins/{uid} is security authority.

Bootstrap first teachers (open rules / this install):
  1) Ensure teacher has Auth + players/{u}.authUid (migrate-user).
  2) Sign in as teacher → Admin password promote (writes admins/{uid})
     OR set admins/{uid}: true in Console / Admin SDK.
  3) Reload / re-login so registry is hydrated.

Verification (rules still open):
  A) Student Trading: create/accept direct + listing still works.
  B) After a foreign trade context load, inspect cache — foreign player should NOT
     carry password, activeSession, achievements, shop, etc.
     DevTools: after trading with bobby, check that db cache / qc helpers do not
     show players/bobby/password (full root should not have been once-loaded).
     Pasteable:
       const c = await qcTradeAvailability.loadTradingCounterpartyContext('bobby',{force:true,reservations:false});
       console.log(c.ok, Object.keys(c.player||{}));
     Expected keys only: username, authUid, inventory, groupId, group, subgroupId,
       isTradeRestricted, isTradeProfileHidden
  C) Admin → Manage player still shows full inventory/stats (full selected-player scope).
  D) Register with an existing username → "already taken" without loading full player.
  E) Teacher Admin panel still opens (registry and/or legacy fallback).
  F) Promote/Demote: RTDB shows admins/{targetUid} true/null AND players/{u}.isAdmin mirror.
  G) Smoke: login, pack open, research claim, scoped load unaffected.

Deferred: Option C, Blaze/Functions, Auth production-default flip (after S8c-1 verify).
Docs: docs/BEFORE_DISTRIBUTION.md
`);
}

/**
 * Pasteable S8c-1 status (tradeGrants + locked rules — NOT auto-deployed).
 * Console paste is required before live enforcement.
 */
export function workflowS8c1() {
  console.info(`
=== S8c-1 tradeGrants + locked RTDB rules ===

Status: IMPLEMENTED — AWAITING RULE DEPLOYMENT / VERIFICATION.
Do NOT assume Console matches repo until you paste database.rules.json.
Rollback artifact: database.rules.open-rollback.json

What shipped (client + in-repo rules):
  - claimerAuthUid stamped on direct/listing claim transactions
  - tradeGrants/{target}/{claimerUid} CREATE just before terminal settle
  - grant CLEAR on terminal success, release/fail, player-delete paths
  - Foreign inventory: grant + exact ±1 (give −1 / recv +1) + nonnegative
  - Locked database.rules.json: admins/{uid}, immutable authUid, private
    password/activeSession, no student parent read of foreign player,
    config/cards/packs/groups admin-only writes, accessCodes, trades,
    tradeGrants, exact foreign inventory grant rule
  - Foreign stats/LB grant-bound in S8c-2 — see workflowS8c2(); PTI/LBG remain accepted residuals

Local simulator proof (already run in implement session):
  npx firebase-tools emulators:exec --only database "node scripts/s8c1-rules-simulator.mjs"
  Proved: increment(±1) exact-delta PASS; fake grant FAIL; unrelated foreign FAIL;
  honest direct + listing settlement PASS;
  auth playerDirectory + tradeIndexMeta parent reads PASS;
  student accessCodes parent FAIL / admin PASS; foreign players/{other} FAIL.

Live-blocker fix (post first Console publish):
  - playerDirectory parent .read auth!=null (safe social projection)
  - tradeIndexMeta .read auth!=null (schemaVersion/rebuiltAt only; write still admin)
  - accessCodes parent .read admin-only; student boot no longer enumerates/seeds
  - Registration/pre-auth: public only config/gameOpen + config/registrationOpen;
    Auth-first register/login; sharedDefs deferred until authenticated
  - Registration multipath: inventory validate allows same-write authUid parent;
    access-code consume is single-path merge (not leaf multipath)
  Republish full database.rules.json after pulling this fix.

BEFORE Console deploy (checklist):
  1) Every classroom account that must play has players/{u}.authUid
  2) Teacher(s) have admins/{authUid}: true (Console or Promote while open)
  3) Firebase Auth Email/Password ON (Auth is production default; no qc_firebase_auth prep)
  4) Copy CURRENT Console rules to a safe note (or keep open-rollback file)
  5) Paste repo database.rules.json into Console → Publish
  6) Immediately run verification below
  7) On failure: paste database.rules.open-rollback.json → Publish

Live verification (Auth ON; throwaway test accounts preferred):
  A) Honest direct trade completes; both inventories correct; grant gone after
  B) Honest listing fulfill completes; inventories correct; grant gone after
  C) Student cannot write players/{other}/inventory/{unrelatedCard}
  D) Student cannot invent tradeGrants without live matching claim
  E) Teacher Admin panel: config/cards still writable; student cannot
  F) Register with unused access code still works
  G) Self pack open / research still works (own inventory)
  H) Peek grant during settle (optional diag): tradeGrants/{target}/{uid}

Auth production-default flip: see qcPersonalAudit.workflowAuthDefaultFlip().
S8c-2: see qcPersonalAudit.workflowS8c2() (grant-bound foreign stats/achievements/LB).
`);
}

/**
 * Pasteable S8c-2 residual cross-player write hardening.
 */
export function workflowS8c2() {
  console.info(`
=== S8c-2 residual cross-player write hardening ===

Status: IMPLEMENTED — AWAITING VERIFICATION
  (rules published; settlement blocker client fix also awaiting live verify).

Rules: FULL database.rules.json already published for S8c-2 grant binding.
Settlement blocker fix is CLIENT-ONLY (no rules republish required for this fix).
Rollback file database.rules.open-rollback.json UNCHANGED.

Hardened (owner | admin | live tradeGrant for that username):
  players/{u}/stats
  players/{u}/achievements
  players/{u}/progression
  players/{u}/lastDirectTradeAt
  leaderboards/{statKey}/{u}
Validates:
  grant-authorized stats/tradesCompleted exact previous+1
  progression/firstTrade may only become true under grant (owner/admin may set false on register)
lastListingAcceptAt: owner | admin ONLY (settlement never writes it foreign)

Settlement blocker fix (client planners):
  Both sides tradesCompleted → ServerValue.increment(1) (never cache-blind absolute)
  Both sides leaderboards/tradesCompleted/{u}/value → ServerValue.increment(1) + updatedAt + group projection
  Claimer achievements: hydrate map before plan; mutation builders never downgrade claimed/claimedAt
  Skip foreign achievements in terminal multipath
  Inventory-derived unique/aura absolute overlays unchanged
  Foreign achievement catch-up on victim login eval
  After deploy: one-time qcLeaderboardSummaries.rebuildLeaderboardSummaries() recommended to heal pre-fix stale LB rows

Accepted residuals (NOT tightened):
  playerTradeIndex — any auth write (rebuildable index)
  listingsByGroup — any auth write (rebuildable index)
  Foreign tradesCompleted leaderboard / achievements catch up on victim login eval
Self-cheating (own inventory/stats) remains outside the threat model.

Hygiene:
  tradeGrants/{target} parent .read → admin | target-owner only (claimer leaf still readable)
  playerDirectory create-when-player-missing without authUid proof → DEFERRED

Local proof:
  npx firebase emulators:exec --only database "node scripts/s8c1-rules-simulator.mjs"

Live verification (after client deploy of planner fix):
  1) Honest Direct Trade → both inventories + claimer stats OK; foreign tradesCompleted +1; grant cleared
  2) Honest Listing fulfill → same
  3) DevTools as student A: set players/{B}/stats/tradesCompleted → PERMISSION_DENIED
  4) DevTools: set leaderboards/tradesCompleted/{B} → PERMISSION_DENIED
  5) Own pack open / research / self stats still work
  6) Teacher Admin config/cards writes still work
  7) Note: PTI/LBG foreign writes still succeed (accepted residual)

Stuck processing recovery (do not manually edit canonical trade fields):
  Prefer claimer-owned releaseDirectClaimAndRestoreIndex(tradeId, claimId, reason).
  Reopening Trading does NOT auto-release another user's stuck claim; there is no TTL sweeper.
  Admin Rebuild Trade Indexes only repairs PTI/LBG after release — it does not release claims.

STOP: no Option C; no PTI/LBG redesign; no Auth changes; no grant-model weaken to auth!=null.
  S8d-1 admin canonical reads: see qcPersonalAudit.workflowS8d1().
`);
}

/**
 * Pasteable S8d-1 admin canonical parent-read foundation.
 */
export function workflowS8d1() {
  console.info(`
=== S8d-1 Admin canonical-read foundation ===

Status: IMPLEMENTED — AWAITING RULE DEPLOYMENT / VERIFICATION
Republish FULL database.rules.json (Console). Rollback artifact unchanged.

Rules (admin-only parent .read; child rules unchanged; no write changes):
  players
  trades/direct
  trades/listings
Authority: auth!=null && admins/{auth.uid}===true

Security:
  Students still cannot enumerate those parents.
  Admin /players parent intentionally returns full player records
  (incl. legacy password/activeSession when present) — trusted teacher only.
  Known-trade child reads (auth) unchanged.

Client helper: js/admin-maintenance.js → window.qcAdminMaintenance
  Soft-gate: Firebase Auth uid + admins/{uid} (NOT session.isAdmin / players.isAdmin)
  complete===true only for authoritative Firebase parent reads
  empty complete tree (value null) ≠ load failure
  Later rebuilds MUST use result.value/keys — cache is NOT canonical truth

Local proof:
  npx firebase emulators:exec --only database "node scripts/s8c1-rules-simulator.mjs"

Live (after rules publish):
  1) Student: await qcDbHydration.loadPathOnce('players',{force:true}) → fail
  2) Admin: await qcAdminMaintenance.adminLoadCanonical('players')
     → complete:true; count ≈ Console / directory
  3) Student: loadPathOnce('trades/direct',{force:true}) → fail
  4) Admin: adminLoadDirectTrades() / adminLoadListings() → complete:true
  5) Student Trading / packs still work
  6) Leaderboard rebuild is S8d-3 (workflowS8d3); Trade Index rebuild still UNSAFE

STOP: no Option C; no Blaze; no PTI/LBG tighten.
`);
}

/**
 * Pasteable S8d-2 safe Player Directory rebuild.
 */
export function workflowS8d2() {
  console.info(`
=== S8d-2 Player Directory rebuild (safe under scoped) ===

Status: COMPLETE + VERIFIED
No rules change / no Console republish for this slice.

Gather (fail-closed):
  adminLoadCanonical('players') → complete===true required
  loadPathOnce('playerDirectory',{force:true}) → ok && mode==='firebase'
Plan: buildPlayerDirectoryRebuildPlan({ playersSnapshot, directorySnapshot })
  Pure — no db.getChildren / cache as player universe
  Idempotent compare: null/missing groupId|subgroupId and missing false booleans are equal
    (Firebase drops null keys on write — directoryEntriesEqual normalizes both sides)
Commit: one updateAcknowledged(updates); UI previews counts then commits same plan

Unit proof:
  node scripts/s8d2-directory-planner.test.mjs
  After a successful rebuild, second preview should show Update:0 / Unchanged:N

Live (Admin teacher):
  1) Admin → Players → Rebuild Directory
  2) Inspect preview counts vs class size; Cancel once → zero writes
  3) Confirm when sane; toast shows created/updated/removed
  4) Optional: add playerDirectory/_s8d2_ghost_test → rebuild → removed
  5) Optional: null one test player's directory leaf → rebuild → restored
  6) Trading partner picker still works
  7) Leaderboard rebuild is S8d-3 (workflowS8d3); Trade Index still UNSAFE

STOP: no trade-index / unique / season rebuild rewrites in this slice.
`);
}

/**
 * Pasteable S8d-3 safe live Leaderboard summaries rebuild.
 */
export function workflowS8d3() {
  console.info(`
=== S8d-3 Live Leaderboard rebuild (safe under scoped) ===

Status: IMPLEMENTED — AWAITING VERIFICATION
No rules change / no Console republish for this slice.

Canonical: players/{username}
Derived:   leaderboards/{statKey}/{username}  (seven live keys; dense include-zero)
Untouched: leaderboardSeasons / leaderboardSnapshots

Gather (fail-closed):
  adminLoadCanonical('players') → complete===true; use result.value / keys only
  loadPathOnce('leaderboards',{force:true}) → ok && mode==='firebase'
  Confirmed null leaderboards = empty tree (valid)
Plan: buildLeaderboardRebuildPlan({ playersSnapshot, leaderboardSnapshot, now })
  Pure — no db.getChildren('players') as universe
  Equality: value + groupId + subgroupId only (updatedAt ignored)
  Null/missing group fields equivalent; non-finite value → 0
Commit: prepareLeaderboardRebuild → preview → commitLeaderboardRebuildPlan(same plan)
  One updateAcknowledged(updates); cancel = zero writes

Unit proof:
  node scripts/s8d3-leaderboard-planner.test.mjs

Live (Admin teacher):
  1) Admin → Leaderboards → Rebuild Leaderboard Summaries
  2) Preview: Players scanned / Rows create|update|remove|unchanged
     Copy states historical seasons/snapshots are NOT changed
  3) Cancel once → reopen → counts match; zero writes
  4) Confirm; first run may show many creates (expected after prior unsafe wipe)
  5) Reopen immediately → create/update/remove all 0
  6) Controlled: set one leaderboards/{stat}/{user}/value wrong → preview 1 update → repair → next 0
  7) Student Leaderboard tab still filters by group; season/snapshot views unchanged
  8) Trade Index rebuild is S8d-4b (workflowS8d4b)

DevTools:
  await qcLeaderboardSummaries.prepareLeaderboardRebuild()
  typeof qcLeaderboardSummaries.buildLeaderboardRebuildPlan

STOP: no Trade Index / Unique Cards / season reset rewrites; no rules changes.
`);
}

/**
 * Pasteable S8d-4a admin parent reads for derived Trade Index roots.
 */
export function workflowS8d4a() {
  console.info(`
=== S8d-4a Admin reads for derived Trade Index roots ===

Status: IMPLEMENTED — AWAITING RULE DEPLOYMENT / VERIFICATION
Must republish full database.rules.json (Console).
Rollback file database.rules.open-rollback.json unchanged.
S8d-4b Trade Index rebuild rewrite — NOT STARTED (do not treat rebuild as safe yet).

Rules (narrow read-only broaden for admins):
  playerTradeIndex parent .read → auth + admins/{uid}
  listingsByGroup parent .read → auth + admins/{uid}
  Child $username / $groupId read+write rules UNCHANGED
  Any-auth PTI/LBG writes remain accepted S8c residual (NOT tightened)

Local proof:
  npx firebase emulators:exec --only database "node scripts/s8c1-rules-simulator.mjs"

Live (after rules publish; Admin teacher Auth + admins/{uid}):
  1) Student: await qcDbHydration.loadPathOnce('playerTradeIndex',{force:true}) → fail
  2) Admin:   await qcDbHydration.loadPathOnce('playerTradeIndex',{force:true})
       → ok && mode==='firebase' (may enumerate PTI usernames)
  3) Student: loadPathOnce('listingsByGroup',{force:true}) → fail
  4) Admin:   loadPathOnce('listingsByGroup',{force:true}) → ok && mode==='firebase'
  5) Student known child still works:
       loadPathOnce('playerTradeIndex/'+me,{force:true}) → ok
  6) Trading still works (writes residual unchanged)
  7) Do NOT run Rebuild Trade Indexes as "safe" yet — that is S8d-4b

STOP: no S8d-4b rebuild rewrite; no write tighten; no Directory/LB/Auth changes.
`);
}

/**
 * Pasteable S8d-4b safe Trade Index rebuild (re-gather on confirm).
 */
export function workflowS8d4b() {
  console.info(`
=== S8d-4b Safe Trade Index rebuild ===

Status: IMPLEMENTED — AWAITING VERIFICATION
No rules change (S8d-4a already live). Schema version stays 1.

Concurrency model (required):
  Preview = advisory gather+plan
  Confirm = RE-GATHER all roots + fresh plan + commit
  Never commit the preview plan (students may claim/settle during wait)

Gather (fail-closed):
  adminLoadCanonical('players'|'trades/direct'|'trades/listings') → complete===true
  loadPathOnce('groups'|'playerTradeIndex'|'listingsByGroup'|'tradeIndexMeta',{force:true})
    → ok && mode==='firebase' (null = empty OK)
Plan: buildTradeIndexRebuildPlan({ ...snapshots, now }) — pure; path invariant
  Only writes under playerTradeIndex/ | listingsByGroup/ | tradeIndexMeta/
  Soft-expired actives omitted (match browse); missing groups skip LBG (skippedMissingGroup)
  _meta equality: ready+v only; rebuiltAt stamped only with content writes

Unit:
  node scripts/s8d4-trade-index-planner.test.mjs

Live (Admin teacher; quiet Trading preferred):
  1) Admin → Players → Rebuild Trade Indexes → preview counts; Cancel once
  2) Confirm → toast shows FRESH post-confirm counts (may differ slightly)
  3) Immediate second preview → content/readiness zeros
  4) Corrupt: delete one PTI leaf for open Direct → preview create 1 → repair
  5) Corrupt: add bogus PTI direct leaf → preview remove 1 → repair
  6) Corrupt: _meta.ready=false → readiness repair
  7) Corrupt: remove one LBG leaf for active listing → create 1 → repair
  8) Confirm trades/* and inventories unchanged; Unready warnings quiet for current players
  9) Smoke: create Direct → confirm; create Listing → fulfill

STOP: no rules; no settlement rewrite; S8d-5a Unique Cards is separate (workflowS8d5a).
`);
}

/**
 * Pasteable S8d-5a safe Unique Cards Owned repair.
 */
export function workflowS8d5a() {
  console.info(`
=== S8d-5a Unique Cards Owned repair (safe under scoped) ===

Status: COMPLETE + VERIFIED. S8d umbrella: COMPLETE.
No rules change. Option C-a authDirectory: see workflowOptionCa().

Definition (unchanged): Number(qty)>0 AND card in catalog AND enabled!==false
  orphans/disabled ignored; inventory never mutated; achievements not touched

Gather (fail-closed):
  adminLoadCanonical('players') → complete===true
  loadPathOnce('cards',{force:true}) → ok && mode==='firebase'
  loadPathOnce('leaderboards/uniqueCardsOwned',{force:true}) → ok && mode==='firebase'
Plan: buildUniqueCardsRepairPlan({ playersSnapshot, cardsSnapshot, leaderboardSnapshot, now })
  Writes ONLY: players/{u}/stats/uniqueCardsOwned + leaderboards/uniqueCardsOwned/{u}
  LB written only when stored uniqueCardsOwned needs repair (LB-only drift → use S8d-3)
Commit: prepare → preview → commit SAME plan (one updateAcknowledged)

Unit: node scripts/s8d5a-unique-cards-repair.test.mjs

Live (Admin teacher):
  1) Pick a player; note inventory-derived unique count (DevTools / Collection)
  2) Manually set ONLY players/{u}/stats/uniqueCardsOwned to a wrong number (not inventory)
  3) Admin → Leaderboards → Repair Unique Cards Owned → preview: needing repair ≥1
  4) Cancel once → zero writes; reopen → same advisory counts
  5) Confirm → toast changed; inventory unchanged; LB uniqueCardsOwned matches
  6) Immediate second preview → Players needing repair: 0
  7) Do NOT run Start New Season / Snapshot as part of 5a

STOP: no S8d-5b required for 5a verify; no achievements; no rules.
`);
}

/**
 * Pasteable S8d-5b safe Start New Season + Lifetime Snapshot class operations.
 */
export function workflowS8d5b() {
  console.info(`
=== S8d-5b Season + Lifetime Snapshot class ops (safe under scoped) ===

Status: COMPLETE + VERIFIED. S8d umbrella: COMPLETE.
No rules change. No schema bump. database.rules.json unchanged.

Authoritative gather: adminLoadCanonical('players') complete===true
  (+ forced leaderboardSeasons / snapshot id reads where needed)
Never use db.getChildren('players') / cache as class universe.
EMPTY_CLASS (playersScanned===0 after excluding __admin__) → refuse all ops.

Start New Season:
  prepareStartNewSeason → preview → Confirm RE-GATHERS
  Recheck activeSeasonId vs preview; mismatch → ABORT zero writes
  Phase A archive entries → await → Phase B rotate multipath → await
  → Phase C seasonal RP reset multipath → await
  Fail codes: SEASON_ARCHIVE_FAILED | SEASON_ROTATE_FAILED | SEASON_RESET_FAILED

Lifetime Snapshot:
  prepareLifetimeSnapshot → preview → Confirm RE-GATHERS + fresh snapshotId
  await snapshot write; if resetAfter await reset multipath
  Fail codes: SNAPSHOT_WRITE_FAILED | SNAPSHOT_RESET_FAILED
  Seasonal RP never a Lifetime reset category

Unit: node scripts/s8d5b-season-snapshot.test.mjs

Live QA credited:
  Tier 2 — Start New Season preview (5 players) cancelled; zero writes
  Tier 2/3 — Lifetime Snapshot Packs Opened preview; disposable snapshot-only
    created (full class); live pack open changed only live LB; historical
    snapshot unchanged; snapshot deleted. No resetAfter; no real Start Season.

Deferred (not S8d blockers): Repair Game Admin tab / Admin UX cleanup /
  Config review — docs/BEFORE_DISTRIBUTION.md Future Admin UX section.
  Option C / first-admin bootstrap — same file.

STOP: no new implementation from this workflow paste; no Option C planning here.
`);
}

/**
 * Pasteable Option C-a authDirectory (C-a.2 production-default strict).
 */
export function workflowOptionCa() {
  console.info(`
=== Option C-a.2 authDirectory (production-default STRICT) ===

Status: C-a.2 IMPLEMENTED — AWAITING LIVE VERIFICATION
C-a.1 / C-a.1.1 LIVE VERIFIED (backfill, existing logins, disposable register, LB username).
C-a.2 = production-default strict: authDirectory required for login/restore.
No password reset / Delete Player Auth changes (C-b). No rules change for C-a.2.

Schema: authDirectory/{username} = { loginEmail, authUid, generation }
  gen0 loginEmail = "{u}@scicards.local" (synthetic — not a real inbox)
  players/{u}.authUid remains ownership authority
  Live LB: leaderboards/{stat}/{u} = { username, value, groupId, subgroupId, updatedAt }

Production:
  Directory present → use loginEmail + verify authUid
  Directory missing/invalid → FAIL CLOSED
  Fresh browsers require authDirectory by default (no Admin localStorage rollout)

Developer emergency ONLY (this browser):
  localStorage.setItem('qc_auth_directory_compat', 'true')
  // or qcAuth.enableAuthDirectoryCompat()
  → temporary gen0 missing-directory fallback (NOT normal production)

Separate emergency:
  qc_force_legacy_auth=true → full legacy RTDB-hash path (not authDirectory)

Backfill: await qcAuth.backfillAuthDirectory() — migration/emergency tooling only
  (never auto during student login; still idempotent)

Live verify (short — registration already verified under C-a.1.1):
  1) Deploy C-a.2 client
  2) Hard refresh / fresh browser context preferred
  3) qcAuth.getOptionCaStatus()
       // PASS: optionCaFoundationVersion === 'option-c-a-2'
       // PASS: strictDefault === true
       // PASS: migrationCompatDefault === false
       // PASS: authDirectoryCompatEnabled === false
  4) Login with one existing backfilled account
  5) Logout / login
  6) Reload / restore
  7) Confirm normal game access

Safe negative (optional, no account damage):
  In DevTools on a logged-out page:
    const t = await qcAuth.resolveAuthLoginTarget('__nobody_missing_ca2__')
    // PASS: t.ok === false && (t.code === 'AUTH_DIRECTORY_REQUIRED' || /missing/i.test(t.error))
  Do NOT delete a real authDirectory leaf to prove strictness.

*** STOP GATE — after live verify, STOP. Do not begin C-b here. ***

Legacy: qc_force_legacy_auth path does not require authDirectory.
Unit: node scripts/option-c-a-auth-directory.test.mjs
`);
}

/**
 * Pasteable S8b+ P0 Trusted Teacher Functions foundation status.
 * No password reset / delete / promote. No S8c rules.
 */
export function workflowS8bPlusP0() {
  console.info(`
=== S8b+ P0 Trusted Teacher Functions foundation ===

Status: IMPLEMENTED — AWAITING VERIFICATION.
RTDB authorization rules unchanged (still open). No password/delete/promote callables yet.

Docs: docs/S8b-PLUS-TEACHER-OPS.md

Developer setup (once):
  1) Firebase Console → Blaze plan for quantum-collectors-v2
  2) npm install -g firebase-tools && firebase login
  3) cd functions && npm install && cd ..
  4) firebase deploy --only functions

Exact deploy:
  firebase deploy --only functions

Bootstrap teacher claim (local script, not teachers):
  node scripts/s8b-auth-admin.mjs set-admin-claim <teacherUsername>
  Then teacher sign out / sign in so admin:true is on the ID token.

Verification (Auth flag ON; DevTools):
  A) Signed out of Firebase Auth:
       await qcTeacherOps.pingTeacherOps()
     → { ok:false, code:'unauthenticated', ... }
  B) Signed in as student (no admin claim):
       await qcTeacherOps.pingTeacherOps()
     → { ok:false, code:'permission-denied', ... }
  C) Signed in as teacher with admin:true:
       await qcTeacherOps.pingTeacherOps()
     → { ok:true, data:{ ok:true, command:'pingTeacherOps', uid, admin:true, message } }

STOP: no S8c; no RTDB rule tighten; no Cat1 classroom ops beyond ping.
`);
}


export function workflowS6e() {
  console.info(`
=== S6e Final Isolation Audits ===

Status: COMPLETE + VERIFIED.
Final qcPersonalAudit.summary(): overall PASS; s6e-personal / trading-idle / trading-action /
leaderboard all PASS; unexpected===0 every label; knownScopedBlockers: []; no unexplained reads.
(summary() may still say phase:'S4' and mention PARTIAL — audit-helper metadata only; no S6e PARTIAL.)
S6 — COMPLETE + VERIFIED (S6c intentionally deferred, not a blocker).
Root remains ON. Next: investigate/plan S7 root-off. Do not begin S7 implementation until approved.

CREDITED (do not replay):
- S6a registration isolation
- Gate B/C trade correctness
- D7 listing races / contention
- S5d rebuild/writer matrix
- D7 Gate G shape for Trading isolation (still ran short action smoke in S6e)

Historical regression matrix (do not re-run as a gate unless regressing):

PASS every label: unexpectedTotal===0 AND hardViolations===0
Also: no bare players | playerTradeIndex | trades/direct | trades/listings
No healthy *canonical-fallback when indexed/scoped source is expected.

Expected always-on (not leaks): players/{me} ×1, playerTradeIndex/{me} ×1
Tab-owned: Trading → playerDirectory + listingsByGroup/{g}; Leaderboard → leaderboards
(release on leave)

----- Prereq -----
localStorage.setItem('qc-personal-scope-audit','true');
localStorage.setItem('qc-personal-cache-isolation','true');
location.reload();
// Login as a normal student (not __admin__)
qcPersonalAudit.reset();

const me = qcDbHydration.getCurrentPlayerHydrationReport().username;
const g = (qcDbHydration.getCached('players/' + me) || {}).groupId;
const OTHER = 'PASTE_COUNTERPARTY'; // only for trading-action label

const allowPersonal = [
  'config','cards','packs','groups','tradeIndexMeta',
  'players/' + me, 'playerTradeIndex/' + me
];
const allowTradingIdle = [
  ...allowPersonal, 'playerDirectory', 'listingsByGroup/' + g,
  'trades/direct/*', 'trades/listings/*'
];
const allowTradingAction = [
  ...allowTradingIdle, 'players/' + OTHER, 'playerTradeIndex/' + OTHER
];
const allowLb = [
  ...allowPersonal, 'leaderboards', 'leaderboardSeasons', 'leaderboardSnapshots'
];

Spot-check anytime:
  qcDbHydration.getSubscriptionRegistry()
  // auth pair ×1 while logged in

----- A) Personal (one practical session covering major tabs) -----
qcPersonalAudit.begin('s6e-personal', { allowedPrefixes: allowPersonal });
// Visit shell + Collection, Packs, Projects, Shop, Profile, Achievements
// (brief browse each; no Trading / Leaderboard in this session)
const a = qcPersonalAudit.end('s6e-personal');
// PASS: a.unexpectedTotal===0 && a.hardViolations===0

----- B) Trading idle -----
qcPersonalAudit.begin('s6e-trading-idle', { allowedPrefixes: allowTradingIdle });
// Open Trading; idle ~5–12s (expiry tick OK); do not complete a trade yet
const b = qcPersonalAudit.end('s6e-trading-idle');
// Leave Trading → directory + listingsByGroup released; auth pair remains

----- C) Trading action smoke (one action only) -----
qcPersonalAudit.begin('s6e-trading-action', { allowedPrefixes: allowTradingAction });
// ONE representative action: create direct OR accept listing (not Gate B/C suite)
const c = qcPersonalAudit.end('s6e-trading-action');

----- D) Leaderboard -----
qcPersonalAudit.begin('s6e-leaderboard', { allowedPrefixes: allowLb });
// Open Leaderboard; switch 2–3 categories; optional season/snapshot view; leave
const d = qcPersonalAudit.end('s6e-leaderboard');

----- Final -----
qcPersonalAudit.summary()
// PASS: all s6e-* labels PASS; overall PASS
`);
}

/** Alias for workflowS6e — umbrella print for S6 final isolation matrix. */
export function workflowS6() {
  return workflowS6e();
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcPersonalAudit = {
    PERSONAL_AUDIT_LS_KEY,
    PERSONAL_ISOLATION_LS_KEY,
    KNOWN_SCOPED_BLOCKERS,
    REMEDIATED_SCOPED_BLOCKERS,
    begin,
    end,
    start,
    stop,
    report,
    summary,
    reset,
    help,
    workflow,
    workflowS5b,
    workflowS5cC,
    workflowS5cD2,
    workflowS5cD3,
    workflowS5cD4,
    workflowS5cD5b,
    workflowS5cD6,
    workflowS5cD7a,
    workflowS5cD7b,
    workflowS5cD7,
    workflowS5d,
    workflowS6a,
    workflowS6b,
    workflowS6d,
    workflowS6e,
    workflowS6,
    workflowS7a,
    workflowS7b,
    workflowS7c,
    workflowS7d,
    workflowS7,
    workflowClassroomDefaultFlip,
    workflowTradeCanonicalHydration,
    workflowClaimNullSafety,
    workflowCardArtRetry,
    workflowS8a,
    workflowS8b,
    workflowAuthDefaultFlip,
    workflowS8bPlusP0,
    workflowS8c0,
    workflowS8c1,
    workflowS8c2,
    workflowS8d1,
    workflowS8d2,
    workflowS8d3,
    workflowS8d4a,
    workflowS8d4b,
    workflowS8d5a,
    workflowS8d5b,
    workflowOptionCa,
    enableAudit,
    disableAudit,
    enableIsolation,
    disableIsolation,
    isAuditEnabled,
    isIsolationEnabled,
    isIsolationActive,
    defaultAllowedPrefixes,
    refreshFlagsFromStorage,
  };
}

refreshFlagsFromStorage();
_installWindowApi();
