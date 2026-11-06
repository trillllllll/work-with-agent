import './conversation.css';
import { Surface } from '@/components/ui/surface.js';
import mark from '@/assets/dovun-mark.svg';
import { settingsHash } from '@/components/settings/settings-categories.js';
import { ContextSummary } from './ContextSummary.js';
import { suggestions, studySuggestions } from '@/lib/assistant-context.js';
import { ArrowLeft, ChevronDown, Ellipsis, Maximize2, Minimize2, PanelLeft, RotateCcw, SquarePen, X } from 'lucide-react';
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
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { openSkillEditor } from '@/components/skills/skill-format.js';
import { ContextUsageDetails } from './ContextUsageDetails.js';
import { ChatComposer } from './ChatComposer.js';
import { Modal } from '@/components/ui/modal.js';
import { WebSearchToggle } from './WebSearchToggle.js';
import { AssistantInputProvider } from './assistant-input.js';
import { StudyTopicBar } from './StudyTopicBar.js';
import { StudyBriefing } from './StudyBriefing.js';
import { useCurrentTopic } from '@/lib/learning-topic.js';
import { focusedLearningNode } from './learning-focus.js';
import { LEARNING_NAVIGATE_EVENT } from './learning-events.js';

type ChatPanelProps = {
  chat: ReturnType<typeof useChat>;
  identityId?: string;
  onSwitchIdentity?: (identityId: string) => void;
  onClose: () => void;
  mobile?: boolean;
  presentation?: 'side' | 'expanded' | 'direct';
  onExpand?: () => void;
  onShrink?: () => void;
  showClose?: boolean;
  onReturnToLearning?: () => void;
  onOpenNavigation?: () => void;
};

export function ChatPanel({ chat, identityId = 'work', onSwitchIdentity, onClose, mobile, presentation = 'side', onExpand, onShrink, showClose = true, onReturnToLearning, onOpenNavigation }: ChatPanelProps) {
  const { t } = useTranslation('chat');
  const action = usePlatformAction();
  const settings = useQuery<Settings>({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
  const configured = Boolean(settings.data?.model && settings.data?.baseUrl && settings.data?.apiKeyConfigured);
  const [drafting, setDrafting] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const closeDetails = () => setUsageOpen(false);
    window.addEventListener('hashchange', closeDetails);
    return () => window.removeEventListener('hashchange', closeDetails);
  }, []);
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
  const { messages, approvals, busy, interrupted, input, setInput, sendSeq, send, retry, startNew, resume, refreshApprovals, approve, reject, executingApprovalId, decisionPhase, unknownApprovalIds, unresolvedApprovalIds, pausedRun, referencedApproval, clearReference, showRepreview } = chat;
  const materialCount = chat.context?.selectedMaterialIds.length ?? 0;
  const latestLearningTurn = [...messages].reverse().find(message => message.role === 'user' && message.context?.schemaVersion === 3 && message.context.attachments.some(item => item.learningMapId || item.learningSessionId));
  const learningReferences = chat.attachments.filter(item => item.learningMapId || item.learningSessionId);
  const savedReferences = latestLearningTurn?.context?.schemaVersion === 3 ? latestLearningTurn.context.attachments.filter(item => item.learningMapId || item.learningSessionId) : [];
  const learningReference = learningReferences[learningReferences.length - 1] ?? savedReferences[savedReferences.length - 1];
  const [topicId, setTopicId] = useCurrentTopic();
  const focusNodeId = focusedLearningNode(messages, chat.attachments);
  useEffect(() => {
    const go = (event: Event) => { const hash = (event as CustomEvent<{ hash?: string }>).detail?.hash; if (!hash) return; window.location.hash = hash; if (mobile) onClose(); };
    window.addEventListener(LEARNING_NAVIGATE_EVENT, go);
    return () => window.removeEventListener(LEARNING_NAVIGATE_EVENT, go);
  }, [mobile, onClose]);
  const newTopic = () => { if (chat.switchingBlocked) return; startNew(); setTopicId(''); setInput(t('studyTopic.newPrompt')); };
  return (
    <div className="dovun-assistant flex h-full min-h-0 min-w-0 flex-col" data-testid="ai-assistant" data-presentation={presentation}>
      <header className="assistant-header flex shrink-0 items-center gap-1 px-3 py-3">
        {onOpenNavigation && <Button variant="ghost" size="icon-sm" aria-label={t('chatPanel.openNavigation')} onClick={onOpenNavigation}><PanelLeft /></Button>}
        <div className="assistant-identity min-w-0 flex-1">
          {onSwitchIdentity ? <h2 aria-label={t(identityId === 'study' ? 'chatPanel.identityStudy' : 'chatPanel.identityWork')}><DropdownMenu><DropdownMenuTrigger asChild><Button variant="plain" size="bare" className="assistant-identity-trigger" disabled={chat.switchingBlocked} aria-label={t('chatPanel.switchIdentity')}><span className="truncate">{t(identityId === 'study' ? 'chatPanel.identityStudy' : 'chatPanel.identityWork')}</span><ChevronDown className="size-3" /></Button></DropdownMenuTrigger><DropdownMenuContent data-assistant-floating align="start">
            <DropdownMenuItem disabled={identityId === 'work'} onSelect={() => onSwitchIdentity('work')}>{t('chatPanel.identityWork')}</DropdownMenuItem>
            <DropdownMenuItem disabled={identityId === 'study'} onSelect={() => onSwitchIdentity('study')}>{t('chatPanel.identityStudy')}</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu></h2> : <h2>{t(identityId === 'study' ? 'chatPanel.identityStudy' : 'chatPanel.identityWork')}</h2>}
          <span className="sr-only" role="status">{busy ? t('status.working') : interrupted ? t('status.interrupted') : settings.isLoading ? t('status.checking') : settings.error ? t('status.unknown') : configured ? t('status.available') : t('status.noModel')}</span>
        </div>
        <ChatHistory busy={chat.switchingBlocked || action.busy} currentId={chat.conversationId} identityId={identityId} onSelect={chat.selectConversation} />
        <Button variant="ghost" size="icon-sm" disabled={chat.switchingBlocked} onClick={startNew} aria-label={t('chatPanel.newConversation')} title={t('chatPanel.newConversation')}><SquarePen /></Button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button ref={moreTrigger} data-testid="assistant-more-actions" variant="ghost" size="icon-sm" aria-label={t('chatPanel.moreActions')} title={t('chatPanel.moreActions')}><Ellipsis /></Button></DropdownMenuTrigger><DropdownMenuContent data-assistant-floating align="end" className="w-72 max-w-[calc(100vw-2rem)]">
          <div className="assistant-model-summary flex items-start gap-3 px-2 py-2 text-xs text-muted-foreground"><span className="shrink-0">{t('chatPanel.model')}</span><strong className="min-w-0 break-all font-medium text-foreground">{settings.data?.model || t('status.noModel')}</strong></div>
          <DropdownMenuItem data-testid="context-usage-trigger" onSelect={() => window.setTimeout(() => setUsageOpen(true), 0)}>{t('usage.open')}</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || action.busy || !chat.conversationId || !messages.length} onSelect={() => void action.run(() => api('/api/v1/knowledge/materials/from-conversation', { method: 'POST', body: json({ conversationId: chat.conversationId, topicId: chat.selectedTopicId || null, title: t('chatPanel.sessionMaterialTitle', { time: new Date().toLocaleString(intlLocale()) }) }) }), t('chatPanel.sessionSaved'))}>{t('chatPanel.saveSession')}</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || drafting || !chat.conversationId || !messages.length} onSelect={() => void saveAsSkill()}>{t('chatPanel.saveAsSkill')}</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
        {presentation === 'side' && <Button variant="ghost" size="icon-sm" onClick={onExpand} aria-label={t('chatPanel.expand')} title={t('chatPanel.expand')}><Maximize2 /></Button>}
        {presentation === 'expanded' && <Button variant="ghost" size="icon-sm" onClick={onShrink} aria-label={t('chatPanel.shrink')} title={t('chatPanel.shrink')}><Minimize2 /></Button>}
        {presentation === 'side' && showClose && <Button variant="ghost" size="icon-sm" title={t('chatPanel.hideAssistant')} aria-label={mobile ? t('chatPanel.backToPage') : t('chatPanel.closeChat')} onClick={onClose}><X /></Button>}
      </header>

      {identityId === 'study' && <StudyTopicBar topicId={topicId} focusNodeId={focusNodeId} disabled={chat.switchingBlocked} onSelectTopic={(id) => void chat.selectTopic(id)} onNewTopic={newTopic}
        onOpenNode={(hash) => { window.location.hash = hash; if (mobile) onClose(); }} onAsk={(prompt) => setInput(input.trim() ? `${input}\n\n${prompt}` : prompt)} />}
      {identityId === 'study' && topicId && <StudyBriefing key={topicId} topicId={topicId} />}
      {onReturnToLearning && <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1">
        <Button variant="ghost" className="min-h-11 shrink-0 px-2" onClick={onReturnToLearning}><ArrowLeft className="size-4" />{t('chatPanel.backToLearning')}</Button>
        {identityId === 'study' && learningReference && <span className="min-w-0 truncate text-xs text-muted-foreground" title={learningReference.title}>{t('chatPanel.learningReference', { title: learningReference.title })}</span>}
      </div>}

      {!settings.isLoading && !settings.error && !configured && <p className="shrink-0 px-4 py-2 text-xs text-muted-foreground">{t('chatPanel.configureModel')} <a className="font-medium text-brand-link underline-offset-4 hover:underline" href={`#${settingsHash('model')}`}>{t('chatPanel.configureModelAction')}</a></p>}
      {chat.draftStorageFailed&&<p role="alert" className="mx-3 shrink-0 rounded-lg border border-destructive/30 p-3 text-xs text-destructive">{t('errors.draftStorageFailed')}</p>}
      {chat.hasLegacyPending&&<p role="status" className="mx-3 shrink-0 rounded-lg border p-3 text-xs text-muted-foreground">{t('chatPanel.legacyPendingHint')}</p>}
      <AssistantInputProvider setInput={setInput}><MessageList emptyState={<>
      <div className="dovun-assistant-welcome"><img src={mark} alt="" /><h3>{t(identityId === 'study' ? 'chatPanel.studyWelcomeTitle' : 'chatPanel.title')}</h3><p>{t(identityId === 'study' ? 'chatPanel.studyGreeting' : 'chatPanel.greeting')}</p></div>
      <div className="dovun-assistant-suggestions flex flex-wrap gap-2 px-3 pt-3">{(identityId === 'study' ? studySuggestions() : suggestions(chat.context?.page ?? '')).map((item) => <Button key={item} size="sm" variant="outline" className="h-auto whitespace-normal text-left" onClick={() => setInput(input.trim() ? `${input}\n\n${item}` : item)}>{item}</Button>)}</div>
      </>} messages={messages} activeRunId={chat.activeRunId} approvals={approvals} approvalPending={approve.isPending || reject.isPending} executingApprovalId={executingApprovalId} unknownApprovalIds={unknownApprovalIds} unresolvedApprovalIds={unresolvedApprovalIds} phase={decisionPhase} onApprove={(id) => approve.mutate(id)} onReject={(id) => reject.mutate(id)} onChanged={refreshApprovals} onRepreviewed={showRepreview} sendSeq={sendSeq} /></AssistantInputProvider>
      {pausedRun && ['new_user_message', 'interrupted', 'round_limit'].includes(pausedRun.reason) && (
        <div className="mx-3 mb-2 flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-xs">
          <span>{pausedRun.reason === 'new_user_message' ? t('system.pausedFollowUp') : t('chatPanel.requestPaused')}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void resume()}>{t('chatPanel.continueRequest')}</Button>
        </div>
      )}

      {interrupted && (
        <Surface as="div" tone="subtle" className={cn('glass-subtle mx-3 mb-2 flex items-center justify-between gap-3 rounded-xl border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive')}>
          <span>{t('chatPanel.connectionDropped')}</span>
          <Button size="sm" variant="outline" className="h-7 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={retry}>
            <RotateCcw />{t('actions.retry')}
          </Button>
        </Surface>
      )}

      <div className="assistant-composer-area shrink-0" data-testid="assistant-context">
        {chat.attachments.length > 0 && <div className="assistant-attachments">{chat.attachments.map((item) => <div className="assistant-attachment" key={item.id}><span className="min-w-0 flex-1 truncate">{t(item.unsaved ? 'chatPanel.unsavedAttachment' : 'chatPanel.selectedAttachment', { title: item.title })}</span><Button variant="ghost" size="icon-xs" onClick={() => chat.removeAttachment(item.id)} aria-label={t('chatPanel.removeAttachment', { title: item.title })}><X /></Button></div>)}</div>}
        <ChatComposer input={input} busy={busy} reference={referencedApproval} onChange={setInput} onSend={send} onCancelReference={clearReference} placeholder={messages.length ? t('composer.continuePlaceholder') : t('composer.placeholder')} onStop={() => void chat.stop()} stopping={chat.stopping} toolbar={<>
          <ChatReferencePicker selectedIds={chat.context?.selectedMaterialIds ?? []} onSelect={chat.addMaterial} />
          <WebSearchToggle enabled={chat.webSearchEnabled} busy={busy} onToggle={chat.setWebSearch} />
          {chat.context && <Popover><PopoverTrigger asChild><Button variant="plain" size="bare" type="button" className="assistant-context-trigger" data-testid="assistant-context-trigger" title={chat.context.label}><span>{t(chat.pinned ? 'chatPanel.referencePinned' : 'chatPanel.reference')}{materialCount > 0 && ` · ${materialCount}`}</span><span className="sr-only"> {chat.context.label}</span><ChevronDown className="size-3" /></Button></PopoverTrigger><PopoverContent data-assistant-floating side="top" onEscapeKeyDown={event => event.stopPropagation()} className="w-80 max-w-[calc(100vw-2rem)] p-3"><h3 className="mb-2 text-sm font-semibold">{t('chatPanel.referenceScope')}</h3><ContextSummary context={chat.context} /><Button size="sm" variant="ghost" onClick={chat.togglePin}>{chat.pinned ? t('chatPanel.followPage') : t('chatPanel.pinContext')}</Button></PopoverContent></Popover>}
        </>} />
      </div>
      {usageOpen && <Modal title={t('usage.title')} onClose={() => setUsageOpen(false)} onCloseAutoFocus={event => { event.preventDefault(); if (moreTrigger.current?.getClientRects().length) moreTrigger.current.focus(); }} data-assistant-floating className="assistant-usage-dialog"><header className="mb-3 flex justify-end"><Button variant="ghost" size="icon-sm" aria-label={t('chatPanel.closeDetails')} onClick={() => setUsageOpen(false)}><X /></Button></header><ContextUsageDetails stats={chat.contextStats} preview={chat.contextPreview} busy={busy} onNavigate={() => setUsageOpen(false)} /></Modal>}

    </div>
  );
}
