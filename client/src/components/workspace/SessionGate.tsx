import { desktopSentinel } from '@/lib/desktop-shell.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { markDesktopShell } from '@/lib/desktop-shell.js';
import { api, setCsrfToken } from '@/lib/api.js';
import { EditorRuntime, markEditorSessionExpired, TaskEditorRuntimeProvider, useBeforeunloadGuard } from '@/lib/task-editor-runtime.js';
import { UnsyncedTasksButton } from '@/components/tasks/task-save-status.js';
import { BrandMark } from '@/components/layout/BrandMark.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';

function EditorRuntimeMount({ runtime, children }: { runtime: EditorRuntime | null; children: ReactNode }) {
  useBeforeunloadGuard();
  return <TaskEditorRuntimeProvider runtime={runtime}>
    {children}
    <UnsyncedTasksButton onOpenTask={(taskId) => { window.dispatchEvent(new CustomEvent('dovun-open-task', { detail: { taskId } })); }} />
  </TaskEditorRuntimeProvider>;
}

export function SessionGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation('workspace');
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
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('session.loginFailed')); setState('locked'); }
    finally { busy.current = false; }
  }
  useEffect(() => {
    let alive = true;
    // The desktop shell navigates here with ?launcher=1 and watches for the sentinel
    // redirect below; it cancels the navigation and marks the launch confirmed.
    if (new URLSearchParams(window.location.search).get('launcher') === '1') {
      markDesktopShell();
      window.history.replaceState(null, '', `${window.location.pathname}#/today`);
      window.location.assign(desktopSentinel('launcher-done'));
    }
    void api<{ mode: 'local' | 'server' }>('/api/v1/server/info').then((info) => { if (alive) setRemote(info.mode === 'server'); }).catch(() => {});
    const params = new URLSearchParams(window.location.hash.slice(1));
    const initialToken = params.get('owner-token');
    if (initialToken) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/today`);
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
    <BrandMark /><h1 className="text-xl font-semibold">{t('session.title')}</h1>
    {state === 'loading' ? <p className="text-sm text-muted-foreground">{t('session.connecting')}</p> : <>
      <p className="text-sm text-muted-foreground">{remote ? t('session.remoteHint') : t('session.localHint')}</p>
      <Input aria-label={remote ? t('session.accessKey') : t('session.launchCredential')} type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required />
      <Button className="w-full" disabled={!token.trim() || busy.current}>{t('session.enter')}</Button>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </form></main>;
}
