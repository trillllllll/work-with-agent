# OpenCode

OpenCode 2 的会话全部由本机共享服务持有，TUI、桌面和 Dovun 都是它的客户端。适配器不启动模型进程，只通过 HTTP 和 SSE 附接这个服务。

## 查实际服务与版本

```sh
~/.opencode/bin/opencode --version          # OpenCode 2 独立 CLI，本机推荐安装位
opencode service status                     # 共享服务地址（来自 ~/.local/state/opencode/service.json）
```

服务注册表在 `~/.local/state/opencode/service.json`，包含 `version`、`url`、`pid` 和鉴权口令。口令是凭据：只经文件或环境变量读取，不进日志、命令参数和文档。HTTP 走 Basic auth，用户名固定 `opencode`，口令来自注册表或 `OPENCODE_PASSWORD`。无凭据请求返回 401。测试注入用 `OPENCODE_SERVICE_URL`，指向 `server/test/stub-opencode-service.mjs` 起的本地 stub。版本低于 2 的旧线（`~/.opencode/bin` 曾为 1.x）没有这些接口，按 `OPENCODE_BIN` → 独立 CLI → 桌面捆绑 CLI 顺序解析，`--version` 主版本 ≥ 2 才上报可用。服务未运行时执行器调用一次 `opencode service start` 再重读注册表。[服务文档](https://opencode.ai/docs/troubleshooting) · [HTTP API](https://opencode.ai/docs/server)

## 会话与消息

| 操作 | 端点 | 说明 |
| --- | --- | --- |
| 新建会话 | `POST /api/session {location:{directory}}` | 返回 `ses_*`；`location` 决定项目归属 |
| 会话列表 | `GET /api/session?directory=&limit=&cursor=` | `data[]` + `cursor.next`，标题由服务自动生成 |
| 读会话 | `GET /api/session/{id}` | 404 返回 `_tag:"SessionNotFoundError"`，恢复时按此严格拒绝 |
| 消息列表 | `GET /api/session/{id}/message?limit=&cursor=` | 按 `user`/`assistant`/`idle` 分块，倒序翻页 |
| 发消息 | `POST /api/session/{id}/prompt {id,text,files?}` | `id` 必须以 `msg_` 开头且**全局唯一**（跨会话复用返回 409）；同会话同 ID 幂等，回执丢失可安全重投。Dovun 用 `msg_` + commandId，读历史时剥前缀还原关联 |
| 打断 | `POST /api/session/{id}/interrupt` | 终态 outcome 为 `interrupted` |
| 忙检查 | `GET /api/session/active` | `{data:{会话ID:{type}}}` |

`assistant.content` 是分块数组：`{type:'text'}`、`{type:'tool',name,state:{input,content,metadata}}`、`{type:'reasoning'}`。`idle` 消息带 `outcome: succeeded|failed|interrupted`。Dovun 按「用户消息开轮」切分，idle 决定轮状态；历史游标沿用 Claude 库的边界语义（本页最旧一轮的用户消息 ID）。`files[].uri` 接受 data URL 图片，未在真实服务上验证过的能力不要写进手册。

## 事件流

`GET /api/event` 是全局 SSE（`data: {json}` 行 + `: heartbeat`），按 `data.sessionID` 过滤。Dovun 依赖的事件：`session.execution.started/succeeded/failed/interrupted`、`session.text.started/delta/ended`、`session.tool.called/success`（+ `input.started/ended`、`progress`）、`permission.asked/replied`、`session.step.*`、`session.usage.updated`、`session.renamed`。带 `durable.seq` 的事件按会话有序；`GET /api/experimental/session/{id}/log?after=&follow=` 只做实时跟随（`log.synced` 给出当前 seq），不回放历史，断线补齐靠消息快照。流断开交给执行器重连路径，恢复时 `session/active` 判忙、接回原轮。

## 审批、模型与档位

- 审批：`permission.asked {id:"per_*", action, resources[], save[]}`；应答 `POST /api/session/{id}/permission/{requestID}/reply {decision:once|always|reject}` 返回 204。`once` 对应 Dovun 的允许一次，`always` 保存为项目级 allow 规则，`reject` 拒绝本轮及该会话待处理请求。`save` 是工具建议的规则 pattern，不覆盖已配置的 deny。
- 模型：`GET /api/model?location[directory]=`（deepObject 编码）。响应里 `settings` 含供应商凭据，只投影 `providerID/id/name/enabled`，绝不落盘或上送。切换 `POST /api/session/{id}/model {model:{id,providerID}}`。
- 档位：Dovun 计划模式映射 `POST /api/session/{id}/agent {agent:'plan'}`，默认映射 `build`。`GET /api/agent` 列全部代理。OpenCode 没有每轮审批策略参数，权限由项目 `opencode.json` 的 `permissions` 规则决定。

## 已验证行为（2.3.2/2.4.1 实测）

同 ID prompt 重复投递只落一条消息；`always` 审批后重跑不再询问；interrupt 后 outcome 为 `interrupted`；服务由桌面 App 2.3.2 或独立 CLI 2.4.1 持有均可附接；执行器重启后凭 `service.json` 重新附接原会话。
