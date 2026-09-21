import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, setCsrfToken } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';

export function SessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'locked' | 'ready'>('loading');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const busy = useRef(false);
  async function login(bootstrapToken: string) {
    if (busy.current) return;
    busy.current = true; setError('');
    try {
      const session = await api<{ csrfToken: string }>('/api/v1/auth/session', { method: 'POST', body: JSON.stringify({ bootstrapToken }) });
      setCsrfToken(session.csrfToken); setToken(''); setState('ready');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败'); setState('locked'); }
    finally { busy.current = false; }
  }
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const initialToken = params.get('owner-token');
    if (initialToken) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/inbox`);
      void login(initialToken);
    } else {
      void api<{ authenticated: boolean; csrfToken?: string }>('/api/v1/auth/session').then((session) => {
        if (!alive) return;
        setCsrfToken(session.csrfToken ?? ''); setState(session.authenticated ? 'ready' : 'locked');
      }).catch((reason) => { if (alive) { setError(reason.message); setState('locked'); } });
    }
    const expired = () => { setCsrfToken(''); setState('locked'); };
    window.addEventListener('workspace-session-expired', expired);
    return () => { alive = false; window.removeEventListener('workspace-session-expired', expired); };
  }, []);
  if (state === 'ready') return <>{children}</>;
  return <main className="flex min-h-dvh items-center justify-center bg-background p-6"><form className="glass-surface w-full max-w-md space-y-5 rounded-2xl p-7" onSubmit={(event) => { event.preventDefault(); void login(token); }}>
    <h1 className="text-xl font-semibold">打开你的工作室</h1>
    {state === 'loading' ? <p className="text-sm text-muted-foreground">正在连接本机服务…</p> : <>
      <p className="text-sm text-muted-foreground">使用启动终端显示的专属链接，或粘贴本次启动凭据。</p>
      <Input aria-label="启动凭据" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required />
      <Button className="w-full" disabled={!token.trim() || busy.current}>进入工作室</Button>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </form></main>;
}
