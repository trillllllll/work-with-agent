import { readStoredApproval } from '../../../server/src/domain/task-batch-types.js';
import { parseSseFrame, type Approval, type SseEvent, type ToolResult } from '../chat.js';
import { currentLanguage, t } from '../i18n/index.js';
import { browserReplica, offlineRequest, cacheableOfflineRead, cachedOfflineRead, cacheOfflineRead } from './offline-runtime.js';

function labels<K extends string>(keys: Record<K, string>): Record<K, string> {
  const result = {} as Record<K, string>;
  for (const id of Object.keys(keys) as K[]) {
    const key = keys[id];
    Object.defineProperty(result, id, { enumerable: true, get: () => t(key) });
  }
  return result;
}
function labeled<V extends string>(id: V, key: string): { id: V; label: string } {
  return { id, get label() { return t(key); } };
}
function option<V extends string>(value: V, key: string): { value: V; label: string } {
  return { value, get label() { return t(key); } };
}

export type Topic = { id: string; name: string; description: string; color: TagColor; isExploration: boolean; goal?: string; draftSummary?: string; finalSummary?: string; summaryStatus?: string; summaryUpdatedAt?: string | null; archivedAt?: string | null; revision?: number };
export type Status = 'todo' | 'doing' | 'blocked' | 'done';
export type TaskPriority = 'none' | 'low' | 'medium' | 'high';
export type Task = { id: string; topicId: string | null; title: string; description: string; status: Status; allowedTransitions: Status[]; priority: TaskPriority; dueDate: string | null; estimatedMinutes: number | null; scheduledStart: string | null; scheduledEnd: string | null; resultSummary: string; createdAt?: string; updatedAt?: string; completedAt?: string | null; completedAtEstimated?: boolean; deletedAt?: string | null; parentId?: string | null; sortOrder?: number; revision?: number; deleteBatchId?: string | null; tags?: Tag[]; tagIds?: string[]; children?: Task[]; topic?: { id: string; name: string; archivedAt?: string | null } | null };
export type TagColor = 'violet' | 'blue' | 'teal' | 'green' | 'amber' | 'rose' | 'slate';
export const tagColors: { id: TagColor; label: string }[] = [
  labeled('violet', 'app:color.violet'), labeled('blue', 'app:color.blue'), labeled('teal', 'app:color.teal'), labeled('green', 'app:color.green'),
  labeled('amber', 'app:color.amber'), labeled('rose', 'app:color.rose'), labeled('slate', 'app:color.slate'),
];
export type Tag = { id: string; name: string; color?: TagColor; revision?: number };
export type TrashTask = Task & { deletedAt: string; topic?: { id: string; name: string } };
export type TaskTopicHistory = { id: string; reason: 'created' | 'assigned' | 'unassigned' | 'topic_archived' | 'undo' | 'migration'; source: string; changedAt: string; fromTopic: { id: string; name: string } | null; toTopic: { id: string; name: string } | null };
export type TaskActivityChange =
  | { field: 'title' | 'description' | 'resultSummary'; before: string; after: string }
  | { field: 'status'; before: Status; after: Status }
  | { field: 'priority'; before: TaskPriority; after: TaskPriority }
  | { field: 'dueDate' | 'scheduledStart' | 'scheduledEnd'; before: string | null; after: string | null }
  | { field: 'topicId'; before: { id: string | null; name: string }; after: { id: string | null; name: string } }
  | { field: 'estimatedMinutes'; before: number | null; after: number | null }
  | { field: 'parentId'; before: { id: string | null; title: string }; after: { id: string | null; title: string } }
  | { field: 'tagIds'; before: string[]; after: string[] }
  | { field: 'deleted'; before: boolean; after: boolean };
export type TaskActivityEvent = { id: string; at: string; actor: { kind: 'user' | 'agent'; name: string }; action: 'create' | 'update' | 'delete' | 'restore' | 'undo'; changes: TaskActivityChange[] };
export type CliCommandSetting = { command: string; source: 'manual' | 'auto' | 'none'; version: string; checkedAt: string; manualCommand: string; autoCommand: string; discoveredCommand: string; discoveredVersion: string; applied: boolean; message: string };
export type Settings = { baseUrl: string; model: string; apiKeyConfigured: boolean; apiKeyMasked: string | null; cli?: { codex: CliCommandSetting; claude: CliCommandSetting }; discovered?: Record<string, CliCommandSetting> };
export type ApprovalResponse = { result?: ToolResult; assistantMessage?: string; assistantMessageId?: string; summaryError?: string; approval?: unknown; resumed?: boolean; run?: { id?: string; state?: string } | null };
export type View = 'board' | 'quadrant' | 'chat' | 'topics' | 'inbox' | 'settings' | 'trash' | 'changes' | 'today' | 'search' | 'tags' | 'archived' | 'more' | 'connections' | 'proposals' | 'knowledge' | 'library' | 'skills' | 'runs' | 'worktrees' | 'reviews' | 'plan' | 'focus' | 'stats' | 'learning';
export type TimeBandColor = 'blue' | 'green' | 'orange' | 'purple' | 'pink' | 'gray';
export type PlanTimeBand = {
  id: string;
  name: string;
  startMinute: number;
  endMinute: number;
  weekdays: number[];
  color: TimeBandColor;
};
export type PlanTimeBandsPayload = { bands: PlanTimeBand[] };
export type TimeBandSegment = {
  bandId: string;
  startMinute: number;
  endMinute: number;
  color: TimeBandColor;
};
export type FocusSession = {
  id: string; taskId: string | null; kind: 'focus' | 'break';
  startedAt: string; endedAt: string; durationMinutes: number;
  plannedMinutes: number; completed: boolean; createdAt: string;
};
export type ChangeSummary = { field: string; before: string; after: string } | { kind: 'tool'; toolName: string; success: boolean };
export type UndoBlockedReason = { code: 'CHANGE_ALREADY_UNDONE' | 'CHANGE_NOT_REVERSIBLE' | 'MISSING_SNAPSHOT'; reason: 'already_undone' | 'undo_record' | 'execution' | 'permanent_delete' | 'unsupported' | 'missing_snapshot' };
export type ChangeListItem = {
  id: string; entityType: string; entityId: string; operation: string; entityName: string; groupCount: number;
  changeSummary: ChangeSummary | null; source: string; actorKind: 'user' | 'assistant' | 'connection';
  connectionId: string | null; connectionName: string | null; approvalId: string | null;
  canUndo: boolean; undoBlockedReason: UndoBlockedReason | null; undoneAt: string | null; createdAt: string;
};
export type ChangePage = { items: ChangeListItem[]; nextCursor: string | null; total: number; connections?: { id: string; name: string | null }[] };
export type ReviewRule = {
  id: string;
  name: string;
  enabled: boolean;
  frequency: 'daily' | 'weekly';
  timeOfDay: string;
  timeZone: string;
  weekDay: number;
  topicIds: string[];
  includeInbox: boolean;
  provider: 'none' | 'builtin' | 'external' | 'codex' | 'claude';
  revision: number;
  coverageThrough: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
};
export type ReviewBatch = {
  id: string;
  ruleId: string;
  occurrenceKey: string;
  status: 'generating' | 'partial' | 'ready' | 'failed';
  snapshot: Record<string, unknown>;
  content: string;
  organizationIds: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  ruleName: string;
  ruleDeleted: boolean;
  counts: { added: number; completed: number; overdue: number; blocked: number } | null;
  pendingProposalCount: number;
};

export const statuses: { value: Status; label: string }[] = [option('todo', 'app:status.todo'), option('doing', 'app:status.doing'), option('blocked', 'app:status.blocked'), option('done', 'app:status.done')];
export function availableTaskStatuses(task: Pick<Task, 'status' | 'allowedTransitions'>): Status[] { const allowed = new Set([task.status, ...(task.allowedTransitions ?? [])]); return statuses.map((item) => item.value).filter((status) => allowed.has(status)); }
export const priorities: { value: TaskPriority; label: string }[] = [option('none', 'app:priority.none'), option('low', 'app:priority.low'), option('medium', 'app:priority.medium'), option('high', 'app:priority.high')];
export const toolLabels: Record<string, string> = labels({
  read_app_knowledge: 'app:tool.readAppKnowledge', read_page_state: 'app:tool.readPageState',
  list_topics: 'app:tool.listTopics', get_topic: 'app:tool.getTopic', get_topic_progress: 'app:tool.getTopicProgress', list_tasks: 'app:tool.listTasks', get_task: 'app:tool.getTask',
  create_task: 'app:tool.createTask', update_task: 'app:tool.updateTask', delete_task: 'app:tool.deleteTask', create_topic: 'app:tool.createTopic', update_topic: 'app:tool.updateTopic', delete_topic: 'app:tool.deleteTopic', propose_topic_summary: 'app:tool.proposeTopicSummary',
  execute_shell: 'app:tool.executeShell', execute_file: 'app:tool.executeFile', execute_http: 'app:tool.executeHttp',
  memory: 'app:tool.memory', conversation_search: 'app:tool.conversationSearch', library: 'app:tool.library', propose_task_changes: 'app:tool.proposeTaskChanges',
  get_time: 'app:tool.getTime', list_plan_time_bands: 'app:tool.listPlanTimeBands', get_work_context: 'app:tool.getWorkContext', query_tasks: 'app:tool.queryTasks', query_topics: 'app:tool.queryTopics', get_task_activity: 'app:tool.getTaskActivity',
  search_workspace: 'app:tool.searchWorkspace', library_read: 'app:tool.libraryRead', memory_read: 'app:tool.memoryRead', get_change_schema: 'app:tool.getChangeSchema', propose_changes: 'app:tool.proposeChanges', prepare_external_prompt: 'app:tool.prepareExternalPrompt', load_skill: 'app:tool.loadSkill', orchestration_read: 'app:tool.orchestrationRead', orchestration_stats: 'app:tool.orchestrationStats', propose_worktree_cleanup: 'app:tool.proposeWorktreeCleanup',
});
export const API_URL = '';
let csrfToken = '';
export function setCsrfToken(value: string) { csrfToken = value; }
/** Every API call carries the CSRF token (when signed in) and the chosen UI language, so server messages match it. */
export function authHeaders(): Record<string, string> { const workspaceId = browserReplica()?.workspaceId; return { 'X-Dovun-Language': currentLanguage(), ...(workspaceId ? { 'X-Dovun-Workspace-Id': workspaceId } : {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) }; }

export type MutationMeta = { changeId?: string; affectedTaskIds?: string[]; warnings?: string[] };
export type ApiEnvelope<T> = { data: T; error: null; meta?: MutationMeta };
export class ApiError extends Error {
  constructor(message: string, public code?: string, public status?: number, public details?: unknown) { super(message); this.name = 'ApiError'; }
}
function normalizeApiError(error: unknown) {
  if (error instanceof Error && (error.name === 'ZodError' || ('code' in error && error.code === 'INVALID_INPUT'))) return new ApiError(t('workspace:offline.errors.validation'), 'INVALID_INPUT', 400);
  if (error instanceof Error && 'code' in error && error.code === 'TASK_STATUS_TRANSITION_NOT_ALLOWED') return new ApiError(t('workspace:offline.errors.transition'), String(error.code), 400);
  return error instanceof Error && 'code' in error && 'status' in error && !(error instanceof ApiError)
    ? new ApiError(error.message, String(error.code), Number(error.status), 'details' in error ? error.details : undefined)
    : error;
}
export async function apiMutation<T = any>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const replica = browserReplica();
  try {
    const local = await offlineRequest(path, init);
    if (local !== undefined) return local;
  } catch (error) {
    throw normalizeApiError(error);
  }
  const cacheable = cacheableOfflineRead(path, init?.method);
  try {
    const prepared = replica ? await replica.prepareOnline(path, init) : init;
    let result = await networkApiMutation<T>(path, prepared);
    if (replica && browserReplica() !== replica) throw new ApiError(t('app:api.requestFailed'), 'SCOPE_CHANGED', 409);
    if (replica) result = await replica.afterOnline(path, init, result);
    if (cacheable) void cacheOfflineRead(path, result, replica);
    return result;
  } catch (error) {
    if (cacheable && (!(error instanceof ApiError) || Number(error.status) >= 500)) {
      const cached = await cachedOfflineRead(path, replica);
      if (cached !== undefined) return cached as ApiEnvelope<T>;
    }
    throw normalizeApiError(error);
  }
}
export async function networkApiMutation<T = any>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const headers = new Headers({ 'Content-Type': 'application/json', ...authHeaders() });
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  if (/^\/api\/v1\/(?:sync|auth|server\/info)(?:\/|\?|$)/.test(path)) headers.delete('X-Dovun-Workspace-Id');
  const response = await fetch(`${API_URL}${path}`, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000), credentials: 'include', headers });
  const body = await response.json().catch(() => ({ data: null, error: t('app:api.invalidResponse') }));
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('workspace-session-expired'));
    throw new ApiError(typeof body.error === 'string' ? body.error : body.error?.message ?? t('app:api.requestFailed'), body.code ?? body.error?.code, response.status, body.details ?? body.error?.details);
  }
  return body;
}
export async function api<T = any>(path: string, init?: RequestInit): Promise<T> { return (await apiMutation<T>(path, init)).data; }

export function parseApproval(item: any): Approval {
  let args: Record<string, unknown> = {};
  try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments ?? {}; } catch { /* Keep malformed legacy data visible as empty args. */ }
  const stored = readStoredApproval(item?.result);
  return {
    approvalId: item.id,
    toolName: item.toolName,
    arguments: args,
    status: item.status,
    ...(item.conversationId ? { conversationId: item.conversationId } : {}),
    ...(stored.toolCallId ? { toolCallId: stored.toolCallId } : {}),
    ...(stored.preview ? { preview: stored.preview } : {}),
    ...(stored.outcome ? { outcome: stored.outcome } : {}),
    ...(stored.supersededByApprovalId ? { supersededByApprovalId: stored.supersededByApprovalId } : {}),
    ...(stored.resultState ? { resultState: stored.resultState } : {}),
    ...(stored.summary ? { summary: stored.summary } : {}),
    ...(stored.appReview ? { appReview: stored.appReview } : {}),
    ...(stored.appOutcome ? { appOutcome: stored.appOutcome } : {}),
    ...(stored.proposalRevision !== undefined ? { proposalRevision: stored.proposalRevision } : {}),
    ...(stored.previewHash ? { previewHash: stored.previewHash } : {}),
    ...(stored.requestedOperations ? { requestedOperations: stored.requestedOperations } : {}),
    ...(stored.reversesApprovalId !== undefined ? { reversesApprovalId: stored.reversesApprovalId } : {}),
    ...(stored.assistantMessageId ? { assistantMessageId: stored.assistantMessageId } : {}),
  };
}

export async function streamChat(body: unknown, onEvent: (event: SseEvent) => void, options?: { onAccepted?: () => void }) {
  await browserReplica()?.prepareOnline('/api/chat', { method: 'POST', body: JSON.stringify(body) });
  const response = await fetch(`${API_URL}/api/chat`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders() }, body: JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(typeof payload?.error === 'string' ? payload.error : payload?.error?.message ?? t('app:api.chatRequestFailed'), payload?.code ?? payload?.error?.code, response.status);
  }
  options?.onAccepted?.();
  if (!response.body) throw new Error(t('app:api.chatEmptyBody'));
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

export type StatsPair = { value: number; previous: number };
export type StatsRate = { value: number | null; previous: number | null };
export type StatsSectionError = { error: { code: string; message: string } };
export type StatsRangeInfo = { from: string; to: string; tz: string; days: number; previous: { from: string; to: string }; today: string };
export type StatsProposalSource = 'connection' | 'auto-memory' | 'local-owner' | 'builtin-agent' | 'orchestration-learning' | 'other';
export type StatsTasksSection = {
  completedByDay: Array<{ date: string; count: number; estimated: number }>;
  createdByDay: Array<{ date: string; count: number }>;
  created: StatsPair;
  completed: StatsPair;
  overdue: number;
  overdueTop: Array<{ id: string; title: string; topicId: string | null; topicName: string | null; topicColor: string | null; days: number }>;
  overdueOldestDays: number;
  byTopic: Array<{ topicId: string | null; name: string | null; color: string | null; count: number }>;
  byTag: Array<{ tagId: string; name: string; color: string; count: number }>;
  estimatedCount: StatsPair;
};
export type StatsFocusSection = {
  minutesByDay: Array<{ date: string; minutes: number }>;
  sessionsByDay: Array<{ date: string; count: number }>;
  minutes: StatsPair;
  sessions: StatsPair;
  completedSessions: StatsPair;
  avgSession: StatsRate;
  completionRate: StatsRate;
  byTask: Array<{ taskId: string | null; title: string | null; minutes: number; sessions: number }>;
};
export type StatsPlanSection = {
  byDay: Array<{ date: string; plannedTasks: number; plannedMinutes: number; doneOnPlan: number; doneLate: number; notDone: number; focusMinutes: number }>;
  onPlanRate: StatsRate;
  plannedTasks: StatsPair;
  doneOnPlanTasks: StatsPair;
  plannedMinutesTotal: StatsPair;
  focusMinutesTotal: StatsPair;
  byBand: Array<{ id: string | null; name: string | null; color: string | null; startMinute: number | null; endMinute: number | null; weekdays: number[] | null; plannedMinutes: number; focusMinutes: number }>;
};
export type StatsAiSection = {
  proposals: {
    created: StatsPair;
    executed: StatsPair;
    rejected: StatsPair;
    failed: StatsPair;
    pending: number;
    adoptionRate: StatsRate;
    bySource: Array<{ source: StatsProposalSource; count: number }>;
  };
  memories: { created: StatsPair; retired: StatsPair; byOrigin: { manual: number; ai: number }; activeTotal: number };
  autoMemory: { jobs: StatsPair; failed: StatsPair; adoption: StatsRate };
  dispatch: {
    rounds: StatsPair;
    firstPassRate: StatsRate;
    costMicroUsd: StatsPair;
    byDay: Array<{ date: string; rounds: number; firstPassPassed: number; firstPassTotal: number; costMicroUsd: number }>;
  };
  connections: Array<{ id: string; name: string; status: string; host: string; writes: number; proposals: number; lastActiveAt: string | null; byDay: Array<{ date: string; count: number }> }>;
};
export type StatsOverview = {
  range: StatsRangeInfo;
  tasks: StatsTasksSection | StatsSectionError;
  focus: StatsFocusSection | StatsSectionError;
  plan: StatsPlanSection | StatsSectionError;
  ai: StatsAiSection | StatsSectionError;
};
