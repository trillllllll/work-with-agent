import { Surface } from '@/components/ui/surface.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ellipsis, TriangleAlert } from 'lucide-react';
import type { Topic } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { parseStored, operationNames } from '@/lib/platform.js';
import { connectionStatus, hostInitials, hostLabel, type Connection, type ConnectionStatus } from '@/lib/connection-status.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { connectionOperationIds } from './AutoActionSwitches.js';
import { ConnectionCheck } from './ConnectionCheck.js';

const statusText: Record<ConnectionStatus, string> = {
  connected: 'connections.statusConnected',
  waiting: 'connections.statusWaiting',
  unhealthy: 'connections.statusUnhealthy',
  revoked: 'connections.revoked',
};

const statusClass: Record<ConnectionStatus, string> = {
  connected: 'border-success-border bg-success-bg text-success',
  waiting: 'border-border bg-muted text-foreground',
  unhealthy: 'border-warning-border bg-warning-bg text-warning',
  revoked: 'border-border bg-muted text-muted-foreground',
};

const operationText: Record<string, string> = {
  'task.create': 'connections.operations.create',
  'task.content': 'connections.operations.content',
  'task.schedule': 'connections.operations.schedule',
  'task.complete': 'connections.operations.complete',
  'task.result': 'connections.operations.result',
};

function formatStamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(intlLocale());
}

type ConnectionCardProps = {
  connection: Connection;
  topics: Topic[];
  archivedTopics: Topic[];
  revoked?: boolean;
  onEdit?: () => void;
  onRevoke?: () => void;
};

export function ConnectionCard({ connection, topics, archivedTopics, revoked = false, onEdit, onRevoke }: ConnectionCardProps) {
  const { t } = useTranslation('workspace');
  const [override, setOverride] = useState<{ revision: number; ids: string[] } | null>(null);
  const missingIds = override && override.revision === connection.revision ? override.ids : (connection.missingTopicIds ?? []);
  const status = connectionStatus({ ...connection, missingTopicIds: missingIds });
  const operationLabel = (operation: string) => {
    const key = operationText[operation];
    if (key) return t(key);
    return operationNames[operation] || operation;
  };
  const actions = parseStored<string[]>(connection.autoActions, []);
  const actionIds = [...connectionOperationIds.filter((id) => actions.includes(id)), ...actions.filter((id) => !(connectionOperationIds as readonly string[]).includes(id))];
  const command = connection.lastCommandAt ? t('connections.lastCommand', { time: formatStamp(connection.lastCommandAt) }) : '';
  const write = connection.lastWriteAt ? t('connections.lastWrite', { time: formatStamp(connection.lastWriteAt), operation: operationLabel(connection.lastWriteOperation ?? '') }) : '';
  const activity = [command, write].filter(Boolean).join(' · ') || t('connections.noActivity');
  const edit = onEdit ?? (() => {});
  return (
    <Surface as="article" tone="subtle" className="space-y-3 rounded-xl p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-xs font-semibold">{hostInitials(connection.host)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold break-words">{connection.name}</h2>
            <Badge variant="outline" className={statusClass[status]}>{t(statusText[status])}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('connections.createdLine', { host: hostLabel(connection.host), time: formatStamp(connection.createdAt) })}</p>
        </div>
        {!revoked && (
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="outline" size="sm" className="hidden sm:inline-flex" onClick={edit}>{t('connections.editAccess')}</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t('connections.moreActions')}><Ellipsis /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => onRevoke?.()}>{t('connections.revoke')}…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      {revoked ? (
        <div className="text-sm text-muted-foreground">
          <ScopeChips connection={connection} topics={topics} archivedTopics={archivedTopics} missingIds={missingIds} />
        </div>
      ) : (
        <dl className="space-y-2 text-sm">
          <div className="grid gap-1 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:items-start sm:gap-3">
            <dt className="text-muted-foreground">{t('connections.scopeLabel')}</dt>
            <dd><ScopeChips connection={connection} topics={topics} archivedTopics={archivedTopics} missingIds={missingIds} /></dd>
          </div>
          <div className="grid gap-1 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:items-start sm:gap-3">
            <dt className="text-muted-foreground">{t('connections.autoLabel')}</dt>
            <dd className="flex flex-wrap gap-1">
              {actionIds.length ? actionIds.map((id) => <span key={id} className="inline-flex rounded-md bg-muted px-2 py-0.5 text-xs">{operationLabel(id)}</span>) : <span className="text-muted-foreground">{t('connections.autoNone')}</span>}
            </dd>
          </div>
          <div className="grid gap-1 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:items-start sm:gap-3">
            <dt className="text-muted-foreground">{t('connections.activityLabel')}</dt>
            <dd className={connection.lastCommandAt || connection.lastWriteAt ? '' : 'text-muted-foreground'}>{activity}</dd>
          </div>
        </dl>
      )}
      {!revoked && status === 'unhealthy' && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning">
          <span className="flex items-start gap-2"><TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{t('connections.cardMissing', { count: missingIds.length })}</span>
          <Button type="button" variant="outline" size="sm" onClick={edit}>{t('connections.fixAccess')}</Button>
        </div>
      )}
      {!revoked && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" className="sm:hidden" onClick={edit}>{t('connections.editAccess')}</Button>
          <ConnectionCheck id={connection.id} host={connection.host} lastCommandAt={connection.lastCommandAt} missingTopicIds={missingIds} topics={topics} archivedTopics={archivedTopics} onMissing={(ids) => setOverride({ revision: connection.revision, ids })} onEdit={edit} />
        </div>
      )}
    </Surface>
  );
}

function ScopeChips({ connection, topics, archivedTopics, missingIds }: { connection: Connection; topics: Topic[]; archivedTopics: Topic[]; missingIds: string[] }) {
  const { t } = useTranslation('workspace');
  const missing = new Set(missingIds);
  const topicById = new Map(topics.map((topic) => [topic.id, topic]));
  const archivedById = new Map(archivedTopics.map((topic) => [topic.id, topic]));
  const ids = parseStored<string[]>(connection.topicIds, []);
  const chip = 'inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-xs';
  return (
    <div className="flex flex-wrap gap-1">
      {connection.includeInbox && <span className={`${chip} bg-muted`}>{t('inbox')}</span>}
      {ids.map((id) => {
        const topic = topicById.get(id);
        const archived = archivedById.get(id);
        if (missing.has(id)) return <span key={id} className={`${chip} border border-warning-border bg-warning-bg text-warning line-through`}>{topic?.name ?? archived?.name ?? t('connections.unnamedMissing')}</span>;
        if (archived) return <span key={id} className={`${chip} bg-muted`}>{archived.name}<Badge variant="outline">{t('connections.archivedBadge')}</Badge></span>;
        if (!topic) return <span key={id} className={`${chip} bg-muted text-muted-foreground`}>{t('connections.unnamedMissing')}</span>;
        return (
          <span key={id} className={`${chip} bg-muted`}>
            <span className="sidebar-list-mark" data-color={topic.color || 'slate'} aria-hidden="true" />
            <span className="truncate">{topic.name}</span>
            {topic.isExploration && <em className="sidebar-explore-tag">{t('settings:topicList.exploring')}</em>}
          </span>
        );
      })}
    </div>
  );
}
