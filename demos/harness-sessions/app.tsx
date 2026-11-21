import { createInstance } from 'i18next';
import {
  ArrowDown, Braces, Check, ChevronRight, CircleAlert, FileCode2, ListChecks,
  LoaderCircle, MessageSquare, ShieldQuestion, Sparkles, Terminal,
} from 'lucide-react';
import { ThemeProvider } from 'next-themes';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { ChatComposer } from '@/components/chat/ChatComposer.js';
import { createBottomPin } from '@/components/chat/bottom-pin.js';
import { MarkdownView } from '@/components/shared/MarkdownView.js';
import { BrandMark } from '@/components/layout/BrandMark.js';
import { ThemeToggle } from '@/components/layout/ThemeToggle.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { ChoiceList } from '@/components/ui/choice-list.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { BackButton } from '@/components/ui/nav-buttons.js';
import { Surface } from '@/components/ui/surface.js';
import { HarnessStartDialog } from '@/components/workspace/HarnessStartDialog.js';
import { ChatProjectButton, HarnessProjectPicker, type HarnessProject } from '@/components/workspace/HarnessProjectPicker.js';
import { demoComputer, demoDirectory, demoProject, initialProjects } from './directories.js';
import chatMessages from '@/i18n/locales/zh-CN/chat.json';
import settingsMessages from '@/i18n/locales/zh-CN/settings.json';
import workspaceMessages from '@/i18n/locales/zh-CN/workspace.json';
import {
  exampleConversations, harnesses, streamExample, streamExampleId,
  type Activity, type Approval, type Conversation, type HarnessId, type StreamMessage, type TextMessage,
} from './fixtures.js';
import { nextFrameAt } from './stream.js';
import { StreamReply } from './StreamReply.js';
import './preview.css';

const storageKey = 'dovun.harness-sessions.preview.v1';
const icons = { codex: Terminal, claude: Sparkles, zcode: Braces };
const isHarness = (value: unknown): value is HarnessId => harnesses.some((harness) => harness.id === value);
const harnessName = (id: HarnessId) => harnesses.find((harness) => harness.id === id)!.name;
const desktop = window.matchMedia('(min-width: 741px)');
function subscribeDesktop(listener: () => void) {
  desktop.addEventListener('change', listener);
  return () => desktop.removeEventListener('change', listener);
}
const isDesktop = () => desktop.matches;

type Route = { harness: HarnessId; sessionId: string | null; project: string | null };
type PreviewData = {
  conversations: Conversation[];
  drafts: Record<string, string>;
  projects: HarnessProject[];
};

function readData(): PreviewData {
  try {
    const value: PreviewData | null = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (value && Array.isArray(value.conversations) && value.drafts) {
      const conversations = value.conversations.some((item) => item.id === streamExampleId)
        ? value.conversations : [streamExample(), ...value.conversations];
      return { conversations, drafts: value.drafts, projects: Array.isArray(value.projects) ? value.projects : [] };
    }
  } catch { /* A browser may not grant storage in private mode. */ }
  return { conversations: exampleConversations(), drafts: {}, projects: [] };
}

function readRoute(): Route {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const harness = hash.get('harness');
  return { harness: isHarness(harness) ? harness : 'codex', sessionId: hash.get('session'), project: hash.get('project') };
}

function isBusy(conversation: Conversation, now: number) {
  const last = conversation.messages.at(-1);
  return last?.kind === 'stream' && nextFrameAt(last, conversation.harness, now) !== undefined;
}

function waitingForApproval(conversation: Conversation) {
  return conversation.messages.some((message) => message.kind === 'approval' && !message.decision);
}

function groupName(timestamp: number, now: number) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (timestamp >= midnight.getTime()) return '今天';
  midnight.setDate(midnight.getDate() - 1);
  return timestamp >= midnight.getTime() ? '昨天' : '更早';
}

const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

function HarnessIcon({ harness, className = 'size-4' }: { harness: HarnessId; className?: string }) {
  const Icon = icons[harness];
  return <Icon className={className} aria-hidden="true" />;
}

function ConversationList({ conversations, active, now, open }: {
  conversations: Conversation[]; active?: string; now: number; open: (id: string) => void;
}) {
  const groups = ['今天', '昨天', '更早'].map((group) => ({
    group, items: conversations.filter((conversation) => groupName(conversation.updatedAt, now) === group),
  })).filter(({ items }) => items.length > 0);
  if (!groups.length) return <p className="px-2 py-6 text-sm text-muted-foreground">还没有会话</p>;

  return <Surface tone="sheet" className="workspace-rows">
    {groups.map(({ group, items }) => <section key={group} aria-label={group} className="harness-session-group">
      <h2 className="px-2 pt-3.5 pb-1 text-xs font-medium text-muted-foreground">{group}</h2>
      {items.map((session) => {
        const pending = waitingForApproval(session);
        const busy = isBusy(session, now);
        return <Button type="button" key={session.id} variant="row" size="bare"
          className="workspace-row flex min-h-[55px] w-full items-center gap-2.5 px-2 py-2 text-left"
          aria-current={active === session.id ? 'page' : undefined} data-selected={active === session.id || undefined}
          onClick={() => open(session.id)}>
          {busy ? <LoaderCircle className="size-4 shrink-0 animate-spin text-brand-link motion-reduce:animate-none" aria-hidden="true" />
            : pending ? <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
              : <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{session.title}</span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">{session.project}</span>
              {pending && <span className="shrink-0 text-warning">待确认</span>}
              {busy && <span className="shrink-0 text-brand-link">生成中</span>}
            </span>
          </span>
          <time className="shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={new Date(session.updatedAt).toISOString()}>{clock.format(session.updatedAt)}</time>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Button>;
      })}
    </section>)}
  </Surface>;
}

function ToolActivity({ message }: { message: Activity }) {
  return <Disclosure className="assistant-process group">
    <DisclosureTrigger className="assistant-process-trigger">
      <ListChecks className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="assistant-process-title">工具过程</span>
      <span className="text-xs text-muted-foreground">{message.steps.length} 步</span>
      <ChevronRight className="assistant-process-chevron group-open:rotate-90" aria-hidden="true" />
    </DisclosureTrigger>
    <div className="assistant-process-body">
      <ol className="assistant-process-steps">{message.steps.map((step) => <li className="assistant-process-step" key={step.action}>
        <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
        <span className="min-w-0 text-xs">
          <span className="block text-foreground">{step.action}</span>
          <code className="font-mono break-all">{step.detail}</code>
        </span>
      </li>)}</ol>
      {message.change && <Surface tone="subtle" className="mt-2 overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-2.5 py-1.5"><FileCode2 className="size-3.5" aria-hidden="true" />{message.change.path}</div>
        <code className="block bg-destructive/10 px-2.5 py-1 font-mono break-all text-destructive">− {message.change.removed}</code>
        <code className="block bg-success-bg px-2.5 py-1 font-mono break-all text-success">+ {message.change.added}</code>
      </Surface>}
    </div>
  </Disclosure>;
}

function ApprovalCard({ approval, decide }: { approval: Approval; decide: (decision: 'accepted' | 'declined') => void }) {
  return <Surface as="section" tone="subtle" className="space-y-2 rounded-xl p-3" aria-label="权限请求">
    <div className="flex items-center gap-2 text-warning"><ShieldQuestion className="size-4" aria-hidden="true" /><strong className="text-sm font-semibold">运行命令</strong></div>
    <code className="block font-mono text-xs break-all">{approval.command}</code>
    {approval.decision ? <p role="status" className="text-xs text-muted-foreground">{approval.decision === 'accepted' ? '已允许一次' : '已拒绝'}</p> :
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" className="min-h-11" onClick={() => decide('declined')}>拒绝</Button>
        <Button type="button" className="min-h-11" onClick={() => decide('accepted')}>允许一次</Button>
      </div>}
  </Surface>;
}

function ChatView({ conversation, draft, now, back, chooseProject, write, send, stop, replay, approve }: {
  conversation: Conversation; draft: string; now: number;
  back: () => void; chooseProject: () => void; write: (draft: string) => void;
  send: () => void; stop: () => void; replay: (id: string) => void; approve: (id: string, decision: 'accepted' | 'declined') => void;
}) {
  const timeline = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLOListElement>(null);
  const [pin] = useState(() => createBottomPin());
  const [detached, setDetached] = useState(false);
  const busy = isBusy(conversation, now);
  const approvalPending = waitingForApproval(conversation);
  const name = harnessName(conversation.harness);
  const latest = conversation.messages.at(-1);
  const hasMessages = conversation.messages.length > 0;
  const followStream = useCallback(() => {
    const pane = timeline.current;
    if (!pane) return;
    const top = pin.onResize(pane);
    if (top !== null && pane.scrollTop !== top) pane.scrollTop = top;
  }, [pin]);

  useLayoutEffect(followStream, [followStream, conversation.messages, now]);
  useLayoutEffect(() => {
    const pane = timeline.current;
    if (!pane || !thread.current) return;
    const observer = new ResizeObserver(followStream);
    observer.observe(pane); observer.observe(thread.current);
    return () => observer.disconnect();
  }, [followStream, hasMessages]);

  function followLatest() {
    pin.pin(); setDetached(false);
    if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
  }

  return <>
    <header className="assistant-header flex items-center gap-2.5">
      <BackButton className="harness-back" onClick={back}><span className="sr-only">返回会话列表</span></BackButton>
      <Badge variant="secondary" className="size-8 p-0 text-muted-foreground">
        <HarnessIcon harness={conversation.harness} />
      </Badge>
      <div className="assistant-identity min-w-0 flex-1">
        <h2>{conversation.title}</h2>
        <p className="truncate text-xs text-muted-foreground">{name} · {conversation.project}{conversation.id === streamExampleId && ' · 流式演示'}</p>
      </div>
      <div className="harness-theme harness-chat-theme"><ThemeToggle /></div>
    </header>
    <div className="assistant-messages relative min-h-0 flex-1">
      <div data-chat-scroll className="glass-scrollbar h-full overflow-y-auto overscroll-contain" ref={timeline}
        onScroll={(event) => {
          pin.onScroll(event.currentTarget); setDetached(!pin.isPinned());
        }}>
        {conversation.messages.length ? <ol ref={thread} className="assistant-thread" aria-label="对话记录">
          {conversation.messages.map((message) => {
            if (message.kind === 'user') return <li className="assistant-message assistant-user-message ml-auto" data-role="user" key={message.id}>
              <div className="assistant-user-bubble whitespace-pre-wrap break-words">{message.text}</div>
            </li>;
            if (message.kind === 'activity') return <li className="harness-process-record" key={message.id}><ToolActivity message={message} /></li>;
            if (message.kind === 'approval') return <li className="assistant-message" key={message.id}><ApprovalCard approval={message} decide={(decision) => approve(message.id, decision)} /></li>;
            if (message.kind === 'stream') return <StreamReply key={message.id + '-' + message.startedAt} message={message}
              harness={conversation.harness} name={name} now={now} icon={<HarnessIcon harness={conversation.harness} className="size-3.5" />}
              replay={message.script === 'checks' && latest?.id === message.id ? () => replay(message.id) : undefined} />;
            return <li className="assistant-message" data-role="assistant" key={message.id}>
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><HarnessIcon harness={conversation.harness} className="size-3.5" />{name}</div>
              <MarkdownView content={message.text} />
            </li>;
          })}
        </ol> : <div className="dovun-assistant-welcome mx-auto flex flex-col items-start gap-3">
          <Surface tone="subtle" className="grid size-11 place-items-center text-brand-link"><HarnessIcon harness={conversation.harness} className="size-5" /></Surface>
          <h3>开始一条 {name} 对话</h3>
        </div>}
      </div>
      {detached && <Button type="button" variant="outline" size="sm" className="harness-follow" onClick={followLatest}>
        <ArrowDown className="size-3.5" aria-hidden="true" />回到最新
      </Button>}
    </div>
    <footer className="assistant-composer-area shrink-0">
      <fieldset aria-label="消息输入">
        <ChatComposer input={draft} busy={busy} actionsDisabled={approvalPending} onChange={(value) => write(value.slice(0, 8_000))} onStop={stop}
          placeholder={approvalPending ? '处理权限请求后继续' : `发消息给 ${name}`}
          model={<ChatProjectButton name={conversation.project} open={chooseProject} />}
          onSend={(event) => {
            event.preventDefault();
            if (!draft.trim() || busy || approvalPending) return;
            followLatest();
            send();
          }} />
      </fieldset>
    </footer>
  </>;
}

function App() {
  const [data, setData] = useState(readData);
  const [route, setRoute] = useState(readRoute);
  const [now, setNow] = useState(Date.now);
  const [createOpen, setCreateOpen] = useState(false);
  const [picker, setPicker] = useState<'list' | 'new' | 'chat' | null>(null);
  const [locationId, setLocationId] = useState('');
  const wide = useSyncExternalStore(subscribeDesktop, isDesktop);
  const locations = [...initialProjects, ...data.projects];
  const conversations = data.conversations.filter((session) => session.harness === route.harness &&
    (!route.project || (session.projectId ?? initialProjects.find((item) => item.projectName === session.project)?.id) === route.project))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const open = conversations.find((session) => session.id === route.sessionId);
  const current = open ?? (wide ? conversations[0] : undefined);
  const chatProject = current?.projectId ?? initialProjects.find((item) => item.projectName === current?.project)?.id;
  const previewId = current?.id === streamExampleId ? current.messages.find((item) => item.kind === 'stream' && item.startedAt === null)?.id : undefined;

  useEffect(() => {
    const refresh = () => { setRoute(readRoute()); setNow(Date.now()); };
    const catchUp = () => { if (document.visibilityState === 'visible') setNow(Date.now()); };
    window.addEventListener('hashchange', refresh);
    document.addEventListener('visibilitychange', catchUp);
    return () => { window.removeEventListener('hashchange', refresh); document.removeEventListener('visibilitychange', catchUp); };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch { /* Keep the current preview usable. */ }
  }, [data]);

  useEffect(() => {
    if (previewId) playExample(previewId);
  }, [previewId]);

  useEffect(() => {
    const deadlines = data.conversations.flatMap((session) => {
      const last = session.messages.at(-1);
      const time = last?.kind === 'stream' && nextFrameAt(last, session.harness, now);
      return typeof time === 'number' ? [time] : [];
    });
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, Math.min(...deadlines) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [data.conversations, now]);

  function navigate(harness: HarnessId, sessionId: string | null = null, project = route.project) {
    const hash = new URLSearchParams({ harness });
    if (sessionId) hash.set('session', sessionId);
    if (project) hash.set('project', project);
    window.location.hash = hash.toString();
    setRoute({ harness, sessionId, project });
  }

  function newConversation() {
    const location = locations.find((item) => item.id === locationId);
    if (!location) return;
    const id = crypto.randomUUID();
    const updatedAt = Date.now();
    setData((value) => ({ ...value, conversations: [
      { id, harness: route.harness, title: '新会话', project: location.projectName, projectId: location.id, updatedAt, messages: [] }, ...value.conversations,
    ] }));
    setCreateOpen(false);
    setNow(updatedAt);
    navigate(route.harness, id);
  }

  function amend(id: string, update: (conversation: Conversation) => Conversation, clearDraft = false) {
    setData((value) => ({ ...value,
      conversations: value.conversations.map((conversation) => conversation.id === id ? update(conversation) : conversation),
      drafts: clearDraft ? { ...value.drafts, [id]: '' } : value.drafts,
    }));
  }

  function send(conversation: Conversation) {
    const draft = data.drafts[conversation.id]?.trim();
    if (!draft || isBusy(conversation, Date.now()) || waitingForApproval(conversation)) return;
    const at = Date.now();
    const user: TextMessage = { id: crypto.randomUUID(), kind: 'user', text: draft };
    const answer: StreamMessage = { id: crypto.randomUUID(), kind: 'stream', script: 'reply', startedAt: at };
    amend(conversation.id, (session) => ({ ...session,
      title: session.messages.length ? session.title : Array.from(draft.replace(/\s+/g, ' ')).slice(0, 28).join(''),
      updatedAt: at, messages: [...session.messages, user, answer],
    }), true);
    setNow(at);
  }

  function stop(conversation: Conversation) {
    const last = conversation.messages.at(-1);
    if (last?.kind !== 'stream' || !isBusy(conversation, Date.now())) return;
    amend(conversation.id, (session) => ({ ...session, messages: [
      ...session.messages.slice(0, -1), { ...last, stoppedAt: Date.now() },
    ] }));
  }

  function playExample(id: string) {
    const at = Date.now();
    amend(streamExampleId, (session) => ({ ...session, messages: session.messages.map((item) =>
      item.id === id && item.kind === 'stream' ? { ...item, startedAt: at, stoppedAt: undefined } : item) }));
    setNow(at);
  }

  return <div className="app-backdrop harness-preview" data-chat-open={Boolean(open)}>
    <aside className="dovun-main harness-list-pane" aria-label="Harness 会话">
      <header className="harness-brand-bar">
        <BrandMark />
        <Badge variant="secondary" className="text-muted-foreground">演示</Badge>
        <div className="harness-theme ml-auto"><ThemeToggle /></div>
      </header>
      <div className="glass-scrollbar min-h-0 overflow-y-auto overscroll-contain">
        <div className="workspace-page harness-session-page">
          <header className="flex items-center justify-between gap-2">
            <h1>会话</h1>
            <HarnessStartDialog open={createOpen} onOpenChange={(next) => { if (next) setLocationId(route.project ?? ''); setCreateOpen(next); }}
              harnessName={harnessName(route.harness)} locations={locations.filter((item) => !route.project || item.id === route.project)}
              value={locationId} onSelect={setLocationId} onStart={newConversation} onChooseProject={() => { setCreateOpen(false); setPicker('new'); }} />
          </header>
          <div className="mb-5 grid gap-3">
            <ChoiceList label="Harness" value={route.harness} onChange={(harness) => { if (isHarness(harness)) navigate(harness); }}
              options={harnesses.map((item) => ({ id: item.id, label: item.name, icon: <HarnessIcon harness={item.id} /> }))} />
            <HarnessProjectPicker open={picker !== null} onOpenChange={(next) => {
              if (!next && picker === 'new') setCreateOpen(true);
              setPicker(next ? 'list' : null);
            }} projects={locations} computers={[demoComputer]} value={picker === 'chat' ? chatProject : route.project ?? undefined}
              directoryHint="这是演示电脑。可点开文件夹，也可在 /WorkSpace 下输入自己的项目路径演练，选择只保存在此浏览器。"
              browse={async (_nodeId, path) => demoDirectory(path, locations)}
              selectDirectory={async (_nodeId, path) => demoProject(path)}
              onChange={(item) => {
                if (item && !locations.some((known) => known.id === item.id)) setData((old) => ({ ...old, projects: [...old.projects, item] }));
                setLocationId(item?.id ?? '');
                if (picker !== 'chat' || !item || item.id !== chatProject) navigate(route.harness, null, item?.id ?? null);
              }} />
          </div>
          <ConversationList conversations={conversations} active={current?.id} now={now} open={(id) => navigate(route.harness, id)} />
        </div>
      </div>
    </aside>
    <main className="dovun-assistant harness-chat-pane" aria-label="会话详情" data-presentation="direct">
      {current && <ChatView key={current.id} conversation={current} draft={data.drafts[current.id] ?? ''} now={now}
        back={() => navigate(route.harness)} chooseProject={() => setPicker('chat')}
        write={(draft) => setData((value) => ({ ...value, drafts: { ...value.drafts, [current.id]: draft } }))}
        send={() => send(current)} stop={() => stop(current)} replay={playExample} approve={(id, decision) => amend(current.id, (session) => ({
          ...session, messages: session.messages.map((message) => message.id === id && message.kind === 'approval' ? { ...message, decision } : message),
        }))} />}
    </main>
  </div>;
}

const i18n = createInstance();
void i18n.init({
  lng: 'zh-CN', fallbackLng: 'zh-CN', initAsync: false, interpolation: { escapeValue: false },
  resources: { 'zh-CN': { chat: chatMessages, settings: settingsMessages, workspace: workspaceMessages } },
});
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={i18n}>
    <ThemeProvider attribute="class" defaultTheme="light" storageKey="dovun.harness-sessions.preview.theme" disableTransitionOnChange>
      <App />
    </ThemeProvider>
  </I18nextProvider>,
);
