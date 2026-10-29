# 文档资源后端验证

记录日期：2026-10-30。范围为源码和隔离数据库验证，没有安装客户端、发布服务器或改写实际运行数据库。

## 已实现的边界

- 继续使用 Material/MaterialVersion 身份与历史证据 hash；显式保存格式、schema、权威正文、原始导入来源和独立补充说明。
- `/api/v1/library/resources` 提供创建、当前/历史读取、正文保存、整理、请求回执、引用影响、原件/来源原件下载、历史恢复。
- 正文保存、恢复与 fixed references 在同一事务内提交；创建/保存/整理/恢复用稳定 `requestId` 和精确回执。正文版本与整理版本各自 CAS，整理不会制造正文版本。
- `POST /:id/restore` 接收 `{requestId, expectedRevision, sourceRevision}`，对文本、富文档、Markdown、二进制均创建新版本。保留来源 schema、证据 hash、原件和补充说明，并重新验证引用权限。
- Markdown `relativeReferences` 是正文相对 URL 到确切资源版本的映射，存储为 `path:` 引用节点。别名允许规范化前导 `../`（最多 32 层），不作为文件系统路径使用。保存省略映射时沿用；显式空数组清除；仅映射改变也增加正文版本。
- 正文附件上传可指定 `managed:true`。提交后的原件持续保留，默认资料根列表隐藏，搜索仍能复用；显式移动文件夹转为普通资料。旧 TaskImage 保留旧 ID/URL，通过永久别名读同一原件，并随当前任务权限变化。
- 富文档禁止旧纯文本写入口覆盖；旧读取返回标记过的文字投影。AI `document_create`/`document_save` 复用原有待确认流程，审批时重新检查版本与引用权限；`library_read action=document` 提供绑定版本的无损分页产品源码。
- 导入可用 `importSource.original/sourceOriginal` 引用已提交原件，保留当前原件、初始来源和补充说明的关系；新导入使用新身份。文字原件须与提交正文一致。

## 自动验证

统一使用 Node 22.13.0。主回归数据库为 `file:/tmp/dovun-document-resource-contract.db`，上传原件目录由测试在系统临时目录创建，测试结束删除。

2026-10-30 01:28 的扩展回归：10 个文件、115 项通过（当时资源专测 18 项）。包含：

```text
src/application/resources/resource-contract.test.ts
src/application/knowledge.test.ts
src/application/library-contract.test.ts
src/application/task-images.test.ts
src/application/task-image-scope.test.ts
src/application/agent-library.test.ts
src/agent-command-contract.test.ts
src/agent-review.test.ts
src/assistant-context.test.ts
src/agent-workspace-search.test.ts
```

01:30 增加暂停写入回归后，资源专测 19 项全部通过，服务端 TypeScript 构建通过。国际化检查通过（941 条服务端消息）；`git diff --check` 通过。上述数量是该次运行证据，不代替主实施记录中的最终全量回归。

01:40 增加跨工作区来源原件及托管导入回归后，资源专测为 20 项，全部通过，服务端 TypeScript 构建通过。独立来源原件通过版本 metadata 绑定原件资源身份和版本；下载验证来源权限及字节路径一致，不将用户导入的原始 JSON 中旧 workspace ID 误当成新文档引用。

资源专测覆盖：同请求并发重试、幂等 payload 冲突、CAS、无变化不升版、独立整理版本、未知 schema 保留、无效节点/校验拒绝、历史固定引用、无权读取与原件下载、富文档 legacy 写入拒绝、AI 待确认及过期审批拒绝、旧导入字节与 BOM/CRLF、任务图片旧 URL/移动权限、撤销恢复引用及权限撤销、导入 provenance、二进制恢复、Markdown 映射、长文档无损分页、兼容模式只读。

复核修复：撤销富文档以前漏建新版本引用，现与新版本事务一同重建并验证权限；原件下载以前可绕过 DTO 的受限附件标签遮蔽，现重新验证确切引用权限，拒绝不可见原件；请求 ACK 只承认该请求保存的正文/整理版本，不借用后续并发结果；普通旧上传的提交 hash 不引入默认 `managed:false`，保持升级后旧重试兼容。

## 合成旧数据迁移演练

入口：`server/src/application/resources/migration-rehearsal.ts`。只在 `/tmp` 中创建演练库；可接收 `--source <副本数据库> --blobs <原件目录>`，通过 SQLite 只读备份并复制已引用原件，在新的临时副本执行迁移及二次迁移。

```bash
PATH="/Users/byc/.volta/tools/image/node/22.13.0/bin:$PATH" \
DATABASE_URL=file:/tmp/dovun-document-rehearsal-unused.db \
node_modules/.bin/tsx server/src/application/resources/migration-rehearsal.ts
```

成功报告：`/tmp/dovun-document-migration-3Gwk08/report.json`；运行日志：`/tmp/dovun-document-migration-run.log`。

| 项目 | 迁移前 | 迁移后 |
| --- | ---: | ---: |
| Material | 2 | 3 |
| MaterialVersion | 3 | 4 |
| TaskImage | 1 | 1 |
| 永久别名 | 0 | 4 |
| ResourceReference | 0 | 0 |
| 原件数 / 总字节 | 3 / 73 | 3 / 73 |

新增的 1 个资源和版本对应旧任务图片。所有旧版本字段摘要、旧图片行摘要、原件字节与 SHA-256 均相同；历史 `contentHash` 未被重算。Markdown 当前原件包含 BOM、CRLF 与表格，迁移为权威正文，旧正文保留为补充说明。兼容投影 hash 与权威原件 hash 相同。二次迁移 `mappedMaterials=0, annotatedVersions=0, mappedTaskImages=0`，整份盘点不变。

合成样本不能替代真实副本演练或旧安装客户端验收。脚本报告不包含正文、标题或凭据。

## 真实受控副本迁移

主实施代理通过实际本机进程 PID 42953 的 `lsof` 确认正在使用的默认 `dovun.db`，并核对桌面 `lib.rs` 的原件目录规则及数据目录下实际 `knowledge-blobs` 中的已引用原件。演练脚本以 SQLite 只读备份生成临时副本，只复制已引用原件，然后在该副本执行迁移；未向原库或真实原件写入，未改变应用状态。

结果报告：`/tmp/dovun-document-migration-G73x5s/report.json`。本记录核对报告聚合数据，不展开私人正文。

| 项目 | 迁移前 | 迁移后 |
| --- | ---: | ---: |
| Material | 231 | 241 |
| MaterialVersion | 237 | 247 |
| TaskImage | 10 | 10 |
| 永久别名 | 0 | 251 |
| ResourceReference | 0 | 0 |
| 已引用原件总字节 | 1,811,557 | 1,811,557 |

报告 `ok=true`；`preservedVersions`、`preservedImages`、`preservedBlobs` 均为 `true`。二次执行三项迁移计数均为 0。新增 10 个资源版本对应既有任务图片，旧身份和内容摘要未改写。此结果验证受控真实数据副本；不代表已安装应用或真实手机完成了新版功能验收。

## 兼容回滚演练方式

保留支持新格式的服务端读取能力，启动时显式设置 `DOVUN_DOCUMENT_READ_ONLY=1`。这暂停资源发布，不是降级数据库，也不是声称旧二进制理解新 schema。

- 新资源 DTO 返回 `writesPaused:true`、`readOnly:true`、`capabilities.edit:false`。
- 新创建/正文保存/恢复/整理返回 `503 DOCUMENT_READ_ONLY`。旧 material、resource、资料文件夹/标签、引用组织命令及其撤销同样禁止，旧任务图片发布禁止。
- 已完成请求的 receipt、所有新格式的读取、历史版本、原件、兼容文字投影继续可用。
- 分片上传的 init/chunk/finish 可以暂存字节；发布为 Material 被拒绝，不产生“已保存正文”的回执。客户端草稿保留，可导出。
- 这不是整站只读开关：任务、聊天、权限范围等独立功能仍按原规则运行；任务移动/删除导致的访问限制继续生效。

资源专测已在开启该开关时验证历史读与回执成功、新旧发布路径均拒绝且正文版本不变。真实旧客户端与跨设备回滚表现仍需单独验收。

补充本机草稿恢复出口：`client/src/lib/documents/draft-recovery.ts` 的 `exportDraftRecovery(session)` 无网络导出当前草稿、确认基线、冲突双方、未知请求精确正文、本机附件字节和 SHA-256。附件缺失时 `complete:false` 并给出清单，正文仍保留；不自动重放写入、不读取认证凭据。01:44 新增恢复包 3 项与会话 22 项共 25 项通过，覆盖未知结果不重发、IDB 失败时内存原件导出、缺失附件明确标注。

## 最终服务端全量回归环境

另建全新目录 `/tmp/dovun-document-server-regression-5ushxn`，显式设置：

```text
DATABASE_URL=file:/tmp/dovun-document-server-regression-5ushxn/test.db
KNOWLEDGE_STORAGE_ROOT=/tmp/dovun-document-server-regression-5ushxn/blobs
LIBRARY_UPLOAD_ROOT=/tmp/dovun-document-server-regression-5ushxn/uploads
```

先运行 `npm run db:migrate -w server`（60 个迁移完成，`migrate.log`），再运行 `npm run test -w server`（`tests.log`），没有执行会操作仓库测试库的根 `npm test`。

最终结果：115 个文件，114 通过、1 失败；1005 项测试，1004 通过、1 失败。开始时间 01:48:29，耗时 324.17 秒，退出码 1。资源合同 20 项通过；本次没有发现新增失败。唯一失败为下述已独立复现的基线断言。

已知基线失败独立复现：`agent-external-prompt.test.ts:86` 期待 `partsJson === '[]'`，实际为空来源的 `assistant_citations` 记录；超长提示词仍正确返回 `PROMPT_TOO_LONG`，没有生成外部提示词卡片。使用 `git archive HEAD` 的未修改源码副本与另一份隔离数据库单跑同一测试，结果同为 1 失败、2 通过。副本位于上述目录的 `baseline/`，精确提交记录在 `baseline-commit.txt`，日志在 `baseline-test.log`。未修改这个既有断言。

## 大文本索引锁回归

三端大文本浏览器用例暴露了短行数量放大：旧提取器每行生成一个块，25,000 行使规范化映射、n-gram 与全部索引写入占用一个长事务，后续浏览器启动连接及测试清理出现等待/超时。

修复将连续短行按最多 1,200 码点合并并保留真实行范围，不截断提取正文。规范化与 n-gram 计算移到写事务外，每批最多 8 块，未完成的新代只暂存；最后通过租约、代号和整理版本校验，原子切换 `indexedGeneration`。旧代在此之前继续提供分页和搜索；旧块保留用于既有引用。租约被替换时清理未发布块，整理版本并发改变时重排队，避免发布过时标题/标签。

隔离目录 `/tmp/dovun-library-index-7e4ikt95`，显式 `DATABASE_URL=file:/tmp/dovun-library-index-7e4ikt95/test.db`、该目录下 `blobs`/`uploads`，先迁移再跑 `library-index-budget.test.ts`、`library-contract.test.ts`、`library-repair.test.ts`。02:31:05 开始，3 文件 38 项通过，34.11 秒；日志 `migrate.log`、`tests.log`。服务端 TypeScript 构建通过。

精确浏览器样本（BOM、CRLF、emoji、25,000 个重复短行及结尾标记）实际为 500,031 字节，生成 272 个完整索引块。测试记录 worker 约 1,508 ms、并发写最长 47 ms；逐页取完并重组的投影与输入一致，末尾标记可检索，权威正文、历史 `contentHash`、revision 均未改变。另覆盖暂存代不可见、租约失效清理、旧出处可读、整理并发时重排队。浏览器三端复验由主实施代理另记，不以此服务层结果代替。

后续独立复核发现共享标签改名/撤销不递增资料整理版本；final 发布事务现同时重读并比较标签名称，防止暂存批次重新写回旧标签。无附件的 `text` 直接使用权威正文及相同行范围提取函数，省去每份小文本启动 Office/PDF 提取子进程；Markdown、原件附件仍走既有提取流程。worker 保持并发 2，有实际任务完成时立即继续排空，空队列仍每秒轮询；每次启动持有独立停止标记，停止后的旧回调不能恢复运行。

最终小修隔离目录 `/tmp/dovun-library-final-index-s0zen06f`，同样显式隔离数据库、blobs、uploads 并先迁移。02:44:33 开始执行相同 3 文件，新增标签名称竞态、121 文本队列、空队列及停止回调测试后，共 41 项通过，24.76 秒。日志 `migrate.log`、`tests.log`。121 份纯文本队列记录 955 ms；25,000 行样本仍为 272 块，worker 1,033 ms、并发写最长 55 ms。会话代理独立只读复核标签 final gate、纯文本定位语义、并发上限和停止回调，未发现 P1。


## 冻结后服务端全量与同步独立复验

在另一份全新数据库 `/tmp/dovun-document-server-final.6RtDwP/test.db` 完成全部116文件、1010项测试：1005通过，5失败（日志同目录 `tests.log`）。其中仍有已在干净基线确认的 `agent-external-prompt.test.ts:86` 断言失败；另4项来自未改动的 `sync-replica.test.ts`，3项超过原有5秒测试时限，后续1项出现正在对齐状态的断言失败。该轮同时进行前端构建和浏览器回归，不将并行负载推测当作已证实根因。

将整份同步测试放在新隔离库 `/tmp/dovun-document-sync-final.cqrwyC/test.db` 独立重跑，22项全部通过，测试主体2.83秒；没有修改同步源码、测试断言或超时。日志 `tests.log`。因此不能把第二次全量说成全绿；同步独立复验通过与全量原始结果分别保留。

转换来源新增契约在 `/tmp/dovun-document-conversion.98WYgS/tests-final.log` 验证21项全部通过：转换创建新资源，来源绑定确切旧版及hash；重复请求不重复创建；副本继续编辑仍保留来源；无权读取原来源时DTO不暴露来源身份，受限主体不能通过转换绕过读取权限。


## 最终冻结源码的全量收口（02:50）

最后一轮使用全新目录 `/tmp/dovun-document-server-verified.xPiC3K`，迁移60项后运行全部服务端测试，未调宽时限：116文件中115通过、1失败；1013项中1012通过、1失败，耗时229.82秒。唯一失败仍为已在干净基线独立确认的 `agent-external-prompt.test.ts:86` 断言；此前同步文件的4项失败没有重现，整份同步文件通过。资源21项、新索引7项均在本轮通过。日志为该目录 `tests.log` 与 `migrate.log`。

最终服务端TypeScript构建通过，前端完整构建及506项测试通过；本次未执行桌面打包、安装或线上发布。此前运行结果保留作诊断记录，当前源码交付以本节及主实施记录为准。
