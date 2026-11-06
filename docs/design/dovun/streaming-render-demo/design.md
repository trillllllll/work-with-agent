# AI 对话流式渲染实验

日期：2026-11-07。源码基线：`08a9c84`。本次交付是独立 Demo 与技术实验。

## 演示目标

在同一份分块输入上比较「等待完成」与「流式渲染」，覆盖 Markdown、数据图表、Mermaid、SVG、HTML。提供调速、暂停、继续、单步、重放及中断，让用户看到内容从不完整到完整的过程。数据是固定模拟回复；解析、渲染、沙箱与交互是真实执行。

## 现有证据与组件复用

- `MessageBlocks.tsx` / `MessageItem.tsx`：流式文字使用纯文本，结束后切换 Markdown；图形在 ready 后展示。
- `reply-parser.ts` / `reply-stream.ts`：已有真实 JSON token 解析和文字增量；source、chart 尚无增量发布。
- 复用 `Button`、`NativeSelect`、`Surface`、`MarkdownView`、`safeSvg`、`buildSrcdoc`、CSP 和主题桥接。
- 现有图表组件在 spec 变化时重建实例；实验使用同一个 ECharts 实例调用 setOption。
- `VisualFrame` 切换源码会卸载子组件，实验使用公共 Surface / Button 布局并将源码放在旁边，避免切换源码重置 HTML。
- 现有 HTML srcdoc 在挂载时固定；实验使用同一个隔离 iframe 接收增量片段。
- 沿用现有色彩、字体和控件材质；页面增加实验专用布局，不调整正式对话入口。

## 更新策略

| 内容 | 更新边界 | 未完成 / 错误处理 |
| --- | --- | --- |
| Markdown | 合并收到的字符后复用 MarkdownView，关闭图形围栏自动执行 | 未闭合语法先按 Markdown 容错展示；不执行 HTML |
| 图表 | JSON parser 收到完整数值后，按完整分类/数值对更新 | 数值未闭合不发布；不补造数据 |
| Mermaid | 以换行结束的候选内容，节流后实际 parse/render | 仅成功结果替换；失败保留上一版；结束后报告错误 |
| SVG | 完整根属性和完整直属元素，临时闭合根并执行现有 SVG 校验 | 不完整元素暂存；错误保留上一版 |
| HTML | 完整顶层片段，清理后追加进同一 iframe | 脚本推迟至整个块完整、校验后执行一次；不重载 iframe |

HTML/SVG 分段器是保守的、显式闭合标签子集，不是通用 HTML5 解析器。复杂不完整父元素会等待闭合；任意 HTML 的节点修改、删除与通用 DOM diff 不在这个实验的已验证能力内。Mermaid 覆盖流程图；其他语法需独立补充边界测试。

## 数据流

固定 present_reply 形状 JSON → UTF-8 字节分块 → 实验 JSON tokenizer → 各内容候选 → 校验/渲染 → 成功结果。

实验解析器基于现有 ReplyParser 的结构，增加 source 与单系列柱状图数据快照。沿用仓库已安装的 @streamparser/json；不将实验解析器接入正式服务。输入大小、嵌套深度、字段长度和块数量有界。

正式接入需扩展后端事件协议（source delta、chart patch、offset、revision）、持久化与断线重放，再替换正式展示逻辑；完整块仍走已有服务端校验和来源核验。Demo 不证明生产模型输出、真实 SSE 重连或桌面安装的验收。

## 验收

1. 五种内容均在完整回复之前出现真实渲染结果，最终结果与固定输入一致。
2. 暂停后接收字节不增加；继续/单步从原位置推进；重放隔离旧异步结果。
3. UTF-8 单字节切分、转义、半个字段、中断和错误候选可重复测试。
4. Mermaid/SVG 错误候选不清空上一版；HTML 流式过程中输入值保留，脚本只运行一次。
5. 桌面/手机布局、键盘操作、控制台、网络及浅色/深色实际浏览器检查。
6. 实测数据与测试范围写入 results.md；不将模拟分块耗时称为模型延迟。
