import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, Sparkles } from 'lucide-react';
import { unplacedApprovals, type Approval, type ChatMessage } from '@/chat.js';
import { Button } from '@/components/ui/button.js';
import { MessageItem } from './MessageItem.js';
import { ApprovalCard } from './ApprovalCard.js';
import { isAppChangeApproval, ReviewCard } from './ReviewCard.js';
import { isTaskBatchApproval, TaskBatchCard } from './TaskBatchCard.js';
import { createBottomPin } from './bottom-pin.js';

type MessageListProps = {
  messages: ChatMessage[];
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
};

export function MessageList({ messages, emptyState, approvals, approvalPending, executingApprovalId, unknownApprovalIds, unresolvedApprovalIds, phase, onApprove, onReject, onChanged, onRepreviewed }: MessageListProps) {
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
    if (el && pinRef.current.isPinned()) el.scrollTop = el.scrollHeight;
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
    if (el) el.scrollTop = el.scrollHeight;
    setShowJump(false);
  };

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      {/* HtmlBlock's lazy observer uses [data-chat-scroll] as its root. */}
      <div data-chat-scroll ref={scrollRef} onScroll={handleScroll} className="glass-scrollbar h-full min-w-0 overflow-y-auto overscroll-contain px-3 py-3">
        {!messages.length && !approvals.length && (emptyState ?? (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <div className="glass-subtle grid size-12 place-items-center rounded-2xl border-primary/15 text-brand-link">
              <Sparkles className="size-5" />
            </div>
            <p className="mt-4 max-w-xs text-[13px] leading-relaxed text-muted-foreground">
              {t('messageList.empty')}
            </p>
          </div>
        ))}
        <div ref={threadRef} className="assistant-thread flex min-w-0 max-w-full flex-col gap-5">
          {messages.map((message, index) => <MessageItem key={`${message.id ?? index}-${index}`} message={message} approvals={approvals} approvalPending={approvalPending} executingApprovalId={executingApprovalId} unknownApprovalIds={unknownApprovalIds} unresolvedApprovalIds={unresolvedApprovalIds} phase={phase} onApprove={onApprove} onReject={onReject} onChanged={onChanged} onRepreviewed={onRepreviewed} />)}
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
