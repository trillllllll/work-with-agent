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
  if (latestUser.includes('生成成果草稿') && !messages.some((item) => item.role === 'tool')) {
    const topicId = messages.find((item) => item.role === 'system')?.content.match(/"topicId":"([^"]+)"/)?.[1] ?? '';
    const summary = latestUser.includes('第二版') ? 'E2E 最终成果' : 'E2E 待放弃草稿';
    return stream(res, [
      { choices: [{ delta: { content: '我准备生成成果草稿。' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'e2e_summary', function: { name: 'propose_topic_summary', arguments: JSON.stringify({ topicId, summary }) } }] }, finish_reason: 'tool_calls' }] },
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
