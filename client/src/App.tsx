import { createPortal } from 'react-dom';
import { Sparkles } from 'lucide-react';
import { buildChatContext } from './lib/chat-context.js';
import { pageNames, usePageContexts, type ChatContextV3 } from './lib/assistant-context.js';
import { useLibrarySnapshot, patchLibrary } from './components/library/store.js';
import type { AssistantSource } from '../../server/src/agent/assistant-sources.js';
import { isOverdue, occursOn } from './lib/schedule.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, statuses, type Status, type Tag, type Task, type TaskPriority, type Topic, type TrashTask, type View } from './lib/api.js';
import { queryKeys, type TaskDraft } from './lib/todo.js';
import { useChat } from './hooks/useChat.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import { useMediaQuery } from './hooks/useMediaQuery.js';
import { useLocalDate, useTasks, useTodoActions } from './hooks/useTodo.js';
import { useWorkspaceEvents } from './hooks/useWorkspaceEvents.js';
import { useMobileNavigation } from './hooks/useMobileNavigation.js';
import { DEFAULT_MOBILE_NAVIGATION, mobileSelectedView } from './lib/mobile-navigation.js';
import { mobileNavigationItem, moreItem, navigationItems } from './lib/navigation-items.js';
import { ConnectionsPage } from './components/workspace/ConnectionsPage.js';
import { ProposalsPage } from './components/workspace/ProposalsPage.js';
import { KnowledgePage } from './components/workspace/KnowledgePage.js';
import { LibraryPage } from './components/library/LibraryPage.js';
import { SkillsPage } from './components/skills/SkillsPage.js';
import { SkillEditorHost } from './components/skills/SkillEditor.js';
import { UploadQueue } from './components/library/UploadQueue.js';
import { RunsPage } from './components/workspace/HandoffPanel.js';
import { ReviewsPage } from './components/workspace/ReviewsPage.js';
import { TopicListPage } from './components/topics/TopicList.js';
import { TopicModal } from './components/topics/TopicModal.js';
import { TaskDetailPane, type TaskDetailHandle } from './components/tasks/TaskExpand.js';
import { SummaryPanel } from './components/board/SummaryPanel.js';
import { BoardColumn, TaskCard } from './components/board/BoardColumn.js';
import { QuadrantBoard } from './components/board/QuadrantBoard.js';
import { ChatPanel } from './components/chat/ChatPanel.js';
import { SettingsView } from './components/settings/SettingsView.js';
import { TrashPage } from './components/trash/TrashPage.js';
import { ChangesPage } from './components/changes/ChangesPage.js';
import { WorkspaceModal, type WorkspaceModalView } from './components/workspace/WorkspaceModal.js';
import { ActionDialog, type ActionPrompt } from './components/dialogs/ActionDialog.js';
import { QuickCapture, type QuickCaptureHandle } from './components/tasks/QuickCapture.js';
import { TaskFilterBar, describeTaskFilters, type TaskFilters } from './components/tasks/TaskFilterBar.js';
import { ListPageHeader } from './components/tasks/ListPageHeader.js';
import { TaskList } from './components/tasks/TaskList.js';
import { withSortOrder } from './components/tasks/task-order.js';
import { TagManager } from './components/tasks/TagManager.js';
import { MorePage } from './components/layout/MorePage.js';
import { Sidebar } from './components/layout/Sidebar.js';
import { PlanPage } from './components/plan/PlanPage.js';
import { FocusPage } from './components/focus/FocusPage.js';
import { FocusChip } from './components/focus/FocusChip.js';
import { FocusProvider } from './components/focus/FocusProvider.js';
import { Button } from './components/ui/button.js';
import { cn } from './lib/utils.js';
import { toast } from 'sonner';

const emptyFilters: TaskFilters = { q: '', status: 'all', topic: 'all', dueFrom: '', dueTo: '', tag: '' };

function classificationSections(tasks: Task[], topics: Topic[]) {
  const sections: { id: string; name: string; items: Task[] }[] = [];
  const inbox = tasks.filter((task) => !task.topicId);
  if (inbox.length) sections.push({ id: 'inbox', name: '收集箱', items: inbox });
  const seen = new Set<string>();
  for (const topic of topics) {
    const items = tasks.filter((task) => task.topicId === topic.id);
    if (!items.length) continue;
    seen.add(topic.id);
    sections.push({ id: topic.id, name: topic.name, items });
  }
  const leftovers = new Map<string, { id: string; name: string; items: Task[] }>();
  for (const task of tasks) {
    if (!task.topicId || seen.has(task.topicId)) continue;
    const current = leftovers.get(task.topicId) ?? { id: task.topicId, name: task.topic?.name ?? '已归档', items: [] };
    current.items.push(task);
    leftovers.set(task.topicId, current);
  }
  return [...sections, ...leftovers.values()];
}

export function App() {
  useWorkspaceEvents();
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => document.documentElement.style.setProperty('--assistant-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
    update();
    viewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    return () => { viewport?.removeEventListener('resize', update); window.removeEventListener('resize', update); document.documentElement.style.removeProperty('--assistant-viewport-height'); };
  }, []);
  const { route, knowledgeSection: liveKnowledgeSection, knowledgeTopicId: liveKnowledgeTopicId, knowledgeTopicExplicit: liveKnowledgeTopicExplicit, navigate, openKnowledge } = useHashRoute();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const wide = useMediaQuery('(min-width: 1280px)');
  const librarySnapshot = useLibrarySnapshot();
  const pageContexts = usePageContexts();
  const [assistantHost] = useState(() => { const host = document.createElement('div'); host.className = 'h-full min-h-0'; return host; });
  const [assistantSlot, setAssistantSlot] = useState<HTMLDivElement | null>(null);
  const [workspaceAssistantSlot, setWorkspaceAssistantSlot] = useState<HTMLDivElement | null>(null);
  const [sourceView, setSourceView] = useState<{ title: string; content: string; kind: string; id: string; topicId?: string | null; revision?: number } | null>(null);
  const mobileNavigation = useMobileNavigation();
  const [selectedTopicId, setSelectedTopicId] = useState(() => localStorage.getItem('todo.selectedTopic') ?? '');
  const [chatOpen, setChatOpen] = useState(false);
  const [assistantOrigin, setAssistantOrigin] = useState<{ route: View; hash: string; context: ChatContextV3; knowledgeSection: ReturnType<typeof useHashRoute>['knowledgeSection']; knowledgeTopicId: string | null; knowledgeTopicExplicit: boolean } | null>(null);
  const [assistantPageSlot, setAssistantPageSlot] = useState<HTMLDivElement | null>(null);
  const isAssistantPage = route === 'chat';
  useEffect(() => { if (!isAssistantPage) setAssistantOrigin(null); }, [isAssistantPage]);
  const knowledgeSection = isAssistantPage && assistantOrigin ? assistantOrigin.knowledgeSection : liveKnowledgeSection;
  const knowledgeTopicId = isAssistantPage && assistantOrigin ? assistantOrigin.knowledgeTopicId : liveKnowledgeTopicId;
  const knowledgeTopicExplicit = isAssistantPage && assistantOrigin ? assistantOrigin.knowledgeTopicExplicit : liveKnowledgeTopicExplicit;
  const effectiveRoute = isAssistantPage && assistantOrigin ? assistantOrigin.route : route;
  const [topicForm, setTopicForm] = useState<Partial<Topic> | null>(null);
  const [taskId, setTaskId] = useState('');
  const [layout, setLayout] = useState<'list' | 'board' | 'quadrant'>('list');
  const [showCompleted, setShowCompleted] = useState(false);
  const [sortMode, setSortMode] = useState('manual');
  const [filters, setFilters] = useState<TaskFilters>(emptyFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [dragHintSeen, setDragHintSeen] = useState(() => localStorage.getItem('todo.dragHintSeen') === '1');
  const [selectedTag, setSelectedTag] = useState('');
  const [assistantSelectedIds, setAssistantSelectedIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<(ActionPrompt & { resolve: (value: boolean) => void }) | null>(null);
  const topicSaveLock = useRef(false);
  const detailRef = useRef<TaskDetailHandle>(null);
  const [detailSlot, setDetailSlot] = useState<HTMLDivElement | null>(null);
  const [detailDirty, setDetailDirty] = useState(false);
  const captureRef = useRef<QuickCaptureHandle>(null);
  const previousMain = useRef<View>('inbox');
  const workspaceView: WorkspaceModalView | null = ['settings', 'trash', 'changes'].includes(effectiveRoute) ? effectiveRoute as WorkspaceModalView : null;
  const page = workspaceView || isAssistantPage ? previousMain.current : route;
  useEffect(() => { if (!workspaceView && route !== 'chat') previousMain.current = route; }, [route, workspaceView]);
  useEffect(() => { setFilters(emptyFilters); setFiltersOpen(false); setLayout('list'); setSortMode('manual'); setShowCompleted(false); }, [page, selectedTopicId]);
  useEffect(() => { if (selectedTopicId) localStorage.setItem('todo.selectedTopic', selectedTopicId); }, [selectedTopicId]);
  const confirm = (value: ActionPrompt) => new Promise<boolean>((resolve) => setPrompt({ ...value, resolve }));
  const actions = useTodoActions();
  const queryClient = useQueryClient();
  const reorderEpoch = useRef(0);
  const today = useLocalDate();
  const topicsQuery = useQuery<Topic[]>({ queryKey: queryKeys.topics, queryFn: () => api('/api/topics') });
  const archivedQuery = useQuery<Topic[]>({ queryKey: ['topics', 'archived'], queryFn: () => api('/api/topics?archived=true') });
  const tagsQuery = useQuery<Tag[]>({ queryKey: queryKeys.tags, queryFn: () => api('/api/tags') });
  const trashQuery = useQuery<TrashTask[]>({ queryKey: queryKeys.trash, queryFn: () => api('/api/trash/tasks'), enabled: route === 'trash' });
  const topics = topicsQuery.data ?? [];
  const tags = tagsQuery.data ?? [];
  const selectedTopic = [...topics, ...(archivedQuery.data ?? [])].find((item) => item.id === selectedTopicId);
  useEffect(() => {
    if (topicsQuery.isSuccess && archivedQuery.isSuccess && (!selectedTopicId || ![...(topicsQuery.data ?? []), ...(archivedQuery.data ?? [])].some((topic) => topic.id === selectedTopicId))) setSelectedTopicId(topicsQuery.data[0]?.id ?? '');
  }, [selectedTopicId, topicsQuery.data, topicsQuery.isSuccess, archivedQuery.data, archivedQuery.isSuccess]);
  const knowledgeTopicReady = topicsQuery.isSuccess && archivedQuery.isSuccess && (!selectedTopicId || [...(topicsQuery.data ?? []), ...(archivedQuery.data ?? [])].some((topic) => topic.id === selectedTopicId));
  useEffect(() => {
    if (route !== 'knowledge' || knowledgeTopicExplicit || !knowledgeTopicReady) return;
    openKnowledge(knowledgeSection ?? 'brief', selectedTopicId, 'replace');
  }, [route, knowledgeTopicExplicit, knowledgeTopicReady, knowledgeSection, selectedTopicId, openKnowledge]);
  const topicDetail = useQuery<Topic>({ queryKey: queryKeys.topic(selectedTopicId), queryFn: () => api(`/api/topics/${selectedTopicId}?includeArchived=true`), enabled: Boolean(selectedTopicId) && page === 'board' });
  const briefNotesQuery = useQuery<{ manualNotes: string }>({ queryKey: ['brief-notes', selectedTopicId], queryFn: () => api(`/api/v1/knowledge/brief/notes?topicId=${encodeURIComponent(selectedTopicId)}`), enabled: page === 'board' && Boolean(selectedTopicId) });
  const detail = topicDetail.data ?? selectedTopic;
  const archived = page === 'board' && Boolean(detail?.archivedAt);
  const scoped: boolean = page === 'inbox' || page === 'board';
  const quadrantView = page === 'quadrant' || (page === 'board' && layout === 'quadrant');
  const hasFilters = Boolean((page === 'search' && filters.q) || filters.status !== 'all' || filters.dueFrom || filters.dueTo || filters.tag);
  const params: Record<string, string> = { status: page === 'today' || (quadrantView && !showCompleted) ? 'open' : filters.status, sort: quadrantView ? 'date' : scoped ? sortMode : 'date' };
  if (page === 'inbox' || (!scoped && filters.topic === 'inbox')) params.inbox = 'true';
  if (page === 'board') params.topicId = selectedTopicId;
  else if (!scoped && filters.topic !== 'all' && filters.topic !== 'inbox') params.topicId = filters.topic;
  if (archived) params.includeArchived = 'true';
  if (page === 'search' && filters.q) params.q = filters.q;
  if (filters.dueFrom) params.dueFrom = filters.dueFrom;
  if (filters.dueTo) params.dueTo = filters.dueTo;
  if (page === 'today') params.dueTo = today;
  if (page === 'tags' ? selectedTag : filters.tag) params.tagIds = page === 'tags' ? selectedTag : filters.tag;
  useEffect(() => setAssistantSelectedIds([]), [page, selectedTopicId, JSON.stringify(params)]);
  const taskPage = ['inbox', 'board', 'quadrant', 'today', 'search', 'tags'].includes(page);
  const tasksQuery = useTasks(params, taskPage && (page !== 'board' || Boolean(selectedTopicId)) && (page !== 'tags' || Boolean(selectedTag)));
  const tasks = tasksQuery.data ?? [];
  const taggedSections = page === 'tags' && selectedTag ? classificationSections(tasks, topics) : [];
  const contextPage = workspaceView ?? page;
  const contextTopicId = contextPage === 'knowledge' ? (knowledgeTopicExplicit ? knowledgeTopicId ?? '' : selectedTopicId) : contextPage === 'board' ? selectedTopicId : '';
  const taskContext = !workspaceView && taskId ? pageContexts.get('task')?.value : undefined;
  const baseContext = buildChatContext({ page: contextPage, topicId: contextTopicId, taskId: workspaceView ? '' : taskId, today });
  const pageContext: ChatContextV3 = {
    ...baseContext, schemaVersion: 3, label: contextPage === 'board' ? selectedTopic?.name ?? '清单' : pageNames[contextPage] ?? contextPage,
    section: contextPage === 'knowledge' ? knowledgeSection ?? 'brief' : null, mode: 'follow',
    taskRevision: null, materialRevision: null,
    ...(contextPage === 'knowledge' ? { scope: contextTopicId ? { kind: 'topic' as const, topicId: contextTopicId } : { kind: 'inbox' as const } } : {}), selectedMaterialIds: [], pageState: {}, attachments: [],
    ...(taskPage && !workspaceView ? {
      scope: params.inbox ? { kind: 'inbox' as const } : params.topicId ? { kind: 'topic' as const, topicId: params.topicId } : { kind: 'all' as const },
      taskFilter: (contextPage === 'tags' && !selectedTag) || (contextPage === 'board' && !selectedTopicId) ? null : { status: params.status as 'open' | 'all', sort: params.sort as 'manual' | 'date', ...(params.q ? { q: params.q } : {}), ...(params.dueFrom ? { dueFrom: params.dueFrom } : {}), ...(params.dueTo ? { dueTo: params.dueTo } : {}), ...(params.tagIds ? { tagIds: [params.tagIds] } : {}), ...(archived ? { includeArchived: true } : {}) },
      selectedTaskIds: assistantSelectedIds,
      pageState: { layout, showCompleted },
    } : {}),
    ...(contextPage === 'library' ? { materialId: librarySnapshot.preview?.materialId ?? null, materialRevision: librarySnapshot.preview?.revision ?? null, materialVersionMode: librarySnapshot.preview?.revision == null ? 'latest' as const : 'historical' as const, selectedMaterialIds: librarySnapshot.selectedIds, pageState: { query: librarySnapshot.query, folderId: librarySnapshot.folderId, tagIds: librarySnapshot.tagIds, kind: librarySnapshot.kind, libraryView: librarySnapshot.view, taskTopicId: librarySnapshot.taskTopicId } } : {}),
    ...(contextPage === 'library' ? pageContexts.get('library-list')?.value : {}),
    ...pageContexts.get(contextPage)?.value,
    ...(taskContext?.taskId === taskId ? taskContext : {}),
    ...(sourceView ? { page: sourceView.kind === 'help' ? sourceView.id : sourceView.kind === 'memory' ? 'knowledge' : 'chat', label: sourceView.title, section: sourceView.kind, scope: sourceView.kind === 'memory' ? sourceView.topicId ? { kind: 'topic' as const, topicId: sourceView.topicId } : { kind: 'inbox' as const } : { kind: 'all' as const }, taskId: null, taskRevision: null, taskFilter: null, materialId: null, materialRevision: null, selectedMaterialIds: [], selectedTaskIds: [], pageState: { selectedId: sourceView.id, ...(sourceView.revision ? { selectedRevision: sourceView.revision } : {}) } } : {}),
  };
  const assistantContext: ChatContextV3 = isAssistantPage
    ? assistantOrigin?.context ?? { ...buildChatContext({ page: 'chat', topicId: '', taskId: '', today }), schemaVersion: 3, label: 'AI 助手', section: null, mode: 'follow', taskRevision: null, materialRevision: null, selectedMaterialIds: [], pageState: {}, attachments: [] }
    : pageContext;
  const chat = useChat({ pageContext: assistantContext, selectedTopicId: assistantContext.scope.kind === 'topic' ? assistantContext.scope.topicId : '', taskId, view: isAssistantPage ? 'chat' : page, onError: (message) => { if (message) toast.error(message); } });
  useLayoutEffect(() => {
    const slot = isAssistantPage ? assistantPageSlot : workspaceView ? workspaceAssistantSlot : assistantSlot;
    if (!slot) return;
    const scroller = assistantHost.querySelector<HTMLElement>('[data-chat-scroll]');
    const top = scroller?.scrollTop;
    const focused = assistantHost.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    slot.appendChild(assistantHost);
    if (scroller && top !== undefined) scroller.scrollTop = top;
    focused?.focus({ preventScroll: true });
  }, [assistantSlot, workspaceAssistantSlot, workspaceView, assistantHost, isAssistantPage, assistantPageSlot]);
  const transitionFromDetail = (action: () => void) => {
    if (taskId && detailRef.current) detailRef.current.requestTransition(action);
    else action();
  };
  const navigateSafely = (view: View) => {
    transitionFromDetail(() => {
    setAssistantOrigin(null);
    if (view === 'chat') setChatOpen(false);
    setSourceView(null);
    setTaskId('');
    if (view === 'knowledge') { openKnowledge('brief', selectedTopicId); return; }
    navigate(view);
  });
  };
  const selectTopic = (id: string) => transitionFromDetail(() => { setSourceView(null); setTaskId(''); setSelectedTopicId(id); navigate('board'); });
  const openTask = (id: string) => {
    if (id === taskId) return;
    transitionFromDetail(() => { setSourceView(null); setTaskId(id); });
  };
  const openLinkedTask = async (id: string) => {
    if (id === taskId) return;
    if (taskId && detailRef.current) {
      const saved = await detailRef.current.ensureSaved();
      if (!saved) return;
    }
    setSourceView(null);
    setTaskId(id);
  };
  const openChat = () => {
    if (window.location.hash.replace(/^#\/?/, '').split('?')[0] !== 'chat') setChatOpen(true);
    requestAnimationFrame(() => window.dispatchEvent(new Event('wwa-focus-assistant')));
  };
  const expandAssistant = () => {
    setAssistantOrigin({ route, hash: window.location.hash, context: structuredClone(pageContext), knowledgeSection, knowledgeTopicId, knowledgeTopicExplicit });
    navigate('chat');
  };
  const shrinkAssistant = () => {
    if (!assistantOrigin) return;
    window.location.hash = assistantOrigin.hash || `/${assistantOrigin.route}`;
    setChatOpen(true);
  };
  useEffect(() => {
    const open = () => openChat();
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'l') { event.preventDefault(); openChat(); }
    };
    window.addEventListener('wwa-adjust-approval', open);
    window.addEventListener('wwa-open-assistant', open);
    window.addEventListener('keydown', shortcut);
    return () => { window.removeEventListener('wwa-adjust-approval', open); window.removeEventListener('wwa-open-assistant', open); window.removeEventListener('keydown', shortcut); };
  }, []);
  const sourceHandler = useRef((source: AssistantSource) => {});
  sourceHandler.current = (source) => {
    void api<{ title: string; content: string; kind: string; id: string; topicId?: string | null }>(`/api/v1/assistant/sources/${source.kind}/${encodeURIComponent(source.id)}${source.revision ? `?revision=${source.revision}` : ''}`).then((resolved) => {
      transitionFromDetail(() => {
        if (source.kind === 'task') { setSourceView(null); setTaskId(source.id); }
        else if (source.kind === 'material') { setSourceView(null); setTaskId(''); patchLibrary({ preview: { materialId: source.id, revision: source.revision ?? null, chunkId: null } }); navigate('library'); }
        else { setTaskId(''); setSourceView(resolved); }
        if ((workspaceView || isAssistantPage) && source.kind !== 'material') {
          setAssistantOrigin(null);
          navigate(previousMain.current);
          setChatOpen(isDesktop);
        }
        if (!isDesktop) setChatOpen(false);
      });
    }).catch((error) => toast.error(error instanceof Error ? error.message : '来源无法读取'));
  };
  useEffect(() => {
    const handler = (event: Event) => sourceHandler.current((event as CustomEvent<AssistantSource>).detail);
    window.addEventListener('wwa-open-source', handler);
    return () => window.removeEventListener('wwa-open-source', handler);
  }, []);
  const markDragHint = () => { localStorage.setItem('todo.dragHintSeen', '1'); setDragHintSeen(true); };
  const newTopic = () => setTopicForm({ name: '', description: '', color: 'slate', isExploration: false });
  const createTask = (input: { title: string; topicId: string | null; parentId: string | null } & Partial<TaskDraft>) => actions.create(input, input.parentId);
  const patchTask = async (task: Task, changes: Partial<TaskDraft>): Promise<Task | undefined> => {
    const keys = [task.parentId, changes.parentId, ...(task.children ?? tasks.filter((child) => child.parentId === task.id)).map((child) => child.id)].filter(Boolean) as string[];
    try { return (await actions.patch(task.id, { ...changes, expectedRevision: task.revision }, keys)).data; }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'SUBTASKS_INCOMPLETE') throw error;
      if (await confirm({ title: '一并完成子任务？', description: '该任务还有未完成的子任务。继续后将一并标记为完成。', confirm: '一并完成' })) return (await actions.patch(task.id, { ...changes, completeChildren: true, expectedRevision: task.revision }, keys)).data;
      return undefined;
    }
  };
  const toggleTask = (task: Task) => patchTask(task, { status: task.status === 'done' ? 'todo' : 'done' });
  const moveTask = (task: Task, topicId: string | null) => patchTask(task, { topicId });
  const moveQuadrant = async (task: Task, priority: TaskPriority) => {
    const lists = queryClient.getQueriesData<Task[]>({ queryKey: queryKeys.tasks });
    const details = queryClient.getQueriesData<Task>({ queryKey: ['task'] });
    const next = (item: Task) => item.id === task.id ? { ...item, priority } : item;
    queryClient.setQueriesData<Task[]>({ queryKey: queryKeys.tasks }, (old) => Array.isArray(old) ? old.map(next) : old);
    queryClient.setQueriesData<Task>({ queryKey: ['task'] }, (old) => old ? next(old) : old);
    try { await patchTask(task, { priority }); }
    catch {
      for (const [key, data] of lists) queryClient.setQueryData(key, data);
      for (const [key, data] of details) queryClient.setQueryData(key, data);
    }
  };
  const reorder = (group: Task[], parentId: string | null, message = '顺序已保存') => {
    const epoch = ++reorderEpoch.current;
    const order = new Map(group.map((task, index) => [task.id, index]));
    const lists = queryClient.getQueriesData<Task[]>({ queryKey: queryKeys.tasks });
    const details = queryClient.getQueriesData<Task>({ queryKey: ['task'] });
    const apply = () => {
      queryClient.setQueriesData<Task[]>({ queryKey: queryKeys.tasks }, (old) => Array.isArray(old) ? old.map((task) => withSortOrder(task, order)) : old);
      queryClient.setQueriesData<Task>({ queryKey: ['task'] }, (old) => old && typeof old === 'object' && 'id' in old ? withSortOrder(old, order) : old);
    };
    apply();
    void Promise.all([
      queryClient.cancelQueries({ queryKey: queryKeys.tasks }),
      queryClient.cancelQueries({ queryKey: ['task'] }),
    ]).then(() => { if (reorderEpoch.current === epoch) apply(); });
    return actions.write('/api/tasks/reorder', 'POST', { topicId: group[0]?.topicId ?? null, parentId, orderedTaskIds: group.map((task) => task.id), expectedRevisions: Object.fromEntries(group.map((task) => [task.id, task.revision])) }, [...group.map((task) => task.id), ...(parentId ? [parentId] : [])], message || undefined).catch(async (error) => {
      if (reorderEpoch.current === epoch) reorderEpoch.current += 1;
      for (const [key, data] of lists) queryClient.setQueryData(key, data);
      for (const [key, data] of details) queryClient.setQueryData(key, data);
      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.tasks }), queryClient.invalidateQueries({ queryKey: ['task'] })]).catch(() => undefined);
      throw error;
    });
  };
  const nest = (task: Task, parentId: string | null, orderedIds: string[]) => {
    const epoch = ++reorderEpoch.current;
    const lists = queryClient.getQueriesData<Task[]>({ queryKey: queryKeys.tasks });
    const details = queryClient.getQueriesData<Task>({ queryKey: ['task'] });
    const parent = tasks.find((item) => item.id === parentId);
    const topicId = parent ? parent.topicId : task.topicId;
    const order = new Map(orderedIds.map((id, index) => [id, index]));
    const patchTaskPlacement = (item: Task): Task => {
      const sortOrder = order.get(item.id);
      let next = item.id === task.id ? { ...item, parentId, topicId, ...(sortOrder === undefined ? {} : { sortOrder }) } : sortOrder === undefined ? item : { ...item, sortOrder };
      if (!item.children) return next;
      const children = item.children.filter((child) => child.id !== task.id).map(patchTaskPlacement);
      if (item.id !== parentId) return { ...next, children };
      const placed = { ...task, parentId, topicId, sortOrder: order.get(task.id) ?? 0 };
      return { ...next, children: [...children, placed].sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.id.localeCompare(right.id)) };
    };
    const apply = () => {
      queryClient.setQueriesData<Task[]>({ queryKey: queryKeys.tasks }, (old) => Array.isArray(old) ? old.map(patchTaskPlacement) : old);
      queryClient.setQueriesData<Task>({ queryKey: ['task'] }, (old) => old && typeof old === 'object' && 'id' in old ? patchTaskPlacement(old) : old);
    };
    apply();
    void Promise.all([
      queryClient.cancelQueries({ queryKey: queryKeys.tasks }),
      queryClient.cancelQueries({ queryKey: ['task'] }),
    ]).then(() => { if (reorderEpoch.current === epoch) apply(); });
    const restore = async () => {
      if (reorderEpoch.current === epoch) reorderEpoch.current += 1;
      for (const [key, data] of lists) queryClient.setQueryData(key, data);
      for (const [key, data] of details) queryClient.setQueryData(key, data);
      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.tasks }), queryClient.invalidateQueries({ queryKey: ['task'] })]).catch(() => undefined);
    };
    return (async () => {
      try {
        const updated = (await actions.write<Task>(`/api/tasks/${task.id}`, 'PATCH', { parentId, expectedRevision: task.revision }, [task.id, parentId, task.parentId].filter((id): id is string => Boolean(id)), parentId ? '已变为子任务' : '已变为根任务')).data;
        if (orderedIds[orderedIds.length - 1] === task.id) return;
        const byId = new Map(tasks.map((item) => [item.id, item]));
        const group = orderedIds.map((id) => id === task.id ? { ...updated, parentId, topicId: updated.topicId ?? topicId } : byId.get(id)).filter((item): item is Task => Boolean(item));
        await reorder(group, parentId, '');
      } catch (error) {
        await restore();
        throw error;
      }
    })();
  };
  const deleteTask = async (task: Task) => {
    const latest = await api<Task>(`/api/tasks/${task.id}`);
    const children = latest.children ?? [];
    if (!await confirm({ title: '删除任务', description: `“${task.title}”${children.length ? `及以下 ${children.length} 个子任务` : ''}将移入回收站。${children.length ? '\n' + children.map((child) => `• ${child.title}`).join('\n') : ''}`, confirm: '移入回收站', destructive: true })) return;
    await actions.write(`/api/tasks/${task.id}`, 'DELETE', undefined, [task.id, ...children.map((child) => child.id)], '任务已移入回收站');
    if (taskId === task.id) setTaskId('');
  };
  const archiveTopic = async (topic: Partial<Topic>) => {
    if (!await confirm({ title: '归档清单', description: `归档“${topic.name}”后任务会保留归属，并从日常视图隐藏。可在已归档页面恢复。`, confirm: '归档清单' })) return;
    await actions.write(`/api/topics/${topic.id}/archive`, 'POST', undefined, [topic.id!], '清单已归档');
    setTopicForm(null); navigate('inbox');
  };
  const saveTopic = async () => {
    if (!topicForm?.name?.trim() || topicSaveLock.current) return;
    topicSaveLock.current = true;
    try {
      const response = await actions.write<Topic>(topicForm.id ? `/api/topics/${topicForm.id}` : '/api/topics', topicForm.id ? 'PATCH' : 'POST', { expectedRevision: topicForm.revision, name: topicForm.name.trim(), description: topicForm.description ?? '', color: topicForm.color ?? 'slate', isExploration: topicForm.isExploration ?? false, ...(topicForm.goal !== undefined ? { goal: topicForm.goal } : {}) }, [topicForm.id ?? 'topic-create'], topicForm.id ? '清单已更新' : '清单已创建');
      setTopicForm(null); selectTopic(response.data.id);
    } catch { /* Keep the form available. */ } finally { topicSaveLock.current = false; }
  };
  const permanentDelete = async (task: TrashTask) => {
    const children = (trashQuery.data ?? []).filter((child) => child.parentId === task.id);
    const descendants = new Map([...(task.children ?? []), ...children].map((child) => [child.id, child]));
    if (!await confirm({ title: '永久删除任务', description: `永久删除“${task.title}”${descendants.size ? `及 ${descendants.size} 个子任务` : ''}，之后无法恢复。${descendants.size ? '\n' + [...descendants.values()].map((child) => `• ${child.title}`).join('\n') : ''}`, confirm: '永久删除', destructive: true })) return;
    await actions.write(`/api/trash/tasks/${task.id}/permanent`, 'DELETE', undefined, [task.id, ...descendants.keys()], '任务已永久删除');
  };
  const run = (work: Promise<unknown>) => { void work.catch((error) => { if (!(error instanceof ApiError)) toast.error(error instanceof Error ? error.message : '操作失败'); }); };
  const listProps = { assistantSelectedIds, onAssistantSelect: (id: string) => setAssistantSelectedIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : ids.length < 100 ? [...ids, id] : ids), topics, tags, onOpen: openTask, onToggle: toggleTask, onMove: moveTask, onDelete: (task: Task) => run(deleteTask(task)), onSave: patchTask, onCreate: createTask, readonly: archived, busy: actions.pending, selectedTaskId: taskId, textDirty: detailDirty };
  const planProps = { onCreate: createTask, topics, tags, onOpen: openTask, onToggle: toggleTask, onSave: patchTask, onDelete: (task: Task) => run(deleteTask(task)), busy: actions.pending };

  const title = page === 'board' ? detail?.name ?? '选择一个清单' : navigationItems.find((item) => item.view === page)?.label ?? '工作区';
  const updateFilter = (patch: Partial<TaskFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const todayGroups = [{ name: '逾期', items: tasks.filter((task) => isOverdue(task, today)) }, { name: '今天', items: tasks.filter((task) => occursOn(task, today)) }].filter((group) => group.items.length);
  const showDragHint = !hasFilters && !archived && sortMode === 'manual' && (!dragHintSeen || tasks.length === 0);
  const showHint = scoped && !quadrantView && (hasFilters || archived || sortMode !== 'manual' || showDragHint);
  const hintText = hasFilters ? '筛选期间不能手动排序；清除筛选后可调整完整列表。' : archived ? '恢复清单后可编辑和排序。' : sortMode !== 'manual' ? '切换为手动排序后，可调整任务位置。' : '上下拖动调整顺序，向右拖成子任务，向左拖回根任务。';
  const listLayout = page !== 'board' && page !== 'today' && page !== 'tags' && !quadrantView && !(scoped && layout === 'board');
  const filterSummary = page === 'board' ? describeTaskFilters(page, scoped, filters, topics, tags).summary : '';
  const briefNotes = (briefNotesQuery.data?.manualNotes ?? '').trim();
  const filterBar = <TaskFilterBar page={page} scoped={scoped} filters={filters} sortMode={sortMode} topics={topics} tags={tags} open={filtersOpen} onOpenChange={setFiltersOpen} onChange={updateFilter} onSort={setSortMode} onClear={() => setFilters(emptyFilters)} presentation={page === 'board' ? 'popover' : 'bar'} />;
  const taskList = <TaskList {...listProps} tasks={tasks} foldDone={scoped && !hasFilters} hierarchical={scoped && !hasFilters && sortMode === 'manual'} onDragSettled={markDragHint} onReorder={scoped && !hasFilters && !archived && sortMode === 'manual' ? reorder : undefined} onNest={scoped && !hasFilters && !archived && sortMode === 'manual' ? nest : undefined} />;
  const taskContent = <div className="mx-auto max-w-5xl p-4 pb-10 sm:p-6">
    <ListPageHeader page={page} title={title} scoped={scoped} archived={archived} today={today} detail={detail} briefNotes={briefNotes} filterSummary={filterSummary} layout={layout} onLayout={setLayout} onOpenChat={openChat} onOpenKnowledge={() => navigateSafely('knowledge')} onEditTopic={() => { if (detail) setTopicForm(detail); }} onNewTask={() => captureRef.current?.focus()} filterBar={filterBar} />
    {page === 'board' && detail && <SummaryPanel detail={detail} busy={actions.pending} onConfirm={archived ? undefined : (action) => run(actions.write(`/api/topics/${detail.id}/summary/${action}`, 'POST', undefined, [detail.id], action === 'confirm' ? '成果已确认' : '草稿已放弃'))} />}
    {page === 'board' && !detail ? <Button onClick={newTopic}>新建清单</Button> : <>
      {!listLayout && scoped && !archived && page !== 'board' && <QuickCapture ref={captureRef} key={`${page}.${selectedTopicId}`} topicId={page === 'inbox' ? null : selectedTopicId} inbox={page === 'inbox'} onCreate={createTask} />}
      {page === 'tags' && <TagManager tags={tags} selected={selectedTag} onSelect={setSelectedTag} confirm={confirm} />}
      {taskPage && page !== 'board' && filterBar}
      {!listLayout && showHint && <p className="mb-3 text-xs text-muted-foreground">{hintText}</p>}
      {page === 'board' && !archived && <QuickCapture ref={captureRef} key={`${page}.${selectedTopicId}`} variant="row" topicId={selectedTopicId} onCreate={createTask} />}
      {listLayout ? <section className="list-surface rounded-2xl p-1.5 sm:p-2">{scoped && !archived && <QuickCapture ref={captureRef} key={`${page}.${selectedTopicId}`} topicId={page === 'inbox' ? null : selectedTopicId} inbox={page === 'inbox'} onCreate={createTask} />}{showHint && <p className="px-2 pb-1 pt-1 text-xs text-muted-foreground">{hintText}</p>}{tasksQuery.isLoading ? <p className="py-12 text-center text-muted-foreground">正在加载任务…</p> : tasksQuery.error ? <p role="alert" className="text-destructive">{tasksQuery.error.message}</p> : taskList}</section> : tasksQuery.isLoading ? <p className="py-12 text-center text-muted-foreground">正在加载任务…</p> : tasksQuery.error ? <p role="alert" className="text-destructive">{tasksQuery.error.message}</p> : page === 'today' ? (todayGroups.length ? <div className="space-y-6">{todayGroups.map((group) => <section key={group.name}><h2 className="mb-3 text-sm font-semibold">{group.name} · {group.items.length}</h2><TaskList {...listProps} tasks={group.items} /></section>)}</div> : <p className="py-12 text-center text-sm text-muted-foreground">暂无任务</p>) : quadrantView ? <QuadrantBoard tasks={tasks} showCompleted={showCompleted} onShowCompleted={setShowCompleted} onMoveQuadrant={moveQuadrant} topics={topics} tags={tags} selected={false} readonly={archived} busy={actions.pending} textDirty={detailDirty} onOpen={openTask} onToggle={toggleTask} onMove={moveTask} onDelete={(item) => run(deleteTask(item))} onSave={patchTask} onCreate={createTask} onUpdateStatus={(id, status: Status) => { const item = tasks.find((candidate) => candidate.id === id); if (item) run(patchTask(item, { status })); }} /> : scoped && layout === 'board' ? <div className="mt-5 flex gap-3 overflow-x-auto pb-4 snap-x snap-mandatory md:grid md:grid-cols-2 md:overflow-visible xl:grid-cols-4">{statuses.map(({ value, label }) => <BoardColumn key={value} label={label} count={tasks.filter((task) => task.status === value).length}>{tasks.filter((task) => task.status === value).map((task) => <TaskCard key={task.id} task={task} topics={topics} tags={tags} selected={taskId === task.id} readonly={archived} busy={actions.pending} textDirty={detailDirty} onOpen={openTask} onToggle={toggleTask} onMove={moveTask} onDelete={(item) => run(deleteTask(item))} onSave={patchTask} onCreate={createTask} onUpdateStatus={(id, status: Status) => { const item = tasks.find((candidate) => candidate.id === id); if (item) run(patchTask(item, { status })); }} />)}</BoardColumn>)}</div> : page === 'tags' ? (selectedTag ? <div className="space-y-6">{taggedSections.map((section) => <section key={section.id} aria-label={section.name}><h2 className="mb-3 text-sm font-semibold">{section.name} · {section.items.length}</h2><TaskList {...listProps} tasks={section.items} /></section>)}{!taggedSections.length && <p className="py-12 text-center text-sm text-muted-foreground">暂无任务</p>}</div> : <p className="py-12 text-center text-sm text-muted-foreground">选择一个标签后，按分类查看带有该标签的任务。</p>) : taskList}
    </>}
  </div>;
  const content = page === 'plan' ? <PlanPage {...planProps} /> : page === 'focus' ? <FocusPage /> : page === 'connections' ? <ConnectionsPage topics={topics} /> : page === 'proposals' ? <ProposalsPage /> : page === 'knowledge' ? <KnowledgePage topics={topics} archivedTopics={archivedQuery.data ?? []} topicId={knowledgeTopicExplicit ? (knowledgeTopicId ?? '') : selectedTopicId} topicExplicit={knowledgeTopicExplicit} topicsReady={topicsQuery.isSuccess && archivedQuery.isSuccess} section={knowledgeSection ?? 'brief'} onLocate={openKnowledge} onOpenSettings={() => navigate('settings')} /> : page === 'skills' ? <SkillsPage /> : page === 'library' ? <LibraryPage topics={topics} selectedTopicId={selectedTopicId} onOpenTask={openLinkedTask} /> : page === 'runs' ? <RunsPage /> : page === 'reviews' ? <ReviewsPage topics={topics} /> : taskPage ? taskContent : page === 'topics' ? <TopicListPage topics={topics} topicsLoading={topicsQuery.isLoading} selectedTopicId={selectedTopicId} onSelectTopic={selectTopic} onNewTopic={newTopic} onEditTopic={setTopicForm} onOpenSettings={() => navigateSafely('settings')} onOpenInbox={() => navigateSafely('inbox')} /> : page === 'archived' ? <div className="p-5 sm:p-7"><h1 className="mb-5 text-2xl font-semibold">已归档</h1><div className="space-y-3">{!(archivedQuery.data ?? []).length && <p className="text-sm text-muted-foreground">暂无归档清单</p>}{(archivedQuery.data ?? []).map((topic) => <article key={topic.id} className="glass-subtle flex flex-wrap items-center gap-3 rounded-xl p-4"><button className="flex-1 text-left font-medium" onClick={() => selectTopic(topic.id)}>{topic.name}</button><Button variant="outline" onClick={() => run(actions.write(`/api/topics/${topic.id}/restore`, 'POST', undefined, [topic.id], '清单已恢复'))}>恢复清单</Button><Button variant="outline" onClick={() => run((async () => { if (await confirm({ title: '移出归档清单的任务', description: `将“${topic.name}”的任务移到收集箱，保留父子关系。`, confirm: '移出任务' })) await actions.write(`/api/topics/${topic.id}/move-tasks-to-inbox`, 'POST', undefined, [topic.id], '任务已移入收集箱'); })())}>移出任务到收集箱</Button></article>)}</div></div> : <MorePage route={route} onNavigate={navigateSafely} />;
  const chatPanel = <ChatPanel chat={chat} presentation={isAssistantPage ? assistantOrigin ? 'expanded' : 'direct' : 'side'} onExpand={expandAssistant} onShrink={shrinkAssistant} mobile={!isDesktop} onClose={() => setChatOpen(false)} />;
  const showChat = chatOpen || route === 'chat';
  const closeTask = () => { setDetailDirty(false); setTaskId(''); };
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  useEffect(() => {
    if (!taskIdRef.current) return;
    detailRef.current?.requestTransition(closeTask);
  }, [page]);
  // 右下角“未同步”列表打开任务。
  const openUnsynced = useRef((id: string) => {});
  openUnsynced.current = (id: string) => {
    if (isAssistantPage) { setAssistantOrigin(null); navigate(previousMain.current); setChatOpen(isDesktop); }
    openTask(id);
  };
  useEffect(() => {
    const handler = (event: Event) => {
      const id = (event as CustomEvent<{ taskId: string }>).detail?.taskId;
      if (id) openUnsynced.current(id);
    };
    window.addEventListener('wwa-open-task', handler);
    return () => window.removeEventListener('wwa-open-task', handler);
  }, []);
  const detailPane = taskId ? <TaskDetailPane key={taskId} ref={detailRef} id={taskId} fallback={tasks.find((task) => task.id === taskId)} tags={tags} readonly={archived} presentation={isDesktop ? 'panel' : showChat ? 'retained' : 'modal'} panelSlot={detailSlot} onSave={patchTask} onClose={closeTask} onDirtyChange={setDetailDirty} onToggleTask={toggleTask} onCreateTask={createTask} onOpenTask={openTask} /> : null;
  const hasAccessory = !isAssistantPage && (showChat || (isDesktop && Boolean(taskId)));
  const navWidth = !wide && showChat && !isAssistantPage ? '56px' : !isAssistantPage && page === 'plan' ? '188px' : '232px';
  return <FocusProvider>
    <div data-assistant-open={showChat || undefined} className="app-backdrop h-dvh overflow-hidden bg-background p-0 xl:p-4">
      <div className={cn('app-frame h-full overflow-hidden', isDesktop ? 'grid' : 'flex flex-col')} style={isDesktop ? { gridTemplateColumns: hasAccessory ? `${navWidth} minmax(0, 1fr) 400px` : `${navWidth} minmax(0, 1fr)`, gridTemplateRows: '48px minmax(0, 1fr)' } : undefined}>
        {isDesktop ? <Sidebar compact={!wide && showChat && !isAssistantPage} key="sidebar" route={route} page={isAssistantPage ? 'chat' : page} topics={topics} topicsLoading={topicsQuery.isLoading} selectedTopicId={selectedTopicId} onNavigate={navigateSafely} onSelectTopic={selectTopic} onEditTopic={setTopicForm} onNewTopic={newTopic} /> : <div key="sidebar" className="hidden" />}
        <header className="flex h-12 shrink-0 items-center justify-end border-b px-4" style={isDesktop ? { gridColumn: '2 / -1', gridRow: 1 } : undefined}>{!isAssistantPage && <Button variant="ghost" size="sm" onClick={openChat} aria-label="打开 AI 助手"><Sparkles className="size-4" />AI 助手</Button>}</header>
        <main key="main" className={cn('app-main glass-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto bg-[var(--glass-bg-strong)]', ((!isDesktop && showChat) || (isDesktop && showChat && taskId) || sourceView || isAssistantPage) && 'hidden')} style={isDesktop ? { gridColumn: 2, gridRow: 2 } : undefined}>{content}</main>
        {sourceView && <section className={cn('min-h-0 overflow-auto p-5', (isAssistantPage || (!isDesktop && showChat)) && 'hidden')} style={isDesktop ? { gridColumn: 2, gridRow: 2 } : undefined} aria-label="来源原文"><Button variant="ghost" onClick={() => setSourceView(null)}>返回页面</Button><h2 className="my-3 text-lg font-semibold">{sourceView.title}</h2><pre className="whitespace-pre-wrap break-words text-sm">{sourceView.content}</pre></section>}
        <div ref={setDetailSlot} className={cn('min-h-0 min-w-0 overflow-hidden border-l', isDesktop && taskId && !sourceView && !isAssistantPage ? '' : 'hidden')} style={isDesktop ? { gridColumn: showChat ? 2 : 3, gridRow: 2 } : undefined} />
        <div key="accessory" ref={setAssistantSlot} className={cn('accessory-pane min-h-0 min-w-0 flex-1 overflow-hidden border-l', showChat && !workspaceView && !isAssistantPage ? '' : 'hidden')} style={isDesktop ? { gridColumn: 3, gridRow: 2 } : undefined} />
        <div ref={setAssistantPageSlot} data-testid="assistant-page" className={cn('min-h-0 min-w-0 flex-1 overflow-hidden', !isAssistantPage && 'hidden')} style={isDesktop ? { gridColumn: '2 / -1', gridRow: 2 } : undefined} />
        {!isDesktop && (!showChat || isAssistantPage) && (() => {
          // 服务端配置驱动手机底栏；初次加载失败时按默认四项显示，不回写服务器。
          const visibleViews = mobileNavigation.data?.visibleViews ?? DEFAULT_MOBILE_NAVIGATION.visibleViews;
          const items = [...visibleViews.map(mobileNavigationItem), moreItem];
          const selected = mobileSelectedView(route, visibleViews);
          return <nav aria-label="主导航" data-testid="mobile-bottom-navigation" className="mobile-tab-bar glass-surface grid shrink-0 rounded-none border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)]" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>{items.map(({ view, label, icon: Icon }) => <button key={view} data-view={view} className={cn('mobile-tab-item flex min-w-0 flex-col items-center gap-1 py-3 text-[11px]', selected === view ? 'text-foreground' : 'text-muted-foreground')} onClick={() => navigateSafely(view)} aria-current={selected === view ? 'page' : undefined}><Icon className="size-5" />{label}</button>)}</nav>;
        })()}
      </div>
    </div>
    {createPortal(chatPanel, assistantHost)}
    <UploadQueue />
    <SkillEditorHost />
    <FocusChip />
    {workspaceView && <WorkspaceModal suspended={isAssistantPage} assistantOpen={showChat} assistantSlot={setWorkspaceAssistantSlot} onOpenAssistant={openChat} view={workspaceView} onViewChange={navigateSafely} onClose={() => navigateSafely(previousMain.current)} settings={<SettingsView />} changes={<ChangesPage />} trash={<TrashPage tasks={trashQuery.data ?? []} loading={trashQuery.isLoading} onRestore={(task) => run(actions.write(`/api/trash/tasks/${task.id}/restore`, 'POST', undefined, [task.id, ...(task.parentId ? [task.parentId] : []), ...(task.children ?? (trashQuery.data ?? []).filter((child) => child.parentId === task.id)).map((child) => child.id)], '任务已恢复'))} onPermanentDelete={(task) => run(permanentDelete(task))} />} />}
    {detailPane}
    {topicForm && <TopicModal form={topicForm} onChange={setTopicForm} onClose={() => { if (!actions.pending) setTopicForm(null); }} onSave={() => run(saveTopic())} onDelete={() => run(archiveTopic(topicForm))} busy={actions.pending} />}
    {prompt && <ActionDialog prompt={prompt} onResolve={(value) => { prompt.resolve(value); setPrompt(null); }} />}
  </FocusProvider>;
}
