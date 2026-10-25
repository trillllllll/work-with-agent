import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { Surface } from '@/components/ui/surface.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { serverInfoQueryOptions } from './ServerSettings.js';

export type SyncConflict = {
  id: string;
  entityType: string;
  entityId: string;
  field: string;
  base: unknown;
  live: unknown;
  incoming: unknown;
};

type SyncStatus = { mode: 'local' | 'server'; bound: boolean; url: string | null; baselineReady: boolean; appliedHubSeq: number; pending: number; lastSuccessAt: string | null; lastError: string | null; syncing: boolean };
type Pairing = { deviceId: string; token: string };

export const syncConflictsQueryOptions = { queryKey: ['sync-conflicts'], queryFn: () => api<SyncConflict[]>('/api/v1/sync/conflicts') };
export const syncStatusQueryOptions = { queryKey: ['sync-status'], queryFn: () => api<SyncStatus>('/api/v1/sync/status'), refetchInterval: 5_000 };

function show(value: unknown) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function SyncConflicts() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const conflicts = useQuery(syncConflictsQueryOptions);
  const status = useQuery(syncStatusQueryOptions);
  const archive = useInfiniteQuery({ queryKey:['sync-archive'], initialPageParam:'', queryFn:({pageParam})=>api<{items:Array<{id:string;source:string;tableName:string;entityKey:string}>;nextCursor:string|null}>('/api/v1/sync/archive?after='+encodeURIComponent(pageParam)), getNextPageParam:page=>page.nextCursor ?? undefined });
  const archiveRows=archive.data?.pages.flatMap(page=>page.items) ?? [];
  const [archiveItem,setArchiveItem] = useState<unknown>(null);
  const readArchive = useMutation({ mutationFn:(id:string)=>api('/api/v1/sync/archive/'+id), onSuccess:setArchiveItem, onError:(error:Error)=>toast.error(error.message) });
  const server = useQuery(serverInfoQueryOptions);
  const [token, setToken] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [credential, setCredential] = useState('');
  const [confirmAlign, setConfirmAlign] = useState(false);
  const resolve = useMutation({
    mutationFn: ({ id, choice }: { id: string; choice: 'mine' | 'theirs' }) => api(`/api/v1/sync/conflicts/${id}/resolve`, { method: 'POST', body: JSON.stringify({ choice }) }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['sync-conflicts'] }); void queryClient.invalidateQueries({ queryKey: ['tasks'] }); },
    onError: (error: Error) => toast.error(error.message),
  });
  const generate = useMutation({
    mutationFn: () => api<Pairing>('/api/v1/sync/devices', { method: 'POST', body: JSON.stringify({ name: 'desktop' }) }),
    onSuccess: (data) => setToken(data.token),
    onError: (error: Error) => toast.error(error.message),
  });
  const align = useMutation({
    mutationFn: async () => {
      await api('/api/v1/sync/bind', { method: 'POST', body: JSON.stringify({ url, token: credential }) });
      return api('/api/v1/sync/align', { method: 'POST', body: JSON.stringify({}) });
    },
    onSuccess: () => {
      setCredential('');
      setConfirmAlign(false);
      toast.success(t('sync.aligned'));
      void queryClient.invalidateQueries({ queryKey: ['sync-status'] });
      void queryClient.invalidateQueries({ queryKey: ['sync-conflicts'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (error: Error) => { setCredential(''); setConfirmAlign(false); void queryClient.invalidateQueries({ queryKey: ['sync-status'] }); toast.error(error.message); },
  });
  const retry = useMutation({
    mutationFn: () => api('/api/v1/sync/run', { method: 'POST', body: '{}' }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['sync-status'] });
      void queryClient.invalidateQueries({ queryKey: ['sync-conflicts'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const rows = conflicts.data ?? [];
  const mode = server.data?.mode ?? status.data?.mode;
  const boundText = status.data?.bound
    ? status.data.baselineReady ? t('sync.ready', { url: status.data.url ?? '' }) : t('sync.waiting', { url: status.data.url ?? '' })
    : t('sync.unbound');
  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      toast.success(t('sync.copied'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sync.copyFailed'));
    }
  }
  return (
    <section aria-labelledby="settings-sync-title">
      <h3 id="settings-sync-title" className="text-lg font-semibold">{t('sync.title')}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('sync.description')}</p>
      {mode === 'server' && (
        <Surface as="div" tone="subtle" className="mt-4  rounded-xl p-4">
          <h4 className="text-sm font-medium">{t('sync.pairTitle')}</h4>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('sync.pairDescription')}</p>
          <Button type="button" className="mt-3" variant="outline" disabled={generate.isPending} onClick={() => generate.mutate()}>{t('sync.generate')}</Button>
          {token && (
            <div className="mt-3 space-y-2">
              <p className="text-[13px] text-muted-foreground">{t('sync.tokenOnce')}</p>
              <div className="flex flex-wrap gap-2">
                <Input readOnly value={token} aria-label={t('sync.token')} />
                <Button type="button" variant="outline" onClick={() => void copyToken()}>{t('sync.copy')}</Button>
              </div>
            </div>
          )}
        </Surface>
      )}
      {mode === 'local' && (
        <Surface as="div" tone="subtle" className="mt-4  rounded-xl p-4">
          <h4 className="text-sm font-medium">{t('sync.bindTitle')}</h4>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('sync.bindDescription')}</p>
          <p className="mt-2 text-[13px] text-muted-foreground">{boundText}</p>
          {status.data?.bound ? <div className="mt-3 space-y-2">
            <p role="status" className="text-sm text-muted-foreground">
              {status.data.syncing ? t('sync.syncing') : status.data.lastError ? t('sync.offline') : status.data.pending > 0 ? t('sync.pending', { count: status.data.pending }) : status.data.lastSuccessAt ? t('sync.confirmed', { time: new Date(status.data.lastSuccessAt).toLocaleTimeString() }) : t('sync.checking')}
            </p>
            {status.data.pending > 0 && (status.data.syncing || status.data.lastError) && <p className="text-sm text-muted-foreground">{t('sync.pending', { count: status.data.pending })}</p>}
            <Button type="button" variant="outline" disabled={retry.isPending || status.data.syncing} onClick={() => retry.mutate()}>{t('sync.retry')}</Button>
          </div> : <div className="mt-3 space-y-2">
            <label className="block text-sm" htmlFor="sync-url">{t('sync.url')}</label>
            <Input id="sync-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" autoComplete="off" />
            <label className="block text-sm" htmlFor="sync-token">{t('sync.token')}</label>
            <Input id="sync-token" type="password" value={credential} onChange={(event) => setCredential(event.target.value)} autoComplete="new-password" />
            <Button type="button" variant="outline" disabled={align.isPending || !url || credential.length < 20} onClick={() => setConfirmAlign(true)}>{t('sync.align')}</Button>
          </div>}
        </Surface>
      )}
      {conflicts.isError && <p className="mt-4 text-sm text-destructive">{conflicts.error.message}</p>}
      {!conflicts.isError && rows.length === 0 && <p className="mt-4 text-sm text-muted-foreground">{t('sync.empty')}</p>}
      <ul className="mt-4 space-y-3">
        {rows.map((row) => (
          <Surface as="li" tone="subtle" key={row.id} className="rounded-xl p-4">
            <p className="text-sm font-medium">{t('sync.item', { field: row.field, entity: row.entityId })}</p>
            <dl className="mt-2 space-y-1 text-[13px] text-muted-foreground">
              <div><dt className="inline">{t('sync.base')}</dt><dd className="inline whitespace-pre-wrap">{show(row.base) || t('sync.blank')}</dd></div>
              <div><dt className="inline">{t('sync.live')}</dt><dd className="inline whitespace-pre-wrap">{show(row.live) || t('sync.blank')}</dd></div>
              <div><dt className="inline">{t('sync.incoming')}</dt><dd className="inline whitespace-pre-wrap">{show(row.incoming) || t('sync.blank')}</dd></div>
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: row.id, choice: 'mine' })}>{t('sync.keepMine')}</Button>
              <Button type="button" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: row.id, choice: 'theirs' })}>{t('sync.keepTheirs')}</Button>
            </div>
          </Surface>
        ))}
      </ul>
      {Boolean(archiveRows.length) && <Disclosure className="mt-4">
        <DisclosureTrigger className="text-sm">{t('sync.archiveTitle', {count:archiveRows.length})}</DisclosureTrigger>
        <p className="mt-2 text-sm text-muted-foreground">{t('sync.archiveDescription')}</p>
        <ul className="mt-2 max-h-64 overflow-auto">{archiveRows.map(item=><li key={item.id}><Button variant="ghost" size="sm" onClick={()=>readArchive.mutate(item.id)}>{item.source} · {item.tableName} · {item.entityKey}</Button></li>)}</ul>
        {archive.hasNextPage && <Button variant="outline" size="sm" disabled={archive.isFetchingNextPage} onClick={()=>void archive.fetchNextPage()}>{t('sync.archiveMore')}</Button>}
        {archiveItem != null && <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(archiveItem,null,2)}</pre>}
      </Disclosure>}
      {confirmAlign && (
        <ConfirmDialog title={t('sync.alignTitle')} itemName={url} description={t('sync.alignDescription')} busy={align.isPending} onCancel={() => { if (!align.isPending) setConfirmAlign(false); }} onConfirm={() => align.mutate()} />
      )}
    </section>
  );
}
