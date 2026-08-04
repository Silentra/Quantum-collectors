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
 * Known blocker (not remediating in S4 audit-infra): Research Projects → trades/direct
 * and trades/listings via buildAvailabilitySnapshot / trade-availability.js.
 */

const AUDIT_LS_KEY = 'qc-personal-scope-audit';
const ISOLATION_LS_KEY = 'qc-personal-cache-isolation';
const SESSION_KEY = 'scicards_session';

/** Documented S4 partial-result blockers (gameplay unchanged). */
export const KNOWN_SCOPED_BLOCKERS = Object.freeze([
  {
    id: 'projects-trade-reservations',
    surfaces: ['projects'],
    paths: ['trades/direct', 'trades/listings'],
    source: 'js/trade-availability.js → buildTradeReservationCounts via buildAvailabilitySnapshot',
    callers: ['js/project-ui.js'],
    note: 'Research Projects reads full trades trees for card availability. S5c trade indexes required; S4 does not disable trade-reservation checks.',
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
  const prefixes = ['config', 'cards', 'packs', 'groups'];
  if (u) prefixes.push(`players/${u}`);
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
  qcPersonalAudit.workflow()   // print guided steps

Known blocker: projects → trades/direct + trades/listings (reported as PARTIAL; not remediating here).
Never logs values/passwords/sessions/inventories. Root listener unchanged.`);
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

5) Projects (known blocker):
   qcPersonalAudit.begin('projects');
   // open Research Projects; browse cards panel / assignment (do not require claim)
   qcPersonalAudit.end('projects');
   // expect PARTIAL: unexpected trades/direct + trades/listings
   // (trade-reservation checks intentionally still active)

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

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcPersonalAudit = {
    PERSONAL_AUDIT_LS_KEY,
    PERSONAL_ISOLATION_LS_KEY,
    KNOWN_SCOPED_BLOCKERS,
    begin,
    end,
    start,
    stop,
    report,
    summary,
    reset,
    help,
    workflow,
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
