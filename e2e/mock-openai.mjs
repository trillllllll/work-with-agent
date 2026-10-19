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
  if (!body.stream && messages.some((item) => item.role === 'system' && String(item.content).includes('有来源的长期记忆'))) {
    const snapshot = JSON.parse(latestUser);
    const source = snapshot.sources[0];
    const output = { summary: '从真实来源生成候选', candidates: [{ action: 'create', targetId: null, expectedRevision: null, kind: 'fact', title: source.title + '的事实', content: source.text, reason: '来源正文已说明', importance: 3, labels: ['提取测试'], evidence: [{ type: source.sourceType, id: source.sourceId, revision: source.revision, hash: source.evidenceHash }] }] };
    return json(res, 200, { model: body.model + '-actual', choices: [{ message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }], ...(body.model === 'mock-no-usage' ? {} : { usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }) });
  }
  if (!body.stream) return json(res, 200, { choices: [{ message: { role: 'assistant', content: '连接成功' }, finish_reason: 'stop' }] });
  const systemText = messages.filter((item) => item.role === 'system').map((item) => String(item.content ?? '')).join('\n');
  if (latestUser.startsWith('AI验收')) {
    const userIndex = messages.findLastIndex((item) => item.role === 'user');
    if (!messages.slice(userIndex + 1).some((item) => item.role === 'tool')) return stream(res, [
      { choices: [{ delta: { content: '正在读取当前页面。' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'ai_page', function: { name: 'read_page_state', arguments: '{}' } },
        { index: 1, id: 'ai_help', function: { name: 'read_app_knowledge', arguments: '{"page":"plan"}' } },
      ] }, finish_reason: 'tool_calls' }] },
    ]);
    return stream(res, [{ choices: [{ delta: { content: 'AI验收完成，已读取当前页面与功能说明。' }, finish_reason: 'stop' }] }]);
  }
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
  const lastUser = messages.findLastIndex((item) => item.role === 'user');
  const sinceUser = messages.slice(Math.max(0, lastUser + 1));
  const toolSince = (name) => sinceUser.some((item) => item.role === 'tool' && String(item.content).includes(`"toolName":"${name}"`));
  const callTool = (id, name, args, text) => stream(res, [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] },
  ]);
  if (latestUser.includes('看看现在状态')) return stream(res, [{ choices: [{ delta: { content: '整组提议仍在等待确认。' }, finish_reason: 'stop' }] }]);
  if (latestUser.includes('把安排改到2026-10-16')) {
    if (toolSince('propose_changes')) return stream(res, [{ choices: [{ delta: { content: '安排方案已放在确认卡里。' }, finish_reason: 'stop' }] }]);
    const listed = sinceUser.map(toolData).find((data) => Array.isArray(data?.items) && data.items.some((task) => String(task?.title ?? '').includes('安排样本')));
    if (!listed) return callTool(`e2e_date_list_${messages.length}`, 'query_tasks', { action: 'list', limit: 20 }, '我先读取要调整的任务。');
    const task = listed.items.find((item) => String(item.title).includes('安排样本'));
    return callTool(`e2e_date_${messages.length}`, 'propose_changes', {
      summary: '把安排改到2026-10-16',
      operations: [{ family: 'workspace', command: { kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { dueDate: '2026-10-16' } } }],
    }, '我准备确认这个安排。');
  }
  if (latestUser.includes('读取当前时间')) {
    if (toolSince('get_time')) {
      const time = sinceUser.map(toolData).find((data) => typeof data?.localDate === 'string');
      return stream(res, [{ choices: [{ delta: { content: `本地日期 ${time?.localDate ?? '未知'}。` }, finish_reason: 'stop' }] }]);
    }
    return callTool('e2e_time', 'get_time', {}, '我先读取当前时间。');
  }
  if (latestUser.includes('读取任务动态')) {
    if (toolSince('get_task_activity')) {
      const page = sinceUser.map(toolData).find((data) => Array.isArray(data?.items));
      const actor = page?.items?.[0]?.actor?.name ?? '未记录';
      return stream(res, [{ choices: [{ delta: { content: `最近 30 天的动态里，记录到的操作者是${actor}。这不代表从未发生过更早的修改。` }, finish_reason: 'stop' }] }]);
    }
    const taskId = latestUser.match(/taskId=(\S+)/)?.[1] ?? '';
    return callTool('e2e_activity', 'get_task_activity', { taskId }, '我先读取任务动态。');
  }
  if (latestUser.includes('整理成外部提示词')) {
    if (toolSince('prepare_external_prompt')) return stream(res, [{ choices: [{ delta: { content: '提示词已经放在卡片里，可以复制。' }, finish_reason: 'stop' }] }]);
    return callTool('e2e_external', 'prepare_external_prompt', {
      capability: 'web_research',
      limitation: '我目前不能联网查资料。',
      goal: '查询 k8s 文档第9节怎么使用',
      background: ['只根据用户给出的问题整理查询要求'],
      constraints: ['不要编造来源或完成状态'],
      expectedOutput: ['列出结论、来源链接和日期'],
    }, '我目前不能联网查资料。');
  }
  if (latestUser.includes('整组确认k8s文档')) {
    if (toolSince('propose_changes')) return stream(res, [{ choices: [{ delta: { content: '整组方案已放在确认卡里。' }, finish_reason: 'stop' }] }]);
    const listed = sinceUser.map(toolData).find((data) => Array.isArray(data?.items) && data.items.some((task) => String(task?.title ?? '').includes('按大威的意见')));
    if (!listed) return callTool(`e2e_batch_list_${messages.length}`, 'query_tasks', { action: 'list', limit: 50 }, '我先读取相关任务。');
    const parent = listed.items.find((task) => String(task.title).includes('按大威的意见'));
    const child = listed.items.find((task) => String(task.title).includes('核对，第9节'));
    const approvalId = messages.find((item) => item.role === 'system')?.content.match(/approvalId=(\S+)/)?.[1];
    const replacing = latestUser.includes('替换这份整组提议') && approvalId;
    const args = {
      summary: '整组调整',
      ...(replacing ? { supersedesApprovalId: approvalId } : {}),
      operations: [
        { family: 'workspace', command: { kind: 'task.create', clientRef: 'parent', input: { title: parent.title, topicId: parent.topicId } } },
        { family: 'workspace', command: { kind: 'task.update', targetId: parent.id, expectedRevision: parent.revision, input: { title: '执行修改', parentId: { $ref: 'parent' } } } },
        { family: 'workspace', command: { kind: 'task.update', targetId: child.id, expectedRevision: child.revision, input: { parentId: { $ref: 'parent' } } } },
      ],
    };
    return callTool(`e2e_batch_${messages.length}`, 'propose_changes', args, replacing ? '我改用新的整组提议替换上一份。' : '我准备一次确认整组修改。');
  }
  if (latestUser.includes('读取项目资料') && !toolSince('library_read')) {
    return callTool('e2e_library_list', 'library_read', { action: 'list', limit: 20 }, '我先查看项目资料。');
  }
  if (latestUser.includes('关联这份项目资料') && !toolSince('propose_changes')) {
    const materialId = latestUser.match(/materialId=(\S+)/)?.[1] ?? '';
    const revision = Number(latestUser.match(/materialRevision=(\d+)/)?.[1] ?? 0);
    const organizationRevision = Number(latestUser.match(/organizationRevision=(\d+)/)?.[1] ?? 0);
    const taskId = latestUser.match(/taskId=(\S+)/)?.[1] ?? '';
    return callTool('e2e_library_links', 'propose_changes', {
      summary: '关联这份资料',
      operations: [{ family: 'library', args: { action: 'links', materialId, revision, organizationRevision, addTaskIds: [taskId], removeTaskIds: [], removeInlineReferences: false } }],
    }, '我准备关联这份资料。');
  }
  if (latestUser.includes('调整时生成失败')) return json(res, 502, { error: { message: 'mock upstream failure' } });
  if (latestUser.includes('请生成调整样本') || latestUser.includes('请把方案改短') || latestUser.includes('修复预览标题')) {
    if (toolSince('propose_changes')) return stream(res, [{ choices: [{ delta: { content: '方案已经放在确认卡里。' }, finish_reason: 'stop' }] }]);
    const title = latestUser.includes('修复预览标题') ? '修复样本' : '调整样本';
    const listed = sinceUser.map(toolData).find((data) => Array.isArray(data?.items) && data.items.some((task) => String(task?.title ?? '').includes(title)));
    if (!listed) return callTool(`e2e_repair_list_${messages.length}`, 'query_tasks', { action: 'list', limit: 50 }, '我先读取要调整的任务。');
    const task = listed.items.find((item) => String(item.title).includes(title));
    const nextTitle = latestUser.includes('请把方案改短') ? '短标题' : latestUser.includes('修复预览标题') ? '修复后的标题' : '调整后的标题';
    return callTool(`e2e_repair_${messages.length}`, 'propose_changes', {
      summary: nextTitle,
      operations: [{ family: 'workspace', command: { kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { title: nextTitle } } }],
    }, '我准备确认这个修改。');
  }
  if (latestUser.includes('继续处理到上限')) {
    const times = sinceUser.filter((item) => item.role === 'tool' && String(item.content).includes('"toolName":"get_time"')).length;
    if (times >= 16) return stream(res, [{ choices: [{ delta: { content: '后续回答已经完成' }, finish_reason: 'stop' }] }]);
    return callTool(`e2e_more_${times}`, 'get_time', {}, '继续读取时间。');
  }
  const fence = (body) => '```mermaid\n' + body.trim() + '\n```';
  if (latestUser.includes('画出这些图')) {
    const reply = [
      '这些图如下。',
      fence('flowchart TD\n  A[开始] --> B[结束]'),
      fence('gantt\n    title 排期\n    dateFormat YYYY-MM-DD\n    section 做\n    排期任务 :a1, 2026-10-01, 2d'),
      fence('sequenceDiagram\n  participant U as 用户\n  U->>U: 问好'),
      fence('classDiagram\n  class Task'),
      fence('stateDiagram-v2\n  [*] --> Ready'),
      fence('erDiagram\n  USER ||--o{ TASK : owns'),
      fence('pie title 占比\n  "完成" : 1'),
      fence('mindmap\n  root((主题))'),
      fence('timeline\n  title 历程\n  2026 : 上线'),
      fence('gitGraph\n  commit id: "c1" tag: "提交"'),
      '```ts\nconst keep = 1\n```',
    ].join('\n\n');
    return stream(res, [{ choices: [{ delta: { content: reply }, finish_reason: 'stop' }] }]);
  }
  if (latestUser.includes('画一张坏图')) return stream(res, [{ choices: [{ delta: { content: '```mermaid\nnot-a-diagram\n```' }, finish_reason: 'stop' }] }]);
  if (latestUser.includes('读取受控文件') && !messages.some((item) => item.role === 'tool')) {
    return stream(res, [
      { choices: [{ delta: { content: '我准备读取工作区文件。' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'e2e_file', function: { name: 'execute_file', arguments: JSON.stringify({ operation: 'read', path: 'package.json' }) } }] }, finish_reason: 'tool_calls' }] },
    ]);
  }
  return stream(res, [{ choices: [{ delta: { content: messages.some((item) => item.role === 'tool') ? '当前任务已读取完成。' : 'Mock 模型回复。' }, finish_reason: 'stop' }] }]);
});
server.listen(port, '127.0.0.1', () => console.log(`Mock OpenAI listening on ${port}`));
