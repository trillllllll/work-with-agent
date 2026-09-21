import { ToolService, type ToolResult } from './application/tool-registry.js';
import type { ToolCall } from './application/workspace.js';
import { ApprovalService } from './application/approval.js';
import { TaskService } from './application/workspace.js';
import { SettingsService, type ModelConfig } from './application/settings.js';
import { ContextService, ConversationService } from './application/conversation.js';
import { CommandService } from './application/commands.js';
import { ownerActor } from './application/security.js';

export type PageContext = { topicId?: string | null; taskId?: string | null; page?: string | null };
export type ChatEvent = {
  type: 'message_start' | 'message_delta' | 'message_end' | 'tool_call' | 'tool_result' | 'approval_required' | 'error' | 'done';
  conversationId?: string;
  messageId?: string;
  delta?: string;
  message?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  approvalId?: string;
  result?: ToolResult;
  code?: string;
};
type AgentContext = { pageContext: PageContext; recentTasks: unknown[]; recentMessages: Array<{ role: string; content: string }>; summary: string };
export type ModelMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; tool_call_id?: string };
export type ModelDelta = { text?: string; toolCalls?: ToolCall[] };
type ModelToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };

const modelError = (message: string, code = 'MODEL_ERROR') => Object.assign(new Error(message), { code });

export class ModelAdapter {
  constructor(private readonly settings = new SettingsService(), private readonly toolDefinitions: () => ModelToolDefinition[] = () => []) {}

  private endpoint(config: ModelConfig) { return `${config.baseUrl.replace(/\/$/, '')}/chat/completions`; }

  private async request(config: ModelConfig, messages: ModelMessage[], includeTools: boolean, stream: boolean, signal?: AbortSignal) {
    const response = await fetch(this.endpoint(config), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      signal,
      body: JSON.stringify({ model: config.model, messages, ...(includeTools ? { tools: this.toolDefinitions(), tool_choice: 'auto' } : {}), stream }),
    });
    if (!response.ok) throw modelError(`模型服务错误：${response.status}`, 'MODEL_HTTP_ERROR');
    return response;
  }

  async testConnection(config: ModelConfig) {
    const response = await this.request(config, [{ role: 'system', content: '你是连接测试助手。' }, { role: 'user', content: '请回复“连接成功”。' }], false, false);
    const payload = await response.json().catch(() => null) as any;
    if (!payload?.choices?.[0]) throw modelError('模型服务返回了无效的连接测试结果', 'MODEL_INVALID_RESPONSE');
  }

  async *stream(messages: ModelMessage[], signal?: AbortSignal, includeTools = true): AsyncGenerator<ModelDelta> {
    const config = await this.settings.credentials();
    if (!config) throw modelError('未配置模型服务，请先在设置页填写接口地址、API Key 和模型名称', 'MODEL_NOT_CONFIGURED');
    const response = await this.request(config, messages, includeTools, true, signal);
    if (!response.body) throw modelError('模型服务没有返回流', 'MODEL_EMPTY_STREAM');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let emittedToolCalls = false;
    const emitToolCalls = () => {
      if (emittedToolCalls || !toolCalls.size) return [] as ToolCall[];
      emittedToolCalls = true;
      const calls: ToolCall[] = [];
      for (const [, value] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
        let args: unknown;
        try { args = JSON.parse(value.arguments || '{}'); } catch { throw modelError(`Tool ${value.name} 的参数不是有效 JSON`, 'INVALID_TOOL_ARGUMENTS'); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw modelError(`Tool ${value.name} 的参数必须是对象`, 'INVALID_TOOL_ARGUMENTS');
        calls.push({ id: value.id, name: value.name, arguments: args as Record<string, unknown> });
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
        const delta = chunk.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') yield { text: delta.content };
        for (const item of delta?.tool_calls ?? []) {
          const index = Number(item.index ?? 0);
          const current = toolCalls.get(index) ?? { id: item.id ?? `call_${index}`, name: '', arguments: '' };
          if (item.id) current.id = item.id;
          if (item.function?.name) current.name += item.function.name;
          if (item.function?.arguments) current.arguments += item.function.arguments;
          toolCalls.set(index, current);
        }
        if (chunk.choices?.[0]?.finish_reason === 'tool_calls') {
          const calls = emitToolCalls();
          if (calls.length) yield { toolCalls: calls };
        }
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) yield* consume(frame);
      if (done) break;
    }
    if (buffer.trim()) yield* consume(buffer);
    const calls = emitToolCalls();
    if (calls.length) yield { toolCalls: calls };
  }

  async complete(messages: ModelMessage[], signal?: AbortSignal, includeTools = false) {
    let text = '';
    const toolCalls: ToolCall[] = [];
    for await (const delta of this.stream(messages, signal, includeTools)) { text += delta.text ?? ''; if (delta.toolCalls) toolCalls.push(...delta.toolCalls); }
    return { text, toolCalls };
  }
}

export class AgentService {
  private model: ModelAdapter;
  private tools: ToolService;
  private approvals = new ApprovalService();
  private conversations = new ConversationService();
  private tasks = new TaskService();
  private context: ContextService;

  constructor(model: ModelAdapter | undefined = undefined, tools = new ToolService()) { this.tools = tools; this.model = model ?? new ModelAdapter(new SettingsService(), () => this.tools.definitions()); this.context = new ContextService(this.model); }

  private async contextFor(conversationId: string, pageContext: PageContext): Promise<AgentContext> {
    await this.context.compactIfNeeded(conversationId);
    const window = await this.context.buildWindow(conversationId, pageContext);
    return {
      pageContext,
      recentTasks: window.recentTasks,
      recentMessages: window.recentMessages,
      summary: window.summary,
    };
  }

  private systemPrompt(context: AgentContext) { return `你是 Agent 工作室的协作助手。变更任务或主题必须使用工具，系统会要求用户审核。只读问题使用工具查询。当前上下文：${JSON.stringify(context)}`; }

  async *chatStream(input: { conversationId?: string; message: string; pageContext?: PageContext; signal?: AbortSignal }): AsyncGenerator<ChatEvent> {
    const conversationId = input.conversationId ?? (await this.conversations.create()).id;
    if (input.conversationId && !(await this.conversations.get(conversationId))) throw Object.assign(new Error('会话不存在'), { status: 404 });
    await this.conversations.addMessage(conversationId, 'user', input.message);
    const context = await this.contextFor(conversationId, input.pageContext ?? {});
    const messages: ModelMessage[] = [{ role: 'system', content: this.systemPrompt(context) }, ...context.recentMessages.map((item) => ({ role: item.role as ModelMessage['role'], content: item.content }))];
    for (let round = 0; round < 8; round += 1) {
      const assistantId = (await this.conversations.addMessage(conversationId, 'assistant', '', 'streaming')).id;
      yield { type: 'message_start', conversationId, messageId: assistantId };
      let text = '';
      const calls: ToolCall[] = [];
      try {
        for await (const delta of this.model.stream(messages, input.signal)) {
          if (delta.text) { text += delta.text; yield { type: 'message_delta', conversationId, messageId: assistantId, delta: delta.text }; }
          if (delta.toolCalls) calls.push(...delta.toolCalls);
        }
        await this.conversations.updateMessage(assistantId, { content: text, status: 'completed' });
        yield { type: 'message_end', conversationId, messageId: assistantId };
      } catch (error) {
        await this.conversations.updateMessage(assistantId, { content: text, status: 'failed' });
        if (error && typeof error === 'object') (error as { conversationId?: string }).conversationId ??= conversationId;
        throw error;
      }
      if (!calls.length) { yield { type: 'done', conversationId }; return; }
      calls.forEach((call, index) => { call.id ??= `call_${round}_${index}`; });
      const toolMessages: ModelMessage[] = [];
      let hasPendingApproval = false;
      for (const call of calls) {
        if (call.name === 'create_task' && call.arguments.topicId === undefined && input.pageContext?.topicId) call.arguments.topicId = input.pageContext.topicId;
        yield { type: 'tool_call', conversationId, toolName: call.name, arguments: call.arguments };
        const validationError = this.tools.validate(call);
        if (validationError) throw Object.assign(modelError(validationError, validationError.startsWith('未知 Tool') ? 'UNKNOWN_TOOL' : 'INVALID_TOOL_ARGUMENTS'), { conversationId });
        if (!this.tools.isReadOnly(call.name)) {
          const approval = await this.approvals.create(call, conversationId);
          hasPendingApproval = true;
          yield { type: 'approval_required', conversationId, toolName: call.name, arguments: call.arguments, approvalId: approval.id };
          continue;
        }
        const result = await this.tools.execute(call);
        await this.conversations.addMessage(conversationId, 'tool', JSON.stringify({ toolName: call.name, toolCallId: call.id, ...result }));
        yield { type: 'tool_result', conversationId, toolName: call.name, arguments: call.arguments, result };
        toolMessages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      // A write call is intentionally never returned to the model as if it
      // had executed. The approval endpoint owns the later side effect.
      if (hasPendingApproval) { yield { type: 'done', conversationId }; return; }
      if (!toolMessages.length) { yield { type: 'done', conversationId }; return; }
      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: calls.map((call) => ({ id: call.id ?? `call_${Math.random().toString(36).slice(2)}`, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
      });
      messages.push(...toolMessages);
    }
    throw modelError('Tool 调用轮次超过上限', 'TOOL_ROUND_LIMIT');
  }

  async chat(input: { conversationId?: string; message: string; pageContext?: PageContext; signal?: AbortSignal }) { const events: ChatEvent[] = []; for await (const event of this.chatStream(input)) events.push(event); return { conversationId: events.find((event) => event.conversationId)?.conversationId, events }; }

  async summarize(conversationId: string, text: string, signal?: AbortSignal) {
    try { const result = await this.model.complete([{ role: 'system', content: '请用简短中文说明刚才的任务变更结果，不要调用工具。' }, { role: 'user', content: text }], signal); return result.text || '变更已执行。'; } catch { return undefined; }
  }

  async testConnection(config: ModelConfig) { return this.model.testConnection(config); }

  async approve(approvalId: string) {
    const approval = await this.approvals.get(approvalId); if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 });
    const proposal = approval.result ? JSON.parse(approval.result) : null;
    if (proposal?.proposalId) {
      if (approval.status !== 'pending') throw Object.assign(new Error('该审核已处理'), { status: 409 });
      const applied = await new CommandService().approve(ownerActor, proposal.proposalId, { expectedRevision: proposal.proposalRevision, requestId: `approval:${approval.id}` });
      const result: ToolResult = { success: true, data: applied.results?.[0] };
      // The Proposal and Receipt commit with the Todo mutation. This compatibility
      // Approval row is recoverable by replaying the same receipt after a crash.
      await prismaApprovalComplete(approval.id, result);
      const assistantMessage = approval.conversationId ? await this.summarize(approval.conversationId, JSON.stringify({ toolName: approval.toolName, result })) : undefined;
      if (assistantMessage && approval.conversationId) await this.conversations.addMessage(approval.conversationId, 'assistant', assistantMessage);
      return { result, assistantMessage, summaryError: !assistantMessage ? '无法生成自动总结' : undefined };
    }
    if (!approval.toolName.startsWith('execute_')) throw Object.assign(new Error('旧审核缺少版本快照，请重新生成提议后确认'), { status: 409, code: 'APPROVAL_REPREVIEW_REQUIRED' });
    if (approval.status !== 'pending' || !(await this.approvals.claim(approvalId))) throw Object.assign(new Error('该审核已处理'), { status: 409 });
    let result: ToolResult; try { const call = this.approvals.parse(approval); const validationError = this.tools.validate(call); result = validationError ? { success: false, error: validationError } : await this.tools.execute(call, { source: 'agent', conversationId: approval.conversationId ?? undefined, approvalId: approval.id, requestId: approval.id }); } catch (error) { result = { success: false, error: error instanceof Error ? error.message : '审核执行失败' }; }
    await this.approvals.update(approvalId, result.success ? 'executed' : 'failed', result);
    let assistantMessage: string | undefined;
    if (approval.conversationId) assistantMessage = await this.summarize(approval.conversationId, JSON.stringify({ toolName: approval.toolName, result }));
    if (assistantMessage && approval.conversationId) await this.conversations.addMessage(approval.conversationId, 'assistant', assistantMessage);
    return { result, assistantMessage, summaryError: result.success && !assistantMessage ? '无法生成自动总结' : undefined };
  }
  async reject(approvalId: string) { const approval = await this.approvals.get(approvalId); if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 }); if (approval.status !== 'pending') throw Object.assign(new Error('该审核已处理'), { status: 409 }); const proposal = approval.result ? JSON.parse(approval.result) : null; if (proposal?.proposalId) await new CommandService().reject(ownerActor, proposal.proposalId, { expectedRevision: proposal.proposalRevision }); return this.approvals.update(approvalId, 'rejected'); }
  async previewApproval(approvalId: string) { return this.approvals.preview(approvalId); }
  async messages(conversationId: string) { if (!(await this.conversations.get(conversationId))) throw Object.assign(new Error('会话不存在'), { status: 404 }); return this.conversations.listMessages(conversationId); }
  async approvalList(status?: string) { if (status && !['pending', 'approved', 'rejected', 'executed', 'failed'].includes(status)) throw Object.assign(new Error('审核状态无效'), { status: 400 }); return this.approvals.list(status as any); }
}

async function prismaApprovalComplete(id: string, result: ToolResult) {
  const { prisma } = await import('./infrastructure/prisma.js');
  await prisma.approval.update({ where: { id }, data: { status: 'executed', result: JSON.stringify(result), updatedAt: new Date().toISOString() } });
}
