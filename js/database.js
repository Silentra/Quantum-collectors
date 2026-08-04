/**
 * Database Layer - Firebase Realtime Database
 *
 * Provides the SAME synchronous API as the original localStorage version
 * by maintaining an in-memory cache. On init, the full DB is pulled from
 * Firebase RTDB once. Writes update both cache and Firebase (fire-and-forget).
 *
 * If Firebase is not configured, falls back to localStorage silently.
 *
 * Exported API:
 *   initDB()          - now async; loads from Firebase or localStorage
 *   get(path)         - sync read from cache
 *   set(path, val)    - sync cache + async Firebase write
 *   update(path, u)   - sync cache + async Firebase write
 *   remove(path)      - sync cache + async Firebase remove
 *   getChildren(path) - sync read from cache
 *   push(path, val)   - sync cache + async Firebase push
 *   onValue(p, cb)    - subscribe to cache changes (in-process)
 *   query(p, fn)      - filter children
 *   getFullDB()       - debug
 *   resetDB()         - reset to defaults
 *   setAcknowledged(path, value)       - await remote set, then patch cache
 *   updateAcknowledged(updates)        - await root multi-path update, then patch cache
 *   clearActiveSessionIfOwned(u, id)   - ownership-checked session clear
 *   generatePushKey(path)              - push key without write
 *   getAcknowledged(path)              - one-shot remote read + cache patch
 *   loadPathOnce(path, opts)           - S1/S2 scoped once → merge subtree (pending/ready reuse)
 *   subscribePath(path)                - S1 scoped Firebase .on → merge subtree
 *   isPathReady(path) / waitForPath    - S1 hierarchical readiness
 *   clearCachedPath(path)              - explicit subtree eviction (not on unsub)
 *   getSubscriptionRegistry()          - active scoped Firebase subscriptions
 *   isFirebaseConnected()
 *
 * Phase S1–S3: root once + root on('value') remain the legacy safety net.
 * Scoped APIs are additive; S3 current-player scope is auth-owned beside root.
 *
 * Data nodes: /config /players /cards /packs /groups /accessCodes /admin
 */

import { initFirebase, isConfigured } from './firebase-config.js';
import * as metrics from './db-metrics.js';
import * as readAudit from './db-read-audit.js';

const DB_KEY = 'scicards_db';

let _db = null;              // in-memory cache (synchronous reads)
let _fbDb = null;            // Firebase RTDB instance
let _useFirebase = false;    // true when Firebase is live
const _listeners = new Map();

/** Optional reason for metrics-only; does not change persistence behavior. */
let _persistReason = 'unknown';

/** Paths explicitly marked ready by scoped load/subscribe (not by root listener). */
const _readyPaths = new Set();

/** @type {Map<string, Array<{ resolve: Function, reject: Function, timer: any }>>} */
const _readyWaiters = new Map();

/**
 * Firebase path subscriptions owned by subscribePath (separate from db.onValue).
 * @type {Map<string, { id: string, refCount: number, fbPath: string, handler: Function }>}
 */
const _fbPathSubscriptions = new Map();

/**
 * In-flight loadPathOnce work keyed by normalized path (duplicate calls share one network read).
 * @type {Map<string, Promise<{ ok: boolean, path: string, value: any, mode: string, reused?: boolean, error?: string }>>}
 */
const _pendingPathLoads = new Map();

let _scopedSubSeq = 0;

// ---------- Default data ----------

function getDefaultDB() {
  return {
    config: {
      gameOpen: true,
      registrationOpen: true,
      adminPassword: 'admin123',
      packOdds: { common: 50, uncommon: 25, rare: 15, epic: 8, legendary: 2 },
      economy: {
        packsPerDay: 5,
        tradeCooldownMinutes: 30,
        maxInventorySize: 500,
        directTradeCooldownMinutes: 10080,
        listingCooldownMinutes: 10080,
        listingAcceptCooldownMinutes: 10080,
        listingExpirationHours: 168,
        maxActiveListingsPerPlayer: 1
      },
      progression: { xpPerPackOpen: 10, xpPerTrade: 5 },
      seasonal: { currentSeason: 'none', seasonEndDate: null },
      trading: {
        enabled: true,
        directTradesEnabled: true,
        listingsEnabled: true,
        defaultHiddenProfile: false,
        enableDetailedLogs: false
      },
      achievements: {
        meta: { enabled: true, version: 1, updatedAt: 0 },
        definitions: {},
      }
    },
    players: {},
    cards: {},
    packs: {},
    groups: {},
    accessCodes: {},
    admin: { lastAction: null, actionLog: [] },
    trades: {},
    achievements: {},
    quests: {},
    seasonal: {},
    leaderboardSeasons: {
      activeSeasonId: null,
      seasons: {}
    }
  };
}

function _mergeDefaults(data) {
  const defaults = getDefaultDB();
  for (const key of Object.keys(defaults)) {
    if (data[key] === undefined) data[key] = defaults[key];
  }
  if (!data.config) data.config = {};
  for (const key of Object.keys(defaults.config)) {
    if (data.config[key] === undefined) data.config[key] = defaults.config[key];
  }
  // Deep-merge economy sub-keys (additive only)
  if (!data.config.economy) data.config.economy = {};
  for (const key of Object.keys(defaults.config.economy)) {
    if (data.config.economy[key] === undefined) data.config.economy[key] = defaults.config.economy[key];
  }
  // Deep-merge trading sub-keys (additive only)
  if (!data.config.trading) data.config.trading = {};
  for (const key of Object.keys(defaults.config.trading)) {
    if (data.config.trading[key] === undefined) data.config.trading[key] = defaults.config.trading[key];
  }
}

// ---------- Firebase write helpers (fire-and-forget) ----------

function _fbSet(path, value) {
  if (!_useFirebase || !_fbDb) return;
  const fbPath = path.split('/').filter(Boolean).join('/');
  metrics.recordFirebaseWrite({ op: 'set', path: fbPath || '/', mode: 'fire-and-forget' });
  _fbDb.ref(fbPath).set(value != null ? value : null)
    .catch(e => console.warn('[DB] Firebase set error:', fbPath, e.message));
}

function _fbUpdate(path, updates) {
  if (!_useFirebase || !_fbDb) return;
  const fbPath = path.split('/').filter(Boolean).join('/');
  metrics.recordFirebaseWrite({ op: 'update', path: fbPath || '/', mode: 'fire-and-forget' });
  _fbDb.ref(fbPath).update(updates)
    .catch(e => console.warn('[DB] Firebase update error:', fbPath, e.message));
}

function _fbRemove(path) {
  if (!_useFirebase || !_fbDb) return;
  const fbPath = path.split('/').filter(Boolean).join('/');
  metrics.recordFirebaseWrite({ op: 'remove', path: fbPath || '/', mode: 'fire-and-forget' });
  _fbDb.ref(fbPath).remove()
    .catch(e => console.warn('[DB] Firebase remove error:', fbPath, e.message));
}

// ---------- localStorage fallback ----------

function _persistLocal() {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(_db));
    if (metrics.isEnabled()) {
      metrics.captureCacheRoot(_db);
      metrics.recordCachePersist(_db, _persistReason);
    }
  }
  catch (e) { console.error('[DB] localStorage persist error:', e); }
}

function _loadLocal() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// ---------- Listener notification ----------

function _notifyListeners(path) {
  const value = get(path);
  if (_listeners.has(path)) {
    for (const cb of _listeners.get(path)) {
      try { cb(value); } catch (e) { console.error('[DB] Listener error:', e); }
    }
  }
  const parts = path.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const parentPath = parts.slice(0, i).join('/');
    if (_listeners.has(parentPath)) {
      const parentVal = get(parentPath);
      for (const cb of _listeners.get(parentPath)) {
        try { cb(parentVal); } catch (e) { console.error('[DB] Listener error:', e); }
      }
    }
  }
}

/**
 * Normalize a DB path: trim slashes, drop empty segments.
 * Empty string means root (rejected by scoped APIs).
 * @param {string} path
 * @returns {string}
 */
function _normalizePath(path) {
  if (path == null || path === '' || path === '/') return '';
  return String(path).split('/').filter(Boolean).join('/');
}

/**
 * Notify in-process onValue listeners for exact path, ancestors, and descendants.
 * Used after scoped subtree merges so child listeners (e.g. activeSession) fire
 * when a parent player node is replaced.
 * @param {string} path - normalized non-empty path
 */
function _notifyScoped(path) {
  if (!path) return;

  const notified = new Set();
  const fire = (listenerPath) => {
    if (!listenerPath || notified.has(listenerPath)) return;
    if (!_listeners.has(listenerPath)) return;
    notified.add(listenerPath);
    const val = get(listenerPath);
    for (const cb of _listeners.get(listenerPath)) {
      try { cb(val); } catch (e) { console.error('[DB] Scoped listener error:', e); }
    }
  };

  fire(path);

  const parts = path.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    fire(parts.slice(0, i).join('/'));
  }

  const prefix = `${path}/`;
  for (const listenerPath of _listeners.keys()) {
    if (listenerPath.startsWith(prefix)) fire(listenerPath);
  }
}

/**
 * Mark a path ready and resolve waitForPath waiters (path + descendants waiting
 * that become satisfied via hierarchical readiness).
 * @param {string} path - normalized
 */
function _markPathReady(path) {
  if (!path) return;
  _readyPaths.add(path);

  // Resolve waiters whose target is this path or a descendant (ancestor-ready satisfies child)
  for (const [waitPath, waiters] of [..._readyWaiters.entries()]) {
    if (waitPath === path || waitPath.startsWith(`${path}/`) || _isPathReadyNormalized(waitPath)) {
      for (const w of waiters) {
        if (w.timer) clearTimeout(w.timer);
        w.resolve({ ok: true, path: waitPath });
      }
      _readyWaiters.delete(waitPath);
    }
  }
}

/**
 * Clear ready marks for path and any descendant marks.
 * @param {string} path - normalized
 */
function _clearReadyMarksUnder(path) {
  if (!path) return;
  _readyPaths.delete(path);
  for (const ready of [..._readyPaths]) {
    if (ready.startsWith(`${path}/`)) _readyPaths.delete(ready);
  }
}

function _isPathReadyNormalized(path) {
  if (!path) return false;
  if (_readyPaths.has(path)) return true;
  const parts = path.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    if (_readyPaths.has(parts.slice(0, i).join('/'))) return true;
  }
  return false;
}

/**
 * Replace only the target subtree in `_db`. Never touches siblings/unrelated roots.
 * @param {string} path - normalized non-empty
 * @param {any} value - null/undefined deletes the node
 * @param {{ source: 'scoped-once'|'scoped-subscription'|'scoped-clear', persist?: boolean, markReady?: boolean }} opts
 */
function _applyScopedSnapshot(path, value, opts = {}) {
  if (!_db || !path) return;

  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return;

  const source = opts.source || 'scoped-once';
  const shouldPersist = opts.persist !== false;
  const shouldMarkReady = opts.markReady !== false;

  if (value === null || value === undefined) {
    let current = _db;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined || current[parts[i]] === null || typeof current[parts[i]] !== 'object') {
        // Nothing to delete
        if (shouldMarkReady) _markPathReady(path);
        _notifyScoped(path);
        return;
      }
      current = current[parts[i]];
    }
    delete current[parts[parts.length - 1]];
  } else {
    let current = _db;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined || current[parts[i]] === null || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = JSON.parse(JSON.stringify(value));
  }

  if (shouldMarkReady) _markPathReady(path);

  if (shouldPersist) {
    _persistReason = source === 'scoped-subscription' ? 'scoped-subscription'
      : source === 'scoped-clear' ? 'scoped-clear'
        : 'scoped-once';
    _persistLocal();
  }

  if (metrics.isEnabled() && source !== 'scoped-clear') {
    metrics.recordPathSnapshot({
      source,
      path,
      value,
    });
  }

  _notifyScoped(path);
}

function _syncScopedSubscriptionMetrics() {
  if (!metrics.isEnabled()) return;
  metrics.recordActiveScopedSubscriptions(
    Array.from(_fbPathSubscriptions.entries()).map(([path, entry]) => ({
      path,
      id: entry.id,
      refCount: entry.refCount,
    })),
  );
}

function _releasePathSubscription(path) {
  const entry = _fbPathSubscriptions.get(path);
  if (!entry) return { released: false, remaining: 0 };

  entry.refCount -= 1;
  if (entry.refCount > 0) {
    if (metrics.isEnabled()) {
      metrics.recordScopedSubscription({
        action: 'release',
        path,
        refCount: entry.refCount,
        id: entry.id,
      });
    }
    _syncScopedSubscriptionMetrics();
    return { released: false, remaining: entry.refCount };
  }

  if (_useFirebase && _fbDb && entry.handler) {
    try {
      _fbDb.ref(entry.fbPath).off('value', entry.handler);
    } catch (e) {
      console.warn('[DB] subscribePath off error:', path, e.message);
    }
  }
  _fbPathSubscriptions.delete(path);
  if (metrics.isEnabled()) {
    metrics.recordScopedSubscription({
      action: 'remove',
      path,
      refCount: 0,
      id: entry.id,
    });
  }
  _syncScopedSubscriptionMetrics();
  // Cache and readiness intentionally retained
  return { released: true, remaining: 0 };
}

// ---------- Public API ----------

/**
 * Initialize database (async).
 * Tries Firebase RTDB first; falls back to localStorage.
 */
export async function initDB() {
  metrics.mark('initDB-start');
  // --- Try Firebase ---
  if (isConfigured()) {
    try {
      console.log('[DB] Attempting Firebase connection...');
      const { db: fbDatabase } = initFirebase();
      _fbDb = fbDatabase;

      // Monitor .info/connected to see if WebSocket connects
      _fbDb.ref('.info/connected').on('value', (snap) => {
        const connected = snap.val();
        console.log(`[DB] Firebase .info/connected = ${connected}`);
      });

      // Pull full snapshot with a timeout so we don't hang forever
      console.log('[DB] Fetching initial snapshot (12s timeout)...');
      const snapshot = await Promise.race([
        _fbDb.ref('/').once('value'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 12000))
      ]);
      const data = snapshot.val();
      console.log('[DB] Initial snapshot received, keys:', data ? Object.keys(data).join(', ') : 'null');
      metrics.mark('initial-root-snapshot');
      metrics.recordRootSnapshot({ source: 'initial-once', value: data });

      if (data && typeof data === 'object') {
        _db = data;
        _mergeDefaults(_db);
      } else {
        // Empty Firebase DB — seed with defaults
        _db = getDefaultDB();
        try {
          await _fbDb.ref('/').set(_db);
          metrics.recordFirebaseWrite({ op: 'set-seed', path: '/', mode: 'acknowledged', ok: true });
        } catch (seedErr) {
          metrics.recordFirebaseWrite({ op: 'set-seed', path: '/', mode: 'acknowledged', ok: false });
          throw seedErr;
        }
      }

      _useFirebase = true;
      _persistReason = 'startup';
      _persistLocal(); // keep localStorage as offline fallback
      if (metrics.isEnabled()) {
        metrics.captureCacheRoot(_db);
        metrics.recordMajorNodeSizes(_db);
      }

      // Live sync: Firebase → cache
      _fbDb.ref('/').on('value', (snap) => {
        const fresh = snap.val();
        if (fresh && typeof fresh === 'object') {
          _db = fresh;
          const listenerPaths = Array.from(_listeners.keys());
          let callbackCount = 0;
          for (const cbs of _listeners.values()) {
            callbackCount += cbs.size;
          }
          metrics.recordRegisteredListeners(listenerPaths);
          metrics.recordRootSnapshot({
            source: 'root-listener',
            value: fresh,
            listenerPathCount: listenerPaths.length,
            listenerCallbackCount: callbackCount,
            listenerPaths,
          });
          _persistReason = 'root-snapshot';
          _persistLocal();
          for (const [p, cbs] of _listeners) {
            const val = get(p);
            for (const cb of cbs) {
              try { cb(val); } catch (e) { /* ignore */ }
            }
          }
        }
      });

      console.log('[DB] Firebase Realtime Database connected (WebSocket)');
      metrics.mark('initDB-complete');
      return;
    } catch (e) {
      console.warn('[DB] Firebase failed, falling back to localStorage:', e.message);
      console.warn('[DB] Full error:', e);
    }
  }

  // --- Fallback: localStorage ---
  _useFirebase = false;
  const stored = _loadLocal();
  if (stored) {
    _db = stored;
    _mergeDefaults(_db);
  } else {
    _db = getDefaultDB();
  }
  _persistReason = 'startup';
  _persistLocal();
  if (metrics.isEnabled()) {
    metrics.captureCacheRoot(_db);
    metrics.recordMajorNodeSizes(_db);
  }
  console.log('[DB] Using localStorage fallback');
  metrics.mark('initDB-complete');
}

/**
 * Get value at a path (e.g., "players/user1/inventory")
 * Returns deep clone to prevent accidental mutation.
 */
export function get(path) {
  const gate = readAudit.beforeRead('get', path);
  if (gate.block) throw gate.error;
  readAudit.record('get', path);
  return _readPath(path);
}

/**
 * Internal cache read without audit hooks (used by getChildren/query to avoid double-count).
 * @param {string} path
 */
function _readPath(path) {
  if (!_db) return null;
  const parts = String(path || '').split('/').filter(Boolean);
  if (parts.length === 0) {
    // Root read — deep clone entire cache
    return JSON.parse(JSON.stringify(_db));
  }
  let current = _db;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return null;
    current = current[part];
  }
  if (current === undefined) return null;
  return JSON.parse(JSON.stringify(current));
}

/**
 * Set value at a path, creating intermediate nodes as needed.
 */
export function set(path, value) {
  if (!_db) return;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return;

  let current = _db;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] === undefined || current[parts[i]] === null || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  const cloned = value !== undefined ? JSON.parse(JSON.stringify(value)) : null;
  current[parts[parts.length - 1]] = cloned;

  _persistReason = 'optimistic-local-write';
  _persistLocal();
  _fbSet(path, cloned);
  _notifyListeners(path);
}

/**
 * Update (shallow merge) at a path.
 */
export function update(path, updates) {
  if (!_db) return;
  const current = get(path);
  const merged = current && typeof current === 'object' ? { ...current, ...updates } : updates;

  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return;

  let node = _db;
  for (let i = 0; i < parts.length - 1; i++) {
    if (node[parts[i]] === undefined || node[parts[i]] === null || typeof node[parts[i]] !== 'object') {
      node[parts[i]] = {};
    }
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = JSON.parse(JSON.stringify(merged));

  _persistReason = 'optimistic-local-write';
  _persistLocal();
  _fbUpdate(path, JSON.parse(JSON.stringify(updates)));
  _notifyListeners(path);
}

/**
 * Remove a node at path.
 */
export function remove(path) {
  if (!_db) return;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return;

  let current = _db;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] === undefined) return;
    current = current[parts[i]];
  }
  delete current[parts[parts.length - 1]];

  _persistReason = 'optimistic-local-write';
  _persistLocal();
  _fbRemove(path);
  _notifyListeners(path);
}

/**
 * Generate a Firebase-style push key without writing.
 * Firebase: allocates via ref.push().key (local, no network).
 * Local-only: same synthetic key pattern as push().
 * @param {string} path - Parent path (e.g. 'trades/listings')
 * @returns {string}
 */
export function generatePushKey(path) {
  if (_useFirebase && _fbDb) {
    const fbPath = (path || '').split('/').filter(Boolean).join('/');
    return _fbDb.ref(fbPath || '/').push().key;
  }
  return '_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

/**
 * Push a new child with auto-generated key.
 * Returns the generated key.
 */
export function push(path, value) {
  const key = generatePushKey(path);
  set(`${path}/${key}`, value);
  return key;
}

/**
 * Subscribe to changes at a path.
 * Returns unsubscribe function.
 */
export function onValue(path, callback) {
  if (!_listeners.has(path)) {
    _listeners.set(path, new Set());
  }
  _listeners.get(path).add(callback);
  if (metrics.isEnabled()) {
    metrics.recordRegisteredListeners(Array.from(_listeners.keys()));
  }

  // Immediately call with current value
  try { callback(get(path)); } catch (e) { console.error('[DB] Listener error:', e); }

  return () => {
    const s = _listeners.get(path);
    if (s) {
      s.delete(callback);
      if (s.size === 0) _listeners.delete(path);
    }
    if (metrics.isEnabled()) {
      metrics.recordRegisteredListeners(Array.from(_listeners.keys()));
    }
  };
}

/**
 * Get all children of a path as an array of {key, value} pairs.
 */
export function getChildren(path) {
  const gate = readAudit.beforeRead('getChildren', path);
  if (gate.block) throw gate.error;
  readAudit.record('getChildren', path);
  const data = _readPath(path);
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data).map(([key, value]) => ({ key, value }));
}

/**
 * Query children matching a condition.
 */
export function query(path, filterFn) {
  const gate = readAudit.beforeRead('query', path);
  if (gate.block) throw gate.error;
  readAudit.record('query', path);
  const data = _readPath(path);
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data)
    .map(([key, value]) => ({ key, value }))
    .filter(({ key, value }) => filterFn(key, value));
}

/**
 * Get the raw DB for debug purposes.
 */
export function getFullDB() {
  return get('');
}

/**
 * Reset entire database to defaults.
 */
export function resetDB() {
  _db = getDefaultDB();
  _persistReason = 'optimistic-local-write';
  _persistLocal();
  if (_useFirebase && _fbDb) {
    metrics.recordFirebaseWrite({ op: 'set', path: '/', mode: 'fire-and-forget' });
    _fbDb.ref('/').set(_db)
      .catch(e => console.warn('[DB] Firebase reset error:', e.message));
  }
}

/** Check if Firebase is the active backend. */
export function isFirebaseConnected() {
  return _useFirebase;
}

/**
 * Whether a path has been marked ready by scoped load/subscribe.
 * Hierarchical downward: a ready ancestor satisfies child-path readiness.
 * A ready child does NOT imply its parent is ready.
 * Root wholesale hydration does not mark scoped readiness (S1).
 * @param {string} path
 * @returns {boolean}
 */
export function isPathReady(path) {
  return _isPathReadyNormalized(_normalizePath(path));
}

/**
 * Wait until isPathReady(path) or timeout.
 * @param {string} path
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, path: string, error?: string }>}
 */
export function waitForPath(path, options = {}) {
  const normalized = _normalizePath(path);
  if (!normalized) {
    return Promise.resolve({ ok: false, path: '', error: 'Invalid path' });
  }
  if (_isPathReadyNormalized(normalized)) {
    return Promise.resolve({ ok: true, path: normalized });
  }

  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;

  return new Promise((resolve) => {
    const entry = {
      resolve,
      reject: resolve,
      timer: null,
    };
    if (!_readyWaiters.has(normalized)) _readyWaiters.set(normalized, []);
    _readyWaiters.get(normalized).push(entry);

    entry.timer = setTimeout(() => {
      const list = _readyWaiters.get(normalized);
      if (list) {
        const idx = list.indexOf(entry);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) _readyWaiters.delete(normalized);
      }
      resolve({ ok: false, path: normalized, error: 'timeout' });
    }, timeoutMs);
  });
}

/**
 * Active scoped Firebase path subscriptions (not db.onValue observers).
 * @returns {{ path: string, id: string, refCount: number }[]}
 */
export function getSubscriptionRegistry() {
  return Array.from(_fbPathSubscriptions.entries()).map(([path, entry]) => ({
    path,
    id: entry.id,
    refCount: entry.refCount,
  }));
}

/**
 * Explicitly delete a cached subtree and clear readiness under it.
 * Does not detach Firebase subscriptions — call unsubscribe separately.
 * @param {string} path
 * @returns {{ ok: boolean, path: string, error?: string }}
 */
export function clearCachedPath(path) {
  const normalized = _normalizePath(path);
  if (!normalized) return { ok: false, path: '', error: 'Invalid path' };
  if (!_db) return { ok: false, path: normalized, error: 'Database not initialized' };

  _clearReadyMarksUnder(normalized);
  _applyScopedSnapshot(normalized, null, {
    source: 'scoped-clear',
    persist: true,
    markReady: false,
  });
  return { ok: true, path: normalized };
}

/**
 * One-shot load of a path into the cache (subtree merge only).
 * Does not attach a live Firebase listener.
 * Duplicate in-flight calls for the same path share one pending Promise.
 * Paths already marked ready skip the network unless `{ force: true }`.
 * @param {string} path
 * @param {{ timeoutMs?: number, force?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, path: string, value: any, mode: 'firebase'|'local', reused?: boolean, error?: string }>}
 */
export async function loadPathOnce(path, options = {}) {
  const normalized = _normalizePath(path);
  const modeHint = _useFirebase ? 'firebase' : 'local';
  if (!normalized) {
    return { ok: false, path: '', value: null, mode: modeHint, error: 'Invalid path' };
  }
  if (!_db) {
    return { ok: false, path: normalized, value: null, mode: modeHint, error: 'Database not initialized' };
  }

  const force = options.force === true;

  if (!force && _isPathReadyNormalized(normalized)) {
    return {
      ok: true,
      path: normalized,
      value: get(normalized),
      mode: modeHint,
      reused: true,
    };
  }

  if (!force && _pendingPathLoads.has(normalized)) {
    const pending = await _pendingPathLoads.get(normalized);
    return { ...pending, reused: true };
  }

  const work = _loadPathOnceWork(normalized, options);
  _pendingPathLoads.set(normalized, work);
  try {
    return await work;
  } finally {
    if (_pendingPathLoads.get(normalized) === work) {
      _pendingPathLoads.delete(normalized);
    }
  }
}

/**
 * @param {string} normalized
 * @param {{ timeoutMs?: number }} options
 */
async function _loadPathOnceWork(normalized, options = {}) {
  if (!_useFirebase || !_fbDb) {
    _markPathReady(normalized);
    _notifyScoped(normalized);
    return { ok: true, path: normalized, value: get(normalized), mode: 'local', reused: false };
  }

  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 12000;
  const fbPath = normalized;

  try {
    const snap = await Promise.race([
      _fbDb.ref(fbPath).once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    const value = snap.val();
    _applyScopedSnapshot(normalized, value, { source: 'scoped-once', persist: true, markReady: true });
    return { ok: true, path: normalized, value: get(normalized), mode: 'firebase', reused: false };
  } catch (e) {
    console.warn('[DB] loadPathOnce error:', fbPath, e.message);
    return {
      ok: false,
      path: normalized,
      value: null,
      mode: 'firebase',
      reused: false,
      error: e.message || 'Load failed',
    };
  }
}

/**
 * Own a Firebase `.on('value')` subscription for a path; merge into cache on each event.
 * Observation of cache changes should use db.onValue (separate from network ownership).
 * Duplicate subscribePath for the same path reuses the Firebase listener (refCount++).
 * Unsubscribe does not evict cache or clear readiness.
 *
 * @param {string} path
 * @returns {{ unsubscribe: Function, id: string, path: string, reused: boolean }}
 */
export function subscribePath(path) {
  const normalized = _normalizePath(path);
  if (!normalized) {
    return {
      unsubscribe: () => {},
      id: '',
      path: '',
      reused: false,
    };
  }

  const existing = _fbPathSubscriptions.get(normalized);
  if (existing) {
    existing.refCount += 1;
    if (metrics.isEnabled()) {
      metrics.recordScopedSubscription({
        action: 'reuse',
        path: normalized,
        refCount: existing.refCount,
        id: existing.id,
      });
    }
    _syncScopedSubscriptionMetrics();
    return {
      unsubscribe: () => { _releasePathSubscription(normalized); },
      id: existing.id,
      path: normalized,
      reused: true,
    };
  }

  _scopedSubSeq += 1;
  const id = `scoped-sub-${_scopedSubSeq}`;
  const fbPath = normalized;

  const handler = (snap) => {
    _applyScopedSnapshot(normalized, snap.val(), {
      source: 'scoped-subscription',
      persist: true,
      markReady: true,
    });
  };

  if (_useFirebase && _fbDb) {
    _fbDb.ref(fbPath).on('value', handler);
  } else {
    // Local-only: mark ready from current cache; no network listener
    _markPathReady(normalized);
    _notifyScoped(normalized);
  }

  _fbPathSubscriptions.set(normalized, {
    id,
    refCount: 1,
    fbPath,
    handler,
  });

  if (metrics.isEnabled()) {
    metrics.recordScopedSubscription({
      action: 'add',
      path: normalized,
      refCount: 1,
      id,
    });
  }
  _syncScopedSubscriptionMetrics();

  return {
    unsubscribe: () => { _releasePathSubscription(normalized); },
    id,
    path: normalized,
    reused: false,
  };
}

/**
 * Patch in-memory cache (+ localStorage mirror) and notify listeners without a Firebase write.
 * Used after an acknowledged remote write succeeds, or for local-only mode.
 */
export function applyLocalOnly(path, value) {
  if (!_db) return;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return;

  if (value === null || value === undefined) {
    let current = _db;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined || current[parts[i]] === null) return;
      current = current[parts[i]];
    }
    delete current[parts[parts.length - 1]];
  } else {
    let current = _db;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined || current[parts[i]] === null || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = JSON.parse(JSON.stringify(value));
  }

  _persistReason = 'acknowledged-cache-patch';
  _persistLocal();
  _notifyListeners(path);
}

/**
 * Await a single-path Firebase set, then apply to local cache.
 * In local-only mode, applies locally and returns { mode: 'local' }.
 * @returns {Promise<{ ok: boolean, mode: 'firebase'|'local', error?: string }>}
 */
export async function setAcknowledged(path, value) {
  if (!_db) return { ok: false, mode: _useFirebase ? 'firebase' : 'local', error: 'Database not initialized' };

  const cloned = value !== undefined && value !== null
    ? JSON.parse(JSON.stringify(value))
    : null;

  if (!_useFirebase || !_fbDb) {
    applyLocalOnly(path, cloned);
    return { ok: true, mode: 'local' };
  }

  const fbPath = path.split('/').filter(Boolean).join('/');
  try {
    await _fbDb.ref(fbPath).set(cloned);
    metrics.recordFirebaseWrite({ op: 'set-ack', path: fbPath || '/', mode: 'acknowledged', ok: true });
    applyLocalOnly(path, cloned);
    return { ok: true, mode: 'firebase' };
  } catch (e) {
    metrics.recordFirebaseWrite({ op: 'set-ack', path: fbPath || '/', mode: 'acknowledged', ok: false });
    console.warn('[DB] setAcknowledged error:', fbPath, e.message);
    return { ok: false, mode: 'firebase', error: e.message || 'Write failed' };
  }
}

/**
 * Await a root multi-path Firebase update (atomic), then apply each key to local cache.
 * `updates` keys are absolute paths from DB root (e.g. players/u, accessCodes/X/used).
 * @returns {Promise<{ ok: boolean, mode: 'firebase'|'local', error?: string }>}
 */
export async function updateAcknowledged(updates) {
  if (!_db) return { ok: false, mode: _useFirebase ? 'firebase' : 'local', error: 'Database not initialized' };
  if (!updates || typeof updates !== 'object') {
    return { ok: false, mode: _useFirebase ? 'firebase' : 'local', error: 'Invalid updates' };
  }

  const cloned = JSON.parse(JSON.stringify(updates));

  if (!_useFirebase || !_fbDb) {
    for (const [path, value] of Object.entries(cloned)) {
      applyLocalOnly(path, value);
    }
    return { ok: true, mode: 'local' };
  }

  try {
    await _fbDb.ref('/').update(cloned);
    metrics.recordFirebaseWrite({
      op: 'update-ack',
      path: '/',
      mode: 'acknowledged',
      ok: true,
      extraPaths: Object.keys(cloned),
    });
    for (const [path, value] of Object.entries(cloned)) {
      applyLocalOnly(path, value);
    }
    return { ok: true, mode: 'firebase' };
  } catch (e) {
    metrics.recordFirebaseWrite({
      op: 'update-ack',
      path: '/',
      mode: 'acknowledged',
      ok: false,
      extraPaths: Object.keys(cloned),
    });
    console.warn('[DB] updateAcknowledged error:', e.message);
    return { ok: false, mode: 'firebase', error: e.message || 'Write failed' };
  }
}

/**
 * Clear players/{username}/activeSession only if it still belongs to sessionId.
 * Firebase: RTDB transaction (abort leaves a newer session untouched).
 * Local-only: clear cache node only on id match.
 * @returns {Promise<{ ok: boolean, cleared: boolean, mode: 'firebase'|'local', error?: string }>}
 */
export async function clearActiveSessionIfOwned(username, sessionId) {
  if (!_db || !username || !sessionId) {
    return { ok: false, cleared: false, mode: _useFirebase ? 'firebase' : 'local', error: 'Invalid arguments' };
  }

  const path = `players/${username}/activeSession`;

  if (!_useFirebase || !_fbDb) {
    const current = get(path);
    if (current && current.id === sessionId) {
      applyLocalOnly(path, null);
      return { ok: true, cleared: true, mode: 'local' };
    }
    return { ok: true, cleared: false, mode: 'local' };
  }

  try {
    const result = await _fbDb.ref(path).transaction(current => {
      if (!current || current.id !== sessionId) return;
      return null;
    });
    const cleared = result.committed === true;
    metrics.recordFirebaseWrite({
      op: 'transaction',
      path,
      mode: 'acknowledged',
      ok: true,
    });
    const nextVal = result.snapshot ? result.snapshot.val() : null;
    applyLocalOnly(path, nextVal == null ? null : nextVal);
    return { ok: true, cleared, mode: 'firebase' };
  } catch (e) {
    metrics.recordFirebaseWrite({
      op: 'transaction',
      path,
      mode: 'acknowledged',
      ok: false,
    });
    console.warn('[DB] clearActiveSessionIfOwned error:', e.message);
    return { ok: false, cleared: false, mode: 'firebase', error: e.message || 'Transaction failed' };
  }
}

/**
 * One-shot read of a path from Firebase (server-current when connected).
 * Local-only mode returns the cache value.
 * @param {string} path
 * @returns {Promise<{ ok: boolean, value: any, mode: 'firebase'|'local', error?: string }>}
 */
export async function getAcknowledged(path) {
  if (!_db) return { ok: false, value: null, mode: _useFirebase ? 'firebase' : 'local', error: 'Database not initialized' };

  if (!_useFirebase || !_fbDb) {
    return { ok: true, value: get(path), mode: 'local' };
  }

  const fbPath = path.split('/').filter(Boolean).join('/');
  try {
    const snap = await _fbDb.ref(fbPath).once('value');
    const value = snap.val();
    applyLocalOnly(path, value == null ? null : value);
    return { ok: true, value, mode: 'firebase' };
  } catch (e) {
    console.warn('[DB] getAcknowledged error:', fbPath, e.message);
    return { ok: false, value: null, mode: 'firebase', error: e.message || 'Read failed' };
  }
}

/**
 * Claim an active, unexpired listing via RTDB transaction (multi-accepter guard).
 * @param {string} listingId
 * @param {{ accepterId: string, chosenCardId: string, claimId: string, now?: number }} claim
 * @returns {Promise<{ ok: boolean, claimed: boolean, listing?: object|null, reason?: string, mode: string, error?: string }>}
 */
export async function claimListingIfActive(listingId, claim) {
  if (!_db || !listingId || !claim?.accepterId || !claim?.chosenCardId || !claim?.claimId) {
    return {
      ok: false,
      claimed: false,
      listing: null,
      reason: 'INVALID_CLAIM',
      mode: _useFirebase ? 'firebase' : 'local',
    };
  }

  const path = `trades/listings/${listingId}`;
  const now = Number.isFinite(Number(claim.now)) ? Number(claim.now) : Date.now();

  const tryClaim = (current) => {
    if (!current || typeof current !== 'object') return;
    if (current.status !== 'active') return;
    if (current.expiresAt && now > current.expiresAt) return;
    return {
      ...current,
      id: current.id || listingId,
      status: 'processing',
      processingBy: claim.accepterId,
      processingAt: now,
      claimId: claim.claimId,
      fulfilledCardId: claim.chosenCardId,
    };
  };

  if (!_useFirebase || !_fbDb) {
    const current = get(path);
    const next = tryClaim(current);
    if (!next) {
      const reason = current?.expiresAt && now > current.expiresAt
        ? 'LISTING_EXPIRED'
        : 'LISTING_NOT_ACTIVE';
      return { ok: true, claimed: false, listing: current, reason, mode: 'local' };
    }
    applyLocalOnly(path, next);
    return { ok: true, claimed: true, listing: next, mode: 'local' };
  }

  try {
    const result = await _fbDb.ref(path).transaction(current => tryClaim(current));
    metrics.recordFirebaseWrite({
      op: 'transaction',
      path,
      mode: 'acknowledged',
      ok: true,
      extraPaths: ['listing-claim'],
    });
    const nextVal = result.snapshot ? result.snapshot.val() : null;
    applyLocalOnly(path, nextVal == null ? null : nextVal);
    const claimed = result.committed === true;
    if (!claimed) {
      const reason = nextVal?.expiresAt && now > nextVal.expiresAt
        ? 'LISTING_EXPIRED'
        : 'LISTING_NOT_ACTIVE';
      return { ok: true, claimed: false, listing: nextVal, reason, mode: 'firebase' };
    }
    return { ok: true, claimed: true, listing: nextVal, mode: 'firebase' };
  } catch (e) {
    metrics.recordFirebaseWrite({
      op: 'transaction',
      path,
      mode: 'acknowledged',
      ok: false,
      extraPaths: ['listing-claim'],
    });
    console.warn('[DB] claimListingIfActive error:', e.message);
    return {
      ok: false,
      claimed: false,
      listing: null,
      mode: 'firebase',
      error: e.message || 'Claim transaction failed',
    };
  }
}

/**
 * Revert processing → active only if this claimId still owns the listing.
 * Never touches fulfilled / cancelled / expired / failed.
 * @param {string} listingId
 * @param {string} claimId
 * @returns {Promise<{ ok: boolean, released: boolean, listing?: object|null, mode: string, error?: string }>}
 */
export async function releaseListingClaimIfOwned(listingId, claimId) {
  if (!_db || !listingId || !claimId) {
    return {
      ok: false,
      released: false,
      listing: null,
      mode: _useFirebase ? 'firebase' : 'local',
      error: 'Invalid arguments',
    };
  }

  const path = `trades/listings/${listingId}`;

  const tryRelease = (current) => {
    if (!current || typeof current !== 'object') return;
    if (current.status !== 'processing') return;
    if (current.claimId !== claimId) return;
    const next = { ...current, status: 'active' };
    delete next.processingBy;
    delete next.processingAt;
    delete next.claimId;
    // Keep fulfilledCardId cleared on release — it was set as chosen during claim
    delete next.fulfilledCardId;
    return next;
  };

  if (!_useFirebase || !_fbDb) {
    const current = get(path);
    const next = tryRelease(current);
    if (!next) {
      return { ok: true, released: false, listing: current, mode: 'local' };
    }
    applyLocalOnly(path, next);
    return { ok: true, released: true, listing: next, mode: 'local' };
  }

  try {
    const result = await _fbDb.ref(path).transaction(current => tryRelease(current));
    metrics.recordFirebaseWrite({
      op: 'transaction',
      path,
      mode: 'acknowledged',
      ok: true,
      extraPaths: ['listing-release'],
    });
    const nextVal = result.snapshot ? result.snapshot.val() : null;
    applyLocalOnly(path, nextVal == null ? null : nextVal);
    return {
      ok: true,
      released: result.committed === true,
      listing: nextVal,
      mode: 'firebase',
    };
  } catch (e) {
    metrics.recordFirebaseWrite({
      op: 'transaction',
      path,
      mode: 'acknowledged',
      ok: false,
      extraPaths: ['listing-release'],
    });
    console.warn('[DB] releaseListingClaimIfOwned error:', e.message);
    return {
      ok: false,
      released: false,
      listing: null,
      mode: 'firebase',
      error: e.message || 'Release transaction failed',
    };
  }
}
