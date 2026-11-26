# DSH（DeepSeek Harness）

DSH 自带仅面向自动化的 ACP 服务（`dsh --profile acp`，Agent Client Protocol over stdio）。适配器为每条会话启动一个这样的进程，并用 `--patch` 叠加层临时挂入一个 Dovun 自带的桥接插件，调用 ACP 没有开放的内部服务。用户的 profile 不被修改。

## 查实际版本与目录

```sh
dsh --version                                  # 0.2.2-rc.5 起可用；执行器按 DOVUN_DSH_BIN → 应用包 → PATH 解析
ls ~/.dsh/profiles/acp                         # 首次调用 acp profile 时由 dsh 自动生成
```

启动器在 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，`~/.local/bin/dsh` 是它的符号链接。源码在 `Contents/Resources/app.asar` 的 `dsh/node_modules/@deepseek-ai/*/src/` 下，用 `ELECTRON_RUN_AS_NODE=1` 运行应用主程序即可读取。`dsh --profile acp` 的任何调用（包括 `--help`）都会在 `$DSH_HOME/profiles/acp` 物化 profile 目录。

会话日志在 `$DSH_HOME/sessions/<项目路径编码>/<会话 ID>/session.v4.jsonl.zstd`（旧版为 `session.jsonl.zstd`），是多帧 zstd 的 JSONL，首帧只有头记录，之后每次追加一帧。旁边的 `session.lock` 是跨进程的内核写锁。`$DSH_HOME/storages/session_projcache/sessions/<会话 ID>.json` 是 ACP profile 也会维护的标题与时间缓存，JSON 格式。项目目录名是路径的有损编码，归属以头记录的 `cwd` 为准。桌面包的 Node 22.13.0 没有内置 zstd，解码用 `fzstd`。测试注入用 `DOVUN_DSH_BIN` 指向 `server/test/stub-dsh-acp.mjs`，并用 `DSH_HOME` 指向临时目录。

## ACP 接口（0.2.2-rc.5 实测）

| 操作 | 方法 | 说明 |
| --- | --- | --- |
| 握手 | `initialize` | `sessionCapabilities` 含 close / list / resume；图片能力取决于模型路由 |
| 新建 | `session/new {cwd, mcpServers:[]}` | 返回 `sessionId` 和 `configOptions`；新会话取启动环境的权限档位 |
| 恢复 | `session/resume {sessionId, cwd}` | 目录须一致；被其他进程占用时返回 -32603，`data.details` 为 `already owned by an active write handle` |
| 配置 | `session/set_config_option {configId, value}` | 只有 `model`（值为 `[provider, model]` 的 JSON）和 `reasoning_effort`，其他 configId 报错 |
| 发送 | `session/prompt {sessionId, prompt}` | 请求在整轮结束后才返回 `{stopReason}`；同一会话同时只接受一个 |
| 打断 | `session/cancel`（通知） | 提示词请求以 `cancelled` 结算 |
| 更新 | `session/update` | `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`usage_update`、`config_option_update` |
| 审批 | `session/request_permission`（agent → client） | 选项固定为 `allow-once` 和 `reject-once` |

`session/load`、`session/set_mode` 返回 -32601：没有历史回放、追加、分叉、计划模式和回答模型提问。`ask_user_question` 在 ACP 下没有应答方时直接报错返回，不会挂起。`session/list` 只给 ID 和目录，并且不会排除被其他进程占用的会话。

## 桥接插件

ACP 不开放权限档位、完整模型目录和逐字增量。叠加层 `insert` 一条 `name: './dovun-dsh-bridge.mjs'`（相对叠加层所在目录解析），插件注入 `permissionPresets`、`sessions`、`llm`，连到执行器在用户私有临时目录监听的 Unix socket，首行用启动令牌认证，之后按行 JSON 通信。

| 方法 | 用途 |
| --- | --- |
| `permission.current {sessionId}` | 当前生效的档位；恢复会话时用它如实报告 |
| `permission.set {sessionId, preset}` | 调 `permissionPresets.set`，写入与桌面端相同的 `permission/preset`、`sandbox/mode`、`approval/policy` 记录 |
| `catalog` | 每个模型的推理档位与默认档位，来自 `llm.listProviders`、`listModels`、`resolveModelInfo` |

插件还转发 `agent/assistant-stream` 的 `start`、`text-delta`、`end` 帧，以及 `session/event` 的 `assistant/message`。适配器用流式条目的 ID 给消息定稿，ACP 的提交通知只用来补漏。插件没有连上时，权限选择器不显示，流式退回整段，档位只显示当前模型。

## 权限、模型与档位

- 权限：三个档位 `read-only`、`workspace-write`、`danger-full-access`，与 Dovun 的只读、工作区、完全访问一一对应。恢复已有会话时沿用会话自己记录的档位，启动环境的 `DSH_PERMISSION_MODE` 只影响新会话。切换在下一轮发送前通过桥接生效。
- 模型：`model` 选项的值作为 Dovun 的模型 ID。同名模型出现在多个供应商下时，名称带供应商名。
- 档位：`reasoning_effort` 的取值有 `off`、`low`、`high`、`max`。没有计划模式，审批策略跟随档位。

## 审批与打断

审批只在模型显式请求更大沙箱时发起：工具调用带 `sandbox_permissions` 和 `justification`，dsh 通过 `approval/request` 转成 `session/request_permission`。ACP 请求只带 `toolCallId`，命令和理由取自之前的 `tool_call` 更新。普通命令在档位的沙箱内执行，越界操作被直接拒绝，不弹审批。提权目标只有 `workspace-write` 和 `danger-full-access`，提权能力随 `sandbox-policy` 的默认档位一起存在。

用户打断后，日志记 `turn/end {kind: aborted}`，工具结果带 `isError` 和 `ABORTED`。读历史时按已打断处理。

## 已验证行为（0.2.2-rc.5 实测）

桥接插件随 `--patch` 加载并连上执行器；`catalog` 返回两个供应商下五个模型的档位；三个档位在恢复后的会话上切换成功，原生日志同步写入；被另一进程占用的会话恢复时返回占用错误；本机 366 个真实日志全部解码成功。

逐字流式、提权审批、允许与拒绝、档位在下一轮生效、打断，用 `server/test/stub-dsh-model.mjs` 驱动真实 dsh 验证通过。这个假模型是本机 OpenAI 兼容的流式服务，按下面的叠加层注册，并把 `DSH_HOME` 指向没有凭据的临时目录。真实模型下的表现需要用户指定供应商和模型后另行验证。

```yaml
- id: llm-pi-ai
  config:
    providers:
      stub-local:
        displayName: Stub Local
        api: openai-completions
        baseURL: http://127.0.0.1:<端口>/v1
        apiKeyEnv: DSH_STUB_API_KEY
        models: [{ id: stub-model, name: Stub Model, contextWindow: 128000, maxTokens: 8192 }]
- id: acp
  config: { provider: stub-local, model: stub-model }
```
