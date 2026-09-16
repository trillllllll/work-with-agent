import { CalendarDays, Flag, Plus, Trash2 } from 'lucide-react';
import { priorities, statuses, type Status, type Task, type Topic } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';

type TaskCardProps = {
  task: Task;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onUpdateStatus: (id: string, status: Status) => void;
  topics?: Topic[];
  onAssignTopic?: (id: string, topicId: string) => void;
  assigning?: boolean;
};

export function TaskCard({ task, onEdit, onDelete, onUpdateStatus, topics, onAssignTopic, assigning = false }: TaskCardProps) {
  const priority = task.priority ?? 'none';
  const priorityLabel = priorities.find((item) => item.value === priority)?.label ?? '无优先级';
  return (
    <article className="glass-subtle group rounded-xl p-3 transition-colors hover:border-primary/25 hover:bg-[var(--glass-hover)]">
      <div className="flex items-start justify-between gap-1.5">
        <button type="button" onClick={() => onEdit(task)} className="min-w-0 text-left text-xs leading-relaxed font-bold hover:text-primary">{task.title}</button>
        <button type="button" title="删除任务" aria-label={`删除任务：${task.title}`} onClick={() => onDelete(task)} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive lg:opacity-0 lg:group-hover:opacity-100">
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {task.description && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{task.description}</p>}
      {task.resultSummary && <div className="mt-2 rounded-lg border-l-2 border-success bg-success-bg/70 px-2 py-1.5 text-[11px] leading-relaxed text-success">结果：{task.resultSummary}</div>}
      {(priority !== 'none' || task.dueDate) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          {priority !== 'none' && <span className={priority === 'high' ? 'text-destructive' : priority === 'medium' ? 'text-warning' : 'text-primary'} title={`优先级：${priorityLabel}`}><Flag className="mr-1 inline size-3" />{priorityLabel}</span>}
          {task.dueDate && <span title={`截止日期：${task.dueDate}`}><CalendarDays className="mr-1 inline size-3" />{task.dueDate}</span>}
        </div>
      )}
      <Select value={task.status} onValueChange={(value) => onUpdateStatus(task.id, value as Status)}>
        <SelectTrigger size="sm" className="mt-3 h-8 w-full text-[11px] text-muted-foreground" aria-label={`修改状态：${task.title}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {statuses.map((item) => <SelectItem value={item.value} key={item.value}>{item.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {topics && onAssignTopic && (
        <Select value="unassigned" onValueChange={(value) => { if (value !== 'unassigned') onAssignTopic(task.id, value); }} disabled={assigning}>
          <SelectTrigger size="sm" className="mt-2 h-8 w-full text-[11px] text-muted-foreground" aria-label={`归入主题：${task.title}`}>
            <SelectValue placeholder="归入主题" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unassigned">归入主题</SelectItem>
            {topics.map((topic) => <SelectItem value={topic.id} key={topic.id}>{topic.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </article>
  );
}

type BoardColumnProps = {
  label: string;
  count: number;
  isTodo?: boolean;
  onAddTask?: () => void;
  children: React.ReactNode;
};

export function BoardColumn({ label, count, isTodo = false, onAddTask, children }: BoardColumnProps) {
  return (
    <div className="glass-subtle flex w-[82vw] max-w-80 shrink-0 snap-start flex-col rounded-2xl p-2.5 max-md:max-h-full md:w-auto md:max-w-none md:shrink md:snap-none md:min-h-[350px]">
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground">{label}</h2>
        <span className="glass-control min-w-5 rounded-full px-1.5 py-0.5 text-center text-[10px] text-muted-foreground">{count}</span>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
      {isTodo && onAddTask && (
        <Button variant="ghost" size="sm" className="mt-2 w-full justify-start text-muted-foreground hover:text-primary" onClick={onAddTask}>
          <Plus />添加任务
        </Button>
      )}
    </div>
  );
}
