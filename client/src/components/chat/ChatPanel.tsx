import { RotateCcw } from 'lucide-react';
import { useChat } from '@/hooks/useChat.js';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { MessageList } from './MessageList.js';
import { ChatComposer } from './ChatComposer.js';

type ChatPanelProps = {
  chat: ReturnType<typeof useChat>;
};

export function ChatPanel({ chat }: ChatPanelProps) {
  const { messages, approvals, busy, interrupted, input, setInput, send, retry, approve, reject } = chat;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-4 pt-4 pb-3.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <span className="text-[11px] font-bold tracking-[0.13em] text-muted-foreground uppercase">协作空间</span>
            <h2 className="mt-1 text-lg leading-tight font-semibold tracking-tight">全局聊天</h2>
          </div>
          {busy ? (
            <Badge variant="secondary" className="gap-1.5">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              处理中…
            </Badge>
          ) : interrupted ? (
            <Badge variant="destructive">连接中断</Badge>
          ) : (
            <Badge variant="outline">可用</Badge>
          )}
        </div>
      </header>

      <MessageList messages={messages} approvals={approvals} approvalPending={approve.isPending || reject.isPending} onApprove={(id) => approve.mutate(id)} onReject={(id) => reject.mutate(id)} />

      {interrupted && (
        <div className={cn('mx-3 mb-2 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive')}>
          <span>聊天连接中断，已保留收到的内容。</span>
          <Button size="sm" variant="outline" className="h-7 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={retry}>
            <RotateCcw />重试
          </Button>
        </div>
      )}

      <ChatComposer input={input} busy={busy} onChange={setInput} onSend={send} />
    </div>
  );
}
