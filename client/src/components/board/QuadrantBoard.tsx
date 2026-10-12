import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import type { TaskPriority } from '@/lib/api.js';
import { quadrantDefinitions } from '@/lib/quadrant.js';
import { TaskCard, type TaskCardProps } from './BoardColumn.js';

type Props = {
  tasks: TaskCardProps['task'][];
  showCompleted: boolean;
  onShowCompleted: (show: boolean) => void;
  onMoveQuadrant: (task: TaskCardProps['task'], priority: TaskPriority) => Promise<unknown>;
} & Omit<TaskCardProps, 'task'>;

function sortTasks(tasks: TaskCardProps['task'][]) {
  return [...tasks].sort((left, right) => {
    const due = (left.scheduledStart ?? left.dueDate ?? '9999-99-99').localeCompare(right.scheduledStart ?? right.dueDate ?? '9999-99-99');
    return due || (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.id.localeCompare(right.id);
  });
}

function QuadrantLane({ definition, tasks, props, showCompleted }: { definition: typeof quadrantDefinitions[number]; tasks: TaskCardProps['task'][]; props: Omit<Props, 'tasks' | 'showCompleted' | 'onShowCompleted' | 'onMoveQuadrant'>; showCompleted: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: definition.id });
  const active = sortTasks(tasks.filter((task) => task.status !== 'done'));
  const completed = sortTasks(tasks.filter((task) => task.status === 'done'));
  return <section ref={setNodeRef} aria-label={`${definition.title}，${definition.description}`} className={cn('flex min-h-[17rem] min-w-0 flex-col rounded-2xl border bg-[var(--glass-bg)] p-3 transition-colors', isOver && 'border-primary/60 bg-[var(--glass-hover)]')}>
    <header className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0"><h2 className={cn('inline-flex rounded-md border px-2 py-1 text-sm font-semibold', definition.tone)}>{definition.title}</h2><p className="mt-1 text-xs text-muted-foreground">{definition.description}</p></div>
      <span className="glass-control shrink-0 rounded-full px-2 py-0.5 text-xs text-muted-foreground">{tasks.length}</span>
    </header>
    <div className="flex min-h-24 flex-1 flex-col gap-2">
      {active.map((task) => <DraggableTask key={task.id} task={task} props={props} />)}
      {!active.length && !completed.length && <p className="grid min-h-20 flex-1 place-items-center rounded-xl border border-dashed border-border/70 px-3 text-center text-xs text-muted-foreground">拖动任务到这里</p>}
      {showCompleted && completed.length > 0 && <details className="mt-1 rounded-xl border border-dashed border-border/60 px-2 py-1.5"><summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground"><ChevronDown className="size-3.5" />已完成 · {completed.length}</summary><div className="mt-2 flex flex-col gap-2">{completed.map((task) => <DraggableTask key={task.id} task={task} props={props} completed />)}</div></details>}
    </div>
  </section>;
}

function DraggableTask({ task, props, completed = false }: { task: TaskCardProps['task']; props: Omit<Props, 'tasks' | 'showCompleted' | 'onShowCompleted' | 'onMoveQuadrant'>; completed?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id, disabled: props.readonly || props.busy });
  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), touchAction: 'manipulation' }} className={cn('relative', isDragging && 'opacity-40', completed && 'opacity-75')} {...attributes} {...listeners}>
    <span aria-hidden="true" className="pointer-events-none absolute right-9 top-3 z-10 text-muted-foreground/45"><GripVertical className="size-3.5" /></span>
    <TaskCard {...props} task={task} />
  </div>;
}

export function QuadrantBoard({ tasks, showCompleted, onShowCompleted, onMoveQuadrant, ...props }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor));
  const handleDragEnd = (event: DragEndEvent) => {
    const target = typeof event.over?.id === 'string' ? event.over.id as TaskPriority : undefined;
    const task = tasks.find((item) => item.id === String(event.active.id));
    if (!target || !task || task.priority === target || !quadrantDefinitions.some((definition) => definition.id === target)) return;
    void onMoveQuadrant(task, target);
  };
  return <div className="space-y-3" data-testid="quadrant-board">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">拖动任务到其他区域，或打开任务详情使用优先级按钮调整分类。</p><label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showCompleted} onChange={(event) => onShowCompleted(event.target.checked)} />显示已完成</label></div>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">{quadrantDefinitions.map((definition) => <QuadrantLane key={definition.id} definition={definition} tasks={tasks.filter((task) => task.priority === definition.id)} props={props} showCompleted={showCompleted} />)}</div>
    </DndContext>
  </div>;
}
