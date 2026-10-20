import { t } from '../i18n/index.js';
import { affectedTasksOf, commandFamily, previewEntries, type AffectedTask, type ProposalKind } from './proposal-fields.js';

export type ProposalCommand = {
  kind: string;
  targetId?: string;
  expectedRevision?: number;
  input?: Record<string, unknown>;
  clientRef?: string;
  entityId?: string;
  evidence?: unknown;
};

export type ProposalItem = {
  index: number;
  kind: string;
  created: boolean;
  deleted: boolean;
  title: string;
  parentIndex: number | null;
  dependsOn: number[];
  command: ProposalCommand;
  detail: Record<string, unknown>;
};

export type ProposalAnalysis = {
  type: ProposalKind;
  items: ProposalItem[];
  needsGroupNote: boolean;
  affectedTasks: AffectedTask[];
  topicIds: Array<string | null>;
  createdCount: number;
  updatedCount: number;
  deletedCount: number;
  confirmKey: 'confirm.single' | 'confirm.group';
  confirmLabel: string;
  title: string;
};

const referenceFields = new Set(['id', 'topicId', 'parentId', 'taskId', 'materialId', 'memoryId', 'tagIds', 'taskIds', 'materialIds', 'memoryIds', 'orderedTaskIds']);

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asCommands(value: unknown): ProposalCommand[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) as unknown; } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is ProposalCommand => Boolean(item) && typeof item === 'object' && typeof (item as ProposalCommand).kind === 'string');
}

function referencedIds(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const ids: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!referenceFields.has(key)) continue;
    if (typeof value === 'string' && value) ids.push(value);
    else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string' && item) ids.push(item);
  }
  return ids;
}

function displayName(command: ProposalCommand, detail: Record<string, unknown>): string {
  const before = detail.before;
  const beforeRow = before && typeof before === 'object' && !Array.isArray(before) ? before as Record<string, unknown> : {};
  const beforeTitle = textOf(beforeRow.title) || textOf(beforeRow.name);
  const input = command.input ?? {};
  const inputTitle = textOf(input.title) || textOf(input.name);
  const detailTitle = textOf(detail.title) || textOf(detail.name);
  if (!command.kind.endsWith('.create')) return beforeTitle || inputTitle || detailTitle;
  return inputTitle || detailTitle || beforeTitle;
}

function singleTitle(command: ProposalCommand, detail: Record<string, unknown>): string {
  const name = displayName(command, detail) || t('proposals:head.untitled');
  switch (command.kind) {
    case 'memory.create': return t('proposals:head.memorySave');
    case 'memory.update': return t('proposals:head.memoryUpdate', { title: name });
    case 'memory.retire': return t('proposals:head.memoryRetire', { title: name });
    case 'memory.crystallize': return t('proposals:head.memoryCrystallize', { title: name });
    case 'task.create': return t('proposals:head.taskCreate', { title: name });
    case 'task.update': return t('proposals:head.taskUpdate', { title: name });
    case 'task.delete':
    case 'task.permanent_delete': return t('proposals:head.taskDelete', { title: name });
    case 'task.restore': return t('proposals:head.taskRestore', { title: name });
    case 'task.reorder': return t('proposals:head.taskReorder');
    case 'skill.create': return t('proposals:head.skillCreate', { title: name });
    case 'skill.update': return t('proposals:head.skillUpdate', { title: name });
    default: return name === t('proposals:head.untitled') ? command.kind : t('proposals:head.named', { operation: command.kind, title: name });
  }
}

function groupTitle(type: ProposalKind, count: number): string {
  if (type === 'task') return t('proposals:head.taskGroup', { count });
  if (type === 'memory') return t('proposals:head.memoryGroup', { count });
  if (type === 'skill') return t('proposals:head.skillGroup', { count });
  return t('proposals:head.otherGroup', { count });
}

function pushTopic(ids: Array<string | null>, value: unknown) {
  if (value === null) {
    if (!ids.includes(null)) ids.push(null);
    return;
  }
  if (typeof value === 'string' && value && !ids.includes(value)) ids.push(value);
}

export function analyzeProposal(commandsInput: unknown, preview: unknown): ProposalAnalysis {
  const commands = asCommands(commandsInput);
  const entries = previewEntries(preview);
  const indexByEntity = new Map<string, number>();
  commands.forEach((command, index) => { if (command.entityId) indexByEntity.set(command.entityId, index + 1); });
  const topicIds: Array<string | null> = [];
  const items: ProposalItem[] = commands.map((command, index) => {
    const detail = entries[index]?.detail ?? {};
    const input = command.input ?? {};
    const depends = new Set<number>();
    for (const id of referencedIds(input)) {
      const at = indexByEntity.get(id);
      if (at && at !== index + 1) depends.add(at);
    }
    if (command.targetId) {
      const at = indexByEntity.get(command.targetId);
      if (at && at !== index + 1) depends.add(at);
    }
    const parentId = typeof input.parentId === 'string' ? input.parentId : '';
    const parentAt = parentId ? indexByEntity.get(parentId) : undefined;
    const parentIndex = parentAt && parentAt !== index + 1 ? parentAt : null;
    if ('topicId' in input) pushTopic(topicIds, input.topicId);
    else if (detail.before && typeof detail.before === 'object' && !Array.isArray(detail.before)) pushTopic(topicIds, (detail.before as Record<string, unknown>).topicId);
    const deleted = command.kind.includes('delete') || command.kind.endsWith('.archive') || command.kind === 'memory.retire';
    return {
      index: index + 1,
      kind: command.kind,
      created: command.kind.endsWith('.create'),
      deleted,
      title: displayName(command, detail),
      parentIndex,
      dependsOn: [...depends].sort((left, right) => left - right),
      command,
      detail,
    };
  });
  const families = new Set(items.map((item) => commandFamily(item.kind)));
  const type: ProposalKind = families.size === 1 ? [...families][0] : 'other';
  const seen = new Set<string>();
  const affectedTasks: AffectedTask[] = [];
  for (const entry of entries) {
    for (const task of affectedTasksOf(entry.detail)) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      affectedTasks.push(task);
    }
  }
  const hasDependency = items.some((item) => item.dependsOn.length > 0);
  const needsGroupNote = items.length > 1 && (hasDependency || affectedTasks.length > 0);
  const confirmKey = items.length > 1 ? 'confirm.group' : 'confirm.single';
  return {
    type,
    items,
    needsGroupNote,
    affectedTasks,
    topicIds,
    createdCount: items.filter((item) => item.created).length,
    updatedCount: items.filter((item) => !item.created && !item.deleted).length,
    deletedCount: items.filter((item) => item.deleted).length,
    confirmKey,
    confirmLabel: t(`proposals:${confirmKey}`, { count: items.length }),
    title: items.length > 1 ? groupTitle(type, items.length) : items.length === 1 ? singleTitle(items[0].command, items[0].detail) : t('proposals:head.otherGroup', { count: 0 }),
  };
}

/** Circled index used by the group tree. Falls back past 20. */
export function itemMark(index: number): string {
  if (index >= 1 && index <= 20) return String.fromCodePoint(0x245F + index);
  return `(${index})`;
}

export function groupNote(analysis: ProposalAnalysis, sourceLabel: string): string {
  if (!analysis.needsGroupNote) return '';
  const separator = t('proposals:listSeparator');
  const byParent = new Map<number, number[]>();
  for (const item of analysis.items) {
    if (!item.parentIndex) continue;
    const list = byParent.get(item.parentIndex) ?? [];
    list.push(item.index);
    byParent.set(item.parentIndex, list);
  }
  const parts: string[] = [];
  for (const [parent, children] of byParent) parts.push(t('proposals:group.explainChildren', { children: children.join(separator), parent: String(parent) }));
  if (!byParent.size) {
    const dangling = analysis.items.filter((item) => item.dependsOn.length > 0);
    if (dangling.length) parts.push(t('proposals:group.explainDepends', { items: dangling.map((item) => item.index).join(separator) }));
  }
  return t('proposals:group.explain', { count: analysis.items.length, source: sourceLabel, detail: parts.join('') });
}
