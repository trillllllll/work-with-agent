import { ContextSummary } from './ContextSummary.js';
import { suggestions } from '@/lib/assistant-context.js';
import { ChevronDown, Ellipsis, Maximize2, Minimize2, RotateCcw, Sparkles, SquarePen, X } from 'lucide-react';
import { useChat } from '@/hooks/useChat.js';
import { api, type Settings } from '@/lib/api.js';
import { useQuery } from '@tanstack/react-query';
import { json, usePlatformAction } from '@/lib/platform.js';
import { cn } from '@/lib/utils.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { ChatHistory, ChatReferencePicker } from './ChatPickers.js';
import { Button } from '@/components/ui/button.js';
import { MessageList } from './MessageList.js';
import { ChatComposer } from './ChatComposer.js';
import { AssistantInputProvider } from './assistant-input.js';

type ChatPanelProps = {
  chat: ReturnType<typeof useChat>;
  onClose: () => void;
  mobile?: boolean;
  presentation?: 'side' | 'expanded' | 'direct';
  onExpand?: () => void;
  onShrink?: () => void;
};

export function ChatPanel({ chat, onClose, mobile, presentation = 'side', onExpand, onShrink }: ChatPanelProps) {
  const action = usePlatformAction();
  const settings = useQuery<Settings>({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
  const configured = Boolean(settings.data?.model && settings.data?.baseUrl && settings.data?.apiKeyConfigured);
  const { messages, approvals, busy, interrupted, input, setInput, send, retry, startNew, resume, refreshApprovals, approve, reject, executingApprovalId, decisionPhase, unknownApprovalIds, unresolvedApprovalIds, pausedRun, referencedApproval, clearReference, showRepreview } = chat;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ai-assistant" data-presentation={presentation}>
      <header className="assistant-header flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <Sparkles className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">AI 助手</h2><span className="text-[10px] text-muted-foreground" role="status">{busy ? '正在处理…' : interrupted ? '连接中断' : settings.isLoading ? '检查连接…' : settings.error ? '连接状态未知' : configured ? '可用' : '未配置模型'}</span></div>
        <ChatHistory busy={busy || action.busy || Boolean(executingApprovalId)} currentId={chat.conversationId} onSelect={chat.selectConversation} />
        <Button variant="ghost" size="icon-sm" disabled={busy || Boolean(executingApprovalId)} onClick={startNew} aria-label="新对话" title="新对话"><SquarePen /></Button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="更多会话操作" title="更多会话操作"><Ellipsis /></Button></DropdownMenuTrigger><DropdownMenuContent data-assistant-floating align="end">
          <DropdownMenuItem disabled={busy || action.busy || !chat.conversationId || !messages.length} onSelect={() => void action.run(() => api('/api/v1/knowledge/materials/from-conversation', { method: 'POST', body: json({ conversationId: chat.conversationId, topicId: chat.selectedTopicId || null, title: `会话记录 ${new Date().toLocaleString()}` }) }), '完整会话已保存到项目资料')}>保存完整会话为资料</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
        {presentation === 'side' && <Button variant="ghost" size="icon-sm" onClick={onExpand} aria-label="放大到独立页" title="放大到独立页"><Maximize2 /></Button>}
        {presentation === 'expanded' && <Button variant="ghost" size="icon-sm" onClick={onShrink} aria-label="缩小回原页面" title="缩小回原页面"><Minimize2 /></Button>}
        {presentation === 'side' && <Button variant="ghost" size="icon-sm" title="收起助手" aria-label={mobile ? "返回当前页面" : "关闭聊天"} onClick={onClose}><X /></Button>}
      </header>

      {!settings.isLoading && !settings.error && !configured && <p className="px-4 py-2 text-xs text-muted-foreground">请在设置中配置模型连接后发送消息。</p>}
      {!messages.length && <div className="flex flex-wrap gap-2 px-3 pt-3">{suggestions(chat.context?.page ?? '').map((item) => <Button key={item} size="sm" variant="outline" className="h-auto whitespace-normal text-left" onClick={() => setInput(item)}>{item}</Button>)}</div>}
      <AssistantInputProvider setInput={setInput}><MessageList messages={messages} approvals={approvals} approvalPending={approve.isPending || reject.isPending} executingApprovalId={executingApprovalId} unknownApprovalIds={unknownApprovalIds} unresolvedApprovalIds={unresolvedApprovalIds} phase={decisionPhase} onApprove={(id) => approve.mutate(id)} onReject={(id) => reject.mutate(id)} onChanged={refreshApprovals} onRepreviewed={showRepreview} /></AssistantInputProvider>
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

      <div className="assistant-composer-context shrink-0 px-4 pt-2" data-testid="assistant-context">
        {chat.context && <Popover><PopoverTrigger asChild><button type="button" className="flex w-full min-w-0 items-center gap-1.5 py-1 text-left text-[11px] text-muted-foreground" data-testid="assistant-context-trigger"><span className="truncate">{chat.pinned ? '已固定' : '参考'} · {chat.context.label}{chat.context.selectedMaterialIds.length ? ` · ${chat.context.selectedMaterialIds.length} 份资料` : ''}</span><ChevronDown className="size-3 shrink-0" /></button></PopoverTrigger><PopoverContent data-assistant-floating side="top" onEscapeKeyDown={(event) => event.stopPropagation()} className="w-80 max-w-[calc(100vw-2rem)] p-3"><h3 className="mb-2 text-sm font-semibold">本次参考范围</h3><ContextSummary context={chat.context} /><Button size="sm" variant="ghost" onClick={chat.togglePin}>{chat.pinned ? '跟随页面' : '固定当前上下文'}</Button></PopoverContent></Popover>}
        {chat.attachments.map((item) => <div className="mb-1 flex items-center gap-2 text-xs" key={item.id}><span className="min-w-0 flex-1 truncate">{item.title} · {item.unsaved ? '未保存草稿' : '选中文字'}</span><Button variant="ghost" size="icon-xs" onClick={() => chat.removeAttachment(item.id)} aria-label={`移除 ${item.title}`}><X /></Button></div>)}
      </div>
      <ChatComposer input={input} busy={busy} reference={referencedApproval} onChange={setInput} onSend={send} onCancelReference={clearReference} model={settings.data?.model} onStop={() => void chat.stop()} stopping={chat.stopping} toolbar={<ChatReferencePicker selectedIds={chat.context?.selectedMaterialIds ?? []} onSelect={chat.addMaterial} />} />
    </div>
  );
}
