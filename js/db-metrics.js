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
  if (parts[0] === 'playerTradeIndex') return 'playerTradeIndex';
  if (parts[0] === 'listingsByGroup') return 'listingsByGroup';
  if (parts[0] === 'tradeIndexMeta') return 'tradeIndexMeta';
  return parts[0];
}

function _emptyState() {
  return {
    rootSnapshots: [],
    pathSnapshots: [],
    scopedSubscriptionEvents: [],
    writes: [],
    writesSinceLastSnapshot: [],
    persistEvents: [],
    listenerFanIns: [],
    milestones: {},
    majorNodes: null,
    registeredListenerPaths: [],
    activeScopedSubscriptions: [],
    totals: {
      rootSnapshotCount: 0,
      pathSnapshotCount: 0,
      initialOnceBytes: null,
      subsequentBytes: 0,
      cumulativeEstimatedBytes: 0,
      pathSnapshotCumulativeBytes: 0,
      largestSnapshotBytes: 0,
      writeCount: 0,
      persistCount: 0,
      persistCumulativeBytes: 0,
      listenerCallbacksTotal: 0,
      rootFanInEvents: 0,
      scopedSubscriptionAdd: 0,
      scopedSubscriptionReuse: 0,
      scopedSubscriptionRemove: 0,
      tradeIndexLifecycleByTag: {},
      tradeIndexFallbackCount: 0,
      tradeIndexFailClosedCount: 0,
    },
    tradeIndexLifecycle: [],
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

/** @type {object|null} */
let _bootModeReport = null;

/**
 * S7b: record boot-mode latch / root-attach state (always stored; independent of metrics enable).
 * @param {object} report
 */
export function recordBootMode(report) {
  _bootModeReport = report ? { ...report } : null;
  if (_enabled && report) {
    console.info(
      `[DB Metrics] Boot mode=${report.mode} rootListenerAttached=${report.rootListenerAttached} firebaseActive=${report.firebaseActive}`,
    );
  }
}

/**
 * @returns {object|null}
 */
export function getBootModeReport() {
  return _bootModeReport ? { ..._bootModeReport } : null;
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
    cacheUpdateSource: opts.source === 'initial-once' ? 'initial-root' : 'root-listener',
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
      cacheUpdateSource: entry.cacheUpdateSource,
      estimatedJsonBytes: bytes,
      elapsedSincePrevMs,
      localWritePaths: entry.localWritePaths,
      listenerCallbackCount: entry.listenerCallbackCount,
    });
  }
}

/**
 * Scoped path snapshot (subtree merge — not a full root replace).
 * @param {object} opts
 * @param {'scoped-once'|'scoped-subscription'} opts.source
 * @param {string} opts.path
 * @param {any} opts.value
 */
export function recordPathSnapshot(opts) {
  if (!_enabled) return;

  const now = Date.now();
  const bytes = estimateJsonBytes(opts.value);
  const pathRedacted = redactPath(opts.path);
  const entry = {
    seq: _state.totals.pathSnapshotCount + 1,
    ts: now,
    source: opts.source,
    cacheUpdateSource: opts.source,
    pathRedacted,
    category: pathCategory(opts.path),
    estimatedJsonBytes: bytes,
    note: 'Estimated JSON bytes for scoped subtree only — not Firebase billed transfer.',
  };

  _state.pathSnapshots.push(entry);
  _state.totals.pathSnapshotCount += 1;
  if (bytes != null) {
    _state.totals.pathSnapshotCumulativeBytes += bytes;
  }

  if (_verbose) {
    console.info(
      `[DB Metrics] Path snapshot #${entry.seq} (${opts.source}) ${pathRedacted} — ${_formatBytes(bytes)}`,
    );
  }
}

/**
 * Track scoped Firebase subscription registry lifecycle.
 * @param {object} opts
 * @param {'add'|'reuse'|'release'|'remove'} opts.action
 * @param {string} opts.path
 * @param {number} opts.refCount
 * @param {string} [opts.id]
 */
export function recordScopedSubscription(opts) {
  if (!_enabled) return;

  const pathRedacted = redactPath(opts.path);
  const entry = {
    ts: Date.now(),
    action: opts.action,
    pathRedacted,
    refCount: opts.refCount,
    id: opts.id || null,
  };
  _state.scopedSubscriptionEvents.push(entry);

  if (opts.action === 'add') _state.totals.scopedSubscriptionAdd += 1;
  if (opts.action === 'reuse') _state.totals.scopedSubscriptionReuse += 1;
  if (opts.action === 'remove') _state.totals.scopedSubscriptionRemove += 1;

  // Refresh active list snapshot for summary (paths only)
  try {
    // Caller may also push via recordActiveScopedSubscriptions
  } catch { /* ignore */ }

  if (_verbose) {
    console.info(
      `[DB Metrics] Scoped sub ${opts.action} ${pathRedacted} refCount=${opts.refCount}`,
    );
  }
}

/**
 * Replace the metrics copy of the active scoped subscription registry.
 * @param {{ path: string, id: string, refCount: number }[]} entries
 */
export function recordActiveScopedSubscriptions(entries) {
  if (!_enabled) return;
  _state.activeScopedSubscriptions = Array.isArray(entries)
    ? entries.map(e => ({
      pathRedacted: redactPath(e.path),
      id: e.id,
      refCount: e.refCount,
    }))
    : [];
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
 * S5c-B trade-index lifecycle diagnostics (ops = distinct server operations, not path count).
 * @param {{ tag: string, ops?: number, ok?: boolean, username?: string }} opts
 */
export function recordTradeIndexLifecycle(opts) {
  if (!_enabled) return;
  if (!_state.tradeIndexLifecycle) _state.tradeIndexLifecycle = [];
  const tag = String(opts.tag || 'unknown');
  const entry = {
    ts: Date.now(),
    tag,
    ops: Number.isFinite(Number(opts.ops)) ? Number(opts.ops) : 0,
    ok: opts.ok === undefined ? null : !!opts.ok,
    usernameRedacted: opts.username ? '[user]' : null,
  };
  _state.tradeIndexLifecycle.push(entry);
  if (!_state.totals.tradeIndexLifecycleByTag) _state.totals.tradeIndexLifecycleByTag = {};
  _state.totals.tradeIndexLifecycleByTag[tag] =
    (_state.totals.tradeIndexLifecycleByTag[tag] || 0) + 1;
  if (_verbose) {
    console.info(`[DB Metrics] TradeIndex ${tag} ops=${entry.ops} ok=${entry.ok}`);
  }
}

/**
 * S5c-C: Research used canonical trades/* because index was unready.
 * @param {{ reason?: string }} [opts]
 */
export function recordTradeIndexFallback(opts = {}) {
  if (!_enabled) return;
  _state.totals.tradeIndexFallbackCount =
    (_state.totals.tradeIndexFallbackCount || 0) + 1;
  recordTradeIndexLifecycle({
    tag: 'tradeIndexFallbackCount',
    ops: 0,
    ok: true,
  });
  if (_verbose) {
    console.info('[DB Metrics] TradeIndex fallback', opts.reason || '');
  }
}

/**
 * S5c-C: Research fail-closed (no verified index and no canonical fallback).
 * @param {{ reason?: string }} [opts]
 */
export function recordTradeIndexFailClosed(opts = {}) {
  if (!_enabled) return;
  _state.totals.tradeIndexFailClosedCount =
    (_state.totals.tradeIndexFailClosedCount || 0) + 1;
  recordTradeIndexLifecycle({
    tag: 'tradeIndexFailClosedCount',
    ops: 0,
    ok: false,
  });
  if (_verbose) {
    console.info('[DB Metrics] TradeIndex fail-closed', opts.reason || '');
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
    bootMode: _bootModeReport,
    cacheUpdateSources: {
      note: 'initial-root / root-listener / scoped-once / scoped-subscription — S8d-0: scoped-only boot; root once+on never attached',
    },
    rootSnapshots: {
      total: snapCount,
      rootListenerAttached: _bootModeReport ? _bootModeReport.rootListenerAttached === true : null,
      initialOnceBytes: _state.totals.initialOnceBytes,
      subsequentEstimatedBytes: _state.totals.subsequentBytes,
      cumulativeEstimatedBytes: _state.totals.cumulativeEstimatedBytes,
      largestSnapshotBytes: _state.totals.largestSnapshotBytes,
      averageSnapshotBytes: avgSnap,
      events: _state.rootSnapshots,
    },
    pathSnapshots: {
      total: _state.totals.pathSnapshotCount,
      cumulativeEstimatedBytes: _state.totals.pathSnapshotCumulativeBytes,
      recent: _state.pathSnapshots.slice(-30),
    },
    scopedSubscriptions: {
      active: _state.activeScopedSubscriptions,
      events: _state.scopedSubscriptionEvents.slice(-30),
      totals: {
        add: _state.totals.scopedSubscriptionAdd,
        reuse: _state.totals.scopedSubscriptionReuse,
        remove: _state.totals.scopedSubscriptionRemove,
      },
      note: 'Firebase path .on ownership — separate from db.onValue cache observers.',
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
    majorNodes: _state.majorNodes,
    tradeIndexLifecycle: {
      byTag: _state.totals.tradeIndexLifecycleByTag || {},
      recent: (_state.tradeIndexLifecycle || []).slice(-30),
      fallbackCount: _state.totals.tradeIndexFallbackCount || 0,
      failClosedCount: _state.totals.tradeIndexFailClosedCount || 0,
    },
    startupTimingMs: {
      milestones: { ..._state.milestones },
      domToInitDbStart: _milestoneDelta('dom-content-loaded', 'initDB-start'),
      initDbStartToInitialSnapshot: _milestoneDelta('initDB-start', 'initial-root-snapshot'),
      initDbStartToComplete: _milestoneDelta('initDB-start', 'initDB-complete'),
      sharedHydrate: _milestoneDelta('shared-hydrate-start', 'shared-hydrate-complete'),
      currentPlayerHydrate: _milestoneDelta('current-player-hydrate-start', 'current-player-hydrate-complete'),
      playerTradeIndexHydrate: _milestoneDelta('playerTradeIndexHydrateStart', 'playerTradeIndexHydrateComplete'),
      tradingDirectoryHydrate: _milestoneDelta('tradingDirectoryHydrateStart', 'tradingDirectoryHydrateComplete'),
      groupListingsHydrate: _milestoneDelta('groupListingsHydrateStart', 'groupListingsHydrateComplete'),
      initAuth: _milestoneDelta('initAuth-start', 'initAuth-complete'),
      migrations: _milestoneDelta('migrations-start', 'migrations-complete'),
      uiInit: _milestoneDelta('ui-init-start', 'ui-init-complete'),
      domToReady: _milestoneDelta('dom-content-loaded', 'app-ready'),
    },
  };

  console.info('[DB Metrics] Summary', report);
  console.info(
    `[DB Metrics] Quick: mode=${_bootModeReport?.mode || '?'} rootAttached=${_bootModeReport?.rootListenerAttached} ` +
      `rootSnaps=${snapCount} pathSnaps=${_state.totals.pathSnapshotCount} ` +
      `cum=${_formatBytes(_state.totals.cumulativeEstimatedBytes)} writes=${_state.totals.writeCount} ` +
      `scopedSubs=${_state.activeScopedSubscriptions.length}`,
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
    recordTradeIndexLifecycle,
    recordTradeIndexFallback,
    recordTradeIndexFailClosed,
    getBootModeReport,
    help() {
      console.info(`DB Metrics
Enable:  localStorage.setItem('qc-db-metrics-enabled','true'); location.reload()
Verbose: localStorage.setItem('qc-db-metrics-verbose','true')
Disable: qcDbMetrics.disable() or set flag false + reload
API: summary() | getBootModeReport() | reset() | resetAll() | measureMajorNodes()
S7b: summary().bootMode / rootSnapshots.total (expect 0; scoped-only after S8d-0)
Boot: qcDbHydration.getBootModeReport()
Bytes are Estimated JSON — not Firebase billed transfer.`);
    },
  };
}

_installWindowApi();
