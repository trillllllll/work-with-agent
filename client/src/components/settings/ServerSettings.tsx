import { desktopSentinel } from '@/lib/desktop-shell.js';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';

export type ServerInfo = { mode: 'local' | 'server'; version: string };

export const serverInfoQueryOptions = { queryKey: ['server-info'], queryFn: () => api<ServerInfo>('/api/v1/server/info') };

export function ServerSettings() {
  const { t } = useTranslation('settings');
  const infoQuery = useQuery<ServerInfo>(serverInfoQueryOptions);
  const inDesktopShell = typeof window !== 'undefined' && '__TAURI__' in window;
  if (infoQuery.isError) return (
    <section aria-labelledby="settings-server-title">
      <h3 id="settings-server-title" className="text-lg font-semibold">{t('server.title')}</h3>
      <p role="alert" className="mt-3 text-sm">{infoQuery.error instanceof Error ? infoQuery.error.message : t('server.title')}<Button variant="ghost" size="sm" onClick={() => void infoQuery.refetch()}>{t('actions.retry')}</Button></p>
    </section>
  );
  const info = infoQuery.data;
  return (
    <section aria-labelledby="settings-server-title">
      <h3 id="settings-server-title" className="text-lg font-semibold">{t('server.title')}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        {info?.mode === 'server' ? t('server.serverMode') : t('server.localMode')}
      </p>
      <dl className="glass-subtle mt-4 grid gap-3 rounded-xl p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">{t('server.mode')}</dt>
          <dd className="mt-0.5">{info ? (info.mode === 'server' ? t('server.serverValue') : t('server.localValue')) : '…'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('server.version')}</dt>
          <dd className="mt-0.5 font-mono">{info?.version ?? '…'}</dd>
        </div>
      </dl>
      {inDesktopShell && (
        <Button type="button" variant="outline" className="mt-4" onClick={() => { window.location.assign(desktopSentinel('launcher')); }}>{t('server.switchMode')}</Button>
      )}
    </section>
  );
}
