# 手机遥控编程 Agent:竞品架构调研与 Dovun 能力盘点

- 初稿 2026-11-20（竞品 star 数为当日快照）
- 2026-11-21 更新 ZCode 源码对照、Dovun 首版三端方案、实施顺序与验收项。[Dovun 0.6.5 首版实现方案](dovun-mobile-harness-implementation.md)
- 问题:很多编程工具(Claude Code / Codex / ZCode 等)已有手机端遥控方案。是否存在聚合性开源软件做这件事?其架构(连接方式)有何差异?Dovun 现状离这个能力有多远?
- 结论速览:
  1. 赛道已收敛为「本地权威 + 手机 companion」,开源成熟方案有 T3 Code / Paseo / Happy / HAPI / Vibex 等,连接拓扑分五层信任光谱(局域网直连 > 打洞 P2P > 零知识中继 > 隧道 > 云平台)。
  2. 设计判断:**中继方案体验最优**(可达性恒定 + 零知识 + 手机端零额外安装)。
  3. Dovun 已能从云端向已配对的电脑派发编排任务。首版复用 `wwa-node` 的出站链路，由电脑持有 Codex 会话、服务器转发、手机使用同一 Dovun 网页接续。交互适配、会话绑定、断线恢复和电脑端命令去重是这次要补的能力。

---

## 一、竞品总览(2026-11-20 抓取)

| 项目 | ★ | 许可证 | 创建 | 移动端 | 支持的 Agent |
|---|---|---|---|---|---|
| [T3 Code](https://github.com/pingdotgg/t3code) | 66.4k | MIT | 2026-02 | iOS/Android(T3 Connect)+ desktop/web | Claude Code、Codex、Cursor CLI、OpenCode 等 |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 28.8k | Apache-2.0 | 2025-06 | 手机浏览器 | Claude Code、Codex、Copilot 等;**已宣布 sunsetting** |
| [Happy](https://github.com/slopus/happy) | 24.7k | MIT | 2025-07 | iOS/Android 原生(App Store 4.9) | Claude、Codex、Grok |
| [Paseo](https://github.com/getpaseo/paseo) | 24.5k | Apache-2.0 | 2025-10 | iOS/Android + desktop/web/CLI | 30+ agent(adapter) |
| [HAPI](https://github.com/tiann/hapi) | 5.4k | AGPL-3.0 | 2025-12 | Web/PWA 免费;商店原生版收费;Telegram Mini | Claude Code、Codex、Cursor Agent、Grok Build、OpenCode、Kimi、Copilot、Antigravity、Pi、DeepSeek Harness |
| [Omnara](https://github.com/omnara-ai/omnara) | 3.4k | Apache-2.0 | 2025-07 | README 已无移动 App(转型 managed-agent 平台) | 任意模型端点 + MCP |
| [Vibex](https://github.com/vibex-ai/vibex) | 285 | AGPL-3.0 | 2026-07 | Android APK + 未签名 IPA(GitHub Releases) | 预设:Claude Code、Codex、**ZCode**、OpenCode;ACP 目录:Kimi Code、DeepSeek Harness、Grok、Pi 等 |

补充:HAPI 是 Happy 的中文本地化分支(作者 tiann/weishu,KernelSU 作者);Vibe Kanban 正在 sunsetting,不建议再选型。

## 二、架构三个正交维度

### ① 数据面:怎么接管 agent

- **PTY/CLI 包装**(最低公分母):把官方 CLI 包进终端,遥控 ≈ 代替敲键盘 + 解析输出。采用者:Happy、HAPI、Paseo、T3 Code。
- **协议级接管**(更深):HAPI × Codex 与官方终端 UI 共享同一 app-server 进程(0.154.0+,所有权规则复杂,cold resume 只认根线程);Vibex / T3 Code 支持 **ACP**(Agent Client Protocol),一份协议接入十几个 agent。
- **平台 SDK 接入**:Omnara(agent 经 SDK 上报状态到后端)。

### ② 控制面:连接拓扑(信任光谱)

| 层级 | 路径 | 中间方 | 谁能看内容 | 稳定性 |
|---|---|---|---|---|
| 1 局域网直连 | 手机 → 电脑(同网) | 无 | 只有你 | **恒定,唯一承诺不降级的真直连** |
| 2 打洞 P2P | UDP 打洞(如 Tailscale) | 打洞成功时无;失败静默退 DERP 零知识中继 | 只有你(WireGuard) | **概率性**(对称 NAT / CGNAT / 封 UDP 会败) |
| 2′ 公网 IP | 手机 → 公网地址 → VPS | 无 | 只有你(TLS) | 恒定;机器暴露公网 |
| 3 中继 | 经专用中继(产品托管或自托管) | 有,**零知识**(E2E 密钥在两端) | 只有你 | 恒定 |
| 4 隧道 | Cloudflare Tunnel / ngrok | 有,边缘终止 TLS | 服务商理论可见 | 恒定;出站 443 必达 |
| 5 云平台 | agent → 云 ← 手机 | 平台即状态权威 | 平台可见(自托管除外) | 恒定;电脑关机状态仍在 |

- **打洞 vs 隧道**:打洞甩开中间人(信任/延迟最优)但概率性、要求两端装软件;隧道确定性最强、手机零安装,代价是明文过第三方。
- **中继 vs 隧道**:机制同形(外联长连接 + 公网端点转发),分野在「中间方看到什么」(密文 vs 明文)与「中间方还干什么」(配对路由/推送/会话管理长在中继上 vs 裸管道)。
- **中继体验最优的理由**:同时拿到两边的优点——信任上零知识(等同打洞),可达性上恒定(等同隧道),手机端不用装额外网络软件。
- **产品实践是多路由回退链**:T3(LAN → Tailscale → SSH → T3 Connect,每分钟重查)、Vibex(Direct/Tailnet/relay 三选)、Paseo(直连或 E2E relay)。

### ③ 信任模型与配对

| | 状态权威 | 配对 | 权限边界 |
|---|---|---|---|
| Vibex | 桌面 DesktopRuntime | 实例配对 | 手机**永不**启动本地 agent、不拥有文件系统、不改 git、不当第二个 PTY 权威 |
| Happy | 本地 CLI | 手机与终端各自生成密钥 + QR 配对(TweetNaCl),中继零知识 | 推送经 APNs/FCM(happy-push-server,Cloudflare Worker) |
| HAPI | 终端拥有生命周期 | URL + 2 个 QR 码 | 文件浏览 opt-in(`hapi runner start --workspace-root`) |
| T3 Code | 一个 server,所有 client 同一 threads | 一次性配对 URL/QR;审批码 10 分钟过期;scoped token;30 天不用须重配 | 权限粒度最细(`terminal:operate` 单独授权) |
| Paseo | daemon | Settings → Pair Device;Docker 模式密码 | 插件可代答权限 |
| Vibe Kanban | web 后端 | **无用户登录**,仅 origin 检查 | 最弱(已 sunsetting) |
| Omnara | 后端数据库(durable state) | 账号 + RBAC | auto-run/ask/block 平台级 |

### 官方第一方(只管自家)

- Anthropic:Claude app 作为 Claude Code 云会话客户端(2025-10 起),另有 Remote Control 用手机接管本地会话。
- OpenAI:Codex 内置于 ChatGPT app。

### ZCode 的同会话接管

ZCode v3.18.2 的手机网页经云 Relay 连到桌面已有的 Host，共享同一个 `zcode-cli` 会话。手机重连时按日志代次和序号补收增量，补不齐时由 CLI 返回当前快照。输入、停止和权限回复带稳定命令 ID，由 CLI 串行受理并去重。开源仓库提供手机 Web、桌面桥接、CLI 协议和测试用 Relay。生产 Relay 是外部依赖。[官方架构](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/docs/web-remote-control/web-remote-control-architecture.md#L5-L43) · [Relay 测试契约](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/docs/web-remote-control/relay-v2-pairing.md#L67-L83)

## 三、Dovun 能力盘点(逐项核实代码)

**已有:**

1. **两种工作区形态**。桌面模式由 Tauri 启动本机服务，服务器模式通过 ownerKey 登录并使用 session cookie 和 CSRF。手机浏览器可使用云端工作区的运行、编排和待确认页面。
2. **远程编排与本机接力**。云端编排通过 `/api/v1/node/lease` 向已配对的 `wwa-node` 派发任务，执行器上报进度和结果。本机接力由处理 `/api/v1/handoffs/:id/start` 请求的机器启动 CLI，已有领取、启动、续跑、取消、结果回传和验收流程。另有 Worktree 管理（大小、干净度、关联编排、删除确认）及运行统计（轮次、通过率、token、费用）。[执行器](../server/src/node-agent/agent.ts) · [接力接口](../server/src/routes/handoffs.ts)
3. **审批原语**:`ApprovalService` + `propose_changes` → 待确认页,用户审核后才执行。
4. **Web Push 基础设施**:VAPID 自动生成并持久化(`push-subscriptions.ts`)、订阅 fan-out、失效清理(404/410);payload 已支持 `{title, body, url, tag}`(深链 + 合并现成);客户端 `push.ts` 已处理 iOS 须加主屏幕的限制;manifest.webmanifest / apple-touch-icon 齐。
5. **设备配对与同步**:`pairSyncDevice`(Bearer token)+ op-log push/pull + workspace identity + 副本冲突解决。
6. **桌面工作区请求转发**。桌面绑定云端后，`workspace-relay.ts` 将白名单内的工作区请求转到云端，提供写前同步、版本重映射、离线缓存和 SSE 透传。`acceptReplicaRelay` 在校验同步设备后，为白名单内的请求授予 owner 权限。[工作区转发](../server/src/application/workspace-relay.ts)
7. **手机 UI**:无底部栏,左下按钮或任意位置右滑开抽屉(0.6.1);触屏格式条;offline-runtime + serviceWorker。

**现有缺口和约束**

- **批处理执行器**。现有 worker 写入一次 prompt 后关闭 stdin，适配器标记 `interactiveInput: false`，因此同会话追加输入和原生权限回复需要新的交互适配。[现有 worker](../server/src/runner/worker.ts) · [CLI 适配](../server/src/runner/adapters.ts)
- **推送覆盖面**:`sendPushToAll` 唯一业务调用点是 `reminders.ts:95`(任务提醒);run 完成、新待确认方案均不推送。
- **桌面入口**。桌面模式默认监听 `127.0.0.1`，工作区认证还要求 loopback Host。首版网页入口使用云端 HTTPS。[服务监听](../server/src/index.ts) · [工作区认证](../server/src/application/security.ts)

## 四、Dovun 首版三端方案

### 三端分工

首版覆盖一台已配对的电脑和一条由 Dovun 启动的 Codex 会话。用户在电脑或手机上打开同一个 Dovun 网页，电脑上的执行器持有会话。接入电脑终端里独立启动的会话需要单独验证 harness 的挂接能力。

| 位置 | 复用和新增 |
|---|---|
| 电脑控制端 | 复用 `wwa-node` 的设备身份、CLI 查找和本机允许目录。新增交互适配器，经本机 `stdio` 连接常驻的 `codex app-server`。现有批处理 worker 继续处理编排任务。[CLI 查找](../server/src/node-agent/cli.ts) · [本机目录校验](../server/src/node-agent/git.ts) |
| 服务器中继 | 复用执行器主动访问的 `/lease`、节点鉴权和默认 3 秒轮询。沿用 `accepts` 协商方式，服务端先声明支持，执行器收到后再声明自身支持，然后开始投递会话指令。会话指令独立于批处理槽位，电脑通过单独接口回传操作回执和事件。服务器保存会话索引、投递记录和短期事件缓存，通过 SSE 将事件转发给网页。首版走现有 HTTPS 服务，服务器可读取转发内容。[执行器轮询](../server/src/node-agent/agent.ts) · [节点领任务](../server/src/application/orchestration/nodes.ts) |
| 电脑及手机网页 | 复用云端登录、电脑列表和「运行」页。两端进入同一个会话页，可查看历史与实时输出、发送消息、打断当前轮、回应 Codex 的原生权限请求。[运行页](../client/src/components/workspace/HandoffPanel.tsx) |

### 接续同一条会话

创建时由 Dovun 分配 `sessionId`，电脑启动 Codex 线程后登记 `sessionId → 电脑 ID + Codex threadId + 项目`。两端打开同一个 `sessionId`，所有操作按绑定送回原电脑，历史和运行状态以本机 Codex 会话为准。

- 会话空闲时用原 `threadId` 开启下一轮。会话正在运行时，追加输入或打断均带上页面看到的 `turnId`。目标轮已结束时刷新状态，由用户决定是否把这句话作为下一轮发送。
- 权限回复带原请求 ID，由电脑确认请求仍待处理后交给 Codex。两个页面看到同一处理结果。[Codex App Server 协议](https://developers.openai.com/codex/app-server/)

### 断线恢复

每个会话事件带日志代次 `epoch` 和代次内递增的 `seq`。页面刷新、回到前台或 SSE 中断后，用最后应用的 `(epoch, seq)` 重新订阅。

| 情况 | 恢复动作 |
|---|---|
| 同代次，缓存足够 | 连续补发缺少的增量，再接实时事件。页面丢弃重复和迟到的事件。 |
| 代次变化，或增量缺失 | 取电脑生成的当前快照，包含最近消息、当前轮次、待确认请求和快照的 `(epoch, seq)`。页面以快照对齐状态，再从该序号接收同代次后续事件。 |
| 电脑暂时离线 | 页面显示最后已知状态，输入留作草稿。电脑重新连接后恢复当前会话，再由用户发送草稿。 |
| 本地会话进程已退出 | 用原 `threadId` 恢复已保存的会话。退出前仍在运行的轮次，根据 Codex 回读结果显示已完成、中断或待核实，由用户决定如何继续。 |

恢复策略参考 [ZCode 的增量重放和快照回退](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts#L674-L726)。

### 命令回执与去重

1. 网页为每次操作生成稳定的 `commandId`，重试沿用原 ID。服务器按 `(sessionId, commandId)` 去重，相同内容返回已有投递记录，同一个 ID 携带不同内容时拒绝。
2. 电脑在调用 Codex 前持久化命令记录。每个会话串行受理，Codex 接受或拒绝后即释放受理队列，生成中的会话仍可接收追加或打断。重复投递返回已有回执。受理前检查当前会话状态，并核对目标轮次或权限请求是否仍有效。
3. 页面分别显示「服务器已收到」和「Codex 已受理」，轮次完成由会话事件更新。电脑若在调用 Codex 后、写下回执前退出，恢复时先查询原会话。结果仍无法确认时显示「待核实」，由用户处理这条操作，避免重复执行。

去重和串行受理参考 [ZCode CommandInbox](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts#L174-L210)。

### 首版实施顺序

1. **先验证本机 Codex 适配。** 复用现有 CLI 查找与目录限制，跑通创建线程、读取输出、追加、打断和原生权限回复。用明确的 `threadId` 重新打开已保存会话，核对线程 ID 和历史。
2. **打通中继和电脑指令回执。** 加入会话绑定、节点能力协商、指令投递和回传。先完成服务端去重、电脑端命令记录、目标校验与回执查询，再接网页发送入口。
3. **打通会话事件与恢复。** 接入 SSE、`epoch/seq` 增量重放和电脑快照。先用测试客户端验证正常续接、序号缺口和执行器重启。
4. **接入共用会话页，再做真机联调。** 在「运行」页加入电脑和会话入口，共用输出、输入、打断及权限确认。用电脑网页和手机浏览器验证同会话往返，再跑断线、重复命令和旧执行器回归。

### 首版验收项

| 场景 | 通过标准 |
|---|---|
| 电脑 → 手机 → 电脑 | 电脑在已配对电脑的允许目录中开启 Codex 会话。手机打开后看见之前的历史和当前输出，运行时追加一句，空闲后再发一轮。回到电脑能看见两次输入及结果，两端的 `sessionId` 和底层 `threadId` 始终一致。 |
| 手机短断线 | 在 Codex 输出期间断开手机网络，再恢复。网页按原 `epoch/seq` 补齐缺失事件，记录连续且每条事件只应用一次。 |
| 缓存缺口或执行器重启 | 分别模拟增量窗口已过和电脑执行器重启。网页收到新快照后继续接收事件。执行器重启后恢复到原 `threadId`，旧代次的迟到事件被丢弃。 |
| 电脑离线 | 网页显示离线并保留草稿。电脑恢复后仍打开原会话，草稿由用户主动发送一次。 |
| 重投与回执丢失 | 重试同一个 `commandId`，并模拟电脑回执丢失导致再次投递。Codex 只收到一次输入，页面能查回原回执。同一个 ID 换内容会被拒绝。模拟本地调用结果不明时，页面显示待核实。 |
| 迟到打断与两端审批 | 将旧轮的打断延迟至新轮开始后送达，新轮继续运行。电脑和手机同时回应同一项 Codex 原生权限请求，Codex 只收到一次有效决定，两个页面显示同一结果。 |
| 执行器兼容性 | 新旧任一端缺少会话能力时，原编排仍可领任务、执行并回传结果。双方支持时，批处理槽位占满也能处理会话控制指令。 |

首版实现后，发版前按仓库规范更新 `app-knowledge.ts` 的手机会话入口说明，并完成移动导航和离线相关回归。

## 五、后续增强

**现有工作流的推送与手机体验**

| # | 事项 | 内容 | 规模 |
|---|---|---|---|
| 1 | run/待确认事件 → Web Push | 在 run 终态迁移与 proposal 生成处调用 `sendPushToAll`，payload 带深链和 tag，设置加独立开关。 | 0.5–1 天 |
| 2 | 手机操作路径真机验证 | 待确认批量审批、运行页、发起接力/编排、composer 发消息逐项过窄屏;iOS 引导加主屏幕后订阅推送 | 1–2 天 |
| 3 | 推送设置分组 | run 事件开关默认开,复用 RemindersSettings 卡片样式 | 0.5 天 |

**桌面直连、手机配对和加密**

| # | 事项 | 内容 | 规模 |
|---|---|---|---|
| 4 | LAN/Tailnet 直连开关 | 桌面默认监听 loopback。若支持直连，需一起核对监听地址、Host 和 Origin 校验，以及移动端认证。 | 待评估 |
| 5 | 手机走设备配对而非 ownerKey | `acceptReplicaRelay` 已放行配对设备;缺手机端扫码配对入口(`pairSyncDevice` 现成)。**注意**:当前白名单是完整 owner 等价,手机场景建议收窄;sync device 无 connection 式 scope,收窄需扩 schema | 2–3 天 |
| — | E2E 加密 | 可参考 Vibex 或 Happy 的端到端加密。 | 后续 |

接入编排和待确认的 Web Push 时，先核对绑定模式下 run 的实际落库位置，再决定推送钩子落点。通知先覆盖 run 终态和新的待确认。

## 六、来源

- getpaseo/paseo · paseo.sh(README/LICENSE/relay)
- pingdotgg/t3code(docs/user/remote-access.md:三路由 + 多路由解析 + scoped token)
- slopus/happy · happy-server · happy.engineering/docs/security(TweetNaCl E2E、QR 配对、happy-push-server)
- tiann/hapi(README:free web/paid native、WireGuard+TLS relay、hapi.run/docs/guide/codex-shared-sessions)
- vibex-ai/vibex(README + releases:v0.1.8 APK、ACP 目录、Relay 零存储声明)
- omnara-ai/omnara(README:managed-agent 转型)
- BloopAI/vibe-kanban(README:sunsetting 横幅、VK_TUNNEL)
- code.claude.com/docs/en/mobile(Claude Code 移动端)
- [ZCode v3.18.2 会话协议](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/docs/zcode-protocol.md)（桌面持续订阅、手机重放、会话快照和命令回执）
- [Codex App Server 协议](https://developers.openai.com/codex/app-server/)（本地线程、轮次控制、输出事件和权限回复）
- Dovun 本仓:security.ts、push-subscriptions.ts、workspace-relay.ts、sync.ts、handoffs.ts、reminders.ts、push.ts、app-knowledge.ts
