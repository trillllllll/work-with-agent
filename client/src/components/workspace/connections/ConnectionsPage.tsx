import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { usePageContext } from '@/lib/assistant-context.js';
import { ApiError, api, type Topic } from '@/lib/api.js';
import { json } from '@/lib/platform.js';
import type { Connection } from '@/lib/connection-status.js';
import { Button } from '@/components/ui/button.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { hostLabel } from '@/lib/connection-status.js';
import { ConnectionCard } from './ConnectionCard.js';
import { ConnectionEmpty } from './ConnectionEmpty.js';
import { ConnectionFormDialog, type ConnectionDraft, type CreatedConnection } from './ConnectionFormDialog.js';

type DialogMode =
  | { kind: 'closed' }
  | { kind: 'create'; host: string }
  | { kind: 'edit'; connection: Connection }
  | { kind: 'setup'; created: CreatedConnection };

export function ConnectionsPage({ topics, archivedTopics = [] }: { topics: Topic[]; archivedTopics?: Topic[] }) {
  const { t } = useTranslation('workspace');
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['connections'], queryFn: () => api<Connection[]>('/api/v1/connections') });
  const [mode, setMode] = useState<DialogMode>({ kind: 'closed' });
  const [conflict, setConflict] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Connection | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const selectedId = mode.kind === 'edit' ? mode.connection.id : mode.kind === 'setup' ? mode.created.id : '';
  usePageContext('connections', { pageState: { selectedId } });
  const connections = list.data ?? [];
  const active = connections.filter((connection) => connection.status !== 'revoked');
  const revoked = connections.filter((connection) => connection.status === 'revoked');
  const refresh = () => { setConflict(false); void list.refetch(); };
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['connections'] });
  const report = (error: unknown) => {
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      setMode({ kind: 'closed' });
      setRevokeTarget(null);
      setConflict(true);
      return;
    }
    toast.error(error instanceof Error ? error.message : t('app:action.failed'));
  };
  const create = async (draft: ConnectionDraft) => {
    try {
      const current = await api<Connection[]>('/api/v1/connections');
      const existing = current.find(item => item.host === draft.host && item.status !== 'revoked');
      if (existing) { setMode({ kind: 'edit', connection: existing }); toast.info(t('connections.reuseExisting')); return; }
      const created = await api<CreatedConnection>('/api/v1/connections', { method: 'POST', body: json(draft) });
      await invalidate();
      setMode({ kind: 'setup', created });
    } catch (error) { report(error); }
  };
  const save = async (connection: Connection, draft: Omit<ConnectionDraft, 'host'>) => {
    try {
      // Host stays on the original connection. Changing it means creating another one.
      await api(`/api/v1/connections/${connection.id}`, { method: 'PATCH', body: json({ ...draft, expectedRevision: connection.revision }) });
      await invalidate();
      toast.success(t('app:action.saved'));
      setMode({ kind: 'closed' });
    } catch (error) { report(error); }
  };
  const revoke = async () => {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    try {
      await api(`/api/v1/connections/${revokeTarget.id}`, { method: 'DELETE', body: json({ expectedRevision: revokeTarget.revision }) });
      await invalidate();
      toast.success(t('connections.revokedToast'));
      setRevokeTarget(null);
    } catch (error) { report(error); }
    finally { setRevokeBusy(false); }
  };
  const dialogKey = mode.kind === 'edit' ? mode.connection.id : 'create';
  return (
    <section className="mx-auto max-w-4xl space-y-6 p-5 sm:p-7">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{t('connections.title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('connections.description')}</p>
        </div>
        <Button type="button" className="shrink-0" aria-label={t('connections.createTitle')} onClick={() => setMode({ kind: 'create', host: 'codex' })}>
          <Plus aria-hidden="true" />
          <span className="sm:hidden">{t('connections.createShort')}</span>
          <span className="hidden sm:inline">{t('connections.createTitle')}</span>
        </Button>
      </header>
      {conflict && <Callout message={t('connections.conflict')} onRefresh={refresh} />}
      {list.isError && <Callout message={t('connections.loadFailed')} onRefresh={refresh} />}
      {list.isLoading ? (
        <div role="status" aria-label={t('connections.loading')} className="space-y-3">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : connections.length === 0 && !list.isError ? (
        <ConnectionEmpty onConnect={(host) => setMode({ kind: 'create', host })} />
      ) : connections.length > 0 ? (
        <div className="space-y-3">
          {active.map((connection) => (
            <ConnectionCard key={connection.id} connection={connection} topics={topics} archivedTopics={archivedTopics} onEdit={() => setMode({ kind: 'edit', connection })} onRevoke={() => setRevokeTarget(connection)} />
          ))}
          {revoked.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-1 py-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
                <ChevronDown aria-hidden="true" className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                <span>{t('connections.revokedGroup', { count: revoked.length })}</span>
                <span>· {t('connections.revokedHint')}</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-3">
                {revoked.map((connection) => <ConnectionCard key={connection.id} connection={connection} topics={topics} archivedTopics={archivedTopics} revoked />)}
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      ) : null}
      {mode.kind !== 'closed' && (
        <ConnectionFormDialog key={dialogKey} mode={mode} topics={topics} archivedTopics={archivedTopics} onClose={() => setMode({ kind: 'closed' })} onCreate={create} onSave={(draft) => mode.kind === 'edit' ? save(mode.connection, draft) : Promise.resolve()} />
      )}
      {revokeTarget && (
        <ConfirmDialog title={t('connections.revokeTitle', { name: revokeTarget.name })} itemName={revokeTarget.name} description={t('connections.revokeDescription', { label: hostLabel(revokeTarget.host) })} confirmLabel={t('connections.revoke')} busy={revokeBusy} onCancel={() => { if (!revokeBusy) setRevokeTarget(null); }} onConfirm={() => { void revoke(); }} />
      )}
    </section>
  );
}

function Callout({ message, onRefresh }: { message: string; onRefresh: () => void }) {
  const { t } = useTranslation('workspace');
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <span>{message}</span>
      <Button type="button" size="sm" variant="outline" onClick={onRefresh}><RefreshCw aria-hidden="true" />{t('connections.refresh')}</Button>
    </div>
  );
}
