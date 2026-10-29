import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { GraduationCap, Plus, Maximize, List, Network, Ellipsis, Search, ArrowLeft, ArrowRight, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api.js';
import { askAssistant, contextLabel, usePageContext } from '@/lib/assistant-context.js';
import { submitCommands, usePlatformAction, type Command } from '@/lib/platform.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';
import { useMediaQuery } from '@/hooks/useMediaQuery.js';
import { learningKey, learningWrite, useLearningCapabilities, type LearningSearchView, type PracticeMode } from '@/lib/learning-api.js';
import { learningHash, learningNodePath, readLearningLocation, type LearningLocation } from '@/lib/learning-navigation.js';
import { readLearningPreference, writeLearningPreference } from '@/lib/learning-storage.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { ActionMenu, ActionMenuItem } from '@/components/ui/action-menu.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { FormDialog } from '@/components/dialogs/FormDialog.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import type { ViewState, ChartCommand } from './MapChart.js';
import { LearningOutline } from './LearningOutline.js';
import { LearningNote } from './LearningNote.js';
import { MasteryLegend, MasteryBadge } from './MasteryDisplay.js';
import { LearningHomeSummary } from './LearningHomeSummary.js';
import { PracticeSetup } from './PracticeSetup.js';
import { PracticeSessionView } from './PracticeSessionView.js';
import { ReviewQueue } from './ReviewQueue.js';
import { LearningTimeline } from './LearningTimeline.js';
import { descendants, flattenTree, learningRecommendations, masterySummary, masteryStates, type LearningMap, type LearningMapAggregate, type LearningMapSummary, type LearningNode } from './learning-model.js';
import './learning.css';
const MapChart = lazy(() => import('./MapChart.js').then(module => ({ default: module.MapChart })));

type Form = { kind: 'map' | 'node'; map?: LearningMap; node?: LearningNode };
type Removal = { title: string; count: number; command: Command };
type Setup = { mapId:string; nodeIds?:string[]; mode?:PracticeMode; jobId?:string };
export function LearningMapPage({ onAskAssistant }: { onAskAssistant?: () => boolean | void }) {
  const runtime=useEditorRuntime();
  if(!runtime)return <div className="p-5"><Skeleton className="h-12 w-full"/></div>;
  return <LearningPageContent key={runtime.scopeKey} scope={runtime.scopeKey} onAskAssistant={onAskAssistant}/>;
}
function LearningPageContent({scope,onAskAssistant}:{scope:string;onAskAssistant?:()=>boolean|void}) {
  const { t } = useTranslation('learning');
  const { resolvedTheme } = useTheme();
  const mobile = useMediaQuery('(max-width: 767px)');
  const action = usePlatformAction({ undo: false });
  const client=useQueryClient();
  const { overview, unsupported } = useLearningCapabilities(scope);
  const workflowEnabled = !unsupported;
  const root=useRef<HTMLDivElement>(null);
  const [location,setLocation]=useState<LearningLocation>(()=>{
    const requested=readLearningLocation(window.location.hash);
    return requested.mapId||requested.nodeId||requested.sessionId||requested.tab!=='note'?requested:readLearningPreference(scope,'location',requested);
  });
  const locationRef=useRef(location);locationRef.current=location;
  const internalHash=useRef<string|null>(null);
  const scrollRestore=useRef<{key:string;top:number}|null>(null);
  const mapsQuery = useQuery({ queryKey: ['learning-maps',scope], queryFn: () => api<{ maps: LearningMapSummary[] }>('/api/v1/learning/maps') });
  const maps = mapsQuery.data?.maps ?? [];
  const activeMapId = maps.some(map => map.id === location.mapId) ? location.mapId : maps[0]?.id ?? '';
  const mapQuery = useQuery({ queryKey: ['learning-map', activeMapId,scope], enabled: Boolean(activeMapId)&&(!location.sessionId||unsupported), queryFn: () => api<LearningMapAggregate>(`/api/v1/learning/maps/${encodeURIComponent(activeMapId)}`) });
  const [outline, setOutline] = useState<boolean | null>(()=>readLearningPreference(scope,'outline',null));
  const showOutline = outline ?? mobile;
  const [focusId, setFocusId] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [setup,setSetup]=useState<Setup|null>(null);
  const [menu,setMenu]=useState(false);
  const [notice,setNotice]=useState('');
  const [collapsed,setCollapsed]=useState<Record<string,Record<string,boolean>>>(()=>readLearningPreference(scope,'collapsed',{}));
  const views = useRef<Record<string, ViewState>>(readLearningPreference(scope,'chart-views',{}));
  const [command, setCommand] = useState<ChartCommand>({ kind: 'fit', counter: 0 });
  const nodes = useMemo(() => flattenTree(mapQuery.data?.tree ?? []), [mapQuery.data]);
  const selectedNode = nodes.find(node => node.id === location.nodeId && node.kind === 'item');
  const map = mapQuery.data?.map;
  const groups = nodes.filter(node => node.kind === 'topic');
  const summary = masterySummary(nodes);
  const [search,setSearch]=useState('');const [term,setTerm]=useState('');const [filter,setFilter]=useState('all');const [allMaps,setAllMaps]=useState(false);
  useEffect(()=>{const timer=setTimeout(()=>setTerm(search.trim()),250);return()=>clearTimeout(timer);},[search]);
  const searching=workflowEnabled&&Boolean(term||filter!=='all');
  const results=useInfiniteQuery({queryKey:learningKey(scope,'search',allMaps?'all':activeMapId,term,filter),enabled:searching&&Boolean(activeMapId),initialPageParam:'',queryFn:({pageParam})=>api<LearningSearchView>(`/api/v1/learning/search?${new URLSearchParams({q:term,...(!allMaps?{mapId:activeMapId}:{}),...(filter!=='all'?{status:filter}:{}),...(pageParam?{cursor:pageParam}:{})})}`),getNextPageParam:last=>last.nextCursor??undefined});
  const found=results.data?.pages.flatMap(page=>page.items)??[];
  const orderedItems=searching?found:nodes.filter(node=>node.kind==='item').map(node=>({id:node.id,mapId:activeMapId}));
  const index=orderedItems.findIndex(node=>node.id===selectedNode?.id);
  const recommendations=selectedNode?learningRecommendations(nodes,selectedNode):[];
  usePageContext('learning', { pageState: { selectedId: location.sessionId?undefined:selectedNode?.id } });
  function rememberScroll(){const main=root.current?.closest('main');if(main&&!scrollRestore.current)writeLearningPreference(scope,`scroll:${learningHash(locationRef.current)}`,main.scrollTop);writeLearningPreference(scope,'chart-views',views.current);}
  function prepareScroll(next:LearningLocation){const key=learningHash(next);scrollRestore.current={key,top:readLearningPreference(scope,`scroll:${key}`,0)};}
  function navigate(next:LearningLocation,replace=false){if(learningHash(next)===learningHash(locationRef.current))return;rememberScroll();prepareScroll(next);setLocation(next);writeLearningPreference(scope,'location',next);const hash=learningHash(next);if(replace){history.replaceState(null,'',`${window.location.pathname}${window.location.search}${hash}`);}else if(window.location.hash!==hash){internalHash.current=hash;window.location.hash=hash;}}
  useEffect(()=>{const previous=history.scrollRestoration;history.scrollRestoration='manual';return()=>{history.scrollRestoration=previous;};},[]);
  useEffect(()=>{const listener=(event:HashChangeEvent)=>{const hash=window.location.hash;if(new URL(event.newURL).hash!==hash)return;if(internalHash.current===hash){internalHash.current=null;return;}if(!/^#\/?learning(?:\?|$)/.test(hash))return;rememberScroll();const next=readLearningLocation(hash);prepareScroll(next);setLocation(next);writeLearningPreference(scope,'location',next);};window.addEventListener('hashchange',listener);window.addEventListener('pagehide',rememberScroll);return()=>{window.removeEventListener('hashchange',listener);window.removeEventListener('pagehide',rememberScroll);};},[scope]);
  useEffect(()=>{const main=root.current?.closest('main');if(!main)return;let timer:number|undefined;
    const scroll=()=>{if(scrollRestore.current)return;if(timer!==undefined)clearTimeout(timer);const key=learningHash(locationRef.current),top=main.scrollTop;timer=window.setTimeout(()=>writeLearningPreference(scope,`scroll:${key}`,top),120);};
    main.addEventListener('scroll',scroll,{passive:true});return()=>{main.removeEventListener('scroll',scroll);if(timer!==undefined)clearTimeout(timer);rememberScroll();};
  },[scope,mapsQuery.isSuccess,location.sessionId]);
  useLayoutEffect(()=>{const main=root.current?.closest('main');if(!main)return;const key=learningHash(location);const target=scrollRestore.current?.key===key?scrollRestore.current:{key,top:readLearningPreference(scope,`scroll:${key}`,0)};scrollRestore.current=target;
    // Capture the target before delayed scroll events from the previous view.
    // Keep those events from being recorded under the newly selected view.
    main.scrollTop=target.top;let second:number|undefined;const first=requestAnimationFrame(()=>{main.scrollTop=target.top;second=requestAnimationFrame(()=>{if(scrollRestore.current===target)scrollRestore.current=null;});});
    return()=>{cancelAnimationFrame(first);if(second!==undefined)cancelAnimationFrame(second);};
  },[location.nodeId,location.sessionId,location.tab,location.mapId,mapQuery.isSuccess,mapsQuery.isSuccess]);
  useEffect(()=>{writeLearningPreference(scope,'collapsed',collapsed);},[collapsed,scope]);
  useEffect(()=>{writeLearningPreference(scope,'outline',outline);},[outline,scope]);
  useEffect(()=>{if(location.nodeId&&mapQuery.isSuccess&&!selectedNode&&!location.sessionId){setNotice(t('workflow.nodeUnavailable'));navigate({...location,mapId:activeMapId,nodeId:''},true);}},[location.nodeId,mapQuery.isSuccess,selectedNode,location.sessionId,activeMapId]);
  function openNode(mapId:string,nodeId:string){navigate({mapId,nodeId,sessionId:'',tab:'note'});}
  function openSession(id:string){writeLearningPreference(scope,`session-return:${id}`,{...locationRef.current,sessionId:''});navigate({...location,sessionId:id,tab:'practice'});}
  function returnFromSession(mapId?:string){const origin=readLearningPreference<LearningLocation|null>(scope,`session-return:${location.sessionId}`,null);navigate(origin??{mapId:mapId??activeMapId,nodeId:!mapId||mapId===location.mapId?location.nodeId:'',sessionId:'',tab:'note'});}
  function selectMap(id:string){navigate({mapId:id,nodeId:'',sessionId:'',tab:'note'});setFocusId('');}
  function setTab(tab:string){navigate({...location,mapId:activeMapId,tab});}
  async function startNode(nodeId:string){try{await learningWrite('/resume',{requestId:crypto.randomUUID(),nodeId,reason:'start'});void client.invalidateQueries({queryKey:learningKey(scope,'overview')});}catch(error){toast.error(error instanceof Error?error.message:t('workflow.failed'));}}
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
    if (result?.status === 'applied') { setRemoval(null);navigate({mapId:activeMapId,nodeId:'',sessionId:'',tab:'note'}); }
  }
  const addReviewRequest=useRef<{nodeId:string;requestId:string}|null>(null);
  async function addReview(){if(!selectedNode)return;if(addReviewRequest.current?.nodeId!==selectedNode.id)addReviewRequest.current={nodeId:selectedNode.id,requestId:crypto.randomUUID()};try{await learningWrite('/reviews/update',{...addReviewRequest.current,mapId:activeMapId});toast.success(t('workflow.reviews.added'));setTab('reviews');void client.invalidateQueries({queryKey:learningKey(scope,'reviews')});}catch(error){if(error instanceof ApiError&&error.code==='REVIEW_EXISTS'){setTab('reviews');return;}toast.error(error instanceof Error?error.message:t('workflow.failed'));}}
  const viewTab = unsupported ? 'note' : location.tab;
  const capabilityNotice = unsupported && <div role="status" className="space-y-2 rounded-lg border p-3 text-sm" data-testid="learning-unsupported"><p>{t('workflow.unsupported')}</p><Button variant="outline" disabled={overview.isFetching} onClick={()=>void overview.refetch()}>{t('workflow.checkSupport')}</Button></div>;
  const dialogs = <>
    {form && <LearningForm form={form} mapId={activeMapId} nodes={nodes} onClose={() => setForm(null)} onSaved={(id,kind) => { if (kind === 'map') selectMap(id); else if (kind === 'item') openNode(activeMapId,id); setForm(null); }} onDelete={node => { setForm(null); deleteNode(node); }} />}
    {removal && <ConfirmDialog title={t('delete')} itemName={removal.title} description={t('deleteHint', { count: removal.count })} busy={action.busy} onCancel={() => setRemoval(null)} onConfirm={() => void confirmRemoval()} />}
    {setup&&<PracticeSetup key={`${setup.mapId}:${setup.jobId??setup.nodeIds?.join(',')??'all'}`} scope={scope} mapId={setup.mapId} nodeIds={setup.nodeIds} scopeLabel={setup.nodeIds?.length?nodes.filter(node=>setup.nodeIds!.includes(node.id)).map(node=>node.title).join(' · '):maps.find(item=>item.id===setup.mapId)?.title} initialMode={setup.mode} initialJobId={setup.jobId} onClose={()=>setSetup(null)} onStarted={id=>{setSetup(null);openSession(id);}}/>}
  </>;
  if(location.sessionId&&unsupported)return <div ref={root} className="learning-page space-y-4 p-4 sm:p-6">{capabilityNotice}<Button variant="outline" onClick={()=>returnFromSession()}><ArrowLeft/>{t('back')}</Button>{dialogs}</div>;
  if(location.sessionId)return <div ref={root} className="learning-page p-4 sm:p-6"><PracticeSessionView scope={scope} sessionId={location.sessionId} onBack={returnFromSession} onAskAssistant={onAskAssistant} onAgain={mapId=>setSetup({mapId})}/>{dialogs}</div>;
  if (mapsQuery.isLoading) return <div className="p-5"><Skeleton className="h-10 w-56" /><Skeleton className="mt-4 h-80 w-full" /></div>;
  if (mapsQuery.isError) return <div className="p-5"><p role="alert">{t('loadFailed')}</p><Button onClick={() => void mapsQuery.refetch()}>{t('retry')}</Button></div>;
  return <div ref={root} className="learning-page flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6">
    {capabilityNotice}
    {notice&&<p role="status" className="rounded-lg border p-3 text-sm">{notice}</p>}
    {selectedNode&&map?<section className="space-y-4" data-testid="learning-workspace">
      <nav className="flex flex-wrap items-center gap-2" aria-label={t('workflow.workspaceTabs')}><Button variant="ghost" className="min-h-11" onClick={()=>navigate({mapId:activeMapId,nodeId:'',sessionId:'',tab:'note'})}><ArrowLeft/>{t('back')}</Button>{(['note','practice','records','reviews'] as const).map(tab=><Button key={tab} variant={viewTab===tab?'secondary':'ghost'} className="min-h-11" disabled={!workflowEnabled&&tab!=='note'} aria-pressed={viewTab===tab} onClick={()=>setTab(tab)}>{t(`workflow.tabs.${tab}`)}</Button>)}</nav>
      <div className="flex flex-wrap items-center justify-between gap-2"><Button variant="ghost" className="min-h-11" disabled={index<=0} onClick={()=>openNode(orderedItems[index-1].mapId,orderedItems[index-1].id)}><ArrowLeft/>{t('workflow.previous')}</Button><Button variant="ghost" className="min-h-11" disabled={index<0||index>=orderedItems.length-1} onClick={()=>openNode(orderedItems[index+1].mapId,orderedItems[index+1].id)}>{t('workflow.next')}<ArrowRight/></Button></div>
      {viewTab==='records'?<LearningTimeline scope={scope} mapId={activeMapId} nodeId={selectedNode.id} onSession={openSession}/>:viewTab==='reviews'?<ReviewQueue scope={scope} mapId={activeMapId} nodeId={selectedNode.id} onNode={openNode} onPractice={(mapId,nodeId)=>setSetup({mapId,nodeIds:[nodeId],mode:'review'})}/>:viewTab==='practice'?<div className="space-y-4 rounded-xl border p-5"><h2 className="text-lg font-semibold">{selectedNode.title}</h2><p className="text-sm text-muted-foreground">{t('workflow.practice.startHint')}</p><div className="flex flex-wrap gap-2"><Button className="min-h-11" onClick={()=>setSetup({mapId:activeMapId,nodeIds:[selectedNode.id]})}>{t('workflow.startPractice')}</Button><Button variant="outline" className="min-h-11" onClick={()=>setSetup({mapId:activeMapId,nodeIds:[selectedNode.id],mode:'wrong'})}>{t('workflow.modes.wrong')}</Button><Button variant="outline" className="min-h-11" onClick={()=>void addReview()}><RotateCcw/>{t('workflow.reviews.add')}</Button></div><LearningTimeline scope={scope} mapId={activeMapId} nodeId={selectedNode.id} onSession={openSession}/></div>:<>
        <LearningNote key={`${scope}:${selectedNode.id}`} node={selectedNode} map={map} scope={scope} path={learningNodePath(nodes,selectedNode.id).map(node=>node.title)} onBack={()=>navigate({mapId:activeMapId,nodeId:'',sessionId:'',tab:'note'})} onDelete={()=>deleteNode(selectedNode)} onAskAssistant={onAskAssistant} onPractice={workflowEnabled?()=>setSetup({mapId:activeMapId,nodeIds:[selectedNode.id]}):undefined}/>
        <section className="mx-auto w-full max-w-4xl space-y-2 rounded-xl border p-4">{workflowEnabled&&<div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" onClick={()=>void startNode(selectedNode.id)}>{t('workflow.startLearning')}</Button><Button variant="outline" className="min-h-11" onClick={()=>void addReview()}>{t('workflow.reviews.add')}</Button></div>}<h3 className="pt-2 text-sm font-medium">{t('workflow.path.title')}</h3><p className="text-xs text-muted-foreground">{t('workflow.path.reason')}</p>{recommendations.length?<ol className="space-y-2">{recommendations.map(node=><li key={node.id}><Button variant="link" className="min-h-11 h-auto whitespace-normal text-left" onClick={()=>openNode(node.mapId,node.id)}>{t(node.status==='review'?'workflow.path.before':'workflow.path.after')}: {node.title}</Button><p className="text-xs text-muted-foreground">{t(`workflow.path.reasons.${node.status}`)}</p></li>)}</ol>:<p className="text-sm text-muted-foreground">{t('workflow.path.empty')}</p>}</section>
      </>}
    </section>:<>
      <header className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><h1 className="text-xl font-semibold">{t('title')}</h1><p className="mt-1 hidden text-xs text-muted-foreground sm:block">{t('subtitle')}</p></div><Button variant="outline" className="min-h-11 max-sm:size-11 max-sm:p-0" aria-label={t('askAssistant')} onClick={()=>onAskAssistant?.()}><GraduationCap/><span className="hidden sm:inline">{t('askAssistant')}</span></Button><Button className="min-h-11" onClick={()=>setForm({kind:'map'})}><Plus/>{t('newMap')}</Button></header>
      {!maps.length?<div className="flex min-h-72 flex-col items-center justify-center gap-3 rounded-xl border p-6 text-center"><Network className="size-9 text-muted-foreground"/><h2 className="text-lg font-medium">{t('empty.title')}</h2><p className="max-w-md text-sm text-muted-foreground">{t('empty.hint')}</p><Button variant="outline" className="min-h-11" disabled={!workflowEnabled} onClick={()=>setTab('records')}>{t('workflow.tabs.records')}</Button>{viewTab==='records'&&<LearningTimeline scope={scope} onSession={openSession}/>}</div>:<>
        <LearningHomeSummary scope={scope} onNode={(mapId,nodeId)=>{openNode(mapId,nodeId);void startNode(nodeId);}} onSession={openSession} onReview={()=>navigate({mapId:'',nodeId:'',sessionId:'',tab:'reviews'})} onGenerate={()=>setSetup({mapId:activeMapId})} onJob={(mapId,jobId)=>setSetup({mapId,jobId})}/>
        <div className="flex flex-wrap items-center gap-2 border-b pb-3"><Select value={activeMapId} onValueChange={selectMap}><SelectTrigger className="min-h-11 min-w-0 flex-1 sm:w-64 sm:flex-none" aria-label={t('selectMap')}><SelectValue/></SelectTrigger><SelectContent>{maps.map(item=><SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent></Select><ActionMenu open={menu} onOpenChange={setMenu} trigger={<Button variant="ghost" className="min-h-11 min-w-11" aria-label={t('workflow.manage')}><Ellipsis/></Button>}><ActionMenuItem disabled={!map} onSelect={()=>setForm({kind:'map',map})}>{t('editMap')}</ActionMenuItem><ActionMenuItem disabled={!map} onSelect={()=>setForm({kind:'node'})}>{t('newNode')}</ActionMenuItem><ActionMenuItem disabled={!map} onSelect={attachMap}>{t('addMapContext')}</ActionMenuItem><ActionMenuItem disabled={!map} className="text-destructive" onSelect={deleteMap}>{t('deleteMap')}</ActionMenuItem></ActionMenu><Button variant="ghost" className="min-h-11" disabled={!workflowEnabled} onClick={()=>setTab(viewTab==='reviews'?'note':'reviews')}>{t('workflow.tabs.reviews')}</Button><Button variant="ghost" className="min-h-11" disabled={!workflowEnabled} onClick={()=>viewTab==='records'?setTab('note'):navigate({mapId:'',nodeId:'',sessionId:'',tab:'records'})}>{t('workflow.tabs.records')}</Button></div>
        {viewTab==='reviews'?<ReviewQueue scope={scope} mapId={location.mapId||undefined} initialDue={location.mapId?'all':'due'} onNode={openNode} onPractice={(mapId,nodeId)=>setSetup({mapId,nodeIds:[nodeId],mode:'review'})}/>:viewTab==='records'?<LearningTimeline scope={scope} mapId={location.mapId||undefined} onSession={openSession}/>:<>
          {map?.goal&&<p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{map.goal}</p>}
          {workflowEnabled&&<div className="flex flex-wrap gap-2" data-testid="learning-search"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground"/><Input className="min-h-11 pl-9" aria-label={t('workflow.search.label')} placeholder={t('workflow.search.placeholder')} value={search} onChange={event=>setSearch(event.target.value)}/></div><Select value={filter} onValueChange={setFilter}><SelectTrigger className="min-h-11 w-36" aria-label={t('workflow.search.status')}><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">{t('workflow.search.allStatus')}</SelectItem>{masteryStates.map(state=><SelectItem key={state.id} value={state.id}>{t(`status.${state.id}`)}</SelectItem>)}</SelectContent></Select><Button variant={allMaps?'secondary':'ghost'} className="min-h-11" aria-pressed={allMaps} onClick={()=>setAllMaps(value=>!value)}>{t('workflow.search.allTopics')}</Button></div>}
          {searching?<section className="space-y-2" aria-label={t('workflow.search.results')}>{results.isError?<div role="alert"><p>{t('workflow.failed')}</p><Button onClick={()=>void results.refetch()}>{t('retry')}</Button></div>:results.isLoading?<Skeleton className="h-40 w-full"/>:!found.length?<p className="rounded-xl border p-6 text-sm text-muted-foreground">{t('workflow.search.empty')}</p>:found.map(item=><Button key={item.id} variant="row" size="bare" className="block min-h-16 w-full space-y-2 rounded-xl border p-4 text-left" onClick={()=>openNode(item.mapId,item.id)}><span className="flex items-start justify-between gap-2"><span className="font-medium">{item.title}</span><MasteryBadge status={item.status}/></span><span className="block text-xs text-muted-foreground">{item.path.join(' / ')}</span><span className="block whitespace-normal text-sm text-muted-foreground">{item.excerpt}</span></Button>)}{results.hasNextPage&&<Button variant="outline" disabled={results.isFetchingNextPage} onClick={()=>void results.fetchNextPage()}>{t('workflow.loadMore')}</Button>}<Button variant="ghost" className="min-h-11" onClick={()=>{setSearch('');setTerm('');setFilter('all');}}>{t('workflow.search.clear')}</Button></section>:<>
            <div className="flex flex-wrap items-center justify-between gap-3"><MasteryLegend/><span className="text-xs text-muted-foreground">{t('progress',summary)}</span></div>
            <div className="flex flex-wrap items-center gap-2"><Button variant={showOutline?'secondary':'ghost'} className="min-h-11" onClick={()=>setOutline(true)} aria-pressed={showOutline}><List/>{t('outline')}</Button><Button variant={!showOutline?'secondary':'ghost'} className="min-h-11" onClick={()=>setOutline(false)} aria-pressed={!showOutline}><Network/>{t('mapView')}</Button>{!showOutline&&<><Button variant="ghost" className="min-h-11" onClick={()=>setCommand(c=>({kind:'fit',counter:c.counter+1}))}><Maximize/>{t('fit')}</Button><Button variant="ghost" className="min-h-11" onClick={()=>setCommand(c=>({kind:'expand',counter:c.counter+1}))}>{t('expand')}</Button><Button variant="ghost" className="min-h-11" onClick={()=>setCommand(c=>({kind:'collapse',counter:c.counter+1}))}>{t('collapse')}</Button></>}{!showOutline&&groups.length>0&&<Select value={groups.some(group=>group.id===focusId)?focusId:mobile?groups[0].id:'all'} onValueChange={id=>setFocusId(id==='all'?'':id)}><SelectTrigger className="min-h-11 w-full sm:w-52" aria-label={t('focusGroup')}><SelectValue/></SelectTrigger><SelectContent>{!mobile&&<SelectItem value="all">{t('allGroups')}</SelectItem>}{groups.map(group=><SelectItem key={group.id} value={group.id}>{group.title}</SelectItem>)}</SelectContent></Select>}</div>
            {mapQuery.isLoading?<Skeleton className="h-80 w-full"/>:mapQuery.isError?<div role="alert"><p>{t('loadFailed')}</p><Button onClick={()=>void mapQuery.refetch()}>{t('retry')}</Button></div>:!nodes.length?<p className="rounded-xl border p-8 text-center text-sm text-muted-foreground">{t('chart.empty')}</p>:<div className="min-w-0 rounded-xl border bg-card p-1 sm:p-3">{showOutline?<LearningOutline nodes={nodes} selectedId={location.nodeId} collapsed={collapsed[activeMapId]??{}} onCollapsedChange={value=>setCollapsed(previous=>({...previous,[activeMapId]:value}))} onOpen={id=>openNode(activeMapId,id)} onEditGroup={node=>setForm({kind:'node',node})} onPracticeGroup={workflowEnabled?node=>setSetup({mapId:activeMapId,nodeIds:descendants(nodes,node.id).filter(item=>item.kind==='item').map(item=>item.id)}):undefined}/>:map&&<Suspense fallback={<Skeleton className="h-80 w-full"/>}><MapChart map={map} nodes={nodes} dark={resolvedTheme==='dark'} views={views} command={command} mobile={mobile} focusId={groups.some(group=>group.id===focusId)?focusId:mobile?groups[0]?.id:undefined} onOpen={id=>openNode(activeMapId,id)}/></Suspense>}</div>}
            <footer className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span>{t(showOutline?'outlineHint':'chartHint')}</span><Button variant="ghost" className="min-h-11" disabled={!map} onClick={()=>setForm({kind:'node'})}><Plus/>{t('newNode')}</Button></footer>
          </>}
        </>}
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
