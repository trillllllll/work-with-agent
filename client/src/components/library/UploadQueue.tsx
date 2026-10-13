import './library.css';
import { useState } from 'react';
import { cancelQueued, clearFinishedUploads, resolveDuplicate, retryUpload, useUploads } from './upload.js';

const statusCopy: Record<string, string> = {
  queued: '等待上传',
  uploading: '正在上传',
  duplicate: '发现相同原件',
  creating: '正在保存',
  done: '已保存',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消',
};

export function UploadQueue() {
  const records = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  if (!records.length) return null;
  const finished = records.some((record) => record.status === 'done' || record.status === 'skipped' || record.status === 'cancelled');
  return <aside className="library-surface library-upload-queue" data-testid="library-upload-queue" aria-label="上传队列">
    <div className="library-upload-head">
      <p className="library-name">上传</p>
      <div className="flex gap-1">
        {finished && <button type="button" className="library-btn" onClick={() => clearFinishedUploads()}>清除已完成</button>}
        <button type="button" className="library-btn" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>{collapsed ? '展开' : '收起'}</button>
      </div>
    </div>
    {!collapsed && <ul className="mt-2 space-y-2">
      {records.map((record) => {
        const label = statusCopy[record.status] ?? record.status;
        const progress = record.progress == null ? label : `${label} ${Math.round(record.progress * 100)}%`;
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
            {(record.status === 'queued' || record.status === 'uploading' || record.status === 'creating') && <button type="button" className="library-btn" onClick={() => cancelQueued(record.localId)}>取消</button>}
            {record.status === 'failed' && <button type="button" className="library-btn" onClick={() => { void retryUpload(record.localId); }}>重试</button>}
            {record.status === 'duplicate' && <>
              <p className="library-meta w-full">发现相同原件</p>
              {(record.duplicates ?? []).map((item) => <span key={item.id} className="flex min-w-0 items-center gap-1">
                <span className="library-name truncate" title={item.title}>{item.title}</span>
                <button type="button" className="library-btn" onClick={() => { void resolveDuplicate(record.localId, 'reuse', record.target, item.id); }}>使用已有</button>
              </span>)}
              <button type="button" className="library-btn" onClick={() => { void resolveDuplicate(record.localId, 'create', record.target); }}>另存一份</button>
              <button type="button" className="library-btn" onClick={() => { void resolveDuplicate(record.localId, 'skip', record.target); }}>跳过</button>
            </>}
          </div>
        </li>;
      })}
    </ul>}
  </aside>;
}
