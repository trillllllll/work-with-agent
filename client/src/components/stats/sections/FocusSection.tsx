import { useTranslation } from 'react-i18next';
import type { StatsFocusSection, StatsRangeInfo, StatsSectionError } from '@/lib/api.js';
import { chartState, eachDate, isSectionError, percentNumber, shortMonthDay } from '@/lib/stats-range.js';
import { formatAxisTick, valuesByDate } from '../charts/scale.js';
import { BarChart } from '../charts/BarChart.js';
import { HBarList } from '../charts/HBarList.js';
import { ChartPlaceholder, compactDuration, dash, durationText, MiniStat, Panel, SectionError, SectionFrame, type StatsNav } from '../SectionShell.js';

export function FocusSection({ data, range, nav, onRetry }: { data: StatsFocusSection | StatsSectionError; range: StatsRangeInfo; nav: StatsNav; onRetry: () => void }) {
  const { t } = useTranslation('stats');
  if (isSectionError(data)) return <SectionError id="focus" title={t('focus.title')} message={data.error.message} onRetry={onRetry} />;
  const dates = eachDate(range.from, range.to);
  const minutes = valuesByDate(dates, data.minutesByDay, (row) => row.minutes);
  const state = chartState(minutes);
  const asHours = Math.max(0, ...minutes) >= 60;
  const dailyAverage = dates.length > 0 ? data.minutes.value / dates.length : 0;
  const rate = percentNumber(data.completionRate.value);

  return (
    <SectionFrame
      id="focus"
      title={t('focus.title')}
      summary={t('focus.summary', { duration: durationText(data.minutes.value, t), sessions: data.sessions.value, average: durationText(dailyAverage, t) })}
      link={{ label: t('focus.link'), onClick: () => nav.go('#/focus') }}
    >
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel className="space-y-3">
          <h3 className="text-sm font-medium">{t('focus.daily')}</h3>
          {state === 'ready' ? (
            <BarChart
              dates={dates}
              today={range.today}
              ariaLabel={t('focus.chartLabel', { duration: durationText(data.minutes.value, t) })}
              series={[{ id: 'minutes', values: minutes, color: 'var(--success)' }]}
              tick={(value) => formatAxisTick(asHours ? value / 60 : value)}
              tooltip={(index) => t('chart.point', { date: shortMonthDay(dates[index] ?? ''), value: durationText(minutes[index] ?? 0, t) })}
            />
          ) : <ChartPlaceholder state={state} />}
          <div className="grid grid-cols-3 gap-2 border-t pt-3">
            <MiniStat label={t('focus.sessionsLabel')} value={String(data.sessions.value)} />
            <MiniStat label={t('focus.average')} value={data.avgSession.value == null ? dash : compactDuration(data.avgSession.value, t)} />
            <MiniStat label={t('focus.completeRate')} value={rate == null ? dash : `${rate}%`} />
          </div>
        </Panel>
        <Panel className="space-y-3">
          <h3 className="text-sm font-medium">{t('focus.byTask')}</h3>
          {data.byTask.length === 0 ? <p className="text-sm text-muted-foreground">{t('section.noData')}</p> : (
            <HBarList rows={data.byTask.map((task, index) => ({
              id: task.taskId ?? `free-${index}`,
              label: task.title ?? t('focus.free'),
              value: task.minutes,
              color: task.taskId ? 'var(--success)' : 'var(--muted-foreground)',
              meta: t('focus.taskMeta', { duration: durationText(task.minutes, t), count: task.sessions }),
              onClick: task.taskId ? () => nav.openTask(task.taskId as string) : undefined,
            }))} />
          )}
          <p className="text-xs text-muted-foreground">{t('focus.freeNote')}</p>
        </Panel>
      </div>
    </SectionFrame>
  );
}
