import type { Task } from './api.js';

export const queryKeys = {
  tasks: ['tasks'] as const,
  taskList: (query: string) => ['tasks', 'list', query] as const,
  task: (id: string) => ['task', id] as const,
  topics: ['topics'] as const,
  topic: (id: string) => ['topic', id] as const,
  tags: ['tags'] as const,
  trash: ['trash', 'tasks'] as const,
};

// A shared queue also covers detail saves, list actions and grouped writes.
// Rejections do not poison the queue, and disjoint tasks can still be saved together.
export function createWriteQueue() {
  const pending = new Map<string, Promise<unknown>>();
  return function enqueue<T>(keys: string[], write: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)];
    const before = unique.map((key) => pending.get(key)).filter(Boolean);
    const result = Promise.all(before.map((item) => item!.catch(() => undefined))).then(write);
    unique.forEach((key) => pending.set(key, result));
    const clean = () => unique.forEach((key) => { if (pending.get(key) === result) pending.delete(key); });
    result.then(clean, clean);
    return result;
  };
}
export const enqueueWrite = createWriteQueue();
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function captureDraftKey(topicId: string | null, parentId: string | null) {
  return `todo.capture.${topicId ?? 'inbox'}.${parentId ?? 'root'}`;
}
export function isCompositionKey(event: { isComposing?: boolean; keyCode?: number; repeat?: boolean }) {
  return Boolean(event.isComposing || event.keyCode === 229 || event.repeat);
}
export function keepNewestTask(old: Task | undefined, next: Task): Task {
  return old && (old.revision ?? 0) > (next.revision ?? 0) ? old : next;
}
export const editableFields = ['title', 'description', 'status', 'priority', 'dueDate', 'resultSummary', 'topicId', 'parentId', 'tagIds'] as const;
export type TaskDraft = Pick<Task, typeof editableFields[number]>;
export function taskDraft(task: Task): TaskDraft {
  return { title: task.title, description: task.description ?? '', status: task.status, priority: task.priority ?? 'none', dueDate: task.dueDate ?? null, resultSummary: task.resultSummary ?? '', topicId: task.topicId ?? null, parentId: task.parentId ?? null, tagIds: task.tagIds ?? task.tags?.map((tag) => tag.id) ?? [] };
}
export function sameField(a: unknown, b: unknown) {
  return Array.isArray(a) && Array.isArray(b) ? [...a].sort().join('\0') === [...b].sort().join('\0') : a === b;
}
export function draftPatch(base: TaskDraft, draft: TaskDraft): Partial<TaskDraft> {
  return Object.fromEntries(editableFields.filter((field) => !sameField(base[field], draft[field])).map((field) => [field, draft[field]]));
}
export function mergeTaskDraft(base: TaskDraft, draft: TaskDraft, incoming: TaskDraft) {
  const next = { ...draft };
  const conflicts: string[] = [];
  for (const field of editableFields) {
    if (sameField(base[field], draft[field])) Object.assign(next, { [field]: incoming[field] });
    else if (!sameField(base[field], incoming[field]) && !sameField(draft[field], incoming[field])) conflicts.push(field);
  }
  return { draft: next, conflicts };
}
