import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient, TaskStatus } from '@prisma/client';

dotenv.config({ path: resolve(process.cwd(), 'server/.env') });
dotenv.config();

export const prisma = new PrismaClient();
export type ToolResult = { success: boolean; data?: unknown; error?: string };
export type ToolCall = { name: string; arguments: Record<string, unknown>; id?: string };
export type ModelConfig = { baseUrl: string; apiKey: string; model: string };
export type PublicSettings = { baseUrl: string; model: string; apiKeyConfigured: boolean; apiKeyMasked: string | null };
const now = () => new Date().toISOString();

function notFound(message: string) { return Object.assign(new Error(message), { status: 404 }); }
function badRequest(message: string) { return Object.assign(new Error(message), { status: 400 }); }

export class SettingsService {
  private readonly id = 'default';

  private normalizeBaseUrl(value: string) {
    const baseUrl = value.trim().replace(/\/+$/, '');
    try {
      const parsed = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch { throw badRequest('接口地址必须是有效的 HTTP(S) URL'); }
    return baseUrl;
  }

  private validateModel(value: string) {
    const model = value.trim();
    if (!model || model.length > 200) throw badRequest('模型名称不能为空且不能超过 200 个字符');
    return model;
  }

  private validateKey(value: string) {
    const apiKey = value.trim();
    if (!apiKey || apiKey.length > 1000) throw badRequest('API Key 不能为空且不能超过 1000 个字符');
    return apiKey;
  }

  private mask(apiKey: string) { return apiKey ? `${apiKey.slice(0, Math.min(3, apiKey.length))}...${apiKey.slice(-4)}` : null; }

  async getStored() { return prisma.appSetting.findUnique({ where: { id: this.id } }); }

  async getPublic() {
    const setting = await this.getStored();
    return {
      baseUrl: setting?.openaiBaseUrl ?? '',
      model: setting?.openaiModel ?? '',
      apiKeyConfigured: Boolean(setting?.openaiApiKey),
      apiKeyMasked: this.mask(setting?.openaiApiKey ?? ''),
    } satisfies PublicSettings;
  }

  async credentials(): Promise<ModelConfig | null> {
    const setting = await this.getStored();
    if (!setting?.openaiBaseUrl || !setting.openaiApiKey || !setting.openaiModel) return null;
    return { baseUrl: setting.openaiBaseUrl, apiKey: setting.openaiApiKey, model: setting.openaiModel };
  }

  async save(input: { baseUrl: string; model: string; apiKey?: string }, testConnection: (config: ModelConfig) => Promise<void>) {
    const current = await this.getStored();
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    const model = this.validateModel(input.model);
    const apiKey = input.apiKey?.trim() || current?.openaiApiKey || '';
    if (!apiKey) throw badRequest('首次配置必须提供 API Key');
    this.validateKey(apiKey);
    const config = { baseUrl, apiKey, model };
    try {
      await testConnection(config);
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error) throw error;
      throw Object.assign(error instanceof Error ? error : new Error('模型连接测试失败'), { status: 502, code: 'SETTINGS_CONNECTION_FAILED' });
    }
    const timestamp = now();
    await prisma.appSetting.upsert({
      where: { id: this.id },
      create: { id: this.id, openaiBaseUrl: baseUrl, openaiApiKey: apiKey, openaiModel: model, createdAt: timestamp, updatedAt: timestamp },
      update: { openaiBaseUrl: baseUrl, openaiApiKey: apiKey, openaiModel: model, updatedAt: timestamp },
    });
    return this.getPublic();
  }

  async clearApiKey() {
    const current = await this.getStored();
    if (current) await prisma.appSetting.update({ where: { id: this.id }, data: { openaiApiKey: '', updatedAt: now() } });
    return this.getPublic();
  }
}

export class TopicService {
  async list() { return prisma.topic.findMany({ orderBy: { updatedAt: 'desc' } }); }
  async get(topicId: string) { return prisma.topic.findUnique({ where: { id: topicId }, include: { tasks: { orderBy: { updatedAt: 'desc' } } } }); }
  async create(input: { name: string; description?: string; isExploration?: boolean; goal?: string }, source = 'user') { const timestamp = now(); const result = await prisma.topic.create({ data: { name: input.name, description: input.description ?? '', goal: input.goal ?? '', isExploration: input.isExploration ?? false, createdAt: timestamp, updatedAt: timestamp } }); await recordChange('topic', result.id, 'create', null, result, source); return result; }
  async update(topicId: string, input: Partial<{ name: string; description: string; isExploration: boolean; goal: string; draftSummary: string }>, source = 'user') { try { const before = await prisma.topic.findUnique({ where: { id: topicId } }); if (!before) throw notFound('主题不存在'); const data: any = { ...input, updatedAt: now() }; if (input.draftSummary !== undefined) { data.summaryStatus = input.draftSummary ? 'draft' : (before.finalSummary ? 'confirmed' : 'empty'); data.summaryUpdatedAt = now(); } const result = await prisma.topic.update({ where: { id: topicId }, data }); await recordChange('topic', topicId, 'update', before, result, source); return result; } catch (error: any) { if (error?.code === 'P2025') throw notFound('主题不存在'); throw error; } }
  async remove(topicId: string, source = 'user') { const topic = await this.get(topicId); if (!topic) throw notFound('主题不存在'); if (topic.tasks.length) throw Object.assign(new Error('非空主题不能删除'), { status: 409 }); const result = await prisma.topic.delete({ where: { id: topicId } }); await recordChange('topic', topicId, 'delete', topic, null, source); return result; }
  async generateSummary(topicId: string, summary: string) { return this.update(topicId, { draftSummary: summary }, 'agent'); }
  async confirmSummary(topicId: string) { const topic = await this.get(topicId); if (!topic) throw notFound('主题不存在'); if (!topic.draftSummary) throw badRequest('没有待确认的成果草稿'); return prisma.topic.update({ where: { id: topicId }, data: { finalSummary: topic.draftSummary, draftSummary: '', summaryStatus: 'confirmed', summaryUpdatedAt: now(), updatedAt: now() } }); }
  async discardSummary(topicId: string) { const topic = await this.get(topicId); if (!topic) throw notFound('主题不存在'); return prisma.topic.update({ where: { id: topicId }, data: { draftSummary: '', summaryStatus: topic.finalSummary ? 'confirmed' : 'empty', summaryUpdatedAt: now(), updatedAt: now() } }); }
}

export class TaskService {
  async list(topicId?: string) { return prisma.task.findMany({ where: topicId ? { topicId } : undefined, orderBy: { updatedAt: 'desc' } }); }
  async get(taskId: string) { return prisma.task.findUnique({ where: { id: taskId } }); }
  async create(input: { topicId: string; title: string; description?: string; status?: TaskStatus; resultSummary?: string }, source = 'user') { const topic = await prisma.topic.findUnique({ where: { id: input.topicId } }); if (!topic) throw notFound('主题不存在'); const timestamp = now(); const result = await prisma.task.create({ data: { topicId: input.topicId, title: input.title, description: input.description ?? '', status: input.status ?? TaskStatus.todo, resultSummary: input.resultSummary ?? '', createdAt: timestamp, updatedAt: timestamp } }); await recordChange('task', result.id, 'create', null, result, source); return result; }
  async update(taskId: string, input: Partial<{ title: string; description: string; status: TaskStatus; resultSummary: string; topicId: string }>, source = 'user') { if (input.topicId && !(await prisma.topic.findUnique({ where: { id: input.topicId } }))) throw notFound('主题不存在'); try { const before = await prisma.task.findUnique({ where: { id: taskId } }); if (!before) throw notFound('任务不存在'); const result = await prisma.task.update({ where: { id: taskId }, data: { ...input, updatedAt: now() } }); await recordChange('task', taskId, 'update', before, result, source); return result; } catch (error: any) { if (error?.code === 'P2025') throw notFound('任务不存在'); throw error; } }
  async remove(taskId: string, source = 'user') { try { const before = await prisma.task.findUnique({ where: { id: taskId } }); if (!before) throw notFound('任务不存在'); const result = await prisma.task.delete({ where: { id: taskId } }); await recordChange('task', taskId, 'delete', before, null, source); return result; } catch (error: any) { if (error?.code === 'P2025') throw notFound('任务不存在'); throw error; } }
}

async function recordChange(entityType: string, entityId: string, operation: string, before: unknown, after: unknown, source: string) { return prisma.changeRecord.create({ data: { entityType, entityId, operation, beforeSnapshot: before ? JSON.stringify(before) : null, afterSnapshot: after ? JSON.stringify(after) : null, source, createdAt: now() } }); }

export class ChangeService {
  async list(entityType?: string, entityId?: string) { return prisma.changeRecord.findMany({ where: { ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) }, orderBy: { createdAt: 'desc' } }); }
  async undo(id: string) { const record = await prisma.changeRecord.findUnique({ where: { id } }); if (!record) throw notFound('变更记录不存在'); if (record.undoneAt) throw badRequest('该变更已经撤销'); const before = record.beforeSnapshot ? JSON.parse(record.beforeSnapshot) : null; const after = record.afterSnapshot ? JSON.parse(record.afterSnapshot) : null; if (record.entityType === 'task') { if (record.operation === 'create') await prisma.task.delete({ where: { id: record.entityId } }); else if (record.operation === 'delete') await prisma.task.create({ data: { ...before, status: before.status as TaskStatus } }); else await prisma.task.update({ where: { id: record.entityId }, data: before }); } else if (record.entityType === 'topic') { if (record.operation === 'create') await prisma.topic.delete({ where: { id: record.entityId } }); else if (record.operation === 'delete') await prisma.topic.create({ data: before }); else await prisma.topic.update({ where: { id: record.entityId }, data: before }); } await prisma.changeRecord.update({ where: { id }, data: { undoneAt: now() } }); return { success: true }; }
}

export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown>; requiresApproval: boolean; validate: (args: Record<string, unknown>) => string | null; execute: (args: Record<string, unknown>) => Promise<ToolResult> };

function validateParameters(schema: Record<string, any>, args: Record<string, unknown>): string | null {
  const properties = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
  for (const required of (schema.required ?? []) as string[]) {
    if (!(required in args) || args[required] === undefined) return `缺少参数: ${required}`;
  }
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).find((key) => !(key in properties));
    if (unknown) return `未知参数: ${unknown}`;
  }
  for (const [key, value] of Object.entries(args)) {
    if (!(key in properties) || value === undefined) continue;
    const definition = properties[key];
    if (definition.type === 'string' && typeof value !== 'string') return `${key} 必须是字符串`;
    if (definition.type === 'boolean' && typeof value !== 'boolean') return `${key} 必须是布尔值`;
    if (definition.type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) return `${key} 必须是对象`;
    if (definition.enum && !definition.enum.includes(value)) return `${key} 的值无效`;
  }
  return null;
}

export class ToolService {
  private topics = new TopicService();
  private tasks = new TaskService();
  private registry: Record<string, ToolDefinition>;

  constructor() {
    const string = { type: 'string' };
    const status = { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'] };
    this.registry = {
      list_topics: this.define('list_topics', '列出所有主题', {}, false, async () => this.topics.list()),
      get_topic: this.define('get_topic', '读取主题及其任务', { topicId: string }, false, async (a) => this.requireResource(await this.topics.get(String(a.topicId)), '主题不存在'), ['topicId']),
      get_topic_progress: this.define('get_topic_progress', '读取主题进度和成果', { topicId: string }, false, async (a) => { const topic = await this.topics.get(String(a.topicId)); if (!topic) throw notFound('主题不存在'); const counts = Object.fromEntries(['todo', 'doing', 'blocked', 'done'].map((status) => [status, topic.tasks.filter((task) => task.status === status).length])); return { topic, counts }; }, ['topicId']),
      list_tasks: this.define('list_tasks', '列出任务，可按主题筛选', { topicId: string }, false, async (a) => this.tasks.list(a.topicId ? String(a.topicId) : undefined)),
      get_task: this.define('get_task', '读取一个任务', { taskId: string }, false, async (a) => this.requireResource(await this.tasks.get(String(a.taskId)), '任务不存在'), ['taskId']),
      create_task: this.define('create_task', '创建任务', { topicId: string, title: string, description: string, status, resultSummary: string }, true, async (a) => this.tasks.create({ topicId: String(a.topicId), title: String(a.title), description: a.description as string | undefined, status: a.status as TaskStatus | undefined, resultSummary: a.resultSummary as string | undefined }), ['topicId', 'title']),
      update_task: this.define('update_task', '更新任务', { taskId: string, topicId: string, title: string, description: string, status, resultSummary: string }, true, async (a) => this.tasks.update(String(a.taskId), { topicId: a.topicId as string | undefined, title: a.title as string | undefined, description: a.description as string | undefined, status: a.status as TaskStatus | undefined, resultSummary: a.resultSummary as string | undefined }), ['taskId']),
      delete_task: this.define('delete_task', '删除任务', { taskId: string }, true, async (a) => this.tasks.remove(String(a.taskId)), ['taskId']),
      create_topic: this.define('create_topic', '创建主题', { name: string, description: string, isExploration: { type: 'boolean' } }, true, async (a) => this.topics.create({ name: String(a.name), description: a.description as string | undefined, isExploration: a.isExploration as boolean | undefined }), ['name']),
      update_topic: this.define('update_topic', '更新主题', { topicId: string, name: string, description: string, isExploration: { type: 'boolean' } }, true, async (a) => this.topics.update(String(a.topicId), { name: a.name as string | undefined, description: a.description as string | undefined, isExploration: a.isExploration as boolean | undefined }), ['topicId']),
      propose_topic_summary: this.define('propose_topic_summary', '提出主题成果草稿', { topicId: string, summary: string }, true, async (a) => this.topics.generateSummary(String(a.topicId), String(a.summary)), ['topicId', 'summary']),
    };
  }

  private define(name: string, description: string, properties: Record<string, unknown>, requiresApproval: boolean, execute: (args: Record<string, unknown>) => Promise<unknown>, required: string[] = []): ToolDefinition {
    const parameters = { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
    return { name, description, parameters, requiresApproval, validate: () => null, execute: async (args) => ({ success: true, data: await execute(args) }) };
  }

  private requireResource<T>(value: T | null, message: string) { if (!value) throw notFound(message); return value; }
  definitions() { return Object.values(this.registry).map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } })); }
  isKnown(name: string) { return Boolean(this.registry[name]); }
  isReadOnly(name: string) { return this.registry[name]?.requiresApproval === false; }
  validate(call: ToolCall) { const definition = this.registry[call.name]; if (!definition) return `未知 Tool: ${call.name}`; if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) return 'Tool 参数必须是对象'; return validateParameters(definition.parameters, call.arguments) ?? definition.validate(call.arguments); }
  async execute(call: ToolCall): Promise<ToolResult> {
    const validationError = this.validate(call);
    if (validationError) return { success: false, error: validationError };
    try { return await this.registry[call.name].execute(call.arguments); }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Tool 执行失败' }; }
  }
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
export class ApprovalService {
  async create(call: ToolCall, conversationId?: string) { const timestamp = now(); return prisma.approval.create({ data: { toolName: call.name, arguments: JSON.stringify(call.arguments), conversationId, createdAt: timestamp, updatedAt: timestamp } }); }
  async get(approvalId: string) { return prisma.approval.findUnique({ where: { id: approvalId } }); }
  async list(status?: ApprovalStatus) { return prisma.approval.findMany({ where: status ? { status } : undefined, orderBy: { createdAt: 'asc' } }); }
  async update(approvalId: string, status: ApprovalStatus, result?: ToolResult) { return prisma.approval.update({ where: { id: approvalId }, data: { status, result: result ? JSON.stringify(result) : undefined, updatedAt: now() } }); }
  async claim(approvalId: string) { const claimed = await prisma.approval.updateMany({ where: { id: approvalId, status: 'pending' }, data: { status: 'approved', updatedAt: now() } }); return claimed.count === 1; }
  parse(value: { toolName: string; arguments: string }) { return { name: value.toolName, arguments: JSON.parse(value.arguments) as Record<string, unknown> }; }
}

export class ConversationService {
  async create() { const timestamp = now(); return prisma.conversation.create({ data: { createdAt: timestamp, updatedAt: timestamp } }); }
  async get(conversationId: string) { return prisma.conversation.findUnique({ where: { id: conversationId } }); }
  async addMessage(conversationId: string, role: 'user' | 'assistant' | 'tool' | 'system', content: string, status: 'streaming' | 'completed' | 'failed' = 'completed') { return prisma.message.create({ data: { conversationId, role, content, status, createdAt: now() } }); }
  async updateMessage(messageId: string, data: { content?: string; status?: 'streaming' | 'completed' | 'failed' }) { return prisma.message.update({ where: { id: messageId }, data }); }
  async listMessages(conversationId: string) { return prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }); }
  async updateSummary(conversationId: string, summary: string) { return prisma.conversation.update({ where: { id: conversationId }, data: { summary, updatedAt: now() } }); }
}

export type ExecutionRequest = { kind: 'shell' | 'file' | 'http'; input: Record<string, unknown>; approvalId: string };
export type ExecutionResult = { success: boolean; data?: unknown; error?: string; reversible: boolean };
export interface ExecutionAdapter { execute(request: ExecutionRequest): Promise<ExecutionResult>; }
export class RecordOnlyExecutionAdapter implements ExecutionAdapter {
  async execute(request: ExecutionRequest): Promise<ExecutionResult> { return { success: true, data: { recorded: true, kind: request.kind, input: request.input }, reversible: false }; }
}

export class ContextService {
  constructor(private readonly model?: { complete(messages: any[], signal?: AbortSignal, includeTools?: boolean): Promise<{ text: string }> }) {}
  estimateTokens(messages: Array<{ content?: string | null }>) { return Math.ceil(messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0) / 4); }
  async compact(conversationId: string, signal?: AbortSignal) {
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } }); if (!conversation) throw notFound('会话不存在');
    const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }); const old = messages.slice(0, -12); if (!old.length) return conversation;
    let summary = conversation.summary; try { summary = this.model ? (await this.model.complete([{ role: 'system', content: '请将对话压缩为结构化摘要：目标、已完成工作、关键决定、未决问题、失败信息。' }, { role: 'user', content: old.map((m) => `${m.role}: ${m.content}`).join('\n') }], signal)).text : old.map((m) => `${m.role}: ${m.content}`).join('\n').slice(-6000); } catch { return conversation; }
    const ids = old.map((message) => message.id); await prisma.message.updateMany({ where: { id: { in: ids } }, data: { compactedAt: new Date().toISOString() } });
    return prisma.conversation.update({ where: { id: conversationId }, data: { summary, summaryVersion: { increment: 1 }, lastCompactedAt: new Date().toISOString(), tokenEstimate: this.estimateTokens(messages.slice(-12)) } });
  }
}
