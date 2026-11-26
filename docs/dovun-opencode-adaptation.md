# OpenCode 接入探测记录（2026-11-25）

按 harness-adaptation skill 对本机 OpenCode 2 做的能力探测与适配证据。凭据不记录；示例端口和 ID 为实测值。

## 版本线与本机状态

| 项 | 实测 |
| --- | --- |
| 桌面 App | `/Applications/OpenCode.app` 2.3.2，自带 `opencode-cli serve --service`（pid 17025），持有共享服务 |
| 独立 CLI（升级前） | `~/.opencode/bin/opencode` 1.19.6（OpenCode 1 旧线，无 `pair`/`service` 子命令，与现行文档不符） |
| 独立 CLI（升级后） | `opencode v2.4.1`，官方 `https://opencode.ai/v2/install` 原位升级，能发现并复用桌面在跑的共享服务 |
| 共享服务 | `http://127.0.0.1:49374`（macOS 默认端口），注册表 `~/.local/state/opencode/service.json`（含 Basic auth 口令，凭据不入库） |
| 会话存储 | `~/.local/share/opencode/opencode.db`（SQLite）；OpenAPI 458 KB，142 路径 / 173 操作 |

`opencode.ai/install`（不带 /v2）是 OpenCode 1 的安装器并拒绝装 2.x；OpenCode 2 的安装脚本在 `https://opencode.ai/v2/install`，同样安装到 `~/.opencode/bin`。

## 鉴权

- 无凭据 `GET /api/info` → 401；Basic auth（用户名 `opencode` + 注册表口令）→ 200 `{version,pid,urls,paths,capabilities}`。
- 执行器读取顺序：`OPENCODE_SERVICE_URL`（测试）→ `OPENCODE_STATE_DIR/service.json` → `~/.local/state/opencode/service.json`。
- `GET /api/model` 响应的 `settings.apiKey` 是供应商凭据，映射时只取 `providerID/id/name/enabled`。

## 实测端点行为

| 行为 | 证据 |
| --- | --- |
| 新建会话 | `POST /api/session {location:{directory}}` → `ses_*`；项目自动注册（`/private/tmp` 规范化） |
| 发消息幂等 | 同 `id` 两次 `prompt`：第二次返回第一条原样数据，消息列表仅一条（对上 Dovun 命令去重）。**`id` 必须以 `msg_` 开头**（否则 400）且**全局唯一**：跨会话复用返回 409 `Prompt message ID conflicts with an existing durable record`。Dovun 用 `msg_`+commandId 发送（commandId 为 UUID）、读历史时剥前缀还原 clientId |
| 忙时投递 | 忙时 prompt 返回 `delivery:"steer"`（注入当前执行）；Dovun 侧改为忙时拒绝，与三家一致 |
| 打断 | `interrupt` → `{interrupted:true}`，事件 `session.execution.interrupted {reason:'user'}`，outcome `interrupted` |
| 恢复严格性 | 未知会话 → 404 `{_tag:"SessionNotFoundError"}`；runtime 映射为 `找不到 OpenCode 原会话，无法恢复` |
| 审批往返 | `permission.asked {action:'read',resources:['test.env'],save:['*']}` → `reply {decision:'once'}` → 204 → 工具继续执行、会话 succeeded |
| 档位切换 | `POST …/agent {agent:'plan'}` → 204，`GET /api/session` 显示 `agent:'plan'`；build/plan 两个主代理 |
| 模型切换 | `POST …/model {model:{id,providerID}}` → 204；模型列表用 deepObject：`location[directory]=…` |
| 404 会话 | `GET /api/session/ses_x` → `{"_tag":"SessionNotFoundError","message":"Session not found: …"}` |
| 事件日志 | `GET /api/experimental/session/{id}/log?after=0` → 仅 `log.synced {seq}`，不回放历史（断线补齐走消息快照） |

## SSE 事件词汇（成功路径实测）

`session.created → session.inbox.enqueued → session.execution.started → session.inbox.delivered → session.renamed → session.step.started → session.step.first-token → session.text.started → session.text.delta* → session.text.ended → session.step.streamed → session.step.ended → session.execution.succeeded`；工具路径为 `session.tool.input.started/ended → session.tool.called → session.tool.progress → session.tool.success`；审批为 `permission.asked / permission.replied`；打断为 `session.step.failed {error:{type:'aborted'}} + session.execution.interrupted`；另有 `session.reasoning.*`（不投影）、`session.usage.updated`、`shell.created/exited`（不消费）。消息粒度：`assistant.content` 分块数组（text/tool/reasoning），`idle` 消息带 outcome。

## 映射决定

- **turn 模型**：用户消息 ID = prompt `id` = Dovun commandId；一个 execution 一轮，多 step（工具循环里的多次模型调用）合为一轮内的多条消息。
- **审批**：`once→accept`、`always→acceptForSession`、`reject→decline`；`shell` 动作映射命令审批（resources 为命令），`edit/write/patch/multiedit` 映射文件变更，其余映射工具审批。
- **占用语义**：共享服务持有会话，无「等原进程退出」问题；runtime `pid` 为 undefined，恢复时不做 idle 阻断，`session/active` 判忙、接回正在运行的轮（桌面同时打开同一会话可旁观点赞续）。
- **暂缓**：`fork/steer/rerun/compact/approvePlan`（controller 对非 codex 已统一拒绝）；组织置顶/分组（opencode 无对应来源，pins 留空键）；`files[].uri` 图片附件代码路径已写但未在真实服务验证，未写入手册。
- **模型**：`providerID/id` 拼接为 Dovun 模型 ID；思考档位映射 OpenCode 的模型 variant：目录 `/api/model` 每项的 `variants[].id` 输出为 efforts，切换时 POST `provider/model#variant`（2026-11-26 实测 204，服务端不校验引用存在性，校验放 Dovun 侧），读回时从 `session.model.id` 的 `#` 后缀剥出档位、基础 ID 不带 variant。

## 真实验收（2026-11-25，桌面 2.3.2 服务 + deepseek-v4.1-flash）

受控项目经共享服务建原生会话并发首轮（标题自动生成「原生首轮完成」）→ Dovun runtime `thread/resume` 恢复原会话：模型 `opencode/deepseek-v4.1-flash`、历史 1 轮、`msg_` 前缀剥出 clientId ✓ → 发验证消息真模型回复「收到」，runtime 侧与服务端（桌面读取的数据源）一致、用户消息去重 1 条 ✓ → 长任务运行中第二个 runtime 附接同一会话（`session/active` 判忙），旁观到 `turn/completed` ✓（对应「桌面正开会话、手机接回」的能力）。验收产生的临时会话已从服务删除。

## 测试资产

- `server/src/node-agent/harness-opencode.test.ts`：9 例（创建+流式+完成、严格恢复、忙拒+打断、审批映射+幂等、原生设置裁剪、接回运行轮、响应丢失恢复、档位→variant 映射+恢复剥后缀、历史分页+重发去重），打真实 stub HTTP 服务。
- `server/test/stub-opencode-service.mjs`：最小共享服务 stub（HTTP+SSE+JSON 存储；`HARNESS_TEST_OPENCODE_ASK` 出审批、`HARNESS_TEST_OPENCODE_HOLD` 卡工具门控）。
- `server/src/harness-sessions.test.ts` 新增云端集成 1 例；`e2e/harness-sessions.spec.ts` 新增手机用例 1 例（Chromium 通过）。

## 环境备注

- Playwright e2e 需用 Volta Node 22.13.0：pnpm 默认 Node 24.17.0 下 tsx load hook 对 `node:sqlite` 返回 null，spec 无法加载（主仓同样复现，非本次改动引起）。
