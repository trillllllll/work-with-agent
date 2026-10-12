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
  const [executingApprovalId, setExecutingApprovalId] = useState('');
  const [unknownApprovalIds, setUnknownApprovalIds] = useState<string[]>([]);
  const approvalsRef = useRef(approvals);
  const conversationRef = useRef(conversationId);
  const busyRef = useRef(busy);
  const mutatingRef = useRef(false);
  const loadGeneration = useRef(0);
  approvalsRef.current = approvals;
  conversationRef.current = conversationId;
  busyRef.current = busy;

  const invalidate = () => { void invalidateTodo(queryClient); void queryClient.invalidateQueries({ queryKey: ['proposals'] }); };

  const reloadConversation = async (id = conversationRef.current, force = false) => {
    if (!id || busyRef.current) return;
    if (!force && (mutatingRef.current || newConversationRef.current === id)) return;
    const generation = ++loadGeneration.current;
    try {
      const [history, listed] = await Promise.all([api(`/api/conversations/${id}/messages`), api('/api/agent/approvals')]);
      if (generation !== loadGeneration.current || conversationRef.current !== id || busyRef.current) return;
      const nextApprovals = (listed as Parameters<typeof parseApproval>[0][]).map(parseApproval).filter((item) => item.conversationId === id);
      setMessages(pairToolMessages(history.map((message: ChatMessage) => ({ id: message.id, role: message.role, content: message.content, status: message.status, toolCalls: message.toolCalls, toolCallId: message.toolCallId })), nextApprovals));
      setApprovals(nextApprovals);
      setUnknownApprovalIds((current) => current.filter((approvalId) => {
        const item = nextApprovals.find((approval) => approval.approvalId === approvalId);
        return Boolean(item && item.status === 'pending' && !item.outcome && !item.supersededByApprovalId);
      }));
    } catch (reason) {
      if (generation !== loadGeneration.current) return;
      if (reason instanceof ApiError && reason.status === 404) {
        localStorage.removeItem('agent-studio.conversationId');
        setConversationId('');
        setMessages([]);
        setApprovals([]);
        return;
      }
      onErrorRef.current(reason instanceof Error ? reason.message : '会话读取失败');
    }
  };

  useEffect(() => {
    if (!conversationId) return;
    localStorage.setItem('agent-studio.conversationId', conversationId);
    if (newConversationRef.current === conversationId) {
      newConversationRef.current = '';
      return;
    }
    void reloadConversation(conversationId, true);
  }, [conversationId]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void reloadConversation(); };
    const onFocus = () => { void reloadConversation(); };
    const events = new EventSource('/api/v1/events', { withCredentials: true });
    const changed = () => { void reloadConversation(); };
    events.onmessage = changed;
    events.addEventListener('change', changed);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      events.close();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  const settleTool = (tool: NonNullable<ChatMessage['tools']>[number], status: ToolActivityStatus, result?: ToolResult) => ({
    ...tool,
    status,
    preview: toolPreview(tool.name, tool.arguments, result, status),
    ...(result?.data !== undefined ? { result: result.data } : {}),
    ...(status === 'error' ? { error: result?.error || '执行失败' } : {}),
    ...(status === 'rejected' ? { error: '用户拒绝，数据未修改' } : {}),
  });
  const batchApproval = (approvalId: string, response?: ApprovalResponse) => {
    const current = approvalsRef.current.find((item) => item.approvalId === approvalId);
    return Boolean(current && (current.resultState === 'batch' || current.preview)) || Boolean(response?.assistantMessageId);
  };
  const finishMutation = (approvalId: string) => {
    mutatingRef.current = false;
    setExecutingApprovalId((current) => current === approvalId ? '' : current);
  };
  const approve = useMutation<ApprovalResponse, Error, string>({
    mutationFn: (approvalId: string) => api(`/api/agent/approvals/${approvalId}/approve`, { method: 'POST' }),
    onMutate: (approvalId) => { mutatingRef.current = true; setExecutingApprovalId(approvalId); setUnknownApprovalIds((current) => current.filter((id) => id !== approvalId)); },
    onSuccess: (response, approvalId) => {
      if (batchApproval(approvalId, response)) {
        void reloadConversation(conversationRef.current, true).finally(() => { finishMutation(approvalId); invalidate(); });
        return;
      }
      finishMutation(approvalId);
      setApprovals((current) => current.filter((item) => item.approvalId !== approvalId));
      invalidate();
      setMessages((current) => {
        const status: ToolActivityStatus = response.result?.success === false ? 'error' : 'done';
        const next: ChatMessage[] = current.map((message) => ({ ...message, tools: message.tools?.map((tool) => tool.approvalId === approvalId ? settleTool(tool, status, response.result) : tool) }));
        if (response.assistantMessage) next.push({ role: 'assistant', content: response.assistantMessage, status: 'completed' });
        return next;
      });
      if (response.summaryError) onErrorRef.current(response.summaryError);
    },
    onError: (error: Error, approvalId) => {
      if (batchApproval(approvalId)) {
        setUnknownApprovalIds((current) => current.includes(approvalId) ? current : [...current, approvalId]);
        void reloadConversation(conversationRef.current, true).finally(() => finishMutation(approvalId));
        return;
      }
      finishMutation(approvalId);
      onErrorRef.current(error.message);
    },
  });
  const reject = useMutation<ApprovalResponse, Error, string>({
    mutationFn: (approvalId: string) => api(`/api/agent/approvals/${approvalId}/reject`, { method: 'POST' }),
    onMutate: (approvalId) => { mutatingRef.current = true; setExecutingApprovalId(approvalId); setUnknownApprovalIds((current) => current.filter((id) => id !== approvalId)); },
    onSuccess: (response, approvalId) => {
      if (batchApproval(approvalId, response)) {
        void reloadConversation(conversationRef.current, true).finally(() => { finishMutation(approvalId); invalidate(); });
        return;
      }
      finishMutation(approvalId);
      setApprovals((current) => current.filter((item) => item.approvalId !== approvalId));
      setMessages((current) => current.map((message) => ({ ...message, tools: message.tools?.map((tool) => tool.approvalId === approvalId ? settleTool(tool, 'rejected', { success: false, error: '用户拒绝，数据未修改' }) : tool) })));
    },
    onError: (error: Error, approvalId) => {
      if (batchApproval(approvalId)) {
        setUnknownApprovalIds((current) => current.includes(approvalId) ? current : [...current, approvalId]);
        void reloadConversation(conversationRef.current, true).finally(() => finishMutation(approvalId));
        return;
      }
      finishMutation(approvalId);
      onErrorRef.current(error.message);
    },
  });

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
    setExecutingApprovalId('');
    setUnknownApprovalIds([]);
    setInterrupted(false);
    setInput('');
  };

  return { conversationId, selectedTopicId, messages, approvals, busy, interrupted, input, setInput, send, retry, startNew, approve, reject, executingApprovalId, unknownApprovalIds };
}
