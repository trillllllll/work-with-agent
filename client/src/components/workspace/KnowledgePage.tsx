import { MemoryExtractionJobs } from './MemoryExtractionJobs.js';
import { usePageContext } from '@/lib/assistant-context.js';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { intlLocale } from '../../i18n/index.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Topic } from '@/lib/api.js';
import { titleFromFileName } from '@/lib/attachment-title.js';
import { json, parseStored, submitCommands, usePlatformAction, type Command } from '@/lib/platform.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { BodyText } from '@/components/shared/BodyText.js';
import type { KnowledgeSection } from '@/hooks/useHashRoute.js';
import { ContextPicker, type Evidence } from './ContextPicker.js';
import { KnowledgeGraph } from './KnowledgeGraph.js';
import { KnowledgeTree } from './KnowledgeTree.js';
import { MaterialBrowser } from './MaterialBrowser.js';
import { OrganizationPrompt } from './OrganizationPrompt.js';
import { asLabels, MemorySummary, memoryKindKeys, originKeys, Stars } from './memory-view.js';
import './work-context.css';

type PageResult<T> = { items: T[]; total: number; nextCursor: number | null };
type Resource = { id: string; title: string; kind: string; revision: number; content?: string; uri?: string; health?: string; status?: string; evidence?: Evidence[]; archivedAt?: string | null; versions?: any[]; importance?: number; labels?: string[]; origin?: string; createdAt?: string; updatedAt?: string };
type ResourceEditing = { id: string; scope: string; resource?: Resource };
type BriefDraft = { notes: string; revision: number };
type KnowledgeTab = KnowledgeSection;
type MemoryStatus = 'active' | 'history' | 'all';
type AutoJobStatus = 'queued' | 'running' | 'proposed' | 'completed' | 'failed' | 'cancelled';
type AutoMemoryState = {
  scopeKey: string;
  topicId: string | null;
  enabled: boolean;
  revision: number;
  state: 'disabled' | 'unconfigured' | 'archived' | 'queued' | 'running' | 'failed' | 'idle';
  pendingSourceCount: number;
  failedSourceCount: number;
  pendingProposalCount: number;
  dueAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  latestJob: null | { id: string; status: AutoJobStatus; errorCode: string | null; errorMessage: string | null };
};
type ProposalItem = { id: string; revision: number; status: string; commands: Command[] | string; preview: unknown; createdAt: string };

const PAGE_SIZE = 40;
const proposalActionKinds = ['memory.create', 'memory.update', 'memory.retire'] as const;

function scopeQuery(topicId: string) {
  return `topicId=${encodeURIComponent(topicId || 'inbox')}`;
}

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'object' && 'props' in node) return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  return '';
}

function useSubmittedQuery(value: string) {
  const [submitted, setSubmitted] = useState('');
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (composing) return;
    const handle = window.setTimeout(() => setSubmitted(value.trim()), 200);
    return () => window.clearTimeout(handle);
  }, [value, composing]);
  return {
    submitted,
    onCompositionStart: () => setComposing(true),
    onCompositionEnd: () => setComposing(false),
  };
}

export function KnowledgePage({
  topics,
  archivedTopics = [],
  initialTopicId = '',
  topicId: controlledTopicId,
  topicExplicit = false,
  topicsReady = true,
  section: controlledSection,
  taskId,
  initialTab,
  onLocate,
  onOpenSettings,
}: {
  topics: Topic[];
  archivedTopics?: Topic[];
  initialTopicId?: string;
  topicId?: string;
  topicExplicit?: boolean;
  topicsReady?: boolean;
  section?: KnowledgeTab;
  taskId?: string;
  initialTab?: KnowledgeTab;
  onLocate?: (section: KnowledgeTab, topicId: string) => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation('knowledge');
  const primaryTabs = [
    ['brief', t('page.tabs.brief'), t('page.tabs.briefNote')],
    ['materials', t('page.tabs.materials'), t('page.tabs.materialsNote')],
    ['memories', t('page.tabs.memories'), t('page.tabs.memoriesNote')],
  ] as const;
  const embedded = Boolean(taskId);
  const [localTopic, setLocalTopic] = useState(initialTopicId);
  const [localSection, setLocalSection] = useState<KnowledgeTab>(initialTab ?? 'materials');
  const topicId = embedded ? localTopic : (controlledTopicId ?? '');
  const section = embedded ? localSection : (controlledSection ?? 'brief');
  const [cursor, setCursor] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [memoryInput, setMemoryInput] = useState('');
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus>('active');
  const [searchHistory, setSearchHistory] = useState(false);
  const [editing, setEditing] = useState<ResourceEditing | null>(null);
  const [briefDrafts, setBriefDrafts] = useState<Record<string, BriefDraft | null>>({});
  const [opened, setOpened] = useState('');
  const searchQuery = useSubmittedQuery(searchInput);
  const memoryQuery = useSubmittedQuery(memoryInput);
  usePageContext(embedded ? 'embedded-knowledge' : 'knowledge', { scope: section === 'extractions' && topicId === 'all' ? { kind: 'all' } : topicId ? { kind: 'topic', topicId } : { kind: 'inbox' }, section, pageState: { selectedId: opened, status: memoryStatus, query: section === 'memories' ? memoryQuery.submitted : searchQuery.submitted } });
  const knownTopics = [...topics, ...archivedTopics.filter((topic) => !topics.some((item) => item.id === topic.id))];
  const missing = !embedded && topicExplicit && topicId !== '' && !(section === 'extractions' && topicId === 'all') && topicsReady && !knownTopics.some((topic) => topic.id === topicId);
  const scope = scopeQuery(topicId);
  const editorScope = `${topicId}:${section}`;
  const activeEditor = editing?.scope === editorScope ? editing : null;
  const locate = (nextSection: KnowledgeTab, nextTopic = topicId) => {
    if (nextSection !== 'extractions' && nextTopic === 'all') nextTopic = '';
    if (embedded) { setLocalTopic(nextTopic); setLocalSection(nextSection); return; }
    onLocate?.(nextSection, nextTopic);
  };
  const openEditor = (resource?: Resource) => setEditing({ id: crypto.randomUUID(), scope: editorScope, resource });
  const updateBriefDraft = (update: (current: BriefDraft | null) => BriefDraft | null) => setBriefDrafts((drafts) => ({ ...drafts, [topicId]: update(drafts[topicId] ?? null) }));
  useEffect(() => { if (embedded && initialTab) setLocalSection(initialTab); }, [embedded, initialTab]);
  useEffect(() => { setCursor(0); setOpened(''); }, [topicId, section]);
  useEffect(() => { setCursor(0); }, [memoryQuery.submitted, searchQuery.submitted, memoryStatus]);
  const auto = useQuery({
    queryKey: ['auto-memory', topicId],
    queryFn: ({ signal }) => api<AutoMemoryState>(`/api/v1/knowledge/auto-memory?${scope}`, { signal }),
    enabled: !embedded && !missing && section !== 'extractions',
    refetchInterval: (query) => {
      if (document.visibilityState !== 'visible') return false;
      const name = query.state.data?.state;
      return name === 'queued' || name === 'running' ? 3000 : 15000;
    },
  });
  const refreshAuto = auto.refetch;
  useEffect(() => {
    const onChange = () => { if (document.visibilityState === 'visible') void refreshAuto(); };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, [refreshAuto]);
  const tabNote = primaryTabs.find(([value]) => value === section)?.[2] ?? (section === 'memories' ? primaryTabs[2][2] : primaryTabs.find(([value]) => value === 'brief')?.[2]);
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const order = primaryTabs.map(([value]) => value);
    const current = order.indexOf(section as typeof order[number]);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : event.key === 'ArrowRight' ? (Math.max(current, 0) + 1) % order.length : (Math.max(current, 0) + order.length - 1) % order.length;
    const target = order[next];
    locate(target);
    window.setTimeout(() => document.getElementById(`context-tab-${target}`)?.focus(), 0);
  };
  const brief = <BriefPanel key={topicId} topicId={topicId || null} draft={briefDrafts[topicId] ?? null} updateDraft={updateBriefDraft} />;
  const materials = <MaterialBrowser topicId={topicId || null} taskId={taskId} onCreate={() => openEditor()} onEdit={(item) => openEditor(item as Resource)}>{activeEditor && <ResourceEditor key={activeEditor.id} type="materials" resource={activeEditor.resource} topicId={topicId || null} taskId={taskId} onClose={() => setEditing((current) => current?.id === activeEditor.id ? null : current)} />}</MaterialBrowser>;
  const memories = <MemoryBrowser embedded={embedded} topicId={topicId} scope={scope} cursor={cursor} setCursor={setCursor} status={memoryStatus} setStatus={(value) => { setMemoryStatus(value); setCursor(0); }} input={memoryInput} setInput={setMemoryInput} submitted={memoryQuery.submitted} onCompositionStart={memoryQuery.onCompositionStart} onCompositionEnd={memoryQuery.onCompositionEnd} opened={opened} setOpened={setOpened} activeEditor={activeEditor} openEditor={openEditor} closeEditor={() => setEditing((current) => current?.id === activeEditor?.id ? null : current)} auto={auto.data} onShowProposals={() => locate('brief')} onShowMaterials={() => locate('materials')} onShowRecords={embedded ? undefined : () => locate('extractions')} />;
  const search = <ContextSearch topicId={topicId} scope={scope} cursor={cursor} setCursor={setCursor} input={searchInput} setInput={setSearchInput} submitted={searchQuery.submitted} history={searchHistory} setHistory={(value) => { setSearchHistory(value); setCursor(0); }} onCompositionStart={searchQuery.onCompositionStart} onCompositionEnd={searchQuery.onCompositionEnd} />;
  const listName = topicId ? knownTopics.find((topic) => topic.id === topicId)?.name ?? t('page.unknownList') : t('page.inbox');
  const pendingCount = auto.data?.pendingProposalCount ?? 0;
  const progress = embedded ? brief : <div className="ctx-desk">
    <div className="ctx-brief-col" data-testid="context-brief">
      <p className="ctx-kicker">{t('page.brief.kicker')} <span className="ctx-muted">· {listName}</span></p>
      {brief}
      <OrganizationPanel topicId={topicId || null} />
    </div>
    <aside className="ctx-rail" data-testid="context-rail" aria-label={t('page.proposal.queue')}>
      <AutoStatus topicId={topicId} state={auto.data} error={auto.error} onRetry={() => void auto.refetch()} onOpenSettings={onOpenSettings} onShowRecords={() => locate('extractions')} />
      <div className="ctx-rail-list">
        <p className="ctx-kicker ctx-kicker-spread">{t('page.proposal.queue')} <span className="ctx-count">{pendingCount}</span></p>
        {auto.isSuccess && pendingCount === 0 && <p className="ctx-muted ctx-proposal-empty">{t('page.proposal.empty')}</p>}
        <MemoryProposals topicId={topicId} scope={scope} count={pendingCount} />
      </div>
    </aside>
  </div>;
  const body = missing ? <p role="alert" className="ctx-error">{t('page.missingList')}</p> : section === 'extractions' ? <MemoryExtractionJobs topicId={topicId} /> : section === 'tree' ? <KnowledgeTree topicId={topicId || null} brief={brief} /> : section === 'graph' ? <KnowledgeGraph topicId={topicId || null} /> : section === 'search' ? search : section === 'materials' ? materials : section === 'memories' ? memories : progress;
  if (embedded) {
    return <section className="work-context work-context-embed space-y-4">
      <div role="tablist" aria-label={t('page.embeddedTabs')} className="ctx-tabs" onKeyDown={onTabKey}>
        {([['materials', t('page.tabs.materials')], ['memories', t('page.tabs.memories')], ['brief', t('page.tabs.brief')], ['search', t('page.tabs.search')]] as const).map(([value, label]) => <button key={value} id={`context-tab-${value}`} type="button" role="tab" className="ctx-tab" aria-selected={section === value} tabIndex={section === value ? 0 : -1} onClick={() => locate(value)}>{label}</button>)}
      </div>
      {section === 'memories' && <p className="ctx-muted">{t('page.embeddedMemoryNote')}</p>}
      {body}
    </section>;
  }
  const viewLabel = section === 'tree' ? t('page.view.tree') : section === 'graph' ? t('page.view.graph') : t('page.view.standard');
  return <section data-testid="work-context" className="work-context">
    <div className="work-context-frame">
      <div className="work-context-main">
        <header className="ctx-header">
          <div className="ctx-header-row">
            <h1 className="ctx-title">{t('page.title')}</h1>
          <div data-testid="context-toolbar" className="ctx-tools">
            <label className="ctx-muted">{t('page.list')}
              <select aria-label={t('page.list')} className="ctx-select" value={topicId} onChange={(event) => locate(section === 'search' || section === 'tree' || section === 'graph' || section === 'extractions' ? section : (primaryTabs.some(([value]) => value === section) ? section : 'brief'), event.target.value)}>
                <option value="">{t('page.inbox')}</option>{section === 'extractions' && <option value="all">{t('page.allLists')}</option>}
                {missing && <option value={topicId}>{t('page.unknownList')}</option>}
                {knownTopics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}{topic.archivedAt ? t('page.archivedSuffix') : ''}</option>)}
              </select>
            </label>
            <Button type="button" className="ctx-btn" aria-pressed={section === 'search'} onClick={() => locate('search')}>{t('page.tabs.search')}</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button type="button" className="ctx-btn" aria-label={t('page.viewMode')}>{viewLabel}</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => locate(primaryTabs.some(([value]) => value === section) ? section : 'brief')}>{t('page.view.standard')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => locate('tree')}>{t('page.view.tree')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => locate('graph')}>{t('page.view.graph')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button type="button" className="ctx-btn">{t('page.more')}</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild><a href={`/api/v1/knowledge/export?${scope}`}>{t('page.exportScope')}</a></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          </div>
          <p className="ctx-subtitle">{t('page.subtitle')}</p>
        </header>
        <div role="tablist" aria-label={t('page.tabsLabel')} data-testid="context-tabs" className="ctx-tabs" onKeyDown={onTabKey}>
          {primaryTabs.map(([value, label]) => {
            const selected = section === value;
            const fallback = !primaryTabs.some(([item]) => item === section) && value === 'brief';
            return <button key={value} id={`context-tab-${value}`} type="button" role="tab" className="ctx-tab" aria-selected={selected} tabIndex={selected || fallback ? 0 : -1} onClick={() => locate(value)}>{label}</button>;
          })}
        </div>
        {section !== 'tree' && section !== 'graph' && section !== 'search' && section !== 'extractions' && <p className="ctx-tab-note">{tabNote}</p>}
        {section === 'memories' && <p className="ctx-tab-note">{t('page.memoriesExtraNote')}</p>}
        {section === 'extractions' && <div className="ctx-tools"><Button variant="ghost" onClick={() => locate('memories', topicId === 'all' ? '' : topicId)}>{t('page.backToMemory')}</Button></div>}
        {body}
      </div>
    </div>
  </section>;
}

function AutoStatus({ topicId, state, error, onRetry, onOpenSettings, onShowRecords }: { topicId: string; state?: AutoMemoryState; error: Error | null; onRetry: () => void; onOpenSettings?: () => void; onShowRecords: () => void }) {
  const { t } = useTranslation('knowledge');
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [showReason, setShowReason] = useState(false);
  const runId = useRef<string | null>(null);
  const retryId = useRef<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ['auto-memory', topicId] });
  const run = async () => {
    if (!runId.current) runId.current = crypto.randomUUID();
    setBusy(true);
    setNotice('');
    try {
      const result = await api<{ accepted?: boolean; reason?: string }>('/api/v1/knowledge/auto-memory/run', { method: 'POST', body: json({ topicId: topicId || null, requestId: runId.current }) });
      if (result?.accepted === false && result.reason === 'NO_CHANGES') setNotice(t('page.auto.noChanges'));
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : t('page.auto.notStarted'));
    } finally {
      runId.current = null;
      setBusy(false);
      await refresh();
    }
  };
  const toggle = async () => {
    if (!state) return;
    setBusy(true);
    setNotice('');
    try {
      await api('/api/v1/knowledge/auto-memory', { method: 'PATCH', body: json({ topicId: topicId || null, enabled: !state.enabled, expectedRevision: state.revision }) });
    } catch (caught) {
      setNotice(caught instanceof ApiError ? caught.message : t('page.auto.settingsNotSaved'));
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const retry = async () => {
    if (!state?.latestJob || state.latestJob.status !== 'failed') return;
    if (!retryId.current) retryId.current = crypto.randomUUID();
    setBusy(true);
    setNotice('');
    try {
      await api(`/api/v1/knowledge/auto-memory/jobs/${state.latestJob.id}/retry`, { method: 'POST', body: json({ requestId: retryId.current }) });
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : t('page.auto.retryNotStarted'));
    } finally {
      retryId.current = null;
      setBusy(false);
      await refresh();
    }
  };
  const label = state ? t(`page.auto.states.${state.state}`) : t('page.auto.states.loading');
  const failedCount = state?.failedSourceCount ?? 0;
  const pendingCount = state?.pendingProposalCount ?? 0;
  const showFailure = !!state && (state.state === 'running' || state.state === 'queued') && failedCount > 0;
  const statusText = showFailure && pendingCount > 0
    ? t('page.auto.lineFailurePending', { label, failedCount, pendingCount })
    : showFailure
      ? t('page.auto.lineFailure', { label, count: failedCount })
      : pendingCount > 0
        ? t('page.auto.linePending', { label, count: pendingCount })
        : label;
  const failed = state?.state === 'failed' || failedCount > 0;
  return <section data-testid="context-auto-status" className="ctx-status" aria-label={t('page.auto.label')}>
    <div className="ctx-status-copy">
      <p className={failed ? 'ctx-status-label ctx-warning' : 'ctx-status-label'}>{statusText}</p>
      <p className="ctx-muted">{t('page.auto.description')}</p>
      {state?.state === 'unconfigured' && <p className="ctx-warning">{t('page.auto.unconfiguredWarning')}</p>}
      {error && <p role="alert" className="ctx-error">{error.message}</p>}
      {notice && <p role="alert" className="ctx-error">{notice}</p>}
      {showReason && <p className="ctx-error">{state?.latestJob?.errorMessage || state?.latestJob?.errorCode || t('page.auto.failed')}</p>}
    </div>
    <div className="ctx-actions">
      {state?.state === 'unconfigured' && <Button type="button" className="ctx-btn" onClick={onOpenSettings}>{t('page.auto.configureModel')}</Button>}
      <Button type="button" className="ctx-btn" onClick={onShowRecords}>{t('page.extractionHistory')}</Button>
      {error && <Button type="button" className="ctx-btn" onClick={onRetry}>{t('page.auto.retry')}</Button>}
      <Button type="button" className="ctx-btn ctx-btn-primary" disabled={busy || !state || state.state === 'disabled' || state.state === 'archived' || state.state === 'unconfigured'} onClick={() => void run()}>{t('page.auto.extractNow')}</Button>
      <Button type="button" className="ctx-btn" disabled={busy || !state || state.state === 'archived'} onClick={() => void toggle()}>{state?.enabled === false ? t('page.auto.enable') : t('page.auto.pause')}</Button>
      {failed && <Button type="button" className="ctx-btn" aria-expanded={showReason} onClick={() => setShowReason((value) => !value)}>{t('page.auto.viewReason')}</Button>}
      {state?.latestJob?.status === 'failed' && <Button type="button" className="ctx-btn" disabled={busy} onClick={() => void retry()}>{t('page.auto.retry')}</Button>}
    </div>
  </section>;
}

function MemoryProposals({ topicId, scope, count }: { topicId: string; scope: string; count: number }) {
  const [cursor, setCursor] = useState(0);
  const query = useQuery({
    queryKey: ['auto-memory-proposals', topicId, cursor],
    queryFn: ({ signal }) => api<PageResult<ProposalItem>>(`/api/v1/knowledge/auto-memory/proposals?${scope}&cursor=${cursor}&limit=20`, { signal }),
    enabled: count > 0,
  });
  useEffect(() => { setCursor(0); }, [topicId]);
  if (!count || !query.data?.items.length) return null;
  return <div className="ctx-stack">
    {query.data.items.map((proposal) => <ProposalCard key={proposal.id} topicId={topicId} proposal={proposal} />)}
    <Pager testId="context-pagination" cursor={cursor} nextCursor={query.data.nextCursor} onPrevious={() => setCursor(Math.max(0, cursor - 20))} onNext={(next) => setCursor(next)} />
  </div>;
}

function ProposalCard({ topicId, proposal }: { topicId: string; proposal: ProposalItem }) {
  const { t } = useTranslation('knowledge');
  const client = useQueryClient();
  const commands = parseStored<Command[]>(proposal.commands, []);
  const command = commands.find((item) => item.kind.startsWith('memory.')) ?? commands[0];
  const input = command?.input ?? {};
  const evidence = Array.isArray(input.evidence) ? input.evidence as Evidence[] : [];
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(String(input.title ?? ''));
  const [content, setContent] = useState(String(input.content ?? ''));
  const [reason, setReason] = useState(String(input.reason ?? ''));
  const editButton = useRef<HTMLButtonElement>(null);
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['brief', topicId || null] }),
      client.invalidateQueries({ queryKey: ['knowledge', 'memories', topicId] }),
      client.invalidateQueries({ queryKey: ['knowledge', 'memories-probe', topicId] }),
      client.invalidateQueries({ queryKey: ['auto-memory', topicId] }),
      client.invalidateQueries({ queryKey: ['auto-memory-proposals', topicId] }),
      client.invalidateQueries({ queryKey: ['knowledge-tree', topicId || null] }),
      client.invalidateQueries({ queryKey: ['knowledge-graph', topicId || null] }),
    ]);
  };
  const approve = async (revision: number) => {
    await api(`/api/v1/proposals/${proposal.id}/approve`, { method: 'POST', body: json({ expectedRevision: revision, requestId: crypto.randomUUID() }) });
    setEditing(false);
    await refresh();
  };
  const confirm = async () => {
    setBusy(true);
    setError('');
    try { await approve(proposal.revision); }
    catch (caught) { setError(caught instanceof Error ? caught.message : t('page.proposal.confirmFailed')); }
    finally { setBusy(false); }
  };
  const reject = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/v1/proposals/${proposal.id}/reject`, { method: 'POST', body: json({ expectedRevision: proposal.revision }) });
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('page.proposal.rejectFailed')); }
    finally { setBusy(false); }
  };
  const saveAndConfirm = async () => {
    setBusy(true);
    setError('');
    try {
      const next = commands.map((item) => item === command ? { ...item, input: { ...item.input, title, content, reason } } : item);
      const dirty = json(next) !== json(commands);
      const saved = dirty ? await api<{ revision: number }>(`/api/v1/proposals/${proposal.id}`, { method: 'PATCH', body: json({ expectedRevision: proposal.revision, commands: next }) }) : proposal;
      await approve(saved.revision);
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('page.proposal.confirmFailed')); }
    finally { setBusy(false); }
  };
  const actionKind = proposalActionKinds.find((kind) => kind === command?.kind);
  const action = actionKind ? t(`page.proposal.actions.${actionKind}`) : t('page.proposal.suggestion');
  const titleText = String(input.title ?? '');
  const bodyText = String(input.content ?? '').replace(/\s+/g, ' ').trim();
  return <article data-testid={`context-proposal-${proposal.id}`} className="ctx-proposal">
    <p className="ctx-proposal-kind">{action}</p>
    <p className="ctx-proposal-title">{titleText}</p>
    {bodyText && <p className="ctx-proposal-snip">{bodyText}</p>}
    <div className="ctx-actions mt-2">
      <Button type="button" className="ctx-btn" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{t('page.proposal.evidence')}</Button>
      <Button type="button" className="ctx-btn ctx-btn-primary" disabled={busy} onClick={() => void confirm()}>{t('page.proposal.confirm')}</Button>
      <Button type="button" className="ctx-btn" disabled={busy} onClick={() => void reject()}>{t('page.proposal.reject')}</Button>
      <Button ref={editButton} type="button" className="ctx-btn" disabled={busy} onClick={() => setEditing(true)}>{t('page.proposal.editConfirm')}</Button>
    </div>
    {open && <div className="ctx-proposal-more">
      {bodyText && <BodyText text={String(input.content ?? '')} className="ctx-body" />}
      <p className="ctx-muted">{t('page.proposal.reasonLine', { reason: String(input.reason ?? '') })}</p>
      {evidence.map((ref) => <p key={`${ref.type}:${ref.id}:${ref.revision}`} className="ctx-muted">{t('page.evidence', { type: ref.type, id: ref.id, revision: ref.revision })}</p>)}
      {!evidence.length && <p className="ctx-muted">{t('page.proposal.noEvidence')}</p>}
    </div>}
    {error && <p role="alert" className="ctx-error">{error}</p>}
    <Dialog open={editing} onOpenChange={setEditing}>
      <DialogContent className="flex max-h-[calc(100dvh-48px)] w-[min(640px,calc(100vw-32px))] max-w-none flex-col overflow-y-auto" aria-describedby={undefined} onCloseAutoFocus={(event) => { event.preventDefault(); editButton.current?.focus(); }}>
        <DialogHeader><DialogTitle>{t('page.proposal.editConfirm')}</DialogTitle></DialogHeader>
        <label className="ctx-body">{t('page.proposal.title')}<Input aria-label={t('page.proposal.titleLabel')} className="ctx-field mt-1" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="ctx-body">{t('page.proposal.body')}<Textarea aria-label={t('page.proposal.body')} className="ctx-field mt-1" value={content} onChange={(event) => setContent(event.target.value)} /></label>
        <label className="ctx-body">{t('page.proposal.reason')}<Input aria-label={t('page.proposal.reasonLabel')} className="ctx-field mt-1" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        {error && <p role="alert" className="ctx-error">{error}</p>}
        <div className="ctx-actions"><Button type="button" className="ctx-btn" onClick={() => setEditing(false)}>{t('page.proposal.cancel')}</Button><Button type="button" className="ctx-btn ctx-btn-primary" disabled={busy || !title.trim() || !content.trim()} onClick={() => void saveAndConfirm()}>{t('page.proposal.confirm')}</Button></div>
      </DialogContent>
    </Dialog>
  </article>;
}

function Pager({ testId, cursor, nextCursor, onPrevious, onNext }: { testId: string; cursor: number; nextCursor: number | null; onPrevious: () => void; onNext: (cursor: number) => void }) {
  const { t } = useTranslation('knowledge');
  if (cursor === 0 && nextCursor == null) return null;
  return <div data-testid={testId} className="ctx-actions">
    <Button type="button" className="ctx-btn" disabled={!cursor} onClick={onPrevious}>{t('page.pager.previous')}</Button>
    <Button type="button" className="ctx-btn" disabled={nextCursor == null} onClick={() => { if (nextCursor != null) onNext(nextCursor); }}>{t('page.pager.next')}</Button>
  </div>;
}

function MemoryReading({ item, resource, openEditor }: { item: Resource; resource: Resource; openEditor: (resource?: Resource) => void }) {
  const { t } = useTranslation('knowledge');
  return <>
    <BodyText text={resource.content ?? ''} className="ctx-body" />
    {resource.uri && <a className="ctx-body underline" href={resource.uri} target="_blank" rel="noreferrer">{t('page.memory.viewSource')}</a>}
    <div className="ctx-actions mt-3">
      <Button type="button" className="ctx-btn" onClick={() => openEditor(resource)}>{t('page.memory.edit')}</Button>
      {item.status === 'active' && <RetireButton item={item} />}
    </div>
    <details>
      <summary>{t('page.memory.historyDetails')}</summary>
      {resource.evidence?.map((ref) => <p key={`${ref.type}:${ref.id}`} className="ctx-muted">{t('page.evidence', { type: ref.type, id: ref.id, revision: ref.revision })}</p>)}
      {resource.versions?.map((version) => {
        const reason = version.reason ?? t('page.memory.savedOriginal');
        return <div key={version.revision} className="mt-3 border-t pt-2"><p className="ctx-muted">{version.importance ? t('page.memory.versionWithImportance', { revision: version.revision, reason, importance: version.importance }) : t('page.memory.version', { revision: version.revision, reason })}</p><BodyText text={version.content} className="ctx-body" /></div>;
      })}
    </details>
  </>;
}

function MemoryBrowser({ embedded, topicId, scope, cursor, setCursor, status, setStatus, input, setInput, submitted, onCompositionStart, onCompositionEnd, opened, setOpened, activeEditor, openEditor, closeEditor, auto, onShowProposals, onShowMaterials, onShowRecords }: {
  embedded: boolean;
  topicId: string;
  scope: string;
  cursor: number;
  setCursor: (cursor: number) => void;
  status: MemoryStatus;
  setStatus: (status: MemoryStatus) => void;
  input: string;
  setInput: (value: string) => void;
  submitted: string;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  opened: string;
  setOpened: (id: string) => void;
  activeEditor: ResourceEditing | null;
  openEditor: (resource?: Resource) => void;
  closeEditor: () => void;
  auto?: AutoMemoryState;
  onShowProposals: () => void;
  onShowMaterials: () => void;
  onShowRecords?: () => void;
}) {
  const { t } = useTranslation('knowledge');
  const list = useQuery({
    queryKey: ['knowledge', 'memories', topicId, cursor, status, submitted],
    queryFn: ({ signal }) => api<PageResult<Resource>>(`/api/v1/knowledge/memories?${scope}&cursor=${cursor}&status=${status}&q=${encodeURIComponent(submitted)}&limit=${PAGE_SIZE}`, { signal }),
    retry: false,
  });
  const probe = useQuery({
    queryKey: ['knowledge', 'memories-probe', topicId],
    queryFn: ({ signal }) => api<PageResult<Resource>>(`/api/v1/knowledge/memories?${scope}&cursor=0&status=all&q=&limit=1`, { signal }),
    retry: false,
  });
  const detail = useQuery({ queryKey: ['knowledge', 'memories', opened], queryFn: ({ signal }) => api<Resource>(`/api/v1/knowledge/memories/${opened}`, { signal }), enabled: Boolean(opened), retry: false });
  const failed = list.error || probe.error;
  const trueEmpty = !failed && !input.trim() && !submitted && probe.isSuccess && (probe.data?.total ?? 0) === 0;
  const searchMiss = !failed && Boolean(submitted) && list.isSuccess && (list.data?.total ?? 0) === 0;
  const filteredEmpty = !failed && !submitted && status === 'active' && list.isSuccess && (list.data?.total ?? 0) === 0 && (probe.data?.total ?? 0) > 0;
  const resource = detail.data;
  const items = list.data?.items ?? [];
  const selected = items.find((item) => item.id === opened);
  const showList = !failed && !trueEmpty && !searchMiss && !filteredEmpty && items.length > 0;
  const records = !embedded && onShowRecords ? <Button type="button" className="ctx-btn" onClick={onShowRecords}>{t('page.extractionHistory')}</Button> : null;
  const emptyAction = (auto?.pendingProposalCount ?? 0) > 0
    ? <Button type="button" className="ctx-btn" onClick={onShowProposals}>{t('page.memory.viewProposals')}</Button>
    : (auto?.pendingSourceCount ?? 0) > 0
      ? null
      : <Button type="button" className="ctx-btn" onClick={onShowMaterials}>{t('page.memory.addMaterials')}</Button>;
  return <div className="ctx-stack">
    {!trueEmpty && <div className="ctx-sheet-bar">
      <Input aria-label={t('page.memory.searchLabel')} className="ctx-field max-w-sm" placeholder={t('page.memory.searchPlaceholder')} value={input} onChange={(event) => setInput(event.target.value)} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} />
      <div role="group" aria-label={t('page.memory.statusLabel')} className="ctx-actions">{([['active', t('page.memory.active')], ['history', t('page.memory.history')], ['all', t('page.memory.all')]] as const).map(([value, label]) => <Button key={value} type="button" className="ctx-btn" aria-pressed={status === value} onClick={() => setStatus(value)}>{label}</Button>)}</div>
      {(list.data?.total ?? 0) > 0 && <span className="ctx-muted">{t('page.memory.results', { count: list.data?.total ?? 0 })}</span>}
      <div className="ctx-sheet-end">{records}<Button type="button" className="ctx-btn ctx-btn-primary" onClick={() => openEditor()}>{t('page.memory.addManual')}</Button></div>
    </div>}
    {activeEditor && <ResourceEditor key={activeEditor.id} type="memories" resource={activeEditor.resource} topicId={topicId || null} onClose={closeEditor} />}
    {failed && <div role="alert" className="ctx-error"><p>{(list.error ?? probe.error)?.message}</p><Button type="button" className="ctx-btn" onClick={() => { void list.refetch(); void probe.refetch(); }}>{t('page.memory.retry')}</Button></div>}
    {trueEmpty && <div data-testid="context-memory-empty" className="ctx-card ctx-empty">
      <h2 className="ctx-empty-title">{t('page.memory.emptyTitle')}</h2>
      <p className="ctx-empty-copy">{t('page.memory.emptyCopy')}</p>
      <div className="ctx-actions">
        {!embedded && emptyAction}
        {!embedded && (auto?.pendingProposalCount ?? 0) === 0 && (auto?.pendingSourceCount ?? 0) > 0 && <RunNow topicId={topicId} />}
        {records}
        <Button type="button" className="ctx-btn ctx-btn-primary" onClick={() => openEditor()}>{t('page.memory.addManual')}</Button>
      </div>
    </div>}
    {searchMiss && <div className="ctx-card"><p>{t('page.memory.noMatch')}</p><Button type="button" className="ctx-btn" onClick={() => setInput('')}>{t('page.memory.clearSearch')}</Button></div>}
    {filteredEmpty && <div className="ctx-card"><p>{t('page.memory.noActive')}</p><Button type="button" className="ctx-btn" onClick={() => setStatus('history')}>{t('page.memory.viewHistory')}</Button></div>}
    {showList && <div className="ctx-memory-split">
      <div className="ctx-mem-list">
        {items.map((item) => <div key={item.id} className="ctx-mem-row"><MemorySummary memory={item} selected={opened === item.id} onSelect={() => setOpened(opened === item.id ? '' : item.id)} /></div>)}
      </div>
      <article className="ctx-mem-detail">
        {selected && resource?.id === selected.id ? <MemoryReading item={selected} resource={resource} openEditor={openEditor} /> : <p className={detail.error ? 'ctx-error' : 'ctx-muted'} role={detail.error ? 'alert' : undefined}>{detail.error ? detail.error.message : opened ? t('page.memory.reading') : t('page.memory.pick')}</p>}
      </article>
    </div>}
    {!failed && !trueEmpty && <Pager testId="context-pagination" cursor={cursor} nextCursor={list.data?.nextCursor ?? null} onPrevious={() => setCursor(Math.max(0, cursor - PAGE_SIZE))} onNext={setCursor} />}
  </div>;
}

function RunNow({ topicId }: { topicId: string }) {
  const { t } = useTranslation('knowledge');
  const client = useQueryClient();
  const [error, setError] = useState('');
  const requestId = useRef<string | null>(null);
  return <>
    <Button type="button" className="ctx-btn" onClick={() => void (async () => {
      if (!requestId.current) requestId.current = crypto.randomUUID();
      setError('');
      try {
        await api('/api/v1/knowledge/auto-memory/run', { method: 'POST', body: json({ topicId: topicId || null, requestId: requestId.current }) });
        await client.invalidateQueries({ queryKey: ['auto-memory', topicId] });
      } catch (caught) { setError(caught instanceof Error ? caught.message : t('page.memory.notStarted')); }
      finally { requestId.current = null; }
    })()}>{t('page.auto.extractNow')}</Button>
    {error && <p role="alert" className="ctx-error">{error}</p>}
  </>;
}

function RetireButton({ item }: { item: Resource }) {
  const { t } = useTranslation('knowledge');
  const { run, busy } = usePlatformAction();
  return <Button type="button" className="ctx-btn" disabled={busy} onClick={() => void run(() => submitCommands([{ kind: 'memory.retire', targetId: item.id, expectedRevision: item.revision, input: { reason: '用户将该记忆设为历史' } }]), t('page.memory.retired'))}>{t('page.memory.makeHistory')}</Button>; // i18n-ignore
}

function ContextSearch({ topicId, scope, cursor, setCursor, input, setInput, submitted, history, setHistory, onCompositionStart, onCompositionEnd }: {
  topicId: string;
  scope: string;
  cursor: number;
  setCursor: (cursor: number) => void;
  input: string;
  setInput: (value: string) => void;
  submitted: string;
  history: boolean;
  setHistory: (value: boolean) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
}) {
  const { t } = useTranslation('knowledge');
  const hits = useQuery({
    queryKey: ['knowledge-search', topicId, submitted, history, cursor],
    queryFn: ({ signal }) => api<PageResult<{ type: string; id: string; revision: number; title: string; snippet: string; status: string }>>(`/api/v1/knowledge/search?${scope}&q=${encodeURIComponent(submitted)}&includeHistory=${history}&cursor=${cursor}&limit=40`, { signal }),
    enabled: Boolean(submitted),
    retry: false,
  });
  return <div className="ctx-stack">
    <div className="ctx-actions">
      <Input aria-label={t('page.search.label')} className="ctx-field max-w-md" placeholder={t('page.search.placeholder')} value={input} onChange={(event) => setInput(event.target.value)} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} />
      <label className="ctx-muted"><input type="checkbox" checked={history} onChange={(event) => setHistory(event.target.checked)} />{t('page.search.includeHistory')}</label>
    </div>
    {hits.error && <p role="alert" className="ctx-error">{hits.error.message}<Button type="button" className="ctx-btn" onClick={() => void hits.refetch()}>{t('page.search.retry')}</Button></p>}
    {submitted && hits.isSuccess && hits.data.total === 0 && <p>{t('page.search.noMatch')}</p>}
    <div className="ctx-stack">{hits.data?.items.map((hit) => <article key={`${hit.type}:${hit.id}:${hit.revision}`} className="ctx-card"><h2 className="ctx-section-title">{hit.title}</h2><BodyText text={hit.snippet} className="ctx-body" /><p className="ctx-muted">{t(`page.search.hit.${hit.type === 'material' ? 'material' : hit.type === 'memory' ? 'memory' : 'task'}`, { revision: hit.revision, status: hit.status })}</p></article>)}</div>
    <Pager testId="context-pagination" cursor={cursor} nextCursor={hits.data?.nextCursor ?? null} onPrevious={() => setCursor(Math.max(0, cursor - 40))} onNext={setCursor} />
  </div>;
}

function ResourceEditor({ type, resource, topicId, taskId, onClose }: { type: 'materials' | 'memories'; resource?: Resource; topicId: string | null; taskId?: string; onClose: () => void }) {
  const { t } = useTranslation('knowledge');
  const isMaterial = type === 'materials';
  const [title, setTitle] = useState(resource?.title ?? '');
  const [content, setContent] = useState(isMaterial ? resource?.versions?.[0]?.content ?? '' : resource?.content ?? '');
  const [kind, setKind] = useState(resource?.kind ?? (isMaterial ? 'text' : 'fact'));
  const [importance, setImportance] = useState(resource?.importance ?? 3);
  const [labels, setLabels] = useState(asLabels(resource?.labels).join(' '));
  const [origin, setOrigin] = useState(resource?.origin ?? 'manual');
  const [uri, setUri] = useState(resource?.uri ?? '');
  const [completeness, setCompleteness] = useState(resource?.versions?.[0]?.metadata?.completeness ?? 'excerpt');
  const [attachment, setAttachment] = useState<{ attachmentBase64: string; fileName: string; mimeType: string } | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>(resource?.evidence ?? []);
  const [reason, setReason] = useState('');
  const [sessionId, setSessionId] = useState(resource?.versions?.[0]?.metadata?.sessionId ?? '');
  const [provider, setProvider] = useState(resource?.versions?.[0]?.metadata?.provider ?? 'manual');
  const [fileError, setFileError] = useState('');
  const autoTitle = useRef('');
  const titleRef = useRef(title);
  titleRef.current = title;
  const { run, busy } = usePlatformAction();
  const existingFileName = typeof resource?.versions?.[0]?.fileName === 'string' ? resource.versions[0].fileName : '';
  const fallbackTitle = isMaterial && kind === 'attachment' ? titleFromFileName(attachment?.fileName || existingFileName) : '';
  const resolvedTitle = title.trim() || fallbackTitle;
  const attachmentMissing = isMaterial && kind === 'attachment' && !attachment && !resource?.versions?.[0]?.hasAttachment;
  async function selectFile(file?: File) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setFileError(t('page.editor.fileTooLarge')); return; }
    setFileError('');
    const reader = new FileReader();
    reader.onload = () => {
      const fileName = file.name;
      setAttachment({ attachmentBase64: String(reader.result).split(',')[1] ?? '', fileName, mimeType: file.type || 'application/octet-stream' });
      const next = titleFromFileName(fileName);
      const current = titleRef.current;
      if (!current.trim() || current === autoTitle.current) {
        autoTitle.current = next;
        titleRef.current = next;
        setTitle(next);
      }
    };
    reader.onerror = () => setFileError(t('page.editor.fileReadFailed'));
    reader.readAsDataURL(file);
  }
  return <form className="ctx-card ctx-stack" onSubmit={(event) => { event.preventDefault(); if (!resolvedTitle.trim() || attachmentMissing) return; void run(async () => {
    const input: Record<string, unknown> = { title: resolvedTitle, content, ...(!resource ? { topicId, kind, ...(isMaterial && taskId ? { taskId } : {}) } : {}) };
    if (isMaterial) { if (kind === 'link') input.uri = uri; if (kind === 'thread') input.metadata = { completeness, sessionId: sessionId || undefined, provider }; if (attachment) Object.assign(input, attachment); }
    else { input.kind = kind; input.evidence = evidence; input.reason = reason || (resource ? '用户修订' : '人工记录'); input.importance = importance; input.labels = labels.split(/[\s,，]+/).map((label) => label.trim()).filter(Boolean); input.origin = origin; } // i18n-ignore
    const result = await submitCommands([{ kind: `${isMaterial ? 'material' : 'memory'}.${resource ? 'update' : 'create'}`, ...(resource ? { targetId: resource.id, expectedRevision: resource.revision } : {}), input }]);
    onClose(); return result;
  }); }}>
    <fieldset className="ctx-stack" disabled={busy}>
    <h2 className="ctx-section-title">{t(resource ? (isMaterial ? 'page.editor.editMaterial' : 'page.editor.editMemory') : (isMaterial ? 'page.editor.createMaterial' : 'page.editor.createMemory'))}</h2>
    <Input aria-label={isMaterial ? t('page.editor.materialTitle') : t('page.editor.memoryTitle')} className="ctx-field" placeholder={isMaterial && kind === 'attachment' ? t('page.editor.fileNamePlaceholder') : t('page.editor.titlePlaceholder')} value={title} onChange={(event) => { titleRef.current = event.target.value; setTitle(event.target.value); }} required={!(isMaterial && kind === 'attachment')} />
    <select aria-label={isMaterial ? t('page.editor.materialKind') : t('page.editor.memoryKind')} className="ctx-select" disabled={Boolean(resource && (isMaterial || resource.kind === 'crystal'))} value={kind} onChange={(event) => setKind(event.target.value)}>{(isMaterial ? (['text', 'markdown', 'link', 'thread', 'attachment'] as const).map((value) => [value, t(`page.editor.materialKinds.${value}`)] as const) : resource?.kind === 'crystal' ? [['crystal', t('memoryView.kinds.crystal')] as const] : memoryKindKeys.filter((value) => value !== 'crystal').map((value) => [value, t(`memoryView.kinds.${value}`)] as const)).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>
    {!isMaterial && <div className="ctx-actions"><Stars value={importance} onChange={setImportance} /><select aria-label={t('page.editor.origin')} className="ctx-select" value={origin} onChange={(event) => setOrigin(event.target.value)}>{originKeys.map((value) => <option key={value} value={value}>{t(`memoryView.origins.${value}`)}</option>)}</select><Input aria-label={t('page.editor.tags')} className="ctx-field max-w-sm" placeholder={t('page.editor.tagsPlaceholder')} value={labels} onChange={(event) => setLabels(event.target.value)} /></div>}
    {kind === 'link' && <Input type="url" aria-label={t('page.editor.sourceLink')} className="ctx-field" placeholder="https://…" value={uri} onChange={(event) => setUri(event.target.value)} required />}
    {kind === 'thread' && <select aria-label={t('page.editor.threadScope')} className="ctx-select" value={completeness} onChange={(event) => setCompleteness(event.target.value)}><option value="excerpt">{t('page.editor.threadExcerpt')}</option><option value="full">{t('page.editor.threadFull')}</option><option value="summary">{t('page.editor.threadSummary')}</option></select>}
    {kind === 'attachment' ? <><input aria-label={t('page.editor.chooseFile')} type="file" onChange={(event) => void selectFile(event.target.files?.[0])} />{fileError && <p role="alert">{fileError}</p>}</> : <Textarea aria-label={isMaterial ? t('page.editor.materialBody') : t('page.editor.memoryBody')} className="ctx-field" placeholder={isMaterial ? t('page.editor.materialBodyPlaceholder') : t('page.editor.memoryBodyPlaceholder')} value={content} onChange={(event) => setContent(event.target.value)} rows={5} />}
    {!isMaterial && <><ContextPicker topicId={topicId} selected={evidence} onChange={setEvidence} /><Input aria-label={t('page.editor.reason')} className="ctx-field" placeholder={t('page.editor.reasonPlaceholder')} value={reason} onChange={(event) => setReason(event.target.value)} /></>}
    {kind === 'thread' && <div className="ctx-actions"><Input aria-label={t('page.editor.host')} className="ctx-field" placeholder={t('page.editor.hostPlaceholder')} value={provider} onChange={(event) => setProvider(event.target.value)} /><Input aria-label={t('page.editor.sessionId')} className="ctx-field" placeholder={t('page.editor.sessionIdPlaceholder')} value={sessionId} onChange={(event) => setSessionId(event.target.value)} /></div>}
    <div className="ctx-actions"><Button type="button" className="ctx-btn" disabled={busy} onClick={onClose}>{t('page.editor.cancel')}</Button><Button className="ctx-btn ctx-btn-primary" disabled={busy || !resolvedTitle.trim() || attachmentMissing || (!isMaterial && !content.trim())}>{isMaterial ? t('page.editor.saveMaterial') : t('page.editor.saveMemory')}</Button></div>
    </fieldset>
  </form>;
}

function BriefPanel({ topicId, draft, updateDraft }: { topicId: string | null; draft: BriefDraft | null; updateDraft: (update: (current: BriefDraft | null) => BriefDraft | null) => void }) {
  const { t } = useTranslation('knowledge');
  const query = useQuery({ queryKey: ['brief', topicId], queryFn: ({ signal }) => api<any>(`/api/v1/knowledge/brief?topicId=${topicId ?? 'inbox'}`, { signal }) });
  const { run, busy } = usePlatformAction();
  async function save() {
    if (!draft) return;
    const submitted = draft;
    await run(async () => {
      const result = await api<{ revision: number }>('/api/v1/knowledge/brief', { method: 'PUT', body: json({ topicId, expectedVersion: submitted.revision, manualNotes: submitted.notes }) });
      updateDraft((current) => current === submitted ? null : current?.revision === submitted.revision ? { ...current, revision: result.revision } : current);
      return result;
    });
  }
  return <div className="ctx-stack">{query.error && <p role="alert" className="ctx-error">{query.error.message}</p>}<div className="ctx-card ctx-brief">{query.data?.content ? <BodyText text={query.data.content} format="markdown" components={{ h1: ({ children }) => nodeText(children).trim() === '当前简报' ? null : <h2 className="ctx-section-title">{children}</h2> }} /> : <p className="ctx-muted">{t('page.brief.preparing')}</p>}</div><label className="ctx-body">{t('page.brief.pinnedNotes')}<Textarea className="ctx-field mt-2" aria-label={t('page.brief.pinnedNotesLabel')} disabled={!query.data} value={draft?.notes ?? query.data?.manualNotes ?? ''} onChange={(event) => { const notes = event.target.value; updateDraft((current) => ({ notes, revision: current?.revision ?? query.data.revision })); }} /></label><Button className="ctx-btn ctx-btn-primary" disabled={busy || draft === null} onClick={() => void save()}>{t('page.brief.savePinnedNotes')}</Button></div>; // i18n-ignore
}

function OrganizationPanel({ topicId }: { topicId: string | null }) {
  const { t } = useTranslation('knowledge');
  const query = useQuery({ queryKey: ['organizations', topicId], queryFn: () => api<any[]>(`/api/v1/knowledge/organizations?topicId=${topicId ?? 'inbox'}`) });
  const [purpose, setPurpose] = useState(() => t('organization.defaultPurpose'));
  const [provider, setProvider] = useState('external');
  const { run, busy } = usePlatformAction();
  return <details className="ctx-card"><summary className="cursor-pointer text-sm font-semibold">{t('page.organize.summary')}</summary><div className="ctx-stack mt-4"><Textarea aria-label={t('page.organize.goal')} className="ctx-field" value={purpose} onChange={(event) => setPurpose(event.target.value)} /><select aria-label={t('page.organize.method')} className="ctx-select" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="external">{t('page.organize.external')}</option><option value="builtin">{t('page.organize.builtin')}</option></select><Button className="ctx-btn" disabled={busy || !purpose.trim()} onClick={() => void run(async () => { const request = await api<any>('/api/v1/knowledge/organizations', { method: 'POST', body: json({ topicId, purpose, provider }) }); return provider === 'builtin' ? api(`/api/v1/knowledge/organizations/${request.id}/generate`, { method: 'POST', body: '{}' }) : request; }, provider === 'builtin' ? t('page.organize.generated') : t('page.organize.prepared'))}>{t('page.organize.prepare')}</Button>{query.data?.map((request) => <article className="space-y-2 border-t pt-3" key={request.id}><p className="ctx-body">{request.purpose}</p><p className="ctx-muted">{request.status} · {new Date(request.createdAt).toLocaleString(intlLocale())}</p>{request.error && <p role="alert" className="ctx-error">{request.error}</p>}{request.result?.summary && <BodyText text={request.result.summary} className="ctx-body" />}{request.provider === 'external' && !['proposed', 'completed'].includes(request.status) && <OrganizationPrompt id={request.id} purpose={request.purpose} />}{request.proposalIds?.length > 0 && <a className="ctx-body underline" href="#/proposals">{t('page.organize.reviewProposals')}</a>}</article>)}</div></details>;
}
