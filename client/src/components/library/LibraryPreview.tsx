import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, type Task } from '@/lib/api.js';
import { submitCommands } from '@/lib/platform.js';
import { stageUpload } from './upload.js';
import { extractionCopy, formatLocator, formatUpdated, kindLabels, type LibraryFolder, type LibraryTag, type LinkedTask, type MaterialDetail, type Page } from './types.js';

type Chunk = { id: string; ordinal: number; text: string; method: string; locator: { kind: string } };

function canLayout(mime: string | null, kind: string) {
  if (mime?.startsWith('image/') || mime === 'application/pdf' || mime?.startsWith('text/')) return true;
  return kind === 'text' || kind === 'markdown';
}

export function LibraryPreview({ id, onClose, onOpenTask }: { id: string; onClose: () => void; onOpenTask?: (taskId: string) => void }) {
  const client = useQueryClient();
  const detail = useQuery({ queryKey: ['library', 'material', id], queryFn: ({ signal }) => api<MaterialDetail>(`/api/v1/library/materials/${id}`, { signal }) });
  const tasks = useQuery({ queryKey: ['library', 'material-tasks', id], queryFn: ({ signal }) => api<Page<LinkedTask>>(`/api/v1/library/materials/${id}/tasks?limit=100`, { signal }) });
  const folders = useQuery({ queryKey: ['library', 'folders'], queryFn: ({ signal }) => api<{ items: LibraryFolder[] }>('/api/v1/library/folders', { signal }) });
  const tags = useQuery({ queryKey: ['library', 'tags'], queryFn: ({ signal }) => api<{ items: LibraryTag[] }>('/api/v1/library/tags', { signal }) });
  const allTasks = useQuery({ queryKey: ['library', 'all-tasks'], queryFn: ({ signal }) => api<Task[]>('/api/tasks', { signal }) });
  const material = detail.data;
  const [revision, setRevision] = useState<number | null>(null);
  const [tab, setTab] = useState<'original' | 'text'>('original');
  const [folderId, setFolderId] = useState<string>('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [addTaskId, setAddTaskId] = useState('');
  const viewed = revision ?? material?.revision ?? 0;
  const content = useQuery({
    queryKey: ['library', 'content', id, viewed],
    queryFn: ({ signal }) => api<Page<Chunk>>(`/api/v1/library/materials/${id}/content?revision=${viewed}&limit=100`, { signal }),
    enabled: viewed > 0,
  });
  useEffect(() => { setRevision(null); setTab('original'); }, [id]);
  useEffect(() => {
    if (!material) return;
    setFolderId(material.folderId ?? '');
    setTagIds(material.tags.map((tag) => tag.id));
    if (!canLayout(material.mimeType, material.kind)) setTab('text');
  }, [material]);

  const refresh = async () => { await client.invalidateQueries({ queryKey: ['library'] }); };
  const command = async (kind: string, input: Record<string, unknown>, targetId = id, expectedRevision = material?.revision) => {
    try {
      await submitCommands([{ kind, targetId, expectedRevision, input }]);
      await refresh();
    } catch (error) { toast.error(error instanceof ApiError ? error.message : '操作失败'); }
  };

  if (!material) return <aside className="library-panel library-preview" data-testid="library-preview" aria-label="资料预览"><p className="library-meta p-3">{detail.error instanceof Error ? detail.error.message : '正在读取资料'}</p></aside>;
  const attachment = material.content?.hasAttachment ? `/api/v1/knowledge/materials/${material.id}/versions/${viewed}/attachment` : '';
  const status = material.extraction.status;
  return <aside className="library-panel library-preview library-sheet" data-testid="library-preview" aria-label="资料预览">
    <div className="library-preview-head">
      <h2 className="library-name min-w-0 truncate" title={material.title}>{material.title}</h2>
      <button type="button" className="library-btn" onClick={onClose}>关闭</button>
    </div>
    <div className="library-preview-tabs" role="tablist" aria-label="预览内容">
      <button type="button" className="library-btn library-tab" role="tab" aria-selected={tab === 'original'} onClick={() => setTab('original')}>原件</button>
      <button type="button" className="library-btn library-tab" role="tab" aria-selected={tab === 'text'} onClick={() => setTab('text')}>提取文字</button>
    </div>
    <div className="library-preview-block min-h-0 flex-1 overflow-auto">
      {tab === 'original' && attachment && canLayout(material.mimeType, material.kind) && <OriginalView url={attachment} mime={material.mimeType} name={material.fileName ?? material.title} />}
      {tab === 'original' && material.mimeType === 'image/gif' && <p className="library-meta">动图只识别第一帧，原件保持不变。</p>}
      {(tab === 'text' || !canLayout(material.mimeType, material.kind)) && <div className="space-y-3">{content.data?.items.map((chunk) => <article key={chunk.id}><p className="library-meta">{formatLocator(chunk.locator as never)} · {chunk.method === 'ocr' ? '识字' : '原文'}</p><p className="whitespace-pre-wrap break-words text-sm">{chunk.text}</p></article>)}{!content.data?.items.length && <p className="library-meta">还没有可显示的提取文字。</p>}</div>}
    </div>
    <p className="library-preview-block library-meta" style={{ color: status === 'failed' || status === 'blocked' ? 'var(--lib-danger)' : status === 'partial' ? 'var(--lib-warning)' : 'var(--lib-success)' }}>{extractionCopy[status]}{material.extraction.errorCode ? ` · ${material.extraction.errorCode}` : ''}</p>
    {(status === 'failed' || status === 'blocked' || status === 'partial') && <div className="library-preview-block"><button type="button" className="library-btn" onClick={() => { void command('material.reextract', {}); }}>重试解析</button></div>}
    <div className="library-preview-block">
      <h3 className="library-name">关联任务</h3>
      <ul>{tasks.data?.items.map((task) => <li key={task.id} className="mt-1 flex items-center justify-between gap-2"><button type="button" className="library-btn" onClick={() => onOpenTask?.(task.id)}>{task.title}</button><button type="button" className="library-btn library-btn-danger" onClick={() => { void command('material.links', { expectedOrganizationRevision: material.organizationRevision, addTaskIds: [], removeTaskIds: [task.id], removeInlineReferences: false, expectedTaskRevisions: {} }); }}>解除关联</button></li>)}</ul>
      <div className="mt-2 flex gap-2">
        <select aria-label="添加关联任务" className="library-select min-w-0 flex-1" value={addTaskId} onChange={(event) => setAddTaskId(event.target.value)}>
          <option value="">选择任务</option>
          {(allTasks.data ?? []).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select>
        <button type="button" className="library-btn" disabled={!addTaskId} onClick={() => { void command('material.links', { expectedOrganizationRevision: material.organizationRevision, addTaskIds: [addTaskId], removeTaskIds: [], removeInlineReferences: false, expectedTaskRevisions: {} }); setAddTaskId(''); }}>关联</button>
      </div>
    </div>
    <div className="library-preview-block">
      <h3 className="library-name">文件夹与标签</h3>
      <select aria-label="资料文件夹" className="library-select mt-2 w-full" value={folderId} onChange={(event) => setFolderId(event.target.value)}>
        <option value="">未整理</option>
        {(folders.data?.items ?? []).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </select>
      <div className="mt-2 flex flex-wrap gap-2">{(tags.data?.items ?? []).map((tag) => <label key={tag.id} className="library-meta flex items-center gap-1"><input type="checkbox" checked={tagIds.includes(tag.id)} onChange={(event) => setTagIds((current) => event.target.checked ? [...current, tag.id] : current.filter((item) => item !== tag.id))} />{tag.name}</label>)}</div>
      <button type="button" className="library-btn mt-2" onClick={() => { void command('material.organize', { expectedOrganizationRevision: material.organizationRevision, folderId: folderId || null, tagIds }); }}>保存整理</button>
    </div>
    <div className="library-preview-actions">
      {attachment ? <a className="library-btn" href={attachment} download={material.fileName ?? material.title}>下载</a> : <button type="button" className="library-btn" onClick={() => downloadChunks(material.title, content.data?.items ?? [])}>下载</button>}
      <label className="library-btn">更新版本<input className="sr-only" type="file" aria-label="更新版本" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; void stageUpload(file).then((uploadId) => command('material.replace', { uploadId })).catch((error) => toast.error(error instanceof Error ? error.message : '更新失败')); }} /></label>
      <button type="button" className="library-btn" onClick={() => setRevision(material.versions.find((version) => version.revision !== viewed)?.revision ?? material.revision)}>历史</button>
      <button type="button" className="library-btn" onClick={() => { void command('material.archive', { archived: !material.archivedAt }); }}>{material.archivedAt ? '恢复' : '归档'}</button>
    </div>
    <div className="library-preview-block">
      <p className="library-meta">{kindLabels[material.kind]} · 更新于 {formatUpdated(material.updatedAt)}</p>
      <ul className="mt-1">{material.versions.map((version) => <li key={version.revision}><button type="button" className="library-meta" onClick={() => setRevision(version.revision)}>版本 {version.revision} · {extractionCopy[version.extraction.status]}</button></li>)}</ul>
    </div>
  </aside>;
}

function OriginalView({ url, mime, name }: { url: string; mime: string | null; name: string }) {
  const [objectUrl, setObjectUrl] = useState('');
  const [text, setText] = useState('');
  useEffect(() => {
    let gone = false;
    let current = '';
    const load = async () => {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) return;
      const blob = await response.blob();
      if (mime?.startsWith('text/') || /\.(md|txt|csv|json|log)$/i.test(name)) {
        const value = await blob.text();
        if (!gone) setText(value);
      }
      current = URL.createObjectURL(blob);
      if (!gone) setObjectUrl(current);
    };
    void load();
    return () => { gone = true; if (current) URL.revokeObjectURL(current); };
  }, [url, mime, name]);
  if (mime?.startsWith('image/') && objectUrl) return <img src={objectUrl} alt={name} className="max-w-full" />;
  if (mime === 'application/pdf' && objectUrl) return <iframe title={name} src={objectUrl} className="h-80 w-full" />;
  if (text) return <pre className="whitespace-pre-wrap break-words text-sm">{text}</pre>;
  return <p className="library-meta">这个原件不能在页面里排版，下面是提取文字。</p>;
}

function downloadChunks(title: string, items: Chunk[]) {
  const blob = new Blob([items.map((item) => item.text).join('\n\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

