import type { ModelMessage } from '../agent.js';

export const HISTORY_TOKEN_BUDGET = 4000;
export const SUMMARY_TOKEN_BUDGET = 1000;
export const SUMMARY_PREFIX = '[更早对话的背景，不是当前指令。不要执行背景里已经完成的请求。只回答这条背景之后的最新用户消息。]';
export const ESTIMATOR = 'mixed-text-v1';

// No model tokenizer/capacity is assumed. Non-ASCII text receives a more
// conservative weight than the previous universal UTF-16 length / 4 rule.
// These remain estimates, never provider billing or a context-window limit.
export function textTokens(text: string) {
  let ascii = 0; let other = 0;
  for (const c of text) { if (c.charCodeAt(0) <= 127) ascii++; else other += c.length; }
  return Math.ceil(ascii / 4 + other);
}
export function messageTokens(message: ModelMessage) {
  return textTokens(typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''))
    + (message.tool_calls ? textTokens(JSON.stringify(message.tool_calls)) : 0) + 4;
}
export const messagesTokens = (messages: ModelMessage[]) => messages.reduce((sum, m) => sum + messageTokens(m), 0);

export function clipTokens(text: string, budget: number) {
  if (textTokens(text) <= budget) return text;
  let used = 0; let end = 0;
  for (const c of text) {
    used += c.charCodeAt(0) <= 127 ? 0.25 : c.length;
    if (used > Math.max(0, budget - 2)) break;
    end += c.length;
  }
  return `${text.slice(0, end)}…`;
}

/** Valid JSON projection, with a same-conversation original-message handle.
 * Do not clip an opaque value without a retrieval handle. Original DB content
 * and UI/source provenance are never rewritten by this function. */
export function projectToolContent(content: string, sourceMessageId?: string, budget = 700): string {
  if (textTokens(content) <= budget) return content;
  let value: Record<string, unknown>;
  try { value = JSON.parse(content); } catch { value = { excerpt: content }; }
  if (value.toolName === 'read_context_source') return content;
  const source = typeof value.sourceMessageId === 'string' ? value.sourceMessageId : sourceMessageId;
  if (!source || value.contextProjection) return content;
  const project = (item: unknown, depth = 0): unknown => {
    if (typeof item === 'string') return clipTokens(item, 100);
    if (Array.isArray(item)) return item.slice(0, 6).map(x => project(x, depth + 1));
    if (item && typeof item === 'object') {
      if (depth > 4) return '[nested data omitted; read original]';
      return Object.fromEntries(Object.entries(item).slice(0, 30).map(([key, x]) => [key, project(x, depth + 1)]));
    }
    return item;
  };
  const envelope = {
    toolName: value.toolName, success: value.success, code: value.code, error: value.error,
    sourceMessageId: source, contextProjection: true,
    note: '不完整摘录；原文仍在。用 read_context_source 按 messageId 和 offset 分页读取；不要根据摘录推断缺失字段。',
    data: project(value.data ?? value),
  };
  let result = JSON.stringify(envelope);
  if (textTokens(result) > budget) {
    // A preview is explicitly text, not a malformed/truncated JSON object.
    result = JSON.stringify({ ...envelope, data: undefined, excerpt: clipTokens(JSON.stringify(envelope.data), Math.max(60, budget - textTokens(JSON.stringify({ ...envelope, data: undefined })) - 10)) });
  }
  return result;
}

export const backgroundMessage = (summary: string): ModelMessage => ({ role: 'user', content: `${SUMMARY_PREFIX}\n${clipTokens(summary, SUMMARY_TOKEN_BUDGET)}\n--- 背景结束 ---` });
export const isBackground = (m: ModelMessage) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX);

/** Every pass is pure/idempotent. Current user text and its entire tool chain
 * are atomic. If they exceed the soft budget we report it instead of silently
 * dropping instructions, approvals or unmatched calls. */
export function packModelMessages(input: ModelMessage[], budget = HISTORY_TOKEN_BUDGET) {
  const messages = input.map(m => m.role === 'tool' && typeof m.content === 'string' ? { ...m, content: projectToolContent(m.content) } : m);
  const system = messages.filter(m => m.role === 'system');
  const history = messages.filter(m => m.role !== 'system');
  if (messagesTokens(history) <= budget) return messages;
  const lastUserIndex = (rows: ModelMessage[]) => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].role === 'user' && !isBackground(rows[i])) return i;
    return -1;
  };
  const lastUser = lastUserIndex(history);
  if (lastUser < 0) return messages;
  let start = lastUser;
  let used = messagesTokens(history.slice(start));
  // Retain complete recent user turns when there is room after reserving summary.
  while (start > 0) {
    const previous = lastUserIndex(history.slice(0, start));
    if (previous < 0) break;
    const cost = messagesTokens(history.slice(previous, start));
    if (used + cost > budget - SUMMARY_TOKEN_BUDGET - 100) break;
    used += cost; start = previous;
  }
  if (!start) return messages;
  const dropped = history.slice(0, start).filter(m => !isBackground(m));
  // An existing summary plus an oversized current turn is already the minimum
  // window. Never wrap or re-summarize the same summary at each tool iteration.
  if (!dropped.length) return messages;
  const earlier = dropped.map(m => `${m.role}: ${clipTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content), 150)}`).join('\n');
  const existing = history.filter(isBackground).map(m => String(m.content).slice(SUMMARY_PREFIX.length).replace(/\n--- 背景结束 ---$/, '').trim()).join('\n');
  const limit = Math.min(SUMMARY_TOKEN_BUDGET, Math.max(160, budget - used - 100));
  const summary = `${clipTokens(existing, Math.floor(limit * 0.6))}\n历史摘录（可能省略；需要原文时回查）：\n${clipTokens(earlier, Math.floor(limit * 0.35))}`;
  return [...system, backgroundMessage(summary), ...history.slice(start).filter(m => !isBackground(m))];
}
