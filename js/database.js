/**
 * Database Layer - Firebase Realtime Database
 *
 * Provides the SAME synchronous API as the original localStorage version
 * by maintaining an in-memory cache. On init, the full DB is pulled from
 * Firebase RTDB once. Writes update both cache and Firebase (fire-and-forget).
 *
 * If Firebase is not configured, falls back to localStorage silently.
 *
 * Exported API (unchanged from original):
 *   initDB()          - now async; loads from Firebase or localStorage
 *   get(path)         - sync read from cache
 *   set(path, val)    - sync cache + async Firebase write
 *   update(path, u)   - sync cache + async Firebase write
 *   remove(path)      - sync cache + async Firebase remove
 *   getChildren(path) - sync read from cache
 *   push(path, val)   - sync cache + async Firebase push
 *   onValue(p, cb)    - subscribe to cache changes
 *   query(p, fn)      - filter children
 *   getFullDB()       - debug
 *   resetDB()         - reset to defaults
 *
 * Data nodes: /config /players /cards /packs /groups /accessCodes /admin
 */

import { initFirebase, isConfigured } from './firebase-config.js';

const DB_KEY = 'scicards_db';

let _db = null;              // in-memory cache (synchronous reads)
let _fbDb = null;            // Firebase RTDB instance
let _useFirebase = false;    // true when Firebase is live
const _listeners = new Map();

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
  _fbDb.ref(fbPath).set(value != null ? value : null)
    .catch(e => console.warn('[DB] Firebase set error:', fbPath, e.message));
}

function _fbUpdate(path, updates) {
  if (!_useFirebase || !_fbDb) return;
  const fbPath = path.split('/').filter(Boolean).join('/');
  _fbDb.ref(fbPath).update(updates)
    .catch(e => console.warn('[DB] Firebase update error:', fbPath, e.message));
}

function _fbRemove(path) {
  if (!_useFirebase || !_fbDb) return;
  const fbPath = path.split('/').filter(Boolean).join('/');
  _fbDb.ref(fbPath).remove()
    .catch(e => console.warn('[DB] Firebase remove error:', fbPath, e.message));
}

// ---------- localStorage fallback ----------

function _persistLocal() {
  try { localStorage.setItem(DB_KEY, JSON.stringify(_db)); }
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

// ---------- Public API ----------

/**
 * Initialize database (async).
 * Tries Firebase RTDB first; falls back to localStorage.
 */
export async function initDB() {
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

      if (data && typeof data === 'object') {
        _db = data;
        _mergeDefaults(_db);
      } else {
        // Empty Firebase DB — seed with defaults
        _db = getDefaultDB();
        await _fbDb.ref('/').set(_db);
      }

      _useFirebase = true;
      _persistLocal(); // keep localStorage as offline fallback

      // Live sync: Firebase → cache
      _fbDb.ref('/').on('value', (snap) => {
        const fresh = snap.val();
        if (fresh && typeof fresh === 'object') {
          _db = fresh;
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
  _persistLocal();
  console.log('[DB] Using localStorage fallback');
}

/**
 * Get value at a path (e.g., "players/user1/inventory")
 * Returns deep clone to prevent accidental mutation.
 */
export function get(path) {
  if (!_db) return null;
  const parts = path.split('/').filter(Boolean);
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

  _persistLocal();
  _fbRemove(path);
  _notifyListeners(path);
}

/**
 * Push a new child with auto-generated key.
 * Returns the generated key.
 */
export function push(path, value) {
  let key;
  if (_useFirebase && _fbDb) {
    key = _fbDb.ref(path.split('/').filter(Boolean).join('/')).push().key;
  } else {
    key = '_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }
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

  // Immediately call with current value
  try { callback(get(path)); } catch (e) { console.error('[DB] Listener error:', e); }

  return () => {
    const s = _listeners.get(path);
    if (s) {
      s.delete(callback);
      if (s.size === 0) _listeners.delete(path);
    }
  };
}

/**
 * Get all children of a path as an array of {key, value} pairs.
 */
export function getChildren(path) {
  const data = get(path);
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data).map(([key, value]) => ({ key, value }));
}

/**
 * Query children matching a condition.
 */
export function query(path, filterFn) {
  return getChildren(path).filter(({ key, value }) => filterFn(key, value));
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
  _persistLocal();
  if (_useFirebase && _fbDb) {
    _fbDb.ref('/').set(_db)
      .catch(e => console.warn('[DB] Firebase reset error:', e.message));
  }
}

/** Check if Firebase is the active backend. */
export function isFirebaseConnected() {
  return _useFirebase;
}
