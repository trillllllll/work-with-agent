// Fixed isolated fixtures, no DB reads, network/model calls or credentials.
// Run after `npm run build -w server`. Both sides use the same text estimator.
import { mkdir, writeFile } from 'node:fs/promises';
import { builtinSystemPrompt, builtinToolDefinitions } from '../server/dist/agent/capabilities.js';
import { initialToolGroups, lazySystemPrompt, toolsForGroups, mediaInstructions } from '../server/dist/agent/tool-loading.js';
import { htmlBlockPrompt } from '../server/dist/agent/html-block.js';
import { messagesTokens, textTokens, packModelMessages, backgroundMessage } from '../server/dist/agent/context-budget.js';

const out = 'docs/design/dovun/context-optimization';
const html = htmlBlockPrompt({ enabled: true, cdn: ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com'] });
const work = '【固定说明】\n保留原始数据，任何修改先出确认卡片。\n\n【本次请求的上下文】\n页面：chat；清单：收集箱；时区：Asia/Shanghai\n\n【附近任务】\n- task-1 todo 核对产品说明 revision=1';
const oldSystem = { role: 'system', content: `${builtinSystemPrompt()}\n\n${html}\n\n${work}` };
const system = { role: 'system', content: `${lazySystemPrompt()}\n\n${work}` };
const fullTools = builtinToolDefinitions();
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });
const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const result = (id, name, data) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify({ toolName: name, sourceMessageId: `source-${id}`, success: true, data }) });
const summary = '目标：核对个人工作台的任务与资料。约束：保留原数据，修改必须先确认。已完成：读到 task-1、material-1 的元信息。未决：核对原文中的安排日期。证据：source-history-1，task-1 revision=1，material-1 revision=2。';

function oldReplay(messages) {
  const replay = messages.map(m => m.role === 'tool' && m.content.length > 6000 ? { ...m, content: m.content.slice(0, 6000) + '…[工具结果已截断]' } : m);
  const chars = messages.reduce((n, m) => n + (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  if (Math.ceil(chars / 4) <= 6000) return replay;
  let head = messages.length; let users = 0;
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user' && ++users > 2) { head = i; break; }
  let tail = Math.max(0, messages.length - 8);
  const lastUser = messages.map(m => m.role).lastIndexOf('user');
  if (lastUser >= 0 && lastUser < tail) tail = lastUser;
  while (tail > 0 && messages[tail].role === 'tool') tail--;
  return tail <= head ? replay : [...replay.slice(0, head), backgroundMessage(summary), ...replay.slice(tail)];
}
const estimate = (messages, tools) => messagesTokens(messages) + textTokens(JSON.stringify(tools));
function scenario(id, title, frames, groups, options = {}) {
  const before = frames.map(frame => estimate([oldSystem, ...oldReplay(frame)], fullTools));
  const active = [...groups];
  const after = [];
  for (let i = 0; i < frames.length; i++) {
    let history = frames[i];
    if (options.longHistory) history = [backgroundMessage(summary), ...history.slice(-5)];
    const media = active.includes('media') ? [{ role: 'system', content: `【按需富媒体规则】\n${mediaInstructions}\n${html}` }] : [];
    after.push(estimate(packModelMessages([system, ...media, ...history]), toolsForGroups(active)));
    if (i === 0 && options.discover) {
      // Include the entire extra request caused by loading, not just schema size.
      active.push(...options.discover);
      const loaded = [...history, call('load', 'load_tools', { groups: options.discover }), result('load', 'load_tools', { groups: active })];
      after.push(estimate(packModelMessages([system, ...loaded]), toolsForGroups(active)));
    }
  }
  const summaryRequest = options.freshSummary ? { estimatedInputTokens: textTokens(options.freshSummary), estimatedOutputTokens: textTokens(summary) } : null;
  const beforeTotal = before.reduce((a, b) => a + b, 0) + (summaryRequest?.estimatedInputTokens ?? 0);
  const afterTotal = after.reduce((a, b) => a + b, 0) + (summaryRequest?.estimatedInputTokens ?? 0);
  return { id, title, estimator: 'mixed-text-v1', before: { calls: before.length + (summaryRequest ? 1 : 0), estimatedInputTokens: beforeTotal, perCallInput: before }, after: { calls: after.length + (summaryRequest ? 1 : 0), estimatedInputTokens: afterTotal, perCallInput: after }, savedTokens: beforeTotal - afterTotal, reductionPercent: Number(((beforeTotal - afterTotal) / beforeTotal * 100).toFixed(1)), summaryRequest, providerActualUsage: null };
}
const q = user('查询当前任务，保持数据不变。');
const queryCall = call('q', 'query_tasks', { action: 'list' });
const queryResult = result('q', 'query_tasks', { items: [{ id: 'task-1', title: '核对产品说明', revision: 1, status: 'todo' }] });
const history = [user('请持续保留这个约束：不要自动删除资料。'), assistant('已核对的早期资料背景。'.repeat(500)), user('先分析，不要执行未确认修改。'), assistant('历史核对记录。'.repeat(500))];
for (let i = 0; i < 10; i++) history.push(user(`核对第${i}段资料。`), assistant(`结论${i}：需要引用原始来源，不能补造结果。`.repeat(80)));
const materialCall = call('material', 'library_read', { action: 'read', materialId: 'material-1', revision: 2 });
const materialResult = result('material', 'library_read', { id: 'material-1', revision: 2, title: '产品说明', content: '原文中的业务说明，需进一步核对日期。'.repeat(800) });
const writeUser = user('创建一项核对任务，先给确认卡片。');
const writeCall = call('write', 'propose_changes', { summary: '创建任务', operations: [{ family: 'workspace', command: { kind: 'task.create', input: { title: '核对产品说明' } } }] });
const rows = [
  scenario('ordinary-query', '普通任务查询（完整两次调用）', [[q], [q, queryCall, queryResult]], initialToolGroups(q.content, 'chat')),
  scenario('long-history', '长会话与大工具结果（稳定摘要）', [[...history, q], [...history, q, materialCall, materialResult]], ['tasks', 'library'], { longHistory: true }),
  scenario('long-history-fresh', '首次压缩（两边均计入摘要请求）', [[...history, q], [...history, q, materialCall, materialResult]], ['tasks', 'library'], { longHistory: true, freshSummary: history.map(m => String(m.content).slice(0, 600)).join('\n') }),
  scenario('write-approval', '创建及审批后续办', [[writeUser], [writeUser, writeCall, result('write', 'propose_changes', { status: 'executed', affected: [{ id: 'task-1', revision: 1 }] })]], initialToolGroups(writeUser.content, 'chat')),
  scenario('discovery-overhead', '未预选修改能力（计入额外加载调用）', [[user('按需提案验收')], [user('按需提案验收'), writeCall, result('write', 'propose_changes', { status: 'executed' })]], ['tasks'], { discover: ['workspace_write'] }),
  scenario('rich-media', '明确要求可视化（保留完整展示能力）', [[user('用图表展示完成情况')]], ['tasks', 'media']),
];
const report = { generatedAt: new Date().toISOString(), kind: 'isolated-fixture-replay', estimator: 'mixed-text-v1', note: 'Same fixed content and estimator for both sides. Input totals include every declared model call and any summary request. Source data, provider tokenizer/billing and semantic model quality are not simulated as actual usage. These results are not the earlier 19029-token real-request sample.', rows };
await mkdir(out, { recursive: true });
await writeFile(`${out}/token-comparison.json`, JSON.stringify(report, null, 2) + '\n');
const table = ['| 场景 | 优化前估算输入 | 优化后估算输入 | 减少 | 调用次数（前→后） |', '| --- | ---: | ---: | ---: | ---: |', ...rows.map(r => `| ${r.title} | ${r.before.estimatedInputTokens.toLocaleString()} | ${r.after.estimatedInputTokens.toLocaleString()} | ${r.reductionPercent}% | ${r.before.calls} → ${r.after.calls} |`)];
await writeFile(`${out}/token-comparison.md`, '# Token 对比\n\n隔离固定场景重放，统一使用 mixed-text-v1 文本估算，**不是供应商实际计费**。累计输入包含加载能力产生的额外调用和摘要请求。长会话固定摘要来自已知测试事实；语义与审批行为另外由单元和端到端测试验证。\n\n' + table.join('\n') + '\n\n富媒体、修改需要时仍加载完整对应定义。首次压缩有额外成本，短会话不会调用摘要模型；不承诺所有请求都节省同样比例。脚本不调用模型，不读取用户数据库。可用 `node scripts/context-token-benchmark.mjs` 重放（先构建服务端）。\n');
console.log(JSON.stringify(rows.map(({ title, before, after, reductionPercent }) => ({ title, before: before.estimatedInputTokens, after: after.estimatedInputTokens, reductionPercent }))));
