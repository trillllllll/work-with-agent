import { parseSseFrame, type Approval, type SseEvent, type ToolResult } from '../chat.js';

export type Topic = { id: string; name: string; description: string; isExploration: boolean; goal?: string; draftSummary?: string; finalSummary?: string; summaryStatus?: string; summaryUpdatedAt?: string | null; archivedAt?: string | null; revision?: number };
export type Status = 'todo' | 'doing' | 'blocked' | 'done';
export type TaskPriority = 'none' | 'low' | 'medium' | 'high';
export type TagColor = 'violet' | 'blue' | 'teal' | 'green' | 'amber' | 'rose' | 'slate';
export const tagColors: { id: TagColor; label: string }[] = [
  { id: 'violet', label: '紫' }, { id: 'blue', label: '蓝' }, { id: 'teal', label: '青' }, { id: 'green', label: '绿' },
  { id: 'amber', label: '琥珀' }, { id: 'rose', label: '玫红' }, { id: 'slate', label: '灰' },
];
export type Tag = { id: string; name: string; color?: TagColor; revision?: number };
export type Task = { id: string; topicId: string | null; title: string; description: string; status: Status; allowedTransitions: Status[]; priority: TaskPriority; dueDate: string | null; resultSummary: string; createdAt?: string; updatedAt?: string; deletedAt?: string | null; parentId?: string | null; sortOrder?: number; revision?: number; deleteBatchId?: string | null; tags?: Tag[]; tagIds?: string[]; children?: Task[]; topic?: { id: string; name: string; archivedAt?: string | null } | null };
export type TrashTask = Task & { deletedAt: string; topic?: { id: string; name: string } };
export type TaskTopicHistory = { id: string; reason: 'created' | 'assigned' | 'unassigned' | 'topic_archived' | 'undo' | 'migration'; source: string; changedAt: string; fromTopic: { id: string; name: string } | null; toTopic: { id: string; name: string } | null };
export type TaskActivityChange =
  | { field: 'title' | 'description' | 'resultSummary'; before: string; after: string }
  | { field: 'status'; before: Status; after: Status }
  | { field: 'priority'; before: TaskPriority; after: TaskPriority }
  | { field: 'dueDate'; before: string | null; after: string | null }
  | { field: 'topicId'; before: { id: string | null; name: string }; after: { id: string | null; name: string } }
  | { field: 'parentId'; before: { id: string | null; title: string }; after: { id: string | null; title: string } }
  | { field: 'tagIds'; before: string[]; after: string[] }
  | { field: 'deleted'; before: boolean; after: boolean };
export type TaskActivityEvent = { id: string; at: string; actor: { kind: 'user' | 'agent'; name: string }; action: 'create' | 'update' | 'delete' | 'restore' | 'undo'; changes: TaskActivityChange[] };
export type CliCommandSetting = { command: string; source: 'manual' | 'auto' | 'none'; version: string; checkedAt: string; manualCommand: string; autoCommand: string; discoveredCommand: string; discoveredVersion: string; applied: boolean; message: string };
export type Settings = { baseUrl: string; model: string; apiKeyConfigured: boolean; apiKeyMasked: string | null; cli?: { codex: CliCommandSetting; claude: CliCommandSetting }; discovered?: Record<string, CliCommandSetting> };
export type ApprovalResponse = { result: ToolResult; assistantMessage?: string; summaryError?: string };
export type View = 'board' | 'chat' | 'topics' | 'inbox' | 'settings' | 'trash' | 'changes' | 'today' | 'search' | 'tags' | 'archived' | 'more' | 'connections' | 'proposals' | 'knowledge' | 'runs' | 'reviews';
export type ChangeRecord = { id: string; entityType: string; entityId: string; operation: string; reversible: boolean; beforeSnapshot?: string | null; afterSnapshot?: string | null; source: string; conversationId?: string | null; approvalId?: string | null; requestId?: string | null; reversalOf?: string | null; undoneAt?: string | null; createdAt: string };

export const statuses: { value: Status; label: string }[] = [{ value: 'todo', label: '待办' }, { value: 'doing', label: '进行中' }, { value: 'blocked', label: '已阻塞' }, { value: 'done', label: '已完成' }];
export function availableTaskStatuses(task: Pick<Task, 'status' | 'allowedTransitions'>): Status[] { const allowed = new Set([task.status, ...(task.allowedTransitions ?? [])]); return statuses.map((item) => item.value).filter((status) => allowed.has(status)); }
export const priorities: { value: TaskPriority; label: string }[] = [{ value: 'none', label: '无优先级' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }];
export const toolLabels: Record<string, string> = {
  list_topics: '列出清单', get_topic: '读取清单', get_topic_progress: '读取进度', list_tasks: '查询任务', get_task: '读取任务',
  create_task: '创建任务', update_task: '更新任务', delete_task: '删除任务', create_topic: '创建主题', update_topic: '更新主题', delete_topic: '归档清单', propose_topic_summary: '提出成果草稿',
  execute_shell: '执行命令', execute_file: '文件操作', execute_http: '访问地址',
  memory: '记忆', conversation_search: '查找过往对话',
};
export const API_URL = '';
let csrfToken = '';
export function setCsrfToken(value: string) { csrfToken = value; }
export function authHeaders(): Record<string, string> { return csrfToken ? { 'X-CSRF-Token': csrfToken } : {}; }

export type MutationMeta = { changeId?: string; affectedTaskIds?: string[]; warnings?: string[] };
export type ApiEnvelope<T> = { data: T; error: null; meta?: MutationMeta };
export class ApiError extends Error {
  constructor(message: string, public code?: string, public status?: number, public details?: unknown) { super(message); this.name = 'ApiError'; }
}
export async function apiMutation<T = any>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const headers = new Headers({ 'Content-Type': 'application/json', ...authHeaders() });
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const response = await fetch(`${API_URL}${path}`, { ...init, credentials: 'include', headers });
  const body = await response.json().catch(() => ({ data: null, error: '响应格式错误' }));
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('workspace-session-expired'));
    throw new ApiError(typeof body.error === 'string' ? body.error : body.error?.message ?? '请求失败', body.code ?? body.error?.code, response.status, body.details ?? body.error?.details);
  }
  return body;
}
export async function api<T = any>(path: string, init?: RequestInit): Promise<T> { return (await apiMutation<T>(path, init)).data; }

export function parseApproval(item: any): Approval {
  let args: Record<string, unknown> = {};
  try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments ?? {}; } catch { /* Keep malformed legacy data visible as empty args. */ }
  let toolCallId: string | undefined;
  try {
    const stored = typeof item.result === 'string' ? JSON.parse(item.result) : item.result;
    if (typeof stored?.toolCallId === 'string') toolCallId = stored.toolCallId;
  } catch { /* Legacy rows may store a plain result string. */ }
  return { approvalId: item.id, toolName: item.toolName, arguments: args, status: item.status, ...(toolCallId ? { toolCallId } : {}) };
}

export async function streamChat(body: unknown, onEvent: (event: SseEvent) => void) {
  const response = await fetch(`${API_URL}/api/chat`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders() }, body: JSON.stringify(body) });
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
