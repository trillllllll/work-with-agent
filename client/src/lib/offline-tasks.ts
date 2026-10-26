import { t } from '../i18n/index.js';
import { allowedTaskTransitions, DomainError, Task as TaskDomain } from '../../../server/src/domain/task.js';
import { emptySchedule, normalizeSchedule, shiftMinutes } from '../../../server/src/domain/schedule.js';
import { nextRecurrenceDate, parseRecurrenceRule, recurrenceAnchor, recurrenceRuleText } from '../../../server/src/domain/recurrence.js';
import { parseInput, taskCreateSchema, taskUpdateSchema, topicCreateSchema, topicUpdateSchema, tagCreateSchema, tagUpdateSchema, reorderSchema } from '../../../server/src/application/workspace-input.js';
import { canonicalSyncRow, syncRowsEqual, type SyncEntityType, type SyncRow } from '../../../server/src/application/sync-merge.js';
import type { BrowserReplica, ReplicaRow, ReplicaRows } from './offline-store.js';

const fail = (code: string, message: string, status = 409): never => { throw new DomainError(code, message, status); };
const rank: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3 };
export const supportedOfflinePath = (path: string, method: string) => method === 'GET'
  ? /^\/api\/(?:tasks(?:\/[^/]+)?|topics(?:\/[^/]+)?|tags|trash\/tasks)$/.test(path)
  : /^\/api\/(?:tasks(?:\/[^/]+)?|tasks\/reorder|topics(?:\/[^/]+)?|tags(?:\/[^/]+)?|trash\/tasks\/[^/]+\/restore)$/.test(path);

export function replicaDto(rows: ReplicaRows, entity: SyncEntityType, stored: ReplicaRow, children = false): any {
  const value = { ...stored.row, id: stored.id, revision: stored.revision, createdAt: stored.createdAt, updatedAt: stored.updatedAt } as any;
  if (entity !== 'task') return value;
  const topic = value.topicId ? rows.topic[value.topicId] : null;
  value.topic = topic ? { id: topic.id, name: topic.row.name, archivedAt: topic.row.archivedAt } : null;
  value.tags = (value.tagIds ?? []).map((id: string) => rows.tag[id]).filter(Boolean).map((tag: ReplicaRow) => replicaDto(rows, 'tag', tag)).sort((a: any, b: any) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  value.allowedTransitions = value.deletedAt || topic?.row.archivedAt ? [] : allowedTaskTransitions(value.status);
  if (children) value.children = Object.values(rows.task).filter(item => item.row.parentId === stored.id && !item.row.deletedAt).sort(manualOrder).map(item => replicaDto(rows, 'task', item));
  return value;
}
const manualOrder = (a: ReplicaRow, b: ReplicaRow) => Number(a.row.sortOrder) - Number(b.row.sortOrder) || a.id.localeCompare(b.id);

export function readReplica(state: BrowserReplica, url: URL): unknown {
  const path = url.pathname, query = url.searchParams, rows = state.rows;
  if (path === '/api/tags') return Object.values(rows.tag).map(row => replicaDto(rows, 'tag', row)).sort((a: any, b: any) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (path === '/api/topics') return Object.values(rows.topic).filter(row => Boolean(row.row.archivedAt) === (query.get('archived') === 'true')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map(row => replicaDto(rows, 'topic', row));
  const detail = path.match(/^\/api\/(tasks|topics)\/([^/]+)$/);
  if (detail) {
    const entity = detail[1] === 'tasks' ? 'task' : 'topic', stored = rows[entity][decodeURIComponent(detail[2])];
    if (!stored || stored.row.deletedAt || (entity === 'topic' && stored.row.archivedAt && query.get('includeArchived') !== 'true')) fail('NOT_FOUND', t('workspace:offline.errors.notFound'), 404);
    return replicaDto(rows, entity, stored, entity === 'task');
  }
  let tasks = Object.values(rows.task).filter(item => path === '/api/trash/tasks' ? Boolean(item.row.deletedAt) : !item.row.deletedAt);
  if (path !== '/api/trash/tasks') tasks = tasks.filter(({ row }) => {
    const topic = row.topicId ? rows.topic[String(row.topicId)] : null;
    if (query.get('includeArchived') !== 'true' && topic?.row.archivedAt) return false;
    if (query.get('topicId') && row.topicId !== query.get('topicId')) return false;
    if (query.get('inbox') === 'true' && row.topicId !== null) return false;
    if (query.has('parentId') && row.parentId !== (query.get('parentId') === 'null' ? null : query.get('parentId'))) return false;
    const status = query.get('status');
    if (status === 'open' && row.status === 'done' || status && status !== 'all' && status !== 'open' && row.status !== status) return false;
    const q = query.get('q')?.trim().toLowerCase();
    if (q && !`${row.title}\n${row.description}`.toLowerCase().includes(q)) return false;
    for (const [key, lower] of [['dueFrom', true], ['dueTo', false]] as const) {
      const bound = query.get(key);
      if (bound && (typeof row.dueDate !== 'string' || (lower ? row.dueDate < bound : row.dueDate > bound))) return false;
    }
    const from = query.get('scheduledFrom'), to = query.get('scheduledTo');
    if (from || to) {
      const start = row.scheduledStart as string | null, end = row.scheduledEnd as string | null, due = row.dueDate as string | null;
      if (!start) { if (!due || from && due < from || to && due > to) return false; }
      else if ((to && start >= shiftMinutes(`${to}T00:00`, 1440)) || (from && (end ? end <= `${from}T00:00` : start < `${from}T00:00`))) return false;
    }
    return (query.get('tagIds')?.split(',').filter(Boolean) ?? []).every(id => (row.tagIds as string[]).includes(id));
  });
  const sort = query.get('sort') ?? (['q', 'tagIds', 'dueFrom', 'dueTo'].some(key => query.has(key)) ? 'date' : 'manual');
  tasks.sort(path === '/api/trash/tasks' ? (a, b) => String(b.row.deletedAt).localeCompare(String(a.row.deletedAt)) || a.id.localeCompare(b.id) : sort === 'manual' ? manualOrder : (a, b) => {
    const date = String(a.row.scheduledStart ?? a.row.dueDate ?? '9999-99-99').localeCompare(String(b.row.scheduledStart ?? b.row.dueDate ?? '9999-99-99'));
    const priority = rank[String(b.row.priority)] - rank[String(a.row.priority)];
    return (sort === 'priority' ? priority || date : date || priority) || a.id.localeCompare(b.id);
  });
  return tasks.map(row => replicaDto(rows, 'task', row));
}

/** Owner UI mutations only. AI proposals, execution, approvals and permanent deletes stay online. */
export function mutateReplica(rows: ReplicaRows, path: string, method: string, raw: Record<string, any>, requestId: string, stamp: string) {
  const before = structuredClone(rows);
  const parts = path.split('/');
  const entity: SyncEntityType = parts[2] === 'topics' ? 'topic' : parts[2] === 'tags' ? 'tag' : 'task';
  const restore = /^\/api\/trash\/tasks\/[^/]+\/restore$/.test(path);
  const id = restore ? parts[4] : parts[3];
  const existing = id ? rows[entity][id] : undefined;
  const activeTopic = (topicId: unknown) => {
    if (topicId == null) return;
    const topic = rows.topic[String(topicId)];
    if (!topic) fail('NOT_FOUND', t('workspace:offline.errors.topicMissing'), 404);
    if (topic.row.archivedAt) fail('TOPIC_ARCHIVED', t('workspace:offline.errors.archived'));
  };
  const editable = (taskId: string) => {
    const task = rows.task[taskId];
    if (!task || task.row.deletedAt) fail('TASK_NOT_EDITABLE', t('workspace:offline.errors.notEditable'));
    activeTopic(task.row.topicId); return task;
  };
  const children = (taskId: string) => Object.values(rows.task).filter(item => item.row.parentId === taskId);
  const order = (topicId: unknown, parentId: unknown) => Math.max(-1, ...Object.values(rows.task).filter(item => !item.row.deletedAt && item.row.topicId === topicId && item.row.parentId === parentId).map(item => Number(item.row.sortOrder))) + 1;
  const touch = (kind: SyncEntityType, key: string, patch: SyncRow) => {
    const item = rows[kind][key];
    const row = { ...item.row, ...patch };
    if (kind === 'task' && patch.status && patch.status !== item.row.status) {
      row.completedAt = patch.status === 'done' ? stamp : null;
      row.completedAtEstimated = false;
    }
    rows[kind][key] = { ...item, row, revision: item.revision + 1, updatedAt: stamp };
  };
  const parent = (parentId: unknown, reopen: boolean) => {
    if (typeof parentId === 'string' && rows.task[parentId]) touch('task', parentId, reopen && rows.task[parentId].row.status === 'done' ? { status: 'todo' } : {});
  };
  if (id && id !== 'reorder') {
    if (!existing) fail('NOT_FOUND', t('workspace:offline.errors.notFound'), 404);
    if (raw.expectedRevision !== existing!.revision) fail('VERSION_CONFLICT', t('workspace:offline.errors.version'));
  }
  let resultId = id;
  if (entity === 'task' && path === '/api/tasks/reorder' && method === 'POST') {
    const input = parseInput(reorderSchema, raw);
    const members = Object.values(rows.task).filter(item => !item.row.deletedAt && item.row.topicId === input.topicId && item.row.parentId === input.parentId);
    if (members.length !== input.orderedTaskIds.length || members.some(item => !input.orderedTaskIds.includes(item.id) || raw.expectedRevisions?.[item.id] !== item.revision)) fail('VERSION_CONFLICT', t('workspace:offline.errors.order'));
    input.orderedTaskIds.forEach((key, index) => { editable(key); touch('task', key, { sortOrder: index }); });
  } else if (method === 'POST' && !id) {
    resultId = requestId;
    if (rows[entity][resultId]) fail('VERSION_CONFLICT', t('workspace:offline.errors.existing'));
    let row: SyncRow;
    if (entity === 'task') {
      const input = parseInput(taskCreateSchema, raw);
      if (input.status && input.status !== 'todo') fail('INVALID_INITIAL_TASK_STATUS', t('workspace:offline.errors.initial'), 400);
      const p = input.parentId ? editable(input.parentId) : null;
      if (p?.row.parentId) fail('INVALID_PARENT', t('workspace:offline.errors.depth'), 400);
      const topicId = input.topicId === undefined ? p?.row.topicId ?? null : input.topicId;
      if (p && p.row.topicId !== topicId) fail('INVALID_PARENT', t('workspace:offline.errors.topicRelation'), 400);
      activeTopic(topicId);
      if ((input.tagIds ?? []).some(tag => !rows.tag[tag])) fail('NOT_FOUND', t('workspace:offline.errors.tags'), 404);
      row = { description: '', status: 'todo', priority: 'none', estimatedMinutes: null, resultSummary: '', recurrenceRule: '', deletedAt: null, deleteBatchId: null, tagIds: [], ...input, ...normalizeSchedule(emptySchedule, input), topicId, parentId: p?.id ?? null, sortOrder: order(topicId, p?.id ?? null), completedAt: null, completedAtEstimated: false, createdAt: stamp };
      parent(p?.id, true);
    } else if (entity === 'topic') row = { description: '', color: 'slate', isExploration: false, goal: '', draftSummary: '', finalSummary: '', summaryStatus: 'empty', summaryUpdatedAt: null, archivedAt: null, ...parseInput(topicCreateSchema, raw) };
    else row = { color: 'violet', ...parseInput(tagCreateSchema, raw) };
    rows[entity][resultId] = { id: resultId, row, revision: 1, createdAt: stamp, updatedAt: stamp };
  } else if (method === 'PATCH' && existing) {
    if (entity === 'task') {
      const beforeTask = editable(id), input = parseInput(taskUpdateSchema, raw);
      if (input.status) TaskDomain.restore({ id, status: beforeTask.row.status as any, topicId: beforeTask.row.topicId as string | null, deletedAt: null }).transitionTo(input.status);
      let parentId = input.parentId === undefined ? beforeTask.row.parentId : input.parentId;
      let topicId = input.topicId === undefined ? beforeTask.row.topicId : input.topicId;
      if (input.parentId) {
        const p = editable(input.parentId);
        if (p.id === id || p.row.parentId || children(id).length) fail('INVALID_PARENT', t('workspace:offline.errors.cycle'), 400);
        if (input.topicId !== undefined && p.row.topicId !== input.topicId) fail('INVALID_PARENT', t('workspace:offline.errors.topicRelation'), 400);
        topicId = p.row.topicId;
      } else if (parentId && topicId !== beforeTask.row.topicId) parentId = null;
      activeTopic(topicId);
      if (input.tagIds?.some(tag => !rows.tag[tag])) fail('NOT_FOUND', t('workspace:offline.errors.tags'), 404);
      const unfinished = children(id).filter(item => !item.row.deletedAt && item.row.status !== 'done');
      if (input.status === 'done' && unfinished.length && !input.completeChildren) fail('SUBTASKS_INCOMPLETE', t('workspace:offline.errors.children'));
      const { completeChildren: _, ...patch } = input;
      const moved = parentId !== beforeTask.row.parentId || topicId !== beforeTask.row.topicId;
      touch('task', id, { ...patch, ...normalizeSchedule(beforeTask.row as any, input), parentId, topicId, ...(moved ? { sortOrder: order(topicId, parentId) } : {}) });
      if (topicId !== beforeTask.row.topicId) for (const child of children(id)) touch('task', child.id, { topicId });
      if (input.status === 'done') for (const child of unfinished) touch('task', child.id, { status: 'done' });
      const textOnly = Object.keys(input).every(field => field === 'title' || field === 'description');
      if (!textOnly) { if (beforeTask.row.parentId !== parentId) parent(beforeTask.row.parentId, false); parent(parentId, rows.task[id].row.status !== 'done'); }
      // Mirror of TaskService.update: completing a recurring task spawns the next occurrence in the same request.
      if (input.status === 'done' && beforeTask.row.status !== 'done') {
        const done = rows.task[id].row;
        const rule = parseRecurrenceRule(String(done.recurrenceRule ?? ''));
        if (rule) {
          const schedule = normalizeSchedule({ dueDate: done.dueDate as string | null, scheduledStart: done.scheduledStart as string | null, scheduledEnd: done.scheduledEnd as string | null }, { dueDate: nextRecurrenceDate(rule, recurrenceAnchor(done.dueDate as string | null, done.scheduledStart as string | null)) });
          const nextId = crypto.randomUUID();
          rows.task[nextId] = { id: nextId, revision: 1, createdAt: stamp, updatedAt: stamp, row: { title: done.title, description: done.description, status: 'todo', priority: done.priority, estimatedMinutes: done.estimatedMinutes, resultSummary: '', recurrenceRule: recurrenceRuleText(rule), deletedAt: null, deleteBatchId: null, tagIds: [...(done.tagIds as string[])], ...schedule, topicId, parentId, sortOrder: order(topicId, parentId), completedAt: null, completedAtEstimated: false, createdAt: stamp } };
          parent(parentId, true);
        }
      }
    } else { if (entity === 'topic') activeTopic(id); touch(entity, id, parseInput(entity === 'topic' ? topicUpdateSchema : tagUpdateSchema, raw)); }
  } else if (method === 'DELETE' && existing) {
    if (entity === 'task') {
      editable(id);
      for (const item of [existing, ...children(id).filter(item => !item.row.deletedAt)]) touch('task', item.id, { deletedAt: stamp, deleteBatchId: requestId });
      parent(existing.row.parentId, false);
    } else if (entity === 'tag') {
      for (const item of Object.values(rows.task)) if ((item.row.tagIds as string[]).includes(id)) touch('task', item.id, { tagIds: (item.row.tagIds as string[]).filter(key => key !== id) });
      delete rows.tag[id];
    } else fail('OFFLINE_UNSUPPORTED', t('workspace:offline.errors.online'), 503);
  } else if (restore && existing) {
    if (!existing.row.deletedAt) fail('TASK_NOT_DELETED', t('workspace:offline.errors.notDeleted'));
    const topicId = existing.row.topicId && rows.topic[String(existing.row.topicId)] && !rows.topic[String(existing.row.topicId)].row.archivedAt ? existing.row.topicId : null;
    const p = existing.row.parentId ? rows.task[String(existing.row.parentId)] : null;
    const parentId = p && !p.row.deletedAt && !p.row.parentId && p.row.topicId === topicId ? p.id : null;
    touch('task', id, { deletedAt: null, deleteBatchId: null, topicId, parentId, sortOrder: order(topicId, parentId) });
    for (const child of children(id)) if (child.row.deletedAt && existing.row.deleteBatchId && child.row.deleteBatchId === existing.row.deleteBatchId) touch('task', child.id, { deletedAt: null, deleteBatchId: null, topicId });
    parent(parentId, existing.row.status !== 'done');
  } else fail('OFFLINE_UNSUPPORTED', t('workspace:offline.errors.online'), 503);
  const changes = (['topic', 'tag', 'task'] as const).flatMap(kind => [...new Set([...Object.keys(before[kind]), ...Object.keys(rows[kind])])].flatMap(key => {
    const previous = canonicalSyncRow(kind, before[kind][key]?.row), next = canonicalSyncRow(kind, rows[kind][key]?.row);
    return syncRowsEqual(kind, previous, next) ? [] : [{ opId: `${requestId}:${kind}:${key}`, entityType: kind, entityId: key, before: previous, after: next }];
  }));
  // Empty parent touches still participate in cascade confirmation and local CAS,
  // just like ChangeGroup on the server; only actual field changes enter sync.
  const affected = [...new Set([...Object.keys(before.task), ...Object.keys(rows.task)])].filter(key => before.task[key]?.revision !== rows.task[key]?.revision);
  const cascade = path !== '/api/tasks/reorder' && (entity === 'task' ? affected.some(key => key !== resultId) : affected.length > 0);
  return { changes, affected, cascade, result: resultId && rows[entity][resultId] ? replicaDto(rows, entity, rows[entity][resultId], entity === 'task') : { orderedTaskIds: raw.orderedTaskIds ?? [], id: resultId }, before };
}
