export type ChatMessage = {
  id?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  status?: 'streaming' | 'completed' | 'failed';
};

export type Approval = {
  approvalId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status?: string;
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
  result?: ToolResult;
  code?: string;
};

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

export function applyMessageEvent(messages: ChatMessage[], event: SseEvent): ChatMessage[] {
  if (event.type === 'message_start') return [...messages, { id: event.messageId, role: 'assistant', content: '', status: 'streaming' }];
  if (event.type === 'message_delta') {
    const index = event.messageId ? messages.findIndex((item) => item.id === event.messageId) : messages.length - 1;
    if (index < 0 || messages[index].role !== 'assistant') return messages;
    return messages.map((item, itemIndex) => itemIndex === index ? { ...item, content: item.content + (event.delta ?? ''), status: 'streaming' } : item);
  }
  if (event.type === 'message_end') return messages.map((item) => item.id === event.messageId ? { ...item, status: 'completed' } : item);
  if (event.type === 'tool_result') return [...messages, { role: 'tool', content: event.result?.success ? JSON.stringify(event.result.data, null, 2) : event.result?.error ?? 'Tool 执行失败' }];
  if (event.type === 'error') return messages.map((item) => item.status === 'streaming' ? { ...item, status: 'failed' } : item);
  return messages;
}

export function applyApprovalEvent(approvals: Approval[], event: SseEvent): Approval[] {
  if (event.type !== 'approval_required' || !event.approvalId) return approvals;
  const next = { approvalId: event.approvalId, toolName: event.toolName ?? '', arguments: event.arguments ?? {} };
  return [...approvals.filter((item) => item.approvalId !== next.approvalId), next];
}
