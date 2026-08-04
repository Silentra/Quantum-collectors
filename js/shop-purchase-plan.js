/**
 * shop-purchase-plan.js
 *
 * One-write acknowledged shop purchase:
 * RP deduction + item grant + purchased slot + purchase history +
 * shopPurchases + achievement updates in a single updateAcknowledged.
 *
 * Does not bump cosmeticsUnlocked or collection-derived stats (parity with
 * prior purchaseShopItem behavior).
 */

import * as db from './database.js';
import { STAT_KEYS, getPlayerStat } from './achievement-stats.js';
import { planAchievementUpdatesForStats } from './achievement-mutations.js';

/**
 * RTDB multi-path updates cannot include both an ancestor and a descendant.
 * @param {Object} updates
 */
export function assertNoOverlappingUpdatePaths(updates) {
  const paths = Object.keys(updates || {}).sort();
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (paths[j].startsWith(`${paths[i]}/`) || paths[i].startsWith(`${paths[j]}/`)) {
        throw new Error(`[ShopPurchase] Overlapping update paths: ${paths[i]} vs ${paths[j]}`);
      }
    }
  }
}

/**
 * Build absolute multi-path updates for a validated shop purchase.
 * Caller must have already run canPurchaseItem and buildGrantWrite.
 *
 * @returns {{ ok: boolean, reason?: string, updates?: Object, notified?: string[], unlocked?: string[], resultMeta?: Object }}
 */
export function buildShopPurchasePlan({
  username,
  validation,
  grantWrite,
  nextSlots,
  purchaseHistory,
  purchasedSlot,
  currentRotation,
  nextRp,
  now,
} = {}) {
  if (!username || !validation?.itemDefinition || !grantWrite) {
    return { ok: false, reason: 'invalid_purchase_plan' };
  }
  if (!Number.isFinite(Number(now))) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  if (!Number.isFinite(Number(nextRp)) || nextRp < 0) {
    return { ok: false, reason: 'insufficient_rp' };
  }

  const prevPurchases = getPlayerStat(username, STAT_KEYS.SHOP_PURCHASES);
  const nextPurchases = prevPurchases + 1;

  const updates = {
    [`players/${username}/currencies/currentResearchPoints`]: nextRp,
    [`players/${username}/${grantWrite.path}`]: grantWrite.value,
    [`players/${username}/shop/currentRotation/slots`]: nextSlots,
    [`players/${username}/purchaseHistory`]: purchaseHistory,
    [`players/${username}/stats/shopPurchases`]: nextPurchases,
  };

  const plannedStatValues = {
    [STAT_KEYS.SHOP_PURCHASES]: nextPurchases,
  };

  const getStat = (statKey) => {
    if (Object.prototype.hasOwnProperty.call(plannedStatValues, statKey)) {
      return plannedStatValues[statKey];
    }
    return getPlayerStat(username, statKey);
  };

  const achPlan = planAchievementUpdatesForStats(username, [STAT_KEYS.SHOP_PURCHASES], {
    getStat,
    now,
  });
  Object.assign(updates, achPlan.updates);

  assertNoOverlappingUpdatePaths(updates);

  return {
    ok: true,
    updates,
    notified: achPlan.notified || [],
    unlocked: achPlan.unlocked || [],
    writeCount: 1,
    resultMeta: {
      itemId: validation.itemDefinition.id,
      itemType: validation.itemDefinition.type,
      pricePaid: validation.price,
      currency: validation.currency,
      grantQuantity: grantWrite.quantity,
      slotIndex: validation.slotIndex,
      slot: purchasedSlot,
      purchaseHistory,
      currentResearchPoints: nextRp,
      rotation: {
        ...currentRotation,
        slots: nextSlots,
      },
    },
  };
}

async function withShopPurchaseLock(username, fn) {
  const lockName = `qc-shop-purchase:${username}`;
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(lockName, { mode: 'exclusive' }, () => fn());
  }
  return fn();
}

/**
 * Commit a pre-built shop purchase plan via updateAcknowledged.
 * @param {string} username
 * @param {Object} plan - from buildShopPurchasePlan
 */
export async function commitShopPurchasePlan(username, plan) {
  return withShopPurchaseLock(username, async () => {
    if (!plan?.ok || !plan.updates) {
      return { success: false, reason: plan?.reason || 'invalid_purchase_plan' };
    }

    const ack = await db.updateAcknowledged(plan.updates);
    if (!ack.ok) {
      return {
        success: false,
        reason: 'WRITE_FAILED',
        error: ack.error || 'Could not save purchase. Check your connection and try again.',
      };
    }

    return {
      success: true,
      notified: plan.notified || [],
      unlocked: plan.unlocked || [],
      writeCount: 1,
      ...(plan.resultMeta || {}),
    };
  });
}

/**
 * Full purchase commit: acquire lock, revalidate via validateAndBuild callback, then ack.
 * validateAndBuild must re-read cache and return { ok, reason?, plan? }.
 */
export async function commitShopPurchaseWithRevalidation(username, validateAndBuild) {
  return withShopPurchaseLock(username, async () => {
    const built = validateAndBuild();
    if (!built?.ok) {
      return { success: false, reason: built?.reason || 'invalid_purchase_plan', validation: built?.validation };
    }

    const plan = built.plan;
    if (!plan?.ok || !plan.updates) {
      return { success: false, reason: plan?.reason || 'invalid_purchase_plan' };
    }

    const ack = await db.updateAcknowledged(plan.updates);
    if (!ack.ok) {
      return {
        success: false,
        reason: 'WRITE_FAILED',
        error: ack.error || 'Could not save purchase. Check your connection and try again.',
      };
    }

    return {
      success: true,
      notified: plan.notified || [],
      unlocked: plan.unlocked || [],
      writeCount: 1,
      ...(plan.resultMeta || {}),
    };
  });
}
