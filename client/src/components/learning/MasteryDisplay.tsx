import { useTranslation } from 'react-i18next';
import { getMastery, masteryStates } from './learning-model.js';
export function MasteryBadge({ status }: { status: string }) {
  const { t } = useTranslation('learning');
  const state = getMastery({ status });
  return <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs" style={{ color: `var(${state.color})` }}><span aria-hidden="true">{state.symbol}</span>{t(`status.${state.id}`)}</span>;
}
export function MasteryLegend() {
  return <div className="flex flex-wrap gap-x-4 gap-y-2">{masteryStates.map(state => <MasteryBadge key={state.id} status={state.id} />)}</div>;
}
