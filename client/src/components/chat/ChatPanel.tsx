import { ContextSummary } from './ContextSummary.js';
import { suggestions } from '@/lib/assistant-context.js';
import { RotateCcw, X } from 'lucide-react';
import { useChat } from '@/hooks/useChat.js';
import { api, type Settings } from '@/lib/api.js';
import { useQuery } from '@tanstack/react-query';
import { json, usePlatformAction } from '@/lib/platform.js';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { MessageList } from './MessageList.js';
import { ChatComposer } from './ChatComposer.js';

type ChatPanelProps = {
  chat: ReturnType<typeof useChat>;
  onClose: () => void;
  mobile?: boolean;
};

export function ChatPanel({ chat, onClose, mobile }: ChatPanelProps) {
  const action = usePlatformAction();
  const settings = useQuery<Settings>({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
  const configured = Boolean(settings.data?.model && settings.data?.baseUrl && settings.data?.apiKeyConfigured);
  const { messages, approvals, busy, interrupted, input, setInput, send, retry, startNew, resume, refreshApprovals, approve, reject, executingApprovalId, decisionPhase, unknownApprovalIds, unresolvedApprovalIds, pausedRun, referencedApproval, clearReference, showRepreview } = chat;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ai-assistant">
      <header className="shrink-0 border-b glass-divider px-4 pt-4 pb-3.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="text-[11px] font-bold tracking-[0.13em] text-muted-foreground uppercase">协作空间</span>
            <h2 className="mt-1 text-lg leading-tight font-semibold tracking-tight">AI 助手</h2>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={startNew}>新对话</Button>
            {busy ? (
              <Badge variant="secondary" className="gap-1.5">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                处理中…
              </Badge>
            ) : interrupted ? (
              <Badge variant="destructive">连接中断</Badge>
            ) : (
              <Badge variant="outline">{settings.isLoading ? '检查连接…' : settings.error ? '连接状态未知' : configured ? '可用' : '未配置模型'}</Badge>
            )}
            <Button variant="ghost" size="icon-sm" title="关闭聊天" aria-label={mobile ? "返回当前页面" : "关闭聊天"} onClick={onClose}>
              {mobile ? <span className="text-xs">返回</span> : <X />}
            </Button>
          </div>
        </div>
        {chat.conversationId && messages.length > 0 && <Button className="mt-2" size="sm" variant="ghost" disabled={busy || action.busy} onClick={() => void action.run(() => api('/api/v1/knowledge/materials/from-conversation', { method: 'POST', body: json({ conversationId: chat.conversationId, topicId: chat.selectedTopicId || null, title: `会话记录 ${new Date().toLocaleString()}` }) }), '完整会话已保存到项目资料')}>主动保存本次完整会话</Button>}
      </header>

      {!settings.isLoading && !settings.error && !configured && <p className="px-4 py-2 text-xs text-muted-foreground">请在设置中配置模型连接后发送消息。</p>}
      {!messages.length && <div className="flex flex-wrap gap-2 px-3 pt-3">{suggestions(chat.context?.page ?? '').map((item) => <Button key={item} size="sm" variant="outline" className="h-auto whitespace-normal text-left" onClick={() => setInput(item)}>{item}</Button>)}</div>}
      <MessageList messages={messages} approvals={approvals} approvalPending={approve.isPending || reject.isPending} executingApprovalId={executingApprovalId} unknownApprovalIds={unknownApprovalIds} unresolvedApprovalIds={unresolvedApprovalIds} phase={decisionPhase} onApprove={(id) => approve.mutate(id)} onReject={(id) => reject.mutate(id)} onChanged={refreshApprovals} onRepreviewed={showRepreview} />
      {pausedRun && ['new_user_message', 'interrupted', 'round_limit'].includes(pausedRun.reason) && (
        <div className="mx-3 mb-2 flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-xs">
          <span>{pausedRun.reason === 'new_user_message' ? '已暂停后续处理' : '这个请求已暂停。'}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void resume()}>继续此请求</Button>
        </div>
      )}

      {interrupted && (
        <div className={cn('glass-subtle mx-3 mb-2 flex items-center justify-between gap-3 rounded-xl border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive')}>
          <span>聊天连接中断，已保留收到的内容。</span>
          <Button size="sm" variant="outline" className="h-7 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={retry}>
            <RotateCcw />重试
          </Button>
        </div>
      )}

      {chat.context && <div className="max-h-52 shrink-0 overflow-auto border-t px-3 py-2" data-testid="assistant-context">
        <div className="flex items-center justify-between gap-2 text-xs"><span>{chat.pinned ? '已固定上下文' : '跟随页面'}</span><Button size="sm" variant="ghost" onClick={chat.togglePin}>{chat.pinned ? '跟随页面' : '固定当前上下文'}</Button></div>
        <ContextSummary context={chat.context} />
        {chat.attachments.map((item) => <div className="flex items-center justify-between gap-2 text-xs" key={item.id}><span>{item.title} · {item.unsaved ? '未保存' : '选中文字'}</span><Button variant="ghost" size="sm" onClick={() => chat.removeAttachment(item.id)} aria-label={`移除 ${item.title}`}>移除</Button></div>)}
      </div>}
      <ChatComposer input={input} busy={busy} reference={referencedApproval} onChange={setInput} onSend={send} onCancelReference={clearReference} />
    </div>
  );
}
