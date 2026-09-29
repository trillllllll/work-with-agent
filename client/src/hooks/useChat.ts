import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { applyApprovalEvent, applyMessageEvent, pairToolMessages, toolPreview, type Approval, type ChatMessage, type ToolActivityStatus, type ToolResult } from '../chat.js';
import { ApiError, api, parseApproval, streamChat, type ApprovalResponse, type View } from '../lib/api.js';
import { invalidateTodo } from './useTodo.js';

export type { View };

type UseChatOptions = {
  selectedTopicId: string;
  taskId?: string;
  view: View;
  onError: (message: string) => void;
};

export function useChat({ selectedTopicId, taskId = '', view, onError }: UseChatOptions) {
  const queryClient = useQueryClient();
  const onErrorRef = useRef(onError);
  const newConversationRef = useRef('');
  onErrorRef.current = onError;
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string>(() => localStorage.getItem('agent-studio.conversationId') ?? '');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [busy, setBusy] = useState(false);
  const [interrupted, setInterrupted] = useState(false);

  const invalidate = () => { void invalidateTodo(queryClient); };

  useEffect(() => {
    if (!conversationId) return;
    localStorage.setItem('agent-studio.conversationId', conversationId);
    if (newConversationRef.current === conversationId) {
      newConversationRef.current = '';
      return;
    }
    Promise.all([api(`/api/conversations/${conversationId}/messages`), api('/api/agent/approvals?status=pending')]).then(([history, pending]) => {
      const approvals = pending.map(parseApproval);
      setMessages(pairToolMessages(history.map((message: ChatMessage) => ({ id: message.id, role: message.role, content: message.content, status: message.status, toolCalls: message.toolCalls, toolCallId: message.toolCallId })), approvals));
      setApprovals((current) => {
        const merged = new Map(current.map((item) => [item.approvalId, item]));
        pending.map(parseApproval).forEach((item: Approval) => merged.set(item.approvalId, item));
        return [...merged.values()];
      });
    }).catch((reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 404) {
        localStorage.removeItem('agent-studio.conversationId');
        setConversationId('');
        setMessages([]);
        return;
      }
      onErrorRef.current(reason instanceof Error ? reason.message : '会话读取失败');
    });
  }, [conversationId]);

  const settleTool = (tool: NonNullable<ChatMessage['tools']>[number], status: ToolActivityStatus, result?: ToolResult) => ({
    ...tool,
    status,
    preview: toolPreview(tool.name, tool.arguments, result, status),
    ...(result?.data !== undefined ? { result: result.data } : {}),
    ...(status === 'error' ? { error: result?.error || '执行失败' } : {}),
    ...(status === 'rejected' ? { error: '用户拒绝，数据未修改' } : {}),
  });
  const approve = useMutation<ApprovalResponse, Error, string>({ mutationFn: (approvalId: string) => api(`/api/agent/approvals/${approvalId}/approve`, { method: 'POST' }), onSuccess: (response, approvalId) => {
    setApprovals((current) => current.filter((item) => item.approvalId !== approvalId));
    invalidate();
    setMessages((current) => {
      const status: ToolActivityStatus = response.result?.success === false ? 'error' : 'done';
      const next: ChatMessage[] = current.map((message) => ({ ...message, tools: message.tools?.map((tool) => tool.approvalId === approvalId ? settleTool(tool, status, response.result) : tool) }));
      if (response.assistantMessage) next.push({ role: 'assistant', content: response.assistantMessage, status: 'completed' });
      return next;
    });
    if (response.summaryError) onErrorRef.current(response.summaryError);
  }, onError: (e: Error) => onErrorRef.current(e.message) });
  const reject = useMutation({ mutationFn: (approvalId: string) => api(`/api/agent/approvals/${approvalId}/reject`, { method: 'POST' }), onSuccess: (_result, approvalId) => {
    setApprovals((current) => current.filter((item) => item.approvalId !== approvalId));
    setMessages((current) => current.map((message) => ({ ...message, tools: message.tools?.map((tool) => tool.approvalId === approvalId ? settleTool(tool, 'rejected', { success: false, error: '用户拒绝，数据未修改' }) : tool) })));
  }, onError: (e: Error) => onErrorRef.current(e.message) });

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setInput(''); onErrorRef.current(''); setInterrupted(false); setBusy(true);
    setMessages((current) => [...current, { role: 'user', content: message }]);
    let receivedDone = false;
    let receivedError = false;
    try {
      await streamChat({ conversationId: conversationId || undefined, message, pageContext: { topicId: selectedTopicId || null, taskId: taskId || null, page: view } }, (event) => {
        if (event.conversationId && event.conversationId !== conversationId) { if (!conversationId) newConversationRef.current = event.conversationId; setConversationId(event.conversationId); localStorage.setItem('agent-studio.conversationId', event.conversationId); }
        setMessages((current) => applyMessageEvent(current, event));
        setApprovals((current) => applyApprovalEvent(current, event));
        if (event.type === 'error') { receivedError = true; onErrorRef.current(event.code ? `${event.message ?? '聊天失败'}（${event.code}）` : (event.message ?? '聊天失败')); }
        if (event.type === 'done') { receivedDone = true; invalidate(); }
      });
      if (!receivedDone && !receivedError) setInterrupted(true);
    } catch (reason) { setInterrupted(true); onErrorRef.current(reason instanceof Error ? reason.message : '聊天连接中断'); }
    finally { setBusy(false); }
  };
  const retry = () => { const last = [...messages].reverse().find((item) => item.role === 'user'); if (last) { setInput(last.content); setInterrupted(false); } };
  const startNew = () => {
    if (busy) return;
    localStorage.removeItem('agent-studio.conversationId');
    newConversationRef.current = '';
    setConversationId('');
    setMessages([]);
    setApprovals([]);
    setInterrupted(false);
    setInput('');
  };

  return { conversationId, selectedTopicId, messages, approvals, busy, interrupted, input, setInput, send, retry, startNew, approve, reject };
}
