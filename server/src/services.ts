import dotenv from 'dotenv';
import { resolve, relative, sep, dirname, basename } from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { PrismaClient, Prisma, TaskStatus } from '@prisma/client';

dotenv.config({ path: resolve(process.cwd(), 'server/.env') });
dotenv.config();

export const prisma = new PrismaClient();
export type ToolResult = { success: boolean; data?: unknown; error?: string };
export type ToolCall = { name: string; arguments: Record<string, unknown>; id?: string };
export type ModelConfig = { baseUrl: string; apiKey: string; model: string };
export type PublicSettings = { baseUrl: string; model: string; apiKeyConfigured: boolean; apiKeyMasked: string | null };
export type MutationContext = { source: 'user' | 'agent'; conversationId?: string; approvalId?: string; requestId?: string };
export type ExecutionKind = 'shell' | 'http' | 'file';
export type ExecutionRequest = { kind: ExecutionKind; input: Record<string, unknown>; approvalId: string; timeoutMs?: number; maxOutputBytes?: number; workingDirectory?: string };
export type ExecutionResult = { success: boolean; data?: unknown; error?: string; errorCode?: string; stdout?: string; stderr?: string; durationMs: number; reversible: boolean; redacted: boolean };
type Db = Prisma.TransactionClient | typeof prisma;
export interface CredentialStore { read(): Promise<string | null>; write(value: string): Promise<void>; clear(): Promise<void>; }
export class SqliteCredentialStore implements CredentialStore {
  async read() { return (await prisma.appSetting.findUnique({ where: { id: 'default' } }))?.openaiApiKey || null; }
  async write(value: string) { await prisma.appSetting.upsert({ where: { id: 'default' }, create: { id: 'default', openaiApiKey: value, createdAt: now(), updatedAt: now() }, update: { openaiApiKey: value, updatedAt: now() } }); }
  async clear() { await prisma.appSetting.updateMany({ where: { id: 'default' }, data: { openaiApiKey: '', updatedAt: now() } }); }
}
const now = () => new Date().toISOString();

function notFound(message: string) { return Object.assign(new Error(message), { status: 404 }); }
function badRequest(message: string) { return Object.assign(new Error(message), { status: 400 }); }

export class SettingsService {
  private readonly id = 'default';
  constructor(private readonly credentialsStore: CredentialStore = new SqliteCredentialStore()) {}

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
      apiKeyConfigured: Boolean(await this.credentialsStore.read()),
      apiKeyMasked: this.mask((await this.credentialsStore.read()) ?? ''),
    } satisfies PublicSettings;
  }

  async credentials(): Promise<ModelConfig | null> {
    const setting = await this.getStored();
    const apiKey = await this.credentialsStore.read();
    if (!setting?.openaiBaseUrl || !apiKey || !setting.openaiModel) return null;
    return { baseUrl: setting.openaiBaseUrl, apiKey, model: setting.openaiModel };
  }

  async save(input: { baseUrl: string; model: string; apiKey?: string }, testConnection: (config: ModelConfig) => Promise<void>) {
    const current = await this.getStored();
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    const model = this.validateModel(input.model);
    const apiKey = input.apiKey?.trim() || await this.credentialsStore.read() || current?.openaiApiKey || '';
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
    await this.credentialsStore.write(apiKey);
    return this.getPublic();
  }

  async clearApiKey() {
    const current = await this.getStored();
    if (current) await this.credentialsStore.clear();
    return this.getPublic();
  }
}

export class TopicService {
  async list() { return prisma.topic.findMany({ orderBy: { updatedAt: 'desc' } }); }
  async get(topicId: string) { return prisma.topic.findUnique({ where: { id: topicId }, include: { tasks: { where: { deletedAt: null }, orderBy: { updatedAt: 'desc' } } } }); }
  async create(input: { name: string; description?: string; isExploration?: boolean; goal?: string }, context: MutationContext | string = { source: 'user' }) { const ctx = typeof context === 'string' ? { source: context as MutationContext['source'] } : context; return prisma.$transaction(async (tx) => { const timestamp = now(); const result = await tx.topic.create({ data: { name: input.name, description: input.description ?? '', goal: input.goal ?? '', isExploration: input.isExploration ?? false, createdAt: timestamp, updatedAt: timestamp } }); await recordChange(tx, 'topic', result.id, 'create', null, result, ctx); return result; }); }
  async update(topicId: string, input: Partial<{ name: string; description: string; isExploration: boolean; goal: string; draftSummary: string }>, context: MutationContext | string = { source: 'user' }) { const ctx = typeof context === 'string' ? { source: context as MutationContext['source'] } : context; try { return await prisma.$transaction(async (tx) => { const before = await tx.topic.findUnique({ where: { id: topicId } }); if (!before) throw notFound('主题不存在'); const data: any = { ...input, updatedAt: now() }; if (input.draftSummary !== undefined) { data.summaryStatus = input.draftSummary ? 'draft' : (before.finalSummary ? 'confirmed' : 'empty'); data.summaryUpdatedAt = now(); } const result = await tx.topic.update({ where: { id: topicId }, data }); await recordChange(tx, 'topic', topicId, 'update', before, result, ctx); return result; }); } catch (error: any) { if (error?.code === 'P2025') throw notFound('主题不存在'); throw error; } }
  async remove(topicId: string, context: MutationContext | string = { source: 'user' }) { const ctx = typeof context === 'string' ? { source: context as MutationContext['source'] } : context; return prisma.$transaction(async (tx) => { const topic = await tx.topic.findUnique({ where: { id: topicId }, include: { tasks: true } }); if (!topic) throw notFound('主题不存在'); if (topic.tasks.length) throw Object.assign(new Error('非空主题不能删除'), { status: 409 }); const result = await tx.topic.delete({ where: { id: topicId } }); await recordChange(tx, 'topic', topicId, 'delete', topic, null, ctx); return result; }); }
  async generateSummary(topicId: string, summary: string, context: MutationContext = { source: 'agent' }) { return this.update(topicId, { draftSummary: summary }, context); }
  async confirmSummary(topicId: string, context: MutationContext = { source: 'user' }) { return prisma.$transaction(async (tx) => { const topic = await tx.topic.findUnique({ where: { id: topicId } }); if (!topic) throw notFound('主题不存在'); if (!topic.draftSummary) throw badRequest('没有待确认的成果草稿'); const result = await tx.topic.update({ where: { id: topicId }, data: { finalSummary: topic.draftSummary, draftSummary: '', summaryStatus: 'confirmed', summaryUpdatedAt: now(), updatedAt: now() } }); await recordChange(tx, 'topic', topicId, 'confirm_summary', topic, result, context); return result; }); }
  async discardSummary(topicId: string, context: MutationContext = { source: 'user' }) { return prisma.$transaction(async (tx) => { const topic = await tx.topic.findUnique({ where: { id: topicId } }); if (!topic) throw notFound('主题不存在'); const result = await tx.topic.update({ where: { id: topicId }, data: { draftSummary: '', summaryStatus: topic.finalSummary ? 'confirmed' : 'empty', summaryUpdatedAt: now(), updatedAt: now() } }); await recordChange(tx, 'topic', topicId, 'discard_summary', topic, result, context); return result; }); }
}

export class TaskService {
  async list(topicId?: string, options: { includeDeleted?: boolean } = {}) { return prisma.task.findMany({ where: { ...(topicId ? { topicId } : {}), ...(options.includeDeleted ? {} : { deletedAt: null }) }, orderBy: { updatedAt: 'desc' } }); }
  async listDeleted() { return prisma.task.findMany({ where: { deletedAt: { not: null } }, include: { topic: { select: { id: true, name: true } } }, orderBy: { deletedAt: 'desc' } }); }
  async get(taskId: string, options: { includeDeleted?: boolean } = {}) { return prisma.task.findFirst({ where: { id: taskId, ...(options.includeDeleted ? {} : { deletedAt: null }) } }); }
  async create(input: { topicId: string; title: string; description?: string; status?: TaskStatus; resultSummary?: string }, context: MutationContext | string = { source: 'user' }) { const ctx = typeof context === 'string' ? { source: context as MutationContext['source'] } : context; return prisma.$transaction(async (tx) => { const topic = await tx.topic.findUnique({ where: { id: input.topicId } }); if (!topic) throw notFound('主题不存在'); const timestamp = now(); const result = await tx.task.create({ data: { topicId: input.topicId, title: input.title, description: input.description ?? '', status: input.status ?? TaskStatus.todo, resultSummary: input.resultSummary ?? '', createdAt: timestamp, updatedAt: timestamp } }); await recordChange(tx, 'task', result.id, 'create', null, result, ctx); return result; }); }
  async update(taskId: string, input: Partial<{ title: string; description: string; status: TaskStatus; resultSummary: string; topicId: string }>, context: MutationContext | string = { source: 'user' }) { const ctx = typeof context === 'string' ? { source: context as MutationContext['source'] } : context; try { return await prisma.$transaction(async (tx) => { if (input.topicId && !(await tx.topic.findUnique({ where: { id: input.topicId } }))) throw notFound('主题不存在'); const before = await tx.task.findUnique({ where: { id: taskId } }); if (!before) throw notFound('任务不存在'); if (before.deletedAt) throw Object.assign(new Error('回收站中的任务不能直接修改'), { status: 409 }); const result = await tx.task.update({ where: { id: taskId }, data: { ...input, updatedAt: now() } }); await recordChange(tx, 'task', taskId, 'update', before, result, ctx); return result; }); } catch (error: any) { if (error?.code === 'P2025') throw notFound('任务不存在'); throw error; } }
  async remove(taskId: string, context: MutationContext | string = { source: 'user' }) { return this.softDelete(taskId, typeof context === 'string' ? { source: context as MutationContext['source'] } : context); }
  async softDelete(taskId: string, context: MutationContext = { source: 'user' }) { return prisma.$transaction(async (tx) => { const before = await tx.task.findUnique({ where: { id: taskId } }); if (!before) throw notFound('任务不存在'); if (before.deletedAt) throw Object.assign(new Error('任务已在回收站'), { status: 409 }); const result = await tx.task.update({ where: { id: taskId }, data: { deletedAt: now(), updatedAt: now() } }); await recordChange(tx, 'task', taskId, 'delete', before, result, context); return result; }); }
  async restore(taskId: string, context: MutationContext = { source: 'user' }) { return prisma.$transaction(async (tx) => { const task = await tx.task.findUnique({ where: { id: taskId }, include: { topic: true } }); if (!task || !task.deletedAt) throw Object.assign(new Error('任务不在回收站'), { status: 409 }); if (!task.topic) throw Object.assign(new Error('原主题不存在，无法恢复任务'), { status: 409 }); const result = await tx.task.update({ where: { id: taskId }, data: { deletedAt: null, updatedAt: now() } }); await recordChange(tx, 'task', taskId, 'restore', task, result, context); return result; }); }
  async permanentDelete(taskId: string, context: MutationContext = { source: 'user' }) { return prisma.$transaction(async (tx) => { const before = await tx.task.findUnique({ where: { id: taskId } }); if (!before || !before.deletedAt) throw Object.assign(new Error('任务不在回收站'), { status: 409 }); await tx.task.delete({ where: { id: taskId } }); await recordChange(tx, 'task', taskId, 'permanent_delete', before, null, context); return before; }); }
}

async function recordChange(db: Db, entityType: string, entityId: string, operation: string, before: unknown, after: unknown, context: MutationContext, reversalOf?: string) { return db.changeRecord.create({ data: { entityType, entityId, operation, beforeSnapshot: before ? JSON.stringify(before) : null, afterSnapshot: after ? JSON.stringify(after) : null, source: context.source, conversationId: context.conversationId, approvalId: context.approvalId, requestId: context.requestId, reversalOf, createdAt: now() } }); }

export class WorkspaceMutation {
  constructor(private readonly topics = new TopicService(), private readonly tasks = new TaskService()) {}
  async execute(call: ToolCall, context: MutationContext): Promise<unknown> {
    switch (call.name) {
      case 'create_task': return this.tasks.create({ topicId: String(call.arguments.topicId), title: String(call.arguments.title), description: call.arguments.description as string | undefined, status: call.arguments.status as TaskStatus | undefined, resultSummary: call.arguments.resultSummary as string | undefined }, context);
      case 'update_task': return this.tasks.update(String(call.arguments.taskId), { topicId: call.arguments.topicId as string | undefined, title: call.arguments.title as string | undefined, description: call.arguments.description as string | undefined, status: call.arguments.status as TaskStatus | undefined, resultSummary: call.arguments.resultSummary as string | undefined }, context);
      case 'delete_task': return this.tasks.remove(String(call.arguments.taskId), context);
      case 'restore_task': return this.tasks.restore(String(call.arguments.taskId), context);
      case 'permanent_delete_task': return this.tasks.permanentDelete(String(call.arguments.taskId), context);
      case 'create_topic': return this.topics.create({ name: String(call.arguments.name), description: call.arguments.description as string | undefined, isExploration: call.arguments.isExploration as boolean | undefined }, context);
      case 'update_topic': return this.topics.update(String(call.arguments.topicId), { name: call.arguments.name as string | undefined, description: call.arguments.description as string | undefined, isExploration: call.arguments.isExploration as boolean | undefined }, context);
      case 'delete_topic': return this.topics.remove(String(call.arguments.topicId), context);
      case 'propose_topic_summary': return this.topics.generateSummary(String(call.arguments.topicId), String(call.arguments.summary), context);
      default: throw badRequest(`不支持的写入 Tool: ${call.name}`);
    }
  }
  async restore(record: { entityType: string; entityId: string; operation: string; beforeSnapshot: string | null; afterSnapshot: string | null }, context: MutationContext, db: Db = prisma) {
    const run = async (tx: Db) => {
      const before = record.beforeSnapshot ? JSON.parse(record.beforeSnapshot) : null;
      const after = record.afterSnapshot ? JSON.parse(record.afterSnapshot) : null;
      const current = record.entityType === 'task' ? await tx.task.findUnique({ where: { id: record.entityId } }) : await tx.topic.findUnique({ where: { id: record.entityId } });
      const expected = record.operation === 'create' ? after : record.operation === 'update' ? after : null;
      if (record.operation !== 'delete' && expected && current && current.updatedAt !== expected.updatedAt) throw Object.assign(new Error('实体已发生后续变更，无法撤销'), { status: 409 });
      if (record.entityType === 'task') {
        if (record.operation === 'create') await tx.task.delete({ where: { id: record.entityId } });
        else if (record.operation === 'delete') {
          if (current) await tx.task.update({ where: { id: record.entityId }, data: sanitizeTask(before) });
          else await tx.task.create({ data: sanitizeTask(before) });
        }
        else await tx.task.update({ where: { id: record.entityId }, data: sanitizeTask(before) });
      } else if (record.entityType === 'topic') {
        if (record.operation === 'create') await tx.topic.delete({ where: { id: record.entityId } });
        else if (record.operation === 'delete') await tx.topic.create({ data: sanitizeTopic(before) });
        else await tx.topic.update({ where: { id: record.entityId }, data: sanitizeTopic(before) });
      } else throw badRequest('不支持的变更实体类型');
      return { before, after };
    };
    return db === prisma ? prisma.$transaction(run) : run(db);
  }
}

function sanitizeTask(value: any) { const { topic, ...data } = value ?? {}; return { ...data, status: data.status as TaskStatus }; }
function sanitizeTopic(value: any) { const { tasks, ...data } = value ?? {}; return data; }

export class ChangeService {
  constructor(private readonly mutations = new WorkspaceMutation()) {}
  async list(entityType?: string, entityId?: string) { return prisma.changeRecord.findMany({ where: { ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) }, orderBy: { createdAt: 'desc' } }); }
  async undo(id: string, context: MutationContext = { source: 'user' }) { const record = await prisma.changeRecord.findUnique({ where: { id } }); if (!record) throw notFound('变更记录不存在'); if (record.undoneAt) throw badRequest('该变更已经撤销'); return prisma.$transaction(async (tx) => { await this.mutations.restore(record, context, tx); await tx.changeRecord.update({ where: { id }, data: { undoneAt: now() } }); await recordChange(tx, record.entityType, record.entityId, `undo:${record.operation}`, record.afterSnapshot ? JSON.parse(record.afterSnapshot) : null, record.beforeSnapshot ? JSON.parse(record.beforeSnapshot) : null, context, id); return { success: true }; }); }
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
    if (definition.type === 'number' && typeof value !== 'number') return `${key} 必须是数字`;
    if (definition.type === 'array' && !Array.isArray(value)) return `${key} 必须是数组`;
    if (definition.type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) return `${key} 必须是对象`;
    if (definition.enum && !definition.enum.includes(value)) return `${key} 的值无效`;
  }
  return null;
}

export class ToolService {
  private topics = new TopicService();
  private tasks = new TaskService();
  private registry: Record<string, ToolDefinition>;
  private mutations = new WorkspaceMutation();
  private execution: ExecutionAdapter;

  constructor(execution: ExecutionAdapter = new ControlledExecutionAdapter()) {
    this.execution = execution;
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
      execute_shell: this.define('execute_shell', '在受控工作区执行白名单命令', { command: string, args: { type: 'array' }, workingDirectory: string, timeoutMs: { type: 'number' } }, true, async (a) => this.execution.execute({ kind: 'shell', input: a, approvalId: 'tool' }), ['command']),
      execute_file: this.define('execute_file', '在受控工作区进行文件操作', { operation: string, path: string, content: string, recursive: { type: 'boolean' } }, true, async (a) => this.execution.execute({ kind: 'file', input: a, approvalId: 'tool' }), ['operation', 'path']),
      execute_http: this.define('execute_http', '访问受控 HTTP(S) 目标', { method: string, url: string, headers: { type: 'object' }, body: { type: 'object' }, timeoutMs: { type: 'number' } }, true, async (a) => this.execution.execute({ kind: 'http', input: a, approvalId: 'tool' }), ['url']),
    };
  }

  private define(name: string, description: string, properties: Record<string, unknown>, requiresApproval: boolean, execute: (args: Record<string, unknown>) => Promise<unknown>, required: string[] = []): ToolDefinition {
    const parameters = { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
    return { name, description, parameters, requiresApproval, validate: () => null, execute: async (args) => ({ success: true, data: await execute(args) }) };
  }

  private requireResource<T>(value: T | null, message: string) { if (!value) throw notFound(message); return value; }
  definitions(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> { return Object.values(this.registry).map(({ name, description, parameters }) => ({ type: 'function' as const, function: { name, description, parameters } })); }
  isKnown(name: string) { return Boolean(this.registry[name]); }
  isReadOnly(name: string) { return this.registry[name]?.requiresApproval === false; }
  validate(call: ToolCall) { const definition = this.registry[call.name]; if (!definition) return `未知 Tool: ${call.name}`; if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) return 'Tool 参数必须是对象'; return validateParameters(definition.parameters, call.arguments) ?? definition.validate(call.arguments); }
  async execute(call: ToolCall, context: MutationContext = { source: 'user' }): Promise<ToolResult> {
    const validationError = this.validate(call);
    if (validationError) return { success: false, error: validationError };
    try {
      if (this.registry[call.name].requiresApproval) {
        if (call.name === 'execute_shell' || call.name === 'execute_file' || call.name === 'execute_http') {
          const kind = call.name === 'execute_shell' ? 'shell' : call.name === 'execute_file' ? 'file' : 'http';
          return { success: true, data: await this.execution.execute({ kind, input: call.arguments, approvalId: context.approvalId ?? 'direct', timeoutMs: Number(call.arguments.timeoutMs) || undefined }) };
        }
        return { success: true, data: await this.mutations.execute(call, context) };
      }
      return await this.registry[call.name].execute(call.arguments);
    }
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

export interface ExecutionAdapter { execute(request: ExecutionRequest): Promise<ExecutionResult>; }
export class RecordOnlyExecutionAdapter implements ExecutionAdapter {
  async execute(request: ExecutionRequest): Promise<ExecutionResult> { return { success: true, data: { recorded: true, kind: request.kind, input: redact(request.input) }, durationMs: 0, reversible: false, redacted: true }; }
}

const MAX_TIMEOUT = 30_000;
const MAX_OUTPUT = 256 * 1024;
const workspaceRoot = resolve(process.env.AGENT_WORKSPACE_ROOT || process.cwd());
const redact = (value: unknown): unknown => { if (Array.isArray(value)) return value.map(redact); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [/authorization|api[-_]?key|cookie|token|secret/i.test(key) ? [key, '[REDACTED]'] : [key, redact(item)] ])); };
function boundedNumber(value: unknown, fallback: number, max: number) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), max) : fallback; }
function safePath(value: unknown) { if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error('文件路径不能为空'), { code: 'FILE_INVALID_PATH' }); const target = resolve(workspaceRoot, value); const rel = relative(workspaceRoot, target); if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(target) !== target && !target.startsWith(workspaceRoot)) throw Object.assign(new Error('文件路径超出工作区'), { code: 'FILE_PATH_DENIED' }); return target; }
async function assertSafeTarget(url: string) { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('仅支持 HTTP(S)'), { code: 'HTTP_PROTOCOL_DENIED' }); const host = parsed.hostname.toLowerCase(); if (host === 'localhost' || host === 'metadata.google.internal' || host.endsWith('.local') || /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) throw Object.assign(new Error('目标地址被禁止'), { code: 'HTTP_TARGET_DENIED' }); const addresses = await lookup(host, { all: true }).catch(() => []); if (addresses.some((item) => /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(item.address))) throw Object.assign(new Error('目标地址解析到受限网络'), { code: 'HTTP_TARGET_DENIED' }); }
export class ControlledExecutionAdapter implements ExecutionAdapter {
  async execute(request: ExecutionRequest): Promise<ExecutionResult> { const started = Date.now(); const timeoutMs = boundedNumber(request.timeoutMs, 10_000, MAX_TIMEOUT); const maxOutputBytes = boundedNumber(request.maxOutputBytes, MAX_OUTPUT, MAX_OUTPUT); try { const data = request.kind === 'shell' ? await this.shell(request.input, timeoutMs, maxOutputBytes) : request.kind === 'file' ? await this.file(request.input, maxOutputBytes) : await this.http(request.input, timeoutMs, maxOutputBytes); return { success: true, data: redact(data), durationMs: Date.now() - started, reversible: request.kind === 'file' && (request.input.operation === 'write' || request.input.operation === 'mkdir'), redacted: true }; } catch (error) { const e = error as any; return { success: false, error: e?.message ?? '执行失败', errorCode: e?.code ?? 'EXECUTION_FAILED', durationMs: Date.now() - started, reversible: false, redacted: true }; } }
  private async shell(input: Record<string, unknown>, timeoutMs: number, maxOutputBytes: number) { const command = String(input.command || ''); const args = Array.isArray(input.args) ? input.args.map(String) : []; const allowed = (process.env.AGENT_ALLOWED_COMMANDS || 'node,npm,git').split(',').map((item) => item.trim()).filter(Boolean); if (!allowed.includes(command)) throw Object.assign(new Error('命令不在白名单中'), { code: 'SHELL_COMMAND_DENIED' }); const cwd = input.workingDirectory ? safePath(input.workingDirectory) : workspaceRoot; const child = spawn(command, args, { cwd, shell: false, windowsHide: true, env: { PATH: process.env.PATH, NODE_ENV: 'production' } }); let stdout = ''; let stderr = ''; const append = (current: string, chunk: Buffer) => (current + chunk.toString()).slice(0, maxOutputBytes); child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); }); child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); }); const timer = setTimeout(() => child.kill(), timeoutMs); const exitCode = await new Promise<number>((resolveExit, reject) => { child.on('error', reject); child.on('close', (code) => resolveExit(code ?? 1)); }); clearTimeout(timer); if (exitCode !== 0) throw Object.assign(new Error(`命令退出码 ${exitCode}`), { code: 'SHELL_EXITED', stdout, stderr }); return { command, args, exitCode, stdout, stderr }; }
  private async file(input: Record<string, unknown>, maxOutputBytes: number) { const operation = String(input.operation || 'read'); const target = safePath(input.path); if (operation === 'read') { const content = await fs.readFile(target); if (content.byteLength > maxOutputBytes) throw Object.assign(new Error('文件超过大小限制'), { code: 'FILE_SIZE_LIMIT' }); return { operation, path: relative(workspaceRoot, target), content: content.toString('utf8') }; } if (operation === 'write') { const content = String(input.content ?? ''); if (Buffer.byteLength(content) > maxOutputBytes) throw Object.assign(new Error('文件超过大小限制'), { code: 'FILE_SIZE_LIMIT' }); await fs.mkdir(dirname(target), { recursive: true }); await fs.writeFile(target, content, 'utf8'); return { operation, path: relative(workspaceRoot, target), bytes: Buffer.byteLength(content) }; } if (operation === 'mkdir') { await fs.mkdir(target, { recursive: true }); return { operation, path: relative(workspaceRoot, target) }; } if (operation === 'delete') { await fs.rm(target, { recursive: Boolean(input.recursive), force: false }); return { operation, path: relative(workspaceRoot, target) }; } throw Object.assign(new Error('文件操作不支持'), { code: 'FILE_OPERATION_DENIED' }); }
  private async http(input: Record<string, unknown>, timeoutMs: number, maxOutputBytes: number) { const url = String(input.url || ''); await assertSafeTarget(url); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { const headers = Object.fromEntries(Object.entries((input.headers as Record<string, unknown>) || {}).filter(([key]) => !/host|content-length/i.test(key)).map(([key, value]) => [key, String(value)])); const response = await fetch(url, { method: String(input.method || 'GET').toUpperCase(), headers, body: input.body == null ? undefined : JSON.stringify(input.body), signal: controller.signal, redirect: 'error' }); const text = await response.text(); if (Buffer.byteLength(text) > maxOutputBytes) throw Object.assign(new Error('响应超过大小限制'), { code: 'HTTP_RESPONSE_LIMIT' }); return { url: new URL(url).origin, status: response.status, body: text }; } finally { clearTimeout(timer); } }
}

export class ContextService {
  constructor(private readonly model?: { complete(messages: any[], signal?: AbortSignal, includeTools?: boolean): Promise<{ text: string }> }) {}
  estimateTokens(messages: Array<{ content?: string | null }>) { return Math.ceil(messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0) / 4); }
  async compactIfNeeded(conversationId: string, signal?: AbortSignal) {
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } }); if (!conversation) throw notFound('会话不存在');
    const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } });
    const old = messages.slice(0, -12); const estimate = this.estimateTokens(messages);
    if (estimate <= 6000 && messages.length <= 24 && old.filter((message) => !message.compactedAt).length <= 12) return conversation;
    return this.compact(conversationId, signal);
  }
  async buildWindow(conversationId: string, pageContext: unknown) {
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } }); if (!conversation) throw notFound('会话不存在');
    const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } });
    const recentMessages = messages.slice(-12).filter((item) => item.role !== 'tool' && item.status !== 'streaming').map(({ role, content }) => ({ role, content }));
    const tasks = pageContext && typeof pageContext === 'object' && 'topicId' in pageContext ? await new TaskService().list((pageContext as any).topicId ?? undefined) : await new TaskService().list();
    return { summary: conversation.summary, recentMessages, pageContext, recentTasks: tasks.slice(0, 8), estimatedTokens: this.estimateTokens(messages.slice(-12)) };
  }
  async compact(conversationId: string, signal?: AbortSignal) {
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } }); if (!conversation) throw notFound('会话不存在');
    const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }); const old = messages.slice(0, -12); if (!old.length) return conversation;
    let summary = conversation.summary; try { summary = this.model ? (await this.model.complete([{ role: 'system', content: '请将对话压缩为结构化摘要：目标、已完成工作、关键决定、未决问题、失败信息。' }, { role: 'user', content: old.map((m) => `${m.role}: ${m.content}`).join('\n') }], signal)).text : old.map((m) => `${m.role}: ${m.content}`).join('\n').slice(-6000); } catch { return conversation; }
    const ids = old.map((message) => message.id); await prisma.message.updateMany({ where: { id: { in: ids } }, data: { compactedAt: new Date().toISOString() } });
    return prisma.conversation.update({ where: { id: conversationId }, data: { summary, summaryVersion: { increment: 1 }, lastCompactedAt: new Date().toISOString(), tokenEstimate: this.estimateTokens(messages.slice(-12)) } });
  }
}
