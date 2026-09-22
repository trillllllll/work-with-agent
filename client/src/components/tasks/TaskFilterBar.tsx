import type { ReactNode } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { Tag, Topic, View } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
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
};

const selectClass = 'glass-control mt-1 h-9 w-full rounded-lg px-2 text-xs';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0 text-xs text-muted-foreground">{label}{children}</label>;
}

export function TaskFilterBar({ page, scoped, filters, sortMode, topics, tags, open, onOpenChange, onChange, onSort, onClear }: Props) {
  const showStatus = page !== 'today';
  const showDates = page !== 'today';
  const showTag = page !== 'tags';
  const topicFiltered = !scoped && filters.topic !== 'all';
  const topicName = filters.topic === 'inbox' ? '收集箱' : topics.find((topic) => topic.id === filters.topic)?.name ?? '所选清单';
  const tagName = tags.find((tag) => tag.id === filters.tag)?.name ?? '所选标签';
  const parts: string[] = [];
  if (filters.q) parts.push(`搜索：${filters.q}`);
  if (showStatus && filters.status === 'open') parts.push('未完成');
  if (showStatus && filters.status === 'done') parts.push('已完成');
  if (topicFiltered) parts.push(`清单：${topicName}`);
  if (showTag && filters.tag) parts.push(`标签：${tagName}`);
  if (showDates && (filters.dueFrom || filters.dueTo)) parts.push(`截止日期 ${filters.dueFrom || '不限'} 至 ${filters.dueTo || '不限'}`);
  const summary = parts.join(' · ');
  return (
    <div className="my-4 rounded-2xl glass-subtle p-3" aria-label="任务筛选">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-40">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-10 rounded-xl pl-9" aria-label="搜索任务" placeholder="搜索任务、说明或标签…" value={filters.q} onChange={(event) => onChange({ q: event.target.value })} />
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" aria-expanded={open} aria-controls="task-filter-panel" onClick={() => onOpenChange(!open)}>
          筛选{parts.length ? ` ${parts.length}` : ''}
          <ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
        </Button>
        {parts.length > 0 && <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={onClear}>清除筛选</Button>}
      </div>
      {!open && summary && <p className="mt-2 text-xs leading-relaxed break-words text-muted-foreground">{summary}</p>}
      {open && <div id="task-filter-panel" className="mt-3 grid grid-cols-1 gap-3 border-t pt-3 glass-divider sm:grid-cols-3">
        {showStatus && <Field label="状态"><select className={selectClass} aria-label="筛选完成状态" value={filters.status} onChange={(event) => onChange({ status: event.target.value })}><option value="all">全部状态</option><option value="open">未完成</option><option value="done">已完成</option></select></Field>}
        {scoped && <Field label="排序"><select className={selectClass} aria-label="任务排序" value={sortMode} onChange={(event) => onSort(event.target.value)}><option value="manual">手动排序</option><option value="date">按截止日期</option><option value="priority">按优先级</option></select></Field>}
        {!scoped && <Field label="清单"><select className={selectClass} aria-label="筛选清单" value={filters.topic} onChange={(event) => onChange({ topic: event.target.value })}><option value="all">全部清单</option><option value="inbox">收集箱</option>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select></Field>}
        {showTag && <Field label="标签"><select className={selectClass} aria-label="筛选标签" value={filters.tag} onChange={(event) => onChange({ tag: event.target.value })}><option value="">全部标签</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></Field>}
        {showDates && <div className="min-w-0 sm:col-span-3">
          <p className="text-xs text-muted-foreground">截止日期</p>
          <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
            <Input className="h-9 w-full min-w-0 text-xs" type="date" aria-label="截止日期从" value={filters.dueFrom} onChange={(event) => onChange({ dueFrom: event.target.value })} />
            <span className="text-xs text-muted-foreground">至</span>
            <Input className="h-9 w-full min-w-0 text-xs" type="date" aria-label="截止日期到" value={filters.dueTo} onChange={(event) => onChange({ dueTo: event.target.value })} />
          </div>
        </div>}
      </div>}
    </div>
  );
}
