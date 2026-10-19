import { useEffect, useRef, useState, type ReactNode } from 'react';
import { markDesktopShell } from '@/lib/desktop-shell.js';
import { api, setCsrfToken } from '@/lib/api.js';
import { EditorRuntime, markEditorSessionExpired, TaskEditorRuntimeProvider, useBeforeunloadGuard } from '@/lib/task-editor-runtime.js';
import { UnsyncedTasksButton } from '@/components/tasks/task-save-status.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';

function EditorRuntimeMount({ runtime, children }: { runtime: EditorRuntime | null; children: ReactNode }) {
  useBeforeunloadGuard();
  return <TaskEditorRuntimeProvider runtime={runtime}>
    {children}
    <UnsyncedTasksButton onOpenTask={(taskId) => { window.dispatchEvent(new CustomEvent('wwa-open-task', { detail: { taskId } })); }} />
  </TaskEditorRuntimeProvider>;
}

export function SessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'locked' | 'ready'>('loading');
  const [runtime, setRuntime] = useState<EditorRuntime | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [remote, setRemote] = useState(false);
  const busy = useRef(false);
  const armRuntime = async (actorId: string | undefined) => {
    // 未确认登录身份时不启动同步。
    if (!actorId) return;
    try {
      const opened = await EditorRuntime.open(actorId);
      setRuntime(opened);
      markEditorSessionExpired(false);
    } catch { /* 草稿仓库不可用时仍可查看，稍后重试 */ }
  };
  async function login(credential: string) {
    if (busy.current) return;
    busy.current = true; setError('');
    try {
      const session = await api<{ csrfToken: string; actor?: { id: string } }>('/api/v1/auth/session', { method: 'POST', body: JSON.stringify(remote ? { ownerKey: credential } : { bootstrapToken: credential }) });
      setCsrfToken(session.csrfToken); setToken(''); setState('ready');
      void armRuntime(session.actor?.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败'); setState('locked'); }
    finally { busy.current = false; }
  }
  useEffect(() => {
    let alive = true;
    // The desktop shell navigates here with ?launcher=1 and watches for the sentinel
    // redirect below; it cancels the navigation and marks the launch confirmed.
    if (new URLSearchParams(window.location.search).get('launcher') === '1') {
      markDesktopShell();
      window.history.replaceState(null, '', `${window.location.pathname}#/inbox`);
      window.location.assign('/wwa-launcher-done');
    }
    void api<{ mode: 'local' | 'server' }>('/api/v1/server/info').then((info) => { if (alive) setRemote(info.mode === 'server'); }).catch(() => {});
    const params = new URLSearchParams(window.location.hash.slice(1));
    const initialToken = params.get('owner-token');
    if (initialToken) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/inbox`);
      void login(initialToken);
    } else {
      void api<{ authenticated: boolean; csrfToken?: string; actor?: { id: string } }>('/api/v1/auth/session').then((session) => {
        if (!alive) return;
        setCsrfToken(session.csrfToken ?? ''); setState(session.authenticated ? 'ready' : 'locked');
        if (session.authenticated) void armRuntime(session.actor?.id);
      }).catch((reason) => { if (alive) { setError(reason.message); setState('locked'); } });
    }
    const expired = () => {
      setCsrfToken('');
      setState('locked');
      // 暂停网络同步，保留本地草稿；重新认证同一 scope 后继续。
      markEditorSessionExpired(true);
    };
    window.addEventListener('workspace-session-expired', expired);
    return () => { alive = false; window.removeEventListener('workspace-session-expired', expired); };
  }, []);
  if (state === 'ready') return <EditorRuntimeMount runtime={runtime}>{children}</EditorRuntimeMount>;
  return <main className="flex min-h-dvh items-center justify-center bg-background p-6"><form className="glass-surface w-full max-w-md space-y-5 rounded-2xl p-7" onSubmit={(event) => { event.preventDefault(); void login(token); }}>
    <h1 className="text-xl font-semibold">打开你的工作室</h1>
    {state === 'loading' ? <p className="text-sm text-muted-foreground">正在连接本机服务…</p> : <>
      <p className="text-sm text-muted-foreground">{remote ? '输入这台服务器的访问密钥。密钥在服务器首次启动时显示过一次。' : '使用启动终端显示的专属链接，或粘贴本次启动凭据。'}</p>
      <Input aria-label={remote ? '访问密钥' : '启动凭据'} type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required />
      <Button className="w-full" disabled={!token.trim() || busy.current}>进入工作室</Button>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </form></main>;
}
