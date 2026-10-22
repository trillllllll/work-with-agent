# 记忆写入与确认链路

## 一句话结论

自动提炼先把候选保存为待确认的 `Proposal`，owner 确认后才执行 `memory.create/update/retire` 成为正式记忆；`propose_changes` 的 `memory.add` 与它共用这套命令、提议和最终执行链路，只是候选产生入口以及聊天侧的 `Approval` 包装不同。

## 自动提炼：从产生建议到正式记忆

### 1. 发现可提炼的变化

- **触发条件**：自动提炼范围已启用；收集箱或未归档清单中的任务、材料（以及已归档成 thread 材料的完整聊天轮次）相对上次扫描发生变化。定时器每 15 秒调用 `tick()`；扫描发现变化后先等 60 秒安静期，连续变化最长合并 300 秒。用户也可以通过 `POST /api/v1/knowledge/auto-memory/run` 手动触发，但仍要求范围已启用、清单未归档、模型已配置且确有未处理来源。
- **中间形态**：来源快照写入 `AutoMemorySource`；到期后创建 `AutoMemoryJob`，其 `snapshot` 保存本次冻结的来源和当前有效记忆。范围由 `topicId` 决定：`null` 是收集箱，非空是对应清单。
- **确认主体**：此步不需要用户确认，因为尚未写正式记忆。
- **落点**：没有记忆落库。
- **代码依据**：`AutoMemoryService.tick/scan/scanScope/markScanChanged/claim`，`SCAN_INTERVAL_MS`、`QUIET_PERIOD_MS`、`MAX_COALESCE_MS`，以及 `scopeKey()`。

### 2. 模型生成结构化候选

- **触发条件**：范围已到期、没有其他全局自动提炼作业占用执行权、模型已配置，并且能选出尚未处理或失败的可读来源；单次最多取 8 个来源。
- **建议形态**：模型必须返回严格 JSON：`{ summary, candidates }`。每个 candidate 是 `{ action, targetId, expectedRevision, kind, title, content, reason, importance, labels, evidence }`；`action` 只能是 `create/update/retire`，最多 12 条，证据必须指向本次来源。原始模型文本先存入 `AutoMemoryJob.modelOutput`。
- **确认主体**：此步不需要用户确认；模型只产候选。
- **落点**：仍没有正式记忆。
- **代码依据**：`AUTO_MEMORY_SYSTEM_PROMPT`、`autoMemoryOutputSchema`、`AutoMemoryService.execute()`。

### 3. 候选转成待确认提议

- **触发条件**：模型输出通过 schema、范围、来源新鲜度、证据和版本检查；与现有有效记忆或本批候选重复的内容被过滤。`update/retire` 还要求目标记忆及版本仍存在且一致。
- **建议形态**：每条保留候选由 `commandFor()` 转成一个 `memory.create`、`memory.update` 或 `memory.retire` 命令，再通过 `CommandService.submit(..., { forceProposal: true })` 单独写入 `Proposal`：
  - `Proposal.status = "pending"`
  - `Proposal.commands` 保存规范化命令 JSON
  - `Proposal.preconditions` 保存确认时要复核的对象、来源和版本条件
  - `Proposal.preview` 保存给界面看的变更预览
  - `AutoMemoryJob.proposalIds` 保存这些提议 id，作业状态变为 `proposed`
  - `MemorySuggestionKey` 保存候选内容指纹到 proposal id 的映射，用于去重/复用
- **确认主体**：等待 owner（当前工作区用户）确认。普通连接和自动提炼内部 actor 不能代替 owner 确认。
- **落点**：此时只在待确认提议队列，不在 `Memory` 表，因此既不是收集箱正式记忆，也不是清单正式记忆。
- **代码依据**：`AutoMemoryService.persist()`、`memorySuggestionHooks()`、`CommandService.submit()`、`Proposal` 与 `MemorySuggestionKey` 数据模型。

### 4. owner 审核提议

- **触发条件**：owner 在提议页/自动记忆候选界面对仍为 `pending` 的 proposal 选择确认；请求必须带当前 `expectedRevision` 和幂等 `requestId`。也可拒绝；拒绝不会写记忆。owner 还可在确认前编辑普通 proposal，编辑会重新检查并更新命令、前置条件、预览和 proposal revision。
- **建议形态**：确认前仍是 `Proposal`。确认入口是 `POST /api/v1/proposals/:id/approve`，服务端重新读取发起 actor、重新检查整个命令批次，并要求前置条件与产生建议时一致。
- **确认主体**：`CommandService.approve()` 显式调用 `assertOwner(actor)`，所以确认主体是 owner。
- **落点**：检查失败时保持未生效（例如版本变化会返回冲突）；拒绝则 `Proposal.status = "rejected"`，仍无正式记忆。
- **代码依据**：`CommandService.edit/approve/reject()` 与 proposals 路由。

### 5. 确认后成为正式记忆

- **触发条件**：owner 确认成功，proposal 仍为 `pending`、revision 一致，且确认事务中的来源、目标和关系前置条件仍与预览一致。
- **正式形态**：同一事务执行 `memory.create/update/retire`，写 `Memory` 和对应的 `MemoryVersion`；随后 proposal 改为 `executed` 并记录结果。`create` 得到 `status = active` 的正式记忆；`update` 产生新 revision；`retire` 把记忆保留为历史而不再作为有效记忆。
- **确认主体**：owner。
- **最终落点**：由命令中的 `topicId` 决定，不会在确认时重新分类：
  - `topicId = null`：成为**收集箱记忆**；
  - `topicId = 某清单 id`：成为该清单的**清单记忆**。
  自动提炼在生成 proposal 时已用当前 scope 固定这个 `topicId`，并拒绝跨 scope 的记忆命令。
- **代码依据**：`CommandService.approve()`、`executeBatch()`、`memory.create/update/retire` handler、`Memory`/`MemoryVersion` 模型、`assertSingleMemoryScope()`。

## `propose_changes` 的 `memory.add` 是否同一套

**结论：同一套（指“命令 → Proposal → owner 确认 → Memory/MemoryVersion”的核心写入与确认协议）；建议生成入口和确认 UI 包装不同。**

判断依据：

1. 内置助手调用 `propose_changes` 时，`family: "memory", args.action: "add"` 由 `compileChangeOperations()` 调用 `commandsFor("add", ...)`，编译成 `memory.create`。`target: "inbox"` 得到 `topicId = null`；`target: "topic"` 使用当前打开清单的 id，没有当前清单会失败。
2. 如果 AI 没提供任务、材料或记忆证据，`commandsFor()` 会把所选或最近的聊天消息编译成同一 proposal 内的 `material.create(kind="thread")`，再让 `memory.create.evidence` 引用它；所以聊天本身不会未经确认先落成正式材料或记忆。
3. `propose_changes` 同样创建 `Proposal`，命令、前置条件和预览均存在该表中。聊天链路另外创建一条 `Approval(toolName="propose_changes")`，把 proposal 与对话、run、工具调用和审核卡关联起来；自动提炼没有这层聊天 `Approval`。
4. 用户在聊天审核卡确认后，服务端仍执行该 proposal 中的同一批规范化命令，最终写入相同的 `Memory`/`MemoryVersion` 数据模型。测试也明确验证确认前 memory 和 thread material 都不存在，确认后两者在同一事务生效。
5. 两条链路的去重并不完全相同：自动提炼额外用 `memorySuggestionHooks()` 和 `MemorySuggestionKey` 对跨作业的相同候选去重/复用；`propose_changes.memory.add` 在编译时由 `commandsFor()` 查询现有正式记忆并拒绝完全相同的条目，但不写 `MemorySuggestionKey`。这属于建议入口的差异，不改变后续共用的 `memory.create`、`Proposal` 和正式记忆存储。

因此不能说是两套正式记忆：两者只有“谁提出、候选最初长什么样、聊天是否有 `Approval` 外壳”的差异；从规范化 `memory.*` 命令开始就是同一套。

## 关键函数的输入、输出与副作用

### `AutoMemoryService.persist()`

- **输入**：已持有 lease 的自动提炼 job、冻结来源 snapshot、通过 schema 的模型输出。
- **输出**：无显式返回值；失败时抛出领域错误或结束已丢失 lease 的作业。
- **副作用**：校验并去重候选；创建/复用 `Proposal` 和 `MemorySuggestionKey`；更新 `AutoMemoryJob`、`AutoMemorySource`、`AutoMemoryScope`。不直接写 `Memory`。

### `commandsFor("add", ...)`

- **输入**：`memory.add` 参数、由 target 解析出的 `topicId`、当前对话上下文和数据库。
- **输出**：一个 `memory.create` 命令；缺少现成证据时输出 `[material.create(thread), memory.create]` 两个相互引用的命令。
- **副作用**：只读数据库以做重复、范围、证据与消息检查；本函数本身不写业务数据。

### `CommandService.submit()`

- **输入**：发起 actor、requestId、规范化命令及可选强制提议/审计/hooks。
- **输出**：直接应用结果或 `{ status: "pending_approval", proposalId, proposalRevision, preview }`；本文两条 AI 记忆链路都走待确认结果。
- **副作用**：在事务中创建 `Proposal`、前置条件、预览、幂等回执并发布工作区变更事件；只有被授权直接应用的其他命令才可能立即改业务数据。

### `CommandService.approve()`

- **输入**：owner actor、proposal id、当前 expectedRevision 和 requestId。
- **输出**：已应用结果（含 proposal id 和批次执行结果）；冲突、过期或非 owner 时抛错。
- **副作用**：在同一事务重新校验并执行命令，写 `Memory`/`MemoryVersion` 等业务记录，把 proposal 标为 `executed`，写幂等回执并发布工作区变更事件。

## 未确认项

无。上述链路均能由当前代码、数据模型和现有测试互相印证。
