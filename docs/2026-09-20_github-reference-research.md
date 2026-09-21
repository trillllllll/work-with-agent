# GitHub 同类与参考项目调研

> 调研日期：2026-09-20
> 范围：仅使用项目自己的 GitHub README、仓库文档和源码目录作为事实来源。Stars、Forks、提交数等是调研当日页面快照，只用于判断项目成熟度和关注度，不代表产品质量。
> 目标产品：面向人的日常任务管理界面，连接项目材料、长期项目记忆与跨 AI 接力。

## 结论摘要

GitHub 上存在大量“局部相似”项目，但目前没有发现一个成熟项目完整覆盖以下闭环：

```text
快速收集 TODO / 材料
  → AI 整理并关联到项目
  → 形成可追溯、可修订的项目记忆
  → 把任务和必要上下文交接给任意 AI
  → 收回结果
  → 更新任务、材料、决策和记忆
```

最值得借鉴的不是一个完整竞品，而是五组能力的组合：

- **日常任务体验**：Super Productivity、Vikunja。
- **材料入口与自动整理**：Paperless-ngx。
- **项目记忆治理**：Nowledge Mem、MemoryWiki、next-wiki；Graphiti/Mem0 可作为时态事实与检索参考，但不宜直接等同于项目档案。
- **知识、任务和文件共存**：Zettelgarden；AppFlowy 可参考本地优先的工作空间形态。
- **AI 接力与任务上下文**：Pith、CCB、Omnigent、CTP/showagent；Agent Relay 提供更重的协作基础设施参考。

### 直接竞品与能力参考的区别

**直接竞品/高度近邻**（产品表面或核心闭环明显重合）：

- [Tada](https://github.com/LoadShine/tada)：离线 Todo + AI 结构化任务，最接近日常使用表面。
- [Zettelgarden](https://github.com/Zettelgarden/Zettelgarden)：任务、知识卡片、文件和 AI 共存。
- [PieroSierra/SecondBrain](https://github.com/PieroSierra/SecondBrain)：材料收集 → 自动 Wiki → 有来源问答/矛盾检查。
- [projectmem](https://github.com/riponcm/projectmem)：项目级 issues/attempts/fixes/decisions 记忆。
- [OptimalEngine](https://github.com/Miosa-osa/OptimalEngine)：证据 → claim → review → fact → memory → context package 的完整治理模型。
- [Multica](https://github.com/multica-ai/multica)：Issue → Agent Run → 进度/阻塞 → 人工 Review 的完整任务接力闭环，是“Todo 无缝衔接 AI 行动”部分最直接的竞品。
- [TaskClaw](https://github.com/taskclaw/taskclaw)：功能列表接近“任务 + 知识 + AI + MCP”，但产品叙事偏 AI 控制台且项目很新。

**能力参考**（不构成完整替代，但某个模块成熟或边界清楚）：

- Todo 体验：Super Productivity、Vikunja。
- 材料整理：Paperless-ngx。
- 记忆治理：MemoryWiki、next-wiki、Mem0、memkeeper。
- Agent 任务上下文：Pith、Plane MCP。
- Handoff：Nowledge Mem、CCB、Omnigent、Agent Relay、showagent、Context Transfer Protocol。其中 Nowledge Mem 偏记忆与会话连续性，CCB 和 Omnigent 偏运行时接力。
- 传统项目管理的信息架构：Plane、Leantime。
- 本地优先一体化工作空间：AppFlowy。

核心判断（分析）：产品机会不在于再做一个 Todo、知识库或 Agent 控制台，而在于把 **Todo 变成项目连续性的主界面**。任务帮助人记住下一步；项目档案帮助 AI 理解为什么做；handoff 负责跨工具延续工作；回收流程再把执行结果变成新的项目事实。

## 本地源码索引

以下版本于 2026-09-20 拉取到 `D:\WorkSpace\GithubRepo`。新拉取的仓库默认使用浅克隆，适合阅读当前源码；需要完整历史时可在对应目录执行 `git fetch --unshallow`。HEAD 用于固定本报告引用时的源码快照。

| 项目 | 本地地址 | 分支 / HEAD |
|---|---|---|
| Agent Relay | `D:\WorkSpace\GithubRepo\relay` | `main` / `cdd6612` |
| AppFlowy | `D:\WorkSpace\GithubRepo\AppFlowy` | `main` / `5cf3a36` |
| showagent | `D:\WorkSpace\GithubRepo\showagent` | `main` / `a763282` |
| Context Transfer Protocol | `D:\WorkSpace\GithubRepo\ctp-spec` | `main` / `2509a4d` |
| Graphiti | `D:\WorkSpace\GithubRepo\graphiti` | `main` / `5764a6c` |
| Vikunja | `D:\WorkSpace\GithubRepo\vikunja` | `main` / `94e6f16` |
| next-wiki | `D:\WorkSpace\GithubRepo\next-wiki` | `main` / `2ad9bd4` |
| Khoj | `D:\WorkSpace\GithubRepo\khoj` | `master` / `ae229ca` |
| Leantime | `D:\WorkSpace\GithubRepo\leantime` | `master` / `056835f` |
| Tada | `D:\WorkSpace\GithubRepo\tada` | `main` / `fc3cb80` |
| Plane | `D:\WorkSpace\GithubRepo\plane` | `preview` / `01064a7` |
| Plane MCP Server | `D:\WorkSpace\GithubRepo\plane-mcp-server` | `main` / `44ef7da` |
| Mem0 | `D:\WorkSpace\GithubRepo\mem0` | `main` / `a39a802` |
| MemoryWiki | `D:\WorkSpace\GithubRepo\MemoryWiki` | `main` / `e1481aa` |
| OptimalEngine | `D:\WorkSpace\GithubRepo\OptimalEngine` | `main` / `f81c79b` |
| Multica | `D:\WorkSpace\GithubRepo\multica` | `main` / `8ce795b` |
| Omnigent | `D:\WorkSpace\GithubRepo\omnigent` | `main` / `7c1ce5129` |
| Paperless-ngx | `D:\WorkSpace\GithubRepo\paperless-ngx` | `dev` / `87d1570` |
| SecondBrain | `D:\WorkSpace\GithubRepo\SecondBrain` | `main` / `2da438e` |
| projectmem | `D:\WorkSpace\GithubRepo\projectmem` | `main` / `e8d7313` |
| Claude Codex Bridge（最新上游副本） | `D:\WorkSpace\GithubRepo\claude_codex_bridge-upstream` | `main` / `a46e083` |
| Pith | `D:\WorkSpace\GithubRepo\pith` | `main` / `e342a0e` |
| Super Productivity | `D:\WorkSpace\GithubRepo\super-productivity` | `master` / `a174317` |
| TaskClaw（bare 仓库） | `D:\WorkSpace\GithubRepo\taskclaw.git` | `main` / `ba6515d` |
| memkeeper | `D:\WorkSpace\GithubRepo\memkeeper` | `main` / `22117a3` |
| Zettelgarden | `D:\WorkSpace\GithubRepo\Zettelgarden` | `master` / `a7c8d05` |
| Nowledge Mem（公开产品仓库） | `D:\WorkSpace\GithubRepo\nowledge-mem` | `main` / `e12a04e` |
| Nowledge Mem Community（连接器与部署周边） | `D:\WorkSpace\GithubRepo\nowledge-community` | `main` / `79a1cd4` |

### 本地仓库特殊说明

- Omnigent 原有工作区已通过 fast-forward 更新到最新 `origin/main`，工作区保持干净。
- 原有 CCB 工作区 `D:\WorkSpace\GithubRepo\claude_code_bridge` 含 6 个本地提交和未跟踪文件，并且与上游各自前进了 6 个提交。为避免覆盖本地工作，本次只执行了 `fetch`，没有自动 merge/rebase；报告的源码引用改用独立、干净的 `claude_codex_bridge-upstream`。
- TaskClaw 上游包含 Windows 文件系统不接受的冒号文件名，因此保留完整 bare 仓库 `taskclaw.git`。可用 `git -C D:\WorkSpace\GithubRepo\taskclaw.git show HEAD:<路径>` 阅读任意文件；源码内容和 Git 对象完整，只是不生成 Windows 工作树。
- Nowledge Mem 可以本地运行并通过官方 Docker 镜像自托管，但核心产品并未开源。`nowledge-mem` 公开仓库主要是 README，`nowledge-community` 公开的是连接器、插件和部署配置，不能据此审计其 Rust 核心、存储、检索与图谱实现。

## 项目能力地图

符号：● 强覆盖；◐ 部分覆盖；○ 基本不覆盖。下表是基于各项目 README/文档的产品分析，不是项目官方自我评价。

| 项目 | 人类 Todo 体验 | 材料管理 | 长期记忆/知识 | AI 自动整理 | AI 接力/会话 | 最值得借鉴 |
|---|---:|---:|---:|---:|---:|---|
| [Tada](https://github.com/LoadShine/tada) | ● | ◐ | ○ | ● | ○ | 离线 Todo 中的自然语言任务结构化与 Markdown 编辑 |
| [Super Productivity](https://github.com/super-productivity/super-productivity) | ● | ◐ | ○ | ○ | ○ | 快速、低打扰的个人任务工作流；任务/项目上下文附件 |
| [Vikunja](https://github.com/go-vikunja/vikunja) | ● | ○ | ○ | ○ | ○ | 成熟 Todo 领域模型、视图与自托管边界 |
| [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) | ○ | ● | ◐ | ● | ○ | 收集箱、元数据建议、自动分类、动态保存视图 |
| [MemoryWiki](https://github.com/MemoryWiki/MemoryWiki) | ○ | ◐ | ● | ◐ | ◐ | 来源、冲突历史、分层记忆、写入门控、可回滚文件格式 |
| [projectmem](https://github.com/riponcm/projectmem) | ○ | ○ | ● | ◐ | ◐ | issue/attempt/fix/decision 类型事件与失败尝试预警 |
| [SecondBrain](https://github.com/PieroSierra/SecondBrain) | ○ | ● | ● | ● | ◐ | append-only raw → AI wiki → outputs 与 contradiction lint |
| [OptimalEngine](https://github.com/Miosa-osa/OptimalEngine) | ○ | ● | ● | ● | ● | Claim/Fact 生命周期和授权 Context Package |
| [next-wiki](https://github.com/hugogu/next-wiki) | ○ | ● | ● | ● | ◐ | raw → generated → curated 的受治理知识闭环 |
| [Mem0](https://github.com/mem0ai/mem0) | ○ | ○ | ● | ● | ◐ | 自动事实提取、多信号检索、时间感知召回 |
| [Khoj](https://github.com/khoj-ai/khoj) | ○ | ● | ◐ | ◐ | ◐ | 多来源个人知识检索、Agent 与自动化入口 |
| [Nowledge Mem](https://github.com/nowledge-co/nowledge-mem) | ○ | ● | ● | ● | ● | Thread → Memory → EVOLVES/Crystal → Working Memory → Context Bundle 的知识连续性闭环 |
| [Zettelgarden](https://github.com/Zettelgarden/Zettelgarden) | ◐ | ● | ● | ◐ | ◐ | Tasks、Cards、Files 在同一产品内的组合方式 |
| [Pith](https://github.com/SiluPanda/pith) | ◐ | ○ | ◐ | ● | ● | Agent 可读任务、上下文组装、工作 session 和回传记录 |
| [Multica](https://github.com/multica-ai/multica) | ◐ | ◐ | ◐ | ◐ | ● | Issue 与 Run 分离、Agent 指派、状态回写、人工 Review 和项目执行上下文 |
| [CCB](https://github.com/SeemSeam/claude_codex_bridge) | ○ | ◐ | ◐ | ○ | ● | 跨 Provider 异步委派、原生 session、后台状态与项目共享记忆 |
| [Omnigent](https://github.com/omnigent-ai/omnigent) | ○ | ◐ | ◐ | ◐ | ● | 统一 Agent session、resume/fork、子 Agent、沙箱、策略与多端协作 |
| [Agent Relay](https://github.com/AgentWorkforce/relay) | ○ | ◐ | ◐ | ○ | ● | 稳定身份、消息投递、共享 session、人机门控流程 |
| [CTP + showagent](https://github.com/context-transfer-protocol/ctp-spec) | ○ | ◐ | ○ | ○ | ● | 可移植上下文胶囊与跨 Agent 原生 session 转换 |
| [TaskClaw](https://github.com/taskclaw/taskclaw) | ◐ | ◐ | ◐ | ◐ | ◐ | 任务+知识+AI+MCP 的近邻样本，以及范围失控风险 |

## 一、最接近产品方向的项目

### 1. Tada：Todo 表面与 AI 结构化输入

仓库：[LoadShine/tada](https://github.com/LoadShine/tada)

**事实**

- Tada 是 offline-first Todo，桌面端使用 Tauri + SQLite，Web 使用 LocalStorage/IndexedDB，AI 采用 BYOK，也支持 Ollama。[README](https://github.com/LoadShine/tada#readme)
- 自然语言输入可被解析为 title、description、due date、priority、tags、subtasks；任务详情内有 AI Ghost Writer，并可按日期/列表生成 Markdown 总结。[README Intelligent Workflows](https://github.com/LoadShine/tada#-intelligent-workflows)
- 同时具备 Calendar、Kanban、Lists 和自定义 Markdown 编辑器。调研时约 **193 stars、15 forks、331 commits**，Apache-2.0。[仓库主页](https://github.com/LoadShine/tada)

**分析：可借鉴与边界**

- 它证明 AI 最自然的入口不是独立聊天，而是快速录入和任务详情编辑器。
- 可直接参考“输入一句自然语言 → 展示结构化字段预览”的交互。
- 不应照搬的地方：AI 主要优化单条任务，没有跨任务的项目事实、材料来源和 handoff 回收。

### 2. projectmem：项目经验的类型化事件账本

仓库：[riponcm/projectmem](https://github.com/riponcm/projectmem)

**事实**

- projectmem 把开发过程记录成 append-only typed events：issues、attempts、fixes、decisions、notes，并通过 MCP 提供给新的 AI session。[README](https://github.com/riponcm/projectmem#what-is-coding-agent-memory)
- 它将 Git 定义为记录“改了什么”，自身记录“为什么改、试过什么、什么失败了”，并在重复失败方案前给出 deterministic pre-commit warning。[README](https://github.com/riponcm/projectmem#the-solution)
- 记忆位于项目内 `.projectmem/`，可随 Git 共享；还可导出 token-budgeted context 或写入 CLAUDE.md 类文件。[README](https://github.com/riponcm/projectmem#readme)
- 调研时约 **827 stars、42 forks、74 commits**，MIT。[仓库主页](https://github.com/riponcm/projectmem)

**分析：可借鉴与边界**

- 不要只存“总结”；必须把 Attempt 和 Failure 作为一等类型，否则项目会反复踩坑。
- event log → 可重建 projection 很适合任务历史、项目时间线与当前档案并存。
- 可借鉴“行动前检查历史经验”，但不要只服务编码和 Git hooks；检查点应扩展到任务交接前、决策确认前和材料归档时。

### 3. SecondBrain：材料摄取与自动知识整理的最小闭环

仓库：[PieroSierra/SecondBrain](https://github.com/PieroSierra/SecondBrain)

**事实**

- 支持 Markdown、PDF、网页、幻灯片、表格和图片导入；AI 自动组织为 cross-linked wiki，问答带来源。[README](https://github.com/PieroSierra/SecondBrain#what-it-is)
- 内容单向经过 `raw/`（append-only，AI 不修改）→ `wiki/`（AI 组织）→ `outputs/`（问答与 lint 报告）。[README How it's organised](https://github.com/PieroSierra/SecondBrain#how-its-organised)
- lint 会标记矛盾、无来源 claim 和知识缺口；ingest 是显式动作，新材料不会静默进入 Wiki。[README](https://github.com/PieroSierra/SecondBrain#prefer-the-terminal)
- 调研时约 **152 stars、11 forks、108 commits**。[仓库主页](https://github.com/PieroSierra/SecondBrain)

**分析：可借鉴与边界**

- 这是“用户只管扔材料，系统负责整理”的强参考；三目录可映射为 Material → Memory Proposal → Query/Review Output。
- contradiction/gap lint 应进入项目健康检查，而不仅是问答功能。
- 不应照搬每次重建整套 Wiki 的方式；项目任务、决策和来源需要稳定 ID、增量更新与显式 supersession。

### 4. OptimalEngine：项目真相与上下文包的完整参考模型

仓库：[Miosa-osa/OptimalEngine](https://github.com/Miosa-osa/OptimalEngine)

**事实**

- 它明确区分 `Source Package → Signal → Claim → Fact → Memory Object → Context Package → Active Memory Pool → Observation → Pending Claim`，阻止解析器、Agent 或文件编辑静默成为事实。[README Memory Lifecycle](https://github.com/Miosa-osa/OptimalEngine#memory-lifecycle)
- Fact/Memory 可携带 source/evidence links、confidence、valid time、transaction time、review state、supersession 和 derivation ledger。[README](https://github.com/Miosa-osa/OptimalEngine#memory-lifecycle)
- Retrieval 输出的是带 scope 与 provenance 的 Context Package，而非裸 chunks；同时使用 L0-L3 分层披露控制 token 预算。[README](https://github.com/Miosa-osa/OptimalEngine#retrieval-pipeline-ordered-chain-signal-branching-mcts-token-tiers)
- 调研时约 **24 stars、12 forks、274 commits**，MIT；仓库仍属早期小型项目。[仓库主页](https://github.com/Miosa-osa/OptimalEngine)

**分析：可借鉴与边界**

- 它是本产品后台领域模型最强的参考：原始材料、候选解释、确认事实、长期记忆和一次 handoff 上下文不能混为一层。
- Context Package 应是 handoff 的正式产物，包含 scope、来源、token budget 和生成时间。
- 不要复制其庞大术语和全栈“操作系统”范围；前台只暴露 Material、Task、Decision、Memory、Handoff 等少数用户概念。

### 5. Multica：最接近 Task → Agent → Review 的产品

仓库：[multica-ai/multica](https://github.com/multica-ai/multica)；文档：[multica.ai/docs](https://multica.ai/docs)

**事实**

- Multica 是一个面向人和 AI 编码 Agent 的开源工作空间。用户像给同事分配工作一样把 Issue 指派给 Agent；Agent 接单、报告进度和阻塞，并将结果交回人工审查。[README](https://github.com/multica-ai/multica#what-is-multica)
- Issue 是长期工作记录，保存目标、上下文、负责人、状态、讨论和执行历史；Run 是一次具体 Agent 执行。同一个 Issue 可以产生多次 Run，历史 Run 不会被覆盖。[Issues](https://multica.ai/docs/issues)、[Runs](https://multica.ai/docs/tasks)
- Agent 开始工作时将 Issue 更新为 `in_progress`，交付后进入 `in_review`；`done` 通常由人确认，或在满足明确的 PR 合并规则时由集成更新。[Issues](https://multica.ai/docs/issues)
- Project 聚合多个 Issue，并提供长期目标、范围、共享要求、仓库和本地目录；Agent 执行项目内 Issue 时会获得项目描述和资源列表作为上下文。[Projects](https://multica.ai/docs/projects)、[Project resources](https://multica.ai/docs/project-resources)
- Agent 有长期身份、说明、Skills、Runtime、模型和权限；Run 可以由 Issue 指派、评论提及、聊天或 Autopilot 触发。[Agents](https://multica.ai/docs/agents-create)、[Assign issues](https://multica.ai/docs/assigning-issues)
- 调研时官方仓库约 **50.6k stars、6.6k forks**，支持自托管和 26 种 Agent CLI；许可证为 Apache-2.0 文本加额外托管、嵌入和品牌条件。[仓库主页](https://github.com/multica-ai/multica)、[README License](https://github.com/multica-ai/multica#license)

**与本产品重合**

- Multica 是当前调研中对“任务无缝衔接 AI 行动”覆盖最完整的近邻：任务/Issue 是稳定业务对象，Agent Run 是可重复的执行实例，进度、阻塞、评论和结果回到原 Issue，最后由人验收。
- 它比 CCB 和 Omnigent 更上层：CCB/Omnigent 主要管理 Agent 运行与会话，Multica 已经把 Agent 执行嵌入项目、Issue、状态看板和人工 Review。
- 它仍不等于本产品方向。Multica 以软件团队和 AI 编码员工为中心，日常体验更接近 Linear/Jira；材料主要是附件、仓库和目录，Skills 主要保存可复用工作方法，没有独立的项目决策、约束、失败经验、来源治理和 supersession 记忆模型。

**可借鉴**

- 明确分离 `Task/Issue` 与 `Handoff Run`：任务长期存在，一次任务可以先由人处理，再交给多个 AI 多次执行；每次执行都有独立状态和历史。
- 采用 `todo → in_progress → in_review → done` 的人机协作语义。Agent 可以交付，但不应默认替用户宣布任务完成。
- 将目标、验收标准、讨论、材料和历史执行结果保留在同一任务脉络中，后续 Run 直接继承，不需要重建上下文。
- Project Context 应显式组装项目目标、共享约束和相关资源，而不是把整个项目数据库或全部聊天历史发送给 Agent。
- Agent 身份、权限、Runtime 与任务解耦，使 CCB、Omnigent 或其他 Provider 可以成为可替换执行端。
- Skills 与 Memory 分开：Skill 是可复用的做事方法，Memory 是项目发生过什么、当前相信什么，两者不应混为一体。

**不建议照搬**

- 不要采用“AI 员工/下一批员工不是人”的产品叙事。本产品的主角应是用户自己的项目，而不是 Agent 团队。
- 不要以团队 Issue Tracker 作为默认体验；个人用户仍需要滴答清单式的收集箱、今天、提醒、快速完成和低认知负担。
- 不要把代码仓库、PR 和 Diff 当作所有项目的主要成果；产品还需容纳调研材料、设计文件、文档、学习记录和非代码项目。
- Issue 历史虽然保留了上下文，但并不自动形成可查询、可修订的项目记忆；仍需 Decision、Constraint、Attempt、Open Question、Artifact 和来源/替代关系。

## 二、任务管理与日常交互

### Super Productivity

仓库：[super-productivity/super-productivity](https://github.com/super-productivity/super-productivity)

**事实**

- 官方定位为带 Timeboxing 和时间跟踪的高级 Todo 应用；支持子任务、项目、标签、颜色、日历及多个项目管理平台的任务导入。[README](https://github.com/super-productivity/super-productivity#-features)
- 任务和项目可以附加笔记、文件以及项目级链接、文件或命令书签；支持本地使用及多种同步方式。[README](https://github.com/super-productivity/super-productivity#-features)
- 调研时仓库约 **22.2k stars、2.1k forks、22k+ commits**，MIT 许可，仓库页显示持续开发。[仓库主页](https://github.com/super-productivity/super-productivity)

**与本产品重合**

- “任务是每天打开的主界面”，项目信息作为任务上下文存在。
- 本地优先、无需先理解知识管理概念，适合作为类滴答清单交互的开源参考。

**可借鉴**

- 快速录入、快捷键、项目/标签/子任务的渐进式复杂度。
- 在任务附近挂上下文，而不是要求用户先进入独立知识库整理材料。
- 外部任务导入后允许用户在本地继续规划，说明“外部来源”和“本地项目认知”可以分层。

**不建议照搬**

- 不要把时间追踪、番茄钟、习惯养成和所有外部任务平台集成一起带入 P0；这些会稀释“项目连续性”。
- 它的 Notes/Attachments 主要是上下文附件，不等于有来源、状态和演化历史的项目记忆。

### Vikunja

仓库：[go-vikunja/vikunja](https://github.com/go-vikunja/vikunja)

**事实**

- 官方定位是 “The task manager you actually own”，是自托管 Todo/项目管理应用。[README](https://github.com/go-vikunja/vikunja#readme)
- 仓库为前后端一体项目，并提供 REST 层、桌面端和插件示例；README 将 roadmap 和完整文档链接到官方站点。[仓库主页](https://github.com/go-vikunja/vikunja)
- 调研时约 **5.5k stars、697 forks、15.7k commits**，主体为 AGPL-3.0-or-later。[仓库主页](https://github.com/go-vikunja/vikunja)

**与本产品重合**

- 项目、列表、任务、过滤/视图、自托管，都是产品的基础外壳。

**可借鉴**

- 把成熟 Todo 能力当作稳定底座，而不是 AI 能力的一部分。
- API-first 的任务模型便于未来让 AI、CLI 和 UI 操作同一套服务。

**不建议照搬**

- 不要在 MVP 阶段追求完整 Todoist/TickTick feature parity。
- Vikunja 的强项是任务管理广度，不是项目材料、决策来源或 AI 接力。

## 三、材料收集与智能整理

### Paperless-ngx

仓库：[paperless-ngx/paperless-ngx](https://github.com/paperless-ngx/paperless-ngx)

**事实**

- Paperless-ngx 把文件消费（consumer）和 Web 管理界面分开；入库时执行 OCR、归档和元数据匹配。[使用文档](https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/usage.md)
- 文档支持 tags、correspondents、document types、storage paths、custom fields、版本历史、批量编辑和 saved views。[使用文档](https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/usage.md)
- 自动匹配可使用规则、模糊匹配或根据已整理样本训练的 Auto 分类器；启用 AI 后还可建议标题、标签、来源方、文档类型、存储路径和日期。[高级用法](https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/advanced_usage.md)
- 默认建议机制强调 inbox：AI 建议可展示给用户，也可由 workflow 按明确字段自动应用。[使用文档](https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/usage.md)
- 调研时约 **45.3k stars、3.1k forks、12k+ commits**，GPL-3.0。[仓库主页](https://github.com/paperless-ngx/paperless-ngx)

**与本产品重合**

- “先扔进收集箱，之后再整理”的零阻力入口。
- 材料保留原件，同时维护可搜索内容、元数据和分类。
- 规则分类与 AI 建议共存，而不是所有整理都依赖 LLM。

**可借鉴**

- 建立明确的材料生命周期：`inbox → 已提取 → 待确认 → 已归档/已关联`。
- AI 应生成字段级建议，并允许用户逐项采纳；不要只给一段不可操作的总结。
- 智能文件夹应实现为 saved query/view，而不是物理移动文件。
- 从用户已经确认的分类中学习，但 inbox 中未经确认的数据不应反向污染分类器。

**不建议照搬**

- 不要把产品做成通用 DMS，也不要在 P0 投入复杂 OCR、邮件消费、文件格式转换。
- 项目材料的关键不是“归档得多完整”，而是它和任务、决策、问题、成果之间的关系。

## 四、长期项目记忆与知识治理

### MemoryWiki

仓库：[MemoryWiki/MemoryWiki](https://github.com/MemoryWiki/MemoryWiki)

**事实**

- MemoryWiki 将项目记忆存储为本地 Markdown/JSONL，记录来源、冲突/更新历史，通过 CLI 和 MCP 召回。[README](https://github.com/MemoryWiki/MemoryWiki#readme)
- 它把记忆分为 episodic、semantic 和 procedural 层；语义记忆带 confidence、strength、source_refs 和 update_log。[README](https://github.com/MemoryWiki/MemoryWiki#why)
- 项目记忆目录明确区分 hot memory、项目概况、episodes、sessions、semantic、procedures、只读 sources、可重建索引和 audit trail。[Memory Layout](https://github.com/MemoryWiki/MemoryWiki#memory-layout)
- MCP 默认只读，写入需要显式环境门控；删除流程默认 dry-run，并要求 reason。[MCP 与删除流程](https://github.com/MemoryWiki/MemoryWiki#mcp)
- README 明确称其为 early public software。调研时约 **3 stars、1 fork、21 commits**，Apache-2.0。[仓库主页](https://github.com/MemoryWiki/MemoryWiki)

**与本产品重合**

- 它几乎直接命中“项目拥有长期记忆”：来源可追溯、冲突不静默覆盖、项目级和全局级记忆分开、AI 写入受控。

**可借鉴**

- 将 `原始证据`、`事件记录`、`稳定认知`、`可复用流程` 分层保存。
- 检索索引、摘要和上下文包都是可重建投影，原始材料与记忆历史才是事实源。
- 记忆修改采用提案、dry-run、显式确认和 audit trail。
- Handoff 产生的 session summary 应成为 episode，再由回顾流程提炼成稳定语义记忆。

**不建议照搬**

- 不要直接暴露目录、CLI 和记忆术语给普通用户；用户的主界面仍应是任务和项目。
- 项目尚早，适合借鉴模型和安全边界，不适合直接依赖为产品核心运行时。

### next-wiki

仓库：[hugogu/next-wiki](https://github.com/hugogu/next-wiki)

**事实**

- next-wiki 定义了一个受治理的知识闭环：conversation/source/command output → append-only raw evidence → AI synthesis/drafts → human review/publication → durable wiki memory。[README](https://github.com/hugogu/next-wiki#why-next-wiki)
- LLM Wiki 模式区分 `raw`、`generated`、`default` 三个空间：原始证据、AI 生成概念、人工整理后的公开知识；生成概念可通过软链接发布，仍保留来源关系。[README](https://github.com/hugogu/next-wiki#a-self-growing-memory-model)
- AI 工具运行时支持提案审批、拒绝、应用、冲突检测、逐项结果、审计和正常的版本/发布边界。[README](https://github.com/hugogu/next-wiki#a-governed-wiki-ai-tool-runtime)
- MCP 服务暴露检索、草稿、发布、revision diff、图导航、tags、raw evidence、批操作和健康检查。[API and MCP](https://github.com/hugogu/next-wiki#api-and-mcp-integrations)
- README 标记为 early open-source release；调研时约 **2 stars、0 forks、1.3k+ commits**，Apache-2.0。[仓库主页](https://github.com/hugogu/next-wiki)

**与本产品重合**

- “原始材料不等于项目记忆”“AI 建议不等于已确认事实”“每次变更必须有来源和审阅边界”与本产品高度一致。

**可借鉴**

- 三层内容模型可以改造成：`Material（原始）→ Memory Proposal（AI 提炼）→ Confirmed Memory（当前有效）`。
- 对多条 AI 整理结果做逐项 preview/approve/reject，而不是一次性全收。
- AI 无工具能力时应降级为只回答，不能假装完成了写入。

**不建议照搬**

- 不要以 Wiki 页面树作为用户主界面；这会把日常用户推回手工知识维护。
- 它的发布、权限、协作体系偏 Wiki/团队场景，个人项目 MVP 可大幅简化。

### Mem0

仓库：[mem0ai/mem0](https://github.com/mem0ai/mem0)

**事实**

- Mem0 定位为 Agent 的 memory layer，支持用户、session、agent 多级记忆和 SDK/API。[README](https://github.com/mem0ai/mem0#introduction)
- 2026 年 README 描述的新算法采用 append-only 提取、实体链接、semantic/BM25/entity 多信号检索与时间推理；项目同时公开评估框架。[README](https://github.com/mem0ai/mem0#new-memory-algorithm-april-2026)
- 官方明确说明 README 中的部分基准来自含专有优化的托管平台，开源 SDK 不能保证完全相同结果。[README](https://github.com/mem0ai/mem0#new-memory-algorithm-april-2026)
- 调研时约 **65k stars、7.6k forks、2.6k commits**，Apache-2.0。[仓库主页](https://github.com/mem0ai/mem0)

**与本产品重合**

- 自动从对话/执行结果中提取事实，并按时间、主体和语义召回，是项目记忆的底层能力之一。

**可借鉴**

- 项目记忆检索不能只依赖向量相似度；关键词、实体、时间和任务关系都应参加排序。
- Agent 的已确认行动也应成为候选记忆，而不只记录用户说过什么。
- 建立可重复的记忆评估集，测试“当前状态”“历史决策”“何时被替代”等问题。

**不建议照搬**

- 不要把“自动抽取的一条事实”直接当作项目当前真相；项目决策需要来源、有效状态、替代关系和人工确认。
- 不要让底层 memory SDK 决定产品领域模型。`Decision`、`Constraint`、`Open Question`、`Attempt` 等仍应是产品自己的对象。

### Khoj

仓库：[khoj-ai/khoj](https://github.com/khoj-ai/khoj)

**事实**

- Khoj 定位为 self-hostable AI second brain，可从 Web 或个人文档回答问题，支持 custom agents、scheduled automations 和 deep research。[仓库主页](https://github.com/khoj-ai/khoj)
- README 列出的文档来源包含 PDF、Markdown、Notion、Word、org-mode 等。[README FAQ](https://github.com/khoj-ai/khoj#frequently-asked-questions-faq)
- 调研时约 **37.4k stars、2.5k forks、5.1k commits**，AGPL-3.0。[仓库主页](https://github.com/khoj-ai/khoj)

**与本产品重合**

- 多来源材料摄取、个人知识检索、可自托管、AI 对话与自动化。

**可借鉴**

- 将多种来源统一成同一检索入口，而不要求用户先改变原文件格式。
- 问答、agent 和 automation 可以共享材料索引，但在 UI 上保持不同入口。

**不建议照搬**

- “AI second brain” 太宽，容易回到聊天框中心；本产品应坚持任务与项目推进中心。
- 文档 RAG 只能回答“材料里有什么”，不能代替“项目当前相信什么，以及为什么”。

### Nowledge Mem：目前最完整的跨 AI 知识连续性参考

- 公开产品仓库：[nowledge-co/nowledge-mem](https://github.com/nowledge-co/nowledge-mem)
- 公开连接器与部署周边：[nowledge-co/community](https://github.com/nowledge-co/community)
- 详细调研：[Nowledge Mem 深度调研](./2026-09-20_nowledge-mem-deep-dive.md)

**事实**

- Nowledge Mem 把 Thread 定义为原始会话层，把 Memory 定义为可脱离原会话独立理解的长期知识单元；文件、来源与生成物进入 Library。[Memories](https://mem.nowledge.co/docs/memories) [Threads](https://mem.nowledge.co/docs/threads)
- Thread 可被 Distill 成多条带类型、标签和重要度的 Memory。Memory 之间通过 `replaces`、`enriches`、`confirms`、`challenges` 四类 EVOLVES 关系保留知识变化历史；冲突交给用户判断，不自动覆盖。[Knowledge evolution](https://mem.nowledge.co/docs/concepts/evolves)
- 多条独立来源收敛后可形成 Crystal；来源变化时系统提出复核，而不是静默重写。近期与重要信息则进入 Space 级 Working Memory，再通过 Context Bundle 注入具体 AI。[Crystals](https://mem.nowledge.co/docs/concepts/crystals) [Context](https://mem.nowledge.co/docs/ai-context)
- Space 是默认读写和召回范围，不是带目标、阶段、依赖和完成定义的 Project。实体图仍是全局的，共享 Space 只改变读取范围。[Spaces](https://mem.nowledge.co/docs/spaces)
- 它区分完整 Thread Capture 与 Handoff Summary：前者保留真实会话，后者只是便于继续工作的摘要，不等于任务派发、状态跟踪或验收协议。[Threads](https://mem.nowledge.co/docs/threads)
- 产品可本地运行、使用官方 Docker 镜像自托管，并支持文本化导出；但服务条款将核心软件声明为 Nowledge Labs 的专有知识产权并禁止逆向。公开 GitHub 仓库不包含核心实现，因此“可自托管”不等于“开源”。[Docker Deployment](https://mem.nowledge.co/docs/docker) [Terms](https://mem.nowledge.co/terms)

**最值得借鉴**

1. 原始证据、原子记忆、稳定综合知识三层分离，而不是直接让 AI 改写唯一一份项目总结。
2. 将 Working Memory 作为有容量约束、可预览和编辑的当前项目 briefing。
3. Context Bundle 按项目范围、Agent 身份、规则和当前焦点动态装配，避免把全部历史塞进 prompt。
4. 保留决策演化链和冲突，不让“最新摘要”抹掉当时为什么做出选择。
5. 同时保留完整会话与轻量 handoff，明确两者的可靠性差异。

**与本产品的边界**

Nowledge Mem 回答的是“人和 AI 已经知道什么、下一个 AI 应先知道什么”；本产品仍应回答“项目下一步做什么、由谁接手、做到什么算完成、结果如何回流”。因此应借鉴它的 `Evidence → Memory → Working Memory → Context Bundle` 管线，但把 Project、Task、Handoff、Artifact 和验收设为一等对象，避免演变成另一个通用知识图谱产品。

## 五、任务、知识与文件的一体化样本

### Zettelgarden

仓库：[Zettelgarden/Zettelgarden](https://github.com/Zettelgarden/Zettelgarden)

**事实**

- Zettelgarden 将 Markdown atomic cards、双向链接、任务、RSS 和本地优先同步放在一个产品中。[README](https://github.com/Zettelgarden/Zettelgarden#readme)
- Task 支持 scheduling、priorities、subtasks、recurring patterns 和 saved searches；文件支持 PDF、图片和文档。[README Features](https://github.com/Zettelgarden/Zettelgarden#features)
- AI 能力包括向量搜索、实体抽取与链接、摘要、主题提取和带引用的 insight generation。[README](https://github.com/Zettelgarden/Zettelgarden#ai-powered-intelligence-pro-features-unlocked-by-default-when-stripe-is-disabled)
- 调研时约 **168 stars、4 forks、3.7k commits**，MIT；README 称项目 actively evolving。[仓库主页](https://github.com/Zettelgarden/Zettelgarden)

**与本产品重合**

- 这是较接近“任务 + 知识 + 文件 + AI”的综合样本。

**可借鉴**

- Task、Card、File 可以是并列对象，并通过链接关联，不必把所有东西塞进任务描述。
- saved searches 与快捷键适合实现智能文件夹和快速录入。
- 历史设计文档标记 `HISTORICAL`/`SUPERSEDED`/`EXECUTED`，值得用于项目决策和设计逻辑的状态表达。

**不建议照搬**

- Zettelkasten 的 atomic card 和手工双链是知识工作者范式，不应成为普通用户的必修课。
- “功能都在一个产品里”不等于形成任务—执行—沉淀闭环；领域关联和状态迁移仍需单独设计。

### TaskClaw

仓库：[taskclaw/taskclaw](https://github.com/taskclaw/taskclaw)

**事实**

- TaskClaw 将 Kanban、AI Chat、Knowledge Base、Notion/ClickUp 双向同步、MCP、Webhooks 和团队协作组合在一起。[README](https://github.com/taskclaw/taskclaw#what-is-taskclaw)
- 它还提供生成 boards、agents、skills 和 knowledge bases 的 Claude Code skills。[README](https://github.com/taskclaw/taskclaw#claude-code-skills-ai-builder)
- 调研时仓库为 **0 stars、0 forks、183 commits**；许可为 Sustainable Use License，并含 enterprise-licensed 目录。[仓库主页](https://github.com/taskclaw/taskclaw)

**与本产品重合**

- 功能列表层面非常接近“任务 + 知识 + AI + MCP”。

**可借鉴**

- Board、Agent、Skill、Knowledge 的导入 bundle 暗示 handoff 可以有机器可读包，而不仅是 prompt 文本。
- Webhook/MCP 适合作为外部 AI 和任务系统的适配层。

**不建议照搬**

- 产品叙事是“AI command center”，与本产品的人类 Todo 主界面不同。
- 功能覆盖非常宽且项目极新；不要把 feature checklist 当成已验证的用户体验。

## 六、AI 接力、任务上下文与会话回收

### Pith

仓库：[SiluPanda/pith](https://github.com/SiluPanda/pith)

**事实**

- Pith 的定位是“AI agents 和 humans 是平等队友的任务管理”；AI 可通过 MCP 读取/更新任务、记录工作、创建子任务。[README](https://github.com/SiluPanda/pith#connect-your-ai-agent)
- MCP 提供 task context 资源，包含完整任务上下文；同时有 `start_session` / `end_session` 记录工作 session 和摘要。[README](https://github.com/SiluPanda/pith#what-your-agent-can-do)
- AI 功能包含 task decomposition、triage、context assembly、effort estimation、sprint summaries 和 duplicate detection。[README](https://github.com/SiluPanda/pith#ai-features)
- 调研时约 **9 stars、1 fork、42 commits**，MIT；仓库 README 声称有 146 tests。[仓库主页](https://github.com/SiluPanda/pith)

**与本产品重合**

- “任务是人和 AI 交接的共同对象”“启动时组装上下文”“结束时回传摘要”与 handoff 闭环高度相似。

**可借鉴**

- Handoff 应有明确 session：接收者、关联任务、开始时间、状态、总结、产物和未完成项。
- `get_context` 不应返回整个项目，而应组装当前任务所需的父任务、相关材料、决策、最近活动和验收标准。
- AI 是可选增强；没有模型时 Todo 仍完整可用。

**不建议照搬**

- 不要把 Agent 做成与人完全同权限的 member；外部 AI 至少要采用范围化能力、最小权限和写入提案。
- Pith 聚焦软件工程任务板，缺少材料治理和可演化项目记忆。

### CCB（Claude Codex Bridge）

仓库：[SeemSeam/claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge)

**事实**

- CCB 是一个可见、可接管的多 Agent CLI 工作区，通过稳定的跨 Provider 协作层连接 Codex、Claude、Gemini 等 CLI Agent，支持 `A → B → C`、`A,B → C` 和 `A → B,C` 等协作图。[README](https://github.com/SeemSeam/claude_codex_bridge#why-ccb)
- Agent 可以通过 `/ask` 异步委派和接力工作；后台 daemon 在前台 UI 关闭后仍维持项目状态，同时保留各 Provider 的原生 terminal 与 session 边界。[README](https://github.com/SeemSeam/claude_codex_bridge#why-ccb)
- CCB 使用项目级 `.ccb/ccb_memory.md` 保存跨 Agent 共享的长期约束、协作规则和 handoff 约定，避免把稳定信息重复写入不同 Provider 的私有记忆。[Config And Shared Memory](https://github.com/SeemSeam/claude_codex_bridge#config-and-shared-memory)
- 调研时仓库约 **3.5k stars、341 forks、1,888 commits**，仍在持续发布。[仓库主页](https://github.com/SeemSeam/claude_codex_bridge)

**与本产品重合**

- CCB 是当前调研中最接近“AI Handoff 接力层”的项目：它已经解决目标 Agent、异步投递、运行状态、会话延续、项目工作区和跨 Agent 共享记忆等基础问题。
- Work With Agent 可以把每个项目任务映射到一次 CCB ask/job/thread，把外部执行状态投影为“等待 AI、处理中、等待输入、已返回、失败”。

**可借鉴**

- 复用 CCB 作为 Provider 适配和运行时层，而不是自行重写 Claude、Codex、Gemini 等 CLI 的会话控制。
- Handoff 记录至少保存 `provider/agent`、外部 job/thread id、派发时间、状态、最后活动、返回结果和产物。
- 区分三类上下文：项目长期记忆、单次任务接力包、Provider 私有会话历史；不要互相替代。
- 保留异步语义。用户派发后可以离开，回到 Todo 中查看状态和接收结果，不必停留在终端或聊天窗口。
- 接力结果必须进入产品自己的“验收与沉淀”流程；CCB 负责可靠送达和延续会话，Work With Agent 负责判断任务是否完成、产生了哪些成果以及应更新哪些项目记忆。

**不建议照搬**

- 不要把终端窗格、Provider 配置、daemon 队列和通信拓扑直接暴露为普通用户主界面；这些应被翻译成任务状态和少量高级诊断信息。
- 不要把 `.ccb/ccb_memory.md` 直接当成完整项目记忆库。它适合共享稳定协作上下文，但缺少材料来源、记忆类型、确认状态、替代关系和面向用户的项目视图。
- 不要把“消息已投递”或“Agent 已回复”视为任务完成；仍需验收标准、成果回收和记忆变更确认。

### Omnigent

仓库：[omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent)；官网：[omnigent.ai](https://omnigent.ai/)

**事实**

- Omnigent 官方定位是运行、组合和治理 AI Agent 的开源 meta-harness，在一个统一层中封装 Claude Code、Codex、Pi 和自定义 YAML Agent，并提供 server、UI、sandbox 和 policies。[官网](https://omnigent.ai/)、[FAQ](https://omnigent.ai/faq)
- 核心对象是可持久化的 Agent session。官方 API 支持创建、读取、恢复、fork、归档、共享 session，也允许父 Agent 创建子 session、派发工作、读取状态和结果。[Programmatic Usage](https://omnigent.ai/docs/programmatic)
- Omnigent 的 Project 是相关 session 的命名容器，并可保存 host、working directory、agent、model 和 worktree 等新 session 默认值；它目前不是项目任务、材料、决策和记忆的领域模型。[Projects](https://omnigent.ai/blog/first-class-projects-with-defaults)
- Scheduled Task 是按周期保存并派发 prompt、agent 和执行位置，到期创建 Agent session 的自动化任务，不是人的 Todo、截止提醒或子任务系统。[Scheduled Tasks](https://omnigent.ai/docs/build/scheduled-tasks)
- 调研时官方仓库约 **10.1k stars、1.6k forks、3.9k commits**，但官方仍将产品标记为 alpha。[仓库主页](https://github.com/omnigent-ai/omnigent)、[FAQ](https://omnigent.ai/faq)

**与本产品重合**

- Omnigent 与 CCB 处于相同的大层级：负责把工作交给不同 Agent，持久化会话，恢复和分叉上下文，观察子 Agent 状态，并在多端继续协作。
- 它比 CCB 更偏完整平台，提供 Server/Web/Desktop/Mobile、REST/SDK、共享会话、OS 沙箱、审批和预算策略；CCB 更轻，更接近本地多 CLI 可见协作。
- 它不是当前产品方向的直接竞品。它的 Project 主要组织 session，结果主要留在 transcript、tool result、文件、diff 和 PR 中，没有形成“人类 Todo → 材料 → 项目记忆 → handoff → 结果回收”的业务闭环。

**可借鉴**

- Project 为新 session 提供默认 Agent、目录、模型和 worktree，适合转化为本产品的“项目执行配置”。
- 将 Provider 私有 session 与产品任务分离，通过外部 session id 建立映射；支持 resume、fork、import 和 child-session tree。
- 借鉴 Canvas/状态树展示正在进行、等待输入和已完成的 Agent 工作，但在主界面中将其投影为任务状态。
- 使用策略层控制文件、网络、成本、工具和审批，而不是把安全完全交给 Prompt。
- 可将 Omnigent 作为 CCB 之外的第二个执行适配器：本产品输出标准 Handoff 包，Omnigent 负责路由、执行、恢复和返回运行结果。

**不建议照搬**

- 不要采用 chat/session-first 的产品结构。用户主界面仍应是收集箱、今天、项目和等待确认，而不是会话列表。
- 不要把 Project 降为 session 文件夹，也不要把 Scheduled Task 当成人的 Todo。
- 不要把完整 transcript 或 Agent recall 当作项目记忆；项目事实仍需来源、类型、人工确认、有效状态和 supersession。
- 不要在 P0 复制 Omnigent 的多 Agent 编排、完整沙箱、团队实时协作和多端运行平台，这会吞噬产品核心闭环。

### Agent Relay

仓库：[AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)

**事实**

- Agent Relay 提供跨 Agent 的 channels、threads、DM、files、search 和实时事件，Agent 可以跨机器协作。[README](https://github.com/AgentWorkforce/relay#messaging)
- Shared Sessions 用于捕获 coding agent sessions，以便搜索过去的工作、决策和上下文。[README](https://github.com/AgentWorkforce/relay#shared-sessions)
- Flows 用 TypeScript 定义带 deterministic checks、required steps 和 human gates 的工作流。[README](https://github.com/AgentWorkforce/relay#flows)
- 调研时约 **847 stars、65 forks、4.9k commits**，Apache-2.0。[仓库主页](https://github.com/AgentWorkforce/relay)

**与本产品重合**

- CCB handoff 的关键问题——身份、消息投递、状态、共享文件、历史 session、人工门控——在 Relay 中都有对应基础设施。

**可借鉴**

- 把接力分成三个层次：稳定身份/会话、消息与附件投递、业务层 handoff contract。
- 外部 AI 返回的不只是最终文本，还应有状态、事件、文件和可检索线程。
- 对关键接力流程采用确定性检查，例如“必须返回总结、产物、未决问题后才能进入待验收”。

**不建议照搬**

- 不要在产品内部重建一个 Agent Slack；用户应看到任务状态，不是代理聊天频道。
- Relay 是基础设施，不能替代项目记忆抽取、任务验收和结果沉淀。

## 七、优先项目交叉验证（紧凑对照）

这一组用于补齐“成熟项目管理、一体化工作空间、记忆底座、跨 Agent 接力”的边界。表中“事实”来自各仓库 README/文档；“启示/不照搬”是本调研的产品分析。活跃度均为 **2026-09-20** GitHub 页面快照。

| 项目 | 定位与核心能力（事实） | 对本产品的相关性（分析） | 可借鉴 / 不建议照搬 | 活跃度与来源 |
|---|---|---|---|---|
| [CCB](https://github.com/SeemSeam/claude_codex_bridge) | 可见、可接管的多 Agent CLI 工作区；支持多 Provider、后台 daemon、`/ask` 委派、原生 session 与项目共享记忆 `.ccb/ccb_memory.md`。[README](https://github.com/SeemSeam/claude_codex_bridge#why-ccb) | 最接近目标产品所说的“handoff 接力层”，但不是面向人的项目管理产品。 | 借鉴稳定 Agent 身份、异步投递、可恢复状态和共享记忆边界；不要把终端拓扑与 provider 运行细节暴露为主界面，也不要把“通信成功”误当“任务已沉淀”。 | 约 **3.5k stars、341 forks、1,888 commits**。[仓库主页](https://github.com/SeemSeam/claude_codex_bridge) |
| [CTP](https://github.com/context-transfer-protocol/ctp-spec) | 面向平台/Agent/模型间上下文移交的开放 JSON 标准；context capsule 表达 purpose、role、instructions 及 people/companies/files 等元数据；它定义 payload，不定义 transport/runtime，并声明与 MCP 互补。[README](https://github.com/context-transfer-protocol/ctp-spec#readme) | 适合作为 handoff 导出格式的语义参考，不能单独完成任务生命周期、授权裁剪或结果回收。 | 借鉴版本化、可移植 capsule；不要在 P0 直接押注一个只有少量实现验证的完整行业标准。 | **11 stars、2 forks、2 commits**。[仓库主页](https://github.com/context-transfer-protocol/ctp-spec) |
| [showagent](https://github.com/aytzey/showagent) | 发现本地 Codex/Claude/Gemini/OpenCode 等 session，预览并把 user/assistant 消息转换为另一 Agent 的原生 session；支持 TUI、CLI、MCP、dry-run 与秘密信息脱敏；工具调用、审批、附件和运行时状态不会被假装成可移植内容。[README](https://github.com/aytzey/showagent#readme) | 直接验证“跨 Agent 延续对话”有真实需求，也清楚展示 transcript handoff 的信息损耗。 | 借鉴“先预览、原 session 不变、标记不可信输入、明确丢失项”；不要把整段聊天历史当项目记忆或默认全量发送。 | **48 stars、4 forks**。[仓库主页](https://github.com/aytzey/showagent) |
| [memkeeper](https://github.com/teflon07/memkeeper) | 本地优先、确定性的 Agent 记忆库：SQLite + BM25，选配本地 ONNX 语义检索/交叉编码 rerank、图投影与 MCP；核心路径不要求网络或 LLM。[README](https://github.com/teflon07/memkeeper#readme) | 适合做离线、可预测的检索底座；它解决“怎么找”，不解决“哪些内容应成为项目事实”。 | 借鉴本地可降级检索与确定性基线；不要先上复杂图/embedding，也不要绕过来源、审核和 supersede 生命周期。 | **2 stars、0 forks、49 commits**，仍属早期参考。[仓库主页](https://github.com/teflon07/memkeeper) |
| [Leantime](https://github.com/Leantime/leantime) | 面向“非项目经理”的开源项目管理系统，把目标/战略、计划与执行连接起来；含 Kanban/Gantt/list/calendar、子任务依赖、目标指标、Wiki/Docs、文件、讨论与插件/API。[README](https://github.com/Leantime/leantime#-features) | 证明“项目目标—工作项—知识/文件”可以在同一信息架构中成立，但核心面向团队 PM，而非个人项目连续性。 | 借鉴渐进式复杂度和从目标到执行的导航；不要复制 Jira 化字段、管理画布和团队治理全家桶。 | **11.6k stars、1.1k forks**，仓库近期仍有版本发布。[仓库主页](https://github.com/Leantime/leantime)、[Releases](https://github.com/Leantime/leantime/releases) |
| [Plane](https://github.com/makeplane/plane) + [官方 MCP](https://github.com/makeplane/plane-mcp-server) | Plane 管理 work items、cycles、modules、views、pages 等；官方 MCP 以 30 个资源工具覆盖 204 个操作，支持 stdio/HTTP、OAuth/API key。[Plane README](https://github.com/makeplane/plane#readme)、[MCP README](https://github.com/makeplane/plane-mcp-server#readme) | 是“成熟项目对象模型 + AI 可操作接口”的强参考，但其 AI 接入主要是操作已有 PM 对象，并不自动形成项目记忆。 | 借鉴资源级工具、查询语言、范围化认证和兼容层；不要把 204 个操作直接暴露给模型或把团队 issue tracker 当个人 Todo。 | Plane **59.7k stars、5.8k forks**；MCP **325 stars、178 forks、98 commits**。[Plane](https://github.com/makeplane/plane)、[MCP](https://github.com/makeplane/plane-mcp-server) |
| [AppFlowy](https://github.com/AppFlowy-IO/AppFlowy) | 本地优先、可自托管的开源 Notion 替代品，主张把 projects、wikis、teams 与 AI 放在同一工作空间，并保留数据控制权。[README](https://github.com/AppFlowy-IO/AppFlowy#readme) | 是材料、文档、数据库和任务共存的成熟壳层参考；但自由块/页面结构不天然等于受治理项目记忆。 | 借鉴本地优先、块式内容与多视图；不要从“通用工作空间”起步，避免首页空白和建模负担。 | **76.9k stars、6.0k forks**。[仓库主页](https://github.com/AppFlowy-IO/AppFlowy) |
| [Graphiti](https://github.com/getzep/graphiti) | 为 Agent 构建时态知识图谱：事实有有效期，旧事实失效但保留历史；每个事实可追溯到原始 episode，并结合语义、关键词和图遍历检索，提供 MCP。[README](https://github.com/getzep/graphiti#graphiti) | 对“历史决策为什么变化”和“当前什么仍有效”很关键，但属于记忆基础设施而非用户产品。 | 借鉴 episode provenance、validity window、自动失效和混合检索；P0 不要承担独立图数据库和大规模自动本体构建。 | **984 commits**，仓库页面显示 **3.2k forks**，活跃但基础设施较重。[仓库主页](https://github.com/getzep/graphiti) |

**交叉验证后的结论（分析）**：CCB/showagent/CTP 分别解决运行时协作、session 转换和交换格式；Plane/Leantime/AppFlowy 解决已有对象的组织与展示；memkeeper/Graphiti 解决检索和时态事实。仍没有一个项目把这些能力收束为“以人的 Todo 为入口、以项目记忆为事实源、以 handoff 为执行桥梁、以结果回收为闭环”的轻量产品。

## 关键空白与产品机会

以下为基于上述项目的综合分析：

1. **任务工具不维护项目为何变成现在这样。** Super Productivity、Vikunja 能很好地回答“接下来做什么”，但不负责决策来源、失败尝试和当前有效认知。
2. **知识工具不负责推进。** Khoj、next-wiki、MemoryWiki 能回答和整理，但用户每天不会自然地从一条记忆进入下一步行动。
3. **Agent 记忆通常围绕对话主体，不围绕项目事实。** Mem0 擅长抽取和召回事实，但项目需要明确的 Decision、Constraint、Question、Attempt、Artifact 和替代关系。
4. **Agent 任务板主要服务 AI 执行。** Pith、Todo-for-AI、TaskClaw 的叙事更接近让 Agent 操作任务板；本产品应以人类注意力和记忆为中心。
5. **接力基础设施不负责业务闭环。** Agent Relay/CCB 能把上下文送过去，但“哪些上下文该送、返回后更新什么”仍是产品价值。
6. **材料自动整理与项目记忆之间尚未连通。** Paperless-ngx 证明 inbox + suggestions + saved views 可行，但它不会把材料变成项目决策与任务缘由。

因此，最明确的差异化可表达为：

> 一个以 Todo 为日常入口、以项目档案为长期事实源、以 handoff 为跨 AI 执行桥梁的个人项目连续性工具。

## 对能力设计的建议

### P0：验证唯一核心闭环

1. **收集箱**
   - 接收一句话、文本、文件和链接。
   - 所有输入先成为原始 `InboxItem/Material`，不因 AI 判断失败而丢失。

2. **字段级整理建议**
   - AI 建议：所属项目、任务、材料类型、候选决策、约束、未决问题。
   - 采用 Paperless/next-wiki 风格的逐项预览、确认和撤销。

3. **项目档案最小模型**
   - 当前目标、当前状态、Decision、Constraint、Open Question、Attempt。
   - 每条记忆保存 source refs、created_at、status、supersedes/superseded_by。
   - 原始材料不可被 AI 静默覆盖。

4. **面向人的 Todo 主界面**
   - 先实现收集箱、今天、项目、等待确认、等待 AI。
   - 学习 Super Productivity 的快速录入和渐进式详情，不追求完整日历/习惯/番茄钟。

5. **标准 Handoff 包**
   - 任务目标、背景、相关材料、有效决策、约束、已尝试方案、验收标准、返回格式。
   - P0 可以先导出 Markdown/JSON 并手动粘贴，不必立即实现所有 Agent 直连。

6. **结果回收**
   - AI 返回后生成变更提案：完成任务、新建任务、保存 Artifact、新增/替代记忆、记录失败尝试。
   - 用户确认后才改变任务和项目认知。

### P1：形成持续使用优势

1. 接入 CCB/其他 Provider，记录可恢复的 Handoff session、外部 thread id、状态和产物。
2. 建立混合召回：关键词 + 语义 + 实体 + 时间 + 显式关系，参考 Mem0，但返回必须带 source refs。
3. 增加智能视图：待整理材料、缺少上下文的任务、与旧决策冲突的新材料、AI 已返回待验收、长期停滞项目。
4. 增加记忆冲突/替代流程，而不是直接修改旧记录。
5. 通过每日/每周回顾把 episode/session 提炼为稳定项目记忆。
6. 建立 handoff 质量指标：用户额外补充背景的次数、AI 追问率、返回结果可直接验收率、结果沉淀率。

### P1 之后再考虑

- 完整 TickTick 替代能力（复杂日历、习惯、跨端提醒）。
- 通用 Wiki/双链知识图谱。
- 团队实时协作与企业权限。
- 通用 Agent 编排和聊天频道。
- 完整 OCR/DMS 与大量第三方同步。

## 推荐深入阅读（按优先级）

1. [Nowledge Mem 深度调研：Thread、Memory、EVOLVES、Working Memory 与 Context Bundle](./2026-09-20_nowledge-mem-deep-dive.md)
2. [MemoryWiki README：分层记忆、来源、冲突和写入门控](https://github.com/MemoryWiki/MemoryWiki#readme)
3. [next-wiki README：raw/generated/curated 与 AI proposal review](https://github.com/hugogu/next-wiki#readme)
4. [Multica Issues：Issue 与 Run 分离、状态回写和人工 Review](https://multica.ai/docs/issues)
5. [Pith README：任务上下文组装与 Agent session](https://github.com/SiluPanda/pith#readme)
6. [Paperless-ngx Advanced Usage：规则分类、自动分类与 AI 建议](https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/advanced_usage.md)
7. [Paperless-ngx Usage：inbox、saved views、版本与 workflow](https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/usage.md)
8. [Super Productivity README：任务流与项目上下文附件](https://github.com/super-productivity/super-productivity#-features)
9. [Zettelgarden README：Tasks、Cards、Files 的组合](https://github.com/Zettelgarden/Zettelgarden#readme)
10. [Agent Relay README：shared sessions、messaging、human gates](https://github.com/AgentWorkforce/relay#readme)
11. [CCB README：跨 Provider 协作、原生 session 与共享记忆边界](https://github.com/SeemSeam/claude_codex_bridge#readme)
12. [Omnigent Programmatic Usage：持久 session、fork 与子 Agent 接力](https://omnigent.ai/docs/programmatic)
13. [Graphiti README：episode 来源、时态事实与混合检索](https://github.com/getzep/graphiti#graphiti)

## 最终建议

不要把这些参考项目拼成一个“大而全”的功能清单。产品第一阶段只需要做到一个别人尚未做顺的瞬间：

> 用户打开一个几周没碰的任务，立即看懂它为什么存在、当时做过什么决定、材料在哪里、下一步是什么；交给任意 AI 后，结果还能回到同一条项目脉络中。

如果这个瞬间足够可靠，Todo、材料、记忆和 handoff 才会被用户理解为一个产品，而不是四个模块。
