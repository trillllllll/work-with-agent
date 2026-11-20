# 手机遥控编程 Agent:竞品架构调研与 Dovun 能力盘点

- 日期:2026-11-20(star 数与代码行为均为当日核实)
- 问题:很多编程工具(Claude Code / Codex / ZCode 等)已有手机端遥控方案。是否存在聚合性开源软件做这件事?其架构(连接方式)有何差异?Dovun 现状离这个能力有多远?
- 结论速览:
  1. 赛道已收敛为「本地权威 + 手机 companion」,开源成熟方案有 T3 Code / Paseo / Happy / HAPI / Vibex 等,连接拓扑分五层信任光谱(局域网直连 > 打洞 P2P > 零知识中继 > 隧道 > 云平台)。
  2. 设计判断:**中继方案体验最优**(可达性恒定 + 零知识 + 手机端零额外安装)。
  3. Dovun 已有执行/审批/推送/设备配对/移动 UI 五块原语,且服务器模式 + `workspace-relay.ts` 已经构成「云端权威 + 桌面绑定」的中继骨架;缺的是 run/待确认事件推送、手机操作路径真机验证、(可选)桌面模式 LAN 直连开关。

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

## 三、Dovun 能力盘点(逐项核实代码)

**已有:**

1. **两种权威形态**:桌面权威(Tauri + 47317)与云端权威(wwa.cby.red 服务器模式,ownerKey 登录 + session cookie + CSRF)。手机浏览器今天就能全功能访问服务器模式。
2. **执行体系**:`server/src/routes/handoffs.ts` 接力 → run 完整生命周期(claim/start/progress/report/continue/reconcile/cancel/confirmStopped/proposals/artifacts/apply),run 事件流;runner(supervisor/worker/adapters)支持多台电脑执行器;Worktree 管理页(大小/干净度/关联编排,删除需确认卡确认);运行统计含轮次、一次通过率、token、费用(竞品公认的缺口,已有)。
3. **审批原语**:`ApprovalService` + `propose_changes` → 待确认页,用户审核后才执行。
4. **Web Push 基础设施**:VAPID 自动生成并持久化(`push-subscriptions.ts`)、订阅 fan-out、失效清理(404/410);payload 已支持 `{title, body, url, tag}`(深链 + 合并现成);客户端 `push.ts` 已处理 iOS 须加主屏幕的限制;manifest.webmanifest / apple-touch-icon 齐。
5. **设备配对与同步**:`pairSyncDevice`(Bearer token)+ op-log push/pull + workspace identity + 副本冲突解决。
6. **中继骨架已存在**:`server/src/application/workspace-relay.ts`——桌面绑定云端后,owner 请求按 ownerFamilies(chat/conversations/agent/orchestrations/worktrees/handoffs/runs/proposals/knowledge/library…)转发云端,带写前强制同步、版本重映射、离线缓存、SSE 透传;反向 `acceptReplicaRelay` 让配对 sync 设备经 `/api/v1/sync/relay` 获 owner 等价权限(白名单族),信任用进程内 WeakSet 标记("after the relay authenticates a paired device. No caller-controlled header or cookie can manufacture it")。
7. **手机 UI**:无底部栏,左下按钮或任意位置右滑开抽屉(0.6.1);触屏格式条;offline-runtime + serviceWorker。

**核实出的两个缺口/约束:**

- **推送覆盖面**:`sendPushToAll` 唯一业务调用点是 `reminders.ts:95`(任务提醒);run 完成、新待确认方案均不推送。
- **`checkLocalOrigin` 先于一切凭据校验**(`security.ts:230`):桌面模式 hostname 必须 loopback → 手机同 Wi-Fi 连 47317 也是 403;配对 sync 设备的 Bearer token 不豁免。

## 四、改造清单

**第一梯队(不动架构,原语全齐):**

| # | 事项 | 内容 | 规模 |
|---|---|---|---|
| 1 | run/待确认事件 → Web Push | 在 run 终态迁移与 proposal 生成处调 `sendPushToAll`,payload 带 url 深链 + tag;设置加独立开关。绑定模式下 runs/handoffs 是云端权威族 → 挂服务端同时覆盖两种部署 | 0.5–1 天 |
| 2 | 手机操作路径真机验证 | 待确认批量审批、运行页、发起接力/编排、composer 发消息逐项过窄屏;iOS 引导加主屏幕后订阅推送 | 1–2 天 |
| 3 | 推送设置分组 | run 事件开关默认开,复用 RemindersSettings 卡片样式 | 0.5 天 |

**第二梯队(桌面模式远程化,可选):**

| # | 事项 | 内容 | 规模 |
|---|---|---|---|
| 4 | LAN/Tailnet 直连开关 | 新配置 `DOVUN_ALLOWED_HOSTS`(默认空保持 loopback)→ `checkLocalOrigin` 放行指定主机名;改动集中在 security.ts | ~1 天 |
| 5 | 手机走设备配对而非 ownerKey | `acceptReplicaRelay` 已放行配对设备;缺手机端扫码配对入口(`pairSyncDevice` 现成)。**注意**:当前白名单是完整 owner 等价,手机场景建议收窄;sync device 无 connection 式 scope,收窄需扩 schema | 2–3 天 |
| — | E2E 加密 | 第一版 TLS + 配对 token 够用;Vibex/Happy 式端到端加密列为后续加固 | 后续 |

**第一版明确不做:**原生 App(PWA + Web Push 已覆盖)、公共托管中继(自托管 = wwa.cby.red)、新传输协议(SSE 透传已在 relay 里)。

**实施时待确认:**绑定模式下 run 状态实际落库位置(reconcile/confirmStopped 是否走同一路径)决定推送钩子挂哪一层;事件防打扰先只做「run 终态 + 新待确认」,不做进度流推送。

**发版配套:**app-knowledge 新增「手机接入」条目;跑 mobile-navigation / offline 两条 e2e。

## 五、来源

- getpaseo/paseo · paseo.sh(README/LICENSE/relay)
- pingdotgg/t3code(docs/user/remote-access.md:三路由 + 多路由解析 + scoped token)
- slopus/happy · happy-server · happy.engineering/docs/security(TweetNaCl E2E、QR 配对、happy-push-server)
- tiann/hapi(README:free web/paid native、WireGuard+TLS relay、hapi.run/docs/guide/codex-shared-sessions)
- vibex-ai/vibex(README + releases:v0.1.8 APK、ACP 目录、Relay 零存储声明)
- omnara-ai/omnara(README:managed-agent 转型)
- BloopAI/vibe-kanban(README:sunsetting 横幅、VK_TUNNEL)
- code.claude.com/docs/en/mobile(Claude Code 移动端)
- Dovun 本仓:security.ts、push-subscriptions.ts、workspace-relay.ts、sync.ts、handoffs.ts、reminders.ts、push.ts、app-knowledge.ts
