## SciCards Architecture

### File Map
```
index.html           - Single-page app shell, all screens/modals, Firebase SDK CDN scripts
style.css            - Custom styles (cards, tabs, toasts, animations)
main.js              - Entry point, async init sequence (DB → Auth → Config → Seed → UI)
FIREBASE_SETUP.md    - Firebase setup instructions, security rules, config example
js/
  firebase-config.js - Firebase App/DB initialization (RTDB only, no Firebase Auth)
  database.js        - Firebase RTDB + in-memory cache (sync API, async Firebase writes)
  config.js          - Centralized live config (reads from /config DB node)
  auth.js            - Username/password auth via RTDB (SHA-256 hashed passwords, no Firebase Auth)
  admin.js           - Admin foundation: isAdmin(username), getPlayer, setPlayerData, listPlayers
  player.js          - Player CRUD, inventory, packs, stats
  cards.js           - Card DB, CRUD, seed data (40 starter science cards), Phase 3 schema
  packs.js           - Pack types, weighted rarity rolling, pack opening
  groups.js          - Group/subgroup hierarchy
  ui.js              - All DOM rendering, event wiring, screen management
  shell-theme.js     - Application shell theme hooks (data-* attrs, title mount, identity accent); no cosmetic visuals
  toast.js           - Toast notification utility
  research.js        - Research Points (RP) infrastructure: schema, migration, helpers, leaderboard queries
  trading.js         - Phase T-1 validation helpers (pure) + Phase T-2 direct trade lifecycle (create/accept/decline/cancel/getPending) + T-4 migration
  trade-execution.js - Atomic direct-trade swap helper: executeDirectTrade(), cooldown read/format helpers
  trade-listings.js  - Phase T-4 listing lifecycle: createListing, cancelListing, acceptListing, getVisibleListings, getMyActiveListing (deprecated), getMyActiveListings, getMaxActiveListingsPerPlayer, expireStaleListings, getListingCooldown
  trade-listing-execution.js - Atomic listing-trade swap helper: executeListingTrade() — isolated, same architecture as trade-execution.js
  trade-confirm-modal.js - Sandbox-safe confirmation modal (showTradeConfirmModal), replaces native confirm() blocked by iframe sandbox
  trade-ui.js        - Trading tab UI: sub-tabs (Direct Trades / Trade Listings), player picker, card selectors, incoming/outgoing trade panels, listing create/cancel/accept, cooldown display
  quest-config.js    - Research Project config: DEFAULT_QUEST_CONFIG, AURA_SCALING, Firebase mirror (config/quests), cached getter, getCardPowerContribution()
  quests.js          - Research Projects module entry: loads quest-config on init, re-exports power helper, placeholder lifecycle
  achievements.js           - Public facade: bumpPlayerStat, record* hooks, login eval, claim; gameplay must never unlock directly
  achievement-config.js     - Admin definitions at config/achievements (meta kill-switch, CRUD)
  achievement-stats.js      - Stat registry, additive writes, project streak + best-streak high-water
  achievement-engine.js     - Pure eval (simple stat/op/value), stat-indexed achievement lookup
  achievement-mutations.js  - Unlock/progress persistence, stat-scoped + login evaluation, claim
  achievement-rewards.js    - Grants via addResearchPoints, grantConsumable, unlockCosmetic, addPack only
  achievement-validation.js - Definition/reward validation, claim guards
  achievements-ui.js        - Profile-embedded achievements panel (hidden locked omitted; Show 5/10/All)
  achievements-admin.js     - Admin CRUD for achievement definitions
  seasonal.js        - PLACEHOLDER
  player-schema.js   - Expanded player persistence schema: defaults, normalization, migration (currencies, cosmetics, items, shopUsage, shop, purchaseHistory, profileCustomization, profile identity, profileVisibility)
  shop-state.js      - Phase 2B pure shop persistence schema helpers: shop state, current rotation, slot, discount structures
  shop-config.js     - Shop economy defaults, merge helpers, built-in reroll resolution, independent slot-cap fallbacks
  shop-catalog.js    - Assembles static + rarity-driven card + pack shop entries into one item-like generation pool
  shop-generation.js - Phase 3 pure weighted shop generation engine: ownership filtering, slot planning, scoped reroll helpers
  shop-validation.js - Shop validation guards: purchases, rerolls, freezing, consumables, discounts, project proposal eligibility, profile identity
  shop-mutations.js  - Canonical shop economy mutation layer: purchases, RP, item stacks, cosmetics, history, refresh/rerolls/freezing, profile identity
  shop-consumables.js - BehaviorType-routed consumable execution layer; no item-specific gameplay logic
  shop-ui.js         - Thin player-facing shop tab renderer; delegates actions to canonical shop mutations
  shop-admin.js      - Additive admin Shop tools: config and item override UI wrappers
  admin-player-tools.js - Canonical admin wrappers for RP grants, shop item/cosmetic grants, and project completion shortcuts
  profile-ui.js      - Profile rendering plus lightweight profile identity runtime helpers
```

### DB Schema (database.js nodes → Firebase RTDB paths)
- `/config` - gameOpen, registrationOpen, adminPassword, packOdds, economy{packsPerDay, tradeCooldownMinutes, maxInventorySize, **directTradeCooldownMinutes**}, progression, seasonal, **quests{...}**, **projectBalance{...}**, **shop{shopRefreshDays,shopSlotCount,rerollCosts,itemOverrides{...}}**, **achievements{meta{enabled,version},definitions{id→{enabled,hidden,name,description,category,sortOrder,rarity,icon,conditions[],conditionMode,rewards[],notifyOnUnlock}}}**
- `/players/{username}` - username, password (SHA-256 hash), createdAt, xp, level, isAdmin, **isTradeRestricted**, **isTradeProfileHidden**, group, subgroup, inventory{cardId:qty}, packs{packId:qty}, stats, badges, achievements, progression, lastLogin, **researchPoints, seasonalResearchPoints, researchStats{...}**, **lastDirectTradeAt**, **lastListingCreatedAt**, **currencies{currentResearchPoints}**, **cosmetics{owned{...}, equipped{aura,border,title,profileBanner}}**, **items{reroll_token,cosmetic_reroll_token,aura_reroll_token,border_reroll_token,discount_chip,freeze_token,research_proposal}**, **shopUsage{rerollsUsedThisRotation,frozenSlotsUsedThisRotation,extraFreezeAllowanceThisRotation}**, **shop{currentRotation{slots[{id,itemId,basePrice,currentPrice,currency,frozen,purchased,discountApplied}],generatedAt,refreshAt,generationVersion},rerollResetAt}**, **projects[]**, **lastProjectRefreshAt**, **purchaseHistory[{itemId,purchasedAt,pricePaid,currency,source}]** (max 10), **profile{equippedAura,equippedBorder,equippedBanner,equippedTitle,featuredCards[],featuredAchievements[]}**, **profileCustomization{featuredCards[],featuredAchievements[]}**, **profileVisibility{isProfileHidden,isCollectionHidden}**
- `/trades/direct/{tradeId}` - id, offeringPlayerId, targetPlayerId, offeredCardId, requestedCardId, status(pending|processing|accepted|declined|cancelled|failed), createdAt, respondedAt, failureReason?
- `/trades/listings/{listingId}` - id, ownerId, offeredCardId, requestedCardIds[], groupId, status(active|processing|fulfilled|cancelled|expired|failed), createdAt, expiresAt, respondedAt?, fulfilledBy?, fulfilledCardId?, failureReason?
- `/cards/{cardId}` - id, name, rarity, type, field, effect, image, flavor, created, **imageUrl, keyFact, auraType, enabled**, conceptType (concept cards only)
- `/packs/{packId}` - id, name, cardsPerPack, odds{rarity:pct}, enabled
- `/groups/{groupId}` - id, name, parent
- `/accessCodes/{CODE}` - created, used, usedBy, usedAt, group

### Phase 3 Card Schema
- **Legacy fields** preserved: `type`, `effect`, `image`, `flavor` — still read/written for backward compat
- **New Phase 3 fields**: `imageUrl` (= image), `keyFact` (= flavor), `auraType` (none|holographic|prismatic|shadow|radiant|cosmic), `enabled` (bool)
- **Phase 1D**: `auraType` is now a **legacy DB field** — no longer admin-controlled or read by the render pipeline. Visual aura for all cards is resolved via `resolveVisualAura()` → `DEFAULT_VISUAL_AURA` (`'default_prismatic'`). The field is preserved in the DB for backward compat and potential future migration.
- `auraLevel` removed from card schema — aura tier is derived from player duplicate count at render time
- `normalizeCard()` in cards.js ensures all fields present with safe defaults; falls back legacy→new
- `createCard()` and `updateCard()` both keep legacy+new fields in sync
- `getEnabledCards()` filters by `enabled !== false`
- `getAllFields()` returns unique field/category values across all cards

### Concept Type System
- `VALID_CONCEPT_TYPES` in cards.js: array of `{label, value}` — the canonical list of allowed conceptType values
- `isValidConceptType(value)` — validation helper
- `normalizeConceptTypes()` — called at startup in main.js, scans all concept cards and fixes malformed conceptType values (logs `[ResearchProjects] Invalid conceptType normalized`)
- `normalizeCard()` handles conceptType for concept cards, defaults to `researchBoost`
- Admin card editor (create + edit) shows a controlled dropdown for conceptType when type=concept; hidden for scientist cards
- Dropdown displays friendly labels (e.g. "Research Amplifier") but stores only internal values (e.g. "researchBoost")
- Save validation in ui.js prevents saving concept cards with invalid conceptType

### Research Points System (js/research.js)
- **Schema fields** on every player: `researchPoints` (lifetime), `seasonalResearchPoints` (resettable), `researchStats` object (totalProjects, successfulProjects, failedProjects, breakthroughs, highestTierCompleted)
- **Migration**: `migrateAllPlayersRP()` called at startup (step 4c in main.js) — auto-adds missing fields to existing players, never overwrites valid data, never resets inventories
- **Helpers**: `getResearchPoints(username)`, `addResearchPoints(username, amount)`, `addSeasonalResearchPoints(username, amount)`
- **Leaderboard queries** (data only, no UI): `getTopResearchPlayers(limit)`, `getTopSeasonalResearchPlayers(limit)` — descending sort, stable tiebreaker by username
- **Admin reset**: `resetSeasonalResearchPoints()` — zeroes only `seasonalResearchPoints` across all players, preserves everything else
- **Console diagnostics**: `[Research] Player RP initialized`, `[Research] Seasonal RP reset`, `[Research] RP migration complete`
- No quests, UI, timers, or rewards — pure infrastructure for future systems

### Research Project Config System (js/quest-config.js)
- **Stabilization cleanup applied** — aura scaling normalized, rarity power restored, durations updated, concept safeguards active
- **AURA_SCALING** (frozen): level-based {0:0, 1:0.10, 2:0.20, 3:0.30} — aura TYPE is cosmetic only, all 5 types scale identically
- **AURA_TYPES_COSMETIC**: holographic, prismatic, shadow, radiant, cosmic — visual only, no gameplay difference
- **DEFAULT_QUEST_CONFIG** (frozen): rarityPower{common:10..legendary:30}, auraScaling, rpRewards, unlockThresholds, researchProjectDurations{rarity:[minHrs,maxHrs]}, successCurve, conceptEffects, cardTypeRules{scientist:'power',concept:'modifier'}
- **getCardPowerContribution(card, auraLevel, configOverride)**: returns power for scientist cards (rarity×aura bonus), returns 0 for concept cards — enforces concept-never-power rule
- **Firebase mirror**: `config/quests` — admin Config editor auto-renders these fields; remote values override defaults
- **loadQuestConfig()**: reads `config/quests` from DB, deep-merges with DEFAULT_QUEST_CONFIG to fill missing keys, caches result; never throws
- **getQuestConfig()**: returns cached config or auto-loads; never returns null
- **seedQuestConfigToFirebase()**: writes DEFAULT_QUEST_CONFIG to `config/quests` (admin reset)
- **Fallback**: if Firebase read fails or returns empty, falls back to DEFAULT_QUEST_CONFIG silently
- **Console diagnostics**: `[ResearchProjects] Config loaded`, `[ResearchProjects] Firebase config loaded`, `[ResearchProjects] Using default config fallback`, plus stabilization logs
- quests.js `initQuests()` calls `loadQuestConfig()` wrapped in try/catch — never crashes startup
- quests.js re-exports `getCardPowerContribution` for convenience
- No project generation, timers, UI, rewards, or card assignment — pure config foundation
- Internal file names (quest-config.js, quests.js) preserved to avoid risky import-path renaming; user-facing references use "Research Project"

### Project Balance Config (js/project-config.js) — Phase 6A-1
- **Single source of truth** for all project balance values used by project-engine.js and project-generator.js
- **DB path**: `config/projectBalance` — persisted via `db.set()`, loaded with `db.get()`, merged over defaults
- **Exported**: `getProjectConfig()` (cached getter, never null), `saveProjectConfig(cfg)` (writes to DB, invalidates cache), `seedProjectConfigDefaults()` (admin reset), `invalidateProjectConfigCache()`
- **PROJECT_CONFIG** proxy export: backward-compat for `import { PROJECT_CONFIG }` in project-engine.js — transparently reads from DB-backed cache
- **Values exposed**: `projectRefreshHours` (default 12), rarityPower (per rarity), auraScaling (levels 0–3), successCurve (exponent, min, max), projectDifficulty (per rarity [min, max]), rpRewards (per rarity {success: [min, max], failure: [min, max]}), projectDurations (per rarity [min, max]), conceptEffects (per type per rarity)
- **project-generator.js** now imports `getProjectConfig()` instead of hardcoded constants for difficulty, rewards, and durations
- **Admin Balance tab** (`renderAdminBalance()` in ui.js): numeric input editor for 8 subsections (Project Refresh Cadence, Scientist Power, Aura Scaling, Success Curve, Project Difficulty, RP Rewards, Project Duration, Concept Modifiers). Save button writes via `saveProjectConfig()`. Reset button restores defaults via `seedProjectConfigDefaults()` with confirmation modal.
- **Concept Modifiers subsection** (Phase 6A-2, corrected in Concept Identity Fix): Exposes all `conceptEffects` values grouped by concept type. Each concept has a single non-overlapping role:
  - **Research Amplifier** (researchBoost): `rewardRPPercent` — % increase to reward RP (aura-scaled). No difficulty effect.
  - **Complexity Reducer** (difficultyReduction): `difficulty` — flat reduction to difficulty (NOT aura-scaled). No reward/power effect.
  - **Synergy Booster** (synergyBoost): `teamPowerPercent` — % increase to team power (aura-scaled). No reward/difficulty effect.
  - **Breakthrough Catalyst** (breakthrough): `breakthroughChance` — flat addition (aura-scaled). Unchanged.
  - **Risk Enhancer** (risk): `rewardRPPercent` (aura-scaled) + `difficultyPercent` (NOT aura-scaled). No failurePenalty.
  - All % modifiers apply proportionally against base values in a single pass (no recursive scaling).
  - `failurePenalty` has been fully removed from config, engine state, and admin UI.
  - DOM IDs: `bal-ce-{type}-{rarity}-{prop}`. Collected in `collectBalanceValues()` and saved to the same `config/projectBalance.conceptEffects` path consumed by `project-engine.js`.
- **Firebase arrays note**: Firebase stores arrays as objects {0: val, 1: val}. The balance editor handles both array and object forms when reading values.

### Project Refresh & Capacity (js/project-refresh.js) — Phase 6A-1B
- **Cap counting corrected**: Only AVAILABLE + ACTIVE projects count toward the 7-project cap. COMPLETE and CLAIMED do NOT count. Fix applied in `project-pool.js` (`countCapProjects()` filter) which feeds `shouldGenerateProjects()` and `getAvailableProjectSlots()`.
- **Configurable refresh cadence**: `projectRefreshHours` (default 12) lives in `project-config.js` defaults and is persisted at `config/projectBalance`. `getProjectRefreshHours()` and `getProjectRefreshIntervalMs()` in `project-refresh.js` read from the DB-backed config instead of a hardcoded constant.
- **Player-facing status bar**: `_renderProjectStatusBar()` in ui.js renders a compact telemetry line above the project list: "Projects: X / 7 Active · Next refresh: Xh Xm". Timer updates live every 30s via `setInterval`.
- **Admin telemetry**: Persistent admin accounts additionally see "Refresh interval: Xh" in the status bar. `__admin__` standalone sessions do not reach the research projects tab (unchanged behavior).
- **Admin Balance editor**: "Project Refresh Cadence" section added as the first subsection, with `bal-refresh-hours` input. Collected and persisted via `collectBalanceValues()` → `saveProjectConfig()`.

### Aura Tier System (Phase 3 + Phase 1D Normalization)
- `getAuraTier(rarity, quantity)` in cards.js computes tier 0–3 from duplicate ownership count
- Thresholds per rarity: legendary [1,2,3], epic [1,3,5], rare [2,4,6], uncommon [2,5,8], common [3,7,10]
- **Phase 1D**: ALL cards now always render with a default visual aura (`DEFAULT_VISUAL_AURA = 'default_prismatic'` in cards.js)
- Legacy per-card `auraType` field preserved in DB for backward compat but **no longer read by the render pipeline** — visual aura is resolved via `resolveVisualAura(profileCosmeticOverride)` which currently always returns `'default_prismatic'`
- **Admin aura controls removed**: `new-card-auraType` selector, `edit-card-auraType` selector, aura label in admin card list — all removed
- `AURA_CSS_MAP` in cards.js maps visual aura identifiers to CSS class suffixes (e.g. `default_prismatic → prismatic`)
- `getAuraCSSClass(visualAura)` returns the full CSS class name (e.g. `aura-prismatic`)
- **Future profile cosmetics**: `resolveVisualAura()` accepts a profile cosmetic override parameter (holographic, radiant, shadow, cosmic) — not yet wired to any profile data
- Tier 0 = no aura visible; tiers 1–3 = subtle → noticeable glow via CSS `::before`/`::after` pseudo-elements
- Aura dots shown on card corners when tier > 0; detail modal always shows pip bar + next-tier hint
- **Gameplay aura scaling** (project-engine.js, quest-config.js, project-config.js) is **unchanged** — `auraLevel` on enriched card objects still drives gameplay math via `config.auraScaling[level]`

### Player-Facing Card Renderer (Phase 3 + normalization Phase 1)
- **Canonical module**: `js/card-render.js` — `buildCardRenderModel()`, `renderCardContent()`, `renderSciCard()` (collection), `renderDetailFrame()`, `renderCardDetailView()` (modal), `renderPackCardWrapper()` / `variant: 'pack-reveal'` (pack + breakthrough). **FX module**: `js/pack-reveal-effects.js` (`spawnRevealParticles`). Inert `.card-cosmetic-effects` host (Phase 3). **Overflow contract**: `.sci-card` `overflow: visible`; inner clips at `z-index: 2`. Pack reveals: `data-aura-tier="0"`, no duplicate-tier aura class.
- **Phase A geometry**: `.card-detail-inner` uses CSS Grid (`12fr / 55fr / 2px / 31fr` rows, art `minmax(32px,…)`). Concept label inside `.card-detail-header`. Art `object-position: center top`. Shell `container-type: size`.
- **Phase B typography**: `clamp()` + `cqw`/`cqh` on `.sci-card` / `.card-detail-frame` descendants; removed duplicate `.sci-card` font-size overrides; emoji via `.card-detail-art-emoji`. `@supports not (container-type: size)` retains legacy rem fallback.
- **Unified card structure**: collection grid, pack opening, and detail modal all share the same `card-detail-*` internal HTML (header → art → divider → body). The modal proportions are the visual reference standard.
- **Collection grid**: `renderPlayerCard()` → `card-render.js` wraps `card-detail-*` internals in a `.sci-card` shell (5:7 aspect ratio, rarity borders, aura visuals, click behavior). CSS overrides (`.sci-card .card-detail-*`) scale down font sizes and padding for grid context. keyFact text uses `.grid-clamp` class for line-clamping.
- **Pack opening**: `renderPackCardWrapper()` — flip shell + canonical `renderPackRevealSciCard()` (`pack-reveal` variant, tier 0)
- **Detail modal**: `renderCardDetailView()` — `.card-detail-asset` (frame only, 240px max) + `.card-detail-meta` below (aura pips, helper text, concept flavor, ownership). Card body excludes supplemental metadata.
- **Pack/breakthrough reveal**: `.pack-opening-cards` grid prefers ~220px (`13.75rem`) per card, shrinks via `auto-fit` + `minmax` on narrow viewports.
- **Disabled cards**: filtered out of player collection, pack stats, and profile progress
- Admin card list/rendering is unchanged (still uses legacy `.card-item` styles)

### Trading System (Phase T-1 + T-2 + T-3 + T-4 + T-6)
- **Seven modules**: `trading.js` (validation + direct lifecycle), `trade-execution.js` (direct atomic swap), `trade-listings.js` (listing lifecycle), `trade-listing-execution.js` (listing atomic swap), `trade-lock-helpers.js` (project-lock helpers), `trade-confirm-modal.js` (sandbox-safe confirmation modal), `trade-ui.js` (UI rendering)
- **DB structure**: `/trades/direct/{tradeId}` for direct trades, `/trades/listings/{listingId}` for anonymous listings. Migration from flat `/trades/{tradeId}` happens automatically on init.
- **Phase T-1 — Pure Validation**: `validateDirectTrade()` and `validateListingTrade()` are fully pure (no DB writes, no side effects, no inventory mutation). Both take explicit data params and return `{ valid, reason }`. Safe to call repeatedly, including immediately before trade completion.
  - `validateListingTrade()` accepts `listing` object with `requestedCardIds` (1–3 array) + `chosenCardId` (the specific card the accepter provides)
- **Phase T-2 — Direct Trade Lifecycle**:
  - `createTradeOffer(offering, target, offeredCard, requestedCard)` — cooldown check → fresh DB load → T-1 validation → duplicate check → write trade record to `/trades/direct/{id}`
  - `acceptTrade(tradeId, acceptingPlayerId)` — status/target guard → cooldown check → delegates to `executeDirectTrade()`
  - `declineTrade(tradeId, decliningPlayerId)` / `cancelTrade(tradeId, cancellingPlayerId)` — status guards → mark declined/cancelled
  - `getPendingTrades(username)` — returns `{ incoming, outgoing }` sorted newest-first
- **Atomic Direct Execution** (`trade-execution.js`):
  - `executeDirectTrade(trade)` — the ONLY function that mutates inventories for direct trades
  - Flow: reload fresh players → reload cards → rerun T-1 validation → check BOTH cooldowns → compute new inventories (no writes yet) → write ALL mutations together (inventories, stats, cooldowns, progression, trade status)
  - Zero-quantity cleanup: entries with qty ≤ 0 are deleted from inventory objects
  - On validation failure: trade marked as `failed` with `failureReason` in DB, no inventory mutation occurs
- **Phase T-4 — Anonymous Trade Listings** (`trade-listings.js` + `trade-listing-execution.js`):
  - `createListing(ownerId, offeredCardId, requestedCardIds)` — max `economy.maxActiveListingsPerPlayer` active listings per player (config-driven, default 1), 1–3 requestedCardIds, all same rarity as offered, group-scoped, cooldown check
  - `cancelListing(listingId, playerId)` — cancellation does NOT remove posting cooldown
  - `acceptListing(listingId, accepterId, chosenCardId)` — delegates to `executeListingTrade()`
  - `getVisibleListings(username)` — returns active listings in player's group, sorted newest-first
  - `getMyActiveListing(username)` — @deprecated, returns first active listing or null (wraps getMyActiveListings)
  - `getMyActiveListings(username)` — returns ALL active listings owned by player, sorted newest-first
  - `getMaxActiveListingsPerPlayer()` — exported config accessor for UI
  - `expireStaleListings()` — scans all active listings, expires any past their `expiresAt`, called on tab render
  - `getListingCooldown(username)` — separate cooldown (`lastListingCreatedAt`, configurable `economy.listingCooldownMinutes` default 30)
  - Listing status lifecycle: `active → fulfilled|cancelled|expired|failed`
  - Listing schema: `{ id, ownerId, offeredCardId, requestedCardIds[], createdAt, expiresAt, groupId, status, respondedAt?, fulfilledBy?, fulfilledCardId?, failureReason? }`
  - Anonymous: UI never displays ownerId to other players
  - Hidden players MAY create and accept listings
- **Atomic Listing Execution** (`trade-listing-execution.js`):
  - `executeListingTrade(listing, accepterId, chosenCardId)` — the ONLY function that mutates inventories for listing trades
  - Same architecture as `executeDirectTrade()`: concurrency guard → reload fresh state → rerun validation → check cooldowns → compute inventories → write all mutations → mark fulfilled
  - Both owner and accepter get `lastDirectTradeAt` cooldown applied (shared trade cooldown)
- **Cooldowns**:
  - `getDirectTradeCooldown(username)` — shared by direct trades and listing acceptance. Configurable via `config.economy.directTradeCooldownMinutes` (default 30).
  - `getListingCooldown(username)` — separate cooldown for creating listings. Configurable via `config.economy.listingCooldownMinutes` (default 30). Uses `players/{username}/lastListingCreatedAt`.
  - Listing expiration: `config.economy.listingExpirationHours` (default 24).
- **Trade UI** (`trade-ui.js`):
  - `renderTrading()` — entry point called by ui.js when Trading tab activates; resets reactive hashes on call
  - `cleanupTrading()` — clears cooldown interval when leaving tab
  - **Sub-tabs**: "🤝 Direct Trades" and "📋 Trade Listings" toggle between views
  - **Direct sub-tab**: cooldown banner, incoming trades (`data-section="incoming-trades"` attr for targeted refresh), outgoing trades (cancel), new trade form (player picker → card selectors → rarity warning → confirmation preview → send)
  - **Listings sub-tab**: listing cooldown banner, "My Listings (n/max)" section (all owned listings + create form when below max), "Available Listings" section (`id="available-listings-section"`, anonymous, group-scoped)
  - Create listing form: offered card dropdown → dynamic checkbox list (same-rarity cards, max 3) → "Post Listing" button
  - Available listings show offered card + requested cards (with ✓ for owned cards, strikethrough for unowned), "Trade: Give {card}" buttons for each fulfillable card
  - Player picker filters to same-group, non-restricted, non-hidden players
  - **Lightweight reactive refresh helpers** (Phase T-8.5A):
    - `refreshTradeCooldownBanners(username?)` — updates direct-trade cooldown banner/timer only
    - `refreshListingCooldownBanners(username?)` — updates listing-post + listing-accept banners/timers only
    - `refreshIncomingTradesSection(username?)` — replaces `[data-section="incoming-trades"]` contents, rewires buttons
    - `refreshAvailableListingsSection(username?)` — replaces `#available-listings-section` contents, rewires buttons
    - `refreshMyListingsSection(username?)` — replaces `#my-listings-section` contents, rewires buttons (skipped by reactive ticker if create form has a value to preserve user input)
    - `refreshTradeAvailabilityState()` — convenience wrapper for cooldown banners
  - **Reactive ticker**: interval inside `_startCooldownTimer` runs every 1s for cooldown banners, every 5s for section change-detection. Uses `_hashArray()` snapshots to skip DOM writes when nothing changed. Guards against wiping form state when user is mid-selection.
- **Phase T-3 — Hidden Player System**:
  - `isTradeProfileHidden` (bool, default `false`) on every player profile — hides player from direct-trade search/lists only
  - Hidden players do NOT appear in the trade-ui player picker and cannot receive unsolicited direct trades (`TARGET_PLAYER_HIDDEN` validation error)
  - Hidden players CAN still: open trading UI, initiate trades themselves, send trade requests, create listings, accept listings, appear on leaderboards, remain in groups/subgroups
  - Toggle: "Hide Trading Profile: ON/OFF" rendered at top of trading tab, writes directly to `players/{username}/isTradeProfileHidden`
  - Migration: safe backfill to `false` on login + session restore (same pattern as `isTradeRestricted`), default `false` in `createPlayerRecord()`
  - Validation uses `target.isTradeProfileHidden` (NOT generic `hidden`) — scoped to trading systems only
- **Phase T-6 — UX Safeguards** (`trade-lock-helpers.js` + validator/execution/UI edits):
  - **Project card locking**: Cards assigned to ACTIVE research projects cannot be traded. Centralized in `trade-lock-helpers.js` via `getPlayerLockedCardIds(username)` → Set. Reuses `getLockedCardIds()` from `project-state.js`.
  - Lock enforced at 3 levels: (1) UI filtering — locked cards excluded from selectors, (2) Validator — `_lockedCardIds` sets checked in `validateDirectTrade()` / `validateListingTrade()`, (3) Execution re-validation — fresh lock sets recomputed in `executeDirectTrade()` / `executeListingTrade()`
  - Error codes: `OFFERED_CARD_LOCKED_BY_PROJECT`, `REQUESTED_CARD_LOCKED_BY_PROJECT`
  - **Last-copy warning**: Non-blocking ⚠️ indicator on card selectors + confirmation dialogs when trading the last copy of a card
  - **Trade confirmation**: Sandbox-safe in-app modal (`trade-confirm-modal.js → showTradeConfirmModal()`) before every trade action (direct send, direct accept, listing create, listing accept) — shows card names, rarities, last-copy warnings. Returns `Promise<boolean>`. Replaces native `confirm()` which is blocked in sandboxed iframes (`allow-modals` not set). Modal supports Esc/backdrop dismiss, responsive layout, dark translucent overlay. CSS classes: `.trade-confirm-overlay`, `.trade-confirm-modal`, `.trade-confirm-warning`, `.trade-confirm-actions`.
  - **Toast improvement**: Container moved to bottom-left (avoids platform controls), 5s visibility, slide-from-left animation
- **Constraints**: 1-for-1 trades only, equal rarity required, same group required, `isTradeRestricted` blocks trading, `isTradeProfileHidden` blocks incoming direct trades (not listings), `tradable: false` on card def blocks that card, project-locked cards cannot be traded
- **DB paths**: `/trades/direct/{tradeId}` (status: pending → processing → accepted|declined|cancelled|failed), `/trades/listings/{listingId}` (status: active → processing → fulfilled|cancelled|expired|failed)
- **Init**: `initTrading()` called in main.js step 6; migrates config values + migrates flat `/trades/` to `/trades/direct/` + `/trades/listings/`
- **Config keys** (in `config/economy`): `directTradeCooldownMinutes` (default 10080), `listingCooldownMinutes` (default 10080), `listingAcceptCooldownMinutes` (default 10080), `listingExpirationHours` (default 168), `maxActiveListingsPerPlayer` (default 1)
- **Phase T-8 — Admin Trading Controls**: `renderAdminTradingControls()` in ui.js renders a dedicated admin sub-tab ("Trading") with:
  - **Global Toggles** (persisted at `config/trading/*`): `enabled` (master switch), `directTradesEnabled`, `listingsEnabled`, `defaultHiddenProfile`, `enableDetailedLogs` — all boolean, toggle switches
  - **Cooldowns & Limits** (persisted at `config/economy/*`): `directTradeCooldownMinutes`, `listingCooldownMinutes`, `listingAcceptCooldownMinutes`, `listingExpirationHours`, `maxActiveListingsPerPlayer` — all numeric inputs
  - Save button writes all values individually via `db.set()` to their respective config paths
  - Trading system reads these values via `config.getValue()` at enforcement time (no restart needed)
  - HTML shell: `#admin-trading-controls` container + `#trading-controls-editor` dynamic content + `#btn-save-trading-controls` button (in index.html)

### Auth System
- **No Firebase Auth** — passwords stored as SHA-256 hashes in `players/{username}.password`
- Hashing uses Web Crypto API (SHA-256 + salt) with simple fallback
- Sessions stored in localStorage (`scicards_session`)
- Auto-login on refresh: `initAuth()` validates stored session against DB
- `login(username, password)` and `register(username, password, accessCode)` are async (due to hashing)
- Admin access: either `isAdmin` flag on player record OR admin password login (creates `__admin__` session)
- **Phase 5A — Persistent Admin**: entering admin code while logged in permanently sets `isAdmin: true` on the player profile (persisted to DB). On subsequent login/session restore, admin UI auto-unlocks without re-entering the code. Standalone `__admin__` session preserved as fallback when no player is logged in.
- **Phase 5A — Capability flags**: `isAdmin` (bool) and `isTradeRestricted` (bool) on every player profile. Default `false`. Safe migration backfill on login and session restore.
- **Phase T-3 — Trade profile flag**: `isTradeProfileHidden` (bool) on every player profile. Default `false`. Safe migration backfill on login and session restore. Affects trading visibility only.
- **Phase 5B — Admin Account Management**: admin player-detail panel (`showPlayerDetail()` in ui.js) has Promote/Remove Admin and Toggle Trade Restriction controls, all confirmation-gated. Self-demotion blocked. Player list shows ADMIN and TRADE LOCKED badges.
- **Phase 5B-2 — Persistent Admin Gameplay Fix**: All gameplay rendering guards in ui.js now check `session.username === '__admin__'` (standalone emergency admin) instead of `session.isAdmin` (which also matches persistent admin players). Persistent admin accounts get full gameplay access (collection, packs, research, profile, navigation) plus admin tools. Only the standalone `__admin__` session bypasses gameplay. Affected: `renderCollection`, `showCardDetail`, `renderPacks`, `renderResearchProjects`, `renderProfile`, `enterGame` (username display + group badge).
- **Phase 5C — Admin Gameplay Telemetry**: Persistent admin accounts (`isAdmin && username !== '__admin__'`) see developer-facing telemetry overlays in Research Projects. Gated by `_isPersistentAdmin()` helper in ui.js. Normal players see NO changes. Two additions:
  1. **Success percentage overlay**: Flavor labels (e.g. "Promising") are appended with raw percentage (e.g. "Promising (68%)") in project cards (ACTIVE state) and the assignment panel live preview.
  2. **Assignment telemetry panel**: Compact monospace panel below the preview box showing Effective Team Power, Effective Difficulty, Success %, Breakthrough Chance, Reward RP, Applied Concept Count — all sourced from `evaluateProject()` return values (no duplicate math). Styled with dashed blue border, visually secondary. CSS in style.css `.rp-admin-telemetry`.

### Admin Foundation (js/admin.js)
- `isAdmin(username)` — check player's isAdmin flag
- `getPlayer(username)` — get full player record
- `setPlayerData(username, path, value)` — set arbitrary data on a player
- `listPlayers()` — list all players
- `promoteToAdmin(username)` / `demoteFromAdmin(username)` — flag management

### Admin Safety Standard (Phase 2)
- All destructive admin actions require confirmation via in-game modal (`confirmAction()` in ui.js)
- Applies to: delete player, delete card, delete pack, delete group, remove inventory item, promote/remove admin, toggle trade restriction
- Modal shows specific description of what will be destroyed; Cancel = no-op, Confirm = proceed
- Confirmation modal is a global DOM element (`#confirm-modal`) in index.html

### Admin Card Editor (Phase 3)
- **Create**: "Add New Card" form in admin Cards tab with all Phase 3 fields
- **Edit**: Edit Card modal (`#edit-card-modal`) opened via Edit button in card list; pre-populates all fields
- **Delete**: Confirmation-gated via `confirmAction()`
- **Image preview**: Live preview thumbnail in both create and edit forms (`updateImagePreview()`)
- **Search/filter**: Rarity filter dropdown + text search in admin card list header
- **Disabled indicator**: Cards with `enabled: false` show `[disabled]` badge in list
- **Aura display**: Cards with aura show emoji + type + level in list
- `setupEditCardModal()` wires close/save/preview listeners once during `init()`
- `openEditCardModal(cardId)` populates modal from card data

### Pack Edit System
- Full "Edit Pack" modal (`#edit-pack-modal` in index.html) for editing existing pack types
- Edit button in admin pack list opens modal pre-populated with current values
- Editable fields: name, cardsPerPack, enabled, odds (all 5 rarities)
- Live odds total indicator (green = 100%, amber = other)
- Saves via `packs.updatePackType(id, updates)` → `db.update()` → Firebase
- `setupEditPackModal()` wires close/save/input listeners once during `init()`

### packOdds Deprecation
- `config.packOdds` (in /config) is @deprecated — NOT used by live pack generation
- Each pack stores its own odds in `/packs/{id}/odds`; config.packOdds only serves as a fallback default if a pack has no odds object (which never happens via the admin UI)
- Config editor shows packOdds section dimmed with "(DEPRECATED)" label
- No live behavior changed — fallback references preserved for safety

### Config Editor (Phase 2)
- Admin Config tab dynamically renders fields in `/config` **excluding** those owned by specialized admin sections
- `buildConfigEditor(obj, prefix)` recursively walks the config object
- Booleans render as toggle switches (instant save on click)
- Numbers, strings, and null values render as editable inputs (saved on "Save Config" click)
- Nested objects (economy, progression, seasonal, packOdds, etc.) render as labeled sections
- Any new fields added to `/config` in Firebase will automatically appear **unless** registered in `ADMIN_CONFIG_SECTIONS`
- **Config Ownership Map** (`ADMIN_CONFIG_SECTIONS` in ui.js): centralized dot-path → section-name map that determines which config keys are hidden from the generic Config tab because they belong to a dedicated admin section (Balance, Trading Controls, etc.). Helper `_isOwnedByAdminSection(dotPath)` checks the path and all ancestors. To hide a new config, add one entry to the map. Currently hides: `projectBalance` (balance), `quests` (balance), `trading` (trading-controls), and 5 `economy.*` trading keys (trading-controls). Empty nested sections are auto-skipped.

### Key Patterns
- All balance values from config.js (never hardcoded)
- database.js maintains an in-memory cache for synchronous reads; writes fire-and-forget to Firebase
- If Firebase is not configured (placeholder keys), falls back to localStorage transparently
- main.js init is async: `await db.initDB()` → `await auth.initAuth()` → sync seed/config/UI
- ui.js renders reactively from DB reads (no separate state)
- Placeholder modules export no-op inits + throw on actual calls

### Phase 2A — Player Persistence Schema Expansion (js/player-schema.js)
- **Persistence-only module** — no gameplay logic, no UI, no Firebase mutation flows, no shop generation
- **Schema subsystems** added to every player record:
  - `currencies` — `{ currentResearchPoints: 0 }`. Separate from lifetime RP (leaderboard) and seasonal RP. No mutation logic added.
  - `cosmetics` — `{ owned: { profile_banner_default: true }, equipped: { aura: 'default_prismatic', border: null, title: null, profileBanner: 'profile_banner_default' } }`. `default_prismatic` is the **cosmetic** aura — completely separate from the gameplay aura multiplier system. No project/card systems modified.
  - `items` — consumable inventory: `{ reroll_token, cosmetic_reroll_token, aura_reroll_token, border_reroll_token, discount_chip, freeze_token, research_proposal }`. All default 0, stackable. No usage logic.
  - `shopUsage` — `{ rerollsUsedThisRotation: 0, frozenSlotsUsedThisRotation: 0 }`. Rotation-scoped tracking. No shop generation added.
  - `shop` — Phase 2B persistent rotation storage. See Phase 2B section below. No runtime shop behavior added.
  - `purchaseHistory` — `[]` capped at 10 entries (rolling). Schema: `{ itemId, purchasedAt, pricePaid, currency, source }`. No analytics/admin UI.
  - `profileCustomization` — `{ featuredCards: [], featuredAchievements: [] }`.
  - `profileVisibility` — `{ isProfileHidden: false, isCollectionHidden: false }`.
- **Frozen defaults**: `DEFAULT_CURRENCIES`, `DEFAULT_COSMETICS`, `DEFAULT_ITEMS`, `DEFAULT_SHOP_USAGE`, `DEFAULT_SHOP`, `DEFAULT_PROFILE_CUSTOMIZATION`, `DEFAULT_PROFILE_VISIBILITY`, `PURCHASE_HISTORY_MAX` — all exported, frozen.
- **getPhase2ADefaults()**: returns a fresh copy of all Phase 2A/2B defaults; used by `createPlayerRecord()` in auth.js for new accounts. Name preserved for import stability.
- **normalizePlayerSchema(username)**: safe backfill for a single player — never overwrites existing valid data. Handles Firebase array→object conversion for `shop.currentRotation.slots`, `purchaseHistory`, `featuredCards`, `featuredAchievements`. Called on login, session restore, and bulk migration.
- **migrateAllPlayersPhase2A()**: startup bulk migration called from main.js step 4f. Iterates all players, calls `normalizePlayerSchema()` for each. Idempotent. Name preserved for startup/import stability while now covering Phase 2B shop persistence fields.
- **normalizePurchaseHistory(raw)**: utility to normalize and cap a raw purchaseHistory value (array or Firebase object → capped array).
- **Integration points**: `auth.js` imports `getPhase2ADefaults` (createPlayerRecord) + `normalizePlayerSchema` (login + initAuth). `main.js` imports `migrateAllPlayersPhase2A` (startup step 4f).
- **No Phase 2B files modified**: ui.js, index.html, style.css, profile-ui.js, shop-ui.js, project-*.js, quest-config.js, cards.js — none touched.

### Phase 2B — Shop Rotation Persistence Schema
- **Persistence-only phase** — no shop gameplay, no purchases, no rerolls, no consumable usage, no weighted generation, no rendering, no timers, no refresh execution, and no runtime shop Firebase mutation flows.
- **Player DB structure**:
  - `shop.currentRotation.slots` — array of persisted slot schema objects. Empty by default; future generation will populate it.
  - `shop.currentRotation.generatedAt` — timestamp metadata only. Default `0`; no timer or refresh execution.
  - `shop.currentRotation.refreshAt` — timestamp metadata only. Default `0`; no scheduling.
  - `shop.currentRotation.generationVersion` — metadata for future regeneration safety. Default `1`; no regeneration behavior.
  - `shop.rerollResetAt` — timestamp metadata only. Default `0`; no reroll reset execution.
- **Slot schema** (`shop-state.js → createShopSlot()`): `{ id, itemId, basePrice, currentPrice, currency, frozen, purchased, discountApplied }`. `currency` defaults to `'rp'`; `frozen` and `purchased` are stored flags only.
- **Discount schema** (`shop-state.js → createDiscountApplied()`): `{ sourceItemId, percent, reductionAmount, appliedAt }`. Structure only; no discount logic or stacking enforcement.
- **Shop state helpers** (`shop-state.js`): `createEmptyShopState()`, `createShopRotationState()`, `createShopSlot()`, `createDiscountApplied()`, and `SHOP_GENERATION_VERSION`. This module remains pure: no DB reads/writes, no rendering, no generation, no mutations.
- **Migration behavior** (`player-schema.js`): `normalizePlayerSchema(username)` initializes missing `shop` state and patches missing nested fields without overwriting valid existing values. Existing slot arrays are preserved with missing slot fields backfilled. Firebase array-like objects are normalized with `Object.values()`. Legacy top-level shop fields (`slots`, `generatedAt`, `refreshAt`, `generationVersion`) are used only to seed missing `shop.currentRotation`; they are not executed as behavior.
- **Subsystem boundaries**:
  - `shop-state.js` owns schema constructors only.
  - `player-schema.js` owns new-player defaults and existing-player normalization only.
  - `shop-generation.js` remains a placeholder for future weighted generation and does not populate slots.
  - `shop-validation.js` remains a placeholder for future guards and does not enforce purchase/reroll/freeze behavior.
  - `shop-mutations.js` remains a placeholder for future atomic shop actions and does not write runtime shop gameplay state.
- **Implementation status**: persistent shop rotation structure and idempotent migration are in place. The live app still has no player-facing shop rendering, purchase flow, reroll flow, consumable routing, refresh timer, or weighted shop generation.

### Phase 2C — Shop Runtime Generation Foundations
- **Generation-only phase** — adds safe runtime shop rotation generation foundations while still excluding purchases, RP deduction, consumable execution, paid rerolls, freeze-token consumption, discount execution, finalized UI rollout, admin balancing, and unrelated gameplay refactors.
- **Pure generation engine** (`shop-generation.js`):
  - `buildEligiblePool(player, config, options)` reads `ITEM_DEFINITIONS`, keeps enabled positive-weight items, excludes explicit item IDs, and removes owned cosmetics when `allowOwnedCosmeticsInShop` is false.
  - `filterOwnedCosmetics(pool, ownedCosmetics, config)` is a pure helper for cosmetic ownership filtering. Non-cosmetic items pass through unchanged.
  - `weightedSelectWithoutReplacement(pool, count, rng)` performs weighted selection with no duplicate `itemId`s and accepts an injected RNG for deterministic tests/smoke checks.
  - `applySlotConstraints(pool, config, options)` clamps impossible slot constraints and enforces minimum utility/cosmetic slots plus `maximumPackAndCardSlots` as a cap.
  - `generateShopRotation(player, config, options)` returns a full `createShopRotationState()` object with generated `slots`, `generatedAt`, `refreshAt`, and `generationVersion` metadata.
- **Frozen-slot preservation**: full rotation generation carries forward slots where `frozen === true`, `purchased !== true`, and `itemId` exists. Preserved item IDs are excluded from newly generated slots. Phase 2C does not consume freeze tokens or implement freeze toggling.
- **Runtime persistence helper** (`shop-mutations.js → ensureShopRotation(username, options)`):
  - Reads the fresh player snapshot from `database.js`.
  - Returns an existing active rotation without writing unless `force: true`.
  - Persists only `players/{username}/shop/currentRotation` when a new rotation is generated.
  - Resets `players/{username}/shopUsage` to `DEFAULT_SHOP_USAGE` only when a new full rotation is written.
  - Leaves `players/{username}/shop/rerollResetAt` untouched. Reroll reset behavior remains persistence-only metadata until reroll systems exist.
- **Firebase mutation boundary**: generation persistence is intentionally narrow and cache-first through existing `db.set()` helpers. It does not write currencies, items, cosmetics, purchase history, or gameplay rewards.
- **Rollback safety**: Phase 2C does not change schema defaults or migration behavior. Removing calls to `ensureShopRotation()` stops runtime generation while leaving Phase 2B persistence fields valid.
- **Implementation status**: runtime rotation generation foundations are available to future UI/refresh phases, but the live app still has no player-facing shop rendering, purchase flow, reroll execution, consumable routing, or discount execution.

### Phase 3 — Shop Runtime Behavior
- **Runtime behavior phase** — implements weighted generation, scoped reroll execution, state-only freeze execution, ownership filtering, and pull-based refresh behavior. Still excludes final UI rollout, HTML restructuring, admin balancing tools, monetization systems, premium currencies, animations/effects, broad architectural rewrites, purchases, token consumption, discount execution, and consumable routing.
- **Pure generation engine** (`shop-generation.js`):
  - Existing Phase 2C generation remains pure: no Firebase, no rendering, no currency mutation.
  - `REROLL_SCOPES` defines supported reroll scopes: `all`, `cosmetic`, `aura`, `border`, `utility`, `pack`.
  - `itemMatchesRerollScope()` centralizes category/scope matching so mutation code does not own generation rules.
  - `getShopRotationSlots()` normalizes array and Firebase object-shaped slot collections.
  - `getRotationItemIds()` and `buildScopedEligiblePool()` exclude static and card `itemId`s from other slots during rerolls; synthetic pack ids are not globally excluded so identical packs may repeat.
  - `generateReplacementShopSlot()` creates a replacement slot through `createShopSlot()` and preserves deterministic RNG injection for smoke tests.
- **Pure validation guards** (`shop-validation.js`):
  - `canRerollSlot(player, slotIndex, scope, config)` checks slot existence, purchased/frozen immutability, scope validity, scope match, and RP affordability.
  - `canRerollRotation(player, scope, config)` validates full/scope rerolls and returns eligible non-purchased, non-frozen slot indexes.
  - `canFreezeSlot(player, slotIndex, config)` checks slot existence, purchased immutability, already-frozen state, and `maxFrozenSlots`.
  - Validation remains side-effect free and performs no DB writes.
- **Runtime mutation layer** (`shop-mutations.js`):
  - All generation and mutation paths resolve config through `shop-config.js → resolveShopRuntimeConfig()` (persisted `config/shop` via `getShopConfig()`, or `mergeShopConfig()` when an override is passed).
  - **Weekly shop refresh**: automatic rotation expiry and `refreshAt` use `weekly-research-pack.js` timestamp helpers (`getNextWeeklyRefreshTimestamp`, `getLastWeeklyRefreshTimestamp`) with schedule from `config/projectBalance` (`weeklyRefreshDay`, `weeklyRefreshHour`). No separate shop scheduler; `shopRefreshDays` in shop config is legacy/ignored for generation. Pull-based regen on shop tab open via `hasActiveRotation()` only.
  - **Consumable visuals**: `shop-definitions.js → resolveItemDisplay()` reads per-item `display` metadata with type/behavior fallbacks; used by shop and profile UI.
  - `ensureShopRotation(username, options)` remains the pull-based lifecycle entry point and refreshes expired or forced rotations.
  - `refreshShopRotation(username, options)` forces the same safe full-refresh path.
  - `rerollShopSlot(username, slotIndex, options)` performs RP-only single-slot rerolls. It deducts `currencies.currentResearchPoints`, increments `shopUsage.rerollsUsedThisRotation`, and writes updated slots only after validation and replacement generation succeed.
  - `rerollShopRotation(username, options)` performs one configured-cost RP reroll across eligible non-purchased, non-frozen slots for the requested scope.
  - `freezeShopSlot(username, slotIndex, options)` is state-only: it sets `frozen: true` and increments `shopUsage.frozenSlotsUsedThisRotation`. It does not consume `items.freeze_token`.
  - `shop.rerollResetAt` remains untouched; reroll reset behavior is still undefined for future phases.
- **Persistence paths touched by Phase 3**:
  - `players/{username}/shop/currentRotation`
  - `players/{username}/shop/currentRotation/slots`
  - `players/{username}/shopUsage`
  - `players/{username}/shopUsage/rerollsUsedThisRotation`
  - `players/{username}/shopUsage/frozenSlotsUsedThisRotation`
  - `players/{username}/currencies/currentResearchPoints`
- **Persistence paths intentionally untouched**:
  - `players/{username}/items`
  - `players/{username}/purchaseHistory`
  - `players/{username}/cosmetics/owned`
  - `players/{username}/shop/rerollResetAt`
  - `players/{username}/inventory`, packs, cards, or gameplay rewards
- **Refresh behavior**:
  - Refresh remains pull-based. Phase 3 adds no timers, intervals, global refresh loops, or new realtime listeners.
  - Expired or forced refreshes preserve eligible frozen/unpurchased slots, regenerate remaining slots, update rotation metadata, and reset `shopUsage`.
- **Scalability notes**:
  - Shop mutations read scoped player subtrees (`shop`, `currencies`, `shopUsage`, `cosmetics`) instead of the full player object where practical.
  - Writes remain scoped to shop, usage, and RP paths; Phase 3 does not write whole player records.
  - Existing `database.js` still initializes and listens at the Firebase root (`ref('/')`), which is the primary bandwidth concern for future scalability. Phase 3 documents this but does not redesign the DB layer.
  - Cache-first, fire-and-forget writes can race across simultaneous sessions. Phase 3 preserves rollback-safe scoped writes and leaves transaction/server-authoritative behavior for a future scalability pass.

### Shop Consumable Execution Layer
- **Behavior-routed consumables** (`shop-consumables.js`):
  - `useConsumable(username, consumableItemId, context, options)` looks up `ITEM_DEFINITIONS[consumableItemId]`, validates ownership/behavior through `canUseConsumable()`, routes by `behaviorType`, and decrements `players/{username}/items/{consumableItemId}` only after the routed mutation returns success.
  - `executeBehavior()` routes actual definition behavior values: `reroll_shop`, `apply_discount`, `freeze_slot`, and `grant_research`. Consumables do not contain gameplay logic and do not branch on specific item IDs for behavior.
  - Inventory quantities are preserved as stable item keys and set to `0` rather than removing schema-default item fields.
- **Token rerolls**:
  - Reroll Token, Cosmetic Reroll Token, Aura Reroll Token, and Border Reroll Token all route through `rerollShopSlotWithToken()` and reuse `generateReplacementShopSlot()`.
  - Token rerolls are payment mode `token`: no `currencies.currentResearchPoints` deduction. They still reject purchased/frozen slots and fail without consuming the token if no scoped replacement exists.
  - Cosmetic/aura/border token scopes force replacement category through shared reroll scopes; they do not require the current slot to already match that category.
- **Discount Chip**:
  - Routes through `applyDiscountToSlot()`.
  - `canApplyDiscount()` rejects purchased slots, already-discounted slots, invalid discount percent, and invalid slot prices.
  - Successful application persists `currentPrice` and `discountApplied{sourceItemId,percent,reductionAmount,appliedAt}` on the slot. Future purchase logic should trust persisted slot price/discount metadata rather than recalculating from live config.
- **Freeze Token**:
  - Routes through `grantFreezeAllowance()`.
  - It grants one additional freeze allowance for the current rotation via `shopUsage.extraFreezeAllowanceThisRotation`.
  - It does NOT directly freeze a slot. The actual slot freeze action remains `freezeShopSlot()`.
  - Full shop refresh resets `extraFreezeAllowanceThisRotation` with the rest of `DEFAULT_SHOP_USAGE`.
- **Research Proposal**:
  - Existing `behaviorType: 'grant_research'` routes to `generateAdditionalProject()` without item-ID specific logic.
  - The mutation reuses `project-pool.js → generateAvailableProjects({ totalRP, slots: 1, createdAt })` and respects the normal AVAILABLE + ACTIVE project cap.
  - It appends one AVAILABLE project to `players/{username}/projects`, leaves `lastProjectRefreshAt` unchanged, and does not assign cards, evaluate outcomes, resolve projects, grant rewards, or mutate RP.
- **Persistence boundaries**:
  - Allowed writes: item quantity decrement, `shop/currentRotation/slots`, `shopUsage/extraFreezeAllowanceThisRotation`, and `projects` for Research Proposal.
  - No full player rewrites, no new realtime listeners, no all-player scans, no `shop.rerollResetAt` writes, no purchase execution, no UI/admin rollout, and no premium currency behavior.
  - Current `database.js` remains cache-first and Firebase writes remain fire-and-forget; remote acknowledgement is not added in this layer.

### Layer 2 — Unified Atomic Economy Mutation Layer
- **Trusted economy path**: shop purchases and reusable economy writes now route through `shop-mutations.js`. Future UI should not directly mutate `currencies`, `cosmetics`, `items`, purchased slot state, or `purchaseHistory`.
- **Purchase validation** (`shop-validation.js → canPurchaseItem()`):
  - Checks player snapshot, rotation/slot validity, valid enabled item definition, unpurchased slot state, supported `rp` currency, finite affordable `currentPrice`, duplicate cosmetic ownership, and supported item types.
  - Supported purchase grants in this layer: `ITEM_TYPES.COSMETIC` and `ITEM_TYPES.CONSUMABLE`. Pack/card shop purchases remain future work and fail closed unless definitions and validation are added later.
- **Canonical helpers** (`shop-mutations.js`):
  - `purchaseShopItem(username, slotIndex, options)` is the single purchase execution entry point.
  - `grantConsumable(username, itemId, quantity)`, `consumeItem(username, itemId, quantity)`, and `unlockCosmetic(username, itemId)` are reusable scoped economy helpers.
  - Purchase execution computes the full write plan before persistence: RP deduction, grant path, purchased slot flag, and capped purchase history.
  - `shop-consumables.js` delegates successful consumable decrement to `consumeItem()` instead of writing item quantities itself.
- **Purchase grants**:
  - Cosmetic purchases persist `players/{username}/cosmetics/owned/{itemId} = true` and do not auto-equip.
  - Consumable purchases increment `players/{username}/items/{itemId}` by the grant quantity, default `1`.
  - Purchased slots are marked `purchased: true`, making them ineligible for reroll, freeze, and discount mutation paths.
- **Purchase history**:
  - Uses `createPurchaseHistoryEntry()` and `normalizePurchaseHistory()`.
  - Stores compact entries with `itemId`, `pricePaid`, `currency`, `purchasedAt`, `source: 'shop'`, `slotId`, and `rotationGeneratedAt`.
  - Persists only the capped `players/{username}/purchaseHistory` array, preserving `PURCHASE_HISTORY_MAX`.
- **Scoped persistence**:
  - Purchase writes are limited to `currencies/currentResearchPoints`, one grant path (`cosmetics/owned/{itemId}` or `items/{itemId}`), `shop/currentRotation/slots`, and `purchaseHistory`.
  - No full player rewrites, root scans, new listeners, admin writes, premium currencies, purchase analytics fanout, or Firebase architecture redesign.
- **Atomicity model**:
  - All validation and write-plan computation happen before local writes.
  - `database.js` remains cache-first and Firebase writes remain fire-and-forget; true cross-path remote transactions are not introduced in this layer.
  - Duplicate execution protection is local: each purchase re-reads the slot and rejects `purchased === true`. Simultaneous-session race handling remains a future scalability/server-authoritative concern.

### Layer 3 — Cosmetic Runtime Layer
- **Runtime identity scope**: Layer 3 turns owned cosmetics into active profile state and featured selections. It does not add final shop/profile UI, cosmetic previews, animations, admin tooling, monetization, achievements gameplay, new listeners, root scans, or database architecture changes.
- **Schema defaults and normalization** (`player-schema.js`):
  - Adds additive `profile{equippedAura,equippedBorder,equippedBanner,equippedTitle,identityAccent,featuredCards,featuredAchievements}` defaults for new players.
  - Existing players are normalized idempotently. Missing `profile` fields are backfilled without deleting `cosmetics.equipped` or `profileCustomization`.
  - Legacy equipped values seed profile state only when the referenced item is owned, enabled, `ITEM_TYPES.COSMETIC`, and matches the expected data-driven category.
  - Featured arrays are normalized to string IDs, preserve order, remove duplicates, and respect `MAX_FEATURED_CARDS` / `MAX_FEATURED_ACHIEVEMENTS`.
- **Pure validation** (`shop-validation.js`):
  - `canEquipCosmetic()` validates item definition, enabled state, cosmetic type, supported category, optional category match, and ownership.
  - `canUnequipCosmetic()` validates supported category and is suitable for idempotent clears.
  - `canFeatureCard()` / `canUnfeatureCard()` require inventory ownership, duplicate prevention, and cap enforcement.
  - `canFeatureAchievement()` / `canUnfeatureAchievement()` require an existing unlocked marker from `achievements` or compatible `badges` state, duplicate prevention, and cap enforcement.
- **Canonical scoped mutations** (`shop-mutations.js`):
  - `equipCosmetic(username, cosmeticId)` writes only `players/{username}/profile/{equippedField}`.
  - `unequipCosmetic(username, category)` writes `null` to the mapped equipped field.
  - `featureCard()`, `unfeatureCard()`, `setFeaturedCards()`, `featureAchievement()`, `unfeatureAchievement()`, and `setFeaturedAchievements()` write only the relevant profile featured array.
  - Mutations read scoped player paths (`profile`, `cosmetics`, one inventory card path, `achievements`, and `badges` where needed) and never mutate ownership, inventory, shop slots, purchase history, or full player records.
- **Runtime helpers** (`profile-ui.js`):
  - `getEquippedAura()`, `getEquippedBorder()`, `getEquippedBanner()`, `getEquippedTitle()`, and `getProfileIdentityState()` expose lightweight state for future UI phases.
  - Helpers validate active cosmetics against ownership and item metadata before returning them, keeping behavior data-driven by `type` and `category`.
- **Rollback and scalability**:
  - The `profile` object is additive and isolated. Removing Layer 3 callers leaves ownership, economy, inventory, and legacy profile data intact.
  - No new realtime listeners, all-player scans, root reads, derived fanout paths, or broad Firebase rewrites are introduced.

### Layer 4 — Shop UI Layer
- **Player-facing tab only**: the Shop is a main game tab alongside Collection, Packs, Research Projects, Trading, Profile, and Leaderboard. This layer does not add admin tooling, cosmetic management UI, profile inventory UI, equip UI, monetization, seasonal/event UI, backend rewrites, or Firebase architecture changes.
- **Tab shell** (`index.html`, `ui.js`):
  - `index.html` owns the static Shop nav button and `tab-shop` container.
  - `ui.js` already delegates tab activation to `renderShop()` and `cleanupShop()` and does not own shop gameplay behavior.
- **Thin rendering layer** (`shop-ui.js`):
  - `renderShop()` calls `ensureShopRotation(username)` on entry, reads current-player scoped cache paths, and renders the persisted rotation.
  - Slot cards render defensively from `ITEM_DEFINITIONS` plus persisted slot state. Missing item metadata falls back to safe labels/descriptions and never crashes rendering.
  - Visual state comes from persisted backend fields: `purchased`, `frozen`, `discountApplied`, `basePrice`, and `currentPrice`.
  - Purchased slots are grayed out, disabled, and labeled `PURCHASED`; frozen and discounted slots have persistent badges/visuals.
  - The refresh countdown is UI-only and updates only the countdown text. It does not rerender the shop or execute background refreshes every second.
- **Mutation boundaries**:
  - UI actions call canonical runtime APIs only: `purchaseShopItem()`, `rerollShopSlot()`, `rerollShopRotation()`, `freezeShopSlot()`, `refreshShopRotation()`, and `shop-consumables.js → useConsumable()`.
  - Consumable targeting for reroll/discount items is local transient UI state only and is cleared on cleanup or successful action.
  - The UI does not call generation helpers, validation helpers, low-level economy helpers, `consumeItem()`, `unlockCosmetic()`, or direct Firebase writes.
- **State synchronization**:
  - Shop state uses a pull-after-mutation model: render on tab entry, rerender after mutations/actions, and clean up intervals/target state when leaving the tab.
  - No new realtime listeners, root scans, all-player scans, derived fanout paths, or heavy polling are introduced.
  - Reads are current-player scoped cache reads for `shop`, `currencies`, `items`, `cosmetics`, and `shopUsage`.
- **Rollback safety**:
  - Removing the Shop tab shell or no-oping `renderShop()` disables the player-facing UI while leaving backend shop, economy, consumable, and identity data untouched.
  - `style.css` additions are scoped to `.shop-*` classes and do not redesign global rendering architecture.

### Profile Inventory + Cosmetic Runtime UI
- **Player-facing profile scope**: The Profile tab now surfaces existing runtime state for identity, consumables, cosmetics, featured cards, RP balances, collection progress, and an achievements summary. It does not add admin tools, public/social profiles, consumable use, monetization, preview animations, new listeners, polling, or backend redesigns.
- **Rendering ownership** (`profile-ui.js`):
  - Preserves the existing username/group, stats, and collection-progress behavior while adding dedicated sections for currently equipped identity, read-only consumables, owned cosmetics, featured cards, and achievements panel (`achievements-ui.js` in profile upper-right, consumables below).
  - Equipped identity renders strictly from `players/{username}/profile/*` via the canonical profile runtime helpers, not from legacy `cosmetics.equipped`.
  - Consumables render only owned quantities from `players/{username}/items` where quantity is greater than zero. They are read-only in Profile.
  - Cosmetics render only owned `ITEM_TYPES.COSMETIC` entries from `cosmetics.owned`, grouped dynamically by metadata category. Unknown/future categories are shown under “Other Cosmetics.”
- **Mutation boundaries**:
  - Equip/unequip actions call `equipCosmetic()` and `unequipCosmetic()` from `shop-mutations.js`.
  - Featured-card actions call `featureCard()` and `unfeatureCard()` from `shop-mutations.js`.
  - Profile UI does not write Firebase paths directly, does not mutate ownership/inventory, and does not duplicate backend validation.
  - Featured cards are capped at `MAX_FEATURED_CARDS = 3` in `player-schema.js`, so the backend runtime enforces the same cap the UI displays.
- **State synchronization**:
  - Profile uses pull-after-mutation rendering: read current player snapshot, call a canonical mutation for user actions, then rerender from persisted runtime state.
  - No new realtime listeners, all-player scans, root reads, polling loops, or broad synchronization systems are introduced.

### Achievement System
- **Config path**: `config/achievements` — `meta.enabled` kill-switch; `definitions` keyed by achievement id (admin-authored only; no hardcoded gameplay achievements).
- **Player progress path**: `players/{username}/achievements/{id}` — `{unlocked, unlockedAt, progress, progressValue, targetValue, claimed, claimedAt, lastEvaluatedAt}`.
- **Gameplay contract**: Gameplay modules call `bumpPlayerStat()`, `recordProjectOutcome()`, `recordCardCollectionGain()`, `recordBreakthroughEarned()`, or `notifyStatsChanged()` from `achievements.js` only. They must never call `unlockAchievement()` or write achievement unlock state directly.
- **Evaluation model**:
  - On stat bump: `buildStatIndex()` maps stat keys → achievement ids; only indexed achievements are evaluated (never full-definition scans per bump).
  - On login/session restore: `evaluateAchievementsOnLogin()` evaluates pending (not-yet-unlocked) definitions once per session (`resetLoginAchievementEvaluation()` on logout).
  - Conditions are simple `{stat, op, value}` with `conditionMode` `all`/`any` — no formulas, nesting, JS eval, or callbacks.
- **Stat registry** (`achievement-stats.js`): additive counters on `players/{username}/stats/*` and top-level fields (`totalResearchPoints`, `projectsCompleted`, `researchStats/breakthroughs`). High-water stats: `bestProjectSuccessStreak`, `maxCardAuraTier`. Current `projectSuccessStreak` may reset on failure; achievements should target `bestProjectSuccessStreak`, not current streak.
- **Rewards** (`achievement-rewards.js`): manual claim via `claimAchievementReward()` routes through `addResearchPoints`, `grantConsumable`, `unlockCosmetic` (ownership only — never auto-equip), and `addPack` — no direct inventory/cosmetic/pack writes.
- **Hidden achievements**: locked hidden entries are omitted from the player list entirely until unlocked.
- **UI**: `achievements-ui.js` (profile panel only); `achievements-admin.js` (simplified CRUD, auto IDs on create, drag-and-drop `sortOrder`, reward dropdowns).

### Admin Shop Tools
- **Additive admin scope**: Adds a Shop section to the existing admin dashboard and small Manage Player extensions. It does not replace admin navigation, redesign shop economy, alter consumable routing, change profile runtime, add analytics/logging, or introduce new listeners.
- **Canonical admin wrappers** (`admin-player-tools.js`):
  - `adminGrantResearchPoints()` delegates to `addResearchPoints()` so lifetime RP and spendable `currencies.currentResearchPoints` increase by the same amount.
  - `adminGrantShopItem()` routes consumables through `grantConsumable()` and cosmetics through `unlockCosmetic()`. Cosmetic grants only unlock ownership and do not mutate equipped profile state.
  - `adminCompleteActiveProject()` is the admin-only testing shortcut for active projects. It re-reads fresh player state, forces the selected active project eligible for resolution, calls `resolveCompletedProject()`, calls `claimProjectRewards()`, grants RP through `addResearchPoints()`, preserves seasonal/weekly RP side effects, grants card rewards through existing inventory helpers, and stores the project as claimed to avoid double rewards.
- **Shop admin section** (`shop-admin.js`):
  - Renders shop economy controls for refresh cadence, slot counts, reroll costs, frozen slot limits, owned-cosmetic inclusion, and future `weeklyFreeRerolls` metadata.
  - Renders consumable behaviorConfig override controls for Discount Chip, Freeze Token, and Research Proposal without changing consumable routing logic.
  - Renders all shop items from item metadata (`type`, `category`, `rarity`) with enable, price, weight, and rarity override controls.
- **Config paths** (`shop-config.js`):
  - General shop overrides persist under `config/shop`.
  - Per-item overrides persist under `config/shop/itemOverrides/{itemId}` and are merged over static `ITEM_DEFINITIONS` by helper functions. Static definitions are not mutated.
- **Player management visibility**:
  - The existing Manage Player modal now includes RP/item/cosmetic grant controls and a read-only economy/profile/shop snapshot for owned consumables, owned cosmetics, equipped profile state, RP balances, and current shop slot state.
  - New controls call admin wrappers rather than writing player economy paths directly from UI.

### Shop + Admin + UX Clarification Fixes
- **Catalog assembly** (`shop-catalog.js`):
  - Merges static shop definitions, rarity-driven synthetic card entries (`shop_card:{cardId}`), and pack shop entries (`shop_pack:{packId}`) into one item-like pool for generation and validation.
  - Card inclusion is controlled by `config/shop/cardRarityControls` per rarity (`enabled`, `price`, `weight`), not per-card whitelisting. Each enabled card of an enabled rarity becomes its own `shop_card:{cardId}` entry; rarity `weight` applies per eligible card in the weighted pool (not as a single grouped rarity pick).
  - Pack shop settings live on pack records (`packs/{id}/shop`) and are edited in Packs admin, not Shop admin.
- **Independent slot caps** (`shop-config.js`, `shop-generation.js`):
  - Preferred config fields: `maxCardSlots`, `maxPackSlots`.
  - Legacy fallback: `maximumPackAndCardSlots` when the new fields are absent.
  - Frozen card/pack slots count against the correct independent cap during refreshes and rerolls.
  - `maxCardSlots` is also limited by unique card catalog entries (no duplicate `shop_card:{cardId}`). `maxPackSlots` is a slot ceiling only and may repeat the same `shop_pack:{packId}`.
- **Built-in rerolls** (`shop-config.js`, `shop-validation.js`, `shop-mutations.js`):
  - `builtInRerolls.total` (0–3) and sequential `builtInRerolls.costs[]` drive RP-only shop rerolls via `shopUsage.rerollsUsedThisRotation`.
  - Token rerolls remain independent: no built-in cost, no built-in allowance consumption, and token rerolls do not increment `rerollsUsedThisRotation`.
  - Legacy `rerollCosts` remains available as a fallback when built-in costs are unavailable.
- **Purchase grants**:
  - Card/pack shop purchases grant through the same `purchaseShopItem()` path into `inventory/{cardId}` and `packs/{packId}`.
- **Projects tab UX** (`project-ui.js`):
  - Research Proposal can be used from the project status bar through canonical `useConsumable(username, 'research_proposal', {})` with rerender-from-persisted-state only.
- **Admin card sort** (`ui.js`):
  - Manage Player Give Card selector and owned inventory list use `cards.sortCardsByRarityAndName()`.
- **Rotation uniqueness** (`shop-generation.js`):
  - Mixed weighted generation is preserved; `maxCardSlots` / `maxPackSlots` are ceilings only (0..N by RNG), not bucket-fill targets.
  - Static consumables/cosmetics and synthetic cards: unique per rotation by `item.id` (no duplicate `shop_card:{cardId}`).
  - Synthetic packs: the same `shop_pack:{packId}` may occupy multiple slots up to `maxPackSlots`.

### Application Shell & Theme Doctrine (S1–S4)

The game screen is a **viewport-owned flex shell**. Login and loading screens are unaffected. Global modals remain **outside** `#screen-game` as `position: fixed` viewport overlays.

#### Shell ownership hierarchy

```
html/body.app-mode-game          (viewport lock — game screen only)
└── #app.app-mode-game
    └── #screen-game              (theme hook owner: data-banner, data-background, data-theme)
        ├── #game-shell-backdrop  (visual-only, non-scrolling, pointer-events: none)
        ├── #game-shell-chrome    (mirrors theme hooks; shared chrome surface prep)
        │   ├── #game-header      (brand + identity flow + title overlay + logout)
        │   │   ├── .game-header-main (flow row)
        │   │   └── #nav-player-title (absolute overlay; non-flow)
        │   └── #tab-nav          (navigation only — structurally separate from header)
        └── #game-content-scroll  (sole authoritative gameplay vertical scroll)
```

**S1 — Viewport height contract**

- `showScreen('game')` toggles `app-mode-game` on `html`, `body`, `#app`.
- Document/body do not scroll in game mode (`overflow: hidden`, `100dvh` on body).
- `#screen-game` is `flex: 1`, `min-height: 0`, `height: 100%`, `overflow: hidden`.
- Flex `min-height: 0` is required on scroll flex children; missing it allows document growth.

**S2 — Semantic regions**

- Header and tabs are **not merged** in the DOM.
- Future visual unification uses `#game-shell-chrome` shared surface (`::before`), CSS variables, and backdrop layers — not structural coupling.

**S3 — Scroll ownership polish**

- `#game-content-scroll` is the only primary gameplay scroll container (`overflow-y: auto`).
- Main tab switches reset `scrollTop` on `#game-content-scroll`.
- `overscroll-behavior-y: contain` reduces scroll chaining to the document.

**S4 — Theme infrastructure (hooks only)**

- Implemented: data attributes, CSS variable defaults, backdrop layer activation, title mount normalization.
- **Not implemented yet**: banner/background/title visual definitions, animations, theme shop, runtime style injection.

#### Scroll ownership doctrine

| Region | Scrolls? | Notes |
|--------|----------|-------|
| `html` / `body` (game mode) | No | Locked while `#screen-game` is active |
| `#game-shell-backdrop` | No | Absolute within `#screen-game`; visual-only |
| `#game-shell-chrome` | No | Persistent chrome |
| `#game-content-scroll` | Yes | Authoritative gameplay scroll |
| Global modals (`#pack-opening-overlay`, `#card-detail-modal`, `#confirm-modal`) | Own internal overflow only | Fixed to viewport; never nested in shell |
| Admin/tab nested `max-h-*` panels | Optional nested scroll | Intentional; `vh` is viewport-relative |

**Non-scrolling background doctrine:** Shell backgrounds and backdrop textures must not scroll with gameplay content. They live on `#game-shell-backdrop` (or chrome pseudo-layers), not inside `#game-content-scroll`.

#### Global vs card cosmetic separation

| Layer | Categories | Mechanism | Must not touch |
|-------|------------|-----------|----------------|
| **Application shell** | `banner`, `background`, `title` | `data-banner`, `data-background`, `data-theme` on `#screen-game` / `#game-shell-chrome`; CSS classes/vars | Card renderer, card geometry, typography |
| **Card renderer** | `card_aura`, `card_glow`, `border` | `renderSciCard()` / `card-render.js` | Shell chrome, navigation, scroll containers |

Shell theming must not import card render paths. Card cosmetics must not mutate shell DOM or shell scroll behavior.

#### Independent theme-category philosophy

Players may mix categories freely (e.g. cosmic banner + blueprint background + scientific title). There are **no forced full-theme bundles**.

- `data-banner` — chrome/header banner treatment (from `profile.equippedBanner` / `profile_banner` cosmetics).
- `data-background` — shell backdrop treatment (from `profile.equippedBackground` / `shell_background` cosmetics when items exist).
- `data-theme` — reserved aggregate/accent hook; defaults to `default`; does not override independent slots.
- `#nav-player-title` — title mount (`data-title` slug); presentation hidden until S5+.

`js/shell-theme.js` applies hooks via `applyShellTheme(playerData)` after login and profile cosmetic equip/unequip. Uses **data attributes only** — no inline styles, no JS-generated visual composition.

#### Shell hook contract (public, stable)

| Hook | Host(s) | Default | Source (when equipped) |
|------|---------|---------|-------------------------|
| `data-banner` | `#screen-game`, `#game-shell-chrome` | `default` | `profile.equippedBanner` |
| `data-background` | `#screen-game`, `#game-shell-chrome` | `default` | `profile.equippedBackground` |
| `data-theme` | `#screen-game`, `#game-shell-chrome` | `default` | Reserved |
| `data-identity-accent` | `#screen-game`, `#game-shell-chrome`, `#game-header` | `default` | `profile.identityAccent` (utility preference) |
| `data-title` | `#nav-player-title` | `default` | `profile.equippedTitle` |

Future CSS selects themes with attribute selectors, e.g. `[data-banner="cosmic"]`, `[data-background="blueprint"]`. Slugs derive from cosmetic item ids via `cosmeticIdToShellSlug()`.

#### CSS variable foundation (`#screen-game`)

Conservative defaults matching current visuals: `--shell-bg`, `--shell-chrome-surface`, `--shell-accent`, `--shell-border`, `--banner-bg`, `--banner-border`, `--tab-accent`, `--background-overlay`, `--shell-header-min-height`, `--shell-safe-inline`. Cosmetic CSS (S5+) reads these vars; do not over-expand the token surface prematurely.

#### Animation intensity philosophy

Target aesthetic: educational, scientific, restrained, premium, readable.

- **Allowed (sparse):** subtle drift, faint shimmer, occasional restrained crackle, slow void movement, ambient twinkle.
- **Not allowed:** aggressive pulsing, fast loops, particle storms, large sweeping glows, chaotic motion.
- **Default expectation:** most cosmetics remain **static**; animation is optional premium enhancement.

#### Constraints (do not regress)

- Do not reintroduce document scrolling in game mode.
- Do not remove `min-height: 0` from the shell flex chain.
- Do not move modals inside `#screen-game`.
- Do not use `position: fixed` for header/tabs (flex chrome only).
- Do not merge header and tabs structurally.
- Do not add runtime inline styling or dynamic style-mutation systems for themes.

#### Future layout note (implemented in S4.5)

Header height uses tokenized ~1.5× scale (`--shell-header-base-min-height` × 1.5). Player title uses a non-flow overlay anchored to the identity region. See **S4.5 — Shell Polish** below.

#### S4.5 — Shell Polish (structure + identity infrastructure)

S4.5 finalizes shell sizing, title overlay structure, and identity accent infrastructure. **No cosmetic visuals** (banner art, background textures, title effects) — those begin in S5.

**Header sizing**

- `--shell-header-base-min-height: 3rem` (baseline)
- `--shell-header-min-height: calc(var(--shell-header-base-min-height) * 1.5)` (~50% taller)
- `--shell-header-padding-block` replaces Tailwind `py-*` on `#game-header`
- No fixed pixel heights, no `vh` scaling on header

**Title overlay doctrine (non-flow)**

- `#nav-player-title` is **not** in the identity flex row
- `position: absolute` within `.game-header-identity-wrap` (anchored to identity region, not viewport center)
- `pointer-events: none` — decorative overlay only
- `transform: translateY(50%)` allowed on title element only (static divider overlap; not animated)
- Header/tab divider remains authoritative; title may visually touch overlap
- Clipped by `#game-header` and `#game-shell-chrome { overflow: hidden }`
- Visible only when equipped title cosmetic has label text (`data-title !== "default"`)
- Forbidden on titles: glow, bounce, pulse, animation, excessive text-shadow, multi-line wrap

**Title vs identity accent vs earned cosmetics**

| Concern | Mechanism | Type |
|---------|-----------|------|
| Title **text** | `profile.equippedTitle` → `#nav-player-title` | Earned cosmetic (shop/achievement) |
| Title **color** | `--identity-accent` via `data-identity-accent` | Profile utility preference |
| Username **color** | Same `--identity-accent` | Profile utility preference |
| Banner / background visuals | `data-banner`, `data-background` | Earned cosmetics (S5+) |

**Identity accent system (`data-identity-accent`)**

- **Not** an earned cosmetic, banner theme, shell theme pack, or title cosmetic
- **Not** `data-theme` (reserved for future aggregate shell accent)
- Curated allowlist (~14 slugs): `default`, `slate`, `silver`, `ice`, `sky`, `teal`, `emerald`, `lime`, `gold`, `amber`, `coral`, `rose`, `lavender`, `violet`, `indigo`
- Stored at `players/{username}/profile/identityAccent`
- Applied via `applyShellTheme()` → `data-identity-accent` on `#screen-game`, `#game-shell-chrome`, `#game-header`
- CSS maps slugs to `--identity-accent`; consumed by `.nav-identity-name` and `.nav-player-title-slot` only
- Mutation: `setIdentityAccent()` in `shop-mutations.js` (profile utility, not shop purchase)
- No arbitrary hex, no inline styles, no runtime style injection

**Stacking / clipping governance**

| Layer | z-index | Notes |
|-------|---------|-------|
| `#game-shell-backdrop` | 0 | Visual-only |
| `#game-shell-chrome::before` | -1 | Shared surface |
| Header/tab flow | 1 | Brand, username, tabs |
| `#nav-player-title` | 2 | Overlay; pointer-events none |
| `#btn-logout` | 3 | Always clickable |
| `#game-shell-chrome` | 2 | Container; overflow hidden |
| `#game-content-scroll` | 1 | Gameplay scroll |
| Global modals | 50+ | Viewport-fixed; authoritative |

**Forbidden (shell drift prevention)**

- Title in flex document flow
- `transform` / `filter` on `#screen-game` or modal ancestors
- `position: fixed` header/tabs
- Shell chrome `z-index` > 10
- Inline identity colors or RGB picker
- Title animations or glow effects
- Merging `#game-header` and `#tab-nav` structurally

**S5 boundary**

S5 adds cosmetic **visual definitions** only: `[data-banner="…"]`, `[data-background="…"]`, title typography refinements per `[data-title="…"]`. S4.5 must remain visually restrained (scientific, elegant, readable).

---

Last verified stable deployment, new commit to note success
### Firebase Integration
- Firebase SDK loaded via CDN (compat builds: App + Database only) in index.html `<head>`
- firebase-config.js: edit the `firebaseConfig` object with your project credentials
- Real-time sync: Firebase → cache via `.on('value')` listener on root
- Offline fallback: localStorage always mirrors the cache as backup
