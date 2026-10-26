/** Field-level three-way merge for hub sync. Ancestor is the op's before row. */
export const syncFields = {
  task: ['title', 'description', 'status', 'priority', 'dueDate', 'estimatedMinutes', 'scheduledStart', 'scheduledEnd', 'resultSummary', 'recurrenceRule', 'topicId', 'parentId', 'deletedAt', 'deleteBatchId', 'sortOrder', 'tagIds', 'createdAt', 'completedAt', 'completedAtEstimated'],
  topic: ['name', 'description', 'color', 'isExploration', 'goal', 'goalDueDate', 'draftSummary', 'finalSummary', 'summaryStatus', 'summaryUpdatedAt', 'archivedAt'],
  tag: ['name', 'color'],
} as const;

export type SyncEntityType = keyof typeof syncFields;
export type SyncRow = Record<string, unknown>;

/** Runtime boundary shared by the hub and replica; JSON objects alone are not valid rows. */
export function isCompleteSyncRow(entity: SyncEntityType, value: unknown): value is SyncRow | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as SyncRow;
  const nullable = new Set(['dueDate', 'scheduledStart', 'scheduledEnd', 'topicId', 'parentId', 'deletedAt', 'deleteBatchId', 'summaryUpdatedAt', 'archivedAt', 'createdAt', 'completedAt', 'goalDueDate']);
  return syncFields[entity].every(field => {
    if (!Object.prototype.hasOwnProperty.call(row, field)) return false;
    const item = row[field];
    if (field === 'tagIds') return Array.isArray(item) && item.length <= 1000 && item.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200) && new Set(item).size === item.length;
    if (field === 'status') return typeof item === 'string' && ['todo', 'doing', 'blocked', 'done'].includes(item);
    if (field === 'priority') return typeof item === 'string' && ['none', 'low', 'medium', 'high'].includes(item);
    if (field === 'isExploration' || field === 'completedAtEstimated') return typeof item === 'boolean';
    if (field === 'sortOrder') return typeof item === 'number' && Number.isFinite(item);
    if (field === 'estimatedMinutes') return item === null || (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0);
    if (item === null) return nullable.has(field);
    return typeof item === 'string' && item.length <= 2_000_000;
  });
}

export type SyncFieldConflict = {
  field: string;
  base: unknown;
  live: unknown;
  incoming: unknown;
};

const lastWriteWins = new Set(['sortOrder']);

export function isSyncEntityType(value: string): value is SyncEntityType {
  return value === 'task' || value === 'topic' || value === 'tag';
}

function empty(entityType: SyncEntityType): SyncRow {
  const row: SyncRow = {};
  for (const field of syncFields[entityType]) row[field] = field === 'tagIds' ? [] : field === 'completedAtEstimated' ? false : null;
  return row;
}

/** Drops revision and timestamps so they never count as user edits. */
export function canonicalSyncRow(entityType: SyncEntityType, row: Record<string, unknown> | null | undefined): SyncRow | null {
  if (!row) return null;
  const out = empty(entityType);
  for (const field of syncFields[entityType]) {
    if (field === 'tagIds') out[field] = Array.isArray(row[field]) ? [...row[field]].map(String).sort() : [];
    else if (row[field] !== undefined) out[field] = row[field];
  }
  return out;
}

export function syncRowsEqual(entityType: SyncEntityType, left: SyncRow | null, right: SyncRow | null) {
  if (!left || !right) return left === right;
  return syncFields[entityType].every((field) => sameValue(field, left[field], right[field]));
}

function sameValue(field: string, left: unknown, right: unknown) {
  if (left == null && right == null) return true;
  if (field === 'title' || field === 'name') return String(left ?? '').trim() === String(right ?? '').trim();
  if (field === 'tagIds') return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
  return left === right;
}

/**
 * Merges one incoming op onto the live row.
 * `row` is what the hub should store. Conflicted fields stay at the live value.
 * A delete against other edits stays on the live row and reports `_deleted` or `deletedAt`.
 */
export function mergeSyncRow(entityType: SyncEntityType, liveRaw: Record<string, unknown> | null, beforeRaw: Record<string, unknown> | null, afterRaw: Record<string, unknown> | null): { row: SyncRow | null; conflicts: SyncFieldConflict[] } {
  const live = canonicalSyncRow(entityType, liveRaw);
  const before = canonicalSyncRow(entityType, beforeRaw);
  const after = canonicalSyncRow(entityType, afterRaw);
  if (!live && !after) return { row: null, conflicts: [] };
  if (!before && after && !live) return { row: after, conflicts: [] };
  if (!live && before && after) return { row: null, conflicts: [{ field: '_deleted', base: before, live: null, incoming: after }] };
  if (!before && after && live) {
    const conflicts = syncFields[entityType].flatMap((field) => sameValue(field, live[field], after[field]) ? [] : [{ field, base: null, live: live[field], incoming: after[field] }]);
    return { row: live, conflicts };
  }
  if (live && before && !after) {
    const diverged = syncFields[entityType].some((field) => !sameValue(field, live[field], before[field]));
    if (!diverged) return { row: null, conflicts: [] };
    return { row: live, conflicts: [{ field: '_deleted', base: before, live, incoming: null }] };
  }
  const base = before ?? empty(entityType);
  const current = live ?? empty(entityType);
  const incoming = after ?? empty(entityType);
  const row: SyncRow = { ...current };
  const conflicts: SyncFieldConflict[] = [];
  const liveEditedOther = syncFields[entityType].some((field) => field !== 'deletedAt' && field !== 'deleteBatchId' && !sameValue(field, current[field], base[field]));
  const incomingSoftDelete = !sameValue('deletedAt', base.deletedAt, incoming.deletedAt) && incoming.deletedAt != null;
  const liveSoftDelete = !sameValue('deletedAt', base.deletedAt, current.deletedAt) && current.deletedAt != null;
  const incomingEditedOther = syncFields[entityType].some((field) => field !== 'deletedAt' && field !== 'deleteBatchId' && !sameValue(field, incoming[field], base[field]));
  // The delete and its batch marker are one operation. Preserve edits on either arrival order.
  if (liveSoftDelete && incomingEditedOther && !incomingSoftDelete) {
    return { row: live, conflicts: [{ field: '_deleted', base: before, live, incoming: after }] };
  }
  for (const field of syncFields[entityType]) {
    if (sameValue(field, base[field], incoming[field])) continue;
    if ((field === 'deletedAt' || field === 'deleteBatchId') && incomingSoftDelete && liveEditedOther) {
      if (field === 'deletedAt') conflicts.push({ field: '_deleted', base: before, live, incoming: after });
      continue;
    }
    if (sameValue(field, base[field], current[field]) || sameValue(field, current[field], incoming[field]) || lastWriteWins.has(field)) {
      row[field] = incoming[field];
      continue;
    }
    conflicts.push({ field, base: base[field], live: current[field], incoming: incoming[field] });
  }
  return { row, conflicts };
}
