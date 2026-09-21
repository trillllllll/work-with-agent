import { prisma } from '../infrastructure/prisma.js';
import { ControlledExecutionAdapter, redact, type ExecutionAdapter, type ExecutionResult } from '../infrastructure/controlled-execution.js';
import { TaskService, TopicService, type MutationContext, type ToolCall } from './workspace.js';
import { taskCreateSchema, taskUpdateSchema as taskPatchSchema, topicCreateSchema, topicUpdateSchema as topicPatchSchema } from './workspace-input.js';
import { CommandService, type Command } from './commands.js';
import { assertTopicAccess, internalActor, ownerActor } from './security.js';
import { randomUUID } from 'node:crypto';

export type ToolResult = { success: boolean; data?: unknown; error?: string; code?: string };
export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown>; requiresApproval: boolean; validate: (args: Record<string, unknown>) => string | null; execute: (args: Record<string, unknown>) => Promise<ToolResult> };
const now = () => new Date().toISOString();
const notFound = (message: string) => Object.assign(new Error(message), { status: 404 });

function validateParameters(schema: Record<string, any>, args: Record<string, unknown>): string | null {
  const properties = (schema.properties ?? {}) as Record<string, { type?: string | string[]; enum?: unknown[]; items?: { type?: string } }>;
  for (const required of (schema.required ?? []) as string[]) if (!(required in args) || args[required] === undefined) return `缺少参数: ${required}`;
  if (schema.additionalProperties === false) { const unknown = Object.keys(args).find((key) => !(key in properties)); if (unknown) return `未知参数: ${unknown}`; }
  for (const [key, value] of Object.entries(args)) {
    if (!(key in properties) || value === undefined) continue;
    const definition = properties[key];
    const types = Array.isArray(definition.type) ? definition.type : [definition.type];
    const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (definition.type && !types.includes(actualType)) return `${key} 类型无效`;
    if (Array.isArray(value) && definition.items?.type && value.some((item) => typeof item !== definition.items!.type)) return `${key} 数组元素类型无效`;
    if (definition.enum && !definition.enum.includes(value)) return `${key} 的值无效`;
  }
  return null;
}

export class ToolService {
  private topics = new TopicService();
  private tasks = new TaskService();
  private registry: Record<string, ToolDefinition>;
  constructor(private readonly execution: ExecutionAdapter = new ControlledExecutionAdapter()) {
    const string = { type: 'string' }; const nullableString = { type: ['string', 'null'] }; const stringArray = { type: 'array', items: string }; const status = { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'] }; const priority = { type: 'string', enum: ['none', 'low', 'medium', 'high'] };
    this.registry = {
      list_topics: this.define('list_topics', '列出所有主题', {}, false, async () => this.topics.list()),
      get_topic: this.define('get_topic', '读取主题及其任务', { topicId: string }, false, async (a) => this.requireResource(await this.topics.get(String(a.topicId)), '主题不存在'), ['topicId']),
      get_topic_progress: this.define('get_topic_progress', '读取主题进度和成果', { topicId: string }, false, async (a) => { const topic = await this.topics.get(String(a.topicId)); if (!topic) throw notFound('主题不存在'); const counts = Object.fromEntries(['todo', 'doing', 'blocked', 'done'].map((value) => [value, topic.tasks.filter((task) => task.status === value).length])); return { topic, counts }; }, ['topicId']),
      list_tasks: this.define('list_tasks', '查询任务；默认不包含回收站和归档清单，可按清单、状态、日期、标签和关键词筛选', { topicId: string, inbox: { type: 'boolean' }, q: string, status: { type: 'string', enum: ['open', 'done', 'all', 'todo', 'doing', 'blocked'] }, dueFrom: string, dueTo: string, tagIds: stringArray, sort: { type: 'string', enum: ['manual', 'date', 'priority'] } }, false, async (a) => this.tasks.list(a.topicId ? String(a.topicId) : undefined, a)),
      get_task: this.define('get_task', '读取一个任务', { taskId: string }, false, async (a) => this.requireResource(await this.tasks.get(String(a.taskId)), '任务不存在'), ['taskId']),
      create_task: this.define('create_task', '创建待办任务；只需标题，可指定一级父任务与标签', { topicId: nullableString, parentId: nullableString, tagIds: stringArray, title: string, description: string, status: { type: 'string', enum: ['todo'] }, priority, dueDate: nullableString, resultSummary: string }, true, async (a) => this.tasks.create(taskCreateSchema.parse(a)), ['title']),
      update_task: this.define('update_task', '局部修改任务；未提供字段保持不变，null清空归属或日期，空数组清空标签。完成含未完成子任务的父任务需明确completeChildren', { taskId: string, topicId: nullableString, parentId: nullableString, tagIds: stringArray, completeChildren: { type: 'boolean' }, title: string, description: string, status, priority, dueDate: nullableString, resultSummary: string }, true, async (a) => this.tasks.update(String(a.taskId), taskPatchSchema.parse(a)), ['taskId']),
      delete_task: this.define('delete_task', '删除任务', { taskId: string }, true, async (a) => this.tasks.remove(String(a.taskId)), ['taskId']),
      delete_topic: this.define('delete_topic', '旧兼容操作：归档清单并将其全部任务移到收集箱；不是保留归属的新归档操作，执行前需要审批', { topicId: string }, true, async (a) => this.topics.remove(String(a.topicId)), ['topicId']),
      create_topic: this.define('create_topic', '创建主题', { name: string, description: string, isExploration: { type: 'boolean' } }, true, async (a) => this.topics.create({ name: String(a.name), description: a.description as string | undefined, isExploration: a.isExploration as boolean | undefined }), ['name']),
      update_topic: this.define('update_topic', '更新主题', { topicId: string, name: string, description: string, isExploration: { type: 'boolean' } }, true, async (a) => this.topics.update(String(a.topicId), { name: a.name as string | undefined, description: a.description as string | undefined, isExploration: a.isExploration as boolean | undefined }), ['topicId']),
      propose_topic_summary: this.define('propose_topic_summary', '提出主题成果草稿', { topicId: string, summary: string }, true, async (a) => this.topics.generateSummary(String(a.topicId), String(a.summary)), ['topicId', 'summary']),
      execute_shell: this.define('execute_shell', '在受控工作区执行白名单命令', { command: string, args: { type: 'array' }, workingDirectory: string, timeoutMs: { type: 'number' } }, true, async (a) => this.execution.execute({ kind: 'shell', input: a, approvalId: 'tool' }), ['command']),
      execute_file: this.define('execute_file', '在受控工作区进行文件操作', { operation: string, path: string, content: string, recursive: { type: 'boolean' } }, true, async (a) => this.execution.execute({ kind: 'file', input: a, approvalId: 'tool' }), ['operation', 'path']),
      execute_http: this.define('execute_http', '访问受控 HTTP(S) 目标', { method: string, url: string, headers: { type: 'object' }, body: { type: 'object' }, timeoutMs: { type: 'number' } }, true, async (a) => this.execution.execute({ kind: 'http', input: a, approvalId: 'tool' }), ['url']),
    };
  }
  private define(name: string, description: string, properties: Record<string, unknown>, requiresApproval: boolean, execute: (args: Record<string, unknown>) => Promise<unknown>, required: string[] = []): ToolDefinition { const parameters = { type: 'object', properties: { ...properties, ...(requiresApproval && !name.startsWith('execute_') ? { expectedRevision: { type: 'number', description: '最近读取的目标revision，修改已有对象时必须提供' } } : {}) }, ...(required.length ? { required } : {}), additionalProperties: false }; return { name, description, parameters, requiresApproval, validate: () => null, execute: async (args) => ({ success: true, data: await execute(args) }) }; }
  private requireResource<T>(value: T | null, message: string) { if (!value) throw notFound(message); return value; }
  definitions() { return Object.values(this.registry).map(({ name, description, parameters }) => ({ type: 'function' as const, function: { name, description, parameters } })); }
  isKnown(name: string) { return Boolean(this.registry[name]); }
  isReadOnly(name: string) { return this.registry[name]?.requiresApproval === false; }
  validate(call: ToolCall) {
    const definition = this.registry[call.name];
    if (!definition) return `未知 Tool: ${call.name}`;
    if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) return 'Tool 参数必须是对象';
    const parameterError = validateParameters(definition.parameters, call.arguments);
    if (parameterError) return parameterError;
    const schemas: Record<string, typeof taskCreateSchema | typeof taskPatchSchema | typeof topicCreateSchema | typeof topicPatchSchema> = { create_task: taskCreateSchema, update_task: taskPatchSchema, create_topic: topicCreateSchema, update_topic: topicPatchSchema };
    const shared = schemas[call.name];
    if (shared) {
      const { taskId, topicId, ...fields } = call.arguments;
      const input = call.name.includes('task') ? { ...fields, ...(topicId !== undefined ? { topicId } : {}) } : fields;
      const parsed = shared.safeParse(input);
      if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    }
    return definition.validate(call.arguments);
  }
  async execute(call: ToolCall, context: MutationContext = { source: 'user' }): Promise<ToolResult> {
    const validationError = this.validate(call);
    if (validationError) return { success: false, error: validationError, code: 'INVALID_INPUT' };
    try {
      const actor = context.actor ?? (context.source === 'agent' ? internalActor : ownerActor);
      if (!this.registry[call.name].requiresApproval) {
        if (typeof call.arguments.topicId === 'string') assertTopicAccess(actor, call.arguments.topicId);
        if (call.name === 'list_tasks' && actor.topicIds !== 'all') return { success: true, data: await this.tasks.list(typeof call.arguments.topicId === 'string' ? call.arguments.topicId : undefined, call.arguments, { OR: [{ topicId: { in: actor.topicIds } }, ...(actor.includeInbox ? [{ topicId: null }] : [])] }) };
        if (call.name === 'list_topics' && actor.topicIds !== 'all') return { success: true, data: (await this.topics.list()).filter((topic) => (actor.topicIds as string[]).includes(topic.id)) };
        const result = await this.registry[call.name].execute(call.arguments);
        if (call.name === 'get_task' && result.data) assertTopicAccess(actor, (result.data as { topicId: string | null }).topicId);
        return result;
      }
      if (['execute_shell', 'execute_file', 'execute_http'].includes(call.name)) {
        const kind = call.name === 'execute_shell' ? 'shell' : call.name === 'execute_file' ? 'file' : 'http';
        const execution = await this.execution.execute({ kind, input: call.arguments, approvalId: context.approvalId ?? 'direct', timeoutMs: Number(call.arguments.timeoutMs) || undefined });
        if (context.approvalId && !this.isExecutionValidationFailure(execution)) await this.recordExecution(call, execution, context);
        return { success: execution.success, data: execution, ...(execution.success ? {} : { error: execution.error, code: execution.errorCode }) };
      }
      const args = { ...call.arguments };
      const targetId = typeof args.taskId === 'string' ? args.taskId : typeof args.topicId === 'string' && !call.name.startsWith('create_') ? args.topicId : undefined;
      const expectedRevision = typeof args.expectedRevision === 'number' ? args.expectedRevision : undefined;
      delete args.taskId; delete args.expectedRevision;
      if (!call.name.includes('task')) delete args.topicId;
      let kind = call.name;
      if (kind === 'propose_topic_summary') { kind = 'topic.update'; args.draftSummary = args.summary; delete args.summary; }
      const command: Command = { kind, targetId, expectedRevision, input: args };
      const response = await new CommandService().submit(actor, { requestId: context.requestId ?? randomUUID(), commands: [command] });
      return { success: true, data: response.status === 'applied' ? response.results[0] : response };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
      return { success: false, error: error instanceof Error ? error.message : 'Tool 执行失败', ...(code ? { code } : {}) };
    }
  }
  private async recordExecution(call: ToolCall, result: ExecutionResult, context: MutationContext) { await prisma.changeRecord.create({ data: { entityType: 'execution', entityId: context.approvalId!, operation: 'execute', beforeSnapshot: null, afterSnapshot: JSON.stringify({ toolName: call.name, input: redact(call.arguments), result: redact(result) }), source: context.source, conversationId: context.conversationId, approvalId: context.approvalId, requestId: context.requestId ?? context.approvalId, createdAt: now() } }); }
  private isExecutionValidationFailure(result: ExecutionResult) { return Boolean(result.errorCode && /(?:_DENIED|_INVALID_|_INVALID$|_INVALID_PATH$)/.test(result.errorCode)); }
}
