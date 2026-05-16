# Phase 2A — Player Persistence Schema Expansion

## Status: COMPLETE

## What Was Completed

All 7 schema subsystems added to player persistence with full backward-compatible migration:

1. **currencies** — `{ currentResearchPoints: 0 }`
2. **cosmetics** — `{ owned: { profile_banner_default: true }, equipped: { aura: 'default_prismatic', border: null, title: null, profileBanner: 'profile_banner_default' } }`
3. **items** — 7 consumable slots (reroll_token, cosmetic_reroll_token, aura_reroll_token, border_reroll_token, discount_chip, freeze_token, research_proposal), all default 0
4. **shopUsage** — `{ rerollsUsedThisRotation: 0, frozenSlotsUsedThisRotation: 0 }`
5. **purchaseHistory** — `[]` capped at 10 entries with rolling overwrite
6. **profileCustomization** — `{ featuredCards: [], featuredAchievements: [] }`
7. **profileVisibility** — `{ isProfileHidden: false, isCollectionHidden: false }`

## Files Changed

| File | Change |
|---|---|
| `js/player-schema.js` | **NEW** — Frozen defaults, `getPhase2ADefaults()`, `normalizePlayerSchema()`, `migrateAllPlayersPhase2A()`, `normalizePurchaseHistory()` |
| `js/auth.js` | Import player-schema. Spread Phase 2A defaults into `createPlayerRecord()`. Call `normalizePlayerSchema()` on login + session restore |
| `main.js` | Import + call `migrateAllPlayersPhase2A()` at startup step 4f |
| `ARCHITECTURE.md` | Added player-schema.js to file map, expanded DB schema, added Phase 2A documentation section |

## Migration Safety

- All additions backward compatible — missing fields safely initialized with defaults
- Never overwrites existing valid data
- Handles Firebase array→object conversion (purchaseHistory, featuredCards, featuredAchievements)
- Idempotent — safe to run multiple times
- Three migration entry points: startup bulk migration, login backfill, session restore backfill

## Boundary Compliance

- ✅ No UI files modified (ui.cleaned.js, profile-ui.js, shop-ui.js untouched)
- ✅ No gameplay logic introduced
- ✅ No Firebase mutation flows added
- ✅ No consumable execution logic
- ✅ No shop generation
- ✅ No project systems modified
- ✅ No admin UI modified
- ✅ Cosmetic aura (`default_prismatic`) fully separate from gameplay aura system

## What Remains (Not Part of Phase 2A)

Phase 2A is persistence-only. Future phases will build on this schema:

- **Shop UI / generation** — wire shop-ui.js to read from items/shopUsage/currencies
- **Purchase mutation logic** — Firebase write flows for buying items, spending currencies
- **Consumable execution** — use logic for reroll tokens, freeze tokens, etc.
- **Cosmetic rendering** — wire cosmetics.equipped into card rendering pipeline
- **Profile UI** — wire profileCustomization and profileVisibility into profile-ui.js
- **Purchase history recording** — append entries during purchase flows

## Recommended Next Step

The user's phased approach suggests the next step would be **Phase 2B** (or whatever the user defines) — likely wiring shop generation, currency mutation logic, or cosmetic rendering. Wait for user direction on which subsystem to activate first.
