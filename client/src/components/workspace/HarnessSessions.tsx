import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '@/lib/api.js';
import { json } from '@/lib/platform.js';
import { Button } from '@/components/ui/button.js';
import { NativeSelect } from '@/components/ui/native-select.js';
import { Surface } from '@/components/ui/surface.js';
import { Textarea } from '@/components/ui/textarea.js';
import { applyHarnessEvent, HARNESS_TEXT_LIMIT, type HarnessCommand, type HarnessEvent, type HarnessSnapshot } from '../../../../server/src/node-agent/harness-protocol.js';

const base = '/api/v1/harness-sessions';
type Session = {
  id: string; nodeId: string; nodeName: string | null; online: boolean; projectName: string;
  threadId: string | null; epoch: number; status: string; error: string | null; startCommandId: string;
};
type Detail = Session & { snapshot: HarnessSnapshot | null; current: boolean };
type List = { nodes: Array<{ id: string; name: string; online: boolean; supportsHarness: boolean }>; sessions: Session[] };
type Project = { id: string; name: string; locations: Array<{ id: string; nodeId: string; status: string }> };
type Receipt = { commandId: string; status: string; error: string | null };
type Pending = { command: HarnessCommand };

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

function useHarnessStream(id: string) {
  const snapshotKey = `dovun-harness-snapshot:${id}`;
  const [snapshot, setSnapshot] = useState(() => load<HarnessSnapshot>(snapshotKey));
  const [ready, setReady] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const current = useRef(snapshot);
  useEffect(() => {
    let source: EventSource;
    function connect(reset = false) {
      source?.close();
      setReady(false);
      const view = current.current;
      const after = !reset && view ? `?after=${view.epoch}:${view.seq}` : '';
      source = new EventSource(`${base}/${encodeURIComponent(id)}/events${after}`);
      source.onerror = () => setReady(false);
      source.onmessage = (event) => {
        let data: HarnessSnapshot | { type: 'event'; epoch: number; seq: number; event: HarnessEvent } | { type: 'receipt'; receipt: Receipt } | { type: 'unavailable'; epoch: number; error: string } | { type: 'caughtUp'; epoch: number; seq: number };
        try { data = JSON.parse(event.data); } catch { connect(true); return; }
        const previous = current.current;
        if (data.type === 'receipt') { setReceipt(data.receipt); return; }
        if (data.type === 'unavailable') {
          if (!previous || data.epoch >= previous.epoch) { setUnavailable(data.error); setReady(false); }
          return;
        }
        if (data.type === 'caughtUp') {
          if (previous?.epoch === data.epoch && previous.seq === data.seq) setReady(true);
          return;
        }
        if (data.type === 'snapshot') {
          if (previous && (data.epoch < previous.epoch || data.epoch === previous.epoch && data.seq < previous.seq)) return;
          current.current = data;
          setSnapshot(data);
          setUnavailable(null);
          setReady(true);
          return;
        }
        if (previous && (data.epoch < previous.epoch || data.epoch === previous.epoch && data.seq <= previous.seq)) return;
        if (!previous || previous.epoch !== data.epoch || data.seq !== previous.seq + 1) { connect(true); return; }
        const next = { ...previous, seq: data.seq, view: applyHarnessEvent(previous.view, data.event) };
        current.current = next;
        setSnapshot(next);
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
  return { snapshot, ready, receipt, unavailable };
}

export function HarnessSessions({ id, open }: { id?: string; open: (id?: string) => void }) {
  const { t } = useTranslation('workspace');
  const list = useQuery({ queryKey: ['harness-sessions'], queryFn: () => api<List>(base), refetchInterval: 5000, enabled: !id });
  const projects = useQuery({ queryKey: ['harness-projects'], queryFn: () => api<Project[]>('/api/projects'), enabled: !id });
  const [locationId, setLocation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const startGate = useRef(false);
  const nodes = new Map(list.data?.nodes.map((node) => [node.id, node]));
  const busyNodes = new Set(list.data?.sessions.filter((session) => session.status !== 'failed').map((session) => session.nodeId));
  const locations = projects.data?.flatMap((project) => project.locations.flatMap((location) => {
    const node = nodes.get(location.nodeId);
    return location.status === 'verified' && node?.supportsHarness && node.online && !busyNodes.has(node.id)
      ? [{ ...location, label: `${project.name} · ${node.name}` }] : [];
  })) ?? [];
  const choice = locations.find((location) => location.id === locationId);

  async function start() {
    if (!choice || startGate.current) return;
    startGate.current = true;
    setStarting(true);
    setError(null);
    const key = 'dovun-harness-create';
    const saved = load<{ nodeId: string; locationId: string; commandId: string }>(key);
    const command = saved?.locationId === choice.id && saved.nodeId === choice.nodeId ? saved
      : { nodeId: choice.nodeId, locationId: choice.id, commandId: crypto.randomUUID() };
    save(key, command);
    try {
      const created = await api<{ sessionId: string }>(base, { method: 'POST', body: json(command) });
      save(key, null);
      open(created.sessionId);
    } catch (failure) {
      setError(message(failure, t('harness.requestFailed')));
      void list.refetch();
    } finally { startGate.current = false; setStarting(false); }
  }
  if (id) return <HarnessDetail key={id} id={id} back={() => { setError(null); open(); }} />;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 space-y-1 text-sm">
        <span className="block">{t('harness.project')}</span>
        <NativeSelect className="w-full" value={choice?.id ?? ''} onChange={(event) => setLocation(event.target.value)}>
          <option value="">{t('harness.select')}</option>
          {locations.map((location) => <option key={location.id} value={location.id}>{location.label}</option>)}
        </NativeSelect>
      </label>
      <Button className="min-h-11" disabled={!choice || starting} onClick={() => void start()}>{t('harness.start')}</Button>
    </div>
    {(error || list.error || projects.error) && <p role="alert" className="text-sm text-destructive">{error ?? list.error?.message ?? projects.error?.message}</p>}
    {list.data && !locations.length && !list.data.sessions.length && <p className="text-sm text-muted-foreground">{t('harness.noComputer')}</p>}
    {!!list.data?.sessions.length && <Surface tone="sheet" className="workspace-rows">
      {list.data.sessions.map((session) => <Button type="button" variant="row" size="bare" key={session.id}
        className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left" onClick={() => open(session.id)}>
        <span className="min-w-0 break-words">{session.projectName}</span>
        <span className="text-xs text-muted-foreground">{session.nodeName ?? t('harness.unknownComputer')} · {t(`harness.status.${session.online ? session.status : 'offline'}`)}</span>
      </Button>)}
    </Surface>}
  </div>;
}

function HarnessDetail({ id, back }: { id: string; back: () => void }) {
  const { t } = useTranslation('workspace');
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
  const detail = useQuery({ queryKey: ['harness-session', id], queryFn: () => api<Detail>(path), refetchInterval: 4_000 });
  const stream = useHarnessStream(id);
  const snapshot = stream.snapshot ?? detail.data?.snapshot;
  const view = snapshot?.view;
  const currentTurn = view?.turn;
  const inProgress = currentTurn?.status === 'inProgress';
  const enabled = !!detail.data?.online && !!snapshot && stream.ready && !stream.unavailable && detail.data.status !== 'failed';
  const commandId = pending?.command.commandId ?? detail.data?.startCommandId;
  const tracked = useQuery({
    queryKey: ['harness-receipt', id, commandId], enabled: !!commandId && (!!pending || detail.data?.status === 'creating'),
    queryFn: () => api<Receipt>(`${path}/commands/${encodeURIComponent(commandId!)}`),
    refetchInterval: 2_000, retry: false,
  });

  function updateDraft(value: string) { setDraft(value); save(draftKey, value); }
  function updatePending(value: Pending | null) { pendingRef.current = value; setPending(value); save(pendingKey, value); }
  function observe(next: Receipt) {
    const active = pendingRef.current;
    if (active?.command.commandId !== next.commandId && detail.data?.startCommandId !== next.commandId) return;
    setReceipt(next);
    if (next.commandId === detail.data?.startCommandId && next.status !== 'queued' && next.status !== 'dispatched') void detail.refetch();
    if (!active || active.command.commandId !== next.commandId || next.status === 'queued' || next.status === 'dispatched') return;
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
    if (!enabled || !snapshot || pendingRef.current) return;
    const command = { ...action, commandId: crypto.randomUUID(), expectedEpoch: snapshot.epoch };
    updatePending({ command });
    void post(command);
  }

  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button variant="outline" type="button" onClick={back}>{t('harness.back')}</Button>
      <p role="status" className="break-words text-sm text-muted-foreground">{detail.data?.projectName} · {t(`harness.status.${detail.data ? !detail.data.online ? 'offline' : enabled ? 'ready' : detail.data.status === 'ready' ? 'reconnecting' : detail.data.status : 'reconnecting'}`)}</p>
    </div>
    {(detail.error || detail.data?.error || stream.unavailable) && <p role="alert" className="text-sm text-destructive break-words">{detail.error?.message ?? stream.unavailable ?? detail.data?.error}</p>}
    <Surface tone="sheet" className="space-y-3 p-3 sm:p-4">
      <ol aria-label={t('harness.conversation')} className="space-y-4">
        {view?.messages.map((message) => <li key={message.id} className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t(`harness.role.${message.role}`)}</p>
          <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{message.text}</p>
        </li>)}
      </ol>
      {!view?.messages.length && <p className="text-sm text-muted-foreground">{t('harness.empty')}</p>}
      {currentTurn && <p role="status" className="text-xs text-muted-foreground">{t(`harness.turn.${currentTurn.status}`)}{currentTurn.error && ` · ${currentTurn.error}`}</p>}
      {view?.approvals.map((request) => <div key={request.id} className="space-y-2 border-t pt-3">
        <h2 className="text-sm font-medium">{t(`harness.approval.${request.kind}`)}</h2>
        {request.details && <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{request.details}</p>}
        <div className="flex flex-wrap gap-2">
          {request.canAccept && <Button className="min-h-11" disabled={!enabled || !!pending} onClick={() => act({ operation: 'resolveApproval', requestId: request.id, decision: 'accept' })}>{t('harness.allow')}</Button>}
          <Button className="min-h-11" variant="outline" disabled={!enabled || !!pending} onClick={() => act({ operation: 'resolveApproval', requestId: request.id, decision: 'decline' })}>{t('harness.decline')}</Button>
        </div>
      </div>)}
    </Surface>
    <form className="space-y-2" onSubmit={(event) => {
      event.preventDefault();
      if (!draft.trim()) return;
      if (inProgress) act({ operation: 'steer', turnId: currentTurn.id, text: draft.trim() });
      else act({ operation: 'send', text: draft.trim() });
    }}>
      <Textarea aria-label={t('harness.draft')} placeholder={t('harness.draft')} value={draft} maxLength={HARNESS_TEXT_LIMIT} onChange={(event) => updateDraft(event.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" type="submit" disabled={!enabled || !draft.trim() || !!pending}>{t(inProgress ? 'harness.steer' : 'harness.send')}</Button>
        {inProgress && <Button className="min-h-11" type="button" variant="outline" disabled={!enabled || !!pending} onClick={() => act({ operation: 'interrupt', turnId: currentTurn.id })}>{t('harness.interrupt')}</Button>}
        {pending && !sending && tracked.error && <Button className="min-h-11" type="button" variant="outline" onClick={() => void post(pending.command)}>{t('harness.retry')}</Button>}
      </div>
    </form>
    {receipt && <p role="status" className="text-sm text-muted-foreground">{t(`harness.receipt.${receipt.status}`)}{receipt.error && ` · ${receipt.error}`}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
