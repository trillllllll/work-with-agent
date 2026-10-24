import { Button } from '@/components/ui/button.js';
import { useTranslation } from 'react-i18next';
import { relativeTime } from '@/components/workspace/memory-view.js';
import type { StatsAiSection, StatsRangeInfo, StatsSectionError } from '@/lib/api.js';
import { chartState, eachDate, formatUsd, isSectionError, percentNumber, shortMonthDay } from '@/lib/stats-range.js';
import { valuesByDate } from '../charts/scale.js';
import { DonutChart } from '../charts/DonutChart.js';
import { HeatCells } from '../charts/HeatCells.js';
import { LineChart } from '../charts/LineChart.js';
import { dash, Delta, Legend, Panel, SectionError, SectionFrame, type StatsNav } from '../SectionShell.js';

export function AiSection({ data, range, nav, onRetry }: { data: StatsAiSection | StatsSectionError; range: StatsRangeInfo; nav: StatsNav; onRetry: () => void }) {
  const { t } = useTranslation('stats');
  if (isSectionError(data)) return <SectionError id="ai" title={t('ai.title')} message={data.error.message} onRetry={onRetry} />;
  const dates = eachDate(range.from, range.to);
  const rounds = valuesByDate(dates, data.dispatch.byDay, (row) => row.rounds);
  const trend = chartState(rounds);
  const proposals = data.proposals;
  const adopted = proposals.executed.value;
  const rejected = proposals.rejected.value;
  const pending = proposals.pending;
  const failed = proposals.failed.value;
  const total = adopted + rejected + pending + failed;
  const rate = percentNumber(proposals.adoptionRate.value);
  const rateLabel = rate == null ? dash : `${rate}%`;
  const originTotal = data.memories.byOrigin.ai + data.memories.byOrigin.manual;
  const aiShare = originTotal === 0 ? 0 : (data.memories.byOrigin.ai / originTotal) * 100;
  const runs = `#/runs?tab=stats&from=${range.from}&to=${range.to}`;
  const segments = [
    { id: 'adopted', value: adopted, color: 'var(--success)', label: t('ai.adopted') },
    { id: 'rejected', value: rejected, color: 'var(--destructive)', label: t('ai.rejected') },
    { id: 'pending', value: pending, color: 'var(--warning)', label: t('ai.pending') },
    { id: 'failed', value: failed, color: 'color-mix(in oklab, var(--foreground) 35%, transparent)', label: t('ai.failed') },
  ];

  return (
    <SectionFrame
      id="ai"
      title={t('ai.title')}
      summary={t('ai.summary', { created: proposals.created.value, rate: rateLabel, rounds: data.dispatch.rounds.value })}
    >
      <div className="grid min-w-0 gap-4 lg:grid-cols-3">
        <Panel className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{t('ai.adoption')}</h3>
            <Button variant="link" size="bare" type="button" className="text-sm text-muted-foreground underline-offset-4 hover:underline" onClick={() => nav.go('#/proposals')}>{t('ai.proposalsLink')}</Button>
          </div>
          {total === 0 ? <p className="text-sm text-muted-foreground">{t('section.noData')}</p> : (
            <div className="flex items-center gap-4">
              <DonutChart segments={segments} center={rateLabel} ariaLabel={t('ai.chartLabel', { executed: adopted, rejected, pending, failed })} />
              <Legend items={segments.map((item) => ({ label: `${item.label} ${item.value}`, color: item.color }))} />
            </div>
          )}
          {proposals.bySource.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('ai.sources')}{t('chart.join')}
              {proposals.bySource.map((item) => `${t(`ai.source.${item.source}`, { defaultValue: item.source })} ${item.count}`).join(t('chart.join'))}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t('ai.rateNote')}</p>
        </Panel>
        <Panel className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{t('ai.memory')}</h3>
            <Button variant="link" size="bare" type="button" className="text-sm text-muted-foreground underline-offset-4 hover:underline" onClick={() => nav.go('#/knowledge')}>{t('ai.knowledgeLink')}</Button>
          </div>
          <p className="text-2xl font-semibold tabular-nums">{t('ai.memoryAdded', { count: data.memories.created.value })}</p>
          <Delta current={data.memories.created.value} previous={data.memories.created.previous} />
          <p className="text-xs text-muted-foreground">{t('ai.memoryRetired', { count: data.memories.retired.value })}</p>
          <div className="flex h-2 overflow-hidden rounded-full" style={{ background: 'var(--muted)' }}>
            {originTotal > 0 && (
              <>
                <div style={{ width: `${aiShare}%`, background: 'var(--tag-violet-fg)' }} />
                <div style={{ width: `${100 - aiShare}%`, background: 'var(--muted-foreground)' }} />
              </>
            )}
          </div>
          <Legend items={[
            { label: `${t('ai.memoryAi')} ${data.memories.byOrigin.ai}`, color: 'var(--tag-violet-fg)' },
            { label: `${t('ai.memoryManual')} ${data.memories.byOrigin.manual}`, color: 'var(--muted-foreground)' },
          ]} />
          <p className="text-xs text-muted-foreground">{t('ai.autoMemory', { jobs: data.autoMemory.jobs.value, failed: data.autoMemory.failed.value })}</p>
        </Panel>
        <Panel className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{t('ai.dispatch')}</h3>
            <Button variant="link" size="bare" type="button" className="text-sm text-muted-foreground underline-offset-4 hover:underline" onClick={() => nav.go(runs)}>{t('ai.runsLink')}</Button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <p className="text-xs text-muted-foreground">{t('ai.rounds')}</p>
              <p className="text-xl font-semibold tabular-nums">{data.dispatch.rounds.value}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('ai.firstPass')}</p>
              <p className="text-xl font-semibold tabular-nums">{percentNumber(data.dispatch.firstPassRate.value) == null ? dash : `${percentNumber(data.dispatch.firstPassRate.value)}%`}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('ai.cost')}</p>
              <p className="text-xl font-semibold tabular-nums">{formatUsd(data.dispatch.costMicroUsd.value)}</p>
            </div>
          </div>
          <Delta current={data.dispatch.rounds.value} previous={data.dispatch.rounds.previous} />
          {trend === 'ready' ? (
            <LineChart
              values={rounds}
              ariaLabel={t('ai.lineLabel')}
              tooltip={(index) => t('chart.point', { date: shortMonthDay(dates[index] ?? ''), value: rounds[index] ?? 0 })}
            />
          ) : trend === 'sparse' ? <p className="text-xs text-muted-foreground" data-testid="stats-sparse">{t('sparseTrend')}</p> : null}
          <p className="text-xs text-muted-foreground">{t('ai.dispatchNote')}</p>
        </Panel>
      </div>
      <Panel className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t('ai.connections')}</h3>
          <Button variant="link" size="bare" type="button" className="text-sm text-muted-foreground underline-offset-4 hover:underline" onClick={() => nav.go('#/connections')}>{t('app:nav.connections')}</Button>
        </div>
        {data.connections.length === 0 ? <p className="text-sm text-muted-foreground">{t('ai.noConnections')}</p> : (
          <ul className="space-y-3">
            {data.connections.map((connection) => (
              <li key={connection.id} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                <Button variant="row" size="bare" type="button" className="min-w-0 flex-1 basis-40 truncate text-left text-sm" onClick={() => nav.go('#/connections')}>
                  {[connection.name, connection.host].filter(Boolean).join(t('chart.join'))}
                </Button>
                <HeatCells days={connection.byDay} label={t('ai.heatLabel', { name: connection.name })} />
                <span className="shrink-0 text-xs sm:w-32 sm:text-right text-muted-foreground tabular-nums">{[t('ai.writes', { count: connection.writes }), t('ai.proposalsCount', { count: connection.proposals })].join(t('chart.join'))}</span>
                <span className="ml-auto shrink-0 text-right text-xs text-muted-foreground sm:ml-0 sm:w-16">{relativeTime(connection.lastActiveAt ?? undefined)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t('ai.heatNote')}</p>
      </Panel>
    </SectionFrame>
  );
}
