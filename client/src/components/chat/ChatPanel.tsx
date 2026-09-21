import { RotateCcw, X } from 'lucide-react';
import { useChat } from '@/hooks/useChat.js';
import { api } from '@/lib/api.js';
import { json, usePlatformAction } from '@/lib/platform.js';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { MessageList } from './MessageList.js';
import { ChatComposer } from './ChatComposer.js';

type ChatPanelProps = {
  chat: ReturnType<typeof useChat>;
  onClose: () => void;
};

export function ChatPanel({ chat, onClose }: ChatPanelProps) {
  const action = usePlatformAction();
  const { messages, approvals, busy, interrupted, input, setInput, send, retry, approve, reject } = chat;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b glass-divider px-4 pt-4 pb-3.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <span className="text-[11px] font-bold tracking-[0.13em] text-muted-foreground uppercase">协作空间</span>
            <h2 className="mt-1 text-lg leading-tight font-semibold tracking-tight">全局聊天</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
            <Button variant="ghost" size="icon-sm" title="关闭聊天" aria-label="关闭聊天" onClick={onClose}>
              <X />
            </Button>
          </div>
        </div>
        {chat.conversationId && messages.length > 0 && <Button className="mt-2" size="sm" variant="ghost" disabled={busy || action.busy} onClick={() => void action.run(() => api('/api/v1/knowledge/materials/from-conversation', { method: 'POST', body: json({ conversationId: chat.conversationId, topicId: chat.selectedTopicId || null, title: `会话记录 ${new Date().toLocaleString()}` }) }), '完整会话已保存到项目资料')}>主动保存本次完整会话</Button>}
      </header>

      <MessageList messages={messages} approvals={approvals} approvalPending={approve.isPending || reject.isPending} onApprove={(id) => approve.mutate(id)} onReject={(id) => reject.mutate(id)} />

      {interrupted && (
        <div className={cn('glass-subtle mx-3 mb-2 flex items-center justify-between gap-3 rounded-xl border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive')}>
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
