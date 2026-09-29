import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, priorities, statuses, type TaskActivityChange, type TaskActivityEvent } from '@/lib/api.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';

const previewLength = 80;

function quoted(text: string) {
  return `「${text || '空'}」`;
}

function label(kind: 'status' | 'priority', value: string) {
  const options = kind === 'status' ? statuses : priorities;
  return options.find((item) => item.value === value)?.label ?? value;
}

function when(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : '';
}

function Clip({ text }: { text: string }) {
  const chars = Array.from(text);
  const [open, setOpen] = useState(false);
  const long = chars.length > previewLength;
  const shown = !long || open ? text : `${chars.slice(0, previewLength).join('')}…`;
  return <span className="whitespace-pre-wrap break-words">{quoted(shown)}{long && <button type="button" className="ml-1 text-primary" onClick={() => setOpen((value) => !value)}>{open ? '收起' : '展开'}</button>}</span>;
}

function names(values: string[]) {
  return values.length ? values.join('、') : '无';
}

function sentence(change: TaskActivityChange) {
  if (change.field === 'title') return <>把标题从 <Clip text={change.before} /> 改成 <Clip text={change.after} /></>;
  if (change.field === 'description') return <>把详情从 <Clip text={change.before} /> 改成 <Clip text={change.after} /></>;
  if (change.field === 'resultSummary') return <>把结果摘要从 <Clip text={change.before} /> 改成 <Clip text={change.after} /></>;
  if (change.field === 'status') return <>把状态从{label('status', change.before)}改成{label('status', change.after)}</>;
  if (change.field === 'priority') return <>把旗标从{label('priority', change.before)}改成{label('priority', change.after)}</>;
  if (change.field === 'dueDate') return <>把日期从{change.before ?? '无'}改成{change.after ?? '无'}</>;
  if (change.field === 'topicId') return <>把清单从{change.before.name}改成{change.after.name}</>;
  if (change.field === 'parentId') return <>把父任务从{change.before.title}改成{change.after.title}</>;
  if (change.field === 'tagIds') return <>把标签从{names(change.before)}改成{names(change.after)}</>;
  return <>把回收站状态从{change.before ? '已删除' : '未删除'}改成{change.after ? '已删除' : '未删除'}</>;
}

function headline(event: TaskActivityEvent) {
  if (event.action === 'create') return '创建了任务';
  if (event.action === 'delete') return '移入回收站';
  if (event.action === 'restore') return '从回收站恢复';
  if (event.action === 'undo') return '撤销了这次修改';
  return '';
}

export function TaskActivityDialog({ taskId, open, onOpenChange }: { taskId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const activity = useQuery<TaskActivityEvent[]>({ queryKey: ['task-activity', taskId], queryFn: () => api(`/api/tasks/${taskId}/activity`), enabled: open });
  const events = activity.data ?? [];
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent surface="glass">
      <DialogHeader>
        <DialogTitle>任务动态</DialogTitle>
        <DialogDescription>这条任务从创建到现在的改动。</DialogDescription>
      </DialogHeader>
      <div className="max-h-80 space-y-3 overflow-y-auto text-sm">
        {activity.isLoading && <p className="text-muted-foreground">正在加载…</p>}
        {activity.isError && <p className="text-destructive">暂时无法加载任务动态。</p>}
        {activity.data && !events.length && <p className="text-muted-foreground">还没有改动记录。</p>}
        {events.map((event) => <article key={event.id} className="space-y-1">
          <p className="text-muted-foreground">{event.actor.name}{when(event.at) ? ` · ${when(event.at)}` : ''}</p>
          {headline(event) && <p>{headline(event)}</p>}
          {event.changes.map((change, index) => <p key={`${event.id}-${change.field}-${index}`}>{sentence(change)}</p>)}
        </article>)}
      </div>
    </DialogContent>
  </Dialog>;
}
