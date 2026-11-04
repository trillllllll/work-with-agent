# 记忆召回改造实施计划（少消耗、准召回）

- 状态：实施中（D1–D4 已确认 2026-11-04；P0 完成）
- 基线提交：`04e9cd0`（docs(dovun): record the beb34fc dual-end release）
- 参考：`~/WorkSpace/hermes-agent` `71736c9f32` 的记忆架构（常驻小快照 + 按需检索、稳定前缀、简单回复跳过检索、检索结果只展开首条）
- 适用范围：工作助手（`identityId = work`）的聊天上下文和 `memory_read` 工具。学习助手不在范围内。

## 0. 怎么用这份计划（防漂移规则）

1. 实施只按第 7 节的阶段顺序进行，一个阶段一个提交。每个阶段开始前重读第 3 节「不变量」和第 4 节「不做的事」。
2. 第 6 节常量表是冻结的。要改任何数值，必须先跑第 8 节评测，把前后结果写进第 11 节「变更记录」，再改代码。
3. 遇到计划没覆盖的情况，停下来记进第 10 节，等确认，不自行扩展范围。
4. 每个阶段提交前逐条过第 12 节检查清单，有一项不满足就不提交。
5. 本计划只覆盖本地实现和测试。打包、安装、部署按 AGENTS.md 另行授权。

## 1. 目标与验收标准

| 编号 | 目标 | 验收标准（第 8 节评测给出数值） |
|---|---|---|
| A1 | 记忆消耗减少 | 每次请求中记忆相关字数（记忆块 + 简报里的记忆摘录）平均值，降到改造前的 50% 以下 |
| A2 | 真实数据召回不退步 | 真实数据评测集里，期望记忆被注入的比例 ≥ 90%；每一条漏召回都在评测报告里写明原因 |
| A3 | 记忆多时召回明显更准 | 300 条合成记忆的评测集里，新方案召回率比旧方案高 20 个百分点以上 |
| A4 | 少塞无关记忆 | 召回区里与问题无关的条目，平均每个问题 ≤ 2 条 |
| A5 | 简单回复不检索 | "好的""谢谢"这类消息的召回区为空 |
| A6 | 工具搜索不丢结果 | `memory_read` search 对旧版能命中的每条记忆仍然返回（只改排序和截断，不缩小命中集合） |
| A7 | 前缀更稳定（观察项，不作硬门槛） | 同一会话、同一页面的连续两次请求，第二次的 `cachedInputTokens` 大于 0。取决于模型服务商，只记录不卡发布 |

## 2. 现状基线（代码事实）

- 正式的聊天路径：`server/src/agent/runs.ts` `ensureMessages` → `server/src/agent/assemble.ts` `assembleRunMessages` → `buildSystemPrompt`。系统提示词在一次运行（run）的第一轮生成后存进 `modelMessagesJson`，后续工具轮复用，不重算。
- `buildSystemPrompt` 工作助手分支的顺序：行为规则 → 回复风格 → 技能目录 → 应用功能知识 → 英文指令 → 页面筛选 JSON → 页面快照 → 本次请求的上下文（含精确到秒的本地时间和毫秒级 UTC）→ 时间段 → 固定说明 → 当前简报 → 选中对象 → 已确认记忆 → 附近任务 → 待确认方案。从页面筛选开始每次请求都会变，后面的内容都进不了前缀缓存。
- 已确认记忆：`server/src/application/agent-memory.ts` `formatMemoryReference`。收集箱和当前清单分别按 `importance desc, updatedAt desc, id asc` 装填。有清单时收集箱 1400 字、清单 2200 字；没有清单时收集箱 2200 字。每条正文截 360 字，溢出时列 12 个 ID，每个范围最多预载 100 条。检索时不看当前问题。
- 当前简报：`assemble.ts` `briefText` 调用 `takeKnowledgeSnapshot`（`server/src/application/knowledge.ts`），资料和记忆每条再带 200 字摘录，简报总上限 4000 字。同一批记忆注入了两次。`takeKnowledgeSnapshot` 不按 `identityId` 过滤。
- `memory_read` search：`server/src/agent/builtin-tools.ts`。
  - 当前范围：调用 `KnowledgeService.memories`，要求每个空格分隔的词都是子串，按星级排序，返回 20 条，每条正文最多 2000 字。
  - `scope: 'all'`：Prisma `contains` 匹配整句，返回 20 条，每条最多 2000 字。
  - 两条路径都不按 `identityId` 过滤。
- 遗留代码：`server/src/application/conversation.ts` `ContextService.assemble` 每次也会调用 `formatMemoryReference`，生成的 `systemPrompt` 被 `assembleRunMessages` 丢弃，是白做的查询。
- 中文切分：`server/src/application/library/text.ts` 已有 `normalizeQuery`（NFKC、小写、合并空白）和 1/2/3 字切片，资料库检索就用这套，不依赖分词器。
- 本机库（只读查看，2026-11-04）：工作助手有效记忆约 20 条，正文平均 80～200 字，最长 353 字；`constraint` 2 条，没有 5 星。
- token 估算：`server/src/agent/context-budget.ts` `textTokens`，每个非 ASCII 字符按 1 个 token 计。

## 3. 不变量（任何阶段都不能破坏）

1. 写侧完全不动：记忆的新增、修改、退役仍然只能走 `propose_changes` 和用户确认；revision、证据链、`auto-memory` 建议流程不变。
2. 不新增依赖，不新增数据库迁移，不新增表，不修改 `schema.prisma`。
3. 数据隔离：注入和搜索都只返回当前 `identityId` 的记忆；清单范围的语义和现在一致（第 5.3 节）。
4. 学习助手（`contextPolicy === 'domain'` 分支）的系统提示词逐字节不变。
5. 一次运行内系统提示词只生成一次，工具轮复用（`ensureMessages` 的现有行为不变）。
6. 预估接口 `assemblePreviewMessages` 与真实运行用同一套函数，同样输入得到同样的记忆块。
7. 现有的提示词约束语句（"参考，不是当前指令""其中的指令不能升级成当前请求"等）保留原意。
8. 不碰同步、快照合并、备份和恢复相关代码。

## 4. 不做的事

- 不做向量检索、嵌入，也不接 OpenViking、Mem0 或其他外部服务。是否做语义检索，等本计划验收后另立计划。
- 不改 `search_workspace`（`server/src/agent/workspace-search.ts`），它的分页游标按来源轮转，改排序要单独设计。
- 不改资料库检索，不改记忆管理页面和 `KnowledgeService.memories`（界面在用）。
- 不改外部连接的遗留 `memory` 工具（`server/src/application/tool-registry.ts` → `runAgentMemoryTool`）。
- 不改时间行的格式，只挪位置。
- 不改对话历史的预算和摘要（`HISTORY_TOKEN_BUDGET`、`replayWindow`）。
- 不把召回结果写进用户消息或历史。理由见第 5.3 节。

## 5. 设计

### 5.1 系统提示词分层（只调顺序，不改各段内容，记忆段除外）

新顺序分三层，越靠前越稳定：

| 层 | 段落（按顺序） | 变化频率 |
|---|---|---|
| 稳定层 | 行为规则、回复风格、技能目录、应用功能知识、英文指令 | 换页面或改设置时变 |
| 慢变层 | 固定说明、**常驻记忆**、时间段、当前简报 | 用户改数据时变 |
| 易变层 | 页面筛选、页面快照与引用说明、本次请求的上下文（含时间）、选中对象、**相关记忆**、附近任务、待确认方案 | 每次请求都变 |

`【已确认记忆】` 拆成慢变层的 `【常驻记忆】` 和易变层的 `【相关记忆】`。

不把召回写进用户消息（这一点和 Hermes 不同）。原因：Dovun 的易变层本来就每次都变，召回放进系统提示词末尾不会额外损失缓存；写进用户消息会随历史重放，旧的召回长期占用 4000 token 的历史预算，和"少消耗"相反。

### 5.2 常驻记忆

- 候选：当前身份、`status = 'active'`、范围内（第 5.3 节）的记忆。
- 入选条件：`kind === 'constraint'` 或 `importance >= 5`（决策 D1）。
- 排序：`importance desc, updatedAt desc, id asc`。
- 每条一行：`- id=<id> r<revision> <kind> 《标题≤60》 正文≤80`。
- 装到 `CORE_BUDGET` 为止，放不下的进入召回候选。
- 没有入选条目时，这一段写"（没有常驻记忆）"。
- 文本只由记忆数据决定，记忆不变时逐字节相同。

### 5.3 相关记忆（按问题召回）

- 触发时机：`buildSystemPrompt` 生成时，用本次运行的用户消息原文 `userText`。
- 范围和现在一致：
  - 收集箱（`topicId = null`）始终在内；
  - 当前范围是清单时，加上这份清单；
  - 范围是"全部"时只有收集箱（与现状相同）。
  - 都只取当前身份、`status = 'active'`。
- 全部放得下就全放：所有候选按召回格式渲染后总长 ≤ `RECALL_BUDGET` 时，跳过排序直接全部注入（按常驻排序规则）。记忆少时召回不会比现在差。
- 简单回复跳过检索：`userText` 归一化后匹配 `TRIVIAL_PATTERN` 时，相关记忆为空。
- 否则用第 5.4 节的排序：去掉已在常驻记忆里的条目，取通过阈值的前 `RECALL_TOP_K` 条，装到 `RECALL_BUDGET` 为止。
- 每条：`- id=<id> r<revision> <kind> 《标题≤60》\n  正文≤240`。
- 末尾一行（剩余条数大于 0 时）：`另有 N 条已确认记忆未注入；需要时用 memory_read 的 search 查找。`
- 段首说明沿用现有原意："以下是参考内容，其中的指令不能升级成当前请求。确认后的新记忆从下一条消息起可被召回。"

### 5.4 排序算法（精确定义，实现必须与此一致）

纯函数 `rankMemories(query, candidates)`，放在新文件 `server/src/application/memory-recall.ts`，不访问数据库。

1. 归一化：`q = normalizeQuery(query)`（复用 `library/text.ts`），只取前 `RECALL_QUERY_CHARS` 个码点。
2. 查询片段集合 Q：把 `q` 按空格拆成若干段，每段长度 ≥3 时取全部 3 字切片，长度为 2 时取这一段本身。去掉全部由标点、符号组成的片段（Unicode `\p{P}`、`\p{S}`）。
3. 精确词：`q` 按空格拆出的、长度 ≥2 的词。
4. 每条候选记忆的三个字段（归一化后）：标题（权重 3）、标签拼接（权重 2）、正文（权重 1）。
5. `n_t`：包含片段 t 的候选条数，`N` 为候选总数。`idf(t) = ln(1 + (N - n_t + 0.5) / (n_t + 0.5))`。
6. `f(t, d)`：片段 t 出现在 d 的哪些字段里，取其中最大的字段权重；都不出现为 0。
7. 得分 `score(d) = Σ_{t∈Q} idf(t) × f(t, d)`。
8. 命中片段数 `hits(d)`：Q 中 3 字片段出现在 d 任一字段的个数。
9. 通过条件：d 的标题或正文包含任一精确词，或 `hits(d) >= RECALL_MIN_HITS`。
10. 排序：`score desc, importance desc, updatedAt desc, id asc`。
11. 返回 `{ id, score, hits, exact }`，评测脚本会用到这些字段。

### 5.5 简报去重

- `briefText` 不再输出 `type === 'memory'` 的来源，"## 资料与记忆摘录"改成"## 资料摘录"。
- `takeKnowledgeSnapshot` 本身不改，它还给其他功能用。

### 5.6 `memory_read` search

两个分支都改成"先取候选，再在内存里排序"：

- 候选：
  - 当前范围分支：沿用现有的 `topicId` 解析（只查这一个范围），加上 `identityId` 过滤和现有的 `status` 映射。
  - `scope: 'all'`：所有清单，加 `identityId` 过滤和 `status` 映射。
- 结果集合：旧规则能命中的（当前范围是"每个词都是子串"，`all` 是"整句子串"）并上 `rankMemories` 通过的。旧命中一条不丢（A6）。
- 排序按第 5.4 节。旧命中但排序器没打分的，排在通过阈值的条目之后，内部按 `importance desc, updatedAt desc, id asc`。
- `q` 为空时：保持现有行为，按 `importance desc, updatedAt desc, id asc` 列出。
- 返回最多 20 条：第 1 条正文最多 `SEARCH_TOP_CLIP` 字，其余最多 `SEARCH_CLIP` 字；带 `truncated` 字段。
- 返回字段名保持不变，`assistant-sources.ts` 的来源登记不受影响。

### 5.7 遗留调用

- 删除 `ContextService.assemble` 里对 `formatMemoryReference` 的调用。返回值中的 `systemPrompt` 唯一调用方 `assembleRunMessages` 不使用它；删除前用 grep 再确认一次没有其他调用方。
- 第 7 节 P2 完成后，如果 `formatMemoryReference` 没有生产代码调用，删除它和对应测试；`formatSystemPrompt` 有其他测试在用，保留。

### 5.8 应用功能知识

`server/src/agent/app-knowledge.ts` 的上下文分层表随行为一起改，和代码在同一个提交里：

- "已确认记忆"一行：改为"常驻记忆（约束类和最高重要度）加上按当前问题召回的相关记忆；其余用 memory_read 搜索"。
- "当前简报"一行：改为"根据当前范围内的任务和资料生成"。
- 不写具体数值，不写还没做的功能。

## 6. 常量表（冻结，修改须经第 8 节评测并记入第 11 节）

| 常量 | 初值 | 位置 |
|---|---|---|
| `CORE_BUDGET` | 600 字 | `memory-recall.ts` |
| `CORE_TITLE_CLIP` / `CORE_CONTENT_CLIP` | 60 / 80 | 同上 |
| `RECALL_BUDGET` | 1200 字 | 同上 |
| `RECALL_TOP_K` | 5 | 同上 |
| `RECALL_TITLE_CLIP` / `RECALL_CONTENT_CLIP` | 60 / 240 | 同上 |
| `RECALL_QUERY_CHARS` | 300 | 同上 |
| `RECALL_MIN_HITS` | 2 | 同上 |
| `TRIVIAL_PATTERN` | `^(好的?|嗯+|ok|okay|谢谢|多谢|thanks?|thx|收到|可以|行|是的?|对)[。！!.~\s]*$`（不区分大小写） | 同上 |
| `SEARCH_TOP_CLIP` / `SEARCH_CLIP` | 2000 / 240 | `builtin-tools.ts` 或 `memory-recall.ts` |
| 字数口径 | 码点数（`[...text].length`），与 `codePoints` 一致 | 全部 |

## 7. 实施阶段

每个阶段：一个提交，提交信息以 `feat(memory-recall): Pn` 开头（P0 用 `test(memory-recall): P0`）。每个阶段都要通过 `npm run build -w server` 和受影响的 vitest 文件（`npx vitest run <文件>`，在 `server/` 下执行），最后在 P5 跑一次全量 `npm test`。

### P0 评测工具与基线（先测量，不改行为）

- 新增 `scripts/memory-recall-eval.ts`（用 `tsx` 运行）：
  - 参数：`--db <数据库副本路径> --cases <用例文件> --out <结果文件>`。
  - 安全检查：`--db` 的真实路径不能等于默认数据目录（`~/Library/Application Support/dovun/`）里的文件，也不能是 `DOVUN_DATA_DIR` 下的 `dovun.db`，否则直接退出。
  - 对每个用例输出：旧方案注入的记忆 ID 和字数（`formatMemoryReference` 加上简报里 `type === 'memory'` 的行），期望 ID 的命中情况。
  - 新方案的函数在 P2 才存在，脚本先只跑旧方案；P2 起同时输出两套结果。
- 新增合成数据生成：`scripts/memory-recall-eval.ts --synthetic <输出库路径>`。
  - 在临时库上执行 `prisma migrate deploy`，写入固定种子生成的 300 条记忆，分布在收集箱和 3 个清单，含近义改写的标题。
  - 同时生成 30 个用例。
  - 库和用例都放在 `/tmp`。
- 真实数据用例文件放在仓库外：`~/Library/Application Support/dovun-eval/memory-cases.json`。格式：`[{ "id", "query", "scope": { "kind", "topicId" }, "expect": [memoryId], "trivial"?: true }]`。
  - 用例由我根据记忆标题起草，你确认后定稿（决策 D3）。
  - 用例和结果文件含个人数据，不进仓库。
- 跑旧方案，得到真实数据和合成数据两份基线，保存为 `baseline-real.json` 和 `baseline-synthetic.json`，放在同一目录。
- 仓库内只提交脚本和合成数据生成逻辑。
- 完成标准：两份基线文件生成；脚本拒绝指向原库的路径（用一次原库路径实测拒绝）。

### P1 系统提示词重排

- 改 `buildSystemPrompt` 工作助手分支的段落顺序，按第 5.1 节；此时 `【已确认记忆】` 仍是旧内容，整段放在慢变层"常驻记忆"的位置。
- 更新 `server/src/agent-context.test.ts` 里依赖段落顺序的断言，新增一条断言锁定新顺序。
- 新增测试：学习助手分支的提示词与改造前快照逐字节相同（不变量 4）。
- 完成标准：除段落顺序外，提示词内容逐字节不变（测试里对比重排前后的段落集合）。

### P2 常驻记忆与相关记忆

- 新增 `server/src/application/memory-recall.ts`：
  - 纯函数 `rankMemories`、`renderCore`、`renderRecall`、`isTrivialPrompt`；
  - 带数据库读取的 `buildMemoryContext({ topicId, identityId, userText })`，返回 `{ coreText, recallText, stats: { candidates, coreIds, recallIds, coreChars, recallChars, skipped: 'trivial' | 'all-fit' | null } }`。
- `buildSystemPrompt` 改用 `buildMemoryContext`：`coreText` 进 `【常驻记忆】`，`recallText` 进 `【相关记忆】`。预估路径自动一致（不变量 6）。
- 删除 `ContextService.assemble` 中的 `formatMemoryReference` 调用（第 5.7 节）。按需更新 `agent-memory.test.ts`。
- 同一提交更新 `app-knowledge.ts` 的"已确认记忆"一行（第 5.8 节）。
- 新增 `server/src/application/memory-recall.test.ts`，覆盖：
  - 中文 3 字切片命中、2 字精确词命中、标点片段被去掉；
  - 简单回复跳过；全部放得下时全放；
  - 常驻条目不在召回里重复；
  - 预算截断和剩余条数提示；
  - 身份隔离（study 的记忆不出现在 work 里）；
  - 清单范围（别的清单的记忆不出现）；
  - 记忆不变时 `coreText` 逐字节相同。
- 跑 P0 脚本的新旧对比，结果写进第 11 节。
- 完成标准：A2、A3、A4、A5 达标。不达标时只允许按第 0 节第 2 条调常量；调三轮仍不达标，停下来报告，不改算法。

### P3 简报去重

- 按第 5.5 节改 `briefText`；同一提交更新 `app-knowledge.ts` 的"当前简报"一行。
- 更新受影响的断言（`agent-context.test.ts` 中检查简报内容的部分）。
- 跑 P0 脚本，确认 A1 达标，结果写进第 11 节。
- 完成标准：A1 达标；简报里不再出现记忆条目。

### P4 `memory_read` search

- 按第 5.6 节改 `builtin-tools.ts` 的两个 search 分支，排序复用 `rankMemories`。
- 更新 `server/src/assistant-context.test.ts` 中 search 相关断言；新增测试：
  - 旧命中集合是新结果的子集（A6）；
  - 身份隔离；
  - 首条 2000 字、其余 240 字；
  - `q` 为空时顺序不变。
- 完成标准：A6 达标，来源登记测试通过。

### P5 收尾复核

- 全量 `npm test`、`npm run build`。
- 在开发服务（API `127.0.0.1:3016`，用临时数据目录，不用本机安装的数据）上手动走一遍：
  - 有常驻记忆和无常驻记忆各一次；
  - 简单回复一次；
  - 问一个只在某条非常驻记忆里出现的事实，确认它进了 `【相关记忆】`；
  - 预估接口和实际请求的记忆块一致。
- 记录 A7 观察值：同一会话连续两次请求的 `cachedInputTokens`。
- 用 `semantic_reviewer` 做一次代码复核，处理意见后再提交。
- 完成标准：第 12 节清单全部满足；第 11 节有完整的评测记录。

## 8. 评测方案

- 数据：
  - 真实数据：本机库的副本，复制到 `/tmp/dovun-eval-<日期>.db`，复制前确认 Dovun 已退出、47317 没有监听，或用 SQLite 在线备份命令（`sqlite3 原库 ".backup 副本"`，只读打开原库）。是否改用云端库副本见决策 D2。
  - 合成数据：P0 生成的 300 条记忆和 30 个用例。
- 指标（每个用例和总平均）：
  - 召回率：`|期望 ∩ 注入| / |期望|`，注入 = 常驻 ∪ 相关记忆（旧方案为记忆块 ∪ 简报里的记忆行）。
  - 记忆字数：记忆块字数 + 简报里记忆行的字数。
  - 无关条数：相关记忆里不在期望集合中的条数。
  - 简单回复：`trivial: true` 的用例，相关记忆条数应为 0。
- 报告格式：每次评测在第 11 节追加一行：日期、提交、常量值、A1～A5 数值、漏召回的用例 ID 和原因。

## 9. 风险与回滚

| 风险 | 表现 | 处理 |
|---|---|---|
| 召回漏掉了以前总会注入的记忆 | 回答忽略某条已知事实 | "全部放得下就全放"兜底小数据；评测逐条查漏召回原因；必要时调 `RECALL_MIN_HITS` 或把该类别纳入常驻 |
| 多轮对话里追问很短（"那第二个呢"） | 当前消息检索不到上一轮话题的记忆 | 这类消息没有 3 字片段也没有精确词，召回为空，只剩常驻记忆。模型仍可调用 memory_read。评测里专门放这类用例，结果不好再提方案（不在本计划内自动加） |
| 长消息片段多、噪声大 | 召回无关条目 | 查询只取前 300 字，按得分取前 5 条，A4 卡住 |
| 提示词顺序变化影响模型行为 | 回答风格或工具使用变化 | P1 单独提交，可单独回滚；P5 手动走查 |
| 搜索结果截断变短 | 模型需要再读一次正文 | 首条保留 2000 字；其余条目返回 ID，可用 memory_read read 读取 |

回滚：本计划不改数据和表结构，每个阶段一个提交，`git revert <提交>` 即可回到上一阶段。

## 10. 决策记录

| 编号 | 问题 | 当前建议 | 状态 |
|---|---|---|---|
| D1 | 常驻记忆的入选标准 | `kind = constraint` 或 5 星 | 已确认（2026-11-04，按建议） |
| D2 | 真实数据评测用本机库副本还是云端库副本 | 先用本机库副本；云端副本需要单独授权从 VPS 下载 | 已确认（2026-11-04，按建议；副本 `/tmp/dovun-eval-real-20261104.db`，sqlite3 只读备份） |
| D3 | 真实评测用例由谁写 | 我根据记忆标题起草 20～30 条，你逐条确认期望结果 | 已确认（2026-11-04 定稿 29 条，见 `~/Library/Application Support/dovun-eval/memory-cases.json`） |
| D4 | 是否接受 `memory_read` search 结果从"按星级"改为"按相关度"排序 | 接受 | 已确认（2026-11-04，按建议） |

## 11. 变更记录（评测结果与常量调整）

| 日期 | 提交 | 改动 | A1 | A2 | A3 | A4 | A5 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 2026-11-04 | （基线，无代码改动） | P0 旧方案基线 | 4255 字/次（真实）、6543 字/次（合成），待 P3 后对比 | 96.0%（真实，27 期望 ID 漏 1：real-25，all 范围只装收集箱前段，目标在预算外） | 52.3%（合成旧方案对照值） | —（旧方案无召回段） | —（旧方案简单回复仍注入） | 结果文件 `baseline-real.json`、`baseline-synthetic.json`，与用例同目录；路径守卫已实测拒绝原库 |

## 12. 每次提交前的检查清单

- [ ] 改动只涉及本阶段列出的文件；`git diff --stat` 里没有计划外文件。
- [ ] 没有新增依赖（`package.json`、`package-lock.json` 无变化），没有新增迁移，`schema.prisma` 无变化。
- [ ] 写侧代码（`propose_changes`、`knowledge.ts` 的记忆命令、`auto-memory*`）无变化。
- [ ] 学习助手提示词快照测试通过。
- [ ] 第 6 节常量与代码一致；如有调整，第 11 节已记录评测结果。
- [ ] 行为有变化的阶段，`app-knowledge.ts` 在同一个提交里已更新，没有写数值和未实现的功能。
- [ ] `npm run build -w server` 通过，受影响的测试通过。
- [ ] 评测用例、结果文件、数据库副本都不在仓库里。
