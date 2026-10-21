import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ArrowRightLeft, Box, Brain, CircleDot, Code, FileText, Folder, GitBranch, History, List, Loader2, Play, ScrollText, Sparkles, SquareCheck, Tag, Tags, Undo2, Waypoints, Blocks } from 'lucide-react';
import type { ChangeListItem, ChangeSummary } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { intlLocale } from '@/i18n/index.js';
import { useLoadMoreSentinel } from '@/lib/use-load-more-sentinel.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { Tooltip } from '@/components/ui/tooltip.js';
import { CHANGE_ENTITY_TYPES, groupChangesByDay, type ChangeDay } from './change-filters.js';

const OPERATION_IDS = ['create', 'update', 'delete', 'archive', 'archive_preserve', 'reorder', 'move_tasks_to_inbox', 'restore', 'permanent_delete', 'confirm_summary', 'discard_summary', 'execute', 'undo'] as const;
const FIELD_KEYS: Record<string, string> = {
  title: 'title', status: 'status', priority: 'priority', dueDate: 'dueDate', scheduledStart: 'schedule', topicId: 'list', parentId: 'parent',
  name: 'name', color: 'color', description: 'description', goal: 'goal', enabled: 'enabled', tagIds: 'tags',
};
const TONE_CLASS = {
  green: 'border-transparent bg-[var(--tag-green-bg)] text-[var(--tag-green-fg)]',
  blue: 'border-transparent bg-[var(--tag-blue-bg)] text-[var(--tag-blue-fg)]',
  rose: 'border-transparent bg-[var(--tag-rose-bg)] text-[var(--tag-rose-fg)]',
  amber: 'border-transparent bg-[var(--tag-amber-bg)] text-[var(--tag-amber-fg)]',
  violet: 'border-transparent bg-[var(--tag-violet-bg)] text-[var(--tag-violet-fg)]',
  slate: 'border-transparent bg-[var(--tag-slate-bg)] text-[var(--tag-slate-fg)]',
} as const;
const ENTITY_ICONS: Record<string, typeof SquareCheck> = {
  task: SquareCheck, topic: List, tag: Tag, execution: Code, memory: Brain, material: FileText, skill: Sparkles, workspace: Blocks,
  proposal: ScrollText, entity: Box, graphLink: Waypoints, libraryFolder: Folder, libraryTag: Tags, handoff: ArrowRightLeft, run: Play, code_application: GitBranch,
};

type ChangesListProps = {
  items: ChangeListItem[];
  total: number;
  loading: boolean;
  errorMessage: string;
  hasNextPage: boolean;
  fetchingNextPage: boolean;
  nextPageError: boolean;
  filtered: boolean;
  filtersSummary: string;
  pendingIds: ReadonlySet<string>;
  onRetry: () => void;
  onRetryNext: () => void;
  onLoadMore: () => void;
  onClear: () => void;
  onUndo: (item: ChangeListItem) => void;
};

function operationTone(operation: string): keyof typeof TONE_CLASS {
  if (operation.startsWith('undo:')) return 'slate';
  const id = operation;
  if (id === 'create') return 'green';
  if (id === 'update' || id === 'reorder' || id === 'move_tasks_to_inbox') return 'blue';
  if (id === 'delete' || id === 'archive' || id === 'archive_preserve' || id === 'permanent_delete') return 'rose';
  if (id === 'restore') return 'amber';
  if (id === 'execute') return 'violet';
  return 'slate';
}

function operationLabel(operation: string, t: TFunction<'settings'>) {
  const undo = operation.startsWith('undo:');
  const id = undo ? operation.slice(5) : operation;
  const label = (OPERATION_IDS as readonly string[]).includes(id) ? t(`changes.operations.${id}`) : id;
  return undo ? t('changes.undoOf', { operation: label }) : label;
}

function entityLabel(entityType: string, t: TFunction<'settings'>) {
  return (CHANGE_ENTITY_TYPES as readonly string[]).includes(entityType) ? t(`changes.entities.${entityType}`) : entityType;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(intlLocale());
}

function blockedReason(item: ChangeListItem, t: TFunction<'settings'>) {
  const reason = item.undoBlockedReason?.reason;
  if (reason === 'already_undone') return t('changes.blocked.alreadyUndoneAt', { time: item.undoneAt ? formatTime(item.undoneAt) : '' });
  if (reason === 'undo_record') return t('changes.blocked.undoRecord');
  if (reason === 'execution') return t('changes.blocked.execution');
  if (reason === 'permanent_delete') return t('changes.blocked.permanentDelete');
  if (reason === 'missing_snapshot') return t('changes.blocked.missingSnapshot');
  return t('changes.blocked.unsupported');
}

export function ChangesList(props: ChangesListProps) {
  const { t } = useTranslation('settings');
  const sentinel = useRef<HTMLDivElement>(null);
  useLoadMoreSentinel(sentinel, {
    loading: props.loading || props.fetchingNextPage || props.nextPageError,
    hasMore: props.hasNextPage,
    onLoadMore: props.onLoadMore,
  });
  if (props.loading) return <SkeletonRows />;
  if (props.errorMessage) return <div className="glass-subtle mt-4 rounded-2xl px-6 py-10 text-center"><p role="alert" className="text-sm">{t('changes.loadFailedFirst')}</p>{props.errorMessage !== t('changes.loadFailedFirst') && <p className="mt-1 text-xs text-muted-foreground">{props.errorMessage}</p>}<Button type="button" variant="outline" size="sm" className="mt-3" onClick={props.onRetry}>{t('changes.retry')}</Button></div>;
  if (!props.items.length) {
    return <div className="glass-subtle mt-4 rounded-2xl px-6 py-10 text-center">
      <History className="mx-auto size-6 text-muted-foreground" />
      <h2 className="mt-3 text-base font-semibold">{props.filtered ? t('changes.noMatchTitle') : t('changes.emptyTitle')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{props.filtered ? t('changes.noMatchHint', { filters: props.filtersSummary }) : t('changes.emptyHint')}</p>
      {props.filtered && <Button type="button" variant="outline" size="sm" className="mt-3" onClick={props.onClear}>{t('changes.clearFilters')}</Button>}
    </div>;
  }
  const groups = groupChangesByDay(props.items);
  return <div className="mt-2">
    {groups.map((group) => <section key={group.day} className="mt-2">
      <h2 className="sticky top-0 z-[1] bg-[var(--glass-bg-strong)] py-2 text-[13px] font-semibold">{t(`changes.days.${group.day as ChangeDay}`)}</h2>
      <div className="glass-subtle overflow-hidden rounded-2xl">
        {group.items.map((item, index) => <ChangeRow key={item.id} item={item} pending={props.pendingIds.has(item.id)} divided={index > 0} onUndo={props.onUndo} />)}
      </div>
    </section>)}
    <div className="flex flex-col items-center gap-2 py-4 text-xs text-muted-foreground">
      {props.fetchingNextPage && <p>{t('changes.loadingMore')}</p>}
      {props.nextPageError && <div role="alert" className="flex w-full items-center gap-2 rounded-lg border border-destructive/35 px-3 py-2 text-sm text-destructive"><span className="min-w-0 flex-1">{t('changes.loadFailed')}</span><Button type="button" variant="outline" size="sm" onClick={props.onRetryNext}>{t('changes.retry')}</Button></div>}
      {!props.hasNextPage && !props.nextPageError && <p className="flex w-full items-center gap-3 before:h-px before:flex-1 before:bg-[var(--glass-divider)] after:h-px after:flex-1 after:bg-[var(--glass-divider)]">{t('changes.end', { total: props.total })}</p>}
      {props.hasNextPage && !props.fetchingNextPage && !props.nextPageError && <Button type="button" variant="outline" size="sm" onClick={props.onLoadMore}>{t('changes.loadMore')}</Button>}
      {props.hasNextPage && <div ref={sentinel} className="h-px w-full" />}
    </div>
  </div>;
}

function SkeletonRows() {
  return <div className="glass-subtle mt-4 overflow-hidden rounded-2xl" aria-hidden="true">
    {Array.from({ length: 7 }, (_, index) => <div key={index} className={cn('grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3', index > 0 && 'border-t glass-divider')}>
      <Skeleton className="size-[30px] rounded-[9px]" />
      <div className="space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/2" /></div>
      <Skeleton className="h-[30px] w-16 rounded-md lg:w-[76px]" />
    </div>)}
  </div>;
}

function ChangeRow({ item, pending, divided, onUndo }: { item: ChangeListItem; pending: boolean; divided: boolean; onUndo: (item: ChangeListItem) => void }) {
  const { t } = useTranslation('settings');
  const { t: appT } = useTranslation('app');
  const Icon = ENTITY_ICONS[item.entityType] ?? CircleDot;
  const name = `${item.entityName.trim() || entityLabel(item.entityType, t)}${item.groupCount > 1 ? t('changes.groupSuffix', { count: item.groupCount }) : ''}`;
  const source = item.actorKind === 'connection' ? item.connectionName || t('changes.sources.deletedConnection') : t(item.actorKind === 'assistant' ? 'changes.sources.assistant' : 'changes.sources.user');
  const button = <Button type="button" variant="outline" size="sm" className="h-[30px] w-16 gap-1 !px-0 text-xs lg:w-[76px] lg:text-[13px]" disabled={!item.canUndo || pending} aria-busy={pending || undefined} onClick={() => onUndo(item)}>{pending ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}{t('changes.undo')}</Button>;
  return <article data-testid="change-row" className={cn('grid grid-cols-[30px_minmax(0,1fr)_auto] items-start gap-3 px-3.5 py-3', divided && 'border-t glass-divider')}>
    <span className="grid size-[30px] place-items-center rounded-[9px] bg-muted text-muted-foreground"><Icon className="size-4" /></span>
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <Badge variant="outline" className={cn('h-5 rounded-md px-1.5 text-[11px] font-semibold', TONE_CLASS[operationTone(item.operation)])}>{operationLabel(item.operation, t)}</Badge>
        <span className="truncate text-sm font-medium">{name}</span>
      </div>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <span>{entityLabel(item.entityType, t)}</span>
        <span aria-hidden="true">·</span>
        <span>{formatTime(item.createdAt)}</span>
        <span aria-hidden="true">·</span>
        <span className="max-w-48 truncate">{source}</span>
        {item.approvalId && <span>{t('changes.approvalSuffix', { id: item.approvalId })}</span>}
        {item.undoneAt && <Badge variant="outline" className="h-[18px] px-1.5 text-[11px] lg:hidden">{t('changes.undoneBadge')}</Badge>}
      </p>
      <SummaryLine summary={item.changeSummary} t={t} appT={appT} />
    </div>
    <div className="flex items-center justify-end gap-2">
      {item.undoneAt && <Badge variant="outline" className="h-5 px-1.5 text-[11px] max-lg:hidden">{t('changes.undoneBadge')}</Badge>}
      {item.canUndo ? button : <Tooltip content={blockedReason(item, t)} disabledTrigger>{button}</Tooltip>}
    </div>
  </article>;
}

function SummaryLine({ summary, t, appT }: { summary: ChangeSummary | null; t: TFunction<'settings'>; appT: TFunction<'app'> }) {
  if (!summary) return null;
  if ('kind' in summary) return <p className="mt-1.5 text-[13px]">{t(summary.success ? 'changes.toolSuccess' : 'changes.toolFailure', { toolName: summary.toolName })}</p>;
  return <p className="mt-1.5 flex min-w-0 items-baseline gap-x-1.5 text-[13px] max-lg:flex-nowrap max-lg:overflow-hidden">
    <span className="shrink-0 text-muted-foreground">{fieldLabel(summary.field, t)}</span>
    <span className="max-w-[46%] shrink-0 truncate text-muted-foreground line-through">{valueLabel(summary.field, summary.before, appT)}</span>
    <span aria-hidden="true" className="shrink-0">→</span>
    <span className="min-w-0 max-lg:truncate lg:break-all">{valueLabel(summary.field, summary.after, appT)}</span>
  </p>;
}

function fieldLabel(field: string, t: TFunction<'settings'>) {
  const key = FIELD_KEYS[field];
  return key ? t(`changes.fields.${key}`) : field;
}

function valueLabel(field: string, value: string, appT: TFunction<'app'>) {
  if (!value) return '\u2014';
  if (field === 'status' && (['todo', 'doing', 'blocked', 'done'] as const).some((item) => item === value)) return appT(`status.${value as 'todo'}`);
  if (field === 'priority' && (['none', 'low', 'medium', 'high'] as const).some((item) => item === value)) return appT(`priority.${value as 'none'}`);
  return value;
}
