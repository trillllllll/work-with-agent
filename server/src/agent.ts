import { parseMessageBlocks, projectBlocks } from './agent/content-blocks.js';
import type { ChatContextV2, ChatContextV3 } from './agent/chat-context.js';
import type { AssistantSource } from './agent/assistant-sources.js';
import { createHash } from 'node:crypto';
import { ToolService, type ToolResult } from './application/tool-registry.js';
import type { ToolCall } from './application/workspace.js';
import { ApprovalService } from './application/approval.js';
import { ChangeService, TaskService } from './application/workspace.js';
import { SettingsService, type ModelConfig } from './application/settings.js';
import { ContextService, ConversationService } from './application/conversation.js';
import { CommandService, canonical } from './application/commands.js';
import { ownerActor } from './application/security.js';
import { checkKnowledgeScope } from './application/knowledge.js';
import { appendAutoMemoryAssistant, beginAutoMemoryTurn, completeAutoMemoryTurn, failAutoMemoryTurn } from './application/auto-memory-chat.js';
import { prisma } from './infrastructure/prisma.js';
import { DomainError } from './domain/task.js';
import { readStoredApproval, type TaskBatchPreview } from './domain/task-batch-types.js';
import { approveTaskBatch, prepareTaskBatch, rejectTaskBatch, taskBatchCommitError } from './application/chat-task-batch.js';
import { builtinToolDefinitions } from './agent/capabilities.js';
import { approveAppChanges, readEnvelope, rejectAppChanges, repreviewApproval, undoPreview, type DecisionInput } from './agent/decision.js';
import { activeRunView, followRun, resumeRun, runEvents, runView, scheduleRun, startChat, startRunScheduler, stopRun } from './agent/runs.js';
import { approvalView } from './agent/views.js';

export type PageContext = { topicId?: string | null; taskId?: string | null; page?: string | null };
export type ChatEvent = {
  contextStats?: import('./agent/context-stats.js').ContextStats;
  context?: ChatContextV2 | ChatContextV3;
  sources?: AssistantSource[];
  type: 'context_stats' | 'block_start' | 'block_delta' | 'block_commit' | 'block_error' | 'user_context' | 'sources' | 'message_start' | 'message_delta' | 'message_end' | 'tool_call' | 'tool_result' | 'approval_required' | 'approval_resolved' | 'run_state' | 'external_prompt' | 'error' | 'done';
  conversationId?: string;
  messageId?: string;
  delta?: string;
  message?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  approvalId?: string;
  result?: ToolResult;
  code?: string;
  toolCallId?: string;
  preview?: TaskBatchPreview;
  runId?: string;
  seq?: number;
  state?: string;
  pauseReason?: string | null;
  blockId?: string;
  index?: number;
  blockType?: import('./agent/content-blocks.js').ContentBlock['type'];
  block?: import('./agent/content-blocks.js').ContentBlock;
  offset?: number;
  compatibilityProjection?: boolean;
  status?: 'completed' | 'failed';
  part?: unknown;
  review?: unknown;
  proposalId?: string;
  proposalRevision?: number;
  previewHash?: string;
};
export type ModelContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type ModelMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | ModelContentPart[] | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; tool_call_id?: string };

function serializeToolCalls(calls: ToolCall[]) {
  return JSON.stringify(calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } })));
}
export type ModelToolDelta = { index: number; id: string; name: string; argumentsDelta: string };
export type ModelUsage = { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; model?: string };
export type ModelDelta = { text?: string; toolCalls?: ToolCall[]; toolDelta?: ModelToolDelta; usage?: ModelUsage };

function readUsage(chunk: any, model: string): ModelUsage | undefined {
  const usage = chunk?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const cached = usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  if (typeof input !== 'number' && typeof output !== 'number' && typeof cached !== 'number') return undefined;
  return {
    ...(typeof input === 'number' ? { inputTokens: input } : {}),
    ...(typeof output === 'number' ? { outputTokens: output } : {}),
    ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}),
    model,
  };
}
export type ModelToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };

const modelError = (message: string, code = 'MODEL_ERROR') => Object.assign(new Error(message), { code });

export class ModelAdapter {
  constructor(private readonly settings = new SettingsService(), private readonly toolDefinitions: () => ModelToolDefinition[] = () => []) {}

  private endpoint(config: ModelConfig) { return `${config.baseUrl.replace(/\/$/, '')}/chat/completions`; }

  private async request(config: ModelConfig, messages: ModelMessage[], includeTools: boolean, stream: boolean, signal?: AbortSignal, tools?: ModelToolDefinition[]) {
    const response = await fetch(this.endpoint(config), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      signal,
      body: JSON.stringify({ model: config.model, messages, ...(includeTools ? { tools: tools ?? this.toolDefinitions(), tool_choice: 'auto' } : {}), stream, ...(stream ? { stream_options: { include_usage: true } } : {}) }),
    });
    if (!response.ok) throw modelError(`模型服务错误：${response.status}`, 'MODEL_HTTP_ERROR');
    return response;
  }

  async testConnection(config: ModelConfig) {
    const response = await this.request(config, [{ role: 'system', content: '你是连接测试助手。' }, { role: 'user', content: '请回复“连接成功”。' }], false, false);
    const payload = await response.json().catch(() => null) as any;
    if (!payload?.choices?.[0]) throw modelError('模型服务返回了无效的连接测试结果', 'MODEL_INVALID_RESPONSE');
  }

  async *stream(messages: ModelMessage[], signal?: AbortSignal, includeTools = true, tools?: ModelToolDefinition[], identityId?: string): AsyncGenerator<ModelDelta> {
    const config = await this.settings.credentials(identityId);
    if (!config) throw modelError('未配置模型服务，请先在设置页填写接口地址、API Key 和模型名称', 'MODEL_NOT_CONFIGURED');
    const response = await this.request(config, messages, includeTools, true, signal, tools);
    if (!response.body) throw modelError('模型服务没有返回流', 'MODEL_EMPTY_STREAM');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let emittedToolCalls = false;
    let argumentBytes = 0;
    const emitToolCalls = () => {
      if (emittedToolCalls || !toolCalls.size) return [] as ToolCall[];
      emittedToolCalls = true;
      const calls: ToolCall[] = [];
      for (const [, value] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
        let args: unknown;
        let invalidArguments = false;
        try { args = JSON.parse(value.arguments || '{}'); } catch { invalidArguments = true; }
        if (!args || typeof args !== 'object' || Array.isArray(args)) invalidArguments = true;
        calls.push({ id: value.id, name: value.name, arguments: invalidArguments ? {} : args as Record<string, unknown>, ...(invalidArguments ? { invalidArguments: true } : {}) });
      }
      return calls;
    };
    const consume = async function* (frame: string): AsyncGenerator<ModelDelta> {
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk: any;
        try { chunk = JSON.parse(payload); } catch { throw modelError('模型返回了无效 SSE JSON', 'MODEL_INVALID_STREAM'); }
        if ((chunk.choices ?? []).some((choice: any) => choice.index !== undefined && choice.index !== 0)) throw modelError('不支持多 choice 交错的回复', 'MODEL_INVALID_STREAM');
        const delta = chunk.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') yield { text: delta.content };
        for (const item of delta?.tool_calls ?? []) {
          const index = Number(item.index ?? 0);
          if (!Number.isInteger(index) || index < 0 || index >= 32) throw modelError('工具调用索引超出限制', 'MODEL_INVALID_STREAM');
          argumentBytes += Buffer.byteLength(item.function?.arguments ?? '');
          if (argumentBytes > 512 * 1024) throw modelError('累计工具参数超过大小限制', 'MODEL_INVALID_STREAM');
          const current = toolCalls.get(index) ?? { id: item.id ?? `call_${index}`, name: '', arguments: '' };
          if (item.id) current.id = item.id;
          if (item.function?.name) current.name += item.function.name;
          if (item.function?.arguments) current.arguments += item.function.arguments;
          if (current.arguments.length > 512 * 1024) throw modelError('工具参数超过大小限制', 'MODEL_INVALID_STREAM');
          toolCalls.set(index, current);
          yield { toolDelta: { index, id: current.id, name: current.name, argumentsDelta: item.function?.arguments ?? '' } };
        }
        if (chunk.choices?.[0]?.finish_reason === 'tool_calls') {
          const calls = emitToolCalls();
          if (calls.length) yield { toolCalls: calls };
        }
        const usage = readUsage(chunk, config.model);
        if (usage) yield { usage };
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      if (buffer.length > 1024 * 1024) throw modelError('模型 SSE 帧超过大小限制', 'MODEL_INVALID_STREAM');
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) yield* consume(frame);
      if (done) break;
    }
    if (buffer.trim()) yield* consume(buffer);
    const calls = emitToolCalls();
    if (calls.length) yield { toolCalls: calls };
  }

  async complete(messages: ModelMessage[], signal?: AbortSignal, includeTools = false, tools?: ModelToolDefinition[]) {
    let text = '';
    const toolCalls: ToolCall[] = [];
    const usage: ModelUsage = {};
    let sawUsage = false;
    for await (const delta of this.stream(messages, signal, includeTools, tools)) {
      text += delta.text ?? '';
      if (delta.toolCalls) toolCalls.push(...delta.toolCalls);
      if (delta.usage) {
        sawUsage = true;
        for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens'] as const) if (typeof delta.usage[key] === 'number') usage[key] = (usage[key] ?? 0) + delta.usage[key]!;
        if (delta.usage.model) usage.model = delta.usage.model;
      }
    }
    return { text, toolCalls, ...(sawUsage ? { usage } : {}) };
  }
}

export class AgentService {
  private model: ModelAdapter;
  private tools: ToolService;
  private approvals = new ApprovalService();
  private conversations = new ConversationService();
  private tasks = new TaskService();
  private context: ContextService;

  private stopRuns: (() => void) | null = null;

  constructor(model: ModelAdapter | undefined = undefined, tools = new ToolService()) { this.tools = tools; this.model = model ?? new ModelAdapter(new SettingsService(), () => builtinToolDefinitions()); this.context = new ContextService(this.model); }

  private streamModel(messages: ModelMessage[], signal?: AbortSignal, includeTools = true, tools?: ModelToolDefinition[], identityId?: string) { return this.model.stream(messages, signal, includeTools, tools, identityId); }

  async boot() {
    this.stopRuns?.();
    this.stopRuns = startRunScheduler((messages, signal, includeTools, tools, identityId) => this.streamModel(messages, signal, includeTools ?? true, tools, identityId), this.context);
  }

  stopScheduler() { this.stopRuns?.(); this.stopRuns = null; }

  async *chatStream(input: { conversationId?: string; message: string; pageContext?: PageContext; context?: unknown; requestKey?: string; identityId?: string; signal?: AbortSignal }): AsyncGenerator<ChatEvent> {
    const run = await startChat(input);
    if (run.state === 'queued') scheduleRun(run.id, (messages, signal, includeTools, tools, identityId) => this.streamModel(messages, signal, includeTools ?? true, tools, identityId), this.context);
    yield* followRun(run.id);
    return;
  }

  async chat(input: { conversationId?: string; message: string; pageContext?: PageContext; context?: unknown; requestKey?: string; identityId?: string; signal?: AbortSignal }) { const events: ChatEvent[] = []; for await (const event of this.chatStream(input)) events.push(event); return { conversationId: events.find((event) => event.conversationId)?.conversationId, events }; }

  async summarize(conversationId: string, text: string, signal?: AbortSignal) {
    try { const result = await this.model.complete([{ role: 'system', content: '请用简短中文说明刚才的任务变更结果，不要调用工具。' }, { role: 'user', content: text }], signal); return result.text || '变更已执行。'; } catch { return undefined; }
  }

  async testConnection(config: ModelConfig) { return this.model.testConnection(config); }

  private async recordResolvedTool(conversationId: string | null | undefined, toolName: string, toolCallId: string | undefined, result: ToolResult) {
    if (!conversationId || !toolCallId) return;
    await this.conversations.addMessage(conversationId, 'tool', JSON.stringify({ toolName, toolCallId, ...result }), 'completed', { toolCallId });
  }

  async approve(approvalId: string, input: DecisionInput = {}): Promise<any> {
    const approval = await this.approvals.get(approvalId); if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 });
    if (approval.toolName.startsWith('execute_')) throw new DomainError('CAPABILITY_REMOVED', '此能力已移出内置 AI', 409);
    const envelope = readEnvelope(approval.result);
    if (envelope) {
      const body = await approveAppChanges(approvalId, input);
      if (body && typeof body === 'object' && (body as { resumed?: boolean }).resumed) scheduleRun(envelope.runId, (messages, signal, includeTools, tools, identityId) => this.streamModel(messages, signal, includeTools ?? true, tools, identityId), this.context);
      return { approval: await approvalView(approvalId), run: await runView(envelope.runId), ...(body as object) };
    }
    if (readStoredApproval(approval.result).resultState === 'batch') return approveTaskBatch(approvalId);
    const proposal = approval.result ? JSON.parse(approval.result) : null;
    const toolCallId = typeof proposal?.toolCallId === 'string' ? proposal.toolCallId : undefined;
    if (approval.toolName === 'library' && typeof proposal?.undoChangeId === 'string') {
      if (approval.status !== 'pending') throw Object.assign(new Error('该审核已处理'), { status: 409 });
      const undone = await new ChangeService().undo(proposal.undoChangeId, { source: 'user', actor: ownerActor, conversationId: approval.conversationId ?? undefined, approvalId: approval.id });
      const result: ToolResult = { success: true, data: undone };
      await prismaApprovalComplete(approval.id, result);
      await this.recordResolvedTool(approval.conversationId, approval.toolName, toolCallId, result);
      const assistantMessage = approval.conversationId ? await this.summarize(approval.conversationId, JSON.stringify({ toolName: approval.toolName, result })) : undefined;
      if (assistantMessage && approval.conversationId) await this.conversations.addMessage(approval.conversationId, 'assistant', assistantMessage);
      return { result, assistantMessage, summaryError: !assistantMessage ? '无法生成自动总结' : undefined };
    }
    if (proposal?.proposalId) {
      if (approval.status !== 'pending') throw Object.assign(new Error('该审核已处理'), { status: 409 });
      const applied = await new CommandService().approve(ownerActor, proposal.proposalId, { expectedRevision: proposal.proposalRevision, requestId: `approval:${approval.id}` });
      const results = Array.isArray(applied.results) ? applied.results : [];
      const result: ToolResult = { success: true, data: results.length > 1 ? results[results.length - 1] : results[0] };
      // The Proposal and Receipt commit with the Todo mutation. This compatibility
      // Approval row is recoverable by replaying the same receipt after a crash.
      await prismaApprovalComplete(approval.id, result);
      await this.recordResolvedTool(approval.conversationId, approval.toolName, toolCallId, result);
      const assistantMessage = approval.conversationId ? await this.summarize(approval.conversationId, JSON.stringify({ toolName: approval.toolName, result })) : undefined;
      if (assistantMessage && approval.conversationId) await this.conversations.addMessage(approval.conversationId, 'assistant', assistantMessage);
      return { result, assistantMessage, summaryError: !assistantMessage ? '无法生成自动总结' : undefined };
    }
    throw new DomainError('APPROVAL_REPREVIEW_REQUIRED', '这份历史方案需要先重新生成预览，才能确认', 409);
  }
  async reject(approvalId: string, input: DecisionInput = {}): Promise<any> {
    const approval = await this.approvals.get(approvalId); if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 });
    const envelope = readEnvelope(approval.result);
    if (envelope) {
      const body = await rejectAppChanges(approvalId, input);
      return { approval: await approvalView(approvalId), run: envelope.runId ? await runView(envelope.runId) : null, ...(body as object) };
    }
    if (approval.toolName.startsWith('execute_')) {
      if (approval.status !== 'pending') throw Object.assign(new Error('该审核已处理'), { status: 409 });
      return this.approvals.update(approvalId, 'rejected');
    }
    if (readStoredApproval(approval.result).resultState === 'batch') return rejectTaskBatch(approvalId);
    if (approval.status !== 'pending') throw Object.assign(new Error('该审核已处理'), { status: 409 });
    const proposal = approval.result ? JSON.parse(approval.result) : null;
    if (proposal?.proposalId) await new CommandService().reject(ownerActor, proposal.proposalId, { expectedRevision: proposal.proposalRevision });
    await this.recordResolvedTool(approval.conversationId, approval.toolName, typeof proposal?.toolCallId === 'string' ? proposal.toolCallId : undefined, { success: false, error: '用户拒绝，数据未修改' }); // i18n-ignore: protocol text; the client matches it (userRejectedError)
    return this.approvals.update(approvalId, 'rejected');
  }
  async previewApproval(approvalId: string) { return this.approvals.preview(approvalId); }
  async getRun(runId: string) { const run = await runView(runId); if (!run) throw Object.assign(new Error('请求不存在'), { status: 404 }); return run; }
  async listRunEvents(runId: string, after = 0) { return runEvents(runId, after); }
  async resume(runId: string) { const run = await resumeRun(runId, (messages, signal, includeTools, tools) => this.streamModel(messages, signal, includeTools ?? true, tools), this.context); return runView(run.id); }
  async stop(runId: string) { const run = await stopRun(runId); return runView(run.id); }
  async getApproval(approvalId: string) { const approval = await approvalView(approvalId); if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 }); return { approval, run: approval.runId ? await runView(approval.runId) : null }; }
  async repreview(approvalId: string, input: { requestKey?: string } = {}) { return repreviewApproval(approvalId, input); }
  async activeRun(conversationId: string) { return activeRunView(conversationId); }
  async prepareUndo(approvalId: string) { return undoPreview(approvalId); }
  async requestByKey(requestKey: string) {
    const run = await prisma.agentRun.findUnique({ where: { requestKey }, select: { id: true, conversationId: true, state: true, sourceUserMessageId: true, contextJson: true } });
    if (!run) return null;
    const message = await prisma.message.findUnique({ where: { id: run.sourceUserMessageId }, select: { content: true } });
    const context = JSON.parse(run.contextJson) as { attachments?: Array<{ id: string }> };
    return { id: run.id, conversationId: run.conversationId, state: run.state, message: message?.content || '', attachmentIds: context.attachments?.map((item) => item.id) || [] };
  }
  async conversationList(cursor?: string, identityId?: string) {
    const rows = await prisma.conversation.findMany({
      take: 31, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      where: identityId ? { identityId } : undefined,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, identityId: true, createdAt: true, messages: { where: { role: 'user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1, select: { content: true } } },
    });
    return { items: rows.slice(0, 30).map((row) => ({ id: row.id, identityId: row.identityId, createdAt: row.createdAt, title: row.messages[0]?.content.slice(0, 100) || '新对话' })), nextCursor: rows.length > 30 ? rows[29].id : null };
  }
  async messages(conversationId: string) { return (await this.snapshot(conversationId)).messages; }
  async snapshot(conversationId: string) {
    return prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id: conversationId } });
      if (!conversation) throw Object.assign(new Error('会话不存在'), { status: 404 });
      const messages = await tx.message.findMany({ where: { conversationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const runs = await tx.agentRun.findMany({ where: { conversationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, state: true, pauseReason: true, nextEventSeq: true, sourceUserMessageId: true, contextJson: true, cursorJson: true } });
      const approvals = await tx.approval.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } });
      const active = runs.find((run) => run.id === conversation.activeRunId) ?? null;
      const contextEvent = active
        ? await tx.agentRunEvent.findFirst({ where: { runId: active.id, type: 'context_stats' }, orderBy: { seq: 'desc' }, select: { dataJson: true } })
        : await tx.agentRunEvent.findFirst({ where: { runId: { in: runs.map(run => run.id) }, type: 'context_stats' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { dataJson: true } });
      const liveMessageId = active && ['queued', 'running'].includes(active.state) ? (JSON.parse(active.cursorJson) as { assistantMessageId?: string }).assistantMessageId : null;
      const contexts = new Map(runs.map((run) => [run.sourceUserMessageId, (() => { const { timeZoneSource, ...context } = JSON.parse(run.contextJson); return context; })()]));
      return {
        identityId: conversation.identityId,
        messages: messages.map((message) => {
          const stale = message.status !== 'streaming' || message.id !== liveMessageId;
          const blocks = parseMessageBlocks(message.blocksJson).map((block) => stale && block.status === 'pending' ? { ...block, status: 'error' as const, error: '回复已中断，内容未完成' } : block);
          return ({ ...message,
          ...(blocks.length ? { blocksJson: JSON.stringify({ schemaVersion: 1, blocks }), content: projectBlocks(blocks) } : {}),
          status: message.status === 'streaming' && message.id !== liveMessageId ? 'completed' : message.status,
          ...(message.role === 'user' ? { context: contexts.get(message.id) ?? null } : {}),
          sources: (JSON.parse(message.partsJson || '[]') as Array<{ type: string; sources?: AssistantSource[] }>).filter((part) => part.type === 'assistant_sources').flatMap((part) => part.sources ?? []),
        }); }),
        approvals,
        contextStats: contextEvent ? JSON.parse(contextEvent.dataJson).contextStats : null,
        watermarks: Object.fromEntries(runs.map((run) => [run.id, run.nextEventSeq])),
        activeRun: active ? { id: active.id, state: active.state, pauseReason: active.pauseReason } : null,
      };
    });
  }
  async approvalList(status?: string) { if (status && !['pending', 'approved', 'rejected', 'executed', 'failed'].includes(status)) throw Object.assign(new Error('审核状态无效'), { status: 400 }); return this.approvals.list(status as any); }
}

async function prismaApprovalComplete(id: string, result: ToolResult) {
  const { prisma } = await import('./infrastructure/prisma.js');
  await prisma.approval.update({ where: { id }, data: { status: 'executed', result: JSON.stringify(result), updatedAt: new Date().toISOString() } });
}
