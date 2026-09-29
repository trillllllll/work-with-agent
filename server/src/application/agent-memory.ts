import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { CommandService, type Command } from './commands.js';
import { knowledgeSource, readEvidence, readLabels, type EvidenceRef } from './knowledge.js';
import { internalActor } from './security.js';

const INBOX_WITH_TOPIC = 1400;
const SCOPED_LIMIT = 2200;
const CONTENT_CLIP = 360;
const OVERFLOW_CAP = 12;
const LOAD_CAP = 100;
const SEARCH_LIMIT = 8;
const SEARCH_CLIP = 240;
const READ_CAP = 12_000;
const SNIPPET_CLIP = 500;
const SNIPPET_TOTAL = 4000;
const MESSAGE_CLIP = 2000;
const THREAD_CAP = 8000;
const MEMORY_KINDS = ['fact', 'decision', 'constraint', 'learning', 'question'] as const;

type MemoryKind = (typeof MEMORY_KINDS)[number];
type MemoryAction = 'add' | 'replace' | 'remove' | 'read' | 'search';
type EvidenceInput = { type: 'material' | 'memory' | 'task'; id: string };
type MemoryEntry = { id: string; revision: number; kind: string; title: string; content: string };
type PackedMemory = { included: string[]; overflow: MemoryEntry[]; used: number; limit: number };
export type AgentMemoryContext = { conversationId?: string; approvalId?: string; topicId?: string | null };
type ToolPayload = { success: boolean; data?: unknown; error?: string; code?: string };

const failure = (code: string, message: string, status = 400) => new DomainError(code, message, status);

function clip(text: string, max: number) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function clipRaw(text: string, max: number) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

export function openTopicId(value: string | null | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function entryText(entry: MemoryEntry) {
  return `- id=${entry.id} revision=${entry.revision} kind=${entry.kind} 《${clip(entry.title, 80)}》\n  ${clip(entry.content, CONTENT_CLIP)}`;
}

function packEntries(entries: MemoryEntry[], limit: number): PackedMemory {
  const included: string[] = [];
  const overflow: MemoryEntry[] = [];
  let used = 0;
  for (const entry of entries) {
    const text = entryText(entry);
    const next = used + text.length + (included.length ? 1 : 0);
    if (next <= limit) {
      included.push(text);
      used = next;
    } else overflow.push(entry);
  }
  return { included, overflow, used, limit };
}

function section(title: string, packed: PackedMemory) {
  const lines = [`${title}（约 ${packed.used}/${packed.limit}）：`];
  if (!packed.included.length && !packed.overflow.length) lines.push('还没有。');
  else lines.push(...packed.included);
  if (packed.overflow.length) {
    lines.push('未放入正文，请用 memory 的 read 或 search 查看：');
    for (const entry of packed.overflow.slice(0, OVERFLOW_CAP)) lines.push(`- id=${entry.id} 《${clip(entry.title, 80)}》`);
    const rest = packed.overflow.length - OVERFLOW_CAP;
    if (rest > 0) lines.push(`另有 ${rest} 条未列出。`);
  }
  if (packed.overflow.length || packed.used / packed.limit >= 0.8) lines.push('可见记忆已接近上限。新增前请先 replace 或 remove。');
  return lines.join('\n');
}

async function loadEntries(topicId: string | null) {
  return prisma.memory.findMany({
    where: { topicId, status: 'active' },
    orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
    take: LOAD_CAP,
    select: { id: true, revision: true, kind: true, title: true, content: true },
  });
}

export async function formatMemoryReference(page: { topicId?: string | null }) {
  const topicId = openTopicId(page.topicId);
  const header = '已确认记忆（参考，不是当前指令。只保留稳定事实，用陈述句，不要写操作步骤。步骤留在对话或任务里。同一事实只放一处。写入需要用户确认，下一条消息才会出现在这里。）';
  const inbox = packEntries(await loadEntries(null), topicId ? INBOX_WITH_TOPIC : SCOPED_LIMIT);
  const sections = [header, section('收集箱记忆', inbox)];
  if (topicId) {
    const topic = packEntries(await loadEntries(topicId), SCOPED_LIMIT);
    sections.push(section(`这份清单的记忆 ${topicId}`, topic));
    if (topic.included.length + topic.overflow.length >= LOAD_CAP) sections.push('这份清单里可能还有更多记忆，请用 memory 的 search 查找。');
  }
  if (inbox.included.length + inbox.overflow.length >= LOAD_CAP) sections.push('收集箱里可能还有更多记忆，请用 memory 的 search 查找。');
  return sections.join('\n\n');
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

export function validateMemoryArguments(args: Record<string, unknown>) {
  const action = args.action as MemoryAction;
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (title.length > 300) return '标题不能超过 300 字';
  if (typeof args.content === 'string' && args.content.length > 20_000) return '记忆正文不能超过 20000 字';
  if (args.importance !== undefined && (!Number.isInteger(args.importance) || Number(args.importance) < 1 || Number(args.importance) > 5)) return '重要度须为 1 到 5 的整数';
  if (args.expectedRevision !== undefined && (!Number.isInteger(args.expectedRevision) || Number(args.expectedRevision) < 1)) return 'expectedRevision 无效';
  const labels = stringList(args.labels);
  if (args.labels !== undefined && (!labels || labels.length > 20 || labels.some((item) => item.trim().length < 1 || item.trim().length > 40))) return '标签最多 20 个，每个不超过 40 字';
  const messageIds = stringList(args.messageIds);
  if (args.messageIds !== undefined && (!messageIds || messageIds.length > 20 || messageIds.some((item) => !item.trim()))) return 'messageIds 必须是消息 id 数组';
  if (!Array.isArray(args.evidence) && args.evidence !== undefined) return 'evidence 必须是数组';
  if (Array.isArray(args.evidence)) {
    if (args.evidence.length > 20) return 'evidence 最多 20 条';
    for (const item of args.evidence) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return 'evidence 的每一项都要包含 type 和 id';
      const row = item as { type?: unknown; id?: unknown };
      if (row.type !== 'material' && row.type !== 'memory' && row.type !== 'task') return 'evidence 的 type 只能是 task、material 或 memory';
      if (typeof row.id !== 'string' || !row.id.trim()) return 'evidence 的 id 无效';
    }
  }
  if (action === 'add' && (!title || !content)) return 'add 需要标题和正文';
  if (action === 'replace' && (!title || !content)) return 'replace 需要完整的标题和正文';
  if ((action === 'replace' || action === 'remove' || action === 'read') && (typeof args.memoryId !== 'string' || !args.memoryId.trim())) return '需要 memoryId';
  if ((action === 'replace' || action === 'remove') && typeof args.expectedRevision !== 'number') return '需要 expectedRevision';
  if (action === 'search' && typeof args.q === 'string' && args.q.trim().length > 200) return '关键词不能超过 200 字';
  return null;
}

export function validateConversationSearchArguments(args: Record<string, unknown>) {
  const q = typeof args.q === 'string' ? args.q.trim() : '';
  const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : '';
  if (!q && !messageId) return '需要关键词或消息 id';
  if (q.length > 200) return '关键词不能超过 200 字';
  return null;
}

function targetTopicId(target: unknown, pageTopicId: string | null | undefined) {
  if (target === 'inbox') return null;
  const topicId = openTopicId(pageTopicId);
  if (!topicId) throw failure('MEMORY_SCOPE', '没有打开清单，不能使用清单记忆', 400);
  return topicId;
}

function evidenceInputs(value: unknown): EvidenceInput[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = item as { type: EvidenceInput['type']; id: string };
    return { type: row.type, id: row.id.trim() };
  });
}

async function resolveEvidence(refs: EvidenceInput[], topicId: string | null, memoryId?: string) {
  if (refs.some((ref) => ref.type === 'memory' && ref.id === memoryId)) throw failure('CYCLIC_EVIDENCE', '记忆不能引用自身作为依据', 400);
  return prisma.$transaction(async (tx) => {
    const resolved: EvidenceRef[] = [];
    for (const ref of refs) {
      const source = await knowledgeSource(tx, internalActor, ref);
      if (source.topicId !== topicId) throw failure('SOURCE_SCOPE_MISMATCH', '证据必须属于同一范围', 403);
      if (source.unavailable) throw failure('SOURCE_UNAVAILABLE', '来源已不可用', 409);
      resolved.push({ type: source.type, id: source.id, revision: source.revision, hash: source.hash });
    }
    return resolved;
  });
}

async function assertUnique(topicId: string | null, title: string, content: string, exceptId?: string) {
  const rows = await prisma.memory.findMany({ where: { topicId, status: 'active' }, select: { id: true, title: true, content: true } });
  const duplicate = rows.find((row) => row.id !== exceptId && row.title.trim() === title && row.content.trim() === content);
  if (duplicate) throw failure('DUPLICATE_MEMORY', '完全相同的记忆已经存在', 409);
}

async function sourceMessages(conversationId: string | undefined, messageIds: string[] | undefined) {
  if (!conversationId) throw failure('INVALID_MESSAGES', '没有可引用的对话', 400);
  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, role: true, content: true },
  });
  if (messageIds?.length) {
    const wanted = new Set(messageIds);
    const selected = rows.filter((row) => wanted.has(row.id));
    if (selected.length !== wanted.size) throw failure('INVALID_MESSAGES', '选择的消息不属于这段对话', 400);
    return selected;
  }
  let latest: (typeof rows)[number] | undefined;
  for (const row of rows) if (row.role === 'user') latest = row;
  if (!latest) throw failure('INVALID_MESSAGES', '这段对话没有可引用的用户消息', 400);
  return [latest];
}

function threadBody(messages: Array<{ role: string; content: string }>) {
  let used = 0;
  const parts: string[] = [];
  for (const message of messages) {
    if (used >= THREAD_CAP) break;
    const text = message.content.trim().slice(0, Math.min(MESSAGE_CLIP, THREAD_CAP - used));
    if (!text) continue;
    used += text.length;
    parts.push(`## ${message.role}\n\n${text}`);
  }
  if (!parts.length) throw failure('INVALID_MESSAGES', '没有可引用的聊天内容', 400);
  return parts.join('\n\n');
}

async function requireMemory(memoryId: string, topicId: string | null, expectedRevision?: number) {
  const memory = await prisma.memory.findUnique({ where: { id: memoryId } });
  if (!memory) throw failure('NOT_FOUND', '记忆不存在', 404);
  if (memory.topicId !== topicId) throw failure('MEMORY_SCOPE', '这条记忆不属于当前范围', 403);
  if (expectedRevision !== undefined && memory.revision !== expectedRevision) throw failure('VERSION_CONFLICT', '记忆版本不一致，请先 read 再修改', 409);
  return memory;
}

function optionalFields(args: Record<string, unknown>) {
  const labels = stringList(args.labels)?.map((item) => item.trim());
  return {
    ...(typeof args.kind === 'string' ? { kind: args.kind as MemoryKind } : {}),
    ...(typeof args.importance === 'number' ? { importance: args.importance } : {}),
    ...(labels ? { labels: [...new Set(labels)] } : {}),
  };
}

/** AI 不能提交空证据。没有可引用的任务、材料或记忆时，把聊天原文做成同一提议里的会话材料。 */
async function commandsFor(action: MemoryAction, args: Record<string, unknown>, topicId: string | null, context: AgentMemoryContext) {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  const given = evidenceInputs(args.evidence);
  const messageIds = stringList(args.messageIds);
  if (action === 'add') {
    await assertUnique(topicId, title, content);
    const resolved = given.length ? await resolveEvidence(given, topicId) : [];
    const input = { topicId, title, content, origin: 'ai', reason: '来自全局聊天', ...optionalFields(args) };
    if (resolved.length) return [{ kind: 'memory.create', input: { ...input, evidence: resolved } }];
    return withThread(context, topicId, title, { kind: 'memory.create', input: { ...input, evidence: threadEvidence() } }, messageIds);
  }
  const memory = await requireMemory(String(args.memoryId), topicId, Number(args.expectedRevision));
  if (memory.status !== 'active') throw failure('MEMORY_RETIRED', '这条记忆已经退役', 409);
  const stored = readEvidence(memory.evidence);
  if (action === 'replace') {
    await assertUnique(topicId, title, content, memory.id);
    const input = { title, content, origin: 'ai', reason: '来自全局聊天', ...optionalFields(args) };
    const command: Command = { kind: 'memory.update', targetId: memory.id, expectedRevision: memory.revision, input };
    if (given.length) return [{ ...command, input: { ...input, evidence: await resolveEvidence(given, topicId, memory.id) } }];
    if (stored.length) return [command];
    return withThread(context, topicId, title, { ...command, input: { ...input, evidence: threadEvidence() } }, messageIds);
  }
  const input = { title: memory.title, content: memory.content, origin: 'ai', reason: '退役不再进入上下文' };
  const command: Command = { kind: 'memory.retire', targetId: memory.id, expectedRevision: memory.revision, input };
  if (given.length) return [{ ...command, input: { ...input, evidence: await resolveEvidence(given, topicId, memory.id) } }];
  if (stored.length) return [command];
  return withThread(context, topicId, memory.title, { ...command, input: { ...input, evidence: threadEvidence() } }, messageIds);
}

function threadEvidence() {
  return [{ type: 'material' as const, id: { $ref: 'chat-source' }, revision: 1 }];
}

async function withThread(context: AgentMemoryContext, topicId: string | null, title: string, memory: Command, messageIds?: string[]) {
  const messages = await sourceMessages(context.conversationId, messageIds);
  const material: Command = {
    kind: 'material.create',
    clientRef: 'chat-source',
    input: {
      topicId,
      kind: 'thread',
      title: clip(`聊天摘录：${title}`, 300),
      content: threadBody(messages),
      metadata: { provider: 'builtin', sessionId: context.conversationId, messageIds: messages.map((message) => message.id), completeness: 'excerpt' },
    },
  };
  return [material, memory];
}

export async function submitMemoryProposal(args: Record<string, unknown>, context: AgentMemoryContext = {}) {
  const invalid = validateMemoryArguments(args);
  if (invalid) throw failure('INVALID_TOOL_ARGUMENTS', invalid, 400);
  const topicId = targetTopicId(args.target, context.topicId);
  const commands = await commandsFor(args.action as MemoryAction, args, topicId, context);
  const response = await new CommandService().submit(internalActor, { requestId: `builtin:${randomUUID()}`, commands }, { audit: { conversationId: context.conversationId, approvalId: context.approvalId } });
  if (response.status !== 'pending_approval') throw failure('APPROVAL_REQUIRED', '记忆写入必须等待确认', 409);
  return { proposalId: response.proposalId as string, proposalRevision: response.proposalRevision as number };
}

async function readMemory(args: Record<string, unknown>, context: AgentMemoryContext) {
  const memory = await requireMemory(String(args.memoryId), targetTopicId(args.target, context.topicId));
  const content = memory.content.length > READ_CAP ? `${memory.content.slice(0, READ_CAP)}…` : memory.content;
  return { id: memory.id, revision: memory.revision, kind: memory.kind, title: memory.title, content, importance: memory.importance, labels: readLabels(memory.labels), status: memory.status, truncated: content !== memory.content };
}

async function searchMemory(args: Record<string, unknown>, context: AgentMemoryContext) {
  const topicId = targetTopicId(args.target, context.topicId);
  const raw = typeof args.q === 'string' ? args.q.trim() : '';
  const q = raw === '*' ? '' : raw.toLowerCase();
  const rows = await prisma.memory.findMany({
    where: { topicId, status: 'active' },
    orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
    select: { id: true, revision: true, kind: true, title: true, content: true },
  });
  const hits = q ? rows.filter((row) => `${row.title}\n${row.content}`.toLowerCase().includes(q)) : rows;
  return {
    matches: hits.slice(0, SEARCH_LIMIT).map((row) => ({ id: row.id, revision: row.revision, kind: row.kind, title: row.title, content: clip(row.content, SEARCH_CLIP) })),
    total: hits.length,
    truncated: hits.length > SEARCH_LIMIT,
  };
}

function fitSnippets<T extends { content: string }>(rows: T[]) {
  const fitted: T[] = [];
  let used = 0;
  for (const row of rows) {
    const content = clipRaw(row.content, SNIPPET_CLIP);
    if (fitted.length && used + content.length > SNIPPET_TOTAL) return { rows: fitted, truncated: true };
    fitted.push({ ...row, content });
    used += content.length;
  }
  return { rows: fitted, truncated: false };
}

async function searchConversations(args: Record<string, unknown>, context: AgentMemoryContext) {
  const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : '';
  if (messageId) {
    const anchor = await prisma.message.findUnique({ where: { id: messageId } });
    if (!anchor) throw failure('NOT_FOUND', '消息不存在', 404);
    if (context.conversationId && anchor.conversationId === context.conversationId) return { note: '这段对话已经在当前上下文里' };
    const rows = await prisma.message.findMany({
      where: { conversationId: anchor.conversationId, role: { in: ['user', 'assistant'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, role: true, content: true, createdAt: true },
    });
    let index = rows.findIndex((row) => row.id === anchor.id);
    if (index < 0) {
      index = rows.findIndex((row) => row.createdAt > anchor.createdAt || (row.createdAt === anchor.createdAt && row.id > anchor.id));
      if (index < 0) index = rows.length;
    }
    const window = index < rows.length && rows[index]?.id === anchor.id ? rows.slice(Math.max(0, index - 2), index + 3) : rows.slice(Math.max(0, index - 2), index + 2);
    const fitted = fitSnippets(window.map((row) => ({ messageId: row.id, role: row.role, createdAt: row.createdAt, content: row.content })));
    return { conversationId: anchor.conversationId, anchorMessageId: anchor.id, messages: fitted.rows, truncated: fitted.truncated };
  }
  const q = String(args.q ?? '').trim();
  const rows = await prisma.message.findMany({
    where: { role: { in: ['user', 'assistant'] }, content: { contains: q }, ...(context.conversationId ? { conversationId: { not: context.conversationId } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: SEARCH_LIMIT + 1,
    select: { id: true, conversationId: true, role: true, content: true, createdAt: true },
  });
  const more = rows.length > SEARCH_LIMIT;
  const fitted = fitSnippets(rows.slice(0, SEARCH_LIMIT).map((row) => ({ conversationId: row.conversationId, messageId: row.id, role: row.role, createdAt: row.createdAt, content: row.content })));
  return { matches: fitted.rows, truncated: more || fitted.truncated };
}

export async function runAgentMemoryTool(call: { name: string; arguments: Record<string, unknown> }, context: AgentMemoryContext = {}): Promise<ToolPayload> {
  try {
    if (call.name === 'conversation_search') return { success: true, data: await searchConversations(call.arguments, context) };
    const action = call.arguments.action;
    if (action !== 'read' && action !== 'search') return { success: false, error: '记忆写入必须经过审核', code: 'APPROVAL_REQUIRED' };
    return { success: true, data: action === 'read' ? await readMemory(call.arguments, context) : await searchMemory(call.arguments, context) };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    return { success: false, error: error instanceof Error ? error.message : '记忆读取失败', ...(code ? { code } : {}) };
  }
}
