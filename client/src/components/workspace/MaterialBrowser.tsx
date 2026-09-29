import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type Task } from '@/lib/api.js';
import { materialKindNames, materialTypeLabel, startOfLocalWeek, titleFromFileName } from '@/lib/attachment-title.js';
import { json, submitCommands, usePlatformAction } from '@/lib/platform.js';
import { cn } from '@/lib/utils.js';
import { Button } from '@/components/ui/button.js';
import { Textarea } from '@/components/ui/textarea.js';
import { MaterialPreview } from './MaterialPreview.js';
import { OrganizationPrompt } from './OrganizationPrompt.js';

type PageResult<T> = { items: T[]; total: number; nextCursor: number | null };
type MaterialRow = { id: string; title: string; kind: string; revision: number; updatedAt?: string; archivedAt?: string | null; taskId?: string | null; taskTitle?: string | null; fileName?: string | null; mimeType?: string | null };
type MaterialDetail = MaterialRow & { uri?: string | null; content?: string; evidence?: Array<{ type: string; id: string; revision: number }>; versions?: Array<{ revision: number; content?: string; fileName?: string | null; hasAttachment?: boolean; reason?: string }> };
type View = 'all' | 'week' | 'linked' | 'archived';
type SortKey = 'title' | 'kind' | 'updatedAt';
const attachmentLimit = 8 * 1024 * 1024;
const views: Array<[View, string]> = [['all', '全部'], ['week', '本周新增'], ['linked', '已关联任务'], ['archived', '已归档']];

function readAttachment(file: File) {
  return new Promise<{ attachmentBase64: string; fileName: string; mimeType: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ attachmentBase64: String(reader.result).split(',')[1] ?? '', fileName: file.name, mimeType: file.type || 'application/octet-stream' });
    reader.onerror = () => reject(new Error('读取失败'));
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
  const tasks = useQuery({ queryKey: ['material-tasks', topicId ?? 'inbox'], queryFn: () => api<Task[]>(topicId ? `/api/tasks?topicId=${encodeURIComponent(topicId)}` : '/api/tasks?inbox=true') });
  const [choice, setChoice] = useState(resource.taskId ?? '');
  useEffect(() => { setChoice(resource.taskId ?? ''); }, [resource.id, resource.revision, resource.taskId]);
  const known = tasks.data?.some((task) => task.id === resource.taskId);
  return <select className="glass-control h-9 max-w-full rounded-lg px-3 text-sm" value={choice} disabled={busy || tasks.isLoading} onChange={(event) => {
    const next = event.target.value;
    const previous = resource.taskId ?? '';
    setChoice(next);
    void run(() => submitCommands([{ kind: 'material.update', targetId: resource.id, expectedRevision: resource.revision, input: { taskId: next || null } }]), next ? '已关联任务' : '已取消关联').then((saved) => { if (!saved) setChoice(previous); });
  }}>
    <option value="">不关联</option>
    {resource.taskId && !known && <option value={resource.taskId}>{tasks.data ? resource.taskTitle || '当前任务' : '正在读取…'}</option>}
    {tasks.data?.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
  </select>;
}
function currentVersion(resource: MaterialDetail) {
  return resource.versions?.find((item) => item.revision === resource.revision) ?? resource.versions?.[0];
}
function formatWhen(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function MaterialBrowser({ topicId, taskId, onCreate, onEdit, children }: { topicId: string | null; taskId?: string; onCreate: () => void; onEdit: (resource: MaterialDetail) => void; children?: ReactNode }) {
  const [view, setView] = useState<View>('all');
  const [kind, setKind] = useState('');
  const [sort, setSort] = useState<SortKey>('updatedAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [cursor, setCursor] = useState(0);
  const [opened, setOpened] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [importError, setImportError] = useState('');
  const [purpose, setPurpose] = useState('从这份材料整理下一步任务、决策和需要确认的问题');
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
    if (!files.length) { if (directories) { setImportError('请拖入文件'); toast.error('请拖入文件'); } return; }
    importing.current = true;
    setImportError('');
    const errors: string[] = [];
    let saved = 0;
    let changeId: string | undefined;
    try {
      for (const file of files) {
        if (file.size > attachmentLimit) { errors.push(`${file.name} 超过 8 MiB`); continue; }
        const title = titleFromFileName(file.name);
        if (!title) { errors.push(`${file.name || '未命名文件'} 没有可用的名称`); continue; }
        try {
          const attachment = await readAttachment(file);
          const result = await submitCommands([{ kind: 'material.create', input: { topicId, ...(taskId ? { taskId } : {}), kind: 'attachment', title, ...attachment } }]);
          saved += 1;
          changeId = result.changeId;
        } catch (error) { errors.push(`${file.name}：${error instanceof Error ? error.message : '导入失败'}`); }
      }
    } finally { importing.current = false; if (saved) await client.invalidateQueries(); }
    if (!saved) { const message = errors.join('；') || '没有导入文件'; setImportError(message); toast.error(message); return; }
    if (errors.length) { const message = `已导入 ${saved} 份，另有 ${errors.length} 份未导入：${errors.join('；')}`; setImportError(message); toast.error(message); return; }
    toast.success(saved === 1 ? '已导入材料' : `已导入 ${saved} 份材料`, saved === 1 && changeId ? { duration: 8000, action: { label: '撤销', onClick: () => { void api(`/api/changes/${changeId}/undo`, { method: 'POST', body: '{}', headers: { 'X-Request-ID': crypto.randomUUID() } }).then(() => { void client.invalidateQueries(); toast.success('已撤销'); }).catch((error) => toast.error(error instanceof Error ? error.message : '撤销失败')); } } } : undefined);
  }
  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragOver(false);
    const dropped = filesFromDrop(event.dataTransfer);
    void importFiles(dropped.files, dropped.directories);
  }
  const columns: Array<[SortKey, string]> = [['title', '名称'], ['kind', '类型'], ['updatedAt', '更新时间']];
  return <div className={cn('grid gap-4', !taskId && 'lg:grid-cols-[9.5rem_minmax(0,1fr)] lg:items-start')}>
    <nav aria-label="材料视图" className={cn('flex gap-1 overflow-x-auto', !taskId && 'lg:flex-col')}>{views.filter(([value]) => value !== 'linked' || !taskId).map(([value, label]) => <Button key={value} type="button" size="sm" variant={view === value ? 'secondary' : 'ghost'} aria-pressed={view === value} onClick={() => setView(value)}>{label}</Button>)}</nav>
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={inputRef} className="sr-only" type="file" multiple aria-label="选择要导入的文件" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void importFiles(files); }} />
        <Button type="button" size="sm" onClick={() => inputRef.current?.click()}>导入文件</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCreate}>保存材料</Button>
        <select aria-label="材料类型筛选" className="glass-control h-8 rounded-lg px-2 text-sm" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">全部类型</option>{Object.entries(materialKindNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </div>
      {children}
      {importError && <p role="alert" className="text-sm text-destructive">{importError}</p>}
      {list.error && <p role="alert" className="text-sm text-destructive">{list.error.message}</p>}
      <div className={cn('grid items-start gap-4', !taskId && opened && 'xl:grid-cols-[minmax(0,1fr)_20rem]')} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        <div className={cn('glass-subtle overflow-x-auto rounded-xl', dragOver && 'ring-2 ring-primary')}>
          <table className="w-full text-sm" aria-label="材料">
            <thead><tr>{columns.map(([key, label]) => <th key={key} aria-sort={sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} className="px-3 py-2 text-left font-medium text-muted-foreground"><button type="button" className="hover:text-foreground" onClick={() => toggleSort(key)}>{label}{sort === key ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>)}{!taskId && <th className="px-3 py-2 text-left font-medium text-muted-foreground">关联任务</th>}</tr></thead>
            <tbody>
              {!list.isLoading && !list.data?.items.length && <tr><td colSpan={taskId ? 3 : 4} className="px-3 py-6 text-muted-foreground">暂无材料。可以导入文件，或保存一段文本。</td></tr>}
              {list.data?.items.map((item) => <tr key={item.id} className={cn('border-t', opened === item.id && 'bg-primary/10')} aria-selected={opened === item.id}>
                <td className="px-3 py-2"><button type="button" className="text-left font-medium" onClick={() => { setOrganizeResult(null); setOpened(opened === item.id ? '' : item.id); }}>{item.title}</button></td>
                <td className="px-3 py-2 text-muted-foreground">{materialTypeLabel(item.kind, item.fileName)}</td>
                <td className="px-3 py-2 text-muted-foreground">{formatWhen(item.updatedAt)}</td>
                {!taskId && <td className="px-3 py-2 text-muted-foreground">{item.taskTitle ?? ''}</td>}
              </tr>)}
            </tbody>
          </table>
        </div>
        {opened && <article aria-label="材料预览" className="glass-subtle space-y-3 rounded-xl p-4">
          {detail.error && <p role="alert" className="text-sm text-destructive">{detail.error.message}</p>}
          {!resource && !detail.error && <p className="text-sm text-muted-foreground">正在读取…</p>}
          {resource?.id === opened && <>
            <h2 className="font-semibold">{resource.title}</h2>
            <p className="text-xs text-muted-foreground">{materialTypeLabel(resource.kind, currentVersion(resource)?.fileName ?? resource.fileName)} · 版本 {resource.revision}{resource.archivedAt ? ' · 已归档' : ''}</p>
            <label className="grid gap-1 text-xs text-muted-foreground">关联任务<TaskLinkSelect resource={resource} topicId={topicId} busy={busy} run={run} /></label>
            {resource.uri && <a className="break-all text-sm text-primary underline" href={resource.uri} target="_blank" rel="noreferrer">查看来源链接</a>}
            {currentVersion(resource)?.hasAttachment && <p className="text-sm">原始文件名 {currentVersion(resource)?.fileName ?? '附件'} · <a className="text-primary underline" href={`/api/v1/knowledge/materials/${resource.id}/versions/${resource.revision}/attachment`}>下载附件</a></p>}
            <MaterialPreview materialId={resource.id} revision={resource.revision} kind={resource.kind} content={currentVersion(resource)?.content} fileName={currentVersion(resource)?.fileName ?? resource.fileName} hasAttachment={currentVersion(resource)?.hasAttachment} />
            <div className="flex flex-wrap gap-2">
              {resource.kind === 'link' && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api(`/api/v1/knowledge/materials/${resource.id}/fetch`, { method: 'POST', body: json({ expectedVersion: resource.revision }) }), '网页快照已保存')}>抓取链接正文快照</Button>}
              <Button type="button" size="sm" variant="outline" onClick={() => onEdit(resource)}>编辑材料</Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => submitCommands([{ kind: 'material.archive', targetId: resource.id, expectedRevision: resource.revision, input: { archived: !resource.archivedAt } }]), resource.archivedAt ? '材料已恢复' : '材料已归档')}>{resource.archivedAt ? '恢复材料' : '归档材料'}</Button>
            </div>
            <div className="space-y-2 border-t pt-3">
              <Textarea aria-label="整理目标" value={purpose} onChange={(event) => setPurpose(event.target.value)} rows={2} />
              <select aria-label="整理方式" className="glass-control h-9 rounded-lg px-3 text-sm" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="external">外部 AI 通过 MCP 整理</option><option value="builtin">使用已配置的内置模型</option></select>
              <Button type="button" size="sm" disabled={busy || !purpose.trim()} onClick={() => void run(async () => { const request = await api<any>('/api/v1/knowledge/organizations', { method: 'POST', body: json({ topicId, purpose, provider, materialIds: [resource.id] }) }); const result = provider === 'builtin' ? await api(`/api/v1/knowledge/organizations/${request.id}/generate`, { method: 'POST', body: '{}' }) : request; setOrganizeResult(result); return result; }, provider === 'builtin' ? '整理建议已生成' : '整理请求已准备')}>整理这份材料</Button>
              {organizeResult?.provider === 'external' && !['proposed', 'completed'].includes(organizeResult.status) && <OrganizationPrompt id={organizeResult.id} purpose={organizeResult.purpose} />}
              {organizeResult?.proposalIds?.length > 0 && <a className="block text-sm text-primary underline" href="#/proposals">检查待确认建议</a>}
            </div>
            <details className="disclosure"><summary className="cursor-pointer text-xs text-muted-foreground">来源与修订历史</summary>{resource.evidence?.map((ref) => <p key={`${ref.type}:${ref.id}`} className="my-2 break-all text-xs">{ref.type} · {ref.id} · 版本 {ref.revision}</p>)}{resource.versions?.map((version) => <div key={version.revision} className="mt-3 border-t pt-2 text-xs"><p>版本 {version.revision} · {version.reason ?? '保存原文'}</p><p className="mt-1 whitespace-pre-wrap">{version.content}</p></div>)}</details>
          </>}
        </article>}
      </div>
      <div className="flex gap-2"><Button type="button" variant="ghost" size="sm" disabled={!cursor} onClick={() => setCursor(Math.max(0, cursor - 40))}>上一页</Button><Button type="button" variant="ghost" size="sm" disabled={list.data?.nextCursor == null} onClick={() => setCursor(list.data?.nextCursor ?? 0)}>下一页</Button></div>
    </div>
  </div>;
}
