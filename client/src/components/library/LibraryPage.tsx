import './library.css';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, type Task, type Topic } from '@/lib/api.js';
import { submitCommands, type Command } from '@/lib/platform.js';
import { Highlighted } from './highlight.js';
import { LibraryPreview } from './LibraryPreview.js';
import { clearLibraryFilters, libraryFilters, librarySearchParams, patchLibrary, useLibrarySnapshot } from './store.js';
import { extractionCopy, formatUpdated, kindLabels, type LibraryFolder, type LibraryTag, type MaterialSummary, type Page, type SearchHit } from './types.js';
import { enqueueUploads, filesFromList, filesFromTransfer, submitInBatches } from './upload.js';

type Row = { id: string; title: string; updatedAt: string; summary?: MaterialSummary; snippet?: { text: string; start: number; end: number } };

export function LibraryPage({ topics, onOpenTask }: { topics: Topic[]; onOpenTask: (taskId: string) => void }) {
  const snapshot = useLibrarySnapshot();
  const client = useQueryClient();
  const listRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const [composing, setComposing] = useState(false);
  const [debounced, setDebounced] = useState(snapshot.query);
  const [picked, setPicked] = useState<string[]>([]);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<'move' | 'tags' | 'tasks' | 'ask' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const params = librarySearchParams(snapshot);
  const searching = debounced.trim().length > 0;
  const list = useQuery({
    queryKey: ['library', 'list', searching ? debounced : '', params.toString()],
    queryFn: ({ signal }): Promise<Page<SearchHit> | Page<MaterialSummary>> => searching
      ? api<Page<SearchHit>>(`/api/v1/library/search?q=${encodeURIComponent(debounced.trim())}&${params}`, { signal })
      : api<Page<MaterialSummary>>(`/api/v1/library/materials?${params}`, { signal }),
    refetchInterval: 3000,
  });
  const folders = useQuery({ queryKey: ['library', 'folders'], queryFn: ({ signal }) => api<{ items: LibraryFolder[] }>('/api/v1/library/folders', { signal }) });
  const tags = useQuery({ queryKey: ['library', 'tags'], queryFn: ({ signal }) => api<{ items: LibraryTag[] }>('/api/v1/library/tags', { signal }) });
  const rows = rowsOf(list.data);
  useEffect(() => {
    if (composing) return;
    const timer = window.setTimeout(() => setDebounced(snapshot.query), 200);
    return () => window.clearTimeout(timer);
  }, [snapshot.query, composing]);
  useEffect(() => {
    if (restored.current || !listRef.current) return;
    restored.current = true;
    listRef.current.scrollTop = snapshot.scrollTop;
  }, [snapshot.scrollTop, rows.length]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || dialog) return;
      if (!snapshot.selectedId) return;
      event.preventDefault();
      closePreview();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const target = { topicId: null, folderId: snapshot.folderId || null, taskIds: [] as string[] };
  const takeFiles = async (files: Array<{ file: File; relativePath: string }>) => {
    if (!files.length) return;
    await enqueueUploads(files, target);
    await client.invalidateQueries({ queryKey: ['library'] });
  };
  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    await takeFiles(await filesFromTransfer(event.dataTransfer));
  };
  const closePreview = () => {
    const selected = snapshot.selectedId;
    patchLibrary({ selectedId: '' });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="library-row-${CSS.escape(selected)}"]`)?.focus());
  };
  const summaries = new Map(rows.flatMap((row) => row.summary ? [[row.id, row.summary] as const] : []));
  const chosen = picked.flatMap((id) => {
    const row = rows.find((item) => item.id === id);
    return row?.summary ? [row.summary] : [];
  });

  return <section className="library-surface library-page" data-testid="library-surface" onDragOver={(event) => { if ([...event.dataTransfer.items].some((item) => item.kind === 'file')) { event.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={(event) => { void onDrop(event); }} onPaste={(event) => {
    const node = event.target;
    if (node instanceof HTMLElement && node.closest('input, textarea, [contenteditable="true"]')) return;
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    event.preventDefault();
    void takeFiles(files.map((file) => ({ file, relativePath: file.name })));
  }}>
    <div className={`library-frame ${dragging ? 'library-drop' : ''}`}>
      <header className="library-titlebar">
        <h1 className="library-title">资料库</h1>
        <div className="library-title-links">
          <button type="button" className="library-btn" onClick={() => { window.location.hash = '/knowledge/memories'; }}>记忆</button>
          <button type="button" className="library-btn" onClick={() => { window.location.hash = '/knowledge/brief'; }}>当前简报</button>
        </div>
      </header>
      <div className="library-toolbar">
        <input className="library-search" aria-label="搜索资料" placeholder="搜索文件名、标题、标签和正文" value={snapshot.query} onChange={(event) => patchLibrary({ query: event.target.value })} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); patchLibrary({ query: event.currentTarget.value }); }} />
        <select className="library-select" aria-label="类型筛选" value={snapshot.kind} onChange={(event) => patchLibrary({ kind: event.target.value as typeof snapshot.kind })}>
          <option value="">全部类型</option>
          {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select className="library-select" aria-label="关联任务筛选" value={snapshot.taskTopicId} onChange={(event) => patchLibrary({ taskTopicId: event.target.value })}>
          <option value="">全部清单</option>
          <option value="inbox">收集箱</option>
          {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
        </select>
        <button type="button" className="library-btn library-folder-button" onClick={() => setFoldersOpen(true)}>文件夹</button>
        <button type="button" className="library-btn" onClick={() => setDialog('ask')}>问资料</button>
        <button type="button" className="library-btn library-btn-primary" onClick={() => fileRef.current?.click()}>添加</button>
        <input ref={fileRef} className="sr-only" type="file" multiple aria-label="选择文件" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void filesFromList(files).then(takeFiles); }} />
        <input ref={(node) => { directoryRef.current = node; node?.setAttribute('webkitdirectory', ''); }} className="sr-only" type="file" multiple aria-label="选择文件夹" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void filesFromList(files).then(takeFiles); }} />
        <button type="button" className="library-btn" onClick={() => directoryRef.current?.click()}>文件夹导入</button>
      </div>
      {picked.length > 0 && <div className="library-toolbar" aria-label="批量操作">
        <button type="button" className="library-btn" onClick={() => setDialog('move')}>移动</button>
        <button type="button" className="library-btn" onClick={() => setDialog('tags')}>标签</button>
        <button type="button" className="library-btn" onClick={() => setDialog('tasks')}>关联任务</button>
        <button type="button" className="library-btn" onClick={() => { void organize(chosen.map((item) => ({ kind: 'material.archive', targetId: item.id, expectedRevision: item.revision, input: { archived: true } }))); }}>归档</button>
        <button type="button" className="library-btn" onClick={() => setPicked([])}>取消选择</button>
      </div>}
      <div className={`library-body ${snapshot.selectedId ? 'has-preview' : 'no-preview'}`}>
        <FolderNav folders={folders.data?.items ?? []} tags={tags.data?.items ?? []} open={foldersOpen} onClose={() => setFoldersOpen(false)} onCreate={async (parentId, name) => { await submitCommands([{ kind: 'libraryFolder.create', input: { parentId, name } }]); await client.invalidateQueries({ queryKey: ['library', 'folders'] }); }} />
        <div ref={listRef} className="library-panel" data-testid="library-list" onScroll={(event) => patchLibrary({ scrollTop: event.currentTarget.scrollTop })}>
          {!rows.length && !list.isLoading && <div className="p-6"><p>没有找到符合条件的资料</p><button type="button" className="library-btn mt-3" onClick={() => { clearLibraryFilters(); setDebounced(''); }}>清除筛选</button></div>}
          {rows.length > 0 && <table className="library-table">
            <thead><tr><th /><th>名称</th><th className="library-col-optional">类型</th><th>关联任务</th><th className="library-col-optional">更新时间</th><th>更多</th></tr></thead>
            <tbody>
              {rows.map((row) => <tr key={row.id} data-testid={`library-row-${row.id}`} aria-selected={snapshot.selectedId === row.id} tabIndex={-1} className={`library-row library-color ${row.snippet ? 'has-snippet' : ''}`} onClick={() => patchLibrary({ selectedId: row.id })}>
                <td><button type="button" className="library-check-hit" aria-label={`选择 ${row.title}`} onClick={(event) => { event.stopPropagation(); setPicked((current) => current.includes(row.id) ? current.filter((item) => item !== row.id) : [...current, row.id]); }}><input className="library-check" type="checkbox" readOnly checked={picked.includes(row.id)} tabIndex={-1} /></button></td>
                <td><div className="library-name truncate">{row.title}</div><div className="library-meta truncate">{row.snippet ? <Highlighted text={row.snippet.text} start={row.snippet.start} end={row.snippet.end} /> : row.summary ? `${folderName(folders.data?.items ?? [], row.summary.folderId)} ${row.summary.tags.map((tag) => tag.name).join(' ')} ${extractionCopy[row.summary.extraction.status]}` : ''}</div></td>
                <td className="library-col-optional library-meta">{row.summary ? kindLabels[row.summary.kind] : ''}</td>
                <td className="library-meta">{row.summary ? row.summary.linkedTaskCount : ''}</td>
                <td className="library-col-optional library-meta">{formatUpdated(row.updatedAt)}</td>
                <td><button type="button" className="library-btn" onClick={(event) => { event.stopPropagation(); patchLibrary({ selectedId: row.id }); }}>更多</button></td>
              </tr>)}
            </tbody>
          </table>}
        </div>
        {snapshot.selectedId && <LibraryPreview id={snapshot.selectedId} onClose={closePreview} onOpenTask={onOpenTask} />}
      </div>
    </div>
    {dialog && <BatchDialog mode={dialog} topics={topics} folders={folders.data?.items ?? []} tags={tags.data?.items ?? []} filters={libraryFilters(snapshot)} materials={chosen} onClose={() => setDialog(null)} onDone={async () => { setDialog(null); setPicked([]); await client.invalidateQueries({ queryKey: ['library'] }); }} />}
  </section>;
}

function rowsOf(page: Page<MaterialSummary> | Page<SearchHit> | undefined): Row[] {
  const items = page?.items ?? [];
  return items.map((item) => 'kind' in item ? { id: item.id, title: item.title, updatedAt: item.updatedAt, summary: item } : { id: item.id, title: item.title, updatedAt: item.updatedAt, snippet: item.hits[0] ? { text: item.hits[0].snippet, start: item.hits[0].highlightStart, end: item.hits[0].highlightEnd } : undefined });
}

function folderName(folders: LibraryFolder[], id: string | null) {
  if (!id) return '未整理';
  return folders.find((folder) => folder.id === id)?.name ?? '未整理';
}

function FolderNav({ folders, tags, open, onClose, onCreate }: { folders: LibraryFolder[]; tags: LibraryTag[]; open: boolean; onClose: () => void; onCreate: (parentId: string | null, name: string) => Promise<void> }) {
  const snapshot = useLibrarySnapshot();
  const [name, setName] = useState('');
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const depth = (folder: LibraryFolder) => {
    let count = 0;
    let cursor: LibraryFolder | undefined = folder;
    const seen = new Set<string>();
    while (cursor?.parentId && !seen.has(cursor.id)) { seen.add(cursor.id); count += 1; cursor = byId.get(cursor.parentId); }
    return count;
  };
  const body = <>
    {([['all', '全部资料'], ['recent', '最近添加'], ['unfiled', '未整理'], ['archived', '已归档']] as const).map(([view, label]) => <button key={view} type="button" className="library-side-button" aria-current={snapshot.view === view && !snapshot.folderId ? 'page' : undefined} onClick={() => { patchLibrary({ view, folderId: '', selectedId: snapshot.selectedId }); onClose(); }}>{label}</button>)}
    <hr className="library-rule" />
    <p className="library-meta px-3">文件夹</p>
    {folders.map((folder) => <button key={folder.id} type="button" className="library-side-button" style={{ paddingLeft: 10 + depth(folder) * 12 }} aria-current={snapshot.folderId === folder.id ? 'page' : undefined} onClick={() => { patchLibrary({ view: 'all', folderId: folder.id }); onClose(); }}>{folder.name}</button>)}
    <form className="flex gap-1 px-2 py-2" onSubmit={(event) => { event.preventDefault(); const next = name.trim(); if (!next) return; void onCreate(snapshot.folderId || null, next).then(() => setName('')); }}>
      <input className="library-search" aria-label="新文件夹名称" value={name} onChange={(event) => setName(event.target.value)} />
      <button type="submit" className="library-btn">新建</button>
    </form>
    <hr className="library-rule" />
    <p className="library-meta px-3">标签</p>
    {tags.map((tag) => <button key={tag.id} type="button" className="library-tag" aria-pressed={snapshot.tagIds.includes(tag.id)} onClick={() => patchLibrary({ tagIds: snapshot.tagIds.includes(tag.id) ? snapshot.tagIds.filter((item) => item !== tag.id) : [...snapshot.tagIds, tag.id] })}>{tag.name}</button>)}
  </>;
  return <>
    <nav className="library-panel library-folders" data-testid="library-folders" aria-label="资料文件夹">{body}</nav>
    {open && createPortal(<div className="library-dialog library-surface" role="dialog" aria-label="文件夹"><section><button type="button" className="library-btn" onClick={onClose}>关闭</button>{body}</section></div>, document.body)}
  </>;
}

async function organize(commands: Command[]) {
  try { await submitInBatches(commands); }
  catch (error) { toast.error(error instanceof ApiError ? error.message : '操作失败'); }
}

function BatchDialog({ mode, topics, folders, tags, filters, materials, onClose, onDone }: {
  mode: 'move' | 'tags' | 'tasks' | 'ask';
  topics: Topic[];
  folders: LibraryFolder[];
  tags: LibraryTag[];
  filters: ReturnType<typeof libraryFilters>;
  materials: MaterialSummary[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [folderId, setFolderId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [taskId, setTaskId] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ status: string; paragraphs: Array<{ text: string; citationIds: string[] }>; citations: Array<{ id: string; materialId: string; titleSnapshot: string; quote: string }> } | null>(null);
  const tasks = useQuery({ queryKey: ['library', 'all-tasks'], queryFn: ({ signal }) => api<Task[]>('/api/tasks', { signal }), enabled: mode === 'tasks' });
  const apply = async () => {
    if (mode === 'move') await organize(materials.map((item) => ({ kind: 'material.organize', targetId: item.id, expectedRevision: item.revision, input: { expectedOrganizationRevision: item.organizationRevision, folderId: folderId || null } })));
    if (mode === 'tags') await organize(materials.map((item) => ({ kind: 'material.organize', targetId: item.id, expectedRevision: item.revision, input: { expectedOrganizationRevision: item.organizationRevision, tagIds: [...new Set([...item.tags.map((tag) => tag.id), ...tagIds])] } })));
    if (mode === 'tasks' && taskId) await organize(materials.map((item) => ({ kind: 'material.links', targetId: item.id, expectedRevision: item.revision, input: { expectedOrganizationRevision: item.organizationRevision, addTaskIds: [taskId], removeTaskIds: [], removeInlineReferences: false, expectedTaskRevisions: {} } })));
    await onDone();
  };
  const ask = async () => {
    try {
      const result = await api<NonNullable<typeof answer>>('/api/v1/library/answers', { method: 'POST', body: JSON.stringify({ requestKey: crypto.randomUUID(), question, filters }) });
      setAnswer(result);
    } catch (error) { toast.error(error instanceof ApiError ? error.message : '暂时不能回答'); }
  };
  return <div className="library-dialog library-surface" role="dialog" aria-label={mode === 'ask' ? '问资料' : '批量整理'}>
    <section>
      <div className="flex justify-between"><h2 className="library-name">{mode === 'move' ? '移动' : mode === 'tags' ? '标签' : mode === 'tasks' ? '关联任务' : '问资料'}</h2><button type="button" className="library-btn" onClick={onClose}>关闭</button></div>
      {mode === 'move' && <select className="library-select mt-3 w-full" aria-label="移动到文件夹" value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">未整理</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>}
      {mode === 'tags' && <div className="mt-3 space-y-1">{tags.map((tag) => <label key={tag.id} className="flex items-center gap-2"><input type="checkbox" checked={tagIds.includes(tag.id)} onChange={(event) => setTagIds((current) => event.target.checked ? [...current, tag.id] : current.filter((item) => item !== tag.id))} />{tag.name}</label>)}</div>}
      {mode === 'tasks' && <select className="library-select mt-3 w-full" aria-label="关联到任务" value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">选择任务</option>{(tasks.data ?? []).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select>}
      {mode === 'ask' && <>
        <textarea className="library-search mt-3 h-24 w-full py-2" aria-label="向资料提问" value={question} onChange={(event) => setQuestion(event.target.value)} />
        <button type="button" className="library-btn library-btn-primary mt-2" onClick={() => { void ask(); }}>提问</button>
        {answer?.status === 'model_unavailable' && <p className="library-meta mt-3">需要配置识字模型。普通搜索仍然可用。</p>}
        {answer?.status === 'insufficient' && <p className="library-meta mt-3">资料里没有足够的原文可以回答。</p>}
        {answer?.paragraphs.map((paragraph, index) => <p key={index} className="mt-3 whitespace-pre-wrap text-sm">{paragraph.text} {paragraph.citationIds.join(' ')}</p>)}
        {answer?.citations.map((citation) => <button key={citation.id} type="button" className="library-quote mt-2 block w-full p-2 text-left" onClick={() => { patchLibrary({ selectedId: citation.materialId }); onClose(); }}><span className="library-meta">{citation.id} · {citation.titleSnapshot}</span><span className="mt-1 block whitespace-pre-wrap text-sm">{citation.quote}</span></button>)}
      </>}
      {mode !== 'ask' && <button type="button" className="library-btn library-btn-primary mt-3" onClick={() => { void apply(); }}>应用</button>}
      <p className="sr-only">{topics.length}</p>
    </section>
  </div>;
}
