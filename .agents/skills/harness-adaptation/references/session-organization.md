# 原生会话置顶与分组

项目归属来自工作目录和本机项目映射。自定义分组可以跨项目，会话标签也能在多个项目里重复。项目和会话各自有置顶状态与顺序。归档影响列表可见性，保留原会话 ID 和历史。

## 各 Harness 的数据源

| Harness | 查询和关联 |
| --- | --- |
| Codex | 在当前 CLI schema 核对 `thread/list` 的 `projectId`、`section` 和 `sectionId`，用 `threadSection/list` 查分组，`archived: true` 查归档。Codex CLI 0.172.0 实测已返回分组 `id`、`name` 和会话归属。先核对当前 App Server 是否返回置顶。当前版本的桌面置顶 ID 和顺序可从有效 `CODEX_HOME` 的 `.codex-global-state.json` 中 `pinned-thread-ids` 读取。项目置顶查 `pinned-project-ids` 并用原生项目 ID 核对。每台机器分别验证桌面状态与协议的 ID。 |
| Claude Code | `listSessions` 或 `getSessionInfo` 的 `cwd` 对应工作目录，`tag` 对应会话标签。本机 CLI 2.1.328 的 JSONL 标签记录包含 `type: "tag"`、`sessionId` 和 `tag`，按原 UUID 读取最新记录。空标签表示清除。Dovun 列表读取末尾最多 2 MiB，局部读取未找到标签时保留上次结果。已核对的本机 SDK 无置顶字段。Claude Desktop 和云会话的显示设置另有来源。 |
| ZCode | 独立 CLI 的 `session/list` 用来定位原会话。桌面会话接口和本机 `~/.zcode/v2/tasks-index.sqlite` 提供组织信息。设置 `ZCODE_DATA_BASE_DIR` 时，与启动器共用有效数据目录。ZCode 4.0.0 的 `tasks` 有 `pinned`、`archived`、`project_id`、`sort_order`。`projects` 有置顶和位置，`project_roots` 有根目录，`task_groups`、`task_group_members` 和 `task_group_view_node_orders` 保存分组、成员和排序。按本机 `host_id`、工作区和精确的 `task_id` 核对 CLI 会话。未匹配的桌面条目需要另外确认归属和恢复能力。 |

[Claude Code SDK 会话字段](https://code.claude.com/docs/en/agent-sdk/typescript#listsessions) · [ZCode 桌面会话设计](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/docs/architecture/zcode-app-control-design.md)

## 接入与验收

1. 在 Mac 执行器读已授权项目的会话摘要。首选已验证的原生读接口。需要读本机索引时，核对路径、版本和表字段后只读查询。中继只接收与合法会话 ID 关联的显示字段。
2. 区分有效的未置顶、未分组、未归档与来源不可用。保留用户已在 Dovun 作出的设置。首页优先核对旧的置顶会话与之前已导入的置顶和归档记录，覆盖原生取消置顶或移出归档的场景。
3. 用同一项目的两条原生会话验证。分别读取一条置顶、一条有分组或标签的会话。对照原客户端核对顺序、刷新后的组名，以及归档恢复后仍可按原会话 ID 打开。
4. 验证旧版本或读取失败时，项目列表和原会话仍可打开。用隔离样本覆盖清除标签、取消置顶或分组、同名异项目、无匹配原生 ID，以及本机索引无法读取的情况。
