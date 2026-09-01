import { ApprovalService, ConversationService, TaskService, ToolService, type ToolCall, type ToolResult } from './services.js';

export type PageContext = { topicId?: string | null; taskId?: string | null; page?: string | null };
export type ChatEvent = {
  type: 'message' | 'tool_result' | 'approval_required';
  message?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  approvalId?: string;
  result?: ToolResult;
};
type AgentContext = {
  pageContext: PageContext;
  recentTasks: unknown[];
  recentMessages: Array<{ role: string; content: string }>;
  summary: string;
};

export type ModelCompletion = { text: string; toolCalls: ToolCall[] };

export class ModelAdapter {
  async complete(message: string, context: AgentContext, signal?: AbortSignal): Promise<ModelCompletion> {
    const baseUrl = process.env.OPENAI_BASE_URL;
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL;
    if (baseUrl && apiKey && model) {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal,
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: '你是 Agent 工作室的协作助手。需要改变任务或主题时，只使用已注册的工具。只读问题直接回答。所有变更都等待用户审核。',
            },
            { role: 'user', content: JSON.stringify({ message, context }) },
          ],
          tools: new ToolService().definitions(),
          tool_choice: 'auto',
        }),
      });
      if (!response.ok) throw new Error(`模型服务错误：${response.status}`);
      const payload = await response.json() as any;
      const assistant = payload.choices?.[0]?.message;
      const toolCalls: ToolCall[] = [];
      for (const rawCall of assistant?.tool_calls ?? []) {
        const name = rawCall?.function?.name;
        if (typeof name !== 'string') throw new Error('模型返回了无效的 Tool 名称');
        let args: unknown;
        try {
          args = JSON.parse(rawCall?.function?.arguments || '{}');
        } catch {
          throw new Error(`Tool ${name} 的参数不是有效 JSON`);
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`Tool ${name} 的参数必须是对象`);
        toolCalls.push({ name, arguments: args as Record<string, unknown> });
      }
      return { text: typeof assistant?.content === 'string' ? assistant.content : '', toolCalls };
    }
    return this.localFallback(message, context);
  }

  private localFallback(message: string, context: AgentContext): ModelCompletion {
    const trimmed = message.trim();
    const create = trimmed.match(/^(?:创建|新建)(?:一个)?任务[：: ](.+)$/i);
    if (create) return {
      text: `我准备创建任务“${create[1]}”，请审核这次变更。`,
      toolCalls: [{ name: 'create_task', arguments: { title: create[1], ...(context.pageContext.topicId ? { topicId: context.pageContext.topicId } : {}) } }],
    };
    if (/任务|待办|进度|有哪些/.test(trimmed)) return {
      text: '我先读取当前工作上下文中的任务。',
      toolCalls: [{ name: 'list_tasks', arguments: context.pageContext.topicId ? { topicId: context.pageContext.topicId } : {} }],
    };
    return { text: '我可以帮你查看任务，或创建任务。例如：“创建任务：整理 API 文档”。', toolCalls: [] };
  }
}

export class AgentService {
  private model: ModelAdapter;
  private tools: ToolService;
  private approvals: ApprovalService;
  private conversations: ConversationService;
  private tasks: TaskService;

  constructor(model = new ModelAdapter(), tools = new ToolService()) {
    this.model = model;
    this.tools = tools;
    this.approvals = new ApprovalService();
    this.conversations = new ConversationService();
    this.tasks = new TaskService();
  }

  private async contextFor(conversationId: string, pageContext: PageContext): Promise<AgentContext> {
    const conversation = await this.conversations.get(conversationId);
    if (!conversation) throw Object.assign(new Error('会话不存在'), { status: 404 });
    const messages = await this.conversations.listMessages(conversationId);
    const maxRecent = 12;
    let recentMessages = messages;
    let summary = conversation.summary;
    if (messages.length > maxRecent) {
      const old = messages.slice(0, -maxRecent);
      const generated = old.map((item) => `${item.role}: ${item.content}`).join('\n').slice(-4000);
      summary = summary ? `${summary}\n${generated}`.slice(-6000) : generated;
      await this.conversations.updateSummary(conversationId, summary);
      recentMessages = messages.slice(-maxRecent);
    }
    const recentTasks = (await this.tasks.list(pageContext.topicId ?? undefined)).slice(0, 8);
    return {
      pageContext,
      recentTasks,
      recentMessages: recentMessages.map(({ role, content }) => ({ role, content })),
      summary,
    };
  }

  async chat(input: { conversationId?: string; message: string; pageContext?: PageContext; signal?: AbortSignal }) {
    const conversationId = input.conversationId ?? (await this.conversations.create()).id;
    if (input.conversationId && !(await this.conversations.get(conversationId))) throw Object.assign(new Error('会话不存在'), { status: 404 });
    await this.conversations.addMessage(conversationId, 'user', input.message);
    const context = await this.contextFor(conversationId, input.pageContext ?? {});
    const completion = await this.model.complete(input.message, context, input.signal);
    const events: ChatEvent[] = [];
    if (completion.text) {
      await this.conversations.addMessage(conversationId, 'assistant', completion.text);
      events.push({ type: 'message', message: completion.text });
    }
    for (const call of completion.toolCalls) {
      if (call.name === 'create_task' && !call.arguments.topicId && input.pageContext?.topicId) call.arguments.topicId = input.pageContext.topicId;
      const validationError = this.tools.validate(call);
      if (validationError) {
        const result = { success: false, error: validationError };
        await this.conversations.addMessage(conversationId, 'tool', JSON.stringify({ toolName: call.name, ...result }));
        events.push({ type: 'tool_result', toolName: call.name, arguments: call.arguments, result });
        continue;
      }
      if (this.tools.isReadOnly(call.name)) {
        const result = await this.tools.execute(call);
        await this.conversations.addMessage(conversationId, 'tool', JSON.stringify({ toolName: call.name, ...result }));
        events.push({ type: 'tool_result', toolName: call.name, arguments: call.arguments, result });
        continue;
      }
      const approval = await this.approvals.create(call);
      events.push({ type: 'approval_required', toolName: call.name, arguments: call.arguments, approvalId: approval.id });
    }
    return { conversationId, events };
  }

  async approve(approvalId: string) {
    const approval = await this.approvals.get(approvalId);
    if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 });
    if (approval.status !== 'pending' || !(await this.approvals.claim(approvalId))) throw Object.assign(new Error('该审核已处理'), { status: 409 });
    let result: ToolResult;
    try {
      const call = this.approvals.parse(approval);
      const validationError = this.tools.validate(call);
      result = validationError ? { success: false, error: validationError } : await this.tools.execute(call);
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : '审核执行失败' };
    }
    await this.approvals.update(approvalId, result.success ? 'executed' : 'failed', result);
    return result;
  }

  async reject(approvalId: string) {
    const approval = await this.approvals.get(approvalId);
    if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 });
    if (approval.status !== 'pending') throw Object.assign(new Error('该审核已处理'), { status: 409 });
    return this.approvals.update(approvalId, 'rejected');
  }

  async messages(conversationId: string) {
    if (!(await this.conversations.get(conversationId))) throw Object.assign(new Error('会话不存在'), { status: 404 });
    return this.conversations.listMessages(conversationId);
  }

  async approvalList(status?: string) {
    if (status && !['pending', 'approved', 'rejected', 'executed', 'failed'].includes(status)) throw Object.assign(new Error('审核状态无效'), { status: 400 });
    return this.approvals.list(status as any);
  }
}
