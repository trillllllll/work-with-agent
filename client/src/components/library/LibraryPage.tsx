import './library.css';
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, type Topic } from '@/lib/api.js';
import { submitCommands, type Command } from '@/lib/platform.js';
import { Highlighted } from './highlight.js';
import { LibraryPreview } from './LibraryPreview.js';
import { TaskLinkPicker } from './TaskLinkPicker.js';
import { clearLibraryFilters, libraryFilters, libraryPageSize, librarySearchParams, patchLibrary, useLibrarySnapshot } from './store.js';
import { extractionCopy, formatUpdated, kindLabels, normalizeRow, type AnswerResult, type LibraryFolder, type LibraryPreviewTarget, type LibraryRow, type LibraryTag, type MaterialDetail, type Page } from './types.js';
import { enqueueUploads, filesFromList, filesFromTransfer, onLibraryChanged } from './upload.js';

type Editor =
  | { kind: 'folder-create'; parentId: string | null }
  | { kind: 'folder-rename'; folder: LibraryFolder }
  | { kind: 'folder-move'; folder: LibraryFolder }
  | { kind: 'tag-rename'; tag: LibraryTag }
  | { kind: 'material-rename'; id: string; title: string };

export function LibraryPage({ topics, onOpenTask }: { topics: Topic[]; onOpenTask: (taskId: string) => void | Promise<void> }) {
  const snapshot = useLibrarySnapshot();
  const client = useQueryClient();
  const surfaceRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const [composing, setComposing] = useState(false);
  const [debounced, setDebounced] = useState(snapshot.query);
  const [narrow, setNarrow] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [dialog, setDialog] = useState<'move' | 'tags' | 'tasks' | 'ask' | null>(null);
  const [composer, setComposer] = useState<'text' | 'link' | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [pageNotice, setPageNotice] = useState('');
  const params = librarySearchParams(snapshot);
  const searching = debounced.trim().length > 0;
  const list = useQuery({
    queryKey: ['library', 'list', searching ? debounced : '', params.toString()],
    queryFn: ({ signal }) => searching
      ? api<Page<LibraryRow>>(`/api/v1/library/search?q=${encodeURIComponent(debounced.trim())}&${params}`, { signal })
      : api<Page<LibraryRow>>(`/api/v1/library/materials?${params}`, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: 3000,
    retry: false,
  });
  const folders = useQuery({ queryKey: ['library', 'folders'], queryFn: ({ signal }) => api<{ items: LibraryFolder[] }>('/api/v1/library/folders', { signal }) });
  const tags = useQuery({ queryKey: ['library', 'tags'], queryFn: ({ signal }) => api<{ items: LibraryTag[] }>('/api/v1/library/tags', { signal }) });
  const rows = (list.data?.items ?? []).map((item) => normalizeRow(item));
  const refresh = async () => { await client.invalidateQueries({ queryKey: ['library'] }); };
  useEffect(() => {
    const stop = onLibraryChanged(() => { void refresh(); });
    return () => { stop(); };
  }, [client]);
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
  useLayoutEffect(() => {
    const node = surfaceRef.current;
    if (!node) return;
    const measure = () => setNarrow(node.getBoundingClientRect().width < 760);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const target = { topicId: null, folderId: snapshot.folderId || null, taskIds: [] as string[] };
  const takeFiles = async (files: Array<{ file: File; relativePath: string }>) => {
    if (!files.length) return;
    await enqueueUploads(files, target);
    await refresh();
  };
  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    await takeFiles(await filesFromTransfer(event.dataTransfer));
  };
  const closePreview = () => {
    const selected = snapshot.preview?.materialId ?? '';
    patchLibrary({ preview: null });
    if (!selected) return;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="library-row-${CSS.escape(selected)}"]`)?.focus());
  };
  const applyBatch = async (ids: string[], build: (item: MaterialDetail) => Command) => {
    const locked = ids.slice();
    if (!locked.length) return { ok: false, text: '已完成 0 份，0 份未完成' };
    let done = 0;
    try {
      const latest = await Promise.all(locked.map((itemId) => api<MaterialDetail>(`/api/v1/library/materials/${itemId}`)));
      const commands = latest.map(build);
      for (let index = 0; index < commands.length; index += 50) {
        const slice = commands.slice(index, index + 50);
        try {
          const result = await submitCommands(slice);
          if (result.status !== 'applied') throw new Error('未完成');
          done += slice.length;
        } catch {
          patchLibrary({ selectedIds: locked.slice(done) });
          return { ok: false, text: `已完成 ${done} 份，${locked.length - done} 份未完成` };
        }
      }
    } catch {
      patchLibrary({ selectedIds: locked.slice(done) });
      return { ok: false, text: `已完成 ${done} 份，${locked.length - done} 份未完成` };
    }
    patchLibrary({ selectedIds: [] });
    await refresh();
    return { ok: true, text: '' };
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const node = event.target;
      if (node instanceof Element && node.closest('[role="dialog"]')) return;
      if (rowMenu) { setRowMenu(null); return; }
      if (addOpen) { setAddOpen(false); return; }
      if (foldersOpen) { setFoldersOpen(false); return; }
      if (dialog || composer || editor) return;
      if (!snapshot.preview) return;
      event.preventDefault();
      closePreview();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const openPreview = (row: LibraryRow) => {
    const hit = row.hits[0];
    const preview: LibraryPreviewTarget = hit?.chunkId
      ? { materialId: row.id, revision: typeof hit.revision === 'number' ? hit.revision : null, chunkId: hit.chunkId }
      : { materialId: row.id, revision: null, chunkId: null };
    patchLibrary({ preview });
  };
  const saveEditor = async (value: string) => {
    if (!editor) return;
    try {
      if (editor.kind === 'folder-create') await submitCommands([{ kind: 'libraryFolder.create', input: { parentId: editor.parentId, name: value } }], crypto.randomUUID());
      if (editor.kind === 'folder-rename') await submitCommands([{ kind: 'libraryFolder.update', targetId: editor.folder.id, expectedRevision: editor.folder.revision, input: { name: value } }]);
      if (editor.kind === 'tag-rename') await submitCommands([{ kind: 'libraryTag.update', targetId: editor.tag.id, expectedRevision: editor.tag.revision, input: { name: value } }]);
      if (editor.kind === 'material-rename') {
        const detail = await api<MaterialDetail>(`/api/v1/library/materials/${editor.id}`);
        await submitCommands([{ kind: 'material.update', targetId: editor.id, expectedRevision: detail.revision, input: { title: value } }]);
      }
      if (editor.kind === 'folder-move') await submitCommands([{ kind: 'libraryFolder.update', targetId: editor.folder.id, expectedRevision: editor.folder.revision, input: { parentId: value || null } }]);
      setEditor(null);
      await refresh();
    } catch (error) { toast.error(error instanceof ApiError ? error.message : '操作失败'); }
  };

  const pageNumber = Math.floor(snapshot.cursor / libraryPageSize) + 1;
  const cancelled = list.error instanceof DOMException && list.error.name === 'AbortError';
  const showError = list.isError && !cancelled;
  return <section ref={surfaceRef} className="library-surface library-page" data-testid="library-surface" data-narrow={narrow ? 'true' : 'false'} onDragOver={(event) => { if ([...event.dataTransfer.items].some((item) => item.kind === 'file')) { event.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={(event) => { void onDrop(event); }} onPaste={(event) => {
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
        <div className="library-toolbar-group library-toolbar-search">
          <input className="library-search" aria-label="搜索资料" placeholder="搜索文件名、标题、标签和正文" value={snapshot.query} onChange={(event) => patchLibrary({ query: event.target.value })} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); patchLibrary({ query: event.currentTarget.value }); }} />
        </div>
        <div className="library-toolbar-group library-toolbar-filters">
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
        </div>
        <div className="library-toolbar-group library-toolbar-actions">
          <button type="button" className="library-btn" onClick={() => setDialog('ask')}>问资料</button>
          <div className="relative">
            <button type="button" className="library-btn library-btn-primary" aria-expanded={addOpen} onClick={() => setAddOpen((value) => !value)}>添加</button>
            {addOpen && <div className="library-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setAddOpen(false); fileRef.current?.click(); }}>文件</button>
              <button type="button" role="menuitem" onClick={() => { setAddOpen(false); directoryRef.current?.click(); }}>文件夹导入</button>
              <button type="button" role="menuitem" onClick={() => { setAddOpen(false); setComposer('text'); }}>文本</button>
              <button type="button" role="menuitem" onClick={() => { setAddOpen(false); setComposer('link'); }}>链接</button>
            </div>}
          </div>
          <input ref={fileRef} className="sr-only" type="file" multiple aria-label="选择文件" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void filesFromList(files).then(takeFiles); }} />
          <input ref={(node) => { directoryRef.current = node; node?.setAttribute('webkitdirectory', ''); }} className="sr-only" type="file" multiple aria-label="选择文件夹" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void filesFromList(files).then(takeFiles); }} />
        </div>
      </div>
      {snapshot.selectedIds.length > 0 && <div className="library-toolbar" aria-label="批量操作">
        <button type="button" className="library-btn" onClick={() => setDialog('move')}>移动</button>
        <button type="button" className="library-btn" onClick={() => setDialog('tags')}>标签</button>
        <button type="button" className="library-btn" onClick={() => setDialog('tasks')}>关联任务</button>
        <button type="button" className="library-btn" onClick={() => { void applyBatch(snapshot.selectedIds, (item) => ({ kind: 'material.archive', targetId: item.id, expectedRevision: item.revision, input: { archived: true } })).then((outcome) => { if (!outcome.ok) setPageNotice(outcome.text); }); }}>归档</button>
        <button type="button" className="library-btn" onClick={() => patchLibrary({ selectedIds: [] })}>取消选择</button>
      </div>}
      {pageNotice && <p className="library-meta" role="alert">{pageNotice}</p>}
      <div className={`library-body ${snapshot.preview ? 'has-preview' : 'no-preview'}`}>
        <FolderNav folders={folders.data?.items ?? []} tags={tags.data?.items ?? []} open={foldersOpen} onClose={() => setFoldersOpen(false)} onEdit={setEditor} onRefresh={refresh} />
        <div ref={listRef} className="library-panel" data-testid="library-list" onScroll={(event) => patchLibrary({ scrollTop: event.currentTarget.scrollTop })}>
          {showError && <div className="library-error" role="alert"><p>{list.error instanceof Error ? list.error.message : '资料没有加载'}</p><button type="button" className="library-btn" onClick={() => { void list.refetch(); }}>重试</button></div>}
          {!showError && list.isLoading && !list.data && <p className="library-meta p-3">正在读取资料</p>}
          {!showError && !rows.length && !list.isLoading && <div className="p-6"><p>没有符合条件的资料</p><button type="button" className="library-btn mt-3" onClick={() => { clearLibraryFilters(); setDebounced(''); }}>清除筛选</button></div>}
          {!showError && rows.length > 0 && <table className="library-table">
            <thead><tr><th /><th>名称</th><th className="library-col-optional">类型</th><th>关联任务</th><th className="library-col-optional">更新时间</th><th>更多</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const hit = row.hits[0];
                return <tr key={row.id} data-testid={`library-row-${row.id}`} aria-selected={snapshot.preview?.materialId === row.id} tabIndex={-1} className={`library-row library-color ${hit ? 'has-snippet' : ''}`} onClick={() => openPreview(row)}>
                  <td><label className="library-check-hit" onClick={(event) => event.stopPropagation()}><input className="library-check" type="checkbox" aria-label={`选择 ${row.title}`} checked={snapshot.selectedIds.includes(row.id)} onClick={(event) => event.stopPropagation()} onChange={(event) => { const selected = snapshot.selectedIds; patchLibrary({ selectedIds: event.target.checked ? [...selected, row.id] : selected.filter((item) => item !== row.id) }); }} /></label></td>
                  <td><div className="library-name truncate">{row.title}</div><div className="library-meta truncate">{hit ? <Highlighted text={hit.snippet} start={hit.highlightStart} end={hit.highlightEnd} /> : `${folderName(folders.data?.items ?? [], row.folderId)} ${row.tags.map((tag) => tag.name).join(' ')} ${extractionCopy[row.extraction.status]}`}</div></td>
                  <td className="library-col-optional library-meta">{kindLabels[row.kind]}</td>
                  <td className="library-meta">{row.linkedTaskCount}</td>
                  <td className="library-col-optional library-meta">{formatUpdated(row.updatedAt)}</td>
                  <td><button type="button" className="library-btn" aria-label={`更多 ${row.title}`} onClick={(event) => { event.stopPropagation(); setRowMenu((current) => current === row.id ? null : row.id); }}>更多</button>
                    {rowMenu === row.id && <div className="library-menu" role="menu"><button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); setRowMenu(null); setEditor({ kind: 'material-rename', id: row.id, title: row.title }); }}>重命名</button></div>}
                  </td>
                </tr>;
              })}
            </tbody>
          </table>}
          {!showError && list.data && <footer className="library-pagination" data-testid="library-pagination">
            <span>共 {list.data.total} 份资料</span>
            <button type="button" className="library-btn" disabled={snapshot.cursor <= 0 || list.isPlaceholderData} onClick={() => patchLibrary({ cursor: Math.max(0, snapshot.cursor - libraryPageSize) })}>上一页</button>
            <span>第 {pageNumber} 页</span>
            <button type="button" className="library-btn" disabled={list.data.nextCursor == null || list.isPlaceholderData} onClick={() => { if (list.data?.nextCursor != null) patchLibrary({ cursor: list.data.nextCursor }); }}>下一页</button>
          </footer>}
        </div>
        {snapshot.preview && <LibraryPreview target={snapshot.preview} onTargetChange={(preview) => patchLibrary({ preview })} onClose={closePreview} onOpenTask={onOpenTask} />}
      </div>
    </div>
    {dialog && <BatchDialog mode={dialog} ids={snapshot.selectedIds} topics={topics} folders={folders.data?.items ?? []} tags={tags.data?.items ?? []} onClose={() => setDialog(null)} applyBatch={applyBatch} />}
    {composer && <Composer kind={composer} onClose={() => setComposer(null)} onRefresh={refresh} />}
    {editor && <NameDialog editor={editor} folders={folders.data?.items ?? []} onClose={() => setEditor(null)} onSave={saveEditor} />}
  </section>;
}

function folderName(folders: LibraryFolder[], id: string | null) {
  if (!id) return '未整理';
  return folders.find((folder) => folder.id === id)?.name ?? '未整理';
}

function orderedFolders(folders: LibraryFolder[]) {
  const ids = new Set(folders.map((folder) => folder.id));
  const children = new Map<string | null, LibraryFolder[]>();
  const norm = (value: string) => value.normalize('NFKC').trim().toLowerCase();
  for (const folder of folders) {
    const parent = folder.parentId && ids.has(folder.parentId) ? folder.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(folder);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((left, right) => norm(left.name).localeCompare(norm(right.name), 'zh') || left.id.localeCompare(right.id));
  const ordered: Array<{ folder: LibraryFolder; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const folder of children.get(parent) ?? []) {
      ordered.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return ordered;
}

function descendantIds(folders: LibraryFolder[], id: string) {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const list = children.get(folder.parentId) ?? [];
    list.push(folder.id);
    children.set(folder.parentId, list);
  }
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const currentId = stack.pop();
    if (!currentId) continue;
    for (const child of children.get(currentId) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      stack.push(child);
    }
  }
  return seen;
}

function FolderNav({ folders, tags, open, onClose, onEdit, onRefresh }: { folders: LibraryFolder[]; tags: LibraryTag[]; open: boolean; onClose: () => void; onEdit: (editor: Editor) => void; onRefresh: () => Promise<void> }) {
  const snapshot = useLibrarySnapshot();
  const [name, setName] = useState('');
  const [tagName, setTagName] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const ordered = orderedFolders(folders);
  const removeFolder = async (folder: LibraryFolder) => {
    await submitCommands([{ kind: 'libraryFolder.delete', targetId: folder.id, expectedRevision: folder.revision, input: {} }]);
    await onRefresh();
  };
  const removeTag = async (tag: LibraryTag) => {
    await submitCommands([{ kind: 'libraryTag.delete', targetId: tag.id, expectedRevision: tag.revision, input: {} }]);
    await onRefresh();
  };
  const createTag = async () => {
    const next = tagName.trim();
    if (!next) return;
    await submitCommands([{ kind: 'libraryTag.create', input: { name: next } }], crypto.randomUUID());
    setTagName('');
    await onRefresh();
  };
  const body = <>
    {([['all', '全部资料'], ['recent', '最近添加'], ['unfiled', '未整理'], ['archived', '已归档']] as const).map(([view, label]) => <button key={view} type="button" className="library-side-button" aria-current={snapshot.view === view && !snapshot.folderId ? 'page' : undefined} onClick={() => { patchLibrary({ view, folderId: '' }); onClose(); }}>{label}</button>)}
    <hr className="library-rule" />
    <p className="library-meta px-3">文件夹</p>
    {ordered.map(({ folder, depth }) => <div key={folder.id}>
      <div className="library-folder-row" style={{ paddingLeft: depth * 12 }}>
        <button type="button" className="library-side-button" aria-current={snapshot.folderId === folder.id ? 'page' : undefined} onClick={() => { patchLibrary({ view: 'all', folderId: folder.id }); onClose(); }}>{folder.name}</button>
        <button type="button" className="library-btn" aria-label={`更多 ${folder.name}`} aria-expanded={menu === folder.id} onClick={() => setMenu((current) => current === folder.id ? null : folder.id)}>更多</button>
      </div>
      {menu === folder.id && <div className="library-menu" role="menu">
        <button type="button" role="menuitem" onClick={() => { setMenu(null); onEdit({ kind: 'folder-create', parentId: folder.id }); }}>新建子文件夹</button>
        <button type="button" role="menuitem" onClick={() => { setMenu(null); onEdit({ kind: 'folder-rename', folder }); }}>重命名</button>
        <button type="button" role="menuitem" onClick={() => { setMenu(null); onEdit({ kind: 'folder-move', folder }); }}>移动</button>
        <button type="button" role="menuitem" onClick={() => { setMenu(null); void removeFolder(folder).catch((error) => toast.error(error instanceof Error ? error.message : '没有删除文件夹')); }}>删除空文件夹</button>
      </div>}
    </div>)}
    <form className="flex gap-1 px-2 py-2" onSubmit={(event) => { event.preventDefault(); const next = name.trim(); if (!next) return; void submitCommands([{ kind: 'libraryFolder.create', input: { parentId: snapshot.folderId || null, name: next } }], crypto.randomUUID()).then(() => onRefresh()).then(() => setName('')).catch((error) => toast.error(error instanceof Error ? error.message : '没有创建文件夹')); }}>
      <input className="library-search" aria-label="新文件夹名称" value={name} onChange={(event) => setName(event.target.value)} />
      <button type="submit" className="library-btn">新建</button>
    </form>
    <hr className="library-rule" />
    <p className="library-meta px-3">标签</p>
    {tags.map((tag) => <div key={tag.id} className="library-folder-row">
      <button type="button" className="library-tag" aria-pressed={snapshot.tagIds.includes(tag.id)} onClick={() => patchLibrary({ tagIds: snapshot.tagIds.includes(tag.id) ? snapshot.tagIds.filter((item) => item !== tag.id) : [...snapshot.tagIds, tag.id] })}>{tag.name}</button>
      <button type="button" className="library-btn" aria-label={`重命名 ${tag.name}`} onClick={() => onEdit({ kind: 'tag-rename', tag })}>重命名</button>
      <button type="button" className="library-btn" aria-label={`删除 ${tag.name}`} onClick={() => { void removeTag(tag).catch((error) => toast.error(error instanceof Error ? error.message : '没有删除标签')); }}>删除</button>
    </div>)}
    <form className="flex gap-1 px-2 py-2" onSubmit={(event) => { event.preventDefault(); void createTag().catch((error) => toast.error(error instanceof Error ? error.message : '没有创建标签')); }}>
      <input className="library-search" aria-label="新标签名称" value={tagName} onChange={(event) => setTagName(event.target.value)} />
      <button type="submit" className="library-btn">新建标签</button>
    </form>
  </>;
  return <>
    <nav className="library-panel library-folders" data-testid="library-folders" aria-label="资料文件夹">{body}</nav>
    {open && createPortal(<div className="library-dialog library-surface" role="dialog" aria-label="文件夹"><section><button type="button" className="library-btn" onClick={onClose}>关闭</button>{body}</section></div>, document.body)}
  </>;
}

function Composer({ kind, onClose, onRefresh }: { kind: 'text' | 'link'; onClose: () => void; onRefresh: () => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const save = async () => {
    const name = title.trim();
    if (!name) return;
    if (kind === 'link') await submitCommands([{ kind: 'material.create', input: { topicId: null, kind: 'link', title: name, uri: body.trim(), content: '' } }]);
    else await submitCommands([{ kind: 'material.create', input: { topicId: null, kind: 'text', title: name, content: body } }]);
    await onRefresh();
    onClose();
  };
  return <div className="library-dialog library-surface" role="dialog" aria-label={kind === 'link' ? '添加链接' : '添加文本'}>
    <section>
      <h2 className="library-name">{kind === 'link' ? '链接' : '文本'}</h2>
      <input className="library-search mt-3 w-full" aria-label={kind === 'link' ? '链接标题' : '文本标题'} value={title} onChange={(event) => setTitle(event.target.value)} />
      <textarea className="library-search mt-2 h-24 w-full py-2" aria-label={kind === 'link' ? '链接地址' : '文本内容'} value={body} onChange={(event) => setBody(event.target.value)} />
      <div className="mt-3 flex gap-2">
        <button type="button" className="library-btn library-btn-primary" onClick={() => { void save().catch((error) => toast.error(error instanceof Error ? error.message : '没有保存')); }}>保存</button>
        <button type="button" className="library-btn" onClick={onClose}>取消</button>
      </div>
    </section>
  </div>;
}

function NameDialog({ editor, folders, onClose, onSave }: { editor: Editor; folders: LibraryFolder[]; onClose: () => void; onSave: (value: string) => Promise<void> }) {
  const initial = editor.kind === 'folder-rename' ? editor.folder.name : editor.kind === 'tag-rename' ? editor.tag.name : editor.kind === 'material-rename' ? editor.title : '';
  const [value, setValue] = useState(initial);
  const excluded = editor.kind === 'folder-move' ? descendantIds(folders, editor.folder.id) : new Set<string>();
  const label = editor.kind === 'folder-move' ? '移动文件夹' : editor.kind === 'tag-rename' ? '重命名标签' : editor.kind === 'material-rename' ? '重命名资料' : editor.kind === 'folder-rename' ? '重命名文件夹' : '新建子文件夹';
  return <div className="library-dialog library-surface" role="dialog" aria-label={label}>
    <section>
      <h2 className="library-name">{label}</h2>
      {editor.kind === 'folder-move' ? <select className="library-select mt-3 w-full" aria-label="移动到文件夹" value={value} onChange={(event) => setValue(event.target.value)}>
        <option value="">未整理</option>
        {folders.filter((folder) => !excluded.has(folder.id)).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </select> : <input className="library-search mt-3 w-full" aria-label={editor.kind === 'tag-rename' ? '标签名称' : editor.kind === 'material-rename' ? '资料名称' : '文件夹名称'} value={value} onChange={(event) => setValue(event.target.value)} />}
      <div className="mt-3 flex gap-2">
        <button type="button" className="library-btn library-btn-primary" onClick={() => { void onSave(editor.kind === 'folder-move' ? value : value.trim()); }}>保存</button>
        <button type="button" className="library-btn" onClick={onClose}>取消</button>
      </div>
    </section>
  </div>;
}

function BatchDialog({ mode, ids, topics, folders, tags, onClose, applyBatch }: {
  mode: 'move' | 'tags' | 'tasks' | 'ask';
  ids: string[];
  topics: Topic[];
  folders: LibraryFolder[];
  tags: LibraryTag[];
  onClose: () => void;
  applyBatch: (ids: string[], build: (item: MaterialDetail) => Command) => Promise<{ ok: boolean; text: string }>;
}) {
  const snapshot = useLibrarySnapshot();
  const [folderId, setFolderId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<'add' | 'remove' | 'replace'>('add');
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AnswerResult | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const idKey = ids.join(',');
  useEffect(() => {
    if (!idKey || mode === 'ask') return;
    let gone = false;
    void Promise.all(idKey.split(',').filter(Boolean).map((itemId) => api<MaterialDetail>(`/api/v1/library/materials/${itemId}`))).catch(() => { if (!gone) setNotice(''); });
    return () => { gone = true; };
  }, [idKey, mode]);
  const apply = async () => {
    setBusy(true);
    setNotice('');
    const nextTags = (item: MaterialDetail) => {
      const current = item.tags.map((tag) => tag.id);
      if (tagMode === 'replace') return tagIds;
      if (tagMode === 'remove') return current.filter((itemId) => !tagIds.includes(itemId));
      return [...new Set([...current, ...tagIds])];
    };
    const outcome = mode === 'move'
      ? await applyBatch(ids, (item) => ({ kind: 'material.organize', targetId: item.id, expectedRevision: item.revision, input: { expectedOrganizationRevision: item.organizationRevision, folderId: folderId || null } }))
      : mode === 'tags'
        ? await applyBatch(ids, (item) => ({ kind: 'material.organize', targetId: item.id, expectedRevision: item.revision, input: { expectedOrganizationRevision: item.organizationRevision, tagIds: nextTags(item) } }))
        : taskIds.length
          ? await applyBatch(ids, (item) => ({ kind: 'material.links', targetId: item.id, expectedRevision: item.revision, input: { expectedOrganizationRevision: item.organizationRevision, addTaskIds: taskIds, removeTaskIds: [], removeInlineReferences: false, expectedTaskRevisions: {} } }))
          : { ok: false, text: '' };
    setBusy(false);
    if (!outcome.ok) { if (outcome.text) setNotice(outcome.text); return; }
    onClose();
  };
  const ask = async () => {
    const result = await api<AnswerResult>('/api/v1/library/answers', { method: 'POST', body: JSON.stringify({ requestKey: crypto.randomUUID(), question, filters: libraryFilters(snapshot) }) });
    setAnswer(result);
  };
  return <div className="library-dialog library-surface" role="dialog" aria-label={mode === 'ask' ? '问资料' : '批量整理'}>
    <section>
      <div className="flex justify-between"><h2 className="library-name">{mode === 'move' ? '移动' : mode === 'tags' ? '标签' : mode === 'tasks' ? '关联任务' : '问资料'}</h2><button type="button" className="library-btn" onClick={onClose}>关闭</button></div>
      {mode === 'move' && <select className="library-select mt-3 w-full" aria-label="移动到文件夹" value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">未整理</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>}
      {mode === 'tags' && <div className="mt-3 space-y-2">
        <label className="flex items-center gap-2"><input type="radio" name="library-tag-mode" checked={tagMode === 'add'} onChange={() => setTagMode('add')} />添加选中标签</label>
        <label className="flex items-center gap-2"><input type="radio" name="library-tag-mode" checked={tagMode === 'remove'} onChange={() => setTagMode('remove')} />移除选中标签</label>
        <label className="flex items-center gap-2"><input type="radio" name="library-tag-mode" checked={tagMode === 'replace'} onChange={() => setTagMode('replace')} />替换全部标签</label>
        {tags.map((tag) => <label key={tag.id} className="flex items-center gap-2"><input type="checkbox" checked={tagIds.includes(tag.id)} onChange={(event) => setTagIds((current) => event.target.checked ? [...current, tag.id] : current.filter((item) => item !== tag.id))} />{tag.name}</label>)}
      </div>}
      {mode === 'tasks' && <TaskLinkPicker selectedIds={taskIds} onChange={setTaskIds} />}
      {mode === 'ask' && <>
        <textarea className="library-search mt-3 h-24 w-full py-2" aria-label="向资料提问" value={question} onChange={(event) => setQuestion(event.target.value)} />
        <button type="button" className="library-btn library-btn-primary mt-2" onClick={() => { void ask().catch((error) => toast.error(error instanceof ApiError ? error.message : '暂时不能回答')); }}>提问</button>
        {answer?.status === 'model_unavailable' && <p className="library-meta mt-3">需要配置识字模型。普通搜索仍然可用。</p>}
        {answer?.status === 'insufficient' && <p className="library-meta mt-3">资料里没有足够的原文可以回答。</p>}
        {answer?.paragraphs.map((paragraph, index) => <p key={index} className="mt-3 whitespace-pre-wrap text-sm">{paragraph.text} {paragraph.citationIds.join(' ')}</p>)}
        {answer?.citations.map((citation) => <button key={citation.id} type="button" className="library-quote mt-2 block w-full p-2 text-left" aria-label={`${citation.id} · ${citation.titleSnapshot}`} onClick={() => { patchLibrary({ preview: { materialId: citation.materialId, revision: typeof citation.revision === 'number' ? citation.revision : null, chunkId: citation.chunkId || null } }); onClose(); }}><span className="library-meta">{citation.id} · {citation.titleSnapshot}</span><span className="mt-1 block whitespace-pre-wrap text-sm">{citation.quote}</span></button>)}
      </>}
      {notice && <p className="library-meta mt-3">{notice}</p>}
      {mode !== 'ask' && <button type="button" className="library-btn library-btn-primary mt-3" disabled={busy} onClick={() => { void apply(); }}>应用</button>}
      <p className="sr-only">{topics.length}</p>
    </section>
  </div>;
}
