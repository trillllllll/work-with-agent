import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, statuses, type Status, type Task, type Topic, type TrashTask } from './lib/api.js';
import { useChat } from './hooks/useChat.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import { useMediaQuery } from './hooks/useMediaQuery.js';
import { AppShell } from './components/layout/AppShell.js';
import { Sidebar } from './components/layout/Sidebar.js';
import { TopicListPage } from './components/topics/TopicList.js';
import { BoardView } from './components/board/BoardView.js';
import { TopicModal } from './components/topics/TopicModal.js';
import { TaskModal } from './components/board/TaskModal.js';
import { ChatPanel } from './components/chat/ChatPanel.js';
import { SettingsView } from './components/settings/SettingsView.js';
import { ConfirmDialog } from './components/dialogs/ConfirmDialog.js';
import { TrashPage } from './components/trash/TrashPage.js';
import { ChangesPage } from './components/changes/ChangesPage.js';
import { WorkspaceModal, type WorkspaceModalView } from './components/workspace/WorkspaceModal.js';

export function App() {
  const queryClient = useQueryClient();
  const { route, navigate } = useHashRoute();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [selectedTopicId, setSelectedTopicId] = useState('');
  const [chatOpen, setChatOpen] = useState(true);
  const [topicForm, setTopicForm] = useState<any>(null);
  const [taskForm, setTaskForm] = useState<any>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ kind: 'topic' | 'task' | 'trash'; id: string; name: string } | null>(null);
  const notifyError = (message: string) => { if (message) toast.error(message); };

  const chat = useChat({ selectedTopicId, view: route, onError: notifyError });

  const topicsQuery = useQuery<Topic[]>({ queryKey: ['topics'], queryFn: () => api('/api/topics') });
  const topics = topicsQuery.data ?? [];
  useEffect(() => { if (!selectedTopicId && topics[0]) setSelectedTopicId(topics[0].id); if (selectedTopicId && !topicsQuery.isFetching && !topics.some((topic) => topic.id === selectedTopicId)) setSelectedTopicId(topics[0]?.id ?? ''); }, [topics, selectedTopicId, topicsQuery.isFetching]);
  const selectedTopic = topics.find((topic) => topic.id === selectedTopicId);
  const topicDetail = useQuery<Topic>({ queryKey: ['topic', selectedTopicId], queryFn: () => api(`/api/topics/${selectedTopicId}`), enabled: Boolean(selectedTopicId) });
  const detail = topicDetail.data ?? selectedTopic;
  const tasksQuery = useQuery<Task[]>({ queryKey: ['tasks', selectedTopicId], queryFn: () => api(`/api/tasks?topicId=${encodeURIComponent(selectedTopicId)}`), enabled: Boolean(selectedTopicId) });
  const trashQuery = useQuery<TrashTask[]>({ queryKey: ['trash', 'tasks'], queryFn: () => api('/api/trash/tasks') });
  const grouped = useMemo(() => Object.fromEntries(statuses.map(({ value }) => [value, (tasksQuery.data ?? []).filter((task) => task.status === value)])) as Record<Status, Task[]>, [tasksQuery.data]);

  const invalidate = () => { queryClient.invalidateQueries({ queryKey: ['topics'] }); queryClient.invalidateQueries({ queryKey: ['tasks'] }); queryClient.invalidateQueries({ queryKey: ['trash', 'tasks'] }); };
  const summaryMutation = useMutation({ mutationFn: (action: 'confirm' | 'discard') => api(`/api/topics/${selectedTopicId}/summary/${action}`, { method: 'POST' }), onSuccess: (_data, action) => { queryClient.invalidateQueries({ queryKey: ['topic', selectedTopicId] }); queryClient.invalidateQueries({ queryKey: ['topics'] }); toast.success(action === 'confirm' ? '成果已确认' : '草稿已放弃'); }, onError: (e: Error) => notifyError(e.message) });
  const saveTopic = useMutation({ mutationFn: (form: any) => api(form.id ? `/api/topics/${form.id}` : '/api/topics', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(form) }), onSuccess: (topic: Topic) => { setTopicForm(null); setSelectedTopicId(topic.id); invalidate(); toast.success(topicForm?.id ? '主题已更新' : '主题已创建'); if (!isDesktop) navigate('board'); }, onError: (e: Error) => notifyError(e.message) });
  const deleteTopic = useMutation({ mutationFn: (id: string) => api(`/api/topics/${id}`, { method: 'DELETE' }), onSuccess: () => { setDeleteConfirmation(null); setSelectedTopicId(''); invalidate(); toast.success('主题已删除'); }, onError: (e: Error) => { setDeleteConfirmation(null); notifyError(e.message); } });
  const saveTask = useMutation({ mutationFn: (form: any) => api(form.id ? `/api/tasks/${form.id}` : '/api/tasks', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(form.id ? { title: form.title, description: form.description, resultSummary: form.resultSummary } : { ...form, topicId: selectedTopicId }) }), onSuccess: () => { setTaskForm(null); invalidate(); toast.success(taskForm?.id ? '任务已更新' : '任务已创建'); }, onError: (e: Error) => notifyError(e.message) });
  const updateTask = useMutation({ mutationFn: ({ id, status }: { id: string; status: Status }) => api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), onSuccess: invalidate, onError: (e: Error) => notifyError(e.message) });
  const deleteTask = useMutation({ mutationFn: (id: string) => api(`/api/tasks/${id}`, { method: 'DELETE' }), onSuccess: () => { setDeleteConfirmation(null); invalidate(); toast.success('任务已删除'); }, onError: (e: Error) => { setDeleteConfirmation(null); notifyError(e.message); } });
  const restoreTask = useMutation({ mutationFn: (id: string) => api(`/api/trash/tasks/${id}/restore`, { method: 'POST' }), onSuccess: () => { setDeleteConfirmation(null); invalidate(); queryClient.invalidateQueries({ queryKey: ['trash', 'tasks'] }); toast.success('任务已恢复'); }, onError: (e: Error) => notifyError(e.message) });
  const permanentDeleteTask = useMutation({ mutationFn: (id: string) => api(`/api/trash/tasks/${id}/permanent`, { method: 'DELETE' }), onSuccess: () => { setDeleteConfirmation(null); queryClient.invalidateQueries({ queryKey: ['trash', 'tasks'] }); toast.success('任务已永久删除'); }, onError: (e: Error) => { setDeleteConfirmation(null); notifyError(e.message); } });

  const workspaceModalView: WorkspaceModalView | null = route === 'settings' || route === 'trash' || route === 'changes' ? route : null;
  const closeWorkspaceModal = () => navigate('board');
  const openWorkspaceModal = (view: WorkspaceModalView) => navigate(view);
  const closeChat = () => { if (isDesktop) setChatOpen(false); else navigate('board'); };

  const openNewTopic = () => setTopicForm({ name: '', description: '', isExploration: true });
  const openNewTask = () => setTaskForm({ title: '', description: '', resultSummary: '' });

  return (
    <>
      <AppShell
        route={route}
        isDesktop={isDesktop}
        navigate={navigate}
        sidebar={
          <Sidebar
            topics={topics}
            topicsLoading={topicsQuery.isLoading}
            selectedTopicId={selectedTopicId}
            onSelectTopic={setSelectedTopicId}
            onNewTopic={openNewTopic}
            onEditTopic={(topic) => setTopicForm(topic)}
            settingsActive={route === 'settings'}
            onToggleSettings={() => navigate(route === 'settings' ? 'board' : 'settings')}
            trashActive={route === 'trash'}
            onOpenTrash={() => navigate('trash')}
            changesActive={route === 'changes'}
            onOpenChanges={() => navigate('changes')}
          />
        }
        board={
          <BoardView
            detail={detail}
            hasTopic={Boolean(selectedTopic)}
            grouped={grouped}
            tasksLoading={tasksQuery.isLoading}
            summaryBusy={summaryMutation.isPending}
            onNewTopic={openNewTopic}
            onNewTask={openNewTask}
            onDeleteTopic={() => selectedTopic && setDeleteConfirmation({ kind: 'topic', id: selectedTopic.id, name: selectedTopic.name })}
            onEditTask={(task) => setTaskForm(task)}
            onDeleteTask={(task) => setDeleteConfirmation({ kind: 'task', id: task.id, name: task.title })}
            onUpdateTaskStatus={(id, status) => updateTask.mutate({ id, status })}
            onConfirmSummary={(action) => summaryMutation.mutate(action)}
            onOpenSettings={() => navigate('settings')}
            showOpenChat={!chatOpen && isDesktop}
            onOpenChat={() => setChatOpen(true)}
          />
        }
        chatOpen={chatOpen}
        chat={<ChatPanel chat={chat} onClose={closeChat} />}
        topics={
          <TopicListPage
            topics={topics}
            topicsLoading={topicsQuery.isLoading}
            selectedTopicId={selectedTopicId}
            onSelectTopic={(id) => { setSelectedTopicId(id); navigate('board'); }}
            onNewTopic={openNewTopic}
            onEditTopic={(topic) => setTopicForm(topic)}
            onOpenSettings={() => navigate('settings')}
          />
        }
      />
      {workspaceModalView && (
        <WorkspaceModal
          view={workspaceModalView}
          onViewChange={openWorkspaceModal}
          onClose={closeWorkspaceModal}
          settings={<SettingsView />}
          trash={<TrashPage tasks={trashQuery.data ?? []} loading={trashQuery.isLoading} onRestore={(task) => restoreTask.mutate(task.id)} onPermanentDelete={(task) => setDeleteConfirmation({ kind: 'trash', id: task.id, name: task.title })} />}
          changes={<ChangesPage />}
        />
      )}
      {topicForm && <TopicModal form={topicForm} onChange={setTopicForm} onClose={() => setTopicForm(null)} onSave={() => saveTopic.mutate(topicForm)} busy={saveTopic.isPending} />}
      {taskForm && <TaskModal form={taskForm} onChange={setTaskForm} onClose={() => setTaskForm(null)} onSave={() => saveTask.mutate(taskForm)} busy={saveTask.isPending} />}
      {deleteConfirmation && <ConfirmDialog title={deleteConfirmation.kind === 'topic' ? '删除主题' : deleteConfirmation.kind === 'trash' ? '永久删除任务' : '删除任务'} itemName={deleteConfirmation.name} description={deleteConfirmation.kind === 'topic' ? '删除前请确认该主题不再需要。非空主题会被系统拒绝删除。' : deleteConfirmation.kind === 'trash' ? '永久删除后无法恢复该任务，请确认继续。' : '删除后任务会移入回收站。'} busy={deleteTopic.isPending || deleteTask.isPending || permanentDeleteTask.isPending} onCancel={() => setDeleteConfirmation(null)} onConfirm={() => deleteConfirmation.kind === 'topic' ? deleteTopic.mutate(deleteConfirmation.id) : deleteConfirmation.kind === 'trash' ? permanentDeleteTask.mutate(deleteConfirmation.id) : deleteTask.mutate(deleteConfirmation.id)} />}
    </>
  );
}
