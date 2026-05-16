/**
 * Firebase Configuration & Initialization
 *
 * This module initializes Firebase App + Realtime Database.
 * Forces WebSocket-only transport to avoid BrowserPollConnection
 * (long-polling uses hidden iframes → SecurityError in sandboxed envs).
 *
 * The compat SDK v10 makes the transport decision during the
 * firebase.database() constructor. We must patch the internal
 * transport registry BEFORE that call.
 */

/* global firebase */

const firebaseConfig = {
  apiKey: "AIzaSyBanUCB_45ETUa7sPurLYoaWfpEZy5RJHo",
  authDomain: "quantum-collectors-v2.firebaseapp.com",
  databaseURL: "https://quantum-collectors-v2-default-rtdb.firebaseio.com/",
  projectId: "quantum-collectors-v2",
  storageBucket: "quantum-collectors-v2.firebasestorage.app",
  messagingSenderId: "862398724879",
  appId: "1:862398724879:web:bcfd15da93cf89323c5c7a"
};

let _app = null;
let _db = null;
let _initialized = false;

/**
 * Discover and log the internal structure of the firebase.database namespace
 * and a database instance, so we can find the right transport knobs.
 */
function discoverInternals(label, obj, maxDepth = 2) {
  if (!obj || typeof obj !== 'object') {
    console.log(`[Firebase:discover] ${label} = ${typeof obj}`);
    return;
  }
  const keys = [];
  try {
    // Get own + prototype keys
    const own = Object.getOwnPropertyNames(obj);
    const proto = obj.__proto__ ? Object.getOwnPropertyNames(obj.__proto__) : [];
    const all = [...new Set([...own, ...proto])].filter(k => k !== 'constructor');
    for (const k of all) {
      try {
        const v = obj[k];
        const t = typeof v;
        if (t === 'function') {
          keys.push(`${k}()`);
        } else if (t === 'object' && v !== null) {
          keys.push(`${k}{}`);
          if (maxDepth > 0) {
            // One level deeper for select keys
            if (k.includes('repo') || k.includes('Repo') || k === '_delegate' ||
                k === 'INTERNAL' || k.includes('info') || k.includes('Info') ||
                k.startsWith('_')) {
              const subKeys = Object.getOwnPropertyNames(v).slice(0, 15);
              console.log(`[Firebase:discover]   ${label}.${k} keys: [${subKeys.join(', ')}]`);
            }
          }
        } else {
          keys.push(`${k}=${JSON.stringify(v)}`);
        }
      } catch (e) {
        keys.push(`${k}=<error>`);
      }
    }
  } catch (e) {
    keys.push(`<enumeration error: ${e.message}>`);
  }
  console.log(`[Firebase:discover] ${label}: [${keys.join(', ')}]`);
}

/**
 * Pre-patch: set transport flags on firebase.database BEFORE creating instance.
 * The compat SDK checks these during database() construction.
 */
function prePatchTransport() {
  const ns = firebase.database;
  if (!ns) {
    console.warn('[Firebase] firebase.database namespace not available');
    return;
  }

  console.log('[Firebase] Pre-patching transport flags...');
  discoverInternals('firebase.database', ns, 1);

  // Try setting known flag names used across SDK versions
  const flagNames = [
    'forceWebSockets_', 'forceWebSockets', '_forceWebSockets',
    'FORCE_WEBSOCKETS', 'useWebSockets'
  ];
  for (const flag of flagNames) {
    try {
      ns[flag] = true;
      console.log(`[Firebase] Set firebase.database.${flag} = true`);
    } catch (e) { /* read-only, skip */ }
  }

  // Also try disabling long-polling flags
  const lpFlags = [
    'forceLongPolling_', 'forceLongPolling', '_forceLongPolling',
    'FORCE_LONG_POLLING', 'useLongPolling'
  ];
  for (const flag of lpFlags) {
    try {
      ns[flag] = false;
      console.log(`[Firebase] Set firebase.database.${flag} = false`);
    } catch (e) { /* read-only, skip */ }
  }

  // Check INTERNAL namespace
  if (ns.INTERNAL) {
    discoverInternals('firebase.database.INTERNAL', ns.INTERNAL, 1);
    // Try calling forceWebSockets if it exists
    if (typeof ns.INTERNAL.forceWebSockets === 'function') {
      try {
        ns.INTERNAL.forceWebSockets();
        console.log('[Firebase] Called INTERNAL.forceWebSockets()');
      } catch (e) {
        console.warn('[Firebase] INTERNAL.forceWebSockets() failed:', e.message);
      }
    }
  }
}

/**
 * Post-patch: after firebase.database() is called, try to set webSocketOnly
 * on the internal RepoInfo before the first connection attempt.
 */
function postPatchTransport(dbInstance) {
  console.log('[Firebase] Post-patching database instance transport...');
  discoverInternals('dbInstance', dbInstance, 2);

  let patched = false;

  // Walk the instance looking for webSocketOnly flag
  const visited = new Set();
  function deepPatch(obj, path, depth) {
    if (!obj || typeof obj !== 'object' || depth > 4 || visited.has(obj)) return false;
    visited.add(obj);

    // Direct hit: object has webSocketOnly property
    if ('webSocketOnly' in obj) {
      const before = obj.webSocketOnly;
      obj.webSocketOnly = true;
      console.log(`[Firebase] Set ${path}.webSocketOnly = true (was ${before})`);
      return true;
    }

    // Check keys selectively
    let found = false;
    const keys = Object.getOwnPropertyNames(obj);
    for (const key of keys) {
      try {
        const val = obj[key];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          if (deepPatch(val, `${path}.${key}`, depth + 1)) {
            found = true;
          }
        }
      } catch (e) { /* skip */ }
    }
    return found;
  }

  patched = deepPatch(dbInstance, 'db', 0);

  if (!patched) {
    console.warn('[Firebase] Could not find webSocketOnly flag in instance tree');
  }

  return patched;
}

/**
 * Final fallback: intercept XHR to block long-poll requests.
 * Firebase long-poll URLs contain specific path patterns.
 */
function installXHRInterceptor() {
  if (typeof XMLHttpRequest === 'undefined') return;

  console.log('[Firebase] Installing XHR long-poll interceptor as fallback...');

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    if (typeof url === 'string') {
      // Firebase RTDB long-poll URLs match: /.lp? or &transport=longpolling
      if (url.includes('.lp?') || url.includes('&lp=') ||
          url.includes('transport=longpolling') || url.includes('/poll')) {
        console.warn('[Firebase] XHR interceptor: blocking long-poll URL:', url.substring(0, 100));
        this._blockedLongPoll = true;
      }
    }
    return origOpen.call(this, method, url, ...args);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    if (this._blockedLongPoll) {
      setTimeout(() => {
        try {
          Object.defineProperty(this, 'status', { value: 0, configurable: true });
        } catch (e) { /* */ }
        this.dispatchEvent(new Event('error'));
      }, 0);
      return;
    }
    return origSend.call(this, ...args);
  };
}

/**
 * Initialize Firebase services (App + RTDB only, no Firebase Auth).
 * Safe to call multiple times — only initializes once.
 */
export function initFirebase() {
  if (_initialized) return { app: _app, db: _db };

  const sdkVersion = typeof firebase !== 'undefined' ? (firebase.SDK_VERSION || 'unknown') : 'not loaded';
  console.log(`[Firebase] SDK version: ${sdkVersion}`);
  console.log('[Firebase] Initializing...');

  try {
    // Step 1: Install XHR interceptor FIRST (before any SDK networking)
    installXHRInterceptor();

    // Step 2: Pre-patch transport flags on the namespace BEFORE database()
    prePatchTransport();

    // Step 3: Initialize App
    _app = firebase.initializeApp(firebaseConfig);
    console.log('[Firebase] App initialized');

    // Step 4: Get database instance (this triggers internal repo creation)
    _db = firebase.database();
    console.log('[Firebase] Database instance created');

    // Step 5: Post-patch the instance (try to set webSocketOnly on RepoInfo)
    const patched = postPatchTransport(_db);

    // Step 6: Go online
    _db.goOnline();

    _initialized = true;
    console.log(`[Firebase] Ready (transport patch: ${patched ? 'applied' : 'XHR-intercept-only'})`);
  } catch (e) {
    console.error('[Firebase] Initialization error:', e);
    throw e;
  }

  return { app: _app, db: _db };
}

/** Get Firebase Realtime Database instance */
export function getDatabase() {
  if (!_db) throw new Error('Firebase not initialized. Call initFirebase() first.');
  return _db;
}

/** Check if Firebase is configured (not placeholder keys) */
export function isConfigured() {
  return firebaseConfig.apiKey !== 'YOUR_API_KEY';
}
