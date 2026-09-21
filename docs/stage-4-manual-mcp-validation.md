# 4A 已有宿主会话的真实 MCP 验收

验收入口：

```powershell
npm run build --workspace server
npx tsx server/src/mcp/real-smoke.ts --run --handoff-only
```

脚本为每次运行建立独立 SQLite 数据库，并通过操作系统分配的随机回环端口启动真实 API。Codex 与 Claude Code 使用各自独立、仅有收集箱范围的连接凭据；结束后撤销凭据。不占用 E2E 端口、不修改用户全局 MCP 配置、不运行应用的本地任务 runner。

每个宿主先开启一段真实会话，仅用 `get_handoff` 读取选定材料。脚本从宿主结构化输出提取明确的 session ID，随后以该 ID 续接同一会话完成：

1. `get_handoff` 读取冻结任务与选定材料。
2. `claim_handoff` 领取一次，使用首次返回的 claim token。
3. `report_progress` 将相同 event ID 和内容提交两次。
4. `report_run` 将相同 event ID 和完整结果提交两次。
5. 再次 `get_handoff` 检查唯一 Run 及返回结果。

随机 `SOURCE_ONLY_` 标记只存在于选定材料正文，没有注入宿主提示词。真实回报必须包含该标记。通过条件同时检查实际 MCP HTTP 请求及数据库：领取者是正确连接，只有一个 manual Run、一个进度事件和一个结果事件；Task 仍为 `todo` 且 revision 未变；用户调用 `review` 并明确 `completeTask:false` 后，Task 仍未完成。

脚本只在这些数据库断言全部通过时记录通过。宿主未调用工具、模型自述成功、模拟回报或跳过均不能通过。输出日志保存前移除连接凭据、用户 cookie、CSRF token 和 claim token；summary 只记录版本、会话 ID、对象 ID、事件种类及无请求正文的 HTTP 轨迹。

`--run` 不加 `--handoff-only` 会保留原有两宿主查询、提议、重复提交与版本冲突验收，并追加上述交接流程。

## 实测记录

完成时间：2026-09-21 01:29:57（Asia/Hong_Kong），对应 `2026-09-20T17:29:57.328Z`。`--handoff-only` 实际进程退出码为 0，两个宿主均通过，没有 skip 或模拟回报。

| 宿主 | CLI 实测版本 | 明确续接的会话 ID | 结果 |
| --- | --- | --- | --- |
| Codex | `codex-cli 0.155.0` | `01a0bfdb-f580-7480-96a0-8e7cf621eb60` | 通过 |
| Claude Code | `2.1.276 (Claude Code)` | `ead66772-80d6-4abe-b2ab-467c19fc40e9` | 通过 |

Claude Code 的初始化事件报告模型为 `kimi-for-coding`，因此这里验证的是当前本机 Claude Code 宿主及其配置模型，不声称验证了 Anthropic Claude 模型。Codex 的结构化输出未报告模型标识，本记录不推定其模型版本。

每个宿主的实际 HTTP 轨迹均为：读取交接 3 次、领取 1 次、进度回报 2 次、结果回报 2 次，全部返回 200。数据库均只有一个 `manual` Run，事件序列为 `claimed → progress → result`，没有重复或晚到结果。选定材料版本为 1，回报包含来源中的随机标记。回报前后及用户采纳后 Task 均保持 `todo`、revision 1。

最终脱敏证据目录：

```text
C:/Users/13431/AppData/Local/Temp/wwa-mcp-hosts-LwffcJ
```

包含 `summary.json`、两宿主各自的 `*-handoff-context.jsonl` 与 `*-handoff.jsonl` 及对应 stderr。四份 JSONL 已检查，未发现未脱敏的 claim token 字段；宿主工具事件只包含本次四项白名单，没有 Shell 或文件操作。独立数据库为 `server/data/mcp-real-1789925251823.db`。

原 2B 真实查询、提议、重复请求及版本冲突证据仍保留在 `C:/Users/13431/AppData/Local/Temp/wwa-mcp-hosts-LTkUO5`。本次专门执行 4A 的 `--handoff-only`，未将旧结果重复算作本次通过项。

## 范围与限制

这是合成任务和选定材料的真实宿主 MCP 集成验收，使用本机现有宿主登录配置。它验证明确 session ID 的会话续接和应用业务状态，不代表任意模型、任意长历史会话或不同 CLI 版本均兼容。Claude Code 的宿主版本与其当前配置模型分别记录，不能将宿主名称当作模型供应商。

日志脱敏覆盖本脚本生成的证据副本；宿主自行保存的本机历史由宿主管理。验收连接随后撤销。普通宿主工具没有授权写入文件或执行项目命令；本流程也不采纳代码补丁，不代替 4B 的独立 runner / 代码应用验收。
