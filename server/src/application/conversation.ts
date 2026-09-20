import { prisma } from '../infrastructure/prisma.js';
import { TaskService } from './workspace.js';

const now = () => new Date().toISOString();
const notFound = (message: string) => Object.assign(new Error(message), { status: 404 });

export class ConversationService {
  async create() { const timestamp = now(); return prisma.conversation.create({ data: { createdAt: timestamp, updatedAt: timestamp } }); }
  async get(conversationId: string) { return prisma.conversation.findUnique({ where: { id: conversationId } }); }
  async addMessage(conversationId: string, role: 'user' | 'assistant' | 'tool' | 'system', content: string, status: 'streaming' | 'completed' | 'failed' = 'completed') { return prisma.message.create({ data: { conversationId, role, content, status, createdAt: now() } }); }
  async updateMessage(messageId: string, data: { content?: string; status?: 'streaming' | 'completed' | 'failed' }) { return prisma.message.update({ where: { id: messageId }, data }); }
  async listMessages(conversationId: string) { return prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }); }
  async updateSummary(conversationId: string, summary: string) { return prisma.conversation.update({ where: { id: conversationId }, data: { summary, updatedAt: now() } }); }
}

export class ContextService {
  constructor(private readonly model?: { complete(messages: any[], signal?: AbortSignal, includeTools?: boolean): Promise<{ text: string }> }) {}
  estimateTokens(messages: Array<{ content?: string | null }>) { return Math.ceil(messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0) / 4); }
  async compactIfNeeded(conversationId: string, signal?: AbortSignal) { const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } }); if (!conversation) throw notFound('会话不存在'); const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }); const old = messages.slice(0, -12); const estimate = this.estimateTokens(messages); if (estimate <= 6000 && messages.length <= 24 && old.filter((message) => !message.compactedAt).length <= 12) return conversation; return this.compact(conversationId, signal); }
  async buildWindow(conversationId: string, pageContext: unknown) { const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } }); if (!conversation) throw notFound('会话不存在'); const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }); const recentMessages = messages.slice(-12).filter((item) => item.role !== 'tool' && item.status !== 'streaming').map(({ role, content }) => ({ role, content })); const tasks = pageContext && typeof pageContext === 'object' && 'topicId' in pageContext ? await new TaskService().list((pageContext as any).topicId ?? undefined) : await new TaskService().list(); return { summary: conversation.summary, recentMessages, pageContext, recentTasks: tasks.slice(0, 8), estimatedTokens: this.estimateTokens(messages.slice(-12)) }; }
  async compact(conversationId: string, signal?: AbortSignal) { const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } }); if (!conversation) throw notFound('会话不存在'); const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }); const old = messages.slice(0, -12); if (!old.length) return conversation; let summary = conversation.summary; try { summary = this.model ? (await this.model.complete([{ role: 'system', content: '请将对话压缩为结构化摘要：目标、已完成工作、关键决定、未决问题、失败信息。' }, { role: 'user', content: old.map((m) => `${m.role}: ${m.content}`).join('\n') }], signal)).text : old.map((m) => `${m.role}: ${m.content}`).join('\n').slice(-6000); } catch { return conversation; } const ids = old.map((message) => message.id); await prisma.message.updateMany({ where: { id: { in: ids } }, data: { compactedAt: now() } }); return prisma.conversation.update({ where: { id: conversationId }, data: { summary, summaryVersion: { increment: 1 }, lastCompactedAt: now(), tokenEstimate: this.estimateTokens(messages.slice(-12)) } }); }
}
