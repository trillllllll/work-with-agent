# Grok CLI

## 查实际二进制

```sh
grok --version
grok --help | rg -- 'agent|always-approve|permission-mode|reauth|leader'
```

适配器启动 `grok agent stdio`（ACP，JSON-RPC 2.0 over stdio）。`GROK_BIN` 指向本机可执行文件可覆盖 PATH 解析（Dovun 侧读 `DOVUN_GROK_BIN`）；状态目录 `GROK_HOME`（默认 `~/.grok`）。本机 volta `@xai-official/grok` 1.0.50 已实测：initialize、`session/list`、裸帧容忍、未知方法 `-32601`；`session/new`/`session/load` 需登录凭据（`~/.grok/auth.json` 缺失时报 `-32000 Authentication required`，引导用户在本机终端运行 `grok login`）。`session/new` 须先 `authenticate {methodId}` 或依赖已有凭据；ACP 规范没有 `session/new.authMethodId` 参数。

握手：`initialize {protocolVersion: 1, clientCapabilities: {}}` → `authMethods[]`、`agentCapabilities.sessionCapabilities {list, resume, close}`、`_meta.modelState.availableModels[]`（`modelId`、`name`、`_meta.reasoningEfforts[]`、`totalContextTokens`）。`session/new {cwd, mcpServers: []}`（`_meta.yoloMode` / `autoMode` 设权限基线）→ `{sessionId, modes: {currentModeId, availableModes}, configOptions[]}`。`configOptions` 是 `{id: 'model'|'reasoning_effort', currentValue, options}` 选择器；`session/set_config_option {sessionId, configId, value: {value}}` 原地切换模型和思考档位，响应即整份新列表。`session/set_mode {modeId: 'plan'}` 切计划模式。权限基线只在建会话时设置，切换时 Dovun 重启 agent 进程并 `session/load` 同一会话。

## 事件与审批

| `session/update.update` | Dovun 映射 |
| --- | --- |
| `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` | userMessage / agentMessage（thought 为 commentary），增量走 `item/agentMessage/delta` |
| `tool_call` + `tool_call_update` | `execute`→commandExecution、`edit/delete/move`→fileChange（content 呈现差异）、`web_search`→webSearch、其余 dynamicToolCall；完成态在 `status: 'completed'/'failed'` |
| `plan` | `turn/plan/updated`（`entries[].state` → pending/inProgress/completed） |
| `current_mode_update`、`turn_completed`、`_x.ai/*`、`hook_execution` | 同步内部状态或忽略；轮次结束以 `session/prompt` 响应的 `stopReason` 为准 |

打断是 `session/cancel` 通知（无 id），prompt 响应以 `stopReason: 'cancelled'` 收尾。工具审批由 agent 发 `session/request_permission` 请求（`{toolCall, options: [{optionId, kind: allow_once/allow_always/reject_once/reject_always}]}`）；Dovun 按工具 kind 映射 command/fileChange/tool 审批卡，决定翻译为 `{outcome: {outcome: 'selected', optionId}}` 或 `{outcome: {outcome: 'cancelled'}}`。Grok 不回审批回执，Dovun 在写回复后自行合成 `serverRequest/resolved`。

## 原会话接口

- `session/load {sessionId, cwd}` 原生续聊同一 UUID；`session/list {cwd}` 无需登录即可列出该目录会话（`sessionId`、`title`、`updatedAt` 为 `+00:00` 偏移 RFC3339，入协议前转 ISO）。
- 磁盘存储：`~/.grok/sessions/<encodeURIComponent(cwd)>/<uuid>/`；`summary.json` 是索引（`info.id`、`info.cwd`、`generated_title`、`updated_at`、`num_chat_messages`、`current_model_id`、`reasoning_effort`），`updates.jsonl` 是权威 ACP 更新流。Dovun 的库投影直接读这两类文件：列表过滤 `num_chat_messages < 1` 的空会话，历史按 `user_message_chunk` 的 `_meta.promptId` 分轮、`cursor` 用轮 ID，文件大于 64 MiB 拒读。
- 会话占用：`~/.grok/active_sessions.json` 含会话 ID 时视为原生正在运行；`thread/read` 的 `status.type` 为 `active` 时 Dovun 阻断接回。
- 图片附件：1.0.50 `promptCapabilities.image: false`，Dovun 在发送前拒绝图片附件并说明。

Dovun 参考实现位于 `server/src/node-agent/harness-grok.ts`、`harness-grok-library.ts` 和 `harness-settings.ts`；权限档位映射 `default`/`auto`/`bypassPermissions`（计划模式走会话 mode）。[ACP 规范](https://agentclientprotocol.com/protocol/v1) · [Grok Agent mode 文档](file:///Users/byc/.grok/docs/user-guide/15-agent-mode.md)（随 CLI 安装在 `$GROK_HOME/docs/`）
