import { z } from 'zod';
import { DomainError } from '../domain/task.js';
import { calendarDate, isCalendarDate, isLocalDateTime, localDateTime, reorderSchema, tagColors, tagCreateSchema, topicCreateSchema } from '../application/workspace-input.js';
import { completeChildrenLine, createStatusLine, dueDateDescription, estimateLine, parentLine, recurrenceDescription, reorderCoverageLine, scheduleMoves, scheduleShapes, scheduledEndDescription, scheduledStartDescription, sortLine, statusTransitionLine, tagIdsDescription, topicIdDescription } from './task-write-spec.js';

export const workspaceWriteKinds = [
  'task.create', 'task.update', 'task.delete', 'task.restore', 'task.reorder',
  'topic.create', 'topic.update', 'topic.archive', 'topic.restore', 'topic.move_tasks_to_inbox',
  'tag.create', 'tag.update', 'tag.delete',
] as const;

const id = z.string().trim().min(1);
const parentRef = z.union([id, z.object({ $ref: z.string().min(1) }).strict()]);
const taskBase = {
  topicId: id.nullable().optional(),
  parentId: parentRef.nullable().optional(),
  title: z.string().trim().min(1, '任务标题不能为空'),
  description: z.string().optional(),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
  priority: z.enum(['none', 'low', 'medium', 'high']).optional(),
  dueDate: calendarDate.nullable().optional(),
  estimatedMinutes: z.number().int().min(1).max(10080).nullable().optional(),
  scheduledStart: localDateTime.nullable().optional(),
  scheduledEnd: localDateTime.nullable().optional(),
  resultSummary: z.string().optional(),
  tagIds: z.array(id).refine((ids) => new Set(ids).size === ids.length, '标签不能重复').optional(),
};
const taskCreateInput = z.object(taskBase).strict();
const taskUpdateInput = z.object({ ...taskBase, title: z.string().trim().min(1, '任务标题不能为空').optional(), completeChildren: z.boolean().optional() }).strict()
  .refine((value) => Object.values(value).some((item) => item !== undefined), '任务修改至少要包含一个字段');
const topicCreateInput = topicCreateSchema.strict();
const topicUpdateInput = topicCreateSchema.partial().extend({ draftSummary: z.string().optional() }).strict()
  .refine((value) => Object.values(value).some((item) => item !== undefined), '清单修改至少要包含一个字段');
const tagCreateInput = tagCreateSchema.strict();
const tagUpdateInput = z.object({
  name: z.string().trim().min(1, '标签名称不能为空').optional(),
  color: z.enum(tagColors).optional(),
}).strict().refine((value) => value.name !== undefined || value.color !== undefined, '标签修改不能为空');
const reorderInput = reorderSchema.strict();
const emptyInput = z.object({}).strict();

const stringSchema = { type: 'string', minLength: 1, 'x-wwa-trim': true } as const;
const nullableId = { anyOf: [{ type: 'null' }, stringSchema] };
const parentSchema = { anyOf: [{ type: 'null' }, stringSchema, { type: 'object', additionalProperties: false, required: ['$ref'], properties: { $ref: stringSchema } }] };
const taskProperties = {
  topicId: { ...nullableId, description: topicIdDescription },
  parentId: { ...parentSchema, description: parentLine },
  title: stringSchema,
  description: { type: 'string' },
  status: { enum: ['todo', 'doing', 'blocked', 'done'], description: `${statusTransitionLine()}。${createStatusLine}` },
  priority: { enum: ['none', 'low', 'medium', 'high'] },
  dueDate: { anyOf: [{ type: 'null' }, { type: 'string', format: 'wwa-calendar-date' }], description: dueDateDescription },
  estimatedMinutes: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1, maximum: 10080 }], description: estimateLine },
  scheduledStart: { anyOf: [{ type: 'null' }, { type: 'string', format: 'wwa-local-date-time' }], description: scheduledStartDescription },
  scheduledEnd: { anyOf: [{ type: 'null' }, { type: 'string', format: 'wwa-local-date-time' }], description: scheduledEndDescription },
  resultSummary: { type: 'string' },
  recurrenceRule: { type: 'string', description: recurrenceDescription },
  tagIds: { type: 'array', items: stringSchema, uniqueItems: true, description: tagIdsDescription },
};

export type JsonSchema = {
  type?: string | string[];
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  minProperties?: number;
  uniqueItems?: boolean;
  format?: string;
  oneOf?: readonly JsonSchema[];
  anyOf?: readonly JsonSchema[];
  description?: string;
  'x-wwa-trim'?: boolean;
};

type CommandSpec = {
  kind: (typeof workspaceWriteKinds)[number];
  description: string;
  required: string[];
  notes: string[];
  requiresRevision: boolean;
  zod: z.ZodTypeAny;
  commandSchema: JsonSchema;
  inputSchema: JsonSchema;
};

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = [], minProperties?: number): JsonSchema {
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}), ...(minProperties ? { minProperties } : {}) };
}

function commandSchema(kind: string, input: JsonSchema, fields: { clientRef?: boolean; target?: boolean }): JsonSchema {
  const properties: Record<string, JsonSchema> = { kind: { const: kind }, input };
  const required = ['kind', 'input'];
  if (fields.clientRef) properties.clientRef = stringSchema;
  if (fields.target) {
    properties.targetId = stringSchema;
    properties.expectedRevision = { type: 'integer', minimum: 1 };
    required.push('targetId', 'expectedRevision');
  }
  return objectSchema(properties, required);
}

const taskCreateJson = objectSchema(taskProperties, ['title']);
const taskUpdateJson = objectSchema({ ...taskProperties, completeChildren: { type: 'boolean', description: completeChildrenLine } }, [], 1);
const topicProperties = { name: stringSchema, description: { type: 'string' }, color: { enum: [...tagColors] }, isExploration: { type: 'boolean' }, goal: { type: 'string' } };
const topicCreateJson = objectSchema(topicProperties, ['name']);
const topicUpdateJson = objectSchema({ ...topicProperties, draftSummary: { type: 'string' } }, [], 1);
const tagProperties = { name: stringSchema, color: { enum: [...tagColors] } };
const tagCreateJson = objectSchema(tagProperties, ['name']);
const tagUpdateJson = objectSchema(tagProperties, [], 1);
const reorderJson = objectSchema({
  topicId: nullableId,
  parentId: nullableId,
  orderedTaskIds: { type: 'array', items: stringSchema, uniqueItems: true },
}, ['topicId', 'parentId', 'orderedTaskIds']);
const emptyJson = objectSchema({});

const create = (kind: CommandSpec['kind'], description: string, zod: z.ZodTypeAny, inputSchema: JsonSchema, notes: string[]): CommandSpec => ({
  kind, description, required: ['kind', 'input'], notes, requiresRevision: false, zod, inputSchema,
  commandSchema: commandSchema(kind, inputSchema, { clientRef: true }),
});
const existing = (kind: CommandSpec['kind'], description: string, zod: z.ZodTypeAny, inputSchema: JsonSchema, notes: string[]): CommandSpec => ({
  kind, description, required: ['kind', 'targetId', 'expectedRevision', 'input'], notes, requiresRevision: true, zod, inputSchema,
  commandSchema: commandSchema(kind, inputSchema, { target: true }),
});

const reorderCommand = {
  kind: 'task.reorder',
  description: '按给定顺序重排同一父级下的任务。',
  required: ['kind', 'input'],
  notes: ['input 只含 topicId、parentId、orderedTaskIds。', reorderCoverageLine],
  requiresRevision: false,
  zod: z.object({ kind: z.literal('task.reorder'), input: reorderInput }).strict(),
  inputSchema: reorderJson,
  commandSchema: commandSchema('task.reorder', reorderJson, {}),
} satisfies CommandSpec;

const registry = new Map<string, CommandSpec>([
  create('task.create', '新建任务。标题必填，初始状态为 todo。', z.object({ kind: z.literal('task.create'), clientRef: id.optional(), input: taskCreateInput }).strict(), taskCreateJson, ['不需要已有对象版本。', 'parentId 可以是任务 ID，或 {"$ref":"clientRef"}。', scheduleShapes, createStatusLine]),
  existing('task.update', '修改已有任务。至少提供一个实际字段，省略的字段保持原值。', z.object({ kind: z.literal('task.update'), targetId: id, expectedRevision: z.number().int().min(1), input: taskUpdateInput }).strict(), taskUpdateJson, ['必须携带刚读取的 expectedRevision。', 'null 清空可空字段，[] 清空集合。', scheduleMoves, statusTransitionLine(), completeChildrenLine, parentLine, sortLine]),
  existing('task.delete', '删除任务。对象 ID 和版本在命令外层，input 必须是空对象。', z.object({ kind: z.literal('task.delete'), targetId: id, expectedRevision: z.number().int().min(1), input: emptyInput }).strict(), emptyJson, ['input 必须是 {}。']),
  existing('task.restore', '恢复任务。对象 ID 和版本在命令外层，input 必须是空对象。', z.object({ kind: z.literal('task.restore'), targetId: id, expectedRevision: z.number().int().min(1), input: emptyInput }).strict(), emptyJson, ['input 必须是 {}。']),
  reorderCommand,
  create('topic.create', '新建清单。', z.object({ kind: z.literal('topic.create'), clientRef: id.optional(), input: topicCreateInput }).strict(), topicCreateJson, ['name 必填。', '不需要已有对象版本。']),
  existing('topic.update', '修改清单。可改名称、说明、探索标记、目标和草稿摘要。', z.object({ kind: z.literal('topic.update'), targetId: id, expectedRevision: z.number().int().min(1), input: topicUpdateInput }).strict(), topicUpdateJson, ['至少提供一个字段。', 'draftSummary 只在更新时可用。']),
  existing('topic.archive', '归档清单。', z.object({ kind: z.literal('topic.archive'), targetId: id, expectedRevision: z.number().int().min(1), input: emptyInput }).strict(), emptyJson, ['input 必须是 {}。']),
  existing('topic.restore', '恢复清单。', z.object({ kind: z.literal('topic.restore'), targetId: id, expectedRevision: z.number().int().min(1), input: emptyInput }).strict(), emptyJson, ['input 必须是 {}。']),
  existing('topic.move_tasks_to_inbox', '把清单里的任务移入收集箱。', z.object({ kind: z.literal('topic.move_tasks_to_inbox'), targetId: id, expectedRevision: z.number().int().min(1), input: emptyInput }).strict(), emptyJson, ['input 必须是 {}。']),
  create('tag.create', '新建标签。', z.object({ kind: z.literal('tag.create'), clientRef: id.optional(), input: tagCreateInput }).strict(), tagCreateJson, ['name 必填。', 'color 可选。']),
  existing('tag.update', '修改标签名称或颜色。', z.object({ kind: z.literal('tag.update'), targetId: id, expectedRevision: z.number().int().min(1), input: tagUpdateInput }).strict(), tagUpdateJson, ['至少提供 name 或 color。']),
  existing('tag.delete', '删除标签。', z.object({ kind: z.literal('tag.delete'), targetId: id, expectedRevision: z.number().int().min(1), input: emptyInput }).strict(), emptyJson, ['input 必须是 {}。']),
].map((entry) => [entry.kind, entry]));

export function workspaceCommandJsonSchema(): JsonSchema {
  return { oneOf: [...registry.values()].map((entry) => entry.commandSchema) };
}

export function workspaceChangeDocument(kind?: string) {
  if (!kind) {
    return {
      family: 'workspace' as const,
      kind: null,
      kinds: [...workspaceWriteKinds],
      command: workspaceCommandJsonSchema(),
      notes: ['按 kind 选择对应分支。', '创建不需要 expectedRevision。', '已有对象的修改必须带刚读取的版本。', '新对象用 clientRef，父任务引用写 {"$ref":"clientRef"}。'],
    };
  }
  const entry = registry.get(kind);
  if (!entry) throw new DomainError('INVALID_TOOL_ARGUMENTS', `未知的修改类型：${kind}`, 400);
  return { family: 'workspace' as const, kind: entry.kind, description: entry.description, required: entry.required, command: entry.commandSchema, input: entry.inputSchema, notes: entry.notes };
}

export function parseWorkspaceCommand(command: { kind: string; targetId?: string; expectedRevision?: number; clientRef?: string; input?: Record<string, unknown> }) {
  const entry = registry.get(command.kind);
  if (!entry) throw new DomainError('CAPABILITY_UNAVAILABLE', '内置 AI 不支持此操作。可以整理成提示词交给具备对应能力的工具。', 400);
  if (entry.requiresRevision && command.expectedRevision === undefined) throw new DomainError('PRECONDITION_REQUIRED', '修改已有对象必须携带刚读取的版本', 428);
  const parsed = entry.zod.safeParse({
    kind: command.kind,
    ...(command.targetId !== undefined ? { targetId: command.targetId } : {}),
    ...(command.expectedRevision !== undefined ? { expectedRevision: command.expectedRevision } : {}),
    ...(command.clientRef !== undefined ? { clientRef: command.clientRef } : {}),
    input: command.input ?? {},
  });
  if (!parsed.success) throw new DomainError('INVALID_TOOL_ARGUMENTS', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'), 400);
  const data = parsed.data as { kind: string; targetId?: string; expectedRevision?: number; clientRef?: string; input: Record<string, unknown> };
  return {
    kind: data.kind,
    ...(data.targetId ? { targetId: data.targetId } : {}),
    ...(data.expectedRevision !== undefined ? { expectedRevision: data.expectedRevision } : {}),
    ...(data.clientRef ? { clientRef: data.clientRef } : {}),
    input: Object.fromEntries(Object.entries(data.input).filter(([, value]) => value !== undefined)),
  };
}

function valueType(value: unknown) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(types: string[] | undefined, value: unknown) {
  if (!types?.length) return true;
  const kind = valueType(value);
  return types.includes(kind) || (kind === 'integer' && types.includes('number'));
}

export function jsonSchemaAccepts(schema: JsonSchema, value: unknown): boolean {
  if (schema.oneOf) return schema.oneOf.filter((branch) => jsonSchemaAccepts(branch, value)).length === 1;
  if (schema.anyOf) return schema.anyOf.some((branch) => jsonSchemaAccepts(branch, value));
  if ('const' in schema && schema.const !== undefined) return value === schema.const;
  if (schema.enum) return schema.enum.some((item) => item === value);
  const types = schema.type === undefined ? undefined : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!matchesType(types, value)) return false;
  if (typeof value === 'string') {
    const text = schema['x-wwa-trim'] ? value.trim() : value;
    if (schema.minLength !== undefined && text.length < schema.minLength) return false;
    if (schema.format === 'wwa-calendar-date' && !isCalendarDate(value)) return false;
    if (schema.format === 'wwa-local-date-time' && !isLocalDateTime(value)) return false;
  }
  if (typeof value === 'number') {
    if ((schema.type === 'integer' || types?.includes('integer')) && !Number.isInteger(value)) return false;
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
    if (schema.items && value.some((item) => !jsonSchemaAccepts(schema.items!, item))) return false;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false && Object.keys(record).some((key) => !(key in properties))) return false;
    if ((schema.required ?? []).some((key) => record[key] === undefined)) return false;
    const present = Object.keys(record).filter((key) => record[key] !== undefined);
    if (schema.minProperties !== undefined && present.length < schema.minProperties) return false;
    return present.every((key) => !(key in properties) || jsonSchemaAccepts(properties[key], record[key]));
  }
  return true;
}
