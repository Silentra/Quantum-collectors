/**
 * Trading composer preservation (background refresh must not wipe drafts).
 * Run: node scripts/trading-composer-preserve.test.mjs
 */

import {
  decideGroupListingsScopeUiAction,
  evaluateDirectTradeComposerActive,
  evaluateListingComposerActive,
} from '../js/trade-ui.js';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('PASS:', msg);
  }
}

// --- GROUP SCOPE ---
{
  const same = decideGroupListingsScopeUiAction({
    previousGroup: 'g1',
    myGroup: 'g1',
  });
  assert(same.fullRender === false && same.clearComposer === false, '1. same-group → no full render');
  assert(same.reason === 'same-group-reensure', '1b. same-group reason');

  const change = decideGroupListingsScopeUiAction({
    previousGroup: 'g1',
    myGroup: 'g2',
  });
  assert(change.fullRender === true && change.clearComposer === true, '2. real group change → full render');

  const nulled = decideGroupListingsScopeUiAction({
    previousGroup: 'g1',
    myGroup: null,
  });
  assert(nulled.fullRender === true && nulled.clearComposer === true, '2b. group null → full render');

  // Critical: result.ok must NOT be part of the decision (regression of smoking gun)
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../js/trade-ui.js', import.meta.url), 'utf8'),
  );
  assert(
    !src.includes('previousGroup !== myGroup || result.ok'),
    '1c. smoking-gun || result.ok removed',
  );
  assert(src.includes('decideGroupListingsScopeUiAction'), '1d. uses shared decision helper');
}

// --- DIRECT COMPOSER ACTIVE ---
{
  assert(evaluateDirectTradeComposerActive({ selectedTarget: 'bob' }) === true, '3. partner → active');
  assert(evaluateDirectTradeComposerActive({ offeredCardId: 'c1' }) === true, '3b. offered → active');
  assert(evaluateDirectTradeComposerActive({ pickersVisible: true }) === true, '3c. pickers → active');
  assert(evaluateDirectTradeComposerActive({ offeredSelectValue: 'c1' }) === true, '3d. select value → active');
  assert(evaluateDirectTradeComposerActive({ confirmVisible: true }) === true, '3e. confirm → active');
  assert(evaluateDirectTradeComposerActive({}) === false, '3f. empty → inactive');
}

// --- LISTING COMPOSER ACTIVE ---
{
  assert(evaluateListingComposerActive({ offeredCardId: 'c1' }) === true, '7. offered → active');
  assert(
    evaluateListingComposerActive({ requestedCardIds: ['a'] }) === true,
    '8. requested-only → active',
  );
  assert(
    evaluateListingComposerActive({ offeredCardId: 'c1', requestedCardIds: ['a', 'b'] }) === true,
    '9. offered+requested → active',
  );
  assert(evaluateListingComposerActive({ filterSearch: 'newton' }) === true, '10. search filter → active');
  assert(evaluateListingComposerActive({ filterType: 'scientist' }) === true, '10b. type filter → active');
  assert(evaluateListingComposerActive({ filterSort: 'qty_desc' }) === true, '10c. sort → active');
  assert(evaluateListingComposerActive({ filterSort: 'default' }) === false, '10d. default sort alone → inactive');
  assert(evaluateListingComposerActive({}) === false, '10e. empty → inactive');
}

// --- SOURCE GUARDS (preservation wiring present) ---
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../js/trade-ui.js', import.meta.url), 'utf8');
  assert(src.includes('_isDirectTradeComposerActive'), 'direct helper present');
  assert(src.includes('_isListingComposerActive'), 'listing helper present');
  assert(src.includes('_listingComposerDraft'), 'listing draft module state');
  assert(src.includes('_restoreListingComposerAfterRefresh'), 'listing restore after refresh');
  assert(src.includes('preserve-composer'), 'directory preserve debug path');
  assert(src.includes('_setDirectPartnerInvalid'), 'partner invalidation without destroy');
  assert(src.includes('_directPartnerInvalidReason'), 'submit checks invalid partner');
  assert(src.includes('refresh-with-composer-restore') || src.includes('rebuild-with-restore'), 'listing restore logging');
  // Successful send still clears
  assert(src.includes('_clearDirectComposerState()'), '11/12 intentional clear helper used');
  assert(src.includes('_clearListingComposerDraft()'), '13 listing clear on success/full render');
}

if (!process.exitCode) {
  console.log('\nAll trading composer preserve tests passed.');
} else {
  console.error('\nTrading composer preserve tests failed.');
}
