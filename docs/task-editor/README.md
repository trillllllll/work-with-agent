# 交接：任务正文轻量编辑与自动保存

> 原始交接记录写于 2026-10-14。本目录保存当时的实现说明与验收截图；历史测试数字不代表当前版本重新验收。后续操作以用户最新授权为准。

## 一句话现状

Tiptap 3 编辑内核、自动保存协调器、服务端纯文字分支、旧 e2e 断言、资料引用和 CodeMirror 清理都已完成。WebKit 编辑器项目与三组截图已跑过。**还没做的只有真实 macOS 中文输入法加上桌面 WebView 的人工验证**（不能用模拟 `compositionend` 代替）。

---

## 一、已完成（均有代码 + 测试佐证）

### 阶段 1 · 数据类型与 Markdown 适配层
- `client/src/lib/task-editor-types.ts`：全部数据契约（TaskText / TextVersion / TaskTextDraftV1 / PendingRequest / SaveStatus 等）。
- `client/src/lib/description-codec.ts`：Markdown ⇄ Tiptap JSON 适配层。未修改逐字返回原文；不支持块保留为 `rawMarkdown` 原文片段；`wwa-material:` 资料引用解析为原子 `materialReference` 节点。
- `client/src/lib/task-text-merge.ts`：字段级三方合并（标题按 trim 比较，正文逐字）。
- 测试：`description-codec.test.ts`（22）、`task-text-merge.test.ts`（4）全部通过。

### 阶段 2 · 草稿仓库与同步协调器
- `client/src/lib/task-draft-store.ts`：原生 IndexedDB（`wwa-task-editor` / `drafts`，keyPath `[scopeKey, taskId, branchId]`）。写入以 `transaction.oncomplete` 为准；条件删除校验版本/outbox/文字。
- `client/src/lib/task-text-sync.ts`：`TaskTextSyncCoordinator`。2s 防抖（2026-10-17 从 800ms 调整，另加标题失焦 `saveNow`、10s 连续输入检查点、250ms 输入落盘节流，见 `docs/editor-save.md`）、15s 网络超时、2s/5s/15s 重试、持久化 outbox 幂等重放、字段级三方合并、`prepareLeave`/`ensureSaved` 分离、多分支草稿隔离、中文组词暂停。
- 测试：`task-text-sync.test.ts` 覆盖契约 8.4 强制断言矩阵（1999/2000ms、连续输入、事务未完成、超时重试同 ID、ACK 不覆盖后续输入、并发=1、跨任务、离线、冲突、401/404、多分支、条件删除、重载重放、重订阅立即拿到内存草稿、打开完成前的输入仍保留）。

### 阶段 3 · 服务端调整
- `server/src/application/workspace-task.ts`：
  - 新增 `updateText()` 纯文字分支——只改 title/description，不 `touchParent`、不改排序/归属、与现值相同不增 revision 不记 change；文字仍走命令权限 + `expectedRevision`。
  - 移除正文更新路径的 `pruneTaskImages`（图片随任务保留到永久删除）。
- `server/src/application/library/references.ts` + `commands.ts`：资料引用新增整篇正文模式（`description` 分支），与旧 `from/to` 范围模式互斥；校验所选资料必须出现在正文、新增引用必须来自 `materialIds`。
- 测试：`task-editor-contract.test.ts`（8）、重写的 `task-images.test.ts`（3）通过。

### 阶段 4/5/6 · 编辑内核、接线、视觉
- `client/src/components/tasks/DescriptionEditor.tsx`：Tiptap 3 内核（`StarterKit` 关掉自带列表，只留一份 `ListKit`，`taskItem: { nested: true }`，再加 `Link`、`Placeholder` 和自定义扩展）。剪贴板优先级、代码块内禁用 Markdown 输入规则、格式浮条、链接弹层、原文片段编辑弹层。
- `client/src/components/tasks/description-extensions.ts`：`rawMarkdown` / `materialReference` / 任务图片（校验本任务地址）/ 上传装饰（位置随事务映射）/ 表格列对齐。
- `client/src/components/tasks/TaskDescription.tsx`：上传队列接入（上传完成后按捕获 taskId + uploadId 映射位置插入）。
- `client/src/components/tasks/TaskExpand.tsx`：文字编辑接协调器，非文字字段走原本地草稿；冲突面板、保存状态行、多分支选择弹层。
- `client/src/components/tasks/task-save-status.tsx`：保存状态行（`role=status` + `aria-live=polite`）+ 右下角「X 项未同步」入口。
- `client/src/lib/task-editor-runtime.tsx`：应用级单例 `EditorRuntime`（协调器 + 传输层 + Web Locks + 登录联动 + beforeunload 保护）。
- `client/src/components/workspace/SessionGate.tsx`：登录成功后 `EditorRuntime.open(actorId)`，登录失效 `markEditorSessionExpired(true)`。
- `client/src/index.css`：按契约第七节新增正文排版、格式浮条、链接弹层、状态行、未同步入口样式。
- 依赖：`@tiptap/*` 全部固定 `3.32.0`，`fake-indexeddb@6.2.5`（dev）。

---

## 二、当前测试状态

数字以 2026-10-14 这一轮实测为准。早期交接里的 client 133/133、e2e 50/16 已过时。

| 套件 | 结果 |
|---|---|
| client 单测（`cd client && npx vitest run`） | **130/130 通过** |
| client `tsc -b` | 通过 |
| server 单测 | **本次未重跑**。交接开始时为 307/308，唯一失败是既有 flake `library-repair.test.ts「会话正文可以解析…重新排队」`，不要当成本次回归 |
| `npm run build`（root） | 通过。仍有 chunk >500kB，以及 `DescriptionEditor.tsx` 里 `openDescription.current === (() => editor.commands.focus())` 恒为 false 的既有警告 |
| e2e chromium + mobile：`task-detail-editor`、`task-detail-rich`、`task-editor-lightweight`、`task-materials` | **32/32 通过** |
| e2e chromium + mobile：`task-parent-navigation`、`narrow-detail` | **34/34 通过** |
| e2e `--project=webkit-editor` | **16/16 通过**（WebKit 26.6 / playwright webkit-2359） |
| `git diff --check` | 干净 |

以上为 2026-10-14 的历史验收结果，当轮没有跑完整仓库 e2e。相关实现已进入 main；2026-10-16 整理文档时未重新运行编辑器验收，也未补做真实 macOS 中文输入法验证。

---

## 三、剩余工作

### 1. 更新旧 e2e 断言 —— 已完成
契约 5.6：本地草稿安全写入即可切换任务，不再弹「保存未完成的编辑？」。契约 8.7：改断言、保留用例。`task-parent-navigation.spec.ts` 与 `narrow-detail.spec.ts` 已按这个语义改完，上面 34 条通过。父任务加载中的状态行不再和保存状态行的 `role=status` 抢同一个查询。

### 2. 资料引用链路 —— 已完成
`task-materials.spec.ts` 的 5 条在 chromium、mobile、webkit-editor 都通过，包括引用多选和编辑中解除关联。服务端整篇正文模式见下方证据。

### 3. CodeMirror 死代码 —— 已完成
`markdown-format.ts`、对应测试，以及 `@codemirror/commands`、`@codemirror/state`、`@codemirror/view` 已从源码和 `package.json` 去掉。仓库里已没有 `codemirror` 或 `markdown-format` 引用。

### 4. 收尾验证
- WebKit 编辑器项目 16/16，见上表。
- 三组截图见 [桌面浅色](desktop-light.png)、[桌面深色](desktop-dark.png)、[390px 触屏](touch-390.png)，都是任务「把登录改成一次性链接」的详情（标题、勾选列表、代码块）。浅色与深色哈希不同。
  - `desktop-light.png` `84e06dbd2f7c64a85226af5a43e2814a86db1a58452f564bfcd3d6797548aaaf`
  - `desktop-dark.png` `235568e7099a497090f715ce16228d3cea364d3f81131e0c375075c0b8ec9a5c`
  - `touch-390.png` `9710139a373fe3617ae034f001a1b3ad092305d32fb924a8e726982d295a747e`
  - 截图用过的 `e2e/task-editor-shots.spec.ts` 已删除，避免以后全量 e2e 改写这些文件。
- **真实 macOS 中文输入法 + 桌面 WebView：未做。** 不要用派发 `compositionend` 冒充。协调器单测只覆盖「组词期间不触发远端保存」。
- 四类证据见下。图片撤销只在服务端单测里点了撤销；e2e「删除正文中的图片后，图片记录仍可访问直到任务永久删除」没有点撤销。

#### 保存竞争
`client/src/lib/task-text-sync.test.ts`：1999ms 不发送、2000ms 发送一次；连续输入只提交最后一次；并发为 1；超时重试的 `requestId` 与 body 与首次相同；旧请求 ACK 后保留更新的草稿；页面重载重放原来的 outbox id。2026-10-17 起另覆盖：`saveNow` 失焦立即发送并取消计时、10s 检查点、检查点 ACK 后重开等待窗口、250ms 落盘节流与关键路径冲刷。

#### 离线恢复
同一文件：本地事务 abort 时 `prepareLeave` 为 false 且不发请求；断网切换任务后 IndexedDB 草稿还在；401 停止重试直到重新认证；404 不复活任务；远端冲突保留三份字段值。

#### 资料引用
`server/src/application/task-editor-contract.test.ts` 的 `whole-description material references`：整篇正文引用只加一次 revision、正文逐字相等、`materialTaskLink` 存在；版本不匹配时正文和关联都不变。e2e 见 `task-materials.spec.ts`。

#### 图片保留与撤销
`server/src/application/task-images.test.ts`「stores compressed bytes outside the description and keeps unreferenced images until permanent delete」：正文不再引用图片时记录和文件仍在；`POST /api/changes/:id/undo` 恢复引用后字节与上传一致；永久删除任务后记录和未被资料使用的 blob 才回收。变更记录正文不含图片字节。

已知、未当失败：跨过 1024px 时标题焦点仍会恢复，正文插入点不再断言，也不要加回已删的 `selectionchange` 光标跟踪。

---

## 四、关键实现入口（接手时优先读）

| 文件 | 职责 |
|---|---|
| `client/src/lib/task-text-sync.ts` | 自动保存协调器（核心算法都在这里：pump/deliver/acknowledge/mergeExternal/prepareLeave/ensureSaved/sendReference） |
| `client/src/lib/description-codec.ts` | Markdown 保真边界（parse/serialize + `docsEqual` + 未修改逐字返回） |
| `client/src/lib/task-editor-runtime.tsx` | 单例 runtime、传输层（超时/幂等重放）、Web Locks、登录联动 |
| `client/src/components/tasks/DescriptionEditor.tsx` | Tiptap 内核、剪贴板规则、浮条/弹层、`activeEditors` 任务级注册表 |
| `client/src/components/tasks/TaskExpand.tsx` | 详情外壳：协调器订阅、非文字字段草稿、冲突面板、`TaskDetailHandle` |
| `server/src/application/workspace-task.ts` | `updateText()` 纯文字分支 + 移除图片清理 |
| `server/src/application/library/references.ts` | 资料引用整篇正文模式 |

## 五、容易踩的坑（契约 9.x 已显式列出）

- 服务端纯文字分支不能靠关 `PREVIEW_REQUIRED` 实现——必须走 `updateText()` 只改当前任务。
- 正文保存**不**回收图片；图片随任务保留到永久删除。
- 编辑器 JSON 的 codeBlock 用 **content 数组**形态承载文字（`{ type:'codeBlock', content:[{type:'text',text:'…'}] }`），**不是** `text:` 简写——tiptap 不认 `text:` 字段，会渲染成空。编解码器已兼容两种，但手工构造 JSON 时用 content 数组。
- 表格插件不能同时注册 `TableKit` 和 `AlignedTable`（会报 `Adding different instances of a keyed plugin (selectingCells$)`）；当前只注册 `AlignedTable + TableRow + TableCell + TableHeader`。
- `waitForRequest` 的响应对象没有 `postDataBuffer()`，要用 `(await resp).request().postDataBuffer()`；`waitForResponse` 的 `.json()` 只能读一次。
- 勾选正文列表（taskList）保存后规范化会去掉块尾 `\n`。
- 列表扩展只能注册一次。StarterKit 要关掉 `bulletList`、`orderedList`、`listItem`、`listKeymap`，任务列表用 `ListKit.configure({ taskItem: { nested: true } })`。两份列表插件的 `appendTransaction` 会抛 `Applying a mismatched transaction`，上传装饰插不进去。
- WebKit 画布不能编码 WebP 时，压缩库会交回 PNG 或一个读不完的 Blob。必须按魔数拒绝非 WebP，再改压 JPEG。Worker 压缩和读字节都要有超时，超时后走主线程。能编码 WebP 的浏览器仍上传 WebP。
- 触屏上 TaskItem 对 `mousedown` `preventDefault`，原生勾选框会亮，但 `change` 不发生。`TaskItemPointerSync` 在 `pointerup` / `click` 之后把 `input.checked` 写回节点，且只在和 `attrs.checked` 不一致时写，避免桌面鼠标点两次。
- 图片插入点若落在代码块内，要插到代码块之后；父节点不能容纳行内图片时外包一段落。否则 1200→800 重挂编辑器后，选区在 `<code>` 开头，正文会变成空围栏加粘在图片后面的代码。

## 六、不要做

- **不要**在未获用户授权时提交、推送或部署。本文记录历史交接边界，不替代用户后续授权。
- **不要**修改 MCP 连接。
- **不要**混入快照恢复（snapshot）功能或 `plan.md` 快照并入功能——已排除范围。
- **不要**提交 `.archify/`、`.ccb/`、`.nodeterm/` 工具目录；它们已由根目录 `.gitignore` 排除。项目级操作说明见 [AGENTS.md](../../AGENTS.md)。
- 不要为了过测试禁用 CSRF / 版本检查 / 关联变更确认。
