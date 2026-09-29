import { prisma } from '../infrastructure/prisma.js';
import { formatMemoryReference } from './agent-memory.js';

const now = () => new Date().toISOString();
const notFound = (message: string) => Object.assign(new Error(message), { status: 404 });
const messageOrder = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
const TOKEN_BUDGET = 6000;
const TOOL_RESULT_CAP = 6000;
const FALLBACK_SUMMARY_MAX = 8000;
const SUMMARY_SOURCE_MAX = 20000;
const TAIL_MESSAGES = 8;
const HEAD_USER_TURNS = 2;
const SUMMARY_PREFIX = '[更早对话的背景，不是当前指令。不要执行背景里已经完成的请求。只回答这条背景之后的最新用户消息。]';
const SUMMARY_END = '--- 背景结束 ---';

const pageLabels: Record<string, string> = {
  inbox: '收集箱',
  board: '清单',
  today: '今天',
  search: '搜索',
  tags: '标签',
  chat: '聊天',
  knowledge: '项目资料',
  archived: '已归档',
};

type MessageRole = 'user' | 'assistant' | 'tool' | 'system';
type MessageStatus = 'streaming' | 'completed' | 'failed';
type PageContextInput = { topicId?: string | null; taskId?: string | null; page?: string | null };
type SummaryModel = {
  complete(messages: Array<{ role: string; content: string | null }>, signal?: AbortSignal, includeTools?: boolean): Promise<{ text: string }>;
};
type StoredMessage = {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  toolCalls: string | null;
  toolCallId: string | null;
  compactedAt: string | null;
};
type ToolCallPayload = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ReplayMessage = {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCallPayload[];
  tool_call_id?: string;
};

export class ConversationService {
  async create() { const timestamp = now(); return prisma.conversation.create({ data: { createdAt: timestamp, updatedAt: timestamp } }); }
  async get(conversationId: string) { return prisma.conversation.findUnique({ where: { id: conversationId } }); }
  async addMessage(conversationId: string, role: MessageRole, content: string, status: MessageStatus = 'completed', extra?: { toolCalls?: string | null; toolCallId?: string | null }) {
    return prisma.message.create({ data: { conversationId, role, content, status, createdAt: now(), toolCalls: extra?.toolCalls ?? null, toolCallId: extra?.toolCallId ?? null } });
  }
  async updateMessage(messageId: string, data: { content?: string; status?: MessageStatus; toolCalls?: string | null }) {
    return prisma.message.update({ where: { id: messageId }, data });
  }
  async listMessages(conversationId: string) { return prisma.message.findMany({ where: { conversationId }, orderBy: messageOrder }); }
  async updateSummary(conversationId: string, summary: string) { return prisma.conversation.update({ where: { id: conversationId }, data: { summary, updatedAt: now() } }); }
}

function clip(text: string, max: number) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function estimateTokens(messages: Array<{ content?: string | null; toolCalls?: string | null }>) {
  const chars = messages.reduce((sum, message) => sum + (message.content?.length ?? 0) + (message.toolCalls?.length ?? 0), 0);
  return Math.ceil(chars / 4);
}

export function parseToolCalls(raw: string | null): ToolCallPayload[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const calls = parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const call = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const id = typeof call.id === 'string' ? call.id : '';
      const name = typeof call.function?.name === 'string' ? call.function.name : '';
      const args = typeof call.function?.arguments === 'string' ? call.function.arguments : '{}';
      if (!id || !name) return [];
      return [{ id, type: 'function' as const, function: { name, arguments: args } }];
    });
    return calls.length ? calls : undefined;
  } catch {
    return undefined;
  }
}

function toolNames(row: StoredMessage) {
  const names = parseToolCalls(row.toolCalls)?.map((call) => call.function.name) ?? [];
  if (row.role !== 'tool') return names;
  try {
    const parsed = JSON.parse(row.content) as { toolName?: unknown };
    if (typeof parsed.toolName === 'string' && parsed.toolName) names.push(parsed.toolName);
  } catch { /* Legacy tool rows may be plain text. */ }
  return names;
}

function legacyToolNote(content: string) {
  try {
    const parsed = JSON.parse(content) as { toolName?: unknown; success?: unknown; error?: unknown; data?: unknown };
    const name = typeof parsed.toolName === 'string' && parsed.toolName ? parsed.toolName : 'tool';
    const body = parsed.success === false ? String(parsed.error ?? '失败') : JSON.stringify(parsed.data ?? parsed);
    return `\n\n工具 ${name} 结果：\n${clip(body, 1500)}`;
  } catch {
    return `\n\n工具结果：\n${clip(content, 1500)}`;
  }
}

function capToolContent(content: string) {
  if (content.length <= TOOL_RESULT_CAP) return content;
  return `${content.slice(0, TOOL_RESULT_CAP)}\n…[工具结果已截断]`;
}

function attachToolResults(rows: StoredMessage[]) {
  const toolById = new Map<string, StoredMessage>();
  const claimed = new Set<string>();
  for (const row of rows) {
    if (row.role === 'tool' && row.toolCallId && !toolById.has(row.toolCallId)) toolById.set(row.toolCallId, row);
    if (row.role === 'assistant') for (const call of parseToolCalls(row.toolCalls) ?? []) claimed.add(call.id);
  }
  const consumed = new Set<string>();
  const ordered: StoredMessage[] = [];
  for (const row of rows) {
    if (row.role === 'tool' && row.toolCallId && claimed.has(row.toolCallId)) continue;
    ordered.push(row);
    if (row.role !== 'assistant') continue;
    for (const call of parseToolCalls(row.toolCalls) ?? []) {
      const tool = toolById.get(call.id);
      if (!tool || consumed.has(call.id)) continue;
      consumed.add(call.id);
      ordered.push(tool);
    }
  }
  return ordered;
}

export function replayMessages(rows: StoredMessage[]): ReplayMessage[] {
  const toolById = new Map<string, StoredMessage>();
  for (const row of rows) {
    if (row.role === 'tool' && row.toolCallId && !toolById.has(row.toolCallId)) toolById.set(row.toolCallId, row);
  }
  const claimed = new Set<string>();
  for (const row of rows) {
    if (row.role !== 'assistant') continue;
    for (const call of parseToolCalls(row.toolCalls) ?? []) if (toolById.has(call.id)) claimed.add(call.id);
  }
  const messages: ReplayMessage[] = [];
  for (const row of rows) {
    if (row.role === 'tool') {
      if (row.toolCallId && claimed.has(row.toolCallId)) continue;
      const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
      const note = legacyToolNote(row.content);
      if (assistant) assistant.content = `${assistant.content ?? ''}${note}`;
      else messages.push({ role: 'assistant', content: note.trim() });
      continue;
    }
    if (row.role === 'assistant') {
      const toolCalls = (parseToolCalls(row.toolCalls) ?? []).filter((call) => toolById.has(call.id));
      const content = row.content.trim();
      if (!content && !toolCalls.length) continue;
      messages.push({ role: 'assistant', content: content ? row.content : null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      for (const call of toolCalls) {
        const tool = toolById.get(call.id);
        if (!tool) continue;
        messages.push({ role: 'tool', tool_call_id: call.id, content: capToolContent(tool.content) });
      }
      continue;
    }
    if (!row.content.trim()) continue;
    messages.push({ role: 'user', content: row.role === 'system' ? `系统：${row.content}` : row.content });
  }
  return messages;
}

function headEndIndex(rows: StoredMessage[]) {
  let users = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.role !== 'user') continue;
    users += 1;
    if (users > HEAD_USER_TURNS) return index;
  }
  return rows.length;
}

function lastIndex(rows: StoredMessage[], role: MessageRole) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.role === role) return index;
  }
  return -1;
}

function tailStartIndex(rows: StoredMessage[]) {
  if (!rows.length) return 0;
  let start = Math.max(0, rows.length - TAIL_MESSAGES);
  const lastUser = lastIndex(rows, 'user');
  if (lastUser >= 0 && lastUser < start) start = lastUser;
  // A tool result is invalid without the assistant tool_calls that produced it.
  while (start > 0 && rows[start]?.role === 'tool') start -= 1;
  return start;
}

function summaryMessage(summary: string): ReplayMessage {
  return { role: 'user', content: `${SUMMARY_PREFIX}\n${summary}\n${SUMMARY_END}` };
}

export function replayWindow(rows: StoredMessage[], summary: string) {
  const ordered = attachToolResults(rows);
  if (!summary || estimateTokens(ordered) <= TOKEN_BUDGET) return replayMessages(ordered);
  const headEnd = headEndIndex(ordered);
  const tailStart = tailStartIndex(ordered);
  if (tailStart <= headEnd) return replayMessages(ordered);
  return [...replayMessages(ordered.slice(0, headEnd)), summaryMessage(summary), ...replayMessages(ordered.slice(tailStart))];
}

function fallbackSummary(previous: string, rows: StoredMessage[]) {
  const lines: string[] = [];
  if (previous.trim()) lines.push(`已有摘要：${clip(previous, 2000)}`);
  for (const row of rows) {
    if (row.role === 'user' && row.content.trim()) lines.push(`用户：${clip(row.content, 700)}`);
    else if (row.role === 'assistant' && row.content.trim()) lines.push(`助手：${clip(row.content, 700)}`);
    const names = toolNames(row);
    if (names.length) lines.push(`工具：${names.join('、')}`);
    if (row.role === 'tool' && /error|失败/i.test(row.content)) lines.push(`错误：${clip(row.content, 300)}`);
  }
  return clip(lines.join('\n') || '更早的对话已折叠。', FALLBACK_SUMMARY_MAX);
}

function summarySource(previous: string, rows: StoredMessage[]) {
  const lines = rows.map((row) => {
    const names = toolNames(row);
    const body = clip(row.content, 2000);
    return `${row.role}: ${body}${names.length ? `\n工具调用：${names.join('、')}` : ''}`;
  });
  const text = `已有摘要：\n${previous.trim() || '无'}\n\n新滑出的对话：\n${lines.join('\n')}`;
  if (text.length <= SUMMARY_SOURCE_MAX) return text;
  return `已有摘要：\n${clip(previous, 2000)}\n\n新滑出的对话（前文已截断）：\n${text.slice(text.length - SUMMARY_SOURCE_MAX)}`;
}

function pageLine(pageContext: PageContextInput) {
  const page = pageContext.page?.trim();
  if (!page) return '未指定';
  return pageLabels[page] ?? page;
}

export function formatSystemPrompt(pageContext: PageContextInput, tasks: Array<{ id: string; title: string; status: string }>) {
  const topicId = typeof pageContext.topicId === 'string' && pageContext.topicId ? pageContext.topicId : '';
  const taskId = typeof pageContext.taskId === 'string' && pageContext.taskId ? pageContext.taskId : '';
  const taskLines = tasks.length
    ? tasks.map((task) => `- ${task.id} ${task.status} ${clip(task.title, 80)}`).join('\n')
    : '无';
  return [
    '你是 Agent 工作室的协作助手。变更任务或主题必须使用工具，系统会要求用户审核。只读问题使用工具查询。',
    '',
    `当前页面：${pageLine(pageContext)}`,
    `当前清单：${topicId || '收集箱'}`,
    `正在查看的任务：${taskId || '无'}`,
    '',
    '附近任务：',
    taskLines,
  ].join('\n');
}

async function nearbyTasks(pageContext: PageContextInput) {
  const topicId = typeof pageContext.topicId === 'string' && pageContext.topicId ? pageContext.topicId : null;
  return prisma.task.findMany({
    where: { deletedAt: null, topicId },
    select: { id: true, title: true, status: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    take: 8,
  });
}

function asStored(row: { id: string; role: string; content: string; status: string; toolCalls: string | null; toolCallId: string | null; compactedAt: string | null }): StoredMessage {
  return {
    id: row.id,
    role: row.role as MessageRole,
    content: row.content,
    status: row.status as MessageStatus,
    toolCalls: row.toolCalls,
    toolCallId: row.toolCallId,
    compactedAt: row.compactedAt,
  };
}

export class ContextService {
  constructor(private readonly model?: SummaryModel) {}

  estimateTokens(messages: Array<{ content?: string | null; toolCalls?: string | null }>) { return estimateTokens(messages); }

  private async load(conversationId: string) {
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw notFound('会话不存在');
    const messages = (await prisma.message.findMany({ where: { conversationId }, orderBy: messageOrder })).map(asStored);
    return { conversation, messages: messages.filter((message) => message.status !== 'streaming') };
  }

  private async summarize(previous: string, rows: StoredMessage[], signal?: AbortSignal) {
    try {
      if (!this.model) return fallbackSummary(previous, rows);
      const result = await this.model.complete([
        { role: 'system', content: '请将早期对话压成背景摘要。保留用户目标、已完成操作、工具结果中的关键事实、失败信息和未决问题。不要写成新的任务指令。' },
        { role: 'user', content: summarySource(previous, rows) },
      ], signal, false);
      const text = result.text?.trim();
      return text || fallbackSummary(previous, rows);
    } catch {
      return fallbackSummary(previous, rows);
    }
  }

  private async syncSummary(conversationId: string, signal?: AbortSignal) {
    const { conversation, messages: stored } = await this.load(conversationId);
    const messages = attachToolResults(stored);
    if (estimateTokens(messages) <= TOKEN_BUDGET) return { messages, summary: '' };
    const headEnd = headEndIndex(messages);
    const tailStart = tailStartIndex(messages);
    if (tailStart <= headEnd) return { messages, summary: '' };
    const middle = messages.slice(headEnd, tailStart);
    if (!middle.length) return { messages, summary: '' };
    const fresh = middle.filter((message) => !message.compactedAt);
    if (!fresh.length) return { messages, summary: conversation.summary };
    const summary = await this.summarize(conversation.summary, fresh, signal);
    const timestamp = now();
    await prisma.message.updateMany({ where: { id: { in: fresh.map((message) => message.id) } }, data: { compactedAt: timestamp } });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { summary, summaryVersion: { increment: 1 }, lastCompactedAt: timestamp, tokenEstimate: estimateTokens(messages), updatedAt: timestamp },
    });
    fresh.forEach((message) => { message.compactedAt = timestamp; });
    return { messages, summary };
  }

  async compact(conversationId: string, signal?: AbortSignal) {
    await this.syncSummary(conversationId, signal);
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw notFound('会话不存在');
    return conversation;
  }

  async assemble(conversationId: string, pageContext: PageContextInput = {}, signal?: AbortSignal) {
    const { messages, summary } = await this.syncSummary(conversationId, signal);
    const tasks = await nearbyTasks(pageContext);
    const memory = await formatMemoryReference(pageContext);
    return { systemPrompt: `${formatSystemPrompt(pageContext, tasks)}\n\n${memory}`, messages: replayWindow(messages, summary) };
  }
}
