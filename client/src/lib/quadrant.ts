import type { TaskPriority } from './api.js';

export const quadrantDefinitions: Array<{ id: TaskPriority; title: string; description: string; tone: string }> = [
  { id: 'high', title: '重要且紧急', description: '立即处理', tone: 'border-rose-500/70' },
  { id: 'medium', title: '重要但不紧急', description: '计划安排', tone: 'border-sky-500/70' },
  { id: 'low', title: '不重要但紧急', description: '快速处理或委派', tone: 'border-amber-500/70' },
  { id: 'none', title: '不重要且不紧急', description: '减少或删除', tone: 'border-slate-400/70' },
];

export function quadrantForPriority(priority: TaskPriority) {
  return quadrantDefinitions.find((quadrant) => quadrant.id === priority)!;
}
