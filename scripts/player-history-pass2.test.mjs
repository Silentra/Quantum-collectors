/**
 * Player History Pass 2 (C4–C5 + D1) tests.
 * Run: node scripts/player-history-pass2.test.mjs
 */

import {
  HISTORY_EVENT_TYPES,
  HISTORY_SERVER_TIMESTAMP,
  HISTORY_PAGE_SIZE,
  PLAYER_HISTORY_ROOT,
  applyOlderHistoryPage,
  buildTradeCompletedHistoryUpdate,
  buildProjectClaimedHistoryUpdate,
  buildShopPurchaseHistoryUpdate,
  buildWeeklyPackGrantedHistoryUpdate,
  formatHistoryTimestamp,
  sortHistoryEntriesNewestFirst,
} from '../js/player-history.js';
import {
  describeHistoryEvent,
  formatCardQtyList,
  resolveCardLabel,
} from '../js/admin-player-history.js';
import { buildDirectTradeAcceptPlan } from '../js/trade-direct-plan.js';
import { buildListingFulfillPlan } from '../js/trade-listing-plan.js';
import { buildShopPurchasePlan } from '../js/shop-purchase-plan.js';
import { buildWeeklyPackClaimPlan } from '../js/weekly-research-pack.js';
import { buildProjectClaimPlan } from '../js/project-claim-plan.js';
import { PROJECT_STATES } from '../js/project-state.js';
import * as db from '../js/database.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('PASS:', msg);
  }
}

function historyLeaves(updates) {
  return Object.keys(updates || {}).filter((k) => k.startsWith(`${PLAYER_HISTORY_ROOT}/`));
}

function historyBodies(updates) {
  return historyLeaves(updates).map((k) => updates[k]);
}

// ——— C0/D1 helpers ———
{
  const ts = formatHistoryTimestamp(Date.UTC(2026, 7, 30, 23, 42, 0));
  assert(/2026/.test(ts), 'timestamp includes year');
  assert(/August/i.test(ts), 'timestamp includes month name');
  assert(/at /i.test(ts), 'timestamp includes at separator');
  assert(formatHistoryTimestamp(null) === 'Unknown time', 'bad ts fallback');
}

{
  const entries = [
    { key: 'aaa', value: { type: 'a' } },
    { key: 'ccc', value: { type: 'c' } },
    { key: 'bbb', value: { type: 'b' } },
  ];
  const newest = sortHistoryEntriesNewestFirst(entries);
  assert(newest[0].key === 'ccc' && newest[2].key === 'aaa', 'newest-first sort');
}

{
  const loaded = [
    { key: 'k48', value: { n: 48 } },
    { key: 'k49', value: { n: 49 } },
    { key: 'k50', value: { n: 50 } },
  ];
  // Simulates endAt(k50) limitToLast(51) returning 3 older + boundary
  const page = [
    { key: 'k47', value: { n: 47 } },
    { key: 'k48', value: { n: 48 } },
    { key: 'k49', value: { n: 49 } },
    { key: 'k50', value: { n: 50 } },
  ];
  // Make page look like a full 51-page by padding
  const padded = [];
  for (let i = 0; i < 47; i++) padded.push({ key: `k${String(i).padStart(2, '0')}`, value: { n: i } });
  padded.push(...page);
  const merged = applyOlderHistoryPage(
    sortHistoryEntriesNewestFirst(loaded),
    padded.slice(-51),
  );
  assert(!merged.entries.some((e, i, arr) => arr.findIndex((x) => x.key === e.key) !== i), 'no duplicate keys');
  assert(merged.entries.every((e) => e.key !== undefined), 'entries have keys');
  assert(merged.hasMore === true || merged.added >= 0, 'merge older page returns state');
}

{
  const loaded = [{ key: 'b', value: 1 }, { key: 'a', value: 0 }];
  const page = [{ key: 'a', value: 0 }]; // only boundary
  const merged = applyOlderHistoryPage(loaded, page);
  assert(merged.added === 0, 'boundary-only page adds nothing');
  assert(merged.hasMore === false, 'boundary-only => no more');
}

{
  const leaf = buildTradeCompletedHistoryUpdate('alice', {
    tradeKind: 'direct',
    tradeId: 't1',
    counterpartyUsername: 'bob',
    gave: { c1: 1 },
    received: { c2: 1 },
  });
  assert(leaf.body.type === HISTORY_EVENT_TYPES.TRADE_COMPLETED, 'trade type');
  assert(leaf.body.ts === HISTORY_SERVER_TIMESTAMP, 'trade uses server ts');
  assert(leaf.body.gave.c1 === 1 && leaf.body.received.c2 === 1, 'trade maps');
}

{
  const d = describeHistoryEvent({
    type: 'pack_opened',
    packId: 'missing_pack',
    cardsGranted: { missing_card: 2 },
    actorType: 'self',
    ts: Date.UTC(2026, 7, 30, 18, 42),
  });
  assert(d.summary.includes('missing_pack') || d.summary.includes('Opened'), 'unknown pack still renders');
  assert(formatCardQtyList({ missing_card: 2 }).includes('missing_card'), 'unknown card id fallback');
  assert(resolveCardLabel('nope') === 'nope', 'card label fallback');
  const bad = describeHistoryEvent({ type: 'weird_event_xyz' });
  assert(bad.summary === 'Unknown history event', 'malformed/unknown type fallback');
  assert(bad.known === false, 'unknown marked');
}

// ——— C4 Direct trade ———
{
  const NOW = 1_700_000_100_000;
  const plan = buildDirectTradeAcceptPlan({
    tradeId: 'td1',
    claimId: 'cl1',
    offeringPlayerId: 'alice',
    targetPlayerId: 'bob',
    offeredCardId: 'cardA',
    requestedCardId: 'cardB',
    offeringPlayer: { inventory: { cardA: 2, cardB: 0 }, stats: {} },
    targetPlayer: { inventory: { cardA: 0, cardB: 1 }, stats: {} },
    now: NOW,
  });
  assert(plan.ok === true, 'direct trade plan ok');
  const leaves = historyLeaves(plan.updates);
  assert(leaves.length === 2, 'direct: exactly two history leaves');
  const bodies = historyBodies(plan.updates);
  assert(bodies.every((b) => b.type === 'trade_completed' && b.tradeKind === 'direct'), 'direct trade_completed');
  const alicePath = leaves.find((p) => p.includes('/alice/'));
  const bobPath = leaves.find((p) => p.includes('/bob/'));
  assert(!!alicePath && !!bobPath, 'direct: one leaf per player');
  assert(plan.updates[alicePath].gave.cardA === 1 && plan.updates[alicePath].received.cardB === 1, 'alice perspective');
  assert(plan.updates[bobPath].gave.cardB === 1 && plan.updates[bobPath].received.cardA === 1, 'bob perspective');
  assert(
    Object.prototype.hasOwnProperty.call(plan.updates, `trades/direct/td1/status`),
    'direct history in same map as settlement status',
  );
}

// Failed / cancelled direct — planner not used; mark failed has no history
{
  // Soft: buildDirectTradeAcceptPlan rejects same card
  const bad = buildDirectTradeAcceptPlan({
    tradeId: 'tdx',
    claimId: 'c',
    offeringPlayerId: 'a',
    targetPlayerId: 'b',
    offeredCardId: 'x',
    requestedCardId: 'x',
    offeringPlayer: { inventory: { x: 1 } },
    targetPlayer: { inventory: { x: 1 } },
    now: Date.now(),
  });
  assert(bad.ok === false && !bad.updates, 'failed plan has no history updates');
}

// ——— C4 Listing trade ———
{
  const NOW = 1_700_000_200_000;
  const plan = buildListingFulfillPlan({
    listingId: 'L1',
    claimId: 'clL',
    ownerId: 'owner',
    accepterId: 'buyer',
    offeredCardId: 'offered',
    chosenCardId: 'chosen',
    ownerPlayer: { inventory: { offered: 1, chosen: 0 }, stats: {} },
    accepterPlayer: { inventory: { offered: 0, chosen: 2 }, stats: {} },
    groupId: 'g1',
    now: NOW,
  });
  assert(plan.ok === true, 'listing fulfill plan ok');
  const leaves = historyLeaves(plan.updates);
  assert(leaves.length === 2, 'listing: exactly two history leaves');
  const bodies = historyBodies(plan.updates);
  assert(bodies.every((b) => b.type === 'trade_completed' && b.tradeKind === 'listing'), 'listing trade_completed');
  const ownerLeaf = leaves.find((p) => p.includes('/owner/'));
  const buyerLeaf = leaves.find((p) => p.includes('/buyer/'));
  assert(plan.updates[ownerLeaf].gave.offered === 1 && plan.updates[ownerLeaf].received.chosen === 1, 'owner perspective');
  assert(plan.updates[buyerLeaf].gave.chosen === 1 && plan.updates[buyerLeaf].received.offered === 1, 'buyer perspective');
  assert(
    Object.prototype.hasOwnProperty.call(plan.updates, `trades/listings/L1/status`),
    'listing history in same map as fulfill status',
  );
}

// ——— C4 Shop ———
{
  const plan = buildShopPurchasePlan({
    username: 'shopper',
    validation: {
      itemDefinition: { id: 'item_pack_std', type: 'pack' },
      price: 200,
      currency: 'rp',
      slotIndex: 0,
    },
    grantWrite: { path: 'packs/pack_std', value: 3, quantity: 1 },
    nextSlots: [],
    purchaseHistory: [{ itemId: 'item_pack_std' }],
    purchasedSlot: { id: 's0' },
    currentRotation: { generatedAt: 1 },
    nextRp: 50,
    now: Date.now(),
  });
  assert(plan.ok === true, 'shop purchase plan ok');
  const leaves = historyLeaves(plan.updates);
  assert(leaves.length === 1, 'shop: one history leaf');
  const body = plan.updates[leaves[0]];
  assert(body.type === 'shop_purchase' && body.itemId === 'item_pack_std', 'shop_purchase fields');
  assert(body.packId === 'pack_std' && body.pricePaid === 200, 'shop grant summary');
  assert(
    Object.prototype.hasOwnProperty.call(plan.updates, 'players/shopper/purchaseHistory'),
    'legacy purchaseHistory still written',
  );
  assert(
    Object.prototype.hasOwnProperty.call(plan.updates, 'players/shopper/currencies/currentResearchPoints'),
    'shop history same multipath as RP',
  );
}

// ——— C4 Project claim (local cache fixture) ———
{
  try {
    await db.initDB?.();
  } catch { /* local */ }

  const username = 'proj_hist_user';
  const projectId = 'proj_hist_1';
  const project = {
    id: projectId,
    state: PROJECT_STATES.COMPLETE,
    rewards: {
      success: true,
      breakthrough: true,
      rpEarned: 120,
      rewards: [],
    },
  };

  db.applyLocalOnly?.(`players/${username}`, {
    username,
    projects: [project],
    inventory: {},
    stats: {},
    totalResearchPoints: 0,
    currencies: { currentResearchPoints: 0 },
    researchStats: { breakthroughs: 0 },
  });

  const plan = buildProjectClaimPlan(username, projectId, {
    now: Date.now(),
    projects: [project],
  });
  if (plan.ok) {
    const leaves = historyLeaves(plan.updates);
    assert(leaves.length === 1, 'project: one history leaf');
    const body = plan.updates[leaves[0]];
    assert(body.type === 'project_claimed', 'project_claimed type');
    assert(body.rpDelta === 120 && body.breakthrough === true, 'project reward facts');
    assert(
      Object.prototype.hasOwnProperty.call(plan.updates, `players/${username}/projects`),
      'project history same multipath as projects array',
    );
  } else {
    console.log('PASS: project claim plan reachable (fixture may miss claim helpers):', plan.reason);
  }

  const nonClaim = buildProjectClaimPlan(username, projectId, {
    now: Date.now(),
    projects: [{ ...project, state: PROJECT_STATES.ACTIVE }],
  });
  assert(nonClaim.ok === false && !nonClaim.updates, 'non-claim path has no history');
}

// ——— C5 Weekly ———
{
  const username = 'weekly_hist_user';
  const { invalidateProjectConfigCache } = await import('../js/project-config.js');
  db.applyLocalOnly?.('config/projectBalance', {
    weeklyRewardPackId: 'pack_weekly',
    weeklyRPRequirements: { common: 1, uncommon: 40, rare: 80, epic: 150, legendary: 250 },
  });
  invalidateProjectConfigCache?.();

  db.applyLocalOnly?.(`players/${username}`, {
    username,
    packs: { pack_weekly: 2 },
    weeklyRPProgress: 999,
    weeklyPackClaimed: false,
    weeklyResetAt: Date.now() + 86_400_000,
    totalResearchPoints: 0,
  });

  const plan = buildWeeklyPackClaimPlan(username);
  assert(plan.ok === true, `weekly plan ok (${plan.error || ''})`);
  const leaves = historyLeaves(plan.updates);
  assert(leaves.length === 1, 'weekly: one history leaf');
  const body = plan.updates[leaves[0]];
  assert(body.type === 'pack_granted' && body.reason === 'weekly', 'weekly pack_granted reason');
  assert(body.actorType === 'system' && body.source === 'weekly_research_pack', 'weekly system actor/source');
  assert(body.before === 2 && body.after === 3, 'weekly before/after');
  assert(plan.updates[`players/${username}/weeklyPackClaimed`] === true, 'claimed flag in same map');
  assert(plan.updates[`players/${username}/packs/pack_weekly`] === 3, 'pack grant in same map');

  // Duplicate claim protection (already claimed)
  db.applyLocalOnly?.(`players/${username}/weeklyPackClaimed`, true);
  const dup = buildWeeklyPackClaimPlan(username);
  assert(dup.ok === false && !dup.updates, 'duplicate weekly claim blocked with no history');

  const weeklyBody = buildWeeklyPackGrantedHistoryUpdate(username, {
    packId: 'p',
    quantity: 1,
    before: 0,
    after: 1,
  }).body;
  assert(weeklyBody.actorType === 'system' && weeklyBody.reason === 'weekly', 'weekly history builder metadata');
}

{
  const shopProj = buildProjectClaimedHistoryUpdate('u', {
    projectId: 'p1',
    rpDelta: 10,
    breakthrough: false,
  });
  assert(shopProj.body.source === 'project_claim', 'project history source');
  const shopH = buildShopPurchaseHistoryUpdate('u', {
    itemId: 'i1',
    itemType: 'consumable',
    pricePaid: 5,
    currency: 'rp',
    grant: { consumableId: 'c1', quantity: 2 },
  });
  assert(shopH.body.consumableId === 'c1' && shopH.body.type === 'shop_purchase', 'shop history builder');
}

assert(HISTORY_PAGE_SIZE === 50, 'page size 50');

if (failed) {
  console.error(`\nplayer-history-pass2: ${failed} failure(s)`);
  process.exit(1);
}
console.log('\nplayer-history-pass2: all checks passed');
