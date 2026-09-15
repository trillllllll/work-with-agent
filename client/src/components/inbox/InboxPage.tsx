import { useState } from 'react';
import { Inbox, Plus } from 'lucide-react';
import type { Status, Task, Topic } from '@/lib/api.js';
import { statuses } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { BoardColumn, TaskCard } from '@/components/board/BoardColumn.js';

type InboxPageProps = {
  topics: Topic[];
  grouped: Record<Status, Task[]>;
  loading: boolean;
  onCapture: (form: { title: string; description: string }) => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
  onUpdateTaskStatus: (id: string, status: Status) => void;
  onAssignTopic: (id: string, topicId: string) => void;
  assigningTaskId?: string;
  saving?: boolean;
};

export function InboxPage({ topics, grouped, loading, onCapture, onEditTask, onDeleteTask, onUpdateTaskStatus, onAssignTopic, assigningTaskId, saving = false }: InboxPageProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || saving) return;
    onCapture({ title: title.trim(), description: description.trim() });
    setTitle('');
    setDescription('');
  };
  return (
    <div className="min-h-full p-4 pb-10 sm:p-7">
      <header className="border-b glass-divider pb-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className="text-[11px] font-bold tracking-[0.13em] text-muted-foreground uppercase">先收集，再归类</span>
            <h1 className="mt-2 flex items-center gap-2 text-2xl font-semibold tracking-tight"><Inbox className="size-6 text-primary" />收集箱</h1>
            <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted-foreground">把还没想清楚归属的事情先记下来，等线索逐渐聚拢后再归入主题。</p>
          </div>
        </div>
        <form onSubmit={submit} className="glass-subtle mt-5 rounded-2xl p-3">
          <div className="flex gap-2 max-sm:flex-col">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="快速记录一件事…" aria-label="收集任务名称" disabled={saving} />
            <Button type="submit" disabled={!title.trim() || saving}><Plus />{saving ? '正在收集…' : '收集任务'}</Button>
          </div>
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} className="mt-2 min-h-16" placeholder="补充一点背景（可选）" aria-label="收集任务描述" disabled={saving} />
        </form>
      </header>
      {loading ? <div className="mt-6 grid gap-3 md:grid-cols-2 lg:grid-cols-4">{statuses.map(({ value }) => <div key={value} className="glass-subtle h-64 animate-pulse rounded-2xl" />)}</div> : (
        <div className="mt-6 flex gap-3 overflow-x-auto pb-4 snap-x snap-mandatory scroll-px-4 md:grid md:grid-cols-2 md:overflow-visible md:pb-0 lg:grid-cols-4">
          {statuses.map(({ value, label }) => <BoardColumn key={value} label={label} count={grouped[value].length}>
            {grouped[value].map((task) => <TaskCard key={task.id} task={task} onEdit={onEditTask} onDelete={onDeleteTask} onUpdateStatus={onUpdateTaskStatus} topics={topics} onAssignTopic={onAssignTopic} assigning={assigningTaskId === task.id} />)}
          </BoardColumn>)}
        </div>
      )}
    </div>
  );
}
