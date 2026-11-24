# Claude Code

## 查实际 CLI 或 Agent SDK

```sh
claude --version
claude --help | rg -- 'model|effort|resume|session-id|permission-mode|dangerously-skip|input-format|output-format|partial-messages'
```

已有执行器走 CLI 时，在目标项目启动 `claude --print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode default --permission-prompt-tool stdio`，实际支持的参数以该二进制为准。保留双向 stdin/stdout，一行一个 JSON。Dovun 使用以下控制帧查模型和设置。本机 CLI 2.1.328 已在隔离环境中实测两种读请求。探测能力时发控制帧即可。

```jsonl
{"type":"control_request","request_id":"models","request":{"subtype":"initialize"}}
{"type":"control_request","request_id":"settings","request":{"subtype":"get_settings"}}
```

等待对应的 `control_response`，核对 `request_id` 后提取 `response.response`。用 `models[].value` 作为模型 ID，读名称、模型的 `supportsAutoMode` 与当前权限档位。读取 `get_settings` 的 `effective.permissions` 来判断管理策略。输出证据时只投影这些字段。使用 Agent SDK 时，从实际 `Query.supportedModels()` 查目录，通过同版本的 `setModel`、`setPermissionMode` 和权限回调接入。思考档位从实际版本的 `--effort`、SDK 类型或模型能力查证。[CLI 参数](https://code.claude.com/docs/en/cli-reference) · [Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript)

## 权限参数

| `--permission-mode` 或 `set_permission_mode {mode}` | 原生行为 |
| --- | --- |
| `default` | 按有效的工具权限规则询问。 |
| `acceptEdits` | 自动接受允许范围内的编辑和相关操作。Bash 等工具仍按原生规则检查。 |
| `plan` | 进入计划模式。按原生事件实现退出计划和执行前确认。 |
| `dontAsk` | 对本来需要询问的操作直接拒绝。 |
| `auto` | Claude Code 用分类器审查工具调用。结合当前模型支持与 `permissions.disableAutoMode` 判断可用性。 |
| `bypassPermissions` | 跳过常规工具审批。查 `permissions.disableBypassPermissionsMode`、沙箱及原生强制保护。Dovun 在用户确认且本机允许的情况下，用 `--allow-dangerously-skip-permissions` 启动同一会话，再请求该模式。 |

查生效的 `allow`、`ask`、`deny` 规则和管理策略。CLI 模式需从回执或后续原生状态确认。Dovun 在下一轮发送前按需发 `set_model {model}` 和 `set_permission_mode {mode}`。改变高级档位所需的启动参数时，等待旧进程释放，用原 UUID 重开再发下一轮。审批由 `control_request` 的 `can_use_tool` 发出，按原 `request_id` 用 `control_response` 回复。Dovun 允许时回 `behavior: allow` 和 `updatedInput`，拒绝时回 `behavior: deny` 和 `message`。字段以同版协议或 SDK 为准。[原生权限规则](https://code.claude.com/docs/en/permissions) · [Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript)

## 原会话接口

- 新建可以指定 `--session-id <uuid>`，已有会话用 `--resume <uuid>` 并保持原项目路径。SDK 对应 `resume`。如需精确接续，使用记录的会话 UUID。
- SDK 支持时使用 `listSessions({dir,limit})`、`getSessionMessages(sessionId,{dir,limit,offset})`。Dovun 的 CLI 适配从 `CLAUDE_CONFIG_DIR` 或 `~/.claude` 下的 `projects` 读取 JSONL 投影，按原 UUID、`cwd` 和消息锚点校验与分页。
- 投递 `user` 帧时携带原 `session_id` 和唯一消息标识。核对 `system/init`、流式消息、`result` 和本机历史。Dovun 在 Claude Code 当前轮未结束时将普通后续消息排到下一轮，用 `interrupt` 控制请求打断，并等待原生轮次结束后再发送。

Dovun 参考实现位于 `server/src/node-agent/harness-claude.ts`、`harness-claude-library.ts` 和 `harness-settings.ts`。[SDK 会话接口](https://code.claude.com/docs/en/agent-sdk/typescript#getsessionmessages)
