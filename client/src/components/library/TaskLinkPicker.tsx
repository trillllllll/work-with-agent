import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, statuses, type Task } from '@/lib/api.js';

function topicName(task: Task) {
  return task.topic?.name ?? '收集箱';
}

function statusName(status: string) {
  return statuses.find((item) => item.value === status)?.label ?? status;
}

export function TaskLinkPicker({ selectedIds, onChange }: { selectedIds: string[]; onChange: (ids: string[]) => void }) {
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
    <input className="library-search library-task-search" aria-label="搜索任务" value={query} onChange={(event) => setQuery(event.target.value)} />
    {selectedIds.length > 0 && <p className="library-meta">已选 {selectedIds.length} 个任务</p>}
    {tasks.isError && <div className="library-meta" role="alert"><p>{tasks.error instanceof Error ? tasks.error.message : '任务没有加载'}</p><button type="button" className="library-btn" onClick={() => { void tasks.refetch(); }}>重试</button></div>}
    {!tasks.isError && <ul className="library-task-results">
      {(tasks.data ?? []).map((task) => <li key={task.id} data-testid={`task-picker-row-${task.id}`}>
        <label className="library-task-option">
          <input type="checkbox" aria-label={`选择 ${task.title}`} checked={selectedIds.includes(task.id)} onChange={(event) => toggle(task.id, event.target.checked)} />
          <span className="min-w-0">
            <span className="library-name block truncate">{task.title}</span>
            <span className="library-meta block truncate">{topicName(task)} · {statusName(task.status)}</span>
          </span>
        </label>
      </li>)}
      {!tasks.isLoading && (tasks.data ?? []).length === 0 && <li className="library-meta">没有符合条件的任务</li>}
    </ul>}
  </div>;
}
