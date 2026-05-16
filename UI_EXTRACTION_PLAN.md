# UI Extraction Plan — Ownership Boundaries & Risk Analysis

## 1. Current UI Ownership Audit

### ui.js Currently Owns (~4320 lines)

| Subsystem | Lines (approx) | Complexity | Notes |
|---|---|---|---|
| **Screen management** | 1–178 | Low | `showScreen()`, `setupTabs()`, `enterGame()` |
| **Login screen** | 180–265 | Low | Form wiring, session creation |
| **Confirm modal** | 106–133 | Low | Global `confirmAction()` — used by many subsystems |
| **Collection rendering** | 311–416 | Medium | Collection grid, filters, rarity groups, card rendering |
| **Card rendering** | 418–597 | Medium | `renderPlayerCard()`, `showCardDetail()`, constants (CONCEPT_EFFECT_LABELS, CONCEPT_FLAVOR_TEXT) |
| **Pack opening** | 599–797 | Medium | Pack grid, open UI, flip animation, particle reveal |
| **Breakthrough card** | 798–928 | Medium | `_generateBreakthroughCard()`, `showBreakthroughCardReveal()` |
| **Research Projects** | 930–2111 | **HIGH** | List, status bar, weekly pack widget, project cards, assignment panel, report panel, heartbeat, filters, card picker grid, evaluate preview, claim flow |
| **Profile** | 2113–2167 | Low | Stats, rarity progress bars |
| **Admin: Overview** | 2169–2224 | Low | Stats grid, game/registration toggles |
| **Admin: Players** | 2226–2610 | **HIGH** | Player list, filters, player detail modal (group, give card/pack, admin status, trade restriction, password reset, danger zone, inventory, stats) |
| **Admin: Cards** | 2612–2885 | High | Card list, filters, create form, edit modal |
| **Admin: Packs** | 2906–3063 | Medium | Pack list, create form, edit modal |
| **Admin: Groups** | 3065–3216 | Medium | Group list, create, edit modal, subgroup management |
| **Admin: Access** | 3218–3268 | Low | Access code list, generate, copy |
| **Admin: Config** | 3270–3480 | Medium | Dynamic recursive config editor, ownership map |
| **Admin: Balance** | 3482–4007 | **HIGH** | 16-section balance editor, collect values, save/reset |
| **Admin: Trading Controls** | 4148–4281 | Medium | Toggle switches, cooldown inputs, save |
| **Init** | 4283–4321 | Low | Tab setup, modal wiring, session check |

### Already Extracted Modules

| Module | Lines | Owns |
|---|---|---|
| **trade-ui.js** | ~1806 | Trading tab: sub-tabs, direct trades, listings, card pickers, filter bars, cooldown timers, reactive refresh |
| **trade-confirm-modal.js** | ~130 | Sandbox-safe confirmation modal for trade actions |
| **leaderboard-ui.js** | ~200+ | Leaderboard tab: categories, ranking table, season/snapshot selector |
| **leaderboard-admin.js** | ~400+ | Admin Leaderboards sub-tab: season rotation, archive management, snapshots |
| **toast.js** | ~28 | Toast notification utility |

### Global Responsibilities That Should Stay in ui.js

1. **Screen management**: `showScreen()`, `setupTabs()` — tab routing orchestrator
2. **`enterGame()`** — session-to-game transition, nav bar setup
3. **Login screen** — auth form wiring
4. **Init** — bootstrap, modal wiring, filter setup, session restore
5. **`confirmAction()`** — shared confirm modal (used by admin subsystems and potentially future features)
6. **Tab dispatch** — the `switch` in `setupTabs()` and `renderAdminSubTab()` that dispatches to the correct renderer

---

## 2. Natural Subsystem Extraction Boundaries

### A. `project-ui.js` — Research Projects UI (~1180 lines)

**What moves:**
- `_projectHeartbeatId`, `PROJECT_HEARTBEAT_INTERVAL_MS`, `_startProjectHeartbeat()`, `_stopProjectHeartbeat()`
- `_assigningProjectId`, `_viewingReportProjectId`, `_refreshTimerInterval`
- `_renderProjectStatusBar()` (including weekly pack widget)
- `renderResearchProjects()`
- `_renderCardsAvailabilityPanel()`
- `renderProjectCard()`
- `renderProjectReportPanel()` (including claim flow + breakthrough card reveal trigger)
- `renderProjectAssignmentPanel()` (including card picker, filters, preview, activation)
- `_generateBreakthroughCard()` — gameplay logic currently co-located with UI
- `showBreakthroughCardReveal()` — reuses pack overlay DOM

**API surface to export:**
- `renderResearchProjects()` — called by tab dispatch
- `startProjectHeartbeat()` / `stopProjectHeartbeat()` — called by tab switch handler

**Dependencies inbound:**
- `auth`, `player`, `cards`, `packs`, `db`, `toast` — standard service imports
- `project-state.js`, `project-assignment.js`, `project-engine.js`, `project-claiming.js`, `project-config.js`, `project-refresh.js`, `project-sync.js`, `weekly-research-pack.js` — project services
- `research.js` — `addSeasonalResearchPoints()`, `refreshUniqueCardsOwned()`

**Dependencies from ui.js needed:**
- `confirmAction()` — NOT currently used by project UI (projects use toast only)
- `_isPersistentAdmin()` — admin telemetry helper
- `CONCEPT_EFFECT_LABELS` constant — shared with card rendering
- Pack opening overlay DOM (`#pack-opening-overlay`, `#pack-opening-title`, `#pack-opening-cards`) — for breakthrough card reveal
- `spawnRevealParticles()` — for breakthrough card particles

### B. `profile-ui.js` — Profile Tab (~55 lines)

**What moves:**
- `renderProfile()`

**API surface to export:**
- `renderProfile()` — called by tab dispatch

**Dependencies inbound:**
- `auth`, `player`, `cards`, `groups`

**Dependencies from ui.js needed:**
- None (fully self-contained reads)

### C. `admin-ui.js` — Admin Panel (~2100 lines)

**What moves:**
- `renderAdmin()`, `renderAdminSubTab()`
- `renderAdminOverview()`
- `_setupPlayerFilters()`, `renderAdminPlayers()`, `showPlayerDetail()`
- `renderAdminCards()`, `openEditCardModal()`, `setupEditCardModal()`
- `renderAdminPacks()`, `openEditPackModal()`, `setupEditPackModal()`, `updateEditPackOddsTotal()`
- `renderAdminGroups()`, `openGroupEditModal()`, `renderGroupEditSubgroups()`
- `renderAdminAccess()`, `refreshAccessCodeGroupDropdown()`
- `renderAdminConfig()`, `ADMIN_CONFIG_SECTIONS`, `_isOwnedByAdminSection()`, `buildConfigEditor()`, `buildFieldInput()`
- `renderAdminBalance()`, `collectBalanceValues()`
- `renderAdminTradingControls()`
- `updateImagePreview()` — shared utility used by card create/edit

**API surface to export:**
- `renderAdmin()` — called by tab dispatch
- `renderAdminSubTab(tab)` — called by admin sub-tab handler
- `setupEditCardModal()` — called once in `init()`
- `setupEditPackModal()` — called once in `init()`

**Dependencies from ui.js needed:**
- `confirmAction()` — heavily used by destructive admin actions
- `renderAdminSeasons()` — imported from `leaderboard-admin.js` (pass-through)
- `_isPersistentAdmin()` — optional, only used by card rendering in admin context

### D. `shop-ui.js` (Future) — Clean Boundary

Would own its own tab content. No existing code to extract — purely additive.

### E. Shared Systems (Keep in ui.js or extract to dedicated helpers)

| Shared item | Current location | Extraction recommendation |
|---|---|---|
| `confirmAction()` | ui.js line 112 | **Keep in ui.js** — small, globally used, low risk to move |
| `_isPersistentAdmin()` | ui.js line 101 | **Keep in ui.js** — copy to extracted modules as needed (3 lines) |
| `CONCEPT_EFFECT_LABELS` | ui.js line 428 | **Move to cards.js** as a data constant, or duplicate in project-ui.js |
| `CONCEPT_FLAVOR_TEXT` | ui.js line 436 | **Same as above** |
| `renderPlayerCard()` | ui.js line 445 | **Keep in ui.js** — used by Collection, which stays in ui.js |
| `showCardDetail()` | ui.js line 508 | **Keep in ui.js** — used by Collection |
| `spawnRevealParticles()` | ui.js line 746 | **Keep in ui.js** — used by pack opening (stays) and breakthrough (project-ui imports it) |
| `showBreakthroughCardReveal()` | ui.js line 858 | **Move to project-ui.js** — only caller is claim flow |
| Pack overlay DOM | index.html | **Shared** — both pack opening and breakthrough use `#pack-opening-overlay` |

---

## 3. Coupling Risks

### RISK 1: Breakthrough Card Reveal ↔ Pack Opening Overlay (HIGH)
- `showBreakthroughCardReveal()` reuses the pack opening overlay (`#pack-opening-overlay`, `#pack-opening-cards`, `#pack-opening-title`)
- The close button is wired in `init()` generically
- **Mitigation:** project-ui.js can import `spawnRevealParticles()` from ui.js and reference the same DOM IDs. Pack overlay is a shared resource, not owned by either subsystem. This works fine as long as both modules reference by ID (no element caching).

### RISK 2: `_isPersistentAdmin()` (LOW)
- 3-line helper used in project UI (telemetry), admin UI (overview), and card rendering
- **Mitigation:** Duplicate as a local helper in extracted modules, or export from ui.js. Not worth abstracting into a shared module.

### RISK 3: CONCEPT_EFFECT_LABELS / CONCEPT_FLAVOR_TEXT (MEDIUM)
- Used by `renderPlayerCard()` (collection), `showCardDetail()` (collection), `_renderCardsAvailabilityPanel()` (project UI), `renderProjectAssignmentPanel()` (project UI)
- **Mitigation:** Move to `cards.js` as exported constants (natural home for card display metadata). Both ui.js and project-ui.js import from there.

### RISK 4: `confirmAction()` Dependency in Admin UI (HIGH)
- Used by ~12 destructive admin actions (delete player, delete card, delete pack, delete group, etc.)
- **Mitigation:** Either (a) export `confirmAction()` from ui.js so admin-ui.js can import it, or (b) extract to a tiny `confirm-modal.js` module. Option (a) is simpler and avoids new files.

### RISK 5: Project Heartbeat Lifecycle ↔ Tab Switch Handler (MEDIUM)
- `_startProjectHeartbeat()` / `_stopProjectHeartbeat()` are called inside `setupTabs()` click handler
- **Mitigation:** project-ui.js exports start/stop. Tab handler in ui.js calls them. Clean contract.

### RISK 6: `renderAdminSubTab()` Dispatch (LOW)
- Currently a `switch` statement in ui.js. After extraction, admin-ui.js owns this function.
- The tab handler in ui.js calls `renderAdminSubTab(tab)` — needs to be imported.
- **Mitigation:** ui.js imports `renderAdminSubTab` from admin-ui.js. Clean.

### RISK 7: `_generateBreakthroughCard()` is Business Logic in UI (MEDIUM)
- This function generates a random card using pack pipeline logic. It lives in ui.js because it's called during the claim flow rendering.
- **Mitigation:** Move to project-ui.js along with the claim flow. Alternatively, move to a service module (e.g., project-claiming.js) — but that changes API surface. Extraction-first approach: keep it in project-ui.js for now.

### RISK 8: `setupEditCardModal()` / `setupEditPackModal()` Called in `init()` (LOW)
- These wire one-time event listeners in `init()`. After extracting admin-ui.js, `init()` needs to call them.
- **Mitigation:** admin-ui.js exports an `initAdmin()` function that ui.js calls during `init()`.

### RISK 9: DOM ID Ownership Overlap (LOW)
- All DOM containers are pre-defined in index.html with unique IDs
- Each subsystem renders into its own container (`#tab-research-projects`, `#tab-profile`, `#tab-admin`)
- No overlap — clean boundary

### RISK 10: CSS Assumptions (LOW)
- All CSS classes are global (style.css + Tailwind)
- No module-scoped CSS
- Extraction doesn't change class names — no CSS risk

### RISK 11: Trading Tab Cleanup on Tab Switch (LOW)
- `cleanupTrading()` is called in `setupTabs()`. Already imported from trade-ui.js.
- Pattern already proven — same approach for project heartbeat.

---

## 4. Recommended Extraction Order — Evaluation

### Proposed: Phase 1 → project-ui.js | Phase 2 → profile-ui.js | Phase 3 → admin-ui.js | Phase 4 → shop backend | Phase 5 → shop-ui.js

**Evaluation:**

| Phase | Module | Lines | Risk | Dependencies on ui.js | Verdict |
|---|---|---|---|---|---|
| **1** | project-ui.js | ~1180 | Medium | `spawnRevealParticles`, `CONCEPT_EFFECT_LABELS`, `_isPersistentAdmin` | **Correct first choice.** Largest player-facing subsystem, well-bounded by DOM ownership (`#tab-research-projects`), has its own heartbeat lifecycle, and reducing it makes subsequent work easier. Prerequisite: move CONCEPT_EFFECT_LABELS to cards.js first (tiny prep step). |
| **2** | profile-ui.js | ~55 | **Trivial** | None | **Correct second choice.** Zero coupling, fast win. Could even be done in Phase 1 as a warm-up. |
| **3** | admin-ui.js | ~2100 | Medium-High | `confirmAction`, `renderAdminSeasons` (import passthrough), `_isPersistentAdmin` | **Correct third choice.** Large extraction, many internal wiring points, but entirely admin-scoped. Most complex extraction. Benefits from ui.js being smaller by then. |
| **4** | Shop backend/services | N/A | Low | None — new code | **Correct.** Build services before UI. |
| **5** | shop-ui.js | N/A | Low | Standard tab dispatch | **Correct.** Additive, follows established patterns. |

**Verdict: The proposed order is appropriate and safe.** No changes recommended.

**Optional acceleration:** Profile is so small it could be extracted alongside Phase 1 with zero additional risk.

---

## 5. Ownership Philosophy — HIGH-LEVEL Recommendations

### What should remain in ui.js long-term:
- **Screen management** — `showScreen()`, `setupTabs()`, `enterGame()`
- **Login screen** — auth form wiring
- **Tab dispatch routing** — the central `if/switch` that routes tab clicks to feature renderers
- **Collection tab** — rendering + filters (unless collection grows significantly)
- **Pack opening UI** — rendering + animations
- **Card rendering** — `renderPlayerCard()`, `showCardDetail()` (shared by collection + pack opening)
- **`confirmAction()`** — global confirm modal
- **`init()`** — bootstrap orchestrator
- **Shared reveal helpers** — `spawnRevealParticles()` (used by pack opening + breakthrough)

### What belongs inside feature UI modules:
- **All rendering/wiring for a specific tab's content** — the feature module owns its DOM container contents
- **Feature-local state** — e.g., `_assigningProjectId` in project-ui, `_activeSubTab` in trade-ui
- **Feature-local timers/intervals** — e.g., project heartbeat, trade cooldown ticker
- **Feature-local reactive refresh helpers** — e.g., `refreshIncomingTradesSection` in trade-ui
- **Feature-scoped admin sub-tabs** (eventually) — e.g., balance editor could live in project-admin-ui.js

### What should stay globally shared:
- **Service modules** — `auth`, `player`, `cards`, `packs`, `groups`, `config`, `db`, `toast`
- **`confirmAction()`** — until/unless a dedicated `confirm-modal.js` is warranted
- **Card data constants** — `CONCEPT_EFFECT_LABELS`, `RARITY_COLORS`, etc. → belong in `cards.js`
- **DOM IDs in index.html** — stable contract between HTML and JS modules

### What should NOT be prematurely abstracted:
- **A "shared UI helpers" module** — don't create `ui-helpers.js` or `shared-ui.js` prematurely. Small helpers (3-5 lines) can be duplicated across 2 modules without harm.
- **A generic "modal system"** — `confirmAction()` and `showTradeConfirmModal()` serve different purposes. Don't unify them into a modal framework yet.
- **A "card renderer" module** — `renderPlayerCard()` is tightly coupled to collection grid logic. Don't extract it until a second consumer (e.g., shop) actually needs it.
- **An event bus / pub-sub system** — direct imports work. Don't add indirection unless you have 3+ modules that need to coordinate without knowing about each other.
- **Admin sub-module splitting** — don't split admin-ui.js into admin-players-ui.js, admin-cards-ui.js, etc. until admin-ui.js itself exceeds ~800 lines (it will be ~2100, so it *may* want splitting — but do Phase 3 as a single extraction first, then evaluate).

---

## 6. Extraction Checklist Template (Per Phase)

For each extraction:

1. **Prep:** Move shared constants to their natural home (e.g., CONCEPT_EFFECT_LABELS → cards.js)
2. **Extract:** Create new module, move functions, add exports
3. **Wire:** Update ui.js imports and tab dispatch to call into new module
4. **Verify:** All tab transitions work, no console errors, no visual regressions
5. **Cleanup:** Remove dead code from ui.js, update ARCHITECTURE.md

---

*This document is a planning artifact. No code changes have been made.*
