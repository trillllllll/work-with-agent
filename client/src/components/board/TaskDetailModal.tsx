import type { FormEvent } from 'react';
import { CalendarDays, CircleDot, Flag, FolderKanban } from 'lucide-react';
import type { Task, TaskPriority } from '@/lib/api.js';
import { priorities, statuses } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';

type TaskDetailModalProps = {
  task: Task;
  topicName?: string;
  onChange: (task: Task) => void;
  onClose: () => void;
  onSave: () => void;
  busy?: boolean;
};

function formatUpdatedAt(value?: string) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

export function TaskDetailModal({ task, topicName, onChange, onClose, onSave, busy = false }: TaskDetailModalProps) {
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(); };
  const update = (changes: Partial<Task>) => onChange({ ...task, ...changes });
  const priority = task.priority ?? 'none';
  const dueDate = task.dueDate ?? '';

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent surface="glass" className="gap-0 overflow-hidden p-0 max-md:top-auto max-md:bottom-0 max-md:left-0 max-md:max-h-[92dvh] max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-t-2xl max-md:rounded-b-none sm:max-w-2xl">
        <DialogHeader className="border-b glass-divider px-5 py-4 pr-14 text-left sm:px-6">
          <DialogTitle>任务详情</DialogTitle>
          <DialogDescription>把任务背景、优先级和下一步安排放在同一个地方。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="overflow-y-auto px-5 py-4 sm:px-6">
          <div className="mb-5">
            <Label htmlFor="task-detail-title">任务名称</Label>
            <Input id="task-detail-title" required autoFocus value={task.title} onChange={(event) => update({ title: event.target.value })} placeholder="下一步要完成什么？" disabled={busy} className="mt-2 h-11 text-base font-semibold" />
          </div>

          <div className="mb-5 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="task-detail-status">状态</Label>
              <Select value={task.status} onValueChange={(value) => update({ status: value as Task['status'] })} disabled={busy}>
                <SelectTrigger id="task-detail-status" className="mt-2 w-full" aria-label="任务状态"><CircleDot className="size-4" /><SelectValue /></SelectTrigger>
                <SelectContent>{statuses.map((item) => <SelectItem value={item.value} key={item.value}>{item.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="task-detail-priority">优先级</Label>
              <Select value={priority} onValueChange={(value) => update({ priority: value as TaskPriority })} disabled={busy}>
                <SelectTrigger id="task-detail-priority" className="mt-2 w-full" aria-label="任务优先级"><Flag className="size-4" /><SelectValue /></SelectTrigger>
                <SelectContent>{priorities.map((item) => <SelectItem value={item.value} key={item.value}>{item.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>

          <div className="mb-5 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="task-detail-due-date">截止日期</Label>
              <div className="relative mt-2">
                <CalendarDays className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="task-detail-due-date" type="date" value={dueDate} onChange={(event) => update({ dueDate: event.target.value || null })} disabled={busy} className="pl-9" />
              </div>
            </div>
            <div>
              <Label>所属主题</Label>
              <div className="glass-control mt-2 flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-muted-foreground"><FolderKanban className="size-4 shrink-0" /><span className="truncate">{topicName ?? (task.topicId ? '当前主题' : '收集箱')}</span></div>
            </div>
          </div>

          <div className="mb-5">
            <Label htmlFor="task-detail-description">任务描述</Label>
            <Textarea id="task-detail-description" value={task.description} onChange={(event) => update({ description: event.target.value })} placeholder="补充背景、范围或验收标准" disabled={busy} className="mt-2 min-h-24" />
          </div>

          <div className="mb-5">
            <Label htmlFor="task-detail-result">结果摘要</Label>
            <Textarea id="task-detail-result" value={task.resultSummary} onChange={(event) => update({ resultSummary: event.target.value })} placeholder="完成后记录最终结果" disabled={busy} className="mt-2 min-h-20" />
          </div>

          <p className="mb-4 text-[11px] text-muted-foreground">最近更新：{formatUpdatedAt(task.updatedAt)}</p>
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button disabled={busy}>{busy ? '正在保存…' : '保存任务'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
