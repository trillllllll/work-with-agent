import { useTranslation } from 'react-i18next';
import type { StatsRangeInfo, StatsSectionError, StatsTasksSection } from '@/lib/api.js';
import { chartState, combineActivity, eachDate, isSectionError, shortMonthDay } from '@/lib/stats-range.js';
import { valuesByDate } from '../charts/scale.js';
import { BarChart } from '../charts/BarChart.js';
import { HBarList } from '../charts/HBarList.js';
import { tagColor } from '../colors.js';
import { ChartPlaceholder, Legend, Panel, SectionError, SectionFrame, type StatsNav } from '../SectionShell.js';

export function TasksSection({ data, range, nav, onRetry }: { data: StatsTasksSection | StatsSectionError; range: StatsRangeInfo; nav: StatsNav; onRetry: () => void }) {
  const { t } = useTranslation('stats');
  if (isSectionError(data)) return <SectionError id="tasks" title={t('tasks.title')} message={data.error.message} onRetry={onRetry} />;
  const dates = eachDate(range.from, range.to);
  const completed = valuesByDate(dates, data.completedByDay, (row) => row.count);
  const created = valuesByDate(dates, data.createdByDay, (row) => row.count);
  const estimated = valuesByDate(dates, data.completedByDay, (row) => row.estimated);
  const state = chartState(combineActivity([completed, created]));
  const showEstimate = data.estimatedCount.value > 0;
  const topics = [...data.byTopic].sort((a, b) => b.count - a.count);
  const tags = [...data.byTag].sort((a, b) => b.count - a.count);

  return (
    <SectionFrame
      id="tasks"
      title={t('tasks.title')}
      summary={t('tasks.summary', { completed: data.completed.value, created: data.created.value, overdue: data.overdue })}
      link={{ label: t('tasks.link'), onClick: () => nav.go('#/search') }}
    >
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel className="space-y-3">
          <h3 className="text-sm font-medium">{t('tasks.trend')}</h3>
          {state === 'ready' ? (
            <BarChart
              dates={dates}
              today={range.today}
              ariaLabel={t('tasks.chartLabel', { completed: data.completed.value, created: data.created.value })}
              tick={(value) => String(Math.round(value))}
              series={[{ id: 'completed', values: completed, color: 'var(--tag-blue-fg)', hatch: showEstimate ? estimated : undefined }]}
              line={{ values: created, color: 'var(--muted-foreground)' }}
              tooltip={(index) => t('chart.point', {
                date: shortMonthDay(dates[index] ?? ''),
                value: showEstimate && (estimated[index] ?? 0) > 0
                  ? t('tasks.tipEstimated', { completed: completed[index] ?? 0, created: created[index] ?? 0, estimated: estimated[index] ?? 0 })
                  : t('tasks.tip', { completed: completed[index] ?? 0, created: created[index] ?? 0 }),
              })}
            />
          ) : <ChartPlaceholder state={state} />}
          <Legend items={[
            { label: t('tasks.legendDone'), color: 'var(--tag-blue-fg)' },
            { label: t('tasks.legendCreated'), color: 'var(--muted-foreground)', swatch: 'line' },
            ...(showEstimate ? [{ label: t('tasks.legendEstimated'), color: 'var(--tag-blue-fg)', swatch: 'hatch' as const }] : []),
          ]} />
          {showEstimate && <p className="text-xs text-muted-foreground">{t('tasks.estimated', { count: data.estimatedCount.value })}</p>}
          <p className="text-xs text-muted-foreground">{t('tasks.completedNote')}</p>
        </Panel>
        <Panel className="space-y-3">
          <h3 className="text-sm font-medium">{t('tasks.overdueTitle')}</h3>
          {data.overdueTop.length === 0 ? <p className="text-sm text-muted-foreground">{t('tasks.overdueEmpty')}</p> : (
            <ul className="space-y-2">
              {data.overdueTop.map((item) => (
                <li key={item.id}>
                  <button type="button" className="flex w-full items-center gap-2 text-left text-sm" onClick={() => nav.go('#/today')}>
                    <span className="size-2 shrink-0 rounded-full" style={{ background: tagColor(item.topicColor) }} />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">{t('tasks.overdueBadge', { count: item.days })}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="text-sm text-muted-foreground underline-offset-4 hover:underline" onClick={() => nav.go('#/today')}>{t('tasks.overdueLink')}</button>
        </Panel>
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Panel className="space-y-3">
          <h3 className="text-sm font-medium">{t('tasks.byTopic')}</h3>
          {topics.length === 0 ? <p className="text-sm text-muted-foreground">{t('section.noData')}</p> : (
            <HBarList rows={topics.map((topic) => ({
              id: topic.topicId ?? 'inbox',
              label: topic.name ?? t('tasks.inbox'),
              value: topic.count,
              color: tagColor(topic.color),
              onClick: () => nav.openTopic(topic.topicId),
            }))} />
          )}
        </Panel>
        <Panel className="space-y-3">
          <h3 className="text-sm font-medium">{t('tasks.byTag')}</h3>
          {tags.length === 0 ? <p className="text-sm text-muted-foreground">{t('section.noData')}</p> : (
            <HBarList rows={tags.map((tag) => ({
              id: tag.tagId,
              label: tag.name,
              value: tag.count,
              color: tagColor(tag.color),
              onClick: () => nav.go('#/tags'),
            }))} />
          )}
          <p className="text-xs text-muted-foreground">{t('tasks.tagNote')}</p>
        </Panel>
      </div>
    </SectionFrame>
  );
}
