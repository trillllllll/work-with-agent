# 记忆读取口径核对

核对范围：内置 AI 的已确认记忆注入、`memory` / `memory_read` 工具、知识页记忆详情及知识 API。这里的“额度”是每次组装 AI 系统提示词时允许放入的字符预算，不是数据库容量、记忆条数或新增配额。

## 六项结论

### 1. 收集箱记忆额度

**结论：打开某份清单时，收集箱记忆正文预算是 1,400 个 JavaScript 字符；没有打开清单、只加载收集箱时是 2,200 个字符。**

预算计算的是格式化后的整条文本，包含 ID、revision、kind、标题、换行和最多 360 字符的正文摘要，不等于原始正文字符数。加载候选最多取排序最前的 100 条；超过 100 条时提示可能还有更多，需搜索。

实测过程与结果：

- 输入：测试库写入多条收集箱记忆，分别在“打开清单”和“未打开清单”上下文组装提示词。
- 观察：聚焦测试分别匹配到 `收集箱记忆（约 n/1400）` 与 `收集箱记忆（约 n/2200）`。
- 结论：两种页面上下文使用不同预算；1,400 是与清单记忆共同加载时给收集箱的预算，2,200 是收集箱单独加载时的预算。

### 2. 清单记忆额度

**结论：当前清单记忆正文预算是 2,200 个 JavaScript 字符。**

它与同页收集箱的 1,400 字符分开计算，不是两者共享 2,200。候选同样最多加载排序最前的 100 条。

实测过程与结果：

- 输入：测试库写入当前清单和另一清单的多条记忆，再以当前清单组装提示词。
- 观察：提示词匹配 `这份清单的记忆 <topicId>（约 n/2200）`；另一清单正文没有出现。
- 结论：当前清单有独立的 2,200 字符预算，并按清单隔离。

### 3. 达到上限后新增的实际行为

**结论：达到提示词预算后，系统仍允许发起新增；新增不会因为 1,400/2,200 字符预算被拒绝。写操作仍须用户确认，确认后正常保存。之后重新组装上下文时，放得下的记忆带正文，放不下的记忆只列 ID 和标题；最多列 12 条溢出索引，其余显示“另有 N 条未列出”。**

排序顺序为重要度降序、更新时间降序、ID 升序，所以新增记忆确认后通常因更新时间较新而挤入正文预算，但仍取决于重要度和格式化长度。正文单条另有 20,000 字符输入限制，这与提示词总预算不是同一个限制。完全相同的有效记忆会被重复校验拒绝。

实测过程与结果：

- 输入：测试数据先把收集箱和清单预算填满，再组装上下文；另调用 `memory add` 尝试直接写入。
- 观察：上下文仍成功生成，溢出条目显示 ID/标题而不显示其正文，并出现“新增前请先 replace 或 remove”的提示；直接写入返回 `APPROVAL_REQUIRED`，数据库没有被越权修改，而不是返回容量超限。
- 结论：预算满是上下文裁剪与整理提醒，不是存储硬上限；AI 新增仍走待确认流程。现有聚焦测试没有自动批准这笔提议，因此“批准按钮后的端到端落库”本次**未确认**；卡点是测试刻意验证 AI 不能绕过用户确认。但命令实现中没有按 1,400/2,200 拒绝创建的分支。

### 4. 为什么显示“未放入正文”

**结论：该条目属于当前可见范围且仍有效，但按排序轮到它时，整条格式化文本已放不进该范围剩余的提示词字符预算。它不是被删除、退役或无权限。**

打包逻辑不会截断整条格式化项来硬塞：能完整放入就带 ID、revision、kind、标题和最多 360 字符的正文摘要；不能完整放入就进入 overflow，只在“未放入正文”下列 ID 和标题。可以再用 `memory read` / `memory_read` 读取，或用 search 找到。测试已验证溢出正文不在提示词中，但 read 能返回完整后缀、search 能命中其正文。

### 5. replace/remove 是否需要 expectedRevision

**结论：需要，二者都必须携带正整数 `expectedRevision`。通常先 read/search 取得当前 revision，再提交 replace/remove。缺失时参数校验直接返回“需要 expectedRevision”；版本不一致时返回 `VERSION_CONFLICT`，提示先 read 再修改。**

`replace` 对应底层 `memory.update`，必须同时提交完整标题和正文；`remove` 对应 `memory.retire`，语义是退役并保留历史，不是硬删除。命令生成时也会把已读取到的当前 revision 写入底层命令的 `expectedRevision`。

实测过程与结果：

- 输入：对 replace/remove 参数分别省略 `expectedRevision`，以及检查已有的参数校验与冲突分支。
- 观察：聚焦测试覆盖参数校验；源码明确在 revision 不一致时抛出 409 `VERSION_CONFLICT`。
- 结论：expectedRevision 是强制乐观锁，不是可选提示字段。

### 6. 历史版本如何查询

**结论：有三条已确认路径。**

1. 界面：工作上下文 → 长期记忆，选中记忆后展开“历史版本”；详情响应包含按 revision 倒序的不可变 `versions`。
2. HTTP / MCP：`GET /api/v1/knowledge/memories/:id` 返回当前记忆及 `versions`；MCP `get_memory { memoryId }` 调用同一路径。先找退役条目可用列表接口的 `status=history` 或 `status=all`。
3. 内置助手：`memory_read { action: "read", memoryId, revision }` 可按具体 revision 读取；省略 revision 时读取当前版本。知识页若已选中历史 revision，页面上下文也会把该 revision 作为默认值。

旧的 `memory` 工具的 `read` 只读当前版本，不接受历史 revision；需要指定历史版本时用 `memory_read`。历史版本不存在时返回 404“记忆版本不存在”。

实测过程与结果：

- 输入：构造当前 revision=2 且保存 revision=1 历史的记忆，分别读取默认版本与知识页选中的 revision=1。
- 观察：聚焦测试默认读取返回当前内容，选中 revision=1 时返回历史内容。
- 结论：历史版本可按 revision 精确查询；详情接口还可一次取得版本列表。

## 代码依据

- `server/src/application/agent-memory.ts`：预算常量、排序与 100 条加载上限、整条打包/overflow、参数校验和乐观锁。
- `server/src/application/agent-memory.test.ts`：1,400/2,200 预算、范围隔离、overflow 的 read/search 实测。
- `server/src/application/knowledge.ts`：记忆详情及 revision 倒序历史。
- `server/src/routes/knowledge.ts`、`server/src/mcp/create-server.ts`：HTTP 与 MCP 查询入口。
- `server/src/agent/builtin-tools.ts`、`server/src/assistant-context.test.ts`：`memory_read` 指定 revision 的读取行为。
- `client/src/components/workspace/KnowledgePage.tsx`：知识页“历史版本”展示。
