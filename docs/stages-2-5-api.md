# 第二至第五阶段：接口与宿主接入

实现使用本机 Express / Prisma / SQLite。Todo、资料、记忆在没有模型时均可手动使用。外部宿主通过官方 MCP SDK 的 stdio 适配器调用认证 HTTP，适配器不读取数据库。

## 本机身份

API 默认监听 `127.0.0.1:3016`，开发界面为 `http://127.0.0.1:5176`。`npm run dev` 的 API 日志输出一次性启动链接；打开它建立 HttpOnly、SameSite=Strict 会话，浏览器随后清除地址中的凭据。凭据十分钟内仅可消费一次，会话有效七天。

`POST /api/v1/auth/session {bootstrapToken}` 建立会话；`GET /api/v1/auth/session` 恢复会话及 CSRF。所有浏览器写请求携带 `X-CSRF-Token`，非允许来源被拒绝。旧 `/api/tasks` 等接口也必须认证，且仅供本机用户使用。AI 使用独立 Bearer 凭据，不能通过旧接口提升权限。

在“AI 连接”选择具体清单、收集箱和允许直接执行的操作。默认所有 AI 写入生成提议；连接撤销立即生效，新清单不会自动纳入授权。连接 Token 仅创建时显示。设置、授权、审批、全局标签修改及永久删除仅允许用户操作。

模型 API Key 只由服务端保存，界面只显示掩码。文件、Shell 和 HTTP 执行有参数校验、超时、输出限制和敏感信息脱敏。用户操作和 Agent 变更保留审计记录，一部分可以撤销。不要把这个只给本机一个人用的服务直接暴露到公网。

## 统一写入与并发

```json
{
  "requestId": "同一次逻辑请求的稳定 ID",
  "commands": [
    {
      "kind": "task.update",
      "targetId": "任务 ID",
      "expectedRevision": 3,
      "input": { "description": "新说明", "dueDate": null, "tagIds": [] }
    }
  ]
}
```

发送到 `POST /api/v1/commands`。缺字段保持原值，`null` 清空可空字段，`[]` 清空集合。已有对象必须提供 `expectedRevision`。最多 50 条命令，以有序事务整体提交，不包含 Shell、网络或文件执行。

创建命令可提供 `clientRef`，后续输入用 `{ "$ref": "引用名" }` 关联本批次创建对象。`GET /api/v1/tools` 是当前命令目录。任务、清单、标签沿用原 ID。

成功返回 `data.status=applied` 和 `changeId/results`，或者 `pending_approval` 和 `proposalId/proposalRevision`。后者表示数据尚未改变。同一主体的相同 requestId 和规范化内容重放原响应；不同内容拒绝，重放仍检查当前连接权限。网络中断重试时保留原 requestId；创建不自动重试。

级联操作需要先 `POST /api/v1/commands/preview {commands}`，保存返回的 `previewToken` 并随原命令提交。预览固定目标版本、连带对象和完整集合；十分钟内有效。版本或集合改变后拒绝整组，必须重新检查。旧 REST 在需要预览时返回 `428 PREVIEW_REQUIRED` 和 `details.commands`，取得令牌后将 `previewToken` 放入原请求正文。排序单独提交完整 `orderedTaskIds` 和 `expectedRevisions` 映射。

界面显示“确认连带修改”，列出受影响任务、修改内容与版本，再提交预览令牌；取消保留草稿。连接即使持有自动创建或完成权限，涉及父任务重开等连带修改仍进入 Proposal。调整提议时保留服务端已分配的创建 ID，新增对象使用新的批内引用，不能任意指定既有对象 ID。

提议接口为 `/api/v1/proposals`、`/:id`、`/:id/approve`、`/:id/reject`。调整提议与确认均携带提议的 `expectedRevision`；确认额外携带 requestId。确认重新检查发起者权限、目标和来源版本，数据、审批结果、审计、回执一起提交。AI 不能确认自己的提议。

分页结果包含 `items/nextCursor/hasMore`；必须继续读取 nextCursor 才能得到完整范围。SSE `/api/v1/events` 发出缓存失效通知，浏览器重连、重新激活和 30 秒兜底刷新均保留未保存草稿。

新增范围查询为 `GET /api/v1/tags`、`/trash/tasks`、`/tasks/:id/history`、`/changes`。连接只能发现授权任务使用过的标签及授权回收站对象；历史中范围外的清单信息被隐藏，审计仅返回经过可见范围检查的元信息，完整快照仅对用户开放。连接管理的 `/:id/check` 检查凭据及范围，`/:id/config` 提供脱敏配置；列表分别显示最近命令和实际写入时间，不能将其误称为宿主进程在线状态。

## Codex 与 Claude Code 配置

先运行 `npm run build`。以下路径替换为项目绝对路径，凭据替换为各自独立连接；不要把实际凭据提交进 Git。宿主读取环境中的 `WWA_API_URL`、`WWA_CONNECTION_TOKEN`。服务必须正在运行。

Codex 的本机 `config.toml` 示例（官方配置定义见 [MCP](https://learn.chatgpt.com/docs/extend/mcp)）：

```toml
[mcp_servers.work_with_agent]
command = "node"
args = ["D:/WorkSpace/ClaudeCodeProjects/WorkWithAgent/server/dist/mcp/index.js"]
env_vars = ["WWA_API_URL", "WWA_CONNECTION_TOKEN"]
```

Claude Code 的 MCP JSON 配置（参见 [官方 MCP 文档](https://code.claude.com/docs/en/mcp)）：

```json
{
  "mcpServers": {
    "work_with_agent": {
      "command": "node",
      "args": ["D:/WorkSpace/ClaudeCodeProjects/WorkWithAgent/server/dist/mcp/index.js"]
    }
  }
}
```

两个进程均需继承环境变量；默认 API 地址是 `http://127.0.0.1:3016`。使用宿主的 MCP 状态检查，随后让它调用 `list_tasks`、`get_task` 和 `submit_commands`。宿主自身工具授权与应用的业务审批是两层独立权限。自动验收只在临时配置中允许三个测试工具，不修改用户全局配置。

## 材料、记忆与整理

`/api/v1/knowledge` 下提供 materials、memories、brief、search、organizations、export。材料及记忆写入共同命令 `material.create/update/archive` 和 `memory.create/update/retire`，详情包含历史版本。

- 材料类型：text、markdown、link、thread、attachment。thread 的 metadata 记录宿主、会话标识、full/excerpt/summary 完整性。
- 附件下载：`GET materials/:id/versions/:revision/attachment`。原件按 hash 管理；首期不解析 Office、PDF 或图片。
- 主动链接抓取：`POST materials/:id/fetch {expectedVersion}`。保存新快照，旧正文保持不变。
- 主动保存内置会话：`POST materials/from-conversation {conversationId,topicId,title,messageIds?}`。省略 messageIds 表示完整记录。
- 记忆来源为 `{type,id,revision,hash?}` 数组；旧来源变化标记待复核，保留历史，不自动判错。
- 固定说明：`PUT brief {topicId,expectedVersion,manualNotes}`。重建结构化简报不覆盖固定说明。
- 创建整理：`POST organizations {topicId,purpose,provider,materialIds?,memoryIds?,taskIds?}`。内置 generate 或外部 candidates 都进入 Proposal。外部提交 `{summary,commands}`，不直接修改业务对象。
- JSON 导出：`GET export?topicId=...`；附件原件可通过各版本下载入口取得；JSON 导出也包含附件 base64，总附件量上限 64 MiB。

任务移动不会移动或公开材料所属范围。搜索按中文关键词扫描原数据，不依赖外部索引服务。待复核记忆单独标识，不作为确认事实进入后续上下文。

## 交接、执行、采纳

`POST /api/v1/handoffs` 保存任务版本、目标、约束、验收说明及选定材料/记忆。已有会话用 MCP 的 get_handoff、claim_handoff、report_progress、report_run 接手和回报。领取凭据绑定连接，稳定事件 ID 防止重复，晚到结果只记入所属运行历史。

`POST handoffs/:id/start {sourcePath,inputFiles?,requestId}` 启动本机独立 runner。Codex 和 Claude Code 分别使用结构化非交互接口及已有账号；不会复制宿主账号凭据。Git 工作副本来自明确 HEAD，不包含未提交内容，不能同时提供 inputFiles。非 Git 从源目录复制用户明确选择的相对文件路径到独立目录，保留相对结构；最多 100 个文件、合计 32 MiB，拒绝目录、符号链接和越界路径。Workspace.inputs 记录每个输入的 path/hash/size，未选中的文件不复制。首版并发为 1。

`POST runs/:id/continue {answer,permissions?,sourcePath?,inputFiles?,requestId}` 为已确定终止的本机运行创建新 Run，通过 continuationOf 关联。已有副本时保留输入快照，拒绝更改源路径或输入集合；首次准备失败没有副本时可修正上述选择。存在明确 session ID 且复用原副本时续接，否则明确开启新宿主会话，绝不使用“最近会话”。API 重启补读持久日志；无法确认启动或进程状态时保持 unknown，禁止重试。已有会话的取消仅撤销应用授权。独立 runner 只有确认其拥有的进程树终止后才显示已取消。

结果经用户 `POST handoffs/:id/review` 采纳，`completeTask` 可请求同时完成任务，仍检查 `expectedTaskRevision` 和子任务规则。代码应用通过 `POST runs/:id/apply` 独立记录，必须先预览产物；复核原路径、分支、HEAD、工作区和 hash。冲突保留副本与补丁，文件系统和数据库之间不承诺原子提交。

## 定期回顾

`/api/v1/reviews/rules` 保存关闭状态的 daily/weekly 规则及 IANA 时区，PATCH 使用 expectedVersion。启用后随本机服务调度；停机只补最近一次到期周期，报告覆盖上次成功记录后的变化。周期唯一键去重，手动 `/rules/:id/run` 每次生成一条独立历史。

先保存无需模型的基础报告，再追加整理建议。builtin、codex、claude 可选择；external 保留已有 MCP 会话手动整理入口。自动路径仅读取快照、提交候选，不派发 Todo、不确认记忆、不修改任务状态。失败保留报告及手动 retry，关闭规则不删除历史。

## 数据升级与验证

使用 `npm run db:backup` 生成并验证备份。四个增量迁移分别增加 2A、3A、4A、5 的结构；2B/3B/4B 复用相应领域。保留旧 ID、审计快照及旧归档语义。移除 ChangeRecord 全局 requestId 唯一索引，新增 `(actorId, requestId)` 回执唯一索引。旧撤销读取缺失新字段时保留原语义。

升级前停止服务，备份 SQLite 文件和资料/runner 目录，在备份副本验证迁移与恢复。Schema 改动后显式生成 Prisma Client。Windows 上生成期间所有使用同一 Client 的本项目进程都应停止，以免 DLL 被占用。

验证命令：`npm run prisma:generate`、`npm test`、`npm run build`、`npm run e2e`。真实宿主验收单独执行 `npx tsx server/src/mcp/real-smoke.ts --run` 与 `npx tsx server/src/runner/smoke.ts --run`，均使用隔离数据。具体结果在实施记录中记录，Mock 通过不代表真实宿主已验收。
