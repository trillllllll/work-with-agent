import { ActionMenu, ActionMenuItem } from '@/components/ui/action-menu.js';
import { Modal } from '@/components/ui/modal.js';
import { TableRow } from '@/components/ui/table-row.js';
import { Surface } from '@/components/ui/surface.js';
import { NativeSelect } from '@/components/ui/native-select.js';
import { Checkbox, Radio } from '@/components/ui/checkbox.js';
import './library.css';
import { askAssistant, usePageContext } from '@/lib/assistant-context.js';
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, type Topic } from '@/lib/api.js';
import { intlLocale, t as translate } from '../../i18n/index.js';
import { submitCommands, type Command } from '@/lib/platform.js';
import { BodyText } from '@/components/shared/BodyText.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Highlighted } from './highlight.js';
import { DocumentWorkspace } from '@/components/documents/DocumentWorkspace.js';
import { LocalDocumentDrafts } from '@/components/documents/LocalDocumentDrafts.js';
import { documentTabs, openDocument, openNewDocument, useOpenDocuments } from '@/components/documents/open.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';
import { associateMarkdownImports } from '@/lib/documents/markdown-import.js';
import { getDocumentRegistry } from '@/lib/documents/runtime.js';
import { TaskLinkPicker } from './TaskLinkPicker.js';
import { clearLibraryFilters, libraryFilters, libraryPageSize, librarySearchParams, patchLibrary, useLibrarySnapshot } from './store.js';
import { extractionLabel, formatUpdated, kindLabel, materialKinds, normalizeRow, type AnswerResult, type LibraryFolder, type LibraryPreviewTarget, type LibraryRow, type LibraryTag, type MaterialDetail, type Page } from './types.js';
import { enqueueUploads, filesFromList, filesFromTransfer, onLibraryChanged } from './upload.js';
import { knowledgeHash } from '@/hooks/useHashRoute.js';

type Editor =
  | { kind: 'folder-create'; parentId: string | null }
  | { kind: 'folder-rename'; folder: LibraryFolder }
  | { kind: 'folder-move'; folder: LibraryFolder }
  | { kind: 'tag-rename'; tag: LibraryTag }
  | { kind: 'material-rename'; id: string; title: string };

export function LibraryPage({ topics, selectedTopicId = '', onOpenTask }: { topics: Topic[]; selectedTopicId?: string; onOpenTask: (taskId: string) => void | Promise<void> }) {
  const { t } = useTranslation('library');
  const snapshot = useLibrarySnapshot();
  const runtime = useEditorRuntime();
  const documentScope = runtime?.scopeKey ?? '';
  const documents = useOpenDocuments(documentScope);
  const documentOpen = Boolean(documents.active || documents.create);
  const client = useQueryClient();
  const surfaceRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const bundleRef = useRef<HTMLInputElement>(null);
  const [importingBundle, setImportingBundle] = useState(false);
  const [composing, setComposing] = useState(false);
  const [debounced, setDebounced] = useState(snapshot.query);
  const [narrow, setNarrow] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [dialog, setDialog] = useState<'move' | 'tags' | 'tasks' | 'ask' | null>(null);
  const [composer, setComposer] = useState<'link' | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [pageNotice, setPageNotice] = useState('');
  const params = librarySearchParams(snapshot);
  const searching = debounced.trim().length > 0;
  usePageContext('library-list', { pageState: { query: debounced, folderId: snapshot.folderId, tagIds: snapshot.tagIds, kind: snapshot.kind, libraryView: snapshot.view, taskTopicId: snapshot.taskTopicId, linkedTaskId: snapshot.taskId } });
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
    const records = await enqueueUploads(files, target);
    if (documentScope && files.some(({ file }) => /\.md(?:own|arkdown)?$/i.test(file.name))) {
      try {
        const result = await associateMarkdownImports(records, documentScope);
        if (result.missing) toast.message(t('document.missingAssets', { count: result.missing }));
      } catch (error) { toast.error(error instanceof Error ? error.message : t('shared.actionFailed')); }
    }
    await refresh();
  };
  const importBundle = async (file: File) => {
    if (!documentScope || importingBundle) return;
    setImportingBundle(true);
    try { const { importResourceBundle } = await import('@/lib/documents/bundle.js'); const imported = await importResourceBundle(file, documentScope, { folderId: snapshot.folderId || null }); await refresh(); openDocument({ resourceId: imported.resourceId }); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('shared.actionFailed')); }
    finally { setImportingBundle(false); }
  };
  const onDrop = async (event: DragEvent) => {
    if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('[data-testid="document-workspace"]'))) return;
    event.preventDefault();
    setDragging(false);
    await takeFiles(await filesFromTransfer(event.dataTransfer));
  };
  const closePreview = async () => {
    const registry = documentScope ? getDocumentRegistry(documentScope) : null;
    const sessions = new Set(documents.tabs.filter((tab) => tab.key === documents.active || tab.key === documents.secondary).flatMap((tab) => { const session = registry?.get(tab.resourceId); return session ? [session] : []; }));
    try {
      if ((await Promise.all([...sessions].map((session) => session.flushLocal()))).some((saved) => !saved)) { toast.error(t('document.storageFailed')); return; }
    } catch (error) { toast.error(error instanceof Error ? error.message : t('document.storageFailed')); return; }
    documentTabs.showList(documentScope);
    const selected = snapshot.preview?.materialId ?? '';
    patchLibrary({ preview: null });
    if (!selected) return;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="library-row-${CSS.escape(selected)}"]`)?.focus());
  };
  const applyBatch = async (ids: string[], build: (item: MaterialDetail) => Command) => {
    const locked = ids.slice();
    if (!locked.length) return { ok: false, text: t('libraryPage.batchResult', { done: 0, remaining: 0 }) };
    let done = 0;
    try {
      const latest = await Promise.all(locked.map((itemId) => api<MaterialDetail>(`/api/v1/library/materials/${itemId}`)));
      const commands = latest.map(build);
      for (let index = 0; index < commands.length; index += 50) {
        const slice = commands.slice(index, index + 50);
        try {
          const result = await submitCommands(slice);
          if (result.status !== 'applied') throw new Error('incomplete');
          done += slice.length;
        } catch {
          patchLibrary({ selectedIds: locked.slice(done) });
          return { ok: false, text: t('libraryPage.batchResult', { done, remaining: locked.length - done }) };
        }
      }
    } catch {
      patchLibrary({ selectedIds: locked.slice(done) });
      return { ok: false, text: t('libraryPage.batchResult', { done, remaining: locked.length - done }) };
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
      if (!documentOpen) return;
      event.preventDefault();
      void closePreview();
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
    openDocument({ resourceId: preview.materialId, revision: preview.revision, chunkId: preview.chunkId, title: row.title });
  };
  useEffect(() => {
    if (!documentScope || !snapshot.preview) return;
    const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    if (params.has('resource') || params.has('create')) return;
    documentTabs.open(documentScope, { resourceId: snapshot.preview.materialId, revision: snapshot.preview.revision, chunkId: snapshot.preview.chunkId });
  }, [documentScope, snapshot.preview?.materialId, snapshot.preview?.revision, snapshot.preview?.chunkId]);
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
    } catch (error) { toast.error(error instanceof ApiError ? error.message : t('shared.actionFailed')); }
  };

  const pageNumber = Math.floor(snapshot.cursor / libraryPageSize) + 1;
  const cancelled = list.error instanceof DOMException && list.error.name === 'AbortError';
  const showError = list.isError && !cancelled;
  return <section ref={surfaceRef} className="library-surface library-page" data-testid="library-surface" data-narrow={narrow ? 'true' : 'false'} data-document-open={documentOpen ? 'true' : 'false'} onDragOver={(event) => { if ([...event.dataTransfer.items].some((item) => item.kind === 'file')) { event.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={(event) => { void onDrop(event); }} onPaste={(event) => {
    const node = event.target;
    if (node instanceof HTMLElement && node.closest('input, textarea, [contenteditable="true"]')) return;
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    event.preventDefault();
    void takeFiles(files.map((file) => ({ file, relativePath: file.name })));
  }}>
    <div className={`library-frame ${dragging ? 'library-drop' : ''}`}>
      <header className="library-titlebar">
        <h1 className="library-title">{t('shared.library')}</h1>
        <div className="library-title-links">
          <LocalDocumentDrafts scopeKey={documentScope} />
          {documents.tabs.length > 0 && !documentOpen && <Button size="sm" variant="outline" onClick={() => documentTabs.activate(documentScope, documents.tabs[documents.tabs.length - 1].key)}>{t('document.opened')} ({documents.tabs.length})</Button>}
          <Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => { window.location.hash = knowledgeHash('memories', selectedTopicId); }}>{t('libraryPage.memory')}</Button>
          <Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => { window.location.hash = knowledgeHash('brief', selectedTopicId); }}>{t('libraryPage.currentProgress')}</Button>
        </div>
      </header>
      <div className="library-toolbar">
        <div className="library-toolbar-group library-toolbar-search">
          <Input className="library-search" aria-label={t('shared.searchMaterials')} placeholder={t('shared.searchPlaceholder')} value={snapshot.query} onChange={(event) => patchLibrary({ query: event.target.value })} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); patchLibrary({ query: event.currentTarget.value }); }} />
        </div>
        <div className="library-toolbar-group library-toolbar-filters">
          <NativeSelect className="library-select" aria-label={t('shared.typeFilter')} value={snapshot.kind} onChange={(event) => patchLibrary({ kind: event.target.value as typeof snapshot.kind })}>
            <option value="">{t('shared.allTypes')}</option>
            {materialKinds.map((value) => <option key={value} value={value}>{kindLabel(value)}</option>)}
          </NativeSelect>
          <NativeSelect className="library-select" aria-label={t('libraryPage.linkedTaskFilter')} value={snapshot.taskTopicId} onChange={(event) => patchLibrary({ taskTopicId: event.target.value })}>
            <option value="">{t('libraryPage.allLists')}</option>
            <option value="inbox">{t('shared.inbox')}</option>
            {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
          </NativeSelect>
          <Button variant="outline" size="bare" type="button" className="library-btn library-folder-button" onClick={() => setFoldersOpen(true)}>{t('shared.folders')}</Button>
        </div>
        <div className="library-toolbar-group library-toolbar-actions">
          <Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => setDialog('ask')}>{t('libraryPage.askMaterials')}</Button>
          <Button variant="default" size="bare" type="button" className="library-btn library-btn-primary" onClick={() => openNewDocument('richdoc-v1', { folderId: snapshot.folderId || null })}>{t('document.new')}</Button>
          <ActionMenu open={addOpen} onOpenChange={setAddOpen} trigger={<Button variant="default" size="bare" type="button" className="library-btn library-btn-primary">{t('libraryPage.add')}</Button>}>
              <ActionMenuItem disabled={importingBundle || !documentScope} onSelect={() => { setAddOpen(false); bundleRef.current?.click(); }}>{t('document.bundleImport')}</ActionMenuItem>
              <ActionMenuItem onSelect={() => { setAddOpen(false); fileRef.current?.click(); }}>{t('libraryPage.addFile')}</ActionMenuItem>
              <ActionMenuItem onSelect={() => { setAddOpen(false); directoryRef.current?.click(); }}>{t('libraryPage.importFolder')}</ActionMenuItem>
              <ActionMenuItem onSelect={() => { setAddOpen(false); openNewDocument('markdown', { folderId: snapshot.folderId || null }); }}>{t('document.newMarkdown')}</ActionMenuItem>
              <ActionMenuItem onSelect={() => { setAddOpen(false); openNewDocument('text', { folderId: snapshot.folderId || null }); }}>{t('document.newText')}</ActionMenuItem>
              <ActionMenuItem onSelect={() => { setAddOpen(false); setComposer('link'); }}>{t('kind.link')}</ActionMenuItem>
          </ActionMenu>
          <Input variant="inline" ref={bundleRef} className="sr-only" type="file" accept=".zip" aria-label={t('document.bundleImport')} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importBundle(file); }} />
          <Input variant="inline" ref={fileRef} className="sr-only" type="file" multiple aria-label={t('libraryPage.chooseFiles')} onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void filesFromList(files).then(takeFiles); }} />
          <Input variant="inline" ref={(node) => { directoryRef.current = node; node?.setAttribute('webkitdirectory', ''); }} className="sr-only" type="file" multiple aria-label={t('libraryPage.chooseFolder')} onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void filesFromList(files).then(takeFiles); }} />
        </div>
      </div>
      {snapshot.selectedIds.length > 0 && <div className="library-toolbar" aria-label={t('libraryPage.bulkActions')}>
        <Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => setDialog('move')}>{t('shared.move')}</Button>
        <Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => setDialog('tags')}>{t('shared.tags')}</Button>
        <Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => setDialog('tasks')}>{t('libraryPage.linkTasks')}</Button>
        <Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => { void applyBatch(snapshot.selectedIds, (item) => ({ kind: 'material.archive', targetId: item.id, expectedRevision: item.revision, input: { archived: true } })).then((outcome) => { if (!outcome.ok) setPageNotice(outcome.text); }); }}>{t('shared.archive')}</Button>
        <Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => patchLibrary({ selectedIds: [] })}>{t('libraryPage.clearSelection')}</Button>
      </div>}
      {pageNotice && <p className="library-meta" role="alert">{pageNotice}</p>}
      <div className={`library-body ${documentOpen ? 'has-document' : 'no-preview'}`}>
        <FolderNav folders={folders.data?.items ?? []} tags={tags.data?.items ?? []} open={foldersOpen} onClose={() => setFoldersOpen(false)} onEdit={setEditor} onRefresh={refresh} />
        <Surface as="div" tone="card" ref={listRef} className="library-panel library-document-list" hidden={documentOpen} data-testid="library-list" onScroll={(event) => patchLibrary({ scrollTop: event.currentTarget.scrollTop })}>
          {showError && <div className="library-error" role="alert"><p>{list.error instanceof Error ? list.error.message : t('shared.materialsLoadFailed')}</p><Button variant="outline" size="bare" type="button" className="library-btn" onClick={() => { void list.refetch(); }}>{t('shared.retry')}</Button></div>}
          {!showError && list.isLoading && !list.data && <p className="library-meta p-3">{t('shared.loadingMaterials')}</p>}
          {!showError && !rows.length && !list.isLoading && <div className="p-6"><p>{t('shared.noMatchingMaterials')}</p><Button variant="outline" size="bare" type="button" className="library-btn mt-3" onClick={() => { clearLibraryFilters(); setDebounced(''); }}>{t('libraryPage.clearFilters')}</Button></div>}
          {!showError && rows.length > 0 && <table className="library-table">
            <thead><TableRow><th /><th>{t('libraryPage.columnName')}</th><th className="library-col-optional">{t('libraryPage.columnType')}</th><th>{t('libraryPage.linkedTasksColumn')}</th><th className="library-col-optional">{t('libraryPage.columnUpdated')}</th><th>{t('shared.more')}</th></TableRow></thead>
            <tbody>
              {rows.map((row) => {
                const hit = row.hits[0];
                return <TableRow key={row.id} data-testid={`library-row-${row.id}`} aria-selected={snapshot.preview?.materialId === row.id} tabIndex={0} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openPreview(row); } }} className={`library-row library-color ${hit ? 'has-snippet' : ''}`} onClick={() => openPreview(row)}>
                  <td><label className="library-check-hit" onClick={(event) => event.stopPropagation()}><Checkbox className="library-check"  aria-label={t('shared.selectNamed', { name: row.title })} checked={snapshot.selectedIds.includes(row.id)} onClick={(event) => event.stopPropagation()} onChange={(event) => { const selected = snapshot.selectedIds; patchLibrary({ selectedIds: event.target.checked ? [...selected, row.id] : selected.filter((item) => item !== row.id) }); }} /></label></td>
                  <td><div className="library-name truncate">{row.title}</div><div className="library-meta truncate">{hit ? <Highlighted text={hit.snippet} start={hit.highlightStart} end={hit.highlightEnd} /> : t('libraryPage.rowMeta', { folder: folderName(folders.data?.items ?? [], row.folderId), tags: row.tags.map((tag) => tag.name).join(' '), status: extractionLabel(row.extraction.status) })}</div></td>
                  <td className="library-col-optional library-meta">{kindLabel(row.kind)}</td>
                  <td className="library-meta">{row.linkedTaskCount}</td>
                  <td className="library-col-optional library-meta">{formatUpdated(row.updatedAt)}</td>
                  <td><ActionMenu open={rowMenu === row.id} onOpenChange={open => setRowMenu(open ? row.id : null)} trigger={<Button variant="outline" size="bare" type="button" className="library-btn" aria-label={t('shared.moreNamed', { name: row.title })} onClick={event => event.stopPropagation()}>{t('shared.more')}</Button>}><ActionMenuItem onSelect={() => { setRowMenu(null); setEditor({ kind: 'material-rename', id: row.id, title: row.title }); }}>{t('shared.rename')}</ActionMenuItem></ActionMenu>
                  </td>
                </TableRow>;
              })}
            </tbody>
          </table>}
          {!showError && list.data && <footer className="library-pagination" data-testid="library-pagination">
            <span>{t('libraryPage.materialTotal', { count: list.data.total })}</span>
            <Button variant="outline" size="bare" type="button" className="library-btn" disabled={snapshot.cursor <= 0 || list.isPlaceholderData} onClick={() => patchLibrary({ cursor: Math.max(0, snapshot.cursor - libraryPageSize) })}>{t('shared.previousPage')}</Button>
            <span>{t('shared.pageNumber', { page: pageNumber })}</span>
            <Button variant="outline" size="bare" type="button" className="library-btn" disabled={list.data.nextCursor == null || list.isPlaceholderData} onClick={() => { if (list.data?.nextCursor != null) patchLibrary({ cursor: list.data.nextCursor }); }}>{t('shared.nextPage')}</Button>
          </footer>}
        </Surface>
        <div className="document-workspace-host" hidden={!documentOpen}>{documentScope ? <DocumentWorkspace scopeKey={documentScope} onOpenTask={onOpenTask} /> : <p role="status">{t('document.noRuntime')}</p>}</div>
      </div>
    </div>
    {dialog && <BatchDialog mode={dialog} ids={snapshot.selectedIds} topics={topics} folders={folders.data?.items ?? []} tags={tags.data?.items ?? []} onClose={() => setDialog(null)} applyBatch={applyBatch} />}
    {composer && <LinkComposer container={surfaceRef.current} onClose={() => setComposer(null)} onRefresh={refresh} />}
    {editor && <NameDialog editor={editor} folders={folders.data?.items ?? []} onClose={() => setEditor(null)} onSave={saveEditor} />}
  </section>;
}

function folderName(folders: LibraryFolder[], id: string | null) {
  if (!id) return translate('library:shared.unfiled');
  return folders.find((folder) => folder.id === id)?.name ?? translate('library:shared.unfiled');
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
  for (const list of children.values()) list.sort((left, right) => norm(left.name).localeCompare(norm(right.name), intlLocale()) || left.id.localeCompare(right.id));
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
  const { t } = useTranslation('library');
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
    {([['all', 'libraryPage.viewAll'], ['recent', 'libraryPage.viewRecent'], ['unfiled', 'shared.unfiled'], ['archived', 'libraryPage.viewArchived']] as const).map(([view, key]) => <Button variant="row" size="bare" key={view} type="button" className="library-side-button" aria-current={snapshot.view === view && !snapshot.folderId ? 'page' : undefined} onClick={() => { patchLibrary({ view, folderId: '' }); onClose(); }}>{t(key)}</Button>)}
    <hr className="library-rule" />
    <p className="library-meta px-3">{t('shared.folders')}</p>
    {ordered.map(({ folder, depth }) => <div key={folder.id}>
      <div className="library-folder-row" style={{ paddingLeft: depth * 12 }}>
        <Button variant="row" size="bare" type="button" className="library-side-button" aria-current={snapshot.folderId === folder.id ? 'page' : undefined} onClick={() => { patchLibrary({ view: 'all', folderId: folder.id }); onClose(); }}>{folder.name}</Button>
        <ActionMenu open={menu === folder.id} onOpenChange={open => setMenu(open ? folder.id : null)} trigger={<Button variant="outline" size="bare" type="button" className="library-btn" aria-label={t('shared.moreNamed', { name: folder.name })}>{t('shared.more')}</Button>}>
        <ActionMenuItem onSelect={() => { setMenu(null); onEdit({ kind: 'folder-create', parentId: folder.id }); }}>{t('libraryPage.newSubfolder')}</ActionMenuItem>
        <ActionMenuItem onSelect={() => { setMenu(null); onEdit({ kind: 'folder-rename', folder }); }}>{t('shared.rename')}</ActionMenuItem>
        <ActionMenuItem onSelect={() => { setMenu(null); onEdit({ kind: 'folder-move', folder }); }}>{t('shared.move')}</ActionMenuItem>
        <ActionMenuItem onSelect={() => { setMenu(null); void removeFolder(folder).catch((error) => toast.error(error instanceof Error ? error.message : t('libraryPage.deleteFolderFailed'))); }}>{t('libraryPage.deleteEmptyFolder')}</ActionMenuItem>
        </ActionMenu>
      </div>
    </div>)}
    <form className="flex gap-1 px-2 py-2" onSubmit={(event) => { event.preventDefault(); const next = name.trim(); if (!next) return; void submitCommands([{ kind: 'libraryFolder.create', input: { parentId: snapshot.folderId || null, name: next } }], crypto.randomUUID()).then(() => onRefresh()).then(() => setName('')).catch((error) => toast.error(error instanceof Error ? error.message : t('libraryPage.createFolderFailed'))); }}>
      <Input className="library-search" aria-label={t('libraryPage.newFolderName')} value={name} onChange={(event) => setName(event.target.value)} />
      <Button variant="outline" size="bare" type="submit" className="library-btn">{t('libraryPage.create')}</Button>
    </form>
    <hr className="library-rule" />
    <p className="library-meta px-3">{t('shared.tags')}</p>
    {tags.map((tag) => <div key={tag.id} className="library-folder-row">
      <Button variant="row" size="bare" type="button" className="library-tag" aria-pressed={snapshot.tagIds.includes(tag.id)} onClick={() => patchLibrary({ tagIds: snapshot.tagIds.includes(tag.id) ? snapshot.tagIds.filter((item) => item !== tag.id) : [...snapshot.tagIds, tag.id] })}>{tag.name}</Button>
      <Button variant="outline" size="bare" type="button" className="library-btn" aria-label={t('libraryPage.renameNamed', { name: tag.name })} onClick={() => onEdit({ kind: 'tag-rename', tag })}>{t('shared.rename')}</Button>
      <Button variant="outline" size="bare" type="button" className="library-btn" aria-label={t('libraryPage.deleteNamed', { name: tag.name })} onClick={() => { void removeTag(tag).catch((error) => toast.error(error instanceof Error ? error.message : t('libraryPage.deleteTagFailed'))); }}>{t('shared.delete')}</Button>
    </div>)}
    <form className="flex gap-1 px-2 py-2" onSubmit={(event) => { event.preventDefault(); void createTag().catch((error) => toast.error(error instanceof Error ? error.message : t('libraryPage.createTagFailed'))); }}>
      <Input className="library-search" aria-label={t('libraryPage.newTagName')} value={tagName} onChange={(event) => setTagName(event.target.value)} />
      <Button variant="outline" size="bare" type="submit" className="library-btn">{t('libraryPage.newTag')}</Button>
    </form>
  </>;
  return <>
    <Surface as="nav" tone="card" className="library-panel library-folders" data-testid="library-folders" aria-label={t('libraryPage.foldersNav')}>{!open && body}</Surface>
    {open && <Modal workspace className="library-surface" title={t('shared.folders')} onClose={onClose}><section><Button variant="outline" size="bare" type="button" className="library-btn" onClick={onClose}>{t('shared.close')}</Button>{body}</section></Modal>}
  </>;
}

function LinkComposer({ container, onClose, onRefresh }: { container: HTMLElement | null; onClose: () => void; onRefresh: () => Promise<void> }) {
  const { t } = useTranslation('library');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const save = async () => {
    if (!title.trim() || !url.trim() || saving) return;
    setSaving(true);
    try { await submitCommands([{ kind: 'material.create', input: { topicId: null, kind: 'link', title: title.trim(), uri: url.trim(), content: '' } }], requestId.current); await onRefresh(); onClose(); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('libraryPage.saveFailed')); }
    finally { setSaving(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}><DialogContent container={container} aria-describedby={undefined} className="max-w-lg"><DialogHeader><DialogTitle>{t('libraryPage.addLink')}</DialogTitle></DialogHeader><form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}><Input autoFocus required aria-label={t('libraryPage.linkTitle')} placeholder={t('libraryPage.linkTitle')} value={title} onChange={(event) => { setTitle(event.target.value); requestId.current = crypto.randomUUID(); }} /><Input type="url" required aria-label={t('libraryPage.linkUrl')} placeholder={t('libraryPage.linkUrl')} value={url} onChange={(event) => { setUrl(event.target.value); requestId.current = crypto.randomUUID(); }} /><DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t('shared.cancel')}</Button><Button type="submit" disabled={saving || !title.trim() || !url.trim()}>{t('shared.save')}</Button></DialogFooter></form></DialogContent></Dialog>;
}

function NameDialog({ editor, folders, onClose, onSave }: { editor: Editor; folders: LibraryFolder[]; onClose: () => void; onSave: (value: string) => Promise<void> }) {
  const { t } = useTranslation('library');
  const initial = editor.kind === 'folder-rename' ? editor.folder.name : editor.kind === 'tag-rename' ? editor.tag.name : editor.kind === 'material-rename' ? editor.title : '';
  const [value, setValue] = useState(initial);
  const excluded = editor.kind === 'folder-move' ? descendantIds(folders, editor.folder.id) : new Set<string>();
  const label = editor.kind === 'folder-move' ? t('libraryPage.moveFolder') : editor.kind === 'tag-rename' ? t('libraryPage.renameTag') : editor.kind === 'material-rename' ? t('libraryPage.renameMaterial') : editor.kind === 'folder-rename' ? t('libraryPage.renameFolder') : t('libraryPage.newSubfolder');
  return <Modal workspace className="library-surface" title={label} onClose={onClose}>
    <section>
      <h2 className="library-name">{label}</h2>
      {editor.kind === 'folder-move' ? <NativeSelect className="library-select mt-3 w-full" aria-label={t('libraryPage.moveToFolder')} value={value} onChange={(event) => setValue(event.target.value)}>
        <option value="">{t('shared.unfiled')}</option>
        {folders.filter((folder) => !excluded.has(folder.id)).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </NativeSelect> : <Input className="library-search mt-3 w-full" aria-label={editor.kind === 'tag-rename' ? t('libraryPage.tagName') : editor.kind === 'material-rename' ? t('libraryPage.materialName') : t('libraryPage.folderName')} value={value} onChange={(event) => setValue(event.target.value)} />}
      <div className="mt-3 flex gap-2">
        <Button variant="default" size="bare" type="button" className="library-btn library-btn-primary" onClick={() => { void onSave(editor.kind === 'folder-move' ? value : value.trim()); }}>{t('shared.save')}</Button>
        <Button variant="outline" size="bare" type="button" className="library-btn" onClick={onClose}>{t('shared.cancel')}</Button>
      </div>
    </section>
  </Modal>;
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
  const { t } = useTranslation('library');
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
  return <Modal workspace className="library-surface" title={mode === 'ask' ? t('libraryPage.askMaterials') : t('libraryPage.bulkOrganize')} onClose={onClose}>
    <section>
      <div className="flex justify-between"><h2 className="library-name">{mode === 'move' ? t('shared.move') : mode === 'tags' ? t('shared.tags') : mode === 'tasks' ? t('libraryPage.linkTasks') : t('libraryPage.askMaterials')}</h2><Button variant="outline" size="bare" type="button" className="library-btn" onClick={onClose}>{t('shared.close')}</Button></div>
      {mode === 'move' && <NativeSelect className="library-select mt-3 w-full" aria-label={t('libraryPage.moveToFolder')} value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">{t('shared.unfiled')}</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</NativeSelect>}
      {mode === 'tags' && <div className="mt-3 space-y-2">
        <label className="flex items-center gap-2"><Radio  name="library-tag-mode" checked={tagMode === 'add'} onChange={() => setTagMode('add')} />{t('libraryPage.addSelectedTags')}</label>
        <label className="flex items-center gap-2"><Radio  name="library-tag-mode" checked={tagMode === 'remove'} onChange={() => setTagMode('remove')} />{t('libraryPage.removeSelectedTags')}</label>
        <label className="flex items-center gap-2"><Radio  name="library-tag-mode" checked={tagMode === 'replace'} onChange={() => setTagMode('replace')} />{t('libraryPage.replaceAllTags')}</label>
        {tags.map((tag) => <label key={tag.id} className="flex items-center gap-2"><Checkbox  checked={tagIds.includes(tag.id)} onChange={(event) => setTagIds((current) => event.target.checked ? [...current, tag.id] : current.filter((item) => item !== tag.id))} />{tag.name}</label>)}
      </div>}
      {mode === 'tasks' && <TaskLinkPicker selectedIds={taskIds} onChange={setTaskIds} />}
      {mode === 'ask' && <>
        <Textarea className="library-search mt-3 h-24 w-full py-2" aria-label={t('libraryPage.askField')} value={question} onChange={(event) => setQuestion(event.target.value)} />
        <Button variant="default" size="bare" type="button" className="library-btn library-btn-primary mt-2" onClick={() => { void ask().catch((error) => toast.error(error instanceof ApiError ? error.message : t('libraryPage.askFailed'))); }}>{t('libraryPage.ask')}</Button>
        {answer?.status === 'model_unavailable' && <p className="library-meta mt-3">{t('libraryPage.modelRequired')}</p>}
        {answer?.status === 'insufficient' && <p className="library-meta mt-3">{t('libraryPage.insufficient')}</p>}
        {answer?.paragraphs.map((paragraph, index) => <BodyText key={index} text={`${paragraph.text} ${paragraph.citationIds.join(' ')}`} className="mt-3" />)}
        {answer?.citations.map((citation) => <Button variant="card" size="bare" key={citation.id} type="button" className="library-quote mt-2 block w-full p-2 text-left" aria-label={`${citation.id} · ${citation.titleSnapshot}`} onClick={() => { patchLibrary({ preview: { materialId: citation.materialId, revision: typeof citation.revision === 'number' ? citation.revision : null, chunkId: citation.chunkId || null } }); onClose(); }}><span className="library-meta">{citation.id} · {citation.titleSnapshot}</span><span className="mt-1 block whitespace-pre-wrap text-sm">{citation.quote}</span></Button>)}
      </>}
      {notice && <p className="library-meta mt-3">{notice}</p>}
      {mode !== 'ask' && <Button variant="default" size="bare" type="button" className="library-btn library-btn-primary mt-3" disabled={busy} onClick={() => { void apply(); }}>{t('libraryPage.apply')}</Button>}
      <p className="sr-only">{topics.length}</p>
    </section>
  </Modal>;
}
