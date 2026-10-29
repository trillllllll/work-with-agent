import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { NativeSelect } from '@/components/ui/native-select.js';
import { TableRow } from '@/components/ui/table-row.js';
import { api } from '@/lib/api.js';
import { materialTypeLabel, startOfLocalWeek } from '@/lib/attachment-title.js';
import { enqueueUploads, filesFromTransfer } from '@/components/library/upload.js';
import { kindLabel, materialKinds } from '@/components/library/types.js';
import { openDocument } from '@/components/documents/open.js';

type MaterialRow = { id: string; title: string; kind: string; revision: number; updatedAt?: string; archivedAt?: string | null; taskId?: string | null; taskTitle?: string | null; fileName?: string | null; mimeType?: string | null };
type PageResult = { items: MaterialRow[]; total: number; nextCursor: number | null };
type View = 'all' | 'week' | 'linked' | 'archived';
type Sort = 'title' | 'kind' | 'updatedAt';

/** Keeps the list context; all document editing and reading has one destination. */
export function MaterialBrowser({ topicId, taskId, onCreate, onEdit, children }: { topicId: string | null; taskId?: string; onCreate: () => void; onEdit: (resource: MaterialRow) => void; children?: ReactNode }) {
  const { t } = useTranslation('workspace');
  const client = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>('all');
  const [kind, setKind] = useState('');
  const [sort, setSort] = useState<Sort>('updatedAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [cursor, setCursor] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const params = new URLSearchParams({ topicId: topicId || 'inbox', cursor: String(cursor), sort, dir });
  if (taskId) params.set('taskId', taskId);
  if (view === 'archived') params.set('archived', 'only');
  if (view === 'linked') params.set('linked', 'task');
  if (view === 'week') params.set('since', startOfLocalWeek());
  if (kind) params.set('kind', kind);
  const query = useQuery({ queryKey: ['knowledge', 'materials', params.toString()], queryFn: () => api<PageResult>(`/api/v1/knowledge/materials?${params}`) });
  const upload = async (files: Array<{ file: File; relativePath: string }>) => {
    if (!files.length || importing) return;
    setImporting(true);
    try { await enqueueUploads(files, { topicId, folderId: null, taskIds: taskId ? [taskId] : [] }); await client.invalidateQueries({ queryKey: ['knowledge', 'materials'] }); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('materials.importFailed')); }
    finally { setImporting(false); }
  };
  const drop = async (event: DragEvent) => { event.preventDefault(); setDragging(false); await upload(await filesFromTransfer(event.dataTransfer)); };
  const toggleSort = (next: Sort) => { setCursor(0); if (sort === next) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(next); setDir(next === 'updatedAt' ? 'desc' : 'asc'); } };
  return <div className="min-w-0 space-y-3">
    <div className="ctx-sheet-bar">
      <div role="group" aria-label={t('materials.navAria')} className="ctx-actions">{(['all', 'week', 'linked', 'archived'] as View[]).filter((value) => value !== 'linked' || !taskId).map((value) => <Button variant="outline" key={value} type="button" className="ctx-btn" aria-pressed={view === value} onClick={() => { setView(value); setCursor(0); }}>{t(`materials.views.${value}`)}</Button>)}</div>
      <NativeSelect aria-label={t('materials.kindFilterAria')} className="ctx-select" value={kind} onChange={(event) => { setKind(event.target.value); setCursor(0); }}><option value="">{t('materials.allKinds')}</option>{materialKinds.map((value) => <option key={value} value={value}>{kindLabel(value)}</option>)}</NativeSelect>
      <div className="ctx-sheet-end"><Input ref={file} className="sr-only" type="file" multiple aria-label={t('materials.importAria')} onChange={(event) => { void upload([...event.target.files ?? []].map((item) => ({ file: item, relativePath: item.name }))); event.target.value = ''; }} /><Button variant="outline" className="ctx-btn" onClick={onCreate}>{t('library:document.new')}</Button><Button className="ctx-btn ctx-btn-primary" disabled={importing} onClick={() => file.current?.click()}>{t('materials.import')}</Button></div>
    </div>
    {children}
    {query.error && <p role="alert" className="ctx-error">{query.error.message}</p>}
    <div className={`ctx-table-wrap ${dragging ? 'ring-2 ring-primary' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { void drop(event); }}>
      <table className="ctx-table" aria-label={t('materials.tableAria')}><thead><TableRow>{(['title', 'kind', 'updatedAt'] as Sort[]).map((key) => <th key={key} aria-sort={sort === key ? dir === 'asc' ? 'ascending' : 'descending' : 'none'}><Button variant="outline" size="bare" className="ctx-btn" onClick={() => toggleSort(key)}>{t(`materials.columns.${key}`)}{sort === key ? dir === 'asc' ? ' ↑' : ' ↓' : ''}</Button></th>)}{!taskId && <th>{t('materials.linkedColumn')}</th>}</TableRow></thead>
        <tbody>{!query.isLoading && !query.data?.items.length && <TableRow><td colSpan={taskId ? 3 : 4}>{t('materials.empty')}</td></TableRow>}{query.data?.items.map((item) => <TableRow key={item.id}><td><Button variant="link" size="bare" className="ctx-name-link" onClick={() => onEdit ? onEdit(item) : openDocument({ resourceId: item.id, title: item.title })}>{item.title}</Button></td><td>{item.kind === 'document' ? kindLabel('document') : materialTypeLabel(item.kind, item.fileName)}</td><td>{item.updatedAt ? new Date(item.updatedAt).toLocaleString() : ''}</td>{!taskId && <td>{item.taskTitle ?? ''}</td>}</TableRow>)}</tbody>
      </table>
    </div>
    <div className="ctx-actions"><Button variant="outline" className="ctx-btn" disabled={!cursor} onClick={() => setCursor(Math.max(0, cursor - 40))}>{t('materials.previousPage')}</Button><Button variant="outline" className="ctx-btn" disabled={query.data?.nextCursor == null} onClick={() => setCursor(query.data?.nextCursor ?? 0)}>{t('materials.nextPage')}</Button></div>
  </div>;
}
