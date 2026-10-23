import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, type StatsAiSection, type StatsFocusSection, type StatsOverview, type StatsPlanSection, type StatsTasksSection } from '@/lib/api.js';
import { usePageContext } from '@/lib/assistant-context.js';
import { useHashRoute } from '@/hooks/useHashRoute.js';
import { intlLocale } from '@/i18n/index.js';
import { activeCount, browserTimeZone, combineActivity, eachDate, isSectionError, localDate, resolveStatsRange } from '@/lib/stats-range.js';
import { valuesByDate } from './charts/scale.js';
import { Button } from '@/components/ui/button.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { KpiCards } from './KpiCards.js';
import { StatsEmpty } from './StatsEmpty.js';
import { StatsRangeBar } from './StatsRangeBar.js';
import { type StatsNav } from './SectionShell.js';
import { TasksSection } from './sections/TasksSection.js';
import { FocusSection } from './sections/FocusSection.js';
import { PlanSection } from './sections/PlanSection.js';
import { AiSection } from './sections/AiSection.js';

function positive(value: number | null | undefined) {
  return typeof value === 'number' && value > 0;
}

export function workspaceIsEmpty(data: StatsOverview): boolean {
  if ([data.tasks, data.focus, data.plan, data.ai].some((section) => isSectionError(section))) return false;
  const tasks = data.tasks as StatsTasksSection;
  const focus = data.focus as StatsFocusSection;
  const plan = data.plan as StatsPlanSection;
  const ai = data.ai as StatsAiSection;
  if (positive(tasks.completed.value) || positive(tasks.created.value) || positive(tasks.overdue) || positive(tasks.estimatedCount.value)) return false;
  if (tasks.byTopic.length > 0 || tasks.byTag.length > 0 || tasks.overdueTop.length > 0) return false;
  if (tasks.completedByDay.some((row) => row.count > 0) || tasks.createdByDay.some((row) => row.count > 0)) return false;
  if (positive(focus.minutes.value) || positive(focus.sessions.value) || focus.byTask.length > 0) return false;
  if (focus.minutesByDay.some((row) => row.minutes > 0)) return false;
  if (positive(plan.plannedTasks.value) || positive(plan.plannedMinutesTotal.value) || positive(plan.focusMinutesTotal.value)) return false;
  if (plan.byBand.some((band) => band.plannedMinutes > 0 || band.focusMinutes > 0)) return false;
  if (plan.byDay.some((row) => row.plannedTasks > 0 || row.focusMinutes > 0 || row.doneOnPlan > 0 || row.doneLate > 0 || row.notDone > 0)) return false;
  const proposals = ai.proposals;
  if (positive(proposals.created.value) || positive(proposals.executed.value) || positive(proposals.rejected.value) || positive(proposals.failed.value) || positive(proposals.pending)) return false;
  if (positive(ai.memories.created.value) || positive(ai.memories.retired.value) || positive(ai.memories.activeTotal)) return false;
  if (positive(ai.memories.byOrigin.ai) || positive(ai.memories.byOrigin.manual)) return false;
  if (positive(ai.autoMemory.jobs.value) || positive(ai.autoMemory.failed.value)) return false;
  if (positive(ai.dispatch.rounds.value) || positive(ai.dispatch.costMicroUsd.value)) return false;
  if (ai.dispatch.byDay.some((row) => row.rounds > 0) || ai.connections.length > 0) return false;
  return true;
}

function recordedDays(data: StatsOverview): number {
  const dates = eachDate(data.range.from, data.range.to);
  const series: number[][] = [];
  if (!isSectionError(data.tasks)) {
    series.push(valuesByDate(dates, data.tasks.completedByDay, (row) => row.count));
    series.push(valuesByDate(dates, data.tasks.createdByDay, (row) => row.count));
  }
  if (!isSectionError(data.focus)) series.push(valuesByDate(dates, data.focus.minutesByDay, (row) => row.minutes));
  if (!isSectionError(data.plan)) series.push(valuesByDate(dates, data.plan.byDay, (row) => row.plannedTasks + row.focusMinutes + row.doneOnPlan + row.doneLate + row.notDone));
  if (!isSectionError(data.ai)) series.push(valuesByDate(dates, data.ai.dispatch.byDay, (row) => row.rounds));
  if (series.length === 0) return dates.length;
  return activeCount(combineActivity(series));
}

function goHash(hash: string) {
  const next = hash.startsWith('#') ? hash : `#${hash}`;
  if (window.location.hash !== next) window.location.hash = next;
}

export function StatsPage({ onOpenTopic }: { onOpenTopic: (id: string) => void }) {
  const { t } = useTranslation('stats');
  const { query, setQuery } = useHashRoute();
  const tz = useMemo(() => browserTimeZone(), []);
  const today = localDate(new Date());
  const resolved = useMemo(
    () => resolveStatsRange({ range: query.range, from: query.from, to: query.to }, new Date(`${today}T12:00:00`)),
    [query.range, query.from, query.to, today],
  );
  usePageContext('stats', { pageState: resolved.valid ? { dateFrom: resolved.from, dateTo: resolved.to } : {} });
  const overview = useQuery({
    queryKey: ['stats-overview', resolved.from, resolved.to, tz],
    enabled: resolved.valid,
    queryFn: () => api<StatsOverview>(`/api/stats/overview?${new URLSearchParams({ from: resolved.from, to: resolved.to, tz })}`),
  });
  const updated = overview.dataUpdatedAt > 0
    ? new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(overview.dataUpdatedAt)
    : '';
  const nav: StatsNav = {
    go: goHash,
    openTopic: (topicId) => { if (!topicId) goHash('#/inbox'); else onOpenTopic(topicId); },
    openTask: (taskId) => { window.dispatchEvent(new CustomEvent('dovun-open-task', { detail: { taskId } })); },
  };
  const retry = () => { void overview.refetch(); };
  const data = overview.data;
  const quiet = data ? workspaceIsEmpty(data) : false;
  const days = data && !quiet ? recordedDays(data) : 0;

  return (
    <div data-testid="stats-page" className="mx-auto w-full min-w-0 max-w-5xl space-y-6 p-5 sm:p-7" aria-busy={overview.isLoading}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <p className="text-xs text-muted-foreground">{updated ? t('computedIn', { tz, time: updated }) : t('computedZone', { tz })}</p>
      </header>
      <StatsRangeBar
        mode={resolved.mode}
        from={resolved.from}
        to={resolved.to}
        valid={resolved.valid}
        onPreset={(mode) => setQuery({ range: mode, from: null, to: null })}
        onCustom={(from, to) => setQuery({ range: 'custom', from, to })}
      />
      {overview.isLoading && (
        <div className="space-y-6" aria-label={t('loading')}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-28" />)}</div>
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      )}
      {overview.isError && (
        <div role="alert" data-testid="stats-section-error" className="glass-subtle flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
          <p className="text-sm text-destructive">{overview.error instanceof Error ? overview.error.message : t('sectionError')}</p>
          <Button type="button" variant="outline" size="sm" onClick={retry}>{t('retry')}</Button>
        </div>
      )}
      {data && quiet && <><KpiCards data={data} quiet nav={nav} /><StatsEmpty nav={nav} /></>}
      {data && !quiet && (
        <>
          {days > 0 && days < 3 && <p data-testid="stats-sparse" className="glass-subtle rounded-xl border px-4 py-3 text-sm text-muted-foreground">{t('sparseBanner', { count: days })}</p>}
          <KpiCards data={data} nav={nav} />
          <TasksSection data={data.tasks} range={data.range} nav={nav} onRetry={retry} />
          <FocusSection data={data.focus} range={data.range} nav={nav} onRetry={retry} />
          <PlanSection data={data.plan} range={data.range} nav={nav} onRetry={retry} />
          <AiSection data={data.ai} range={data.range} nav={nav} onRetry={retry} />
        </>
      )}
    </div>
  );
}
