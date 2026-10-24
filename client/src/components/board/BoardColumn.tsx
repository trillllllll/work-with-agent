import { Surface } from '@/components/ui/surface.js';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Flag, Plus } from 'lucide-react';
import { availableTaskStatuses, priorities, statuses, type Status, type Tag, type Task, type Topic } from '@/lib/api.js';
import type { TaskDraft } from '@/lib/todo.js';
import { Button } from '@/components/ui/button.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { TaskActions, TaskMenuButton } from '@/components/tasks/TaskActionsMenu.js';

export type TaskCardProps = {
  task: Task;
  topics: Topic[];
  tags: Tag[];
  selected?: boolean;
  readonly?: boolean;
  busy?: boolean;
  textDirty?: boolean;
  onOpen: (id: string) => void;
  onToggle: (task: Task) => Promise<unknown>;
  onMove: (task: Task, topicId: string | null) => Promise<unknown>;
  onDelete: (task: Task) => void;
  onSave: (task: Task, patch: Partial<TaskDraft>) => Promise<Task | undefined>;
  onCreate: (input: { title: string; topicId: string | null; parentId: string | null }) => Promise<unknown>;
  onUpdateStatus: (id: string, status: Status) => void;
};

export function TaskCard({ task, topics, tags, selected = false, readonly = false, busy = false, textDirty = false, onOpen, onToggle, onMove, onDelete, onSave, onCreate, onUpdateStatus }: TaskCardProps) {
  const { t } = useTranslation('plan');
  const priority = task.priority ?? 'none';
  const priorityLabel = priorities.find((item) => item.value === priority)?.label ?? t('taskCard.noPriority');
  return <TaskActions task={task} topics={topics} tags={tags} readonly={readonly} busy={busy} textDirty={textDirty} onOpen={onOpen} onToggle={onToggle} onMove={onMove} onDelete={onDelete} onSave={onSave} onCreate={onCreate}>
    <Surface as="article" tone="subtle" data-testid={`task-card-${task.id}`} data-selected={selected || undefined} className="group rounded-xl p-3 transition-colors hover:border-primary/25 hover:bg-[var(--glass-hover)]" onClick={(event) => { const target = event.target; if (!(target instanceof Element) || target.closest('button, a, select, label, input, [role="menu"], [role="menuitem"], [role="listbox"], [role="option"]')) return; onOpen(task.id); }}>
      <div className="flex items-start justify-between gap-1.5">
        <Button variant="row" size="bare" type="button" onClick={(event) => { event.stopPropagation(); onOpen(task.id); }} className="min-w-0 flex-1 text-left text-xs leading-relaxed font-bold hover:text-brand-link">{task.title}</Button>
        <TaskMenuButton />
      </div>
      {task.resultSummary && <div className="mt-2 rounded-lg border border-success bg-success-bg/70 px-2 py-1.5 text-[11px] leading-relaxed text-success">{t('taskCard.result', { summary: task.resultSummary })}</div>}
      {(priority !== 'none' || task.dueDate) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          {priority !== 'none' && <span className={priority === 'high' ? 'text-destructive' : priority === 'medium' ? 'text-warning' : 'text-brand-link'} title={t('taskCard.priorityTitle', { priority: priorityLabel })}><Flag className="mr-1 inline size-3" />{priorityLabel}</span>}
          {task.dueDate && <span title={t('taskCard.dueTitle', { date: task.dueDate })}><CalendarDays className="mr-1 inline size-3" />{task.dueDate}</span>}
        </div>
      )}
      <Select value={task.status} onValueChange={(value) => onUpdateStatus(task.id, value as Status)} disabled={readonly}>
        <SelectTrigger size="sm" className="mt-3 h-8 w-full text-[11px] text-muted-foreground" aria-label={t('taskCard.statusLabel', { title: task.title })}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {statuses.filter((item) => availableTaskStatuses(task).includes(item.value)).map((item) => <SelectItem value={item.value} key={item.value}>{item.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Surface>
  </TaskActions>;
}

type BoardColumnProps = {
  label: string;
  count: number;
  isTodo?: boolean;
  onAddTask?: () => void;
  children: React.ReactNode;
};

export function BoardColumn({ label, count, isTodo = false, onAddTask, children }: BoardColumnProps) {
  const { t } = useTranslation('plan');
  return (
    <Surface as="div" tone="subtle" className="flex w-[82vw] max-w-80 shrink-0 snap-start flex-col rounded-2xl p-2.5 max-md:max-h-full md:w-auto md:max-w-none md:shrink md:snap-none md:min-h-[350px]">
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground">{label}</h2>
        <span className="glass-control min-w-5 rounded-full px-1.5 py-0.5 text-center text-[10px] text-muted-foreground">{count}</span>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
      {isTodo && onAddTask && (
        <Button variant="ghost" size="sm" className="mt-2 w-full justify-start text-muted-foreground hover:text-brand-link" onClick={onAddTask}>
          <Plus />{t('boardColumn.addTask')}
        </Button>
      )}
    </Surface>
  );
}
