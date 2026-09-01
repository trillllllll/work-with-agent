import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import './style.css';

type Topic = { id: string; name: string; description: string; isExploration: boolean };
type Status = 'todo' | 'doing' | 'blocked' | 'done';
type Task = { id: string; topicId: string; title: string; description: string; status: Status; resultSummary: string };
type ChatMessage = { id?: string; role: 'user' | 'assistant' | 'tool' | 'system'; content: string };
type Approval = { approvalId: string; toolName: string; arguments: Record<string, unknown>; status?: string };
type SseEvent = { type: string; conversationId?: string; delta?: string; message?: string; toolName?: string; arguments?: Record<string, unknown>; approvalId?: string; result?: { success: boolean; data?: unknown; error?: string } };
const statuses: { value: Status; label: string }[] = [{ value: 'todo', label: '待办' }, { value: 'doing', label: '进行中' }, { value: 'blocked', label: '已阻塞' }, { value: 'done', label: '已完成' }];
const toolLabels: Record<string, string> = { create_task: '创建任务', update_task: '更新任务', delete_task: '删除任务', create_topic: '创建主题', update_topic: '更新主题' };
const API_URL = 'http://localhost:3001';

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${API_URL}${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await response.json().catch(() => ({ data: null, error: '响应格式错误' }));
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : '请求失败');
  return body.data;
}

function parseApproval(item: any): Approval {
  let args: Record<string, unknown> = {};
  try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments ?? {}; } catch { /* Keep malformed legacy data visible as empty args. */ }
  return { approvalId: item.id, toolName: item.toolName, arguments: args, status: item.status };
}

async function streamChat(body: unknown, onEvent: (event: SseEvent) => void) {
  const response = await fetch(`${API_URL}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(typeof payload?.error === 'string' ? payload.error : '聊天请求失败');
  }
  if (!response.body) throw new Error('聊天连接没有响应体');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    let event = 'message';
    const data: string[] = [];
    for (const line of lines) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).trim()); }
    if (data.length) { try { onEvent({ type: event, ...JSON.parse(data.join('\n')) }); } catch { onEvent({ type: 'error', message: '无法解析聊天事件' }); } }
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    frames.forEach(consume);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
}

function App() {
  const queryClient = useQueryClient();
  const [selectedTopicId, setSelectedTopicId] = useState('');
  const [topicForm, setTopicForm] = useState<any>(null);
  const [taskForm, setTaskForm] = useState<any>(null);
  const [error, setError] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [conversationId, setConversationId] = useState<string>(() => localStorage.getItem('agent-studio.conversationId') ?? '');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatInterrupted, setChatInterrupted] = useState(false);
  const topicsQuery = useQuery<Topic[]>({ queryKey: ['topics'], queryFn: () => api('/api/topics') });
  const topics = topicsQuery.data ?? [];
  useEffect(() => { if (!selectedTopicId && topics[0]) setSelectedTopicId(topics[0].id); if (selectedTopicId && !topics.some((topic) => topic.id === selectedTopicId)) setSelectedTopicId(topics[0]?.id ?? ''); }, [topics, selectedTopicId]);
  const selectedTopic = topics.find((topic) => topic.id === selectedTopicId);
  const tasksQuery = useQuery<Task[]>({ queryKey: ['tasks', selectedTopicId], queryFn: () => api(`/api/tasks?topicId=${encodeURIComponent(selectedTopicId)}`), enabled: Boolean(selectedTopicId) });
  const invalidate = () => { queryClient.invalidateQueries({ queryKey: ['topics'] }); queryClient.invalidateQueries({ queryKey: ['tasks'] }); };

  useEffect(() => {
    if (!conversationId) return;
    localStorage.setItem('agent-studio.conversationId', conversationId);
    Promise.all([api(`/api/conversations/${conversationId}/messages`), api('/api/agent/approvals?status=pending')]).then(([messages, pending]) => {
      setChatMessages(messages.map((message: ChatMessage) => ({ id: message.id, role: message.role, content: message.content })));
      setApprovals(pending.map(parseApproval));
    }).catch((reason: Error) => setError(reason.message));
  }, [conversationId]);

  const saveTopic = useMutation({ mutationFn: (form: any) => api(form.id ? `/api/topics/${form.id}` : '/api/topics', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(form) }), onSuccess: (topic: Topic) => { setTopicForm(null); setSelectedTopicId(topic.id); invalidate(); }, onError: (e: Error) => setError(e.message) });
  const deleteTopic = useMutation({ mutationFn: (id: string) => api(`/api/topics/${id}`, { method: 'DELETE' }), onSuccess: () => { setSelectedTopicId(''); invalidate(); }, onError: (e: Error) => setError(e.message) });
  const saveTask = useMutation({ mutationFn: (form: any) => api(form.id ? `/api/tasks/${form.id}` : '/api/tasks', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(form.id ? { title: form.title, description: form.description, resultSummary: form.resultSummary } : { ...form, topicId: selectedTopicId }) }), onSuccess: () => { setTaskForm(null); invalidate(); }, onError: (e: Error) => setError(e.message) });
  const updateTask = useMutation({ mutationFn: ({ id, status }: { id: string; status: Status }) => api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), onSuccess: invalidate, onError: (e: Error) => setError(e.message) });
  const deleteTask = useMutation({ mutationFn: (id: string) => api(`/api/tasks/${id}`, { method: 'DELETE' }), onSuccess: invalidate, onError: (e: Error) => setError(e.message) });
  const approve = useMutation({ mutationFn: (approvalId: string) => api(`/api/agent/approvals/${approvalId}/approve`, { method: 'POST' }), onSuccess: (_result, approvalId) => { setApprovals((current) => current.filter((item) => item.approvalId !== approvalId)); invalidate(); setChatMessages((current) => [...current, { role: 'tool', content: '变更已批准并执行。' }]); }, onError: (e: Error) => setError(e.message) });
  const reject = useMutation({ mutationFn: (approvalId: string) => api(`/api/agent/approvals/${approvalId}/reject`, { method: 'POST' }), onSuccess: (_result, approvalId) => { setApprovals((current) => current.filter((item) => item.approvalId !== approvalId)); setChatMessages((current) => [...current, { role: 'tool', content: '变更已拒绝，数据未修改。' }]); }, onError: (e: Error) => setError(e.message) });

  const sendChat = async (event: FormEvent) => {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message || chatBusy) return;
    setChatInput(''); setError(''); setChatInterrupted(false); setChatBusy(true);
    setChatMessages((current) => [...current, { role: 'user', content: message }]);
    let receivedDone = false;
    try {
      await streamChat({ conversationId: conversationId || undefined, message, pageContext: { topicId: selectedTopicId || null, taskId: null, page: 'board' } }, (event) => {
        if (event.conversationId && event.conversationId !== conversationId) { setConversationId(event.conversationId); localStorage.setItem('agent-studio.conversationId', event.conversationId); }
        if (event.type === 'message_start') setChatMessages((current) => [...current, { role: 'assistant', content: '' }]);
        if (event.type === 'message_delta') setChatMessages((current) => { const next = [...current]; const index = next.length - 1; if (index >= 0 && next[index].role === 'assistant') next[index] = { ...next[index], content: next[index].content + (event.delta ?? '') }; return next; });
        if (event.type === 'tool_result') setChatMessages((current) => [...current, { role: 'tool', content: event.result?.success ? JSON.stringify(event.result.data, null, 2) : event.result?.error ?? 'Tool 执行失败' }]);
        if (event.type === 'approval_required' && event.approvalId) setApprovals((current) => [...current.filter((item) => item.approvalId !== event.approvalId), { approvalId: event.approvalId!, toolName: event.toolName ?? '', arguments: event.arguments ?? {} }]);
        if (event.type === 'error') setError(event.message ?? '聊天失败');
        if (event.type === 'done') { receivedDone = true; invalidate(); }
      });
      if (!receivedDone) setChatInterrupted(true);
    } catch (reason) { setChatInterrupted(true); setError(reason instanceof Error ? reason.message : '聊天连接中断'); }
    finally { setChatBusy(false); }
  };
  const retryChat = () => { const last = [...chatMessages].reverse().find((item) => item.role === 'user'); if (last) { setChatInput(last.content); setChatInterrupted(false); } };
  const grouped = useMemo(() => Object.fromEntries(statuses.map(({ value }) => [value, (tasksQuery.data ?? []).filter((task) => task.status === value)])) as Record<Status, Task[]>, [tasksQuery.data]);

  return <main className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">A</span><div><strong>Agent 工作室</strong><small>工作推进台</small></div></div><div className="sidebar-heading"><span>主题</span><button className="icon-button" title="新建主题" onClick={() => setTopicForm({ name: '', description: '', isExploration: true })}>+</button></div><div className="topic-list">{topics.map((topic) => <div className={`topic-row ${topic.id === selectedTopicId ? 'selected' : ''}`} key={topic.id}><button className="topic-button" onClick={() => setSelectedTopicId(topic.id)}><span className="topic-dot" />{topic.name}{topic.isExploration && <em>探索</em>}</button><button className="more-button" title="编辑主题" onClick={() => setTopicForm(topic)}>···</button></div>)}{!topics.length && !topicsQuery.isLoading && <p className="muted">还没有主题，先创建一个。</p>}</div><div className="sidebar-footer">本地工作区</div></aside><section className="workspace"><header className="workspace-header"><div><span className="eyebrow">任务管理</span><h1>{selectedTopic?.name ?? '选择一个主题'}</h1><p>{selectedTopic?.description || '把想法拆成下一步，持续推进到结果。'}</p></div>{selectedTopic && <div className="header-actions"><button className="secondary danger" onClick={() => { if (confirm('确定删除这个主题吗？')) deleteTopic.mutate(selectedTopic.id); }}>删除主题</button><button className="primary" onClick={() => setTaskForm({ title: '', description: '', resultSummary: '' })}>+ 新建任务</button></div>}</header>{error && <div className="alert"><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}{!selectedTopic && <div className="empty-state"><div className="empty-icon">✦</div><h2>从一个主题开始</h2><p>主题是任务逐渐收敛成结果的容器。</p><button className="primary" onClick={() => setTopicForm({ name: '', description: '', isExploration: true })}>创建探索主题</button></div>}{selectedTopic && (tasksQuery.isLoading ? <div className="loading">正在加载任务…</div> : <div className="board">{statuses.map(({ value, label }) => <div className="column" key={value}><div className="column-heading"><h2>{label}</h2><span>{grouped[value].length}</span></div><div className="task-list">{grouped[value].map((task) => <article className="task-card" key={task.id}><div className="task-card-top"><button className="task-title" onClick={() => setTaskForm(task)}>{task.title}</button><button className="more-button" title="删除任务" onClick={() => { if (confirm('确定删除这个任务吗？')) deleteTask.mutate(task.id); }}>×</button></div>{task.description && <p>{task.description}</p>}{task.resultSummary && <div className="result-summary">结果：{task.resultSummary}</div>}<select value={task.status} onChange={(event) => updateTask.mutate({ id: task.id, status: event.target.value as Status })}>{statuses.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></article>)}</div>{value === 'todo' && <button className="add-inline" onClick={() => setTaskForm({ title: '', description: '', resultSummary: '' })}>+ 添加任务</button>}</div>)}</div>)}</section><aside className="chat-panel"><div className="chat-header"><span className="eyebrow">协作空间</span><h2>全局聊天</h2><span className="status-pill">{chatBusy ? '处理中…' : chatInterrupted ? '连接中断' : '可用'}</span></div><div className="chat-messages">{!chatMessages.length && !approvals.length && <div className="chat-empty"><div className="chat-orbit">✦</div><p>告诉 Agent 你想推进什么。只读操作会直接执行，修改任务前会请求审核。</p></div>}{chatMessages.map((message, index) => <div className={`chat-message ${message.role}`} key={`${message.id ?? index}-${index}`}><span className="message-role">{message.role === 'user' ? '你' : message.role === 'tool' ? 'Tool' : message.role === 'system' ? '系统' : 'Agent'}</span><p>{message.content}</p></div>)}{approvals.map((approval) => <div className="approval-card" key={approval.approvalId}><div className="approval-label">需要审核</div><strong>{toolLabels[approval.toolName] ?? approval.toolName}</strong><code>{JSON.stringify(approval.arguments, null, 2)}</code><div className="approval-actions"><button className="secondary" disabled={approve.isPending || reject.isPending} onClick={() => reject.mutate(approval.approvalId)}>拒绝</button><button className="primary" disabled={approve.isPending || reject.isPending} onClick={() => approve.mutate(approval.approvalId)}>批准执行</button></div></div>)}{chatInterrupted && <div className="alert"><span>聊天连接中断，已保留收到的内容。</span><button onClick={retryChat}>重试</button></div>}</div><form className="chat-input" onSubmit={sendChat}><input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="例如：创建任务：整理 API 文档" /><button className="primary" disabled={chatBusy || !chatInput.trim()}>发送</button></form></aside>{topicForm && <TopicModal form={topicForm} onChange={setTopicForm} onClose={() => setTopicForm(null)} onSave={() => saveTopic.mutate(topicForm)} />}{taskForm && <TaskModal form={taskForm} onChange={setTaskForm} onClose={() => setTaskForm(null)} onSave={() => saveTask.mutate(taskForm)} />}</main>;
}

function TopicModal({ form, onChange, onClose, onSave }: any) { return <div className="modal-backdrop"><form className="modal" onSubmit={(event) => { event.preventDefault(); onSave(); }}><div className="modal-heading"><h2>{form.id ? '编辑主题' : '新建主题'}</h2><button type="button" className="close-button" onClick={onClose}>×</button></div><label>主题名称<input autoFocus required value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="例如：Agent 工作室" /></label><label>描述<textarea value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="这个主题最终想形成什么结果？" /></label><label className="checkbox"><input type="checkbox" checked={form.isExploration} onChange={(event) => onChange({ ...form, isExploration: event.target.checked })} /> 当前仍在探索</label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary">保存主题</button></div></form></div>; }
function TaskModal({ form, onChange, onClose, onSave }: any) { return <div className="modal-backdrop"><form className="modal" onSubmit={(event) => { event.preventDefault(); onSave(); }}><div className="modal-heading"><h2>{form.id ? '编辑任务' : '新建任务'}</h2><button type="button" className="close-button" onClick={onClose}>×</button></div><label>任务名称<input autoFocus required value={form.title} onChange={(event) => onChange({ ...form, title: event.target.value })} placeholder="下一步要完成什么？" /></label><label>任务描述<textarea value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="补充背景、范围或验收标准" /></label><label>结果摘要<textarea value={form.resultSummary} onChange={(event) => onChange({ ...form, resultSummary: event.target.value })} placeholder="完成后记录最终结果" /></label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary">保存任务</button></div></form></div>; }

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
