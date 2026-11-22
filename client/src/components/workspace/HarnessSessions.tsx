import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ChevronRight, CircleAlert, LoaderCircle, MessageSquare, ShieldQuestion, Terminal } from 'lucide-react';
import { ApiError, api } from '@/lib/api.js';
import { json } from '@/lib/platform.js';
import { intlLocale } from '@/i18n/index.js';
import { ChatComposer } from '@/components/chat/ChatComposer.js';
import { createBottomPin } from '@/components/chat/bottom-pin.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { ChoiceList } from '@/components/ui/choice-list.js';
import { BackButton } from '@/components/ui/nav-buttons.js';
import { Surface } from '@/components/ui/surface.js';
import { HarnessStartDialog } from './HarnessStartDialog.js';
import { HarnessTimeline } from './HarnessTimeline.js';
import { ChatProjectButton, HarnessProjectPicker, type HarnessProject, type ProjectComputer } from './HarnessProjectPicker.js';
import type { DirectoryPage } from '../../../../server/src/node-agent/directory-protocol.js';
import { applyHarnessEvent, HARNESS_TEXT_LIMIT, type HarnessCommand, type HarnessEvent, type HarnessSnapshot } from '../../../../server/src/node-agent/harness-protocol.js';
import '@/components/chat/conversation.css';
import './harness-sessions.css';

const base = '/api/v1/harness-sessions';
const codex = { id: 'codex', name: 'Codex' };
const createKey = 'dovun-harness-create';
type Harness = typeof codex;
type Session = {
  id: string; nodeId: string; nodeName: string | null; online: boolean; projectName: string;
  threadId: string | null; epoch: number; status: string; error: string | null; startCommandId: string;
  harness?: string; locationId: string; title?: string | null; activity?: 'approval' | 'running' | null; updatedAt: string;
};
type Detail = Session & { snapshot: HarnessSnapshot | null; current: boolean };
type List = {
  harnesses?: Harness[];
  nodes: Array<ProjectComputer & { supportsHarness: boolean }>;
  directories?: HarnessProject[];
  sessions: Session[];
};
type Project = { id: string; name: string; locations: Array<{ id: string; nodeId: string; path: string; status: string }> };
type Receipt = { commandId: string; status: string; error: string | null };
type Pending = { command: HarnessCommand };
type StartCommand = { nodeId: string; locationId: string; commandId: string };

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
      const after = !reset && view ? `&after=${view.epoch}:${view.seq}` : '';
      source = new EventSource(`${base}/${encodeURIComponent(id)}/events?timeline=1${after}`);
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

function SessionList({ sessions, selectedId, open }: { sessions: Session[]; selectedId?: string; open: (id: string) => void }) {
  const { t } = useTranslation('workspace');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const groups = { today: [] as Session[], yesterday: [] as Session[], earlier: [] as Session[] };
  const clock = new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' });
  for (const session of sessions) {
    const time = Date.parse(session.updatedAt);
    groups[time >= today.valueOf() ? 'today' : time >= yesterday.valueOf() ? 'yesterday' : 'earlier'].push(session);
  }

  return <Surface tone="sheet" className="workspace-rows">
    {Object.entries(groups).filter(([, entries]) => entries.length).map(([group, entries]) => <section className="harness-session-group" key={group}>
      <h2 className="px-2 pt-3.5 pb-1 text-xs font-medium text-muted-foreground">{t('harness.group.' + group)}</h2>
      {entries.map((session) => {
        const running = session.online && session.activity === 'running';
        const approval = session.online && session.activity === 'approval';
        const status = !session.online ? t('harness.status.offline') : session.status !== 'ready' ? t('harness.status.' + session.status)
          : approval ? t('harness.waitingApproval') : running ? t('harness.turn.inProgress') : '';
        const nodeName = session.nodeName ?? t('harness.unknownComputer');
        return <Button key={session.id} type="button" variant="row" size="bare"
          className="workspace-row flex min-h-[55px] w-full items-center gap-2.5 px-2 py-2 text-left"
          aria-current={selectedId === session.id ? 'page' : undefined} data-selected={selectedId === session.id || undefined}
          onClick={() => open(session.id)}>
          {approval ? <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
            : running ? <LoaderCircle className="size-4 shrink-0 animate-spin text-brand-link motion-reduce:animate-none" aria-hidden="true" />
              : <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{session.title || session.projectName}</span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">{session.title ? session.projectName + ' · ' + nodeName : nodeName}</span>
              {status && <span className={'shrink-0 ' + (approval ? 'text-warning' : '')}>{status}</span>}
            </span>
          </span>
          {Number.isFinite(Date.parse(session.updatedAt)) && <time dateTime={session.updatedAt} className="shrink-0 text-xs text-muted-foreground tabular-nums">{clock.format(new Date(session.updatedAt))}</time>}
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Button>;
      })}
    </section>)}
  </Surface>;
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
  const list = useQuery({ queryKey: ['harness-sessions'], queryFn: () => api<List>(base), refetchInterval: 5_000 });
  const queryClient = useQueryClient();
  const harnesses = list.data?.harnesses?.length ? list.data.harnesses : [codex];
  const selected = harnesses.find((item) => item.id === harness) ?? harnesses[0];
  const sessions = (list.data?.sessions ?? []).filter((session) => (session.harness ?? codex.id) === selected.id);
  const current = list.data?.sessions.find((session) => session.id === id);
  const [createOpen, setCreateOpen] = useState(false);
  const [picker, setPicker] = useState<'list' | 'new' | 'chat' | null>(null);
  const projects = useQuery({ queryKey: ['harness-projects'], queryFn: () => api<Project[]>('/api/projects') });
  const [locationId, setLocationId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const startGate = useRef(false);
  const nodes = new Map(list.data?.nodes.map((node) => [node.id, node]));
  const busyNodes = new Set(list.data?.sessions.filter((session) => session.status !== 'failed').map((session) => session.nodeId));
  const registered = projects.data?.flatMap((project) => project.locations.flatMap((location) => {
    const node = nodes.get(location.nodeId);
    return location.status === 'verified' && node
      ? [{ ...location, projectName: project.name, computerName: node.name }] : [];
  })) ?? [];
  const directories = list.data?.directories ?? [];
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
    return selected.id === codex.id && node?.online && node.supportsHarness && (!project || item.id === selectedProject?.id);
  });
  const locations = verifiedLocations.filter((location) => !busyNodes.has(location.nodeId));
  const choice = locations.find((location) => location.id === locationId);
  const verifiedNodes = new Set(verifiedLocations.map((location) => location.nodeId));
  const occupied = sessions.filter((session) => session.status !== 'failed' && verifiedNodes.has(session.nodeId))
    .map((session) => ({ id: session.id, title: session.title || session.projectName, computerName: (session.title ? session.projectName + ' · ' : '') + (session.nodeName ?? t('harness.unknownComputer')) }));

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
    const command = saved?.locationId === choice.id && saved.nodeId === choice.nodeId ? saved
      : { nodeId: choice.nodeId, locationId: choice.id, commandId: crypto.randomUUID() };
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
  const chatHarness = harnesses.find((item) => item.id === (current?.harness ?? codex.id)) ?? selected;
  return <section className="harness-workspace h-full min-h-0">
    <div className="harness-workspace-panes" data-session-open={Boolean(id)}>
      <div className="harness-list-pane glass-scrollbar min-h-0 min-w-0 overflow-y-auto overscroll-contain">
        <div className="workspace-page harness-session-page">
          {navigation}
          <header className="flex items-center justify-between gap-2">
            <h1>{t('harness.tab')}</h1>
            <HarnessStartDialog open={createOpen} onOpenChange={changeCreateOpen} harnessName={selected.name}
              locations={locations} value={choice?.id ?? ''} onSelect={setLocationId} onStart={start}
              unavailable={projectComputer && (!projectComputer.online ? t('harness.selectedOffline', { computer: projectComputer.name })
                : !projectComputer.supportsHarness ? t('harness.selectedUnsupported', { computer: projectComputer.name, harness: selected.name }) : undefined)}
              onChooseProject={() => { setCreateOpen(false); setPicker('new'); }}
              occupied={occupied} onResume={(sessionId) => { setCreateOpen(false); open(sessionId); }}
              loading={list.isLoading || projects.isLoading} starting={starting} error={locationError} />
          </header>
          <div className="mb-5 grid gap-3">
            <ChoiceList label={t('harness.filter')} value={selected.id} onChange={selectHarness}
              options={harnesses.map((item) => ({ id: item.id, label: item.name, icon: <Terminal className="size-4" /> }))} />
            <HarnessProjectPicker open={picker !== null} onOpenChange={(next) => {
              if (!next && picker === 'new') setCreateOpen(true);
              setPicker(next ? 'list' : null);
            }} projects={catalog} computers={list.data?.nodes ?? []} value={picker === 'chat' ? current?.locationId : selectedProject?.id}
              loading={projects.isLoading || list.isLoading} error={projects.error?.message}
              browse={(nodeId, path) => api<DirectoryPage>(base + '/directories/browse', { method: 'POST', body: json({ nodeId, path }) })}
              selectDirectory={(nodeId, path) => api<HarnessProject>(base + '/directories/select', { method: 'POST', body: json({ nodeId, path }) })}
              onChange={(item) => {
                if (item && !catalog.some((p) => p.id === item.id)) {
                  queryClient.setQueryData<List>(['harness-sessions'], (data) => data && { ...data, directories: [...(data.directories ?? []), item] });
                  void list.refetch();
                  void projects.refetch();
                }
                if (picker !== 'chat' || !item || item.id !== current?.locationId) selectProject(item?.id ?? null);
                setLocationId(item?.id ?? '');
              }} />
          </div>
          {list.error && <p role="alert" className="mb-3 text-sm text-destructive">{list.error.message}</p>}
          {list.isLoading ? <p role="status" className="text-sm text-muted-foreground">{t('harness.loading')}</p>
            : visibleSessions.length ? <SessionList sessions={visibleSessions} selectedId={id} open={open} />
              : !list.error && <p className="px-2 py-6 text-sm text-muted-foreground">{t(selectedProject ? 'harness.noProjectSessions' : 'harness.noSessions', { harness: selected.name, project: selectedProject?.projectName })}</p>}
        </div>
      </div>
      <div className="harness-detail-pane min-h-0 min-w-0">
        {id ? <HarnessDetail key={id} id={id} summary={current} harnessName={chatHarness.name} back={() => open()} chooseProject={() => setPicker('chat')} />
          : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('harness.chooseSession')}</div>}
      </div>
    </div>
  </section>;
}

function HarnessDetail({ id, summary, harnessName, back, chooseProject }: { id: string; summary?: Session; harnessName: string; back: () => void; chooseProject: () => void }) {
  const { t } = useTranslation(['workspace', 'chat']);
  const queryClient = useQueryClient();
  const path = `${base}/${encodeURIComponent(id)}`;
  const draftKey = `dovun-harness-draft:${id}`;
  const pendingKey = `dovun-harness-pending:${id}`;
  const [draft, setDraft] = useState(() => load<string>(draftKey) ?? '');
  const [pending, setPending] = useState(() => load<Pending>(pendingKey));
  const pendingRef = useRef(pending);
  const [sending, setSending] = useState(false);
  const sendGate = useRef(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const [pin] = useState(createBottomPin);
  const [showLatest, setShowLatest] = useState(false);
  const detail = useQuery({ queryKey: ['harness-session', id], queryFn: () => api<Detail>(path + '?timeline=1'), refetchInterval: 4_000 });
  const stream = useHarnessStream(id);
  const snapshot = stream.snapshot ?? detail.data?.snapshot;
  const view = snapshot?.view;
  const currentTurn = view?.turn;
  const inProgress = currentTurn?.status === 'inProgress';
  const awaitingApproval = Boolean(view?.approvals.length);
  const enabled = !!detail.data?.online && !!snapshot && stream.ready && !stream.unavailable && detail.data.status !== 'failed';
  const actionsDisabled = !enabled || !!pending || sending;
  const startCommandId = detail.data?.startCommandId;
  const waitingForStart = !snapshot && detail.data?.status === 'creating';
  const commandId = pending?.command.commandId ?? (waitingForStart ? startCommandId : undefined);
  const tracked = useQuery({
    queryKey: ['harness-receipt', id, commandId], enabled: !!commandId,
    queryFn: () => api<Receipt>(`${path}/commands/${encodeURIComponent(commandId!)}`),
    refetchInterval: 2_000, retry: false,
  });

  function updateDraft(value: string) { setDraft(value); save(draftKey, value); }
  function updatePending(value: Pending | null) { pendingRef.current = value; setPending(value); save(pendingKey, value); }
  function observe(next: Receipt) {
    const active = pendingRef.current;
    const expected = active?.command.commandId ?? (waitingForStart ? startCommandId : undefined);
    if (next.commandId !== expected) return;
    setReceipt((previous) => {
      if (previous?.commandId === next.commandId && delivering(next) && previous.status !== 'queued') return previous;
      return next;
    });
    if (next.commandId === startCommandId && !delivering(next)) void detail.refetch();
    if (!active || delivering(next)) return;
    if (next.status === 'accepted' && 'text' in active.command) {
      const text = active.command.text;
      setDraft((value) => {
        if (value.trim() !== text) return value;
        save(draftKey, '');
        return '';
      });
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
  useLayoutEffect(followLatest, [followLatest, view]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current, thread = threadRef.current;
    if (!scroll || !thread) return;
    const observer = new ResizeObserver(followLatest);
    observer.observe(scroll);
    observer.observe(thread);
    return () => observer.disconnect();
  }, [followLatest]);

  function jumpToLatest() {
    pin.pin();
    setShowLatest(false);
    followLatest();
  }

  async function post(command: HarnessCommand) {
    if (sendGate.current) return;
    sendGate.current = true;
    setSending(true);
    setError(null);
    try { observe(await api<Receipt>(`${path}/commands`, { method: 'POST', body: json(command) })); }
    catch (failure) {
      setError(message(failure, t('harness.requestFailed')));
      if (failure instanceof ApiError && failure.status && failure.status < 500) updatePending(null);
    } finally { sendGate.current = false; setSending(false); }
  }
  function act(action: Omit<Extract<HarnessCommand, { operation: 'send' }>, 'commandId' | 'expectedEpoch'>
    | Omit<Extract<HarnessCommand, { operation: 'steer' }>, 'commandId' | 'expectedEpoch'>
    | Omit<Extract<HarnessCommand, { operation: 'interrupt' }>, 'commandId' | 'expectedEpoch'>
    | Omit<Extract<HarnessCommand, { operation: 'resolveApproval' }>, 'commandId' | 'expectedEpoch'>) {
    if (!enabled || !snapshot || pendingRef.current || sendGate.current) return;
    if ('text' in action) jumpToLatest();
    const command = { ...action, commandId: crypto.randomUUID(), expectedEpoch: snapshot.epoch };
    setReceipt(null);
    updatePending({ command });
    void post(command);
  }

  const session = detail.data ?? summary;
  const projectName = session?.projectName;
  const nodeName = session?.nodeName ?? t('harness.unknownComputer');
  const status = !session ? 'reconnecting' : !session.online ? 'offline' : enabled ? 'ready'
    : stream.unavailable ? 'unavailable' : session.status === 'ready' ? 'reconnecting' : session.status;
  const detailError = detail.error?.message ?? stream.unavailable ?? detail.data?.error;
  const approvalControls = view?.approvals.map((request) => <Surface as="section" tone="subtle" className="space-y-2.5 rounded-xl p-3" key={request.id} aria-label={t('harness.approval.' + request.kind)}>
    <h3 className="flex items-center gap-2 text-sm font-medium text-warning">
      <ShieldQuestion className="size-4" aria-hidden="true" />{t('harness.approval.' + request.kind)}
    </h3>
    {request.details && <p className="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{request.details}</p>}
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" className="min-h-11" variant="outline" disabled={actionsDisabled}
        onClick={() => act({ operation: 'resolveApproval', requestId: request.id, decision: 'decline' })}>{t('harness.decline')}</Button>
      {request.canAccept && <Button type="button" className="min-h-11" disabled={actionsDisabled}
        onClick={() => act({ operation: 'resolveApproval', requestId: request.id, decision: 'accept' })}>{t('harness.allow')}</Button>}
    </div>
  </Surface>);
  const visibleReceipt = receipt && (waitingForStart || receipt.commandId !== startCommandId) ? receipt : null;

  return <section className="dovun-assistant harness-thread flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    data-presentation="direct" aria-label={t('harness.detail')}>
    <header className="assistant-header flex items-center gap-2.5">
      <BackButton className="min-h-11 min-w-11" onClick={back}><span className="sr-only">{t('harness.back')}</span></BackButton>
      <Badge variant="secondary" className="size-8 p-0 text-muted-foreground"><Terminal className="size-4" aria-hidden="true" /></Badge>
      <div className="assistant-identity min-w-0 flex-1">
        <h2 title={session?.title ?? projectName}>{session?.title || projectName || t('harness.tab')}</h2>
        <p className="truncate text-xs text-muted-foreground" title={nodeName}>{harnessName}{session && ' · ' + nodeName}</p>
      </div>
      <span className="max-w-[34%] text-right text-xs leading-tight text-muted-foreground" role="status">{t('harness.status.' + status)}</span>
    </header>
    {detailError && <p role="alert" className="shrink-0 px-4 pt-2 text-sm text-destructive [overflow-wrap:anywhere]">{detailError}</p>}
    <div className="assistant-messages relative min-h-0 flex-1">
      <div data-chat-scroll ref={scrollRef} onScroll={(event) => {
        pin.onScroll(event.currentTarget);
        setShowLatest(!pin.isPinned());
      }}
        className="glass-scrollbar h-full min-w-0 overflow-y-auto overscroll-contain">
        <div ref={threadRef} className="assistant-thread flex min-w-0 flex-col gap-4">
          {view && (view.messages.length || view.turn) ? <HarnessTimeline view={view} name={harnessName} liveMessageId={stream.liveMessageId}
            approvalControls={approvalControls} /> : !detailError && <div className="dovun-assistant-welcome">
            <h3>{t('harness.empty', { harness: harnessName })}</h3>
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
      {(visibleReceipt || error || pending && !sending && tracked.error) && (
        <div className="mb-2 flex flex-wrap items-center gap-2 px-2 text-xs text-muted-foreground">
          {visibleReceipt && <p role="status" className="[overflow-wrap:anywhere]">{t('harness.receipt.' + visibleReceipt.status)}{visibleReceipt.error && ' · ' + visibleReceipt.error}</p>}
          {error && <p role="alert" className="text-destructive [overflow-wrap:anywhere]">{error}</p>}
          {pending && !sending && tracked.error && <Button size="sm" variant="outline" type="button" onClick={() => void post(pending.command)}>{t('harness.retry')}</Button>}
        </div>
      )}
      <ChatComposer input={draft} onChange={updateDraft} maxLength={HARNESS_TEXT_LIMIT} busy={inProgress}
        actionsDisabled={actionsDisabled} allowSendWhileBusy listenForAssistantFocus={false}
        labels={{ input: t('harness.draft'), send: t(inProgress ? 'harness.steer' : 'harness.send'), stop: t('harness.interrupt') }}
        placeholder={inProgress ? t('harness.steer') : t('harness.placeholder', { harness: harnessName })}
        model={projectName && <ChatProjectButton name={projectName} open={chooseProject} />}
        onSend={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text) return;
          if (inProgress) act({ operation: 'steer', turnId: currentTurn.id, text });
          else act({ operation: 'send', text });
        }}
        onStop={inProgress ? () => act({ operation: 'interrupt', turnId: currentTurn.id }) : undefined} />
    </div>
  </section>;
}
