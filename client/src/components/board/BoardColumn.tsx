import { Plus, Trash2 } from 'lucide-react';
import { statuses, type Status, type Task } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';

type TaskCardProps = {
  task: Task;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onUpdateStatus: (id: string, status: Status) => void;
};

export function TaskCard({ task, onEdit, onDelete, onUpdateStatus }: TaskCardProps) {
  return (
    <article className="group rounded-lg border bg-card p-3 shadow-card transition-colors hover:border-muted-foreground/40">
      <div className="flex items-start justify-between gap-1.5">
        <button type="button" onClick={() => onEdit(task)} className="min-w-0 text-left text-xs leading-relaxed font-bold hover:text-primary">{task.title}</button>
        <button type="button" title="删除任务" aria-label={`删除任务：${task.title}`} onClick={() => onDelete(task)} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive lg:opacity-0 lg:group-hover:opacity-100">
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {task.description && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{task.description}</p>}
      {task.resultSummary && <div className="mt-2 rounded-md border-l-2 border-success bg-success-bg px-2 py-1.5 text-[11px] leading-relaxed text-success">结果：{task.resultSummary}</div>}
      <select
        value={task.status}
        onChange={(event) => onUpdateStatus(task.id, event.target.value as Status)}
        className="mt-3 h-8 w-full rounded-md border bg-background px-2 text-[11px] text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={`修改状态：${task.title}`}
      >
        {statuses.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
      </select>
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
    <div className="flex w-[82vw] max-w-80 shrink-0 snap-start flex-col rounded-lg border bg-muted p-2.5 max-md:max-h-full md:w-auto md:max-w-none md:shrink md:snap-none md:min-h-[350px]">
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground">{label}</h2>
        <span className="min-w-5 rounded-full border bg-background px-1.5 py-0.5 text-center text-[10px] text-muted-foreground">{count}</span>
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
