import { Surface } from '@/components/ui/surface.js';
import { Button } from '@/components/ui/button.js';
import { NativeSelect } from '@/components/ui/native-select.js';
import { Checkbox } from '@/components/ui/checkbox.js';
import { Input } from '@/components/ui/input.js';
import { askAssistant, usePageContext } from '@/lib/assistant-context.js';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, authHeaders } from '@/lib/api.js';
import { BodyText, textFormatForMaterial } from '@/components/shared/BodyText.js';
import { t } from '../../i18n/index.js';
import { submitCommands } from '@/lib/platform.js';
import { libraryPageSize } from './store.js';
import { TaskLinkPicker } from './TaskLinkPicker.js';
import { enqueueUploads } from './upload.js';
import { extractionLabel, formatLocator, formatUpdated, kindLabel, type LibraryFolder, type LibraryTag, type LibraryPreviewTarget, type LinkedTask, type MaterialChunk, type MaterialDetail, type MaterialSource, type Page } from './types.js';

function canLayout(mime: string | null, kind: string) {
  if (mime?.startsWith('image/') || mime === 'application/pdf' || mime?.startsWith('text/')) return true;
  return kind === 'text' || kind === 'markdown';
}

export async function loadMaterialSource(id: string, revision: number, signal?: AbortSignal): Promise<MaterialSource> {
  const response = await fetch(`/api/v1/library/materials/${encodeURIComponent(id)}/versions/${revision}/source`, { credentials: 'include', headers: authHeaders(), signal });
  if (!response.ok) {
    let message = t('library:libraryPreview.sourceUnread');
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
  const { t } = useTranslation('library');
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
    } catch (error) { toast.error(error instanceof ApiError ? error.message : t('shared.actionFailed')); }
  };
  const version = material?.versions.find((item) => item.revision === viewed);
  const mime = source.data?.kind === 'attachment' ? source.data.mimeType : source.data?.kind === 'text' ? (source.data.mimeType || 'text/plain') : (version?.mimeType ?? material?.mimeType ?? null);
  const fileName = source.data?.fileName || version?.fileName || material?.fileName || material?.title || t('shared.material');
  const layout = material ? canLayout(mime, material.kind) : false;
  const preferred: 'original' | 'text' = target.chunkId || (source.data?.kind === 'attachment' && !layout) ? 'text' : 'original';
  const tab = tabChoice ?? preferred;
  const verified = Boolean(chunk.data && target.chunkId && material && chunk.data.materialId === material.id && chunk.data.revision === viewed);
  const extraction = version?.extraction ?? material?.extraction;

  const download = async () => {
    try {
      const loaded = source.data ?? await loadMaterialSource(id, viewed);
      if (loaded.kind === 'text') {
        saveBlob(new Blob([loaded.text], { type: 'text/plain;charset=utf-8' }), loaded.fileName || `${material?.title ?? t('shared.material')}.txt`);
        return;
      }
      const response = await fetch(loaded.href, { credentials: 'include', headers: authHeaders() });
      if (!response.ok) throw new Error(t('libraryPreview.downloadFailed'));
      const blob = await response.blob();
      saveBlob(new Blob([blob], { type: loaded.mimeType || blob.type }), loaded.fileName || fileName);
    } catch (error) { toast.error(error instanceof Error ? error.message : t('libraryPreview.downloadFailed')); }
  };

  usePageContext('library', { label: material ? t('libraryPreview.contextLabel', { title: material.title }) : t('shared.library'), materialId: id, materialRevision: viewed || null, materialVersionMode: target.revision == null ? 'latest' : 'historical' });
  if (!material || !extraction) return <Surface as="aside" tone="card" className="library-panel library-preview" data-testid="library-preview" aria-label={t('libraryPreview.previewLabel')}><p className="library-meta p-3">{detail.error instanceof Error ? detail.error.message : t('libraryPreview.loading')}</p></Surface>;
  const status = extraction.status;
  return <Surface as="aside" tone="card" className="library-panel library-preview library-sheet" data-testid="library-preview" aria-label={t('libraryPreview.previewLabel')}>
    <div className="library-preview-head">
      <div className="min-w-0">
        <h2 className="library-name truncate" title={material.title}>{material.title}</h2>
        {viewed > 0 && <p className="library-meta" data-testid="library-preview-version">{t('libraryPreview.version', { revision: viewed })}</p>}
      </div>
      <Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => askAssistant()}>{t('shared.aiAssistant')}</Button>
      <Button variant="outline" size="bare" type="button" className="library-btn" onMouseDown={(event) => event.preventDefault()} onClick={() => { const selection = window.getSelection(); const node = selection?.anchorNode?.parentElement; if (selection && !selection.isCollapsed && node?.closest('[data-testid="library-preview"]')) askAssistant({ kind: 'selection', title: material.title, text: selection.toString(), materialId: id, unsaved: false }); else toast.error(t('libraryPreview.selectTextFirst')); }}>{t('libraryPreview.askSelection')}</Button>
      <Button variant="outline" size="bare" type="button" className="library-btn" onClick={onClose}>{t('shared.close')}</Button>
    </div>
    <div className="library-preview-tabs" role="tablist" aria-label={t('libraryPreview.previewTabs')}>
      <Button variant="tab" size="bare" type="button" className="library-btn library-tab" role="tab" aria-selected={tab === 'original'} onClick={() => setTabChoice('original')}>{t('libraryPreview.original')}</Button>
      <Button variant="tab" size="bare" type="button" className="library-btn library-tab" role="tab" aria-selected={tab === 'text'} onClick={() => setTabChoice('text')}>{t('libraryPreview.extractedText')}</Button>
      {target.revision != null && <Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => onTargetChange({ materialId: id, revision: null, chunkId: null })}>{t('libraryPreview.viewLatest')}</Button>}
    </div>
    <div className="library-preview-block min-h-0 flex-1 overflow-auto">
      {verified && chunk.data && <p className="library-meta">{t('libraryPreview.versionDetail', { revision: chunk.data.revision, detail: formatLocator(chunk.data.locator) })}</p>}
      {tab === 'original' && source.isLoading && <p className="library-meta">{t('libraryPreview.loadingOriginal')}</p>}
      {tab === 'original' && source.data?.kind === 'text' && <BodyText text={source.data.text} format={textFormatForMaterial(material.kind, mime)} />}
      {tab === 'original' && source.data?.kind === 'attachment' && layout && <OriginalView url={source.data.href} mime={source.data.mimeType} name={source.data.fileName || fileName} />}
      {tab === 'original' && source.isError && <p className="library-meta">{source.error instanceof Error ? source.error.message : t('libraryPreview.sourceUnread')}</p>}
      {tab === 'original' && mime === 'image/gif' && <p className="library-meta">{t('libraryPreview.gifFrame')}</p>}
      {tab === 'original' && source.data?.kind === 'attachment' && !layout && <p className="library-meta">{t('libraryPreview.cannotLayout')}</p>}
      {tab === 'text' && <ChunkBrowser materialId={id} revision={viewed} highlightId={verified ? target.chunkId : null} />}
    </div>
    <p className="library-preview-block library-meta" style={{ color: status === 'failed' || status === 'blocked' ? 'var(--lib-danger)' : status === 'partial' ? 'var(--lib-warning)' : 'var(--lib-success)' }}>{extraction.errorCode ? t('libraryPreview.extractionWithCode', { status: extractionLabel(status), code: extraction.errorCode }) : extractionLabel(status)}</p>
    {(extraction.errors ?? []).map((error, index) => {
      const place = formatLocator(error.locator);
      return <p key={`${error.code}-${index}`} className="library-preview-block library-meta" style={{ color: 'var(--lib-danger)' }}>{place ? t('libraryPreview.locatedError', { place, message: error.message }) : error.message}</p>;
    })}
    {(status === 'failed' || status === 'blocked' || status === 'partial') && <div className="library-preview-block"><Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => { void command('material.reextract', {}); }}>{t('libraryPreview.retryExtract')}</Button></div>}
    <div className="library-preview-block">
      <h3 className="library-name">{t('libraryPreview.linkedTasks')}</h3>
      {tasks.data && <div className="library-linked-pages" data-testid="library-linked-tasks-pagination">
        <span>{t('libraryPreview.taskTotal', { count: tasks.data.total })}</span>
        <Button variant="outline" size="bare" type="button" className="library-btn" disabled={taskCursor <= 0 || tasks.isPlaceholderData} onClick={() => setTaskPage({ id, cursor: Math.max(0, taskCursor - libraryPageSize) })}>{t('shared.previousPage')}</Button>
        <span>{t('shared.pageNumber', { page: Math.floor(taskCursor / libraryPageSize) + 1 })}</span>
        <Button variant="outline" size="bare" type="button" className="library-btn" disabled={tasks.data.nextCursor == null || tasks.isPlaceholderData} onClick={() => { if (tasks.data?.nextCursor != null) setTaskPage({ id, cursor: tasks.data.nextCursor }); }}>{t('shared.nextPage')}</Button>
      </div>}
      <ul className="library-linked-tasks">{tasks.data?.items.map((task) => <li key={task.id} className="mt-1 flex items-center justify-between gap-2" data-testid={`library-linked-task-${task.id}`}><Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => onOpenTask?.(task.id)}>{task.title}</Button><Button variant="outline" size="bare" type="button" className="library-btn library-btn-danger" onClick={() => { void command('material.links', { expectedOrganizationRevision: material.organizationRevision, addTaskIds: [], removeTaskIds: [task.id], removeInlineReferences: false, expectedTaskRevisions: {} }); }}>{t('shared.unlink')}</Button></li>)}</ul>
      <TaskLinkPicker selectedIds={selectedTaskIds} onChange={setSelectedTaskIds} />
      <Button variant="outline" size="bare" type="button" className="library-btn mt-2" disabled={selectedTaskIds.length === 0} onClick={() => {
        const chosen = selectedTaskIds;
        void (async () => {
          try {
            await submitCommands([{ kind: 'material.links', targetId: id, expectedRevision: material.revision, input: { expectedOrganizationRevision: material.organizationRevision, addTaskIds: chosen, removeTaskIds: [], removeInlineReferences: false, expectedTaskRevisions: {} } }]);
            setSelectedTaskIds([]);
            await refresh();
          } catch (error) { toast.error(error instanceof ApiError ? error.message : t('shared.actionFailed')); }
        })();
      }}>{t('libraryPreview.linkSelected')}</Button>
    </div>
    <div className="library-preview-block">
      <h3 className="library-name">{t('libraryPreview.folderAndTags')}</h3>
      <NativeSelect aria-label={t('libraryPreview.folderLabel')} className="library-select mt-2 w-full" value={folderId} onChange={(event) => setFolderId(event.target.value)}>
        <option value="">{t('shared.unfiled')}</option>
        {(folders.data?.items ?? []).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </NativeSelect>
      <div className="mt-2 flex flex-wrap gap-2">{(tags.data?.items ?? []).map((tag) => <label key={tag.id} className="library-meta flex items-center gap-1"><Checkbox  checked={tagIds.includes(tag.id)} onChange={(event) => setTagIds((current) => event.target.checked ? [...current, tag.id] : current.filter((item) => item !== tag.id))} />{tag.name}</label>)}</div>
      <Button variant="outline" size="bare" type="button" className="library-btn mt-2" onClick={() => { void command('material.organize', { expectedOrganizationRevision: material.organizationRevision, folderId: folderId || null, tagIds }); }}>{t('libraryPreview.saveOrganization')}</Button>
    </div>
    <div className="library-preview-actions">
      <Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => { void download(); }}>{t('libraryPreview.download')}</Button>
      <Button asChild variant="outline" size="bare"><label className="library-btn">{t('libraryPreview.updateVersion')}<Input variant="inline" className="sr-only" type="file" aria-label={t('libraryPreview.updateVersion')} onChange={(event) => {
        const files = [...(event.target.files ?? [])];
        event.target.value = '';
        const file = files[0];
        if (!file) return;
        void enqueueUploads([{ file, relativePath: file.name }], { topicId: material.topicId, folderId: material.folderId, taskIds: [], replaceMaterialId: material.id, expectedRevision: material.revision, silent: true }).then(() => refresh()).catch((error) => toast.error(error instanceof Error ? error.message : t('libraryPreview.updateFailed')));
      }} /></label></Button>
      <Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => { void command('material.archive', { archived: !material.archivedAt }); }}>{material.archivedAt ? t('libraryPreview.restore') : t('shared.archive')}</Button>
    </div>
    <div className="library-preview-block">
      <p className="library-meta">{t('libraryPreview.kindUpdated', { kind: kindLabel(material.kind), updated: formatUpdated(material.updatedAt) })}</p>
      <ul className="mt-1">{material.versions.map((item) => <li key={item.revision}><Button variant="plain" size="bare" type="button" className="library-meta" onClick={() => onTargetChange({ materialId: id, revision: item.revision, chunkId: null })}>{t('libraryPreview.versionDetail', { revision: item.revision, detail: extractionLabel(item.extraction.status) })}</Button></li>)}</ul>
    </div>
  </Surface>;
}

function ChunkBrowser({ materialId, revision, highlightId }: { materialId: string; revision: number; highlightId: string | null }) {
  const { t } = useTranslation('library');
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
        <p className="library-meta">{t('libraryPreview.chunkMeta', { place: formatLocator(item.locator), method: item.method === 'ocr' ? t('libraryPreview.methodOcr') : t('libraryPreview.methodNative') })}</p>
        <BodyText text={item.text} format="plain" />
      </article>)}
      {!items.length && ready && <p className="library-meta">{t('libraryPreview.noExtractedText')}</p>}
    </div>
    {ready && next != null && <Button variant="outline" size="bare" type="button" className="library-btn mt-3" onClick={() => { void loadMore(); }}>{t('libraryPreview.loadMore')}</Button>}
  </div>;
}

function OriginalView({ url, mime, name }: { url: string; mime: string | null; name: string }) {
  const { t } = useTranslation('library');
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
  if (text) return <BodyText text={text} format="plain" mono={mime === 'text/csv' || mime === 'application/json' || /\.(csv|json|log)$/i.test(name)} />;
  return <p className="library-meta">{t('libraryPreview.loadingOriginal')}</p>;
}
