import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { applyApprovalEvent, applyMessageEvent, type Approval, type ChatMessage } from '../chat.js';
import { api, parseApproval, streamChat, type ApprovalResponse, type View } from '../lib/api.js';

export type { View };

type UseChatOptions = {
  selectedTopicId: string;
  view: View;
  onError: (message: string) => void;
};

export function useChat({ selectedTopicId, view, onError }: UseChatOptions) {
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

  const invalidate = () => { queryClient.invalidateQueries({ queryKey: ['topics'] }); queryClient.invalidateQueries({ queryKey: ['topic'] }); queryClient.invalidateQueries({ queryKey: ['tasks'] }); };

  useEffect(() => {
    if (!conversationId) return;
    localStorage.setItem('agent-studio.conversationId', conversationId);
    if (newConversationRef.current === conversationId) {
      newConversationRef.current = '';
      return;
    }
    Promise.all([api(`/api/conversations/${conversationId}/messages`), api('/api/agent/approvals?status=pending')]).then(([history, pending]) => {
      setMessages(history.map((message: ChatMessage) => ({ id: message.id, role: message.role, content: message.content, status: message.status })));
      setApprovals((current) => {
        const merged = new Map(current.map((item) => [item.approvalId, item]));
        pending.map(parseApproval).forEach((item: Approval) => merged.set(item.approvalId, item));
        return [...merged.values()];
      });
    }).catch((reason: Error) => onErrorRef.current(reason.message));
  }, [conversationId]);

  const approve = useMutation<ApprovalResponse, Error, string>({ mutationFn: (approvalId: string) => api(`/api/agent/approvals/${approvalId}/approve`, { method: 'POST' }), onSuccess: (response, approvalId) => {
    setApprovals((current) => current.filter((item) => item.approvalId !== approvalId));
    invalidate();
    setMessages((current) => {
      const next = [...current];
      if (response.assistantMessage) next.push({ role: 'assistant', content: response.assistantMessage, status: 'completed' });
      else next.push({ role: 'tool', content: response.result?.success ? '变更已批准并执行。' : `变更执行失败：${response.result?.error ?? '未知错误'}` });
      return next;
    });
    if (response.summaryError) onErrorRef.current(response.summaryError);
  }, onError: (e: Error) => onErrorRef.current(e.message) });
  const reject = useMutation({ mutationFn: (approvalId: string) => api(`/api/agent/approvals/${approvalId}/reject`, { method: 'POST' }), onSuccess: (_result, approvalId) => { setApprovals((current) => current.filter((item) => item.approvalId !== approvalId)); setMessages((current) => [...current, { role: 'tool', content: '变更已拒绝，数据未修改。' }]); }, onError: (e: Error) => onErrorRef.current(e.message) });

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setInput(''); onErrorRef.current(''); setInterrupted(false); setBusy(true);
    setMessages((current) => [...current, { role: 'user', content: message }]);
    let receivedDone = false;
    let receivedError = false;
    try {
      await streamChat({ conversationId: conversationId || undefined, message, pageContext: { topicId: selectedTopicId || null, taskId: null, page: view } }, (event) => {
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

  return { messages, approvals, busy, interrupted, input, setInput, send, retry, approve, reject };
}
