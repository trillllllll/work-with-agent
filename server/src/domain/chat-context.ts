import { z } from 'zod';

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
  identityId: z.enum(['work', 'study']).optional(),
}).strict();

export type ChatContextV2 = z.infer<typeof chatContextV2>;
const short = z.string().max(300);
export const chatAttachment = z.object({
  id: short.min(1), kind: z.enum(['draft', 'selection']), title: short,
  text: z.string().refine((value) => [...value].length <= 20000, '单个附件最多 20,000 字符'),
  taskId: short.optional(), materialId: short.optional(), unsaved: z.boolean(),
  learningNodeId: short.optional(), learningMapId: short.optional(),
  learningRevision: z.number().int().positive().optional(),
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
    operation: short.optional(),
    source: short.optional(),
  }).strict(),
  attachments: z.array(chatAttachment).max(20).refine((items) => items.reduce((sum, item) => sum + [...item.text].length, 0) <= 40000, '附件合计最多 40,000 字符'),
}).strict();
export type ChatContextV3 = z.infer<typeof chatContextV3>;
export type ChatAttachment = z.infer<typeof chatAttachment>;
// `language` is the user's UI language when it is not the zh-CN default; the assistant replies in it.
export type StoredChatContext = (ChatContextV2 | ChatContextV3) & { timeZoneSource: 'context' | 'default'; language?: 'en' };
