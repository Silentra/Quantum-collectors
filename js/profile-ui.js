/**
 * Profile UI — renders the player profile tab
 * Extracted from ui.cleaned.js (Phase 1 refactor)
 */

import * as auth from './auth.js';
import * as player from './player.js';
import * as cards from './cards.js';
import * as groups from './groups.js';
import * as toast from './toast.js';
import { ITEM_CATEGORIES, ITEM_DEFINITIONS, ITEM_TYPES, resolveItemDisplay } from './shop-definitions.js';
import {
  equipCosmetic,
  featureCard,
  unequipCosmetic,
  unfeatureCard,
} from './shop-mutations.js';

const PROFILE_FEATURED_CARD_LIMIT = 3;

const EQUIPPED_FIELDS = Object.freeze({
  [ITEM_CATEGORIES.AURA]: 'equippedAura',
  [ITEM_CATEGORIES.BORDER]: 'equippedBorder',
  [ITEM_CATEGORIES.PROFILE_BANNER]: 'equippedBanner',
  [ITEM_CATEGORIES.TITLE]: 'equippedTitle',
});

const EQUIPPED_LABELS = Object.freeze({
  [ITEM_CATEGORIES.AURA]: 'Aura',
  [ITEM_CATEGORIES.BORDER]: 'Border',
  [ITEM_CATEGORIES.PROFILE_BANNER]: 'Banner',
  [ITEM_CATEGORIES.TITLE]: 'Title',
});

function getOwnedCosmetics(playerData) {
  return playerData?.cosmetics?.owned && typeof playerData.cosmetics.owned === 'object'
    ? playerData.cosmetics.owned
    : {};
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatLabel(value, fallback = 'Unknown') {
  if (!value || typeof value !== 'string') return fallback;
  return value
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getReasonMessage(reason) {
  const messages = {
    card_already_featured: 'That card is already featured.',
    card_not_featured: 'That card is not currently featured.',
    card_not_owned: 'You do not own that card.',
    cosmetic_category_mismatch: 'That cosmetic does not match this category.',
    cosmetic_not_owned: 'You do not own that cosmetic.',
    featured_cards_full: `You can feature up to ${PROFILE_FEATURED_CARD_LIMIT} cards.`,
    invalid_card_id: 'Invalid card.',
    invalid_cosmetic_definition: 'Invalid cosmetic.',
    item_not_cosmetic: 'That item is not a cosmetic.',
    unsupported_cosmetic_category: 'That cosmetic category is not supported for equipping yet.',
  };
  return messages[reason] || formatLabel(reason, 'Action failed.');
}

function resolveEquippedCosmetic(playerData, profileField, category) {
  const itemId = playerData?.profile?.[profileField] ?? null;
  const definition = itemId ? ITEM_DEFINITIONS[itemId] : null;
  if (!definition || definition.enabled === false) return null;
  if (definition.type !== ITEM_TYPES.COSMETIC || definition.category !== category) return null;
  if (!getOwnedCosmetics(playerData)[itemId]) return null;
  return { itemId, definition };
}

export function getEquippedAura(playerData) {
  return resolveEquippedCosmetic(playerData, 'equippedAura', ITEM_CATEGORIES.AURA);
}

export function getEquippedBorder(playerData) {
  return resolveEquippedCosmetic(playerData, 'equippedBorder', ITEM_CATEGORIES.BORDER);
}

export function getEquippedBanner(playerData) {
  return resolveEquippedCosmetic(playerData, 'equippedBanner', ITEM_CATEGORIES.PROFILE_BANNER);
}

export function getEquippedTitle(playerData) {
  return resolveEquippedCosmetic(playerData, 'equippedTitle', ITEM_CATEGORIES.TITLE);
}

export function getProfileIdentityState(playerData) {
  const profile = playerData?.profile || {};
  return {
    aura: getEquippedAura(playerData),
    border: getEquippedBorder(playerData),
    banner: getEquippedBanner(playerData),
    title: getEquippedTitle(playerData),
    featuredCards: Array.isArray(profile.featuredCards) ? [...profile.featuredCards] : [],
    featuredAchievements: Array.isArray(profile.featuredAchievements)
      ? [...profile.featuredAchievements]
      : [],
  };
}

function getEquippedItemId(playerData, category) {
  const field = EQUIPPED_FIELDS[category];
  return field ? playerData?.profile?.[field] ?? null : null;
}

function isKnownEquippableCategory(category) {
  return Boolean(EQUIPPED_FIELDS[category]);
}

function getOwnedCosmeticEntries(playerData) {
  return Object.entries(getOwnedCosmetics(playerData))
    .filter(([, owned]) => owned === true)
    .map(([itemId]) => ({ itemId, definition: ITEM_DEFINITIONS[itemId] }))
    .filter(entry => entry.definition?.type === ITEM_TYPES.COSMETIC);
}

function getOwnedConsumableEntries(playerData) {
  const items = playerData?.items && typeof playerData.items === 'object' ? playerData.items : {};
  return Object.entries(items)
    .map(([itemId, quantity]) => ({
      itemId,
      quantity: Math.max(0, Math.floor(Number(quantity) || 0)),
      definition: ITEM_DEFINITIONS[itemId],
    }))
    .filter(entry => entry.quantity > 0 && entry.definition?.type === ITEM_TYPES.CONSUMABLE);
}

function getOwnedCardEntries(username) {
  return player.getInventory(username)
    .filter(({ quantity }) => Number(quantity) > 0)
    .map(({ cardId, quantity }) => ({
      cardId,
      quantity,
      card: cards.getCard(cardId),
    }))
    .filter(entry => entry.card);
}

function renderProfileSummary(p) {
  document.getElementById('profile-username').textContent = p.username;
  const groupEl = document.getElementById('profile-group');
  const groupName = p.group ? groups.getGroupName(p.group) : null;
  if (groupName) {
    groupEl.textContent = groupName;
    groupEl.style.display = '';
  } else {
    groupEl.textContent = '';
    groupEl.style.display = 'none';
  }

  const stats = p.stats || {};
  const researchStats = p.researchStats || {};
  const totalRP = typeof p.totalResearchPoints === 'number' ? p.totalResearchPoints : 0;
  const spendableRP = typeof p.currencies?.currentResearchPoints === 'number'
    ? p.currencies.currentResearchPoints
    : 0;
  const projectsCompleted = p.projectsCompleted || researchStats.successfulProjects || 0;
  const tradesCompleted = stats.tradesCompleted || 0;
  document.getElementById('profile-stats').innerHTML = `
    <div class="stat-card"><div class="stat-value">${escapeHtml(totalRP)}</div><div class="stat-label">Lifetime RP</div></div>
    <div class="stat-card"><div class="stat-value">${escapeHtml(spendableRP)}</div><div class="stat-label">Spendable RP</div></div>
    <div class="stat-card"><div class="stat-value">${escapeHtml(projectsCompleted)}</div><div class="stat-label">Projects Completed</div></div>
    <div class="stat-card"><div class="stat-value">${escapeHtml(tradesCompleted)}</div><div class="stat-label">Trades Completed</div></div>
  `;
}

function renderEquippedIdentity(p) {
  const container = document.getElementById('profile-identity');
  if (!container) return;

  const categories = [
    ITEM_CATEGORIES.AURA,
    ITEM_CATEGORIES.BORDER,
    ITEM_CATEGORIES.PROFILE_BANNER,
    ITEM_CATEGORIES.TITLE,
  ];
  const rows = categories.map(category => {
    const itemId = getEquippedItemId(p, category);
    const definition = itemId ? ITEM_DEFINITIONS[itemId] : null;
    const validEquipped = definition?.type === ITEM_TYPES.COSMETIC &&
      definition.category === category &&
      getOwnedCosmetics(p)[itemId] === true;
    return `
      <div class="profile-identity-card">
        <div>
          <div class="profile-section-kicker">${escapeHtml(EQUIPPED_LABELS[category])}</div>
          <div class="profile-card-title">${validEquipped ? escapeHtml(definition.name || itemId) : 'None equipped'}</div>
          <div class="profile-card-meta">${validEquipped ? escapeHtml(formatLabel(definition.rarity, 'Cosmetic')) : 'No active cosmetic'}</div>
        </div>
        <button class="profile-btn" data-profile-action="unequip-cosmetic" data-category="${escapeHtml(category)}" ${validEquipped ? '' : 'disabled'}>Unequip</button>
      </div>
    `;
  }).join('');

  const hasEquipped = categories.some(category => Boolean(getEquippedItemId(p, category)));
  container.innerHTML = `
    <section class="profile-panel">
      <div class="profile-panel-header">
        <h3>Currently Equipped</h3>
        <span>${hasEquipped ? 'Canonical profile runtime state' : 'No equipped cosmetics'}</span>
      </div>
      <div class="profile-identity-grid">${rows}</div>
    </section>
  `;
}

function renderConsumables(p) {
  const container = document.getElementById('profile-inventory');
  if (!container) return;

  const entries = getOwnedConsumableEntries(p);
  const chips = entries.length === 0
    ? '<p class="profile-consumables-empty">None owned</p>'
    : entries.map(({ itemId, quantity, definition }) => {
      const visual = resolveItemDisplay(definition);
      const iconClass = visual.cssClass ? ` ${visual.cssClass}` : '';
      const title = escapeHtml(definition?.description || definition?.name || itemId);
      const name = escapeHtml(definition?.name || itemId);
      return `
        <div class="profile-consumable-chip${iconClass}" title="${title}">
          <span class="profile-consumable-icon" aria-hidden="true">${escapeHtml(visual.emoji)}</span>
          <span class="profile-consumable-label">${name}</span>
          <span class="profile-consumable-qty">×${escapeHtml(quantity)}</span>
        </div>
      `;
    }).join('');

  container.innerHTML = `
    <section class="profile-consumables-panel">
      <header class="profile-consumables-panel-header">
        <h3>Consumables</h3>
        <span class="profile-consumables-hint">Use in Shop</span>
      </header>
      <div class="profile-consumables-chips">${chips}</div>
    </section>
  `;
}

function renderCosmetics(p) {
  const container = document.getElementById('profile-cosmetics');
  if (!container) return;

  const entries = getOwnedCosmeticEntries(p);
  if (entries.length === 0) {
    container.innerHTML = `
      <section class="profile-panel">
        <div class="profile-panel-header"><h3>Cosmetics</h3><span>Owned cosmetics only</span></div>
        <div class="profile-empty-state">No cosmetics owned.</div>
      </section>
    `;
    return;
  }

  const groupsByCategory = new Map();
  for (const entry of entries) {
    const key = isKnownEquippableCategory(entry.definition.category)
      ? entry.definition.category
      : 'other';
    if (!groupsByCategory.has(key)) groupsByCategory.set(key, []);
    groupsByCategory.get(key).push(entry);
  }

  const categoryOrder = [
    ITEM_CATEGORIES.AURA,
    ITEM_CATEGORIES.BORDER,
    ITEM_CATEGORIES.PROFILE_BANNER,
    ITEM_CATEGORIES.TITLE,
    'other',
  ];

  const sections = categoryOrder
    .filter(category => groupsByCategory.has(category))
    .map(category => {
      const label = category === 'other' ? 'Other Cosmetics' : `${EQUIPPED_LABELS[category] || formatLabel(category)}s`;
      const items = groupsByCategory.get(category).map(({ itemId, definition }) => {
        const equipped = getEquippedItemId(p, definition.category) === itemId;
        const equippable = isKnownEquippableCategory(definition.category);
        return `
          <article class="profile-item-card ${equipped ? 'is-equipped' : ''}">
            <div class="profile-card-topline">
              <span>${escapeHtml(formatLabel(definition.rarity, 'Cosmetic'))}</span>
              <span>${escapeHtml(formatLabel(definition.category, 'Cosmetic'))}</span>
            </div>
            <h4 class="profile-card-title">${escapeHtml(definition.name || itemId)}</h4>
            <p class="profile-card-description">${escapeHtml(definition.description || 'No description available.')}</p>
            <div class="profile-card-actions">
              ${equipped ? '<span class="profile-state-pill">Equipped</span>' : ''}
              <button class="profile-btn profile-btn-primary" data-profile-action="equip-cosmetic" data-cosmetic-id="${escapeHtml(itemId)}" ${equippable && !equipped ? '' : 'disabled'}>Equip</button>
              <button class="profile-btn" data-profile-action="unequip-cosmetic" data-category="${escapeHtml(definition.category)}" ${equipped ? '' : 'disabled'}>Unequip</button>
            </div>
          </article>
        `;
      }).join('');
      return `
        <div class="profile-cosmetic-group">
          <h4>${escapeHtml(label)}</h4>
          <div class="profile-item-grid">${items}</div>
        </div>
      `;
    }).join('');

  container.innerHTML = `
    <section class="profile-panel">
      <div class="profile-panel-header">
        <h3>Cosmetics</h3>
        <span>Owned cosmetics grouped by category</span>
      </div>
      ${sections}
    </section>
  `;
}

function renderFeaturedCards(p, username) {
  const container = document.getElementById('profile-featured-cards');
  if (!container) return;

  const featuredIds = Array.isArray(p.profile?.featuredCards)
    ? p.profile.featuredCards.slice(0, PROFILE_FEATURED_CARD_LIMIT)
    : [];
  const featuredSet = new Set(featuredIds);
  const ownedCards = getOwnedCardEntries(username);

  const featured = featuredIds
    .map(cardId => ({ cardId, card: cards.getCard(cardId) }))
    .filter(entry => entry.card);

  const featuredContent = featured.length === 0
    ? '<div class="profile-empty-state">No featured cards selected.</div>'
    : `<div class="profile-featured-list">${featured.map(({ cardId, card }) => `
        <article class="profile-featured-card">
          <div>
            <div class="profile-card-title">${escapeHtml(card.name || cardId)}</div>
            <div class="profile-card-meta">${escapeHtml(formatLabel(card.rarity))} · ${escapeHtml(formatLabel(card.type))}</div>
          </div>
          <button class="profile-btn" data-profile-action="unfeature-card" data-card-id="${escapeHtml(cardId)}">Remove</button>
        </article>
      `).join('')}</div>`;

  const canFeatureMore = featuredIds.length < PROFILE_FEATURED_CARD_LIMIT;
  const ownedContent = ownedCards.length === 0
    ? '<div class="profile-empty-state">No owned cards available to feature.</div>'
    : `<div class="profile-feature-options">${ownedCards.map(({ cardId, quantity, card }) => {
        const alreadyFeatured = featuredSet.has(cardId);
        return `
          <article class="profile-feature-option">
            <div>
              <div class="profile-card-title">${escapeHtml(card.name || cardId)}</div>
              <div class="profile-card-meta">${escapeHtml(formatLabel(card.rarity))} · Qty ${escapeHtml(quantity)}</div>
            </div>
            <button class="profile-btn profile-btn-primary" data-profile-action="feature-card" data-card-id="${escapeHtml(cardId)}" ${!alreadyFeatured && canFeatureMore ? '' : 'disabled'}>
              ${alreadyFeatured ? 'Featured' : 'Feature'}
            </button>
          </article>
        `;
      }).join('')}</div>`;

  container.innerHTML = `
    <section class="profile-panel">
      <div class="profile-panel-header">
        <h3>Featured Cards</h3>
        <span>${featuredIds.length}/${PROFILE_FEATURED_CARD_LIMIT} selected</span>
      </div>
      ${featuredContent}
      <h4 class="profile-subheading">Owned Cards</h4>
      ${ownedContent}
    </section>
  `;
}

function renderCollectionProgress(username) {
  const inventory = player.getInventory(username);
  const allCardsList = cards.getEnabledCards();
  const ownedIds = new Set(inventory.map(i => i.cardId));

  const progressHTML = cards.RARITIES.map(rarity => {
    const total = allCardsList.filter(c => c.rarity === rarity).length;
    const owned = allCardsList.filter(c => c.rarity === rarity && ownedIds.has(c.id)).length;
    const pct = total > 0 ? Math.round((owned / total) * 100) : 0;
    return `
      <div>
        <div class="flex justify-between text-sm mb-1">
          <span class="capitalize" style="color:${cards.RARITY_COLORS[rarity]}">${escapeHtml(rarity)}</span>
          <span class="text-surface-400">${escapeHtml(owned)}/${escapeHtml(total)}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${pct}%;background:${cards.RARITY_COLORS[rarity]}"></div>
        </div>
      </div>
    `;
  }).join('');
  document.getElementById('profile-progress').innerHTML = progressHTML;
}

function renderAchievementsPlaceholder() {
  const container = document.getElementById('profile-achievements-placeholder');
  if (!container) return;
  container.innerHTML = `
    <section class="profile-panel profile-panel-muted">
      <div class="profile-panel-header">
        <h3>Achievements</h3>
        <span>Coming later</span>
      </div>
      <div class="profile-empty-state">Achievement systems are not active yet.</div>
    </section>
  `;
}

function wireProfileActions(username) {
  const containers = [
    document.getElementById('profile-identity'),
    document.getElementById('profile-cosmetics'),
    document.getElementById('profile-featured-cards'),
  ].filter(Boolean);

  for (const container of containers) {
    container.onclick = event => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const button = target?.closest('[data-profile-action]');
      if (!button) return;
      handleProfileAction(username, button);
    };
  }
}

function handleProfileAction(username, button) {
  const action = button.dataset.profileAction;
  let result = null;

  if (action === 'equip-cosmetic') {
    result = equipCosmetic(username, button.dataset.cosmeticId);
    if (result.success) toast.success('Cosmetic equipped.');
  } else if (action === 'unequip-cosmetic') {
    result = unequipCosmetic(username, button.dataset.category);
    if (result.success) toast.success('Cosmetic unequipped.');
  } else if (action === 'feature-card') {
    result = featureCard(username, button.dataset.cardId);
    if (result.success) toast.success('Card featured.');
  } else if (action === 'unfeature-card') {
    result = unfeatureCard(username, button.dataset.cardId);
    if (result.success) toast.success('Card removed from featured cards.');
  }

  if (result && !result.success) {
    toast.error(getReasonMessage(result.reason));
  }
  renderProfile();
}

export function renderProfile() {
  const session = auth.getSession();
  if (!session || session.username === '__admin__') return;

  const p = player.getPlayer(session.username);
  if (!p) return;

  renderProfileSummary(p);
  renderEquippedIdentity(p);
  renderConsumables(p);
  renderCosmetics(p);
  renderFeaturedCards(p, session.username);
  renderCollectionProgress(session.username);
  renderAchievementsPlaceholder();
  wireProfileActions(session.username);
}
