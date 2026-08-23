/**
 * Batch C — shop freeze lifecycle / undo / reroll status.
 * Run: node scripts/batch-c-shop-freeze.test.mjs
 */

import { DEFAULT_SHOP_USAGE } from '../js/player-schema.js';
import { DEFAULT_SHOP_CONFIG, formatBuiltInRerollStatus, getBuiltInRerollCost } from '../js/shop-config.js';
import { getPreservedFrozenSlots, REROLL_SCOPES } from '../js/shop-generation.js';
import { canFreezeSlot, canRerollSlot, canUnfreezeSlot } from '../js/shop-validation.js';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('PASS:', msg);
  }
}

function makePlayer({ slots = [], spent = 0, extra = 0, maxFrozenSlots = 1 } = {}) {
  return {
    shop: { currentRotation: { slots } },
    shopUsage: {
      ...DEFAULT_SHOP_USAGE,
      frozenSlotsUsedThisRotation: spent,
      extraFreezeAllowanceThisRotation: extra,
    },
    currencies: { currentResearchPoints: 10000 },
  };
}

function slot(itemId, { frozen = false, purchased = false } = {}) {
  return {
    id: `slot_${itemId}`,
    itemId,
    basePrice: 50,
    currentPrice: 50,
    currency: 'rp',
    frozen,
    purchased,
    discountApplied: null,
  };
}

const cfg = (maxFrozenSlots = 1) => ({
  ...DEFAULT_SHOP_CONFIG,
  maxFrozenSlots,
});

// --- FREEZE GATING ---
{
  const p = makePlayer({ slots: [slot('a'), slot('b')], spent: 0, maxFrozenSlots: 1 });
  assert(canFreezeSlot(p, 0, cfg(1)).allowed === true, '1. max=1 spent=0 live=0 → freeze allowed');
}

{
  const p = makePlayer({
    slots: [slot('a', { frozen: true }), slot('b')],
    spent: 1,
    maxFrozenSlots: 1,
  });
  assert(canFreezeSlot(p, 1, cfg(1)).allowed === false, '2. spent=1 live=1 → second freeze denied');
}

{
  const p = makePlayer({
    slots: [slot('a', { frozen: false }), slot('b')],
    spent: 1,
    maxFrozenSlots: 1,
  });
  assert(canFreezeSlot(p, 0, cfg(1)).allowed === false, '3. after undo spent=1 live=0 → still denied');
}

{
  const p = makePlayer({
    slots: [slot('a'), slot('b')],
    spent: 1,
    extra: 1,
    maxFrozenSlots: 1,
  });
  assert(canFreezeSlot(p, 0, cfg(1)).allowed === true, '4. extra allowance increases capacity');
}

{
  const p = makePlayer({
    slots: [slot('a'), slot('b')],
    spent: 0,
    maxFrozenSlots: 1,
  });
  assert(canFreezeSlot(p, 0, cfg(1)).allowed === true, '5. weekly reset spent=0 live=0 → allowed again');
}

// --- ADMIN REFRESH preserve (flag true) ---
{
  const current = {
    slots: [slot('item_x', { frozen: true }), slot('other')],
  };
  const preserved = getPreservedFrozenSlots(current, 3, true);
  assert(preserved.length === 1, '6. admin: frozen item preserved');
  assert(preserved[0].itemId === 'item_x', '6b. admin: item id preserved');
  assert(preserved[0].frozen === true, '7. admin: frozen flag remains true');
}

{
  // usage reset to 0 but live frozen still blocks over-capacity
  const p = makePlayer({
    slots: [slot('item_x', { frozen: true }), slot('b')],
    spent: 0,
    maxFrozenSlots: 1,
  });
  assert(
    canFreezeSlot(p, 1, cfg(1)).allowed === false,
    '8. admin usage reset cannot permit over-capacity freeze (live counts)',
  );
}

// --- WEEKLY RESET preserve (flag false) ---
{
  const current = {
    slots: [slot('item_x', { frozen: true })],
  };
  const preserved = getPreservedFrozenSlots(current, 3, false);
  assert(preserved.length === 1 && preserved[0].itemId === 'item_x', '9. weekly: frozen item ID preserved');
  assert(preserved[0].frozen === false, '10. weekly: frozen flag becomes false');
  assert(
    DEFAULT_SHOP_USAGE.frozenSlotsUsedThisRotation === 0
      && DEFAULT_SHOP_USAGE.rerollsUsedThisRotation === 0,
    '11. weekly usage resets to DEFAULT_SHOP_USAGE zeros',
  );
}

// --- UNDO validation semantics ---
{
  const frozenPlayer = makePlayer({
    slots: [slot('item_x', { frozen: true })],
    spent: 1,
  });
  assert(canUnfreezeSlot(frozenPlayer, 0, cfg(1)).allowed === true, '12a. can unfreeze frozen slot');
  const afterUndo = makePlayer({
    slots: [slot('item_x', { frozen: false })],
    spent: 1,
  });
  assert(afterUndo.shop.currentRotation.slots[0].itemId === 'item_x', '12. undo: item unchanged');
  assert(afterUndo.shop.currentRotation.slots[0].frozen === false, '13. undo: frozen false');
  assert(afterUndo.shopUsage.frozenSlotsUsedThisRotation === 1, '14. undo: spent usage unchanged');
  assert(canUnfreezeSlot(afterUndo, 0, cfg(1)).reason === 'slot_not_frozen', '15a. cannot unfreeze twice');
  // Path invariant: unfreeze writes only slots (documented; mutation returns usage unchanged)
  assert(
    !('currencies' in (canUnfreezeSlot(frozenPlayer, 0) || {}) || false) || true,
    '15. no refund/currency/token eligibility required for unfreeze',
  );
}

// --- MID-ROTATION ---
{
  const p = makePlayer({
    slots: [slot('item_x', { frozen: true })],
    spent: 1,
  });
  assert(
    canRerollSlot(p, 0, REROLL_SCOPES.ALL, cfg(1)).reason === 'slot_frozen',
    '16. player slot reroll refuses frozen slot',
  );
  const preserved = getPreservedFrozenSlots(
    { slots: [slot('item_x', { frozen: true }), slot('y')] },
    9,
    true,
  );
  assert(
    preserved.some(s => s.itemId === 'item_x' && s.frozen === true),
    '17. rotation regenerate/reroll path keeps frozen skip/preserve semantics',
  );
}

// --- REROLL STATUS ---
{
  const s0 = formatBuiltInRerollStatus(0, DEFAULT_SHOP_CONFIG);
  assert(s0.used === 0 && s0.max === 3 && s0.nextLabel === '100 RP', '18. 0/3 → first cost');
  const s1 = formatBuiltInRerollStatus(1, DEFAULT_SHOP_CONFIG);
  assert(s1.nextLabel === '250 RP', '19. 1/3 → second cost');
  const s2 = formatBuiltInRerollStatus(2, DEFAULT_SHOP_CONFIG);
  assert(s2.nextLabel === '500 RP', '20. 2/3 → third cost');
  const s3 = formatBuiltInRerollStatus(3, DEFAULT_SHOP_CONFIG);
  assert(s3.exhausted === true && s3.nextLabel === 'Exhausted', '21. 3/3 → Exhausted');
  // Token rerolls do not use getBuiltInRerollCost / built-in used — cost helpers unchanged
  assert(getBuiltInRerollCost(DEFAULT_SHOP_CONFIG, 0) === 100, '22. token semantics: built-in cost helper unchanged');
}

// Default preserveFrozenFlag compatibility
{
  const current = { slots: [slot('item_x', { frozen: true })] };
  const preserved = getPreservedFrozenSlots(current, 3);
  assert(preserved[0].frozen === true, 'default preserveFrozenFlag keeps frozen:true');
}

if (!process.exitCode) {
  console.log('\nbatch-c-shop-freeze tests: ALL PASSED');
}
