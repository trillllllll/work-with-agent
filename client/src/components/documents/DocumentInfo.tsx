import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.js';
import { NativeSelect } from '@/components/ui/native-select.js';
import { Checkbox } from '@/components/ui/checkbox.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { api } from '@/lib/api.js';
import { submitCommands } from '@/lib/platform.js';
import { TaskLinkPicker } from '@/components/library/TaskLinkPicker.js';
import { extractionLabel, formatLocator } from '@/components/library/types.js';
import type { LibraryFolder, LibraryTag, LinkedTask, MaterialDetail, Page } from '@/components/library/types.js';
import { openDocument } from './open.js';
import { DocumentResources } from './DocumentResources.js';
import { isEditorRuntimeActive, useEditorRuntime } from '@/lib/task-editor-runtime.js';

export function DocumentInfo({ resourceId, revision, onOpenTask }: { resourceId: string; revision: number; onOpenTask: (id: string) => void | Promise<void> }) {
  const { t } = useTranslation('library');
  const client = useQueryClient();
  const scope = useEditorRuntime()?.scopeKey;
  const detail = useQuery({ queryKey: ['library', 'material', scope, resourceId], queryFn: ({ signal }) => api<MaterialDetail>(`/api/v1/library/materials/${encodeURIComponent(resourceId)}`, { signal }), enabled: Boolean(scope) });
  const folders = useQuery({ queryKey: ['library', 'folders', scope], queryFn: () => api<{ items: LibraryFolder[] }>('/api/v1/library/folders'), enabled: Boolean(scope) });
  const tags = useQuery({ queryKey: ['library', 'tags', scope], queryFn: () => api<{ items: LibraryTag[] }>('/api/v1/library/tags'), enabled: Boolean(scope) });
  const [cursor, setCursor] = useState(0);
  const tasks = useQuery({ queryKey: ['library', 'document-tasks', scope, resourceId, cursor], queryFn: () => api<Page<LinkedTask>>(`/api/v1/library/materials/${encodeURIComponent(resourceId)}/tasks?cursor=${cursor}&limit=40`), enabled: Boolean(scope) });
  const [folderId, setFolderId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const material = detail.data;
  useEffect(() => { if (material) { setFolderId(material.folderId ?? ''); setTagIds(material.tags.map((tag) => tag.id)); } }, [material?.organizationRevision]);
  const command = async (kind: string, input: Record<string, unknown>) => {
    if (!material || !scope || !isEditorRuntimeActive(scope)) return false;
    try { await submitCommands([{ kind, targetId: resourceId, expectedRevision: material.revision, input }]); await client.invalidateQueries({ queryKey: ['library'] }); return true; }
    catch (error) { toast.error(error instanceof Error ? error.message : t('shared.actionFailed')); return false; }
  };
  return <div className="document-info-content">
    {detail.error && <p role="alert">{detail.error.message}</p>}
    {material && <div className="document-info-section"><p className="library-meta">{extractionLabel(material.extraction.status)}</p>{material.extraction.errors?.map((error, index) => <p key={index} className="library-meta">{formatLocator(error.locator)} {error.message}</p>)}</div>}
    <Disclosure open><DisclosureTrigger>{t('document.usedFiles')}</DisclosureTrigger><DocumentResources key={`${resourceId}:${revision}`} resourceId={resourceId} revision={revision} /></Disclosure>
    <Disclosure open><DisclosureTrigger>{t('libraryPreview.folderAndTags')}</DisclosureTrigger><div className="document-info-section">
      <NativeSelect aria-label={t('libraryPreview.folderLabel')} value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">{t('shared.unfiled')}</option>{folders.data?.items.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</NativeSelect>
      {tags.data?.items.map((tag) => <label key={tag.id} className="flex items-center gap-2 text-sm"><Checkbox checked={tagIds.includes(tag.id)} onChange={(event) => setTagIds((ids) => event.target.checked ? [...ids, tag.id] : ids.filter((id) => id !== tag.id))} />{tag.name}</label>)}
      <Button size="sm" variant="outline" disabled={!material} onClick={() => { void command('material.organize', { expectedOrganizationRevision: material?.organizationRevision, folderId: folderId || null, tagIds }); }}>{t('libraryPreview.saveOrganization')}</Button>
    </div></Disclosure>
    <Disclosure open><DisclosureTrigger>{t('libraryPreview.linkedTasks')}</DisclosureTrigger><div className="document-info-section">
      {tasks.data?.items.map((task) => <div key={task.id} data-testid={`library-linked-task-${task.id}`} className="flex items-start gap-1"><Button size="sm" variant="link" className="min-w-0 flex-1 justify-start whitespace-normal text-left" onClick={() => { void onOpenTask(task.id); }}>{task.title}</Button><Button size="sm" variant="ghost" onClick={() => { void command('material.links', { expectedOrganizationRevision: material?.organizationRevision, addTaskIds: [], removeTaskIds: [task.id], removeInlineReferences: false, expectedTaskRevisions: {} }); }}>{t('shared.unlink')}</Button></div>)}
      <div className="flex flex-wrap gap-1" data-testid="library-linked-tasks-pagination"><span className="w-full library-meta">{t('libraryPreview.taskTotal', { count: tasks.data?.total ?? 0 })}</span><Button size="sm" variant="ghost" disabled={cursor === 0} onClick={() => setCursor(Math.max(0, cursor - 40))}>{t('shared.previousPage')}</Button><Button size="sm" variant="ghost" disabled={tasks.data?.nextCursor == null} onClick={() => setCursor(tasks.data?.nextCursor ?? 0)}>{t('shared.nextPage')}</Button></div>
      <TaskLinkPicker selectedIds={taskIds} onChange={setTaskIds} />
      <Button size="sm" variant="outline" disabled={!taskIds.length} onClick={() => { void command('material.links', { expectedOrganizationRevision: material?.organizationRevision, addTaskIds: taskIds, removeTaskIds: [], removeInlineReferences: false, expectedTaskRevisions: {} }).then((saved) => { if (saved) setTaskIds([]); }); }}>{t('libraryPreview.linkSelected')}</Button>
    </div></Disclosure>
    <Disclosure open><DisclosureTrigger>{t('document.history')}</DisclosureTrigger><div className="document-info-section">
      {material?.versions.map((version) => <Button key={version.revision} size="sm" variant="ghost" className="justify-start" onClick={() => openDocument({ resourceId, revision: version.revision })}>{t('libraryPreview.version', { revision: version.revision })}<span className="ml-2 library-meta">{new Date(version.createdAt).toLocaleString()}</span></Button>)}
    </div></Disclosure>
  </div>;
}
