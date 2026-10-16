import { contextLabel, attachmentError, type ChatAttachment, type ChatContextV3 } from '@/lib/assistant-context.js';
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
  pageContext?: ChatContextV3;
  selectedTopicId: string;
  taskId?: string;
  view: View;
  filters?: TaskFilters;
  sort?: string;
  includeArchived?: boolean;
  today?: string;
  onError: (message: string) => void;
};

export function useChat({ pageContext, selectedTopicId, taskId = '', view, filters, sort, includeArchived = false, today = '', onError }: UseChatOptions) {
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
  const [referencedApproval, setReferencedApproval] = useState<{ id: string; title: string } | null>(null);
  const library = useLibrarySnapshot();
  const [pinnedContext, setPinnedContext] = useState<ChatContextV3 | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const activeContext = pinnedContext ?? pageContext;
  const context = activeContext ? { ...activeContext, label: contextLabel(activeContext.label), mode: pinnedContext ? 'pinned' as const : 'follow' as const, attachments } : undefined;
  const contextRef = useRef(context);
  contextRef.current = context;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const addAttachment = (item: ChatAttachment) => {
    const next = [...attachmentsRef.current, item];
    const error = attachmentError(next);
    if (error) { onErrorRef.current(error); return; }
    attachmentsRef.current = next;
    setAttachments(next);
  };
  useEffect(() => {
    const handle = (event: Event) => {
      const item = (event as CustomEvent<{ attachment?: ChatAttachment }>).detail?.attachment;
      if (item) addAttachment(item);
    };
    window.addEventListener('wwa-open-assistant', handle);
    return () => window.removeEventListener('wwa-open-assistant', handle);
  }, []);
  const approvalsRef = useRef(approvals);
  const conversationRef = useRef(conversationId);
  const busyRef = useRef(busy);
  const mutatingRef = useRef(false);
  const loadGeneration = useRef(0);
  const seenEvents = useRef(new Set<string>());
  approvalsRef.current = approvals;
  conversationRef.current = conversationId;
  busyRef.current = busy;

  const invalidate = () => { void invalidateTodo(queryClient); void queryClient.invalidateQueries({ queryKey: ['proposals'] }); };

  const resumableReason = (reason: string | null | undefined) => Boolean(reason && ['new_user_message', 'interrupted', 'round_limit'].includes(reason));
  const reloadConversation = async (id = conversationRef.current, force = false) => {
    if (!id) return;
    if (!force && busyRef.current) return;
    if (!force && (mutatingRef.current || newConversationRef.current === id)) return;
    const generation = ++loadGeneration.current;
    try {
      const [history, listed, active] = await Promise.all([
        api(`/api/conversations/${id}/messages`),
        api('/api/agent/approvals'),
        api<{ id: string; state: string; pauseReason?: string | null } | null>(`/api/conversations/${id}/active-run`),
      ]);
      if (generation !== loadGeneration.current || conversationRef.current !== id) return;
      if (!force && busyRef.current) return;
      if (!busyRef.current) {
        if (active?.state === 'paused' && resumableReason(active.pauseReason)) setPausedRun({ id: active.id, reason: active.pauseReason! });
        else setPausedRun(null);
      }
      const nextApprovals = (listed as Parameters<typeof parseApproval>[0][]).map(parseApproval).filter((item) => item.conversationId === id);
      setMessages(pairToolMessages(history.map((message: ChatMessage) => ({ id: message.id, role: message.role, content: message.content, status: message.status, toolCalls: message.toolCalls, toolCallId: message.toolCallId, parts: parseExternalParts(message.partsJson), context: message.context, sources: message.sources })), nextApprovals));
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

  useEffect(() => {
    const onAdjust = (event: Event) => {
      const detail = (event as CustomEvent<{ approvalId?: string; conversationId?: string | null; title?: string }>).detail;
      if (!detail?.approvalId) return;
      setReferencedApproval({ id: detail.approvalId, title: detail.title || '修改方案' });
      if (detail.conversationId && detail.conversationId !== conversationRef.current) setConversationId(detail.conversationId);
    };
    window.addEventListener('wwa-adjust-approval', onAdjust);
    return () => window.removeEventListener('wwa-adjust-approval', onAdjust);
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
        const runId = response.resumed && response.run?.id ? response.run.id : '';
        void (async () => {
          try {
            await reloadConversation(conversationRef.current, true);
          } finally {
            finishMutation(approvalId);
            invalidate();
          }
          if (!runId) return;
          setInterrupted(false);
          busyRef.current = true;
          setBusy(true);
          try {
            await trackRun(runId, 0);
          } catch (reason) {
            onErrorRef.current(reason instanceof Error ? reason.message : '暂时不能继续这个请求');
          } finally {
            try { await reloadConversation(conversationRef.current, true); } catch { /* reloadConversation already reports a read failure. */ }
            busyRef.current = false;
            setBusy(false);
          }
        })();
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
    const reference = referencedApproval;
    if (!message || busy) return;
    onErrorRef.current(''); setInterrupted(false); setBusy(true); setPausedRun(null);
    const requestContext = structuredClone(contextRef.current ?? buildChatContext({ page: view, topicId: selectedTopicId, taskId, materialId: view === 'library' ? library.preview?.materialId ?? null : null, filters, sort, includeArchived, today }));
    requestContext.referencedApprovalId = reference?.id ?? null;
    setMessages((current) => [...current, { role: 'user', content: message, context: requestContext }]);
    let accepted = false;
    let receivedDone = false;
    let receivedError = false;
    let runId = '';
    let lastSeq = 0;
    const consume = (serverEvent: SseEvent) => {
      if (serverEvent.runId) runId = serverEvent.runId;
      if (typeof serverEvent.seq === 'number') lastSeq = Math.max(lastSeq, serverEvent.seq);
      const applied = applyLiveEvent(serverEvent);
      if (!applied) return;
      if (serverEvent.type === 'error') receivedError = true;
      if (serverEvent.type === 'done' || serverEvent.type === 'run_state' && (serverEvent.state === 'completed' || serverEvent.state === 'waiting_approval' || serverEvent.state === 'paused' || serverEvent.state === 'failed' || serverEvent.state === 'cancelled')) receivedDone = true;
    };
    try {
      await streamChat({
        conversationId: conversationId || undefined,
        message,
        requestKey: crypto.randomUUID(),
        context: requestContext,
      }, consume, { onAccepted: () => { accepted = true; } });
      if (!receivedDone && !receivedError && runId) await trackRun(runId, lastSeq);
      if (!receivedDone && !receivedError && !runId) setInterrupted(true);
      if (accepted && !receivedError) {
        setInput((current) => current.trim() === message ? '' : current);
        const sentIds = new Set(requestContext.schemaVersion === 3 ? requestContext.attachments.map((item) => item.id) : []);
        setAttachments((current) => current.filter((item) => !sentIds.has(item.id)));
        setReferencedApproval((current) => current?.id === reference?.id ? null : current);
      }
    } catch (reason) {
      if (!accepted) {
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last?.role === 'user' && last.content === message && !last.id) next.pop();
          return next;
        });
      }
      setInterrupted(true);
      onErrorRef.current(reason instanceof Error ? reason.message : '聊天连接中断');
    }
    finally { setBusy(false); }
  };
  const resume = async () => {
    if (!pausedRun || busyRef.current) return;
    const runId = pausedRun.id;
    setBusy(true);
    setInterrupted(false);
    try {
      const prior = await api<Array<{ seq: number }>>(`/api/agent/runs/${runId}/events?after=0`);
      const after = prior.reduce((max, item) => Math.max(max, item.seq), 0);
      await api(`/api/agent/runs/${runId}/resume`, { method: 'POST', body: '{}' });
      await trackRun(runId, after);
      await reloadConversation(conversationRef.current, true);
    } catch (reason) { onErrorRef.current(reason instanceof Error ? reason.message : '暂时不能继续这个请求'); }
    finally { setBusy(false); }
  };
  const applyLiveEvent = (event: SseEvent) => {
    if (event.runId && typeof event.seq === 'number') {
      const key = `${event.runId}:${event.seq}`;
      if (seenEvents.current.has(key)) return false;
      seenEvents.current.add(key);
    }
    if (event.type === 'run_state' && event.state === 'paused' && event.runId && event.pauseReason) setPausedRun({ id: event.runId, reason: event.pauseReason });
    if (event.type === 'run_state' && (event.state === 'completed' || event.state === 'waiting_approval')) setPausedRun(null);
    if (event.conversationId && event.conversationId !== conversationRef.current) {
      if (!conversationRef.current) newConversationRef.current = event.conversationId;
      setConversationId(event.conversationId);
      localStorage.setItem('agent-studio.conversationId', event.conversationId);
    }
    setMessages((current) => applyMessageEvent(current, event));
    setApprovals((current) => applyApprovalEvent(current, event));
    if (event.type === 'error' && !event.message?.includes('后续回答未完成')) onErrorRef.current(event.code ? `${event.message ?? '聊天失败'}（${event.code}）` : (event.message ?? '聊天失败'));
    if (event.type === 'done') invalidate();
    return true;
  };
  const trackRun = async (runId: string, after: number) => {
    let lastSeq = after;
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline) {
      const events = await api<Array<{ seq: number; type: string; data: SseEvent }>>(`/api/agent/runs/${runId}/events?after=${lastSeq}`);
      for (const item of events) {
        lastSeq = Math.max(lastSeq, item.seq);
        applyLiveEvent({ ...item.data, type: item.data.type || item.type, runId, seq: item.seq });
      }
      const run = await api<{ state: string; pauseReason?: string | null; errorMessage?: string | null }>(`/api/agent/runs/${runId}`);
      if (run.state === 'paused') {
        setPausedRun(resumableReason(run.pauseReason) ? { id: runId, reason: run.pauseReason! } : null);
        return;
      }
      if (['completed', 'failed', 'cancelled', 'waiting_approval'].includes(run.state)) {
        setPausedRun(null);
        if (run.state === 'failed' && run.errorMessage) onErrorRef.current(run.errorMessage);
        return;
      }
      await sleep(400);
    }
    setInterrupted(true);
  };
  const showRepreview = (body: { approvalId?: string; previewHash?: string; supersedesApprovalId?: string; approval?: { id: string; status: string; toolName: string; conversationId?: string | null; envelope?: unknown } }) => {
    const view = body.approval;
    const envelope = view?.envelope && typeof view.envelope === 'object' ? view.envelope as { assistantMessageId?: string; toolCallId?: string; review?: Approval['appReview']; proposalRevision?: number; outcome?: Approval['appOutcome']; supersededByApprovalId?: string | null } : undefined;
    const review = envelope?.review;
    if (!view?.id || !review?.previewHash) {
      void reloadConversation(conversationRef.current, true);
      return;
    }
    const next: Approval = {
      approvalId: view.id,
      toolName: view.toolName,
      arguments: {},
      status: view.status,
      ...(view.conversationId ? { conversationId: view.conversationId } : {}),
      ...(envelope?.assistantMessageId ? { assistantMessageId: envelope.assistantMessageId } : {}),
      ...(envelope?.toolCallId ? { toolCallId: envelope.toolCallId } : {}),
      resultState: 'app_changes',
      appReview: review,
      previewHash: review.previewHash,
      proposalRevision: envelope?.proposalRevision,
      summary: review.intent,
      ...(envelope?.outcome ? { appOutcome: envelope.outcome } : {}),
      ...(envelope?.supersededByApprovalId ? { supersededByApprovalId: envelope.supersededByApprovalId } : {}),
    };
    setApprovals((current) => [
      ...current.filter((item) => item.approvalId !== next.approvalId).map((item) => item.approvalId === body.supersedesApprovalId ? { ...item, status: 'rejected', supersededByApprovalId: next.approvalId } : item),
      next,
    ]);
    window.dispatchEvent(new CustomEvent('wwa-locate-approval', { detail: { approvalId: next.approvalId } }));
  };
  const refreshApprovals = () => { void reloadConversation(conversationRef.current, true); };
  const retry = () => { const last = [...messages].reverse().find((item) => item.role === 'user'); if (last) { setInput(last.content); if (last.context?.schemaVersion === 3) { setPinnedContext(structuredClone(last.context)); setAttachments(structuredClone(last.context.attachments)); } setInterrupted(false); } };
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
    setPinnedContext(null);
    setAttachments([]);
    setReferencedApproval(null);
    setPausedRun(null);
  };

  return { context, pinned: Boolean(pinnedContext), togglePin: () => setPinnedContext((current) => current ? null : structuredClone(pageContext ?? null)), attachments, removeAttachment: (id: string) => setAttachments((current) => current.filter((item) => item.id !== id)), conversationId, selectedTopicId, messages, approvals, busy, interrupted, input, setInput, send, retry, startNew, resume, refreshApprovals, approve, reject, executingApprovalId, decisionPhase, unknownApprovalIds, unresolvedApprovalIds, pausedRun, referencedApproval, clearReference: () => setReferencedApproval(null), showRepreview };
}
