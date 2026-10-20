import { projectBlocks } from '../../server/src/agent/content-projection.js';
import type { ContentBlock } from './lib/message-blocks.js';
import type { ChatContextV2, ChatContextV3 } from '../../server/src/agent/chat-context.js';
import type { AssistantSource } from '../../server/src/agent/assistant-sources.js';
import type { AppOutcome, AppReview, BatchOutcome, TaskBatchPreview } from '../../server/src/domain/task-batch-types.js';
import { t } from './i18n/index.js';

/** Server stores this exact error when the user rejects a tool call. */
export const userRejectedError = '用户拒绝，数据未修改'; // i18n-ignore
/** Server error text that means the follow-up reply stopped early. */
export const replyIncompleteMarker = '后续回答未完成'; // i18n-ignore

export type ExternalPromptPart = {
  schemaVersion: 1;
  type: 'external_prompt';
  id: string;
  capability: 'web_research' | 'local_execution' | 'external_application' | 'other' | string;
  limitation: string;
  title: string;
  prompt: string;
};

/** A pending worktree deletion card the assistant created; the user confirms or cancels it in the chat. */
export type WorktreeCleanupPart = {
  schemaVersion: 1;
  type: 'worktree_cleanup';
  id: string;
  cleanupId: string;
  nodeName: string;
  removableCount: number;
  blockedCount: number;
  reason: string;
};

export type ChatPart = ExternalPromptPart | WorktreeCleanupPart;

export type ChatMessage = {
  blocks?: ContentBlock[];
  blocksJson?: string | null;
  needsSnapshot?: boolean;
  context?: ChatContextV2 | ChatContextV3 | null;
  sources?: AssistantSource[];
  id?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  status?: 'streaming' | 'completed' | 'failed';
  toolCalls?: string | null;
  toolCallId?: string | null;
  tools?: ToolActivity[];
  parts?: ChatPart[];
  partsJson?: string | null;
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
  conversationId?: string;
  preview?: TaskBatchPreview;
  outcome?: BatchOutcome;
  supersededByApprovalId?: string;
  resultState?: 'batch' | 'proposal' | 'result' | 'app_changes' | 'unreadable';
  summary?: string;
  appReview?: AppReview;
  appOutcome?: AppOutcome;
  proposalRevision?: number;
  previewHash?: string;
  requestedOperations?: unknown[];
  reversesApprovalId?: string | null;
  assistantMessageId?: string;
};

export type ToolResult = { success: boolean; data?: unknown; error?: string; code?: string };

export type SseEvent = {
  blockId?: string;
  blockType?: ContentBlock['type'];
  index?: number;
  block?: ContentBlock;
  offset?: number;
  compatibilityProjection?: boolean;
  status?: 'completed' | 'failed';
  context?: ChatContextV2 | ChatContextV3;
  sources?: AssistantSource[];
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
  preview?: TaskBatchPreview;
  review?: AppReview;
  proposalId?: string;
  proposalRevision?: number;
  previewHash?: string;
  runId?: string;
  seq?: number;
  state?: string;
  pauseReason?: string | null;
  part?: ChatPart;
  supersedesApprovalId?: string;
};

const READ_ONLY_TOOLS = new Set(['image_search', 'present_reply', 'read_app_knowledge', 'read_page_state', 'list_topics', 'get_topic', 'get_topic_progress', 'list_tasks', 'get_task', 'conversation_search', 'get_time', 'get_work_context', 'query_tasks', 'query_topics', 'get_task_activity', 'search_workspace', 'library_read', 'memory_read', 'get_change_schema', 'orchestration_read']);
const PREVIEW_MAX = 80;

const LIBRARY_READS = new Set(['list', 'search', 'read', 'content', 'linked_tasks', 'task_materials', 'folders', 'tags', 'ask']);

export function isReadOnlyTool(name: string, args?: Record<string, unknown>) {
  if (name === 'memory') return args?.action === 'read' || args?.action === 'search';
  if (name === 'library') return LIBRARY_READS.has(String(args?.action ?? ''));
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

/** load_skill stays out of READ_ONLY_TOOLS so it shows as its own skill-usage row. */
export function skillUsagePreview(args: Record<string, unknown> = {}, result?: ToolResult | null, status?: ToolActivityStatus) {
  if (status === 'running') return t('chat:toolPreview.skillReading');
  if (status === 'error' || result?.success === false) {
    if (result?.code === 'NOT_FOUND') return t('chat:toolPreview.skillNotFound');
    if (result?.code === 'CAPABILITY_UNAVAILABLE') return t('chat:toolPreview.skillUnavailable');
    return clip(result?.error || t('chat:toolPreview.skillReadFailed'));
  }
  const data = result?.data && typeof result.data === 'object' ? result.data as { name?: unknown; revision?: unknown } : {};
  const name = typeof data.name === 'string' && data.name ? data.name : typeof args.name === 'string' ? args.name : '';
  if (!name) return status === 'done' || result ? t('chat:toolPreview.read') : t('chat:toolPreview.skillReading');
  return clip(typeof data.revision === 'number' ? `${name} v${data.revision}` : name);
}

export function toolPreview(name: string, args: Record<string, unknown> = {}, result?: ToolResult | null, status?: ToolActivityStatus) {
  if (status === 'rejected') return t('chat:toolPreview.rejected');
  if (name === 'load_skill') return skillUsagePreview(args, result, status);
  if (status === 'error' || result?.success === false) return clip(result?.error || t('chat:toolPreview.runFailed'));
  if (name === 'propose_changes') return clip(typeof args.summary === 'string' && args.summary.trim() ? args.summary : t('chat:toolPreview.waitingConfirm'));
  if (name === 'prepare_external_prompt') return t('chat:toolPreview.promptReady');
  if (name === 'propose_worktree_cleanup') return t('chat:toolPreview.waitingCleanup');
  if (name === 'orchestration_read') return orchestrationReadPreview(args, status);
  if (name === 'get_time' || name === 'get_work_context' || name === 'query_tasks' || name === 'query_topics' || name === 'get_task_activity' || name === 'search_workspace' || name === 'library_read' || name === 'memory_read' || name === 'get_change_schema') {
    return clip(textField(args, ['q', 'title', 'taskId']) || (status === 'running' ? t('chat:toolPreview.reading') : t('chat:toolPreview.read')));
  }
  if (name === 'conversation_search') {
    if (typeof args.q === 'string' && args.q.trim()) return clip(args.q);
    if (typeof args.messageId === 'string' && args.messageId.trim()) return t('chat:toolPreview.nearby');
    return t('chat:toolPreview.earlier');
  }
  if (name === 'library') {
    const title = textField(args, ['title', 'name', 'question', 'q']) || readTitle(result?.data);
    if (title) return clip(title);
    return clip(typeof args.action === 'string' && args.action ? args.action : t('chat:toolPreview.projectMaterials'));
  }
  if (name === 'memory') {
    if (args.action === 'search') return clip(typeof args.q === 'string' && args.q.trim() ? args.q : t('chat:toolPreview.searchMemory'));
    const title = textField(args, ['title']) || readTitle(result?.data);
    return clip(title || textField(args, ['memoryId']) || t('chat:toolPreview.memory'));
  }
  if (status === 'pending') return targetPreview(name, args) || t('chat:toolPreview.waitingReview');
  if (name === 'list_tasks') {
    const list = Array.isArray(result?.data) ? result.data : [];
    const title = readTitle(list[0]);
    return title ? t('chat:toolPreview.tasksWithTitle', { count: list.length, title: clip(title, 40) }) : t('chat:toolPreview.tasks', { count: list.length });
  }
  if (name === 'list_topics') {
    const list = Array.isArray(result?.data) ? result.data : [];
    return t('chat:toolPreview.lists', { count: list.length });
  }
  if (name === 'get_task' || name === 'get_topic' || name === 'get_topic_progress') return clip(readTitle(result?.data) || targetPreview(name, args) || t('chat:toolPreview.read'));
  if (status === 'running') return targetPreview(name, args);
  return targetPreview(name, args) || readTitle(result?.data) || (result ? t('chat:toolPreview.ran') : '');
}

export function groupToolActivities(tools: ToolActivity[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  let run: ToolActivity[] = [];
  const flush = () => {
    if (run.length > 0) groups.push({ kind: 'run', activities: run });
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
  const rejected = body?.error === userRejectedError;
  const status: ToolActivityStatus = rejected ? 'rejected' : body?.success === false ? 'error' : body ? 'done' : approval ? 'pending' : 'error';
  const error = status === 'rejected' ? userRejectedError : status === 'error' ? (body?.error || t('chat:toolActivity.noResult')) : undefined;
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

function toolAssistantId(message: ChatMessage) {
  try {
    const parsed = JSON.parse(message.content) as { assistantMessageId?: unknown };
    return typeof parsed.assistantMessageId === 'string' ? parsed.assistantMessageId : undefined;
  } catch {
    return undefined;
  }
}

export function approvalsOnMessage(message: ChatMessage, approvals: Approval[]) {
  const callIds = new Set((message.tools ?? []).map((tool) => tool.toolCallId));
  const seen = new Set<string>();
  const matched: Approval[] = [];
  for (const approval of approvals) {
    const byMessage = Boolean(message.id && approval.assistantMessageId === message.id);
    const byCall = !approval.assistantMessageId && Boolean(approval.toolCallId && callIds.has(approval.toolCallId));
    if ((!byMessage && !byCall) || seen.has(approval.approvalId)) continue;
    seen.add(approval.approvalId);
    matched.push(approval);
  }
  return matched;
}

export function unplacedApprovals(messages: ChatMessage[], approvals: Approval[]) {
  const placed = new Set(messages.flatMap((message) => approvalsOnMessage(message, approvals).map((item) => item.approvalId)));
  const seen = new Set<string>();
  return approvals.filter((approval) => {
    if (placed.has(approval.approvalId) || seen.has(approval.approvalId)) return false;
    seen.add(approval.approvalId);
    return true;
  });
}

export function pairToolMessages(messages: ChatMessage[], approvals: Approval[] = []): ChatMessage[] {
  const tools = messages.map((message, index) => ({ message, index })).filter((item) => item.message.role === 'tool' && item.message.toolCallId);
  const consumed = new Set<number>();
  const take = (assistantId: string | undefined, callId: string) => {
    const scoped = assistantId ? tools.find((item) => !consumed.has(item.index) && item.message.toolCallId === callId && toolAssistantId(item.message) === assistantId) : undefined;
    const open = tools.find((item) => !consumed.has(item.index) && item.message.toolCallId === callId && !toolAssistantId(item.message));
    const match = scoped ?? open;
    if (!match) return undefined;
    consumed.add(match.index);
    return match.message;
  };
  const claimed = (callId: string) => messages.some((message) => message.role === 'assistant' && parseStoredCalls(message.toolCalls).some((call) => call.id === callId));
  const used = new Set<string>();
  const visible: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.toolCallId && claimed(message.toolCallId)) continue;
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
    const rows = parseStoredCalls(message.toolCalls).map((call) => activityForCall(call, take(message.id, call.id), approvals, used));
    visible.push({ ...message, tools: rows });
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
  catch { return { type: 'error', message: t('chat:errors.parseEventFailed') }; }
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
  if (event.type === 'user_context' && event.context) {
    const found = messages.findIndex((item) => item.id === event.messageId);
    const index = found >= 0 ? found : messages.reduce((last, item, index) => item.role === 'user' && !item.id ? index : last, -1);
    return messages.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.messageId, context: event.context } : item);
  }
  if (event.type.startsWith('block_') && event.messageId && event.blockId) {
    return messages.map((message) => {
      if (message.id !== event.messageId) return message;
      const blocks = [...(message.blocks ?? [])];
      const position = blocks.findIndex((block) => block.id === event.blockId);
      const current = blocks[position];
      if (event.type === 'block_start') {
        if (current) return message;
        blocks.push({ id: event.blockId!, index: event.index ?? blocks.length, type: event.blockType ?? 'pending', status: 'pending' });
      } else if (event.type === 'block_commit' && event.block) {
        if (position < 0) blocks.push(event.block); else blocks[position] = event.block;
      } else if (event.type === 'block_delta') {
        if (!current) return { ...message, needsSnapshot: true };
        if (current.status !== 'pending') return message;
        const text = current.markdown ?? ''; const offset = event.offset ?? -1; const delta = event.delta ?? '';
        if (offset < text.length && text.slice(offset, offset + delta.length) === delta) return message;
        if (offset !== text.length) return { ...message, needsSnapshot: true };
        blocks[position] = { ...current, type: 'text', markdown: text + delta };
      } else if (event.type === 'block_error') {
        if (!current) return { ...message, needsSnapshot: true };
        blocks[position] = { ...current, status: 'error', error: event.message || t('chat:messageBlocks.incomplete') };
      }
      blocks.sort((a, b) => a.index - b.index);
      return { ...message, blocks, content: projectBlocks(blocks) };
    });
  }
  if (event.type === 'message_start') {
    const index = event.messageId ? messages.findIndex((item) => item.id === event.messageId) : -1;
    if (index >= 0) return messages;
    return [...messages, { id: event.messageId, role: 'assistant', content: '', status: 'streaming' }];
  }
  if (event.type === 'message_delta') {
    const index = event.messageId ? messages.findIndex((item) => item.id === event.messageId) : messages.length - 1;
    if (index < 0 || messages[index].role !== 'assistant') return messages;
    if (messages[index].status === 'completed' || messages[index].status === 'failed') return messages;
    return messages.map((item, itemIndex) => itemIndex === index ? { ...item, content: event.compatibilityProjection ? event.delta ?? '' : item.content + (event.delta ?? ''), status: 'streaming' } : item);
  }
  if (event.type === 'message_end') return messages.map((item) => item.id === event.messageId ? { ...item, status: event.status === 'failed' ? 'failed' : 'completed' } : item);
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
      ...(status === 'error' ? { error: event.result?.error || t('chat:toolPreview.runFailed') } : {}),
    };
    return withTool(messages, event.messageId, event.toolCallId, created, (tool) => ({
      ...tool,
      name: event.toolName || tool.name,
      arguments: event.arguments ?? tool.arguments,
      status,
      preview: toolPreview(event.toolName || tool.name, event.arguments ?? tool.arguments, event.result, status),
      ...(event.result?.data !== undefined ? { result: event.result.data } : {}),
      ...(status === 'error' ? { error: event.result?.error || t('chat:toolPreview.runFailed') } : {}),
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
  if (event.type === 'sources' && event.sources) return messages.map((item) => item.id === event.messageId ? { ...item, sources: event.sources } : item);
  if (event.type === 'external_prompt' && event.part && isChatPart(event.part)) {
    const part = event.part;
    const index = assistantIndex(messages, event.messageId);
    if (index < 0) return [...messages, { role: 'assistant' as const, content: '', status: 'completed' as const, parts: [part] }];
    return messages.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const parts = item.parts ?? [];
      if (parts.some((current) => current.id === part.id)) return item;
      return { ...item, parts: [...parts, part] };
    });
  }
  if (event.type === 'run_state' && event.pauseReason === 'new_user_message') {
    const settled = messages.map((item) => item.status === 'streaming' ? { ...item, status: 'completed' as const } : item);
    const pausedText = t('chat:system.pausedFollowUp');
    if (settled.some((item) => item.content === pausedText)) return settled;
    return [...settled, { role: 'system' as const, content: pausedText, status: 'completed' as const }];
  }
  if (event.type === 'error') {
    const failedText = t('chat:toolPreview.runFailed');
    const next = messages.map((item) => {
      const tools = item.tools?.map((tool) => tool.status === 'running' ? { ...tool, status: 'error' as const, error: event.message || failedText, preview: toolPreview(tool.name, tool.arguments, { success: false, error: event.message || failedText }, 'error') } : tool);
      if (item.status === 'streaming') return { ...item, status: 'failed' as const, ...(tools ? { tools } : {}) };
      return tools ? { ...item, tools } : item;
    });
    const incompleteText = t('chat:system.replyIncomplete');
    if (event.message?.includes(replyIncompleteMarker) && !next.some((item) => item.content.includes(replyIncompleteMarker) || item.content === incompleteText)) {
      next.push({ role: 'system', content: incompleteText, status: 'completed' });
    }
    return next;
  }
  return messages;
}

function isChatPart(value: unknown): value is ChatPart {
  if (!value || typeof value !== 'object') return false;
  const part = value as Partial<ExternalPromptPart> & Partial<WorktreeCleanupPart>;
  if (typeof part.id !== 'string') return false;
  if (part.type === 'external_prompt') return typeof part.prompt === 'string' && part.prompt.length > 0;
  if (part.type === 'worktree_cleanup') return typeof part.cleanupId === 'string' && part.cleanupId.length > 0;
  return false;
}

const orchestrationReadActions = new Set(['attention', 'list', 'get', 'nodes', 'worktrees']);
function orchestrationReadPreview(args: Record<string, unknown>, status?: ToolActivityStatus) {
  const action = typeof args.action === 'string' ? args.action : '';
  if (orchestrationReadActions.has(action)) return t(`chat:toolPreview.orchestration.${action}`);
  return status === 'running' ? t('chat:toolPreview.reading') : t('chat:toolPreview.read');
}

export function parseExternalParts(raw: string | null | undefined): ChatPart[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      return isChatPart(item) ? [item] : [];
    });
  } catch {
    return [];
  }
}

export type ReviewCardState = 'pending' | 'approving' | 'rejecting' | 'unknown' | 'executed' | 'rejected' | 'failed' | 'superseded' | 'unreadable' | 'capability_removed';

export function reviewCardState(approval: Approval, phase: '' | 'approve' | 'reject', unknown: boolean): ReviewCardState {
  if (approval.toolName.startsWith('execute_')) return 'capability_removed';
  if (approval.resultState === 'unreadable' && !approval.appReview) return 'unreadable';
  if (approval.supersededByApprovalId) return 'superseded';
  if (unknown) return 'unknown';
  if (phase === 'approve') return 'approving';
  if (phase === 'reject') return 'rejecting';
  const outcome = approval.appOutcome?.status;
  if (outcome === 'executed' || approval.status === 'executed') return 'executed';
  if (outcome === 'rejected' || approval.status === 'rejected') return 'rejected';
  if (outcome === 'failed' || approval.status === 'failed') return 'failed';
  if (approval.status === 'pending' || !approval.status) return 'pending';
  return 'pending';
}

export function reviewStatusCopy(state: ReviewCardState, approval: Approval, unresolved = false) {
  if (state === 'pending') return t('chat:reviewStatus.waitingConfirm');
  if (state === 'approving') return t('chat:reviewStatus.applying');
  if (state === 'rejecting') return t('chat:reviewStatus.cancelling');
  if (state === 'unknown') return unresolved ? t('chat:reviewStatus.needsCheck') : t('chat:reviewStatus.checking');
  if (state === 'executed') {
    const count = approval.appOutcome?.status === 'executed' ? approval.appOutcome.appliedOperationCount : approval.appReview?.affectedEntityCount ?? 0;
    return t('chat:reviewStatus.updated', { count });
  }
  if (state === 'rejected' && approval.appOutcome?.status === 'rejected' && approval.appOutcome.code === 'SAVED_IN_EDITOR') return approval.appOutcome.message || t('chat:reviewStatus.savedInEditor');
  if (state === 'rejected') return t('chat:reviewStatus.cancelled');
  if (state === 'failed' && approval.appOutcome?.status === 'failed' && approval.appOutcome.code === 'VERSION_CONFLICT') return t('chat:reviewStatus.conflict');
  if (state === 'failed') return t('chat:reviewStatus.notModified');
  if (state === 'superseded') return t('chat:reviewStatus.superseded');
  if (state === 'unreadable') return t('chat:reviewStatus.unreadable');
  return t('chat:reviewStatus.capabilityRemoved');
}

export function applyApprovalEvent(approvals: Approval[], event: SseEvent): Approval[] {
  if (event.type !== 'approval_required' || !event.approvalId) return approvals;
  const fromArguments = typeof event.arguments?.supersedesApprovalId === 'string' ? event.arguments.supersedesApprovalId : '';
  const supersedes = typeof event.supersedesApprovalId === 'string' ? event.supersedesApprovalId : fromArguments;
  const next: Approval = {
    approvalId: event.approvalId,
    toolName: event.toolName ?? '',
    arguments: event.arguments ?? {},
    status: 'pending',
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    ...(event.messageId ? { assistantMessageId: event.messageId } : {}),
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
    ...(event.preview ? { preview: event.preview, resultState: 'batch' as const, summary: event.preview.summary } : {}),
    ...(event.review?.previewHash ? { resultState: 'app_changes' as const, appReview: event.review, previewHash: event.previewHash ?? event.review.previewHash, proposalRevision: event.proposalRevision, summary: event.review.intent } : {}),
  };
  const kept = approvals.filter((item) => item.approvalId !== next.approvalId).map((item) => (
    supersedes && item.approvalId === supersedes ? { ...item, status: 'rejected', supersededByApprovalId: next.approvalId } : item
  ));
  return [...kept, next];
}
