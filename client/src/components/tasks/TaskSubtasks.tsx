import { Checkbox } from '@/components/ui/checkbox.js';
import { Button } from '@/components/ui/button.js';
import { useTranslation } from 'react-i18next';
import { canHaveSubtasks } from '@/lib/todo.js';
import { QuickCapture } from './QuickCapture.js';
import { useEdit } from './TaskExpand.js';
import { cn } from '@/lib/utils.js';

export function SubtasksSection() {
  const { t } = useTranslation('tasks');
  const edit = useEdit();
  const children = edit.task.children ?? [];
  const canAdd = !edit.readonly && canHaveSubtasks(edit.task);
  if (!canAdd && children.length === 0) return null;
  const done = children.filter((child) => child.status === 'done').length;
  const pct = children.length ? Math.round(done / children.length * 100) : 0;
  return <section aria-label={t('taskSubtasks.label')} className="space-y-1">
    <header className="flex items-center gap-2 px-1">
      <span className="text-xs font-medium text-muted-foreground">{t('taskSubtasks.label')}</span>
      {children.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{done}/{children.length}</span>}
      <div className="task-subtask-progress ml-1 h-0.5 flex-1"><span style={{ width: `${pct}%` }} /></div>
    </header>
    {children.map((child) => <div key={child.id} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-[var(--glass-hover)]">
      <Checkbox shape="round"  className="task-checkbox size-[18px] shrink-0 accent-primary" checked={child.status === 'done'} disabled={edit.readonly} aria-label={t(child.status === 'done' ? 'shared.reopenTask' : 'shared.completeTask', { title: child.title })} onChange={() => { void edit.toggleSubtask(child).catch(() => undefined); }} />
      <Button variant="row" size="bare" type="button" className={cn('min-w-0 flex-1 truncate py-0.5 text-left text-sm', child.status === 'done' && 'text-muted-foreground line-through')} onClick={() => edit.openSubtask(child.id)}>{child.title}</Button>
    </div>)}
    {canAdd && <QuickCapture variant="row" topicId={edit.task.topicId ?? null} parentId={edit.taskId} onCreate={edit.createSubtask} />}
  </section>;
}
