# 分阶段源码参考与设计取舍

> 核对日期：2026-09-20。对应[第一版架构基线](./architecture-baseline.md)。
>
> 本文记录实际读取的本地源码快照、调用链、相关测试与设计取舍。所有引用固定到提交；未启动参考项目、未运行其测试、未连接真实 AI。静态阅读不能替代运行验证，也不代表对应功能已在本产品实现。

## 范围与使用方法

此前的产品调研用于识别能力和筛选项目；本轮进一步阅读具体实现，按基础 Todo、AI 接入、记忆与整理、Handoff 四个阶段补充设计依据。源码证明的事实、本产品的取舍与尚待验证的行为分别记录。没有读取的模块不推断其能力。

| 阶段 | 参考仓库与固定提交 | 本轮关注的实现 |
|---|---|---|
| 基础 Todo | [Super Productivity](https://github.com/super-productivity/super-productivity/tree/a1743173e923492bc15e9e1b3d96d92e8d2c8b94) | 连续录入、草稿、中文输入、任务与视图更新 |
| 基础 Todo | [Vikunja](https://github.com/go-vikunja/vikunja/tree/94e6f165af474f7c7dbd3796cf19a450b5a3067a) | 局部编辑、缓存更新、失败回滚、排序范围 |
| AI 接入 | [Pith](https://github.com/SiluPanda/pith/tree/e342a0e3b596f0268230cf9c5d6d3519896ef2eb) | MCP → HTTP → 任务与变更记录 |
| AI 接入 | [Plane MCP](https://github.com/makeplane/plane-mcp-server/tree/44ef7da1955cc77703a102d69371ec067e9effc0) | 工具目录、凭证与工作范围、分页封装 |
| AI 接入 | [Nowledge Community](https://github.com/nowledge-co/community/tree/79a1cd410d88df4aa7880e533fb28e8c9bf536a4) | 公开连接器、CLI/HTTP 客户端与宿主 hooks 的边界 |
| 记忆与整理 | [projectmem](https://github.com/riponcm/projectmem/tree/e8d73137acde6f091ef6196f88ba5eccf6eb0e8a) | 追加事件、决策替代、当前摘要重建 |
| 记忆与整理 | [MemoryWiki](https://github.com/MemoryWiki/MemoryWiki/tree/e1481aa72e11f035724fc624e232254cf9bfd85f) | 来源、候选、确认、索引失效与检索 |
| Handoff | [Multica](https://github.com/multica-ai/multica/tree/8ce795b00718bd5d527153a6ded1de36e943be12) | 工作项与执行实例分离、重复完成回报 |
| Handoff | [CCB](https://github.com/SeemSeam/claude_codex_bridge/tree/a46e0830b82fb359941201a84df3288b97a81c08) | 提交回执、外部 job、结果终结与恢复 |

本地快照均位于 `D:/WorkSpace/GithubRepo/`；目录名依次为 `super-productivity`、`vikunja`、`pith`、`plane-mcp-server`、`nowledge-community`、`projectmem`、`MemoryWiki`、`multica`、`claude_codex_bridge-upstream`。本轮没有修改这些仓库。

<a id="stage-1"></a>

## 第一阶段：基础 Todo

### Super Productivity：从输入草稿到任务与视图更新

| 已读源码 | 实现事实 |
|---|---|
| [add-task-bar-state.service.ts](https://github.com/super-productivity/super-productivity/blob/a1743173e923492bc15e9e1b3d96d92e8d2c8b94/src/app/features/tasks/add-task-bar/add-task-bar-state.service.ts#L15) | 编辑状态与已创建任务分开；标题、说明草稿通过 sessionStorage 保存。`resetAfterAdd()` 清空内容与部分选择，同时保留项目、日期、估时和说明展开状态。 |
| [add-task-bar.component.ts](https://github.com/super-productivity/super-productivity/blob/a1743173e923492bc15e9e1b3d96d92e8d2c8b94/src/app/features/tasks/add-task-bar/add-task-bar.component.ts#L470) | `addTask()` 防止重复添加、排除空标题；提交后重置编辑状态。键盘处理在 869 行附近区分备注展开、普通 Enter、输入法 composing 和重复按键。 |
| [task.service.ts](https://github.com/super-productivity/super-productivity/blob/a1743173e923492bc15e9e1b3d96d92e8d2c8b94/src/app/features/tasks/task.service.ts#L391) | `add()` 按当前上下文构造任务，发送 `TaskSharedActions.addTask` 并返回 ID。 |
| [task-shared-crud.reducer.ts](https://github.com/super-productivity/super-productivity/blob/a1743173e923492bc15e9e1b3d96d92e8d2c8b94/src/app/root-store/meta/task-shared-meta-reducers/task-shared-crud.reducer.ts#L73) | `handleAddTask` 在同一 reducer 中写任务实体并更新项目、标签、规划中的关联与顺序；Today 的归入按日期处理。 |
| [plugin-api/types.ts](https://github.com/super-productivity/super-productivity/blob/a1743173e923492bc15e9e1b3d96d92e8d2c8b94/packages/plugin-api/src/types.ts#L281) | Task 保存独立 ID、项目、标签、父子关系与日期等；实体和组织它的列表不是同一个概念。 |

已读链路：输入与选项 → 编辑草稿 → Enter/按钮处理 → `TaskService.add` → 统一 action → 任务实体及项目/标签/规划更新。**本轮没有继续审查操作日志持久化和同步链路**，不能据此认定输入重置已等待磁盘落盘。

相关测试只读未运行：[组件输入法用例](https://github.com/super-productivity/super-productivity/blob/a1743173e923492bc15e9e1b3d96d92e8d2c8b94/src/app/features/tasks/add-task-bar/add-task-bar.component.spec.ts#L1396)覆盖 composing、keyCode 229 和普通 Enter；[编辑状态用例](https://github.com/super-productivity/super-productivity/blob/a1743173e923492bc15e9e1b3d96d92e8d2c8b94/src/app/features/tasks/add-task-bar/add-task-bar-state.service.spec.ts#L651)覆盖连续录入的选项保留、清空和 sessionStorage 恢复。

**本产品取舍：**

- **采纳**：草稿与任务分离；中文选字不误提交；防止重复创建；成功后保留当前清单，方便连续录入。
- **简化**：沿用 React 和现有服务端，不引入 Angular/NgRx 及其完整同步体系；第一阶段只明确需要保留的编辑选项。
- **自己的设计**：服务端保存失败保留输入，成功后再重置；一级子任务、父子完成规则和清单归档语义按本产品基线定义，不声称来自该项目。
- **实施验证**：中文输入连续选字、快速连按 Enter、保存失败后重试、切换清单再输入。验证持久化结果和重复创建，不能只看界面出现了任务。

### Vikunja：统一任务修改与缓存，排序有明确范围

| 已读源码 | 实现事实 |
|---|---|
| [taskMutations.ts](https://github.com/go-vikunja/vikunja/blob/94e6f165af474f7c7dbd3796cf19a450b5a3067a/frontend/src/client/queries/taskMutations.ts#L64) | 写入字段有白名单，移除 undefined，并转换为局部 PATCH；`updateTaskMutationOptions` 统一调用生成客户端及缓存处理。 |
| [taskCache.ts](https://github.com/go-vikunja/vikunja/blob/94e6f165af474f7c7dbd3796cf19a450b5a3067a/frontend/src/client/queries/taskCache.ts#L9) | 对已加载的详情、列表、分页列表、看板和关联任务统一更新；移动任务时处理旧项目成员关系，另行使相关查询失效。 |
| [contextMutation.ts](https://github.com/go-vikunja/vikunja/blob/94e6f165af474f7c7dbd3796cf19a450b5a3067a/frontend/src/client/queries/contextMutation.ts#L5) | 捕获请求身份、取消相关查询并保存涉及缓存快照；失败时只恢复本次涉及的快照，且检查身份上下文仍相同。 |
| [api/v2/tasks.go](https://github.com/go-vikunja/vikunja/blob/94e6f165af474f7c7dbd3796cf19a450b5a3067a/pkg/routes/api/v2/tasks.go#L244) 与 [handler/core.go](https://github.com/go-vikunja/vikunja/blob/94e6f165af474f7c7dbd3796cf19a450b5a3067a/pkg/web/handler/core.go#L138) | HTTP 取得身份并转换请求，进入通用 handler；`DoUpdate` 检查权限、调用模型更新、处理事务，提交后派发待处理事件。 |
| [task_position.go](https://github.com/go-vikunja/vikunja/blob/94e6f165af474f7c7dbd3796cf19a450b5a3067a/pkg/models/task_position.go#L38) | 排序记录由任务 ID 与项目视图 ID 共同确定；存在最小间隔、冲突处理与重排。`updateTaskPosition` 在 287 行开始执行相关写入流程。 |
| [calculateItemPosition.ts](https://github.com/go-vikunja/vikunja/blob/94e6f165af474f7c7dbd3796cf19a450b5a3067a/frontend/src/helpers/calculateItemPosition.ts#L5) | 拖动时从相邻位置计算新值，分别处理开头、末尾、中间和邻值相同的情况。 |

已读链路：任务编辑 → 统一 mutation/局部 PATCH → HTTP 身份与对象转换 → handler 权限/模型更新/事务 → 响应 → 更新已加载缓存及查询失效。本轮没有完整审查服务端 AutoPatch 和全部 Task 模型内部逻辑。

相关测试只读未运行：[taskMutations.test.ts](https://github.com/go-vikunja/vikunja/blob/94e6f165af474f7c7dbd3796cf19a450b5a3067a/frontend/src/client/queries/taskMutations.test.ts#L141)覆盖失败回滚，以及未涉及的列表在同时变化时不被回滚；[calculateTaskPosition.test.ts](https://github.com/go-vikunja/vikunja/blob/94e6f165af474f7c7dbd3796cf19a450b5a3067a/frontend/src/helpers/calculateTaskPosition.test.ts#L9)覆盖位置计算；[task_position_test.go](https://github.com/go-vikunja/vikunja/blob/94e6f165af474f7c7dbd3796cf19a450b5a3067a/pkg/models/task_position_test.go#L30)覆盖排序冲突检测与解决。

**本产品取舍：**

- **采纳**：集中封装任务修改、缓存更新与查询失效，让详情、清单、今天和搜索保持一致；失败回滚范围尽量小。
- **简化**：第一阶段手动顺序限定在清单根任务和同一父任务内；今天、标签与搜索使用确定性排序。先实现简单的持久化顺序，不复制完整的多视图浮点排名和重排系统。
- **自己的设计**：同一任务连续编辑需要处理响应先后，旧响应不能覆盖新内容；源码中的上下文检查不能当成已经证明所有并发编辑安全。
- **实施验证**：在搜索里修改任务后，其今天归属、清单和详情正确更新；修改失败不撤销另一项成功修改；拖动后刷新顺序保留，编辑标题不改变手动顺序。

以上落实到基线第 2.3、4、11 节。第一阶段仍以日常清单操作为交付目标。

<a id="stage-2"></a>

## 第二阶段：AI 接入源码核查

本阶段只读固定提交的源码，没有启动 MCP、连接真实 AI、执行写入或运行测试。三个参考工作区均无未提交改动。Nowledge Mem 仅读到公开连接器；Plane MCP 仅读到 MCP → SDK 边界，未审查其后端持久化。

### Pith：薄 MCP 适配器、共享 HTTP 业务入口

- 本地：`D:/WorkSpace/GithubRepo/pith`
- origin：`https://github.com/SiluPanda/pith`
- 提交：`e342a0e3b596f0268230cf9c5d6d3519896ef2eb`

| 已读核心文件 | 符号、行号与作用 |
|---|---|
| [packages/mcp-server/src/server.ts](https://github.com/SiluPanda/pith/blob/e342a0e3b596f0268230cf9c5d6d3519896ef2eb/packages/mcp-server/src/server.ts#L41) | `createServer`；41–61 行注册 `list_tasks`；106–135 行注册 `update_task`，把 snake_case 工具输入映射为 HTTP 请求字段 |
| [packages/mcp-server/src/api-client.ts](https://github.com/SiluPanda/pith/blob/e342a0e3b596f0268230cf9c5d6d3519896ef2eb/packages/mcp-server/src/api-client.ts#L4) | `request`，4–31 行；读取配置地址/API key，Bearer 请求、30 秒超时、解析结果；`api.updateTask`，53–54 行 |
| [packages/server/src/routes/tasks.ts](https://github.com/SiluPanda/pith/blob/e342a0e3b596f0268230cf9c5d6d3519896ef2eb/packages/server/src/routes/tasks.ts#L166) | `taskRoutes`；15 行身份校验；61–66 行查询与计数；103–129 行创建事务；166–236 行 PATCH 与逐字段 activity |
| [packages/server/src/middleware/authenticate.ts](https://github.com/SiluPanda/pith/blob/e342a0e3b596f0268230cf9c5d6d3519896ef2eb/packages/server/src/middleware/authenticate.ts#L22) | `authenticate`，22–68 行；API key/JWT 解析成服务端 `request.user` |
| [packages/core/src/schemas/task.ts](https://github.com/SiluPanda/pith/blob/e342a0e3b596f0268230cf9c5d6d3519896ef2eb/packages/core/src/schemas/task.ts#L38) | `updateTaskSchema`，38–49 行；nullable 与 optional 分别表达清空和未提供 |
| [packages/server/src/lib/response.ts](https://github.com/SiluPanda/pith/blob/e342a0e3b596f0268230cf9c5d6d3519896ef2eb/packages/server/src/lib/response.ts#L25) | `paginated`，25–30 行；`error`，33–38 行；定义分页元数据和业务错误格式 |

实际调用链：

```text
MCP update_task
  → 仅映射已提供字段
  → api.updateTask / HTTP PATCH
  → authenticate / updateTaskSchema
  → 读取当前任务、构造字段变更
  → 事务内更新 tasks 并插入 activities
  → HTTP 响应
  → MCP 结果
```

**实现事实：**

- MCP 不直接操作数据库，任务逻辑集中在后端 HTTP 路由。这里证明的是“共享服务入口”；该实现并未把路由内业务逻辑完全抽成独立应用用例。
- PATCH 使用 `!== undefined` 判断字段是否提供，明确允许部分字段为 `null`。修改说明不会顺带清空截止日期。
- 创建及修改同时写任务与 activity，调用主体从 `request.user` 取得，`actorType` 从服务端角色推导。
- 该调用链也有值得避开的缺口：服务端列表返回 `data + meta`，MCP `list_tasks` 只序列化 `result.data`，分页元信息在适配时丢失。HTTP 客户端只保留错误 message，丢掉原业务错误 code/details。
- 所读 PATCH 在事务前读旧值，最终 SQL 仅以 ID 更新，没有预期版本条件。不能把“事务保存任务与日志”误认为已经解决并发覆盖。

**对 WorkWithAgent 的取舍：**

- **采纳**：MCP 保持薄层；身份由连接凭证解析；字段校验复用；修改和记录同事务提交。
- **不采纳**：把任务规则堆进 MCP 或继续复制到各 HTTP 路由；丢弃分页与错误元数据；以无条件更新替代版本检查。
- **待验证**：MCP 与 UI 对同一任务并发编辑；服务端已创建但客户端超时后重试；查询超过第一页时 AI 是否能继续翻页。
- **需要细化基线**：第 5.3 节应明确 `未提供 = 保持`、`null = 清空可空字段`、`[] = 清空集合`，并要求结构化错误与分页信息完整穿过适配器。

### Plane MCP：统一工具目录、带范围的 SDK 调用、完整分页

- 本地：`D:/WorkSpace/GithubRepo/plane-mcp-server`
- origin：`https://github.com/makeplane/plane-mcp-server`
- 提交：`44ef7da1955cc77703a102d69371ec067e9effc0`

| 已读核心文件 | 符号、行号与作用 |
|---|---|
| [plane_mcp/server.py](https://github.com/makeplane/plane-mcp-server/blob/44ef7da1955cc77703a102d69371ec067e9effc0/plane_mcp/server.py#L54) | `_configured`，54–60 行；三种 server factory 共享中间件、工具和 instructions |
| [plane_mcp/tools/registry.py](https://github.com/makeplane/plane-mcp-server/blob/44ef7da1955cc77703a102d69371ec067e9effc0/plane_mcp/tools/registry.py#L52) | `RESOURCES`，52–83 行；`action_arguments`，86–88 行；显式维护目录和动作参数 |
| [plane_mcp/tools/workitem.py](https://github.com/makeplane/plane-mcp-server/blob/44ef7da1955cc77703a102d69371ec067e9effc0/plane_mcp/tools/workitem.py#L180) | `register/workitem`，180 行起；275–304 行列表；346–372 行创建、读取和更新；383–403 行标签/负责人集合修改 |
| [plane_mcp/client.py](https://github.com/makeplane/plane-mcp-server/blob/44ef7da1955cc77703a102d69371ec067e9effc0/plane_mcp/client.py#L21) | `get_plane_client_context`，21–74 行；取得 API key/OAuth token 与 workspace，构造 SDK client |
| [plane_mcp/toolkit/paging.py](https://github.com/makeplane/plane-mcp-server/blob/44ef7da1955cc77703a102d69371ec067e9effc0/plane_mcp/toolkit/paging.py#L54) | `envelope`，54–76 行；保留分页信息；`pql_failure`，113–126 行；返回可修正的查询错误 |
| [plane_mcp/toolkit/runtime.py](https://github.com/makeplane/plane-mcp-server/blob/44ef7da1955cc77703a102d69371ec067e9effc0/plane_mcp/toolkit/runtime.py#L62) | `opt`，62–64 行；`rich_text`，67–73 行；`coerce_list`，76–103 行；参数归一化 |

实际调用链：

```text
server factory → 共用配置与工具注册
  → workitem(action, 参数)
  → get_plane_client_context（凭证、workspace）
  → PlaneClient.work_items.list / retrieve / update
  → SDK 返回模型
  → envelope / model_dump / 错误反馈
```

**实现事实：**

- HTTP OAuth、header HTTP、stdio 的工厂复用同一套工具与中间件；“支持不同连接方式”没有造成三套业务工具实现。
- 工具是“资源 + action”的结构。`workitem` 显式声明每个 action 的必填/可选字段，模型可看到 ID、动作与参数约定。
- 请求中的 workspace 上下文由客户端配置或认证 token claims 取得，工具执行将其传给 SDK；本次没有继续审查 OAuth Provider 与 Plane 后端，所以不能将此表述为已验证完整权限隔离。
- `envelope` 保留 `next_cursor`、`prev_cursor`、count 等字段；如果来源对象没有承诺的分页字段，直接报错，避免把不完整结果包装成“最后一页”。
- `opt` 将 `""` 和 `0` 变成 `None`。`workitem.write_payload` 对多个编辑字段使用该转换；这是该适配器的具体选择，不能原样套入要求随时清空说明、日期、归属的 Todo。
- 标签/负责人增删在适配器里先 retrieve，再合并集合并 update；所读路径没有版本参数，因此这段代码不能作为原子集合修改的依据。

**对 WorkWithAgent 的取舍：**

- **采纳**：共享工具目录与使用说明；显式传递访问范围；列表/详情分开；保留分页；让错误说明缺失字段及可执行的修正方向。
- **不采纳**：起步即照搬 Plane 大量资源和动作；用空串/0 统一表示未提供；在 MCP 里自行进行读取—合并—覆盖来维护领域集合。
- **待验证**：初版少量独立动作工具是否比 `task(action=...)` 更易调用；普通、清空、空数组请求能否准确往返；跨页查询与范围过滤是否一致。
- **需要细化基线**：MCP 是协议适配器，子任务归属、标签增删、排序等组合修改仍必须由应用用例完成；适配层不能新增一套并发敏感的业务实现。

### Nowledge Community：公开连接器如何接入统一服务

- 本地：`D:/WorkSpace/GithubRepo/nowledge-community`
- origin：`https://github.com/nowledge-co/community`
- 提交：`79a1cd410d88df4aa7880e533fb28e8c9bf536a4`
- 边界：本次选读公开 Amp 连接器及通用 MCP 配置。**没有读到 Nowledge Mem 核心数据库、服务端 MCP 工具实现、检索或记忆演化实现。**

| 已读实现/配置文件 | 符号、行号与作用 |
|---|---|
| [mcp.json](https://github.com/nowledge-co/community/blob/79a1cd410d88df4aa7880e533fb28e8c9bf536a4/mcp.json#L1) | 1–12 行；Streamable HTTP MCP 地址、来源 APP 和 API key 配置模板 |
| [nowledge-mem-amp-plugin/src/index.ts](https://github.com/nowledge-co/community/blob/79a1cd410d88df4aa7880e533fb28e8c9bf536a4/nowledge-mem-amp-plugin/src/index.ts#L144) | `ampKnowledgeMem`，144–176 行；配置、客户端、执行器与宿主注册组装；188–203 行宿主生命周期 hook |
| [nowledge-mem-amp-plugin/src/tools.ts](https://github.com/nowledge-co/community/blob/79a1cd410d88df4aa7880e533fb28e8c9bf536a4/nowledge-mem-amp-plugin/src/tools.ts#L85) | `TOOL_DEFINITIONS`，85 行起；`createToolExecutors`，220 行起；查询、保存、更新、会话保存和摘要动作 |
| [nowledge-mem-amp-plugin/src/cli.ts](https://github.com/nowledge-co/community/blob/79a1cd410d88df4aa7880e533fb28e8c9bf536a4/nowledge-mem-amp-plugin/src/cli.ts#L46) | `createNmemCli`，46–70 行；参数数组执行 `nmem --json`；`serialiseCliError`，82–89 行 |
| [nowledge-mem-amp-plugin/src/http.ts](https://github.com/nowledge-co/community/blob/79a1cd410d88df4aa7880e533fb28e8c9bf536a4/nowledge-mem-amp-plugin/src/http.ts#L52) | `createNmemHttp`，52–91 行；`buildHeaders`，99–105 行；`normaliseNetworkError`，120–129 行 |
| [nowledge-mem-amp-plugin/src/config.ts](https://github.com/nowledge-co/community/blob/79a1cd410d88df4aa7880e533fb28e8c9bf536a4/nowledge-mem-amp-plugin/src/config.ts#L119) | `resolveConfig`，119–183 行；环境变量、共享配置、默认地址及空间/身份设置解析 |

两条公开可见入口应分开描述：

```text
通用 MCP：
宿主读取 mcp.json
  → http://127.0.0.1:14242/mcp
  → 此次未审查的服务端实现

Amp 原生插件：
ampKnowledgeMem → registerTool(声明 + executor)
  → nowledge_mem_search / save / update
  → createNmemCli → nmem --json → 结果字符串
```

此外，入口为会话同步注入了独立 HTTP 客户端；它发送 JSON body，并提供超时与网络错误分类。本次没有完整跟踪 `SessionSyncManager`，不据此宣称验证了完整会话同步或幂等机制。

**实现事实：**

- 工具声明与实际执行器拆分；入口文件负责连接宿主 SDK、配置和客户端。
- 普通查询/记忆写入由 CLI 执行，搜索工具限制结果数量；所读插件调用链自身没有另一份记忆数据库。
- `nmem` 调用采用 `execFile` 参数数组、JSON 输出与超时处理；不是通过拼接 shell 字符串执行用户内容。
- HTTP 客户端分别返回连接失败、超时和 HTTP 状态，有配置 key 时添加认证头。
- 工具使用说明直接附在工具定义中；例如先搜索相关记忆再更新，来源字段随写入命令发送。
- `nowledge_mem_save_handoff` 在 304–308 行只是 `nmem t create` 保存摘要。它没有在这段实现中派发任务、跟踪执行者或执行验收。
- 自动同步、会话启动上下文是宿主 hook 的额外能力，不能据“提供 MCP endpoint”推断所有宿主都能自动获得这些行为。

**对 WorkWithAgent 的取舍：**

- **采纳**：统一服务入口；独立连接配置、工具目录与简短行为说明；稳定清单/任务 ID；故障诊断；连接器只做宿主适配与参数转换。
- **不采纳**：第二阶段绑定完整记忆模型、启动 Context Bundle、自动会话捕获；为每个宿主创建独立 Todo 副本；把摘要保存称为完整 Handoff。
- **待验证**：首个实际宿主支持的 transport、连接配置、凭证注入、返回结构；本地服务离线后能否给出可理解错误。
- **需要细化基线**：第二阶段应明确两个层次：**通用 MCP 连接先交付**，宿主原生插件、CLI、自动 hook 按需求独立增加。不能把这些额外连接器行为当成通用 MCP 的默认能力。

### 第二阶段建议补入架构基线的约束

以下为结合上述源码提出的本项目设计选择，不表示参考项目已完整实现：

1. **共享用例的具体落点**：UI REST 与 MCP 同进程时直接调用同一应用用例；若 MCP 为独立进程，则通过受认证的 HTTP 客户端调用已有用例入口。两种方式均不直接读写数据库、不复制任务规则。部署方式在第二阶段实施前用首个宿主验证后确定。
2. **可编辑字段的三态语义**：未提供保持原值；可空字段 `null` 清空；集合 `[]` 清空；合法的 `false`、`0` 不被当作未提供。所有入口保持一致。
3. **结果契约不可在适配时缩减**：保留 ID、版本、执行状态、变更 ID、分页信息、业务错误码和必要修正信息。分页工具不能仅返回首批数组；待确认不能包装成执行成功。
4. **读取—修改由用例维护一致性**：排序、标签集合、父子任务等组合操作由用例原子执行或进行版本检查；MCP 不自行读出快照后覆盖。
5. **第二阶段验收补充**：跨入口字段清空、查询超过一页、用户与 AI 并发编辑、写入响应丢失后同请求重试、待确认提议过期、服务离线；这些比“工具能够被发现”更能证明 AI 与 UI 在操作同一份可靠数据。

<a id="stage-3"></a>

## 第三阶段：记忆与整理

### projectmem：历史保留，当前摘要可以重建

| 已读源码 | 实现事实 |
|---|---|
| [models.py](https://github.com/riponcm/projectmem/blob/e8d73137acde6f091ef6196f88ba5eccf6eb0e8a/src/projectmem/models.py#L125) | Event 保存 ID、类型、摘要、位置、提交、来源与 supersedes；`superseded_ids` 计算被替代记录。 |
| [storage.py](https://github.com/riponcm/projectmem/blob/e8d73137acde6f091ef6196f88ba5eccf6eb0e8a/src/projectmem/storage.py#L514) 与 [commands/decision.py](https://github.com/riponcm/projectmem/blob/e8d73137acde6f091ef6196f88ba5eccf6eb0e8a/src/projectmem/commands/decision.py#L12) | 决策命令校验被替代记录，追加 JSONL 事件，再重建摘要；事件追加后，部分类型还尝试跨项目提升。 |
| [summary.py](https://github.com/riponcm/projectmem/blob/e8d73137acde6f091ef6196f88ba5eccf6eb0e8a/src/projectmem/summary.py#L35) 与 [search.py](https://github.com/riponcm/projectmem/blob/e8d73137acde6f091ef6196f88ba5eccf6eb0e8a/src/projectmem/search.py#L9) | 当前摘要排除已被替代的决策，保留失败和部分成功尝试；历史搜索仍检索完整事件集，使用子串或正则匹配。 |
| [staleness.py](https://github.com/riponcm/projectmem/blob/e8d73137acde6f091ef6196f88ba5eccf6eb0e8a/src/projectmem/staleness.py#L103) | 引用文件消失或后续提交较多会触发过期提示，不自动删除或判定内容错误。 |

已读链路：提交决策 → 校验替代引用 → 追加 Event → 重建当前摘要 → 新决策进入当前背景、旧决策仍可在历史中查到。

这一链路是确定性的日志和视图生成，没有模型提炼；事件本身多为已经概括的内容，不是完整原始会话。追加事件与生成摘要是顺序操作，不能推断为跨文件事务；过期提示也不代表完成语义真实性核验。

**本产品取舍：**

- **采纳**：当前背景与历史分开；记忆修订保留旧内容和替代关系，工作摘要可以从有效记忆与实时任务重建。
- **简化**：保留既有数据库，不把 JSONL 或生成摘要变成 Todo 状态来源；项目经验扩展到全局范围需要明确选择。
- **实施验证**：新决策替代旧决策后，当前背景只使用新版本；历史仍能查到旧版本、来源和替代理由；来源变动后能提示重新核对。

### MemoryWiki：来源、候选与正式记忆分开处理

| 已读源码 | 实现事实 |
|---|---|
| [source_ingest.py](https://github.com/MemoryWiki/MemoryWiki/blob/e1481aa72e11f035724fc624e232254cf9bfd85f/source_ingest.py#L99) | 计算源文件 SHA-256，记录来源和台账，使用调用方提供的摘要创建或更新正式记忆，也可追加冲突说明。 |
| [memory_crystallize_candidates.py](https://github.com/MemoryWiki/MemoryWiki/blob/e1481aa72e11f035724fc624e232254cf9bfd85f/memory_crystallize_candidates.py#L50) | 用英文标记词提取候选并附来源；`propose_candidates` 默认预览，显式要求写入才保存待处理候选。 |
| [memory_review.py](https://github.com/MemoryWiki/MemoryWiki/blob/e1481aa72e11f035724fc624e232254cf9bfd85f/memory_review.py#L996) | `apply_candidate` 默认返回拟写入内容，实际写入需 write，替换同 ID 记录还需 replace；写后保存审计并刷新索引。 |
| [store_semantic.py](https://github.com/MemoryWiki/MemoryWiki/blob/e1481aa72e11f035724fc624e232254cf9bfd85f/memory_system/store_semantic.py#L12) | 文件锁与原子写入辅助方法保存正式记忆，并标脏索引；更新和冲突记录保留来源。 |
| [retrieval_index.py](https://github.com/MemoryWiki/MemoryWiki/blob/e1481aa72e11f035724fc624e232254cf9bfd85f/memory_system/retrieval_index.py#L271) | 派生检索视图保存内容 hash 和生成版本，加载时检查原记录与来源；78 行的 local embedding 使用 token 哈希稀疏向量。 |
| [memory_recall.py](https://github.com/MemoryWiki/MemoryWiki/blob/e1481aa72e11f035724fc624e232254cf9bfd85f/memory_recall.py#L816) | 限制返回数量和估算 token；区分 live/indexed/hybrid，索引失效时 indexed 跳过、hybrid 回读原记录，并返回冲突提示。 |

已读的两条路径需要区分：

```text
已保存会话/经历 → 规则提取候选 → 待处理队列 → 显式确认 → 正式记忆、审计、索引
原始材料 + 调用方摘要 → 来源引用/hash → 直接创建或更新正式记忆、追加冲突说明
```

因此，不能把该项目描述成“所有正式记忆都经过统一审批”。英文标记规则、固定置信度和 token 哈希向量也不能证明中文提炼与语义召回质量；来源 hash 只能识别变化，冲突日志只能记录问题，都不能替代事实核对。

**本产品取舍：**

- **采纳**：来源材料、提炼候选和正式记忆分开；AI 候选可预览，正式记忆有作用范围、来源和修改历史；派生视图可以失效与重建。
- **自己的设计**：先提供人工可编辑的项目记忆，再增加 AI 候选。确认时重新检查来源与目标版本；已变化的候选不能按旧内容静默覆盖。
- **简化**：暂不引入全部强度评分、图扩展和多粒度检索；中文材料的效果通过本项目样例验证。
- **实施验证**：候选生成后来源被修改；同一候选重复确认；确认时用户同时修改目标；记忆保存成功但索引刷新失败。最后一种情况应准确显示已保存，并回退查询或明确提示索引未更新。

本阶段未阅读或运行测试套件，上述场景是本项目待实现的验收要求。结论落实到基线第 8.1、11 节，记忆不成为前两个阶段的依赖。

<a id="stage-4"></a>

## 后续阶段：Handoff 与执行接力

### Multica：用户任务与一次执行分别保存

| 已读源码 | 实现事实 |
|---|---|
| [models.go](https://github.com/multica-ai/multica/blob/8ce795b00718bd5d527153a6ded1de36e943be12/server/pkg/db/generated/models.go#L109) | AgentTaskQueue 保存 IssueID、运行状态、结果、会话、尝试与重跑来源；Issue 是独立的用户工作项。 |
| [agent.sql](https://github.com/multica-ai/multica/blob/8ce795b00718bd5d527153a6ded1de36e943be12/server/pkg/db/queries/agent.sql#L764) | 认领以状态、运行时和锁约束竞争；认领后进入 dispatched；完成条件要求原状态 running，未启动的重投递受租约条件限制。 |
| [service/task.go](https://github.com/multica-ai/multica/blob/8ce795b00718bd5d527153a6ded1de36e943be12/server/internal/service/task.go#L1252) | 入队创建新执行 ID；认领、完成回报与手动重跑在服务层处理，完成返回 transitioned 标识是否发生实际状态转换。 |
| [task_lifecycle.go](https://github.com/multica-ai/multica/blob/8ce795b00718bd5d527153a6ded1de36e943be12/server/internal/handler/task_lifecycle.go#L27) | 重启后恢复孤儿执行并交给失败处理；用户重跑时检查目标 Agent 的调用权限。 |
| [task_complete_race_test.go](https://github.com/multica-ai/multica/blob/8ce795b00718bd5d527153a6ded1de36e943be12/server/internal/service/task_complete_race_test.go#L101) | mock 测试覆盖 completed/cancelled/failed 后重复终结回报，要求原状态保留且 transitioned 为 false；只读未运行。 |

已读链路：用户重跑 Issue → 校验来源执行和目标权限 → 创建新 AgentTaskQueue → 事务认领 → dispatched → 运行时启动与回报 → 有条件完成 → 保存结果、会话并发布事件。

这里的 Issue 对应本产品 Task，AgentTaskQueue 对应未来 Run。派发接收、真正启动、执行完成是不同事实；对重复或迟到的终结回报，用状态条件阻止重复副作用。结果及会话的部分数据在事务内保存，但兜底评论在事务外生成，不能推断所有产物都具备事务级回收保证。孤儿恢复进入失败处理，也不表示所有失败都能继续原执行。

**本产品取舍：**

- **采纳**：保留用户任务 ID，引入独立 Run；每次重跑记录来源 Run、输入版本、连接、外部标识和结果。结果收回与任务验收分别记录。
- **简化**：先接一个运行时，不照搬 Agent/Squad、并发池、自治调度与 PostgreSQL 行锁；SQLite 使用适合自身的事务和条件更新。
- **实施验证**：提交超时但外部 job 已创建；重复完成回报；取消后晚到成功；重跑后旧结果仍可查；重启后活跃 Run 能得到明确处理。

### CCB：提交回执、完成结果与恢复能力分别表达

| 已读源码 | 实现事实 |
|---|---|
| [submission_recording.py](https://github.com/SeemSeam/claude_codex_bridge/blob/a46e0830b82fb359941201a84df3288b97a81c08/lib/ccbd/services/dispatcher_runtime/submission_recording.py#L50) | 生成独立 job ID，保存请求、目标、provider 和状态，返回接受/排队回执；业务 task_id 与 job_id 分开。 |
| [lifecycle_start_runtime/start.py](https://github.com/SeemSeam/claude_codex_bridge/blob/a46e0830b82fb359941201a84df3288b97a81c08/lib/ccbd/services/dispatcher_runtime/lifecycle_start_runtime/start.py#L39) | 写 running、事件与快照，再按条件调用执行服务；启动异常形成失败决定。 |
| [finalization_runtime/service.py](https://github.com/SeemSeam/claude_codex_bridge/blob/a46e0830b82fb359941201a84df3288b97a81c08/lib/ccbd/services/dispatcher_runtime/finalization_runtime/service.py#L12) 与 [persistence.py](https://github.com/SeemSeam/claude_codex_bridge/blob/a46e0830b82fb359941201a84df3288b97a81c08/lib/ccbd/services/dispatcher_runtime/finalization_runtime/persistence.py#L15) | 终结要求明确决定，锁内检查是否已终结，保存快照、事件和终态；结果处理、回复投递与资源清理分开。 |
| [restore_runtime/execution.py](https://github.com/SeemSeam/claude_codex_bridge/blob/a46e0830b82fb359941201a84df3288b97a81c08/lib/ccbd/services/dispatcher_runtime/restore_runtime/execution.py#L91) | 调用执行服务恢复，区分 terminal_pending、restored 和不可恢复；记录原因与 resume_capable。 |
| [test_v2_ccbd_dispatcher.py](https://github.com/SeemSeam/claude_codex_bridge/blob/a46e0830b82fb359941201a84df3288b97a81c08/test/test_v2_ccbd_dispatcher.py#L444) | 使用替身覆盖提交、tick、完成；2540/2602 行附近覆盖重启不可恢复和运行时丢失待处理记录的情景。只读未运行。 |

已读链路：带 task_id 的请求 → 独立 job_id 与接收回执 → 调度/start → CompletionDecision → 完成快照和终态 → 结果回收、回复投递、清理。恢复时，已有完成决定但尚未终结的 job 补做终结；能恢复的继续跟踪；无法恢复的保存失败或 incomplete 并注明原因。

代码先记 running 再有条件启动，不能仅凭该状态断言真实 provider 已开始工作。完成持久化由多次存储调用组成，本轮未证明跨文件崩溃原子性。执行完成与调用者收到回复具有不同生命周期，回复丢失不能直接推断为执行失败。

**本产品取舍：**

- **采纳**：执行适配器映射本地 Task/Run、外部 job/session/turn；结果保存状态、原因、引用与内容；明确支持查询、取消、恢复还是仅重新提交。
- **简化**：CCB 作为可选适配器，终端 pane、多 provider 内部调度和消息角色不进入 Todo 核心。
- **实施验证**：选定接口的真实输入输出；提交响应丢失后的 job 查询；取消语义；回信丢失后的结果补取；不可恢复时明确给出重新提交入口。

结论落实到基线第 7.3、8、11 节：交接内容负责输入，Run 负责一次尝试，验收负责用户是否采纳。首个执行适配器完成实际故障场景验证后，再固定派发和恢复协议。

## 后续每阶段如何继续补充

本轮提供设计输入，实施前仍按下面的顺序推进：

1. 从该阶段用户操作选一个具体问题，定位参考源码的完整成功与失败路径，核对提交是否仍适用。
2. 记录入口、核心规则、存储与反馈，以及相关测试；涉及真实宿主、网络或模型的行为，用最小可运行场景补证。
3. 决定采纳与简化，写成自己的交互规则、数据约束和接口样例；暂未确定的选择保留验证条件。
4. 实现后用本产品场景验收，补充运行版本、结果和已知限制。未跑通时保留“待验证”，不把参考项目的能力写成本产品已具备。

任何后续阶段的参考结论都不提前增加基础 Todo 的交付范围。
