import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { GraduationCap, Plus, Pencil, Trash2, Maximize, List, Network, FolderCog } from 'lucide-react';
import { api } from '@/lib/api.js';
import { askAssistant, contextLabel, usePageContext } from '@/lib/assistant-context.js';
import { submitCommands, usePlatformAction, type Command } from '@/lib/platform.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';
import { useMediaQuery } from '@/hooks/useMediaQuery.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { FormDialog } from '@/components/dialogs/FormDialog.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import type { ViewState, ChartCommand } from './MapChart.js';
import { LearningOutline } from './LearningOutline.js';
import { LearningNote } from './LearningNote.js';
import { MasteryLegend } from './MasteryDisplay.js';
import { descendants, flattenTree, masterySummary, type LearningMap, type LearningMapAggregate, type LearningMapSummary, type LearningNode } from './learning-model.js';
import './learning.css';
const MapChart = lazy(() => import('./MapChart.js').then(module => ({ default: module.MapChart })));

type Form = { kind: 'map' | 'node'; map?: LearningMap; node?: LearningNode };
type Removal = { title: string; count: number; command: Command };
export function LearningMapPage({ onAskAssistant }: { onAskAssistant?: () => boolean | void }) {
  const { t } = useTranslation('learning');
  const { resolvedTheme } = useTheme();
  const mobile = useMediaQuery('(max-width: 767px)');
  const runtime = useEditorRuntime();
  const tabScope = useRef(crypto.randomUUID());
  const action = usePlatformAction({ undo: false });
  const mapsQuery = useQuery({ queryKey: ['learning-maps'], queryFn: () => api<{ maps: LearningMapSummary[] }>('/api/v1/learning/maps') });
  const maps = mapsQuery.data?.maps ?? [];
  const [selectedMapId, setSelectedMapId] = useState('');
  const activeMapId = maps.some(map => map.id === selectedMapId) ? selectedMapId : maps[0]?.id ?? '';
  const mapQuery = useQuery({ queryKey: ['learning-map', activeMapId], enabled: Boolean(activeMapId), queryFn: () => api<LearningMapAggregate>(`/api/v1/learning/maps/${encodeURIComponent(activeMapId)}`) });
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [outline, setOutline] = useState<boolean | null>(null);
  const showOutline = outline ?? mobile;
  const [focusId, setFocusId] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const views = useRef<Record<string, ViewState>>({});
  const [command, setCommand] = useState<ChartCommand>({ kind: 'fit', counter: 0 });
  const nodes = useMemo(() => flattenTree(mapQuery.data?.tree ?? []), [mapQuery.data]);
  const selectedNode = nodes.find(node => node.id === selectedNodeId && node.kind === 'item');
  const map = mapQuery.data?.map;
  const groups = nodes.filter(node => node.kind === 'topic');
  const summary = masterySummary(nodes);
  usePageContext('learning', { pageState: { selectedId: selectedNode?.id } });
  function selectMap(id: string) { setSelectedMapId(id); setSelectedNodeId(''); setFocusId(''); }
  function deleteNode(node: LearningNode) {
    const children = descendants(nodes,node.id);
    setRemoval({ title: node.title, count: children.length, command: { kind: 'learning.node.archive', targetId: node.id, expectedRevision: node.revision, input: { cascade: true, expectedDescendantRevisions: Object.fromEntries(children.map(child => [child.id,child.revision])) } } });
  }
  function deleteMap() {
    if (!map) return;
    setRemoval({ title: map.title, count: nodes.length, command: { kind: 'learning.map.archive', targetId: map.id, expectedRevision: map.revision, input: { expectedNodeRevisions: Object.fromEntries(nodes.map(node => [node.id,node.revision])) } } });
  }
  function attachMap() {
    if (!map || onAskAssistant?.() === false) return;
    askAssistant({ kind: 'draft', title: contextLabel(map.title), text: `${map.title}\n${map.goal}`, learningMapId: map.id, learningRevision: map.revision, unsaved: false });
  }
  const removalRequest = useRef<{ removal: Removal; id: string } | null>(null);
  async function confirmRemoval() {
    if (!removal) return;
    if (removalRequest.current?.removal !== removal) removalRequest.current = { removal, id: crypto.randomUUID() };
    const result = await action.run(() => submitCommands([removal.command],removalRequest.current!.id), t('deleted'));
    if (result?.status === 'applied') { setRemoval(null); setSelectedNodeId(''); }
  }
  const dialogs = <>
    {form && <LearningForm form={form} mapId={activeMapId} nodes={nodes} onClose={() => setForm(null)} onSaved={(id,kind) => { if (kind === 'map') selectMap(id); else if (kind === 'item') setSelectedNodeId(id); setForm(null); }} onDelete={node => { setForm(null); deleteNode(node); }} />}
    {removal && <ConfirmDialog title={t('delete')} itemName={removal.title} description={t('deleteHint', { count: removal.count })} busy={action.busy} onCancel={() => setRemoval(null)} onConfirm={() => void confirmRemoval()} />}
  </>;
  if (mapsQuery.isLoading) return <div className="p-5"><Skeleton className="h-10 w-56" /><Skeleton className="mt-4 h-80 w-full" /></div>;
  if (mapsQuery.isError) return <div className="p-5"><p role="alert">{t('loadFailed')}</p><Button onClick={() => void mapsQuery.refetch()}>{t('retry')}</Button></div>;
  return <div className="learning-page flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6">
    {selectedNode && map ? <LearningNote key={`${runtime?.scopeKey}:${selectedNode.id}`} node={selectedNode} map={map} scope={runtime?.scopeKey ?? tabScope.current} onBack={() => setSelectedNodeId('')} onDelete={() => deleteNode(selectedNode)} onAskAssistant={onAskAssistant} /> : <>
      <header className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><h1 className="text-xl font-semibold">{t('title')}</h1><p className="mt-1 hidden text-xs text-muted-foreground sm:block">{t('subtitle')}</p></div>
        <Button variant="outline" className="min-h-11 max-sm:size-11 max-sm:p-0" aria-label={t('askAssistant')} onClick={() => onAskAssistant?.()}><GraduationCap /><span className="hidden sm:inline">{t('askAssistant')}</span></Button>
        <Button className="min-h-11" onClick={() => setForm({ kind: 'map' })}><Plus />{t('newMap')}</Button>
      </header>
      {!maps.length ? <div className="flex min-h-72 flex-col items-center justify-center gap-3 rounded-xl border p-6 text-center"><Network className="size-9 text-muted-foreground" /><h2 className="text-lg font-medium">{t('empty.title')}</h2><p className="max-w-md text-sm text-muted-foreground">{t('empty.hint')}</p></div> : <>
        <div className="flex flex-wrap items-center gap-2 border-b pb-3">
          <Select value={activeMapId} onValueChange={selectMap}><SelectTrigger className="min-h-11 w-[calc(100%_-_104px)] sm:w-64" aria-label={t('selectMap')}><SelectValue /></SelectTrigger><SelectContent>{maps.map(item => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent></Select>
          <Button variant="ghost" className="min-h-11" disabled={!map} aria-label={t('editMap')} onClick={() => setForm({ kind: 'map', map })}><Pencil /><span className="hidden sm:inline">{t('editMap')}</span></Button>
          <Button variant="ghost" className="min-h-11" disabled={!map} aria-label={t('deleteMap')} onClick={deleteMap}><Trash2 /><span className="hidden sm:inline">{t('deleteMap')}</span></Button>
          <div className="flex-1" /><Button variant="outline" className="min-h-11" disabled={!map} onClick={() => setForm({ kind: 'node' })}><Plus />{t('newNode')}</Button>
        </div>
        {map?.goal && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{map.goal}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3"><MasteryLegend /><span className="text-xs text-muted-foreground">{t('progress', summary)}</span></div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={showOutline ? 'secondary' : 'ghost'} className="min-h-11" onClick={() => setOutline(true)} aria-pressed={showOutline}><List />{t('outline')}</Button>
          <Button variant={!showOutline ? 'secondary' : 'ghost'} className="min-h-11" onClick={() => setOutline(false)} aria-pressed={!showOutline}><Network />{t('mapView')}</Button>
          {!showOutline && <><Button variant="ghost" className="min-h-11" onClick={() => setCommand(c => ({ kind: 'fit', counter: c.counter + 1 }))}><Maximize />{t('fit')}</Button><Button variant="ghost" className="min-h-11" onClick={() => setCommand(c => ({ kind: 'expand', counter: c.counter + 1 }))}>{t('expand')}</Button><Button variant="ghost" className="min-h-11" onClick={() => setCommand(c => ({ kind: 'collapse', counter: c.counter + 1 }))}>{t('collapse')}</Button></>}
          {!showOutline && groups.length > 0 && <Select value={groups.some(group => group.id === focusId) ? focusId : mobile ? groups[0].id : 'all'} onValueChange={id => setFocusId(id === 'all' ? '' : id)}><SelectTrigger className="min-h-11 w-full sm:w-52" aria-label={t('focusGroup')}><SelectValue /></SelectTrigger><SelectContent>{!mobile && <SelectItem value="all">{t('allGroups')}</SelectItem>}{groups.map(group => <SelectItem key={group.id} value={group.id}>{group.title}</SelectItem>)}</SelectContent></Select>}
          {groups.length > 0 && !showOutline && <Button variant="ghost" className="hidden min-h-11 sm:inline-flex" onClick={() => setOutline(true)}><FolderCog />{t('manageGroups')}</Button>}
        </div>
        {mapQuery.isLoading ? <Skeleton className="h-80 w-full" /> : mapQuery.isError ? <div role="alert"><p>{t('loadFailed')}</p><Button onClick={() => void mapQuery.refetch()}>{t('retry')}</Button></div> : !nodes.length ? <p className="rounded-xl border p-8 text-center text-sm text-muted-foreground">{t('chart.empty')}</p> : <div className="min-w-0 rounded-xl border bg-card p-1 sm:p-3">
          {showOutline ? <LearningOutline key={activeMapId} nodes={nodes} onOpen={setSelectedNodeId} onEditGroup={node => setForm({ kind: 'node',node })} /> : map && <Suspense fallback={<Skeleton className="h-80 w-full" />}><MapChart map={map} nodes={nodes} dark={resolvedTheme === 'dark'} views={views} command={command} mobile={mobile} focusId={groups.some(group => group.id === focusId) ? focusId : mobile ? groups[0]?.id : undefined} onOpen={setSelectedNodeId} /></Suspense>}
        </div>}
        <footer className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span>{t(showOutline ? 'outlineHint' : 'chartHint')}</span><Button variant="ghost" className="min-h-11" disabled={!map} onClick={attachMap}>{t('addMapContext')}</Button></footer>
      </>}
    </>}
    {dialogs}
  </div>;
}

function LearningForm({ form, mapId, nodes, onClose, onSaved, onDelete }: { form: Form; mapId: string; nodes: LearningNode[]; onClose: () => void; onSaved: (id: string,kind: string) => void; onDelete: (node: LearningNode) => void }) {
  const { t } = useTranslation('learning');
  const action = usePlatformAction({ undo: false });
  const [title, setTitle] = useState(form.map?.title ?? form.node?.title ?? '');
  const [goal, setGoal] = useState(form.map?.goal ?? '');
  const [kind, setKind] = useState(form.node?.kind ?? 'item');
  const [parentId, setParentId] = useState(form.node?.parentId ?? 'root');
  const requests = useRef(new Map<string,string>());
  const excluded = new Set(form.node ? [form.node.id,...descendants(nodes,form.node.id).map(node => node.id)] : []);
  const parents = nodes.filter(node => node.kind === 'topic' && !excluded.has(node.id));
  async function save() {
    const commands: Command[] = form.kind === 'map' ? [{ kind: form.map ? 'learning.map.update' : 'learning.map.create', ...(form.map ? { targetId: form.map.id, expectedRevision: form.map.revision } : {}), input: { title: title.trim(), goal } }] : form.node ? [
      { kind: 'learning.node.update', targetId: form.node.id, expectedRevision: form.node.revision, input: { title: title.trim() } },
      ...(parentId !== (form.node.parentId ?? 'root') ? [{ kind: 'learning.node.move', targetId: form.node.id, expectedRevision: form.node.revision + 1, input: { parentId: parentId === 'root' ? null : parentId } }] : []),
    ] : [{ kind: 'learning.node.create', input: { mapId, parentId: parentId === 'root' ? null : parentId, kind, title: title.trim(), detail: '', sortOrder: nodes.filter(node => node.parentId === (parentId === 'root' ? null : parentId)).length } }];
    const snapshot = JSON.stringify(commands);
    if (!requests.current.has(snapshot)) requests.current.set(snapshot,crypto.randomUUID());
    const result = await action.run(() => submitCommands(commands, requests.current.get(snapshot)),t('saved'));
    if (result?.status === 'applied') onSaved(String(result.results?.[0]?.id ?? form.map?.id ?? form.node?.id ?? ''),form.kind === 'map' ? 'map' : kind);
  }
  return <FormDialog title={t(form.kind === 'map' ? form.map ? 'editMap' : 'newMap' : form.node ? 'editGroup' : 'newNode')} onClose={() => { if (!action.busy) onClose(); }}><form className="space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
    <label className="block space-y-2 text-sm"><span>{t('name')}</span><Input autoFocus aria-label={t('name')} required maxLength={form.kind === 'map' ? 200 : 300} value={title} disabled={action.busy} onChange={event => setTitle(event.target.value)} /></label>
    {form.kind === 'map' ? <label className="block space-y-2 text-sm"><span>{t('goal')}</span><Textarea aria-label={t('goal')} rows={3} maxLength={2000} value={goal} disabled={action.busy} onChange={event => setGoal(event.target.value)} /></label> : <>
      {!form.node && <div className="space-y-2 text-sm"><label htmlFor="learning-node-kind">{t('nodeKind')}</label><Select value={kind} onValueChange={setKind} disabled={action.busy}><SelectTrigger id="learning-node-kind" aria-label={t('nodeKind')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="item">{t('kind.item')}</SelectItem><SelectItem value="topic">{t('kind.topic')}</SelectItem></SelectContent></Select></div>}
      <div className="space-y-2 text-sm"><label htmlFor="learning-node-parent">{t('parent')}</label><Select value={parentId} onValueChange={setParentId} disabled={action.busy}><SelectTrigger id="learning-node-parent" aria-label={t('parent')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="root">{t('root')}</SelectItem>{parents.map(node => <SelectItem key={node.id} value={node.id}>{node.title}</SelectItem>)}</SelectContent></Select></div>
    </>}
    <div className="flex justify-end gap-2 border-t pt-4">{form.node && <Button type="button" variant="ghost" className="mr-auto text-destructive" disabled={action.busy} onClick={() => onDelete(form.node!)}>{t('deleteGroup')}</Button>}<Button type="button" variant="outline" disabled={action.busy} onClick={onClose}>{t('cancel')}</Button><Button type="submit" disabled={action.busy || !title.trim()}>{action.busy ? t('saving') : t('save')}</Button></div>
  </form></FormDialog>;
}
