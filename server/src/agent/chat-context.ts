import { z } from 'zod';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { ownerActor, assertTopicAccess } from '../application/security.js';
import { assertTimeZone } from './time.js';

const allPages = new Set(['today', 'plan', 'search', 'tags', 'library', 'topics', 'quadrant', 'archived', 'trash', 'focus']);

export const chatContextV2 = z.object({
  schemaVersion: z.literal(2),
  page: z.string().min(1),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('inbox') }).strict(),
    z.object({ kind: z.literal('topic'), topicId: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('all') }).strict(),
  ]),
  taskId: z.string().min(1).nullable(),
  materialId: z.string().min(1).nullable(),
  selectedTaskIds: z.array(z.string().min(1)).max(100),
  taskFilter: z.object({
    q: z.string().optional(),
    status: z.enum(['open', 'done', 'all', 'todo', 'doing', 'blocked']).optional(),
    dueFrom: z.string().optional(),
    dueTo: z.string().optional(),
    scheduledFrom: z.string().optional(),
    scheduledTo: z.string().optional(),
    tagIds: z.array(z.string()).optional(),
    sort: z.enum(['manual', 'date', 'priority']).optional(),
    includeArchived: z.boolean().optional(),
  }).strict().nullable(),
  timeZone: z.string().min(1),
  referencedApprovalId: z.string().min(1).nullable(),
}).strict();

export type ChatContextV2 = z.infer<typeof chatContextV2>;
const short = z.string().max(300);
export const chatAttachment = z.object({
  id: short.min(1), kind: z.enum(['draft', 'selection']), title: short,
  text: z.string().refine((value) => [...value].length <= 20000, '单个附件最多 20,000 字符'),
  taskId: short.optional(), materialId: short.optional(), unsaved: z.boolean(),
}).strict();
export const chatContextV3 = chatContextV2.extend({
  schemaVersion: z.literal(3),
  label: short,
  section: short.nullable(),
  mode: z.enum(['follow', 'pinned']),
  taskRevision: z.number().int().positive().nullable(),
  materialRevision: z.number().int().positive().nullable(),
  materialVersionMode: z.enum(['latest', 'historical']).optional(),
  selectedMaterialIds: z.array(short.min(1)).max(100),
  pageState: z.object({
    layout: short.optional(), showCompleted: z.boolean().optional(),
    dateFrom: short.optional(), dateTo: short.optional(), anchor: short.optional(),
    query: short.optional(), folderId: short.optional(), tagIds: z.array(short).max(100).optional(),
    kind: short.optional(), libraryView: short.optional(), taskTopicId: short.optional(), linkedTaskId: short.optional(),
    selectedId: short.optional(), selectedRevision: z.number().int().positive().optional(), status: short.optional(),
  }).strict(),
  attachments: z.array(chatAttachment).max(20).refine((items) => items.reduce((sum, item) => sum + [...item.text].length, 0) <= 40000, '附件合计最多 40,000 字符'),
}).strict();
export type ChatContextV3 = z.infer<typeof chatContextV3>;
export type ChatAttachment = z.infer<typeof chatAttachment>;
// `language` is the user's UI language when it is not the zh-CN default; the assistant replies in it.
export type StoredChatContext = (ChatContextV2 | ChatContextV3) & { timeZoneSource: 'context' | 'default'; language?: 'en' };

export function scopeFromLegacy(page: string | null | undefined, topicId: string | null | undefined): ChatContextV2['scope'] {
  const name = page?.trim() || '';
  if (name === 'inbox') return { kind: 'inbox' };
  if (name === 'board' && topicId) return { kind: 'topic', topicId };
  if (name === 'knowledge') return topicId ? { kind: 'topic', topicId } : { kind: 'all' };
  if (allPages.has(name)) return { kind: 'all' };
  if (topicId) return { kind: 'topic', topicId };
  return { kind: 'inbox' };
}

export function contextFromRequest(input: { context?: unknown; pageContext?: { topicId?: string | null; taskId?: string | null; page?: string | null } | null }): StoredChatContext {
  if (input.context && typeof input.context === 'object') {
    const version = (input.context as { schemaVersion?: unknown }).schemaVersion;
    const parsed = (version === 3 ? chatContextV3 : chatContextV2).safeParse({
      ...(input.context as object),
      selectedTaskIds: [...new Set(((input.context as { selectedTaskIds?: string[] }).selectedTaskIds ?? []))].slice(0, 100),
    });
    if (!parsed.success) throw new DomainError('INVALID_CONTEXT', parsed.error.issues.map((issue) => issue.message).join('；'), 400);
    assertTimeZone(parsed.data.timeZone);
    return { ...parsed.data, timeZoneSource: 'context' };
  }
  const page = input.pageContext?.page ?? 'inbox';
  const topicId = input.pageContext?.topicId ?? null;
  return {
    schemaVersion: 2,
    page: page || 'inbox',
    scope: scopeFromLegacy(page, topicId),
    taskId: input.pageContext?.taskId ?? null,
    materialId: null,
    selectedTaskIds: [],
    taskFilter: null,
    timeZone: 'Asia/Shanghai',
    timeZoneSource: 'default',
    referencedApprovalId: null,
  };
}

export async function validateScopeAndResolveIds(context: StoredChatContext): Promise<StoredChatContext> {
  assertTopicAccess(ownerActor, context.scope.kind === 'topic' ? context.scope.topicId : context.scope.kind === 'inbox' ? null : null);
  if (context.scope.kind === 'topic') {
    const topic = await prisma.topic.findUnique({ where: { id: context.scope.topicId }, select: { id: true } });
    if (!topic) throw new DomainError('NOT_FOUND', '当前清单不存在', 404);
  }
  if (context.taskId) {
    const task = await prisma.task.findUnique({ where: { id: context.taskId }, select: { id: true, topicId: true, revision: true } });
    if (!task) throw new DomainError('NOT_FOUND', '当前任务不存在', 404);
    assertTopicAccess(ownerActor, task.topicId);
    if (context.schemaVersion === 3) context = { ...context, taskRevision: task.revision };
  }
  if (context.materialId) {
    const material = await prisma.material.findUnique({ where: { id: context.materialId }, select: { id: true, topicId: true, revision: true } });
    if (!material) throw new DomainError('NOT_FOUND', '当前资料不存在', 404);
    assertTopicAccess(ownerActor, material.topicId);
    if (context.schemaVersion === 3 && (context.materialRevision === null || context.materialVersionMode === 'latest')) context = { ...context, materialRevision: material.revision };
  }
  if (context.schemaVersion === 3) {
    if (context.materialId && context.materialRevision) {
      const version = await prisma.materialVersion.findUnique({ where: { materialId_revision: { materialId: context.materialId, revision: context.materialRevision } }, select: { id: true } });
      if (!version) throw new DomainError('NOT_FOUND', '资料版本不存在', 404);
    }
    const ids = [...new Set(context.selectedMaterialIds)];
    if (ids.length) {
      const rows = await prisma.material.findMany({ where: { id: { in: ids } }, select: { id: true, topicId: true } });
      if (rows.length !== ids.length) throw new DomainError('NOT_FOUND', '选中的资料不存在', 404);
      rows.forEach((row) => assertTopicAccess(ownerActor, row.topicId));
    }
  }
  const selected = [...new Set(context.selectedTaskIds)].slice(0, 100);
  if (selected.length) {
    const rows = await prisma.task.findMany({ where: { id: { in: selected } }, select: { id: true, topicId: true } });
    if (rows.length !== selected.length) throw new DomainError('NOT_FOUND', '选中的任务不存在', 404);
    for (const row of rows) assertTopicAccess(ownerActor, row.topicId);
  }
  return { ...context, selectedTaskIds: selected };
}
