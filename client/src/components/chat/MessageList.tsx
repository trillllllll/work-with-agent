import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Sparkles } from 'lucide-react';
import { unplacedApprovals, type Approval, type ChatMessage } from '@/chat.js';
import { Button } from '@/components/ui/button.js';
import { MessageItem } from './MessageItem.js';
import { ApprovalCard } from './ApprovalCard.js';
import { isAppChangeApproval, ReviewCard } from './ReviewCard.js';
import { isTaskBatchApproval, TaskBatchCard } from './TaskBatchCard.js';

type MessageListProps = {
  messages: ChatMessage[];
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

export function MessageList({ messages, approvals, approvalPending, executingApprovalId, unknownApprovalIds, unresolvedApprovalIds, phase, onApprove, onReject, onChanged, onRepreviewed }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    nearBottomRef.current = nearBottom;
    setShowJump(!nearBottom && el.scrollHeight > el.clientHeight * 1.5);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, approvals]);

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
    window.addEventListener('wwa-locate-approval', locate);
    return () => window.removeEventListener('wwa-locate-approval', locate);
  }, []);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    nearBottomRef.current = true;
    setShowJump(false);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={handleScroll} className="glass-scrollbar h-full overflow-y-auto overscroll-contain px-3 py-3">
        {!messages.length && !approvals.length && (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <div className="glass-subtle grid size-12 place-items-center rounded-2xl border-primary/15 text-primary">
              <Sparkles className="size-5" />
            </div>
            <p className="mt-4 max-w-xs text-[13px] leading-relaxed text-muted-foreground">
              告诉 Agent 你想推进什么。只读操作会直接执行，修改任务前会请求审核。
            </p>
          </div>
        )}
        <div className="flex flex-col gap-2.5">
          {messages.map((message, index) => <MessageItem key={`${message.id ?? index}-${index}`} message={message} approvals={approvals} approvalPending={approvalPending} executingApprovalId={executingApprovalId} unknownApprovalIds={unknownApprovalIds} unresolvedApprovalIds={unresolvedApprovalIds} phase={phase} onApprove={onApprove} onReject={onReject} onChanged={onChanged} onRepreviewed={onRepreviewed} />)}
          {unplacedApprovals(messages, approvals).filter((approval) => isTaskBatchApproval(approval) || isAppChangeApproval(approval) || !approval.status || approval.status === 'pending').map((approval) => isAppChangeApproval(approval) ? <ReviewCard key={approval.approvalId} approval={approval} phase={approval.approvalId === executingApprovalId ? phase : ''} unknown={unknownApprovalIds.includes(approval.approvalId)} unresolved={unresolvedApprovalIds.includes(approval.approvalId)} onApprove={onApprove} onReject={onReject} onChanged={onChanged} onRepreviewed={onRepreviewed} /> : isTaskBatchApproval(approval) ? <TaskBatchCard key={approval.approvalId} approval={approval} executing={approval.approvalId === executingApprovalId} unknown={unknownApprovalIds.includes(approval.approvalId)} onApprove={onApprove} onReject={onReject} /> : <ApprovalCard key={approval.approvalId} approval={approval} pending={approvalPending} onApprove={onApprove} onReject={onReject} />)}
        </div>
      </div>
      {showJump && (
        <Button size="sm" variant="secondary" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-card" onClick={jumpToBottom}>
          <ArrowDown />回到底部
        </Button>
      )}
    </div>
  );
}
