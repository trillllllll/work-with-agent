import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { applyApprovalEvent, applyMessageEvent, pairToolMessages, parseExternalParts, toolPreview, type Approval, type ChatMessage, type SseEvent, type ToolActivityStatus, type ToolResult } from '../chat.js';

type ApprovalLookup = {
  status?: string;
  envelope?: {
    outcome?: Approval['appOutcome'] | null;
    supersededByApprovalId?: string | null;
  } | null;
};
import { ApiError, api, parseApproval, streamChat, type ApprovalResponse, type View } from '../lib/api.js';
import { buildChatContext } from '../lib/chat-context.js';
import type { TaskFilters } from '../components/tasks/TaskFilterBar.js';
import { useLibrarySnapshot } from '../components/library/store.js';
import { invalidateTodo } from './useTodo.js';

export type { View };

type UseChatOptions = {
  selectedTopicId: string;
  taskId?: string;
  view: View;
  filters?: TaskFilters;
  sort?: string;
  includeArchived?: boolean;
  today?: string;
  onError: (message: string) => void;
};

export function useChat({ selectedTopicId, taskId = '', view, filters, sort, includeArchived = false, today = '', onError }: UseChatOptions) {
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
  const [decisionPhase, setDecisionPhase] = useState<'' | 'approve' | 'reject'>('');
  const [unknownApprovalIds, setUnknownApprovalIds] = useState<string[]>([]);
  const [unresolvedApprovalIds, setUnresolvedApprovalIds] = useState<string[]>([]);
  const [pausedRun, setPausedRun] = useState<{ id: string; reason: string } | null>(null);
  const library = useLibrarySnapshot();
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
      setMessages(pairToolMessages(history.map((message: ChatMessage) => ({ id: message.id, role: message.role, content: message.content, status: message.status, toolCalls: message.toolCalls, toolCallId: message.toolCallId, parts: parseExternalParts(message.partsJson) })), nextApprovals));
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
  const keptApproval = (approvalId: string, response?: ApprovalResponse) => {
    const current = approvalsRef.current.find((item) => item.approvalId === approvalId);
    return Boolean(current && (current.resultState === 'batch' || current.resultState === 'app_changes' || current.preview || current.appReview)) || Boolean(response?.assistantMessageId);
  };
  const decisionBody = (approvalId: string) => {
    const current = approvalsRef.current.find((item) => item.approvalId === approvalId);
    if (current?.resultState !== 'app_changes' || !current.previewHash || current.proposalRevision === undefined) return {};
    return { expectedProposalRevision: current.proposalRevision, previewHash: current.previewHash };
  };
  const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const reconcile = async (approvalId: string) => {
    setUnknownApprovalIds((current) => current.includes(approvalId) ? current : [...current, approvalId]);
    const delays = [1000, 2000, 4000, 8000, 15000, 30000];
    for (const delay of delays) {
      await sleep(delay);
      try {
        const body = await api<{ approval?: ApprovalLookup; status?: string; envelope?: ApprovalLookup['envelope'] }>(`/api/agent/approvals/${approvalId}`);
        const view = body.approval ?? { status: body.status, envelope: body.envelope ?? null };
        const outcome = view.envelope?.outcome ?? null;
        const settled = Boolean(view.status && view.status !== 'pending' && view.status !== 'approved') || Boolean(outcome);
        if (settled) {
          setApprovals((current) => current.map((item) => item.approvalId === approvalId ? {
            ...item,
            ...(view.status ? { status: view.status } : {}),
            ...(outcome ? { appOutcome: outcome } : {}),
            ...(view.envelope?.supersededByApprovalId ? { supersededByApprovalId: view.envelope.supersededByApprovalId } : {}),
          } : item));
          setUnknownApprovalIds((current) => current.filter((id) => id !== approvalId));
          setUnresolvedApprovalIds((current) => current.filter((id) => id !== approvalId));
          if (!busyRef.current) await reloadConversation(conversationRef.current, true);
          return;
        }
      } catch { /* Keep checking. A lost response is not a failed write. */ }
    }
    setUnresolvedApprovalIds((current) => current.includes(approvalId) ? current : [...current, approvalId]);
  };
  const finishMutation = (approvalId: string) => {
    mutatingRef.current = false;
    setExecutingApprovalId((current) => current === approvalId ? '' : current);
    setDecisionPhase('');
  };
  const approve = useMutation<ApprovalResponse, Error, string>({
    mutationFn: (approvalId: string) => api(`/api/agent/approvals/${approvalId}/approve`, { method: 'POST', body: JSON.stringify(decisionBody(approvalId)) }),
    onMutate: (approvalId) => { mutatingRef.current = true; setExecutingApprovalId(approvalId); setDecisionPhase('approve'); setUnknownApprovalIds((current) => current.filter((id) => id !== approvalId)); setUnresolvedApprovalIds((current) => current.filter((id) => id !== approvalId)); },
    onSuccess: (response, approvalId) => {
      if (keptApproval(approvalId, response)) {
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
      if (keptApproval(approvalId)) {
        finishMutation(approvalId);
        void reconcile(approvalId);
        return;
      }
      finishMutation(approvalId);
      onErrorRef.current(error.message);
    },
  });
  const reject = useMutation<ApprovalResponse, Error, string>({
    mutationFn: (approvalId: string) => api(`/api/agent/approvals/${approvalId}/reject`, { method: 'POST', body: JSON.stringify(decisionBody(approvalId)) }),
    onMutate: (approvalId) => { mutatingRef.current = true; setExecutingApprovalId(approvalId); setDecisionPhase('reject'); setUnknownApprovalIds((current) => current.filter((id) => id !== approvalId)); },
    onSuccess: (response, approvalId) => {
      if (keptApproval(approvalId, response)) {
        void reloadConversation(conversationRef.current, true).finally(() => { finishMutation(approvalId); invalidate(); });
        return;
      }
      finishMutation(approvalId);
      setApprovals((current) => current.filter((item) => item.approvalId !== approvalId));
      setMessages((current) => current.map((message) => ({ ...message, tools: message.tools?.map((tool) => tool.approvalId === approvalId ? settleTool(tool, 'rejected', { success: false, error: '用户拒绝，数据未修改' }) : tool) })));
    },
    onError: (error: Error, approvalId) => {
      if (keptApproval(approvalId)) {
        finishMutation(approvalId);
        void reconcile(approvalId);
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
    setInput(''); onErrorRef.current(''); setInterrupted(false); setBusy(true); setPausedRun(null);
    setMessages((current) => [...current, { role: 'user', content: message }]);
    let receivedDone = false;
    let receivedError = false;
    let runId = '';
    let lastSeq = 0;
    const consume = (event: SseEvent) => {
      if (event.runId) runId = event.runId;
      if (typeof event.seq === 'number') lastSeq = Math.max(lastSeq, event.seq);
      if (event.type === 'run_state' && event.state === 'paused' && event.runId && event.pauseReason) setPausedRun({ id: event.runId, reason: event.pauseReason });
      if (event.type === 'run_state' && (event.state === 'completed' || event.state === 'waiting_approval')) setPausedRun(null);
      if (event.conversationId && event.conversationId !== conversationId) { if (!conversationId) newConversationRef.current = event.conversationId; setConversationId(event.conversationId); localStorage.setItem('agent-studio.conversationId', event.conversationId); }
      setMessages((current) => applyMessageEvent(current, event));
      setApprovals((current) => applyApprovalEvent(current, event));
      if (event.type === 'error') { receivedError = true; if (!event.message?.includes('后续回答未完成')) onErrorRef.current(event.code ? `${event.message ?? '聊天失败'}（${event.code}）` : (event.message ?? '聊天失败')); }
      if (event.type === 'done' || event.type === 'run_state' && (event.state === 'completed' || event.state === 'waiting_approval' || event.state === 'paused' || event.state === 'failed' || event.state === 'cancelled')) receivedDone = true;
      if (event.type === 'done') invalidate();
    };
    try {
      const materialId = view === 'library' ? library.preview?.materialId ?? null : null;
      await streamChat({
        conversationId: conversationId || undefined,
        message,
        requestKey: crypto.randomUUID(),
        context: buildChatContext({ page: view, topicId: selectedTopicId, taskId, materialId, filters, sort, includeArchived, today }),
      }, consume);
      if (!receivedDone && !receivedError && runId) {
        const deadline = Date.now() + 100_000;
        while (Date.now() < deadline && !receivedDone) {
          const events = await api<Array<{ seq: number; type: string; data: SseEvent }>>(`/api/agent/runs/${runId}/events?after=${lastSeq}`);
          for (const item of events) consume({ ...item.data, type: item.data.type || item.type, runId, seq: item.seq });
          const run = await api<{ state: string }>(`/api/agent/runs/${runId}`);
          if (['completed', 'paused', 'failed', 'cancelled', 'waiting_approval'].includes(run.state)) { receivedDone = true; break; }
          await sleep(500);
        }
      }
      if (!receivedDone && !receivedError) setInterrupted(true);
    } catch (reason) { setInterrupted(true); onErrorRef.current(reason instanceof Error ? reason.message : '聊天连接中断'); }
    finally { setBusy(false); }
  };
  const resume = async () => {
    if (!pausedRun || busy) return;
    setBusy(true);
    try {
      await api(`/api/agent/runs/${pausedRun.id}/resume`, { method: 'POST', body: '{}' });
      setPausedRun(null);
      await reloadConversation(conversationRef.current, true);
    } catch (reason) { onErrorRef.current(reason instanceof Error ? reason.message : '暂时不能继续这个请求'); }
    finally { setBusy(false); }
  };
  const refreshApprovals = () => { void reloadConversation(conversationRef.current, true); };
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

  return { conversationId, selectedTopicId, messages, approvals, busy, interrupted, input, setInput, send, retry, startNew, resume, refreshApprovals, approve, reject, executingApprovalId, decisionPhase, unknownApprovalIds, unresolvedApprovalIds, pausedRun };
}
