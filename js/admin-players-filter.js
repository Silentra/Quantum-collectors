/**
 * Admin Players multi-select group/subgroup filter — pure helpers.
 * Presentation-only; no Firebase I/O.
 */

import {
  getPlayerDisplayName,
  compareDirectoryPlayersByDisplayName,
} from './player-display-name.js';

/**
 * Effective subgroup absent under directory normalization (missing/null/blank).
 * Non-empty stale IDs are NOT absent.
 * @param {unknown} subgroupId
 * @returns {boolean}
 */
export function isAbsentSubgroupId(subgroupId) {
  if (subgroupId == null) return true;
  if (typeof subgroupId === 'string' && subgroupId.trim() === '') return true;
  return false;
}

/**
 * @param {object|null|undefined} directoryValue
 * @returns {string|null}
 */
export function effectiveDirectoryGroupId(directoryValue) {
  const p = directoryValue && typeof directoryValue === 'object' ? directoryValue : null;
  if (!p) return null;
  if (p.groupId != null && String(p.groupId).trim() !== '') return String(p.groupId);
  return null;
}

/**
 * @param {object|null|undefined} directoryValue
 * @returns {string|null}
 */
export function effectiveDirectorySubgroupId(directoryValue) {
  const p = directoryValue && typeof directoryValue === 'object' ? directoryValue : null;
  if (!p) return null;
  if (p.subgroupId != null && String(p.subgroupId).trim() !== '') return String(p.subgroupId);
  return null;
}

/**
 * @param {{ key: string, value?: object|null }} entry
 * @param {{
 *   groupIds?: string[],
 *   subgroupIds?: string[],
 *   includeNoSubgroup?: boolean,
 * }} filter
 * @returns {boolean}
 */
export function directoryEntryMatchesGroupSubgroupFilter(entry, filter = {}) {
  const groupIds = Array.isArray(filter.groupIds) ? filter.groupIds.filter(Boolean).map(String) : [];
  const subgroupIds = Array.isArray(filter.subgroupIds) ? filter.subgroupIds.filter(Boolean).map(String) : [];
  const includeNoSubgroup = filter.includeNoSubgroup === true;
  const p = entry?.value;

  if (groupIds.length > 0) {
    const g = effectiveDirectoryGroupId(p);
    if (!g || !groupIds.includes(g)) return false;
  }

  const hasSubFilter = subgroupIds.length > 0 || includeNoSubgroup;
  if (hasSubFilter) {
    const s = effectiveDirectorySubgroupId(p);
    const matchNamed = !!(s && subgroupIds.includes(s));
    const matchNone = includeNoSubgroup && isAbsentSubgroupId(s);
    if (!matchNamed && !matchNone) return false;
  }

  return true;
}

/**
 * @param {{ key: string, value?: object|null }} entry
 * @param {string} search
 * @returns {boolean}
 */
export function directoryEntryMatchesAdminPlayersSearch(entry, search) {
  const q = String(search || '').trim().toLowerCase();
  if (!q) return true;
  const key = String(entry?.key || '');
  const p = entry?.value;
  const login = String(p?.username || key || '').toLowerCase();
  const visible = getPlayerDisplayName(p, key).toLowerCase();
  return login.includes(q) || visible.includes(q);
}

/**
 * Full Admin Players list pipeline: search → group/subgroup filter → display-name sort.
 * @param {Array<{ key: string, value?: object|null }>} entries
 * @param {{
 *   search?: string,
 *   groupIds?: string[],
 *   subgroupIds?: string[],
 *   includeNoSubgroup?: boolean,
 * }} opts
 * @returns {Array<{ key: string, value?: object|null }>}
 */
export function filterAndSortAdminDirectoryPlayers(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const filtered = list.filter((entry) => (
    directoryEntryMatchesAdminPlayersSearch(entry, opts.search)
    && directoryEntryMatchesGroupSubgroupFilter(entry, opts)
  ));
  return [...filtered].sort(compareDirectoryPlayersByDisplayName);
}

/**
 * Build subgroup checkbox options. Labels: "GroupName / SubName".
 * When selectedGroupIds non-empty, union subgroups of those groups only.
 * @param {Array<{ id: string, name: string, subgroups?: object }>} allGroups
 * @param {string[]} selectedGroupIds
 * @returns {Array<{ id: string, groupId: string, label: string }>}
 */
export function buildAdminPlayersSubgroupFilterOptions(allGroups, selectedGroupIds = []) {
  const groups = Array.isArray(allGroups) ? allGroups : [];
  const selected = Array.isArray(selectedGroupIds) ? selectedGroupIds.filter(Boolean).map(String) : [];
  const pool = selected.length > 0
    ? groups.filter((g) => selected.includes(String(g.id)))
    : groups;

  const opts = [];
  for (const g of pool) {
    const subs = g?.subgroups && typeof g.subgroups === 'object' ? Object.values(g.subgroups) : [];
    for (const s of subs) {
      if (!s || s.id == null) continue;
      opts.push({
        id: String(s.id),
        groupId: String(g.id),
        label: `${g.name || g.id} / ${s.name || s.id}`,
      });
    }
  }
  opts.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return opts;
}

/**
 * Drop draft subgroup IDs that are not in the visible option list (after group draft changes).
 * @param {Iterable<string>} draftSubgroupIds
 * @param {Array<{ id: string }>} visibleSubOptions
 * @returns {string[]}
 */
export function pruneDraftSubgroupIds(draftSubgroupIds, visibleSubOptions) {
  const allowed = new Set((visibleSubOptions || []).map((o) => String(o.id)));
  const out = [];
  for (const id of draftSubgroupIds || []) {
    const s = String(id || '');
    if (s && allowed.has(s)) out.push(s);
  }
  return out;
}

/**
 * Active filter count for badge (committed values).
 * @param {{ groupIds?: string[], subgroupIds?: string[], includeNoSubgroup?: boolean }} filter
 * @returns {number}
 */
export function countAdminPlayersActiveFilters(filter = {}) {
  const g = Array.isArray(filter.groupIds) ? filter.groupIds.filter(Boolean).length : 0;
  const s = Array.isArray(filter.subgroupIds) ? filter.subgroupIds.filter(Boolean).length : 0;
  const n = filter.includeNoSubgroup === true ? 1 : 0;
  return g + s + n;
}
