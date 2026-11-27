# Harness 会话入口与续聊原型

日期：2026-11-27  
范围：仅信息架构与离线交互原型。不修改正式应用、路由、权限、后端或真实会话；原型全部使用虚构数据。

## 源码核实

- 桌面侧栏和移动「更多」共用导航分组，`runs` 位于「AI 协作」：`client/src/lib/navigation-items.ts:29`、`client/src/lib/navigation-items.ts:47`。
- 当前「AI 执行」默认显示编排轮次，「会话」是第四个页签：`client/src/components/workspace/HandoffPanel.tsx:64-88`。
- 会话列表已经具备 Harness、项目/目录、电脑、在线状态、最近更新、归档和双栏布局：`client/src/components/workspace/HarnessSessions.tsx:210-280`、`client/src/components/workspace/HarnessSessions.tsx:486-563`、`client/src/components/workspace/harness-sessions.css:28-33`。
- 新建已有 Harness + 项目/电脑确认：`client/src/components/workspace/HarnessStartDialog.tsx:27-67`。发送、运行中追加/排队、审批和设置按 Harness 能力分别处理：`client/src/components/workspace/HarnessSessions.tsx:847-852`、`client/src/components/workspace/HarnessSessions.tsx:977-1010`。
- 「AI 连接」是 MCP 配置与授权，不是 Harness 会话入口；固定的「AI 助手」是内置工作助手，也不与 Harness 会话混用。

### 当前入口步骤

- 桌面：侧栏展开「AI 协作」（未展开时多一步）→「AI 执行」→「会话」→ 选择会话。已连接会话从主导航通常需要 3 次点击才进入对话。
- 手机：底部「更多」→ 找到「AI 协作」→「AI 执行」→「会话」→ 选择会话，且协作分组不一定在首屏。
- 深链 `runs?tab=sessions&sessionId=…` 已能直接打开会话，应继续保留。

## 推荐方向

只做一个方向：**把「Harness 会话」提升为「AI 协作」下的直接入口，并提供「继续最近会话」快捷动作。**

- 桌面：在「AI 协作」分组中新增「Harness 会话」，置于「AI 执行」之前；点击直接呈现现有会话列表。列表顶部保留一张「继续最近会话」卡片，桌面 ≥740px 延续左列表、右对话分屏。
- 手机 390px：「更多」首屏在 AI 助手之后放两个明显动作：主按钮「Harness 会话」，次按钮「继续最近：核对移动端续聊入口」。AI 协作分组内仍保留同一主入口，避免只在首页可找到。
- 「AI 执行」保留编排轮次、接力、统计；原「会话」页签和旧深链暂时保留为兼容入口，后续再决定是否隐藏页签，不做破坏性跳转。
- 「AI 连接」继续负责配置/授权； Harness 不可用时应指向已配对电脑与 Harness 可用性，不能误导用户去新建 MCP 连接。
- 最近会话按所有 Harness 的 `updatedAt` 取一条，显示 Harness、项目、电脑和状态。失效时仍打开该条历史并说明原因，不静默改开别的会话。

## 列表与对话

列表优先展示「最近更新」，可切换「按项目」；支持按 Harness 和项目筛选。每行包含：

- 会话标题、Harness；
- 项目名与目录（同名项目必须显示目录）；
- 执行电脑与在线/可用性；
- 运行中、待确认、只读、离线或无法续聊状态；
- 最近更新时间，保留归档与已有最近会话。

「继续」与「新开」明确分开：点击既有行只打开同一 `sessionId` 的历史；「新建会话」先确认 Harness、项目/目录和电脑，再进入空对话，由用户主动发送。新建不改变权限，也不自动发消息。

能力边界：只消费 Dovun 现有会话 API 已返回且可管理的记录，不新增“导入任意终端历史”入口。现有 Codex 原生历史发现仍受原项目、电脑和执行器能力条件约束，本方案不扩大它。编排结果、接力记录与实时 Harness 工具授权也不混作同一状态。

## 真实状态与可用动作

| 状态 | 仍可做什么 | 不能/不应做什么 |
| --- | --- | --- |
| 尚未配对或 Harness 不可用 | 查看已有记录、可用电脑与项目；了解启用条件 | 不显示可发送的假输入框；不引导到无关的 AI 连接 |
| 在线、只读权限 | 查看历史、发送消息、让 Harness 读取项目 | 不暗示可写文件；不自动扩大权限 |
| 电脑离线、只读 | 查看已缓存历史、复制内容、辨认原会话 | 禁止发送、审批和改权限；标明缓存可能不完整 |
| 运行中 | 打开同一历史，按当前 Harness 显示“追加到当前轮”或“排到下一轮” | 不假设所有引擎都能打断、追加或排队，不重复启动 |
| 待确认 | 查看原生请求与其实际支持的审批选项 | 不把编排“已验收”当作实时工具授权 |
| 启动失败/暂不可用 | 查看可取回的历史和错误；主动选择新建 | 不假装能够续聊，不自动重试或启动远程进程 |

## 两条验收路径

### 回访 / Android 续聊

1. 从 390px「更多」首页，一眼看到并点击「Harness 会话」（1 次到列表）。
2. 按 `Codex · Dovun · 设计 Mac` 找到「核对移动端续聊入口」（第 2 次到实际对话）。
3. 核对同一条历史中的“移动端历史锚点”消息；也可从首页「继续最近」1 次直达。
4. 打开「检查离线缓存说明」，确认离线只读样例仍允许查看/复制缓存历史，但发送、审批和权限修改不可用。

### 首次使用 / 新开

1. 「Harness 会话」→「新建会话」。
2. 选择 Codex 与 `Dovun / 设计 Mac / ~/WorkSpace/Dovun`，在确认区再次核对；权限保持原设置。
3. 点击「确认并打开会话」，输入内容后主动点「模拟发送」。
4. 只看到原型模拟回复；没有网络、模型调用、进程启动、自动发送或权限变化。

## 待用户决策的取舍

- 是否在侧栏新增一个独立项（推荐），还是把「AI 执行」改名并拆成两个入口；前者兼容成本较低，但侧栏多一项。
- 手机首屏是否同时放「Harness 会话」和最近会话（推荐），还是只放主入口；前者回访更快，但会占用一张卡片高度。
- 最近会话是否跨 Harness（推荐）；若只按当前 Harness，筛选语义更单纯，但入口需要额外记忆上次选择。
- 兼容期后是否移除「AI 执行」里的「会话」页签；建议先保留深链与页签，再依据使用数据决定。

## 后续正式实施涉及文件

仅在方案验收后实施：`client/src/lib/navigation-items.ts`、`client/src/components/layout/Sidebar.tsx`、`client/src/components/layout/MorePage.tsx`、`client/src/components/workspace/HandoffPanel.tsx`、`client/src/components/workspace/HarnessSessions.tsx`、`client/src/components/workspace/harness-sessions.css`、对应 `client/src/i18n/locales/*/app.json` 与 `workspace.json`。如需独立路由别名，再最小化调整 `client/src/App.tsx` / `useHashRoute`，并保留旧链接测试。

原型：`demos/harness-sessions-entry.html`。
