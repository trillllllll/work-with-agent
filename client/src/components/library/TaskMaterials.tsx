import './library.css';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type Task } from '@/lib/api.js';
import { queryKeys } from '@/lib/todo.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';
import { descriptionCitesMaterial } from '@/lib/material-citation.js';
import { insertMaterialReferencesIntoTask, readTaskBookmark } from '@/components/tasks/DescriptionEditor.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog.js';
import { LibraryPreview } from './LibraryPreview.js';
import { enqueueUploads } from './upload.js';
import { kindLabel, materialKinds, normalizeRow, type LibraryPreviewTarget, type LibraryRow, type MaterialDetail, type MaterialKind, type MaterialSummary, type Page } from './types.js';

export function TaskMaterials({ taskId, topicId, description, readonly, saveText, onOpenLinkedTask }: { taskId: string; topicId: string | null; description: string; readonly: boolean; saveText: () => Promise<boolean>; onOpenLinkedTask?: (taskId: string) => Promise<void> | void }) {
  const { t } = useTranslation('library');
  const client = useQueryClient();
  const runtime = useEditorRuntime();
  const bookmarkRef = useRef<{ from: number; to: number } | null>(null);
  const [over, setOver] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [preview, setPreview] = useState<LibraryPreviewTarget | null>(null);
  const [unlink, setUnlink] = useState<MaterialSummary | null>(null);
  const materials = useQuery({
    queryKey: ['library', 'task-materials', taskId],
    queryFn: async ({ signal }) => {
      const first = await api<Page<MaterialSummary>>(`/api/v1/library/tasks/${taskId}/materials?limit=40`, { signal });
      const items = [...first.items];
      let cursor = first.nextCursor;
      let guard = 0;
      while (cursor != null && guard < 20) {
        const page = await api<Page<MaterialSummary>>(`/api/v1/library/tasks/${taskId}/materials?limit=40&cursor=${cursor}`, { signal });
        items.push(...page.items);
        if (page.nextCursor == null || page.nextCursor === cursor) break;
        cursor = page.nextCursor;
        guard += 1;
      }
      return { ...first, items, nextCursor: null };
    },
  });
  const items = materials.data?.items ?? [];
  const linked = new Set(items.map((item) => item.id));
  const refresh = () => client.invalidateQueries({ queryKey: ['library', 'task-materials', taskId] });
  const upload = async (files: File[]) => {
    if (!files.length || readonly) return;
    await enqueueUploads(files.map((file) => ({ file, relativePath: file.name })), { topicId, folderId: null, taskIds: [taskId] });
    await refresh();
  };

  const cite = async () => {
    if (!picked.length) return;
    const saved = await saveText();
    if (!saved) return;
    const coordinator = runtime?.coordinator ?? null;
    let revision: number | undefined;
    if (coordinator) {
      revision = coordinator.getRecord(taskId)?.base.revision;
    }
    if (revision == null) {
      const task = await api<Task>(`/api/tasks/${taskId}?includeArchived=true`);
      revision = task.revision;
    }
    // 打开选择框时记下的选区优先。弹层抢走焦点后，编辑器选区可能变化；失效时不默认插到末尾。
    const live = readTaskBookmark(taskId);
    const captured = bookmarkRef.current;
    if (!live) {
      toast.error(t('taskMaterials.editorUnavailable'));
      return;
    }
    const range = captured ?? { from: Math.min(live.anchor, live.head), to: Math.max(live.anchor, live.head) };
    if (range.from > live.docSize || range.to > live.docSize || range.from < 0) {
      toast.error(t('taskMaterials.insertPositionStale'));
      return;
    }
    try {
      const selected = await Promise.all(picked.map((itemId) => api<MaterialDetail>(`/api/v1/library/materials/${itemId}`)));
      const references = selected.map((item) => ({ materialId: item.id, label: item.title }));
      const nextDescription = insertMaterialReferencesIntoTask(taskId, references, range);
      if (nextDescription == null) {
        toast.error(t('taskMaterials.editorUnavailable'));
        return;
      }
      const command = {
        kind: 'task.reference_materials',
        targetId: taskId,
        expectedRevision: revision,
        input: {
          materialIds: selected.map((item) => item.id),
          description: nextDescription,
          expectedMaterialRevisions: Object.fromEntries(selected.map((item) => [item.id, item.revision])),
          expectedOrganizationRevisions: Object.fromEntries(selected.map((item) => [item.id, item.organizationRevision])),
        },
      };
      const sent = coordinator
        ? await coordinator.sendReference(taskId, command, nextDescription)
        : false;
      if (!sent) {
        if (coordinator?.getRecord(taskId)?.blockedReason === 'reference-conflict') {
          toast.error(t('taskMaterials.revisionChanged'));
        } else {
          toast.error(t('taskMaterials.insertFailed'));
        }
        return;
      }
      await client.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      await refresh();
      setPicking(false);
      setPicked([]);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-task-editor] [data-task-editor-prose]')?.focus());
    } catch (error) { toast.error(error instanceof ApiError ? error.message : t('taskMaterials.insertFailed')); }
  };
  const linkOnly = async () => {
    if (!picked.length) return;
    const saved = await saveText();
    if (!saved) return;
    try {
      const selected = await Promise.all(picked.map((itemId) => api<MaterialDetail>(`/api/v1/library/materials/${itemId}`)));
      const commands = selected.map((item) => ({
        kind: 'material.links',
        targetId: item.id,
        expectedRevision: item.revision,
        input: { expectedOrganizationRevision: item.organizationRevision, addTaskIds: [taskId], removeTaskIds: [], removeInlineReferences: false, expectedTaskRevisions: {} },
      }));
      for (let index = 0; index < commands.length; index += 50) await submitBatch(commands.slice(index, index + 50));
      await refresh();
      setPicking(false);
      setPicked([]);
    } catch (error) { toast.error(error instanceof ApiError ? error.message : t('taskMaterials.linkFailed')); }
  };
  const remove = async (material: MaterialSummary, removeInlineReferences: boolean) => {
    const saved = await saveText();
    if (!saved) return;
    const task = await api<Task>(`/api/tasks/${taskId}?includeArchived=true`);
    await submitBatch([{
      kind: 'material.links',
      targetId: material.id,
      expectedRevision: material.revision,
      input: {
        expectedOrganizationRevision: material.organizationRevision,
        addTaskIds: [],
        removeTaskIds: [task.id],
        removeInlineReferences,
        expectedTaskRevisions: removeInlineReferences ? { [task.id]: task.revision } : {},
      },
    }]);
    await client.invalidateQueries({ queryKey: queryKeys.task(task.id) });
    await refresh();
  };

  // 编辑器里的资料引用节点点击后打开预览。
  useEffect(() => {
    const onPreview = (event: Event) => {
      const detail = (event as CustomEvent<{ taskId: string; materialId: string }>).detail;
      if (!detail || detail.taskId !== taskId) return;
      setPreview({ materialId: detail.materialId, revision: null, chunkId: null });
    };
    window.addEventListener('dovun-preview-material', onPreview);
    return () => window.removeEventListener('dovun-preview-material', onPreview);
  }, [taskId]);

  return <section className="library-surface task-materials" data-testid="task-materials" onDragOver={(event) => {
    if (readonly || ![...event.dataTransfer.items].some((item) => item.kind === 'file')) return;
    event.preventDefault();
    event.stopPropagation();
    setOver(true);
  }} onDragLeave={() => setOver(false)} onDrop={(event) => {
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    void upload(files);
  }}>
    <div className="task-materials-head">
      <h2 className="library-name">{t('taskMaterials.heading', { count: materials.data?.total ?? items.length })}</h2>
      {!readonly && <div className="task-materials-actions">
        <label className="library-btn">{t('taskMaterials.uploadFiles')}<input className="sr-only" type="file" multiple aria-label={t('taskMaterials.uploadFiles')} onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void upload(files); }} /></label>
        <Dialog open={picking} onOpenChange={(open) => { setPicking(open); if (!open) setPreview(null); }}>
          <DialogTrigger asChild><button type="button" className="library-btn" onMouseDown={() => { bookmarkRef.current = null; }} onClick={() => {
            const bookmark = readTaskBookmark(taskId);
            bookmarkRef.current = bookmark ? { from: Math.min(bookmark.anchor, bookmark.head), to: Math.max(bookmark.anchor, bookmark.head) } : null;
          }}>{t('taskMaterials.citeExisting')}</button></DialogTrigger>
          <DialogContent className="library-surface material-picker" showCloseButton={false}>
            <DialogTitle>{t('taskMaterials.citeExisting')}</DialogTitle>
            <DialogDescription className="sr-only">{t('taskMaterials.citeDescription')}</DialogDescription>
            <PickerBody taskId={taskId} linked={linked} picked={picked} setPicked={setPicked} onPreview={setPreview} />
            <div className="material-picker-footer">
              <button type="button" className="library-btn" onClick={() => { void linkOnly(); }}>{t('taskMaterials.linkOnly')}</button>
              <button type="button" className="library-btn library-btn-primary" onClick={() => { void cite(); }}>{t('taskMaterials.insertReference')}</button>
              <button type="button" className="library-btn" onClick={() => setPicking(false)}>{t('shared.cancel')}</button>
            </div>
            {preview && <LibraryPreview target={preview} onTargetChange={setPreview} onClose={() => setPreview(null)} onOpenTask={(linkedId) => { void onOpenLinkedTask?.(linkedId); }} />}
          </DialogContent>
        </Dialog>
      </div>}
    </div>
    <div className={over ? 'library-drop' : undefined}>
      {!items.length && <p className="library-meta py-3">{t('taskMaterials.empty')}</p>}
      {items.map((item) => <div key={item.id} className="task-material-row" data-testid={`task-material-${item.id}`}>
        <FileText className="library-icon" aria-hidden />
        <span className="library-name min-w-0 flex-1 truncate" title={item.title}>{item.title}</span>
        <button type="button" className="library-btn" onClick={() => setPreview({ materialId: item.id, revision: null, chunkId: null })}>{t('shared.preview')}</button>
        {!readonly && <button type="button" className="library-btn" onClick={() => { if (descriptionCitesMaterial(description, item.id)) setUnlink(item); else void remove(item, false).catch((error) => toast.error(error instanceof Error ? error.message : t('taskMaterials.unlinkFailed'))); }}>{t('shared.unlink')}</button>}
      </div>)}
    </div>
    {unlink && <div className="library-dialog library-surface" role="dialog" aria-label={t('shared.unlink')}>
      <section>
        <h2 className="library-name">{t('shared.unlink')}</h2>
        <p className="mt-2 text-sm">{t('taskMaterials.unlinkBody', { title: unlink.title })}</p>
        <div className="mt-3 flex gap-2">
          <button type="button" className="library-btn" onClick={() => setUnlink(null)}>{t('shared.cancel')}</button>
          <button type="button" className="library-btn library-btn-danger" onClick={() => { const material = unlink; setUnlink(null); void remove(material, true).catch((error) => toast.error(error instanceof Error ? error.message : t('taskMaterials.unlinkFailed'))); }}>{t('shared.unlink')}</button>
        </div>
      </section>
    </div>}
    {preview && !picking && createPortal(<div className="library-preview-host library-surface"><LibraryPreview target={preview} onTargetChange={setPreview} onClose={() => setPreview(null)} onOpenTask={(linkedId) => { void onOpenLinkedTask?.(linkedId); }} /></div>, document.body)}
  </section>;
}

async function submitBatch(commands: unknown[]) {
  const { submitCommands } = await import('@/lib/platform.js');
  return submitCommands(commands as Parameters<typeof submitCommands>[0]);
}

function PickerBody({ taskId, linked, picked, setPicked, onPreview }: { taskId: string; linked: Set<string>; picked: string[]; setPicked: (ids: string[]) => void; onPreview: (target: LibraryPreviewTarget) => void }) {
  const { t } = useTranslation('library');
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState<'' | MaterialKind>('');
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    if (composing) return;
    const timer = window.setTimeout(() => setDebounced(query), 200);
    return () => window.clearTimeout(timer);
  }, [query, composing]);
  useEffect(() => { setCursor(0); }, [debounced, kind]);
  const trimmed = debounced.trim();
  const list = useQuery({
    queryKey: ['library', 'picker', taskId, trimmed, kind, cursor],
    queryFn: ({ signal }) => {
      const kindParam = kind ? `&kind=${encodeURIComponent(kind)}` : '';
      const path = trimmed
        ? `/api/v1/library/search?q=${encodeURIComponent(trimmed)}&limit=40&cursor=${cursor}&archived=exclude${kindParam}`
        : `/api/v1/library/materials?limit=40&cursor=${cursor}&archived=exclude${kindParam}`;
      return api<Page<LibraryRow>>(path, { signal });
    },
    retry: false,
  });
  const rows = (list.data?.items ?? []).map((item) => normalizeRow(item));
  return <>
    <input className="library-search material-picker-search" aria-label={t('shared.searchMaterials')} placeholder={t('shared.searchPlaceholder')} value={query} onChange={(event) => setQuery(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); setQuery(event.currentTarget.value); }} />
    <select className="library-select" aria-label={t('shared.typeFilter')} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
      <option value="">{t('shared.allTypes')}</option>
      {materialKinds.map((value) => <option key={value} value={value}>{kindLabel(value)}</option>)}
    </select>
    <div className="material-picker-list">
      {list.isError && <div className="library-error" role="alert"><p>{list.error instanceof Error ? list.error.message : t('shared.materialsLoadFailed')}</p><button type="button" className="library-btn" onClick={() => { void list.refetch(); }}>{t('shared.retry')}</button></div>}
      {!list.isError && list.isLoading && <p className="library-meta">{t('shared.loadingMaterials')}</p>}
      {!list.isError && !list.isLoading && !rows.length && <p className="library-meta">{t('shared.noMatchingMaterials')}</p>}
      {rows.map((item) => <div key={item.id} className="material-picker-row" data-testid={`material-picker-row-${item.id}`}>
        <label className="material-picker-check"><input type="checkbox" aria-label={item.title} checked={picked.includes(item.id)} onChange={(event) => setPicked(event.target.checked ? [...picked, item.id] : picked.filter((id) => id !== item.id))} /></label>
        <span className="library-name min-w-0 flex-1 truncate" title={item.title}>{item.title}</span>
        <span className="library-meta shrink-0">{kindLabel(item.kind)}</span>
        {linked.has(item.id) && <span className="library-meta shrink-0">{t('taskMaterials.linked')}</span>}
        <button type="button" className="library-btn" onClick={() => onPreview({ materialId: item.id, revision: item.hits[0]?.chunkId ? item.hits[0].revision : null, chunkId: item.hits[0]?.chunkId ?? null })}>{t('shared.preview')}</button>
      </div>)}
    </div>
    {(cursor > 0 || list.data?.nextCursor != null) && <div className="flex gap-2">
      <button type="button" className="library-btn" disabled={cursor <= 0} onClick={() => setCursor((value) => Math.max(0, value - 40))}>{t('shared.previousPage')}</button>
      <button type="button" className="library-btn" disabled={list.data?.nextCursor == null} onClick={() => { if (list.data?.nextCursor != null) setCursor(list.data.nextCursor); }}>{t('shared.nextPage')}</button>
    </div>}
  </>;
}
