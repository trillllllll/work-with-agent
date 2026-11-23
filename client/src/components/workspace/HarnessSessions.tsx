import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Archive, ArrowDown, ChevronRight, CircleAlert, Ellipsis, FolderOpen, ListOrdered, LoaderCircle, MessageSquare, Pin, ShieldQuestion, Terminal } from 'lucide-react';
import { ApiError, api } from '@/lib/api.js';
import { json } from '@/lib/platform.js';
import { intlLocale } from '@/i18n/index.js';
import { ChatComposer } from '@/components/chat/ChatComposer.js';
import { createBottomPin } from '@/components/chat/bottom-pin.js';
import { MarkdownView } from '@/components/shared/MarkdownView.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { ChoiceList } from '@/components/ui/choice-list.js';
import { BackButton } from '@/components/ui/nav-buttons.js';
import { Surface } from '@/components/ui/surface.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { Input } from '@/components/ui/input.js';
import { HarnessStartDialog } from './HarnessStartDialog.js';
import { HarnessSettings } from './HarnessSettings.js';
import { HarnessContext, HarnessPlan, HarnessQuestion, HarnessQueueControls, HarnessTurnControls, type HarnessAction } from './HarnessRunControls.js';
import { HarnessWorkspaceTools } from './HarnessWorkspaceTools.js';
import { HarnessTimeline } from './HarnessTimeline.js';
import { ChatProjectButton, HarnessProjectPicker, type HarnessProject, type ProjectComputer } from './HarnessProjectPicker.js';
import type { DirectoryPage } from '../../../../server/src/node-agent/directory-protocol.js';
import { applyHarnessEvent, HARNESS_TEXT_LIMIT, harnessKind, harnessNames, type HarnessKind, type HarnessCatalogPage, type HarnessHistoryPage,
  type HarnessCommand, type HarnessEvent, type HarnessInputAttachment, type HarnessSnapshot, type HarnessView } from '../../../../server/src/node-agent/harness-protocol.js';
import '@/components/chat/conversation.css';
import './harness-sessions.css';

const base = '/api/v1/harness-sessions';
const codex = { id: 'codex', name: 'Codex' };
const createKey = 'dovun-harness-create';
const emptyTimeline: HarnessView = { messages: [], turn: null, approvals: [], error: null };
const approvalLabels = {
  once: 'harness.allow', session: 'harness.allowInSession', project: 'harness.allowInProject',
  projectComputerUse: 'harness.allowComputerUseInProject', approvePlan: 'harness.plan.approve', deny: 'harness.decline',
} as const;
type Harness = typeof codex;
type Session = {
  id: string; nodeId: string; nodeName: string | null; online: boolean; projectName: string;
  threadId: string | null; epoch: number; status: string; error: string | null; startCommandId: string;
  harness?: string; locationId: string; title?: string | null; activity?: 'approval' | 'running' | null; updatedAt: string;
  native?: boolean; historyAvailable?: boolean; settingsAvailable?: boolean; workspaceAvailable?: boolean;
  pinned?: boolean; archived?: boolean; unread?: boolean;
  sourceSessionId?: string | null;
};
type SessionRow = Pick<Session, 'id' | 'nodeName' | 'online' | 'projectName' | 'status' | 'title' | 'activity' | 'updatedAt' | 'pinned' | 'archived' | 'unread'> & {
  nativeThreadId?: string; projectKey: string; projectPath?: string;
};
type Detail = Session & { snapshot: HarnessSnapshot | null; current: boolean };
type List = {
  harnesses?: Harness[];
  nodes: Array<ProjectComputer & { supportsHarness: boolean; harnessLibrary?: boolean; harnessWorkspace?: boolean; harnesses?: HarnessKind[] }>;
  directories?: HarnessProject[];
  sessions: Session[];
  nextCursor?: string | null;
};
type Project = { id: string; name: string; locations: Array<{ id: string; nodeId: string; path: string; status: string }> };
type Receipt = { commandId: string; status: string; error: string | null; settings?: boolean; resultSessionId?: string };
type Pending = { command: HarnessCommand };
type StartCommand = { nodeId: string; locationId: string; commandId: string; harness?: string };

function load<T>(key: string): T | null {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') as T; } catch { return null; }
}
function save(key: string, value: unknown) {
  try {
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* Keep the live draft when storage is unavailable. */ }
}
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function delivering(receipt: Receipt) { return receipt.status === 'queued' || receipt.status === 'dispatched'; }

function useHarnessStream(id: string) {
  const snapshotKey = `dovun-harness-timeline:${id}`;
  const [{ snapshot, liveMessageId }, setOutput] = useState<{ snapshot: HarnessSnapshot | null; liveMessageId?: string }>(() => ({
    snapshot: load<HarnessSnapshot>(snapshotKey),
  }));
  const [ready, setReady] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const current = useRef(snapshot);
  useEffect(() => {
    let source: EventSource;
    function connect(reset = false) {
      source?.close();
      setReady(false);
      let live = false;
      const view = current.current;
      // Cached snapshots from builds that did not request settings need a full refresh.
      const after = !reset && view?.view.settings ? `&after=${view.epoch}:${view.seq}` : '';
      source = new EventSource(`${base}/${encodeURIComponent(id)}/events?timeline=1&settings=1&workspace=1&permissions=1${after}`);
      source.onerror = () => { live = false; setReady(false); };
      source.onmessage = (event) => {
        let data: HarnessSnapshot | { type: 'event'; epoch: number; seq: number; event: HarnessEvent } | { type: 'receipt'; receipt: Receipt } | { type: 'unavailable'; epoch: number; error: string } | { type: 'caughtUp'; epoch: number; seq: number };
        try { data = JSON.parse(event.data); } catch { connect(true); return; }
        const previous = current.current;
        if (data.type === 'receipt') { setReceipt(data.receipt); return; }
        if (data.type === 'unavailable') {
          if (!previous || data.epoch >= previous.epoch) { live = false; setUnavailable(data.error); setReady(false); }
          return;
        }
        if (data.type === 'caughtUp') {
          if (previous?.epoch === data.epoch && previous.seq === data.seq) { live = true; setReady(true); }
          return;
        }
        if (data.type === 'snapshot') {
          if (previous && (data.epoch < previous.epoch || data.epoch === previous.epoch && data.seq < previous.seq)) return;
          current.current = data;
          setOutput({ snapshot: data });
          live = true;
          setUnavailable(null);
          setReady(true);
          return;
        }
        if (previous && (data.epoch < previous.epoch || data.epoch === previous.epoch && data.seq <= previous.seq)) return;
        if (!previous || previous.epoch !== data.epoch || data.seq !== previous.seq + 1) { connect(true); return; }
        const next = { ...previous, seq: data.seq, view: applyHarnessEvent(previous.view, data.event) };
        current.current = next;
        setOutput({ snapshot: next, liveMessageId: live && data.event.kind === 'delta' ? data.event.id : undefined });
      };
    }
    const remember = () => save(snapshotKey, current.current);
    const resume = () => { if (document.visibilityState === 'visible') connect(); else remember(); };
    const offline = () => setReady(false);
    connect();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pagehide', remember);
    window.addEventListener('online', resume);
    window.addEventListener('offline', offline);
    return () => {
      remember();
      source.close();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pagehide', remember);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', offline);
    };
  }, [id, snapshotKey]);
  return { snapshot, liveMessageId, ready, receipt, unavailable };
}

type SessionMetadata = { title?: string; pinned?: boolean; archived?: boolean; read?: boolean };

function SessionList({ sessions, groupByProject, selectedId, opening, open, update }: {
  sessions: SessionRow[]; groupByProject: boolean; selectedId?: string; opening?: string | null;
  open: (row: SessionRow) => void; update: (id: string, change: SessionMetadata) => void;
}) {
  const { t } = useTranslation('workspace');
  const [renaming, setRenaming] = useState<SessionRow | null>(null);
  const [title, setTitle] = useState('');
  const groups = new Map<string, SessionRow[]>();
  const clock = new Intl.DateTimeFormat(intlLocale(), { month: 'short', day: 'numeric' });
  for (const session of sessions) {
    const key = groupByProject ? session.projectKey : '';
    const rows = groups.get(key) ?? [];
    rows.push(session);
    groups.set(key, rows);
  }
  const headings = new Map<string, number>();
  for (const [group, [session]] of groups) {
    if (!group) continue;
    const label = session.projectName + '\0' + session.nodeName;
    headings.set(label, (headings.get(label) ?? 0) + 1);
  }

  return <><Surface tone="sheet" className="workspace-rows">
    {[...groups].map(([group, entries]) => <section className="harness-session-group" key={group}>
      {groupByProject && <div className="px-2 pt-3.5 pb-1">
        <h2 className="flex min-w-0 items-center gap-2 text-xs font-medium">
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{entries[0].projectName}</span>
          <span className="truncate font-normal text-muted-foreground">{entries[0].nodeName}</span>
        </h2>
        {(headings.get(entries[0].projectName + '\0' + entries[0].nodeName) ?? 0) > 1 && entries[0].projectPath &&
          <p className="mt-0.5 pl-5 text-xs text-muted-foreground [overflow-wrap:anywhere]">{entries[0].projectPath}</p>}
      </div>}
      {entries.map((session) => {
        const running = session.online && session.activity === 'running';
        const approval = session.online && session.activity === 'approval';
        const status = !session.online ? t('harness.status.offline') : session.status !== 'ready' ? t('harness.status.' + session.status)
          : approval ? t('harness.waitingApproval') : running ? t('harness.turn.inProgress') : '';
        const nodeName = session.nodeName ?? t('harness.unknownComputer');
        return <div key={session.id} className="flex min-w-0 items-center">
          <Button type="button" variant="row" size="bare"
          className="workspace-row flex min-h-[55px] min-w-0 flex-1 items-center gap-2.5 px-2 py-2 text-left"
          aria-current={selectedId === session.id ? 'page' : undefined} data-selected={selectedId === session.id || undefined}
          disabled={Boolean(session.nativeThreadId && (!session.online || opening))} aria-busy={opening === session.id || undefined}
          onClick={() => open(session)}>
          {approval ? <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
            : running || opening === session.id ? <LoaderCircle className="size-4 shrink-0 animate-spin text-brand-link motion-reduce:animate-none" aria-hidden="true" />
              : session.pinned ? <Pin className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                : <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <span className="truncate">{session.title || session.projectName}</span>
              {session.unread && <span className="size-1.5 shrink-0 rounded-full bg-brand-link" aria-label={t('harness.unread')} />}
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">{session.title ? session.projectName + ' · ' + nodeName : nodeName}</span>
              {status && <span className={'shrink-0 ' + (approval ? 'text-warning' : '')}>{status}</span>}
            </span>
          </span>
          {Number.isFinite(Date.parse(session.updatedAt)) && <time dateTime={session.updatedAt} className="shrink-0 text-xs text-muted-foreground tabular-nums">{clock.format(new Date(session.updatedAt))}</time>}
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Button>
          {!session.nativeThreadId && <DropdownMenu>
            <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={t('harness.sessionActions')}><Ellipsis /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => { setTitle(session.title || session.projectName); setRenaming(session); }}>{t('harness.rename')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => update(session.id, { pinned: !session.pinned })}>{t(session.pinned ? 'harness.unpin' : 'harness.pin')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => update(session.id, { archived: !session.archived })}>{t(session.archived ? 'harness.unarchive' : 'harness.archive')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => update(session.id, { read: Boolean(session.unread) })}>{t(session.unread ? 'harness.markRead' : 'harness.markUnread')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>}
        </div>;
      })}
    </section>)}
  </Surface><Dialog open={!!renaming} onOpenChange={(next) => { if (!next) setRenaming(null); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t('harness.rename')}</DialogTitle></DialogHeader>
      <form className="grid gap-4" onSubmit={(event) => {
        event.preventDefault();
        if (renaming && title.trim()) update(renaming.id, { title: title.trim() });
        setRenaming(null);
      }}>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} aria-label={t('harness.sessionTitle')} />
        <DialogFooter><Button type="submit" disabled={!title.trim()}>{t('settings:actions.save')}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog></>;
}

export function HarnessSessions({ id, harness, project, navigation, open, selectHarness, selectProject }: {
  id?: string;
  harness?: string;
  project?: string;
  navigation: ReactNode;
  open: (id?: string) => void;
  selectHarness: (id: string) => void;
  selectProject: (id: string | null) => void;
}) {
  const { t } = useTranslation('workspace');
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'project' | 'recent' | 'archive'>('project');
  const list = useInfiniteQuery({
    queryKey: ['harness-sessions', harness ?? codex.id, project ?? null, mode === 'archive'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ harness: harness ?? codex.id });
      if (project) params.set('locationId', project);
      if (mode === 'archive') params.set('archived', '1');
      if (pageParam) params.set('cursor', pageParam);
      return api<List>(base + '?' + params, { signal });
    },
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: (query) => (query.state.data?.pages.length ?? 0) < 2 ? 5_000 : false,
  });
  const listData = list.data?.pages[0];
  const allSessions = list.data?.pages.flatMap((page) => page.sessions) ?? [];
  const harnesses = listData?.harnesses?.length ? listData.harnesses : [codex];
  const selected = harnesses.find((item) => item.id === harness) ?? harnesses[0];
  const sessions = allSessions.filter((session) => (session.harness ?? codex.id) === selected.id);
  const current = allSessions.find((session) => session.id === id);
  const [createOpen, setCreateOpen] = useState(false);
  const [picker, setPicker] = useState<'list' | 'new' | 'chat' | null>(null);
  const projects = useQuery({ queryKey: ['harness-projects'], queryFn: () => api<Project[]>('/api/projects') });
  const [locationId, setLocationId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [nativeError, setNativeError] = useState<{ project: string; text: string } | null>(null);
  const startGate = useRef(false);
  const openGate = useRef(false);
  const nodes = new Map(listData?.nodes.map((node) => [node.id, node]));
  const busyNodes = new Set(allSessions.filter((session) => session.status !== 'failed').map((session) => session.nodeId));
  const supportsSelected = (node?: List['nodes'][number]) => node?.harnesses
    ? node.harnesses.some((harness) => harness === selected.id) : node?.supportsHarness && selected.id === codex.id;
  const discoverNodes = (listData?.nodes ?? []).filter((node) => node.online && node.harnessWorkspace && supportsSelected(node)).map((node) => node.id).sort();
  const discovery = useInfiniteQuery({
    queryKey: ['harness-index', selected.id, discoverNodes], enabled: discoverNodes.length > 0 && mode !== 'archive',
    initialPageParam: null as Record<string, string> | null, staleTime: 30_000, retry: false,
    queryFn: async ({ pageParam, signal }) => {
      const pending = pageParam ? Object.entries(pageParam) : discoverNodes.map((nodeId) => [nodeId, null] as const);
      const results = await Promise.allSettled(pending.map(async ([nodeId, cursor]) => {
        const page = await api<{ nextCursor: string | null }>(base + '/native/index', { method: 'POST', signal, body: json({ nodeId, cursor,
          ...(selected.id === codex.id ? {} : { harness: selected.id }),
        }) });
        return [nodeId, page.nextCursor === cursor ? null : page.nextCursor] as const;
      }));
      const errors = results.flatMap((result) => result.status === 'rejected' ? [message(result.reason, t('harness.requestFailed'))] : []);
      const next = Object.fromEntries(results.flatMap((result) => result.status === 'fulfilled' && result.value[1] ? [[result.value[0], result.value[1]]] : [])) as Record<string, string>;
      return { next, errors };
    },
    getNextPageParam: (page) => Object.keys(page.next).length ? page.next : null,
  });
  useEffect(() => {
    if (discovery.dataUpdatedAt) void queryClient.invalidateQueries({ queryKey: ['harness-sessions'] });
  }, [discovery.dataUpdatedAt, queryClient]);
  const registered = projects.data?.flatMap((project) => project.locations.flatMap((location) => {
    const node = nodes.get(location.nodeId);
    return location.status === 'verified' && node
      ? [{ ...location, projectName: project.name, computerName: node.name }] : [];
  })) ?? [];
  const directories = listData?.directories ?? [];
  const allLocations: HarnessProject[] = [...registered, ...directories];
  const catalog = [...registered, ...directories.filter((dir) => !registered.some((item) => item.nodeId === dir.nodeId && item.path === dir.path))];
  const chosenLocation = allLocations.find((item) => item.id === project);
  const selectedProject = chosenLocation && (catalog.find((item) => item.id === project)
    ?? catalog.find((item) => item.nodeId === chosenLocation.nodeId && item.path === chosenLocation.path));
  const matchesProject = (locationId: string) => !project || locationId === project || Boolean(selectedProject &&
    allLocations.some((item) => item.id === locationId && item.nodeId === selectedProject.nodeId && item.path === selectedProject.path));
  const projectComputer = selectedProject && nodes.get(selectedProject.nodeId);
  const visibleSessions = sessions.filter((session) => matchesProject(session.locationId));
  const verifiedLocations = catalog.filter((item) => {
    const node = nodes.get(item.nodeId);
    return node?.online && supportsSelected(node) && (!project || item.id === selectedProject?.id);
  });
  const locations = verifiedLocations.filter((location) => nodes.get(location.nodeId)?.harnessLibrary || !busyNodes.has(location.nodeId));
  const choice = locations.find((location) => location.id === locationId);
  const verifiedNodes = new Set(verifiedLocations.map((location) => location.nodeId));
  const occupied = sessions.filter((session) => session.status !== 'failed' && verifiedNodes.has(session.nodeId) && !nodes.get(session.nodeId)?.harnessLibrary)
    .map((session) => ({ id: session.id, title: session.title || session.projectName, computerName: (session.title ? session.projectName + ' · ' : '') + (session.nodeName ?? t('harness.unknownComputer')) }));
  const nativeEnabled = Boolean(mode !== 'archive' && selected.id === codex.id && selectedProject && projectComputer?.online && projectComputer.harnessLibrary && !projectComputer.harnessWorkspace);
  const native = useInfiniteQuery({
    queryKey: ['harness-native', selectedProject?.nodeId, selectedProject?.id], enabled: nativeEnabled,
    initialPageParam: null as string | null, staleTime: 20_000, retry: false,
    queryFn: ({ pageParam, signal }) => api<HarnessCatalogPage>(base + '/native', { method: 'POST', signal,
      body: json({ nodeId: selectedProject!.nodeId, locationId: selectedProject!.id, cursor: pageParam }) }),
    getNextPageParam: (page, _pages, cursor) => page.nextCursor === cursor ? null : page.nextCursor,
  });
  const seen = new Set(sessions.filter((session) => session.nodeId === selectedProject?.nodeId && session.status !== 'failed').map((session) => session.threadId));
  const projectPaths = new Map(allLocations.map((location) => [location.id, location.path]));
  const projectKey = (id: string, nodeId: string) => nodeId + '\0' + (projectPaths.get(id) ?? id);
  const rows: SessionRow[] = visibleSessions.map((session) => ({ ...session, projectPath: projectPaths.get(session.locationId), projectKey: projectKey(session.locationId, session.nodeId) }));
  if (selectedProject && selected.id === codex.id) {
    for (const page of native.data?.pages ?? []) for (const thread of page.threads) {
      if (seen.has(thread.threadId)) continue;
      seen.add(thread.threadId);
      rows.push({ id: 'native:' + thread.threadId, nativeThreadId: thread.threadId, nodeName: selectedProject.computerName,
        online: nativeEnabled, projectName: selectedProject.projectName, title: thread.title, status: 'ready', updatedAt: thread.updatedAt,
        projectKey: projectKey(selectedProject.id, selectedProject.nodeId), projectPath: selectedProject.path });
    }
  }
  const indexed = new Map(rows.map((row) => [row.id, row]));
  const uniqueRows = [...indexed.values()].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const [metadataError, setMetadataError] = useState<string | null>(null);
  async function updateMetadata(sessionId: string, change: SessionMetadata) {
    setMetadataError(null);
    try {
      await api(`${base}/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: json(change) });
      void list.refetch();
      void queryClient.invalidateQueries({ queryKey: ['harness-session', sessionId] });
    } catch (failure) {
      setMetadataError(message(failure, t('harness.requestFailed')));
    }
  }

  async function openRow(row: SessionRow) {
    if (!row.nativeThreadId) {
      open(row.id);
      if (row.unread) void updateMetadata(row.id, { read: true });
      return;
    }
    if (!nativeEnabled || !selectedProject || openGate.current) return;
    openGate.current = true;
    setOpening(row.id);
    setNativeError(null);
    const origin = window.location.hash;
    try {
      const result = await api<{ sessionId: string }>(base + '/native/open', { method: 'POST',
        body: json({ nodeId: selectedProject.nodeId, locationId: selectedProject.id, threadId: row.nativeThreadId }) });
      void list.refetch();
      if (window.location.hash === origin) open(result.sessionId);
    } catch (failure) { setNativeError({ project: selectedProject.id, text: message(failure, t('harness.requestFailed')) }); }
    finally { openGate.current = false; setOpening(null); }
  }

  function changeCreateOpen(next: boolean) {
    if (startGate.current) return;
    if (next) {
      const previous = load<StartCommand>(createKey);
      const recovered = previous && visibleSessions.find((session) => session.startCommandId === previous.commandId);
      if (recovered) {
        save(createKey, null);
        open(recovered.id);
        return;
      }
      setLocationId(selectedProject?.id ?? previous?.locationId ?? '');
      setError(null);
    }
    setCreateOpen(next);
  }

  async function start() {
    if (!choice || startGate.current) return;
    startGate.current = true;
    setStarting(true);
    setError(null);
    const origin = window.location.hash;
    const saved = load<StartCommand>(createKey);
    const command = saved?.locationId === choice.id && saved.nodeId === choice.nodeId && (saved.harness ?? codex.id) === selected.id ? saved
      : { nodeId: choice.nodeId, locationId: choice.id, commandId: crypto.randomUUID(), ...(selected.id === codex.id ? {} : { harness: selected.id }) };
    save(createKey, command);
    try {
      const created = await api<{ sessionId: string }>(base, { method: 'POST', body: json(command) });
      save(createKey, null);
      setCreateOpen(false);
      void list.refetch();
      if (window.location.hash === origin) open(created.sessionId);
    } catch (failure) {
      setError(message(failure, t('harness.requestFailed')));
      void list.refetch();
    } finally { startGate.current = false; setStarting(false); }
  }

  const locationError = error ?? projects.error?.message ?? list.error?.message;
  const chatHarness = harnesses.find((item) => item.id === current?.harness) ?? selected;
  return <section className="harness-workspace h-full min-h-0">
    <div className="harness-workspace-panes" data-session-open={Boolean(id)}>
      <div className="harness-list-pane glass-scrollbar min-h-0 min-w-0 overflow-y-auto overscroll-contain">
        <div className="workspace-page harness-session-page">
          {navigation}
          <header className="flex items-center justify-between gap-2">
            <h1>{t('harness.tab')}</h1>
            {selected.id !== 'zcode' && <HarnessStartDialog open={createOpen} onOpenChange={changeCreateOpen} harnessName={selected.name}
              locations={locations} value={choice?.id ?? ''} onSelect={setLocationId} onStart={start}
              unavailable={projectComputer && (!projectComputer.online ? t('harness.selectedOffline', { computer: projectComputer.name })
                : !supportsSelected(projectComputer) ? t('harness.selectedUnsupported', { computer: projectComputer.name, harness: selected.name }) : undefined)}
              onChooseProject={() => { setCreateOpen(false); setPicker('new'); }}
              occupied={occupied} onResume={(sessionId) => { setCreateOpen(false); open(sessionId); }}
              loading={list.isLoading || projects.isLoading} starting={starting} error={locationError} />}
          </header>
          <div className="mb-5 grid gap-3">
            <ChoiceList label={t('harness.filter')} value={selected.id} onChange={selectHarness}
              options={harnesses.map((item) => ({ id: item.id, label: item.name, icon: <Terminal className="size-4" /> }))} />
            <HarnessProjectPicker open={picker !== null} onOpenChange={(next) => {
              if (!next && picker === 'new') setCreateOpen(true);
              setPicker(next ? 'list' : null);
            }} projects={catalog} computers={listData?.nodes ?? []} value={picker === 'chat' ? current?.locationId : selectedProject?.id}
              loading={projects.isLoading || list.isLoading} error={projects.error?.message}
              browse={(nodeId, path) => api<DirectoryPage>(base + '/directories/browse', { method: 'POST', body: json({ nodeId, path }) })}
              selectDirectory={async (nodeId, path) => {
                const added = await api<HarnessProject>(base + '/directories/select', { method: 'POST', body: json({ nodeId, path }) });
                void queryClient.invalidateQueries({ queryKey: ['harness-index', selected.id] });
                return added;
              }}
              onChange={(item) => {
                if (item && !catalog.some((p) => p.id === item.id)) {
                  void list.refetch();
                  void projects.refetch();
                }
                if (picker !== 'chat' || !item || item.id !== current?.locationId) selectProject(item?.id ?? null);
                setLocationId(item?.id ?? '');
              }} />
            <div className="flex flex-wrap gap-1" role="group" aria-label={t('harness.listView')}>
              {(['project', 'recent', 'archive'] as const).map((view) => <Button key={view} type="button" size="sm" className="min-h-11"
                variant={mode === view ? 'secondary' : 'ghost'} aria-pressed={mode === view} onClick={() => {
                  setMode(view);
                  if (view === 'recent' && project) selectProject(null);
                }}>
                {view === 'archive' && <Archive />} {t('harness.view.' + view)}
              </Button>)}
            </div>
          </div>
          {list.error && <p role="alert" className="mb-3 text-sm text-destructive">{list.error.message}</p>}
          {metadataError && <p role="alert" className="mb-3 text-sm text-destructive">{metadataError}</p>}
          {nativeError && nativeError.project === selectedProject?.id && <p role="alert" className="mb-3 text-sm text-destructive">{nativeError.text}</p>}
          {uniqueRows.length > 0 && <SessionList sessions={uniqueRows} groupByProject={mode !== 'recent' && !selectedProject}
            selectedId={id} opening={opening} open={(row) => void openRow(row)} update={(sessionId, change) => void updateMetadata(sessionId, change)} />}
          {(list.isLoading || nativeEnabled && native.isPending || discovery.isLoading) && <p role="status" className="px-2 py-4 text-sm text-muted-foreground">{t('harness.loading')}</p>}
          {nativeEnabled && native.error && <div className="flex flex-wrap items-center gap-2 px-2 py-3">
            <p role="alert" className="text-sm text-destructive">{native.error.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void native.refetch()}>{t('harness.retry')}</Button>
          </div>}
          {!list.isLoading && !list.error && !discovery.isFetching && !rows.length && (!nativeEnabled || !native.isPending && !native.error && !native.hasNextPage) &&
            <p className="px-2 py-6 text-sm text-muted-foreground">{t(selectedProject ? 'harness.noProjectSessions' : 'harness.noSessions', { harness: selected.name, project: selectedProject?.projectName })}</p>}
          {list.hasNextPage && <Button type="button" variant="ghost" className="mt-2 min-h-11 w-full"
            disabled={list.isFetching} onClick={() => void list.fetchNextPage()}>{t(list.isFetchingNextPage ? 'harness.loading' : 'harness.moreSessions')}</Button>}
          {mode !== 'archive' && discovery.hasNextPage && <Button type="button" variant="ghost" className="mt-2 min-h-11 w-full"
            disabled={discovery.isFetching} onClick={() => void discovery.fetchNextPage()}>{t(discovery.isFetchingNextPage ? 'harness.loading' : 'harness.moreNative')}</Button>}
          {mode !== 'archive' && discovery.data?.pages.some((page) => page.errors.length) && <div className="flex items-center gap-2 px-2 py-3">
            <p role="status" className="text-sm text-muted-foreground">{t('harness.indexError')}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void discovery.refetch()}>{t('harness.retry')}</Button>
          </div>}
          {nativeEnabled && native.hasNextPage && <Button type="button" variant="ghost" className="mt-2 min-h-11 w-full"
            disabled={native.isFetching} onClick={() => void native.fetchNextPage()}>{t(native.isFetchingNextPage ? 'harness.loading' : 'harness.moreSessions')}</Button>}
        </div>
      </div>
      <div className="harness-detail-pane min-h-0 min-w-0">
        {id ? <HarnessDetail key={id} id={id} summary={current} harness={chatHarness} back={() => open()} chooseProject={() => setPicker('chat')} openSession={open} />
          : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('harness.chooseSession')}</div>}
      </div>
    </div>
  </section>;
}

function HarnessDetail({ id, summary, harness, back, chooseProject, openSession }: {
  id: string; summary?: Session; harness: Harness; back: () => void; chooseProject: () => void; openSession: (id: string) => void;
}) {
  const { t } = useTranslation(['workspace', 'chat']);
  const queryClient = useQueryClient();
  const path = `${base}/${encodeURIComponent(id)}`;
  const draftKey = `dovun-harness-draft:${id}`;
  const attachmentKey = `dovun-harness-attachments:${id}`;
  const pendingKey = `dovun-harness-pending:${id}`;
  const [draft, setDraft] = useState(() => load<string>(draftKey) ?? '');
  const [attachments, setAttachments] = useState(() => load<HarnessInputAttachment[]>(attachmentKey) ?? []);
  const [toolRequest, setToolRequest] = useState<'files' | 'commands' | null>(null);
  const [pending, setPending] = useState(() => load<Pending>(pendingKey));
  const pendingRef = useRef(pending);
  const [sending, setSending] = useState(false);
  const sendGate = useRef(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const historyAnchor = useRef<{ row: HTMLElement; top: number; pages: number } | null>(null);
  const [pin] = useState(createBottomPin);
  const [showLatest, setShowLatest] = useState(false);
  const detail = useQuery({ queryKey: ['harness-session', id], queryFn: () => api<Detail>(path + '?timeline=1&settings=1&workspace=1&permissions=1'), refetchInterval: 4_000 });
  const stream = useHarnessStream(id);
  const snapshot = stream.snapshot ?? detail.data?.snapshot;
  const view = snapshot?.view;
  const settings = detail.data?.settingsAvailable ? view?.settings : undefined;
  const historyEnabled = Boolean(detail.data?.historyAvailable && (detail.data.native || detail.data.title || view?.messages.length));
  const history = useInfiniteQuery({
    queryKey: ['harness-history', id, detail.data?.threadId, snapshot?.epoch], enabled: historyEnabled,
    initialPageParam: null as string | null, staleTime: 30_000, retry: false, refetchOnWindowFocus: false,
    queryFn: ({ pageParam, signal }) => api<HarnessHistoryPage>(path + '/history', { method: 'POST', signal, body: json({ cursor: pageParam }) }),
    getNextPageParam: (page, _pages, cursor) => page.nextCursor === cursor ? null : page.nextCursor,
  });
  const historicalViews = useMemo(() => (history.data?.pages ?? []).slice().reverse().map((page) => page.view), [history.data]);
  const historyLoading = historyEnabled && history.isPending;
  const hasMessages = Boolean(view?.messages.length || view?.turn || historicalViews.some((page) => page.messages.length || page.tools?.length));
  const currentTurn = view?.turn;
  const inProgress = currentTurn?.status === 'inProgress';
  const awaitingApproval = Boolean(view?.approvals.length);
  const enabled = !!detail.data?.online && !!snapshot && stream.ready && !stream.unavailable && detail.data.status !== 'failed';
  const actionsDisabled = !enabled || !!pending || sending;
  const startCommandId = detail.data?.startCommandId;
  const waitingForStart = !snapshot && detail.data?.status === 'creating' && !detail.data.native;
  const commandId = pending?.command.commandId ?? (waitingForStart ? startCommandId : undefined);
  const tracked = useQuery({
    queryKey: ['harness-receipt', id, commandId], enabled: !!commandId,
    queryFn: () => api<Receipt>(`${path}/commands/${encodeURIComponent(commandId!)}`),
    refetchInterval: 2_000, retry: false,
  });

  function updateDraft(value: string) {
    setDraft(value);
    save(draftKey, value);
    if (detail.data?.workspaceAvailable && !actionsDisabled) {
      if (/(^|\s)@$/.test(value)) setToolRequest('files');
      if (value === '/') setToolRequest('commands');
    }
  }
  function editAttachments(change: (files: HarnessInputAttachment[]) => HarnessInputAttachment[]) {
    setAttachments((previous) => {
      const updated = change(previous);
      save(attachmentKey, updated.length ? updated : null);
      return updated;
    });
  }
  function updatePending(value: Pending | null) { pendingRef.current = value; setPending(value); save(pendingKey, value); }
  function observe(next: Receipt) {
    const active = pendingRef.current;
    const expected = active?.command.commandId ?? (waitingForStart ? startCommandId : undefined);
    if (next.commandId !== expected) return;
    setReceipt((previous) => {
      if (previous?.commandId === next.commandId && delivering(next) && previous.status !== 'queued') return previous;
      return { ...next, settings: active?.command.operation === 'configure' };
    });
    if (next.commandId === startCommandId && !delivering(next)) void detail.refetch();
    if (!active || delivering(next)) return;
    if (active.command.operation === 'configure') {
      setSettingsError(next.status === 'accepted' ? null : next.error ?? t('harness.requestFailed'));
      if (next.status !== 'accepted') void detail.refetch();
    }
    if (next.status === 'accepted' && (active.command.operation === 'send' || active.command.operation === 'steer' || active.command.operation === 'enqueue')) {
      const text = active.command.text;
      const sent = active.command.attachments;
      setDraft((value) => {
        if (value.trim() !== text) return value;
        save(draftKey, '');
        return '';
      });
      if (sent?.length) editAttachments((files) => JSON.stringify(files) === JSON.stringify(sent) ? [] : files);
    }
    updatePending(null);
  }
  useEffect(() => { if (stream.receipt) observe(stream.receipt); }, [stream.receipt]);
  useEffect(() => { if (tracked.data) observe(tracked.data); }, [tracked.data]);
  useEffect(() => {
    if (stream.ready) void queryClient.invalidateQueries({ queryKey: ['harness-sessions'] });
  }, [queryClient, stream.ready, inProgress, awaitingApproval]);

  const followLatest = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const top = pin.onResize(scroll);
    if (top !== null && top !== scroll.scrollTop) scroll.scrollTop = top;
  }, [pin]);
  useLayoutEffect(followLatest, [followLatest, view, historicalViews]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current, anchor = historyAnchor.current;
    if (!scroll || !anchor || (history.data?.pages.length ?? 0) <= anchor.pages) return;
    historyAnchor.current = null;
    if (anchor.row.isConnected) scroll.scrollTop += anchor.row.getBoundingClientRect().top - anchor.top;
    pin.onScroll(scroll, true);
    setShowLatest(!pin.isPinned());
  }, [history.data, pin]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current, thread = threadRef.current;
    if (!scroll || !thread) return;
    const observer = new ResizeObserver(followLatest);
    observer.observe(scroll);
    observer.observe(thread);
    return () => observer.disconnect();
  }, [followLatest]);

  function jumpToLatest() {
    historyAnchor.current = null;
    pin.pin();
    setShowLatest(false);
    followLatest();
  }

  function loadOlder() {
    if (!history.hasNextPage || history.isFetching || !detail.data?.historyAvailable) return;
    const scroll = scrollRef.current;
    if (scroll) {
      const viewport = scroll.getBoundingClientRect();
      const row = [...scroll.querySelectorAll<HTMLElement>('[data-harness-turn]')].find((item) => item.getBoundingClientRect().bottom > viewport.top);
      if (row) historyAnchor.current = { row, top: row.getBoundingClientRect().top, pages: history.data?.pages.length ?? 0 };
      pin.onScroll(scroll, true);
    }
    void history.fetchNextPage({ cancelRefetch: false }).then((result) => { if (result.isError) historyAnchor.current = null; });
  }

  async function post(command: HarnessCommand) {
    if (sendGate.current) return;
    sendGate.current = true;
    setSending(true);
    setError(null);
    if (command.operation === 'configure') setSettingsError(null);
    try { observe(await api<Receipt>(`${path}/commands`, { method: 'POST', body: json(command) })); }
    catch (failure) {
      const reason = message(failure, t('harness.requestFailed'));
      setError(reason);
      if (command.operation === 'configure') setSettingsError(reason);
      if (failure instanceof ApiError && failure.status && failure.status < 500) updatePending(null);
    } finally { sendGate.current = false; setSending(false); }
  }
  function act(action: HarnessAction) {
    if (!enabled || !snapshot || pendingRef.current || sendGate.current) return;
    if ('text' in action) jumpToLatest();
    const command = { ...action, commandId: crypto.randomUUID(), expectedEpoch: snapshot.epoch };
    setReceipt(null);
    updatePending({ command });
    void post(command);
  }

  const session = detail.data ?? summary;
  const provider = harnessKind.safeParse(detail.data?.harness ?? summary?.harness).data ?? harnessKind.safeParse(harness.id).data;
  const name = provider ? harnessNames[provider] : harness.name;
  const zcode = provider === 'zcode';
  const sendLabel = inProgress && !zcode ? provider === 'claude' ? 'harness.queue.enqueue' : 'harness.steer' : 'harness.send';
  const projectName = session?.projectName;
  const nodeName = session?.nodeName ?? t('harness.unknownComputer');
  const status = !session ? 'reconnecting' : !session.online ? 'offline' : enabled ? 'ready'
    : stream.unavailable ? 'unavailable' : session.status === 'ready' ? 'reconnecting' : session.status;
  const detailError = detail.error?.message ?? stream.unavailable ?? detail.data?.error;
  const approvalControls = view?.approvals.map((request) => {
    if (request.kind === 'question') {
      return <HarnessQuestion key={request.id} request={request} disabled={actionsDisabled} answer={act} />;
    }
    const title = t('harness.approval.' + request.kind, { harness: name });
    return <Surface as="section" tone="subtle" className="space-y-2.5 rounded-xl p-3" key={request.id} aria-label={title}>
      <h3 className="flex items-center gap-2 text-sm font-medium text-warning">
        <ShieldQuestion className="size-4" aria-hidden="true" />{title}
      </h3>
      {request.details && (request.kind === 'plan' ? <MarkdownView content={request.details} responsiveTables />
        : <p className="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{request.details}</p>)}
      <div className="flex flex-wrap justify-end gap-2">
        {request.options ? request.options.map(({ id, scope }) => <Button key={id} type="button" className="min-h-11"
          variant={scope === 'once' || scope === 'approvePlan' ? 'default' : 'outline'} disabled={actionsDisabled}
          onClick={() => act({ operation: 'choosePermission', requestId: request.id, optionId: id })}>
          {t(approvalLabels[scope])}
        </Button>) : (request.decisions ?? (request.canAccept ? ['decline', 'accept'] as const : ['decline'] as const)).map((decision) => <Button
          key={decision} type="button" className="min-h-11" variant={decision === 'accept' ? 'default' : 'outline'} disabled={actionsDisabled}
          onClick={() => act({ operation: 'resolveApproval', requestId: request.id, decision })}>
          {t(decision === 'accept' ? 'harness.allow' : decision === 'decline' ? 'harness.decline'
            : decision === 'cancel' ? 'harness.cancelApproval' : 'harness.allowInSession')}
        </Button>)}
      </div>
    </Surface>;
  });
  const visibleReceipt = receipt && (waitingForStart || receipt.commandId !== startCommandId) ? receipt : null;
  const workspace = session?.workspaceAvailable === true;
  const codexControls = workspace && name === harnessNames.codex;
  const attachmentInput = workspace && attachments.length ? { attachments } : {};
  const currentPlan = workspace && view?.plan?.turnId === currentTurn?.id ? view?.plan : undefined;
  const planControls = currentPlan && <HarnessPlan plan={currentPlan}
    canApprove={!actionsDisabled && currentPlan.ready && currentTurn?.status === 'completed' && settings?.mode === 'plan' && !view?.queue?.items.length}
    approve={() => {
      if (settings) act({ operation: 'approvePlan', turnId: currentPlan.turnId, expectedSettingsRevision: settings.revision });
    }} />;

  return <section className="dovun-assistant harness-thread flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    data-presentation="direct" aria-label={t('harness.detail')}>
    <header className="assistant-header flex items-center gap-2.5">
      <BackButton className="min-h-11 min-w-11" onClick={back}><span className="sr-only">{t('harness.back')}</span></BackButton>
      <Badge variant="secondary" className="size-8 p-0 text-muted-foreground"><Terminal className="size-4" aria-hidden="true" /></Badge>
      <div className="assistant-identity min-w-0 flex-1">
        <h2 title={session?.title ?? projectName}>{session?.title || projectName || t('harness.tab')}</h2>
        <p className="truncate text-xs text-muted-foreground" title={nodeName}>{name}{session && ' · ' + nodeName}</p>
      </div>
      {session?.sourceSessionId && <Button type="button" variant="ghost" size="sm" onClick={() => openSession(session.sourceSessionId!)}>{t('harness.sourceSession')}</Button>}
      <span className="max-w-[34%] text-right text-xs leading-tight text-muted-foreground" role="status">{t('harness.status.' + status)}</span>
    </header>
    {detailError && <p role="alert" className="shrink-0 px-4 pt-2 text-sm text-destructive [overflow-wrap:anywhere]">{detailError}</p>}
    <div className="assistant-messages relative min-h-0 flex-1">
      <div data-chat-scroll ref={scrollRef} onScroll={(event) => {
        pin.onScroll(event.currentTarget);
        setShowLatest(!pin.isPinned());
        if (!pin.isPinned() && event.currentTarget.scrollTop <= 24 && !history.isError) loadOlder();
      }}
        className="glass-scrollbar h-full min-w-0 overflow-y-auto overscroll-contain">
        <div ref={threadRef} className="assistant-thread flex min-w-0 flex-col gap-4">
          {detail.data?.historyAvailable && history.hasNextPage && <Button type="button" variant="ghost" size="sm"
            className="mx-auto min-h-11" disabled={history.isFetching} onClick={loadOlder}>
            {t(history.isFetchingNextPage ? 'harness.loadingHistory' : 'harness.moreHistory')}
          </Button>}
          {history.error && <div className="mx-auto flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-destructive">{history.error.message}</p>
            {!history.hasNextPage && <Button type="button" size="sm" variant="outline" onClick={() => void history.refetch()}>{t('harness.retry')}</Button>}
          </div>}
          {historyLoading && !hasMessages && <p role="status" className="text-center text-sm text-muted-foreground">{t('harness.loadingHistory')}</p>}
          {hasMessages ? <HarnessTimeline view={view ?? emptyTimeline} history={historicalViews} name={name} liveMessageId={stream.liveMessageId}
            approvalControls={<>{planControls}{approvalControls}</>}
            turnControls={codexControls ? (turn, firstMessage) => turn.status !== 'inProgress' && turn.status !== 'unknown' && <HarnessTurnControls
              turn={turn} prompt={firstMessage?.text} disabled={actionsDisabled} settingsRevision={settings?.revision}
              canRerun={currentTurn?.id === turn.id && !view?.queue?.items.length} act={act} /> : undefined} /> : !detailError && !historyLoading && !history.error && <div className="dovun-assistant-welcome">
            <h3>{t('harness.empty', { harness: name })}</h3>
          </div>}
          {!currentTurn && approvalControls}
        </div>
      </div>
      {showLatest && <Button type="button" variant="secondary" size="sm"
        className="absolute right-3 bottom-3 min-h-11 rounded-full shadow-card" onClick={jumpToLatest}>
        <ArrowDown aria-hidden="true" />{t('chat:messageList.jumpToBottom')}
      </Button>}
    </div>
    <div className="assistant-composer-area shrink-0">
      {workspace && view?.queue && <HarnessQueueControls queue={view.queue} running={inProgress} disabled={actionsDisabled} act={act} />}
      {workspace && attachments.length > 0 && <div className="mx-4 flex flex-wrap gap-1">
        {attachments.map((file, index) => <Button type="button" key={index} size="sm" variant="secondary" className="max-w-full"
          aria-label={t('harness.files.remove', { name: file.name })} disabled={actionsDisabled}
          onClick={() => editAttachments((files) => files.filter((_, position) => position !== index))}><span className="truncate">{file.name} ×</span></Button>)}
      </div>}
      {(visibleReceipt || error || pending && !sending && tracked.error) && (
        <div className="mb-2 flex flex-wrap items-center gap-2 px-2 text-xs text-muted-foreground">
          {visibleReceipt && <p role="status" className="[overflow-wrap:anywhere]">
            {t(visibleReceipt.settings && visibleReceipt.status === 'accepted' ? 'harness.settings.saved' : 'harness.receipt.' + visibleReceipt.status, { harness: name })}
            {visibleReceipt.error && ' · ' + visibleReceipt.error}
          </p>}
          {visibleReceipt?.resultSessionId && <Button type="button" size="sm" variant="outline"
            onClick={() => openSession(visibleReceipt.resultSessionId!)}>{t('harness.openFork')}</Button>}
          {error && <p role="alert" className="text-destructive [overflow-wrap:anywhere]">{error}</p>}
          {pending && !sending && tracked.error && <Button size="sm" variant="outline" type="button" onClick={() => void post(pending.command)}>{t('harness.retry')}</Button>}
        </div>
      )}
      <ChatComposer input={draft} onChange={updateDraft} maxLength={HARNESS_TEXT_LIMIT} busy={inProgress}
        actionsDisabled={actionsDisabled} allowSendWhileBusy={!zcode || Boolean(settings)} listenForAssistantFocus={false}
        labels={{ input: t('harness.draft'), send: t(sendLabel), stop: t('harness.interrupt') }}
        placeholder={sendLabel === 'harness.send' ? t('harness.placeholder', { harness: name }) : t(sendLabel)}
        toolbar={<>{workspace && <HarnessWorkspaceTools endpoint={path} disabled={actionsDisabled} capacity={Math.max(0, 2 - attachments.length)}
          requested={toolRequest} clearRequest={() => {
            if (toolRequest === 'commands' && draft === '/') updateDraft('');
            if (toolRequest === 'files' && /(^|\s)@$/.test(draft)) updateDraft(draft.slice(0, -1).trimEnd());
            setToolRequest(null);
          }} attach={(file) => editAttachments((files) => files.length >= 2 ? files : [...files, file])}
          running={inProgress || Boolean(view?.queue?.items.length)} compact={codexControls ? () => act({ operation: 'compact' }) : undefined}
          configurePlan={settings?.planAvailable ? () => act({ operation: 'configure', expectedSettingsRevision: settings.revision, changes: { mode: 'plan' } }) : undefined} />}
          {settings && <HarnessSettings settings={settings} harness={provider} disabled={actionsDisabled} saving={pending?.command.operation === 'configure'}
          error={settingsError} onChange={(changes) => act({ operation: 'configure', expectedSettingsRevision: settings.revision, changes })}
          onForkProvider={codexControls && !inProgress ? (modelProvider) => act({ operation: 'fork', modelProvider }) : undefined} />}
          {codexControls && inProgress && <Button type="button" variant="ghost" size="icon" aria-label={t('harness.queue.enqueue')} title={t('harness.queue.enqueue')}
            disabled={actionsDisabled || !draft.trim()} onClick={() => act({ operation: 'enqueue', text: draft.trim(), ...attachmentInput,
              ...(settings ? { expectedSettingsRevision: settings.revision } : {}) })}><ListOrdered /></Button>}
        </>}
        contextUsage={codexControls && <HarnessContext usage={view?.usage} disabled={actionsDisabled || inProgress || Boolean(view?.queue?.items.length)}
          compact={() => act({ operation: 'compact' })} />}
        model={projectName && <ChatProjectButton name={projectName} open={chooseProject} />}
        onSend={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text || zcode && inProgress && !settings) return;
          if (attachments.length && !workspace) { setError(t('harness.files.update')); return; }
          if (zcode) act({ operation: 'send', text, ...(settings ? { expectedSettingsRevision: settings.revision } : {}) });
          else if (inProgress && provider !== 'claude') act({ operation: 'steer', turnId: currentTurn.id, text, ...attachmentInput });
          else if (inProgress) act({ operation: 'enqueue', text, ...attachmentInput, ...(settings ? { expectedSettingsRevision: settings.revision } : {}) });
          else act({ operation: 'send', text, ...attachmentInput, ...(settings ? { expectedSettingsRevision: settings.revision } : {}) });
        }}
        onStop={inProgress ? () => act({ operation: 'interrupt', turnId: currentTurn.id }) : undefined} />
    </div>
  </section>;
}
