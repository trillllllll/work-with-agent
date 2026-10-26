import { Button } from '@/components/ui/button.js';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, priorities, statuses, type TaskActivityChange, type TaskActivityEvent } from '@/lib/api.js';
import { recurrenceLabel } from '@/lib/recurrence.js';
import { intlLocale, t as translate } from '../../i18n/index.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';

const previewLength = 80;

function quoted(text: string) {
  return translate('tasks:activity.quoted', { text: text || translate('tasks:activity.empty') });
}

function label(kind: 'status' | 'priority', value: string) {
  const options = kind === 'status' ? statuses : priorities;
  return options.find((item) => item.value === value)?.label ?? value;
}

function when(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString(intlLocale()) : '';
}

function Clip({ text }: { text: string }) {
  const { t } = useTranslation('tasks');
  const chars = Array.from(text);
  const [open, setOpen] = useState(false);
  const long = chars.length > previewLength;
  const shown = !long || open ? text : `${chars.slice(0, previewLength).join('')}…`;
  return <span className="whitespace-pre-wrap break-words">{quoted(shown)}{long && <Button variant="plain" size="bare" type="button" className="ml-1 text-brand-link" onClick={() => setOpen((value) => !value)}>{open ? t('activity.collapse') : t('activity.expand')}</Button>}</span>;
}

function names(values: string[]) {
  return values.length ? values.join(translate('tasks:activity.nameSeparator')) : translate('tasks:shared.none');
}

function minutesText(value: number | null) {
  return value === null ? translate('tasks:shared.none') : translate('tasks:shared.minuteCount', { count: value });
}

function recurrenceText(value: string) {
  return value ? recurrenceLabel(value) : translate('tasks:recurrence.none');
}

function orNone(value: string | null | undefined) {
  return value ?? translate('tasks:shared.none');
}

function changeText(key: string, before: string, after: string) {
  return translate(key, { before, after });
}

function sentence(change: TaskActivityChange) {
  if (change.field === 'title') return <Trans t={translate} i18nKey="tasks:activity.titleChange" components={{ before: <Clip text={change.before} />, after: <Clip text={change.after} /> }} />;
  if (change.field === 'description') return <Trans t={translate} i18nKey="tasks:activity.descriptionChange" components={{ before: <Clip text={change.before} />, after: <Clip text={change.after} /> }} />;
  if (change.field === 'resultSummary') return <Trans t={translate} i18nKey="tasks:activity.resultChange" components={{ before: <Clip text={change.before} />, after: <Clip text={change.after} /> }} />;
  if (change.field === 'status') return changeText('tasks:activity.statusChange', label('status', change.before), label('status', change.after));
  if (change.field === 'priority') return changeText('tasks:activity.priorityChange', label('priority', change.before), label('priority', change.after));
  if (change.field === 'dueDate') return changeText('tasks:activity.dateChange', orNone(change.before), orNone(change.after));
  if (change.field === 'scheduledStart' || change.field === 'scheduledEnd') return changeText(change.field === 'scheduledStart' ? 'tasks:activity.startChange' : 'tasks:activity.endChange', orNone(change.before?.replace('T', ' ')), orNone(change.after?.replace('T', ' ')));
  if (change.field === 'estimatedMinutes') return changeText('tasks:activity.estimateChange', minutesText(change.before), minutesText(change.after));
  if (change.field === 'recurrenceRule') return changeText('tasks:activity.recurrenceChange', recurrenceText(change.before), recurrenceText(change.after));
  if (change.field === 'topicId') return changeText('tasks:activity.listChange', change.before.name, change.after.name);
  if (change.field === 'parentId') return changeText('tasks:activity.parentChange', change.before.title, change.after.title);
  if (change.field === 'tagIds') return changeText('tasks:activity.tagsChange', names(change.before), names(change.after));
  return changeText('tasks:activity.trashChange', change.before ? translate('tasks:activity.deleted') : translate('tasks:activity.notDeleted'), change.after ? translate('tasks:activity.deleted') : translate('tasks:activity.notDeleted'));
}

function headline(event: TaskActivityEvent) {
  if (event.action === 'create') return translate('tasks:activity.created');
  if (event.action === 'delete') return translate('tasks:activity.movedToTrash');
  if (event.action === 'restore') return translate('tasks:activity.restored');
  if (event.action === 'undo') return translate('tasks:activity.undone');
  return '';
}

export function TaskActivityDialog({ taskId, open, onOpenChange }: { taskId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('tasks');
  const activity = useQuery<TaskActivityEvent[]>({ queryKey: ['task-activity', taskId], queryFn: () => api(`/api/tasks/${taskId}/activity`), enabled: open });
  const events = activity.data ?? [];
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent surface="glass">
      <DialogHeader>
        <DialogTitle>{t('activity.title')}</DialogTitle>
        <DialogDescription>{t('activity.description')}</DialogDescription>
      </DialogHeader>
      <div className="max-h-80 space-y-3 overflow-y-auto text-sm">
        {activity.isLoading && <p className="text-muted-foreground">{t('shared.loading')}</p>}
        {activity.isError && <p className="text-destructive">{t('activity.loadError')}</p>}
        {activity.data && !events.length && <p className="text-muted-foreground">{t('activity.emptyHistory')}</p>}
        {events.map((event) => <article key={event.id} className="space-y-1">
          <p className="text-muted-foreground">{when(event.at) ? t('activity.actorAt', { name: event.actor.name, time: when(event.at) }) : event.actor.name}</p>
          {headline(event) && <p>{headline(event)}</p>}
          {event.changes.map((change, index) => <p key={`${event.id}-${change.field}-${index}`}>{sentence(change)}</p>)}
        </article>)}
      </div>
    </DialogContent>
  </Dialog>;
}
