import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, authHeaders } from '@/lib/api.js';
import { submitCommands } from '@/lib/platform.js';
import { libraryPageSize } from './store.js';
import { TaskLinkPicker } from './TaskLinkPicker.js';
import { enqueueUploads } from './upload.js';
import { extractionCopy, formatLocator, formatUpdated, kindLabels, type LibraryFolder, type LibraryTag, type LibraryPreviewTarget, type LinkedTask, type MaterialChunk, type MaterialDetail, type MaterialSource, type Page } from './types.js';

function canLayout(mime: string | null, kind: string) {
  if (mime?.startsWith('image/') || mime === 'application/pdf' || mime?.startsWith('text/')) return true;
  return kind === 'text' || kind === 'markdown';
}

export async function loadMaterialSource(id: string, revision: number, signal?: AbortSignal): Promise<MaterialSource> {
  const response = await fetch(`/api/v1/library/materials/${encodeURIComponent(id)}/versions/${revision}/source`, { credentials: 'include', headers: authHeaders(), signal });
  if (!response.ok) {
    let message = '原件没有读取';
    try {
      const body = await response.json() as { error?: string | { message?: string } };
      message = typeof body.error === 'string' ? body.error : body.error?.message ?? message;
    } catch { /* The status is already a failure. */ }
    throw new Error(message);
  }
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const body = await response.json() as { data?: MaterialSource & { kind?: string; text?: string } };
    const data = body.data ?? body as { kind?: string; text?: string; href?: string; revision?: number; fileName?: string | null; mimeType?: string };
    if (data.kind === 'attachment') {
      const revisionNumber = data.revision ?? revision;
      const href = data.href || `/api/v1/knowledge/materials/${encodeURIComponent(id)}/versions/${revisionNumber}/attachment`;
      return { kind: 'attachment', revision: revisionNumber, fileName: data.fileName ?? '', mimeType: data.mimeType || 'application/octet-stream', href };
    }
    return { kind: 'text', text: typeof data.text === 'string' ? data.text : '', fileName: data.fileName ?? null, mimeType: data.mimeType || 'text/plain' };
  }
  return { kind: 'text', text: await response.text(), fileName: null, mimeType: 'text/plain' };
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function LibraryPreview({ target, onTargetChange, onClose, onOpenTask }: { target: LibraryPreviewTarget; onTargetChange: (target: LibraryPreviewTarget) => void; onClose: () => void; onOpenTask?: (taskId: string) => void }) {
  const client = useQueryClient();
  const id = target.materialId;
  const detail = useQuery({ queryKey: ['library', 'material', id], queryFn: ({ signal }) => api<MaterialDetail>(`/api/v1/library/materials/${id}`, { signal }) });
  const [taskPage, setTaskPage] = useState({ id, cursor: 0 });
  if (taskPage.id !== id) setTaskPage({ id, cursor: 0 });
  const taskCursor = taskPage.id === id ? taskPage.cursor : 0;
  const tasks = useQuery({
    queryKey: ['library', 'material-tasks', id, taskCursor],
    queryFn: ({ signal }) => api<Page<LinkedTask>>(`/api/v1/library/materials/${id}/tasks?cursor=${taskCursor}&limit=${libraryPageSize}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const folders = useQuery({ queryKey: ['library', 'folders'], queryFn: ({ signal }) => api<{ items: LibraryFolder[] }>('/api/v1/library/folders', { signal }) });
  const tags = useQuery({ queryKey: ['library', 'tags'], queryFn: ({ signal }) => api<{ items: LibraryTag[] }>('/api/v1/library/tags', { signal }) });
  const chunk = useQuery({
    queryKey: ['library', 'chunk', target.chunkId],
    queryFn: ({ signal }) => api<MaterialChunk>(`/api/v1/library/chunks/${target.chunkId}`, { signal }),
    enabled: Boolean(target.chunkId),
    retry: false,
  });
  const material = detail.data;
  const viewed = target.revision ?? material?.revision ?? 0;
  const source = useQuery({
    queryKey: ['library', 'source', id, viewed],
    queryFn: ({ signal }) => loadMaterialSource(id, viewed, signal),
    enabled: viewed > 0,
    retry: false,
  });
  const [folderId, setFolderId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const targetKey = `${id}:${target.revision ?? ''}:${target.chunkId ?? ''}`;
  const [tabKey, setTabKey] = useState(targetKey);
  const [tabChoice, setTabChoice] = useState<'original' | 'text' | null>(null);
  if (tabKey !== targetKey) {
    setTabKey(targetKey);
    setTabChoice(null);
  }
  useEffect(() => {
    if (!material) return;
    setFolderId(material.folderId ?? '');
    setTagIds(material.tags.map((tag) => tag.id));
  }, [material]);

  const refresh = async () => { await client.invalidateQueries({ queryKey: ['library'] }); };
  const command = async (kind: string, input: Record<string, unknown>, targetId = id, expectedRevision = material?.revision) => {
    try {
      await submitCommands([{ kind, targetId, expectedRevision, input }]);
      await refresh();
    } catch (error) { toast.error(error instanceof ApiError ? error.message : '操作失败'); }
  };
  const version = material?.versions.find((item) => item.revision === viewed);
  const mime = source.data?.kind === 'attachment' ? source.data.mimeType : source.data?.kind === 'text' ? (source.data.mimeType || 'text/plain') : (version?.mimeType ?? material?.mimeType ?? null);
  const fileName = source.data?.fileName || version?.fileName || material?.fileName || material?.title || '资料';
  const layout = material ? canLayout(mime, material.kind) : false;
  const preferred: 'original' | 'text' = target.chunkId || (source.data?.kind === 'attachment' && !layout) ? 'text' : 'original';
  const tab = tabChoice ?? preferred;
  const verified = Boolean(chunk.data && target.chunkId && material && chunk.data.materialId === material.id && chunk.data.revision === viewed);
  const extraction = version?.extraction ?? material?.extraction;

  const download = async () => {
    try {
      const loaded = source.data ?? await loadMaterialSource(id, viewed);
      if (loaded.kind === 'text') {
        saveBlob(new Blob([loaded.text], { type: 'text/plain;charset=utf-8' }), loaded.fileName || `${material?.title ?? '资料'}.txt`);
        return;
      }
      const response = await fetch(loaded.href, { credentials: 'include', headers: authHeaders() });
      if (!response.ok) throw new Error('下载失败');
      const blob = await response.blob();
      saveBlob(new Blob([blob], { type: loaded.mimeType || blob.type }), loaded.fileName || fileName);
    } catch (error) { toast.error(error instanceof Error ? error.message : '下载失败'); }
  };

  if (!material || !extraction) return <aside className="library-panel library-preview" data-testid="library-preview" aria-label="资料预览"><p className="library-meta p-3">{detail.error instanceof Error ? detail.error.message : '正在读取资料'}</p></aside>;
  const status = extraction.status;
  return <aside className="library-panel library-preview library-sheet" data-testid="library-preview" aria-label="资料预览">
    <div className="library-preview-head">
      <div className="min-w-0">
        <h2 className="library-name truncate" title={material.title}>{material.title}</h2>
        {viewed > 0 && <p className="library-meta" data-testid="library-preview-version">版本 {viewed}</p>}
      </div>
      <button type="button" className="library-btn" onClick={onClose}>关闭</button>
    </div>
    <div className="library-preview-tabs" role="tablist" aria-label="预览内容">
      <button type="button" className="library-btn library-tab" role="tab" aria-selected={tab === 'original'} onClick={() => setTabChoice('original')}>原件</button>
      <button type="button" className="library-btn library-tab" role="tab" aria-selected={tab === 'text'} onClick={() => setTabChoice('text')}>提取文字</button>
      {target.revision != null && <button type="button" className="library-btn" onClick={() => onTargetChange({ materialId: id, revision: null, chunkId: null })}>查看最新版</button>}
    </div>
    <div className="library-preview-block min-h-0 flex-1 overflow-auto">
      {verified && chunk.data && <p className="library-meta">版本 {chunk.data.revision} · {formatLocator(chunk.data.locator)}</p>}
      {tab === 'original' && source.isLoading && <p className="library-meta">正在读取原件</p>}
      {tab === 'original' && source.data?.kind === 'text' && <pre className="whitespace-pre-wrap break-words text-sm">{source.data.text}</pre>}
      {tab === 'original' && source.data?.kind === 'attachment' && layout && <OriginalView url={source.data.href} mime={source.data.mimeType} name={source.data.fileName || fileName} />}
      {tab === 'original' && source.isError && <p className="library-meta">{source.error instanceof Error ? source.error.message : '原件没有读取'}</p>}
      {tab === 'original' && mime === 'image/gif' && <p className="library-meta">动图只识别第一帧，原件保持不变。</p>}
      {tab === 'original' && source.data?.kind === 'attachment' && !layout && <p className="library-meta">这个原件不能在页面里排版，下面是提取文字。</p>}
      {tab === 'text' && <ChunkBrowser materialId={id} revision={viewed} highlightId={verified ? target.chunkId : null} />}
    </div>
    <p className="library-preview-block library-meta" style={{ color: status === 'failed' || status === 'blocked' ? 'var(--lib-danger)' : status === 'partial' ? 'var(--lib-warning)' : 'var(--lib-success)' }}>{extractionCopy[status]}{extraction.errorCode ? ` · ${extraction.errorCode}` : ''}</p>
    {(extraction.errors ?? []).map((error, index) => <p key={`${error.code}-${index}`} className="library-preview-block library-meta" style={{ color: 'var(--lib-danger)' }}>{formatLocator(error.locator)} · {error.message}</p>)}
    {(status === 'failed' || status === 'blocked' || status === 'partial') && <div className="library-preview-block"><button type="button" className="library-btn" onClick={() => { void command('material.reextract', {}); }}>重试解析</button></div>}
    <div className="library-preview-block">
      <h3 className="library-name">关联任务</h3>
      {tasks.data && <div className="library-linked-pages" data-testid="library-linked-tasks-pagination">
        <span>共 {tasks.data.total} 个任务</span>
        <button type="button" className="library-btn" disabled={taskCursor <= 0 || tasks.isPlaceholderData} onClick={() => setTaskPage({ id, cursor: Math.max(0, taskCursor - libraryPageSize) })}>上一页</button>
        <span>第 {Math.floor(taskCursor / libraryPageSize) + 1} 页</span>
        <button type="button" className="library-btn" disabled={tasks.data.nextCursor == null || tasks.isPlaceholderData} onClick={() => { if (tasks.data?.nextCursor != null) setTaskPage({ id, cursor: tasks.data.nextCursor }); }}>下一页</button>
      </div>}
      <ul className="library-linked-tasks">{tasks.data?.items.map((task) => <li key={task.id} className="mt-1 flex items-center justify-between gap-2" data-testid={`library-linked-task-${task.id}`}><button type="button" className="library-btn" onClick={() => onOpenTask?.(task.id)}>{task.title}</button><button type="button" className="library-btn library-btn-danger" onClick={() => { void command('material.links', { expectedOrganizationRevision: material.organizationRevision, addTaskIds: [], removeTaskIds: [task.id], removeInlineReferences: false, expectedTaskRevisions: {} }); }}>解除关联</button></li>)}</ul>
      <TaskLinkPicker selectedIds={selectedTaskIds} onChange={setSelectedTaskIds} />
      <button type="button" className="library-btn mt-2" disabled={selectedTaskIds.length === 0} onClick={() => {
        const chosen = selectedTaskIds;
        void (async () => {
          try {
            await submitCommands([{ kind: 'material.links', targetId: id, expectedRevision: material.revision, input: { expectedOrganizationRevision: material.organizationRevision, addTaskIds: chosen, removeTaskIds: [], removeInlineReferences: false, expectedTaskRevisions: {} } }]);
            setSelectedTaskIds([]);
            await refresh();
          } catch (error) { toast.error(error instanceof ApiError ? error.message : '操作失败'); }
        })();
      }}>关联</button>
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
      <button type="button" className="library-btn" onClick={() => { void download(); }}>下载</button>
      <label className="library-btn">更新版本<input className="sr-only" type="file" aria-label="更新版本" onChange={(event) => {
        const files = [...(event.target.files ?? [])];
        event.target.value = '';
        const file = files[0];
        if (!file) return;
        void enqueueUploads([{ file, relativePath: file.name }], { topicId: material.topicId, folderId: material.folderId, taskIds: [], replaceMaterialId: material.id, expectedRevision: material.revision, silent: true }).then(() => refresh()).catch((error) => toast.error(error instanceof Error ? error.message : '更新失败'));
      }} /></label>
      <button type="button" className="library-btn" onClick={() => { void command('material.archive', { archived: !material.archivedAt }); }}>{material.archivedAt ? '恢复' : '归档'}</button>
    </div>
    <div className="library-preview-block">
      <p className="library-meta">{kindLabels[material.kind]} · 更新于 {formatUpdated(material.updatedAt)}</p>
      <ul className="mt-1">{material.versions.map((item) => <li key={item.revision}><button type="button" className="library-meta" onClick={() => onTargetChange({ materialId: id, revision: item.revision, chunkId: null })}>版本 {item.revision} · {extractionCopy[item.extraction.status]}</button></li>)}</ul>
    </div>
  </aside>;
}

function ChunkBrowser({ materialId, revision, highlightId }: { materialId: string; revision: number; highlightId: string | null }) {
  const [items, setItems] = useState<MaterialChunk[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const nextRef = useRef<number | null>(null);
  const loadingRef = useRef(false);
  useEffect(() => {
    let gone = false;
    const run = async () => {
      let cursor = 0;
      let collected: MaterialChunk[] = [];
      let guard = 0;
      while (!gone && guard < 30) {
        const page = await api<Page<MaterialChunk>>(`/api/v1/library/materials/${materialId}/content?revision=${revision}&cursor=${cursor}&limit=40`);
        if (gone) return;
        collected = [...collected, ...page.items];
        nextRef.current = page.nextCursor;
        setItems(collected);
        setNext(page.nextCursor);
        setReady(true);
        const found = !highlightId || collected.some((item) => item.id === highlightId);
        if (found || page.nextCursor == null || page.nextCursor === cursor) break;
        cursor = page.nextCursor;
        guard += 1;
      }
    };
    nextRef.current = null;
    setReady(false);
    void run().catch(() => { if (!gone) setReady(true); });
    return () => { gone = true; };
  }, [materialId, revision, highlightId]);
  useEffect(() => {
    if (!highlightId) return;
    document.querySelector<HTMLElement>(`[data-testid="library-chunk-${CSS.escape(highlightId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [items, highlightId]);
  const loadMore = async () => {
    const cursor = nextRef.current;
    if (cursor == null || loadingRef.current) return;
    loadingRef.current = true;
    try {
      const page = await api<Page<MaterialChunk>>(`/api/v1/library/materials/${materialId}/content?revision=${revision}&cursor=${cursor}&limit=40`);
      nextRef.current = page.nextCursor;
      setItems((current) => [...current, ...page.items]);
      setNext(page.nextCursor);
    } finally {
      loadingRef.current = false;
    }
  };
  return <div>
    <div className="library-chunks">
      {items.map((item) => <article key={item.id} className="library-chunk" data-testid={`library-chunk-${item.id}`} data-highlighted={item.id === highlightId ? 'true' : 'false'}>
        <p className="library-meta">{formatLocator(item.locator)} · {item.method === 'ocr' ? '识字' : '原文'}</p>
        <p className="whitespace-pre-wrap break-words text-sm">{item.text}</p>
      </article>)}
      {!items.length && ready && <p className="library-meta">还没有可显示的提取文字。</p>}
    </div>
    {ready && next != null && <button type="button" className="library-btn mt-3" onClick={() => { void loadMore(); }}>继续加载</button>}
  </div>;
}

function OriginalView({ url, mime, name }: { url: string; mime: string | null; name: string }) {
  const [objectUrl, setObjectUrl] = useState('');
  const [text, setText] = useState('');
  useEffect(() => {
    let gone = false;
    let current = '';
    const load = async () => {
      const response = await fetch(url, { credentials: 'include', headers: authHeaders() });
      if (!response.ok || gone) return;
      const blob = await response.blob();
      if (mime?.startsWith('text/') || /\.(md|txt|csv|json|log)$/i.test(name)) {
        const value = await blob.text();
        if (!gone) setText(value);
      }
      current = URL.createObjectURL(new Blob([blob], { type: mime || blob.type }));
      if (!gone) setObjectUrl(current);
    };
    void load();
    return () => { gone = true; if (current) URL.revokeObjectURL(current); };
  }, [url, mime, name]);
  if (mime?.startsWith('image/') && objectUrl) return <img src={objectUrl} alt={name} className="max-w-full" />;
  if (mime === 'application/pdf' && objectUrl) return <iframe title={name} src={objectUrl} className="h-80 w-full" />;
  if (text) return <pre className="whitespace-pre-wrap break-words text-sm">{text}</pre>;
  return <p className="library-meta">正在读取原件</p>;
}
