let release;
export function releaseStreamingFixture() { release?.(); release = undefined; }
/** Gate the actual model SSE stream so tests can inspect pending production blocks. */
export async function streamProductionFixture(res, prompt, tools) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = (delta, done = false) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: done ? 'tool_calls' : null }] })}\n\n`);
  if (!tools.some(t => t.function.name === 'present_reply') && tools.some(t => t.function.name === 'load_tools')) {
    send({ tool_calls: [{ index: 0, id: 'load-streaming', function: { name: 'load_tools', arguments: '{"groups":["media"]}' } }] }, true); res.end('data: [DONE]\n\n'); return;
  }
  const kind = prompt.split('正式流式验收 ')[1]?.split(' ')[0] ?? 'html';
  let block, marker;
  if (kind === 'html') {
    block = { type: 'html', renderMode: 'fragments', title: '分段交互验收', alt: '生成时输入，完成后确认', source: '<style>body{padding:18px}input{max-width:90%;padding:8px}section{margin-bottom:14px}</style><section><label for="stream-name">我的计划</label><input id="stream-name" autocomplete="off"/></section>\n<section><button id="confirm">确认</button><output id="result"></output></section><script>window.__runs=(window.__runs||0)+1;document.getElementById("confirm").addEventListener("click",function(){document.getElementById("result").textContent=document.getElementById("stream-name").value;});</script>' };
    marker = '<section><button';
    if (prompt.includes('invalid')) block.source += '<p>脚本后不允许片段</p>';
  } else if (kind === 'svg') {
    block = { type: 'svg', title: '矢量验收', source: '<svg viewBox="0 0 200 80"><rect width="200" height="80" fill="#dcebe3"/>\n<text x="10" y="40">最终节点😀</text></svg>' }; marker = '<text';
    if (prompt.includes('invalid')) block.source = block.source.replace('</svg>', '<path onclick="alert(1)"/></svg>');
  } else if (kind === 'mermaid') {
    block = { type: 'mermaid', title: '流程验收', source: 'flowchart LR\nA[开始]-->B[中间]\nB-->C[最终节点]\n' }; marker = 'B-->C';
    if (prompt.includes('invalid')) block.source += 'C-->D[未闭合';
    if (prompt.includes('empty')) { block.source = 'flowchart LR\nclassDef warm fill:#f00\nA-->B\n'; marker = 'A-->B'; }
  } else if (kind === 'markdown' || kind === 'plain') {
    block = { type: 'text', markdown: '## 流式排版\n\n**可读文字😀**\n\n| 阶段 | 状态 |\n| --- | --- |\n| 实现 | 进行中 |\n\n最后一段确认。' }; marker = '最后一段';
  } else {
    const series = [{ name: '甲', values: kind === 'scatter' ? [[1, 2], [3, 4]] : [1, 2] }, { name: '乙', values: kind === 'scatter' ? [[5, 6]] : [3, 4] }];
    const spec = { kind, title: '数据验收', ...(kind === 'pie' ? { values: [{ name: 'A', value: 1 }, { name: 'B', value: 2 }] } : { ...(kind === 'scatter' ? {} : { categories: ['A', 'B'] }), series }), provenance: prompt.includes('invalid') ? { kind: 'tool', label: '虚构来源', messageId: 'missing', toolCallId: 'missing', dataPath: [], categoryField: 'name', valueFields: ['value'] } : { kind: 'simulated', label: '模拟数据' } };
    block = { type: 'chart', spec };
  }
  const wire = kind === 'plain' ? block.markdown : JSON.stringify({ blocks: [block] });
  const split = marker ? wire.indexOf(marker) : kind === 'pie' ? wire.indexOf(',{"name":"B"') : kind === 'scatter' ? wire.indexOf(',[3,4]') : wire.indexOf('1,2') + 2;
  const emit = (text, first, done = false) => send(kind === 'plain' ? { content: text } : { tool_calls: [{ index: 0, ...(first ? { id: 'streaming-presentation' } : {}), function: { ...(first ? { name: 'present_reply' } : {}), arguments: text } }] }, done);
  emit(wire.slice(0, split), true);
  await new Promise(resolve => { release = resolve; res.once('close', resolve); });
  if (res.destroyed) return;
  emit(wire.slice(split), false, true); res.end('data: [DONE]\n\n');
}
