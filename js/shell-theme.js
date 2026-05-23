/**
 * Application shell theme hooks (S4 infrastructure).
 *
 * Applies stable data-* attributes and title mount metadata only.
 * No inline styles, no runtime style mutation, no cosmetic visual definitions.
 *
 * @see ARCHITECTURE.md — Application Shell & Theme Doctrine
 */

import { ITEM_DEFINITIONS, ITEM_TYPES, ITEM_CATEGORIES } from './shop-definitions.js';

/** Default hook values when nothing is equipped (matches current base visuals). */
export const SHELL_THEME_DEFAULTS = Object.freeze({
  banner: 'default',
  background: 'default',
  theme: 'default',
});

/**
 * Reserved shell-background cosmetic category (shop items may be added later).
 * Independent from profile_banner and title.
 */
export const SHELL_BACKGROUND_CATEGORY = 'shell_background';

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
  const def = ITEM_DEFINITIONS[itemId];
  if (!def || def.type !== ITEM_TYPES.COSMETIC || def.enabled === false) return false;
  if (def.category !== category) return false;
  return playerData?.cosmetics?.owned?.[itemId] === true;
}

/**
 * Resolve independent shell theme hook values from canonical profile runtime state.
 * Categories remain independent (banner + background + title may mix freely).
 * @param {object|null|undefined} playerData
 * @returns {{ banner: string, background: string, theme: string, titleSlug: string, titleItemId: string|null }}
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

  return {
    banner,
    background,
    theme: SHELL_THEME_DEFAULTS.theme,
    titleSlug,
    titleItemId: isEquippedCosmetic(titleId, playerData, CATEGORY_BY_SLOT.title) ? titleId : null,
  };
}

function applyThemeAttributes(screen, chrome, state) {
  screen.dataset.banner = state.banner;
  screen.dataset.background = state.background;
  screen.dataset.theme = state.theme;

  if (chrome) {
    chrome.dataset.banner = state.banner;
    chrome.dataset.background = state.background;
    chrome.dataset.theme = state.theme;
  }
}

/**
 * Normalize #nav-player-title mount (metadata only; presentation deferred to S5+).
 * @param {object|null|undefined} playerData
 * @param {{ titleSlug: string, titleItemId: string|null }} state
 */
export function syncNavPlayerTitleMount(playerData, state) {
  const el = document.getElementById('nav-player-title');
  if (!el) return;

  const titleId = state?.titleItemId ?? null;
  const def = titleId ? ITEM_DEFINITIONS[titleId] : null;
  const label = def?.name || def?.label || '';

  el.dataset.title = state?.titleSlug || 'default';
  el.textContent = label;
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
}

/**
 * Apply shell theme hooks to #screen-game / #game-shell-chrome.
 * Pass null to reset to defaults (e.g. on logout).
 * @param {object|null|undefined} playerData
 */
export function applyShellTheme(playerData = null) {
  const screen = document.getElementById('screen-game');
  if (!screen) return;

  const chrome = document.getElementById('game-shell-chrome');
  const state = playerData ? resolveShellThemeState(playerData) : {
    ...SHELL_THEME_DEFAULTS,
    titleSlug: 'default',
    titleItemId: null,
  };

  applyThemeAttributes(screen, chrome, state);
  syncNavPlayerTitleMount(playerData, state);
}

export function resetShellTheme() {
  applyShellTheme(null);
}
