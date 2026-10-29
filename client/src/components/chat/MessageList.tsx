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
  const [showJump, setShowJump] = useState(false);

  const metrics = (el: HTMLElement) => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const pin = pinRef.current;
    pin.onScroll(metrics(el));
    setShowJump(!pin.isPinned() && el.scrollHeight > el.clientHeight * 1.5);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      const next = pinRef.current.onResize(metrics(el));
      if (next !== null) el.scrollTop = next;
    }
  }, [messages, approvals]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const scroller = scrollRef.current;
    const thread = threadRef.current;
    if (!scroller || !thread) return;
    const observer = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (!el) return;
      const next = pinRef.current.onResize(metrics(el));
      if (next !== null) el.scrollTop = next;
    });
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
    <div className="relative min-h-0 min-w-0 flex-1">
      {/* HtmlBlock's lazy observer uses [data-chat-scroll] as its root. */}
      <div data-chat-scroll ref={scrollRef} onScroll={handleScroll} className="glass-scrollbar h-full min-w-0 overflow-y-auto overscroll-contain px-3 py-3">
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
