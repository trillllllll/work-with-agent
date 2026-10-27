import http from 'node:http';

// Alternate ports let parallel suites share one machine (see playwright.orchestration.config.ts).
const port = Number(process.env.MOCK_OPENAI_PORT ?? 4010);
// Requests that an interactive html block must never be able to make; the html e2e asserts this stays 0.
let htmlLeaks = 0;
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const stream = (res, chunks) => {
  // Deterministic model fixture learns the same lazy-loading protocol as a real
  // model. No test-only execution bypass exists in the application.
  const tools = res.contextTools ?? [];
  if (tools.some(t => t.function.name === 'load_tools')) {
    const calls = new Map();
    for (const chunk of chunks) for (const choice of chunk.choices ?? []) for (const part of choice.delta?.tool_calls ?? []) {
      const old = calls.get(part.index) ?? { name: '', arguments: '' };
      calls.set(part.index, { name: part.function?.name || old.name, arguments: old.arguments + (part.function?.arguments ?? '') });
    }
    const required = new Set();
    const groupFor = { present_reply: 'media', image_search: 'media', web_search: 'web', read_webpage: 'web', library_read: 'library', memory_read: 'memory', get_work_context: 'memory', orchestration_read: 'orchestration', orchestration_stats: 'orchestration', propose_worktree_cleanup: 'orchestration', prepare_external_prompt: 'external', query_tasks: 'tasks', query_topics: 'tasks', get_task_activity: 'tasks', list_plan_time_bands: 'tasks' };
    for (const call of calls.values()) {
      if (call.name === 'propose_changes') {
        let args = {}; try { args = JSON.parse(call.arguments); } catch {}
        const offered = tools.find(t => t.function.name === 'propose_changes')?.function.parameters.properties.operations.items.oneOf ?? [];
        const families = new Set(offered.map(x => x.properties.family.const));
        for (const operation of args.operations ?? []) if (!families.has(operation.family)) required.add(`${operation.family}_write`);
      } else if (!tools.some(t => t.function.name === call.name) && groupFor[call.name]) required.add(groupFor[call.name]);
    }
    if (required.size) chunks = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'mock-load-tools', function: { name: 'load_tools', arguments: JSON.stringify({ groups: [...required] }) } }] }, finish_reason: 'tool_calls' }] }];
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
};
// ~40 words of filler so html blocks sit far enough apart to tell a 300px preload from a 450px gap.
const lazyFiller = '这段填充只负责把相邻的交互页面隔开，让对话长到必须滚动。离聊天可见区域三百像素以内的页面可以提前加载，更远的页面保持占位，直到滚到它们附近才挂上框架。';
// Fixed 300px body matches the block height, so mounting the frame does not shrink the thread.
const fixedHtml = (title) => `<div style="height:300px">${title}</div>`;
// The sandbox bridge (buildSrcdoc) observes documentElement and body and posts wwa:resize with scrollHeight.
// Appending a 900px div after load changes that height, which grows the parent iframe.
const growingHtml = `<div id="grow" style="height:300px"></div><script>setTimeout(function(){var extra=document.createElement("div");extra.style.height="900px";document.body.appendChild(extra);},1500);</script>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/health') return json(res, 200, { ok: true });
  if (req.url === '/html-leaks') return json(res, 200, { count: htmlLeaks });
  if (req.url === '/cdn/probe@1.0.0/ok.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end("document.getElementById('cdn-ok').textContent = 'loaded';"); }
  if (req.url?.startsWith('/beacon') || req.url === '/cdn/probe@1.0.0/bad.js') { htmlLeaks++; res.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' }); return res.end("document.getElementById('cdn-bad').textContent = 'loaded';"); }
  if (req.url === '/nav-target') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<p>navigated</p>'); }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(res, 404, { error: 'not found' });
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  res.contextTools = body.tools;
  const rawMessages = body.messages ?? [];
  const loaderIds = new Set(rawMessages.flatMap(m => (m.tool_calls ?? []).filter(c => c.function.name === 'load_tools').map(c => c.id)));
  const messages = rawMessages.flatMap(m => {
    if (m.role === 'tool' && loaderIds.has(m.tool_call_id)) return [];
    if (!m.tool_calls) return [m];
    const calls = m.tool_calls.filter(c => !loaderIds.has(c.id));
    return calls.length ? [{ ...m, tool_calls: calls }] : m.content ? [{ ...m, tool_calls: undefined }] : [];
  });
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
  if (latestUser.includes('上下文统计验收')) {
    const alreadyRead = messages.some(m => m.role === 'tool' && String(m.content).includes('query_tasks'));
    if (!alreadyRead) return stream(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'context-tasks', function: { name: 'query_tasks', arguments: JSON.stringify({ action: 'list' }) } }] }, finish_reason: 'tool_calls' }] }]);
    return stream(res, [{ choices: [{ delta: { content: '已读取隔离工作台的任务。保持原有数据，未进行修改。' }, finish_reason: 'stop' }] }]);
  }
  if (latestUser.includes('按需提案验收')) {
    if (messages.some(m => m.role === 'tool' && String(m.content).includes('propose_changes'))) return stream(res, [{ choices: [{ delta: { content: '已收到审批后的真实执行回执。' }, finish_reason: 'stop' }] }]);
    return stream(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'context-proposal', function: { name: 'propose_changes', arguments: JSON.stringify({ summary: '创建隔离验证任务', operations: [{ family: 'workspace', command: { kind: 'task.create', input: { title: '上下文按需加载审批验证' } } }] }) } }] }, finish_reason: 'tool_calls' }] }]);
  }
  if (latestUser.includes('html 选择题验收')) {
    const origin = `http://127.0.0.1:${port}`;
    const choice = `<p>选择一个方案</p><button onclick="wwa.fillInput('我选 A')">方案 A</button> <button onclick="wwa.fillInput('我选 B')">方案 B</button>
<pre id="probe">running</pre><span id="cdn-ok">pending</span> <span id="cdn-bad">blocked</span>
<script src="${origin}/cdn/probe@1.0.0/ok.js"></script>
<script>
wwa.fillInput('自动填入');
const out = {};
const attempt = async (key, run) => { try { out[key] = String(await run()); } catch (error) { out[key] = 'blocked:' + error.name; } };
const request = (make) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('timeout')), 1500); make(() => { clearTimeout(timer); resolve('open'); }, () => { clearTimeout(timer); reject(new Error('error')); }); });
(async () => {
  await attempt('fetch', () => fetch('${origin}/beacon?fetch').then(() => 'open'));
  await attempt('xhr', () => request((ok, fail) => { const x = new XMLHttpRequest(); x.onload = ok; x.onerror = fail; x.open('GET', '${origin}/beacon?xhr'); x.send(); }));
  await attempt('websocket', () => request((ok, fail) => { const socket = new WebSocket('ws://127.0.0.1:${port}/beacon'); socket.onopen = ok; socket.onerror = fail; }));
  await attempt('image', () => request((ok, fail) => { const image = new Image(); image.onload = ok; image.onerror = fail; image.src = '${origin}/beacon?image'; }));
  await attempt('sendBeacon', () => navigator.sendBeacon('${origin}/beacon?send', 'x'));
  await attempt('parent', () => parent.document.title);
  await attempt('top', () => { top.location.href = '${origin}/beacon?top'; return 'navigated'; });
  await attempt('storage', () => localStorage.length);
  await attempt('cookie', () => document.cookie);
  await attempt('open', () => window.open('${origin}/beacon?open'));
  await attempt('rtc', () => typeof RTCPeerConnection);
  await attempt('eval', () => eval('1 + 1'));
  const injected = document.createElement('script'); injected.src = 'http://localhost:${port}/cdn/probe@1.0.0/bad.js'; document.body.append(injected);
  await new Promise((resolve) => setTimeout(resolve, 500));
  out.done = 'yes';
  document.getElementById('probe').textContent = JSON.stringify(out);
})();
</script>`;
    const navigate = `<p>跳转测试</p><button onclick="location.href='${origin}/nav-target'">离开这里</button>`;
    const blocks = [
      { type: 'text', markdown: '请在下面选一个方案。' },
      { type: 'html', title: '方案选择', alt: '方案 A 和方案 B 两个按钮，点选后填入输入框', height: 260, source: choice },
      { type: 'html', title: '跳转测试', alt: '一个试图离开的按钮', source: navigate },
    ];
    return stream(res, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'html-choice', function: { name: 'present_reply', arguments: JSON.stringify({ blocks }) } }] }, finish_reason: 'tool_calls' }] }]);
  }
  if (latestUser.includes('html 搬家验收')) {
    const origin = `http://127.0.0.1:${port}`;
    // User page repro/gantt-user.html, plus #state so the filter click is observable after a reload.
    const gantt = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
body{margin:0;padding:14px;font-size:13px}
button{font:inherit;padding:4px 11px;border-radius:999px;cursor:pointer}
.row{display:flex;margin-bottom:6px;height:26px}
.track{position:relative;flex:1}
.bar{position:absolute;top:2px;height:18px;background:#2e9e6a}
</style></head>
<body>
<div class="btns" id="btns">
<button data-f="all" aria-pressed="true">全部</button>
<button data-f="done" aria-pressed="false">仅实际</button>
<button data-f="plan" aria-pressed="false">仅计划</button>
</div>
<p id="state">初始</p>
<div id="chart"></div>
<script>
(function(){
var D=[{n:"a",s:26,e:53,k:"done"},{n:"b",s:60,e:120,k:"plan"}];
var chart=document.getElementById("chart");
D.forEach(function(it){var row=document.createElement("div");row.className="row";row.setAttribute("data-k",it.k);
var tr=document.createElement("div");tr.className="track";var b=document.createElement("div");b.className="bar";
b.style.left=(it.s/540*100)+"%";b.style.width=((it.e-it.s)/540*100)+"%";tr.appendChild(b);row.appendChild(tr);chart.appendChild(row);});
document.getElementById("btns").addEventListener("click",function(e){var btn=e.target.closest("button");if(!btn)return;
var f=btn.getAttribute("data-f");if(f==="done")document.getElementById("state").textContent="仅实际";Array.prototype.forEach.call(document.querySelectorAll(".row"),function(r){var k=r.getAttribute("data-k");
r.style.display=(f==="all")||(f==="done"?k==="done":k!=="done")?"":"none";});});
})();
</script>
</body></html>`;
    const anchor = `<p id="log"></p><a href="#" onclick="document.getElementById('log').textContent+='井号'">井号</a> <a href="#sec" onclick="document.getElementById('log').textContent+='去小节'">去小节</a> <a href="" onclick="document.getElementById('log').textContent+='空链接'">空链接</a> <button type="button" onclick="location.hash='h';document.getElementById('log').textContent+='改hash'">改 hash</button><div style="height:2400px"></div><h2 id="sec">小节</h2>`;
    const external = `<a href="${origin}/nav-target">外链</a>`;
    const early = `<script>location.href='${origin}/nav-target'</script>`;
    const reload = `<p id="mark">原样</p><button type="button" onclick="document.getElementById('mark').textContent='改过';setTimeout(function(){location.reload()},50)">重新加载</button>`;
    // Function scope: a global `var frameElement` would alias the read-only window accessor and stay null.
    const probe = `<pre id="probe-out"></pre><script>
(function(){
var captured=[];
window.parent={postMessage:function(m){captured.push(JSON.stringify(m))}};
var html=document.documentElement.outerHTML+document.documentElement.innerHTML;
var scripts=Array.from(document.scripts).map(function(s){return s.text}).join();
var frameElement=String(window.frameElement);
window.wwa.fillInput('探针');
window.addEventListener('load',function(){setTimeout(function(){
document.getElementById('probe-out').textContent=JSON.stringify({html:html,scripts:scripts,frameElement:frameElement,captured:captured});
},300)});
})();
</script>`;
    const blocks = [
      { type: 'text', markdown: '搬家验收。' },
      { type: 'html', title: '甘特图', alt: '三条任务条，可按全部、仅实际、仅计划筛选', source: gantt },
      { type: 'html', title: '锚点', alt: '页内井号链接、小节锚点和空链接', source: anchor },
      { type: 'html', title: '外链', alt: '一个指向外部地址的链接', source: external },
      { type: 'html', title: '提前跳走', alt: '页面在加载完成前就跳走', source: early },
      { type: 'html', title: '重新加载', alt: '按钮会重新加载这个小页面', source: reload },
      { type: 'html', title: '探针', alt: '尝试读取隔离信息并填入输入框', source: probe },
    ];
    return stream(res, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'html-move', function: { name: 'present_reply', arguments: JSON.stringify({ blocks }) } }] }, finish_reason: 'tool_calls' }] }]);
  }
  if (latestUser.includes('html 懒加载验收')) {
    const blocks = [{ type: 'text', markdown: '下面隔开排列了八个小页面。' }];
    for (let index = 1; index <= 8; index += 1) {
      blocks.push({ type: 'html', title: `懒加载 ${index}`, alt: `懒加载验收页面 ${index}`, height: 300, source: fixedHtml(`懒加载 ${index}`) });
      blocks.push({ type: 'text', markdown: lazyFiller });
    }
    return stream(res, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'html-lazy', function: { name: 'present_reply', arguments: JSON.stringify({ blocks }) } }] }, finish_reason: 'tool_calls' }] }]);
  }
  if (latestUser.includes('html 贴底验收')) {
    const blocks = [{ type: 'text', markdown: '贴底验收从这里开始。' }];
    for (let index = 1; index <= 3; index += 1) {
      blocks.push({ type: 'html', title: `贴底 ${index}`, alt: `贴底验收页面 ${index}`, height: 300, source: fixedHtml(`贴底 ${index}`) });
      blocks.push({ type: 'text', markdown: lazyFiller });
    }
    blocks.push({ type: 'html', title: '贴底变高', alt: '加载后会把自己变高的页面', height: 300, source: growingHtml });
    return stream(res, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'html-pin', function: { name: 'present_reply', arguments: JSON.stringify({ blocks }) } }] }, finish_reason: 'tool_calls' }] }]);
  }
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
  if (latestUser.includes('笔记真实编辑验收')) {
    if (toolSince('propose_changes')) return stream(res, [{ choices: [{ delta: { content: '知识笔记已更新。' }, finish_reason: 'stop' }] }]);
    const nodeId = latestUser.match(/"learningNodeId":"([^"]+)"/)?.[1];
    if (!toolSince('learning_read')) return callTool('e2e_note_read', 'learning_read', { action: 'node', nodeId }, '我先读取这篇真实笔记。');
    const node = sinceUser.filter(message => message.role === 'tool').map(toolData).find(data => data?.node)?.node;
    if (!node) return stream(res, [{ choices: [{ delta: { content: '没有读到笔记。' }, finish_reason: 'stop' }] }]);
    return callTool('e2e_note_edit', 'propose_changes', { summary: '补充知识笔记和掌握情况', operations: [{ family: 'learning', args: { action: 'node_update', nodeId: node.id, expectedNodeRevision: node.revision, detail: node.detail + '\n\nAI 补充：模型需要通过独立场景验证应用边界。', nodeStatus: 'review' } }] }, '请确认这次笔记修改。');
  }
  if (latestUser.includes('学习地图验收')) {
    if (toolSince('propose_changes')) return stream(res, [{ choices: [{ delta: { content: '学习地图已创建，可以到学习地图页查看。' }, finish_reason: 'stop' }] }]);
    if (!toolSince('learning_read')) return callTool('e2e_learning_read', 'learning_read', { action: 'list' }, '我先读取学习域。');
    return callTool('e2e_learning_propose', 'propose_changes', {
      summary: '创建 Rust 学习地图',
      operations: [
        { family: 'learning', clientRef: 'map', args: { action: 'map_create', title: 'Rust 学习地图', goal: '掌握 Rust 基础' } },
        { family: 'learning', args: { action: 'node_create', mapId: { $ref: 'map' }, parentId: null, kind: 'topic', title: '所有权' } },
        { family: 'learning', args: { action: 'node_create', mapId: { $ref: 'map' }, parentId: null, kind: 'item', title: '读第 4 章' } },
      ],
    }, '我准备创建学习地图。');
  }
  if (latestUser.includes('列出任务')) {
    if (toolSince('query_tasks')) return stream(res, [{ choices: [{ delta: { content: '当前任务已读取完成。' }, finish_reason: 'stop' }] }]);
    return callTool(`e2e_list_${messages.length}`, 'query_tasks', { action: 'list', scope: 'current', usePageFilter: true, limit: 20 }, '我先读取任务。');
  }
  if (latestUser.includes('创建任务')) {
    if (toolSince('propose_changes')) return stream(res, [{ choices: [{ delta: { content: '变更已完成。' }, finish_reason: 'stop' }] }]);
    const topicId = latestUser.match(/topicId=(\S+)/)?.[1];
    return callTool(`e2e_create_${messages.length}`, 'propose_changes', {
      summary: '创建任务',
      operations: [{ family: 'workspace', command: { kind: 'task.create', input: { title: 'E2E Agent 任务', ...(topicId ? { topicId } : {}) } } }],
    }, '我准备创建这个任务。');
  }
  if (latestUser.includes('生成成果草稿')) {
    const topicId = latestUser.match(/topicId=(\S+)/)?.[1] ?? '';
    const topic = [...sinceUser].reverse().map(toolData).find((v) => v?.id === topicId && Number.isInteger(v.revision) && v.revision > 0);
    if (!topic) return callTool(`e2e_summary_read_${messages.length}`, 'query_topics', { action: 'get', topicId }, '我先读取当前清单及其版本。');
    if (toolSince('propose_changes')) return stream(res, [{ choices: [{ delta: { content: '成果草稿已放在确认卡里。' }, finish_reason: 'stop' }] }]);
    const summary = latestUser.includes('第二版') ? 'E2E 最终成果' : 'E2E 待放弃草稿';
    return callTool(`e2e_summary_${messages.length}`, 'propose_changes', {
      summary: '生成成果草稿',
      operations: [{ family: 'workspace', command: { kind: 'topic.update', targetId: topicId, expectedRevision: topic.revision, input: { draftSummary: summary } } }],
    }, '我准备生成成果草稿。');
  }
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
  if (latestUser.includes('统计这周 AI 派发')) {
    if (toolSince('orchestration_stats')) {
      const stats = sinceUser.map(toolData).find((data) => data && typeof data.roundCount === 'number');
      const rounds = stats?.roundCount ?? '未知';
      const unknown = (stats?.resources?.noCostJobs ?? 0) > 0 ? '有步骤费用未知。' : '';
      return stream(res, [{ choices: [{ delta: { content: `本周派发 ${rounds} 轮。${unknown}` }, finish_reason: 'stop' }] }]);
    }
    return callTool('e2e_orch_stats', 'orchestration_stats', {}, '我先统计本周的派发。');
  }
  if (latestUser.includes('清理已验收的 worktree')) {
    if (toolSince('propose_worktree_cleanup')) return stream(res, [{ choices: [{ delta: { content: '删除卡片已经生成，请在卡片上确认。' }, finish_reason: 'stop' }] }]);
    const listed = sinceUser.map(toolData).find((data) => Array.isArray(data?.items) && data.items.some((view) => Array.isArray(view?.worktrees)));
    if (!listed) return callTool('e2e_orch_read', 'orchestration_read', { action: 'worktrees' }, '我先看看电脑上报的 worktree。');
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
  return stream(res, [{ choices: [{ delta: { content: messages.some((item) => item.role === 'tool') ? '当前任务已读取完成。' : 'Mock 模型回复。' }, finish_reason: 'stop' }] }]);
});
server.on('upgrade', (req, socket) => { if (req.url?.startsWith('/beacon')) htmlLeaks++; socket.destroy(); });
server.listen(port, '127.0.0.1', () => console.log(`Mock OpenAI listening on ${port}`));
