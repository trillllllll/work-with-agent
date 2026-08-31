import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import './style.css';

type Topic = { id: string; name: string; description: string; isExploration: boolean };
type Status = 'todo' | 'doing' | 'blocked' | 'done';
type Task = { id: string; topicId: string; title: string; description: string; status: Status; resultSummary: string };
const statuses: { value: Status; label: string }[] = [
  { value: 'todo', label: '待办' }, { value: 'doing', label: '进行中' },
  { value: 'blocked', label: '已阻塞' }, { value: 'done', label: '已完成' },
];

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`http://localhost:3001${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : '请求失败');
  return body.data;
}

function App() {
  const queryClient = useQueryClient();
  const [selectedTopicId, setSelectedTopicId] = useState('');
  const [topicForm, setTopicForm] = useState<any>(null);
  const [taskForm, setTaskForm] = useState<any>(null);
  const [error, setError] = useState('');
  const topicsQuery = useQuery<Topic[]>({ queryKey: ['topics'], queryFn: () => api('/api/topics') });
  const topics = topicsQuery.data ?? [];
  useEffect(() => { if (!selectedTopicId && topics[0]) setSelectedTopicId(topics[0].id); if (selectedTopicId && !topics.some((topic) => topic.id === selectedTopicId)) setSelectedTopicId(topics[0]?.id ?? ''); }, [topics, selectedTopicId]);
  const selectedTopic = topics.find((topic) => topic.id === selectedTopicId);
  const tasksQuery = useQuery<Task[]>({ queryKey: ['tasks', selectedTopicId], queryFn: () => api(`/api/tasks?topicId=${selectedTopicId}`), enabled: Boolean(selectedTopicId) });
  const invalidate = () => { queryClient.invalidateQueries({ queryKey: ['topics'] }); queryClient.invalidateQueries({ queryKey: ['tasks', selectedTopicId] }); };
  const saveTopic = useMutation({ mutationFn: (form: any) => api(form.id ? `/api/topics/${form.id}` : '/api/topics', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(form) }), onSuccess: (topic: Topic) => { setTopicForm(null); setSelectedTopicId(topic.id); invalidate(); }, onError: (e: Error) => setError(e.message) });
  const deleteTopic = useMutation({ mutationFn: (id: string) => api(`/api/topics/${id}`, { method: 'DELETE' }), onSuccess: () => { setSelectedTopicId(''); invalidate(); }, onError: (e: Error) => setError(e.message) });
  const saveTask = useMutation({ mutationFn: (form: any) => api(form.id ? `/api/tasks/${form.id}` : '/api/tasks', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(form.id ? { title: form.title, description: form.description, resultSummary: form.resultSummary } : { ...form, topicId: selectedTopicId }) }), onSuccess: () => { setTaskForm(null); invalidate(); }, onError: (e: Error) => setError(e.message) });
  const updateTask = useMutation({ mutationFn: ({ id, status }: { id: string; status: Status }) => api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), onSuccess: invalidate, onError: (e: Error) => setError(e.message) });
  const deleteTask = useMutation({ mutationFn: (id: string) => api(`/api/tasks/${id}`, { method: 'DELETE' }), onSuccess: invalidate, onError: (e: Error) => setError(e.message) });
  const grouped = useMemo(() => Object.fromEntries(statuses.map(({ value }) => [value, (tasksQuery.data ?? []).filter((task) => task.status === value)])) as Record<Status, Task[]>, [tasksQuery.data]);

  return <main className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">A</span><div><strong>Agent 工作室</strong><small>工作推进台</small></div></div><div className="sidebar-heading"><span>主题</span><button className="icon-button" title="新建主题" onClick={() => setTopicForm({ name: '', description: '', isExploration: true })}>+</button></div><div className="topic-list">{topics.map((topic) => <div className={`topic-row ${topic.id === selectedTopicId ? 'selected' : ''}`} key={topic.id}><button className="topic-button" onClick={() => setSelectedTopicId(topic.id)}><span className="topic-dot" />{topic.name}{topic.isExploration && <em>探索</em>}</button><button className="more-button" title="编辑主题" onClick={() => setTopicForm(topic)}>···</button></div>)}{!topics.length && !topicsQuery.isLoading && <p className="muted">还没有主题，先创建一个。</p>}</div><div className="sidebar-footer">本地工作区</div></aside>
    <section className="workspace"><header className="workspace-header"><div><span className="eyebrow">任务管理</span><h1>{selectedTopic?.name ?? '选择一个主题'}</h1><p>{selectedTopic?.description || '把想法拆成下一步，持续推进到结果。'}</p></div>{selectedTopic && <div className="header-actions"><button className="secondary danger" onClick={() => { if (confirm('确定删除这个主题吗？')) deleteTopic.mutate(selectedTopic.id); }}>删除主题</button><button className="primary" onClick={() => setTaskForm({ title: '', description: '', resultSummary: '' })}>+ 新建任务</button></div>}</header>{error && <div className="alert"><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}{!selectedTopic && <div className="empty-state"><div className="empty-icon">✦</div><h2>从一个主题开始</h2><p>主题是任务逐渐收敛成结果的容器。</p><button className="primary" onClick={() => setTopicForm({ name: '', description: '', isExploration: true })}>创建探索主题</button></div>}{selectedTopic && (tasksQuery.isLoading ? <div className="loading">正在加载任务…</div> : <div className="board">{statuses.map(({ value, label }) => <div className="column" key={value}><div className="column-heading"><h2>{label}</h2><span>{grouped[value].length}</span></div><div className="task-list">{grouped[value].map((task) => <article className="task-card" key={task.id}><div className="task-card-top"><button className="task-title" onClick={() => setTaskForm(task)}>{task.title}</button><button className="more-button" title="删除任务" onClick={() => { if (confirm('确定删除这个任务吗？')) deleteTask.mutate(task.id); }}>×</button></div>{task.description && <p>{task.description}</p>}{task.resultSummary && <div className="result-summary">结果：{task.resultSummary}</div>}<select value={task.status} onChange={(event) => updateTask.mutate({ id: task.id, status: event.target.value as Status })}>{statuses.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></article>)}</div>{value === 'todo' && <button className="add-inline" onClick={() => setTaskForm({ title: '', description: '', resultSummary: '' })}>+ 添加任务</button>}</div>)}</div>)} </section>
    <aside className="chat-panel"><div className="chat-header"><span className="eyebrow">协作空间</span><h2>全局聊天</h2><span className="status-pill">即将接入</span></div><div className="chat-empty"><div className="chat-orbit">✦</div><p>Agent 会在这里陪你拆解任务、整理主题，并在执行变更前请求审核。</p></div><div className="chat-input"><input disabled placeholder="Agent 聊天将在下一阶段接入" /><button disabled>发送</button></div></aside>
    {topicForm && <TopicModal form={topicForm} onChange={setTopicForm} onClose={() => setTopicForm(null)} onSave={() => saveTopic.mutate(topicForm)} />}{taskForm && <TaskModal form={taskForm} onChange={setTaskForm} onClose={() => setTaskForm(null)} onSave={() => saveTask.mutate(taskForm)} />}
  </main>;
}

function TopicModal({ form, onChange, onClose, onSave }: any) { return <div className="modal-backdrop"><form className="modal" onSubmit={(event) => { event.preventDefault(); onSave(); }}><div className="modal-heading"><h2>{form.id ? '编辑主题' : '新建主题'}</h2><button type="button" className="close-button" onClick={onClose}>×</button></div><label>主题名称<input autoFocus required value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="例如：Agent 工作室" /></label><label>描述<textarea value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="这个主题最终想形成什么结果？" /></label><label className="checkbox"><input type="checkbox" checked={form.isExploration} onChange={(event) => onChange({ ...form, isExploration: event.target.checked })} /> 当前仍在探索</label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary">保存主题</button></div></form></div>; }
function TaskModal({ form, onChange, onClose, onSave }: any) { return <div className="modal-backdrop"><form className="modal" onSubmit={(event) => { event.preventDefault(); onSave(); }}><div className="modal-heading"><h2>{form.id ? '编辑任务' : '新建任务'}</h2><button type="button" className="close-button" onClick={onClose}>×</button></div><label>任务名称<input autoFocus required value={form.title} onChange={(event) => onChange({ ...form, title: event.target.value })} placeholder="下一步要完成什么？" /></label><label>任务描述<textarea value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="补充背景、范围或验收标准" /></label><label>结果摘要<textarea value={form.resultSummary} onChange={(event) => onChange({ ...form, resultSummary: event.target.value })} placeholder="完成后记录最终结果" /></label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary">保存任务</button></div></form></div>; }

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
