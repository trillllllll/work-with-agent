# Codex

## 从运行版本查协议

找到执行器实际使用的 Codex CLI。用它生成 schema。以下命令只导出协议。需要实验方法时，先确认帮助里有 `--experimental`，再用该参数单独导出并核对运行时握手要求。

```sh
codex --version
codex app-server --help
codex app-server generate-json-schema --help
schema_dir="$(mktemp -d)"
codex app-server generate-json-schema --out "$schema_dir"
rg --files "$schema_dir" | rg 'ModelList|ConfigRequirements|ThreadResume|ThreadTurnsList|TurnStart|RequestApproval'
```

在目标项目用 `codex app-server --listen stdio://` 或该版本支持的本机连接启动。查询已运行桌面会话时，先确认桌面提供受支持的共享连接且它能访问该 thread。App Server 一行一个 JSON。发送 `initialize`，等成功后发送 `initialized` 通知，再查模型。需要实验能力时，按本机 schema 在握手中声明 `capabilities.experimentalApi`。

```jsonl
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"harness-probe","version":"1"}}}
{"method":"initialized"}
{"id":2,"method":"model/list","params":{"limit":100,"includeHidden":false}}
```

## 模型和权限

| 要查的内容 | 原生字段与核对方法 |
| --- | --- |
| 可选模型、名称和思考档位 | 分页读 `model/list` 的 `data`、`nextCursor`。用 `model` 或 schema 定义的 ID 发起请求，用 `displayName` 展示。关注 `supportedReasoningEfforts` 和 `defaultReasoningEffort`。 |
| 当前项目的 provider 与原会话选择 | 查 `config/read` 的有效配置和原 thread 的模型、provider。用同一 provider 恢复。收到 `modelProviderMismatch` 时，保留历史读取，并核对原会话的 provider 配置。 |
| 文件访问与审批 | 用 `configRequirements/read` 核对 `allowedSandboxModes`、`allowedApprovalPolicies` 等管理要求。启动和恢复的旧式字段为 `sandbox`，例如 `read-only`、`workspace-write`、`danger-full-access`。`turn/start` 的对应字段为 `sandboxPolicy`，例如 `{type:"readOnly"}`、`{type:"workspaceWrite",writableRoots:[cwd]}`、`{type:"dangerFullAccess"}`。 |
| 询问策略 | 单独查 `approvalPolicy`。Dovun 已适配 `on-request`、`untrusted` 和 `never` 中被本机策略允许的项。`never` 表示从不请求该类审批，文件访问范围仍由实际沙箱决定。 |
| 计划模式及生效 | 检查当前版本是否提供 `collaborationMode/list`、计划档位及对应的 `turn/start` schema。Dovun 在下一轮传 `model`、`effort`、`sandboxPolicy`、`approvalPolicy` 和可用的 `collaborationMode`，计划模式采用只读沙箱。 |

安装版本若支持命名权限档案，查询 `permissionProfile/list` 及其管理限制，核对 `permissions` 和旧沙箱字段的互斥条件。审批按原生请求 id 匹配，例如 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 和 `item/permissions/requestApproval`。按该请求的 schema 回复授权范围与决定。

## 原会话接口

- `thread/list` 按项目查历史，`thread/read` 核对 ID 和归属，`thread/turns/list` 分页读旧轮次。按当前 schema 选择 `itemsView`，使用原样游标。
- 用 `thread/resume {threadId}` 恢复，核对返回的 `thread.id`。下一轮用 `turn/start`。本机共享连接能操作原轮次时，用 `turn/steer` 携带 `expectedTurnId`，打断用 `turn/interrupt` 携带 `turnId`。
- 记录 session 启动、消息增量和完成通知的 ID。在原生历史内读回回复。优先从原生返回字段或对应模型请求记录确认实际模型。

Dovun 参考实现位于 `server/src/node-agent/harness-codex.ts`、`harness-settings.ts`、`harness-library.ts` 和 `harness-controller.ts`。0.6.15 使用 `stdio` 和已验证的本机 Codex 共享 socket。本机 CLI 0.166.0 已验证 schema 导出，其他版本按实际输出复核。[Codex App Server 官方文档](https://developers.openai.com/codex/app-server/)
