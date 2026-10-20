import type { TaskPriority } from './api.js';
import { t } from '../i18n/index.js';

const quadrantTones: Record<TaskPriority, string> = {
  high: 'border-rose-500/70',
  medium: 'border-sky-500/70',
  low: 'border-amber-500/70',
  none: 'border-slate-400/70',
};
const quadrantOrder: TaskPriority[] = ['high', 'medium', 'low', 'none'];

export const quadrantDefinitions: Array<{ id: TaskPriority; readonly title: string; readonly description: string; tone: string }> = quadrantOrder.map((id) => ({
  id,
  get title() { return t(`plan:quadrant.${id}.title`); },
  get description() { return t(`plan:quadrant.${id}.description`); },
  tone: quadrantTones[id],
}));

export function quadrantForPriority(priority: TaskPriority) {
  return quadrantDefinitions.find((quadrant) => quadrant.id === priority)!;
}
