# 0.3.0 旧名称保留清单

这里说明有意保留的类别，不能据此批准无关页面继续显示旧品牌。

| 类别 | 位置/原因 | 后续 |
| --- | --- | --- |
| 运行配置兼容 | `runtime-env.ts`、桌面 `environment`、MCP 连接响应与旧条目模式 | 0.4.0 移除回退；现有条目更新而非新增 |
| 原系统身份 | `tauri.conf.json` 的 app.workwithagent.desktop | 原生浏览器状态迁移验证后切换 |
| 旧启动器 | `bin/wwa-mcp` 转发、旧绝对路径 | 仅过渡一版 |
| 通信兼容 | legacy-events、desktop-shell 哨兵路径、旧语言头和 cookie | 仅过渡一版 |
| 数据导入 | agent-studio.db、旧偏好键、wwa-task-editor、旧目录 | 作为迁移来源，不能删除用户旧状态 |
| 内容协议 | wwa-material、data-wwa-material、wwa://、HTML sandbox 标记 | 持续解析历史正文，不批量改写用户内容 |
| 外部身份 | GitHub URL、现有域名/服务器路径、Compose 服务/容器名 | 实际切换另行执行 |
| 历史资料与测试 | 原设计、调研、兼容夹具、脱敏测试凭据 | 保留来源与测试意义 |

排查使用 `rg -n 'WWA_|work_with_agent|work-with-agent|agent-studio|wwa-' client/src server/src desktop scripts .github README* docs/deployment.md`，逐项按上表判断，不做全仓机械替换。密钥与用户正文不纳入扫描输出。

0.4.0 分支已移除上表的运行配置回退、旧事件桥、旧语言/会话入口和目标目录的旧启动别名。旧配置仅作为启动阻断诊断，旧目录/偏好/草稿仅作为导入来源；正文协议、快照解析、外部仓库与现有部署身份继续保留。`window.wwa` / `wwa:*` sandbox 协议属于已有交互资料内容的兼容接口。
