import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, statuses, type Task } from '@/lib/api.js';
import { t } from '../../i18n/index.js';

function topicName(task: Task) {
  return task.topic?.name ?? t('library:shared.inbox');
}

function statusName(status: string) {
  return statuses.find((item) => item.value === status)?.label ?? status;
}

export function TaskLinkPicker({ selectedIds, onChange }: { selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useTranslation('library');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);
  const tasks = useQuery({
    queryKey: ['library', 'task-picker', debounced],
    queryFn: ({ signal }) => api<Task[]>(debounced ? `/api/tasks?q=${encodeURIComponent(debounced)}` : '/api/tasks', { signal }),
  });
  const toggle = (taskId: string, checked: boolean) => {
    onChange(checked ? [...new Set([...selectedIds, taskId])] : selectedIds.filter((item) => item !== taskId));
  };
  return <div className="library-task-picker" data-testid="library-task-picker">
    <input className="library-search library-task-search" aria-label={t('taskLinkPicker.searchLabel')} value={query} onChange={(event) => setQuery(event.target.value)} />
    {selectedIds.length > 0 && <p className="library-meta">{t('taskLinkPicker.selected', { count: selectedIds.length })}</p>}
    {tasks.isError && <div className="library-meta" role="alert"><p>{tasks.error instanceof Error ? tasks.error.message : t('taskLinkPicker.loadFailed')}</p><button type="button" className="library-btn" onClick={() => { void tasks.refetch(); }}>{t('shared.retry')}</button></div>}
    {!tasks.isError && <ul className="library-task-results">
      {(tasks.data ?? []).map((task) => <li key={task.id} data-testid={`task-picker-row-${task.id}`}>
        <label className="library-task-option">
          <input type="checkbox" aria-label={t('shared.selectNamed', { name: task.title })} checked={selectedIds.includes(task.id)} onChange={(event) => toggle(task.id, event.target.checked)} />
          <span className="min-w-0">
            <span className="library-name block truncate">{task.title}</span>
            <span className="library-meta block truncate">{topicName(task)} · {statusName(task.status)}</span>
          </span>
        </label>
      </li>)}
      {!tasks.isLoading && (tasks.data ?? []).length === 0 && <li className="library-meta">{t('taskLinkPicker.empty')}</li>}
    </ul>}
  </div>;
}
