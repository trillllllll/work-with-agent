import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type Task } from '@/lib/api.js';
import { materialKindNames, materialTypeLabel, startOfLocalWeek, titleFromFileName } from '@/lib/attachment-title.js';
import { json, submitCommands, usePlatformAction } from '@/lib/platform.js';
import { intlLocale, t as translate } from '../../i18n/index.js';
import { cn } from '@/lib/utils.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.js';
import { Textarea } from '@/components/ui/textarea.js';
import { MaterialPreview } from './MaterialPreview.js';
import { OrganizationPrompt } from './OrganizationPrompt.js';

function FileSlot({ children }: { children?: ReactNode; i18nIsDynamicList?: boolean }) {
  return <>{children}</>;
}

type PageResult<T> = { items: T[]; total: number; nextCursor: number | null };
type MaterialRow = { id: string; title: string; kind: string; revision: number; updatedAt?: string; archivedAt?: string | null; taskId?: string | null; taskTitle?: string | null; fileName?: string | null; mimeType?: string | null };
type MaterialDetail = MaterialRow & { uri?: string | null; content?: string; evidence?: Array<{ type: string; id: string; revision: number }>; versions?: Array<{ revision: number; content?: string; fileName?: string | null; hasAttachment?: boolean; reason?: string }> };
type View = 'all' | 'week' | 'linked' | 'archived';
type SortKey = 'title' | 'kind' | 'updatedAt';
const attachmentLimit = 8 * 1024 * 1024;
const viewOrder: View[] = ['all', 'week', 'linked', 'archived'];

function readAttachment(file: File) {
  return new Promise<{ attachmentBase64: string; fileName: string; mimeType: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ attachmentBase64: String(reader.result).split(',')[1] ?? '', fileName: file.name, mimeType: file.type || 'application/octet-stream' });
    reader.onerror = () => reject(new Error(translate('workspace:materials.readFailed')));
    reader.readAsDataURL(file);
  });
}
function filesFromDrop(data: DataTransfer) {
  const files: File[] = [];
  let directories = 0;
  for (const item of data.items) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory) { directories += 1; continue; }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files: files.length || directories ? files : [...data.files], directories };
}
function TaskLinkSelect({ resource, topicId, busy, run }: { resource: MaterialDetail; topicId: string | null; busy: boolean; run: ReturnType<typeof usePlatformAction>['run'] }) {
  const { t } = useTranslation('workspace');
  const tasks = useQuery({ queryKey: ['material-tasks', topicId ?? 'inbox'], queryFn: () => api<Task[]>(topicId ? `/api/tasks?topicId=${encodeURIComponent(topicId)}` : '/api/tasks?inbox=true') });
  const [choice, setChoice] = useState(resource.taskId ?? '');
  useEffect(() => { setChoice(resource.taskId ?? ''); }, [resource.id, resource.revision, resource.taskId]);
  const known = tasks.data?.some((task) => task.id === resource.taskId);
  return <select className="glass-control h-9 max-w-full rounded-lg px-3 text-sm" value={choice} disabled={busy || tasks.isLoading} onChange={(event) => {
    const next = event.target.value;
    const previous = resource.taskId ?? '';
    setChoice(next);
    void run(() => submitCommands([{ kind: 'material.update', targetId: resource.id, expectedRevision: resource.revision, input: { taskId: next || null } }]), next ? t('materials.linkedToast') : t('materials.unlinkedToast')).then((saved) => { if (!saved) setChoice(previous); });
  }}>
    <option value="">{t('materials.noLink')}</option>
    {resource.taskId && !known && <option value={resource.taskId}>{tasks.data ? resource.taskTitle || t('materials.currentTask') : t('materials.reading')}</option>}
    {tasks.data?.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
  </select>;
}
function currentVersion(resource: MaterialDetail) {
  return resource.versions?.find((item) => item.revision === resource.revision) ?? resource.versions?.[0];
}
function formatWhen(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(intlLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function MaterialBrowser({ topicId, taskId, onCreate, onEdit, children }: { topicId: string | null; taskId?: string; onCreate: () => void; onEdit: (resource: MaterialDetail) => void; children?: ReactNode }) {
  const { t } = useTranslation('workspace');
  const [view, setView] = useState<View>('all');
  const [kind, setKind] = useState('');
  const [sort, setSort] = useState<SortKey>('updatedAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [cursor, setCursor] = useState(0);
  const [opened, setOpened] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [importError, setImportError] = useState('');
  const [purpose, setPurpose] = useState(() => t('materials.defaultPurpose'));
  const [provider, setProvider] = useState('external');
  const [organizeResult, setOrganizeResult] = useState<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const importing = useRef(false);
  const client = useQueryClient();
  const { run, busy } = usePlatformAction();
  const since = view === 'week' ? startOfLocalWeek() : '';
  useEffect(() => { setCursor(0); setOpened(''); setOrganizeResult(null); }, [topicId, taskId, view, kind, sort, dir]);
  const params = new URLSearchParams({ topicId: topicId || 'inbox', cursor: String(cursor), sort, dir });
  if (taskId) params.set('taskId', taskId);
  if (view === 'archived') params.set('archived', 'only');
  if (view === 'linked') params.set('linked', 'task');
  if (since) params.set('since', since);
  if (kind) params.set('kind', kind);
  const list = useQuery({ queryKey: ['knowledge', 'materials', params.toString()], queryFn: () => api<PageResult<MaterialRow>>(`/api/v1/knowledge/materials?${params}`) });
  const detail = useQuery({ queryKey: ['knowledge', 'materials', opened], queryFn: () => api<MaterialDetail>(`/api/v1/knowledge/materials/${opened}`), enabled: Boolean(opened) });
  const resource = detail.data;
  function toggleSort(next: SortKey) {
    if (sort === next) setDir(dir === 'asc' ? 'desc' : 'asc');
    else { setSort(next); setDir(next === 'updatedAt' ? 'desc' : 'asc'); }
  }
  async function importFiles(files: File[], directories = 0) {
    if (importing.current) return;
    if (!files.length) { if (directories) { const message = t('materials.dropFiles'); setImportError(message); toast.error(message); } return; }
    importing.current = true;
    setImportError('');
    const errors: string[] = [];
    let saved = 0;
    let changeId: string | undefined;
    try {
      for (const file of files) {
        if (file.size > attachmentLimit) { errors.push(t('materials.fileTooLarge', { name: file.name })); continue; }
        const title = titleFromFileName(file.name);
        if (!title) { errors.push(t('materials.noUsableName', { name: file.name || t('materials.unnamed') })); continue; }
        try {
          const attachment = await readAttachment(file);
          const result = await submitCommands([{ kind: 'material.create', input: { topicId, ...(taskId ? { taskId } : {}), kind: 'attachment', title, ...attachment } }]);
          saved += 1;
          changeId = result.changeId;
        } catch (error) { errors.push(t('materials.importErrorItem', { name: file.name, message: error instanceof Error ? error.message : t('materials.importFailed') })); }
      }
    } finally { importing.current = false; if (saved) await client.invalidateQueries(); }
    if (!saved) { const message = errors.join(t('clauseSeparator')) || t('materials.nothingImported'); setImportError(message); toast.error(message); return; }
    if (errors.length) { const message = t('materials.partialImport', { saved, failed: errors.length, details: errors.join(t('clauseSeparator')) }); setImportError(message); toast.error(message); return; }
    toast.success(saved === 1 ? t('materials.imported_one') : t('materials.imported_other', { saved }), saved === 1 && changeId ? { duration: 8000, action: { label: t('materials.undo'), onClick: () => { void api(`/api/changes/${changeId}/undo`, { method: 'POST', body: '{}', headers: { 'X-Request-ID': crypto.randomUUID() } }).then(() => { void client.invalidateQueries(); toast.success(t('materials.undone')); }).catch((error) => toast.error(error instanceof Error ? error.message : t('materials.undoFailed'))); } } } : undefined);
  }
  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragOver(false);
    const dropped = filesFromDrop(event.dataTransfer);
    void importFiles(dropped.files, dropped.directories);
  }
  const columns: Array<[SortKey, string]> = [['title', t('materials.columns.title')], ['kind', t('materials.columns.kind')], ['updatedAt', t('materials.columns.updatedAt')]];
  const openedResource = resource?.id === opened ? resource : undefined;
  const summary = openedResource
    ? t(openedResource.archivedAt && openedResource.id.startsWith('auto-chat:') ? 'materials.summaryArchivedExcerpt' : openedResource.archivedAt ? 'materials.summaryArchived' : openedResource.id.startsWith('auto-chat:') ? 'materials.summaryExcerpt' : 'materials.summary', { type: materialTypeLabel(openedResource.kind, currentVersion(openedResource)?.fileName ?? openedResource.fileName), revision: openedResource.revision })
    : detail.error ? t('materials.readFailedDetail') : t('materials.reading');
  return <div className={cn('grid gap-4', !taskId && 'lg:grid-cols-[9.5rem_minmax(0,1fr)] lg:items-start')}>
    <nav aria-label={t('materials.navAria')} className={cn('flex gap-1 overflow-x-auto', !taskId && 'lg:flex-col')}>{viewOrder.filter((value) => value !== 'linked' || !taskId).map((value) => <Button key={value} type="button" size="sm" variant={view === value ? 'secondary' : 'ghost'} aria-pressed={view === value} onClick={() => setView(value)}>{t(`materials.views.${value}`)}</Button>)}</nav>
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={inputRef} className="sr-only" type="file" multiple aria-label={t('materials.importAria')} onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void importFiles(files); }} />
        <Button type="button" size="sm" onClick={() => inputRef.current?.click()}>{t('materials.import')}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCreate}>{t('materials.save')}</Button>
        <select aria-label={t('materials.kindFilterAria')} className="glass-control h-8 rounded-lg px-2 text-sm" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">{t('materials.allKinds')}</option>{Object.entries(materialKindNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </div>
      {children}
      {importError && <p role="alert" className="text-sm text-destructive">{importError}</p>}
      {list.error && <p role="alert" className="text-sm text-destructive">{list.error.message}</p>}
      <div className={cn('glass-subtle overflow-x-auto rounded-xl', dragOver && 'ring-2 ring-primary')} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        <table className="w-full text-sm" aria-label={t('materials.tableAria')}>
          <thead><tr>{columns.map(([key, label]) => <th key={key} aria-sort={sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} className="px-3 py-2 text-left font-medium text-muted-foreground"><button type="button" className="hover:text-foreground" onClick={() => toggleSort(key)}>{label}{sort === key ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>)}{!taskId && <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('materials.linkedColumn')}</th>}</tr></thead>
          <tbody>
            {!list.isLoading && !list.data?.items.length && <tr><td colSpan={taskId ? 3 : 4} className="px-3 py-6 text-muted-foreground">{t('materials.empty')}</td></tr>}
            {list.data?.items.map((item) => <tr key={item.id} className={cn('border-t', opened === item.id && 'bg-primary/10')} aria-selected={opened === item.id}>
              <td className="px-3 py-2"><button type="button" className="text-left font-medium" aria-haspopup="dialog" aria-expanded={opened === item.id} onClick={() => { setOrganizeResult(null); setOpened(item.id); }}>{item.title}</button>{item.id.startsWith('auto-chat:') && <span className="ctx-badge">{t('materials.autoExcerpt')}</span>}</td>
              <td className="px-3 py-2 text-muted-foreground">{materialTypeLabel(item.kind, item.fileName)}</td>
              <td className="px-3 py-2 text-muted-foreground">{formatWhen(item.updatedAt)}</td>
              {!taskId && <td className="px-3 py-2 text-muted-foreground">{item.taskTitle ?? ''}</td>}
            </tr>)}
          </tbody>
        </table>
      </div>
      <Dialog open={Boolean(opened)} onOpenChange={(next) => { if (!next) setOpened(''); }}>
        <DialogContent surface="glass" overlayClassName="z-[60]" className="z-[60] flex h-[min(46rem,calc(100dvh-3rem))] w-[min(64rem,calc(100%-3rem))] max-w-none flex-col gap-3 overflow-hidden p-4">
          <div className="min-w-0 shrink-0 pr-10">
            <DialogTitle className="truncate text-base" title={openedResource ? openedResource.title : undefined}>{openedResource ? openedResource.title : t('materials.previewTitle')}</DialogTitle>
            <DialogDescription className="truncate text-xs">{summary}</DialogDescription>
          </div>
          <div className="relative min-h-[8rem] min-w-0 flex-1">
            <div className="absolute inset-0 overflow-hidden">
              {detail.error && <p role="alert" className="text-sm text-destructive">{detail.error.message}</p>}
              {openedResource ? <MaterialPreview materialId={openedResource.id} revision={openedResource.revision} kind={openedResource.kind} content={currentVersion(openedResource)?.content} fileName={currentVersion(openedResource)?.fileName ?? openedResource.fileName} hasAttachment={currentVersion(openedResource)?.hasAttachment} /> : !detail.error && <p className="text-sm text-muted-foreground">{t('materials.reading')}</p>}
            </div>
          </div>
          {openedResource && <div className="flex min-h-0 max-h-[min(16rem,38dvh)] shrink flex-col gap-3 overflow-auto">
            {openedResource.uri && <a className="break-all text-sm text-primary underline" href={openedResource.uri} target="_blank" rel="noreferrer">{t('materials.sourceLink')}</a>}
            {currentVersion(openedResource)?.hasAttachment && <p className="text-sm"><Trans t={t} i18nKey="materials.originalFile" components={{ fileName: <FileSlot i18nIsDynamicList>{currentVersion(openedResource)?.fileName ?? t('materials.attachmentFallback')}</FileSlot>, a: <a className="text-primary underline" href={`/api/v1/knowledge/materials/${openedResource.id}/versions/${openedResource.revision}/attachment`} /> }} /></p>}
            <div className="flex flex-wrap items-end gap-2">
              <label className="grid min-w-[min(100%,12rem)] flex-1 gap-1 text-xs text-muted-foreground">{t('materials.linkedTask')}<TaskLinkSelect resource={openedResource} topicId={topicId} busy={busy} run={run} /></label>
              <div className="flex flex-wrap gap-2">
                {openedResource.kind === 'link' && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api(`/api/v1/knowledge/materials/${openedResource.id}/fetch`, { method: 'POST', body: json({ expectedVersion: openedResource.revision }) }), t('materials.snapshotToast'))}>{t('materials.fetchSnapshot')}</Button>}
                <Button type="button" size="sm" variant="outline" onClick={() => { setOpened(''); onEdit(openedResource); }}>{t('materials.edit')}</Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => submitCommands([{ kind: 'material.archive', targetId: openedResource.id, expectedRevision: openedResource.revision, input: { archived: !openedResource.archivedAt } }]), openedResource.archivedAt ? t('materials.restoredToast') : t('materials.archivedToast'))}>{openedResource.archivedAt ? t('materials.restore') : t('materials.archive')}</Button>
              </div>
            </div>
            <details className="disclosure shrink-0">
              <summary className="cursor-pointer text-xs text-muted-foreground">{t('materials.organize')}</summary>
              <div className="mt-2 max-h-[min(12rem,30dvh)] space-y-2 overflow-auto">
                <Textarea aria-label={t('materials.purposeAria')} value={purpose} onChange={(event) => setPurpose(event.target.value)} rows={2} />
                <select aria-label={t('materials.methodAria')} className="glass-control h-9 rounded-lg px-3 text-sm" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="external">{t('materials.methodExternal')}</option><option value="builtin">{t('materials.methodBuiltin')}</option></select>
                <Button type="button" size="sm" disabled={busy || !purpose.trim()} onClick={() => void run(async () => { const request = await api<any>('/api/v1/knowledge/organizations', { method: 'POST', body: json({ topicId, purpose, provider, materialIds: [openedResource.id] }) }); const result = provider === 'builtin' ? await api(`/api/v1/knowledge/organizations/${request.id}/generate`, { method: 'POST', body: '{}' }) : request; setOrganizeResult(result); return result; }, provider === 'builtin' ? t('materials.builtinToast') : t('materials.externalToast'))}>{t('materials.organize')}</Button>
                {organizeResult?.provider === 'external' && !['proposed', 'completed'].includes(organizeResult.status) && <OrganizationPrompt id={organizeResult.id} purpose={organizeResult.purpose} />}
                {organizeResult?.proposalIds?.length > 0 && <a className="block text-sm text-primary underline" href="#/proposals">{t('materials.reviewSuggestions')}</a>}
              </div>
            </details>
            <details className="disclosure shrink-0"><summary className="cursor-pointer text-xs text-muted-foreground">{t('materials.historySummary')}</summary><div className="max-h-[min(12rem,30dvh)] overflow-auto">{openedResource.evidence?.map((ref) => <p key={`${ref.type}:${ref.id}`} className="my-2 break-all text-xs">{t('materials.evidenceLine', { type: ref.type, id: ref.id, revision: ref.revision })}</p>)}{openedResource.versions?.map((version) => <div key={version.revision} className="mt-3 border-t pt-2 text-xs"><p>{t('materials.versionLine', { revision: version.revision, reason: version.reason ?? t('materials.savedOriginal') })}</p><p className="mt-1 whitespace-pre-wrap">{version.content}</p></div>)}</div></details>
          </div>}
        </DialogContent>
      </Dialog>
      <div className="flex gap-2"><Button type="button" variant="ghost" size="sm" disabled={!cursor} onClick={() => setCursor(Math.max(0, cursor - 40))}>{t('materials.previousPage')}</Button><Button type="button" variant="ghost" size="sm" disabled={list.data?.nextCursor == null} onClick={() => setCursor(list.data?.nextCursor ?? 0)}>{t('materials.nextPage')}</Button></div>
    </div>
  </div>;
}
