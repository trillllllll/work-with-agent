import './library.css';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type Task } from '@/lib/api.js';
import { queryKeys } from '@/lib/todo.js';
import { submitCommands } from '@/lib/platform.js';
import { descriptionCitesMaterial } from '@/lib/material-citation.js';
import { readDescriptionCaret } from '@/components/tasks/DescriptionEditor.js';
import { LibraryPreview } from './LibraryPreview.js';
import { enqueueUploads } from './upload.js';
import type { MaterialSummary, Page } from './types.js';

export function TaskMaterials({ taskId, topicId, description, readonly, saveText }: { taskId: string; topicId: string | null; description: string; readonly: boolean; saveText: () => Promise<void> }) {
  const client = useQueryClient();
  const [over, setOver] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState('');
  const [unlink, setUnlink] = useState<MaterialSummary | null>(null);
  const materials = useQuery({
    queryKey: ['library', 'task-materials', taskId],
    queryFn: ({ signal }) => api<Page<MaterialSummary>>(`/api/v1/library/tasks/${taskId}/materials?limit=100`, { signal }),
  });
  const library = useQuery({
    queryKey: ['library', 'picker'],
    queryFn: ({ signal }) => api<Page<MaterialSummary>>('/api/v1/library/materials?limit=100&archived=exclude', { signal }),
    enabled: picking,
  });
  const items = materials.data?.items ?? [];
  const refresh = () => client.invalidateQueries({ queryKey: ['library', 'task-materials', taskId] });
  const upload = async (files: File[]) => {
    if (!files.length || readonly) return;
    await enqueueUploads(files.map((file) => ({ file, relativePath: file.name })), { topicId, folderId: null, taskIds: [taskId] });
    await refresh();
  };
  const cite = async (selected: MaterialSummary[]) => {
    if (!selected.length) return;
    await saveText();
    const task = await api<Task>(`/api/tasks/${taskId}?includeArchived=true`);
    const node = document.querySelector<HTMLElement>('[aria-label="详情"]');
    const caret = node ? readDescriptionCaret(node) : null;
    const length = task.description.length;
    const from = caret && caret.start <= length ? caret.start : length;
    const to = caret && caret.end <= length ? caret.end : length;
    try {
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
    } catch (error) { toast.error(error instanceof ApiError ? error.message : '没有插入引用'); }
  };
  const remove = async (material: MaterialSummary, removeInlineReferences: boolean) => {
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
        <button type="button" className="library-btn" onClick={() => setPicking(true)}>引用已有资料</button>
      </div>}
    </div>
    <div className={over ? 'library-drop' : undefined}>
      {!items.length && <p className="library-meta py-3">拖入文件，或引用已有资料</p>}
      {items.map((item) => <div key={item.id} className="task-material-row" data-testid={`task-material-${item.id}`}>
        <FileText className="library-icon" aria-hidden />
        <span className="library-name min-w-0 flex-1 truncate" title={item.title}>{item.title}</span>
        <button type="button" className="library-btn" onClick={() => setPreviewId(item.id)}>预览</button>
        {!readonly && <button type="button" className="library-btn" onClick={() => { if (descriptionCitesMaterial(description, item.id)) setUnlink(item); else void remove(item, false).catch((error) => toast.error(error instanceof Error ? error.message : '没有解除关联')); }}>解除关联</button>}
      </div>)}
    </div>
    {picking && <div className="library-dialog library-surface" role="dialog" aria-label="引用已有资料">
      <section>
        <h2 className="library-name">引用已有资料</h2>
        <div className="mt-3 max-h-80 space-y-1 overflow-auto">{(library.data?.items ?? []).map((item) => <label key={item.id} className="flex items-center gap-2"><input type="checkbox" checked={picked.includes(item.id)} onChange={(event) => setPicked((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />{item.title}</label>)}</div>
        <div className="mt-3 flex gap-2">
          <button type="button" className="library-btn library-btn-primary" onClick={() => { void cite((library.data?.items ?? []).filter((item) => picked.includes(item.id))); }}>插入引用</button>
          <button type="button" className="library-btn" onClick={() => setPicking(false)}>取消</button>
        </div>
      </section>
    </div>}
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
    {previewId && createPortal(<div className="library-preview-host library-surface"><LibraryPreview id={previewId} onClose={() => setPreviewId('')} onOpenTask={() => setPreviewId('')} /></div>, document.body)}
  </section>;
}

