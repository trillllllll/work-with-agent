import { useTranslation } from 'react-i18next';
import { formatTokens } from '@/components/orchestration/format.js';
import type { StatsAssistantUsageSection, StatsRangeInfo, StatsSectionError } from '@/lib/api.js';
import { chartState, eachDate, isSectionError, shortMonthDay } from '@/lib/stats-range.js';
import { valuesByDate } from '../charts/scale.js';
import { LineChart } from '../charts/LineChart.js';
import { HBarList } from '../charts/HBarList.js';
import { Delta, MiniStat, Panel, SectionError, SectionFrame } from '../SectionShell.js';

const identityColors = ['var(--tag-violet-fg)', 'var(--tag-blue-fg)', 'var(--tag-teal-fg)'];

export function AssistantUsageSection({ data, range, onRetry }: { data: StatsAssistantUsageSection | StatsSectionError; range: StatsRangeInfo; onRetry: () => void }) {
  const { t } = useTranslation('stats');
  if (isSectionError(data)) return <SectionError id="assistant" title={t('aiUsage.title')} message={data.error.message} onRetry={onRetry} />;
  const memoryJobs = data.memoryJobs;
  // No chat in this window (and no background extraction): keep the page quiet.
  if (data.totals.runs.value === 0 && (memoryJobs?.jobs ?? 0) === 0) return null;
  const dates = eachDate(range.from, range.to);
  const daily = valuesByDate(dates, data.byDay, (row) => row.inputTokens + row.outputTokens);
  const trend = chartState(daily);
  const identityLabel = (key: string) => t(key === 'study' ? 'aiUsage.identityStudy' : 'aiUsage.identityWork');
  const missingUsage = Math.max(0, data.totals.runs.value - data.totals.runsWithUsage);
  const identityRows = data.byIdentity.map((group, index) => ({
    id: group.key,
    label: identityLabel(group.key),
    value: group.inputTokens + group.outputTokens,
    color: identityColors[index % identityColors.length],
    meta: t('aiUsage.groupMeta', { count: group.runs, tokens: formatTokens(group.inputTokens + group.outputTokens) }),
  }));

  return (
    <SectionFrame id="assistant" title={t('aiUsage.title')} summary={t('aiUsage.summary', { count: data.totals.runs.value, tokens: formatTokens(data.totals.inputTokens.value + data.totals.outputTokens.value) })}>
      <div className="grid min-w-0 gap-4 lg:grid-cols-3">
        <Panel className="space-y-3">
          <h3 className="text-sm font-medium">{t('aiUsage.requests')}</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <MiniStat label={t('aiUsage.requests')} value={String(data.totals.runs.value)} />
            <MiniStat label={t('aiUsage.input')} value={formatTokens(data.totals.inputTokens.value)} />
            <MiniStat label={t('aiUsage.output')} value={formatTokens(data.totals.outputTokens.value)} />
            <MiniStat label={t('aiUsage.cached')} value={formatTokens(data.totals.cachedInputTokens)} />
          </div>
          <Delta current={data.totals.runs.value} previous={data.totals.runs.previous} />
          {missingUsage > 0 && <p className="text-xs text-muted-foreground">{t('aiUsage.usageNote', { count: missingUsage })}</p>}
        </Panel>
        <Panel className="space-y-3">
          <h3 className="text-sm font-medium">{t('aiUsage.byIdentity')}</h3>
          {identityRows.length === 0 ? <p className="text-sm text-muted-foreground">{t('section.noData')}</p> : <HBarList rows={identityRows} />}
          {memoryJobs && memoryJobs.jobs > 0 && (
            <p className="text-xs text-muted-foreground">{t('aiUsage.memoryJobs', { count: memoryJobs.jobs, failed: memoryJobs.failed, input: formatTokens(memoryJobs.inputTokens), output: formatTokens(memoryJobs.outputTokens) })}</p>
          )}
        </Panel>
        <Panel className="space-y-3">
          <h3 className="text-sm font-medium">{t('aiUsage.daily')}</h3>
          {trend === 'ready' ? (
            <LineChart
              values={daily}
              ariaLabel={t('aiUsage.lineLabel')}
              tooltip={(index) => t('chart.point', { date: shortMonthDay(dates[index] ?? ''), value: daily[index] ?? 0 })}
            />
          ) : <p className="text-xs text-muted-foreground" data-testid="stats-sparse">{t('sparseTrend')}</p>}
        </Panel>
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Panel className="space-y-3">
          <h3 className="text-sm font-medium">{t('aiUsage.byModel')}</h3>
          {data.byModel.length === 0 ? <p className="text-sm text-muted-foreground">{t('section.noData')}</p> : (
            <ul className="space-y-2">
              {data.byModel.map((row) => (
                <li key={row.key} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{row.key}</span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{t('aiUsage.modelMeta', { count: row.runs, input: formatTokens(row.inputTokens), output: formatTokens(row.outputTokens) })}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel className="space-y-3">
          <h3 className="text-sm font-medium">{t('aiUsage.topConversations')}</h3>
          {data.topConversations.length === 0 ? <p className="text-sm text-muted-foreground">{t('section.noData')}</p> : (
            <ul className="space-y-2">
              {data.topConversations.map((row) => (
                <li key={row.conversationId} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{row.title ?? t('aiUsage.unnamedConversation', { id: row.conversationId.slice(-6) })}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{t('aiUsage.groupMeta', { count: row.runs, tokens: formatTokens(row.inputTokens + row.outputTokens) })}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </SectionFrame>
  );
}
