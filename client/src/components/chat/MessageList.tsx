import { Surface } from '@/components/ui/surface.js';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, Sparkles } from 'lucide-react';
import { presentChatMessages, unplacedApprovals, type Approval, type ChatMessage } from '@/chat.js';
import { Button } from '@/components/ui/button.js';
import { assistantTurns } from './assistant-process.js';
import { MessageItem } from './MessageItem.js';
import { ApprovalCard } from './ApprovalCard.js';
import { isAppChangeApproval, ReviewCard } from './ReviewCard.js';
import { isTaskBatchApproval, TaskBatchCard } from './TaskBatchCard.js';
import { createBottomPin } from './bottom-pin.js';

type MessageListProps = {
  messages: ChatMessage[];
  activeRunId?: string;
  emptyState?: ReactNode;
  approvals: Approval[];
  approvalPending: boolean;
  executingApprovalId: string;
  unknownApprovalIds: string[];
  unresolvedApprovalIds: string[];
  phase: '' | 'approve' | 'reject';
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onChanged: () => void;
  onRepreviewed?: (body: { approvalId?: string; previewHash?: string; supersedesApprovalId?: string; approval?: { id: string; status: string; toolName: string; conversationId?: string | null; envelope?: unknown } }) => void;
  /** Bumped by each send so the list re-pins and jumps to the just-appended message. */
  sendSeq?: number;
};

export function MessageList({ messages, activeRunId, emptyState, approvals, approvalPending, executingApprovalId, unknownApprovalIds, unresolvedApprovalIds, phase, onApprove, onReject, onChanged, onRepreviewed, sendSeq = 0 }: MessageListProps) {
  const { t } = useTranslation('chat');
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const pinRef = useRef(createBottomPin());
  const scrollIntent = useRef({ top: 0, until: 0 });
  const intentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touchY = useRef(0);
  const [showJump, setShowJump] = useState(false);

  const metrics = (el: HTMLElement) => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });

  const resizeToBottom = () => {
    const el = scrollRef.current;
    // A wheel default action can arrive after ResizeObserver. Give the active gesture the
    // first move, then resume following if it never actually scrolled this container upward.
    if (!el || performance.now() < scrollIntent.current.until) return;
    const next = pinRef.current.onResize(metrics(el));
    if (next !== null) el.scrollTop = next;
  };

  const clearScrollIntent = () => {
    const deferred = intentTimer.current !== undefined;
    scrollIntent.current.until = 0;
    clearTimeout(intentTimer.current); intentTimer.current = undefined;
    if (deferred) resizeToBottom();
  };

  const noteScrollIntent = () => {
    const el = scrollRef.current;
    if (!el) return;
    scrollIntent.current = { top: el.scrollTop, until: performance.now() + 700 };
    clearTimeout(intentTimer.current);
    intentTimer.current = setTimeout(() => { intentTimer.current = undefined; scrollIntent.current.until = 0; resizeToBottom(); }, 700);
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const pin = pinRef.current;
    const intent = scrollIntent.current;
    // Intent alone never unpins: the scroller must actually move upward. This also covers a
    // wheel/touch/key/scrollbar movement arriving in the same frame as streamed content growth.
    pin.onScroll(metrics(el), performance.now() <= intent.until && el.scrollTop < intent.top - 1);
    intent.top = el.scrollTop;
    setShowJump(!pin.isPinned() && el.scrollHeight > el.clientHeight * 1.5);
  };

  useEffect(() => {
    resizeToBottom();
  }, [messages, approvals]);

  useEffect(() => () => clearTimeout(intentTimer.current), []);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const scroller = scrollRef.current;
    const thread = threadRef.current;
    if (!scroller || !thread) return;
    const observer = new ResizeObserver(resizeToBottom);
    observer.observe(scroller);
    observer.observe(thread);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const locate = (event: Event) => {
      const approvalId = (event as CustomEvent<{ approvalId?: string }>).detail?.approvalId;
      if (!approvalId || !scrollRef.current) return;
      const card = scrollRef.current.querySelector(`[data-approval-id="${CSS.escape(approvalId)}"]`);
      if (!(card instanceof HTMLElement)) return;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      card.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      card.classList.remove('approval-locate');
      void card.offsetWidth;
      card.classList.add('approval-locate');
      const title = card.querySelector('h2');
      if (title instanceof HTMLElement) { title.tabIndex = -1; title.focus(); }
    };
    window.addEventListener('dovun-locate-approval', locate);
    return () => window.removeEventListener('dovun-locate-approval', locate);
  }, []);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    clearScrollIntent();
    pinRef.current.pin();
    if (el) {
      const next = pinRef.current.onResize(metrics(el));
      if (next !== null) el.scrollTop = next;
    }
    setShowJump(false);
  };

  const prevSendSeq = useRef(sendSeq);
  useEffect(() => {
    // Sending implies watching the new exchange, so re-pin even if the user had scrolled up.
    // The effect runs after the commit that appended the sent message, so the scroller measures the real bottom.
    if (sendSeq === prevSendSeq.current) return;
    prevSendSeq.current = sendSeq;
    jumpToBottom();
  }, [sendSeq]);

  return (
    <div className="assistant-messages relative min-h-0 min-w-0 flex-1">
      {/* HtmlBlock's lazy observer uses [data-chat-scroll] as its root. */}
      <div data-chat-scroll ref={scrollRef} onScroll={handleScroll}
        onWheelCapture={(event) => { if (event.deltaY < 0) noteScrollIntent(); else if (event.deltaY > 0) clearScrollIntent(); }}
        onTouchStartCapture={(event) => { touchY.current = event.touches[0]?.clientY ?? 0; }}
        onTouchMoveCapture={(event) => { const next = event.touches[0]?.clientY ?? touchY.current; if (next > touchY.current) noteScrollIntent(); else if (next < touchY.current) clearScrollIntent(); touchY.current = next; }}
        onKeyDownCapture={(event) => {
          if ((event.target as Element).closest('input, textarea, select, button, [contenteditable], [role="textbox"]')) return;
          if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) noteScrollIntent();
          else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) clearScrollIntent();
        }}
        onPointerDownCapture={(event) => { if (event.target === event.currentTarget) noteScrollIntent(); }}
        onPointerMoveCapture={(event) => { if (event.buttons === 1 && event.target === event.currentTarget) noteScrollIntent(); }}
        className="glass-scrollbar h-full min-w-0 overflow-y-auto overscroll-contain px-3 py-3">
        {!messages.length && !approvals.length && (emptyState ?? (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <Surface as="div" tone="subtle" className="grid size-12 place-items-center rounded-2xl border-primary/15 text-brand-link">
              <Sparkles className="size-5" />
            </Surface>
            <p className="mt-4 max-w-xs text-[13px] leading-relaxed text-muted-foreground">
              {t('messageList.empty')}
            </p>
          </div>
        ))}
        <div ref={threadRef} className="assistant-thread flex min-w-0 max-w-full flex-col gap-5">
          {assistantTurns(presentChatMessages(messages)).map((turn, turnIndex) => <div key={turn[0].id ?? turnIndex} className="assistant-turn">{turn.map((message, index) => <MessageItem key={message.id ?? index} message={message} processActive={Boolean(activeRunId && turn.some(item => item.runId === activeRunId))} processMessages={index === 0 ? turn : undefined} hideProcess={index > 0} approvals={approvals} approvalPending={approvalPending} executingApprovalId={executingApprovalId} unknownApprovalIds={unknownApprovalIds} unresolvedApprovalIds={unresolvedApprovalIds} phase={phase} onApprove={onApprove} onReject={onReject} onChanged={onChanged} onRepreviewed={onRepreviewed} />)}</div>)}
          {unplacedApprovals(messages, approvals).filter((approval) => isTaskBatchApproval(approval) || isAppChangeApproval(approval) || !approval.status || approval.status === 'pending').map((approval) => isAppChangeApproval(approval) ? <ReviewCard key={approval.approvalId} approval={approval} phase={approval.approvalId === executingApprovalId ? phase : ''} unknown={unknownApprovalIds.includes(approval.approvalId)} unresolved={unresolvedApprovalIds.includes(approval.approvalId)} onApprove={onApprove} onReject={onReject} onChanged={onChanged} onRepreviewed={onRepreviewed} /> : isTaskBatchApproval(approval) ? <TaskBatchCard key={approval.approvalId} approval={approval} executing={approval.approvalId === executingApprovalId} unknown={unknownApprovalIds.includes(approval.approvalId)} onApprove={onApprove} onReject={onReject} /> : <ApprovalCard key={approval.approvalId} approval={approval} pending={approvalPending} onApprove={onApprove} onReject={onReject} />)}
        </div>
      </div>
      {showJump && (
        <Button size="sm" variant="secondary" className="absolute right-3 bottom-3 rounded-full shadow-card" onClick={jumpToBottom}>
          <ArrowDown />{t('messageList.jumpToBottom')}
        </Button>
      )}
    </div>
  );
}
