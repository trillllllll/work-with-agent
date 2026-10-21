import { useTranslation } from 'react-i18next';
import type { StatsPlanSection, StatsRangeInfo, StatsSectionError } from '@/lib/api.js';
import { chartState, combineActivity, eachDate, isSectionError, percentNumber, shortMonthDay } from '@/lib/stats-range.js';
import { formatMinuteLabel } from '@/lib/plan-time-bands.js';
import { formatAxisTick, valuesByDate } from '../charts/scale.js';
import { ColumnChart } from '../charts/BarChart.js';
import { StackedBarChart } from '../charts/StackedBarChart.js';
import { bandColor } from '../colors.js';
import { ChartPlaceholder, dash, durationText, Legend, Panel, SectionError, SectionFrame, type StatsNav } from '../SectionShell.js';

const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

function formatWeekdays(days: number[] | null, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (!days || days.length === 0) return '';
  const unique = [...new Set(days)].filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b);
  if (unique.length === 7) return t('plan.everyDay');
  const groups: number[][] = [];
  for (const day of unique) {
    const last = groups[groups.length - 1];
    if (last && day === last[last.length - 1] + 1) last.push(day);
    else groups.push([day]);
  }
  return groups.map((group) => {
    const names = group.map((day) => t(`plan:weekday.${weekdayKeys[day - 1]}.short`));
    if (group.length >= 3) return t('plan.dayRange', { from: names[0], to: names[names.length - 1] });
    return names.join(t('plan.dayJoin'));
  }).join(t('plan.dayJoin'));
}

export function PlanSection({ data, range, nav, onRetry }: { data: StatsPlanSection | StatsSectionError; range: StatsRangeInfo; nav: StatsNav; onRetry: () => void }) {
  const { t } = useTranslation('stats');
  if (isSectionError(data)) return <SectionError id="plan" title={t('plan.title')} message={data.error.message} onRetry={onRetry} />;
  const dates = eachDate(range.from, range.to);
  const onTime = valuesByDate(dates, data.byDay, (row) => row.doneOnPlan);
  const late = valuesByDate(dates, data.byDay, (row) => row.doneLate);
  const miss = valuesByDate(dates, data.byDay, (row) => row.notDone);
  const planned = valuesByDate(dates, data.byDay, (row) => row.plannedMinutes);
  const focused = valuesByDate(dates, data.byDay, (row) => row.focusMinutes);
  const stackedState = chartState(combineActivity([onTime, late, miss]));
  const pairState = chartState(combineActivity([planned, focused]));
  const asHours = Math.max(0, ...planned, ...focused) >= 60;
  const rate = percentNumber(data.onPlanRate.value);

  return (
    <SectionFrame
      id="plan"
      title={t('plan.title')}
      summary={t('plan.summary', {
        planned: data.plannedTasks.value,
        percent: rate == null ? dash : `${rate}%`,
        plannedDuration: durationText(data.plannedMinutesTotal.value, t),
        focusDuration: durationText(data.focusMinutesTotal.value, t),
      })}
      link={{ label: t('plan.link'), onClick: () => nav.go('#/plan') }}
    >
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-4">
          <Panel className="space-y-3">
            <h3 className="text-sm font-medium">{t('plan.stacked')}</h3>
            {stackedState === 'ready' ? (
              <StackedBarChart
                dates={dates}
                today={range.today}
                ariaLabel={t('plan.chartLabel')}
                tick={(value) => String(Math.round(value))}
                series={[
                  { id: 'onTime', values: onTime, color: 'var(--success)' },
                  { id: 'late', values: late, color: 'var(--warning)' },
                  { id: 'miss', values: miss, color: 'color-mix(in oklab, var(--foreground) 35%, transparent)' },
                ]}
                tooltip={(index) => t('chart.point', {
                  date: shortMonthDay(dates[index] ?? ''),
                  value: t('plan.dayTip', { onTime: onTime[index] ?? 0, late: late[index] ?? 0, miss: miss[index] ?? 0 }),
                })}
              />
            ) : <ChartPlaceholder state={stackedState} />}
            <Legend items={[
              { label: t('plan.onTime'), color: 'var(--success)' },
              { label: t('plan.late'), color: 'var(--warning)' },
              { label: t('plan.miss'), color: 'color-mix(in oklab, var(--foreground) 35%, transparent)' },
            ]} />
          </Panel>
          <Panel className="space-y-3">
            <h3 className="text-sm font-medium">{t('plan.pair')}</h3>
            {pairState === 'ready' ? (
              <ColumnChart
                mode="group"
                dates={dates}
                today={range.today}
                ariaLabel={t('plan.pairLabel')}
                tick={(value) => formatAxisTick(asHours ? value / 60 : value)}
                tickUnit={asHours ? 60 : 1}
                series={[
                  { id: 'planned', values: planned, color: 'var(--tag-blue-fg)' },
                  { id: 'focus', values: focused, color: 'var(--success)' },
                ]}
                tooltip={(index) => t('chart.point', {
                  date: shortMonthDay(dates[index] ?? ''),
                  value: t('plan.pairTip', { planned: durationText(planned[index] ?? 0, t), focus: durationText(focused[index] ?? 0, t) }),
                })}
              />
            ) : <ChartPlaceholder state={pairState} />}
            <Legend items={[
              { label: t('plan.planned'), color: 'var(--tag-blue-fg)' },
              { label: t('plan.focused'), color: 'var(--success)' },
            ]} />
          </Panel>
        </div>
        <Panel className="space-y-3">
          <h3 className="text-sm font-medium">{t('plan.byBand')}</h3>
          {data.byBand.length === 0 ? <p className="text-sm text-muted-foreground">{t('section.noData')}</p> : (
            <ul className="space-y-3">
              {data.byBand.map((band, index) => {
                const ungrouped = band.id == null && band.name == null;
                const width = band.plannedMinutes <= 0 ? (band.focusMinutes > 0 ? 100 : 0) : Math.min(100, (band.focusMinutes / band.plannedMinutes) * 100);
                const days = formatWeekdays(band.weekdays, t);
                const time = band.startMinute == null || band.endMinute == null ? '' : `${formatMinuteLabel(band.startMinute)}-${formatMinuteLabel(band.endMinute)}`;
                const schedule = [days, time].filter(Boolean).join(' ');
                const color = ungrouped ? bandColor('slate') : bandColor(band.color);
                return (
                  <li key={band.id ?? `band-${index}`} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate">{band.name ?? t('plan.ungrouped')}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{durationText(band.focusMinutes, t)} / {durationText(band.plannedMinutes, t)}</span>
                    </div>
                    {schedule && <p className="text-xs text-muted-foreground">{schedule}</p>}
                    <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--muted)' }}>
                      <div className="h-full rounded-full" style={{ width: `${width}%`, background: color }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{t('plan.note')}</p>
        </Panel>
      </div>
    </SectionFrame>
  );
}
