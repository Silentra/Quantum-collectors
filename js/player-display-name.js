/**
 * Player display-name foundation (Slice A + Slice C).
 *
 * Login username remains the stable identity key.
 * displayName is a mutable visible label only.
 *
 * visibleName = valid/non-empty displayName || username
 *
 * Slice C: teacher-required rename is single-use and rules-enforced.
 */

/** Max length for NEW login usernames and NEW display-name submissions. */
export const DISPLAY_NAME_MAX_LENGTH = 20;
export const DISPLAY_NAME_MIN_LENGTH = 3;

/** Teacher instruction for required rename (plain text). */
export const DISPLAY_NAME_CHANGE_MESSAGE_MAX_LENGTH = 200;

/** Approved V1 display-name pattern (case preserved; no spaces). */
export const DISPLAY_NAME_RE = /^[A-Za-z0-9_]{3,20}$/;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function trimDisplayNameInput(value) {
  return String(value ?? '').trim();
}

/**
 * Validate a NEW display-name submission.
 * Does not mutate or reject grandfathered stored values at render time.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, displayName: string } | { ok: false, error: string }}
 */
export function validateDisplayName(raw) {
  const displayName = trimDisplayNameInput(raw);
  if (!displayName) {
    return { ok: false, error: 'Display name is required.' };
  }
  if (displayName.length < DISPLAY_NAME_MIN_LENGTH) {
    return {
      ok: false,
      error: `Display name must be at least ${DISPLAY_NAME_MIN_LENGTH} characters.`,
    };
  }
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`,
    };
  }
  if (!DISPLAY_NAME_RE.test(displayName)) {
    return {
      ok: false,
      error: 'Display name must be 3–20 characters: letters, numbers, and underscore only.',
    };
  }
  return { ok: true, displayName };
}

/**
 * Optional teacher instruction for Require Name Change.
 * @param {unknown} raw
 * @returns {{ ok: true, message: string|null } | { ok: false, error: string }}
 */
export function validateDisplayNameChangeMessage(raw) {
  const message = trimDisplayNameInput(raw);
  if (!message) return { ok: true, message: null };
  if (message.length > DISPLAY_NAME_CHANGE_MESSAGE_MAX_LENGTH) {
    return {
      ok: false,
      error: `Message must be at most ${DISPLAY_NAME_CHANGE_MESSAGE_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, message };
}

/**
 * @param {object|null|undefined} playerLike
 * @returns {boolean}
 */
export function playerRequiresDisplayNameChange(playerLike) {
  return !!(playerLike && typeof playerLike === 'object' && playerLike.requiresDisplayNameChange === true);
}

/**
 * @param {object|null|undefined} playerLike
 * @returns {string|null}
 */
export function getDisplayNameChangeMessage(playerLike) {
  if (!playerLike || typeof playerLike !== 'object') return null;
  if (typeof playerLike.displayNameChangeMessage !== 'string') return null;
  const trimmed = playerLike.displayNameChangeMessage.trim();
  return trimmed || null;
}

/**
 * Tolerant render-time resolver. Never throws on legacy/bad data.
 *
 * @param {object|string|null|undefined} source - player-like, directory-like, or raw displayName string
 * @param {string} [usernameFallback]
 * @returns {string}
 */
export function getPlayerDisplayName(source, usernameFallback = '') {
  const fallback = String(
    usernameFallback
      || (source && typeof source === 'object' && source.username != null ? source.username : '')
      || '',
  );

  let raw = null;
  if (typeof source === 'string') {
    raw = source;
  } else if (source && typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, 'displayName')) {
    raw = source.displayName;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  }

  return fallback;
}

/**
 * Normalize displayName for directory projection / equality.
 * Empty / missing → null (Firebase omits nulls on write).
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function projectDisplayNameForDirectory(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Admin direct-rename multipath fragment for players/{key} only.
 * Clears require-change fields (cancels outstanding Require Name Change).
 * Caller must also merge syncDirectoryUpdateFromPlayer(...).
 *
 * @param {string} playerKey
 * @param {string} displayName - already validated
 * @returns {Record<string, string|null>}
 */
export function buildAdminSetDisplayNamePlayerPaths(playerKey, displayName) {
  const key = String(playerKey || '').trim();
  if (!key) return {};
  return {
    [`players/${key}/displayName`]: displayName,
    [`players/${key}/requiresDisplayNameChange`]: null,
    [`players/${key}/displayNameChangeMessage`]: null,
  };
}

/**
 * Admin Require Name Change multipath (players only; no directory mirror).
 *
 * @param {string} playerKey
 * @param {string|null} message - already validated (null = clear/absent)
 * @returns {Record<string, boolean|string|null>}
 */
export function buildAdminRequireDisplayNameChangePaths(playerKey, message = null) {
  const key = String(playerKey || '').trim();
  if (!key) return {};
  return {
    [`players/${key}/requiresDisplayNameChange`]: true,
    [`players/${key}/displayNameChangeMessage`]: message == null || message === '' ? null : String(message),
  };
}

/**
 * Flagged-student authorized rename multipath (players only).
 * Caller merges syncDirectoryUpdateFromPlayer with the new displayName.
 *
 * @param {string} playerKey
 * @param {string} displayName - already validated
 * @returns {Record<string, string|null>}
 */
export function buildStudentAuthorizedDisplayNameChangePaths(playerKey, displayName) {
  const key = String(playerKey || '').trim();
  if (!key) return {};
  return {
    [`players/${key}/displayName`]: displayName,
    [`players/${key}/requiresDisplayNameChange`]: null,
    [`players/${key}/displayNameChangeMessage`]: null,
  };
}
