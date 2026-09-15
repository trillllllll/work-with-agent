import { MessageSquare } from 'lucide-react';
import { statuses, type Status, type Task, type Topic } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { BoardColumn, TaskCard } from './BoardColumn.js';
import { SummaryPanel } from './SummaryPanel.js';
import { EmptyState } from './EmptyState.js';

type BoardViewProps = {
  detail?: Topic;
  hasTopic: boolean;
  grouped: Record<Status, Task[]>;
  tasksLoading: boolean;
  summaryBusy: boolean;
  onNewTopic: () => void;
  onNewTask: () => void;
  onDeleteTopic: () => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
  onUpdateTaskStatus: (id: string, status: Status) => void;
  onConfirmSummary: (action: 'confirm' | 'discard') => void;
  onOpenSettings: () => void;
  showOpenChat?: boolean;
  onOpenChat?: () => void;
};

export function BoardView({ detail, hasTopic, grouped, tasksLoading, summaryBusy, onNewTopic, onNewTask, onDeleteTopic, onEditTask, onDeleteTask, onUpdateTaskStatus, onConfirmSummary, onOpenSettings, showOpenChat = false, onOpenChat }: BoardViewProps) {
  return (
    <div className="p-4 pb-10 sm:p-7">
      <header className="flex flex-col gap-4 border-b glass-divider pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <span className="text-[11px] font-bold tracking-[0.13em] text-muted-foreground uppercase">任务管理</span>
          <h1 className="mt-2 text-2xl leading-tight font-semibold tracking-tight">{detail?.name ?? '选择一个主题'}</h1>
          <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted-foreground">{detail?.description || '把想法拆成下一步，持续推进到结果。'}</p>
          {detail?.goal && <p className="mt-1.5 text-[13px] font-semibold text-success">目标：{detail.goal}</p>}
        </div>
        {(showOpenChat || hasTopic) && (
          <div className="flex shrink-0 items-center gap-2 max-sm:w-full">
            {showOpenChat && onOpenChat && <Button variant="ghost" size="icon" title="打开聊天" aria-label="打开聊天" onClick={onOpenChat}><MessageSquare /></Button>}
            {hasTopic && (
              <>
                <Button variant="outline" className="text-destructive hover:bg-destructive/10 hover:text-destructive max-sm:flex-1" onClick={onDeleteTopic}>删除主题</Button>
                <Button className="max-sm:flex-1" onClick={onNewTask}>新建任务</Button>
              </>
            )}
          </div>
        )}
      </header>

      <SummaryPanel detail={detail} busy={summaryBusy} onConfirm={onConfirmSummary} />

      {!hasTopic && (
        <EmptyState
          title="从一个主题开始"
          description="主题是任务逐渐收敛成结果的容器。"
          actionLabel="创建探索主题"
          onAction={onNewTopic}
          secondaryActionLabel="模型设置"
          onSecondaryAction={onOpenSettings}
        />
      )}

      {hasTopic && (
        tasksLoading ? (
          <div className="mt-6 grid gap-3 max-md:flex max-md:overflow-hidden md:grid-cols-2 lg:grid-cols-4">
            {statuses.map(({ value }) => <Skeleton key={value} className="h-64 w-full" />)}
          </div>
        ) : (
          <div className="mt-6 flex gap-3 overflow-x-auto pb-4 snap-x snap-mandatory scroll-px-4 md:grid md:grid-cols-2 md:overflow-visible md:pb-0 lg:grid-cols-4">
            {statuses.map(({ value, label }) => (
              <BoardColumn key={value} label={label} count={grouped[value].length} isTodo={value === 'todo'} onAddTask={onNewTask}>
                {grouped[value].map((task) => (
                  <TaskCard key={task.id} task={task} onEdit={onEditTask} onDelete={onDeleteTask} onUpdateStatus={onUpdateTaskStatus} />
                ))}
              </BoardColumn>
            ))}
          </div>
        )
      )}
    </div>
  );
}
