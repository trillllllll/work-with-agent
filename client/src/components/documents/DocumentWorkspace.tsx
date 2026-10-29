import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.js';
import { ActionMenu, ActionMenuItem } from '@/components/ui/action-menu.js';
import { Input } from '@/components/ui/input.js';
import { NativeSelect } from '@/components/ui/native-select.js';
import { Surface } from '@/components/ui/surface.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.js';
import { Textarea } from '@/components/ui/textarea.js';
import { usePageContext } from '@/lib/assistant-context.js';
import { getDocumentRegistry } from '@/lib/documents/runtime.js';
import { loadResource } from '@/lib/documents/api.js';
import { restoreResourceVersion } from '@/lib/documents/restore.js';
import { uploadIds, type DocumentSession } from '@/lib/documents/session.js';
import type { DocumentDraft, DocumentSnapshot, DraftContent, ResourceDocument } from '@/lib/documents/types.js';
import { contentText, emptyRichDocument } from '../../../../server/src/domain/document-content.js';
import { documentTabs, openDocument, useOpenDocuments, type OpenDocumentTab } from './open.js';
import { DocumentSupplement } from './DocumentSupplement.js';
import { TextDocumentEditor, type TextViewMode } from './TextDocumentEditor.js';
import { SaveDocumentAs } from './SaveDocumentAs.js';
import { withinTextEditBudget } from './text-budget.js';
import { RichDocumentEditor } from './RichDocumentEditor.js';
import { measureRichDocument } from './RichDocumentBoundary.js';
import { ResourceReader, resourceOriginalUrl, saveDocumentBlob } from './ResourceReader.js';
import { DocumentInfo } from './DocumentInfo.js';
import { DocumentExtractedText } from './DocumentExtractedText.js';
import { DocumentChanges } from './DocumentChanges.js';
import { ResourceReferencePicker, insertResourceReference } from './ResourceReferencePicker.js';
import './documents.css';

const idleSubscribe = () => () => {};
const emptySnapshot = () => null;
const creations = new Map<string, Promise<DocumentSession>>();
const positions = new Map<string, { scrollTop: number; mode: TextViewMode }>();

export function DocumentWorkspace({ scopeKey, onOpenTask }: { scopeKey: string; onOpenTask: (id: string) => void | Promise<void> }) {
  const { t } = useTranslation('library');
  const state = useOpenDocuments(scopeKey);
  const [ratio, setRatio] = useState(50);
  const [creatingError, setCreatingError] = useState('');
  const registry = useMemo(() => scopeKey ? getDocumentRegistry(scopeKey) : null, [scopeKey]);
  useEffect(() => {
    if (!state.create || !registry) return;
    const target = state.create;
    const key = `${scopeKey}:${target.requestId}`;
    let promise = creations.get(key);
    if (!promise) {
      promise = registry.create({ title: t('document.untitled'), format: target.format, content: target.format === 'richdoc-v1' ? emptyRichDocument(crypto.randomUUID()) : '', topicId: target.topicId, folderId: target.folderId });
      creations.set(key, promise);
    }
    let alive = true;
    promise.then((session) => { if (alive) { const value = session.getSnapshot(); documentTabs.created(scopeKey, { resourceId: value.localId, title: value.title }); } }).catch((error) => { if (alive) setCreatingError(error instanceof Error ? error.message : t('shared.actionFailed')); });
    return () => { alive = false; };
  }, [state.create?.requestId, registry, scopeKey, t]);
  const active = state.tabs.find((tab) => tab.key === state.active);
  const secondary = state.tabs.find((tab) => tab.key === state.secondary);
  const leaveCurrent = async (action: () => void) => {
    const sessions = new Set([active, secondary].flatMap((tab) => { const session = tab && registry?.get(tab.resourceId); return session ? [session] : []; }));
    try {
      if ((await Promise.all([...sessions].map((session) => session.flushLocal()))).some((saved) => !saved)) { toast.error(t('document.storageFailed')); return; }
      action();
    } catch (error) { toast.error(error instanceof Error ? error.message : t('document.storageFailed')); }
  };
  const activateByKey = (event: React.KeyboardEvent, key: string) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = state.tabs.findIndex((tab) => tab.key === key);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? state.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + state.tabs.length) % state.tabs.length;
    const next = state.tabs[nextIndex];
    if (!next) return;
    void leaveCurrent(() => { documentTabs.activate(scopeKey, next.key); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-document-tab="${CSS.escape(next.key)}"]`)?.focus()); });
  };
  return <section className="document-workspace" data-testid="document-workspace" aria-label={t('document.workspace')}>
    <div className="document-workspace-bar">
      <Button size="sm" variant="ghost" onClick={() => { void leaveCurrent(() => documentTabs.showList(scopeKey)); }}>{t('document.back')}</Button>
      <div className="document-open-tabs" role="tablist" aria-label={t('document.opened')}>
        {state.tabs.map((tab) => <div className="document-tab-wrap" key={tab.key}>
          <Button size="sm" variant="tab" role="tab" tabIndex={state.active === tab.key ? 0 : -1} aria-selected={state.active === tab.key} data-document-tab={tab.key} onKeyDown={(event) => activateByKey(event, tab.key)} onClick={() => { void leaveCurrent(() => documentTabs.activate(scopeKey, tab.key)); }} title={tab.title || t('document.untitled')}><span className="truncate">{tab.title || t('document.untitled')}</span>{tab.revision != null && <span className="library-meta">v{tab.revision}</span>}</Button>
          <Button size="icon-xs" variant="ghost" aria-label={t('document.closeTab', { title: tab.title || t('document.untitled') })} onClick={() => { void leaveCurrent(() => documentTabs.close(scopeKey, tab.key)); }}>×</Button>
        </div>)}
      </div>
      <NativeSelect className="document-mobile-tabs" aria-label={t('document.opened')} value={state.active ?? ''} onChange={(event) => { const key = event.target.value; void leaveCurrent(() => documentTabs.activate(scopeKey, key)); }}><option value="" disabled>{t('document.opened')}</option>{state.tabs.map((tab) => <option key={tab.key} value={tab.key}>{tab.title || t('document.untitled')}{tab.revision != null ? ` · v${tab.revision}` : ''}</option>)}</NativeSelect>
      <NativeSelect className="document-compare" aria-label={t('document.compare')} value={state.secondary ?? ''} onChange={(event) => { const key = event.target.value || null; void leaveCurrent(() => documentTabs.split(scopeKey, key)); }}><option value="">{secondary ? t('document.endCompare') : t('document.compare')}</option>{state.tabs.map((tab) => <option value={tab.key} key={tab.key}>{tab.title || t('document.untitled')}{tab.revision != null ? ` · v${tab.revision}` : ''}</option>)}</NativeSelect>
    </div>
    {creatingError && <p role="alert" className="document-notice">{creatingError}</p>}
    {state.create && !active && <p role="status" className="document-notice">{t('document.loading')}</p>}
    {active && <div className={`document-panes ${secondary ? 'document-panes-split' : ''}`} style={{ '--document-ratio': `${ratio}%` } as CSSProperties}>
      <DocumentPane key={`primary:${active.key}`} scopeKey={scopeKey} target={active} viewId="primary" onOpenTask={onOpenTask} />
      {secondary && <><div className="document-divider"><Input type="range" min={25} max={75} value={ratio} aria-label={t('document.splitRatio')} onChange={(event) => setRatio(Number(event.target.value))} /></div><DocumentPane key={`secondary:${secondary.key}`} scopeKey={scopeKey} target={secondary} viewId="secondary" onOpenTask={onOpenTask} /></>}
    </div>}
  </section>;
}

function DocumentPane({ scopeKey, target, viewId, onOpenTask }: { scopeKey: string; target: OpenDocumentTab; viewId: string; onOpenTask: (id: string) => void | Promise<void> }) {
  const { t } = useTranslation('library');
  const registry = useMemo(() => getDocumentRegistry(scopeKey), [scopeKey]);
  const existing = target.revision == null ? registry.get(target.resourceId) : undefined;
  const [session, setSession] = useState<DocumentSession | null>(existing ?? null);
  const [restoreError, setRestoreError] = useState('');
  const local = target.resourceId.startsWith('local-');
  useEffect(() => {
    if (!local || session) return;
    let alive = true;
    void registry.listDrafts().then(async (drafts) => {
      const draft = drafts.filter((entry) => entry.localId === target.resourceId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!draft) throw new Error(t('document.loadFailed'));
      const restored = await registry.restoreLocalDraft(draft.localId, draft.sessionId);
      if (alive) setSession(restored);
    }).catch((error) => { if (alive) setRestoreError(error instanceof Error ? error.message : t('document.loadFailed')); });
    return () => { alive = false; };
  }, [local, registry, target.resourceId, session, t]);
  const live = session ?? existing;
  const liveSnapshot = useSyncExternalStore(live?.subscribe ?? idleSubscribe, live?.getSnapshot ?? emptySnapshot, live?.getSnapshot ?? emptySnapshot);
  const query = useQuery({ queryKey: ['library', 'resource', scopeKey, liveSnapshot?.resourceId ?? target.resourceId, target.revision ?? 'latest'], queryFn: () => loadResource(liveSnapshot?.resourceId ?? target.resourceId, target.revision ?? undefined), enabled: !local && !live || Boolean(liveSnapshot?.resourceId), refetchInterval: target.revision == null ? 8000 : false, retry: false });
  useEffect(() => {
    if (!query.data || target.revision != null) return;
    let alive = true;
    void registry.open(query.data).then((value) => { if (alive) setSession(value); });
    return () => { alive = false; };
  }, [query.data, registry, target.revision]);
  if (target.revision != null && query.data) return <DocumentSurface scopeKey={scopeKey} target={target} viewId={viewId} resource={query.data} session={null} onOpenTask={onOpenTask} />;
  if (session) return <SessionSurface scopeKey={scopeKey} target={target} viewId={viewId} resource={query.data} session={session} onOpenTask={onOpenTask} />;
  return <Surface tone="card" className="document-pane"><div className="document-notice" role={query.isError || restoreError ? 'alert' : 'status'}><p>{restoreError || (query.error instanceof Error ? query.error.message : t('document.loading'))}</p>{query.isError && <Button variant="outline" size="sm" onClick={() => { void query.refetch(); }}>{t('shared.retry')}</Button>}</div></Surface>;
}

function SessionSurface(props: { scopeKey: string; target: OpenDocumentTab; viewId: string; resource?: ResourceDocument; session: DocumentSession; onOpenTask: (id: string) => void | Promise<void> }) {
  const snapshot = useSyncExternalStore(props.session.subscribe, props.session.getSnapshot, props.session.getSnapshot);
  return <DocumentSurface {...props} snapshot={snapshot} />;
}

function DocumentSurface({ scopeKey, target, viewId, resource, session, snapshot, onOpenTask }: { scopeKey: string; target: OpenDocumentTab; viewId: string; resource?: ResourceDocument; session: DocumentSession | null; snapshot?: DocumentSnapshot; onOpenTask: (id: string) => void | Promise<void> }) {
  const { t } = useTranslation('library');
  const queryClient = useQueryClient();
  const scroll = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const viewKey = `${scopeKey}:${target.key}:${viewId}`;
  const editorBridge = useMemo(() => session ? {
    registerFlush: (flush: () => boolean) => session.registerEditor(viewKey, flush),
    onPendingChange: (pending: boolean) => session.setEditorPending(viewKey, pending),
    onSerializationFailure: (editorJson: unknown, message: string) => session.captureEditorFailure(viewKey, editorJson, message),
  } : {}, [session, viewKey]);
  const value = snapshot?.content ?? resource?.content ?? '';
  const format = snapshot?.format ?? resource?.format ?? 'text';
  const resourceId = snapshot?.resourceId ?? resource?.id ?? null;
  const revision = snapshot?.revision ?? resource?.revision ?? 0;
  const readOnly = !session || snapshot?.readOnly === true || snapshot?.status === 'recovery' || format === 'binary';
  const [composing, setComposing] = useState(false);
  const compositionChanged = (value: boolean) => { setComposing(value); session?.setComposing(value); };
  const exceedsBodyBudget = useMemo(() => typeof value === 'string' ? !withinTextEditBudget(value) : format === 'richdoc-v1' && !measureRichDocument(value).withinBudget, [format, value]);
  const bodyReadOnly = readOnly || exceedsBodyBudget && !composing;
  const [title, setTitle] = useState(snapshot?.title ?? resource?.title ?? '');
  const [titleEditing, setTitleEditing] = useState(false);
  const [mode, setMode] = useState<TextViewMode>(() => readOnly ? 'read' : positions.get(viewKey)?.mode ?? 'edit');
  const [panel, setPanel] = useState<'info' | 'outline' | 'extracted' | null>(target.chunkId ? 'extracted' : null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [downloadingAttachment, setDownloadingAttachment] = useState<string | null>(null);
  const [reuse, setReuse] = useState<{ blockId?: string; path?: string } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [recoveryDraft, setRecoveryDraft] = useState<DocumentDraft | null>(null);
  usePageContext(`document-${viewId}`, { materialId: resourceId, materialRevision: revision || null, materialVersionMode: target.revision == null ? 'latest' : 'historical', label: title });
  useEffect(() => { if (!titleEditing) setTitle(snapshot?.title ?? resource?.title ?? ''); }, [snapshot?.title, resource?.title, titleEditing]);
  useEffect(() => { documentTabs.title(scopeKey, target.key, snapshot?.title ?? resource?.title ?? t('document.untitled')); }, [scopeKey, target.key, snapshot?.title, resource?.title, t]);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = positions.get(viewKey)?.scrollTop ?? 0; return () => { void session?.flushLocal(); }; }, [viewKey, session]);
  useEffect(() => { if (!target.nodeId) return; const timer = window.setTimeout(() => { scroll.current?.dispatchEvent(new CustomEvent('dovun-document-reveal', { detail: { blockId: target.nodeId } })); scroll.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(target.nodeId!)}"]`)?.scrollIntoView({ block: 'center' }); }, 100); return () => window.clearTimeout(timer); }, [target.nodeId, resource?.id]);
  const rename = () => {
    setTitleEditing(false);
    const next = title.trim();
    if (next && !readOnly) session?.setTitle(next);
  };
  const insert = (files: File[], bookmark?: { blockId: string }) => { if (!session || bodyReadOnly || format !== 'richdoc-v1') return; const current = session.getSnapshot().content; if (typeof current === 'string' || !measureRichDocument(current).withinBudget) return; for (const entry of files) void session.addUpload(entry, { kind: entry.type.startsWith('image/') ? 'image' : 'file', bookmark: bookmark?.blockId }).catch((error) => toast.error(String(error))); };
  const downloadDraft = () => { if (resourceId && revision && (!snapshot || snapshot.status === 'saved' || snapshot.status === 'read-only')) { const link = document.createElement('a'); link.href = resourceOriginalUrl({ id: resourceId, revision }); link.download = resource?.attachment?.fileName || title; link.click(); return; } const blob = new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type: typeof value === 'string' ? 'text/plain' : 'application/json' }); const href = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = href; link.download = `${title || t('document.untitled')}.${typeof value === 'string' ? format === 'markdown' ? 'md' : 'txt' : 'json'}`; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000); };
  const restoreVersion = async () => {
    if (!resource || target.revision == null || restoring) return;
    setRestoring(true);
    try {
      const latest = await loadResource(resource.id);
      const activeSession = await getDocumentRegistry(scopeKey).open(latest);
      const current = activeSession.getSnapshot();
      if (current.status !== 'saved' && current.status !== 'read-only') throw new Error(t('document.restoreDraftFirst'));
      const restored = await restoreResourceVersion(scopeKey, resource.id, resource.revision, latest.revision);
      activeSession.receiveRemote(restored);
      if (!await activeSession.flushLocal()) throw new Error(t('document.storageFailed'));
      queryClient.setQueryData(['library', 'resource', scopeKey, resource.id, 'latest'], restored);
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      documentTabs.open(scopeKey, { resourceId: resource.id, title: restored.title });
    } catch (error) { toast.error(error instanceof Error ? error.message : t('shared.actionFailed')); }
    finally { setRestoring(false); }
  };
  const exportBundle = async () => {
    if (!resourceId || !revision || exporting) return;
    setExportOpen(false); setExporting(true);
    try { const { exportResourceBundle } = await import('@/lib/documents/bundle.js'); const blob = await exportResourceBundle(resourceId, revision); saveDocumentBlob(blob, `${title || t('document.untitled')}.dovun.zip`); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('shared.actionFailed')); }
    finally { setExporting(false); }
  };
  const exportRecovery = async () => {
    if (!session || exporting) return;
    setExportOpen(false); setExporting(true);
    try {
      const { exportDraftRecovery } = await import('@/lib/documents/draft-recovery.js');
      const result = await exportDraftRecovery(session);
      saveDocumentBlob(result.blob, `${title || t('document.untitled')}.draft.dovun.zip`);
      if (!result.complete) toast.warning(t('document.recoveryIncomplete', { count: result.missingUploadIds.length }));
    } catch (error) { toast.error(error instanceof Error ? error.message : t('shared.actionFailed')); }
    finally { setExporting(false); }
  };
  const downloadLocalAttachment = async (uploadId: string, fileName: string) => {
    if (!session || downloadingAttachment) return;
    setDownloadingAttachment(uploadId);
    try {
      const blob = await session.recoveryAttachment(uploadId);
      const name = fileName.replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g, '_').replace(/^\.+/, '').trim().slice(0, 200) || 'attachment';
      saveDocumentBlob(blob, name);
    } catch { toast.error(t('document.localFileUnavailable')); }
    finally { setDownloadingAttachment(null); }
  };
  return <Surface tone="card" className="document-pane" data-testid="document-pane" onDragOver={(event) => { if (format === 'richdoc-v1' && [...event.dataTransfer.items].some((item) => item.kind === 'file')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = bodyReadOnly ? 'none' : 'copy'; } }} onDrop={(event) => { if (event.defaultPrevented || format !== 'richdoc-v1') return; const files = [...event.dataTransfer.files]; if (!files.length) return; event.preventDefault(); event.stopPropagation(); if (!bodyReadOnly) insert(files); }}>
    <header className="document-header">
      <Input variant="inline" className="document-title" aria-label={t('document.title')} value={title} readOnly={readOnly} onFocus={() => setTitleEditing(true)} onChange={(event) => setTitle(event.target.value)} onBlur={() => { void rename(); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur(); }} />
      <div className="document-meta"><span>{format === 'richdoc-v1' ? t('kind.document') : format === 'markdown' ? 'Markdown' : format === 'text' ? t('kind.text') : resource?.attachment?.fileName ?? t('kind.attachment')}</span><span role="status" aria-live="polite" data-testid="document-save-state">{target.revision != null ? t('document.version', { revision }) : t(`document.status.${snapshot?.status ?? 'read-only'}`)}</span></div>
    </header>
    <div className="document-toolbar">
      {!bodyReadOnly && <div role="group" aria-label={t('document.workspace')} className="document-mode-buttons">{(['edit', 'read', ...(format === 'markdown' ? ['split'] : [])] as TextViewMode[]).map((item) => <Button size="sm" variant="tab" key={item} aria-pressed={mode === item} onClick={() => { void session?.flushLocal().then((saved) => { if (!saved) { toast.error(t('document.storageFailed')); return; } setMode(item); positions.set(viewKey, { scrollTop: scroll.current?.scrollTop ?? 0, mode: item }); }); }}>{t(item === 'edit' && format !== 'richdoc-v1' ? 'document.source' : `document.${item}`)}</Button>)}</div>}
      {session && !readOnly && <Button size="sm" variant="ghost" onClick={() => { void session.flushRemote(); }}>{t('document.save')}</Button>}
      <SaveDocumentAs scopeKey={scopeKey} resource={resource} snapshot={snapshot} session={session} />
      {format === 'richdoc-v1' && !bodyReadOnly && <><Button size="sm" variant="ghost" onClick={() => file.current?.click()}>{t('document.insert')}</Button><Input ref={file} className="sr-only" type="file" multiple aria-label={t('document.insert')} onChange={(event) => { insert([...event.target.files ?? []]); event.target.value = ''; }} /></>}
      {target.revision != null && resourceId && <><Button size="sm" variant="outline" onClick={() => openDocument({ resourceId })}>{t('document.latest')}</Button><Button size="sm" variant="outline" disabled={restoring} onClick={() => { void restoreVersion(); }}>{t('document.restoreVersion')}</Button></>}
      <div className="document-toolbar-end"><Button size="sm" variant="ghost" aria-pressed={panel === 'outline'} onClick={() => setPanel(panel === 'outline' ? null : 'outline')}>{t('document.outline')}</Button>{resourceId && <Button size="sm" variant="ghost" aria-pressed={panel === 'extracted'} onClick={() => setPanel(panel === 'extracted' ? null : 'extracted')}>{t('document.extracted')}</Button>}{resourceId && <Button size="sm" variant="ghost" aria-pressed={panel === 'info'} onClick={() => setPanel(panel === 'info' ? null : 'info')}>{t('document.info')}</Button>}<ActionMenu open={exportOpen} onOpenChange={setExportOpen} trigger={<Button size="sm" variant="ghost" disabled={exporting}>{t(exporting ? 'document.exporting' : 'document.export')}</Button>}><ActionMenuItem onSelect={downloadDraft}>{t(snapshot?.status === 'saved' || readOnly ? 'document.download' : 'document.draftDownload')}</ActionMenuItem>{session && <ActionMenuItem onSelect={() => { void exportRecovery(); }}>{t('document.recoveryExport')}</ActionMenuItem>}{resourceId && revision > 0 && <ActionMenuItem disabled={snapshot != null && snapshot.status !== 'saved' && snapshot.status !== 'read-only'} onSelect={() => { void exportBundle(); }}>{t('document.bundleExport')}</ActionMenuItem>}{resource?.hasSourceOriginal && <ActionMenuItem onSelect={() => { const link = document.createElement('a'); link.href = `/api/v1/library/resources/${encodeURIComponent(resource.id)}/versions/${resource.revision}/source-original`; link.download = resource.attachment?.fileName || resource.title; link.click(); }}>{t('document.sourceOriginal')}</ActionMenuItem>}</ActionMenu></div>
    </div>
    {snapshot?.error && <div className="document-notice document-error" role="alert"><p>{snapshot.error.message}</p>{snapshot.status === 'storage-error' && <p>{t('document.storageFailed')}</p>}<Button size="sm" variant="outline" onClick={() => { void session?.retry(); }}>{t('document.retry')}</Button><Button size="sm" variant="ghost" disabled={exporting} onClick={() => { void exportRecovery(); }}>{t('document.recoveryExport')}</Button></div>}
    {snapshot?.conflict && <div className="document-notice" role="alert"><p>{t('document.conflict')}</p><Button size="sm" variant="outline" onClick={() => setConflictOpen(true)}>{t('document.compareConflict')}</Button></div>}
    {!!snapshot?.staleBranches.length && <div className="document-notice"><p>{t('document.staleBranches')}</p>{snapshot.staleBranches.map((draft) => <div key={draft.sessionId}><Button size="sm" variant="outline" onClick={() => setRecoveryDraft(draft)}>{t('document.readDraft')} · {new Date(draft.updatedAt).toLocaleString()}</Button></div>)}</div>}
    {!!snapshot?.uploads.some((upload) => upload.state !== 'removed' && upload.state !== 'ready') && <div className="document-upload-list">{snapshot.uploads.filter((upload) => upload.state !== 'removed' && upload.state !== 'ready').map((upload) => <div key={upload.id}><span>{upload.fileName}</span><span className="library-meta">{upload.error || t('document.uploadNotice')}</span><Button size="sm" variant="ghost" disabled={downloadingAttachment !== null} onClick={() => { void downloadLocalAttachment(upload.id, upload.fileName); }}>{t(downloadingAttachment === upload.id ? 'document.readingLocalFile' : 'document.downloadLocalFile')}</Button>{upload.state === 'failed' && <Button size="sm" variant="ghost" onClick={() => { void session?.retryUpload(upload.id); }}>{t('document.retryUpload')}</Button>}<Button size="sm" variant="ghost" onClick={() => { void session?.removeUpload(upload.id); }}>{t('document.removeUpload')}</Button></div>)}</div>}
    <div className={`document-content-frame ${panel ? 'has-document-panel' : ''}`}>
      <div ref={scroll} className="document-scroll" onScroll={(event) => positions.set(viewKey, { mode, scrollTop: event.currentTarget.scrollTop })}>
        {format === 'richdoc-v1' && typeof value !== 'string' ? <RichDocumentEditor {...editorBridge} sessionKey={viewKey} value={value} onChange={(next) => { if (!bodyReadOnly) session?.edit(next); }} readOnly={bodyReadOnly || mode === 'read'} onCompositionChange={compositionChanged} onInsertFiles={insert} onInsertExisting={(bookmark) => { if (!bodyReadOnly) setReuse(bookmark ?? {}); }} onUndo={() => session?.undo()} onRedo={() => session?.redo()} /> : format === 'text' || format === 'markdown' ? <TextDocumentEditor references={snapshot?.relativeReferences ?? resource?.relativeReferences} onResolveMissing={(path) => setReuse({ path })} fileName={resource?.attachment?.fileName || title} viewKey={viewKey} onUndo={() => session?.undo()} onRedo={() => session?.redo()} value={typeof value === 'string' ? value : ''} onChange={(next) => session?.edit(next)} format={format} mode={readOnly ? 'read' : mode} readOnly={readOnly} onCompositionChange={compositionChanged} /> : resource ? <ResourceReader resource={resource} /> : null}
        <DocumentSupplement content={resource?.supplementalContent} viewKey={viewKey} />
      </div>
      {panel && <aside className="document-side-panel" aria-label={t(`document.${panel}`)}><div className="document-side-heading"><h3>{t(`document.${panel}`)}</h3><Button size="sm" variant="ghost" onClick={() => setPanel(null)}>{t('shared.close')}</Button></div>{panel === 'info' && resourceId ? <DocumentInfo key={`${scopeKey}:${resourceId}`} resourceId={resourceId} revision={revision} onOpenTask={onOpenTask} /> : panel === 'extracted' && resourceId ? <DocumentExtractedText key={`${scopeKey}:${resourceId}:${revision}`} resourceId={resourceId} revision={revision} chunkId={target.chunkId} /> : <DocumentOutline content={value} format={format} container={scroll} />}</aside>}
    </div>
    {target.returnHash && <Button className="document-return" size="sm" variant="ghost" onClick={() => { window.location.hash = target.returnHash!; }}>{t('document.returnSource')}</Button>}
    {reuse && session && <ResourceReferencePicker onClose={() => setReuse(null)} onSelect={async (id, version) => { if (bodyReadOnly) return; const selected = await loadResource(id, version); const liveContent = session.getSnapshot().content; if (typeof liveContent !== 'string' && !measureRichDocument(liveContent).withinBudget) throw new Error(t('document.largeReadOnly')); if (reuse.path) { session.setRelativeReference(reuse.path, { resourceId: selected.id, revision: selected.revision }); if (!await session.flushLocal()) throw new Error(t('document.storageFailed')); return; } const current = session.getSnapshot().content; const image = selected.attachment?.mimeType?.startsWith('image/') === true; const reference = { id: crypto.randomUUID(), kind: image ? 'image' as const : 'file' as const, target: { resourceId: selected.id, revision: selected.revision }, ...(image ? { alt: selected.title } : { label: selected.title }) }; const next = insertResourceReference(current, reference, reuse.blockId); if (!next) throw new Error(t('document.insertPositionChanged')); session.edit(next); if (!await session.flushLocal()) throw new Error(t('document.storageFailed')); }} />}
    {conflictOpen && snapshot?.conflict && session && <ConflictDialog session={session} snapshot={snapshot} onClose={() => setConflictOpen(false)} scopeKey={scopeKey} />}
    {recoveryDraft && session && <Dialog open onOpenChange={(open) => { if (!open) setRecoveryDraft(null); }}><DialogContent className="document-conflict-dialog"><DialogTitle>{t('document.readDraft')}</DialogTitle><DialogDescription>{t('document.staleBranches')}</DialogDescription><div className="document-conflict-copies"><div><h3>{t('document.base')}</h3><pre>{contentText(recoveryDraft.format, recoveryDraft.base.content)}</pre></div><div><h3>{recoveryDraft.title}</h3><pre>{contentText(recoveryDraft.format, recoveryDraft.content)}</pre></div></div><div className="flex gap-2"><Button onClick={() => { void session.restoreBranch(recoveryDraft.sessionId).then(() => { setRecoveryDraft(null); setMode('edit'); }).catch((error) => toast.error(error instanceof Error ? error.message : t('shared.actionFailed'))); }}>{t('document.recoverDraft')}</Button><Button variant="ghost" onClick={() => setRecoveryDraft(null)}>{t('shared.cancel')}</Button></div></DialogContent></Dialog>}
  </Surface>;
}

function DocumentOutline({ content, format, container }: { content: DraftContent; format: string; container: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation('library');
  const [headings, setHeadings] = useState<Array<{ id: string; title: string; level: number }>>([]);
  const [page, setPage] = useState(0);
  const cursor = Math.min(page * 100, Math.max(0, Math.ceil(headings.length / 100) - 1) * 100);
  useEffect(() => { const timer = setTimeout(() => {
    const items: Array<{ id: string; title: string; level: number }> = [];
    if (typeof content === 'string') { if (format === 'markdown') content.split('\n').forEach((line, index) => { const match = /^(#{1,6})\s+(.+)/.exec(line); if (match) items.push({ id: `line-${index}`, level: match[1].length, title: match[2] }); }); }
    else { const walk = (blocks: typeof content.blocks) => { for (const block of blocks) { if (block.kind === 'heading') items.push({ id: block.id, title: block.text?.map((run) => run.text).join('') ?? '', level: block.level ?? 1 }); if ('children' in block && block.children) walk(block.children); } }; walk(content.blocks); }
    setHeadings(items);
  }, 600); return () => clearTimeout(timer); }, [content, format]);
  return <nav className="document-outline" aria-label={t('document.outline')}>{!headings.length && <p className="library-meta">{t('document.noHeadings')}</p>}{headings.slice(cursor, cursor + 100).map((heading, offset) => <Button data-testid="document-outline-item" key={heading.id} size="sm" variant="ghost" className="justify-start whitespace-normal text-left" style={{ paddingLeft: `${8 + (heading.level - 1) * 12}px` }} onClick={() => { if (typeof content !== 'string') container.current?.dispatchEvent(new CustomEvent('dovun-document-reveal', { detail: { blockId: heading.id } })); const field = container.current?.querySelector<HTMLTextAreaElement>('.document-source'); if (typeof content === 'string' && field) { const line = Number(heading.id.slice(5)); const offset = content.split('\n').slice(0, line).join('\n').length + (line > 0 ? 1 : 0); field.focus(); field.setSelectionRange(offset, offset); } const node = typeof content === 'string' ? container.current?.querySelectorAll('h1,h2,h3,h4,h5,h6')[cursor + offset] : container.current?.querySelector(`[data-block-id="${CSS.escape(heading.id)}"]`); node?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>{heading.title}</Button>)}{headings.length > 100 && <div className="document-outline-pagination" data-testid="document-outline-pagination"><span className="library-meta">{t('document.outlinePage', { from: cursor + 1, to: Math.min(cursor + 100, headings.length), total: headings.length })}</span><Button size="sm" variant="ghost" disabled={cursor === 0} onClick={() => setPage(Math.max(0, page - 1))}>{t('shared.previousPage')}</Button><Button size="sm" variant="ghost" disabled={cursor + 100 >= headings.length} onClick={() => setPage(page + 1)}>{t('shared.nextPage')}</Button></div>}</nav>;
}

function ConflictDialog({ session, snapshot, onClose, scopeKey }: { session: DocumentSession; snapshot: DocumentSnapshot; onClose: () => void; scopeKey: string }) {
  const { t } = useTranslation('library');
  const conflict = snapshot.conflict!;
  const [merge, setMerge] = useState(typeof snapshot.content === 'string' ? snapshot.content : '');
  const show = (value: unknown) => contentText(snapshot.format, value);
  const copyBlocked = uploadIds(snapshot.content).size > 0;
  const saveCopy = async () => {
    try {
      if (!session.flushEditors()) throw new Error(t('document.storageFailed'));
      const current = session.getSnapshot();
      if (uploadIds(current.content).size) throw new Error(t('document.copyUploadPending'));
      const copy = await getDocumentRegistry(scopeKey).create({ title: `${current.title} — ${t('document.copySuffix')}`, format: current.format === 'binary' ? 'text' : current.format, content: current.content as ResourceDocument['content'], relativeReferences: current.relativeReferences });
      documentTabs.open(scopeKey, { resourceId: copy.getSnapshot().localId, title: copy.getSnapshot().title }); onClose();
    } catch (error) { toast.error(error instanceof Error ? error.message : t('shared.actionFailed')); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="document-conflict-dialog"><DialogTitle>{t('document.conflictDialog')}</DialogTitle><DialogDescription>{t('document.conflict')}</DialogDescription><div className="document-conflict-copies">{([['base', conflict.base.content], ['mine', snapshot.content], ['remote', conflict.remote.content]] as const).map(([key, content]) => <div key={key}><h3>{t(`document.${key}`)}</h3><pre>{show(content)}</pre></div>)}</div><DocumentChanges base={conflict.base.content} local={snapshot.content} remote={conflict.remote.content} />{copyBlocked && <p role="status">{t('document.copyUploadPending')}</p>}{typeof snapshot.content === 'string' && <label>{t('document.merge')}<Textarea rows={8} value={merge} onChange={(event) => setMerge(event.target.value)} /></label>}<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { void session.resolveConflict('local').then(onClose); }}>{t('document.keepMine')}</Button><Button variant="outline" onClick={() => { void session.resolveConflict('remote').then(onClose); }}>{t('document.useRemote')}</Button>{typeof snapshot.content === 'string' && <Button onClick={() => { void session.resolveConflict({ content: merge }).then(onClose); }}>{t('document.applyMerge')}</Button>}<Button variant="ghost" disabled={copyBlocked} onClick={() => { void saveCopy(); }}>{t('document.saveCopy')}</Button></div></DialogContent></Dialog>;
}
