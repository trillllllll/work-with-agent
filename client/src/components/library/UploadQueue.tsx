import './library.css';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { cancelQueued, clearFinishedUploads, resolveDuplicate, retryUpload, useUploads } from './upload.js';
import type { UploadStatus } from './upload.js';

export function UploadQueue() {
  const { t } = useTranslation('library');
  const records = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  if (!records.length) return null;
  const finished = records.some((record) => record.status === 'done' || record.status === 'skipped' || record.status === 'cancelled');
  return <aside className="library-surface library-upload-queue" data-testid="library-upload-queue" aria-label={t('uploadQueue.label')}>
    <div className="library-upload-head">
      <p className="library-name">{t('uploadQueue.title')}</p>
      <div className="flex gap-1">
        {finished && <button type="button" className="library-btn" onClick={() => clearFinishedUploads()}>{t('uploadQueue.clearFinished')}</button>}
        <button type="button" className="library-btn" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>{collapsed ? t('uploadQueue.expand') : t('uploadQueue.collapse')}</button>
      </div>
    </div>
    {!collapsed && <ul className="mt-2 space-y-2">
      {records.map((record) => {
        const label = t(`uploadQueue.status.${record.status as UploadStatus}`);
        const progress = record.progress == null ? label : t('uploadQueue.progress', { label, percent: Math.round(record.progress * 100) });
        return <li key={record.localId}>
          <div className="flex items-center justify-between gap-2">
            <span className="library-name truncate" title={record.relativePath}>{record.name}</span>
            <span className="library-meta shrink-0">{progress}</span>
          </div>
          <div className="library-progress mt-1" aria-hidden>
            <span className={record.progress == null ? 'indeterminate' : undefined} style={record.progress == null ? undefined : { width: `${Math.round(record.progress * 100)}%` }} />
          </div>
          {record.error && <p className="library-meta" style={{ color: 'var(--lib-danger)' }}>{record.error}</p>}
          <div className="mt-1 flex flex-wrap gap-1">
            {(record.status === 'queued' || record.status === 'uploading' || record.status === 'creating') && <button type="button" className="library-btn" onClick={() => cancelQueued(record.localId)}>{t('shared.cancel')}</button>}
            {record.status === 'failed' && <button type="button" className="library-btn" onClick={() => { void retryUpload(record.localId); }}>{t('shared.retry')}</button>}
            {record.status === 'duplicate' && <>
              <p className="library-meta w-full">{t('uploadQueue.status.duplicate')}</p>
              {(record.duplicates ?? []).map((item) => <span key={item.id} className="flex min-w-0 items-center gap-1">
                <span className="library-name truncate" title={item.title}>{item.title}</span>
                <button type="button" className="library-btn" onClick={() => { void resolveDuplicate(record.localId, 'reuse', record.target, item.id); }}>{t('uploadQueue.useExisting')}</button>
              </span>)}
              <button type="button" className="library-btn" onClick={() => { void resolveDuplicate(record.localId, 'create', record.target); }}>{t('uploadQueue.saveCopy')}</button>
              <button type="button" className="library-btn" onClick={() => { void resolveDuplicate(record.localId, 'skip', record.target); }}>{t('uploadQueue.skip')}</button>
            </>}
          </div>
        </li>;
      })}
    </ul>}
  </aside>;
}
