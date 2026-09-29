import { prisma } from '../infrastructure/prisma.js';
import { assertTopicAccess, type Actor } from './security.js';
import { notFound } from './workspace-store.js';

const statuses = new Set(['todo', 'doing', 'blocked', 'done']);
const priorities = new Set(['none', 'low', 'medium', 'high']);

type Snap = {
  title: string;
  description: string;
  status: string;
  priority: string;
  dueDate: string | null;
  resultSummary: string;
  topicId: string | null;
  parentId: string | null;
  tagIds: string[];
  deletedAt: string | null;
};

type RawChange =
  | { field: 'title' | 'description' | 'resultSummary'; before: string; after: string }
  | { field: 'status' | 'priority'; before: string; after: string }
  | { field: 'dueDate'; before: string | null; after: string | null }
  | { field: 'topicId'; before: string | null; after: string | null }
  | { field: 'parentId'; before: string | null; after: string | null }
  | { field: 'tagIds'; before: string[]; after: string[] }
  | { field: 'deleted'; before: boolean; after: boolean };

type RawEvent = {
  id: string;
  at: string;
  source: string;
  actorId: string | null;
  connectionId: string | null;
  action: 'create' | 'update' | 'delete' | 'restore' | 'undo';
  changes: RawChange[];
};

export type TaskActivityEvent = {
  id: string;
  at: string;
  actor: { kind: 'user' | 'agent'; name: string };
  action: RawEvent['action'];
  changes: Array<
    | { field: 'title' | 'description' | 'resultSummary'; before: string; after: string }
    | { field: 'status' | 'priority'; before: string; after: string }
    | { field: 'dueDate'; before: string | null; after: string | null }
    | { field: 'topicId'; before: { id: string | null; name: string }; after: { id: string | null; name: string } }
    | { field: 'parentId'; before: { id: string | null; title: string }; after: { id: string | null; title: string } }
    | { field: 'tagIds'; before: string[]; after: string[] }
    | { field: 'deleted'; before: boolean; after: boolean }
  >;
};

const canReadTopic = (actor: Actor, topicId: string | null) => topicId === null ? actor.includeInbox : actor.topicIds === 'all' || actor.topicIds.includes(topicId);

function snap(value: unknown): Snap | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const tagIds = Array.isArray(raw.tagIds) ? raw.tagIds.filter((id): id is string => typeof id === 'string').sort() : [];
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    status: typeof raw.status === 'string' ? raw.status : 'todo',
    priority: typeof raw.priority === 'string' ? raw.priority : 'none',
    dueDate: typeof raw.dueDate === 'string' ? raw.dueDate : null,
    resultSummary: typeof raw.resultSummary === 'string' ? raw.resultSummary : '',
    topicId: typeof raw.topicId === 'string' ? raw.topicId : null,
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    tagIds,
    deletedAt: typeof raw.deletedAt === 'string' ? raw.deletedAt : null,
  };
}

/** A change record may be a group snapshot, a nested batch, or an older task object.
 * Unreadable JSON is ignored. The task is "present" only when this record actually stored it. */
function readTaskState(raw: string | null, taskId: string) {
  const found = { present: false, task: null as Snap | null };
  if (!raw) return found;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return found; }
  visit(parsed, taskId, found, 0);
  return found;
}

function visit(value: unknown, taskId: string, found: { present: boolean; task: Snap | null }, depth: number) {
  if (found.present || depth > 8 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, taskId, found, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const tasks = (record.entities as { tasks?: Record<string, unknown> } | undefined)?.tasks;
  if (tasks && Object.prototype.hasOwnProperty.call(tasks, taskId)) {
    found.present = true;
    found.task = snap(tasks[taskId]);
    return;
  }
  if (typeof record.id === 'string' && record.id === taskId && ('title' in record || 'status' in record)) {
    found.present = true;
    found.task = snap(record);
    return;
  }
  if (typeof record.snapshot === 'string') {
    try { visit(JSON.parse(record.snapshot), taskId, found, depth + 1); } catch { /* Skip one bad nested snapshot. */ }
  } else if (record.snapshot && typeof record.snapshot === 'object') visit(record.snapshot, taskId, found, depth + 1);
  if (Array.isArray(record.changes)) visit(record.changes, taskId, found, depth + 1);
  if (Array.isArray(record.tasks)) visit(record.tasks, taskId, found, depth + 1);
}

function sameTags(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function diff(before: Snap | null, after: Snap | null, operation: string): { action: RawEvent['action']; changes: RawChange[] } | null {
  const undo = operation.startsWith('undo:');
  if (!before && after && !undo) return { action: 'create', changes: [] };
  if (!before || !after) return null;
  const changes: RawChange[] = [];
  if (before.title !== after.title) changes.push({ field: 'title', before: before.title, after: after.title });
  if (before.description !== after.description) changes.push({ field: 'description', before: before.description, after: after.description });
  if (before.resultSummary !== after.resultSummary) changes.push({ field: 'resultSummary', before: before.resultSummary, after: after.resultSummary });
  if (before.status !== after.status && statuses.has(before.status) && statuses.has(after.status)) changes.push({ field: 'status', before: before.status, after: after.status });
  if (before.priority !== after.priority && priorities.has(before.priority) && priorities.has(after.priority)) changes.push({ field: 'priority', before: before.priority, after: after.priority });
  if (before.dueDate !== after.dueDate) changes.push({ field: 'dueDate', before: before.dueDate, after: after.dueDate });
  if (before.topicId !== after.topicId) changes.push({ field: 'topicId', before: before.topicId, after: after.topicId });
  if (before.parentId !== after.parentId) changes.push({ field: 'parentId', before: before.parentId, after: after.parentId });
  if (!sameTags(before.tagIds, after.tagIds)) changes.push({ field: 'tagIds', before: before.tagIds, after: after.tagIds });
  const deletedBefore = Boolean(before.deletedAt);
  const deletedAfter = Boolean(after.deletedAt);
  if (deletedBefore !== deletedAfter) changes.push({ field: 'deleted', before: deletedBefore, after: deletedAfter });
  if (undo) return changes.length ? { action: 'undo', changes } : null;
  if (!deletedBefore && deletedAfter) return { action: 'delete', changes: changes.filter((change) => change.field !== 'deleted') };
  if (deletedBefore && !deletedAfter) return { action: 'restore', changes: changes.filter((change) => change.field !== 'deleted') };
  return changes.length ? { action: 'update', changes } : null;
}

function topicName(actor: Actor, topicId: string | null, names: Map<string, string>) {
  if (!canReadTopic(actor, topicId)) return { id: null, name: '范围外清单' };
  if (topicId === null) return { id: null, name: '收集箱' };
  return { id: topicId, name: names.get(topicId) ?? '已删除的清单' };
}

function parentName(actor: Actor, parentId: string | null, parents: Map<string, { title: string; topicId: string | null }>) {
  if (!parentId) return { id: null, title: '无' };
  const parent = parents.get(parentId);
  if (!parent || !canReadTopic(actor, parent.topicId)) return { id: null, title: parent ? '范围外任务' : '已删除的任务' };
  return { id: parentId, title: parent.title };
}

function tagNames(ids: string[], names: Map<string, string>) {
  return ids.map((id) => names.get(id) ?? '已删除的标签');
}

export async function taskActivity(actor: Actor, taskId: string): Promise<TaskActivityEvent[]> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, topicId: true, createdAt: true } });
  if (!task) throw notFound('任务不存在');
  assertTopicAccess(actor, task.topicId);
  // Child changes are stored on the parent record, and batches use a workspace id.
  // Match the task id inside the snapshot, then keep only this task's own fields.
  const records = await prisma.changeRecord.findMany({
    where: { OR: [{ beforeSnapshot: { contains: taskId } }, { afterSnapshot: { contains: taskId } }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const raw: RawEvent[] = [];
  for (const record of records) {
    const before = readTaskState(record.beforeSnapshot, taskId);
    const after = readTaskState(record.afterSnapshot, taskId);
    if (!before.present && !after.present) continue;
    const change = diff(before.present ? before.task : null, after.present ? after.task : null, record.operation);
    if (!change) continue;
    raw.push({ id: record.id, at: record.createdAt, source: record.source, actorId: record.actorId, connectionId: record.connectionId, ...change });
  }
  if (!raw.some((event) => event.action === 'create')) {
    raw.push({ id: `created:${task.id}`, at: task.createdAt, source: 'user', actorId: actor.kind === 'user' ? actor.id : null, connectionId: null, action: 'create', changes: [] });
  }
  raw.sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id));

  const topicIds = new Set<string>();
  const parentIds = new Set<string>();
  const tagIds = new Set<string>();
  const connectionIds = new Set<string>();
  for (const event of raw) {
    if (event.connectionId) connectionIds.add(event.connectionId);
    for (const change of event.changes) {
      if (change.field === 'topicId') { if (change.before) topicIds.add(change.before); if (change.after) topicIds.add(change.after); }
      if (change.field === 'parentId') { if (change.before) parentIds.add(change.before); if (change.after) parentIds.add(change.after); }
      if (change.field === 'tagIds') { change.before.forEach((id) => tagIds.add(id)); change.after.forEach((id) => tagIds.add(id)); }
    }
  }
  const [topics, parents, tags, connections] = await Promise.all([
    topicIds.size ? prisma.topic.findMany({ where: { id: { in: [...topicIds] } }, select: { id: true, name: true } }) : [],
    parentIds.size ? prisma.task.findMany({ where: { id: { in: [...parentIds] } }, select: { id: true, title: true, topicId: true } }) : [],
    tagIds.size ? prisma.tag.findMany({ where: { id: { in: [...tagIds] } }, select: { id: true, name: true } }) : [],
    connectionIds.size ? prisma.connection.findMany({ where: { id: { in: [...connectionIds] } }, select: { id: true, name: true } }) : [],
  ]);
  const topicMap = new Map(topics.map((item) => [item.id, item.name]));
  const parentMap = new Map(parents.map((item) => [item.id, item]));
  const tagMap = new Map(tags.map((item) => [item.id, item.name]));
  const connectionMap = new Map(connections.map((item) => [item.id, item.name]));

  const present = (change: RawChange): TaskActivityEvent['changes'][number] => {
    if (change.field === 'topicId') return { field: 'topicId', before: topicName(actor, change.before, topicMap), after: topicName(actor, change.after, topicMap) };
    if (change.field === 'parentId') return { field: 'parentId', before: parentName(actor, change.before, parentMap), after: parentName(actor, change.after, parentMap) };
    if (change.field === 'tagIds') return { field: 'tagIds', before: tagNames(change.before, tagMap), after: tagNames(change.after, tagMap) };
    return change;
  };
  return raw.map((event) => ({
    id: event.id,
    at: event.at,
    action: event.action,
    actor: event.source === 'user' || event.actorId === 'local-owner'
      ? { kind: 'user' as const, name: '你' }
      : { kind: 'agent' as const, name: (event.connectionId && connectionMap.get(event.connectionId)) || 'AI' },
    changes: event.changes.map(present),
  }));
}
