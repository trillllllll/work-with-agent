import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { orchestrationStatusLabels } from './labels.js';
import { formatCost, formatDuration, formatMissing, formatTokens } from './format.js';

const STATUSES = ['all', 'open', 'running', 'paused', 'awaiting_acceptance', 'accepted', 'rejected', 'cancelled', 'superseded'] as const;

type FeedItem = {
  id: string; taskId: string; taskTitle: string | null; round: number; status: string; projectId: string; projectName: string | null;
  pauseReason: string | null; startedAt: string | null; endedAt: string | null; provider: string | null; nodeName: string | null;
  totals: { durationMs: number | null; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; costMicroUsd: number | null };
};
type Project = { id: string; name: string };

function statusLabel(status: string, t: (key: string) => string) {
  if (status === 'all') return t('runs.allStatuses');
  if (status === 'open') return t('runs.open');
  return orchestrationStatusLabels[status] ?? status;
}

export function OrchestrationRunsList() {
  const { t } = useTranslation('workspace');
  const { t: orchestration } = useTranslation('orchestration');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all');
  const [projectId, setProjectId] = useState('all');
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') });
  const feed = useInfiniteQuery({
    queryKey: ['orchestration-feed', status, projectId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      if (projectId !== 'all') params.set('projectId', projectId);
      if (pageParam) params.set('cursor', pageParam);
      const qs = params.toString();
      return api<{ items: FeedItem[]; nextCursor: string | null }>(`/api/orchestrations/feed${qs ? `?${qs}` : ''}`);
    },
    getNextPageParam: (page) => page.nextCursor,
  });
  const items = feed.data?.pages.flatMap((page) => page.items) ?? [];
  const openRound = (item: FeedItem) => {
    sessionStorage.setItem('dovun-open-orchestration', JSON.stringify({ taskId: item.taskId, orchestrationId: item.id }));
    window.dispatchEvent(new CustomEvent('dovun-open-task', { detail: { taskId: item.taskId } }));
  };
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <Select value={status} onValueChange={(value) => setStatus(value as (typeof STATUSES)[number])}>
        <SelectTrigger className="h-9 w-[11rem] rounded-xl text-sm" aria-label={t('runs.statusFilter')}><SelectValue /></SelectTrigger>
        <SelectContent>{STATUSES.map((value) => <SelectItem key={value} value={value}>{statusLabel(value, t)}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={projectId} onValueChange={setProjectId}>
        <SelectTrigger className="h-9 w-[11rem] rounded-xl text-sm" aria-label={t('runs.projectFilter')}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('runs.allProjects')}</SelectItem>
          {(projects.data ?? []).map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
    {feed.isLoading && <p className="text-sm text-muted-foreground">{t('handoff.loading')}</p>}
    {feed.isError && <p role="alert" className="text-sm text-destructive">{feed.error.message}</p>}
    {!feed.isLoading && !items.length && <p className="py-8 text-sm text-muted-foreground">{t('runs.emptyOrchestrations')}</p>}
    {items.map((item) => {
      const started = item.startedAt && Number.isFinite(Date.parse(item.startedAt)) ? new Date(item.startedAt).toLocaleString(intlLocale()) : formatMissing();
      return <Button variant="card" size="bare" key={item.id} type="button" data-testid="orchestration-feed-item" className="flex w-full flex-wrap items-center gap-2 rounded-xl p-4 text-left" onClick={() => openRound(item)}>
        <strong className="min-w-0 break-words text-sm">{item.taskTitle ?? formatMissing()}</strong>
        <span className="text-xs text-muted-foreground">{orchestration('history.roundTotal', { round: item.round })}</span>
        <Badge variant="outline">{orchestrationStatusLabels[item.status] ?? item.status}</Badge>
        {item.projectName && <span className="text-xs text-muted-foreground">{item.projectName}</span>}
        <span className="text-xs text-muted-foreground">{item.nodeName ?? formatMissing()} · {item.provider ?? formatMissing()}</span>
        <span className="w-full text-xs text-muted-foreground">{started} · {formatDuration(item.totals.durationMs)} · {orchestration('history.tokens', { input: formatTokens(item.totals.inputTokens), output: formatTokens(item.totals.outputTokens) })} · {formatCost(item.totals.costMicroUsd)}</span>
      </Button>;
    })}
    {feed.hasNextPage && <Button size="sm" variant="outline" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>{t('runs.loadMore')}</Button>}
  </div>;
}
