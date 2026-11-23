import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, CircleAlert, FileText, ImageIcon, ListChecks, LoaderCircle, Search, Terminal, Wrench } from 'lucide-react';
import { createBottomPin } from '@/components/chat/bottom-pin.js';
import { MarkdownView } from '@/components/shared/MarkdownView.js';
import { SvgBlock } from '@/components/shared/SvgBlock.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { Surface } from '@/components/ui/surface.js';
import type { HarnessArtifact, HarnessMessage, HarnessTool, HarnessTurn, HarnessView } from '../../../../server/src/node-agent/harness-protocol.js';
import './harness-timeline.css';

type Row = { kind: 'message'; item: HarnessMessage } | { kind: 'tool'; item: HarnessTool };
type Part = { kind: 'user'; message: HarnessMessage } | { kind: 'reply'; message: HarnessMessage } | { kind: 'process'; rows: Row[] };
type Turn = { id: string; rows: Row[]; status?: HarnessTurn; artifacts: HarnessArtifact[] };

function groupTurns(view: HarnessView) {
  const turns = new Map<string, Turn>();
  const rows: Row[] = [
    ...view.messages.map((item, index) => ({ kind: 'message' as const, item: item.order === undefined ? { ...item, order: index + 1 } : item })),
    ...(view.tools ?? []).map((item) => ({ kind: 'tool' as const, item })),
  ];
  const visible = new Set(view.messages.map((item) => item.turnId));
  if (view.turn) visible.add(view.turn.id);
  for (const row of rows.sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0))) {
    const id = row.item.turnId;
    if (!visible.has(id)) continue;
    const turn = turns.get(id) ?? { id, rows: [], artifacts: [] };
    turn.rows.push(row);
    turns.set(id, turn);
  }
  for (const status of view.turns ?? []) {
    const turn = turns.get(status.id);
    if (turn) turn.status = status;
  }
  if (view.turn) {
    const turn = turns.get(view.turn.id) ?? { id: view.turn.id, rows: [], artifacts: [] };
    turn.status = view.turn;
    turns.set(turn.id, turn);
  }
  for (const artifact of view.artifacts ?? []) {
    const turn = turns.get(artifact.turnId);
    if (turn?.rows.some((row) => row.kind === 'message' && row.item.id === artifact.messageId)) turn.artifacts.push(artifact);
  }
  return [...turns.values()];
}

// Insert older/live-only rows before the next shared anchor, without duplicating a turn or item.
function mergeOrdered<T>(history: T[], live: T[], key: (value: T) => string, merge: (history: T, live: T) => T) {
  const ordered = new Map(history.map((value) => [key(value), value]));
  const before = new Map<string, T[]>();
  let unanchored: T[] = [];
  for (const value of live) {
    const id = key(value);
    const previous = ordered.get(id);
    if (previous === undefined) { unanchored.push(value); continue; }
    if (unanchored.length) { before.set(id, unanchored); unanchored = []; }
    ordered.set(id, merge(previous, value));
  }
  return [...[...ordered].flatMap(([id, value]) => [...(before.get(id) ?? []), value]), ...unanchored];
}

function parts(rows: Row[]) {
  const answers = rows.flatMap((row) => row.kind === 'message' && row.item.role === 'assistant' && row.item.phase !== 'commentary' ? [row.item] : []);
  const final = answers.some((item) => item.phase === 'final_answer') ? undefined : answers[answers.length - 1]?.id;
  const result: Part[] = [];
  for (const row of rows) {
    if (row.kind === 'message') {
      if (row.item.role === 'user') { result.push({ kind: 'user', message: row.item }); continue; }
      if (!row.item.text) continue;
      if (row.item.phase === 'final_answer' || row.item.id === final) { result.push({ kind: 'reply', message: row.item }); continue; }
    }
    const previous = result[result.length - 1];
    if (previous?.kind === 'process') previous.rows.push(row);
    else result.push({ kind: 'process', rows: [row] });
  }
  return result;
}

const visualizationDirective = '\uE200visualize\uE202';

function harnessReplyText(content: string) {
  const text = content.replace(/\uE200visualize\uE202[^\uE200\uE201\r\n]*\uE201/g, '');
  const start = text.lastIndexOf('\uE200');
  if (start === -1) return text;
  const tail = text.slice(start);
  // A streaming delta can stop inside a directive. Keep it out of the visible reply as well.
  if (visualizationDirective.startsWith(tail) || (tail.startsWith(visualizationDirective) && !/[\uE201\r\n]/.test(tail))) return text.slice(0, start);
  return text;
}

function HarnessMarkdown({ message, active, liveMessageId }: { message: HarnessMessage; active: boolean; liveMessageId?: string }) {
  const { t } = useTranslation('workspace');
  const streaming = active && message.streaming !== false;
  return <div className={streaming ? 'streaming-caret' : undefined}>
    <MarkdownView content={harnessReplyText(message.text)} streaming={streaming} revealAdditions={message.id === liveMessageId} responsiveTables diagrams
      components={{
        img: ({ alt }) => alt ? <span>{alt}</span> : null,
        a: ({ href, children }) => !href || (/\.svg(?:$|#)/i.test(href) && !/^https?:\/\//i.test(href))
          ? <span title={t('harness.artifact.localFile')}>{children}</span>
          : <a href={href} target="_blank" rel="noreferrer" className="text-brand-link underline underline-offset-2">{children}</a>,
      }} />
  </div>;
}

function ToolOutput({ result, label }: { result: string; label: string }) {
  const scroll = useRef<HTMLPreElement>(null);
  const [pin] = useState(createBottomPin);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const top = pin.onResize(element);
    if (top !== null) element.scrollTop = top;
  }, [pin, result]);
  return <pre ref={scroll} aria-label={label} tabIndex={0} onScroll={(event) => pin.onScroll(event.currentTarget)}
    className="harness-tool-output glass-scrollbar whitespace-pre-wrap [overflow-wrap:anywhere]">{result}</pre>;
}

const toolIcons = { command: Terminal, fileChange: FileText, webSearch: Search, tool: Wrench, image: ImageIcon };

function ToolRow({ tool }: { tool: HarnessTool }) {
  const { t } = useTranslation('workspace');
  const Icon = toolIcons[tool.kind];
  const running = tool.status === 'running';
  const status = t('harness.toolStatus.' + tool.status);
  const [choice, setChoice] = useState<boolean>();
  const open = choice ?? (running && tool.kind === 'command');
  const detailed = tool.kind === 'command' || Boolean(tool.files?.length || tool.output);
  const summary = <>
    <Icon className="size-4 shrink-0" aria-hidden="true" />
    <span className="min-w-0 flex-1">
      <span>{t('harness.tool.' + tool.kind)}</span>
      {tool.title && (tool.kind !== 'command' || !open) && <span className="harness-tool-title">{tool.title}</span>}
    </span>
    <span className="shrink-0 text-xs" data-tool-status={tool.status}>{status}</span>
  </>;
  return <li data-harness-tool={tool.id}>
    {detailed ? <Disclosure open={open} onToggle={(event) => {
      if (event.currentTarget.open !== open) setChoice(event.currentTarget.open);
    }}>
      <DisclosureTrigger className="harness-tool-trigger">{summary}<ChevronRight className={open ? 'size-3.5 rotate-90' : 'size-3.5'} aria-hidden="true" /></DisclosureTrigger>
      <Surface tone="subtle" className="harness-tool-detail">
        {tool.kind === 'command' && tool.title && <code className="block whitespace-pre-wrap [overflow-wrap:anywhere]">{tool.title}</code>}
        {tool.files?.length ? <ul className="space-y-1">{tool.files.map((file, index) => {
          const diff = tool.diffs?.find((item) => item.path === file);
          return <li key={file + index}>
            {!diff ? <code className="[overflow-wrap:anywhere]">{file}</code> : <Disclosure>
              <DisclosureTrigger className="flex flex-wrap items-center gap-2 text-left">
                <code className="min-w-0 [overflow-wrap:anywhere]">{file}</code>
                <span className="text-xs tabular-nums text-muted-foreground">+{diff.added} / −{diff.removed}</span>
              </DisclosureTrigger>
              <ToolOutput result={diff.patch} label={t('harness.files.diff')} />
              {diff.truncated && <p className="text-xs text-muted-foreground">{t('harness.files.diffTruncated')}</p>}
            </Disclosure>}
          </li>;
        })}</ul> : null}
        {tool.output ? <>
          {tool.truncated && <p className="text-muted-foreground">{t('harness.tool.tail')}</p>}
          <ToolOutput result={tool.output} label={t('harness.tool.output')} />
        </> : tool.kind === 'command' && <p className="text-muted-foreground">{t(running ? 'harness.tool.waitingOutput' : 'harness.tool.noOutput')}</p>}
        {tool.exitCode !== undefined && <p className="text-muted-foreground">{t('harness.tool.exitCode', { code: tool.exitCode })}</p>}
      </Surface>
    </Disclosure> : <div className="harness-tool-trigger">{summary}</div>}
  </li>;
}

function Process({ rows, active, liveMessageId }: { rows: Row[]; active: boolean; liveMessageId?: string }) {
  const { t } = useTranslation('workspace');
  const [choice, setChoice] = useState<boolean>();
  const open = choice ?? active;
  const tools = rows.filter((row) => row.kind === 'tool').length;
  return <Disclosure className="assistant-process" data-harness-process open={open} onToggle={(event) => {
    if (event.currentTarget.open !== open) setChoice(event.currentTarget.open);
  }}>
    <DisclosureTrigger className="assistant-process-trigger">
      {active ? <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        : <ListChecks className="size-4 shrink-0" aria-hidden="true" />}
      <span className="assistant-process-title">{t('harness.activity')}</span>
      {!!tools && <span className="text-xs text-muted-foreground">{t('harness.tool.count', { count: tools })}</span>}
      <ChevronRight className={'assistant-process-chevron ' + (open ? 'rotate-90' : '')} aria-hidden="true" />
    </DisclosureTrigger>
    <ol className="harness-process-items assistant-process-body">
      {rows.map((row) => row.kind === 'tool' ? <ToolRow key={row.item.id} tool={row.item} />
        : <li key={row.item.id}><HarnessMarkdown message={row.item} active={active} liveMessageId={liveMessageId} /></li>)}
    </ol>
  </Disclosure>;
}

function ArtifactCard({ artifact }: { artifact: HarnessArtifact }) {
  const { t } = useTranslation('workspace');
  const [open, setOpen] = useState(false);
  return <Disclosure tone="subtle" className="harness-artifact" data-harness-artifact={artifact.id} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <DisclosureTrigger className="harness-tool-trigger">
      <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{artifact.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{t('harness.artifact.preview')}</span>
      <ChevronRight className={open ? 'size-3.5 rotate-90' : 'size-3.5'} aria-hidden="true" />
    </DisclosureTrigger>
    {open && <div className="px-3"><SvgBlock source={artifact.source} /></div>}
  </Disclosure>;
}

export function HarnessTimeline({ view, history, name, liveMessageId, approvalControls, turnControls }: {
  view: HarnessView; history?: HarnessView[]; name: string; liveMessageId?: string; approvalControls?: ReactNode;
  turnControls?: (turn: HarnessTurn, firstMessage?: HarnessMessage) => ReactNode;
}) {
  const { t } = useTranslation('workspace');
  const past = useMemo(() => (history ?? []).flatMap(groupTurns), [history]);
  const turns = mergeOrdered(past, groupTurns(view), (turn) => turn.id, (older, current) => ({
    ...current, status: current.status ?? older.status,
    rows: mergeOrdered(older.rows, current.rows, (row) => row.item.id, (_older, newer) => newer),
    artifacts: mergeOrdered(older.artifacts, current.artifacts, (artifact) => artifact.id, (_older, newer) => newer),
  }));
  return <ol aria-label={t('harness.conversation')} className="harness-conversation flex min-w-0 flex-col gap-5">
    {turns.map((turn) => {
      const active = turn.status?.status === 'inProgress';
      const content = parts(turn.rows);
      const firstAssistant = content.findIndex((part) => part.kind !== 'user');
      const byline = <div className="harness-turn-byline" data-role="assistant">
        <Terminal className="size-3.5" aria-hidden="true" /><span>{name}</span>
        {turn.status && <span role={active || turn.id === view.turn?.id ? 'status' : undefined}>
          {active && <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {t('harness.turn.' + turn.status.status)}
        </span>}
      </div>;
      return <li key={turn.id} data-harness-turn={turn.id} className="flex min-w-0 flex-col gap-3">
        {content.map((part, index) => {
          if (part.kind === 'user') return <div className="assistant-message assistant-user-message ml-auto" key={part.message.id} data-role="user">
            <div className="assistant-user-bubble whitespace-pre-wrap [overflow-wrap:anywhere]">{part.message.text}
              {part.message.attachmentNames?.map((file, position) => <span key={position} className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <FileText className="size-3.5" />{file}
              </span>)}
            </div>
          </div>;
          const key = part.kind === 'reply' ? part.message.id : part.rows[0].item.id;
          return <div className="assistant-message min-w-0" key={key} data-role="assistant">
            {index === firstAssistant && byline}
            {part.kind === 'process' ? <Process rows={part.rows} active={active} liveMessageId={liveMessageId} />
              : <HarnessMarkdown message={part.message} active={active} liveMessageId={liveMessageId} />}
          </div>;
        })}
        {firstAssistant < 0 && turn.status && <div className="assistant-message">{byline}</div>}
        {turn.status?.error && <p role="status" className="flex items-center gap-2 text-xs text-destructive"><CircleAlert className="size-4" aria-hidden="true" />{turn.status.error}</p>}
        {turn.artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
        {turn.id === view.turn?.id && approvalControls}
        {turn.status && turnControls?.(turn.status, content.find((part) => part.kind === 'user')?.message)}
      </li>;
    })}
  </ol>;
}
