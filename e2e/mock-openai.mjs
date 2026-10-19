import http from 'node:http';

// Alternate ports let parallel suites share one machine (see playwright.orchestration.config.ts).
const port = Number(process.env.MOCK_OPENAI_PORT ?? 4010);
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
  const system = String(messages.find((item) => item.role === 'system')?.content ?? '');
  if (system.includes('[编排计划]') || system.includes('[编排验收]') || system.includes('[编排最终验收]')) {
    // Orchestrator model: independent subtasks, accept every report, final satisfied.
    let output;
    if (system.includes('[编排计划]')) {
      const subtasks = JSON.parse(latestUser.match(/子任务：(\[.*\])/)[1]);
      output = { goalCriteria: '每个子任务的文件都已合入集成分支', steps: subtasks.map((task) => ({ taskId: task.id, dependsOn: [], acceptanceCriteria: `${task.title} 已提交`, rationale: 'mock 计划：互不依赖' })) };
    } else if (system.includes('[编排验收]')) output = { decision: 'accept', comment: 'mock 审阅通过' };
    else output = { satisfied: true, comment: 'mock：主任务已满足' };
    const content = JSON.stringify(output);
    if (body.stream) return stream(res, [{ choices: [{ delta: { content }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    return json(res, 200, { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
  }
  if (body.model === 'mock-upstream' || latestUser.includes('上游错误')) return json(res, 502, { error: { message: 'mock upstream failure' } });
  if (!body.stream && body.model === 'mock-invalid') return json(res, 200, { choices: [] });
  if (!body.stream && messages.some((item) => item.role === 'system' && String(item.content).includes('有来源的长期记忆'))) {
    const snapshot = JSON.parse(latestUser);
    const source = snapshot.sources[0];
    const output = { summary: '从真实来源生成候选', candidates: [{ action: 'create', targetId: null, expectedRevision: null, kind: 'fact', title: source.title + '的事实', content: source.text, reason: '来源正文已说明', importance: 3, labels: ['提取测试'], evidence: [{ type: source.sourceType, id: source.sourceId, revision: source.revision, hash: source.evidenceHash }] }] };
    return json(res, 200, { model: body.model + '-actual', choices: [{ message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }], ...(body.model === 'mock-no-usage' ? {} : { usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }) });
  }
  if (!body.stream) return json(res, 200, { choices: [{ message: { role: 'assistant', content: '连接成功' }, finish_reason: 'stop' }] });
  if (latestUser.includes('可视化矩阵验收')) {
    const provenance = { kind: 'simulated', label: '矩阵验收数据' };
    const blocks = [
      { type: 'text', markdown: '矩阵开始。' },
      ...[
        ['流程图', 'flowchart LR; A[开始] --> B[完成]'],
        ['时序图', 'sequenceDiagram\n用户->>助手: 提问\n助手-->>用户: 回答'],
        ['状态图', 'stateDiagram-v2\n[*] --> Active\nActive --> Done'],
        ['类图', 'classDiagram\nclass Task {\n+String title\n}'],
      ].map(([title, source]) => ({ type: 'mermaid', title, source })),
      ...['line', 'bar'].map((kind) => ({ type: 'chart', title: kind, spec: { kind, title: kind, categories: ['一', '二'], series: [{ name: '数量', values: [2, 4] }], provenance } })),
      { type: 'chart', title: 'pie', spec: { kind: 'pie', title: 'pie', values: [{ name: 'A', value: 2 }, { name: 'B', value: 3 }], provenance } },
      { type: 'chart', title: 'scatter', spec: { kind: 'scatter', title: 'scatter', series: [{ name: '观测', values: [[1, 2], [3, 4]] }], provenance } },
      { type: 'svg', title: '标准 SVG', source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><text x="10" y="40" fill="#668899">中文箭头</text></svg>' },
      ...['single', 'grid', 'carousel'].map((layout) => ({ type: 'image_search', title: layout, searchId: 'fixture-authorized-search', resultIds: ['fixture-image-1', 'fixture-image-2'], layout })),
      { type: 'svg', title: '恶意 SVG', source: '<svg onload="window.__unsafeExecuted=true"><script>alert(1)</script></svg>' },
      { type: 'text', markdown: '矩阵结束。' },
    ];
    return stream(res, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'matrix', function: { name: 'present_reply', arguments: JSON.stringify({ blocks }) } }] }, finish_reason: 'tool_calls' }] }]);
  }
  if (latestUser.includes('富媒体验收')) {
    const blocks = [
      { type: 'text', markdown: '文字流式前缀😀，这是第一段。' },
      { type: 'mermaid', source: 'flowchart LR; A[输入] --> B[分析] --> C[结果]', title: '处理流程' },
      { type: 'text', markdown: '中间说明，图形已经出现。' },
      { type: 'svg', source: '<svg viewBox="0 0 240 100"><rect x="10" y="10" width="220" height="80" rx="12" fill="#49697b"/><text x="120" y="58" text-anchor="middle" fill="white" font-size="18">中文图示</text></svg>', title: 'SVG 图示' },
      { type: 'image_search', searchId: 'unauthorized-fixture', resultIds: ['invented'], title: '图片失败占位' },
      { type: 'chart', title: '每周完成', spec: { kind: 'bar', title: '每周完成', categories: ['周一', '周二', '周三'], series: [{ name: '完成', values: [3, 5, 4] }], provenance: { kind: 'simulated', label: '浏览器验收数据' } } },
      { type: 'text', markdown: '最后一段，局部失败不影响其他内容。' },
    ];
    const args = JSON.stringify({ blocks });
    const firstEnd = args.indexOf('文字流式前缀😀') + '文字流式前缀😀'.length;
    const secondEnd = args.indexOf('中间说明') + '中间说明'.length;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const emit = (argumentsDelta, first = false, done = false) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...(first ? { id: 'rich-presentation' } : {}), function: { ...(first ? { name: 'present_reply' } : {}), arguments: argumentsDelta } }] }, finish_reason: done ? 'tool_calls' : null }] })}\n\n`);
    emit(args.slice(0, firstEnd), true);
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (res.destroyed) return;
    emit(args.slice(firstEnd, secondEnd));
    await new Promise((resolve) => setTimeout(resolve, latestUser.includes('停止') ? 5000 : 800));
    if (res.destroyed) return;
    emit(args.slice(secondEnd), false, true);
    res.end('data: [DONE]\n\n'); return;
  }
  const systemText = messages.filter((item) => item.role === 'system').map((item) => String(item.content ?? '')).join('\n');
  if (systemText.includes('起草一条可复用技能')) {
    const draft = { name: '会话起草技能', description: '整理这次对话里的做法时使用', instructions: '1. 先复述目标\n2. 再列出步骤' };
    return stream(res, [{ choices: [{ delta: { content: JSON.stringify(draft) }, finish_reason: 'stop' }] }]);
  }
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
  if (latestUser.includes('技能加载验收')) {
    const offered = systemText.includes('【可用技能】') && (body.tools ?? []).some((tool) => tool?.function?.name === 'load_skill');
    if (!offered) return stream(res, [{ choices: [{ delta: { content: '没有可用技能。' }, finish_reason: 'stop' }] }]);
    const loaded = sinceUser.filter((item) => item.role === 'tool' && String(item.content).includes('"toolName":"load_skill"')).map(toolData).find(Boolean);
    if (!loaded) return callTool(`e2e_skill_load_${messages.length}`, 'load_skill', { name: systemText.match(/- (验收周报[^：:]*)[：:]/)?.[1] ?? '验收周报' }, '我先读取技能。');
    return stream(res, [{ choices: [{ delta: { content: `已按技能 ${loaded.name} v${loaded.revision} 处理。` }, finish_reason: 'stop' }] }]);
  }
  if (latestUser.includes('起草技能验收')) {
    if (toolSince('propose_changes')) return stream(res, [{ choices: [{ delta: { content: '技能草稿已放在确认卡里。' }, finish_reason: 'stop' }] }]);
    const name = latestUser.match(/名称=(\S+)/)?.[1] ?? '验收起草';
    return callTool(`e2e_skill_draft_${messages.length}`, 'propose_changes', {
      summary: '起草技能',
      operations: [{ family: 'skill', command: { kind: 'skill.create', input: { name, description: '每周五整理任务时使用', instructions: '第一步：列出本周完成\n第二步：写下下周计划', enabled: true, reason: '根据对话起草' } } }],
    }, '我起草了一条技能。');
  }
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
  if (latestUser.includes('清理已验收的 worktree')) {
    if (toolSince('propose_worktree_cleanup')) return stream(res, [{ choices: [{ delta: { content: '删除卡片已经生成，请在卡片上确认。' }, finish_reason: 'stop' }] }]);
    const listed = sinceUser.map(toolData).find((data) => Array.isArray(data?.items) && data.items.some((view) => Array.isArray(view?.worktrees)));
    if (!listed) return callTool('e2e_orch_read', 'orchestration_read', { action: 'worktrees' }, '我先看看执行端上报的 worktree。');
    const view = listed.items.find((item) => item.worktrees.some((entry) => entry.action === 'remove'));
    const entry = view?.worktrees.find((item) => item.action === 'remove');
    if (!view || !entry) return stream(res, [{ choices: [{ delta: { content: '没有可以删除的 worktree。' }, finish_reason: 'stop' }] }]);
    return callTool('e2e_orch_cleanup', 'propose_worktree_cleanup', { nodeId: view.node.id, paths: [entry.path], reason: '轮次已验收' }, `准备删除 ${entry.name}。`);
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
  if (latestUser.includes('读取受控文件') && !messages.some((item) => item.role === 'tool')) {
    return stream(res, [
      { choices: [{ delta: { content: '我准备读取工作区文件。' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'e2e_file', function: { name: 'execute_file', arguments: JSON.stringify({ operation: 'read', path: 'package.json' }) } }] }, finish_reason: 'tool_calls' }] },
    ]);
  }
  return stream(res, [{ choices: [{ delta: { content: messages.some((item) => item.role === 'tool') ? '当前任务已读取完成。' : 'Mock 模型回复。' }, finish_reason: 'stop' }] }]);
});
server.listen(port, '127.0.0.1', () => console.log(`Mock OpenAI listening on ${port}`));
