# Worker 真实进程中断与租约恢复

2026-10-30 执行完成，结果见 [原始 JSON](worker-recovery-20261030.json)。本次运行不是注入过期时间：被认领任务保留原始 120 秒租约，脚本实际等待 120.087 秒后启动新 worker 进程。

## 过程与结果

| 阶段 | 实际状态 | 判题记录 / 复习项 / 复习事件 |
| --- | --- | --- |
| 合成简答答案已保存 | job queued，gradingVersion 1，retries 0 | 0 / 0 / 0 |
| PID 40762 已认领，进入受控模型等待 | job running，retries 1，原始 lease 到期为 2026-10-29 18:14:52.677 UTC | 0 / 0 / 0 |
| 只向该脚本创建的 PID 40762 发 SIGKILL | 子进程以 SIGKILL 退出，数据库仍为 running，答案不变 | 0 / 0 / 0 |
| 原租约自然到期后，新 PID 46513 运行真实 runPracticeJobs | processed 1，job/attempt succeeded，retries 2，gradingVersion 仍为 1 | 1 / 1 / 1 |
| 再用新 PID 46533 重复运行 | processed 0，有效判题与所有计数均未改变 | 1 / 1 / 1 |

提交前、终止后、恢复后、重复运行后的原始答案 SHA-256 完全相同：`d29c4ed459355d0bb19652dc64295d8dbf5b908442315720fae9172615b62b55`。总执行时间 121.286 秒。报告保存每阶段快照、退出信号、实际 PID、原始租约时间和源码哈希。

## 重放

在仓库根目录使用 Node 22；每次选不存在的临时数据库与输出文件：

```bash
/Users/byc/.volta/tools/image/node/22.13.0/bin/node --import tsx scripts/learning-worker-recovery.mts \
  --db /tmp/learning-worker-recovery-my-run.db \
  --out /tmp/learning-worker-recovery-my-run.json
```

脚本会执行约两分钟，等待中每 20 秒打印剩余时间。它拒绝已有数据库及 sidecar，只接受临时目录中 `learning-worker-recovery-NAME.db` 文件名。正常结束后删除自己的合成库和隔离配置目录；传 `--keep-db` 可保留合成库检查。该脚本未加入每次 `npm test`，避免固定增加两分钟。

## 验证边界

- 使用项目当前增量迁移创建合成库，创建真实题目版本、简答作答与持久化判题任务。
- 子进程运行真实 `runPracticeJobs`；仅模型响应替换为受控 fixture，没有真实模型请求。
- 子进程环境使用白名单，工作目录与数据目录均隔离；不读取真实配置、不复制凭据，也不操作其他 PID。
- 没有修改 Date、系统时间、worker 租约常量或 SQL lease 值。判题写入、有效版本切换及复习投影由真实服务代码完成。
- 本证据覆盖 worker 进程终止及新进程恢复，不等同于整台机器断电、文件系统损坏或桌面安装启动验收。

脚本：[learning-worker-recovery.mts](../../../../scripts/learning-worker-recovery.mts)；报告包含执行时的实际源码 SHA-256。
