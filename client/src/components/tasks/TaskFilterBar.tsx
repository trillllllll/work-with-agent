import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ListFilter, Search } from 'lucide-react';
import type { Tag, Topic, View } from '@/lib/api.js';
import { t as translate } from '../../i18n/index.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { cn } from '@/lib/utils.js';

export type TaskFilters = { q: string; status: string; topic: string; dueFrom: string; dueTo: string; tag: string };

type Props = {
  page: View;
  scoped: boolean;
  filters: TaskFilters;
  sortMode: string;
  topics: Topic[];
  tags: Tag[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (patch: Partial<TaskFilters>) => void;
  onSort: (value: string) => void;
  onClear: () => void;
  presentation?: 'bar' | 'popover';
};

export function describeTaskFilters(page: View, scoped: boolean, filters: TaskFilters, topics: Topic[], tags: Tag[]) {
  const showStatus = page !== 'today';
  const showDates = page !== 'today';
  const showTag = page !== 'tags';
  const topicFiltered = !scoped && filters.topic !== 'all';
  const topicName = filters.topic === 'inbox' ? translate('tasks:shared.inbox') : topics.find((topic) => topic.id === filters.topic)?.name ?? translate('tasks:taskFilter.selectedList');
  const tagName = tags.find((tag) => tag.id === filters.tag)?.name ?? translate('tasks:taskFilter.selectedTag');
  const parts: string[] = [];
  if (page === 'search' && filters.q) parts.push(translate('tasks:taskFilter.searchSummary', { query: filters.q }));
  if (showStatus && filters.status === 'open') parts.push(translate('tasks:taskFilter.incomplete'));
  if (showStatus && filters.status === 'done') parts.push(translate('tasks:taskFilter.completed'));
  if (topicFiltered) parts.push(translate('tasks:taskFilter.listSummary', { name: topicName }));
  if (showTag && filters.tag) parts.push(translate('tasks:taskFilter.tagSummary', { name: tagName }));
  if (showDates && (filters.dueFrom || filters.dueTo)) parts.push(translate('tasks:taskFilter.dateSummary', { from: filters.dueFrom || translate('tasks:taskFilter.anyDate'), to: filters.dueTo || translate('tasks:taskFilter.anyDate') }));
  return { parts, summary: parts.join(' · ') };
}

const selectClass = 'glass-control mt-1 h-9 w-full rounded-lg px-2 text-xs';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0 text-xs text-muted-foreground">{label}{children}</label>;
}

function FilterFields({ page, scoped, filters, sortMode, topics, tags, onChange, onSort, stacked = false }: Pick<Props, 'page' | 'scoped' | 'filters' | 'sortMode' | 'topics' | 'tags' | 'onChange' | 'onSort'> & { stacked?: boolean }) {
  const { t } = useTranslation('tasks');
  const showStatus = page !== 'today';
  const showDates = page !== 'today';
  const showTag = page !== 'tags';
  return <div className={cn('grid grid-cols-1 gap-3', !stacked && 'sm:grid-cols-3')}>
    {showStatus && <Field label={t('taskFilter.status')}><select className={selectClass} aria-label={t('taskFilter.statusAria')} value={filters.status} onChange={(event) => onChange({ status: event.target.value })}><option value="all">{t('taskFilter.anyStatus')}</option><option value="open">{t('taskFilter.incomplete')}</option><option value="done">{t('taskFilter.completed')}</option></select></Field>}
    {scoped && <Field label={t('taskFilter.sort')}><select className={selectClass} aria-label={t('taskFilter.sortAria')} value={sortMode} onChange={(event) => onSort(event.target.value)}><option value="manual">{t('taskFilter.manual')}</option><option value="date">{t('taskFilter.byDate')}</option><option value="priority">{t('taskFilter.byPriority')}</option></select></Field>}
    {!scoped && <Field label={t('taskFilter.list')}><select className={selectClass} aria-label={t('taskFilter.listAria')} value={filters.topic} onChange={(event) => onChange({ topic: event.target.value })}><option value="all">{t('taskFilter.allLists')}</option><option value="inbox">{t('shared.inbox')}</option>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select></Field>}
    {showTag && <Field label={t('taskFilter.tag')}><select className={selectClass} aria-label={t('taskFilter.tagAria')} value={filters.tag} onChange={(event) => onChange({ tag: event.target.value })}><option value="">{t('taskFilter.allTags')}</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></Field>}
    {showDates && <div className={cn('min-w-0', !stacked && 'sm:col-span-3')}>
      <p className="text-xs text-muted-foreground">{t('taskFilter.date')}</p>
      <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <Input className="h-9 w-full min-w-0 text-xs" type="date" aria-label={t('taskFilter.dateFrom')} value={filters.dueFrom} onChange={(event) => onChange({ dueFrom: event.target.value })} />
        <span className="text-xs text-muted-foreground">{t('taskFilter.to')}</span>
        <Input className="h-9 w-full min-w-0 text-xs" type="date" aria-label={t('taskFilter.dateTo')} value={filters.dueTo} onChange={(event) => onChange({ dueTo: event.target.value })} />
      </div>
    </div>}
  </div>;
}

function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation('tasks');
  return <div className="relative min-w-0 flex-1 basis-40">
    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    <Input className="h-10 rounded-xl pl-9" aria-label={t('taskFilter.searchAria')} placeholder={t('taskFilter.searchPlaceholder')} value={value} onChange={(event) => onChange(event.target.value)} />
  </div>;
}

export function TaskFilterBar({ page, scoped, filters, sortMode, topics, tags, open, onOpenChange, onChange, onSort, onClear, presentation = 'bar' }: Props) {
  const { t } = useTranslation('tasks');
  const { parts, summary } = describeTaskFilters(page, scoped, filters, topics, tags);
  const search = page === 'search' ? <SearchField value={filters.q} onChange={(q) => onChange({ q })} /> : null;
  if (presentation === 'popover') {
    return <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={t('taskFilter.filter')} aria-expanded={open} className="relative">
          <ListFilter />
          {parts.length > 0 && <span aria-hidden className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground">{parts.length}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))] space-y-3 p-3">
        {search}
        <FilterFields page={page} scoped={scoped} filters={filters} sortMode={sortMode} topics={topics} tags={tags} onChange={onChange} onSort={onSort} stacked />
        {parts.length > 0 && <Button type="button" size="sm" variant="ghost" onClick={onClear}>{t('taskFilter.clear')}</Button>}
      </PopoverContent>
    </Popover>;
  }
  return (
    <div className="my-3" aria-label={t('taskFilter.barAria')}>
      <div className="flex flex-wrap items-center gap-2">
        {search}
        <Button type="button" variant="ghost" size="sm" className="shrink-0 -ml-1 text-muted-foreground" aria-expanded={open} aria-controls="task-filter-panel" onClick={() => onOpenChange(!open)}>
          <ListFilter className="size-4" aria-hidden />
          {parts.length ? t('taskFilter.filterWithCount', { count: parts.length }) : t('taskFilter.filter')}
          <ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
        </Button>
        {parts.length > 0 && <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={onClear}>{t('taskFilter.clear')}</Button>}
        {!open && summary && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span>}
      </div>
      {open && <div id="task-filter-panel" className="mt-2 rounded-xl border border-[var(--glass-border-soft)] bg-[var(--glass-subtle)] p-3"><FilterFields page={page} scoped={scoped} filters={filters} sortMode={sortMode} topics={topics} tags={tags} onChange={onChange} onSort={onSort} /></div>}
    </div>
  );
}
