import { useQuery } from '@tanstack/react-query';
import { ChevronRight, CircleAlert, History } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api.js';
import type { HarnessSessionTarget } from '@/lib/harness-navigation.js';
import { Button } from '@/components/ui/button.js';

export type RecentHarnessSession = {
  id: string;
  harness?: string;
  locationId: string;
  projectName: string;
  nodeName: string | null;
  online: boolean;
  status: string;
  title?: string | null;
  updatedAt: string;
  archived?: boolean;
};
type RecentList = {
  harnesses?: Array<{ id: string; name: string }>;
  sessions: RecentHarnessSession[];
};

export function selectRecentHarnessSession(sessions: RecentHarnessSession[]) {
  return sessions.filter(session => !session.archived && Number.isFinite(Date.parse(session.updatedAt)))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))[0];
}

export function HarnessRecentCard({ onOpen, onOpenList }: {
  onOpen: (target: HarnessSessionTarget) => void;
  onOpenList: () => void;
}) {
  const { t } = useTranslation('workspace');
  const list = useQuery({
    queryKey: ['harness-sessions', 'recent-entry'],
    queryFn: ({ signal }) => api<RecentList>('/api/v1/harness-sessions?order=recent', { signal }),
    refetchInterval: 15_000,
    retry: false,
  });
  const recent = !list.error && list.data ? selectRecentHarnessSession(list.data.sessions) : undefined;
  const harness = recent && (list.data?.harnesses?.find(item => item.id === recent.harness)?.name ?? (recent.harness ? recent.harness : 'Codex'));
  const unavailable = recent && (!recent.online || recent.status !== 'ready');
  const title = list.isLoading ? t('harness.recent.loading')
    : list.error ? t('harness.recent.unavailable')
      : recent ? t(unavailable ? 'harness.recent.view' : 'harness.recent.continue')
        : t('harness.recent.empty');
  const description = list.error ? t('harness.recent.listFallback')
    : recent ? `${recent.title || recent.projectName} · ${harness} · ${recent.projectName} · ${recent.nodeName ?? t('harness.unknownComputer')}`
      : t('harness.recent.listFallback');
  return <Button variant="card" size="bare" type="button"
    data-testid="more-harness-recent" data-session-id={recent?.id}
    disabled={list.isLoading}
    onClick={() => recent ? onOpen({ id: recent.id, harness: recent.harness ?? 'codex', project: recent.locationId }) : onOpenList()}
    className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 py-2.5 text-left transition-colors hover:bg-[var(--glass-hover)]">
    <span className="glass-control flex size-9 shrink-0 items-center justify-center rounded-xl">
      {list.error ? <CircleAlert aria-hidden className="size-5 text-warning" /> : <History aria-hidden className="size-5" strokeWidth={1.75} />}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-[15px] font-medium">{title}</span>
      <span className="block truncate text-xs text-muted-foreground">{description}</span>
      {recent && !recent.online && <span className="block text-xs text-warning">{t('harness.status.offline')}</span>}
      {recent && recent.online && recent.status !== 'ready' && <span className="block text-xs text-muted-foreground">{t('harness.status.' + recent.status)}</span>}
    </span>
    <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
  </Button>;
}
