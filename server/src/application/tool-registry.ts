import { TaskPriority, TaskStatus } from '@prisma/client';
import { prisma } from '../infrastructure/prisma.js';
import { ControlledExecutionAdapter, redact, type ExecutionAdapter, type ExecutionResult } from '../infrastructure/controlled-execution.js';
import { TaskService, TopicService, WorkspaceMutation, type MutationContext, type ToolCall } from './workspace.js';

export type ToolResult = { success: boolean; data?: unknown; error?: string };
export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown>; requiresApproval: boolean; validate: (args: Record<string, unknown>) => string | null; execute: (args: Record<string, unknown>) => Promise<ToolResult> };
const now = () => new Date().toISOString();
const notFound = (message: string) => Object.assign(new Error(message), { status: 404 });

function validateParameters(schema: Record<string, any>, args: Record<string, unknown>): string | null {
  const properties = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
  for (const required of (schema.required ?? []) as string[]) if (!(required in args) || args[required] === undefined) return `缺少参数: ${required}`;
  if (schema.additionalProperties === false) { const unknown = Object.keys(args).find((key) => !(key in properties)); if (unknown) return `未知参数: ${unknown}`; }
  for (const [key, value] of Object.entries(args)) { if (!(key in properties) || value === undefined) continue; const definition = properties[key]; if (definition.type === 'string' && typeof value !== 'string') return `${key} 必须是字符串`; if (definition.type === 'boolean' && typeof value !== 'boolean') return `${key} 必须是布尔值`; if (definition.type === 'number' && typeof value !== 'number') return `${key} 必须是数字`; if (definition.type === 'array' && !Array.isArray(value)) return `${key} 必须是数组`; if (definition.type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) return `${key} 必须是对象`; if (definition.enum && !definition.enum.includes(value)) return `${key} 的值无效`; }
  return null;
}

export class ToolService {
  private topics = new TopicService();
  private tasks = new TaskService();
  private registry: Record<string, ToolDefinition>;
  private mutations = new WorkspaceMutation();
  constructor(private readonly execution: ExecutionAdapter = new ControlledExecutionAdapter()) {
    const string = { type: 'string' }; const status = { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'] }; const priority = { type: 'string', enum: ['none', 'low', 'medium', 'high'] };
    this.registry = {
      list_topics: this.define('list_topics', '列出所有主题', {}, false, async () => this.topics.list()),
      get_topic: this.define('get_topic', '读取主题及其任务', { topicId: string }, false, async (a) => this.requireResource(await this.topics.get(String(a.topicId)), '主题不存在'), ['topicId']),
      get_topic_progress: this.define('get_topic_progress', '读取主题进度和成果', { topicId: string }, false, async (a) => { const topic = await this.topics.get(String(a.topicId)); if (!topic) throw notFound('主题不存在'); const counts = Object.fromEntries(['todo', 'doing', 'blocked', 'done'].map((value) => [value, topic.tasks.filter((task) => task.status === value).length])); return { topic, counts }; }, ['topicId']),
      list_tasks: this.define('list_tasks', '列出任务，可按主题筛选', { topicId: string }, false, async (a) => this.tasks.list(a.topicId ? String(a.topicId) : undefined)),
      get_task: this.define('get_task', '读取一个任务', { taskId: string }, false, async (a) => this.requireResource(await this.tasks.get(String(a.taskId)), '任务不存在'), ['taskId']),
      create_task: this.define('create_task', '创建任务，可先放入收集箱；新任务固定为待办状态', { topicId: string, title: string, description: string, status: { type: 'string', enum: ['todo'] }, priority, dueDate: string, resultSummary: string }, true, async (a) => this.tasks.create({ topicId: typeof a.topicId === 'string' ? a.topicId : null, title: String(a.title), description: a.description as string | undefined, status: a.status as TaskStatus | undefined, priority: a.priority as TaskPriority | undefined, dueDate: a.dueDate as string | null | undefined, resultSummary: a.resultSummary as string | undefined }), ['title']),
      update_task: this.define('update_task', '更新任务', { taskId: string, topicId: string, title: string, description: string, status, priority, dueDate: string, resultSummary: string }, true, async (a) => this.tasks.update(String(a.taskId), { topicId: a.topicId as string | undefined, title: a.title as string | undefined, description: a.description as string | undefined, status: a.status as TaskStatus | undefined, priority: a.priority as TaskPriority | undefined, dueDate: a.dueDate as string | null | undefined, resultSummary: a.resultSummary as string | undefined }), ['taskId']),
      delete_task: this.define('delete_task', '删除任务', { taskId: string }, true, async (a) => this.tasks.remove(String(a.taskId)), ['taskId']),
      create_topic: this.define('create_topic', '创建主题', { name: string, description: string, isExploration: { type: 'boolean' } }, true, async (a) => this.topics.create({ name: String(a.name), description: a.description as string | undefined, isExploration: a.isExploration as boolean | undefined }), ['name']),
      update_topic: this.define('update_topic', '更新主题', { topicId: string, name: string, description: string, isExploration: { type: 'boolean' } }, true, async (a) => this.topics.update(String(a.topicId), { name: a.name as string | undefined, description: a.description as string | undefined, isExploration: a.isExploration as boolean | undefined }), ['topicId']),
      propose_topic_summary: this.define('propose_topic_summary', '提出主题成果草稿', { topicId: string, summary: string }, true, async (a) => this.topics.generateSummary(String(a.topicId), String(a.summary)), ['topicId', 'summary']),
      execute_shell: this.define('execute_shell', '在受控工作区执行白名单命令', { command: string, args: { type: 'array' }, workingDirectory: string, timeoutMs: { type: 'number' } }, true, async (a) => this.execution.execute({ kind: 'shell', input: a, approvalId: 'tool' }), ['command']),
      execute_file: this.define('execute_file', '在受控工作区进行文件操作', { operation: string, path: string, content: string, recursive: { type: 'boolean' } }, true, async (a) => this.execution.execute({ kind: 'file', input: a, approvalId: 'tool' }), ['operation', 'path']),
      execute_http: this.define('execute_http', '访问受控 HTTP(S) 目标', { method: string, url: string, headers: { type: 'object' }, body: { type: 'object' }, timeoutMs: { type: 'number' } }, true, async (a) => this.execution.execute({ kind: 'http', input: a, approvalId: 'tool' }), ['url']),
    };
  }
  private define(name: string, description: string, properties: Record<string, unknown>, requiresApproval: boolean, execute: (args: Record<string, unknown>) => Promise<unknown>, required: string[] = []): ToolDefinition { const parameters = { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }; return { name, description, parameters, requiresApproval, validate: () => null, execute: async (args) => ({ success: true, data: await execute(args) }) }; }
  private requireResource<T>(value: T | null, message: string) { if (!value) throw notFound(message); return value; }
  definitions() { return Object.values(this.registry).map(({ name, description, parameters }) => ({ type: 'function' as const, function: { name, description, parameters } })); }
  isKnown(name: string) { return Boolean(this.registry[name]); }
  isReadOnly(name: string) { return this.registry[name]?.requiresApproval === false; }
  validate(call: ToolCall) { const definition = this.registry[call.name]; if (!definition) return `未知 Tool: ${call.name}`; if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) return 'Tool 参数必须是对象'; return validateParameters(definition.parameters, call.arguments) ?? definition.validate(call.arguments); }
  async execute(call: ToolCall, context: MutationContext = { source: 'user' }): Promise<ToolResult> { const validationError = this.validate(call); if (validationError) return { success: false, error: validationError }; try { if (this.registry[call.name].requiresApproval) { if (['execute_shell', 'execute_file', 'execute_http'].includes(call.name)) { const kind = call.name === 'execute_shell' ? 'shell' : call.name === 'execute_file' ? 'file' : 'http'; const execution = await this.execution.execute({ kind, input: call.arguments, approvalId: context.approvalId ?? 'direct', timeoutMs: Number(call.arguments.timeoutMs) || undefined }); if (context.approvalId && !this.isExecutionValidationFailure(execution)) await this.recordExecution(call, execution, context); return { success: execution.success, data: execution, ...(execution.success ? {} : { error: execution.error }) }; } return { success: true, data: await this.mutations.execute(call, context) }; } return await this.registry[call.name].execute(call.arguments); } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Tool 执行失败' }; } }
  private async recordExecution(call: ToolCall, result: ExecutionResult, context: MutationContext) { await prisma.changeRecord.create({ data: { entityType: 'execution', entityId: context.approvalId!, operation: 'execute', beforeSnapshot: null, afterSnapshot: JSON.stringify({ toolName: call.name, input: redact(call.arguments), result: redact(result) }), source: context.source, conversationId: context.conversationId, approvalId: context.approvalId, requestId: context.requestId ?? context.approvalId, createdAt: now() } }); }
  private isExecutionValidationFailure(result: ExecutionResult) { return Boolean(result.errorCode && /(?:_DENIED|_INVALID_|_INVALID$|_INVALID_PATH$)/.test(result.errorCode)); }
}
