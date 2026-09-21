# 第四阶段：Handoff 与本机 Runner 验证

验证日期：2026-09-21（Asia/Hong_Kong）。环境：Windows 原生 PowerShell、Node.js、Git；使用用户已有 CLI 登录，不安装宿主、不更改全局配置。CLI 运行数据、数据库与源仓库均位于独立临时目录。

## 已实现的边界

- Handoff 准备阶段可以按版本编辑并重新冻结任务、子任务和材料记忆快照；领取或启动后禁止修改。手动领取校验连接授权、选定宿主、领取令牌和当前范围。
- 每次启动、用户回答后续接或新增权限后重跑都创建新 Run。有明确外部 session ID 且复用原副本时才续接宿主会话；缺少 session 或需要重新准备副本时启动全新宿主会话，仍通过 `continuationOf` 关联原 Run。观察日志和补收结果保持原 Run，不能自动重复执行。
- 进程退出、结果验收、代码应用和 Todo 完成分别记录。结构化结果包含检查、问题、未完成项和拟议修改；拟议修改只创建统一 Proposal，不能通过 report 直接修改业务对象。
- 结果不可覆盖；事件有稳定去重 ID 和单调序号。重复相同结果返回重放，冲突结果拒绝，已取消或已有更新 Run 的晚到回报仅审计。
- 用户验收可选择完成 Todo，通过共用命令服务执行并检查当前任务版本；一并完成子任务时同时检查完整子任务 ID/版本集合。
- Git 从明确 HEAD 创建独立 worktree，未提交修改不带入；非 Git 使用独立输出目录，可以只复制用户选择的普通输入文件，默认选择为空。本机任务并发为 1，观察未知的 Run 仍占用并发槽。
- 完整 Git 变更保存为不可变 patch Artifact，覆盖已提交、暂存、未暂存和新增文件。应用前检查原路径、HEAD、分支和干净工作区；先预览，明确应用后再写原仓库。不会提交、自动解冲突或自动完成 Todo。
- 独立 Node supervisor 持有实际子进程并持续写日志；API 重启后只补收。Windows 取消由持有子进程的 supervisor 执行进程树终止，不根据数据库中的旧 PID 猜测并终止进程。

## 最终真实 CLI 验收

| 宿主 | 实测版本 | 只读结构化初次 / 明确 session 续接 | 真正独立副本写入、补丁预览与应用 |
| --- | --- | --- | --- |
| Codex | `codex-cli 0.155.0` | 通过 / 通过 | 通过 |
| Claude Code | `2.1.276` | 通过 / 通过 | 通过 |

四轮结构化验收使用最终结果 schema（包含 `unfinished` 和原生 schema 的 `proposedCommandsJson`）。应用层将后者校验并转换为 `proposedCommands`。两宿主初次返回 `SMOKE_OK`，续接返回 `SMOKE_CONTINUED`，并保持各自明确的 session ID。日志目录：`%TEMP%/wwa-cli-smoke-TY2VUB`。

完整写入验收由 `integration-smoke.ts` 调用真实 Handoff/Run 应用服务：独立数据库迁移、创建任务和 Handoff、本机启动、原始事件补收、读取 Artifact、预览 patch、显式 apply，再读取源文件和 Todo。不是 mock CLI。证据：`%TEMP%/wwa-handoff-real-wgmGbZ/acceptance-results.json`。

| 宿主 | Run ID | Patch SHA-256 | 应用结果 |
| --- | --- | --- | --- |
| Codex | `cmua38hbm0004r4e0nc3foras` | `f8713443f21d6e60f4e913bb3daee38fb78930ea5dfc1b35a8f01d8c10eb9bb3` | `codex-created.txt` 内容正确；应用前源目录未改变；Todo 仍为 `todo` |
| Claude Code | `cmua392qe000xr4e0c25wgrq4` | `ae9465af8fc878e9c25082e64c6e8dec36d4d0ce49081bbe23fbd712a958f843` | `claude-created.txt` 内容正确；应用前源目录未改变；Todo 仍为 `todo` |

Claude Code 在这台机器上沿用用户配置的模型，事件中实际模型为 `kimi-for-coding`。上述结果验证的是 **Claude Code CLI 宿主协议和已有配置**，不应表述为 Anthropic 原生 Claude 模型或 Claude 订阅验收。

## Windows 权限修复的实测证据

Codex 使用 `--ignore-user-config` 防止隐式继承用户 MCP 等集成，但该参数也省略了用户已有的 `[windows] sandbox = "unelevated"`。最初 :workspace 已包含正确 worktree 写入范围，`exec_command` 仍返回 `blocked by policy`，`apply_patch` 将该目录判为 outside project。只增加本次调用的 `-c windows.sandbox="unelevated"` 后，同一工作副本内的创建和读取立即通过，最终双宿主写入链也通过。

实现现在显式选择 Windows 原生沙盒后端；默认 `unelevated`，可用 `WWA_CODEX_WINDOWS_SANDBOX=elevated` 选择用户已配置的强化后端。非法取值直接拒绝。该选择不改变 `:workspace` / `:read-only` 权限，不设置 full access，也不写用户配置。`unelevated` 使用当前用户派生的受限令牌；它的网络隔离弱于 `elevated`。受管理设备的 requirements 仍优先，不允许时不会自动绕过。[官方 Windows 沙盒说明](https://developers.openai.com/zh-Hans/docs/windows/windows-sandbox)

宿主参数显式关闭审批交互、网页搜索、额外应用/插件/钩子等能力；未授权 shell 时关闭 shell 工具。Claude Code 使用 `--safe-mode`、空且严格的 MCP 配置和明确工具列表；`--permission-prompts none` 遇到无法满足的权限时返回结果或错误，不在网页中伪装原生交互。继承环境中的父 Codex app 管道、会话与权限标志会移除，保留已有登录目录和认证环境，不复制或输出凭据。[Codex 非交互模式](https://developers.openai.com/codex/noninteractive)、[Claude Code CLI 参数](https://code.claude.com/docs/en/cli-reference)

## 针对性自动化测试

最终独立库命令：

```powershell
$env:DATABASE_URL='file:../data/handoff-isolated-test.db'
npx vitest run --config server/vitest.config.ts server/src/runner/runner.test.ts server/src/application/handoff.test.ts
npx tsc --noEmit --project server/tsconfig.json
```

结果：**16 / 16 测试通过，服务端 TypeScript 检查通过**。其中最后增加的 4 项覆盖非 Git 输入复制和无宿主 session 的失败重试；它们不改变已验收的 CLI 权限参数。

| 测试文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `server/src/runner/runner.test.ts` | 8 | 明确 session 与受限权限参数、Windows 后端配置、父会话环境隔离、事件语义、HEAD/dirty/完整补丁、选择输入复制/哈希/越界/junction/缺失/大小限制、进程日志、重复启动拒绝、Windows 子孙进程取消、启动者退出后继续观察 |
| `server/src/application/handoff.test.ts` | 8 | 领取/宿主/令牌绑定、结果不可变与重放、撤销连接与晚到结果、版本化准备、Proposal 不直写、验收 CAS 与子任务版本集合、补收/退出取消竞态、新 Run 续接、补丁应用幂等、准备失败后修正输入/新会话重试、CLI 缺失后复用副本 |

测试中的受控 Node CLI fixture 用来确定性验证取消、重启观察和故障时序，**不能代替上面的真实宿主验收**。独立库只清理测试自己创建的对象；不连接生产库。

## 非 Git 输入与失败重试

启动请求可带 `inputFiles: string[]`，最多 100 个源目录相对文件，合计 32 MiB。路径统一分隔符、去除 `.`、去重并排序后纳入请求哈希；拒绝绝对路径、`..`、Windows 设备名/数据流路径、符号链接或 junction 组件、目录、缺失文件和超限内容。Git 请求携带非空选择会明确拒绝，不能以输入复制间接带入未提交修改。

文件在进程启动前复制，保持相对路径；`Workspace.inputs` 保存实际复制内容的 `{path, hash, size}` 清单，并附在 CLI prompt 中。后续修改原文件不改变该快照。复用副本的续跑保留原输入清单，不重新读取源文件；CLI 可以按已授予权限修改副本内的文件，清单始终表示最初复制的版本。

复制或 CLI 准备失败会保留 `failed` Run、所选路径和带错误码的 `launch_failed` 事件，不伪装已启动。没有执行副本时，`continue` 可以带 `sourcePath` / `inputFiles` 修正输入（包括 `[]` 清空选择）并创建新 Run；已有有效副本时拒绝这些覆盖字段。没有明确 session 的重试使用全新会话，不能推测最近会话。`unknown` 状态必须先核实停止，禁止直接重投。

## 第五阶段受限外部回顾桥接

`generateExternalReview` 只接收整理请求的冻结文本，使用独立空目录与无工具/只读宿主参数，不创建或领取 Todo Run，也不向 CLI 传应用写令牌。输出只包含摘要和候选命令；随后由 OrganizationService 校验来源、范围和目标版本，创建等待用户确认的 Proposal。能力检查不满足时直接报错，不降级到有执行权限的模式。

最终真实验收：Codex 与 Claude Code 均返回 `REVIEW_SMOKE_OK` 和空候选集合，证据目录 `%TEMP%/wwa-review-smoke-M7wf0V`。这验证宿主受限整理协议；定时规则幂等和候选审批另由回顾模块测试覆盖。定时整理不会自动派发 Todo、应用修改或完成任务。

## 重现真实验收

下面命令会使用已有登录调用真实模型，产生相应宿主用量。脚本打印独立证据目录，失败以非零退出码结束。

```powershell
node --import tsx server/src/runner/smoke.ts --run
node --import tsx server/src/runner/smoke.ts --reviews
node --import tsx server/src/runner/integration-smoke.ts --run
```

## 已知限制

- 不承诺网页实时原生 CLI 问答。待输入、补充权限和返工使用新 Run；明确 session 才能复用宿主会话，没有 session 时显式以新会话重试，禁止 `--last` 猜测会话。
- API 进程重启可以补收；supervisor 崩溃或机器重启后若无法确认原进程结束，标为未知，不重新投递。人工确认停止必须明确提交，不能自动推断孤儿进程已死。
- Windows 持有子进程时的进程树取消已测；尚未实现独立原生 Job Object 守护组件，所以不能承诺 supervisor 崩溃时所有后代同步退出。
- 文件系统应用和数据库不是分布式事务。应用记录先写入，结果不确定时保留 unknown，不自动再次应用；用户可查看原目录和 patch 后处理。
- Claude Code 的工具许可不是普遍的操作系统写入隔离。启用 shell 意味着允许该宿主执行命令；应用仍仅显式采纳受验证的产物，不应把独立工作副本称作整机安全沙盒。
- 原生宿主日志可能含任务、材料、模型输出及路径，应按本地项目资料管理；验收脚本不打印登录凭据。
- 版本能力来自上述实测版本。其他 CLI 版本或组织策略可能拒绝能力，错误会保留；没有通过扩大权限来保证运行成功。
