import './conversation.css';
import { Surface } from '@/components/ui/surface.js';
import mark from '@/assets/dovun-mark.svg';
import { settingsHash } from '@/components/settings/settings-categories.js';
import { ContextSummary } from './ContextSummary.js';
import { suggestions, studySuggestions } from '@/lib/assistant-context.js';
import { ArrowLeft, Ellipsis, Maximize2, Minimize2, PanelLeft, RotateCcw, SquarePen, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useChat } from '@/hooks/useChat.js';
import { api, type Settings } from '@/lib/api.js';
import { useQuery } from '@tanstack/react-query';
import { json, usePlatformAction } from '@/lib/platform.js';
import { intlLocale } from '../../i18n/index.js';
import { cn } from '@/lib/utils.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { ChatHistory, ChatReferencePicker } from './ChatPickers.js';
import { Button } from '@/components/ui/button.js';
import { MessageList } from './MessageList.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { openSkillEditor } from '@/components/skills/skill-format.js';
import { ContextUsageDetails } from './ContextUsageDetails.js';
import { ContextUsageRing } from './ContextUsageRing.js';
import { compactTokens, shownContextUsage, windowPercent } from '@/lib/context-usage.js';
import { ChatComposer } from './ChatComposer.js';
import { ChatModelPicker } from './ChatModelPicker.js';
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
  const [inputToolsOpen, setInputToolsOpen] = useState(false);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const toolsTrigger = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  // The header and the dock float over the message list; the list reserves the dock's live height.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const dock = dockRef.current;
    if (!root || !dock) return;
    const sync = () => root.style.setProperty('--assistant-dock-height', `${dock.offsetHeight}px`);
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(sync);
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);
  const studyMoreTrigger = useRef<HTMLButtonElement>(null);
  const usageTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const closeDetails = () => { setUsageOpen(false); setInputToolsOpen(false); setBriefingOpen(false); };
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
  const usageShown = shownContextUsage(chat.contextStats, chat.contextPreview, busy);
  const usagePercent = usageShown ? windowPercent(usageShown) : null;
  const usageValue = usageShown ? usagePercent === null ? t('usage.tokenValue', { tokens: compactTokens(usageShown.estimatedInputTokens) }) : t('usage.percentValue', { percent: Math.round(usagePercent) }) : busy ? t('usage.estimating') : '—';
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
  const showLayoutActions = Boolean(onReturnToLearning || (identityId === 'study' && learningReference)
    || (presentation === 'side' && (onExpand || showClose)) || (presentation === 'expanded' && onShrink)
    || (mobile && onOpenNavigation));
  const newTopic = () => { if (chat.switchingBlocked) return; startNew(); setTopicId(''); setInput(t('studyTopic.newPrompt')); };
  const conversationNotice = <>
      {!settings.isLoading && !settings.error && !configured && <p className="shrink-0 px-4 py-2 text-xs text-muted-foreground">{t('chatPanel.configureModel')} <a className="font-medium text-brand-link underline-offset-4 hover:underline" href={`#${settingsHash('model')}`}>{t('chatPanel.configureModelAction')}</a></p>}
      {chat.draftStorageFailed&&<p role="alert" className="mx-3 shrink-0 rounded-lg border border-destructive/30 p-3 text-xs text-destructive">{t('errors.draftStorageFailed')}</p>}
      {chat.hasLegacyPending&&<p role="status" className="mx-3 shrink-0 rounded-lg border p-3 text-xs text-muted-foreground">{t('chatPanel.legacyPendingHint')}</p>}
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
  </>;
  return (
    <div ref={rootRef} className="dovun-assistant assistant-glass flex h-full min-h-0 min-w-0 flex-col" data-testid="ai-assistant" data-presentation={presentation} data-scrolled={scrolled || undefined}>
      <header className="assistant-header flex shrink-0 items-center gap-1 px-3 py-3" data-chat-tools-region="header">
        <div className="assistant-identity min-w-0 flex-1">
          <h2 className="truncate">{t(identityId === 'study' ? 'chatPanel.identityStudy' : 'chatPanel.identityWork')}</h2>
          <span className="sr-only" role="status">{busy ? t('status.working') : interrupted ? t('status.interrupted') : settings.isLoading ? t('status.checking') : settings.error ? t('status.unknown') : configured ? t('status.available') : t('status.noModel')}</span>
        </div>
        <ChatHistory busy={chat.switchingBlocked || action.busy} currentId={chat.conversationId} identityId={identityId} onSelect={chat.selectConversation} />
        <Button variant="ghost" size="icon-sm" disabled={chat.switchingBlocked} onClick={startNew} aria-label={t('chatPanel.newConversation')} title={t('chatPanel.newConversation')}><SquarePen /></Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button data-testid="assistant-more-actions" variant="ghost" size="icon-sm" aria-label={t('chatPanel.moreActions')} title={t('chatPanel.moreActions')}><Ellipsis /></Button></DropdownMenuTrigger>
          <DropdownMenuContent data-assistant-floating align="end" className="w-64 max-w-[calc(100vw-2rem)]">
            {onSwitchIdentity && <DropdownMenuGroup>
              <DropdownMenuLabel>{t('chatPanel.switchIdentity')}</DropdownMenuLabel>
              <DropdownMenuItem disabled={chat.switchingBlocked || identityId === 'work'} onSelect={() => onSwitchIdentity('work')}>{t('chatPanel.identityWork')}</DropdownMenuItem>
              <DropdownMenuItem disabled={chat.switchingBlocked || identityId === 'study'} onSelect={() => onSwitchIdentity('study')}>{t('chatPanel.identityStudy')}</DropdownMenuItem>
            </DropdownMenuGroup>}
            {showLayoutActions && <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t('chatPanel.layoutGroup')}</DropdownMenuLabel>
              {onReturnToLearning && <DropdownMenuItem onSelect={onReturnToLearning}><ArrowLeft />{t('chatPanel.backToLearning')}</DropdownMenuItem>}
              {identityId === 'study' && learningReference && <p className="truncate px-2 text-xs text-muted-foreground" title={learningReference.title}>{t('chatPanel.learningReference', { title: learningReference.title })}</p>}
              {presentation === 'side' && onExpand && <DropdownMenuItem onSelect={onExpand}><Maximize2 />{t('chatPanel.expand')}</DropdownMenuItem>}
              {presentation === 'expanded' && onShrink && !onReturnToLearning && <DropdownMenuItem onSelect={onShrink}><Minimize2 />{t('chatPanel.shrink')}</DropdownMenuItem>}
              {presentation === 'side' && showClose && !onReturnToLearning && <DropdownMenuItem onSelect={onClose}><X />{t(mobile ? 'chatPanel.backToPage' : 'chatPanel.closeChat')}</DropdownMenuItem>}
              {mobile && onOpenNavigation && <DropdownMenuItem onSelect={onOpenNavigation}><PanelLeft />{t('app:shell.mainNav')}</DropdownMenuItem>}
            </DropdownMenuGroup>
            </>}
            {onSwitchIdentity || showLayoutActions ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t('chatPanel.saveGroup')}</DropdownMenuLabel>
              <DropdownMenuItem disabled={busy || action.busy || !chat.conversationId || !messages.length} onSelect={() => void action.run(() => api('/api/v1/knowledge/materials/from-conversation', { method: 'POST', body: json({ conversationId: chat.conversationId, topicId: chat.selectedTopicId || null, title: t('chatPanel.sessionMaterialTitle', { time: new Date().toLocaleString(intlLocale()) }) }) }), t('chatPanel.sessionSaved'))}>{t('chatPanel.saveSession')}</DropdownMenuItem>
              <DropdownMenuItem disabled={busy || drafting || !chat.conversationId || !messages.length} onSelect={() => void saveAsSkill()}>{t('chatPanel.saveAsSkill')}</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <AssistantInputProvider setInput={setInput}><MessageList emptyState={<>
      <div className="dovun-assistant-welcome"><img src={mark} alt="" /><h3>{t(identityId === 'study' ? 'chatPanel.studyWelcomeTitle' : 'chatPanel.title')}</h3><p>{t(identityId === 'study' ? 'chatPanel.studyGreeting' : 'chatPanel.greeting')}</p></div>
      <Surface tone="sheet" className="dovun-assistant-suggestions workspace-chat-prompts workspace-rows">{(identityId === 'study' ? studySuggestions() : suggestions(chat.context?.page ?? '')).map((item) => <Button key={item} size="sm" variant="row" className="workspace-row h-auto whitespace-normal text-left" onClick={() => setInput(input.trim() ? `${input}\n\n${item}` : item)}>{item}</Button>)}</Surface>
      </>} messages={messages} activeRunId={chat.activeRunId} approvals={approvals} approvalPending={approve.isPending || reject.isPending} executingApprovalId={executingApprovalId} unknownApprovalIds={unknownApprovalIds} unresolvedApprovalIds={unresolvedApprovalIds} phase={decisionPhase} onApprove={(id) => approve.mutate(id)} onReject={(id) => reject.mutate(id)} onChanged={refreshApprovals} onRepreviewed={showRepreview} sendSeq={sendSeq} notice={conversationNotice} onScrolledChange={setScrolled} /></AssistantInputProvider>
      <div ref={dockRef} className="assistant-dock">
      {identityId === 'study' && <StudyTopicBar topicId={topicId} focusNodeId={focusNodeId} disabled={chat.switchingBlocked} onSelectTopic={(id) => void chat.selectTopic(id)} onNewTopic={newTopic} moreTrigger={studyMoreTrigger} onBriefing={() => setBriefingOpen(true)}
        onOpenNode={(hash) => { window.location.hash = hash; if (mobile) onClose(); }} onAsk={(prompt) => setInput(input.trim() ? `${input}\n\n${prompt}` : prompt)} />}

      <div className="assistant-composer-area assistant-compact-footer shrink-0" data-testid="assistant-context" data-chat-tools-region="composer">
        <span className="sr-only">{chat.contextCleared ? t('chatPanel.noReference') : chat.context?.label}</span>
        <ChatComposer input={input} busy={busy} reference={referencedApproval} onChange={setInput} onSend={send} placeholder={messages.length ? t('composer.continuePlaceholder') : t('composer.placeholder')} onStop={() => void chat.stop()} stopping={chat.stopping}
          compactTools={<Button ref={toolsTrigger} type="button" variant="ghost" size="icon" className="size-11 shrink-0" data-testid="assistant-input-tools" aria-haspopup="dialog" aria-expanded={inputToolsOpen} aria-label={t('chatPanel.inputTools')} title={chat.contextCleared ? t('chatPanel.noReference') : chat.context?.label} onClick={() => setInputToolsOpen(true)}><Ellipsis />{(materialCount > 0 || referencedApproval) && <span className="assistant-tools-indicator" aria-hidden="true" />}</Button>}
          contextUsage={<Button ref={usageTrigger} type="button" variant="plain" size="bare" className="assistant-context-trigger assistant-context-ring-trigger shrink-0" data-testid="context-usage-trigger" aria-label={`${t('usage.open')} · ${usageValue}`} title={`${t('usage.open')} · ${usageValue}`} onClick={() => setUsageOpen(true)}><ContextUsageRing stats={usageShown} pending={busy} /></Button>} />
      </div>
      </div>
      {identityId === 'study' && topicId && briefingOpen && <Modal title={t('briefing.title')} onClose={() => setBriefingOpen(false)} onCloseAutoFocus={event => {
        const trigger = studyMoreTrigger.current;
        if (trigger) { event.preventDefault(); trigger.focus(); }
      }} data-assistant-floating className="assistant-tools-sheet">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t('briefing.title')}</h3><Button variant="ghost" size="icon-sm" aria-label={t('chatPanel.closeDetails')} onClick={() => setBriefingOpen(false)}><X /></Button></div>
        <StudyBriefing key={topicId} topicId={topicId} />
      </Modal>}
      {inputToolsOpen && <Modal title={t('chatPanel.inputTools')} onClose={() => setInputToolsOpen(false)} onCloseAutoFocus={event => { event.preventDefault(); toolsTrigger.current?.focus(); }} data-assistant-floating className="assistant-tools-sheet">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t('chatPanel.inputTools')}</h3><Button variant="ghost" size="icon-sm" aria-label={t('chatPanel.closeDetails')} onClick={() => setInputToolsOpen(false)}><X /></Button></div>
        <section className="min-w-0 space-y-2" aria-label={t('chatPanel.referenceGroup')}>
          <h4 className="text-xs font-semibold text-muted-foreground">{t('chatPanel.referenceGroup')}</h4>
          <div className="flex flex-wrap items-center gap-1">
            <ChatReferencePicker selectedIds={chat.context?.selectedMaterialIds ?? []} onSelect={chat.addMaterial} />
            {chat.context && <Popover><PopoverTrigger asChild><Button variant="ghost" size="sm" type="button" data-testid="assistant-context-trigger" title={chat.contextCleared ? t('chatPanel.noReference') : chat.context.label}><span>{t(chat.pinned ? 'chatPanel.referencePinned' : 'chatPanel.reference')}{materialCount > 0 && ` · ${materialCount}`}</span></Button></PopoverTrigger><PopoverContent data-assistant-floating side="top" onEscapeKeyDown={event => event.stopPropagation()} className="w-80 max-w-[calc(100vw-2rem)] p-3"><h3 className="mb-2 text-sm font-semibold">{t('chatPanel.referenceScope')}</h3>{chat.contextCleared ? <p className="py-1 text-xs text-muted-foreground">{t('chatPanel.noReference')}</p> : <ContextSummary context={chat.context} />}<div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={chat.pinContext}>{t('chatPanel.pinContext')}</Button><Button size="sm" variant="ghost" disabled={chat.contextCleared && chat.attachments.length === 0} onClick={chat.clearContext}>{t('chatPanel.clearContext')}</Button></div></PopoverContent></Popover>}
          </div>
          {referencedApproval && <div className="flex items-center justify-between gap-2 text-xs"><span>{t('composer.adjusting', { title: referencedApproval.title })}</span><Button type="button" variant="ghost" size="sm" onClick={clearReference}>{t('composer.removeReference')}</Button></div>}
          {chat.attachments.length > 0 && <div className="assistant-attachments">{chat.attachments.map(item => <div className="assistant-attachment" key={item.id}><span className="min-w-0 flex-1 truncate">{t(item.unsaved ? 'chatPanel.unsavedAttachment' : 'chatPanel.selectedAttachment', { title: item.title })}</span><Button type="button" variant="ghost" size="icon-xs" onClick={() => chat.removeAttachment(item.id)} aria-label={t('chatPanel.removeAttachment', { title: item.title })}><X /></Button></div>)}</div>}
        </section>
        <section className="min-w-0 space-y-2 border-t pt-3" aria-label={t('chatPanel.generationGroup')}>
          <h4 className="text-xs font-semibold text-muted-foreground">{t('chatPanel.generationGroup')}</h4>
          <div className="flex min-w-0 flex-wrap items-center gap-2"><ChatModelPicker settings={settings.data} disabled={busy} /><WebSearchToggle enabled={chat.webSearchEnabled} busy={busy} onToggle={chat.setWebSearch} /></div>
        </section>
      </Modal>}
      {usageOpen && <Modal title={t('usage.title')} onClose={() => setUsageOpen(false)} onCloseAutoFocus={event => { event.preventDefault(); if (usageTrigger.current?.getClientRects().length) usageTrigger.current.focus(); }} data-assistant-floating className="assistant-usage-dialog"><header className="mb-3 flex justify-end"><Button variant="ghost" size="icon-sm" aria-label={t('chatPanel.closeDetails')} onClick={() => setUsageOpen(false)}><X /></Button></header><ContextUsageDetails stats={chat.contextStats} preview={chat.contextPreview} busy={busy} onNavigate={() => setUsageOpen(false)} /></Modal>}

    </div>
  );
}
