import type { ContextUsage } from '@/lib/context-usage.js';
import { readMessageBlocks } from '@/lib/message-blocks.js';
import { contextLabel, attachmentError, type ChatAttachment, type ChatContextV3 } from '@/lib/assistant-context.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { applyApprovalEvent, applyMessageEvent, pairToolMessages, parseExternalParts, replyIncompleteMarker, toolPreview, userRejectedError, type Approval, type ChatMessage, type SseEvent, type ToolActivityStatus, type ToolResult } from '../chat.js';

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
  identityId?: string;
  filters?: TaskFilters;
  sort?: string;
  includeArchived?: boolean;
  today?: string;
  onError: (message: string) => void;
};

export function useChat({ pageContext, selectedTopicId, taskId = '', view, identityId, filters, sort, includeArchived = false, today = '', onError }: UseChatOptions) {
  const { t } = useTranslation('chat');
  const tRef = useRef(t);
  tRef.current = t;
  const queryClient = useQueryClient();
  const onErrorRef = useRef(onError);
  const newConversationRef = useRef('');
  onErrorRef.current = onError;
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string>(() => localStorage.getItem('dovun.conversationId') ?? '');
  const identityIdRef = useRef(identityId ?? 'work');
  identityIdRef.current = identityId ?? 'work';
  const [contextStats, setContextStats] = useState<ContextUsage | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [busy, setBusy] = useState(false);
  const activeRunId = useRef('');
  const pendingRequestKey = useRef(localStorage.getItem('dovun.pendingRequestKey') || '');
  const pendingRequestBody = useRef(localStorage.getItem('dovun.pendingRequestBody') || '');
  const clearPendingRequest = () => {
    pendingRequestKey.current = ''; pendingRequestBody.current = '';
    localStorage.removeItem('dovun.pendingRequestKey'); localStorage.removeItem('dovun.pendingRequestBody');
  };
  const [stopping, setStopping] = useState(false);
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
    window.addEventListener('dovun-open-assistant', handle);
    return () => window.removeEventListener('dovun-open-assistant', handle);
  }, []);
  const approvalsRef = useRef(approvals);
  const conversationRef = useRef(conversationId);
  const busyRef = useRef(busy);
  const mutatingRef = useRef(false);
  const loadGeneration = useRef(0);
  const seenEvents = useRef(new Map<string, SseEvent>());
  const snapshotWatermarks = useRef<Record<string, number>>({});
  approvalsRef.current = approvals;
  conversationRef.current = conversationId;
  busyRef.current = busy;

  const invalidate = () => {
    void invalidateTodo(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['proposals'] });
    // 审批可能改到学习域；地图页未挂载时这里是无害的空失效。
    void queryClient.invalidateQueries({ queryKey: ['learning-maps'] });
    void queryClient.invalidateQueries({ queryKey: ['learning-map'] });
  };

  const resumableReason = (reason: string | null | undefined) => Boolean(reason && ['new_user_message', 'interrupted', 'round_limit'].includes(reason));
  const reloadConversation = async (id = conversationRef.current, force = false) => {
    if (!id) return;
    if (!force && busyRef.current) return;
    if (!force && (mutatingRef.current || newConversationRef.current === id)) return;
    const generation = ++loadGeneration.current;
    try {
      const snapshot = await api<{ contextStats?: ContextUsage | null; messages: ChatMessage[]; approvals: Array<Parameters<typeof parseApproval>[0]>; watermarks: Record<string, number>; activeRun: { id: string; state: string; pauseReason?: string | null } | null }>(`/api/conversations/${id}/snapshot`);
      const history = snapshot.messages; const active = snapshot.activeRun;
      if (generation !== loadGeneration.current || conversationRef.current !== id) return;
      if (!force && busyRef.current) return;
      snapshotWatermarks.current = snapshot.watermarks;
      activeRunId.current = active?.id ?? '';
      if (!busyRef.current) {
        if (active?.state === 'paused' && resumableReason(active.pauseReason)) setPausedRun({ id: active.id, reason: active.pauseReason! });
        else setPausedRun(null);
      }
      let nextApprovals = snapshot.approvals.map(parseApproval);
      let restored = pairToolMessages(history.map((message: ChatMessage) => ({ id: message.id, role: message.role, content: message.content, status: message.status, toolCalls: message.toolCalls, toolCallId: message.toolCallId, parts: parseExternalParts(message.partsJson), context: message.context, sources: message.sources, blocks: readMessageBlocks(message.blocksJson) })), nextApprovals);
      for (const event of seenEvents.current.values()) if (event.conversationId === id && event.runId && (event.seq ?? 0) > (snapshot.watermarks[event.runId] ?? 0)) { restored = applyMessageEvent(restored, event); nextApprovals = applyApprovalEvent(nextApprovals, event); }
      let restoredStats = snapshot.contextStats ?? null;
      for (const event of seenEvents.current.values()) if (event.conversationId === id && event.runId && (event.seq ?? 0) > (snapshot.watermarks[event.runId] ?? 0) && event.contextStats) restoredStats = event.contextStats;
      setContextStats(restoredStats);
      setMessages(restored);
      for (const [key, event] of seenEvents.current) if (event.runId && (event.seq ?? 0) <= (snapshot.watermarks[event.runId] ?? 0)) seenEvents.current.delete(key);
      setApprovals(nextApprovals);
      if (!busyRef.current && active && ['queued', 'running'].includes(active.state)) {
        setBusy(true); busyRef.current = true;
        void trackRun(active.id, snapshot.watermarks[active.id] ?? 0).catch((reason) => { setInterrupted(true); onErrorRef.current(reason instanceof Error ? reason.message : tRef.current('errors.restoreFailed')); }).finally(() => { setBusy(false); });
      }
      setUnknownApprovalIds((current) => current.filter((approvalId) => {
        const item = nextApprovals.find((approval) => approval.approvalId === approvalId);
        return Boolean(item && item.status === 'pending' && !item.outcome && !item.supersededByApprovalId);
      }));
    } catch (reason) {
      if (generation !== loadGeneration.current) return;
      if (reason instanceof ApiError && reason.status === 404) {
        localStorage.removeItem('dovun.conversationId');
        setConversationId('');
        setContextStats(null); setMessages([]);
        setApprovals([]);
        return;
      }
      onErrorRef.current(reason instanceof Error ? reason.message : tRef.current('errors.loadConversationFailed'));
    }
  };

  useEffect(() => {
    if (!conversationId) return;
    localStorage.setItem('dovun.conversationId', conversationId);
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
      if (detail.conversationId && detail.conversationId !== conversationRef.current && (busyRef.current || mutatingRef.current || pendingRequestKey.current)) { onErrorRef.current(tRef.current('errors.finishBeforeAdjust')); return; }
      setReferencedApproval({ id: detail.approvalId, title: detail.title || tRef.current('review.proposal') });
      if (detail.conversationId && detail.conversationId !== conversationRef.current) setConversationId(detail.conversationId);
    };
    window.addEventListener('dovun-adjust-approval', onAdjust);
    return () => window.removeEventListener('dovun-adjust-approval', onAdjust);
  }, []);

  const settleTool = (tool: NonNullable<ChatMessage['tools']>[number], status: ToolActivityStatus, result?: ToolResult) => ({
    ...tool,
    status,
    preview: toolPreview(tool.name, tool.arguments, result, status),
    ...(result?.data !== undefined ? { result: result.data } : {}),
    ...(status === 'error' ? { error: result?.error || tRef.current('toolPreview.runFailed') } : {}),
    ...(status === 'rejected' ? { error: userRejectedError } : {}),
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
          if (runId) { busyRef.current = true; setBusy(true); }
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
            onErrorRef.current(reason instanceof Error ? reason.message : tRef.current('errors.cannotContinue'));
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
      setMessages((current) => current.map((message) => ({ ...message, tools: message.tools?.map((tool) => tool.approvalId === approvalId ? settleTool(tool, 'rejected', { success: false, error: userRejectedError }) : tool) })));
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
    if (!message || busyRef.current || mutatingRef.current) return;
    if (pendingRequestKey.current) { setInterrupted(true); onErrorRef.current(tRef.current('errors.pendingRequest')); return; }
    const requestKey = crypto.randomUUID();
    const requestContext = structuredClone(contextRef.current ?? buildChatContext({ page: view, topicId: selectedTopicId, taskId, materialId: view === 'library' ? library.preview?.materialId ?? null : null, filters, sort, includeArchived, today }));
    requestContext.referencedApprovalId = reference?.id ?? null;
    const requestBody = { conversationId: conversationRef.current || undefined, identityId: identityIdRef.current, message, requestKey, context: requestContext };
    // Store the exact body before sending. Replays must retain both the key and its original context.
    const storedBody = JSON.stringify(requestBody);
    try {
      localStorage.setItem('dovun.pendingRequestBody', storedBody); localStorage.setItem('dovun.pendingRequestKey', requestKey);
    } catch {
      // Do not start an untraceable request when the browser cannot save its recovery data.
      try { localStorage.removeItem('dovun.pendingRequestBody'); localStorage.removeItem('dovun.pendingRequestKey'); } catch { /* Storage may be unavailable entirely. */ }
      onErrorRef.current(tRef.current('errors.saveSendStateFailed'));
      return;
    }
    pendingRequestBody.current = storedBody; pendingRequestKey.current = requestKey;
    setContextStats(null);
    activeRunId.current = ''; loadGeneration.current++; busyRef.current = true;
    onErrorRef.current(''); setInterrupted(false); setBusy(true); setPausedRun(null);
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
      await streamChat(requestBody, consume, { onAccepted: () => { accepted = true; } });
      if (!receivedDone && !receivedError && runId) await trackRun(runId, lastSeq);
      if (!receivedDone && !receivedError && !runId) {
        const found = await findRequest(requestKey); adoptRequest(found); runId = found.id;
        await trackRun(runId, 0);
      }
      clearPendingRequest();
      if (accepted && !receivedError) {
        setInput((current) => current.trim() === message ? '' : current);
        const sentIds = new Set(requestContext.schemaVersion === 3 ? requestContext.attachments.map((item) => item.id) : []);
        setAttachments((current) => current.filter((item) => !sentIds.has(item.id)));
        setReferencedApproval((current) => current?.id === reference?.id ? null : current);
      }
    } catch (reason) {
      const rejected = reason instanceof ApiError && Boolean(reason.status && reason.status >= 400 && reason.status < 500 && ![401, 429].includes(reason.status));
      if (rejected && !runId) clearPendingRequest();
      if (!rejected && !runId) { try { const found = await findRequest(requestKey); adoptRequest(found); runId = found.id; accepted = true; } catch { /* Retain the original key and body for a later reconnect. */ } }
      if (runId) {
        try {
          await trackRun(runId, lastSeq);
          await reloadConversation(conversationRef.current, true);
          clearPendingRequest();
          setInterrupted(false);
          setInput((current) => current.trim() === message ? '' : current);
          const sentIds = new Set(requestContext.schemaVersion === 3 ? requestContext.attachments.map((item) => item.id) : []);
          setAttachments((current) => current.filter((item) => !sentIds.has(item.id)));
          setReferencedApproval((current) => current?.id === reference?.id ? null : current);
          return;
        } catch { /* Fall through to an explicit reconnect state, never resend. */ }
      }
      if (!accepted) {
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last?.role === 'user' && last.content === message && !last.id) next.pop();
          return next;
        });
      }
      setInterrupted(!rejected);
      onErrorRef.current(reason instanceof Error ? reason.message : tRef.current('errors.chatInterrupted'));
    }
    finally { if (accepted) await reloadConversation(conversationRef.current, true); busyRef.current = false; setBusy(false); }
  };
  const resume = async () => {
    if (!pausedRun || busyRef.current) return;
    const runId = pausedRun.id;
    busyRef.current = true;
    setBusy(true);
    setInterrupted(false);
    try {
      const prior = await api<Array<{ seq: number }>>(`/api/agent/runs/${runId}/events?after=0`);
      const after = prior.reduce((max, item) => Math.max(max, item.seq), 0);
      await api(`/api/agent/runs/${runId}/resume`, { method: 'POST', body: '{}' });
      await trackRun(runId, after);
      await reloadConversation(conversationRef.current, true);
    } catch (reason) { onErrorRef.current(reason instanceof Error ? reason.message : tRef.current('errors.cannotContinue')); }
    finally { setBusy(false); }
  };
  const applyLiveEvent = (event: SseEvent) => {
    if (event.runId) activeRunId.current = event.runId;
    if (event.runId && typeof event.seq === 'number') {
      if (event.seq <= (snapshotWatermarks.current[event.runId] ?? 0)) return false;
      const key = `${event.runId}:${event.seq}`;
      if (seenEvents.current.has(key)) return false;
      seenEvents.current.set(key, event);
    }
    if (event.type === 'context_stats' && event.contextStats) setContextStats(event.contextStats);
    if (event.type === 'run_state' && event.state === 'paused' && event.pauseReason === 'user_stopped') {
      setMessages((current) => current.map((message) => ({ ...message, status: message.status === 'streaming' ? 'failed' : message.status, blocks: message.blocks?.map((block) => block.status === 'pending' ? { ...block, status: 'error', error: tRef.current('errors.stoppedIncomplete') } : block) })));
    }
    if (event.type === 'run_state' && event.state === 'paused' && event.runId && event.pauseReason) setPausedRun({ id: event.runId, reason: event.pauseReason });
    if (event.type === 'run_state' && (event.state === 'completed' || event.state === 'waiting_approval')) setPausedRun(null);
    if (event.conversationId && event.conversationId !== conversationRef.current) {
      if (!conversationRef.current) newConversationRef.current = event.conversationId;
      conversationRef.current = event.conversationId;
      setConversationId(event.conversationId);
      localStorage.setItem('dovun.conversationId', event.conversationId);
    }
    setMessages((current) => applyMessageEvent(current, event));
    setApprovals((current) => applyApprovalEvent(current, event));
    if (event.type === 'error' && !event.message?.includes(replyIncompleteMarker)) onErrorRef.current(event.code ? tRef.current('errors.chatFailedWithCode', { message: event.message ?? tRef.current('errors.chatFailed'), code: event.code }) : (event.message ?? tRef.current('errors.chatFailed')));
    if (event.type === 'done') invalidate();
    return true;
  };
  const trackRun = async (runId: string, after: number) => {
    let lastSeq = after;
    const trackingConversation = conversationRef.current;
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline) {
      if (conversationRef.current !== trackingConversation) return;
      const events = await api<Array<{ seq: number; type: string; data: SseEvent }>>(`/api/agent/runs/${runId}/events?after=${lastSeq}`);
      if (conversationRef.current !== trackingConversation) return;
      for (const item of events) {
        lastSeq = Math.max(lastSeq, item.seq);
        applyLiveEvent({ ...item.data, type: item.data.type || item.type, runId, seq: item.seq });
      }
      if (conversationRef.current !== trackingConversation) return;
      const run = await api<{ state: string; pauseReason?: string | null; errorMessage?: string | null }>(`/api/agent/runs/${runId}`);
      if (conversationRef.current !== trackingConversation) return;
      if (run.state === 'paused') {
        setPausedRun(resumableReason(run.pauseReason) ? { id: runId, reason: run.pauseReason! } : null);
        await reloadConversation(conversationRef.current, true);
        return;
      }
      if (['completed', 'failed', 'cancelled', 'waiting_approval'].includes(run.state)) {
        setPausedRun(null);
        if (run.state === 'failed' && run.errorMessage) onErrorRef.current(run.errorMessage);
        await reloadConversation(conversationRef.current, true);
        return;
      }
      await sleep(400);
    }
    setInterrupted(true);
    throw new Error(tRef.current('errors.trackTimeout'));
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
    window.dispatchEvent(new CustomEvent('dovun-locate-approval', { detail: { approvalId: next.approvalId } }));
  };
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      const id = activeRunId.current || (conversationRef.current ? (await api<{ id: string } | null>(`/api/conversations/${conversationRef.current}/active-run`))?.id : '');
      if (!id) throw new Error(tRef.current('errors.stopTooEarly'));
      await api(`/api/agent/runs/${id}/stop`, { method: 'POST', body: '{}' });
      setMessages((current) => current.map((item) => item.status === 'streaming' ? { ...item, status: 'completed' as const } : item));
      setPausedRun(null);
      await reloadConversation(conversationRef.current, true);
    } catch (reason) { onErrorRef.current(reason instanceof Error ? reason.message : tRef.current('errors.stopFailed')); }
    finally { setStopping(false); }
  };
  const selectConversation = (id: string) => {
    if (busyRef.current || mutatingRef.current || id === conversationRef.current) return;
    if (pendingRequestKey.current) { onErrorRef.current(tRef.current('errors.retryBeforeSwitch')); return; }
    // Keep the current composer draft and explicit references when browsing history.
    activeRunId.current = '';
    loadGeneration.current++;
    newConversationRef.current = '';
    seenEvents.current.clear();
    setContextStats(null); setMessages([]); setApprovals([]); setPausedRun(null); setInterrupted(false);
    setReferencedApproval(null); setUnknownApprovalIds([]); setUnresolvedApprovalIds([]);
    setConversationId(id);
  };
  const addMaterial = (id: string) => {
    const current = contextRef.current;
    if (!current) return;
    const ids = current.selectedMaterialIds.includes(id) ? current.selectedMaterialIds.filter((item) => item !== id) : [...current.selectedMaterialIds, id];
    if (ids.length > 100) { onErrorRef.current(tRef.current('errors.tooManyMaterials')); return; }
    setPinnedContext({ ...structuredClone(current), selectedMaterialIds: ids });
  };
  useEffect(() => { if (messages.some((message) => message.needsSnapshot)) void reloadConversation(conversationRef.current, true); }, [messages]);
  useEffect(() => { if (pendingRequestKey.current) { setInterrupted(true); void retry(); } }, []);
  const refreshApprovals = () => { void reloadConversation(conversationRef.current, true); };
  const findRequest = async (key: string) => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const found = await api<{ id: string; conversationId: string; message: string; attachmentIds: string[] } | null>(`/api/agent/requests/${encodeURIComponent(key)}`);
      if (found) return found;
      await sleep(500);
    }
    let body: Record<string, unknown>;
    try { body = JSON.parse(pendingRequestBody.current); }
    catch { throw new Error(tRef.current('errors.requestMissingLocally')); }
    if (!body || body.requestKey !== key || typeof body.message !== 'string' || !body.context || typeof body.context !== 'object') throw new Error(tRef.current('errors.requestIncomplete'));
    // A POST may never have reached the server. Its unique request key makes this exact replay idempotent.
    let runId = ''; let rejection = '';
    try {
      await streamChat(body, (event) => {
        if (event.runId) runId = event.runId;
        if (event.type === 'error') rejection = event.message || tRef.current('errors.chatRequestFailed');
        applyLiveEvent(event);
      });
    } catch (reason) {
      if (!runId && reason instanceof ApiError && reason.status && reason.status >= 400 && reason.status < 500 && ![401, 429].includes(reason.status)) clearPendingRequest();
      throw reason;
    }
    if (!runId && rejection) { clearPendingRequest(); throw new Error(rejection); }
    const found = await api<{ id: string; conversationId: string; message: string; attachmentIds: string[] } | null>(`/api/agent/requests/${encodeURIComponent(key)}`);
    if (found) return found;
    throw new Error(tRef.current('errors.requestUnconfirmed'));
  };
  const adoptRequest = (found: { id: string; conversationId: string }) => {
    activeRunId.current = found.id;
    if (conversationRef.current !== found.conversationId) {
      loadGeneration.current++; conversationRef.current = found.conversationId;
      newConversationRef.current = found.conversationId; setConversationId(found.conversationId);
      localStorage.setItem('dovun.conversationId', found.conversationId);
    }
  };
  const retry = async () => {
    if (busyRef.current || mutatingRef.current) return;
    if (pendingRequestKey.current) {
      setBusy(true); busyRef.current = true; setInterrupted(false);
      try { const found = await findRequest(pendingRequestKey.current); adoptRequest(found); await reloadConversation(found.conversationId, true); await trackRun(found.id, snapshotWatermarks.current[found.id] ?? 0); clearPendingRequest(); setInput((current) => current.trim() === found.message ? '' : current); setAttachments((current) => current.filter((item) => !found.attachmentIds.includes(item.id))); }
      catch (reason) { setInterrupted(true); onErrorRef.current(reason instanceof Error ? reason.message : tRef.current('errors.restoreFailed')); }
      finally { busyRef.current = false; setBusy(false); }
      return;
    }
    if (activeRunId.current && interrupted) {
      const id = activeRunId.current; setBusy(true); busyRef.current = true; setInterrupted(false);
      try { await reloadConversation(conversationRef.current, true); await trackRun(id, snapshotWatermarks.current[id] ?? 0); }
      catch (reason) { setInterrupted(true); onErrorRef.current(reason instanceof Error ? reason.message : tRef.current('errors.restoreFailed')); }
      finally { busyRef.current = false; setBusy(false); }
      return;
    }
    const last = [...messages].reverse().find((item) => item.role === 'user');
    if (last) { setInput(last.content); if (last.context?.schemaVersion === 3) { setPinnedContext(structuredClone(last.context)); setAttachments(structuredClone(last.context.attachments)); } setInterrupted(false); }
  };
  const startNew = () => {
    if (busyRef.current || mutatingRef.current) return;
    activeRunId.current = '';
    clearPendingRequest();
    loadGeneration.current++;
    localStorage.removeItem('dovun.conversationId');
    newConversationRef.current = '';
    setConversationId('');
    setContextStats(null); setMessages([]);
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

  return { contextStats, stop, stopping, selectConversation, addMaterial, context, pinned: Boolean(pinnedContext), togglePin: () => setPinnedContext((current) => current ? null : structuredClone(pageContext ?? null)), attachments, removeAttachment: (id: string) => setAttachments((current) => current.filter((item) => item.id !== id)), conversationId, selectedTopicId, messages, approvals, busy, interrupted, input, setInput, send, retry, startNew, resume, refreshApprovals, approve, reject, executingApprovalId, decisionPhase, unknownApprovalIds, unresolvedApprovalIds, pausedRun, referencedApproval, clearReference: () => setReferencedApproval(null), showRepreview };
}
