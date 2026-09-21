import { useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Trash2 } from 'lucide-react';
import type { Task, Topic } from '@/lib/api.js';
import { priorities, statuses } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/utils.js';

type Props = { tasks: Task[]; topics: Topic[]; onOpen: (id: string) => void; onToggle: (task: Task) => Promise<unknown>; onMove: (task: Task, topicId: string | null) => Promise<unknown>; onDelete: (task: Task) => void; onReorder?: (tasks: Task[], parentId: string | null) => Promise<unknown>; hierarchical?: boolean; readonly?: boolean; busy?: boolean };
export function TaskList({ tasks, topics, onOpen, onToggle, onMove, onDelete, onReorder, hierarchical = false, readonly = false, busy }: Props) {
  const [dragged, setDragged] = useState<string | null>(null);
  const sort = (a: Task, b: Task) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id);
  const roots = hierarchical ? tasks.filter((task) => !task.parentId || !tasks.some((parent) => parent.id === task.parentId)).sort(sort) : tasks;
  function reorder(group: Task[], from: number, to: number, parentId: string | null) {
    if (!onReorder || to < 0 || to >= group.length || from === to) return;
    const next = [...group]; next.splice(to, 0, ...next.splice(from, 1));
    void onReorder(next, parentId).catch(() => undefined);
  }
  const row = (task: Task, group: Task[], index: number, nested = false) => <div key={task.id}>
    <article data-testid={`task-row-${task.id}`} className={cn('glass-subtle flex flex-wrap items-center gap-2 rounded-xl p-3', nested && 'ml-7 border-l-2 border-primary/20')} onDragOver={(event) => { if (onReorder && group.some((item) => item.id === dragged)) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); const from = group.findIndex((item) => item.id === dragged); if (from >= 0) reorder(group, from, index, task.parentId ?? null); setDragged(null); }}>
      {onReorder && <span draggable={!busy} onDragStart={(event) => { setDragged(task.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.id); }} onDragEnd={() => setDragged(null)} className="cursor-grab text-muted-foreground" title="拖动排序"><GripVertical className="size-4" /></span>}
      <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={task.status === 'done'} disabled={readonly || busy} aria-label={`${task.status === 'done' ? '重开' : '完成'}任务：${task.title}`} onChange={() => { void onToggle(task).catch(() => undefined); }} />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(task.id)}><span className={cn('block break-words text-sm font-medium', task.status === 'done' && 'text-muted-foreground line-through')}>{task.title}</span><span className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted-foreground">{task.dueDate && <time>{task.dueDate}</time>}{task.priority !== 'none' && <span>{priorities.find((value) => value.value === task.priority)?.label}优先级</span>}{task.status !== 'todo' && task.status !== 'done' && <span>{statuses.find((value) => value.value === task.status)?.label}</span>}{task.tags?.map((tag) => <span key={tag.id} className="rounded bg-primary/10 px-1 text-primary">#{tag.name}</span>)}{!hierarchical && task.topic && <span>{task.topic.name}</span>}{!hierarchical && task.parentId && <span>子任务</span>}</span></button>
      {!readonly && <div className="flex max-w-full items-center gap-1 max-sm:w-full max-sm:justify-end max-sm:pl-6">
        <select className="glass-control max-w-28 rounded-lg p-1.5 text-xs" aria-label={`移动任务：${task.title}`} value={task.topicId ?? ''} disabled={busy} onChange={(event) => { void onMove(task, event.target.value || null).catch(() => undefined); }}><option value="">收集箱</option>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select>
        {onReorder && <><Button variant="ghost" size="icon-xs" disabled={busy || index === 0} aria-label={`上移任务：${task.title}`} onClick={() => reorder(group, index, index - 1, task.parentId ?? null)}><ArrowUp /></Button><Button variant="ghost" size="icon-xs" disabled={busy || index === group.length - 1} aria-label={`下移任务：${task.title}`} onClick={() => reorder(group, index, index + 1, task.parentId ?? null)}><ArrowDown /></Button></>}
        <Button variant="ghost" size="icon-xs" disabled={busy} aria-label={`删除任务：${task.title}`} onClick={() => onDelete(task)}><Trash2 /></Button>
      </div>}
    </article>
    {hierarchical && !nested && <div className="mt-2 space-y-2">{tasks.filter((child) => child.parentId === task.id).sort(sort).map((child, childIndex, children) => row(child, children, childIndex, true))}</div>}
  </div>;
  return <div className="space-y-2" data-testid="task-list">{!roots.length ? <p className="py-12 text-center text-sm text-muted-foreground">暂无任务</p> : roots.map((task, index) => row(task, roots, index))}</div>;
}
