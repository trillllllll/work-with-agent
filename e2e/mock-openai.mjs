import http from 'node:http';

const port = 4010;
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const stream = (res, chunks) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
};
const server = http.createServer(async (req, res) => {
  if (req.url === '/health') return json(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(res, 404, { error: 'not found' });
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  const messages = body.messages ?? [];
  const latestUser = String([...messages].reverse().find((item) => item.role === 'user')?.content ?? '');
  if (body.model === 'mock-upstream' || latestUser.includes('上游错误')) return json(res, 502, { error: { message: 'mock upstream failure' } });
  if (!body.stream && body.model === 'mock-invalid') return json(res, 200, { choices: [] });
  if (!body.stream) return json(res, 200, { choices: [{ message: { role: 'assistant', content: '连接成功' }, finish_reason: 'stop' }] });
  const systemText = messages.filter((item) => item.role === 'system').map((item) => String(item.content ?? '')).join('\n');
  if (systemText.includes('不要新增编号')) {
    return stream(res, [{ choices: [{ delta: { content: JSON.stringify({ paragraphs: [{ text: '根据资料回答', citationIds: ['C1'] }] }) }, finish_reason: 'stop' }] }]);
  }
  if (systemText.includes('最多 4 个检索短语')) {
    const query = [...latestUser].slice(0, 80).join('');
    return stream(res, [{ choices: [{ delta: { content: JSON.stringify({ queries: query ? [query] : [] }) }, finish_reason: 'stop' }] }]);
  }
  if (latestUser.includes('无效响应')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.end('data: {invalid-json}\n\ndata: [DONE]\n\n');
    return;
  }
  if (latestUser.includes('列出任务') && !messages.some((item) => item.role === 'tool')) {
    return stream(res, [
      { choices: [{ delta: { content: '我先读取任务。' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'e2e_list_tasks', function: { name: 'list_tasks', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
    ]);
  }
  if (latestUser.includes('创建任务') && !messages.some((item) => item.role === 'tool')) {
    const topicId = messages.find((item) => item.role === 'system')?.content.match(/"topicId":"([^"]+)"/)?.[1] ?? '';
    return stream(res, [
      { choices: [{ delta: { content: '我准备创建这个任务。' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'e2e_create_task', function: { name: 'create_task', arguments: JSON.stringify({ topicId, title: 'E2E Agent 任务' }) } }] }, finish_reason: 'tool_calls' }] },
    ]);
  }
  if (latestUser.includes('生成成果草稿')) {
    const topicId = messages.find((item) => item.role === 'system')?.content.match(/"topicId":"([^"]+)"/)?.[1] ?? '';
    const topic = [...messages].reverse().filter((item) => item.role === 'tool').map((item) => {
      try { const result = JSON.parse(item.content); return result.success ? result.data : null; } catch { return null; }
    }).find((value) => value?.id === topicId && Number.isInteger(value.revision) && value.revision > 0);
    if (!topic) {
      return stream(res, [
        { choices: [{ delta: { content: '我先读取当前清单及其版本。' }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'e2e_summary_read_topic', function: { name: 'get_topic', arguments: JSON.stringify({ topicId }) } }] }, finish_reason: 'tool_calls' }] },
      ]);
    }
    const summary = latestUser.includes('第二版') ? 'E2E 最终成果' : 'E2E 待放弃草稿';
    return stream(res, [
      { choices: [{ delta: { content: '我准备生成成果草稿。' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'e2e_summary', function: { name: 'propose_topic_summary', arguments: JSON.stringify({ topicId, summary, expectedRevision: topic.revision }) } }] }, finish_reason: 'tool_calls' }] },
    ]);
  }
  const toolData = (message) => {
    try { const value = JSON.parse(message.content); return value?.success ? value.data : null; } catch { return null; }
  };
  if (latestUser.includes('看看现在状态')) return stream(res, [{ choices: [{ delta: { content: '整组提议仍在等待确认。' }, finish_reason: 'stop' }] }]);
  if (latestUser.includes('整组确认k8s文档')) {
    const lastUser = messages.findLastIndex((item) => item.role === 'user');
    const listed = messages.slice(Math.max(0, lastUser + 1)).map(toolData).find((data) => Array.isArray(data) && data.some((task) => String(task?.title ?? '').includes('按大威的意见')));
    if (!listed) {
      return stream(res, [
        { choices: [{ delta: { content: '我先读取相关任务。' }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: `e2e_batch_list_${messages.length}`, function: { name: 'list_tasks', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      ]);
    }
    const parent = listed.find((task) => String(task.title).includes('按大威的意见'));
    const child = listed.find((task) => String(task.title).includes('核对，第9节'));
    const approvalId = messages.find((item) => item.role === 'system')?.content.match(/approvalId=(\S+)/)?.[1];
    const replacing = latestUser.includes('替换这份整组提议') && approvalId;
    const args = {
      summary: '整组调整',
      ...(replacing ? { supersedesApprovalId: approvalId } : {}),
      operations: [
        { kind: 'task.create', clientRef: 'parent', input: { title: parent.title, topicId: parent.topicId } },
        { kind: 'task.update', targetId: parent.id, expectedRevision: parent.revision, input: { title: '执行修改', parentId: { $ref: 'parent' } } },
        { kind: 'task.update', targetId: child.id, expectedRevision: child.revision, input: { parentId: { $ref: 'parent' } } },
      ],
    };
    return stream(res, [
      { choices: [{ delta: { content: replacing ? '我改用新的整组提议替换上一份。' : '我准备一次确认整组修改。' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: `e2e_batch_${messages.length}`, function: { name: 'propose_task_changes', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] },
    ]);
  }
  if (latestUser.includes('读取项目资料') && !messages.some((item) => item.role === 'tool')) {
    return stream(res, [
      { choices: [{ delta: { content: '我先查看项目资料。' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'e2e_library_list', function: { name: 'library', arguments: JSON.stringify({ action: 'list', limit: 20 }) } }] }, finish_reason: 'tool_calls' }] },
    ]);
  }
  if (latestUser.includes('关联这份项目资料') && !messages.some((item) => item.role === 'tool')) {
    const materialId = latestUser.match(/materialId=(\S+)/)?.[1] ?? '';
    const revision = Number(latestUser.match(/materialRevision=(\d+)/)?.[1] ?? 0);
    const organizationRevision = Number(latestUser.match(/organizationRevision=(\d+)/)?.[1] ?? 0);
    const taskId = latestUser.match(/taskId=(\S+)/)?.[1] ?? '';
    return stream(res, [
      { choices: [{ delta: { content: '我准备关联这份资料。' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'e2e_library_links', function: { name: 'library', arguments: JSON.stringify({ action: 'links', materialId, revision, organizationRevision, addTaskIds: [taskId], removeTaskIds: [], removeInlineReferences: false }) } }] }, finish_reason: 'tool_calls' }] },
    ]);
  }
  if (latestUser.includes('读取受控文件') && !messages.some((item) => item.role === 'tool')) {
    return stream(res, [
      { choices: [{ delta: { content: '我准备读取工作区文件。' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'e2e_file', function: { name: 'execute_file', arguments: JSON.stringify({ operation: 'read', path: 'package.json' }) } }] }, finish_reason: 'tool_calls' }] },
    ]);
  }
  return stream(res, [{ choices: [{ delta: { content: messages.some((item) => item.role === 'tool') ? '当前任务已读取完成。' : 'Mock 模型回复。' }, finish_reason: 'stop' }] }]);
});
server.listen(port, '127.0.0.1', () => console.log(`Mock OpenAI listening on ${port}`));
