import type { View } from './api.js';
import type { TaskFilters } from '../components/tasks/TaskFilterBar.js';

const allPages = new Set(['today', 'plan', 'search', 'tags', 'library', 'topics', 'quadrant', 'archived', 'trash', 'focus', 'stats']);

export function chatScope(page: string, topicId: string): { kind: 'inbox' } | { kind: 'topic'; topicId: string } | { kind: 'all' } {
  if (page === 'inbox') return { kind: 'inbox' };
  if ((page === 'board' || page === 'knowledge') && topicId) return { kind: 'topic', topicId };
  if (page === 'knowledge') return { kind: 'all' };
  if (allPages.has(page)) return { kind: 'all' };
  if (page === 'board' && topicId) return { kind: 'topic', topicId };
  if (['settings', 'connections', 'proposals', 'skills', 'changes', 'runs', 'worktrees', 'reviews', 'learning', 'more'].includes(page)) return { kind: 'all' };
  return { kind: 'inbox' };
}

export function buildChatContext(input: {
  page: View | string;
  topicId: string;
  taskId: string;
  materialId?: string | null;
  filters?: TaskFilters | null;
  sort?: string;
  includeArchived?: boolean;
  today?: string;
  referencedApprovalId?: string | null;
}) {
  const filters = input.filters;
  const status = filters?.status && filters.status !== 'all' ? filters.status : undefined;
  const dueTo = input.page === 'today' && input.today ? input.today : filters?.dueTo || undefined;
  const taskFilter: {
    q?: string;
    status?: 'open' | 'done' | 'all' | 'todo' | 'doing' | 'blocked';
    dueFrom?: string;
    dueTo?: string;
    tagIds?: string[];
    includeArchived?: boolean;
    sort?: 'manual' | 'date' | 'priority';
  } = {
    ...(filters?.q ? { q: filters.q } : {}),
    ...(status && ['open', 'done', 'all', 'todo', 'doing', 'blocked'].includes(status) ? { status: status as 'open' | 'done' | 'all' | 'todo' | 'doing' | 'blocked' } : {}),
    ...(filters?.dueFrom ? { dueFrom: filters.dueFrom } : {}),
    ...(dueTo ? { dueTo } : {}),
    ...(filters?.tag ? { tagIds: [filters.tag] } : {}),
    ...(input.includeArchived ? { includeArchived: true } : {}),
  };
  const hasFilter = Object.keys(taskFilter).length > 0;
  if (hasFilter && (input.sort === 'manual' || input.sort === 'date' || input.sort === 'priority')) taskFilter.sort = input.sort;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  return {
    schemaVersion: 2 as const,
    page: input.page,
    scope: chatScope(input.page, input.topicId),
    taskId: input.taskId || null,
    materialId: input.materialId || null,
    selectedTaskIds: input.taskId ? [input.taskId] : [],
    taskFilter: hasFilter ? taskFilter : null,
    timeZone: zone,
    referencedApprovalId: input.referencedApprovalId ?? null,
  };
}
