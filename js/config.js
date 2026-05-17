/**
 * Config Module - Centralized Live Configuration
 *
 * All gameplay balance values come from here (pulled from DB).
 * No hardcoded values in other modules — everything reads from config.
 */

import * as db from './database.js';

let _configCache = null;

/** Load config from database */
export function loadConfig() {
  _configCache = db.get('config');
  return _configCache;
}

/** Get full config */
export function getConfig() {
  if (!_configCache) loadConfig();
  return _configCache;
}

/** Get a specific config value by dot-path (e.g., "economy.packsPerDay") */
export function getValue(dotPath) {
  const config = getConfig();
  if (!config) return null;
  const parts = dotPath.split('.');
  let current = config;
  for (const part of parts) {
    if (current === null || current === undefined) return null;
    current = current[part];
  }
  return current !== undefined ? current : null;
}

/** Update a config value and persist */
export function setValue(dotPath, value) {
  const parts = dotPath.split('.');
  if (parts.length === 1) {
    db.update('config', { [dotPath]: value });
  } else {
    // Rebuild the nested path
    const topKey = parts[0];
    const subObj = db.get(`config/${topKey}`) || {};
    let current = subObj;
    for (let i = 1; i < parts.length - 1; i++) {
      if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
    db.set(`config/${topKey}`, subObj);
  }
  _configCache = null; // Invalidate cache
}

/** Check if game is open */
export function isGameOpen() {
  return getValue('gameOpen') !== false;
}

/** Check if registration is open */
export function isRegistrationOpen() {
  return getValue('registrationOpen') !== false;
}

/**
 * Get pack odds config.
 * @deprecated config.packOdds is unused by live pack generation — each pack type stores its own
 * odds in /packs/{id}/odds. This fallback only applies if a pack somehow has no odds object.
 * Kept for backward compatibility; do NOT remove without migrating existing packs.
 */
export function getPackOdds() {
  return getValue('packOdds') || { common: 50, uncommon: 25, rare: 15, epic: 8, legendary: 2 };
}

/** Subscribe to config changes */
export function onConfigChange(callback) {
  return db.onValue('config', (val) => {
    _configCache = val;
    callback(val);
  });
}
