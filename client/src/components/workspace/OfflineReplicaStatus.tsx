import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browserReplica } from '@/lib/offline-runtime.js';
import { Button } from '@/components/ui/button.js';

export function OfflineReplicaStatus() {
  const { t } = useTranslation('workspace');
  const [state, setState] = useState<{ pending: number; offline: boolean; error: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      const runtime = browserReplica();
      if (!runtime) { setState(null); return; }
      void runtime.status().then(value => { if (alive && value) setState({ pending: value.outbox.length, offline: !navigator.onLine, error: Boolean(value.lastError) }); });
    };
    refresh();
    for (const event of ['online', 'offline', 'dovun-replica-change']) window.addEventListener(event, refresh);
    return () => { alive = false; for (const event of ['online', 'offline', 'dovun-replica-change']) window.removeEventListener(event, refresh); };
  }, []);
  if (!state || !state.offline && !state.pending && !state.error) return null;
  return <aside role="status" className="fixed inset-x-3 bottom-20 z-50 mx-auto flex max-w-lg items-center justify-between gap-3 rounded-xl border bg-background px-4 py-2 text-sm shadow-lg sm:bottom-4">
    <span>{t(state.offline ? 'offline.saved' : state.error ? 'offline.retrying' : 'offline.pending', { count: state.pending })}</span>
    {!state.offline && <Button type="button" variant="ghost" size="sm" onClick={() => { if (browserReplica()?.needsRecovery) window.dispatchEvent(new Event('dovun-replica-reconnect')); else void browserReplica()?.sync().catch(() => {}); }}>{t('offline.retry')}</Button>}
  </aside>;
}
