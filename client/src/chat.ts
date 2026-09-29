export type ChatMessage = {
  id?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  status?: 'streaming' | 'completed' | 'failed';
  toolCalls?: string | null;
  toolCallId?: string | null;
  tools?: ToolActivity[];
};

export type ToolActivityStatus = 'running' | 'done' | 'error' | 'pending' | 'rejected';

export type ToolActivity = {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  status: ToolActivityStatus;
  preview: string;
  result?: unknown;
  error?: string;
  approvalId?: string;
};

export type ToolGroup = { kind: 'run'; activities: ToolActivity[] } | { kind: 'call'; activity: ToolActivity };

export type Approval = {
  approvalId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status?: string;
  toolCallId?: string;
};

export type ToolResult = { success: boolean; data?: unknown; error?: string };

export type SseEvent = {
  type: string;
  conversationId?: string;
  messageId?: string;
  delta?: string;
  message?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  approvalId?: string;
  toolCallId?: string;
  result?: ToolResult;
  code?: string;
};

const READ_ONLY_TOOLS = new Set(['list_topics', 'get_topic', 'get_topic_progress', 'list_tasks', 'get_task', 'conversation_search']);
const PREVIEW_MAX = 80;

export function isReadOnlyTool(name: string, args?: Record<string, unknown>) {
  if (name === 'memory') return args?.action === 'read' || args?.action === 'search';
  return READ_ONLY_TOOLS.has(name);
}

function clip(text: string, max = PREVIEW_MAX) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function textField(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === 'string' && field.trim()) return field.trim();
  }
  return '';
}

function targetPreview(name: string, args: Record<string, unknown>) {
  if (name === 'execute_shell') return clip(typeof args.command === 'string' ? args.command : '');
  if (name === 'execute_file') return clip(typeof args.path === 'string' ? args.path : '');
  if (name === 'execute_http') return clip(typeof args.url === 'string' ? args.url : '');
  const title = textField(args, ['title', 'name']);
  if (title) return clip(title);
  return clip(textField(args, ['taskId', 'topicId']));
}

function readTitle(data: unknown) {
  const direct = textField(data, ['title', 'name']);
  if (direct) return direct;
  if (data && typeof data === 'object') return textField((data as { topic?: unknown }).topic, ['name', 'title']);
  return '';
}

export function toolPreview(name: string, args: Record<string, unknown> = {}, result?: ToolResult | null, status?: ToolActivityStatus) {
  if (status === 'rejected') return '已拒绝';
  if (status === 'error' || result?.success === false) return clip(result?.error || '执行失败');
  if (name === 'conversation_search') {
    if (typeof args.q === 'string' && args.q.trim()) return clip(args.q);
    if (typeof args.messageId === 'string' && args.messageId.trim()) return '前后文';
    return '过往对话';
  }
  if (name === 'memory') {
    if (args.action === 'search') return clip(typeof args.q === 'string' && args.q.trim() ? args.q : '搜索记忆');
    const title = textField(args, ['title']) || readTitle(result?.data);
    return clip(title || textField(args, ['memoryId']) || '记忆');
  }
  if (status === 'pending') return targetPreview(name, args) || '等待审核';
  if (name === 'list_tasks') {
    const list = Array.isArray(result?.data) ? result.data : [];
    const title = readTitle(list[0]);
    return title ? `${list.length} 条任务 · ${clip(title, 40)}` : `${list.length} 条任务`;
  }
  if (name === 'list_topics') {
    const list = Array.isArray(result?.data) ? result.data : [];
    return `${list.length} 个清单`;
  }
  if (name === 'get_task' || name === 'get_topic' || name === 'get_topic_progress') return clip(readTitle(result?.data) || targetPreview(name, args) || '已读取');
  if (status === 'running') return targetPreview(name, args);
  return targetPreview(name, args) || readTitle(result?.data) || (result ? '已执行' : '');
}

export function groupToolActivities(tools: ToolActivity[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  let run: ToolActivity[] = [];
  const flush = () => {
    if (run.length > 1) groups.push({ kind: 'run', activities: run });
    else if (run.length === 1) groups.push({ kind: 'call', activity: run[0]! });
    run = [];
  };
  for (const activity of tools) {
    if (activity.status === 'done' && isReadOnlyTool(activity.name, activity.arguments)) run.push(activity);
    else { flush(); groups.push({ kind: 'call', activity }); }
  }
  flush();
  return groups;
}

type StoredCall = { id: string; function: { name: string; arguments: string } };

function parseStoredCalls(raw: string | null | undefined): StoredCall[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const call = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const id = typeof call.id === 'string' ? call.id : '';
      const name = typeof call.function?.name === 'string' ? call.function.name : '';
      const args = typeof call.function?.arguments === 'string' ? call.function.arguments : '{}';
      if (!id || !name) return [];
      return [{ id, function: { name, arguments: args } }];
    });
  } catch {
    return [];
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseToolBody(content: string): ToolResult & { toolName?: string } {
  try {
    const parsed = JSON.parse(content) as ToolResult & { toolName?: string };
    if (!parsed || typeof parsed !== 'object') return { success: false, error: content };
    return parsed;
  } catch {
    return { success: false, error: content };
  }
}

function sameArgs(left: Record<string, unknown>, right: Record<string, unknown>) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findApproval(callId: string, name: string, args: Record<string, unknown>, approvals: Approval[], used: Set<string>) {
  const linked = approvals.find((item) => item.toolCallId === callId && !used.has(item.approvalId));
  if (linked) return linked;
  return approvals.find((item) => !item.toolCallId && !used.has(item.approvalId) && item.toolName === name && sameArgs(item.arguments, args));
}

function activityForCall(call: StoredCall, row: ChatMessage | undefined, approvals: Approval[], used: Set<string>): ToolActivity {
  const args = parseArgs(call.function.arguments);
  const body = row ? parseToolBody(row.content) : undefined;
  const approval = findApproval(call.id, call.function.name, args, approvals, used);
  if (approval) used.add(approval.approvalId);
  const rejected = body?.error === '用户拒绝，数据未修改';
  const status: ToolActivityStatus = rejected ? 'rejected' : body?.success === false ? 'error' : body ? 'done' : approval ? 'pending' : 'error';
  const error = status === 'rejected' ? '用户拒绝，数据未修改' : status === 'error' ? (body?.error || '没有返回结果') : undefined;
  return {
    toolCallId: call.id,
    name: call.function.name,
    arguments: args,
    status,
    preview: toolPreview(call.function.name, args, body, status),
    ...(body?.data !== undefined ? { result: body.data } : {}),
    ...(error ? { error } : {}),
    ...(approval ? { approvalId: approval.approvalId } : {}),
  };
}

function legacyActivity(message: ChatMessage): ToolActivity {
  const body = parseToolBody(message.content);
  const name = body.toolName || 'tool';
  const status: ToolActivityStatus = body.success === false ? 'error' : 'done';
  return {
    toolCallId: message.toolCallId || `legacy-${message.id ?? name}`,
    name,
    arguments: {},
    status,
    preview: toolPreview(name, {}, body, status),
    ...(body.data !== undefined ? { result: body.data } : {}),
    ...(status === 'error' ? { error: body.error || message.content } : {}),
  };
}

export function pairToolMessages(messages: ChatMessage[], approvals: Approval[] = []): ChatMessage[] {
  const toolRows = new Map<string, ChatMessage>();
  const claimed = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId && !toolRows.has(message.toolCallId)) toolRows.set(message.toolCallId, message);
    if (message.role === 'assistant') for (const call of parseStoredCalls(message.toolCalls)) claimed.add(call.id);
  }
  const used = new Set<string>();
  const visible: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.toolCallId && claimed.has(message.toolCallId)) continue;
      const legacy = legacyActivity(message);
      const host = [...visible].reverse().find((item) => item.role === 'assistant');
      if (host) host.tools = [...(host.tools ?? []), legacy];
      else visible.push({ role: 'assistant', content: '', status: 'completed', tools: [legacy] });
      continue;
    }
    if (message.role !== 'assistant') {
      visible.push({ ...message });
      continue;
    }
    const tools = parseStoredCalls(message.toolCalls).map((call) => activityForCall(call, toolRows.get(call.id), approvals, used));
    visible.push({ ...message, tools });
  }
  return visible;
}

export function parseSseFrame(frame: string): SseEvent | undefined {
  let type = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (!data.length) return undefined;
  try { return { type, ...JSON.parse(data.join('\n')) }; }
  catch { return { type: 'error', message: '无法解析聊天事件' }; }
}

function assistantIndex(messages: ChatMessage[], messageId?: string) {
  if (messageId) {
    const index = messages.findIndex((item) => item.id === messageId);
    if (index >= 0) return index;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]?.role === 'assistant') return index;
  return -1;
}

function withTool(messages: ChatMessage[], messageId: string | undefined, toolCallId: string, create: ToolActivity, update: (tool: ToolActivity) => ToolActivity) {
  let found = false;
  const next = messages.map((message) => {
    if (!message.tools?.some((tool) => tool.toolCallId === toolCallId)) return message;
    found = true;
    return { ...message, tools: message.tools.map((tool) => tool.toolCallId === toolCallId ? update(tool) : tool) };
  });
  if (found) return next;
  const index = assistantIndex(messages, messageId);
  if (index < 0) return [...messages, { role: 'assistant' as const, content: '', status: 'completed' as const, tools: [create] }];
  return next.map((message, itemIndex) => itemIndex === index ? { ...message, tools: [...(message.tools ?? []), create] } : message);
}

export function applyMessageEvent(messages: ChatMessage[], event: SseEvent): ChatMessage[] {
  if (event.type === 'message_start') return [...messages, { id: event.messageId, role: 'assistant', content: '', status: 'streaming' }];
  if (event.type === 'message_delta') {
    const index = event.messageId ? messages.findIndex((item) => item.id === event.messageId) : messages.length - 1;
    if (index < 0 || messages[index].role !== 'assistant') return messages;
    return messages.map((item, itemIndex) => itemIndex === index ? { ...item, content: item.content + (event.delta ?? ''), status: 'streaming' } : item);
  }
  if (event.type === 'message_end') return messages.map((item) => item.id === event.messageId ? { ...item, status: 'completed' } : item);
  if (event.type === 'tool_call' && event.toolCallId && event.toolName) {
    const args = event.arguments ?? {};
    const created: ToolActivity = { toolCallId: event.toolCallId, name: event.toolName, arguments: args, status: 'running', preview: toolPreview(event.toolName, args, undefined, 'running') };
    return withTool(messages, event.messageId, event.toolCallId, created, () => created);
  }
  if (event.type === 'tool_result' && event.toolCallId) {
    const name = event.toolName ?? 'tool';
    const args = event.arguments ?? {};
    const status: ToolActivityStatus = event.result?.success === false ? 'error' : 'done';
    const created: ToolActivity = {
      toolCallId: event.toolCallId,
      name,
      arguments: args,
      status,
      preview: toolPreview(name, args, event.result, status),
      ...(event.result?.data !== undefined ? { result: event.result.data } : {}),
      ...(status === 'error' ? { error: event.result?.error || '执行失败' } : {}),
    };
    return withTool(messages, event.messageId, event.toolCallId, created, (tool) => ({
      ...tool,
      name: event.toolName || tool.name,
      arguments: event.arguments ?? tool.arguments,
      status,
      preview: toolPreview(event.toolName || tool.name, event.arguments ?? tool.arguments, event.result, status),
      ...(event.result?.data !== undefined ? { result: event.result.data } : {}),
      ...(status === 'error' ? { error: event.result?.error || '执行失败' } : {}),
    }));
  }
  if (event.type === 'approval_required' && event.toolCallId && event.toolName) {
    const args = event.arguments ?? {};
    const created: ToolActivity = { toolCallId: event.toolCallId, name: event.toolName, arguments: args, status: 'pending', preview: toolPreview(event.toolName, args, undefined, 'pending'), ...(event.approvalId ? { approvalId: event.approvalId } : {}) };
    return withTool(messages, event.messageId, event.toolCallId, created, (tool) => ({
      ...tool,
      status: 'pending',
      arguments: event.arguments ?? tool.arguments,
      preview: toolPreview(tool.name, event.arguments ?? tool.arguments, undefined, 'pending'),
      ...(event.approvalId ? { approvalId: event.approvalId } : {}),
    }));
  }
  if (event.type === 'error') return messages.map((item) => {
    const tools = item.tools?.map((tool) => tool.status === 'running' ? { ...tool, status: 'error' as const, error: event.message || '执行失败', preview: toolPreview(tool.name, tool.arguments, { success: false, error: event.message || '执行失败' }, 'error') } : tool);
    if (item.status === 'streaming') return { ...item, status: 'failed' as const, ...(tools ? { tools } : {}) };
    return tools ? { ...item, tools } : item;
  });
  return messages;
}

export function applyApprovalEvent(approvals: Approval[], event: SseEvent): Approval[] {
  if (event.type !== 'approval_required' || !event.approvalId) return approvals;
  const next = { approvalId: event.approvalId, toolName: event.toolName ?? '', arguments: event.arguments ?? {}, ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}) };
  return [...approvals.filter((item) => item.approvalId !== next.approvalId), next];
}
