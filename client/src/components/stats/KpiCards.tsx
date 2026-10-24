import { Button } from '@/components/ui/button.js';
import { useTranslation } from 'react-i18next';
import type { StatsAiSection, StatsFocusSection, StatsOverview, StatsPlanSection, StatsTasksSection } from '@/lib/api.js';
import { isSectionError, percentNumber } from '@/lib/stats-range.js';
import { cn } from '@/lib/utils.js';
import { compactDuration, dash, Delta, type StatsNav } from './SectionShell.js';

function percentText(rate: number | null | undefined) {
  const value = percentNumber(rate);
  return value == null ? dash : `${value}%`;
}

export function KpiCards({ data, quiet, nav }: { data: StatsOverview; quiet?: boolean; nav: StatsNav }) {
  const { t } = useTranslation('stats');
  const tasks = isSectionError(data.tasks) ? null : data.tasks as StatsTasksSection;
  const focus = isSectionError(data.focus) ? null : data.focus as StatsFocusSection;
  const plan = isSectionError(data.plan) ? null : data.plan as StatsPlanSection;
  const ai = isSectionError(data.ai) ? null : data.ai as StatsAiSection;
  const runs = `#/runs?tab=stats&from=${data.range.from}&to=${data.range.to}`;
  const decided = (ai?.proposals.executed.value ?? 0) + (ai?.proposals.rejected.value ?? 0);

  const cards: { id: string; label: string; value: string; hint: string; delta: { current: number | null; previous: number | null } | null; tone?: string; hash: string }[] = [
    {
      id: 'completed',
      label: t('kpi.completed'),
      value: quiet || !tasks ? dash : String(tasks.completed.value),
      hint: quiet || !tasks ? t('kpi.none') : '',
      delta: quiet || !tasks ? null : { current: tasks.completed.value, previous: tasks.completed.previous },
      hash: '#/search',
    },
    {
      id: 'overdue',
      label: t('kpi.overdue'),
      value: quiet || !tasks ? dash : String(tasks.overdue),
      hint: quiet || !tasks ? t('kpi.none') : tasks.overdue > 0 ? t('kpi.overdueOldest', { count: tasks.overdueOldestDays }) : t('kpi.overdueClear'),
      delta: null,
      tone: !quiet && tasks && tasks.overdue > 0 ? 'text-destructive' : undefined,
      hash: '#/today',
    },
    {
      id: 'focus',
      label: t('kpi.focus'),
      value: quiet || !focus ? dash : compactDuration(focus.minutes.value, t),
      hint: quiet || !focus ? t('kpi.none') : t('kpi.focusSessions', { count: focus.sessions.value }),
      delta: quiet || !focus ? null : { current: focus.minutes.value, previous: focus.minutes.previous },
      hash: '#/focus',
    },
    {
      id: 'onplan',
      label: t('kpi.onPlan'),
      value: quiet || !plan ? dash : percentText(plan.onPlanRate.value),
      hint: quiet || !plan ? t('kpi.none') : t('kpi.onPlanDetail', { done: plan.doneOnPlanTasks.value, planned: plan.plannedTasks.value }),
      delta: quiet || !plan ? null : { current: plan.onPlanRate.value, previous: plan.onPlanRate.previous },
      hash: '#/plan',
    },
    {
      id: 'adoption',
      label: t('kpi.adoption'),
      value: quiet || !ai ? dash : percentText(ai.proposals.adoptionRate.value),
      hint: quiet || !ai ? t('kpi.none') : t('kpi.adoptionDetail', { executed: ai.proposals.executed.value, decided, pending: ai.proposals.pending }),
      delta: quiet || !ai ? null : { current: ai.proposals.adoptionRate.value, previous: ai.proposals.adoptionRate.previous },
      hash: '#/proposals',
    },
    {
      id: 'dispatch',
      label: t('kpi.dispatch'),
      value: quiet || !ai ? dash : String(ai.dispatch.rounds.value),
      hint: quiet || !ai ? t('kpi.none') : ai.dispatch.firstPassRate.value == null ? t('kpi.dispatchDetailNone') : t('kpi.dispatchDetail', { percent: percentNumber(ai.dispatch.firstPassRate.value) }),
      delta: quiet || !ai ? null : { current: ai.dispatch.rounds.value, previous: ai.dispatch.rounds.previous },
      hash: runs,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
      {cards.map((card) => (
        <Button variant="card" size="bare" key={card.id} type="button" data-testid={`stats-kpi-${card.id}`} onClick={() => nav.go(card.hash)} className="min-w-0 rounded-xl p-3 text-left">
          <p className="truncate text-xs text-muted-foreground">{card.label}</p>
          <p className={cn('mt-1 text-2xl font-semibold tabular-nums', card.tone)}>{card.value}</p>
          {card.hint && <p className="mt-1 truncate text-xs text-muted-foreground">{card.hint}</p>}
          {card.delta && <p className="mt-1"><Delta current={card.delta.current} previous={card.delta.previous} /></p>}
        </Button>
      ))}
    </div>
  );
}
