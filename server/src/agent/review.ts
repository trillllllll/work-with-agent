import { createHash } from 'node:crypto';
import type { ChangeRecord } from '@prisma/client';
import { canonical } from '../application/commands.js';
import { isGroup } from '../application/workspace-store.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const statusText: Record<string, string> = { todo: '待办', doing: '进行中', blocked: '阻塞', done: '已完成', learning: '学习中' };
const colorText: Record<string, string> = { violet: '紫', blue: '蓝', teal: '青', green: '绿', amber: '琥珀', rose: '玫红', slate: '灰' };
const priorityText: Record<string, string> = { none: '无', low: '低', medium: '中', high: '高' };

const taskKeys = ['title', 'description', 'status', 'priority', 'dueDate', 'scheduledStart', 'scheduledEnd', 'estimatedMinutes', 'resultSummary', 'topicId', 'parentId', 'sortOrder', 'tagIds', 'deletedAt'] as const;
const topicKeys = ['name', 'description', 'goal', 'isExploration', 'color', 'draftSummary', 'archivedAt'] as const;
const materialKeys = ['title', 'kind', 'content', 'uri', 'topicId', 'folderId', 'tagIds', 'taskIds', 'archivedAt'] as const;
const memoryKeys = ['title', 'content', 'kind', 'importance', 'labels', 'status', 'evidence'] as const;
const tagKeys = ['name', 'color'] as const;
const folderKeys = ['name', 'parentId'] as const;
const skillKeys = ['name', 'description', 'instructions', 'enabled'] as const;
const learningMapKeys = ['title', 'goal', 'status', 'deletedAt'] as const;
const learningNodeKeys = ['title', 'detail', 'kind', 'status', 'mastery', 'parentId', 'sortOrder', 'deletedAt'] as const;
const learningActivityKeys = ['kind', 'content', 'nodeId'] as const;
const skillLabels: Record<string, string> = { name: '名称', description: '描述', instructions: '正文', enabled: '启用' };

const labels: Record<string, string> = {
  title: '标题', description: '详情', status: '状态', priority: '优先级', dueDate: '安排日期', scheduledStart: '开始时间', scheduledEnd: '结束时间',
  estimatedMinutes: '预计用时', resultSummary: '结果摘要', topicId: '清单', parentId: '父任务', sortOrder: '排序', tagIds: '标签', deletedAt: '删除状态',
  name: '名称', goal: '目标', isExploration: '探索标记', draftSummary: '成果草稿', archivedAt: '归档状态', kind: '类型', content: '正文', uri: '链接',
  folderId: '文件夹', taskIds: '关联任务', importance: '重要度', labels: '标签', evidence: '证据', color: '颜色',
  mastery: '掌握度', detail: '详情', nodeId: '条目',
};

export type ReviewEntityChange = {
  entityType: 'task' | 'topic' | 'tag' | 'material' | 'memory' | 'libraryFolder' | 'libraryTag' | 'skill' | 'learning_map' | 'learning_node' | 'learning_activity';
  entityId: string;
  titleBefore: string | null;
  titleAfter: string | null;
  operation: 'create' | 'update' | 'delete' | 'restore' | 'archive' | 'retire';
  origin: 'explicit' | 'related';
  revisionBefore: number | null;
  revisionAfter: number | null;
  fields: Array<{ key: string; label: string; before: JsonValue; after: JsonValue; beforeText: string; afterText: string }>;
};

export type ApprovalReview = {
  schemaVersion: 1;
  title: string;
  intent: string;
  requestedOperationCount: number;
  commandCount: number;
  affectedEntityCount: number;
  relatedEntityCount: number;
  atomic: true;
  reversibility: 'supported' | 'unsupported';
  reversibilityReason: string | null;
  consequences: string[];
  entities: ReviewEntityChange[];
  previewHash: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function show(key: string, value: unknown): string {
  if (value === null || value === undefined) return '未设置';
  if (value === '' || (Array.isArray(value) && value.length === 0)) return '清空';
  if (key === 'status' && typeof value === 'string') return statusText[value] ?? value;
  if (key === 'color' && typeof value === 'string') return colorText[value] ?? value;
  if (key === 'priority' && typeof value === 'string') return priorityText[value] ?? value;
  if (key === 'deletedAt') return value ? '已删除' : '未删除';
  if (key === 'archivedAt') return value ? '已归档' : '未归档';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('、') || '清空';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonValue(item)]));
  return String(value);
}

function titleOf(row: Record<string, unknown> | null) {
  if (!row) return null;
  const title = row.title ?? row.name;
  return typeof title === 'string' ? title : null;
}

function revisionOf(row: Record<string, unknown> | null) {
  return typeof row?.revision === 'number' ? row.revision : null;
}

function operationOf(entityType: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): ReviewEntityChange['operation'] {
  if (!before && after) return 'create';
  if (before && !after) return 'delete';
  if (before?.deletedAt && !after?.deletedAt) return 'restore';
  if (!before?.deletedAt && after?.deletedAt) return 'delete';
  if (!before?.archivedAt && after?.archivedAt) return 'archive';
  if (entityType === 'memory' && before?.status !== 'retired' && after?.status === 'retired') return 'retire';
  return 'update';
}

function linkTaskIds(row: Record<string, unknown>): string[] | null {
  if (Array.isArray(row.taskIds)) return row.taskIds.filter((id): id is string => typeof id === 'string').slice().sort();
  if (!Array.isArray(row.links)) return null;
  return row.links.flatMap((link) => {
    if (!link || typeof link !== 'object') return [];
    const taskId = (link as { taskId?: unknown }).taskId;
    return typeof taskId === 'string' ? [taskId] : [];
  }).sort();
}

function projectMaterialLinks(row: Record<string, unknown> | null, ids: string[] | null, includeEmpty: boolean) {
  if (!row || ids === null || 'taskIds' in row) return row;
  if (ids.length === 0 && !includeEmpty) return row;
  return { ...row, taskIds: ids };
}

function fieldsFor(entityType: ReviewEntityChange['entityType'], before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (entityType === 'material') {
    const leftIds = before ? linkTaskIds(before) : null;
    const rightIds = after ? linkTaskIds(after) : null;
    const includeEmpty = Boolean(leftIds?.length || rightIds?.length);
    before = projectMaterialLinks(before, leftIds, includeEmpty);
    after = projectMaterialLinks(after, rightIds, includeEmpty);
  }
  const keys = entityType === 'task' ? taskKeys : entityType === 'topic' ? topicKeys : entityType === 'material' ? materialKeys : entityType === 'memory' ? memoryKeys : entityType === 'libraryFolder' ? folderKeys : entityType === 'skill' ? skillKeys : entityType === 'learning_map' ? learningMapKeys : entityType === 'learning_node' ? learningNodeKeys : entityType === 'learning_activity' ? learningActivityKeys : tagKeys;
  const fields = [];
  for (const key of keys) {
    const left = before?.[key] ?? null;
    const right = after?.[key] ?? null;
    if (canonical(left) === canonical(right)) continue;
    if (!before && (right === '' || (Array.isArray(right) && right.length === 0))) continue;
    fields.push({ key, label: entityType === 'skill' ? skillLabels[key] ?? key : labels[key] ?? key, before: jsonValue(left), after: jsonValue(right), beforeText: show(key, left), afterText: show(key, right) });
  }
  return fields;
}

type Slot = { entityType: ReviewEntityChange['entityType']; entityId: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null };

function remember(slots: Map<string, Slot>, entityType: Slot['entityType'], entityId: string, before: unknown, after: unknown) {
  const key = `${entityType}:${entityId}`;
  const current = slots.get(key) ?? { entityType, entityId, before: null, after: null };
  if (!slots.has(key)) current.before = asRecord(before);
  const next = asRecord(after);
  current.after = current.after && next ? { ...current.after, ...next } : next ?? current.after;
  slots.set(key, current);
}

function absorb(slots: Map<string, Slot>, record: ChangeRecord) {
  let before: unknown = null;
  let after: unknown = null;
  try { before = record.beforeSnapshot ? JSON.parse(record.beforeSnapshot) : null; } catch { return; }
  try { after = record.afterSnapshot ? JSON.parse(record.afterSnapshot) : null; } catch { return; }
  if (isGroup(before) && isGroup(after)) {
    for (const kind of ['tasks', 'topics', 'tags'] as const) {
      const entityType = kind === 'tasks' ? 'task' : kind === 'topics' ? 'topic' : 'tag';
      const ids = new Set([...Object.keys(before.entities[kind]), ...Object.keys(after.entities[kind])]);
      for (const id of ids) remember(slots, entityType, id, before.entities[kind][id], after.entities[kind][id]);
    }
    return;
  }
  const entityType = record.entityType as Slot['entityType'];
  if (!['task', 'topic', 'tag', 'material', 'memory', 'libraryFolder', 'libraryTag', 'skill', 'learning_map', 'learning_node', 'learning_activity'].includes(entityType)) return;
  remember(slots, entityType, record.entityId, before, after);
}

export function buildReview(input: { intent: string; requestedOperationCount: number; commandCount: number; explicitIds: string[]; records: ChangeRecord[] }): Omit<ApprovalReview, 'previewHash'> & { previewHash?: string } {
  const slots = new Map<string, Slot>();
  for (const record of input.records) absorb(slots, record);
  const explicit = new Set(input.explicitIds);
  const entities: ReviewEntityChange[] = [];
  for (const slot of slots.values()) {
    const fields = fieldsFor(slot.entityType, slot.before, slot.after);
    if (!fields.length && slot.before && slot.after) continue;
    const operation = operationOf(slot.entityType, slot.before, slot.after);
    entities.push({
      entityType: slot.entityType,
      entityId: slot.entityId,
      titleBefore: titleOf(slot.before),
      titleAfter: titleOf(slot.after),
      operation,
      origin: explicit.has(slot.entityId) ? 'explicit' : 'related',
      revisionBefore: revisionOf(slot.before),
      revisionAfter: revisionOf(slot.after),
      fields,
    });
  }
  const related = entities.filter((entity) => entity.origin === 'related');
  const explicitEntities = entities.filter((entity) => entity.origin === 'explicit');
  const taskCount = explicitEntities.filter((entity) => entity.entityType === 'task').length;
  const consequences = consequenceLines(entities);
  // 学习域尚无撤销处理器；如实标注，避免确认卡片给出错误预期。
  const learningOnly = entities.length > 0 && entities.every((entity) => entity.entityType.startsWith('learning_'));
  return {
    schemaVersion: 1,
    title: taskCount && taskCount === explicitEntities.length ? `修改 ${taskCount} 个任务` : `修改 ${Math.max(explicitEntities.length, input.requestedOperationCount)} 项`,
    intent: input.intent,
    requestedOperationCount: input.requestedOperationCount,
    commandCount: input.commandCount,
    affectedEntityCount: entities.length,
    relatedEntityCount: related.length,
    atomic: true,
    reversibility: learningOnly ? 'unsupported' : 'supported',
    reversibilityReason: learningOnly ? '学习域的修改暂不支持一键撤销' : null,
    consequences,
    entities,
  };
}

function consequenceLines(entities: ReviewEntityChange[]) {
  const lines: string[] = [];
  const schedule = entities.filter((entity) => entity.fields.some((field) => ['dueDate', 'scheduledStart', 'scheduledEnd'].includes(field.key)));
  if (schedule.length) {
    const dates = [...new Set(schedule.flatMap((entity) => entity.fields.filter((field) => field.key === 'dueDate').map((field) => `${field.beforeText} → ${field.afterText}`)))];
    lines.push(dates.length ? `安排变为 ${dates.join('；')}。` : `会调整 ${schedule.length} 个对象的安排。`);
  }
  const completed = entities.filter((entity) => entity.origin === 'related' && entity.fields.some((field) => field.key === 'status' && field.after === 'done'));
  if (completed.length) lines.push(`关联影响：另外 ${completed.length} 个子任务会一并完成`);
  const removed = entities.filter((entity) => entity.operation === 'delete');
  if (removed.length) lines.push(`会删除 ${removed.length} 个对象。确认前不会删除。`);
  const archived = entities.filter((entity) => entity.operation === 'archive');
  if (archived.length) lines.push(`会归档 ${archived.length} 个清单，任务仍留在原清单。`);
  const cleared = entities.filter((entity) => entity.fields.some((field) => field.afterText === '清空'));
  if (cleared.length) lines.push('包含清空字段。清空后原内容不会保留在该字段里。');
  const inbox = entities.filter((entity) => entity.fields.some((field) => field.key === 'topicId' && field.after === null));
  if (inbox.length) lines.push(`${inbox.length} 个任务会移出清单，进入收集箱。`);
  if (!lines.length) lines.push('确认后会一次性提交以上修改。');
  return lines;
}

export function previewHashOf(commands: unknown, preconditions: unknown, review: Omit<ApprovalReview, 'previewHash'>) {
  return createHash('sha256').update(canonical({ commands, preconditions, review })).digest('hex');
}
