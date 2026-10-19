import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CloudOff } from 'lucide-react';
import { t as translate } from '../../i18n/index.js';
import { useEditorRuntime, listUploads, subscribeUploads } from '@/lib/task-editor-runtime.js';
import type { SaveStatus } from '@/lib/task-editor-types.js';
import { cn } from '@/lib/utils.js';

export function saveStatusLabel(status: SaveStatus, uploading: boolean): string {
  if (uploading) return translate('tasks:saveStatus.uploading');
  switch (status) {
    case 'local-pending': return translate('tasks:saveStatus.localPending');
    case 'saving': return translate('tasks:saveStatus.saving');
    case 'local-only': return translate('tasks:saveStatus.localOnly');
    case 'conflict': return translate('tasks:saveStatus.conflict');
    case 'storage-error': return translate('tasks:saveStatus.storageError');
    case 'blocked': return translate('tasks:saveStatus.blocked');
    default: return '';
  }
}

/** 活跃任务的保存状态行：role=status、aria-live=polite；“已保存”1500ms 后隐藏文字但保留高度。 */
export function SaveStatusRow({ status, taskId }: { status: SaveStatus; taskId: string }) {
  const { t } = useTranslation('tasks');
  const [recentlySaved, setRecentlySaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const previous = useRef<SaveStatus>(status);
  useEffect(() => {
    const refresh = () => setUploading(listUploads().some((upload) => upload.taskId === taskId && (upload.state === 'compressing' || upload.state === 'uploading')));
    refresh();
    const unsubscribe = subscribeUploads(refresh);
    return () => { unsubscribe(); };
  }, [taskId]);
  useEffect(() => {
    if (previous.current === 'saving' && status === 'clean') {
      setRecentlySaved(true);
      const timer = window.setTimeout(() => setRecentlySaved(false), 1500);
      previous.current = status;
      return () => window.clearTimeout(timer);
    }
    previous.current = status;
  }, [status]);
  const label = recentlySaved && status === 'clean' ? t('saveStatus.saved') : saveStatusLabel(status, uploading);
  const tone = status === 'conflict' || status === 'local-only' || status === 'blocked'
    ? 'task-save-warning'
    : status === 'storage-error' ? 'task-save-error' : 'task-save-muted';
  return <p role="status" aria-live="polite" className={cn('task-save-status min-h-5 text-[12px] leading-5', label ? tone : '')}>{label}</p>;
}

/** 窗口右下角的“X 项未同步”入口。 */
export function UnsyncedTasksButton({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const { t } = useTranslation('tasks');
  const runtime = useEditorRuntime();
  const coordinator = runtime?.coordinator ?? null;
  const [unsynced, setUnsynced] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [, force] = useStateReducer();
  const notified = useRef(new Set<string>());

  useEffect(() => {
    if (!coordinator) return;
    const refresh = () => {
      setUnsynced(coordinator.unsyncedTaskIds());
      force();
    };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [coordinator]);

  useEffect(() => {
    const unsubscribe = subscribeUploads(() => force());
    return () => { unsubscribe(); };
  }, []);

  const uploads = listUploads().filter((upload) => upload.state === 'compressing' || upload.state === 'uploading');
  const count = unsynced.length + uploads.length;
  if (!count) return null;
  return createPortal(<div className="task-unsynced-dock">
    <button type="button" className="task-unsynced-button" aria-label={t('saveStatus.unsyncedLabel', { count })} onClick={() => setOpen((value) => !value)}>
      <CloudOff className="size-4" aria-hidden />
      {t('saveStatus.unsyncedCount', { count })}
    </button>
    {open && <div className="task-unsynced-list" role="dialog" aria-label={t('saveStatus.unsyncedList')}>
      {unsynced.map((taskId) => {
        const record = coordinator?.getRecord(taskId);
        return <button key={taskId} type="button" className="task-unsynced-item" onClick={() => { onOpenTask(taskId); setOpen(false); }}>
          <span className="task-unsynced-title">{record?.draft.title || t('shared.untitled')}</span>
          <span className="task-unsynced-state">{saveStatusLabel(coordinator?.status(taskId) ?? 'local-only', false) || t('saveStatus.unsynced')}</span>
        </button>;
      })}
      {uploads.map((upload) => <div key={upload.uploadId} className="task-unsynced-item" role="status">
        <span className="task-unsynced-title">{upload.fileName}</span>
        <span className="task-unsynced-state">{upload.state === 'compressing' ? t('saveStatus.compressing') : t('saveStatus.uploading')}</span>
      </div>)}
    </div>}
  </div>, document.body);
}

function useStateReducer(): [number, () => void] {
  const [state, setState] = useState(0);
  return [state, () => setState((value) => value + 1)];
}
