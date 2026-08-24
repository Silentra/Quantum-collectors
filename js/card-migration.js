/**
 * Batch D3 — Firebase /cards conversion preview planner (READ-ONLY).
 *
 * Pure classification of Firebase children vs bundled BASE_CARD_DEFINITIONS.
 * Reuses D2 applyCardOverride / buildCardOverride — no second comparison system.
 *
 * D3 performs ZERO Firebase writes. The `updates` object is in-memory preview only.
 * D4 (not implemented here) must re-gather and rebuild a fresh plan before commit.
 */

import {
  applyCardOverride,
  buildCardOverride,
} from './card-override.js';

export const CARD_PRE_MIGRATION_BACKUP_FILENAME =
  'quantum-collectors-cards-pre-migration-backup.json';

export const PREVIEW_ONLY_MESSAGE =
  'This is a preview only. Firebase cards have not been changed.';

/** Expected bundled catalog size (D2). */
export const EXPECTED_BUNDLED_CARD_COUNT = 125;

/**
 * Deep-clone a JSON-serializable value (backup / immutability).
 * @param {*} value
 * @returns {*}
 */
function deepCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Build a read-only Firebase /cards → sparse-override conversion plan.
 *
 * @param {{ baseCards: Iterable<object>, firebaseSnapshot: object|null|undefined }} args
 * @returns {object} plan (see Batch D3 contract)
 */
export function buildCardFirebaseConversionPlan({ baseCards, firebaseSnapshot }) {
  const message = PREVIEW_ONLY_MESSAGE;
  const emptyUpdates = { deletes: [], sparseSets: {}, preserveIds: [] };

  const baseList = Array.isArray(baseCards) ? baseCards : [...(baseCards || [])];
  const baseById = new Map();
  const duplicateBaseIds = [];
  for (const card of baseList) {
    if (!card || typeof card !== 'object' || !card.id) {
      return {
        ok: false,
        readyForD4: false,
        error: 'BASE_CARD_INVALID',
        bundledCount: baseList.length,
        firebaseCount: 0,
        redundantCount: 0,
        overrideCount: 0,
        customCount: 0,
        malformedCount: 1,
        bundledAbsentFromFirebaseCount: 0,
        redundantIds: [],
        overrideDetails: [],
        customDetails: [],
        malformedDetails: [{ pathId: '(base)', reason: 'base_entry_missing_id' }],
        bundledAbsentFromFirebaseIds: [],
        finalFirebaseRecordCount: 0,
        updates: emptyUpdates,
        message,
      };
    }
    if (baseById.has(card.id)) {
      duplicateBaseIds.push(card.id);
    } else {
      baseById.set(card.id, card);
    }
  }

  const bundledCount = baseById.size;
  const malformedDetails = [];

  if (duplicateBaseIds.length) {
    for (const id of duplicateBaseIds) {
      malformedDetails.push({ pathId: id, reason: 'duplicate_base_id' });
    }
  }

  let snapshot = firebaseSnapshot;
  if (snapshot == null) snapshot = {};
  if (typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return {
      ok: false,
      readyForD4: false,
      error: 'FIREBASE_SNAPSHOT_INVALID',
      bundledCount,
      firebaseCount: 0,
      redundantCount: 0,
      overrideCount: 0,
      customCount: 0,
      malformedCount: 1,
      bundledAbsentFromFirebaseCount: 0,
      redundantIds: [],
      overrideDetails: [],
      customDetails: [],
      malformedDetails: [{ pathId: '(snapshot)', reason: 'firebase_snapshot_not_object_map' }],
      bundledAbsentFromFirebaseIds: [],
      finalFirebaseRecordCount: 0,
      updates: emptyUpdates,
      message,
    };
  }

  const firebaseCount = Object.keys(snapshot).length;
  const redundantIds = [];
  const overrideDetails = [];
  const customDetails = [];
  const deletes = [];
  const sparseSets = {};
  const preserveIds = [];

  for (const [pathId, raw] of Object.entries(snapshot)) {
    if (!pathId || typeof pathId !== 'string') {
      malformedDetails.push({ pathId: String(pathId), reason: 'empty_or_invalid_path_id' });
      continue;
    }

    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      malformedDetails.push({ pathId, reason: 'malformed_non_object_child' });
      continue;
    }

    if (raw.id != null && String(raw.id) !== pathId) {
      malformedDetails.push({
        pathId,
        reason: `path_id_mismatch:${raw.id}`,
      });
      continue;
    }

    const base = baseById.get(pathId);
    if (!base) {
      // C — Firebase-only custom
      customDetails.push({
        id: pathId,
        name: typeof raw.name === 'string' ? raw.name : '(unnamed)',
        type: raw.type || 'unknown',
        enabled: raw.enabled !== false,
      });
      preserveIds.push(pathId);
      continue;
    }

    try {
      const resolved = applyCardOverride(base, raw);
      if (!resolved) {
        malformedDetails.push({ pathId, reason: 'apply_override_returned_null' });
        continue;
      }
      const override = buildCardOverride(base, resolved);
      const changedFields = Object.keys(override).sort();

      if (changedFields.length === 0) {
        // A — redundant
        redundantIds.push(pathId);
        deletes.push(pathId);
      } else {
        // B — sparse override
        overrideDetails.push({
          id: pathId,
          name: resolved.name || base.name || pathId,
          changedFields,
          override,
        });
        sparseSets[pathId] = override;
      }
    } catch (err) {
      malformedDetails.push({
        pathId,
        reason: `comparison_failed:${err?.message || String(err)}`,
      });
    }
  }

  redundantIds.sort((a, b) => a.localeCompare(b));
  deletes.sort((a, b) => a.localeCompare(b));
  preserveIds.sort((a, b) => a.localeCompare(b));
  overrideDetails.sort((a, b) => a.id.localeCompare(b.id));
  customDetails.sort((a, b) => a.id.localeCompare(b.id));

  const bundledAbsentFromFirebaseIds = [...baseById.keys()]
    .filter((id) => !Object.prototype.hasOwnProperty.call(snapshot, id))
    .sort((a, b) => a.localeCompare(b));

  const redundantCount = redundantIds.length;
  const overrideCount = overrideDetails.length;
  const customCount = customDetails.length;
  const malformedCount = malformedDetails.length;
  const finalFirebaseRecordCount = overrideCount + customCount;

  // Integrity: every delete/override id must be in base; every custom must not
  let integrityOk = true;
  for (const id of deletes) {
    if (!baseById.has(id)) {
      malformedDetails.push({ pathId: id, reason: 'delete_id_not_in_base' });
      integrityOk = false;
    }
  }
  for (const id of Object.keys(sparseSets)) {
    if (!baseById.has(id)) {
      malformedDetails.push({ pathId: id, reason: 'override_id_not_in_base' });
      integrityOk = false;
    }
  }
  for (const id of preserveIds) {
    if (baseById.has(id)) {
      malformedDetails.push({ pathId: id, reason: 'custom_id_is_in_base' });
      integrityOk = false;
    }
  }

  const finalMalformedCount = malformedDetails.length;
  const ok = finalMalformedCount === 0 && integrityOk && duplicateBaseIds.length === 0;
  const readyForD4 =
    ok &&
    bundledCount === EXPECTED_BUNDLED_CARD_COUNT &&
    baseById.size === bundledCount &&
    finalMalformedCount === 0;

  return {
    ok,
    readyForD4,
    bundledCount,
    firebaseCount,
    redundantCount,
    overrideCount,
    customCount,
    malformedCount: finalMalformedCount,
    bundledAbsentFromFirebaseCount: bundledAbsentFromFirebaseIds.length,
    redundantIds,
    overrideDetails,
    customDetails,
    malformedDetails,
    bundledAbsentFromFirebaseIds,
    finalFirebaseRecordCount,
    updates: {
      deletes,
      sparseSets,
      preserveIds,
    },
    message,
  };
}

/**
 * Serialize raw Firebase /cards snapshot for backup (pure; no DOM / Firebase I/O).
 * Does not mutate snapshot.
 *
 * @param {object} firebaseSnapshot
 * @returns {string}
 */
export function serializeRawCardsPreMigrationBackup(firebaseSnapshot) {
  if (firebaseSnapshot == null || typeof firebaseSnapshot !== 'object' || Array.isArray(firebaseSnapshot)) {
    throw new Error('serializeRawCardsPreMigrationBackup requires an object-map snapshot');
  }
  const clone = deepCloneJson(firebaseSnapshot);
  return `${JSON.stringify(clone, null, 2)}\n`;
}

/**
 * Download raw Firebase /cards snapshot as pre-migration backup (browser only; no Firebase I/O).
 * Does not mutate snapshot.
 *
 * @param {object} firebaseSnapshot
 * @param {string} [filename]
 * @returns {string} pretty JSON written to the file
 */
export function downloadRawCardsPreMigrationBackup(
  firebaseSnapshot,
  filename = CARD_PRE_MIGRATION_BACKUP_FILENAME,
) {
  const json = serializeRawCardsPreMigrationBackup(firebaseSnapshot);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return json;
}

/**
 * Pretty-print plan for console / modal (no I/O).
 * @param {object} plan
 * @returns {string}
 */
export function formatCardConversionPlanSummary(plan) {
  if (!plan) return '(no plan)';
  const lines = [
    plan.message || PREVIEW_ONLY_MESSAGE,
    '',
    `Bundled base cards: ${plan.bundledCount}`,
    `Firebase records: ${plan.firebaseCount}`,
    '',
    `Redundant base duplicates to remove: ${plan.redundantCount}`,
    `Base cards to reduce to overrides: ${plan.overrideCount}`,
    `Firebase-only custom cards to preserve: ${plan.customCount}`,
    `Malformed/conflicts: ${plan.malformedCount}`,
    '',
    `Expected Firebase records after conversion: ${plan.finalFirebaseRecordCount}`,
    `Bundled IDs with no Firebase child: ${plan.bundledAbsentFromFirebaseCount}`,
    `readyForD4: ${plan.readyForD4}`,
  ];

  if (plan.overrideDetails?.length) {
    lines.push('', 'Overrides:');
    for (const o of plan.overrideDetails) {
      lines.push(
        `  - ${o.name} (${o.id}): [${(o.changedFields || []).join(', ')}] ${JSON.stringify(o.override)}`,
      );
    }
  }
  if (plan.customDetails?.length) {
    lines.push('', 'Firebase-only customs:');
    for (const c of plan.customDetails) {
      lines.push(
        `  - ${c.name} (${c.id}) type=${c.type} enabled=${c.enabled}`,
      );
    }
  }
  if (plan.malformedDetails?.length) {
    lines.push('', 'Malformed:');
    for (const m of plan.malformedDetails) {
      lines.push(`  - ${m.pathId}: ${m.reason}`);
    }
  }
  if (plan.bundledAbsentFromFirebaseIds?.length && plan.bundledAbsentFromFirebaseIds.length <= 20) {
    lines.push('', 'Bundled absent from Firebase (no D4 action):');
    for (const id of plan.bundledAbsentFromFirebaseIds) {
      lines.push(`  - ${id}`);
    }
  }

  lines.push(
    '',
    'D4 note: Confirm must re-gather Firebase /cards and rebuild a fresh plan — do not commit this preview.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Batch D4 — commit helpers (writes only via injected updateAcknowledged)
// ---------------------------------------------------------------------------

/**
 * Build multipath Firebase updates from a conversion plan (pure).
 * A → cards/{id}: null
 * B → cards/{id}: sparse override
 * C → no write
 *
 * @param {object} plan - from buildCardFirebaseConversionPlan
 * @returns {{ ok: boolean, updates: Object.<string, *>, error?: string, pathCount?: number }}
 */
export function buildCardConversionFirebaseUpdates(plan) {
  if (!plan || typeof plan !== 'object') {
    return { ok: false, updates: {}, error: 'PLAN_MISSING' };
  }
  if (plan.readyForD4 !== true) {
    return { ok: false, updates: {}, error: 'PLAN_NOT_READY_FOR_D4' };
  }
  if (plan.malformedCount > 0) {
    return { ok: false, updates: {}, error: 'PLAN_HAS_MALFORMED' };
  }

  const updates = {};
  const deletes = plan.updates?.deletes || [];
  const sparseSets = plan.updates?.sparseSets || {};

  for (const id of deletes) {
    if (!id || typeof id !== 'string') {
      return { ok: false, updates: {}, error: 'INVALID_DELETE_ID' };
    }
    updates[`cards/${id}`] = null;
  }

  for (const [id, override] of Object.entries(sparseSets)) {
    if (!id || typeof id !== 'string') {
      return { ok: false, updates: {}, error: 'INVALID_OVERRIDE_ID' };
    }
    if (updates[`cards/${id}`] !== undefined) {
      return { ok: false, updates: {}, error: `DELETE_AND_SPARSE_CONFLICT:${id}` };
    }
    updates[`cards/${id}`] = deepCloneJson(override);
  }

  const pathCheck = assertCardConversionUpdatePaths(updates);
  if (!pathCheck.ok) {
    return { ok: false, updates: {}, error: pathCheck.error };
  }

  return { ok: true, updates, pathCount: Object.keys(updates).length };
}

/**
 * Every write path must be exactly under cards/{id} (no other roots).
 * @param {object} updates
 * @returns {{ ok: boolean, error?: string, paths?: string[] }}
 */
export function assertCardConversionUpdatePaths(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return { ok: false, error: 'UPDATES_INVALID' };
  }
  const paths = Object.keys(updates);
  for (const path of paths) {
    if (typeof path !== 'string' || !path.startsWith('cards/')) {
      return { ok: false, error: `PATH_NOT_UNDER_CARDS:${path}` };
    }
    const rest = path.slice('cards/'.length);
    if (!rest || rest.includes('/') || rest.includes('.')) {
      return { ok: false, error: `PATH_NOT_SINGLE_CARD_CHILD:${path}` };
    }
    // Forbidden roots must never appear as prefixes
    for (const forbidden of [
      'players',
      'trades',
      'config',
      'packs',
      'authDirectory',
      'admins',
      'groups',
      'accessCodes',
      'leaderboards',
    ]) {
      if (path === forbidden || path.startsWith(`${forbidden}/`)) {
        return { ok: false, error: `FORBIDDEN_ROOT:${path}` };
      }
    }
  }
  return { ok: true, paths };
}

/**
 * Fail-closed gate for live D4 after a FRESH plan (not the stale D3 preview).
 * Aborts if overrides/customs appeared (unexpected vs clean D3 live state) unless allowed.
 *
 * @param {object} plan
 * @param {{ allowOverridesAndCustoms?: boolean }} [opts]
 * @returns {{ ok: boolean, error?: string, reason?: string }}
 */
export function validateFreshPlanForD4Commit(plan, opts = {}) {
  if (!plan || plan.readyForD4 !== true) {
    return { ok: false, error: 'PLAN_NOT_READY_FOR_D4', reason: 'readyForD4 !== true' };
  }
  if (plan.bundledCount !== EXPECTED_BUNDLED_CARD_COUNT) {
    return { ok: false, error: 'BUNDLED_COUNT_MISMATCH', reason: `bundledCount=${plan.bundledCount}` };
  }
  if (plan.malformedCount > 0) {
    return { ok: false, error: 'PLAN_HAS_MALFORMED', reason: `malformedCount=${plan.malformedCount}` };
  }
  if (!opts.allowOverridesAndCustoms) {
    if (plan.overrideCount > 0) {
      return {
        ok: false,
        error: 'UNEXPECTED_OVERRIDES',
        reason: `${plan.overrideCount} override(s) — review Preview before convert`,
      };
    }
    if (plan.customCount > 0) {
      return {
        ok: false,
        error: 'UNEXPECTED_CUSTOMS',
        reason: `${plan.customCount} custom(s) — review Preview before convert`,
      };
    }
  }
  return { ok: true };
}

/**
 * Commit a FRESH conversion plan via injected acknowledged multipath update.
 * Does not gather or rebuild — caller must supply a fresh plan.
 *
 * @param {object} plan
 * @param {{ updateAcknowledged: Function, allowOverridesAndCustoms?: boolean }} options
 * @returns {Promise<object>}
 */
export async function commitCardFirebaseConversionPlan(plan, options = {}) {
  const updateFn = options.updateAcknowledged;
  if (typeof updateFn !== 'function') {
    return { ok: false, error: 'UPDATE_ACK_MISSING', wrote: false };
  }

  const gate = validateFreshPlanForD4Commit(plan, {
    allowOverridesAndCustoms: options.allowOverridesAndCustoms === true,
  });
  if (!gate.ok) {
    return { ok: false, error: gate.error, reason: gate.reason, wrote: false };
  }

  const built = buildCardConversionFirebaseUpdates(plan);
  if (!built.ok) {
    return { ok: false, error: built.error, wrote: false };
  }

  if (built.pathCount === 0) {
    return {
      ok: true,
      wrote: false,
      skipped: true,
      pathCount: 0,
      plan,
      message: 'No Firebase card updates required (already sparse/empty).',
    };
  }

  const pathCheck = assertCardConversionUpdatePaths(built.updates);
  if (!pathCheck.ok) {
    return { ok: false, error: pathCheck.error, wrote: false };
  }

  const result = await updateFn(built.updates);
  if (!result || result.ok !== true) {
    return {
      ok: false,
      error: result?.error || 'UPDATE_ACKNOWLEDGED_FAILED',
      wrote: false,
      pathCount: built.pathCount,
    };
  }

  return {
    ok: true,
    wrote: true,
    skipped: false,
    pathCount: built.pathCount,
    mode: result.mode,
    deletes: plan.updates.deletes.length,
    sparseSets: Object.keys(plan.updates.sparseSets).length,
    plan,
  };
}
