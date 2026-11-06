// i18n-ignore-file: Chinese experiment fixtures, no application data.
export type Kind = 'markdown' | 'chart' | 'mermaid' | 'svg' | 'html';
export const kinds: { id: Kind; name: string; label: string; hint: string }[] = [
  { id: 'markdown', name: 'Markdown', label: '文字与排版', hint: '文字到达，排版随之出现。' },
  { id: 'chart', name: 'Chart', label: '数据图表', hint: '完整的数据点到达，柱形随之增长。' },
  { id: 'mermaid', name: 'Mermaid', label: '流程图', hint: '解析成功才更新，未写完时保留上一版。' },
  { id: 'svg', name: 'SVG', label: '矢量图形', hint: '完整图形元素逐个进入画布。' },
  { id: 'html', name: 'HTML', label: '交互页面', hint: '页面逐段成形，输入状态始终保留。' },
];
const markdown = `## 把这一周，变成看得见的进展\n\n我们为产品迭代安排了 **三个阶段**。先验证方向，再完善体验，最后准备交付。\n\n### 先把最重要的事做好\n\n- **周一至周二**：确认方案，完成关键交互。\n- **周三至周四**：联调与测试，处理边界情况。\n- **周五**：验收并整理发布说明。\n\n| 阶段 | 目标 | 状态 |\n| --- | --- | --- |\n| 方案 | 对齐主要流程 | 已完成 |\n| 实现 | 跑通核心体验 | 进行中 |\n| 验收 | 确认交付质量 | 待开始 |\n\n> 小步更新，让进展更清楚。即使回答还没结束，已经生成的内容也可以阅读。\n\n\`\`\`ts\nconst next = await stream.read();\nrender(next.value);\n\`\`\`\n\n下一步：从 **最小可验证的体验** 开始。 🌱`;
const mermaid = `flowchart LR\n  A[收到内容]\n  A --> B[解析片段]\n  B --> C{内容完整?}\n  C -->|是| D[更新预览]\n  C -->|否| E[等待下一段]\n  E --> B\n  D --> F[保留可读结果]\n`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 350">
<rect x="1" y="1" width="618" height="348" rx="22" fill="#f4f7f5"/>
<text x="36" y="52" font-size="22" font-family="sans-serif" fill="#244d41">从想法，到交付</text>
<path d="M100 164H520" stroke="#b4cabe" stroke-width="3" stroke-dasharray="6 6"/>
<g><circle cx="100" cy="164" r="32" fill="#dcebe3"/><text x="100" y="171" text-anchor="middle" font-size="20" fill="#244d41">01</text><text x="100" y="228" text-anchor="middle" font-size="16" fill="#244d41">明确方向</text></g>
<g><circle cx="310" cy="164" r="32" fill="#8db8a3"/><text x="310" y="171" text-anchor="middle" font-size="20" fill="#163c2e">02</text><text x="310" y="228" text-anchor="middle" font-size="16" fill="#244d41">逐步成形</text></g>
<g><circle cx="520" cy="164" r="32" fill="#386b55"/><text x="520" y="171" text-anchor="middle" font-size="20" fill="#ffffff">03</text><text x="520" y="228" text-anchor="middle" font-size="16" fill="#244d41">完成交付</text></g>
<text x="310" y="300" text-anchor="middle" font-size="14" fill="#61776b">每一个完整片段，都让结果更清楚一点。</text>
</svg>`;
const html = `<style>
*{box-sizing:border-box}body{padding:24px;font-size:14px}h2{font-size:24px;margin:8px 0}p{color:var(--wwa-muted);line-height:1.7}section{border:1px solid var(--wwa-border);border-radius:14px;padding:18px;margin:16px 0}label{display:block;margin-bottom:10px}input{width:100%;background:var(--wwa-bg);color:var(--wwa-fg);border:1px solid var(--wwa-border);border-radius:8px;padding:10px;font:inherit}button{background:var(--wwa-accent);color:white;border:0;border-radius:8px;padding:10px 16px;font:inherit;cursor:pointer}button:disabled{opacity:.45;cursor:wait}output{display:block;margin-top:12px;font-size:15px}.eyebrow{font-size:11px;letter-spacing:2px;color:var(--wwa-accent)}.stats{display:flex;gap:24px}.stats strong{font-size:25px;display:block}.stats span{font-size:12px;color:var(--wwa-muted)}
</style>
<header><span class="eyebrow">YOUR NEXT STEP</span><h2>给下一步，留一点空间。</h2><p>页面还在生成时，就可以在下面输入。后续内容到达不会清空它。</p></header>
<section><label for="next-step">我的下一步</label><input id="next-step" placeholder="试着在生成结束前输入…" autocomplete="off" /></section>
<section class="stats"><div><strong>3</strong><span>个阶段</span></div><div><strong>5</strong><span>个工作日</span></div><div><strong>1</strong><span>个明确目标</span></div></section>
<section><button id="confirm-step" type="button" disabled>确认我的下一步</button><output id="step-result">页面完成后，可以点击确认。</output></section>
<script>
window.__demoScriptRuns=(window.__demoScriptRuns||0)+1;
document.getElementById('confirm-step').disabled=false;
document.getElementById('confirm-step').addEventListener('click',function(){
var value=document.getElementById('next-step').value.trim();
document.getElementById('step-result').textContent=value?'下一步：'+value:'先写下一件你想完成的事。';
});
</script>`;
export function fixture(kind: Kind, invalid = false): { wire: string; source: string } {
  let block: Record<string, unknown>;
  if (kind === 'markdown') block = { type: 'text', markdown };
  else if (kind === 'chart') block = { type: 'chart', spec: { kind: 'bar', title: '一周的进展', categories: ['周一', '周二', '周三', '周四', '周五'], series: [{ name: '完成任务', values: [3, 5, 4, 8, 6] }], provenance: { kind: 'simulated', label: '演示数据' } } };
  else block = { type: kind, ...(kind === 'html' ? { renderMode: 'fragments' } : {}), title: kinds.find(k => k.id === kind)!.label, alt: '固定模拟内容，用于渲染实验', source: kind === 'html' ? html : kind === 'svg' ? svg : mermaid };
  if (invalid && kind === 'mermaid') block.source = mermaid + '  F --> G[这个标签没有结束\n';
  if (invalid && kind === 'svg') block.source = svg.replace('</svg>', '<path d="M 20 20" onclick="alert(1)"/></svg>');
  return { wire: JSON.stringify({ blocks: [block] }, null, 2), source: String(block.source ?? block.markdown ?? JSON.stringify(block.spec, null, 2)) };
}
