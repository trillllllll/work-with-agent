import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, CalendarDays, FolderKanban, History, Inbox, Menu, MessageSquare, Plus, Search, Settings, Tags, Trash2 } from 'lucide-react';
import { api, ApiError, statuses, type Status, type Tag, type Task, type Topic, type TrashTask, type View } from './lib/api.js';
import { queryKeys, type TaskDraft } from './lib/todo.js';
import { useChat } from './hooks/useChat.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import { useMediaQuery } from './hooks/useMediaQuery.js';
import { useLocalDate, useTasks, useTodoActions } from './hooks/useTodo.js';
import { useWorkspaceEvents } from './hooks/useWorkspaceEvents.js';
import { ConnectionsPage } from './components/workspace/ConnectionsPage.js';
import { ProposalsPage } from './components/workspace/ProposalsPage.js';
import { KnowledgePage } from './components/workspace/KnowledgePage.js';
import { RunsPage } from './components/workspace/HandoffPanel.js';
import { ReviewsPage } from './components/workspace/ReviewsPage.js';
import { TopicList, TopicListPage } from './components/topics/TopicList.js';
import { TopicModal } from './components/topics/TopicModal.js';
import { TaskDetailPane, type TaskDetailHandle } from './components/tasks/TaskExpand.js';
import { SummaryPanel } from './components/board/SummaryPanel.js';
import { BoardColumn, TaskCard } from './components/board/BoardColumn.js';
import { ChatPanel } from './components/chat/ChatPanel.js';
import { SettingsView } from './components/settings/SettingsView.js';
import { TrashPage } from './components/trash/TrashPage.js';
import { ChangesPage } from './components/changes/ChangesPage.js';
import { WorkspaceModal, type WorkspaceModalView } from './components/workspace/WorkspaceModal.js';
import { ActionDialog, type ActionPrompt } from './components/dialogs/ActionDialog.js';
import { QuickCapture, type QuickCaptureHandle } from './components/tasks/QuickCapture.js';
import { TaskFilterBar, type TaskFilters } from './components/tasks/TaskFilterBar.js';
import { TaskList } from './components/tasks/TaskList.js';
import { withSortOrder } from './components/tasks/task-order.js';
import { TagManager } from './components/tasks/TagManager.js';
import { ThemeToggle } from './components/layout/ThemeToggle.js';
import { BrandMark } from './components/layout/BrandMark.js';
import { Button } from './components/ui/button.js';
import { cn } from './lib/utils.js';
import { toast } from 'sonner';

const navigation: { view: View; label: string; icon: typeof Inbox }[] = [
  { view: 'inbox', label: '收集箱', icon: Inbox }, { view: 'today', label: '今天', icon: CalendarDays },
  { view: 'topics', label: '清单', icon: FolderKanban }, { view: 'search', label: '搜索', icon: Search },
  { view: 'tags', label: '标签', icon: Tags }, { view: 'archived', label: '已归档', icon: Archive },
  { view: 'trash', label: '回收站', icon: Trash2 }, { view: 'changes', label: '变更历史', icon: History },
  { view: 'settings', label: '设置', icon: Settings },
  { view: 'connections', label: 'AI 连接', icon: MessageSquare },
  { view: 'proposals', label: '待确认', icon: Inbox },
  { view: 'knowledge', label: '项目资料', icon: FolderKanban },
  { view: 'runs', label: 'AI 执行', icon: History },
  { view: 'reviews', label: '定期回顾', icon: CalendarDays },
];
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
  const { route, navigate } = useHashRoute();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [selectedTopicId, setSelectedTopicId] = useState(() => localStorage.getItem('todo.selectedTopic') ?? '');
  const [chatOpen, setChatOpen] = useState(false);
  const [topicForm, setTopicForm] = useState<Partial<Topic> | null>(null);
  const [taskId, setTaskId] = useState('');
  const [layout, setLayout] = useState<'list' | 'board'>('list');
  const [sortMode, setSortMode] = useState('manual');
  const [filters, setFilters] = useState<TaskFilters>(emptyFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedTag, setSelectedTag] = useState('');
  const [prompt, setPrompt] = useState<(ActionPrompt & { resolve: (value: boolean) => void }) | null>(null);
  const topicSaveLock = useRef(false);
  const detailRef = useRef<TaskDetailHandle>(null);
  const [detailDirty, setDetailDirty] = useState(false);
  const captureRef = useRef<QuickCaptureHandle>(null);
  const previousMain = useRef<View>('inbox');
  const workspaceView: WorkspaceModalView | null = ['settings', 'trash', 'changes'].includes(route) ? route as WorkspaceModalView : null;
  const page = workspaceView || route === 'chat' ? previousMain.current : route;
  useEffect(() => { if (!workspaceView && route !== 'chat') previousMain.current = route; }, [route, workspaceView]);
  useEffect(() => { setFilters(emptyFilters); setFiltersOpen(false); setLayout('list'); setSortMode('manual'); }, [page, selectedTopicId]);
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
  const topicDetail = useQuery<Topic>({ queryKey: queryKeys.topic(selectedTopicId), queryFn: () => api(`/api/topics/${selectedTopicId}?includeArchived=true`), enabled: Boolean(selectedTopicId) && page === 'board' });
  const detail = topicDetail.data ?? selectedTopic;
  const archived = page === 'board' && Boolean(detail?.archivedAt);
  const scoped = page === 'inbox' || page === 'board';
  const hasFilters = Boolean(filters.q || filters.status !== 'all' || filters.dueFrom || filters.dueTo || filters.tag);
  const params: Record<string, string> = { status: page === 'today' ? 'open' : filters.status, sort: scoped ? sortMode : 'date' };
  if (page === 'inbox' || (!scoped && filters.topic === 'inbox')) params.inbox = 'true';
  if (page === 'board') params.topicId = selectedTopicId;
  else if (!scoped && filters.topic !== 'all' && filters.topic !== 'inbox') params.topicId = filters.topic;
  if (archived) params.includeArchived = 'true';
  if (filters.q) params.q = filters.q;
  if (filters.dueFrom) params.dueFrom = filters.dueFrom;
  if (filters.dueTo) params.dueTo = filters.dueTo;
  if (page === 'today') params.dueTo = today;
  if (page === 'tags' ? selectedTag : filters.tag) params.tagIds = page === 'tags' ? selectedTag : filters.tag;
  const taskPage = ['inbox', 'board', 'today', 'search', 'tags'].includes(page);
  const tasksQuery = useTasks(params, taskPage && (page !== 'board' || Boolean(selectedTopicId)) && (page !== 'tags' || Boolean(selectedTag)));
  const tasks = tasksQuery.data ?? [];
  const taggedSections = page === 'tags' && selectedTag ? classificationSections(tasks, topics) : [];
  const chat = useChat({ selectedTopicId: page === 'inbox' ? '' : selectedTopicId, view: page === 'inbox' ? 'inbox' : 'board', onError: (message) => { if (message) toast.error(message); } });
  const transitionFromDetail = (action: () => void) => {
    if (taskId && detailRef.current) detailRef.current.requestTransition(action);
    else action();
  };
  const navigateSafely = (view: View) => transitionFromDetail(() => { setTaskId(''); setChatOpen(false); navigate(view); });
  const selectTopic = (id: string) => transitionFromDetail(() => { setTaskId(''); setChatOpen(false); setSelectedTopicId(id); navigate('board'); });
  const openTask = (id: string) => {
    if (id === taskId) return;
    transitionFromDetail(() => { setTaskId(id); setChatOpen(false); });
  };
  const openChat = () => transitionFromDetail(() => setChatOpen(true));
  const newTopic = () => setTopicForm({ name: '', description: '', isExploration: false });
  const createTask = (input: { title: string; topicId: string | null; parentId: string | null }) => actions.create(input, input.parentId);
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
      const response = await actions.write<Topic>(topicForm.id ? `/api/topics/${topicForm.id}` : '/api/topics', topicForm.id ? 'PATCH' : 'POST', { expectedRevision: topicForm.revision, name: topicForm.name.trim(), description: topicForm.description ?? '', isExploration: topicForm.isExploration ?? false, ...(topicForm.goal !== undefined ? { goal: topicForm.goal } : {}) }, [topicForm.id ?? 'topic-create'], topicForm.id ? '清单已更新' : '清单已创建');
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
  const listProps = { topics, tags, onOpen: openTask, onToggle: toggleTask, onMove: moveTask, onDelete: (task: Task) => run(deleteTask(task)), onSave: patchTask, onCreate: createTask, readonly: archived, busy: actions.pending, selectedTaskId: taskId, textDirty: detailDirty };
  const navButton = ({ view, label, icon: Icon }: typeof navigation[number]) => <button key={view} type="button" onClick={() => navigateSafely(view)} data-active={route === view || undefined} className={cn('sidebar-nav-item relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px]', route === view ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground')} aria-current={route === view ? 'page' : undefined}><Icon className="size-4" strokeWidth={route === view ? 2.3 : 1.8} />{label}</button>;
  const title = page === 'board' ? detail?.name ?? '选择一个清单' : navigation.find((item) => item.view === page)?.label ?? '工作区';
  const updateFilter = (patch: Partial<TaskFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const taskContent = <div className="mx-auto max-w-5xl p-4 pb-10 sm:p-6">
    <header className="mb-5 border-b pb-5 glass-divider"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs text-muted-foreground">个人任务清单</p><h1 className="mt-1.5 text-3xl font-semibold tracking-tight">{title}</h1>{page === 'inbox' && <p className="mt-2 max-w-xl text-xs text-muted-foreground">这是一个分类，这里只显示放在收集箱里的任务。</p>}{page === 'today' && <p className="mt-2 text-xs text-muted-foreground">{today} · 未完成的到期任务</p>}{archived && <p className="mt-2 text-sm text-muted-foreground">此清单已归档，内容只读。</p>}</div><div className="flex flex-wrap items-center gap-2"><Button variant="ghost" size="icon" aria-label="打开聊天" onClick={() => isDesktop ? openChat() : navigateSafely('chat')}><MessageSquare /></Button>{page === 'board' && detail && !archived && <Button variant="outline" aria-label={`编辑清单：${detail.name}`} onClick={() => setTopicForm(detail)}>编辑清单</Button>}{scoped && <div className="glass-control flex rounded-xl p-1"><Button variant={layout === 'list' ? 'secondary' : 'ghost'} size="sm" onClick={() => setLayout('list')}>列表</Button><Button variant={layout === 'board' ? 'secondary' : 'ghost'} size="sm" onClick={() => setLayout('board')}>看板</Button></div>}{scoped && !archived && <Button onClick={() => captureRef.current?.focus()}><Plus />新建任务</Button>}</div></div></header>
    {page === 'board' && detail && <details className="mb-5 glass-subtle rounded-xl p-4"><summary className="cursor-pointer text-sm font-semibold">资料、记忆与当前简报</summary><KnowledgePage key={detail.id} topics={[detail]} initialTopicId={detail.id} /></details>}
    {page === 'board' && !detail ? <Button onClick={newTopic}>新建清单</Button> : <>
      {scoped && !archived && <QuickCapture ref={captureRef} key={`${page}.${selectedTopicId}`} topicId={page === 'inbox' ? null : selectedTopicId} inbox={page === 'inbox'} onCreate={createTask} />}
      {page === 'board' && detail && <details className="my-4 glass-subtle rounded-xl p-3"><summary className="cursor-pointer text-sm text-muted-foreground">探索与成果</summary><p className="mt-3 whitespace-pre-wrap text-sm">{detail.description}</p>{detail.goal && <p className="mt-2 text-sm">目标：{detail.goal}</p>}<SummaryPanel detail={detail} busy={actions.pending} onConfirm={archived ? undefined : (action) => run(actions.write(`/api/topics/${detail.id}/summary/${action}`, 'POST', undefined, [detail.id], action === 'confirm' ? '成果已确认' : '草稿已放弃'))} /></details>}
      {page === 'tags' && <TagManager tags={tags} selected={selectedTag} onSelect={setSelectedTag} confirm={confirm} />}
      {taskPage && <TaskFilterBar page={page} scoped={scoped} filters={filters} sortMode={sortMode} topics={topics} tags={tags} open={filtersOpen} onOpenChange={setFiltersOpen} onChange={updateFilter} onSort={setSortMode} onClear={() => setFilters(emptyFilters)} />}
      {scoped && <p className="mb-3 text-xs text-muted-foreground">{hasFilters ? '筛选期间不能手动排序；清除筛选后可调整完整列表。' : archived ? '恢复清单后可编辑和排序。' : sortMode !== 'manual' ? '切换为手动排序后，可调整任务位置。' : '包含已完成任务。上下拖动调整顺序，向右拖成子任务，向左拖回根任务。'}</p>}
      {tasksQuery.isLoading ? <p className="py-12 text-center text-muted-foreground">正在加载任务…</p> : tasksQuery.error ? <p role="alert" className="text-destructive">{tasksQuery.error.message}</p> : page === 'today' ? <div className="space-y-6">{[{ name: '逾期', items: tasks.filter((task) => task.dueDate && task.dueDate < today) }, { name: '今天', items: tasks.filter((task) => task.dueDate === today) }].map((group) => <section key={group.name}><h2 className="mb-3 text-sm font-semibold">{group.name} · {group.items.length}</h2><TaskList {...listProps} tasks={group.items} /></section>)}</div> : scoped && layout === 'board' ? <div className="mt-5 flex gap-3 overflow-x-auto pb-4 snap-x snap-mandatory md:grid md:grid-cols-2 md:overflow-visible xl:grid-cols-4">{statuses.map(({ value, label }) => <BoardColumn key={value} label={label} count={tasks.filter((task) => task.status === value).length}>{tasks.filter((task) => task.status === value).map((task) => <TaskCard key={task.id} task={task} topics={topics} tags={tags} selected={taskId === task.id} readonly={archived} busy={actions.pending} textDirty={detailDirty} onOpen={openTask} onToggle={toggleTask} onMove={moveTask} onDelete={(item) => run(deleteTask(item))} onSave={patchTask} onCreate={createTask} onUpdateStatus={(id, status: Status) => { const item = tasks.find((candidate) => candidate.id === id); if (item) run(patchTask(item, { status })); }} />)}</BoardColumn>)}</div> : page === 'tags' ? (selectedTag ? <div className="space-y-6">{taggedSections.map((section) => <section key={section.id} aria-label={section.name}><h2 className="mb-3 text-sm font-semibold">{section.name} · {section.items.length}</h2><TaskList {...listProps} tasks={section.items} /></section>)}{!taggedSections.length && <p className="py-12 text-center text-sm text-muted-foreground">暂无任务</p>}</div> : <p className="py-12 text-center text-sm text-muted-foreground">选择一个标签后，按分类查看带有该标签的任务。</p>) : <TaskList {...listProps} tasks={tasks} hierarchical={scoped && !hasFilters && sortMode === 'manual'} onReorder={scoped && !hasFilters && !archived && sortMode === 'manual' ? reorder : undefined} onNest={scoped && !hasFilters && !archived && sortMode === 'manual' ? nest : undefined} />}
    </>}
  </div>;
  const content = page === 'connections' ? <ConnectionsPage topics={topics} /> : page === 'proposals' ? <ProposalsPage /> : page === 'knowledge' ? <KnowledgePage topics={topics} initialTopicId={selectedTopicId} /> : page === 'runs' ? <RunsPage /> : page === 'reviews' ? <ReviewsPage topics={topics} /> : taskPage ? taskContent : page === 'topics' ? <TopicListPage topics={topics} topicsLoading={topicsQuery.isLoading} selectedTopicId={selectedTopicId} onSelectTopic={selectTopic} onNewTopic={newTopic} onEditTopic={setTopicForm} onOpenSettings={() => navigateSafely('settings')} onOpenInbox={() => navigateSafely('inbox')} /> : page === 'archived' ? <div className="p-5 sm:p-7"><h1 className="mb-5 text-2xl font-semibold">已归档</h1><div className="space-y-3">{!(archivedQuery.data ?? []).length && <p className="text-sm text-muted-foreground">暂无归档清单</p>}{(archivedQuery.data ?? []).map((topic) => <article key={topic.id} className="glass-subtle flex flex-wrap items-center gap-3 rounded-xl p-4"><button className="flex-1 text-left font-medium" onClick={() => selectTopic(topic.id)}>{topic.name}</button><Button variant="outline" onClick={() => run(actions.write(`/api/topics/${topic.id}/restore`, 'POST', undefined, [topic.id], '清单已恢复'))}>恢复清单</Button><Button variant="outline" onClick={() => run((async () => { if (await confirm({ title: '移出归档清单的任务', description: `将“${topic.name}”的任务移到收集箱，保留父子关系。`, confirm: '移出任务' })) await actions.write(`/api/topics/${topic.id}/move-tasks-to-inbox`, 'POST', undefined, [topic.id], '任务已移入收集箱'); })())}>移出任务到收集箱</Button></article>)}</div></div> : <div className="p-5"><h1 className="mb-5 text-2xl font-semibold">工作区</h1>{navigation.map(navButton)}<Button className="mt-4" variant="outline" onClick={() => navigateSafely('chat')}><MessageSquare />打开聊天</Button><div className="mt-4"><ThemeToggle /></div></div>;
  const chatPanel = <ChatPanel chat={chat} onClose={() => { setChatOpen(false); if (!isDesktop || route === 'chat') navigate(previousMain.current); }} />;
  const showChat = chatOpen || route === 'chat';
  const closeTask = () => { setDetailDirty(false); setTaskId(''); };
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  useEffect(() => {
    if (!taskIdRef.current) return;
    detailRef.current?.requestTransition(closeTask);
  }, [page]);
  const detailPane = taskId ? <TaskDetailPane key={taskId} ref={detailRef} id={taskId} fallback={tasks.find((task) => task.id === taskId)} tags={tags} readonly={archived} presentation={isDesktop ? 'panel' : 'modal'} onSave={patchTask} onClose={closeTask} onDirtyChange={setDetailDirty} /> : null;
  const hasAccessory = showChat || (isDesktop && Boolean(taskId));
  const navGroup = (views: View[]) => navigation.filter((item) => views.includes(item.view)).map(navButton);

  return <>
    <div className="app-backdrop h-dvh overflow-hidden bg-background p-0 xl:p-4">
      <div className={cn('app-frame h-full overflow-hidden', isDesktop ? 'grid' : 'flex flex-col')} style={isDesktop ? { gridTemplateColumns: hasAccessory ? '232px minmax(0, 1fr) minmax(340px, 400px)' : '232px minmax(0, 1fr)' } : undefined}>
        {isDesktop && <aside className="app-sidebar glass-surface flex min-h-0 flex-col border-y-0 border-l-0 p-3 xl:rounded-l-[22px] xl:border-y xl:border-l"><div className="mb-5 mt-1 px-2"><BrandMark /></div><nav aria-label="主导航" className="space-y-0.5">{navGroup(['today', 'topics', 'search'])}</nav><div className="mt-4 flex items-center justify-between px-2"><span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">分类</span><Button variant="ghost" size="icon-xs" aria-label="新建清单" onClick={newTopic}><Plus /></Button></div><div className="my-2 min-h-[5rem] max-h-[32%] overflow-y-auto"><TopicList topics={topics} loading={topicsQuery.isLoading} selectedTopicId={page === 'board' ? selectedTopicId : ''} onSelect={selectTopic} onEdit={setTopicForm} onOpenInbox={() => navigateSafely('inbox')} inboxActive={page === 'inbox'} /></div><div className="glass-scrollbar min-h-0 flex-1 overflow-y-auto border-t pt-2 glass-divider"><nav aria-label="内容导航" className="space-y-0.5">{navGroup(['tags', 'archived'])}</nav><p className="mb-1 mt-3 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">工作区</p><nav aria-label="AI 工作区导航" className="space-y-0.5">{navGroup(['connections', 'proposals', 'knowledge', 'runs', 'reviews'])}</nav></div><div className="mt-2 border-t pt-2 glass-divider"><nav aria-label="工具导航" className="space-y-0.5">{navGroup(['trash', 'changes'])}</nav><div className="mt-1 flex items-center gap-1">{navGroup(['settings'])}<ThemeToggle /></div></div></aside>}
        <main className="app-main glass-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto bg-[var(--glass-bg-strong)]">{!isDesktop && route === 'chat' ? chatPanel : content}</main>
        {isDesktop && hasAccessory && <div className="accessory-pane min-h-0 min-w-0 border-l glass-divider xl:rounded-r-[22px] xl:border-y xl:border-r">{showChat ? chatPanel : detailPane}</div>}
        {!isDesktop && <nav aria-label="主导航" className="mobile-tab-bar glass-surface grid shrink-0 grid-cols-5 rounded-none border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)]">{[...navigation.slice(0, 4), { view: 'more' as View, label: '更多', icon: Menu }].map(({ view, label, icon: Icon }) => <button key={view} className={cn('mobile-tab-item flex flex-col items-center gap-1 py-3 text-[11px]', route === view ? 'text-foreground' : 'text-muted-foreground')} onClick={() => navigateSafely(view)} aria-current={route === view ? 'page' : undefined}><Icon className="size-5" />{label}</button>)}</nav>}
      </div>
    </div>
    {workspaceView && <WorkspaceModal view={workspaceView} onViewChange={navigateSafely} onClose={() => navigateSafely(previousMain.current)} settings={<SettingsView />} changes={<ChangesPage />} trash={<TrashPage tasks={trashQuery.data ?? []} loading={trashQuery.isLoading} onRestore={(task) => run(actions.write(`/api/trash/tasks/${task.id}/restore`, 'POST', undefined, [task.id, ...(task.parentId ? [task.parentId] : []), ...(task.children ?? (trashQuery.data ?? []).filter((child) => child.parentId === task.id)).map((child) => child.id)], '任务已恢复'))} onPermanentDelete={(task) => run(permanentDelete(task))} />} />}
    {!isDesktop && detailPane}
    {topicForm && <TopicModal form={topicForm} onChange={setTopicForm} onClose={() => { if (!actions.pending) setTopicForm(null); }} onSave={() => run(saveTopic())} onDelete={() => run(archiveTopic(topicForm))} busy={actions.pending} />}
    {prompt && <ActionDialog prompt={prompt} onResolve={(value) => { prompt.resolve(value); setPrompt(null); }} />}
  </>;
}
