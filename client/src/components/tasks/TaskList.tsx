import { useState } from 'react';
import { ArrowDown, ArrowUp, CalendarDays, FolderInput, GripVertical, MoreHorizontal, Trash2 } from 'lucide-react';
import type { Task, Topic } from '@/lib/api.js';
import { priorities, statuses } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { cn } from '@/lib/utils.js';

type Props = { tasks: Task[]; topics: Topic[]; onOpen: (id: string) => void; onToggle: (task: Task) => Promise<unknown>; onMove: (task: Task, topicId: string | null) => Promise<unknown>; onDelete: (task: Task) => void; onReorder?: (tasks: Task[], parentId: string | null) => Promise<unknown>; hierarchical?: boolean; readonly?: boolean; busy?: boolean; selectedTaskId?: string };
export function TaskList({ tasks, topics, onOpen, onToggle, onMove, onDelete, onReorder, hierarchical = false, readonly = false, busy, selectedTaskId }: Props) {
  const [dragged, setDragged] = useState<string | null>(null);
  const sort = (a: Task, b: Task) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id);
  const roots = hierarchical ? tasks.filter((task) => !task.parentId || !tasks.some((parent) => parent.id === task.parentId)).sort(sort) : tasks;
  function reorder(group: Task[], from: number, to: number, parentId: string | null) {
    if (!onReorder || to < 0 || to >= group.length || from === to) return;
    const next = [...group]; next.splice(to, 0, ...next.splice(from, 1));
    void onReorder(next, parentId).catch(() => undefined);
  }
  const row = (task: Task, group: Task[], index: number, nested = false) => <div key={task.id}>
    <article data-testid={`task-row-${task.id}`} data-selected={selectedTaskId === task.id || undefined} className={cn('task-row group flex min-h-12 items-center gap-2 rounded-xl border border-transparent px-2.5 py-2', selectedTaskId === task.id ? 'border-[var(--glass-border)] bg-[var(--glass-hover)] shadow-[inset_0_1px_0_var(--glass-highlight)]' : 'hover:bg-[var(--glass-subtle)]', nested && 'ml-7 border-l-[3px] border-l-border')} onDragOver={(event) => { if (onReorder && group.some((item) => item.id === dragged)) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); const from = group.findIndex((item) => item.id === dragged); if (from >= 0) reorder(group, from, index, task.parentId ?? null); setDragged(null); }}>
      {onReorder && <span draggable={!busy} onDragStart={(event) => { setDragged(task.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.id); }} onDragEnd={() => setDragged(null)} className="cursor-grab text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" title="拖动排序"><GripVertical className="size-4" /></span>}
      <input type="checkbox" className="task-checkbox size-[18px] shrink-0 accent-primary" checked={task.status === 'done'} disabled={readonly || busy} aria-label={`${task.status === 'done' ? '重开' : '完成'}任务：${task.title}`} onChange={() => { void onToggle(task).catch(() => undefined); }} />
      <button type="button" aria-label={task.title} className="min-w-0 flex-1 py-0.5 text-left" onClick={() => onOpen(task.id)}><span className={cn('block break-words text-sm font-medium', task.status === 'done' && 'text-muted-foreground line-through')}>{task.title}</span><span aria-hidden="true" className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">{task.priority !== 'none' && <span className="task-meta-pill">{priorities.find((value) => value.value === task.priority)?.label}</span>}{task.status !== 'todo' && task.status !== 'done' && <span className="task-meta-pill">{statuses.find((value) => value.value === task.status)?.label}</span>}<span className="task-place-chip">{task.topic?.name ?? '收集箱'}</span>{task.tags?.map((tag) => <span key={tag.id} className="task-tag-chip" data-color={tag.color || 'violet'}>#{tag.name}</span>)}{!hierarchical && task.parentId && <span className="task-meta-pill">子任务</span>}</span></button>
      {task.dueDate && <time className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:flex"><CalendarDays className="size-3.5" />{task.dueDate}</time>}
      {!readonly && <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" disabled={busy} aria-label={`任务操作：${task.title}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuSub><DropdownMenuSubTrigger><FolderInput />移动到</DropdownMenuSubTrigger><DropdownMenuSubContent>
            <DropdownMenuItem disabled={!task.topicId} onSelect={() => { void onMove(task, null).catch(() => undefined); }}>收集箱</DropdownMenuItem>
            {topics.map((topic) => <DropdownMenuItem key={topic.id} disabled={task.topicId === topic.id} onSelect={() => { void onMove(task, topic.id).catch(() => undefined); }}>{topic.name}</DropdownMenuItem>)}
          </DropdownMenuSubContent></DropdownMenuSub>
          {onReorder && <><DropdownMenuItem disabled={busy || index === 0} aria-label={`上移任务：${task.title}`} onSelect={() => reorder(group, index, index - 1, task.parentId ?? null)}><ArrowUp />上移</DropdownMenuItem><DropdownMenuItem disabled={busy || index === group.length - 1} aria-label={`下移任务：${task.title}`} onSelect={() => reorder(group, index, index + 1, task.parentId ?? null)}><ArrowDown />下移</DropdownMenuItem></>}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" aria-label={`删除任务：${task.title}`} onSelect={() => onDelete(task)}><Trash2 />移入回收站</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>}
    </article>
    {hierarchical && !nested && <div className="mt-2 space-y-2">{tasks.filter((child) => child.parentId === task.id).sort(sort).map((child, childIndex, children) => row(child, children, childIndex, true))}</div>}
  </div>;
  return <div className="space-y-2" data-testid="task-list">{!roots.length ? <p className="py-12 text-center text-sm text-muted-foreground">暂无任务</p> : roots.map((task, index) => row(task, roots, index))}</div>;
}
