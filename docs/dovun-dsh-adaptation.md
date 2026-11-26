# DSH 接入探测记录（2026-11-25 至 2026-11-26）

按 harness-adaptation skill 对本机 DeepSeek Harness 做的能力探测与适配证据。凭据不记录；示例 ID 为实测值。

## 版本线与本机状态

| 项 | 实测 |
| --- | --- |
| 桌面 App | `/Applications/DeepSeek Harness.app` 0.2.2-rc.5，内置 Node 24.21.0 |
| 启动器 | `Contents/Resources/runtime/cli/bin/dsh`（`~/.local/bin/dsh` 为符号链接），用 `ELECTRON_RUN_AS_NODE=1` 运行 `app.asar` 里的 CLI |
| 自动化入口 | `dsh --profile acp`：ACP v1 NDJSON stdio，启动到 `initialize` 应答 0.8 秒 |
| 会话存储 | `~/.dsh/sessions/<项目路径编码>/<会话 ID>/session.v4.jsonl.zstd`，旧版为 `session.jsonl.zstd`；本机 65 个项目、366 个会话（314 个 v4、54 个 v0） |
| 投影缓存 | `~/.dsh/storages/session_projcache/sessions/<会话 ID>.json`，366 个，其中 358 个有标题 |

## 鉴权

- ACP 的 `authenticate` 立即成功，服务器不需要身份验证。模型凭据由 dsh 自己的凭据服务提供，Dovun 不经手。
- 执行器启动 dsh 时沿用本机环境，只固定 `DSH_PERMISSION_MODE=workspace-write` 作为新会话的起始档位。
- 桥接 socket 位于用户私有临时目录，权限 0600，首行校验每次启动随机生成的令牌。

## 实测接口行为

| 行为 | 证据 |
| --- | --- |
| 握手 | `protocolVersion` 1；`sessionCapabilities` 有 close / list / resume；本机 `promptCapabilities.image` 为 false |
| 模型目录 | `deepseek-official`（deepseek-v4-flash、DeepSeek-V4.1-Flash、DeepSeek-V4-Pro）和 `deepseek-account`（DeepSeek-V4.1-Flash、DeepSeek-V4-Pro）；`reasoning_effort` 为 Off / Low / High / Max |
| 新建与恢复 | `session/new`、`close`、`list`、`resume` 都通；改过的推理档位关掉再恢复仍在 |
| 不支持的接口 | `session/load`、`session/set_mode` 返回 -32601；空提示词返回 -32602「empty prompt」，不触发模型请求 |
| 占用 | 同一进程重复恢复返回 -32602「session is already active」；另一进程持有写锁时返回 -32603，`data.details` 为「already owned by an active write handle」，且该会话仍出现在 `session/list` 里 |
| 列表 | 全量 337 个会话、65 个项目目录、4 页，0.21 秒；不含 29 个 subagent 会话 |
| 写锁 | `session.lock` 上的非阻塞 `flock`，持有者进程退出即释放；读历史不碰锁。`lsof` 可只读查出被占用的会话 |
| 模型请求 | 纯文本一轮 1.2 秒回复 `HARNESS_RESUME_OK`，工具调用一轮 1.9 秒执行 `echo`；原生日志里两条回复的 `source` 都是所选的 deepseek-official / deepseek-v4-flash |
| 提问工具 | `ask_user_question` 在没有应答方时直接报错返回（源码确认），不会挂起 |
| 审批触发 | 模型的工具调用带 `sandbox_permissions` 和理由时才发起；普通命令在档位的沙箱内执行，越界操作直接被拒绝。提权目标只有 `workspace-write` 和 `danger-full-access` |
| 打断 | `session/cancel` 后日志记 `turn/end {kind: aborted}`，工具结果带 `isError` 和 `ABORTED` |

## 权限

- 三个档位 `read-only`、`workspace-write`、`danger-full-access`，审批策略跟随档位（前两个为 ask，后者为 never）。
- 新建会话时取启动环境的 `DSH_PERMISSION_MODE`。恢复已有会话时沿用会话自己记录的档位，启动环境不改写它。
- ACP 只开放 `model` 和 `reasoning_effort` 两个会话配置项，整个 `dsh-acp` 包不引用权限服务，所以通过 ACP 无法在会话中切档位。
- dsh 内部一直能切：`permissionPresets.set(session, 档位)`。桌面端和网页端的选择器、headless 的 `--permission-mode` 都调它。
- Dovun 用 `dsh --profile acp --patch <叠加层>` 每次启动临时挂入一个约 80 行的插件，叠加层里的 `name: './dovun-dsh-bridge.mjs'` 按叠加层所在目录解析。实测在恢复后的会话上连续切 workspace-write → read-only → danger-full-access → read-only，全部成功，原生日志写入与桌面端相同的记录。

## 流式

ACP 只在模型步骤提交时给出整段消息，没有逐字增量。实时增量在 dsh 内部的 `agent/assistant-stream` 事件里：`start` 帧带轮次和步骤号，`chunk` 帧带块序号和文本，`end` 帧在消息落盘之后才发。桥接插件转发这些帧和 `session/event` 的 `assistant/message`，适配器用流式条目的 ID 给消息定稿。

## 映射决定

- **进程**：每条会话一个 `dsh --profile acp` 进程，桥接文件写在本次进程私有的临时目录，关闭时删除。
- **轮次**：用户消息 ID 等于 Dovun 的 commandId；ACP 不保存它，所以历史里的用户消息没有 clientId，重投的命令回执保守地标为待核实。
- **历史**：离线解码日志，按真实用户消息（`source.kind` 为 user）切轮，跳过插件注入的上下文；解码结果按文件修改时间缓存，容忍最后一帧未写完。
- **审批**：`allow-once` 对应允许，`reject-once` 对应拒绝；没有「允许本会话」。
- **权限**：恢复时如实报告会话记录的档位；完整访问只在页面支持高级权限时报告，否则下一轮应用显示的工作区档位。
- **暂缓**：追加、重跑、分叉、压缩、计划模式、回答模型的提问、图片附件、Windows；原生置顶、分组和标签（dsh 没有）。

## 真实验收（2026-11-26，0.2.2-rc.5）

**不发模型请求**：用真实 dsh 核对运行时适配器。桥接插件加载并连上执行器；`catalog` 返回两个供应商下五个模型的档位；临时会话恢复后报告记录的只读档位，三个档位切换成功且报告的沙箱类型一致；真实日志读出 2 轮历史，与此前冒烟的对话一致；被另一进程占用的会话返回「DSH 原会话正在被占用」，不存在的会话返回「找不到 DSH 原会话」。本机全部 366 个真实日志用 `fzstd` 解码成功，175 MB 压缩数据解出 975 MB，平均每个 52 毫秒。

**用本机假模型驱动真实 dsh**：发真实模型请求需要用户先指定供应商和模型，所以改用 `server/test/stub-dsh-model.mjs`（本机 OpenAI 兼容的流式服务）经 `--patch` 注册为供应商，`DSH_HOME` 指向没有凭据的临时目录。dsh 二进制、桥接插件和适配器都是真实的，22 项检查全部通过：

| 场景 | 结果 |
| --- | --- |
| 逐字流式 | 正文分 6 段在一轮结束前到达；提交的消息沿用流式条目的 ID，只出现一次 |
| 只读档位 | 下一轮发送前生效，`touch` 被沙箱拒绝；普通命令不弹审批 |
| 提权审批 | 模型带 `sandbox_permissions` 和理由请求更大权限时，dsh 发来审批。卡片显示命令和模型写的理由，选项为允许和拒绝 |
| 允许 | 命令执行一次，文件创建成功，工具状态为完成 |
| 拒绝 | 什么都没执行，工具返回「用户拒绝了提权」，这一轮正常结束 |
| 工作区档位 | 同样的写入直接放行 |
| 打断 | 运行中的 `sleep 20` 在打断后 26 毫秒结束，这一轮报告为已打断，没有残留进程 |
| 历史 | 6 轮都在，工具的成败结果保留 |

审批只在模型显式请求提权时发起。ACP profile 默认就允许提权，因为 `sandbox-policy` 设了默认档位；提权目标只有 `workspace-write` 和 `danger-full-access`。用户打断的轮次在日志里记为 `aborted`，工具结果带 `isError` 和 `ABORTED`，投影时按已打断处理，重载后与实时一致。

**仍未验证**：真实模型下的流式和审批。逐字流式的分块方式取决于模型，假模型只证明管线通畅。另外还需请用户用 dsh 桌面端在受控项目建一个一次性会话，验证恢复桌面端创建的真实会话。

## 测试资产

- `server/src/node-agent/harness-dsh.test.ts`：8 例（新建加流式加完成、缺失与占用会话、审批映射、运行中重复发送与打断、档位切换与恢复报告、无桥接时降级、按项目列表与历史分页、多帧解码含 magic 误命中）。
- `server/test/stub-dsh-acp.mjs`：最小 ACP stub，讲 ACP 子集、按 dsh 的布局写日志，并连回执行器的 socket 充当桥接；`HARNESS_TEST_DSH_ASK` 出审批、`HARNESS_TEST_DSH_HOLD` 卡住工具、`HARNESS_TEST_DSH_LOCKED` 模拟占用、`HARNESS_TEST_DSH_NO_BRIDGE` 模拟插件未加载。
- `server/test/dsh-fixtures.mjs`：用原始块生成 zstd 帧，不依赖 Node 的 zstd。
- `server/test/stub-dsh-model.mjs`：本机 OpenAI 兼容的流式假模型，经 `--patch` 注册给真实 dsh，用来在不发真实模型请求的情况下验证适配器。
- `server/src/harness-sessions.test.ts` 新增集成 1 例；`e2e/harness-sessions.spec.ts` 新增手机用例 1 例（Chromium 与 webkit-chat 通过）。

## 环境备注

- 执行器只在服务器接受 `harness_dsh_v1` 后才宣告 `dsh`。旧服务器会拒绝含未知类型的整个租约，所以不能直接上报。
- 探测期间 dsh 桌面端一直在运行，共用同一个 `~/.dsh`，没有出现冲突。
- `dsh --profile acp` 没有删除会话的接口。
