import './library.css';
import { resolveDuplicate, retryUpload, useUploads } from './upload.js';

const statusCopy: Record<string, string> = {
  queued: '等待上传',
  uploading: '正在上传',
  duplicate: '发现相同原件',
  creating: '正在保存',
  done: '已保存',
  failed: '失败',
  skipped: '已跳过',
};

export function UploadQueue() {
  const records = useUploads();
  if (!records.length) return null;
  return <aside className="library-surface library-upload-queue" data-testid="library-upload-queue" aria-label="上传队列">
    <p className="library-name">上传</p>
    <ul className="mt-2 space-y-2">
      {records.map((record) => <li key={record.localId}>
        <div className="flex items-center justify-between gap-2">
          <span className="library-name truncate" title={record.relativePath}>{record.name}</span>
          <span className="library-meta shrink-0">{record.progress == null ? statusCopy[record.status] : `${statusCopy[record.status]} ${Math.round(record.progress * 100)}%`}</span>
        </div>
        <div className="library-progress mt-1" aria-hidden>
          <span className={record.progress == null ? 'indeterminate' : undefined} style={record.progress == null ? undefined : { width: `${Math.round(record.progress * 100)}%` }} />
        </div>
        {record.error && <p className="library-meta" style={{ color: 'var(--lib-danger)' }}>{record.error}</p>}
        {record.status === 'failed' && <button type="button" className="library-btn mt-1" onClick={() => { void retryUpload(record.localId); }}>重试</button>}
        {record.status === 'duplicate' && <div className="mt-1 flex flex-wrap gap-1">
          <button type="button" className="library-btn" onClick={() => { void resolveDuplicate(record.localId, 'reuse', record.target, record.duplicates?.[0]?.id); }}>使用已有</button>
          <button type="button" className="library-btn" onClick={() => { void resolveDuplicate(record.localId, 'create', record.target); }}>另存一份</button>
          <button type="button" className="library-btn" onClick={() => { void resolveDuplicate(record.localId, 'skip', record.target); }}>跳过</button>
        </div>}
      </li>)}
    </ul>
  </aside>;
}
