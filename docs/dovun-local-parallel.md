# 本机 WWA 与 Dovun 独立并行

2026-10-23，用户明确要求保留两套应用、迁移 WWA 数据，且两套需要同时运行。本次授权覆盖独立安装与本机验证，不包含服务器部署、仓库或域名改名。

| 项目 | WWA | Dovun |
| --- | --- | --- |
| 应用 | `/Applications/Work With Agent.app` | `/Applications/Dovun.app` |
| 系统标识 | `app.workwithagent.desktop` | `app.dovun.desktop` |
| 本机端口 | 47316 | 47317 |
| 数据目录 | `~/Library/Application Support/work-with-agent` | `~/Library/Application Support/dovun` |
| 数据库 | `agent-studio.db` | `dovun.db` |

这是一份独立副本。导入后两套分别保存，不自动持续同步。WWA 的应用、启动器、执行端绑定和原数据保留；本次不修改宿主 MCP 配置或新增连接。

## 首次导入

1. 退出 WWA 并停止本机服务及执行端。离线目录迁移先做完整备份、逐文件核对，再建立 Dovun 副本。普通资料/数据库链接仍拒绝；执行端 worktree 内部的相对依赖链接可原样保留，不能逃逸到其他目录，复制不会跟随链接。
2. 复制并核对原生浏览器 profile，原件与完整备份保留。完成标记独立于工作 profile；之后不再检查旧进程或重导入旧状态。已导入的 profile 丢失时停止并要求恢复备份。
3. Dovun 在首次启动服务前，短暂占用两个空闲端口，用主 WebView 依次访问旧、新本机 origin，将保存的偏好和 IndexedDB 草稿导入 47317。桥仅监听 loopback，使用随机令牌、Host/Origin 校验、CSP，无跨域开放，不记录正文或凭据。
4. 本机 origin/API 范围一起更新到 47317，用户 ID、任务 ID、分支、版本与 outbox 保留；属于其他服务/用户的 scope 不改。已有较新编辑保留，冲突成为恢复分支。主 WebView 导入后继续打开工作区；已退出旧窗口所丢失的 sessionStorage 临时输入无法恢复，不宣称它们已找回。
5. 原生 profile、数据和 origin 分别保存完成凭证。后续启动不触碰 WWA 端口、profile 或数据，因此 WWA 可以同时运行。首次迁移失败时保留来源、备份、恢复快照；不会启动空工作台。

## 避免重复执行

复制的 `node/config.json` 和 `sync-device.json` 移入 Dovun 数据目录中的 `migration-disabled-bindings/`，不撤销原 WWA 的绑定。Dovun 的定期回顾和自动记忆先暂停；迁移记录保留暂停数量。用户独立配置后可重新绑定/启用，之后不会再次被启动流程归档或暂停。

资料附件使用相对路径；执行历史中指向旧数据目录的 Artifact 路径只在复制库中改到新目录，不改用户正文、仓库路径或原库。原始逐字节副本及全部文件清单仍在备份和私有迁移记录中。

## 本次记录

真实数据的私有记录在 `~/Library/Application Support/Dovun migration records/migration.json`，包含备份位置、数据库前后摘要、70 张表的行数及暂停信息。凭据与用户正文不进入仓库。

首次复制包含 109,071 个文件，原库在复制前后 SHA256 相同，初始 Dovun 数据库与原库逐字节一致；70 张表行数相同，`quick_check` 为 `ok`。迁移基线含 146 条任务、6 个清单、214 份资料、34 条记忆、73 个会话；其中含归档/历史数据，并非各页面当前筛选下的可见数量。复制库暂停 1 条定期回顾、7 个自动记忆范围。

安装、实际 origin 导入和双应用同时运行的结果在完成后追加，代码和隔离测试通过不等于已安装验证。
