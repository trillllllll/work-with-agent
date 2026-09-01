import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient, TaskStatus } from '@prisma/client';

dotenv.config({ path: resolve(process.cwd(), 'server/.env') });
dotenv.config();

export const prisma = new PrismaClient();
export type ToolResult = { success: boolean; data?: unknown; error?: string };
export type ToolCall = { name: string; arguments: Record<string, unknown> };
const now = () => new Date().toISOString();

function notFound(message: string) { return Object.assign(new Error(message), { status: 404 }); }

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

type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown>; requiresApproval: boolean; validate: (args: Record<string, unknown>) => string | null; execute: (args: Record<string, unknown>) => Promise<ToolResult> };
const toolSchemas: Record<string, Omit<ToolDefinition, 'name' | 'execute'>> = {
  list_topics: { description: '列出所有主题', parameters: { type: 'object', properties: {}, additionalProperties: false }, requiresApproval: false, validate: () => null },
  get_topic: { description: '读取主题及其任务', parameters: { type: 'object', properties: { topicId: { type: 'string' } }, required: ['topicId'], additionalProperties: false }, requiresApproval: false, validate: (a) => typeof a.topicId === 'string' ? null : 'topicId 必须是字符串' },
  list_tasks: { description: '列出任务，可按主题筛选', parameters: { type: 'object', properties: { topicId: { type: 'string' } }, additionalProperties: false }, requiresApproval: false, validate: (a) => a.topicId === undefined || typeof a.topicId === 'string' ? null : 'topicId 必须是字符串' },
  get_task: { description: '读取一个任务', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false }, requiresApproval: false, validate: (a) => typeof a.taskId === 'string' ? null : 'taskId 必须是字符串' },
  create_task: { description: '创建任务', parameters: { type: 'object', properties: { topicId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'] }, resultSummary: { type: 'string' } }, required: ['topicId', 'title'], additionalProperties: false }, requiresApproval: true, validate: (a) => typeof a.topicId === 'string' && typeof a.title === 'string' ? null : 'topicId 和 title 必须是字符串' },
  update_task: { description: '更新任务', parameters: { type: 'object', properties: { taskId: { type: 'string' }, topicId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'] }, resultSummary: { type: 'string' } }, required: ['taskId'], additionalProperties: false }, requiresApproval: true, validate: (a) => typeof a.taskId === 'string' ? null : 'taskId 必须是字符串' },
  delete_task: { description: '删除任务', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false }, requiresApproval: true, validate: (a) => typeof a.taskId === 'string' ? null : 'taskId 必须是字符串' },
  create_topic: { description: '创建主题', parameters: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, isExploration: { type: 'boolean' } }, required: ['name'], additionalProperties: false }, requiresApproval: true, validate: (a) => typeof a.name === 'string' ? null : 'name 必须是字符串' },
  update_topic: { description: '更新主题', parameters: { type: 'object', properties: { topicId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, isExploration: { type: 'boolean' } }, required: ['topicId'], additionalProperties: false }, requiresApproval: true, validate: (a) => typeof a.topicId === 'string' ? null : 'topicId 必须是字符串' },
};

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
  private topics = new TopicService(); private tasks = new TaskService();
  definitions() { return Object.entries(toolSchemas).map(([name, definition]) => ({ type: 'function', function: { name, description: definition.description, parameters: definition.parameters } })); }
  isKnown(name: string) { return Boolean(toolSchemas[name]); }
  isReadOnly(name: string) { return toolSchemas[name]?.requiresApproval === false; }
  validate(call: ToolCall) { const definition = toolSchemas[call.name]; if (!definition) return `未知 Tool: ${call.name}`; if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) return 'Tool 参数必须是对象'; return validateParameters(definition.parameters, call.arguments) ?? definition.validate(call.arguments); }
  async execute(call: ToolCall): Promise<ToolResult> { const validationError = this.validate(call); if (validationError) return { success: false, error: validationError }; const a = call.arguments; try { switch (call.name) {
    case 'list_topics': return { success: true, data: await this.topics.list() };
    case 'get_topic': { const data = await this.topics.get(String(a.topicId)); return data ? { success: true, data } : { success: false, error: '主题不存在' }; }
    case 'list_tasks': return { success: true, data: await this.tasks.list(a.topicId ? String(a.topicId) : undefined) };
    case 'get_task': { const data = await this.tasks.get(String(a.taskId)); return data ? { success: true, data } : { success: false, error: '任务不存在' }; }
    case 'create_topic': return { success: true, data: await this.topics.create({ name: String(a.name), description: a.description as string | undefined, isExploration: a.isExploration as boolean | undefined }) };
    case 'update_topic': return { success: true, data: await this.topics.update(String(a.topicId), { name: a.name as string | undefined, description: a.description as string | undefined, isExploration: a.isExploration as boolean | undefined }) };
    case 'create_task': return { success: true, data: await this.tasks.create({ topicId: String(a.topicId), title: String(a.title), description: a.description as string | undefined, status: a.status as TaskStatus | undefined, resultSummary: a.resultSummary as string | undefined }) };
    case 'update_task': return { success: true, data: await this.tasks.update(String(a.taskId), { topicId: a.topicId as string | undefined, title: a.title as string | undefined, description: a.description as string | undefined, status: a.status as TaskStatus | undefined, resultSummary: a.resultSummary as string | undefined }) };
    case 'delete_task': return { success: true, data: await this.tasks.remove(String(a.taskId)) };
    default: return { success: false, error: `未知 Tool: ${call.name}` };
  } } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Tool 执行失败' }; } }
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
export class ApprovalService {
  async create(call: ToolCall) { const timestamp = now(); return prisma.approval.create({ data: { toolName: call.name, arguments: JSON.stringify(call.arguments), createdAt: timestamp, updatedAt: timestamp } }); }
  async get(approvalId: string) { return prisma.approval.findUnique({ where: { id: approvalId } }); }
  async list(status?: ApprovalStatus) { return prisma.approval.findMany({ where: status ? { status } : undefined, orderBy: { createdAt: 'asc' } }); }
  async update(approvalId: string, status: ApprovalStatus, result?: ToolResult) { return prisma.approval.update({ where: { id: approvalId }, data: { status, result: result ? JSON.stringify(result) : undefined, updatedAt: now() } }); }
  async claim(approvalId: string) { const claimed = await prisma.approval.updateMany({ where: { id: approvalId, status: 'pending' }, data: { status: 'approved', updatedAt: now() } }); return claimed.count === 1; }
  parse(value: { toolName: string; arguments: string }) { return { name: value.toolName, arguments: JSON.parse(value.arguments) as Record<string, unknown> }; }
}

export class ConversationService {
  async create() { const timestamp = now(); return prisma.conversation.create({ data: { createdAt: timestamp, updatedAt: timestamp } }); }
  async get(conversationId: string) { return prisma.conversation.findUnique({ where: { id: conversationId } }); }
  async addMessage(conversationId: string, role: 'user' | 'assistant' | 'tool' | 'system', content: string) { return prisma.message.create({ data: { conversationId, role, content, createdAt: now() } }); }
  async listMessages(conversationId: string) { return prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }); }
  async updateSummary(conversationId: string, summary: string) { return prisma.conversation.update({ where: { id: conversationId }, data: { summary, updatedAt: now() } }); }
}
