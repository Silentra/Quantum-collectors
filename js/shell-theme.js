/**
 * Application shell theme hooks (S4 / S4.5 infrastructure).
 *
 * Applies stable data-* attributes and title mount metadata only.
 * No inline styles, no runtime style mutation, no cosmetic visual definitions.
 *
 * @see ARCHITECTURE.md — Application Shell & Theme Doctrine
 */

import {
  getCosmeticDefinition,
  isCosmeticDefinitionActive,
} from './cosmetic-definitions.js';
import { ITEM_CATEGORIES } from './shop-definitions.js';

/** Default hook values when nothing is equipped (matches current base visuals). */
export const SHELL_THEME_DEFAULTS = Object.freeze({
  banner: 'default',
  background: 'default',
  theme: 'default',
});

export const IDENTITY_ACCENT_DEFAULT = 'default';
export const PROFILE_HEADER_TEXT_DEFAULT = 'default';
export const PROFILE_BODY_TEXT_DEFAULT = 'default';

/** Profile readability palette (same options as identity accent swatches). */
export const PROFILE_TEXT_COLOR_IDS = Object.freeze([
  'default',
  'slate',
  'silver',
  'ice',
  'sky',
  'teal',
  'emerald',
  'lime',
  'gold',
  'amber',
  'coral',
  'rose',
  'lavender',
  'violet',
  'indigo',
]);

/**
 * Curated identity accent allowlist (~14 options).
 * Profile utility preference — NOT an earned cosmetic, NOT a shell theme pack.
 */
export const IDENTITY_ACCENT_IDS = Object.freeze([
  'default',
  'slate',
  'silver',
  'ice',
  'sky',
  'teal',
  'emerald',
  'lime',
  'gold',
  'amber',
  'coral',
  'rose',
  'lavender',
  'violet',
  'indigo',
]);

const IDENTITY_ACCENT_SET = new Set(IDENTITY_ACCENT_IDS);
const PROFILE_TEXT_COLOR_SET = new Set(PROFILE_TEXT_COLOR_IDS);

/**
 * Shell-background cosmetic category id (alias for ITEM_CATEGORIES.SHELL_BACKGROUND).
 * Independent from profile_banner and title.
 */
export const SHELL_BACKGROUND_CATEGORY = ITEM_CATEGORIES.SHELL_BACKGROUND;

const PROFILE_EQUIPPED_FIELDS = Object.freeze({
  banner: 'equippedBanner',
  background: 'equippedBackground',
  title: 'equippedTitle',
});

const CATEGORY_BY_SLOT = Object.freeze({
  banner: ITEM_CATEGORIES.PROFILE_BANNER,
  background: SHELL_BACKGROUND_CATEGORY,
  title: ITEM_CATEGORIES.TITLE,
});

/**
 * Normalize identity accent slug; invalid values fall back to default.
 * @param {string|null|undefined} accentId
 * @returns {string}
 */
export function normalizeIdentityAccent(accentId) {
  if (typeof accentId !== 'string') return IDENTITY_ACCENT_DEFAULT;
  const slug = accentId.trim().toLowerCase();
  return IDENTITY_ACCENT_SET.has(slug) ? slug : IDENTITY_ACCENT_DEFAULT;
}

/**
 * @param {string|null|undefined} colorId
 * @returns {string}
 */
export function normalizeProfileHeaderTextColor(colorId) {
  if (typeof colorId !== 'string') return PROFILE_HEADER_TEXT_DEFAULT;
  const slug = colorId.trim().toLowerCase();
  return PROFILE_TEXT_COLOR_SET.has(slug) ? slug : PROFILE_HEADER_TEXT_DEFAULT;
}

/**
 * @param {string|null|undefined} colorId
 * @returns {string}
 */
export function normalizeProfileBodyTextColor(colorId) {
  if (typeof colorId !== 'string') return PROFILE_BODY_TEXT_DEFAULT;
  const slug = colorId.trim().toLowerCase();
  return PROFILE_TEXT_COLOR_SET.has(slug) ? slug : PROFILE_BODY_TEXT_DEFAULT;
}

/**
 * Map a cosmetic item id to a stable, CSS-safe theme slug for data-* hooks.
 * @param {string|null|undefined} itemId
 * @returns {string|null}
 */
export function cosmeticIdToShellSlug(itemId) {
  if (!itemId || typeof itemId !== 'string') return null;
  const slug = itemId
    .replace(/^(profile_banner_|shell_bg_|shell_background_|title_)/i, '')
    .replace(/_/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  return slug || null;
}

function isEquippedCosmetic(itemId, playerData, category) {
  if (!itemId || !category) return false;
  const def = getCosmeticDefinition(itemId);
  if (!isCosmeticDefinitionActive(def) || def.category !== category) return false;
  return playerData?.cosmetics?.owned?.[itemId] === true;
}

/**
 * Resolve independent shell theme hook values from canonical profile runtime state.
 * Categories remain independent (banner + background + title may mix freely).
 * @param {object|null|undefined} playerData
 * @returns {{ banner: string, background: string, theme: string, identityAccent: string, headerTextColor: string, bodyTextColor: string, titleSlug: string, titleItemId: string|null }}
 */
export function resolveShellThemeState(playerData) {
  const bannerId = playerData?.profile?.[PROFILE_EQUIPPED_FIELDS.banner] ?? null;
  const backgroundId = playerData?.profile?.[PROFILE_EQUIPPED_FIELDS.background] ?? null;
  const titleId = playerData?.profile?.[PROFILE_EQUIPPED_FIELDS.title] ?? null;

  const banner = isEquippedCosmetic(bannerId, playerData, CATEGORY_BY_SLOT.banner)
    ? (cosmeticIdToShellSlug(bannerId) || SHELL_THEME_DEFAULTS.banner)
    : SHELL_THEME_DEFAULTS.banner;

  const background = isEquippedCosmetic(backgroundId, playerData, CATEGORY_BY_SLOT.background)
    ? (cosmeticIdToShellSlug(backgroundId) || SHELL_THEME_DEFAULTS.background)
    : SHELL_THEME_DEFAULTS.background;

  const titleSlug = isEquippedCosmetic(titleId, playerData, CATEGORY_BY_SLOT.title)
    ? (cosmeticIdToShellSlug(titleId) || SHELL_THEME_DEFAULTS.theme)
    : 'default';

  const identityAccent = normalizeIdentityAccent(playerData?.profile?.identityAccent);
  const headerTextColor = normalizeProfileHeaderTextColor(playerData?.profile?.headerTextColor);
  const bodyTextColor = normalizeProfileBodyTextColor(playerData?.profile?.bodyTextColor);

  return {
    banner,
    background,
    theme: SHELL_THEME_DEFAULTS.theme,
    identityAccent,
    headerTextColor,
    bodyTextColor,
    titleSlug,
    titleItemId: isEquippedCosmetic(titleId, playerData, CATEGORY_BY_SLOT.title) ? titleId : null,
  };
}

function applyThemeAttributes(screen, chrome, header, state) {
  screen.dataset.banner = state.banner;
  screen.dataset.background = state.background;
  screen.dataset.theme = state.theme;
  screen.dataset.identityAccent = state.identityAccent;
  screen.dataset.headerText = state.headerTextColor;
  screen.dataset.bodyText = state.bodyTextColor;

  if (chrome) {
    chrome.dataset.banner = state.banner;
    chrome.dataset.theme = state.theme;
    chrome.dataset.identityAccent = state.identityAccent;
  }

  if (header) {
    header.dataset.identityAccent = state.identityAccent;
  }
}

/**
 * Sync #nav-player-title overlay mount (non-flow; visibility when equipped title has label).
 * @param {{ titleSlug: string, titleItemId: string|null }} state
 */
export function syncNavPlayerTitleMount(state) {
  const el = document.getElementById('nav-player-title');
  if (!el) return;

  const titleId = state?.titleItemId ?? null;
  const def = titleId ? getCosmeticDefinition(titleId) : null;
  const label = (def?.name || '').trim();

  el.dataset.title = state?.titleSlug || 'default';
  el.textContent = label;

  const visible = Boolean(label && state?.titleSlug && state.titleSlug !== 'default');
  el.hidden = !visible;
  if (visible) {
    el.removeAttribute('aria-hidden');
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
}

/**
 * Apply shell theme hooks to #screen-game / #game-shell-chrome / #game-header.
 * Pass null to reset to defaults (e.g. on logout).
 * @param {object|null|undefined} playerData
 */
export function applyShellTheme(playerData = null) {
  const screen = document.getElementById('screen-game');
  if (!screen) return;

  const chrome = document.getElementById('game-shell-chrome');
  const header = document.getElementById('game-header');
  const state = playerData ? resolveShellThemeState(playerData) : {
    ...SHELL_THEME_DEFAULTS,
    identityAccent: IDENTITY_ACCENT_DEFAULT,
    headerTextColor: PROFILE_HEADER_TEXT_DEFAULT,
    bodyTextColor: PROFILE_BODY_TEXT_DEFAULT,
    titleSlug: 'default',
    titleItemId: null,
  };

  applyThemeAttributes(screen, chrome, header, state);
  syncNavPlayerTitleMount(state);
}

export function resetShellTheme() {
  applyShellTheme(null);
}
