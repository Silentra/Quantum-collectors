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
  achievements.js    - PLACEHOLDER
  seasonal.js        - PLACEHOLDER
  player-schema.js   - Phase 2A/2B expanded player persistence schema: defaults, normalization, migration (currencies, cosmetics, items, shopUsage, shop, purchaseHistory, profileCustomization, profileVisibility)
  shop-state.js      - Phase 2B pure shop persistence schema helpers: shop state, current rotation, slot, discount structures
  shop-generation.js - Future weighted shop generation engine placeholder (no generation logic yet)
  shop-validation.js - Future shop validation placeholder (no validation logic yet)
  shop-mutations.js  - Future shop mutation placeholder (no gameplay/Firebase mutation logic yet)
```

### DB Schema (database.js nodes → Firebase RTDB paths)
- `/config` - gameOpen, registrationOpen, adminPassword, packOdds, economy{packsPerDay, tradeCooldownMinutes, maxInventorySize, **directTradeCooldownMinutes**}, progression, seasonal, **quests{...}**, **projectBalance{...}**
- `/players/{username}` - username, password (SHA-256 hash), createdAt, xp, level, isAdmin, **isTradeRestricted**, **isTradeProfileHidden**, group, subgroup, inventory{cardId:qty}, packs{packId:qty}, stats, badges, achievements, progression, lastLogin, **researchPoints, seasonalResearchPoints, researchStats{...}**, **lastDirectTradeAt**, **lastListingCreatedAt**, **currencies{currentResearchPoints}**, **cosmetics{owned{...}, equipped{aura,border,title,profileBanner}}**, **items{reroll_token,cosmetic_reroll_token,aura_reroll_token,border_reroll_token,discount_chip,freeze_token,research_proposal}**, **shopUsage{rerollsUsedThisRotation,frozenSlotsUsedThisRotation}**, **shop{currentRotation{slots[{id,itemId,basePrice,currentPrice,currency,frozen,purchased,discountApplied}],generatedAt,refreshAt,generationVersion},rerollResetAt}**, **purchaseHistory[{itemId,purchasedAt,pricePaid,currency,source}]** (max 10), **profileCustomization{featuredCards[],featuredAchievements[]}**, **profileVisibility{isProfileHidden,isCollectionHidden}**
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

### Player-Facing Card Renderer (Phase 3)
- **Unified card structure**: collection grid, pack opening, and detail modal all share the same `card-detail-*` internal HTML (header → art → divider → body). The modal proportions are the visual reference standard.
- **Collection grid**: `renderPlayerCard()` wraps `card-detail-*` internals in a `.sci-card` shell (5:7 aspect ratio, rarity borders, aura visuals, click behavior). CSS overrides (`.sci-card .card-detail-*`) scale down font sizes and padding for grid context. keyFact text uses `.grid-clamp` class for line-clamping.
- **Pack opening**: same `.sci-card` shell + `card-detail-*` internals with reveal animation
- **Detail modal**: `.card-detail-frame` shell (5:7 aspect, 240px max-width) + `card-detail-*` internals at full size + aura tier info section
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

Last verified stable deployment, new commit to note success
### Firebase Integration
- Firebase SDK loaded via CDN (compat builds: App + Database only) in index.html `<head>`
- firebase-config.js: edit the `firebaseConfig` object with your project credentials
- Real-time sync: Firebase → cache via `.on('value')` listener on root
- Offline fallback: localStorage always mirrors the cache as backup
