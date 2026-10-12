import { z } from 'zod';
import { DomainError } from './task.js';
import {
  TASK_BATCH_FIELDS,
  type TaskBatchField,
  type TaskBatchPreview,
  type TaskDelta,
  type TaskSnapshot,
} from './task-batch-types.js';

export const TASK_BATCH_INSTRUCTIONS = [
  '用户要求的是一个完整结果。先识别所有修改目标，再选择工具。',
  '涉及相互依赖的新建、改名、父子关系调整时，使用 propose_task_changes 一次提出整组修改。',
  '先读取所有相关任务，使用实际 ID、parentId 和 revision；不得猜测版本。',
  '用户指定名称必须原样使用。不要为了简洁替换标题。',
  '对已有任务只提交用户要求的字段，不重发状态、日期、标签等完整对象。',
  '任务只有一层子级。原父任务要成为子任务时，其现有子任务必须在同组中先移走。',
  '已有记录只是描述为空，不代表用户想补描述或删除任务。先回答用户当前问题。',
  '生成待确认后只说明将改什么，不宣称已经完成。真正完成以持久化结果为准。',
  '工具错误的 code 和 error 是已收到的结果。依据错误调整方案，不能说没收到；相同参数失败后不盲目重复。',
  '用户纠正同一待确认操作时，引用其 supersedesApprovalId，提出新的完整方案；不要保留两份可批准的冲突方案。',
  '用户拒绝后停止该提议；只有新的明确要求才可提出后续操作。',
  '回答状态查询时以最新查询为准；最终结果按原请求逐项核对，不用整段任务属性替代完成说明。',
].join('\n');

export const PROPOSE_TASK_CHANGES_DESCRIPTION = '提出一组需要一次确认的任务修改，支持新建任务、改名和调整一级父子关系。只生成待确认，不立即修改任务。先读取已有任务及版本；同一已有任务的改名和移动合成一项。expectedRevision 使用整组修改前的版本。新父任务用 clientRef 声明，parentId 可用 {$ref:clientRef} 引用。已有子任务必须全部移出后，原父任务才能成为子任务。用户修改同一待确认请求时使用 supersedesApprovalId 替换旧提议；不要另建一个并存的同意事项。';

const parentSchema = z.union([
  z.string().trim().min(1),
  z.null(),
  z.object({ $ref: z.string().trim().min(1) }).strict(),
]);

const createOperationSchema = z.object({
  kind: z.literal('task.create'),
  clientRef: z.string().trim().min(1),
  input: z.object({
    title: z.string().trim().min(1),
    topicId: z.string().trim().min(1).nullable().optional(),
    parentId: parentSchema.optional(),
    tagIds: z.array(z.string().trim().min(1)).optional(),
  }).strict(),
}).strict();

const updateOperationSchema = z.object({
  kind: z.literal('task.update'),
  targetId: z.string().trim().min(1),
  expectedRevision: z.number().int().min(1),
  input: z.object({
    title: z.string().trim().min(1).optional(),
    parentId: parentSchema.optional(),
  }).strict().refine((input) => input.title !== undefined || input.parentId !== undefined, { message: '至少包含 title 或 parentId' }),
}).strict();

export const proposeTaskChangesSchema = z.object({
  summary: z.string().trim().min(1).max(200),
  operations: z.array(z.discriminatedUnion('kind', [createOperationSchema, updateOperationSchema])).min(1).max(50),
  supersedesApprovalId: z.string().trim().min(1).optional(),
}).strict();

export type ProposeTaskChangesArgs = z.infer<typeof proposeTaskChangesSchema>;

const parentJsonSchema = {
  oneOf: [
    { type: 'string', minLength: 1 },
    { type: 'null' },
    { type: 'object', additionalProperties: false, required: ['$ref'], properties: { $ref: { type: 'string', minLength: 1 } } },
  ],
};

export const proposeTaskChangesParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'operations'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 200, description: '这组修改的一句话说明，不作为新任务标题' },
    supersedesApprovalId: { type: 'string', minLength: 1, description: '用户纠正同一待确认时，替换这一条整组提议' },
    operations: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'clientRef', 'input'],
            properties: {
              kind: { const: 'task.create' },
              clientRef: { type: 'string', minLength: 1 },
              input: {
                type: 'object',
                additionalProperties: false,
                required: ['title'],
                properties: {
                  title: { type: 'string', minLength: 1 },
                  topicId: { type: ['string', 'null'] },
                  parentId: parentJsonSchema,
                  tagIds: { type: 'array', items: { type: 'string', minLength: 1 } },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'targetId', 'expectedRevision', 'input'],
            properties: {
              kind: { const: 'task.update' },
              targetId: { type: 'string', minLength: 1 },
              expectedRevision: { type: 'integer', minimum: 1 },
              input: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  title: { type: 'string', minLength: 1 },
                  parentId: parentJsonSchema,
                },
              },
            },
          },
        ],
      },
    },
  },
};

export type BatchTaskRow = {
  id: string;
  revision: number;
  title: string;
  topicId: string | null;
  parentId: string | null;
  deletedAt: string | null;
};

export type CompiledCommand = {
  kind: string;
  targetId?: string;
  expectedRevision?: number;
  input: Record<string, unknown>;
  clientRef?: string;
  entityId?: string;
};

type Normalizer = (commands: Array<CompiledCommand & { sourceIndex?: number }>) => Array<CompiledCommand & { sourceIndex?: number }>;

function fail(code: string, message: string, status = 400): never {
  throw new DomainError(code, message, status);
}

export function parseProposeTaskChanges(value: unknown): ProposeTaskChangesArgs {
  const parsed = proposeTaskChangesSchema.safeParse(value);
  if (!parsed.success) fail('INVALID_TOOL_ARGUMENTS', parsed.error.issues.map((issue) => `${issue.path.join('.') || '参数'}: ${issue.message}`).join('; '));
  for (const operation of parsed.data.operations) {
    if (operation.kind === 'task.create' && operation.input.tagIds && new Set(operation.input.tagIds).size !== operation.input.tagIds.length) {
      fail('INVALID_TOOL_ARGUMENTS', 'tagIds 不能重复');
    }
  }
  return parsed.data;
}

export function applyPageTopic(args: ProposeTaskChangesArgs, page?: { topicId?: string | null }): ProposeTaskChangesArgs {
  const topicId = page?.topicId ?? null;
  return {
    ...args,
    operations: args.operations.map((operation) => {
      if (operation.kind !== 'task.create' || operation.input.topicId !== undefined || operation.input.parentId !== undefined) return operation;
      return { ...operation, input: { ...operation.input, topicId } };
    }),
  };
}

function parentValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

export function compileTaskBatch(args: ProposeTaskChangesArgs, rows: BatchTaskRow[], normalize: Normalizer): { commands: CompiledCommand[]; baseTaskRevisions: Record<string, number>; summary: string } {
  const targets = args.operations.flatMap((operation) => operation.kind === 'task.update' ? [operation.targetId] : []);
  if (new Set(targets).size !== targets.length) fail('INVALID_BATCH', '同一任务在一组里只能修改一次，请把改名和移动合成一项');
  const refs = args.operations.flatMap((operation) => operation.kind === 'task.create' ? [operation.clientRef] : []);
  if (new Set(refs).size !== refs.length) fail('INVALID_REFERENCE', 'clientRef必须唯一且用于创建命令');
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const operation of args.operations) {
    if (operation.kind !== 'task.update') continue;
    const row = byId.get(operation.targetId);
    if (!row) fail('NOT_FOUND', '任务不存在', 404);
    if (row.deletedAt) fail('TASK_NOT_EDITABLE', '回收站中的任务不能直接修改');
  }
  const draft = args.operations.map((operation, sourceIndex) => operation.kind === 'task.create'
    ? { kind: 'task.create', clientRef: operation.clientRef, input: { ...operation.input }, sourceIndex }
    : { kind: 'task.update', targetId: operation.targetId, expectedRevision: operation.expectedRevision, input: { ...operation.input }, sourceIndex });
  let normalized: Array<CompiledCommand & { sourceIndex?: number }>;
  try { normalized = normalize(draft); } catch (error) {
    if (error instanceof DomainError) throw error;
    throw error;
  }
  const commands = normalized.map((command) => ({ ...command, sourceIndex: command.sourceIndex ?? 0 }));
  const created = new Set(commands.flatMap((command) => command.kind === 'task.create' && command.entityId ? [command.entityId] : []));
  const finalParent = new Map<string, string | null>();
  for (const row of rows) finalParent.set(row.id, row.parentId);
  for (const command of commands) {
    if (command.kind === 'task.create' && command.entityId) finalParent.set(command.entityId, parentValue(command.input.parentId) ?? null);
    if (command.kind === 'task.update' && command.targetId && 'parentId' in command.input) finalParent.set(command.targetId, parentValue(command.input.parentId) ?? null);
  }
  const topicOf = (id: string): string | null => {
    const command = commands.find((item) => item.entityId === id && item.kind === 'task.create');
    if (command) {
      const parent = parentValue(command.input.parentId);
      if (parent) return topicOf(parent);
      return parentValue(command.input.topicId) ?? (command.input.topicId === null ? null : null);
    }
    const row = byId.get(id);
    const update = commands.find((item) => item.kind === 'task.update' && item.targetId === id && 'parentId' in item.input);
    const parent = update ? parentValue(update.input.parentId) : undefined;
    if (parent) return topicOf(parent);
    return row?.topicId ?? null;
  };
  for (const command of commands) {
    if (command.kind !== 'task.create' || !command.entityId) continue;
    const parent = parentValue(command.input.parentId);
    if (!parent || command.input.topicId === undefined) continue;
    if (topicOf(parent) !== command.input.topicId) fail('INVALID_PARENT', '父子任务必须属于同一清单');
  }
  for (const [id, parentId] of finalParent) {
    if (!parentId) continue;
    if (parentId === id) fail('INVALID_PARENT', '任务不能成为自己的子任务');
    if (!created.has(parentId) && !byId.has(parentId)) fail('INVALID_PARENT', '父任务不存在');
    const parent = byId.get(parentId);
    if (parent?.deletedAt) fail('INVALID_PARENT', '不能移动到已删除的父任务下');
    if (finalParent.get(parentId)) fail('INVALID_PARENT', '只支持一级子任务');
    if (topicOf(id) !== topicOf(parentId)) fail('INVALID_PARENT', '父子任务必须属于同一清单');
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor) {
      if (seen.has(cursor)) fail('INVALID_PARENT', '父子关系存在循环');
      seen.add(cursor);
      cursor = finalParent.get(cursor) ?? null;
    }
  }
  const active = commands.filter((command) => {
    if (command.kind !== 'task.update' || !command.targetId) return true;
    const row = byId.get(command.targetId);
    if (!row) return true;
    if (command.input.title !== undefined && command.input.title !== row.title) return true;
    if ('parentId' in command.input && parentValue(command.input.parentId) !== row.parentId) return true;
    return false;
  });
  if (!active.length) fail('NO_CHANGES', '请求的内容和当前任务一致');
  const indexOf = new Map(active.map((command) => [command.sourceIndex ?? 0, command]));
  const deps = new Map<number, Set<number>>();
  for (const command of active) deps.set(command.sourceIndex ?? 0, new Set());
  const link = (before: number | undefined, after: number | undefined) => {
    if (before === undefined || after === undefined || before === after) return;
    deps.get(after)?.add(before);
  };
  for (const command of active) {
    const parent = parentValue(command.input.parentId);
    if (!parent || !created.has(parent)) continue;
    link(active.find((item) => item.entityId === parent)?.sourceIndex, command.sourceIndex);
  }
  for (const command of active) {
    if (command.kind !== 'task.update' || !command.targetId) continue;
    if (!finalParent.get(command.targetId)) continue;
    const children = rows.filter((row) => row.parentId === command.targetId);
    for (const child of children) {
      const move = active.find((item) => item.kind === 'task.update' && item.targetId === child.id);
      if (!move || finalParent.get(child.id) === command.targetId) {
        const names = children.filter((item) => finalParent.get(item.id) === command.targetId).map((item) => item.title || item.id);
        fail('INVALID_PARENT', `还有子任务没有移出：${names.join('、') || child.title || child.id}`);
      }
      link(move.sourceIndex, command.sourceIndex);
    }
  }
  for (const command of active) {
    const parent = parentValue(command.input.parentId);
    if (!parent || created.has(parent)) continue;
    const current = byId.get(parent);
    if (!current?.parentId || finalParent.get(parent) !== null) continue;
    const lift = active.find((item) => item.kind === 'task.update' && item.targetId === parent && parentValue(item.input.parentId) === null);
    link(lift?.sourceIndex, command.sourceIndex);
  }
  const pending = new Set(active.map((command) => command.sourceIndex ?? 0));
  const ordered: Array<CompiledCommand & { sourceIndex?: number }> = [];
  while (pending.size) {
    const ready = [...pending].filter((index) => [...(deps.get(index) ?? [])].every((item) => !pending.has(item))).sort((left, right) => left - right);
    if (!ready.length) fail('INVALID_PARENT', '移动顺序存在循环');
    const next = ready[0]!;
    pending.delete(next);
    ordered.push(indexOf.get(next)!);
  }
  const baseTaskRevisions: Record<string, number> = {};
  for (const operation of args.operations) if (operation.kind === 'task.update') baseTaskRevisions[operation.targetId] = operation.expectedRevision;
  return {
    summary: args.summary,
    baseTaskRevisions,
    commands: ordered.map(({ sourceIndex: _sourceIndex, ...command }) => command),
  };
}

const CREATE_DEFAULTS: Record<TaskBatchField, unknown> = {
  title: '', topicId: null, parentId: null, status: 'todo', priority: 'none', description: '', resultSummary: '',
  dueDate: null, scheduledStart: null, scheduledEnd: null, estimatedMinutes: null, tagIds: [],
};

function sameValue(left: unknown, right: unknown) {
  return Array.isArray(left) || Array.isArray(right) ? JSON.stringify(left ?? []) === JSON.stringify(right ?? []) : left === right;
}

export function toTaskSnapshot(row: {
  id: string; revision: number; title: string; topicId: string | null; parentId: string | null; sortOrder: number;
  status: TaskSnapshot['status']; priority: TaskSnapshot['priority']; description: string; resultSummary: string;
  dueDate: string | null; scheduledStart: string | null; scheduledEnd: string | null; estimatedMinutes: number | null;
  tagIds?: string[]; tags?: Array<{ tagId: string }>;
}): TaskSnapshot {
  const tagIds = [...(row.tagIds ?? row.tags?.map((tag) => tag.tagId) ?? [])].sort((left, right) => left.localeCompare(right));
  return {
    id: row.id, revision: row.revision, title: row.title, topicId: row.topicId, parentId: row.parentId, sortOrder: row.sortOrder,
    status: row.status, priority: row.priority, description: row.description, resultSummary: row.resultSummary,
    dueDate: row.dueDate, scheduledStart: row.scheduledStart, scheduledEnd: row.scheduledEnd, estimatedMinutes: row.estimatedMinutes, tagIds,
  };
}

export function buildTaskBatchPreview(input: {
  summary: string;
  operationCount: number;
  before: TaskSnapshot[];
  after: TaskSnapshot[];
  explicitIds: string[];
}): TaskBatchPreview {
  const beforeById = new Map(input.before.map((task) => [task.id, task]));
  const explicit = new Set(input.explicitIds);
  const changes: TaskDelta[] = [];
  for (const after of [...input.after].sort((left, right) => left.id.localeCompare(right.id))) {
    const before = beforeById.get(after.id) ?? null;
    const fields = TASK_BATCH_FIELDS.flatMap((field) => {
      const current = after[field];
      const previous = before ? before[field] : CREATE_DEFAULTS[field];
      if (sameValue(previous, current)) return [];
      return [{ field, before: before ? previous : null, after: current }];
    });
    if (!fields.length) continue;
    changes.push({ taskId: after.id, before, after, fields, origin: !before || explicit.has(after.id) ? 'explicit' : 'related' });
  }
  const ids = [...new Set([...input.before.map((task) => task.id), ...input.after.map((task) => task.id)])].sort((left, right) => left.localeCompare(right));
  return {
    schemaVersion: 1,
    summary: input.summary,
    operationCount: input.operationCount,
    beforeTasks: ids.flatMap((id) => { const task = beforeById.get(id); return task ? [task] : []; }),
    afterTasks: ids.flatMap((id) => { const task = input.after.find((item) => item.id === id); return task ? [task] : []; }),
    changes,
  };
}

export function batchSuccessText(preview: TaskBatchPreview, tasks: TaskSnapshot[]) {
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  const lines = ['已完成整组修改。'];
  for (const change of preview.changes) {
    if (change.origin !== 'explicit') continue;
    const title = titles.get(change.taskId) ?? change.after.title;
    if (!change.before) { lines.push(`新建「${title}」`); continue; }
    for (const field of change.fields) {
      if (field.field === 'title') lines.push(`「${String(field.before)}」改名为「${title}」`);
      if (field.field === 'parentId') {
        const parentTitle = typeof field.after === 'string' ? titles.get(field.after) : undefined;
        lines.push(parentTitle ? `「${title}」的父任务改为「${parentTitle}」` : `「${title}」改为顶级任务`);
      }
    }
  }
  return lines.join('\n');
}

export function batchFailureText(error: string, code: string) {
  return `本组未修改：${error}（${code}）。`;
}

export const BATCH_REJECT_TEXT = '已拒绝，本组任务未修改。';
export const BATCH_SUPERSEDE_TEXT = '此提议已被新的整组修改替代。';
