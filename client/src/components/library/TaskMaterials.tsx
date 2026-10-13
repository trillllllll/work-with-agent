import './library.css';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type Task } from '@/lib/api.js';
import { queryKeys } from '@/lib/todo.js';
import { submitCommands } from '@/lib/platform.js';
import { descriptionCitesMaterial } from '@/lib/material-citation.js';
import { readDescriptionCaret } from '@/components/tasks/DescriptionEditor.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog.js';
import { LibraryPreview } from './LibraryPreview.js';
import { enqueueUploads } from './upload.js';
import { kindLabels, normalizeRow, type LibraryPreviewTarget, type LibraryRow, type MaterialDetail, type MaterialKind, type MaterialSummary, type Page } from './types.js';

export function TaskMaterials({ taskId, topicId, description, readonly, saveText, onOpenLinkedTask }: { taskId: string; topicId: string | null; description: string; readonly: boolean; saveText: () => Promise<boolean>; onOpenLinkedTask?: (taskId: string) => Promise<void> | void }) {
  const client = useQueryClient();
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
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
  const captureSelection = () => {
    const node = document.querySelector<HTMLElement>('[data-task-editor] [aria-label="详情"]');
    if (node) selectionRef.current = readDescriptionCaret(node);
  };
  const upload = async (files: File[]) => {
    if (!files.length || readonly) return;
    await enqueueUploads(files.map((file) => ({ file, relativePath: file.name })), { topicId, folderId: null, taskIds: [taskId] });
    await refresh();
  };
  const cite = async () => {
    if (!picked.length) return;
    const saved = await saveText();
    if (!saved) return;
    const task = await api<Task>(`/api/tasks/${taskId}?includeArchived=true`);
    const length = task.description.length;
    const caret = selectionRef.current;
    const start = caret && caret.start <= length ? caret.start : length;
    const end = caret && caret.end <= length ? caret.end : length;
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    try {
      const selected = await Promise.all(picked.map((itemId) => api<MaterialDetail>(`/api/v1/library/materials/${itemId}`)));
      await submitCommands([{
        kind: 'task.reference_materials',
        targetId: task.id,
        expectedRevision: task.revision,
        input: {
          materialIds: selected.map((item) => item.id),
          from,
          to,
          expectedMaterialRevisions: Object.fromEntries(selected.map((item) => [item.id, item.revision])),
          expectedOrganizationRevisions: Object.fromEntries(selected.map((item) => [item.id, item.organizationRevision])),
        },
      }]);
      await client.invalidateQueries({ queryKey: queryKeys.task(task.id) });
      await refresh();
      setPicking(false);
      setPicked([]);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-task-editor] [aria-label="详情"]')?.focus());
    } catch (error) { toast.error(error instanceof ApiError ? error.message : '没有插入引用'); }
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
      for (let index = 0; index < commands.length; index += 50) await submitCommands(commands.slice(index, index + 50));
      await refresh();
      setPicking(false);
      setPicked([]);
    } catch (error) { toast.error(error instanceof ApiError ? error.message : '没有关联资料'); }
  };
  const remove = async (material: MaterialSummary, removeInlineReferences: boolean) => {
    const saved = await saveText();
    if (!saved) return;
    const task = await api<Task>(`/api/tasks/${taskId}?includeArchived=true`);
    await submitCommands([{
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
      <h2 className="library-name">资料 · {materials.data?.total ?? items.length}</h2>
      {!readonly && <div className="flex gap-2">
        <label className="library-btn">上传文件<input className="sr-only" type="file" multiple aria-label="上传文件" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void upload(files); }} /></label>
        <Dialog open={picking} onOpenChange={(open) => { setPicking(open); if (!open) setPreview(null); }}>
          <DialogTrigger asChild><button type="button" className="library-btn" onMouseDown={captureSelection} onClick={captureSelection}>引用已有资料</button></DialogTrigger>
          <DialogContent className="library-surface material-picker" showCloseButton={false}>
            <DialogTitle>引用已有资料</DialogTitle>
            <DialogDescription className="sr-only">搜索并选择要引用的资料</DialogDescription>
            <PickerBody taskId={taskId} linked={linked} picked={picked} setPicked={setPicked} onPreview={setPreview} />
            <div className="material-picker-footer">
              <button type="button" className="library-btn" onClick={() => { void linkOnly(); }}>仅关联</button>
              <button type="button" className="library-btn library-btn-primary" onClick={() => { void cite(); }}>插入引用</button>
              <button type="button" className="library-btn" onClick={() => setPicking(false)}>取消</button>
            </div>
            {preview && <LibraryPreview target={preview} onTargetChange={setPreview} onClose={() => setPreview(null)} onOpenTask={(linkedId) => { void onOpenLinkedTask?.(linkedId); }} />}
          </DialogContent>
        </Dialog>
      </div>}
    </div>
    <div className={over ? 'library-drop' : undefined}>
      {!items.length && <p className="library-meta py-3">拖入文件，或引用已有资料</p>}
      {items.map((item) => <div key={item.id} className="task-material-row" data-testid={`task-material-${item.id}`}>
        <FileText className="library-icon" aria-hidden />
        <span className="library-name min-w-0 flex-1 truncate" title={item.title}>{item.title}</span>
        <button type="button" className="library-btn" onClick={() => setPreview({ materialId: item.id, revision: null, chunkId: null })}>预览</button>
        {!readonly && <button type="button" className="library-btn" onClick={() => { if (descriptionCitesMaterial(description, item.id)) setUnlink(item); else void remove(item, false).catch((error) => toast.error(error instanceof Error ? error.message : '没有解除关联')); }}>解除关联</button>}
      </div>)}
    </div>
    {unlink && <div className="library-dialog library-surface" role="dialog" aria-label="解除关联">
      <section>
        <h2 className="library-name">解除关联</h2>
        <p className="mt-2 text-sm">正文仍引用「{unlink.title}」。解除关联会把引用改回普通文字。取消后正文和关联都保持不变。</p>
        <div className="mt-3 flex gap-2">
          <button type="button" className="library-btn" onClick={() => setUnlink(null)}>取消</button>
          <button type="button" className="library-btn library-btn-danger" onClick={() => { const material = unlink; setUnlink(null); void remove(material, true).catch((error) => toast.error(error instanceof Error ? error.message : '没有解除关联')); }}>解除关联</button>
        </div>
      </section>
    </div>}
    {preview && !picking && createPortal(<div className="library-preview-host library-surface"><LibraryPreview target={preview} onTargetChange={setPreview} onClose={() => setPreview(null)} onOpenTask={(linkedId) => { void onOpenLinkedTask?.(linkedId); }} /></div>, document.body)}
  </section>;
}

function PickerBody({ taskId, linked, picked, setPicked, onPreview }: { taskId: string; linked: Set<string>; picked: string[]; setPicked: (ids: string[]) => void; onPreview: (target: LibraryPreviewTarget) => void }) {
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
    <input className="library-search material-picker-search" aria-label="搜索资料" placeholder="搜索文件名、标题、标签和正文" value={query} onChange={(event) => setQuery(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); setQuery(event.currentTarget.value); }} />
    <select className="library-select" aria-label="类型筛选" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
      <option value="">全部类型</option>
      {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
    <div className="material-picker-list">
      {list.isError && <div className="library-error" role="alert"><p>{list.error instanceof Error ? list.error.message : '资料没有加载'}</p><button type="button" className="library-btn" onClick={() => { void list.refetch(); }}>重试</button></div>}
      {!list.isError && list.isLoading && <p className="library-meta">正在读取资料</p>}
      {!list.isError && !list.isLoading && !rows.length && <p className="library-meta">没有符合条件的资料</p>}
      {rows.map((item) => <div key={item.id} className="material-picker-row" data-testid={`material-picker-row-${item.id}`}>
        <label className="material-picker-check"><input type="checkbox" aria-label={item.title} checked={picked.includes(item.id)} onChange={(event) => setPicked(event.target.checked ? [...picked, item.id] : picked.filter((id) => id !== item.id))} /></label>
        <span className="library-name min-w-0 flex-1 truncate" title={item.title}>{item.title}</span>
        <span className="library-meta shrink-0">{kindLabels[item.kind]}</span>
        {linked.has(item.id) && <span className="library-meta shrink-0">已关联</span>}
        <button type="button" className="library-btn" onClick={() => onPreview({ materialId: item.id, revision: item.hits[0]?.chunkId ? item.hits[0].revision : null, chunkId: item.hits[0]?.chunkId ?? null })}>预览</button>
      </div>)}
    </div>
    {(cursor > 0 || list.data?.nextCursor != null) && <div className="flex gap-2">
      <button type="button" className="library-btn" disabled={cursor <= 0} onClick={() => setCursor((value) => Math.max(0, value - 40))}>上一页</button>
      <button type="button" className="library-btn" disabled={list.data?.nextCursor == null} onClick={() => { if (list.data?.nextCursor != null) setCursor(list.data.nextCursor); }}>下一页</button>
    </div>}
  </>;
}
