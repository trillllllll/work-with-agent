# Nowledge Mem 深度调研

> 日期：2026-09-20
> 范围：仅使用 Nowledge Mem 官方文档、官方隐私政策与 `nowledge-co` 官方 GitHub 仓库。
> 目的：理解其产品模型、记忆生命周期、跨 AI 连续性和开放边界，并判断它与 Work With Agent 的关系。

## 1. 结论先行

Nowledge Mem 不是普通的「聊天记录搜索」，而是一套以知识连续性为中心的 AI 上下文系统：它保存原始会话和材料，把其中值得长期保留的部分提炼成原子记忆，再通过知识图谱、演化关系、Working Memory 和 Context Bundle，把适量上下文交给不同 AI 工具。[官方首页](https://mem.nowledge.co/docs) [Memories](https://mem.nowledge.co/docs/memories) [Threads](https://mem.nowledge.co/docs/threads)

它最成熟的闭环是：

```text
会话 / 文件 / URL / 手工输入
          ↓ capture
Thread / Library Source / Memory
          ↓ distill + background intelligence
原子记忆 + 实体关系 + EVOLVES + Crystal
          ↓ rank + scope + brief
Working Memory + Context Bundle
          ↓
Claude Code / Codex / Cursor / 其他 AI
          ↓ session capture
新的 Thread 与 Memory
```

这和 Work With Agent 的方向高度重合，但两者的中心不同：

- Nowledge Mem 的中心是「我和 AI 知道什么，以及下一个 AI 如何接着知道」。
- Work With Agent 应坚持以「项目接下来要做什么，这件事由谁接手，做到什么算完成」为中心。

换句话说，Nowledge Mem 已经相当接近一个优秀的**项目记忆基础层**，但还不是滴答清单式的**项目行动系统**。最危险的路线是复制它的 Memories、Graph 和 AI workspace；最有价值的路线是借鉴它的记忆机制，再把 Task、Project、Handoff、Artifact 和验收闭环做成一等对象。

## 2. 产品核心对象与信息架构

官方 Context 文档对主要对象的分工定义得很清楚：[Context](https://mem.nowledge.co/docs/ai-context)

| 对象 | 官方定位 | 生命周期角色 |
| --- | --- | --- |
| Memory | 可独立理解、值得长期保留的事实、偏好、决策、计划、流程、经验、事件或上下文 | 持久知识单元 |
| Thread | 一次 AI 会话的原始消息流和讨论历史 | 原始证据、回放与提炼来源 |
| Library | 文件、文档、来源与生成物 | 原始材料和产物层 |
| Space | 工作、生活、项目或长期 Agent 的可选「记忆通道」 | 默认读写范围与召回边界 |
| Working Memory | 每日生成、日间刷新的短 briefing | 当前工作焦点与近期变化的低成本注入层 |
| Context Bundle | 某个 AI 开始工作前收到的 owner/profile/rules/scope/Working Memory 组合 | 一次 AI run 的启动上下文 |
| Knowledge Graph | Memory、Entity、Thread、Crystal 等对象及其关系形成的全局网络 | 连接、演化、证据与综合层 |
| Crystal | 至少三条独立来源收敛后综合出的稳定参考记忆 | 多来源知识综合层 |
| AI Profile / Rules / Skills | 长期 Agent 身份、常驻行为约束与可重复工作方法 | 行为上下文，而不是事实记忆 |

Memory 是最基本的持久单元。每条 Memory 包含标题、正文、类型、标签、重要度和创建时间；类型包括 `fact`、`preference`、`decision`、`plan`、`procedure`、`learning`、`context`、`event`。官方特别强调 Memory 应脱离原对话也能独立阅读，而 Thread 保存完整历史。[Memories](https://mem.nowledge.co/docs/memories)

这套信息架构最重要的设计是把三种信息分开：

1. **Trace**：原始会话、材料和事件证据。
2. **Unit**：从 Trace 中提炼出的原子、可复用记忆。
3. **Crystal**：多条独立 Unit 收敛后形成的稳定综合知识。

官方把这三层称为 Super Knowledge Graph 的三种知识形态，并通过实体、演化链、社区和来源关系连接起来。[Knowledge Graph](https://mem.nowledge.co/docs/knowledge-graph) [Crystals](https://mem.nowledge.co/docs/concepts/crystals)

### 2.1 Space 不是严格意义上的 Project

Space 可以对应长期项目、团队或 Agent，但它本质上是**召回和默认读写的 lane**：激活后，Memories、Threads、Library、Working Memory、AI Now 和 Timeline 默认跟随该 Space；实体图仍保持全局。Space 可以只在本空间召回、先搜本空间再读共享空间，或搜索全部空间；共享上下文只是读权限，不会移动或合并记录。[Spaces](https://mem.nowledge.co/docs/spaces)

因此 Space 能充当「项目知识范围」，却没有项目目标、阶段、任务状态、依赖、里程碑或完成定义。把 Space 直接等同于 Project，会丢失行动管理语义。

## 3. 六个关键对象的生命周期与关系

### 3.1 Thread：保真记录层

Thread 从浏览器扩展、原生连接器、编码工具本地历史扫描、文件导入、CLI 或 API 进入系统。它保留真实消息次序，支持按标题、正文和来源搜索，也可以固定和查看单条消息。[Threads](https://mem.nowledge.co/docs/threads)

Thread 的核心后续动作是 Distill。短 Thread 可立即提炼；超长 Thread 使用后台渐进读取，最后只保存较少的高价值持久记忆。Thread 本身仍作为来源保留，不因提炼而被摘要替代。[Threads](https://mem.nowledge.co/docs/threads) [Distill API](https://mem.nowledge.co/docs/api/memories/distill/post)

### 3.2 Memory：长期知识层

Memory 可以由用户直接写入、从 URL/文件/Timeline 生成、从 Thread 提炼，或由连接的 Agent 添加和更新。系统自动生成标题、分配 2–4 个复用既有分类体系的标签，并使用重要度影响搜索排序和 briefing 优先级。[Memories](https://mem.nowledge.co/docs/memories)

Memory 可编辑正文、标题、标签和重要度；官方同时提供 update、forget 和 delete 三种不同语义：

- `update`：直接修改当前 Memory 属性。[Update Memory API](https://mem.nowledge.co/docs/api/memories/memory_id/patch)
- `forget`：从召回和按 ID 读取中移除，但不硬删除图数据库中的记录。[Forget Memory API](https://mem.nowledge.co/docs/api/memories/memory_id/forget/post)
- `delete`：删除 Memory，并可级联删除相关实体和关系。[Delete Memory API](https://mem.nowledge.co/docs/api/memories/memory_id/delete)

### 3.3 Working Memory：短期、可编辑的当前工作面

Working Memory 是每天的 briefing。系统每天早晨归档前一天版本，再基于近期活动生成新版本；当日新增 Memory 后也会延迟刷新，用户还可以手工编辑。默认 Space 保留兼容文件 `~/ai-now/memory.md`，其他 Space 通过相同 API 和集成提供独立 briefing。[Background Intelligence](https://mem.nowledge.co/docs/concepts/background-intelligence) [Working Memory API](https://mem.nowledge.co/docs/api/agent/working-memory/get)

它不是完整项目数据库，而是一个有容量约束的「当前注意力缓存」。更新 API 要求至少包含 Focus Areas 或 Briefing，并对内容大小设限，说明产品有意控制启动上下文膨胀。[Update Working Memory API](https://mem.nowledge.co/docs/api/agent/working-memory/put)

### 3.4 Context Bundle：一次运行的上下文装配结果

Context Bundle 根据 `agent_id`、调用来源 `source_app`、宿主稳定身份 `host_agent_id`、活跃 `space_id` 组装 owner/profile/policy/scope，并可包含 Working Memory。它是 Agent 开工前的动态视图，不是新的 Memory 类型，也不参与 embedding 或索引。[Context](https://mem.nowledge.co/docs/ai-context) [Context Bundle API](https://mem.nowledge.co/docs/api/context/bundle/get)

它解决的是「这一个 AI、在这一个范围、这一次启动应该先知道什么」，不是把全部历史塞进 prompt。

### 3.5 Space：召回隔离与共享边界

Space 建立后，记录可以批量移动到其中；共享 Space 只提供跨空间读取。每个 Space 有独立 Working Memory。删除 Space 时，如果主要记录已经清空但仍有 Working Memory，系统会提醒并允许一并清理生成内容。[Spaces](https://mem.nowledge.co/docs/spaces)

### 3.6 Knowledge Graph：全局连接与演化层

每个 Memory 会成为图节点，后台任务抽取实体和关系。图保持全局，即使常用视图受 Space 限制；这让系统可以在局部工作时保留跨领域连接。[Knowledge Graph](https://mem.nowledge.co/docs/knowledge-graph) [Spaces](https://mem.nowledge.co/docs/spaces)

当三条以上独立 Memory 在同一主题上形成足够收敛，系统可以合成为 Crystal，并通过 `CRYSTALLIZED_FROM` 保留来源。如果来源后来被更新、挑战或替换，Crystal 被标记为需要复核，而不是静默重写；最终是否保留仍由用户决定。[Crystals](https://mem.nowledge.co/docs/concepts/crystals)

## 4. Capture、Distill、Retrieve、Evolve、Correct 与 Forget

### 4.1 Capture

官方支持多种入口：Timeline 可接收想法、问题、URL 和文件；浏览器扩展提供自动捕获、手动 Distill 和完整 Thread Backup；原生连接器利用生命周期 hook 保存真实会话；本地扫描用于补录既有编码 Agent 历史。[Memories](https://mem.nowledge.co/docs/memories) [Browser Extension](https://mem.nowledge.co/docs/integrations/browser-extension) [Never Lose a Session](https://mem.nowledge.co/docs/use-cases/session-backup)

一个值得借鉴的细节是浏览器 Smart Distill 会先检查现有记忆，必要时更新旧 Memory，而不是不断制造重复记录。[Browser Extension](https://mem.nowledge.co/docs/integrations/browser-extension)

### 4.2 Distill

Distill 把 Thread 中耐久的结论拆成独立 Memory，并赋予标题、标签和重要度。API 支持按消息范围提炼、swift/guided/expert 三个提取级别，以及 `simple_llm` 或 `knowledge_graph` 两种方式；还有 worthiness gate，用户可显式强制提炼。[Distill API](https://mem.nowledge.co/docs/api/memories/distill/post)

这不是把整段对话压成一篇摘要，而是建立「原始会话 → 多条独立知识单元」的可追溯关系。

### 4.3 Retrieve

检索同时使用语义、关键词和图关系。排序以语义相关度为主，时间衰减、访问频率、置信度、是否为 EVOLVES 最新版本、是否为 Crystal 等作为辅助信号；重要度提供最低可见性，防止关键旧知识变成无法找到的“幽灵记忆”。[Memories](https://mem.nowledge.co/docs/memories) [Memory Decay](https://mem.nowledge.co/docs/concepts/memory-decay)

Nowledge FS 又把检索结果投影为可导航路径：Agent 先 `recall/find/grep`，再 `stat/cat` 小范围读取，而不是一次加载长会话或大文档。路径只是 Mem API 地址，并非真实文件系统；当前 mount、SQL/Cypher、replay 等仍在设计中。[Nowledge FS](https://mem.nowledge.co/docs/nowledge-fs) [Nowledge FS API](https://mem.nowledge.co/docs/api/fs)

### 4.4 Evolve

后台智能在新 Memory 到达后检测四种关系：

- `replaces`：新认知替代旧认知；
- `enriches`：新增细节；
- `confirms`：独立来源支持既有认知；
- `challenges`：新信息与旧认知冲突。

前两者形成版本进展链，旧版本仍可在历史搜索中查看；后两者属于证据关系，不会自动替换原记忆。冲突只会被呈现，不会由系统擅自裁决。[Knowledge Evolution](https://mem.nowledge.co/docs/concepts/evolves)

### 4.5 Correct

用户可以直接编辑 Memory，也可以对错误的 EVOLVES 判断执行治理操作：选择保留某条、保留两条并标记 confirms/challenges，或标记为无关。应用修正时会原子调整直接边、重新计算可见性，并留下幂等治理记录。[Apply Memory History Correction API](https://mem.nowledge.co/docs/api/memories/evolves/revision/apply/post)

### 4.6 Forget 与衰减

系统不会因为时间久远而自动删除知识。衰减只改变排序；日常 freshness 刷新不会归档、删除、合并或改写 Memory。对低风险旧事实的整理也是先生成审阅建议；偏好、决策、计划、流程、规则、身份和上下文不会仅因过旧而机械归档。真正 Forget 或 Delete 始终是显式操作。[Memory Decay](https://mem.nowledge.co/docs/concepts/memory-decay)

这一点很重要：**注意力衰减和事实失效是两件事**。前者是检索排序，后者需要有来源、有理由的生命周期变更。

## 5. Handoff 与跨 AI 工具连续性

Nowledge Mem 的跨工具连续性由四层组成：

1. **启动层**：原生连接器在 session start 读取 Context Bundle；能力较弱的集成至少读取 Working Memory。
2. **工作中召回层**：Agent 遇到可能关联旧工作的主题时，通过 MCP、CLI 或原生工具搜索 Memory 和 Thread。
3. **持久化层**：Agent 保存关键决策、经验或流程为 Memory。
4. **会话回收层**：宿主暴露可靠 transcript/hook 时保存完整 Thread；否则只保存 handoff summary。

官方明确区分 full session capture 与 handoff summary：前者是真实会话记录，后者只是用于恢复工作的精简 continuation note。通用 skills 无法读取宿主真实 transcript 时，不会假装已经保存完整 Thread。[Threads](https://mem.nowledge.co/docs/threads)

不同宿主能力不同：Claude Code、Codex、Gemini CLI、OpenCode 等可通过 hook 或本地 session 文件保存真实会话；Droid 或缺少可靠 transcript hook 的路径主要提供 handoff summary；Cursor 同时有 summary fallback 和本地历史导入。[Never Lose a Session](https://mem.nowledge.co/docs/use-cases/session-backup) [Cursor Integration](https://mem.nowledge.co/integrations/cursor)

`save-handoff` 的本质是由 Agent 编写一条可恢复摘要，而不是任务调度协议。它不负责：

- 把任务真正派发给另一个 Agent；
- 跟踪接收方是否开始、阻塞或完成；
- 定义验收标准并收集结构化成果；
- 将完成结果自动映射回项目任务状态。

因此它解决了「换一个 AI 不必重新解释」，却没有完整解决「工作如何在多个执行者之间受控流转」。这正是 CCB 式 handoff 和 Work With Agent 一等 Handoff 对象可以补齐的部分。

## 6. 本地优先、云、隐私、存储与导出

### 6.1 本地模式

当前官方隐私政策明确区分本地和 hosted 数据：未启用托管 workspace 时，Memory、Thread、文件、搜索索引和知识图谱留在设备上，登录不会静默上传内容；本地内容直到用户删除或清除本地数据才离开设备。[Privacy Policy](https://mem.nowledge.co/privacy)

AI 能力可使用本地模型或用户选择的远程模型。使用第三方模型时，数据从用户设备直接交给所选服务，适用对方隐私政策。官方文档同时提供完全本地模型路径。[Nowledge Mem Docs](https://mem.nowledge.co/docs) [Privacy Policy](https://mem.nowledge.co/privacy)

### 6.2 远程访问与“同步”

当前多端同步不是多个本地数据库的多主复制，而是「一个始终在线的 Mem 实例 + 多个客户端」。桌面、Web、移动端、CLI 和 Agent 都连接同一后端，因此共享同一份 Memory、Thread、Graph 和 Library。[Sync Across Devices](https://mem.nowledge.co/docs/sync)

用户可以通过 Nowledge Link、Cloudflare Quick Tunnel 或自己的 Cloudflare 域名暴露该实例，并用 API key 保护远程请求；Docker 镜像也支持将数据、配置、缓存绑定到宿主机目录。[Access Mem Anywhere](https://mem.nowledge.co/docs/remote-access) [Docker Deployment](https://mem.nowledge.co/docs/docker)

### 6.3 Nowledge Cloud

当前隐私政策已经包含显式创建或使用 Nowledge Cloud workspace 的托管模式。放入该 workspace 的 Memory、Thread 消息、Library 文件、摘要、标签、关系和元数据会由 Nowledge Labs 的基础设施存储和处理；官方声明不出售个人信息、不投放广告，也不使用 workspace 内容训练其模型。[Privacy Policy](https://mem.nowledge.co/privacy)

所以不能再笼统理解为「Nowledge 永远看不到任何数据」；准确说法是：**本地 workspace 默认不上云，Cloud workspace 是用户显式选择的另一种部署边界**。

### 6.4 数据导出

完整 Data Transfer 导出不是不透明数据库快照，而是可检查的 ZIP/目录：JSON manifest、Memory/Thread/Source/Entity/Skill/Graph edge 的 JSONL、非敏感 AI Profile 和 Rule，以及 Markdown Working Memory；Library 原文件可保留原格式。它可以重新导入另一套 Mem，并支持 merge、skip、overwrite。[Back Up, Export, and Import](https://mem.nowledge.co/docs/data-portability)

另有两种面向其他工具的知识快照：

- Markdown Wiki：保留 `[[wikilink]]`，适合 Obsidian/Logseq；
- OKF Bundle：使用 Markdown、YAML frontmatter 和标准路径，适合通用工具与 Agent。

两者都覆盖知识图谱，但属于单向快照，外部修改不会自动同步回 Mem。[Open Knowledge Format](https://mem.nowledge.co/docs/zh/concepts/open-knowledge-format) [LLM Wiki](https://mem.nowledge.co/docs/concepts/llm-wiki)

## 7. 开源与闭源边界

结论：**Nowledge Mem 可以本地运行和自托管，但核心产品并未开源；“Public GitHub repo”不能等同于“核心可审计”。**

截至本报告日期，官方 [`nowledge-co/nowledge-mem`](https://github.com/nowledge-co/nowledge-mem) 仓库顶层只展示 README 和浏览器扩展引用目录，没有桌面应用、Rust 核心、数据库、检索、图谱、后台智能或服务端实现源码，也未展示覆盖核心产品的开源许可证。README 的作用主要是产品介绍、MCP 示例和文档入口。

官方 [`nowledge-co/community`](https://github.com/nowledge-co/community) 仓库则公开了大量外围集成：Claude Code、Codex、Cursor、OpenCode、Gemini、各类 Agent 插件、skills、配置示例和安装脚本。它们使「宿主如何读取 Context Bundle、调用 MCP、保存 Thread」具有较高可观察性，但并没有公开 MCP/HTTP 服务背后的核心存储与算法实现。

官方还提供：

- 可安装的桌面和 Linux 二进制包；
- 可运行在 VPS/NAS/云主机上的官方 Docker 镜像；
- 本地 HTTP、MCP、CLI 和较完整的 OpenAPI 文档；
- 可移植、可检查、可重导入的数据导出。

这些能力意味着它**可本地部署、可自托管数据、可通过公开接口集成、可迁移数据**，但不意味着用户能够审计核心实现、从源码自行构建、修补服务端或在原厂停止发布后独立维护。官方所谓 self-hosting 更接近「在自己的机器运行官方闭源发行物」。[Linux Server Deployment](https://mem.nowledge.co/docs/server-deployment) [Docker Deployment](https://mem.nowledge.co/docs/docker) [API Reference](https://mem.nowledge.co/docs/api)

对 Work With Agent 的启示是：可以把 Nowledge Mem 当作产品和接口参考，甚至未来作为可选记忆后端，但不宜把产品核心建立在无法审计或自行维护的内部实现上。

## 8. 与 Work With Agent 的重合和差异

### 8.1 高度重合

| Work With Agent 设想 | Nowledge Mem 已实现或接近实现 |
| --- | --- |
| 收集项目材料 | Timeline、Library、URL/文件解析、浏览器捕获 |
| 保存 AI 对话 | Thread、原生 connector capture、本地历史 backfill |
| 从材料提炼长期记忆 | Thread Distill、Smart Distill、Memory 分类 |
| 保存历史决策与设计逻辑 | decision/procedure/learning 类型、来源追溯 |
| 发现新旧认知冲突 | EVOLVES `challenges`、人工裁决 |
| 项目当前状态简报 | Space 级 Working Memory |
| 为 AI 提供启动上下文 | Context Bundle、Working Memory、Rules、Profile |
| 跨 Claude/Codex/Cursor 连续工作 | 原生插件、MCP、CLI、session capture |
| 本地优先和可迁移 | 本地存储、自托管、Data Transfer、OKF/Markdown 导出 |

### 8.2 本质差异

| 维度 | Nowledge Mem | Work With Agent 应聚焦 |
| --- | --- | --- |
| 核心交互 | Timeline、Search、Memories、Library、Graph | Today、Inbox、Project、Task detail |
| 顶层对象 | Memory / Thread / Space | Project / Task / Handoff |
| Plan | 一种 Memory 类型，表达未来意图 | 可执行任务、截止时间、依赖、状态和责任人 |
| Space | 召回和读写 lane | 有目标、阶段、状态和完成标准的项目 |
| Handoff | 可恢复摘要或上下文连续性 | 有生命周期的正式派发、执行、等待、返回、验收 |
| Artifact | Library 中的来源或生成物 | 与任务交付、验收和后续工作直接绑定的成果 |
| 闭环终点 | 新知识被保存、连接并可再次召回 | 项目被推进，任务状态和项目记忆同时更新 |

Nowledge Mem 的入口本质上是「记下/找到/理解」，Work With Agent 的入口应是「今天做什么/谁来做/是否完成」。

## 9. 最值得借鉴的设计

### 9.1 把原始证据与耐久记忆分开

Thread 和 Material 应保留原貌，Memory 是可独立理解的提炼物。不能用一篇不断覆盖的项目摘要替代证据层。

### 9.2 Working Memory 作为动态投影，不作为唯一真相

每个项目可以有一份短小「项目当前工作面」，从任务、近期结果、决策和风险生成，并允许人工编辑；但真相仍在 Task、Material、Decision 和 Memory 中。

### 9.3 Context Bundle 做按执行者、项目和任务的装配

Handoff 不应把整个项目塞给 AI，而应动态装配：用户/Agent 身份、项目规则、当前任务、相关材料、有效决策、Working Memory、验收标准和可访问路径。

### 9.4 显式区分 full transcript 与 handoff summary

宿主不能提供完整会话时，应诚实标记只保存了摘要。这个边界能避免用户误以为系统保留了完整证据。

### 9.5 用演化边而不是覆盖历史

项目决策需要 `replaces/enriches/confirms/challenges` 类关系。新决定可以成为当前版本，但旧决定和当时证据仍应保留。

### 9.6 将衰减、失效和删除分离

「最近不常用」只影响召回优先级；「已失效」属于业务状态；「忘记」和「删除」必须是显式治理动作。

### 9.7 渐进读取和路径化访问

AI 先搜索和查看元数据，再读取材料片段，避免把长 Thread、整份文档或全部项目历史一次灌入上下文。Nowledge FS 的路径模型值得借鉴，但可以投影成项目原生路径，例如 `/projects/<id>/tasks/<id>`。

### 9.8 可移植导出不是附属功能

至少应提供人可读的 Markdown/JSONL 项目包，保留项目、任务、材料、记忆、关系、Handoff 和 Artifact，并让来源链接和版本链可以离线理解。

## 10. 应避免的路线

### 10.1 不要把知识图谱做成首页

Graph 很适合探索和审计，但不适合成为用户每天推进项目的入口。普通用户应主要面对 Today、Inbox 和任务详情。

### 10.2 不要让 Space 冒充 Project

Project 必须拥有目标、状态、阶段、任务、阻塞和完成定义。只有检索隔离的容器不足以支撑项目管理。

### 10.3 不要把“能搜到上下文”当作“完成了交接”

真正的 Handoff 要包含责任转移、状态同步、验收标准、成果回传和失败处理。共享 Memory 只是交接前提。

### 10.4 不要过早复制全套 Graph Intelligence

实体抽取、社区检测、Crystal、bi-temporal search 很有魅力，但会把 MVP 变成通用知识平台。第一阶段应先验证：任务带上下文交给 AI，结果能回到项目并更新下一步。

### 10.5 不要静默重写关键项目认知

自动分类和摘要可以低风险运行；涉及决策替代、冲突裁决、任务完成和项目状态变化时，应生成差异供用户确认。

## 11. 对产品能力设计的具体调整建议

建议把 Work With Agent 的记忆层明确分成四级：

```text
Evidence   = Material + Thread + Artifact（原始证据）
Memory     = 可独立理解的事实、决策、经验、约束（长期知识）
Project WM = 当前目标、正在进行、阻塞、近期变化（动态工作面）
Handoff    = 为某个 Task、某个执行者装配的一次运行上下文
```

并明确它们与行动层的关系：

```text
Project
├── Task                 用户每天操作的主对象
│   ├── Evidence         为什么做、基于什么
│   ├── Relevant Memory  已知约束与历史经验
│   ├── Handoff          谁接手、带什么上下文
│   └── Artifact         交付了什么
├── Project Memory       项目长期认知
└── Project Working Memory
    └── 由当前 Task、阻塞、变化和决策生成
```

在 MVP 中，值得优先实现的 Nowledge 风格能力只有四项：

1. 保存原始材料/会话，并从中提议独立 Memory；
2. Memory 保留来源与替代/冲突关系；
3. 每个 Project 自动生成短 Working Memory；
4. 每次 Task handoff 生成可检查的 Context Bundle。

Knowledge Graph 可先作为底层关系模型，不必做复杂可视化；Crystal、社区发现和跨领域洞察可放到后期。

## 12. 最终判断

Nowledge Mem 是当前最接近 Work With Agent「长期项目记忆 + 跨 AI 连续性」部分的近邻产品，不只是基础设施参考。它证明了三个关键产品判断：

- 用户需要保留完整 Thread，也需要从中提炼可复用 Memory；
- AI 的连续性不能只靠搜索，需要 Working Memory 和启动 Context Bundle；
- 记忆必须有来源、演化、冲突与显式遗忘，而不是无限追加文本。

但它也留下了明确空间：Todo、Project、Handoff 执行状态、验收和结果回流并不是其核心模型。Work With Agent 不应与它竞争「谁的知识图谱更强」，而应把它已经验证的记忆思想嵌入一个更轻、更行动导向的项目清单体验：

> Nowledge Mem 让不同 AI 记得你知道什么；Work With Agent 应让你和不同 AI 知道项目下一步做什么，并确保做完以后项目真的向前走。

## 参考入口

- [Nowledge Mem 官方文档](https://mem.nowledge.co/docs)
- [官方使用场景](https://mem.nowledge.co/docs/use-cases)
- [Memories](https://mem.nowledge.co/docs/memories)
- [Threads](https://mem.nowledge.co/docs/threads)
- [Spaces](https://mem.nowledge.co/docs/spaces)
- [Context](https://mem.nowledge.co/docs/ai-context)
- [Background Intelligence](https://mem.nowledge.co/docs/concepts/background-intelligence)
- [Knowledge Graph](https://mem.nowledge.co/docs/knowledge-graph)
- [Knowledge Evolution](https://mem.nowledge.co/docs/concepts/evolves)
- [Memory Decay](https://mem.nowledge.co/docs/concepts/memory-decay)
- [Data Portability](https://mem.nowledge.co/docs/data-portability)
- [Privacy Policy](https://mem.nowledge.co/privacy)
- [官方 nowledge-mem 仓库](https://github.com/nowledge-co/nowledge-mem)
- [官方 community/integrations 仓库](https://github.com/nowledge-co/community)
