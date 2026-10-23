import mark from '@/assets/dovun-mark.svg';
import { settingsHash } from '@/components/settings/settings-categories.js';
import { ContextSummary } from './ContextSummary.js';
import { suggestions } from '@/lib/assistant-context.js';
import { ChevronDown, Ellipsis, Maximize2, Minimize2, RotateCcw, Sparkles, SquarePen, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useChat } from '@/hooks/useChat.js';
import { api, type Settings } from '@/lib/api.js';
import { useQuery } from '@tanstack/react-query';
import { json, usePlatformAction } from '@/lib/platform.js';
import { intlLocale } from '../../i18n/index.js';
import { cn } from '@/lib/utils.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { ChatHistory, ChatReferencePicker } from './ChatPickers.js';
import { Button } from '@/components/ui/button.js';
import { MessageList } from './MessageList.js';
import { useState } from 'react';
import { toast } from 'sonner';
import { openSkillEditor } from '@/components/skills/skill-format.js';
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
  const { t } = useTranslation('chat');
  const action = usePlatformAction();
  const settings = useQuery<Settings>({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
  const configured = Boolean(settings.data?.model && settings.data?.baseUrl && settings.data?.apiKeyConfigured);
  const [drafting, setDrafting] = useState(false);
  const saveAsSkill = async () => {
    if (!chat.conversationId || drafting) return;
    setDrafting(true);
    const pending = toast.loading(t('chatPanel.draftingSkill'));
    try {
      const draft = await api<{ name: string; description: string; instructions: string }>('/api/skills/draft', { method: 'POST', body: json({ conversationId: chat.conversationId }) });
      toast.dismiss(pending);
      openSkillEditor({ draft: { ...draft, enabled: true } });
    } catch (error) {
      toast.dismiss(pending);
      toast.error(error instanceof Error ? error.message : t('chatPanel.draftSkillFailed'));
    } finally { setDrafting(false); }
  };
  const { messages, approvals, busy, interrupted, input, setInput, send, retry, startNew, resume, refreshApprovals, approve, reject, executingApprovalId, decisionPhase, unknownApprovalIds, unresolvedApprovalIds, pausedRun, referencedApproval, clearReference, showRepreview } = chat;
  const materialCount = chat.context?.selectedMaterialIds.length ?? 0;
  return (
    <div className="dovun-assistant flex h-full min-h-0 min-w-0 flex-col" data-testid="ai-assistant" data-presentation={presentation}>
      <header className="assistant-header flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <Sparkles className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{t('chatPanel.title')}</h2><span className="text-[10px] text-muted-foreground" role="status">{busy ? t('status.working') : interrupted ? t('status.interrupted') : settings.isLoading ? t('status.checking') : settings.error ? t('status.unknown') : configured ? t('status.available') : t('status.noModel')}</span></div>
        <ChatHistory busy={busy || action.busy || Boolean(executingApprovalId)} currentId={chat.conversationId} onSelect={chat.selectConversation} />
        <Button variant="ghost" size="icon-sm" disabled={busy || Boolean(executingApprovalId)} onClick={startNew} aria-label={t('chatPanel.newConversation')} title={t('chatPanel.newConversation')}><SquarePen /></Button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t('chatPanel.moreActions')} title={t('chatPanel.moreActions')}><Ellipsis /></Button></DropdownMenuTrigger><DropdownMenuContent data-assistant-floating align="end">
          <DropdownMenuItem disabled={busy || action.busy || !chat.conversationId || !messages.length} onSelect={() => void action.run(() => api('/api/v1/knowledge/materials/from-conversation', { method: 'POST', body: json({ conversationId: chat.conversationId, topicId: chat.selectedTopicId || null, title: t('chatPanel.sessionMaterialTitle', { time: new Date().toLocaleString(intlLocale()) }) }) }), t('chatPanel.sessionSaved'))}>{t('chatPanel.saveSession')}</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || drafting || !chat.conversationId || !messages.length} onSelect={() => void saveAsSkill()}>{t('chatPanel.saveAsSkill')}</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
        {presentation === 'side' && <Button variant="ghost" size="icon-sm" onClick={onExpand} aria-label={t('chatPanel.expand')} title={t('chatPanel.expand')}><Maximize2 /></Button>}
        {presentation === 'expanded' && <Button variant="ghost" size="icon-sm" onClick={onShrink} aria-label={t('chatPanel.shrink')} title={t('chatPanel.shrink')}><Minimize2 /></Button>}
        {presentation === 'side' && <Button variant="ghost" size="icon-sm" title={t('chatPanel.hideAssistant')} aria-label={mobile ? t('chatPanel.backToPage') : t('chatPanel.closeChat')} onClick={onClose}><X /></Button>}
      </header>

      {!settings.isLoading && !settings.error && !configured && <p className="shrink-0 px-4 py-2 text-xs text-muted-foreground">{t('chatPanel.configureModel')} <a className="font-medium text-brand-link underline-offset-4 hover:underline" href={`#${settingsHash('model')}`}>{t('chatPanel.configureModelAction')}</a></p>}
      <AssistantInputProvider setInput={setInput}><MessageList emptyState={<>
      <div className="dovun-assistant-welcome"><img src={mark} alt="" /><h3>{t('chatPanel.title')}</h3><p>{t('chatPanel.greeting')}</p></div>
      <div className="dovun-assistant-suggestions flex flex-wrap gap-2 px-3 pt-3">{suggestions(chat.context?.page ?? '').map((item) => <Button key={item} size="sm" variant="outline" className="h-auto whitespace-normal text-left" onClick={() => setInput(input.trim() ? `${input}\n\n${item}` : item)}>{item}</Button>)}</div>
      </>} messages={messages} approvals={approvals} approvalPending={approve.isPending || reject.isPending} executingApprovalId={executingApprovalId} unknownApprovalIds={unknownApprovalIds} unresolvedApprovalIds={unresolvedApprovalIds} phase={decisionPhase} onApprove={(id) => approve.mutate(id)} onReject={(id) => reject.mutate(id)} onChanged={refreshApprovals} onRepreviewed={showRepreview} /></AssistantInputProvider>
      {pausedRun && ['new_user_message', 'interrupted', 'round_limit'].includes(pausedRun.reason) && (
        <div className="mx-3 mb-2 flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-xs">
          <span>{pausedRun.reason === 'new_user_message' ? t('system.pausedFollowUp') : t('chatPanel.requestPaused')}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void resume()}>{t('chatPanel.continueRequest')}</Button>
        </div>
      )}

      {interrupted && (
        <div className={cn('glass-subtle mx-3 mb-2 flex items-center justify-between gap-3 rounded-xl border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive')}>
          <span>{t('chatPanel.connectionDropped')}</span>
          <Button size="sm" variant="outline" className="h-7 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={retry}>
            <RotateCcw />{t('actions.retry')}
          </Button>
        </div>
      )}

      <div className="assistant-composer-context shrink-0 px-4 pt-2" data-testid="assistant-context">
        {chat.context && <Popover><PopoverTrigger asChild><button type="button" className="flex w-full min-w-0 items-center gap-1.5 py-1 text-left text-[11px] text-muted-foreground" data-testid="assistant-context-trigger"><span className="truncate">{materialCount ? t(chat.pinned ? 'chatPanel.contextPinnedWithMaterials' : 'chatPanel.contextReferenceWithMaterials', { label: chat.context.label, count: materialCount }) : t(chat.pinned ? 'chatPanel.contextPinned' : 'chatPanel.contextReference', { label: chat.context.label })}</span><ChevronDown className="size-3 shrink-0" /></button></PopoverTrigger><PopoverContent data-assistant-floating side="top" onEscapeKeyDown={(event) => event.stopPropagation()} className="w-80 max-w-[calc(100vw-2rem)] p-3"><h3 className="mb-2 text-sm font-semibold">{t('chatPanel.referenceScope')}</h3><ContextSummary context={chat.context} /><Button size="sm" variant="ghost" onClick={chat.togglePin}>{chat.pinned ? t('chatPanel.followPage') : t('chatPanel.pinContext')}</Button></PopoverContent></Popover>}
        {chat.attachments.map((item) => <div className="mb-1 flex items-center gap-2 text-xs" key={item.id}><span className="min-w-0 flex-1 truncate">{t(item.unsaved ? 'chatPanel.unsavedAttachment' : 'chatPanel.selectedAttachment', { title: item.title })}</span><Button variant="ghost" size="icon-xs" onClick={() => chat.removeAttachment(item.id)} aria-label={t('chatPanel.removeAttachment', { title: item.title })}><X /></Button></div>)}
      </div>
      <ChatComposer input={input} busy={busy} reference={referencedApproval} onChange={setInput} onSend={send} onCancelReference={clearReference} model={settings.data?.model} onStop={() => void chat.stop()} stopping={chat.stopping} toolbar={<ChatReferencePicker selectedIds={chat.context?.selectedMaterialIds ?? []} onSelect={chat.addMaterial} />} />
    </div>
  );
}
