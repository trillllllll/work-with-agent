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
  async create(input: { name: string; description?: string; isExploration?: boolean }) { const timestamp = now(); return prisma.topic.create({ data: { name: input.name, description: input.description ?? '', isExploration: input.isExploration ?? false, createdAt: timestamp, updatedAt: timestamp } }); }
  async update(topicId: string, input: Partial<{ name: string; description: string; isExploration: boolean }>) { try { return await prisma.topic.update({ where: { id: topicId }, data: { ...input, updatedAt: now() } }); } catch (error: any) { if (error?.code === 'P2025') throw notFound('主题不存在'); throw error; } }
  async remove(topicId: string) { const topic = await this.get(topicId); if (!topic) throw notFound('主题不存在'); if (topic.tasks.length) throw Object.assign(new Error('非空主题不能删除'), { status: 409 }); return prisma.topic.delete({ where: { id: topicId } }); }
}

export class TaskService {
  async list(topicId?: string) { return prisma.task.findMany({ where: topicId ? { topicId } : undefined, orderBy: { updatedAt: 'desc' } }); }
  async get(taskId: string) { return prisma.task.findUnique({ where: { id: taskId } }); }
  async create(input: { topicId: string; title: string; description?: string; status?: TaskStatus; resultSummary?: string }) { const topic = await prisma.topic.findUnique({ where: { id: input.topicId } }); if (!topic) throw notFound('主题不存在'); const timestamp = now(); return prisma.task.create({ data: { topicId: input.topicId, title: input.title, description: input.description ?? '', status: input.status ?? TaskStatus.todo, resultSummary: input.resultSummary ?? '', createdAt: timestamp, updatedAt: timestamp } }); }
  async update(taskId: string, input: Partial<{ title: string; description: string; status: TaskStatus; resultSummary: string; topicId: string }>) { if (input.topicId && !(await prisma.topic.findUnique({ where: { id: input.topicId } }))) throw notFound('主题不存在'); try { return await prisma.task.update({ where: { id: taskId }, data: { ...input, updatedAt: now() } }); } catch (error: any) { if (error?.code === 'P2025') throw notFound('任务不存在'); throw error; } }
  async remove(taskId: string) { try { return await prisma.task.delete({ where: { id: taskId } }); } catch (error: any) { if (error?.code === 'P2025') throw notFound('任务不存在'); throw error; } }
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
      list_tasks: this.define('list_tasks', '列出任务，可按主题筛选', { topicId: string }, false, async (a) => this.tasks.list(a.topicId ? String(a.topicId) : undefined)),
      get_task: this.define('get_task', '读取一个任务', { taskId: string }, false, async (a) => this.requireResource(await this.tasks.get(String(a.taskId)), '任务不存在'), ['taskId']),
      create_task: this.define('create_task', '创建任务', { topicId: string, title: string, description: string, status, resultSummary: string }, true, async (a) => this.tasks.create({ topicId: String(a.topicId), title: String(a.title), description: a.description as string | undefined, status: a.status as TaskStatus | undefined, resultSummary: a.resultSummary as string | undefined }), ['topicId', 'title']),
      update_task: this.define('update_task', '更新任务', { taskId: string, topicId: string, title: string, description: string, status, resultSummary: string }, true, async (a) => this.tasks.update(String(a.taskId), { topicId: a.topicId as string | undefined, title: a.title as string | undefined, description: a.description as string | undefined, status: a.status as TaskStatus | undefined, resultSummary: a.resultSummary as string | undefined }), ['taskId']),
      delete_task: this.define('delete_task', '删除任务', { taskId: string }, true, async (a) => this.tasks.remove(String(a.taskId)), ['taskId']),
      create_topic: this.define('create_topic', '创建主题', { name: string, description: string, isExploration: { type: 'boolean' } }, true, async (a) => this.topics.create({ name: String(a.name), description: a.description as string | undefined, isExploration: a.isExploration as boolean | undefined }), ['name']),
      update_topic: this.define('update_topic', '更新主题', { topicId: string, name: string, description: string, isExploration: { type: 'boolean' } }, true, async (a) => this.topics.update(String(a.topicId), { name: a.name as string | undefined, description: a.description as string | undefined, isExploration: a.isExploration as boolean | undefined }), ['topicId']),
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
