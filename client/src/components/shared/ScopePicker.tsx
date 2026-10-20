import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Inbox, Search } from 'lucide-react';
import type { Topic } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { accessCount, clearSelection, filterSelected, filterTopics, orderSelectedFirst, selectAll } from '@/lib/scope-selection.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';

export type ScopePickerLabels = {
  legend: string;
  count: (selected: number, total: number) => string;
  missingCount: (count: number) => string;
  selectAll: string;
  clear: string;
  searchAria: string;
  searchPlaceholder: (count: number) => string;
  inboxAria: string;
  inboxHint: string;
  itemAria: (name: string) => string;
  missingName: (id: string) => string;
  missingRow: (name: string) => string;
  archivedBadge: string;
  filterAll: string;
  filterSelected: (count: number) => string;
  footer: string;
};

type ScopePickerProps = {
  topics: Topic[];
  archivedTopics: Topic[];
  missingIds: string[];
  includeInbox: boolean;
  topicIds: string[];
  /** Edit mode keeps the initially selected lists at the top for this dialog session. */
  pinSelected: boolean;
  onChange: (next: { includeInbox: boolean; topicIds: string[] }) => void;
  labels: ScopePickerLabels;
  exploringLabel: string;
};

export function ScopePicker({ topics, archivedTopics, missingIds, includeInbox, topicIds, pinSelected, onChange, labels, exploringLabel }: ScopePickerProps) {
  const { t } = useTranslation('workspace');
  const pinnedIds = useRef(topicIds).current;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'selected'>('all');
  const ordered = pinSelected ? orderSelectedFirst(topics, pinnedIds) : topics;
  const matched = filterTopics(ordered, query);
  const shown = filter === 'selected' ? filterSelected(matched, topicIds) : matched;
  const count = accessCount(topics, includeInbox, topicIds);
  const missingSet = new Set(missingIds);
  const missingChecked = topicIds.filter((id) => missingSet.has(id));
  const archivedRows = archivedTopics.filter((topic) => pinnedIds.includes(topic.id));
  const selection = { includeInbox, topicIds };
  const toggle = (id: string, checked: boolean) => {
    const next = checked ? (topicIds.includes(id) ? topicIds : [...topicIds, id]) : topicIds.filter((item) => item !== id);
    onChange({ includeInbox, topicIds: next });
  };
  return (
    <fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-medium">{labels.legend}</span>
          <span className="text-muted-foreground"> · {labels.count(count.selected, count.total)}</span>
          {missingChecked.length > 0 && <span className="text-warning"> · {labels.missingCount(missingChecked.length)}</span>}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(selectAll(selection, topics, query))}>{labels.selectAll}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(clearSelection(selection, topics, query))}>{labels.clear}</Button>
      </div>
      <div className="mt-2 rounded-xl border border-border">
        <div className="relative border-b border-border p-2">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-5 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label={labels.searchAria} placeholder={labels.searchPlaceholder(topics.length)} value={query} className="pl-9" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} />
        </div>
        <div className="border-b border-border p-1">
          <label className={cn('flex min-h-[34px] items-center gap-2 rounded-lg px-2', includeInbox && 'bg-muted')}>
            <input type="checkbox" className="size-4 shrink-0 accent-primary" aria-label={labels.inboxAria} checked={includeInbox} onChange={(event) => onChange({ includeInbox: event.target.checked, topicIds })} />
            <Inbox aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-sm">{t('inbox')}</span>
            <span className="truncate text-xs text-muted-foreground">{labels.inboxHint}</span>
          </label>
        </div>
        {missingIds.length > 0 && (
          <div className="space-y-1 border-b border-border p-1">
            {missingIds.map((id) => {
              const name = labels.missingName(id);
              const checked = topicIds.includes(id);
              return (
                <div key={id}>
                  <label className="flex min-h-[34px] items-center gap-2 rounded-lg border border-warning-border bg-warning-bg px-2">
                    <input type="checkbox" className="size-4 shrink-0 accent-primary" aria-label={labels.itemAria(name)} checked={checked} onChange={(event) => toggle(id, event.target.checked)} />
                    <span className="min-w-0 flex-1 truncate text-sm text-warning line-through">{name}</span>
                  </label>
                  {checked && <p className="px-2 py-1 text-xs text-warning">{labels.missingRow(name)}</p>}
                </div>
              );
            })}
          </div>
        )}
        {archivedRows.length > 0 && (
          <div className="space-y-1 border-b border-border p-1">
            {archivedRows.map((topic) => {
              const checked = topicIds.includes(topic.id);
              return (
                <label key={topic.id} className={cn('flex min-h-[34px] items-center gap-2 rounded-lg px-2', checked && 'bg-muted')}>
                  <input type="checkbox" className="size-4 shrink-0 accent-primary" aria-label={labels.itemAria(topic.name)} checked={checked} onChange={(event) => toggle(topic.id, event.target.checked)} />
                  <span className="sidebar-list-mark" data-color={topic.color || 'slate'} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm">{topic.name}</span>
                  <Badge variant="outline">{labels.archivedBadge}</Badge>
                </label>
              );
            })}
          </div>
        )}
        <div className="max-h-[216px] overflow-y-auto p-1">
          <div className="grid grid-cols-1 gap-1 lg:grid-cols-2">
            {shown.map((topic) => {
              const checked = topicIds.includes(topic.id);
              return (
                <label key={topic.id} className={cn('flex min-h-[34px] items-center gap-2 rounded-lg px-2', checked && 'bg-muted')}>
                  <input type="checkbox" className="size-4 shrink-0 accent-primary" aria-label={labels.itemAria(topic.name)} checked={checked} onChange={(event) => toggle(topic.id, event.target.checked)} />
                  <span className="sidebar-list-mark" data-color={topic.color || 'slate'} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm">{topic.name}</span>
                  {topic.isExploration && <em className="sidebar-explore-tag">{exploringLabel}</em>}
                </label>
              );
            })}
          </div>
        </div>
        <div className="border-t border-border p-2">
          <div className="inline-flex gap-1 rounded-lg border p-1" role="group" aria-label={labels.legend}>
            <Button type="button" size="sm" variant={filter === 'all' ? 'secondary' : 'ghost'} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>{labels.filterAll}</Button>
            <Button type="button" size="sm" variant={filter === 'selected' ? 'secondary' : 'ghost'} aria-pressed={filter === 'selected'} onClick={() => setFilter('selected')}>{labels.filterSelected(count.selected)}</Button>
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{labels.footer}</p>
    </fieldset>
  );
}
