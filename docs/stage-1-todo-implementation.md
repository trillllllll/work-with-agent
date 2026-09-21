# 第一阶段：基础 Todo 实施与接口

目标依据 [架构基线](./architecture-baseline.md)。基础 Todo 不依赖模型配置；内置聊天、审批和受控执行保留为可选入口。MCP、连接授权、完整外部版本协议与请求幂等不属于本次交付。

本文保留第一阶段的交付记录。第二至第五阶段已为这些接口补上认证、CSRF、显式版本和级联预览；当前调用方式见 [最新接口契约](./stages-2-5-api.md)，不要直接沿用下文省略认证与版本的历史示例。

## 实施批次

1. 共享业务校验、完成/重新打开、统一查询与串行任务写入。
2. 增量迁移：一级子任务、整数顺序、删除批次、标签关系、单调版本和分组审计。
3. 收集箱与清单列表、连续录入、显式保存详情。
4. 今天、搜索、组合筛选、标签与手动排序。
5. 父子事务、归档管理、分组回收站恢复与撤销。
6. 旧数据迁移、桌面/移动端无模型验收及既有 Agent 回归。

## REST 契约

路径中的清单继续使用 `topics`，不重命名已有 Topic/Task ID。

| 接口 | 行为 |
| --- | --- |
| `GET /api/tasks` | 按 `topicId` 或 `inbox=true`、`q`、`status`、`dueFrom`、`dueTo`、逗号分隔 `tagIds`、`sort` 查询；默认排除已删除和归档任务 |
| `GET /api/tasks/:id` | 读取最新任务、标签与子任务 |
| `POST /api/tasks` | 仅标题必填，默认待办；可传 `parentId` 创建一级子任务 |
| `PATCH /api/tasks/:id` | 局部更新；未提供保持原值，`null` 清空可空字段，`tagIds: []` 清空标签 |
| `POST /api/tasks/reorder` | `{ topicId, parentId, orderedTaskIds }`；两个归属字段均显式传 ID 或 `null` |
| `DELETE /api/tasks/:id` | 任务及本次涉及的未删除子任务进入回收站 |
| `GET /api/trash/tasks` | 回收站及父子关系信息 |
| `POST /api/trash/tasks/:id/restore` | 按删除批次恢复；失效归属回退收集箱，返回提示 |
| `DELETE /api/trash/tasks/:id/permanent` | 永久删除已在回收站的任务及明确关联的子任务，不能撤销 |
| `GET /api/topics?archived=true` | 查询归档清单；不传参数则查询活动清单 |
| `GET /api/topics/:id?includeArchived=true` | 显式读取归档清单 |
| `POST /api/topics/:id/archive` | 归档并保留所有任务归属 |
| `POST /api/topics/:id/restore` | 恢复归档清单 |
| `POST /api/topics/:id/move-tasks-to-inbox` | 显式将清单任务移入收集箱 |
| `GET/POST /api/tags` | 列出或创建标签 |
| `PATCH/DELETE /api/tags/:id` | 改名或删除标签；删除只解除关联 |
| `POST /api/changes/:id/undo` | 冲突检查后原子撤销，追加新历史 |

任务状态筛选为 `open`、`done`、`all`，也兼容 `todo/doing/blocked`。日期为有效本地日历日期 `YYYY-MM-DD`，日期范围包含边界。`sort` 支持 `manual/date/priority`；日期排序中无日期排最后，同值使用稳定 ID。`parentId=null` 查询根任务，省略则返回匹配任务的扁平集合。

父任务仍有未完成子任务时，直接完成返回 `409 SUBTASKS_INCOMPLETE`；用户明确选择后，以 `completeChildren: true` 重试。新建、恢复或挂接未完成子任务、重新打开子任务时，已完成的父任务一起重新打开。所有组合修改由应用用例在单个事务中维护。

成功保持 `{ data, error: null }`，写操作另外返回 `meta`，可包含 `changeId`、`affectedTaskIds` 和 `warnings`。客户端保留错误码及 HTTP 状态，不能把失败、冲突或未确认显示成保存成功。

### 兼容入口

`DELETE /api/topics/:id` 仍是旧的“归档并将任务移入收集箱”操作；新的清单界面使用 `/archive`。内部 `delete_topic` 分发保持旧行为，历史 `archive` 快照不重新解释为新归档语义。

现有内置 Tool 继续经过原审批流程，再调用相同应用用例。普通 Todo 界面直接保存。未接入第二阶段身份/授权前，不应把现有界面 REST 视为面向外部 AI 的开放连接协议。

## 数据与交互约束

- 新迁移保留旧 ID、状态、说明、成果、审批和归属历史；旧任务成为根任务，顺序按原 `updatedAt DESC` 加稳定 ID 回填。
- 同一次操作写一条版本化分组 ChangeRecord，包含对象和关系快照；保留已有非空 `request_id` 唯一索引。
- `revision` 单调增加，撤销不会写回旧版本或旧时间。撤销检查涉及的对象、父子/标签关系及排序范围，冲突则整组拒绝。
- 任务详情显式保存；已保存实体与未保存草稿分开。所有同任务写操作串行提交，回包不覆盖脏字段。
- 快速录入草稿按清单/父任务隔离保存。IME 选字和重复按键不提交；提交期间同步锁定，保存成功才清空对应草稿。写请求不自动重试。
- 手动顺序只属于收集箱根任务、清单根任务和同父子任务。重排必须包含该范围未删除的所有任务，包括已完成任务；筛选视图不允许提交部分集合。
- 基础创建、移动和恢复追加到目标范围末尾；文字编辑和完成状态切换不改变位置。
- 归档任务不能直接编辑。删除仍关联归档任务的标签时，先恢复相应清单；标签名称本身仍可作为全局分类名称修改。

## 验证方式

迁移和集成测试使用独立 SQLite，不在开发数据库执行测试重置。完整验收使用 Node.js 22（与 CI 一致），迁移测试使用 Node 内置 SQLite；本次验证环境为 22.17.1。Windows 下生成 Prisma Client 前停止使用本项目 Prisma DLL 的服务。依次运行：

```text
npm run prisma:generate
npm test
npm run build
npm run e2e
```

基础 Todo 的 E2E 不配置模型；原有 Agent 场景继续使用本地 Mock。覆盖新旧迁移、领域/REST/Tool 一致性、草稿与缓存竞态、父子生命周期、排序与撤销冲突，以及 Chromium 桌面和 Pixel 7 移动视口。E2E 使用独立 API 端口 `3015`、前端 `5175`、Mock `4010`，不会复用运行中的开发服务。

## 实际验收记录（2026-09-21）

- Prisma Client 已显式生成，10 个迁移在独立测试库成功应用。
- `npm test`：服务端 61 项、客户端 10 项全部通过；包括空库/旧库迁移、REST/Tool 契约、旧快照兼容和分组撤销。
- `npm run build`：服务端 TypeScript、客户端 TypeScript 和 Vite 生产构建通过。Vite 保留单个 bundle 大于 500 kB 的体积提示。
- `npm run e2e`：33 项通过、9 项按条件跳过；26 项无模型 Todo 验收全部通过（13 个场景 × 桌面/移动）。跳过项为 7 个仅适用于另一视口的既有场景及 2 个未配置的真实模型冒烟测试。

端到端验收新增 13 个无需模型的 Todo 场景，分别在桌面和移动视口执行。网络延迟与失败场景验证提交锁、跨清单草稿、同任务串行、独立任务失败隔离和冲突确认；本地日期跨午夜场景验证今天/逾期自动变化。旧 Agent 审批、成果、受控执行和聊天导航场景继续保留。
