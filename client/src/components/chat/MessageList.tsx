import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Sparkles } from 'lucide-react';
import type { Approval, ChatMessage } from '@/chat.js';
import { Button } from '@/components/ui/button.js';
import { MessageItem } from './MessageItem.js';
import { ApprovalCard } from './ApprovalCard.js';

type MessageListProps = {
  messages: ChatMessage[];
  approvals: Approval[];
  approvalPending: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
};

export function MessageList({ messages, approvals, approvalPending, onApprove, onReject }: MessageListProps) {
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
          {messages.map((message, index) => <MessageItem message={message} key={`${message.id ?? index}-${index}`} />)}
          {approvals.map((approval) => <ApprovalCard key={approval.approvalId} approval={approval} pending={approvalPending} onApprove={onApprove} onReject={onReject} />)}
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
