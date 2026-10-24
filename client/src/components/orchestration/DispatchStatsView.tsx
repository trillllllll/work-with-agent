import { TableRow } from '@/components/ui/table-row.js';
import { Button } from '@/components/ui/button.js';
import { Surface } from '@/components/ui/surface.js';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { Input } from '@/components/ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { formatCost, formatDiff, formatDuration, formatMissing, formatTokens } from './format.js';
import { customRange, dateInputValue, weekRange } from './week-range.js';
import { intlLocale } from '@/i18n/index.js';

const FAILURE_KINDS = ['rate_limit', 'git_denied', 'no_commit', 'tests_failed', 'merge_conflict', 'review_failed', 'cli_error', 'other'] as const;

type UsageGroup = { key: string; jobs: number; durationMs: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; costMicroUsd: number };
type RankDuration = { taskId: string; title: string; durationMs: number; jobs: number };
type RankCost = { taskId: string; title: string; costMicroUsd: number; jobs: number };
type DispatchStats = {
  from: string;
  to: string;
  projectId: string | null;
  roundCount: number;
  stepCount: number;
  firstPass: { passed: number; total: number; rate: number | null };
  rework: number;
  rejected: number;
  accepted: number;
  succeeded: number;
  failed: number;
  failureKinds: Record<(typeof FAILURE_KINDS)[number], number>;
  resources: {
    jobs: number;
    durationMs: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costMicroUsd: number;
    costJobs: number;
    noCostJobs: number;
    filesChanged: number;
    linesAdded: number;
    linesDeleted: number;
  };
  byNode: UsageGroup[];
  byProvider: UsageGroup[];
  byModel: UsageGroup[];
  top5ByDuration: RankDuration[];
  top5ByCost: RankCost[];
  legacy: { count: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; costMicroUsd: number; costJobs: number; durationMs: number };
  assistant: {
    runs: number;
    runsWithUsage: number;
    durationMs: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    byModel: UsageGroup[];
  };
};
type Project = { id: string; name: string };
type Mode = 'this' | 'last' | 'custom';

function formatRate(rate: number | null) {
  if (rate == null) return formatMissing();
  return new Intl.NumberFormat(intlLocale(), { style: 'percent', maximumFractionDigits: 1 }).format(rate);
}

function openTask(taskId: string) {
  window.dispatchEvent(new CustomEvent('dovun-open-task', { detail: { taskId } }));
}

function seededDispatchRange(rangeFrom?: string, rangeTo?: string) {
  const week = weekRange(new Date(), 0);
  const fallback = {
    mode: 'this' as const,
    fromDate: dateInputValue(week.from),
    toDate: dateInputValue(new Date(week.to.getFullYear(), week.to.getMonth(), week.to.getDate() - 1)),
  };
  if (!rangeFrom || !rangeTo || !/^\d{4}-\d{2}-\d{2}$/.test(rangeFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(rangeTo) || !customRange(rangeFrom, rangeTo)) return fallback;
  return { mode: 'custom' as const, fromDate: rangeFrom, toDate: rangeTo };
}

export function DispatchStatsView({ rangeFrom, rangeTo }: { rangeFrom?: string; rangeTo?: string } = {}) {
  const { t } = useTranslation('workspace');
  const { t: orchestration } = useTranslation('orchestration');
  const [seed] = useState(() => seededDispatchRange(rangeFrom, rangeTo));
  const [mode, setMode] = useState<Mode>(seed.mode);
  const [projectId, setProjectId] = useState('all');
  const [fromDate, setFromDate] = useState(seed.fromDate);
  const [toDate, setToDate] = useState(seed.toDate);
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') });
  const range = useMemo(() => {
    if (mode === 'this') return weekRange(new Date(), 0);
    if (mode === 'last') return weekRange(new Date(), -1);
    return customRange(fromDate, toDate);
  }, [mode, fromDate, toDate]);
  const stats = useQuery({
    queryKey: ['orchestration-stats', range?.from.toISOString() ?? '', range?.to.toISOString() ?? '', projectId],
    enabled: !!range,
    queryFn: () => {
      const params = new URLSearchParams({ from: range!.from.toISOString(), to: range!.to.toISOString() });
      if (projectId !== 'all') params.set('projectId', projectId);
      return api<DispatchStats>(`/api/orchestrations/stats?${params}`);
    },
  });
  const data = stats.data;
  const empty = !!data && data.roundCount === 0 && data.resources.jobs === 0 && data.legacy.count === 0 && data.assistant.runs === 0;
  const maxFailure = data ? Math.max(1, ...FAILURE_KINDS.map((kind) => data.failureKinds[kind] ?? 0)) : 1;
  const modeClass = (_selected: boolean) => 'shrink-0 px-3 py-1 text-sm';
  const groupLabel = (key: string) => key === 'unknown' ? t('runs.stats.unknown') : key;

  return <div className="space-y-4" data-testid="dispatch-stats">
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex gap-2 overflow-x-auto" role="group" aria-label={t('runs.tabStats')}>
        <Button variant="tab" size="bare" type="button" className={modeClass(mode === 'this')} onClick={() => setMode('this')}>{t('runs.thisWeek')}</Button>
        <Button variant="tab" size="bare" type="button" className={modeClass(mode === 'last')} onClick={() => setMode('last')}>{t('runs.lastWeek')}</Button>
        <Button variant="tab" size="bare" type="button" className={modeClass(mode === 'custom')} onClick={() => setMode('custom')}>{t('runs.custom')}</Button>
      </div>
      <Select value={projectId} onValueChange={setProjectId}>
        <SelectTrigger className="h-9 w-[11rem] rounded-xl text-sm" aria-label={t('runs.projectFilter')}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('runs.allProjects')}</SelectItem>
          {(projects.data ?? []).map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
    {mode === 'custom' && <div className="flex flex-wrap gap-2">
      <label className="space-y-1 text-xs text-muted-foreground">{t('runs.from')}<Input type="date" aria-label={t('runs.from')} value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
      <label className="space-y-1 text-xs text-muted-foreground">{t('runs.to')}<Input type="date" aria-label={t('runs.to')} value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
    </div>}
    {stats.isLoading && <p className="text-sm text-muted-foreground">{t('runs.stats.loading')}</p>}
    {stats.isError && <p role="alert" className="text-sm text-destructive">{stats.error.message}</p>}
    {!range && <p className="text-sm text-muted-foreground">{t('runs.statsEmpty')}</p>}
    {empty && <p className="py-8 text-sm text-muted-foreground">{t('runs.statsEmpty')}</p>}
    {data && !empty && <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Surface as="article" tone="subtle" className="rounded-xl border p-4" data-testid="stats-card-rounds">
          <p className="text-xs text-muted-foreground">{t('runs.stats.rounds')}</p>
          <p className="text-2xl font-semibold tabular-nums">{data.roundCount}</p>
          <p className="text-xs text-muted-foreground">{t('runs.stats.accepted', { n: data.accepted })}</p>
        </Surface>
        <Surface as="article" tone="subtle" className="rounded-xl border p-4">
          <p className="text-xs text-muted-foreground">{t('runs.stats.steps')}</p>
          <p className="text-2xl font-semibold tabular-nums">{data.stepCount}</p>
          <p className="text-xs text-muted-foreground">{t('runs.stats.outcome', { succeeded: data.succeeded, failed: data.failed })}</p>
        </Surface>
        <Surface as="article" tone="subtle" className="rounded-xl border p-4" data-testid="stats-card-pass">
          <p className="text-xs text-muted-foreground">{t('runs.stats.passRate')}</p>
          <p className="text-2xl font-semibold tabular-nums">{formatRate(data.firstPass.rate)}</p>
          <p className="text-xs text-muted-foreground">{t('runs.stats.passDetail', { passed: data.firstPass.passed, total: data.firstPass.total })}</p>
        </Surface>
        <Surface as="article" tone="subtle" className="rounded-xl border p-4">
          <p className="text-xs text-muted-foreground">{t('runs.stats.rework')}</p>
          <p className="text-2xl font-semibold tabular-nums">{data.rework}<span className="text-muted-foreground"> / </span><span data-testid="stats-rejected">{data.rejected}</span></p>
        </Surface>
        <Surface as="article" tone="subtle" className="rounded-xl border p-4">
          <p className="text-xs text-muted-foreground">{t('runs.stats.duration')}</p>
          <p className="text-2xl font-semibold">{formatDuration(data.resources.durationMs)}</p>
        </Surface>
        <Surface as="article" tone="subtle" className="rounded-xl border p-4">
          <p className="text-xs text-muted-foreground">{t('runs.stats.tokens')}</p>
          <p className="text-sm font-semibold">{t('runs.stats.tokenValue', { input: formatTokens(data.resources.inputTokens), output: formatTokens(data.resources.outputTokens) })}</p>
          <p className="text-xs text-muted-foreground">{t('runs.stats.cached', { cached: formatTokens(data.resources.cachedInputTokens) })}</p>
        </Surface>
        <Surface as="article" tone="subtle" className="rounded-xl border p-4">
          <p className="text-xs text-muted-foreground">{t('runs.stats.cost')}</p>
          <p className="text-2xl font-semibold">{data.resources.costJobs > 0 ? formatCost(data.resources.costMicroUsd) : formatMissing()}</p>
          {data.resources.noCostJobs > 0 && <p className="text-xs text-muted-foreground">{t('runs.stats.noCost', { n: data.resources.noCostJobs })}</p>}
        </Surface>
        <Surface as="article" tone="subtle" className="rounded-xl border p-4">
          <p className="text-xs text-muted-foreground">{t('runs.stats.diff')}</p>
          <p className="text-sm font-semibold">{formatDiff(data.resources.filesChanged, data.resources.linesAdded, data.resources.linesDeleted)}</p>
        </Surface>
      </div>
      <section className="space-y-2" data-testid="stats-failures">
        <h2 className="text-sm font-semibold">{t('runs.stats.failures')}</h2>
        <ul className="space-y-2">
          {FAILURE_KINDS.map((kind) => {
            const count = data.failureKinds[kind] ?? 0;
            const width = Math.round((count / maxFailure) * 100);
            return <li key={kind} className="grid grid-cols-[minmax(6rem,9rem)_1fr_2rem] items-center gap-2 text-xs">
              <span>{orchestration(`failureKind.${kind}`)}</span>
              <span className="h-2 overflow-hidden rounded-full bg-muted"><span className="block h-2 rounded-full bg-primary/20" style={{ width: `${width}%` }} /></span>
              <span className="text-right tabular-nums">{count}</span>
            </li>;
          })}
        </ul>
      </section>
      <div className="grid gap-4 lg:grid-cols-3">
        <GroupTable title={t('runs.stats.byNode')} rows={data.byNode} label={groupLabel} />
        <GroupTable title={t('runs.stats.byProvider')} rows={data.byProvider} label={groupLabel} />
        <GroupTable title={t('runs.stats.byModel')} rows={data.byModel} label={groupLabel} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-2" data-testid="stats-top-duration">
          <h2 className="text-sm font-semibold">{t('runs.stats.topDuration')}</h2>
          {data.top5ByDuration.length === 0 ? <p className="text-xs text-muted-foreground">{formatMissing()}</p> : <ol className="space-y-1 text-sm">
            {data.top5ByDuration.map((item) => <li key={item.taskId} className="flex items-center justify-between gap-3">
              <Button variant="link" size="bare" type="button" className="min-w-0 truncate text-left underline-offset-2 hover:underline" onClick={() => openTask(item.taskId)}>{item.title}</Button>
              <span className="shrink-0 text-xs text-muted-foreground">{formatDuration(item.durationMs)}</span>
            </li>)}
          </ol>}
        </section>
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">{t('runs.stats.topCost')}</h2>
          {data.top5ByCost.length === 0 ? <p className="text-xs text-muted-foreground">{formatMissing()}</p> : <ol className="space-y-1 text-sm">
            {data.top5ByCost.map((item) => <li key={item.taskId} className="flex items-center justify-between gap-3">
              <Button variant="link" size="bare" type="button" className="min-w-0 truncate text-left underline-offset-2 hover:underline" onClick={() => openTask(item.taskId)}>{item.title}</Button>
              <span className="shrink-0 text-xs text-muted-foreground">{formatCost(item.costMicroUsd)}</span>
            </li>)}
          </ol>}
        </section>
      </div>
      {data.assistant.runs > 0 && <Surface as="section" tone="subtle" className="rounded-xl border p-4 text-sm" data-testid="stats-assistant">
        <h2 className="text-sm font-semibold">{t('runs.stats.assistant')}</h2>
        <p className="text-xs text-muted-foreground">{t('runs.stats.assistantLine', {
          count: data.assistant.runs,
          tokens: formatTokens(data.assistant.inputTokens + data.assistant.outputTokens),
          cached: formatTokens(data.assistant.cachedInputTokens),
          duration: formatDuration(data.assistant.durationMs),
        })}</p>
        {data.assistant.byModel.length > 0 && <ul className="mt-2 space-y-1">
          {data.assistant.byModel.map((group) => <li key={group.key} className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate text-muted-foreground">{groupLabel(group.key)}</span>
            <span className="shrink-0 tabular-nums">{t('runs.stats.assistantModelLine', { count: group.jobs, tokens: formatTokens(group.inputTokens + group.outputTokens) })}</span>
          </li>)}
        </ul>}
        <p className="mt-1 text-xs text-muted-foreground">{t('runs.stats.noCostAssistant')}</p>
      </Surface>}
      <Surface as="section" tone="subtle" className="rounded-xl border p-4 text-sm">
        <h2 className="text-sm font-semibold">{t('runs.stats.legacy')}</h2>
        <p className="text-xs text-muted-foreground">{t('runs.stats.legacyLine', {
          count: data.legacy.count,
          tokens: formatTokens(data.legacy.inputTokens + data.legacy.outputTokens),
          cost: data.legacy.costJobs > 0 ? formatCost(data.legacy.costMicroUsd) : formatMissing(),
          duration: formatDuration(data.legacy.durationMs),
        })}</p>
      </Surface>
    </>}
  </div>;
}

function GroupTable({ title, rows, label }: { title: string; rows: UsageGroup[]; label: (key: string) => string }) {
  const { t } = useTranslation('workspace');
  return <section className="space-y-2">
    <h2 className="text-sm font-semibold">{title}</h2>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] text-left text-xs">
        <thead className="text-muted-foreground">
          <TableRow>
            <th className="py-1 pr-2 font-medium">{t('runs.stats.column')}</th>
            <th className="py-1 pr-2 font-medium">{t('runs.stats.jobs')}</th>
            <th className="py-1 pr-2 font-medium">{t('runs.stats.duration')}</th>
            <th className="py-1 pr-2 font-medium">{t('runs.stats.tokens')}</th>
            <th className="py-1 font-medium">{t('runs.stats.cost')}</th>
          </TableRow>
        </thead>
        <tbody>
          {rows.length === 0 && <TableRow><td className="py-2 text-muted-foreground" colSpan={5}>{formatMissing()}</td></TableRow>}
          {rows.map((row) => <TableRow key={row.key} className="border-t">
            <td className="py-1 pr-2">{label(row.key)}</td>
            <td className="py-1 pr-2 tabular-nums">{row.jobs}</td>
            <td className="py-1 pr-2">{formatDuration(row.durationMs)}</td>
            <td className="py-1 pr-2">{formatTokens(row.inputTokens + row.outputTokens)}</td>
            <td className="py-1">{formatCost(row.costMicroUsd)}</td>
          </TableRow>)}
        </tbody>
      </table>
    </div>
  </section>;
}
