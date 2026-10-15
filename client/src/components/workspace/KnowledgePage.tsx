import { usePageContext } from '@/lib/assistant-context.js';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Topic } from '@/lib/api.js';
import { titleFromFileName } from '@/lib/attachment-title.js';
import { json, parseStored, submitCommands, usePlatformAction, type Command } from '@/lib/platform.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { MarkdownView } from '@/components/chat/MarkdownView.js';
import type { KnowledgeSection } from '@/hooks/useHashRoute.js';
import { ContextPicker, type Evidence } from './ContextPicker.js';
import { KnowledgeGraph } from './KnowledgeGraph.js';
import { KnowledgeTree } from './KnowledgeTree.js';
import { MaterialBrowser } from './MaterialBrowser.js';
import { OrganizationPrompt } from './OrganizationPrompt.js';
import { asLabels, MemorySummary, memoryKindNames, originNames, Stars } from './memory-view.js';
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

const memoryKinds = { fact: '事实', decision: '决策', constraint: '约束', learning: '经验', question: '未决问题' };
const primaryTabs = [
  ['brief', '当前进展', '根据任务和有效记忆汇总；固定说明由你维护。'],
  ['materials', '参考资料', '保存原文、文件和聊天摘录，为 AI 提供依据。'],
  ['memories', '长期记忆', '已确认的事实、决策、约束和经验，会在相关聊天中供 AI 参考。'],
] as const;
const stateLabels: Record<AutoMemoryState['state'], string> = {
  disabled: '自动提炼已暂停',
  archived: '已归档，暂停提炼',
  unconfigured: '尚未配置内置模型',
  queued: '等待提炼',
  running: '正在提炼',
  failed: '有内容提炼失败',
  idle: '已处理完当前变化',
};
const actionLabels: Record<string, string> = { 'memory.create': '新增', 'memory.update': '更新', 'memory.retire': '退役' };
const PAGE_SIZE = 40;

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
  usePageContext(embedded ? 'embedded-knowledge' : 'knowledge', { scope: topicId ? { kind: 'topic', topicId } : { kind: 'inbox' }, section, pageState: { selectedId: opened, status: memoryStatus, query: section === 'memories' ? memoryQuery.submitted : searchQuery.submitted } });
  const knownTopics = [...topics, ...archivedTopics.filter((topic) => !topics.some((item) => item.id === topic.id))];
  const missing = !embedded && topicExplicit && topicId !== '' && topicsReady && !knownTopics.some((topic) => topic.id === topicId);
  const scope = scopeQuery(topicId);
  const editorScope = `${topicId}:${section}`;
  const activeEditor = editing?.scope === editorScope ? editing : null;
  const locate = (nextSection: KnowledgeTab, nextTopic = topicId) => {
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
    enabled: !embedded && !missing,
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
  const memories = <MemoryBrowser embedded={embedded} topicId={topicId} scope={scope} cursor={cursor} setCursor={setCursor} status={memoryStatus} setStatus={(value) => { setMemoryStatus(value); setCursor(0); }} input={memoryInput} setInput={setMemoryInput} submitted={memoryQuery.submitted} onCompositionStart={memoryQuery.onCompositionStart} onCompositionEnd={memoryQuery.onCompositionEnd} opened={opened} setOpened={setOpened} activeEditor={activeEditor} openEditor={openEditor} closeEditor={() => setEditing((current) => current?.id === activeEditor?.id ? null : current)} auto={auto.data} onShowProposals={() => locate('brief')} onShowMaterials={() => locate('materials')} />;
  const search = <ContextSearch topicId={topicId} scope={scope} cursor={cursor} setCursor={setCursor} input={searchInput} setInput={setSearchInput} submitted={searchQuery.submitted} history={searchHistory} setHistory={(value) => { setSearchHistory(value); setCursor(0); }} onCompositionStart={searchQuery.onCompositionStart} onCompositionEnd={searchQuery.onCompositionEnd} />;
  const body = missing ? <p role="alert" className="ctx-error">这个清单不存在。</p> : section === 'tree' ? <KnowledgeTree topicId={topicId || null} brief={brief} /> : section === 'graph' ? <KnowledgeGraph topicId={topicId || null} /> : section === 'search' ? search : section === 'materials' ? materials : section === 'memories' ? memories : <>
    {!embedded && <AutoStatus topicId={topicId} state={auto.data} error={auto.error} onRetry={() => void auto.refetch()} onOpenSettings={onOpenSettings} />}
    {!embedded && <MemoryProposals topicId={topicId} scope={scope} count={auto.data?.pendingProposalCount ?? 0} />}
    {brief}
    {!embedded && <OrganizationPanel topicId={topicId || null} />}
  </>;
  if (embedded) {
    return <section className="work-context work-context-embed space-y-4">
      <div role="tablist" aria-label="任务资料" className="ctx-tabs" onKeyDown={onTabKey}>
        {([['materials', '参考资料'], ['memories', '长期记忆'], ['brief', '当前进展'], ['search', '搜索上下文']] as const).map(([value, label]) => <button key={value} id={`context-tab-${value}`} type="button" role="tab" className="ctx-tab" aria-selected={section === value} tabIndex={section === value ? 0 : -1} onClick={() => locate(value)}>{label}</button>)}
      </div>
      {section === 'memories' && <p className="ctx-muted">所属清单的长期记忆</p>}
      {body}
    </section>;
  }
  const viewLabel = section === 'tree' ? '知识树' : section === 'graph' ? '关系图' : '标准页面';
  return <section data-testid="work-context" className="work-context">
    <div className="work-context-frame">
      <div className="work-context-main">
        <header className="ctx-header">
          <div>
            <h1 className="ctx-title">工作上下文</h1>
            <p className="ctx-subtitle">查看当前进展，整理参考资料，维护 AI 后续会使用的长期记忆。</p>
          </div>
          <div data-testid="context-toolbar" className="ctx-tools">
            <label className="ctx-muted">所属清单
              <select aria-label="所属清单" className="ctx-select" value={topicId} onChange={(event) => locate(section === 'search' || section === 'tree' || section === 'graph' ? section : (primaryTabs.some(([value]) => value === section) ? section : 'brief'), event.target.value)}>
                <option value="">收集箱</option>
                {missing && <option value={topicId}>未知清单</option>}
                {knownTopics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}{topic.archivedAt ? '（已归档）' : ''}</option>)}
              </select>
            </label>
            <Button type="button" className="ctx-btn" aria-pressed={section === 'search'} onClick={() => locate('search')}>搜索上下文</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button type="button" className="ctx-btn" aria-label="查看方式">{viewLabel}</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => locate(primaryTabs.some(([value]) => value === section) ? section : 'brief')}>标准页面</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => locate('tree')}>知识树</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => locate('graph')}>关系图</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button type="button" className="ctx-btn">更多</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild><a href={`/api/v1/knowledge/export?${scope}`}>导出当前范围</a></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <div role="tablist" aria-label="工作上下文" data-testid="context-tabs" className="ctx-tabs" onKeyDown={onTabKey}>
          {primaryTabs.map(([value, label]) => {
            const selected = section === value;
            const fallback = !primaryTabs.some(([item]) => item === section) && value === 'brief';
            return <button key={value} id={`context-tab-${value}`} type="button" role="tab" className="ctx-tab" aria-selected={selected} tabIndex={selected || fallback ? 0 : -1} onClick={() => locate(value)}>{label}</button>;
          })}
        </div>
        {section !== 'tree' && section !== 'graph' && section !== 'search' && <p className="ctx-tab-note">{tabNote}</p>}
        {section === 'memories' && <p className="ctx-tab-note">聊天摘要由系统自动维护，不显示在这里。自动提炼的建议确认后才成为长期记忆。</p>}
        {body}
      </div>
    </div>
  </section>;
}

function AutoStatus({ topicId, state, error, onRetry, onOpenSettings }: { topicId: string; state?: AutoMemoryState; error: Error | null; onRetry: () => void; onOpenSettings?: () => void }) {
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
      if (result?.accepted === false && result.reason === 'NO_CHANGES') setNotice('没有新的变化。');
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '提炼没有开始');
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
      setNotice(caught instanceof ApiError ? caught.message : '自动提炼设置没有保存');
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
      setNotice(caught instanceof Error ? caught.message : '重试没有开始');
    } finally {
      retryId.current = null;
      setBusy(false);
      await refresh();
    }
  };
  const label = state ? stateLabels[state.state] : '正在读取';
  const extraFailure = state && (state.state === 'running' || state.state === 'queued') && state.failedSourceCount > 0 ? `另有 ${state.failedSourceCount} 项失败` : '';
  const failed = state?.state === 'failed' || (state?.failedSourceCount ?? 0) > 0;
  return <section data-testid="context-auto-status" className="ctx-card ctx-status" aria-label="自动提炼">
    <div className="ctx-status-copy">
      <p className="ctx-status-label">自动提炼 {label}{extraFailure ? `，${extraFailure}` : ''}{state && state.pendingProposalCount > 0 ? ` · ${state.pendingProposalCount} 条待确认` : ''}</p>
      <p className="ctx-muted">资料、任务和本应用聊天发生变化后自动整理，建议确认后生效。</p>
      {state?.state === 'unconfigured' && <p className="ctx-warning">尚未配置内置模型，待处理内容已保留。</p>}
      {error && <p role="alert" className="ctx-error">{error.message}</p>}
      {notice && <p role="alert" className="ctx-error">{notice}</p>}
      {showReason && <p className="ctx-error">{state?.latestJob?.errorMessage || state?.latestJob?.errorCode || '提炼失败'}</p>}
    </div>
    <div className="ctx-actions">
      {state?.state === 'unconfigured' && <Button type="button" className="ctx-btn" onClick={onOpenSettings}>配置模型</Button>}
      {error && <Button type="button" className="ctx-btn" onClick={onRetry}>重试</Button>}
      <Button type="button" className="ctx-btn ctx-btn-primary" disabled={busy || !state || state.state === 'disabled' || state.state === 'archived' || state.state === 'unconfigured'} onClick={() => void run()}>立即提炼</Button>
      <Button type="button" className="ctx-btn" disabled={busy || !state || state.state === 'archived'} onClick={() => void toggle()}>{state?.enabled === false ? '开启自动提炼' : '暂停自动提炼'}</Button>
      {failed && <Button type="button" className="ctx-btn" aria-expanded={showReason} onClick={() => setShowReason((value) => !value)}>查看原因</Button>}
      {state?.latestJob?.status === 'failed' && <Button type="button" className="ctx-btn" disabled={busy} onClick={() => void retry()}>重试</Button>}
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
  const client = useQueryClient();
  const commands = parseStored<Command[]>(proposal.commands, []);
  const command = commands.find((item) => item.kind.startsWith('memory.')) ?? commands[0];
  const input = command?.input ?? {};
  const evidence = Array.isArray(input.evidence) ? input.evidence as Evidence[] : [];
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
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
    catch (caught) { setError(caught instanceof Error ? caught.message : '确认失败'); }
    finally { setBusy(false); }
  };
  const reject = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/v1/proposals/${proposal.id}/reject`, { method: 'POST', body: json({ expectedRevision: proposal.revision }) });
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '拒绝失败'); }
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
    } catch (caught) { setError(caught instanceof Error ? caught.message : '确认失败'); }
    finally { setBusy(false); }
  };
  return <article data-testid={`context-proposal-${proposal.id}`} className="ctx-card ctx-stack">
    <p className="ctx-status-label">{actionLabels[command?.kind ?? ''] ?? '建议'} {String(input.title ?? '')}</p>
    <p className="ctx-body whitespace-pre-wrap">{String(input.content ?? '')}</p>
    <p className="ctx-muted">理由：{String(input.reason ?? '')}</p>
    <details>
      <summary>证据</summary>
      {evidence.map((ref) => <p key={`${ref.type}:${ref.id}:${ref.revision}`} className="ctx-muted">{ref.type} · {ref.id} · 版本 {ref.revision}</p>)}
      {!evidence.length && <p className="ctx-muted">没有附带证据</p>}
    </details>
    {error && <p role="alert" className="ctx-error">{error}</p>}
    <div className="ctx-actions">
      <Button type="button" className="ctx-btn ctx-btn-primary" disabled={busy} onClick={() => void confirm()}>确认</Button>
      <Button type="button" className="ctx-btn" disabled={busy} onClick={() => void reject()}>拒绝</Button>
      <Button ref={editButton} type="button" className="ctx-btn" disabled={busy} onClick={() => setEditing(true)}>编辑后确认</Button>
    </div>
    <Dialog open={editing} onOpenChange={setEditing}>
      <DialogContent className="flex max-h-[calc(100dvh-48px)] w-[min(640px,calc(100vw-32px))] max-w-none flex-col overflow-y-auto" aria-describedby={undefined} onCloseAutoFocus={(event) => { event.preventDefault(); editButton.current?.focus(); }}>
        <DialogHeader><DialogTitle>编辑后确认</DialogTitle></DialogHeader>
        <label className="ctx-body">标题<Input aria-label="建议标题" className="ctx-field mt-1" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="ctx-body">建议正文<Textarea aria-label="建议正文" className="ctx-field mt-1" value={content} onChange={(event) => setContent(event.target.value)} /></label>
        <label className="ctx-body">理由<Input aria-label="建议理由" className="ctx-field mt-1" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        {error && <p role="alert" className="ctx-error">{error}</p>}
        <div className="ctx-actions"><Button type="button" className="ctx-btn" onClick={() => setEditing(false)}>取消</Button><Button type="button" className="ctx-btn ctx-btn-primary" disabled={busy || !title.trim() || !content.trim()} onClick={() => void saveAndConfirm()}>确认</Button></div>
      </DialogContent>
    </Dialog>
  </article>;
}

function Pager({ testId, cursor, nextCursor, onPrevious, onNext }: { testId: string; cursor: number; nextCursor: number | null; onPrevious: () => void; onNext: (cursor: number) => void }) {
  if (cursor === 0 && nextCursor == null) return null;
  return <div data-testid={testId} className="ctx-actions">
    <Button type="button" className="ctx-btn" disabled={!cursor} onClick={onPrevious}>上一页</Button>
    <Button type="button" className="ctx-btn" disabled={nextCursor == null} onClick={() => { if (nextCursor != null) onNext(nextCursor); }}>下一页</Button>
  </div>;
}

function MemoryBrowser({ embedded, topicId, scope, cursor, setCursor, status, setStatus, input, setInput, submitted, onCompositionStart, onCompositionEnd, opened, setOpened, activeEditor, openEditor, closeEditor, auto, onShowProposals, onShowMaterials }: {
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
}) {
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
  const emptyAction = (auto?.pendingProposalCount ?? 0) > 0
    ? <Button type="button" className="ctx-btn" onClick={onShowProposals}>查看待确认建议</Button>
    : (auto?.pendingSourceCount ?? 0) > 0
      ? null
      : <Button type="button" className="ctx-btn" onClick={onShowMaterials}>添加参考资料</Button>;
  return <div className="ctx-stack">
    {!trueEmpty && <div className="ctx-actions">
      <Input aria-label="搜索记忆" className="ctx-field max-w-sm" placeholder="搜索标题、正文或标签" value={input} onChange={(event) => setInput(event.target.value)} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} />
      <div role="group" aria-label="记忆状态" className="ctx-actions">{([['active', '活跃'], ['history', '历史'], ['all', '全部']] as const).map(([value, label]) => <Button key={value} type="button" className="ctx-btn" aria-pressed={status === value} onClick={() => setStatus(value)}>{label}</Button>)}</div>
      {(list.data?.total ?? 0) > 0 && <span className="ctx-muted">结果 {list.data?.total} 条</span>}
      <Button type="button" className="ctx-btn ctx-btn-primary" onClick={() => openEditor()}>手动记录</Button>
    </div>}
    {activeEditor && <ResourceEditor key={activeEditor.id} type="memories" resource={activeEditor.resource} topicId={topicId || null} onClose={closeEditor} />}
    {failed && <div role="alert" className="ctx-error"><p>{(list.error ?? probe.error)?.message}</p><Button type="button" className="ctx-btn" onClick={() => { void list.refetch(); void probe.refetch(); }}>重试</Button></div>}
    {trueEmpty && <div data-testid="context-memory-empty" className="ctx-card ctx-empty">
      <h2 className="ctx-empty-title">还没有长期记忆</h2>
      <p className="ctx-empty-copy">AI 会从资料、任务和本应用聊天中提炼建议，你确认后会显示在这里。也可以手动记录。</p>
      <div className="ctx-actions">
        {!embedded && emptyAction}
        {!embedded && (auto?.pendingProposalCount ?? 0) === 0 && (auto?.pendingSourceCount ?? 0) > 0 && <RunNow topicId={topicId} />}
        <Button type="button" className="ctx-btn ctx-btn-primary" onClick={() => openEditor()}>手动记录</Button>
      </div>
    </div>}
    {searchMiss && <div className="ctx-card"><p>没有找到匹配的记忆。</p><Button type="button" className="ctx-btn" onClick={() => setInput('')}>清除搜索</Button></div>}
    {filteredEmpty && <div className="ctx-card"><p>当前没有活跃记忆。</p><Button type="button" className="ctx-btn" onClick={() => setStatus('history')}>查看历史</Button></div>}
    {!failed && !trueEmpty && <div className="ctx-stack">{list.data?.items.map((item) => <article key={item.id} className="ctx-card"><MemorySummary memory={item} selected={opened === item.id} onSelect={() => setOpened(opened === item.id ? '' : item.id)} />{opened === item.id && resource?.id === item.id && <><p className="ctx-body mt-3 whitespace-pre-wrap">{resource.content}</p>{resource.uri && <a className="ctx-body underline" href={resource.uri} target="_blank" rel="noreferrer">查看来源链接</a>}<div className="ctx-actions mt-3"><Button type="button" className="ctx-btn" onClick={() => openEditor(resource)}>编辑记忆</Button>{item.status === 'active' && <RetireButton item={item} />}</div><details><summary className="ctx-muted">来源与修订历史</summary>{resource.evidence?.map((ref) => <p key={`${ref.type}:${ref.id}`} className="ctx-muted">{ref.type} · {ref.id} · 版本 {ref.revision}</p>)}{resource.versions?.map((version) => <div key={version.revision} className="mt-3 border-t pt-2"><p className="ctx-muted">版本 {version.revision} · {version.reason ?? '保存原文'}{version.importance ? ` · 重要度 ${version.importance}` : ''}</p><p className="ctx-body whitespace-pre-wrap">{version.content}</p></div>)}</details></>}</article>)}</div>}
    {!failed && !trueEmpty && <Pager testId="context-pagination" cursor={cursor} nextCursor={list.data?.nextCursor ?? null} onPrevious={() => setCursor(Math.max(0, cursor - PAGE_SIZE))} onNext={setCursor} />}
  </div>;
}

function RunNow({ topicId }: { topicId: string }) {
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
      } catch (caught) { setError(caught instanceof Error ? caught.message : '提炼没有开始'); }
      finally { requestId.current = null; }
    })()}>立即提炼</Button>
    {error && <p role="alert" className="ctx-error">{error}</p>}
  </>;
}

function RetireButton({ item }: { item: Resource }) {
  const { run, busy } = usePlatformAction();
  return <Button type="button" className="ctx-btn" disabled={busy} onClick={() => void run(() => submitCommands([{ kind: 'memory.retire', targetId: item.id, expectedRevision: item.revision, input: { reason: '用户将该记忆设为历史' } }]), '记忆已保留为历史')}>设为历史</Button>;
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
  const hits = useQuery({
    queryKey: ['knowledge-search', topicId, submitted, history, cursor],
    queryFn: ({ signal }) => api<PageResult<{ type: string; id: string; revision: number; title: string; snippet: string; status: string }>>(`/api/v1/knowledge/search?${scope}&q=${encodeURIComponent(submitted)}&includeHistory=${history}&cursor=${cursor}&limit=40`, { signal }),
    enabled: Boolean(submitted),
    retry: false,
  });
  return <div className="ctx-stack">
    <div className="ctx-actions">
      <Input aria-label="搜索上下文" className="ctx-field max-w-md" placeholder="查找任务、材料与记忆" value={input} onChange={(event) => setInput(event.target.value)} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} />
      <label className="ctx-muted"><input type="checkbox" checked={history} onChange={(event) => setHistory(event.target.checked)} />包含历史与归档</label>
    </div>
    {hits.error && <p role="alert" className="ctx-error">{hits.error.message}<Button type="button" className="ctx-btn" onClick={() => void hits.refetch()}>重试</Button></p>}
    {submitted && hits.isSuccess && hits.data.total === 0 && <p>没有找到匹配的内容。</p>}
    <div className="ctx-stack">{hits.data?.items.map((hit) => <article key={`${hit.type}:${hit.id}:${hit.revision}`} className="ctx-card"><h2 className="ctx-section-title">{hit.title}</h2><p className="ctx-body whitespace-pre-wrap">{hit.snippet}</p><p className="ctx-muted">{hit.type === 'material' ? '材料' : hit.type === 'memory' ? '记忆' : '任务'} · 版本 {hit.revision} · {hit.status}</p></article>)}</div>
    <Pager testId="context-pagination" cursor={cursor} nextCursor={hits.data?.nextCursor ?? null} onPrevious={() => setCursor(Math.max(0, cursor - 40))} onNext={setCursor} />
  </div>;
}

function ResourceEditor({ type, resource, topicId, taskId, onClose }: { type: 'materials' | 'memories'; resource?: Resource; topicId: string | null; taskId?: string; onClose: () => void }) {
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
    if (file.size > 8 * 1024 * 1024) { setFileError('附件不得超过 8 MiB'); return; }
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
    reader.onerror = () => setFileError('读取附件失败，请重新选择。');
    reader.readAsDataURL(file);
  }
  return <form className="ctx-card ctx-stack" onSubmit={(event) => { event.preventDefault(); if (!resolvedTitle.trim() || attachmentMissing) return; void run(async () => {
    const input: Record<string, unknown> = { title: resolvedTitle, content, ...(!resource ? { topicId, kind, ...(isMaterial && taskId ? { taskId } : {}) } : {}) };
    if (isMaterial) { if (kind === 'link') input.uri = uri; if (kind === 'thread') input.metadata = { completeness, sessionId: sessionId || undefined, provider }; if (attachment) Object.assign(input, attachment); }
    else { input.kind = kind; input.evidence = evidence; input.reason = reason || (resource ? '用户修订' : '人工记录'); input.importance = importance; input.labels = labels.split(/[\s,，]+/).map((label) => label.trim()).filter(Boolean); input.origin = origin; }
    const result = await submitCommands([{ kind: `${isMaterial ? 'material' : 'memory'}.${resource ? 'update' : 'create'}`, ...(resource ? { targetId: resource.id, expectedRevision: resource.revision } : {}), input }]);
    onClose(); return result;
  }); }}>
    <fieldset className="ctx-stack" disabled={busy}>
    <h2 className="ctx-section-title">{resource ? '编辑' : '新增'}{isMaterial ? '材料' : '记忆'}</h2>
    <Input aria-label={isMaterial ? '材料标题' : '记忆标题'} className="ctx-field" placeholder={isMaterial && kind === 'attachment' ? '不填则使用文件名' : '标题'} value={title} onChange={(event) => { titleRef.current = event.target.value; setTitle(event.target.value); }} required={!(isMaterial && kind === 'attachment')} />
    <select aria-label={isMaterial ? '材料类型' : '记忆类型'} className="ctx-select" disabled={Boolean(resource && (isMaterial || resource.kind === 'crystal'))} value={kind} onChange={(event) => setKind(event.target.value)}>{Object.entries(isMaterial ? { text: '文本', markdown: 'Markdown', link: '链接', thread: '保存会话', attachment: '附件' } : resource?.kind === 'crystal' ? { crystal: memoryKindNames.crystal } : memoryKinds).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>
    {!isMaterial && <div className="ctx-actions"><Stars value={importance} onChange={setImportance} /><select aria-label="记忆来源" className="ctx-select" value={origin} onChange={(event) => setOrigin(event.target.value)}>{Object.entries(originNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select><Input aria-label="记忆标签" className="ctx-field max-w-sm" placeholder="标签，用空格或逗号分隔" value={labels} onChange={(event) => setLabels(event.target.value)} /></div>}
    {kind === 'link' && <Input type="url" aria-label="来源链接" className="ctx-field" placeholder="https://…" value={uri} onChange={(event) => setUri(event.target.value)} required />}
    {kind === 'thread' && <select aria-label="会话保存范围" className="ctx-select" value={completeness} onChange={(event) => setCompleteness(event.target.value)}><option value="excerpt">会话片段</option><option value="full">完整会话</option><option value="summary">接力摘要</option></select>}
    {kind === 'attachment' ? <><input aria-label="选择附件" type="file" onChange={(event) => void selectFile(event.target.files?.[0])} />{fileError && <p role="alert">{fileError}</p>}</> : <Textarea aria-label={isMaterial ? '材料正文' : '记忆正文'} className="ctx-field" placeholder={isMaterial ? '原始内容或链接说明' : '事实、决策及其理由'} value={content} onChange={(event) => setContent(event.target.value)} rows={5} />}
    {!isMaterial && <><ContextPicker topicId={topicId} selected={evidence} onChange={setEvidence} /><Input aria-label="记忆修订理由" className="ctx-field" placeholder="记录或替代这条记忆的理由" value={reason} onChange={(event) => setReason(event.target.value)} /></>}
    {kind === 'thread' && <div className="ctx-actions"><Input aria-label="会话宿主" className="ctx-field" placeholder="宿主，例如 Codex" value={provider} onChange={(event) => setProvider(event.target.value)} /><Input aria-label="外部会话标识" className="ctx-field" placeholder="会话标识（可选）" value={sessionId} onChange={(event) => setSessionId(event.target.value)} /></div>}
    <div className="ctx-actions"><Button type="button" className="ctx-btn" disabled={busy} onClick={onClose}>取消</Button><Button className="ctx-btn ctx-btn-primary" disabled={busy || !resolvedTitle.trim() || attachmentMissing || (!isMaterial && !content.trim())}>保存{isMaterial ? '材料' : '记忆'}</Button></div>
    </fieldset>
  </form>;
}

function BriefPanel({ topicId, draft, updateDraft }: { topicId: string | null; draft: BriefDraft | null; updateDraft: (update: (current: BriefDraft | null) => BriefDraft | null) => void }) {
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
  return <div className="ctx-stack">{query.error && <p role="alert" className="ctx-error">{query.error.message}</p>}<div className="ctx-card ctx-brief">{query.data?.content ? <MarkdownView content={query.data.content} components={{ h1: ({ children }) => nodeText(children).trim() === '当前简报' ? null : <h2 className="ctx-section-title">{children}</h2> }} /> : <p className="ctx-muted">正在准备当前简报…</p>}</div><label className="ctx-body">固定说明<Textarea className="ctx-field mt-2" aria-label="简报固定说明" disabled={!query.data} value={draft?.notes ?? query.data?.manualNotes ?? ''} onChange={(event) => { const notes = event.target.value; updateDraft((current) => ({ notes, revision: current?.revision ?? query.data.revision })); }} /></label><Button className="ctx-btn ctx-btn-primary" disabled={busy || draft === null} onClick={() => void save()}>保存固定说明</Button></div>;
}

function OrganizationPanel({ topicId }: { topicId: string | null }) {
  const query = useQuery({ queryKey: ['organizations', topicId], queryFn: () => api<any[]>(`/api/v1/knowledge/organizations?topicId=${topicId ?? 'inbox'}`) });
  const [purpose, setPurpose] = useState('整理资料中的下一步任务、决策和需要确认的问题');
  const [provider, setProvider] = useState('external');
  const { run, busy } = usePlatformAction();
  return <details className="ctx-card"><summary className="cursor-pointer text-sm font-semibold">AI 辅助整理</summary><div className="ctx-stack mt-4"><Textarea aria-label="整理目标" className="ctx-field" value={purpose} onChange={(event) => setPurpose(event.target.value)} /><select aria-label="整理方式" className="ctx-select" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="external">外部 AI 通过 MCP 整理</option><option value="builtin">使用已配置的内置模型</option></select><Button className="ctx-btn" disabled={busy || !purpose.trim()} onClick={() => void run(async () => { const request = await api<any>('/api/v1/knowledge/organizations', { method: 'POST', body: json({ topicId, purpose, provider }) }); return provider === 'builtin' ? api(`/api/v1/knowledge/organizations/${request.id}/generate`, { method: 'POST', body: '{}' }) : request; }, provider === 'builtin' ? '整理建议已生成' : '整理请求已准备')}>准备整理</Button>{query.data?.map((request) => <article className="space-y-2 border-t pt-3" key={request.id}><p className="ctx-body">{request.purpose}</p><p className="ctx-muted">{request.status} · {new Date(request.createdAt).toLocaleString()}</p>{request.error && <p role="alert" className="ctx-error">{request.error}</p>}{request.result?.summary && <p className="ctx-body whitespace-pre-wrap">{request.result.summary}</p>}{request.provider === 'external' && !['proposed', 'completed'].includes(request.status) && <OrganizationPrompt id={request.id} purpose={request.purpose} />}{request.proposalIds?.length > 0 && <a className="ctx-body underline" href="#/proposals">检查待确认建议</a>}</article>)}</div></details>;
}
