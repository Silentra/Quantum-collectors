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
    phase: 'S4',
    overall: allPass ? 'PASS' : allAcceptable && !anyFail ? 'PARTIAL' : rows.length ? 'FAIL' : 'EMPTY',
    note: 'PARTIAL = only known scoped blockers (e.g. projects→trades); gameplay/trade reservations unchanged.',
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

Never logs values/passwords/sessions/inventories. Root listener unchanged.
Does not claim all Trading is scoped-clean until later S5c-D phases.`);
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

Next: verify S6a (qcPersonalAudit.workflowS6a()), then S6b–S6e. Do not begin S7/S8 yet.
`);
}

/**
 * Pasteable S6a accessCodes scoped once-load verification (register + bootstrap).
 */
export function workflowS6a() {
  console.info(`
=== S6a accessCodes scoped once-load ===

Status: IMPLEMENTED — AWAITING VERIFICATION. Root remains ON. Do not begin S6b yet.

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
   // Stay on auth screen; begin before clicking Register:
   qcPersonalAudit.begin('s6a-register', { allowedPrefixes: [
     'config','cards','packs','groups','tradeIndexMeta','accessCodes'
   ]});
   // Attempt register with a test code (valid or invalid)
   const end = qcPersonalAudit.end('s6a-register');
   // PASS: reads include get accessCodes/<CODE> (leaf), not a student subscribe
   // PASS: no accessCodes entry in getSubscriptionRegistry()

Do NOT implement or test S6b–S6e in this gate.
`);
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
