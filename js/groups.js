/**
 * Groups Module - Clean Group + Subgroup architecture
 *
 * Data model:
 *   groups/{id} = { id, name, subgroups: { [subId]: { id, name } }, created }
 *
 * Player data uses:
 *   { groupId: string|null, subgroupId: string|null }
 *
 * Rules:
 *   - Groups are top-level only (no nesting)
 *   - Subgroups live inside their parent group (no cross-group subgroups)
 *   - subgroupId must belong to player's groupId
 *   - subgroupId is nullable
 *
 * Future-compatible for: leaderboards, trading restrictions, pack distribution.
 */

import * as db from './database.js';

// ---------- ID Generation ----------

function _genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// ---------- Group CRUD ----------

/**
 * Create a new top-level group.
 * @param {string} name
 * @returns {string} groupId
 */
export function createGroup(name) {
  const id = _genId('grp');
  const group = {
    id,
    name: (name || 'New Group').trim(),
    subgroups: {},
    created: Date.now()
  };
  db.set(`groups/${id}`, group);
  return id;
}

/**
 * Get a group by ID.
 * @param {string} id
 * @returns {object|null}
 */
export function getGroup(id) {
  if (!id) return null;
  return db.get(`groups/${id}`);
}

/**
 * Get all groups as an array.
 * @returns {Array<object>}
 */
export function getAllGroups() {
  return db.getChildren('groups').map(({ value }) => value);
}

/**
 * Rename a group.
 * @param {string} id
 * @param {string} newName
 */
export function renameGroup(id, newName) {
  if (!id || !newName) return;
  db.update(`groups/${id}`, { name: newName.trim() });
}

/**
 * Delete a group and all its subgroups.
 * Does NOT automatically unassign players — caller should handle that if needed.
 * @param {string} id
 */
export function deleteGroup(id) {
  if (!id) return;
  db.remove(`groups/${id}`);
}

// ---------- Subgroup CRUD ----------

/**
 * Create a subgroup inside a group.
 * @param {string} groupId
 * @param {string} name
 * @returns {string|null} subgroupId or null if group not found
 */
export function createSubgroup(groupId, name) {
  if (!groupId) return null;
  const group = getGroup(groupId);
  if (!group) return null;

  const id = _genId('sub');
  const subgroup = { id, name: (name || 'New Subgroup').trim() };
  db.set(`groups/${groupId}/subgroups/${id}`, subgroup);
  return id;
}

/**
 * Get a subgroup by groupId + subgroupId.
 * @param {string} groupId
 * @param {string} subgroupId
 * @returns {object|null}
 */
export function getSubgroup(groupId, subgroupId) {
  if (!groupId || !subgroupId) return null;
  return db.get(`groups/${groupId}/subgroups/${subgroupId}`);
}

/**
 * Get all subgroups for a group as an array.
 * @param {string} groupId
 * @returns {Array<{id, name}>}
 */
export function getSubgroups(groupId) {
  if (!groupId) return [];
  const data = db.get(`groups/${groupId}/subgroups`);
  if (!data || typeof data !== 'object') return [];
  return Object.values(data);
}

/**
 * Rename a subgroup.
 * @param {string} groupId
 * @param {string} subgroupId
 * @param {string} newName
 */
export function renameSubgroup(groupId, subgroupId, newName) {
  if (!groupId || !subgroupId || !newName) return;
  db.update(`groups/${groupId}/subgroups/${subgroupId}`, { name: newName.trim() });
}

/**
 * Delete a subgroup from a group.
 * @param {string} groupId
 * @param {string} subgroupId
 */
export function deleteSubgroup(groupId, subgroupId) {
  if (!groupId || !subgroupId) return;
  db.remove(`groups/${groupId}/subgroups/${subgroupId}`);
}

// ---------- Display Helpers ----------

/**
 * Get a group's display name (safe, returns 'None' if not found).
 * @param {string} id
 * @returns {string}
 */
export function getGroupName(id) {
  if (!id) return 'None';
  const group = getGroup(id);
  return group ? group.name : 'Unknown Group';
}

/**
 * Get a subgroup's display name (safe, returns 'None' if not found).
 * @param {string} groupId
 * @param {string} subgroupId
 * @returns {string}
 */
export function getSubgroupName(groupId, subgroupId) {
  if (!groupId || !subgroupId) return 'None';
  const sub = getSubgroup(groupId, subgroupId);
  return sub ? sub.name : 'Unknown Subgroup';
}

/**
 * Validate that a subgroupId belongs to the given groupId.
 * Returns false if either is null (subgroupId null is always valid).
 * @param {string} groupId
 * @param {string} subgroupId
 * @returns {boolean}
 */
export function isSubgroupOf(groupId, subgroupId) {
  if (!subgroupId) return true; // null subgroup is always valid
  if (!groupId) return false;
  return getSubgroup(groupId, subgroupId) !== null;
}
