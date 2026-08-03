/**
 * db-metrics.js — Phase 1A temporary Firebase RTDB diagnostics (measurement only)
 *
 * Disabled by default. Enable:
 *   localStorage.setItem('qc-db-metrics-enabled', 'true')
 * then reload. Optional verbose:
 *   localStorage.setItem('qc-db-metrics-verbose', 'true')
 *
 * Console API (after load):
 *   window.qcDbMetrics.summary()
 *   window.qcDbMetrics.reset()
 *   window.qcDbMetrics.enable()
 *   window.qcDbMetrics.disable()
 *   window.qcDbMetrics.measureMajorNodes()  // re-measure from provided cache via database hook
 *
 * Estimated JSON bytes ≠ Firebase billed transfer. No Firebase writes. No value logging.
 */

const ENABLE_KEY = 'qc-db-metrics-enabled';
const VERBOSE_KEY = 'qc-db-metrics-verbose';

const SESSION_KEY = 'scicards_session';

/** @type {boolean} */
let _enabled = false;
/** @type {boolean} */
let _verbose = false;

function _readFlag(key) {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function _refreshFlags() {
  _enabled = _readFlag(ENABLE_KEY);
  _verbose = _readFlag(VERBOSE_KEY);
}

_refreshFlags();

/**
 * UTF-8-aware estimated serialized size.
 * Label in summaries: Estimated JSON bytes — not Firebase billed transfer.
 * @param {any} value
 * @returns {number|null}
 */
export function estimateJsonBytes(value) {
  try {
    if (typeof Blob !== 'undefined') {
      return new Blob([JSON.stringify(value)]).size;
    }
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return null;
  }
}

function _formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function _getCurrentUsername() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.username ? String(s.username) : null;
  } catch {
    return null;
  }
}

/**
 * Redact paths for logging — never emit session tokens or access-code values.
 * @param {string} path
 * @returns {string}
 */
export function redactPath(path) {
  if (!path) return '/';
  const parts = String(path).split('/').filter(Boolean);
  if (parts.length === 0) return '/';

  const me = _getCurrentUsername();
  const out = [];

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const prev = parts[i - 1];

    if (prev === 'players') {
      out.push(me && p === me ? '{current-user}' : '{other-user}');
      continue;
    }
    if (prev === 'accessCodes') {
      out.push('{redacted}');
      continue;
    }
    if (p === 'activeSession' || prev === 'activeSession') {
      // Keep segment name "activeSession" but never deeper id values as path parts
      out.push(p === 'activeSession' ? 'activeSession' : '{redacted}');
      continue;
    }
    if (prev === 'password' || p === 'password') {
      out.push(p === 'password' ? 'password' : '{redacted}');
      continue;
    }
    out.push(p);
  }

  return out.join('/');
}

/**
 * Top-level category for aggregation.
 * @param {string} path
 * @returns {string}
 */
export function pathCategory(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  if (parts.length === 0) return 'root';
  if (parts[0] === 'players') return 'players';
  if (parts[0] === 'trades') {
    if (parts[1] === 'direct') return 'trades/direct';
    if (parts[1] === 'listings') return 'trades/listings';
    return 'trades';
  }
  return parts[0];
}

function _emptyState() {
  return {
    rootSnapshots: [],
    writes: [],
    writesSinceLastSnapshot: [],
    persistEvents: [],
    listenerFanIns: [],
    milestones: {},
    majorNodes: null,
    registeredListenerPaths: [],
    totals: {
      rootSnapshotCount: 0,
      initialOnceBytes: null,
      subsequentBytes: 0,
      cumulativeEstimatedBytes: 0,
      largestSnapshotBytes: 0,
      writeCount: 0,
      persistCount: 0,
      persistCumulativeBytes: 0,
      listenerCallbacksTotal: 0,
      rootFanInEvents: 0,
    },
  };
}

/** @type {ReturnType<typeof _emptyState>} */
let _state = _emptyState();

export function isEnabled() {
  return _enabled;
}

export function isVerbose() {
  return _verbose;
}

export function enable() {
  try { localStorage.setItem(ENABLE_KEY, 'true'); } catch { /* ignore */ }
  _refreshFlags();
  _enabled = true;
  console.info('[DB Metrics] Enabled. Reload recommended for full startup capture. Use qcDbMetrics.summary()');
}

export function disable() {
  try { localStorage.setItem(ENABLE_KEY, 'false'); } catch { /* ignore */ }
  _enabled = false;
  console.info('[DB Metrics] Disabled. Near-zero overhead until re-enabled + reload.');
}

export function reset() {
  if (!_enabled && !_readFlag(ENABLE_KEY)) {
    _state = _emptyState();
    return;
  }
  const milestones = { ..._state.milestones };
  _state = _emptyState();
  // Keep startup milestones from this page load unless caller wants a clean action test
  _state.milestones = milestones;
  console.info('[DB Metrics] Counters reset (startup milestones retained). Call resetAll() to clear milestones too.');
}

export function resetAll() {
  _state = _emptyState();
  console.info('[DB Metrics] All metrics cleared.');
}

/**
 * @param {string} name
 * @param {number} [ts]
 */
export function mark(name, ts = Date.now()) {
  if (!_enabled) return;
  if (!_state.milestones[name]) {
    _state.milestones[name] = ts;
  }
}

/**
 * @param {object} opts
 * @param {'initial-once'|'root-listener'} opts.source
 * @param {any} opts.value
 * @param {number} [opts.listenerPathCount]
 * @param {number} [opts.listenerCallbackCount]
 * @param {string[]} [opts.listenerPaths]
 */
export function recordRootSnapshot(opts) {
  if (!_enabled) return;

  const now = Date.now();
  const bytes = estimateJsonBytes(opts.value);
  const prev = _state.rootSnapshots[_state.rootSnapshots.length - 1];
  const elapsedSincePrevMs = prev ? now - prev.ts : null;

  const localWrites = _state.writesSinceLastSnapshot.slice();
  const lastWrite = localWrites.length ? localWrites[localWrites.length - 1] : null;

  const entry = {
    seq: _state.totals.rootSnapshotCount + 1,
    ts: now,
    source: opts.source,
    estimatedJsonBytes: bytes,
    elapsedSincePrevMs,
    localWritesSincePrev: localWrites.length,
    localWriteCategories: localWrites.map(w => w.category),
    localWritePaths: localWrites.map(w => w.pathRedacted),
    msSinceMostRecentLocalWrite: lastWrite ? now - lastWrite.ts : null,
    listenerPathCount: opts.listenerPathCount ?? null,
    listenerCallbackCount: opts.listenerCallbackCount ?? null,
    note: 'Estimated JSON bytes — not Firebase billed transfer. Write correlation is local-client only.',
  };

  _state.rootSnapshots.push(entry);
  _state.totals.rootSnapshotCount += 1;
  if (bytes != null) {
    _state.totals.cumulativeEstimatedBytes += bytes;
    if (bytes > _state.totals.largestSnapshotBytes) {
      _state.totals.largestSnapshotBytes = bytes;
    }
    if (opts.source === 'initial-once') {
      _state.totals.initialOnceBytes = bytes;
    } else {
      _state.totals.subsequentBytes += bytes;
    }
  }

  if (opts.listenerCallbackCount != null) {
    _state.totals.listenerCallbacksTotal += opts.listenerCallbackCount;
    _state.totals.rootFanInEvents += 1;
    _state.listenerFanIns.push({
      seq: entry.seq,
      ts: now,
      pathCount: opts.listenerPathCount,
      callbackCount: opts.listenerCallbackCount,
      paths: opts.listenerPaths || [],
      notifiedAllRegistered: true,
    });
  }

  _state.writesSinceLastSnapshot = [];

  const compact = `[DB Metrics] Root snapshot #${entry.seq} (${opts.source}) — ${_formatBytes(bytes)} estimated — ${localWrites.length} local writes since previous`;
  console.info(compact);
  if (_verbose) {
    console.info('[DB Metrics] detail', {
      seq: entry.seq,
      source: opts.source,
      estimatedJsonBytes: bytes,
      elapsedSincePrevMs,
      localWritePaths: entry.localWritePaths,
      listenerCallbackCount: entry.listenerCallbackCount,
    });
  }
}

/**
 * @param {object} opts
 * @param {string} opts.op - set|update|remove|set-ack|update-ack|transaction|set-seed
 * @param {string} opts.path
 * @param {'fire-and-forget'|'acknowledged'} opts.mode
 * @param {boolean|null} [opts.ok]
 * @param {string[]} [opts.extraPaths] - for multi-path update keys
 */
export function recordFirebaseWrite(opts) {
  if (!_enabled) return;

  const pathRedacted = redactPath(opts.path);
  const category = pathCategory(opts.path);
  const extra = (opts.extraPaths || []).map(redactPath);

  const entry = {
    ts: Date.now(),
    op: opts.op,
    pathRedacted,
    category,
    mode: opts.mode,
    ok: opts.ok === undefined ? null : opts.ok,
    extraPathsRedacted: extra,
  };

  _state.writes.push(entry);
  _state.writesSinceLastSnapshot.push(entry);
  _state.totals.writeCount += 1;

  if (_verbose) {
    console.info(`[DB Metrics] Write ${opts.op} ${pathRedacted} (${opts.mode})`, opts.ok == null ? '' : `ok=${opts.ok}`);
  }
}

/**
 * @param {any} cacheRoot - full _db object (serialized for size only; not logged)
 * @param {string} reason
 */
export function recordCachePersist(cacheRoot, reason) {
  if (!_enabled) return;

  const bytes = estimateJsonBytes(cacheRoot);
  _state.persistEvents.push({
    ts: Date.now(),
    reason: reason || 'unknown',
    estimatedJsonBytes: bytes,
  });
  _state.totals.persistCount += 1;
  if (bytes != null) {
    _state.totals.persistCumulativeBytes += bytes;
  }

  if (_verbose) {
    console.info(`[DB Metrics] Cache persist (${reason}) — ${_formatBytes(bytes)}`);
  }
}

/**
 * Track registered in-memory listener paths (not values).
 * @param {string[]} paths
 */
export function recordRegisteredListeners(paths) {
  if (!_enabled) return;
  _state.registeredListenerPaths = Array.isArray(paths) ? paths.slice() : [];
}

/**
 * Measure major node sizes from a raw cache root object.
 * @param {object|null} dbRoot
 */
export function recordMajorNodeSizes(dbRoot) {
  if (!_enabled) return;
  if (!dbRoot || typeof dbRoot !== 'object') {
    _state.majorNodes = { error: 'cache unavailable' };
    return;
  }

  const sizes = {};
  const measure = (label, value) => {
    sizes[label] = {
      estimatedJsonBytes: estimateJsonBytes(value),
      note: 'Estimated JSON bytes — not Firebase billed transfer',
    };
  };

  measure('/', dbRoot);
  measure('config', dbRoot.config);
  measure('players', dbRoot.players);
  measure('cards', dbRoot.cards);
  measure('packs', dbRoot.packs);
  measure('groups', dbRoot.groups);
  measure('trades/direct', dbRoot.trades && dbRoot.trades.direct);
  measure('trades/listings', dbRoot.trades && dbRoot.trades.listings);

  const me = _getCurrentUsername();
  const players = dbRoot.players && typeof dbRoot.players === 'object' ? dbRoot.players : {};
  const keys = Object.keys(players);

  if (me && players[me] !== undefined) {
    measure('players/{current-user}', players[me]);
    sizes['players/{current-user}'].label = `logged-in user (${me.length} char username; name not required for size)`;
  } else if (keys.length > 0) {
    let sum = 0;
    let counted = 0;
    for (const k of keys) {
      const b = estimateJsonBytes(players[k]);
      if (b != null) {
        sum += b;
        counted += 1;
      }
    }
    sizes['players/{representative}'] = {
      estimatedJsonBytes: counted ? Math.round(sum / counted) : null,
      label: `average of ${counted} player records (no session)`,
      note: 'Estimated JSON bytes — not Firebase billed transfer',
    };
    const firstKey = keys[0];
    measure('players/{first-player}', players[firstKey]);
    sizes['players/{first-player}'].label = 'first key in players map (diagnostic only)';
  } else {
    sizes['players/{representative}'] = { estimatedJsonBytes: 0, label: 'no players' };
  }

  _state.majorNodes = sizes;
}

export function measureMajorNodesNow() {
  if (!_enabled) {
    console.warn('[DB Metrics] Disabled');
    return null;
  }
  if (_lastCacheRoot) {
    recordMajorNodeSizes(_lastCacheRoot);
    return _state.majorNodes;
  }
  console.warn('[DB Metrics] No cache root available yet');
  return null;
}

/** @type {object|null} */
let _lastCacheRoot = null;

/**
 * Keep a pointer to current cache for on-demand major-node measure (not logged).
 * @param {object|null} dbRoot
 */
export function captureCacheRoot(dbRoot) {
  if (!_enabled) return;
  _lastCacheRoot = dbRoot;
}

function _milestoneDelta(from, to) {
  const a = _state.milestones[from];
  const b = _state.milestones[to];
  if (a == null || b == null) return null;
  return b - a;
}

export function summary() {
  if (!_enabled && _state.totals.rootSnapshotCount === 0 && _state.totals.writeCount === 0) {
    console.info('[DB Metrics] Inactive. Enable with: localStorage.setItem("qc-db-metrics-enabled","true"); location.reload()');
    return null;
  }

  // Refresh major nodes at summary time if we have a cache pointer
  if (_lastCacheRoot) {
    recordMajorNodeSizes(_lastCacheRoot);
  }

  const writesByOp = {};
  const writesByCategory = {};
  for (const w of _state.writes) {
    writesByOp[w.op] = (writesByOp[w.op] || 0) + 1;
    writesByCategory[w.category] = (writesByCategory[w.category] || 0) + 1;
  }

  const snapCount = _state.totals.rootSnapshotCount;
  const avgSnap = snapCount && _state.totals.cumulativeEstimatedBytes
    ? Math.round(_state.totals.cumulativeEstimatedBytes / snapCount)
    : null;

  const report = {
    disclaimer: 'Estimated JSON bytes — not Firebase billed transfer. Local write↔snapshot links are correlation only (other clients omitted).',
    enabled: _enabled,
    rootSnapshots: {
      total: snapCount,
      initialOnceBytes: _state.totals.initialOnceBytes,
      subsequentEstimatedBytes: _state.totals.subsequentBytes,
      cumulativeEstimatedBytes: _state.totals.cumulativeEstimatedBytes,
      largestSnapshotBytes: _state.totals.largestSnapshotBytes,
      averageSnapshotBytes: avgSnap,
      events: _state.rootSnapshots,
    },
    writes: {
      total: _state.totals.writeCount,
      byOperation: writesByOp,
      byTopLevelPath: writesByCategory,
      recent: _state.writes.slice(-30),
    },
    cachePersistence: {
      count: _state.totals.persistCount,
      cumulativeEstimatedBytes: _state.totals.persistCumulativeBytes,
      recent: _state.persistEvents.slice(-20),
    },
    cacheListeners: {
      registeredPaths: _state.registeredListenerPaths,
      rootFanInEvents: _state.totals.rootFanInEvents,
      totalCallbacksInvoked: _state.totals.listenerCallbacksTotal,
      note: 'Root snapshots notify every registered db.onValue path with no equality check.',
      recentFanIns: _state.listenerFanIns.slice(-20),
    },
    startupTimingMs: {
      milestones: { ..._state.milestones },
      domToInitDbStart: _milestoneDelta('dom-content-loaded', 'initDB-start'),
      initDbStartToInitialSnapshot: _milestoneDelta('initDB-start', 'initial-root-snapshot'),
      initDbStartToComplete: _milestoneDelta('initDB-start', 'initDB-complete'),
      initAuth: _milestoneDelta('initAuth-start', 'initAuth-complete'),
      migrations: _milestoneDelta('migrations-start', 'migrations-complete'),
      uiInit: _milestoneDelta('ui-init-start', 'ui-init-complete'),
      domToReady: _milestoneDelta('dom-content-loaded', 'app-ready'),
    },
    majorNodes: _state.majorNodes,
  };

  console.info('[DB Metrics] Summary', report);
  console.info(
    `[DB Metrics] Quick: snapshots=${snapCount} cum=${_formatBytes(_state.totals.cumulativeEstimatedBytes)} writes=${_state.totals.writeCount} persists=${_state.totals.persistCount}`
  );
  return report;
}

function _installWindowApi() {
  if (typeof window === 'undefined') return;
  window.qcDbMetrics = {
    summary,
    reset,
    resetAll,
    enable,
    disable,
    isEnabled,
    measureMajorNodes: measureMajorNodesNow,
    help() {
      console.info(`DB Metrics (Phase 1A)
Enable:  localStorage.setItem('qc-db-metrics-enabled','true'); location.reload()
Verbose: localStorage.setItem('qc-db-metrics-verbose','true')
Disable: qcDbMetrics.disable() or set flag false + reload
API: summary() | reset() | resetAll() | measureMajorNodes()
Bytes are Estimated JSON — not Firebase billed transfer.`);
    },
  };
}

_installWindowApi();
