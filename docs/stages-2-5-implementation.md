# 第二至第五阶段实施与验收

实施日期：2026-09-21（Asia/Hong_Kong）。范围采用用户确认的七批计划，依赖既有第一阶段 Todo；未提交原工作区改动，也未重置原数据。

## 已落地模块

| 批次 | 实现落点 | 用户可见结果 |
|---|---|---|
| 2A | security、commands、command-catalog、workspace-api、approval | 本机会话、连接范围、显式版本、原子批次、幂等回执、统一待确认、SSE |
| 2B | 官方 SDK stdio MCP、连接管理与提议页面 | Codex / Claude Code 访问同一份 Todo；用户可修改授权、撤销连接、调整和确认提议 |
| 3A | knowledge、材料/记忆及不可变版本、受管理附件 | 无模型保存资料、会话、附件、来源记忆，查看修订历史并导出 |
| 3B | knowledge-organizations、结构化 brief、中文关键词 search | 内置/外部整理共用候选；来源过期拒绝确认，固定说明保留，待复核记忆独立显示 |
| 4A | handoff、runs、HandoffReview、Artifact | 可修订待派发交接；已有会话原子领取、回报进展及结果，用户采纳、完成或返工 |
| 4B | 独立 supervisor、两种 CLI adapter、workspaces | 独立副本、持久日志、明确会话续接、未知状态核实、完整补丁预览和单独应用 |
| 5 | reviews-clock、reviews、受限 review-generator | 默认关闭的每日/每周回顾、IANA 时区、最新周期补跑、基础报告与待确认建议 |

接口详情、配置示例和命令见 [API 与宿主接入](./stages-2-5-api.md)。验收细节分别见 [身份与命令](./stage-2-contract-validation.md)、[已有会话 MCP 交接](./stage-4-manual-mcp-validation.md) 与 [Runner 验收](./stage-4-runner-validation.md)。

## 关键实现约束

- SQLite 内的一次命令组保存数据、审计、回执和提议结果；模型调用与 CLI/文件副作用在事务外。
- 每个既有对象携带 expectedRevision，级联及集合操作额外固定完整依赖集合。预览后发生变化则整组失败；不会偷偷取新版本覆盖旧输入。
- 本客户端已排队的连续任务写入只继承前一笔本地成功写入的版本。外部刷新不改变已提交操作的版本条件；未保存字段保持草稿并提示同字段冲突。
- 创建子任务可能重开父任务，属于连带关系变更；外部连接不会因拥有“创建任务”权限而获得该连带修改的自动授权。
- 资料归属独立于任务当前清单。外部查询会过滤标签、回收站、归属历史和审计；完整混合审计快照仅对用户可见。
- 材料内容、记忆修订、执行结果和产物保留历史。旧来源变化只标记待复核。混合 Todo/材料/记忆批次沿用版本冲突撤销。
- 定时回顾不派发 Todo、不自动确认候选、不修改任务状态。`external` 保留手动 MCP 路径；`codex`/`claude` 才选择已验证的受限 CLI。
- 代码应用与结果验收、Todo 完成分别记录。中断可能留下 applying/unknown，不能推断为成功，也不能自动重投。
- 非 Git 输入由用户明确列出相对文件，复制到独立目录并记录 path/hash/size；不会复制整个源目录。启动失败且没有宿主会话时，用户可修正输入，以新 Run、新会话重试并保留 continuationOf。已有副本续跑继续使用原输入快照；unknown 仍不能重投。

## 数据与备份验证

四次增量迁移：`20260921010000_identity_commands`、`20260921020000_knowledge`、`20260921030000_handoff_runner`、`20260921040000_reviews`。原有任务、清单和历史 ID 不变，ChangeRecord 的历史 requestId 保留；主体范围幂等由 RequestReceipt 的复合唯一键接替。

新增 `npm run db:backup`，对 SQLite 执行一致性备份，并复制受管理附件、runner 目录，写入 manifest；备份需在 API 与 runner 停止后进行。已生成并验证升级前备份：

`D:/WorkSpace/ClaudeCodeProjects/WorkWithAgent/.backups/2026-09-20T17-07-05-843Z/`

在独立 `upgrade-verification.db` 对真实旧库副本运行完整 14 次迁移，对所有旧表的原列逐行计算 hash 比较：22 条清单、16 条任务、401 个会话、1700 条消息、130 条审批、571 条审计及 12 条归属历史均保持完整。另从备份恢复到独立 `restore-verification.db`，通过 integrity_check 与 foreign_key_check。未将验证库替换为用户数据库。

正式升级前再次备份到 `.backups/2026-09-20T17-27-44-066Z/`，随后通过 `npm run db:migrate` 对 `agent-studio.db` 增量应用四次新迁移。升级后按备份中所有旧表的原列逐行比较 hash，数据全部一致；正式库 integrity_check 与 foreign_key_check 通过。保留备份与原 ID，未执行 reset。

空库迁移及历史语义另由自动测试覆盖。Schema 变更后已显式运行 Prisma Client 生成；测试准备只在 schema 发生变化时重新生成，避免 Windows 下重复替换正在使用的 DLL。

## 真实宿主验证

| 对象 | 版本 | 验证内容 | 结果 |
|---|---|---|---|
| MCP SDK | 1.30.0 | 官方 Client/stdio 协商、参数清空与布尔值、分页和结构化错误 | 协议测试通过 |
| Codex CLI | 0.155.0 | 真实 MCP 查询、相同请求提交两次、人工确认后读回、旧版本拒绝 | 通过 |
| Claude Code | 2.1.276 | 同上，独立授权连接与真实宿主调用 | 通过 |
| Codex / Claude Code 已有会话 | 同上 | 明确 session ID 续接、选定材料、原子领取、重复回报去重、采纳后 Todo 保持未完成 | 双宿主 2/2 通过 |
| Codex / Claude Code CLI | 同上 | 结构化首次执行、明确 session ID 续接、新结果 schema | 双宿主 4/4 通过 |
| Codex / Claude Code 本机执行 | 同上 | 真实 worktree 写新文件、原目录未变、完整补丁预览、显式应用、Todo 保持未完成 | 双宿主 2/2 通过 |
| Codex / Claude Code 受限回顾 | 同上 | 冻结文本、受限无写入工具、返回摘要和候选 schema | 双宿主 2/2 通过 |

MCP 验证来自真实 CLI 模型调用，使用独立新数据库和临时宿主配置，没有修改用户全局配置。证据目录：`C:/Users/13431/AppData/Local/Temp/wwa-mcp-hosts-LTkUO5`。可重跑 `npx tsx server/src/mcp/real-smoke.ts --run`。

已有会话 MCP 交接另以 `--run --handoff-only` 真实执行，证据为 `C:/Users/13431/AppData/Local/Temp/wwa-mcp-hosts-LwffcJ/summary.json`。两个宿主均从选定材料读取仅存在于正文的随机标记并回报；各自重复提交进度和结果，数据库只保留唯一事件。用户采纳且不完成后任务仍为 todo，版本不变。验收连接均已撤销。

CLI 结构化输出与续接可重跑 `npx tsx server/src/runner/smoke.ts --run`。Claude Code 验收使用用户现有配置的 `kimi-for-coding` 模型线路；宿主兼容通过不等于验证 Anthropic 模型或订阅。完整副本执行证据为 `%TEMP%/wwa-handoff-real-wgmGbZ/acceptance-results.json`，受限回顾证据为 `%TEMP%/wwa-review-smoke-M7wf0V`。Windows Codex 显式指定受限 sandbox 后端，修复忽略用户配置时遗漏该设置而拒绝工作副本写入的问题，详见 Runner 验收记录。

## 自动化验收记录

已运行针对性用例与全量回归，覆盖身份/CSRF、权限、CAS、集合竞态、回执、原子回滚、来源变更、中文检索、混合撤销、父子任务、取消/重启、补丁及二进制、时区/DST、停机补跑等。

最终在同一轮按以下顺序执行，三个命令均以退出码 0 完成：

| 命令 | 最终结果 |
|---|---|
| `npm test` | 服务端 119 项、客户端 10 项，共 129 项通过 |
| `npm run build` | 服务端 TypeScript 与客户端生产构建通过；Vite 提示主包大于 500 kB，不影响构建 |
| `npm run e2e` | 桌面与移动端共 47 项通过、9 项跳过，耗时 2.8 分钟 |

9 项跳过包括 7 项仅适用于另一视口的对应测试，以及 2 项未启用 `E2E_REAL_MODEL` 的内置模型测试。上节两个外部宿主的真实 MCP、明确会话续接、CLI 副本写入与受限回顾均另行实际执行通过，未以这些跳过替代。

本轮已修复的集成问题包括：旧 Express 挂载路径未被 mutation 中间件命中；队列第二笔写入仍使用第一笔之前版本；旧迁移测试继续要求全局 requestId 唯一索引；Windows runner 状态文件原位替换产生 EPERM；提议编辑时新建对象 ID 不稳定；迟到保存影响另一清单草稿；旧 Agent 成果测试未先读取版本。上述修复均纳入最终回归。

Mock Agent、受控假进程与真实宿主测试分别记录，不把 Mock 通过或平台条件跳过当作真实接入验收。

## 本轮边界

首版为本机单用户、SQLite 单写者与单并发 runner。宿主/机器故障后保留未知状态，人工核实进程树后才能确认停止；不会假称能停止已有外部聊天。非 Git 任务只复制明确选定输入，输出保存在独立目录。中文检索直接查询原始数据，无语义向量索引依赖。

提醒、重复任务、多端同步、团队权限、邮件/网盘连接、OCR、全局语义检索、自动连续派发和 CCB 专用适配器仍属于独立扩展。
