import { ApprovalService, ConversationService, TaskService, ToolService, type ToolCall, type ToolResult } from './services.js';

export type PageContext = { topicId?: string | null; taskId?: string | null; page?: string | null };
export type ChatEvent = { type: 'message' | 'tool_result' | 'approval_required'; message?: string; toolName?: string; arguments?: Record<string, unknown>; approvalId?: string; result?: ToolResult };

class ModelAdapter {
  async complete(message: string, context: unknown[]): Promise<{ text: string; toolCall?: ToolCall }> {
    const baseUrl = process.env.OPENAI_BASE_URL;
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL;
    if (baseUrl && apiKey && model) {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages: [{ role: 'system', content: '你是 Agent 工作室的协作助手。需要改变任务或主题时，只返回一个 JSON Tool 调用。只读问题直接回答。' }, { role: 'user', content: JSON.stringify({ message, context }) }] }) });
      if (!response.ok) throw new Error(`模型服务错误：${response.status}`);
      const payload = await response.json() as any; const assistant = payload.choices?.[0]?.message;
      const rawCall = assistant?.tool_calls?.[0];
      if (rawCall) return { text: assistant.content ?? `准备调用 ${rawCall.function.name}`, toolCall: { name: rawCall.function.name, arguments: JSON.parse(rawCall.function.arguments || '{}') } };
      return { text: assistant?.content ?? '模型没有返回内容' };
    }
    return this.localFallback(message, context);
  }
  private localFallback(message: string, context: any[]): { text: string; toolCall?: ToolCall } {
    const trimmed = message.trim(); const create = trimmed.match(/^(?:创建|新建)(?:一个)?任务[：: ](.+)$/i);
    if (create) return { text: `我准备创建任务“${create[1]}”，请审核这次变更。`, toolCall: { name: 'create_task', arguments: { title: create[1], topicId: context[0]?.topicId } } };
    if (/任务|待办|进度|有哪些/.test(trimmed)) return { text: '我先读取当前工作上下文中的任务。', toolCall: { name: 'list_tasks', arguments: { topicId: context[0]?.topicId } } };
    return { text: '我可以帮你查看任务，或创建任务。例如：“创建任务：整理 API 文档”。' };
  }
}

export class AgentService {
  private model = new ModelAdapter(); private tools = new ToolService(); private approvals = new ApprovalService(); private conversations = new ConversationService(); private tasks = new TaskService();
  async chat(input: { conversationId?: string; message: string; pageContext?: PageContext }) {
    const conversationId = input.conversationId ?? this.conversations.create(); this.conversations.addMessage(conversationId, 'user', input.message);
    const recentTasks = this.tasks.list(input.pageContext?.topicId ?? undefined).slice(0, 8);
    const context = [{ topicId: input.pageContext?.topicId ?? null, taskId: input.pageContext?.taskId ?? null, page: input.pageContext?.page ?? null }, { recentTasks }];
    const completion = await this.model.complete(input.message, context); const events: ChatEvent[] = [];
    if (completion.text) { this.conversations.addMessage(conversationId, 'assistant', completion.text); events.push({ type: 'message', message: completion.text }); }
    if (!completion.toolCall) return { conversationId, events };
    const call = completion.toolCall;
    if (call.name === 'create_task' && !call.arguments.topicId && input.pageContext?.topicId) call.arguments.topicId = input.pageContext.topicId;
    if (this.tools.isReadOnly(call.name)) { const result = await this.tools.execute(call); this.conversations.addMessage(conversationId, 'tool', JSON.stringify(result)); events.push({ type: 'tool_result', toolName: call.name, arguments: call.arguments, result }); return { conversationId, events }; }
    const approval = this.approvals.create(call); events.push({ type: 'approval_required', toolName: call.name, arguments: call.arguments, approvalId: approval?.id }); return { conversationId, events };
  }
  approve(approvalId: string) { const approval = this.approvals.get(approvalId); if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 }); if (approval.status !== 'pending') throw Object.assign(new Error('该审核已处理'), { status: 409 }); return this.tools.execute({ name: approval.toolName, arguments: approval.arguments }).then((result) => { this.approvals.update(approvalId, result.success ? 'executed' : 'failed', result); return result; }); }
  reject(approvalId: string) { const approval = this.approvals.get(approvalId); if (!approval) throw Object.assign(new Error('审核记录不存在'), { status: 404 }); if (approval.status !== 'pending') throw Object.assign(new Error('该审核已处理'), { status: 409 }); return this.approvals.update(approvalId, 'rejected'); }
}
