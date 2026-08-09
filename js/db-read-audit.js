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
 * Build allowlist prefixes for a username (no trailing slash variants needed —
 * matching uses exact or prefix+/).
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
 * @param {string} normalizedPath
 * @param {string[]} allowedPrefixes
 * @returns {boolean}
 */
function _isAllowed(normalizedPath, allowedPrefixes) {
  if (!normalizedPath) return false; // root / empty — not personal-scoped
  for (const prefix of allowedPrefixes) {
    if (!prefix) continue;
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) return true;
  }
  return false;
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
    ? options.allowedPrefixes.map(_normalizePath).filter(Boolean)
    : defaultAllowedPrefixes(username || '');

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
      `isolation=${isIsolationActive()} allow=${allowedPrefixes.join(',')}`,
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

DO NOT require zero trades/listings during full create — buildAvailabilitySnapshot
still scans canonical listings until D6 (expected noise).

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
