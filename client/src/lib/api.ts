import { parseSseFrame, type Approval, type SseEvent, type ToolResult } from '../chat.js';

export type Topic = { id: string; name: string; description: string; isExploration: boolean; goal?: string; draftSummary?: string; finalSummary?: string; summaryStatus?: string; summaryUpdatedAt?: string | null };
export type Status = 'todo' | 'doing' | 'blocked' | 'done';
export type Task = { id: string; topicId: string; title: string; description: string; status: Status; resultSummary: string; deletedAt?: string | null };
export type TrashTask = Task & { deletedAt: string; topic?: { id: string; name: string } };
export type Settings = { baseUrl: string; model: string; apiKeyConfigured: boolean; apiKeyMasked: string | null };
export type ApprovalResponse = { result: ToolResult; assistantMessage?: string; summaryError?: string };
export type View = 'board' | 'chat' | 'topics' | 'settings' | 'trash' | 'changes';
export type ChangeRecord = { id: string; entityType: string; entityId: string; operation: string; beforeSnapshot?: string | null; afterSnapshot?: string | null; source: string; conversationId?: string | null; approvalId?: string | null; requestId?: string | null; reversalOf?: string | null; undoneAt?: string | null; createdAt: string };

export const statuses: { value: Status; label: string }[] = [{ value: 'todo', label: '待办' }, { value: 'doing', label: '进行中' }, { value: 'blocked', label: '已阻塞' }, { value: 'done', label: '已完成' }];
export const toolLabels: Record<string, string> = { create_task: '创建任务', update_task: '更新任务', delete_task: '删除任务', create_topic: '创建主题', update_topic: '更新主题' };
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${API_URL}${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await response.json().catch(() => ({ data: null, error: '响应格式错误' }));
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : '请求失败');
  return body.data;
}

export function parseApproval(item: any): Approval {
  let args: Record<string, unknown> = {};
  try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments ?? {}; } catch { /* Keep malformed legacy data visible as empty args. */ }
  return { approvalId: item.id, toolName: item.toolName, arguments: args, status: item.status };
}

export async function streamChat(body: unknown, onEvent: (event: SseEvent) => void) {
  const response = await fetch(`${API_URL}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(typeof payload?.error === 'string' ? payload.error : '聊天请求失败');
  }
  if (!response.body) throw new Error('聊天连接没有响应体');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (frame: string) => { const event = parseSseFrame(frame); if (event) onEvent(event); };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    frames.forEach(consume);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
}
