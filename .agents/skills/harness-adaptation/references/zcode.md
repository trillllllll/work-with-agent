# ZCode

## 先确认版本、目录和宿主

记录实际 ZCode 桌面版本、内置 CLI `--version`、启动脚本和运行时。macOS 从实际安装的应用读取 `Info.plist`。使用该应用或适配器解析出的可执行文件查 `--version` 与 `--help`。对照匹配的上游标签或提交，查 V4 command schema、App Server 注册的方法、Provider Registry 和请求鉴权端口。

在相同项目和账号环境启动实际要接入的 `app-server`。读 `session/create` 或 `session/resume` 返回的 `settings.model.available`。新建用于模型探测时用临时项目和存储。读取每项的 `ref.providerId`、`ref.modelId`、`label` 和 `reasoning`，同时核对原会话的 `provider`、`model`、`thought`。刷新时发 `provider/refreshRegistry`，再重读可用模型。通过 `switchModelConfig` 传原生 `provider`、`model`、`thought` 并核对新快照。

旧会话保存的模型不在列表里时，分别查这三处。

1. **目录版本。** 比较安装包内置目录和当前版本的 Active/LKG 目录，确认实际进程解析到了当前目录。查看目录修订号和模型 ID。
2. **账号注册。** 桌面主进程与独立 CLI 的账号来源可能不同。查启动的 App Server 由谁加载账号目录，模型是否进了当前进程的 Provider Registry。用桌面宿主注册账号时，核对 `provider/updateAccountConfig` 和生效的配置修订。
3. **请求鉴权。** 按启动方式查独立 CLI 的原生鉴权，或查宿主如何处理 `interaction/requestProviderRuntimeHeaders`。真账号验证保留原生执行记录或模型响应证据，日志只记录结果和必要字段。

Dovun 0.6.15 的实测案例中，安装包目录缺 GLM-5.4，更新后的目录已有该模型。Dovun 启动的 worker 还缺桌面宿主提供的账号注册。Mac 安装包因此收录了与 ZCode 4.0.0 配套的本机账号宿主，用上游独立 CLI 的注册和请求鉴权。智谱 `login bigmodel` 写入专用本机凭据库。用当前已授权目录供给列表，实际模型请求由本机 ZCode 按原生授权完成。后续版本先查官方接口与版本兼容性，再决定是否需要这一宿主。 [ZCode CLI 登录规格](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/docs/design/v2/auth-login.md)

## 权限与会话接口

| 能力 | 查法与原生字段 |
| --- | --- |
| 权限模式 | 从 V4 会话快照查 `config.mode` 和当前权限定义。Dovun 将 `build` 显示为变更前确认，`guarded` 显示为自主模式，`yolo` 显示为完全访问；旧会话的 `edit` 保留原生语义。查当前版本的实际工具准入和询问范围。 |
| 计划与切换 | 发 `v4/command` 的 `switchCollaborationMode`，按 schema 传 `mode`，包括 `plan`。用 `config.planEnabled` 和 `config.mode` 读回计划状态与权限。模型和模式切换按协议带相应的 `baseRevision`，状态过期时重读原生快照。 |
| 审批 | 从挂起交互读取 `interactionId` 和原生 `optionId`。用 `resolveInteraction` 回复原请求，显示其提供的允许一次、会话内、项目内、拒绝或计划确认选项。处理已结束的请求时读原生结果。 |
| 列表与分页 | 用 `session/list` 查项目、ID 和归属。V4 的历史场景按所用版本的只读订阅和 `v4/conversation/rowsRange` 规范分页。Dovun 用 `historyFirst` 订阅及 `beforeRowId` 翻旧页。 |
| 恢复与运行 | 用 `session/resume {sessionId,workspace}` 恢复并校验返回 ID。订阅 `v4/conversation/subscribe`，处理 `v4/conversation/frame`，缺失增量时用 `v4/conversation/resync`。发送用 `v4/command` 的 `sendText` 并保留原 `commandId`。打断用 `stop`，核对 `expectedForegroundExecutionId`。 |

区分冷历史、冷恢复和接管在跑的桌面会话。Dovun 0.6.15 会检查本机原会话的运行占用，桌面释放后再用同一 ID 恢复。ZCode 原生新建能力与 Dovun 手机侧入口分别核对。可查 Dovun 的 `server/src/node-agent/harness-zcode-client.ts`、`harness-zcode-library.ts`、`harness-zcode-live.ts`、`harness-zcode.ts` 以及 `scripts/zcode-account-host/upstream.patch`。[ZCode 协议](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/docs/zcode-protocol.md) · [V4 命令 schema](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/packages/shared/src/zcode-protocol-v4/command.ts)
