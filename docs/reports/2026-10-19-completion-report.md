# 任务完成报告（2026-10-19 起的一轮开发）

本报告汇总本轮合入 `main` 的全部工作：做了什么、用户能用到什么、关键设计和安全考虑、主要文件、测试，以及已知缺口和后续事项。
开发方式：每个需求在独立 worktree 和分支上实现并推到远端，最后由 Grok Build（`grok-4.7-build-fast`）在集成分支 `merge/main-integration` 上按顺序做真实的合并提交（不 squash、不 rebase），全部测试通过后普通 push 到 `main`。

资料来源：各分支的提交记录、`docs/i18n.md`，以及需求与方案笔记（skills / interactive-html-blocks / orchestrator 的方案文档）。文中数字均来自提交记录或本次在集成分支上实际运行的结果。

## 合并顺序

基线 `origin/main` = `196c062`。

| 顺序 | 分支 | 合并提交 |
|---|---|---|
| 1 | `feat/i18n`（含 README 刷新） | `776cb77` |
| 2 | `feat/assistant-skills` | `c9921dc` |
| 3 | `feat/interactive-html-blocks` | `98c8470` |
| 4 | `feat/orchestrator`（一期 + 二期） | `ff802eb` |
| 5 | `feat/orchestrator-assistant-tools` | `37b069a` |
| 6 | `feat/focus-page-zoom` | `ab8a92e` |
| 7 | `fix/materials-header-layout` | `0fe55f8` |
| 8 | `feat/mcp-task-attachments` | `15c54bc` |
| 9 | `fix/hide-subtasks-on-subtask` | `3fa17b1` |

合并后补充了两个提交：
- `d3ad419`：编排 E2E 配置固定为 `zh-CN`。i18n 合入后，Desktop Chrome 默认的英文环境会显示英文界面，而用例断言的是中文。
- `a725542`：`work-context.spec.ts` 的「工作」导航分组加上新入口「技能」和「Worktree 管理」，与 `more-page.spec.ts` 保持一致。

### 冲突处理原则

- 冲突一律取并集：既保留新功能，也保留 i18n 改造。
- 后合入分支里新写死的中文界面文案，在合并提交里一并改为 `t()`，同时补齐 `zh-CN` 和 `en` 两份词条；新的服务端用户可见消息补进 `server/src/i18n/locales/en.ts`。具体如下：
  - **技能包**：新增 `skills` 命名空间，`chat`、`settings`、`app` 词条也有补充；服务端技能相关报错补了英文；手机底栏白名单计数改为 19。
  - **交互式 HTML**：html 块界面和设置区块的文案迁入 `chat` 和 `settings`。
  - **编排**：新增 `orchestration` 命名空间；服务端新增 81 条英文消息。
  - **编排助手工具**：清理卡片使用 `t()`。
  - **专注页**：新增 `plan:focus.expand/shrink/collapse`。
  - **素材栏**：保留 `t()` 标签。
  - **MCP 附件**：`create-server.ts` 保留 `requestLocale`，二进制请求转发 `Accept-Language`；README 中英文两版都加了附件说明。
- 合并完成后：`npm run i18n:check` 覆盖 11 个命名空间，150 个源文件中没有残留的中文字面量，服务端 817 条消息都有英文翻译。

---

## 1. README 刷新与截图

**用户可见**
- README 重新组织为下载、架构、自托管、配置、目录结构几个部分。
- 截图用 mock 数据从当前界面重新截取，图片里的语言和正文语言一致：中文 README 配 `*-zh.png`，英文 README 配 `*-en.png`。

**主要文件**：`README.md`，`docs/readme/*.png`（任务列表浅色和深色、周计划、知识图谱深色，中英各一套）。

**提交**：`1aa1025`、`4ea6c4b`，英文版见第 2 节。

**已知缺口**：截图是静态的，以后界面改了需要重新截。

## 2. 国际化（i18n）与双语 README

**用户可见**
- 界面支持简体中文和英文：默认中文，浏览器语言是英文时自动显示英文。
- 设置里可以切换语言，选择保存在本机（localStorage `wwa.language`），`<html lang>` 跟随当前语言。
- 服务端的报错、校验提示、警告、活动和图谱标签按请求语言返回。语言的判断顺序是：`X-WWA-Language`，然后 `Accept-Language`，最后默认 `zh-CN`。
- MCP 支持语言：HTTP MCP 转发调用方的语言，stdio MCP 可以通过 `WWA_LANGUAGE` 设置。
- 界面为英文时，AI 助手用英文回复。
- 桌面端启动页和启动报错跟随系统语言。检测来源依次是：Windows 界面语言、macOS `AppleLanguages`、`LC_ALL`/`LC_MESSAGES`/`LANG`。
- 新增 `README.en.md`，配英文截图；中英两个 README 顶部可以互相切换。

**关键设计**
- 客户端使用 i18next + react-i18next。词条按命名空间放在 `client/src/i18n/locales/<lng>/<ns>.json`，打包时内置并同步初始化。
- 服务端源码里的消息仍保持中文，只在 HTTP 边界通过 `locales/en.ts` 映射成英文。这样存库数据、给模型看的工具结果和测试仍使用原文。
- 提示词不整段翻译，以免改变 AI 行为，只在英文界面下追加一句「请用英文回复」。协议中需要逐字匹配的字符串，以及 AI 后台生成的摘要和记忆，仍然保持中文，原因见 `docs/i18n.md`。
- CI 运行 `npm run i18n:check`，检查：
  - 各语言的键是否一致；
  - 英文值里有没有中文；
  - `client/src` 在词条文件之外有没有中文字面量；
  - 服务端消息的英文是否缺失、过期，占位符是否一致。

**主要文件**
- 客户端：`client/src/i18n/index.ts`、`client/src/i18n/locales/**`
- 服务端：`server/src/i18n/index.ts`、`server/src/i18n/locales/en.ts`
- 检查脚本：`scripts/i18n-check.mjs`、`scripts/server-messages.mjs`
- 桌面端：`desktop/src-tauri/src/i18n.rs`、`desktop/src-tauri/src/lib.rs`、`desktop/splash/index.html`
- 文档：`docs/i18n.md`、`README.en.md`、`.github/workflows/ci.yml`

**测试**
- 单元测试：`client/src/i18n/i18n.test.ts`、`server/src/i18n/i18n.test.ts`
- E2E：`e2e/language-switch.spec.ts`，覆盖语言切换和英文浏览器默认显示英文。
- 顺带修复：`ToolCallRow` 的 hooks 顺序崩溃；父任务重试按钮的无障碍名称。

**已知缺口和后续**
- 服务端约 704 条消息和桌面端启动报错的英文，是 Grok Build 批量起草的，通过了自动检查并做过抽查，**没有逐条人工审阅**。
- 提示词、协议字符串、AI 生成的摘要和记忆仍是中文，这是有意保留的。
- E2E 仍按中文界面断言（Playwright 固定 `locale: 'zh-CN'`）。

## 3. 四个小需求（todo）

### 3.1 专注页放大和缩小（`feat/focus-page-zoom`，`1a81ad8`）

**用户可见**
- 专注页的交互和 AI 助手一致，有两种形态：
  - 右侧栏面板，带「放大到独立页」「收起专注」；
  - 独立整页，带「缩小回原页面」，回到进入专注前的那个页面。
- 从侧栏、「更多」或手机底栏打开专注时，会记住来源页；直接访问 `#/focus` 不显示尺寸控制。
- 在桌面端，浮动计时条和任务里的「开始专注」改为打开侧栏面板，不离开当前页面。
- 专注和助手共用右侧栏，打开一个会关掉另一个。

**主要文件**：`client/src/App.tsx`、`client/src/components/focus/FocusPage.tsx`、`client/src/components/focus/FocusChip.tsx`、`client/src/lib/focus-presentation.ts`

**测试**：`client/src/lib/focus-presentation.test.ts`、`e2e/focus-presentation.spec.ts`，并调整了 `e2e/plan-focus.spec.ts`。

**待确认**：放大时是否要像助手那样保留任务详情，还需要用户确认。

### 3.2 MCP 读取任务图片和附件（`feat/mcp-task-attachments`，`3840b05`）

**用户可见**
- 外部 AI 通过 MCP 调用 `get_task` 时，会在原有 JSON 之后附上描述里引用的图片，作为 MCP image 内容返回。限制如下：
  - 最多 6 张；
  - 必要时缩到 2000px、1.5 MiB 以内；
  - 每次调用合计不超过 6 MiB；
  - 被跳过的图片会说明原因。
- 传 `includeImages:false` 可以保持旧输出。
- 新增两个工具：
  - `get_task_image`：读取单张描述图片。
  - `get_material_attachment`：读取素材文件。图片返回 image，文本返回 UTF-8 文本资源，PDF 等小体积二进制返回 base64 blob 资源。

**安全**
- 连接令牌通过新的受限路由 `GET /api/v1/tasks/:id/images/:imageId` 读取图片，可见范围与 `GET /api/v1/tasks/:id` 相同。
- 素材附件路由通过 `X-WWA-Mime-Type` 返回存储的 MIME 类型。

**主要文件**：`server/src/mcp/create-server.ts`、`server/src/mcp/media.ts`、`server/src/application/task-images.ts`、`server/src/application/workspace-api.ts`、`server/src/app.ts`

**测试**：`server/src/mcp.test.ts`、`server/src/mcp/media.test.ts`、`server/src/application/task-image-scope.test.ts`

### 3.3 素材栏标题布局（`fix/materials-header-layout`，`06696be`）

**用户可见**：素材栏标题行里的「上传」按钮文字垂直居中，和旁边的按钮等高。面板很窄时，两个按钮换到单独一行，不会把文字挤断。

**实现**：库里的按钮改为 inline-flex；label 形式的按钮补了键盘焦点环。

**主要文件**：`client/src/components/library/TaskMaterials.tsx`、`client/src/components/library/library.css`

**测试**：没有新增专门的测试，靠现有 E2E 回归。已知 `task-materials:31` 在 main 上本来就失败。

### 3.4 子任务不再显示子任务设置（`fix/hide-subtasks-on-subtask`，`c16f37a`）

**用户可见**
- 系统只支持一级子任务。在子任务上，下面这些入口不再提供「添加子任务」：
  - 详情面板；
  - 任务菜单，包括下拉菜单和右键菜单；
  - 子任务对话框。
- 根任务的行为不变。
- 已经带有子项的旧数据子任务，拖动时只在同级之间排序。

**实现**：新增 `canHaveSubtasks(task)`，与服务端的 `INVALID_PARENT` 规则一致，服务端校验未改。

**主要文件**：`client/src/lib/todo.ts`、`client/src/components/tasks/TaskSubtasks.tsx`、`client/src/components/tasks/TaskActionsMenu.tsx`、`client/src/components/tasks/TaskList.tsx`、`client/src/components/tasks/task-order.ts`

**测试**：`client/src/lib/todo.test.ts`、`client/src/components/tasks/task-order.test.ts`、`e2e/task-parent-navigation.spec.ts`

## 4. AI 助手技能包（Skills，`feat/assistant-skills`）

**用户可见**
- 新页面 `#/skills`：
  - 列表、搜索；
  - 新建、导入 `SKILL.md`；
  - 编辑，带预览，版本冲突时会提示；
  - 启用和停用；
  - 删除后可以恢复；
  - 版本历史，可以对比和回滚。
- 设置页和「更多」页都有入口。
- 聊天里：
  - AI 加载技能时，单独显示一行「使用技能：名称 vN」，展开后是当次加载的正文。旧对话里看到的仍是当时的版本。
  - AI 提议新建或修改技能时，会出一张确认卡片，带字段和逐行对比，可以「在编辑器中修改」或「确认保存」。
- 聊天菜单新增「存为技能」：模型起草后打开编辑器，用户保存前不写入任何内容。

**关键设计和安全**
- 数据模型是 `Skill` + `SkillVersion`，迁移为 `20261019030000_skills`。
  - 名称唯一靠手写 SQL 的部分唯一索引，只约束未删除的技能。
  - 写入统一经过 `persistSkill`，更新时用 `expectedRevision` 做乐观锁。
- 按需加载：每次 run 在第一次调用模型之前冻结技能目录。只有目录非空时才注册 `load_skill`，所以没有技能时行为基本不变。
- `skill.create` 和 `skill.update` 走 `propose_changes` 的确认流程，每个提议只含一个操作。
  - `skill.*` 不在外部工具列表里；外部连接调用会在 owner 检查之前就被拒绝，返回 `CAPABILITY_UNAVAILABLE`。
  - REST 接口 `/api/skills` 只有本人可用，不挂在 `/api/v1` 下。
- 在编辑器里保存待确认的提议：
  - 在同一个事务里写入正文，并把审批关闭为 rejected，outcome 为 `SAVED_IN_EDITOR`。
  - 审批已经处理过、或者哈希对不上时，返回 409，不写任何内容。
- 导入 `SKILL.md`：只支持常见的 YAML 写法，不执行任何内容。

**主要文件**
- 服务端：`server/src/application/skills.ts`、`server/src/agent/builtin-tools.ts`、`server/src/agent/assemble.ts`、`server/src/agent/propose.ts`
- 客户端：`client/src/components/skills/*`（`SkillsPage`、`SkillEditor`、`SkillHistory`、`SkillProposalCard`）

**测试**
- 单元测试：`server/src/application/skills.test.ts`、`server/src/application/skills-api.test.ts`、`server/src/agent-skill-loading.test.ts`、`server/src/agent-skill-proposals.test.ts`、`client/src/components/skills/skill-format.test.ts`
- E2E：`e2e/assistant-skills.spec.ts`

**已知缺口和后续**
- 技能多到几十条时，系统提示词会明显变长，目前没有设目录上限。
- 一次 run 中途启用或停用技能不生效，下一条消息才生效。
- 以后如果用 `prisma migrate dev` 自动生成迁移，要注意它可能想删掉手写的部分唯一索引。

## 5. 交互式 HTML 小页面（`feat/interactive-html-blocks`）

**用户可见**
- AI 回复里可以放一个可交互的 HTML 小页面，比如一组选项按钮。用户点进页面后，可以把内容填进助手输入框，但**不会自动发送**。
- 小页面支持：主题变量、自动高度、懒加载、全屏、导出 `.html`。
- 设置里可以关掉这个功能，也可以编辑允许加载脚本的 CDN 白名单，默认开启，白名单为 jsDelivr、cdnjs、unpkg。

**关键设计和安全**
- `present_reply` 新增 html 块，服务端按策略校验：功能开关、大小上限，脚本只能是白名单 CDN 上固定版本的文件。
- iframe 只给 `sandbox="allow-scripts"`，内容通过 `srcdoc` 载入，同时用 meta CSP 和 iframe `csp` 属性两层限制：除白名单里的脚本、样式和字体地址外，所有网络访问都被拦截，也不能访问 Cookie、存储或父页面。
- 页面一旦自行跳转，iframe 就被销毁，显示「已停止运行」。
- 唯一的桥接能力是 `wwa.fillInput`，而且只在用户聚焦过这个 iframe 之后才生效。只有助手面板提供这个能力。
- 设置接口为 `GET/PATCH /api/settings/html-blocks`，白名单只接受裸 https origin（或本地 http origin），会规范化并去重。

**主要文件**
- 客户端：`client/src/components/chat/HtmlBlock.tsx`、`client/src/lib/html-sandbox.ts`、`client/src/components/chat/assistant-input.tsx`、`client/src/components/settings/HtmlBlockSettings.tsx`
- 服务端：`server/src/agent/html-block.ts`、`server/src/application/html-block-settings.ts`
- 迁移：`20261019040000_html_blocks`

**测试**
- 单元测试：`client/src/html-sandbox.test.ts`、`server/src/agent/html-block.test.ts`、`server/src/html-block-settings.test.ts`
- E2E：`e2e/assistant-html-blocks.spec.ts`。用例探测了 fetch、XHR、WebSocket、图片、sendBeacon、父窗口访问、存储、Cookie、`window.open`、`eval`，以及运行时插入的非白名单脚本，mock 服务器记录到的泄漏为 0。

**已知缺口**
- 页面自行跳转时，在被拦下之前，目标请求仍会发出一次。
- 移动端和 WebKit 的 E2E 没有跑。

## 6. 主控编排一期（`feat/orchestrator`）

**前提**：WWA 服务端可能运行在远端服务器上，而代码在用户本机。所以服务端和主控 AI **不执行任何命令，不碰本地文件和 git**。

**分工**
- 主控 AI 只负责拆计划、派任务、审阅汇报。
- 新增本机执行端 `wwa-node`，主动向服务器拉取任务。它只做确定性的机械操作：探测仓库、按指定 ref 建 worktree、只读采集 git 事实，以及在用户点击后 push。
- 写代码、提交、合并、解冲突、跑测试、调查项目，都由执行端在本机启动 Codex 或 Claude 完成。

**用户可见**
- 设置页：
  - 「本机执行端」：新建时给出一次性令牌和启动命令。
  - 「项目」：添加本机位置，由执行端校验路径。
- 任务详情里有「开始运行」和编排面板，可以看计划、授权、进度，并执行暂停、继续、取消、重试、跳过、重派等操作。
- 流程：
  1. 子任务并行开发；
  2. 串行合入集成分支；
  3. 每次合入后，另开一个只读的新 AI 会话独立核对；
  4. 主控做最终判断，进入「待验收」（编排上的徽标，不新增任务状态）；
  5. 用户点「验收通过」，再点「推送集成分支」，才会 push。

**关键设计和安全**
- 执行端令牌只显示一次，服务端只存哈希，可以吊销。执行端路由使用 `Authorization: Node <token>`，挂在 `identityMiddleware` 之前，照样做 Host/Origin 校验。
- `allowedRoots` 只能在本机配置（`~/.wwa-node/config.json`，权限 0600）。服务端下发的路径必须落在 allowedRoots 之内，比较前先取 realpath。
- 核对 develop 结果：
  - 硬规则：有新提交、工作区干净、分支名对得上、hooks 没有变化、`checks` 全部通过。
  - 配了模型时，主控模型再审阅一次。
- 核对 merge 结果：执行端采集的事实（HEAD、祖先关系、冲突标记）要和独立核对运行的结果一致，模型不能推翻失败的比对。
- 幂等：
  - 任务用 `dispatchKey` 唯一索引，同一个键只建一个任务。
  - 租约通过比较并设置下发，回报必须带 `leaseToken`。重复回报内容相同按重放处理，内容不同返回 409。
- 离线：租约 15 分钟，过期后编排暂停 `node_offline`，**不改派**给别的机器；执行端迟到的回报会被接受。
- Codex 的 git 写权限：用自定义权限档，显式写入 `gitDir` 和 `commonDir`。被拒绝时暂停 `git_write_denied`。
- 迁移：`20261020000000_orchestration`

**主要文件**
- 服务端：`server/src/application/orchestration/*`（`service`、`planner`、`checks`、`nodes`、`projects`、`prompts`、`events`）、`server/src/routes/orchestration.ts`、`server/src/node-agent/*`
- 客户端：`client/src/components/orchestration/OrchestrationPanel.tsx`、`client/src/components/orchestration/OrchestrationSettings.tsx`

**测试**：`server/src/orchestration.test.ts`、`server/src/orchestration-units.test.ts`。使用桩 CLI `server/test/stub-orchestration-cli.mjs`，并在真 git 临时仓库上测试执行端。

## 7. 主控编排二期（`feat/orchestrator`）

**用户可见**
- **Worktree 管理页** `#/worktrees`，入口在侧栏和「更多」页，手机底栏不提供：
  - 数据来自执行端盘点，包括分支、HEAD、脏文件数、大小、是否损坏、剩余磁盘空间。
  - 删除前必须在确认卡片上点确认。有未提交修改、或者正被编排使用的会被拦下。
- **系统通知**：编排暂停或进入待验收时发通知。桌面端使用 Tauri 通知，浏览器只在页面没有焦点时通知。每台设备可以单独关闭。
- **可选的 PR**：push 之后，执行端先 `gh pr view`，没有 PR 再 `gh pr create`，面板显示 PR 链接。
- **跨机并行**：一轮编排可以多选最多 3 个额外位置，代码经 origin 中转。所有位置的 origin URL 必须相同，额外执行端的协议版本必须不低于 2。
- **桌面端一键配对**：自动启动并守护本机执行端，配对时选目录作为 allowedRoots。

**关键设计和安全**
- 执行端协议升到 v2，新增 `inventory`、`cleanup`、`pull_request` 任务。`run` 增加 `fetch`（核对 sha，不一致报 `FETCH_MISMATCH`）和 `publish`。
- 删除确认卡片存在新表 `WorktreeCleanup`，10 分钟过期；确认时会重新检查占用。执行端只接受数据目录下的路径，不加 `--force`。
- 删除分支用 `git branch -d`。如果 git 认为分支已经合进它的上游，也会一起删掉；远端分支不受影响。
- 跨机运行时，子任务分支和集成分支会出现在 origin 上；单机运行不会自动 push。
- 迁移：`20261021000000_orchestration_phase2`

**主要文件**
- 服务端：`server/src/application/orchestration/worktrees.ts`、`server/src/node-agent/*`
- 客户端：`client/src/components/orchestration/WorktreesPage.tsx`、`client/src/lib/desktop-shell.ts`
- 桌面端：`desktop/src-tauri/src/lib.rs`、`desktop/src-tauri/Cargo.toml`

**测试**
- 单元测试：`server/src/orchestration-phase2.test.ts`、`client/src/lib/desktop-shell.test.ts`
- E2E：`e2e/orchestration.e2e.ts`，用 `npm run e2e:orchestration` 运行。使用独立端口和独立数据库，跑真执行端进程、桩 Codex 和假 gh，覆盖配对、运行、通知、验收、push、PR，以及确认删除 worktree。

**未做**：接入 `#/runs` 和 Handoff 记录；push 后通过 GitHub API 比对远端 SHA；运行快照的删除；手机底栏入口。

## 8. 助手编排工具（`feat/orchestrator-assistant-tools`）

这个分支依赖技能包的 `builtinToolDefinitions(opts)`，所以先合入了技能包，再在它上面开发（`031e743`）。

**用户可见**
- 可以在 AI 助手里查询编排进度、执行端和 worktree。
- 助手可以提议清理 worktree，但只会在聊天里生成一张确认卡片，用户点「确认删除」后才真正执行。同一张卡片也会出现在 `#/worktrees` 页。

**关键设计和安全**
- `orchestration_read` 是只读工具，有五个动作：attention、list、get、nodes、worktrees。它不派发任何任务，也不能刷新盘点，回答时要注明上报时间。
- `propose_worktree_cleanup` 调用 `WorktreeService.previewCleanup(raw, 'assistant')`，只生成状态为 pending 的卡片。
- 系统提示词明确规定：删除只能生成确认卡片，不得说已经删除。

**测试**：`server/src/agent-orchestration-tools.test.ts`，以及 `e2e/orchestration.e2e.ts` 中「助手只能提议删除，用户在聊天卡片里确认」的用例。

---

## 9. 本次集成验证（Node 22.13.0）

- `prisma generate`、`prisma validate` 通过。迁移链按时间排列：`…20261019020000_topic_color` → `20261019030000_skills` → `20261019040000_html_blocks` → `20261020000000_orchestration` → `20261021000000_orchestration_phase2`。`prisma migrate diff` 对比全部迁移和 schema，结果与合并前 `origin/main` 的基线完全相同，只有原有的索引重定义，新迁移没有引入新的漂移。
- `npm test`：服务端 71 个文件、520 个测试全部通过；客户端 33 个文件、185 个测试全部通过。
- `npm run build` 通过。
- `npm run i18n:check` 通过：11 个命名空间，150 个源文件干净，服务端 817 条消息有英文翻译。
- `npm run e2e:orchestration`：3 个用例全部通过。
- Desktop Chrome E2E（`playwright test --project=chromium`）：241 个通过、3 个跳过、13 个失败。
  - 其中 12 个是 main 上原本就失败的用例（见第 10 节）。
  - 另 1 个是 `work-context:76`，原因是新增了导航入口，已经修正；修正后重跑 `work-context` 和 `more-page`，12 个全部通过。
  - 手机和 WebKit 项目没有跑。
- `cargo test`（`desktop/src-tauri`，stable Rust）：13 个测试通过。由于 `../resources/` 是打包产物，测试时用 `TAURI_CONFIG='{"bundle":{"resources":null}}'` 跳过了资源检查。

## 10. 已知缺口与后续事项

1. **真实的 Codex 和 gh 还没跑过**：编排的单测和 E2E 用的都是桩 Codex/Claude CLI 和假 gh。上线前需要人工验证一次：用真 Codex 建 worktree、提交、`git log` 确认，再用真 gh 开一次 PR。
2. **桌面端没有手工测试**：执行端配对和守护、系统通知、启动报错的英文，都没有在真实桌面上点过。
3. **机器起草的英文没有完整审阅**：服务端消息、桌面端启动报错，以及部分界面文案的英文由 Grok Build 起草，通过了自动检查，但没有逐条人工审过。
4. **main 上原本就失败的 E2E**：以下用例在合并前的 `main` 上就失败，本次没有修复：
   - `app.spec` ×4
   - `assistant-errors` ×2
   - `mobile-navigation` 键盘排序
   - `plan-focus` :97、:110
   - `task-materials` :31
   - `todo` :52、:660
   - 手机端 `todo` :134
5. 交互式 HTML：自行跳转时仍会发出一次请求；移动端和 WebKit 的 E2E 没跑。
6. 编排未做：接入 `#/runs` 和 Handoff、GitHub API 远端比对、快照删除、手机底栏入口。
7. 技能包：目录没有上限；如果用 `prisma migrate dev` 生成迁移，要注意它可能删掉部分唯一索引。
8. 专注页：放大时是否保留任务详情，还需要和用户确认。
