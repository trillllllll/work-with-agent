import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import './style.css';
import { applyApprovalEvent, applyMessageEvent, parseSseFrame, type Approval, type ChatMessage, type SseEvent, type ToolResult } from './chat.js';
import { ConfirmDialog, Dialog } from './dialog.js';

type Topic = { id: string; name: string; description: string; isExploration: boolean; goal?: string; draftSummary?: string; finalSummary?: string; summaryStatus?: string; summaryUpdatedAt?: string | null };
type Status = 'todo' | 'doing' | 'blocked' | 'done';
type Task = { id: string; topicId: string; title: string; description: string; status: Status; resultSummary: string };
type Settings = { baseUrl: string; model: string; apiKeyConfigured: boolean; apiKeyMasked: string | null };
type ApprovalResponse = { result: ToolResult; assistantMessage?: string; summaryError?: string };
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
  const consume = (frame: string) => { const event = parseSseFrame(frame); if (event) onEvent(event); };
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
  const [view, setView] = useState<'board' | 'settings'>('board');
  const [selectedTopicId, setSelectedTopicId] = useState('');
  const [topicForm, setTopicForm] = useState<any>(null);
  const [taskForm, setTaskForm] = useState<any>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ kind: 'topic' | 'task'; id: string; name: string } | null>(null);
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
  const topicDetail = useQuery<Topic>({ queryKey: ['topic', selectedTopicId], queryFn: () => api(`/api/topics/${selectedTopicId}`), enabled: Boolean(selectedTopicId) });
  const detail = topicDetail.data ?? selectedTopic;
  const summaryMutation = useMutation({ mutationFn: (action: 'confirm' | 'discard') => api(`/api/topics/${selectedTopicId}/summary/${action}`, { method: 'POST' }), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['topic', selectedTopicId] }); queryClient.invalidateQueries({ queryKey: ['topics'] }); }, onError: (e: Error) => setError(e.message) });
  const tasksQuery = useQuery<Task[]>({ queryKey: ['tasks', selectedTopicId], queryFn: () => api(`/api/tasks?topicId=${encodeURIComponent(selectedTopicId)}`), enabled: Boolean(selectedTopicId) });
  const invalidate = () => { queryClient.invalidateQueries({ queryKey: ['topics'] }); queryClient.invalidateQueries({ queryKey: ['tasks'] }); };

  useEffect(() => {
    if (!conversationId) return;
    localStorage.setItem('agent-studio.conversationId', conversationId);
    Promise.all([api(`/api/conversations/${conversationId}/messages`), api('/api/agent/approvals?status=pending')]).then(([messages, pending]) => {
      setChatMessages(messages.map((message: ChatMessage) => ({ id: message.id, role: message.role, content: message.content, status: message.status })));
      setApprovals(pending.map(parseApproval));
    }).catch((reason: Error) => setError(reason.message));
  }, [conversationId]);

  const saveTopic = useMutation({ mutationFn: (form: any) => api(form.id ? `/api/topics/${form.id}` : '/api/topics', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(form) }), onSuccess: (topic: Topic) => { setTopicForm(null); setSelectedTopicId(topic.id); invalidate(); }, onError: (e: Error) => setError(e.message) });
  const deleteTopic = useMutation({ mutationFn: (id: string) => api(`/api/topics/${id}`, { method: 'DELETE' }), onSuccess: () => { setDeleteConfirmation(null); setSelectedTopicId(''); invalidate(); }, onError: (e: Error) => { setDeleteConfirmation(null); setError(e.message); } });
  const saveTask = useMutation({ mutationFn: (form: any) => api(form.id ? `/api/tasks/${form.id}` : '/api/tasks', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(form.id ? { title: form.title, description: form.description, resultSummary: form.resultSummary } : { ...form, topicId: selectedTopicId }) }), onSuccess: () => { setTaskForm(null); invalidate(); }, onError: (e: Error) => setError(e.message) });
  const updateTask = useMutation({ mutationFn: ({ id, status }: { id: string; status: Status }) => api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), onSuccess: invalidate, onError: (e: Error) => setError(e.message) });
  const deleteTask = useMutation({ mutationFn: (id: string) => api(`/api/tasks/${id}`, { method: 'DELETE' }), onSuccess: () => { setDeleteConfirmation(null); invalidate(); }, onError: (e: Error) => { setDeleteConfirmation(null); setError(e.message); } });
  const approve = useMutation<ApprovalResponse, Error, string>({ mutationFn: (approvalId: string) => api(`/api/agent/approvals/${approvalId}/approve`, { method: 'POST' }), onSuccess: (response, approvalId) => {
    setApprovals((current) => current.filter((item) => item.approvalId !== approvalId));
    invalidate();
    setChatMessages((current) => {
      const next = [...current];
      if (response.assistantMessage) next.push({ role: 'assistant', content: response.assistantMessage, status: 'completed' });
      else next.push({ role: 'tool', content: response.result?.success ? '变更已批准并执行。' : `变更执行失败：${response.result?.error ?? '未知错误'}` });
      return next;
    });
    if (response.summaryError) setError(response.summaryError);
  }, onError: (e: Error) => setError(e.message) });
  const reject = useMutation({ mutationFn: (approvalId: string) => api(`/api/agent/approvals/${approvalId}/reject`, { method: 'POST' }), onSuccess: (_result, approvalId) => { setApprovals((current) => current.filter((item) => item.approvalId !== approvalId)); setChatMessages((current) => [...current, { role: 'tool', content: '变更已拒绝，数据未修改。' }]); }, onError: (e: Error) => setError(e.message) });

  const sendChat = async (event: FormEvent) => {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message || chatBusy) return;
    setChatInput(''); setError(''); setChatInterrupted(false); setChatBusy(true);
    setChatMessages((current) => [...current, { role: 'user', content: message }]);
    let receivedDone = false;
    let receivedError = false;
    try {
      await streamChat({ conversationId: conversationId || undefined, message, pageContext: { topicId: selectedTopicId || null, taskId: null, page: view } }, (event) => {
        if (event.conversationId && event.conversationId !== conversationId) { setConversationId(event.conversationId); localStorage.setItem('agent-studio.conversationId', event.conversationId); }
        setChatMessages((current) => applyMessageEvent(current, event));
        setApprovals((current) => applyApprovalEvent(current, event));
        if (event.type === 'error') { receivedError = true; setError(event.code ? `${event.message ?? '聊天失败'}（${event.code}）` : (event.message ?? '聊天失败')); }
        if (event.type === 'done') { receivedDone = true; invalidate(); }
      });
      if (!receivedDone && !receivedError) setChatInterrupted(true);
    } catch (reason) { setChatInterrupted(true); setError(reason instanceof Error ? reason.message : '聊天连接中断'); }
    finally { setChatBusy(false); }
  };
  const retryChat = () => { const last = [...chatMessages].reverse().find((item) => item.role === 'user'); if (last) { setChatInput(last.content); setChatInterrupted(false); } };
  const grouped = useMemo(() => Object.fromEntries(statuses.map(({ value }) => [value, (tasksQuery.data ?? []).filter((task) => task.status === value)])) as Record<Status, Task[]>, [tasksQuery.data]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">A</span><div><strong>Agent 工作室</strong><small>工作推进台</small></div></div>
        <div className="sidebar-heading"><span>主题</span><button className="icon-button" type="button" title="新建主题" aria-label="新建主题" onClick={() => setTopicForm({ name: '', description: '', isExploration: true })}>+</button></div>
        <div className="topic-list">
          {topics.map((topic) => <div className={`topic-row ${topic.id === selectedTopicId ? 'selected' : ''}`} key={topic.id}><button className="topic-button" type="button" onClick={() => setSelectedTopicId(topic.id)}><span className="topic-dot" />{topic.name}{topic.isExploration && <em>探索</em>}</button><button className="more-button" type="button" title="编辑主题" aria-label={`编辑主题：${topic.name}`} onClick={() => setTopicForm(topic)}>···</button></div>)}
          {!topics.length && !topicsQuery.isLoading && <p className="muted">还没有主题，先创建一个。</p>}
        </div>
        <div className="sidebar-footer"><button className={`settings-link ${view === 'settings' ? 'active' : ''}`} type="button" onClick={() => { setView((current) => current === 'settings' ? 'board' : 'settings'); setError(''); }}><span aria-hidden="true">⚙</span>设置</button><small>本地工作区</small></div>
      </aside>
      <section className="workspace">
        {error && <div className="alert"><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}
        {view === 'settings' ? <SettingsView /> : <>
          <header className="workspace-header"><div><span className="eyebrow">任务管理</span><h1>{detail?.name ?? '选择一个主题'}</h1><p>{detail?.description || '把想法拆成下一步，持续推进到结果。'}</p>{detail?.goal && <p className="topic-goal">目标：{detail.goal}</p>}</div>{selectedTopic && <div className="header-actions"><button className="secondary danger" type="button" onClick={() => setDeleteConfirmation({ kind: 'topic', id: selectedTopic.id, name: selectedTopic.name })}>删除主题</button><button className="primary" type="button" onClick={() => setTaskForm({ title: '', description: '', resultSummary: '' })}>+ 新建任务</button></div>}</header>
          {detail?.draftSummary && <section className="summary-panel draft"><div><strong>成果草稿</strong><p>{detail.draftSummary}</p></div><div className="summary-actions"><button className="secondary" onClick={() => summaryMutation.mutate('discard')}>放弃草稿</button><button className="primary" onClick={() => summaryMutation.mutate('confirm')}>确认成果</button></div></section>}
          {detail?.finalSummary && !detail.draftSummary && <section className="summary-panel"><strong>正式成果</strong><p>{detail.finalSummary}</p><small>{detail.summaryUpdatedAt ? `已确认：${new Date(detail.summaryUpdatedAt).toLocaleString()}` : ''}</small></section>}
          {!selectedTopic && <div className="empty-state"><div className="empty-icon">✦</div><h2>从一个主题开始</h2><p>主题是任务逐渐收敛成结果的容器。</p><button className="primary" type="button" onClick={() => setTopicForm({ name: '', description: '', isExploration: true })}>创建探索主题</button></div>}
          {selectedTopic && (tasksQuery.isLoading ? <div className="loading">正在加载任务…</div> : <div className="board">{statuses.map(({ value, label }) => <div className="column" key={value}><div className="column-heading"><h2>{label}</h2><span>{grouped[value].length}</span></div><div className="task-list">{grouped[value].map((task) => <article className="task-card" key={task.id}><div className="task-card-top"><button className="task-title" type="button" onClick={() => setTaskForm(task)}>{task.title}</button><button className="more-button" type="button" title="删除任务" aria-label={`删除任务：${task.title}`} onClick={() => setDeleteConfirmation({ kind: 'task', id: task.id, name: task.title })}>×</button></div>{task.description && <p>{task.description}</p>}{task.resultSummary && <div className="result-summary">结果：{task.resultSummary}</div>}<select value={task.status} onChange={(event) => updateTask.mutate({ id: task.id, status: event.target.value as Status })}>{statuses.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></article>)}</div>{value === 'todo' && <button className="add-inline" type="button" onClick={() => setTaskForm({ title: '', description: '', resultSummary: '' })}>+ 添加任务</button>}</div>)}</div>)}
        </>}
      </section>
      <aside className="chat-panel">
        <div className="chat-header"><span className="eyebrow">协作空间</span><h2>全局聊天</h2><span className="status-pill">{chatBusy ? '处理中…' : chatInterrupted ? '连接中断' : '可用'}</span></div>
        <div className="chat-messages">
          {!chatMessages.length && !approvals.length && <div className="chat-empty"><div className="chat-orbit">✦</div><p>告诉 Agent 你想推进什么。只读操作会直接执行，修改任务前会请求审核。</p></div>}
          {chatMessages.map((message, index) => <div className={`chat-message ${message.role} ${message.status ?? ''}`} key={`${message.id ?? index}-${index}`}><span className="message-role">{message.role === 'user' ? '你' : message.role === 'tool' ? 'Tool' : message.role === 'system' ? '系统' : 'Agent'}{message.status === 'failed' ? '（输出失败）' : ''}</span><p>{message.content || (message.status === 'streaming' ? '正在输出…' : '')}</p></div>)}
          {approvals.map((approval) => <div className="approval-card" key={approval.approvalId}><div className="approval-label">需要审核</div><strong>{toolLabels[approval.toolName] ?? approval.toolName}</strong><code>{JSON.stringify(approval.arguments, null, 2)}</code><div className="approval-actions"><button className="secondary" disabled={approve.isPending || reject.isPending} onClick={() => reject.mutate(approval.approvalId)}>拒绝</button><button className="primary" disabled={approve.isPending || reject.isPending} onClick={() => approve.mutate(approval.approvalId)}>批准执行</button></div></div>)}
          {chatInterrupted && <div className="alert"><span>聊天连接中断，已保留收到的内容。</span><button onClick={retryChat}>重试</button></div>}
        </div>
        <form className="chat-input" onSubmit={sendChat}><input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="例如：创建任务：整理 API 文档" /><button className="primary" disabled={chatBusy || !chatInput.trim()}>发送</button></form>
      </aside>
      {topicForm && <TopicModal form={topicForm} onChange={setTopicForm} onClose={() => setTopicForm(null)} onSave={() => saveTopic.mutate(topicForm)} busy={saveTopic.isPending} />}
      {taskForm && <TaskModal form={taskForm} onChange={setTaskForm} onClose={() => setTaskForm(null)} onSave={() => saveTask.mutate(taskForm)} busy={saveTask.isPending} />}
      {deleteConfirmation && <ConfirmDialog title={deleteConfirmation.kind === 'topic' ? '删除主题' : '删除任务'} itemName={deleteConfirmation.name} description={deleteConfirmation.kind === 'topic' ? '删除前请确认该主题不再需要。非空主题会被系统拒绝删除。' : '删除后任务记录将从当前工作台移除。'} busy={deleteTopic.isPending || deleteTask.isPending} onCancel={() => setDeleteConfirmation(null)} onConfirm={() => deleteConfirmation.kind === 'topic' ? deleteTopic.mutate(deleteConfirmation.id) : deleteTask.mutate(deleteConfirmation.id)} />}
    </main>
  );
}

function SettingsView() {
  const queryClient = useQueryClient();
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState('');
  const [clearKeyConfirmation, setClearKeyConfirmation] = useState(false);
  const settingsQuery = useQuery<Settings>({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
  useEffect(() => {
    if (!settingsQuery.data) return;
    setBaseUrl(settingsQuery.data.baseUrl);
    setModel(settingsQuery.data.model);
  }, [settingsQuery.data]);
  const save = useMutation<Settings, Error, void>({
    mutationFn: () => api('/api/settings', { method: 'PATCH', body: JSON.stringify({ baseUrl, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }) }),
    onSuccess: (data) => { queryClient.setQueryData(['settings'], data); setApiKey(''); setMessage('连接测试通过，设置已保存。'); setFormError(''); },
    onError: (error) => { setFormError(error.message); setMessage(''); },
  });
  const clearKey = useMutation<Settings, Error, void>({
    mutationFn: () => api('/api/settings/api-key', { method: 'DELETE' }),
    onSuccess: (data) => { queryClient.setQueryData(['settings'], data); setClearKeyConfirmation(false); setApiKey(''); setMessage('API Key 已清除。'); setFormError(''); },
    onError: (error) => { setClearKeyConfirmation(false); setFormError(error.message); setMessage(''); },
  });
  if (settingsQuery.isLoading) return <div className="settings-page"><div className="loading">正在加载设置…</div></div>;
  if (settingsQuery.isError) return <div className="settings-page"><div className="alert"><span>{settingsQuery.error instanceof Error ? settingsQuery.error.message : '设置加载失败'}</span><button onClick={() => settingsQuery.refetch()}>重试</button></div></div>;
  return <div className="settings-page">
    <header className="workspace-header"><div><span className="eyebrow">系统配置</span><h1>模型设置</h1><p>配置 OpenAI Chat Completions 兼容服务，保存前会测试连接。</p></div></header>
    {formError && <div className="alert"><span>{formError}</span><button onClick={() => setFormError('')}>关闭</button></div>}
    {message && <div className="success-banner">{message}</div>}
    <form className="settings-form" onSubmit={(event) => { event.preventDefault(); setMessage(''); setFormError(''); save.mutate(); }}>
      <label>接口地址<input required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" /></label>
      <label>模型名称<input required value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" /></label>
      <label>API Key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settingsQuery.data?.apiKeyConfigured ? `已配置：${settingsQuery.data.apiKeyMasked}` : '请输入 API Key'} autoComplete="new-password" /></label>
      <div className="settings-status">{settingsQuery.data?.apiKeyConfigured ? <>当前 Key：<code>{settingsQuery.data.apiKeyMasked}</code></> : '当前尚未配置 API Key'}</div>
      <div className="settings-actions"><button className="primary" disabled={save.isPending || clearKey.isPending}>{save.isPending ? '正在测试连接…' : '测试连接并保存'}</button>{settingsQuery.data?.apiKeyConfigured && <button type="button" className="secondary danger" disabled={save.isPending || clearKey.isPending} onClick={() => setClearKeyConfirmation(true)}>{clearKey.isPending ? '正在清除…' : '清除 API Key'}</button>}</div>
    </form>
    {clearKeyConfirmation && <ConfirmDialog title="清除 API Key" itemName="当前已保存的 API Key" description="清除后将无法继续使用当前模型配置，聊天需要重新配置 API Key。" busy={clearKey.isPending} onCancel={() => setClearKeyConfirmation(false)} onConfirm={() => clearKey.mutate()} />}
  </div>;
}

function TopicModal({ form, onChange, onClose, onSave, busy = false }: any) {
  return <Dialog title={form.id ? '编辑主题' : '新建主题'} description="主题是任务逐渐收敛成结果的容器。" onClose={onClose}>
    <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <div className="field-group">
        <label htmlFor="topic-name">主题名称</label>
        <input id="topic-name" data-dialog-initial required value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="例如：Agent 工作室" />
      </div>
      <div className="field-group">
        <label htmlFor="topic-description">描述</label>
        <textarea id="topic-description" value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="这个主题最终想形成什么结果？" />
      </div>
      <label className="checkbox" htmlFor="topic-exploration"><input id="topic-exploration" type="checkbox" checked={form.isExploration} onChange={(event) => onChange({ ...form, isExploration: event.target.checked })} /> 当前仍在探索</label>
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? '正在保存…' : '保存主题'}</button></div>
    </form>
  </Dialog>;
}

function TaskModal({ form, onChange, onClose, onSave, busy = false }: any) {
  return <Dialog title={form.id ? '编辑任务' : '新建任务'} description="补充任务背景和预期结果，保存后会同步到当前看板。" onClose={onClose}>
    <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <div className="field-group">
        <label htmlFor="task-title">任务名称</label>
        <input id="task-title" data-dialog-initial required value={form.title} onChange={(event) => onChange({ ...form, title: event.target.value })} placeholder="下一步要完成什么？" />
      </div>
      <div className="field-group">
        <label htmlFor="task-description">任务描述</label>
        <textarea id="task-description" value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="补充背景、范围或验收标准" />
      </div>
      <div className="field-group">
        <label htmlFor="task-result">结果摘要</label>
        <textarea id="task-result" value={form.resultSummary} onChange={(event) => onChange({ ...form, resultSummary: event.target.value })} placeholder="完成后记录最终结果" />
      </div>
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? '正在保存…' : '保存任务'}</button></div>
    </form>
  </Dialog>;
}

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
