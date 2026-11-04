# 双端发布记录：规划页 r3 日视图重做 + 瓷面蓝灰调色板

2026-11-04，按用户授权完成 macOS 打包、覆盖安装及生产部署。发布源码为 `main@beb34fc106b77be81bdd9256b8628bca2b3a2574`（origin/main 一致），应用版本沿用 `0.6.0`，按实际提交及资源哈希识别本次更新。

## 发布内容

本机安装跨越 6 个提交（旧包为 `e36261e` 产物），生产跨越 5 个提交（旧镜像 `a9c0d01`）：

- `77be531` 移除输入框下方的预览提示。
- `dc7ed43` 浅色/深色设计变量重做为瓷面蓝灰调色板。
- `586067b` 抬高暗色 muted 与链接对比度到 4.5 以上（生成器只守 3% 边缘，控件表面测试按 8% 白渐变合成颜色）。
- `084c0e6` 规划页日视图围绕日程本身重做：日期簇头部、显示设置收纳「显示已完成/显示时间段背景」、时间段全宽铺底且被占用时退为左缘竖排小字、一小时 96px、任务卡三档密度、卡内 44px 完成圆点、带时间标签的现在线、待安排托盘顶部当日概览。
- `beb34fc` r3 原型与 9 张验收截图归档（`docs/design/dovun/schedule-restyle/evidence/`）。

`app-knowledge` 手册的 `plan`、`settings` 两条随 `084c0e6` 一起改到本次界面，发版前置满足。无 Prisma schema 变化、无新增迁移（`git diff a9c0d01..beb34fc -- server/prisma` 为空）。

## 构建

- 主工作区临时移出 11 个未跟踪的 learning demo 文件（清单存 `/tmp/dovun-release-stash/manifest.txt`，构建后原样还原），使构建只含已提交源码；`client/vite.config.ts` 无多页入口，`client/learning-*.html` 不参与打包。
- Node 22.13.0 + cargo；先 `npm run prisma:generate -w server`，再 `npm run desktop:build`，日志 `Finished 2 bundles`、`EXIT:0`。
- 产物：`Dovun.app` 与 `desktop/src-tauri/target/release/bundle/dmg/Dovun_0.6.0_aarch64.dmg`（sha256 `fcb007b447cb5201d804e9750de2cc78d43f35a95b4a5a9242763953b548f458`）。
- 桌面冒烟 `npm run desktop:smoke` 通过：本机模式与服务器模式（owner key 登录、bootstrap 凭据禁用）。
- 增量镜像上下文 729 文件、tar sha256 `61620ad65638b1a14436113fc9dfe5d881fbca0fdec0ed3fed7e2459251971aa`，用 `COPYFILE_DISABLE=1` 打包；服务器解包后 `._*` 条目为 0（tar 的 `LIBARCHIVE.xattr` 提示只是忽略 macOS 扩展属性头，不落真实文件）。
- `Dockerfile.release` 沿用上一版增量流程：`FROM dovun:0.6.0-a9c0d01`，删旧 dist/client-dist/prisma，复制新产物，`prisma generate`，打 revision 标签。新镜像 `dovun:0.6.0-beb34fc`（`sha256:c53ef7cb6347b6887986489f7e193e638dbd3a3387b5c6641ed0cc4cf8fc305c`）。

## macOS 安装

- 唯一安装目标 `/Applications/Dovun.app`，标识 `app.dovun.desktop`、版本 0.6.0、主程序 `dovun`。替换前确认无执行中任务（`Run` 只有 failed/returned，`agent_runs` 只有 completed/failed/paused/waiting_approval，`NodeJob` 只有 done/cancelled，`learning_jobs` 空）、47317 无监听。
- 按用户指示**不备份旧安装包**。回退路径已验证：`/Users/byc/WorkSpace/.backups/dovun-20261103-e36261e/Dovun_0.6.0_aarch64.dmg` 内的包与卸载前安装完全一致（同为 `index-BmI9jSpg.js`/`index-Bd7I-ETR.css`）。
- 数据照旧备份到 `/Users/byc/WorkSpace/.backups/dovun-20261104-beb34fc/`（3.9G）：完整 `~/Library/Application Support/dovun`、`~/Library/WebKit/app.dovun.desktop`、`~/Library/Application Support/app.dovun.desktop`、`~/Library/Caches/app.dovun.desktop`、`app.dovun.desktop.plist`，`manifest.txt` 记录 `dovun.db` sha256 `6fc73e58ad5c52628effe219d76ac05216746d5f76e7c264ac458c289d732914`（345530368B，无 -wal/-shm/-journal）与偏好 plist sha256 `663c9849152ccec1bb263b5676e5d8921eb67cdf89b89326650ab315ca7b618d`。
- 整包 `rm -rf` + `ditto` 替换后：签名 adhoc `valid on disk`、满足 Designated Requirement；17710 个文件与构建产物一致；`client/index.html` 引用 `assets/index-B47gmFVJ.js`/`index-GqCIjfUN.css`；包内 `server/dist/agent/app-knowledge.js` 含「日期簇」（旧包为 0）；包内 `Resources/server` 与组装目录逐字节一致（仅多一个 `node_modules/.cache`），`Resources/client` 与 `client/dist` 一致。
- `dovun.db` 与偏好 plist 的 sha256 安装前后一致；应用保持关闭、47317 无监听；构建目录重复 `.app` 已删除，DMG 保留；`/Applications` 下只有一个可运行 Dovun。

## 生产部署

- 公网 `https://wwa.cby.red`，运行根 `/opt/dovun-release-20261026`，compose 项目 `dovun-production`、容器 `work-with-agent`，挂载 `/opt/dovun-release-20261026/data->/data`、端口 `127.0.0.1:12716:3016` 均未变。切换前预检这四项与运行镜像 `dovun:0.6.0-a9c0d01`、compose 镜像字段一致才继续。
- 隔离预检：`sqlite3 .backup` 取生产库一致性副本（486391808B），新镜像以 `network_mode: none`、`mem_limit: 1g`、`cpus: 0.5`、独立容器名与临时数据目录启动 → `healthy`、`OOMKilled=false`、`prisma migrate status` 为「65 migrations found / Database schema is up to date!」、日志「No pending migrations to apply.」、容器内 `/api/v1/server/info` 返回 `mode=server, version=0.6.0`、首页资产即新构建、`app-knowledge.js` 含新手册标记。副本、临时容器与含凭据的临时 compose 文件用后即删。
- 停服窗口前在线备份：`/opt/backups/dovun/20261104-beb34fc-dbaudit/`（`dovun.db.gz` 108461146B，sha256 `a4ab9d83659175d59f1739c003bf280991f645fd4eade18d68c1c534a76d1ee3`，附 compose 副本与 0600 的 `.env` 副本）。
- 旧镜像打回滚标签 `dovun:rollback-20261104-a9c0d01` 保留；只改 compose 的 `image` 与 revision 标签后 `docker compose up -d` 重建 → `healthy`、`restarts=0`、`OOMKilled=false`。
- 业务表逐行哈希前后一致（tasks 216、topics 9、Material 337、MaterialVersion 343、Memory 35、messages 4516、approvals 167、sync_devices 26、sync_state 0），`businessUnchanged=true`；`.env` 未改动。回执见 `releases/beb34fc/receipt.json` 与 `current-release.json`。
- 回滚路径：镜像级 `dovun:rollback-20261104-a9c0d01`；数据级可用上述 `.gz` 恢复。未重启主机或 Docker，未删除旧镜像、卷或数据，未执行 `docker system df` 等无界统计。

## 公网验收（macOS 直连，绕过代理）

- `/api/v1/server/info` → `mode=server, version=0.6.0`。
- 线上 `index.html` 引用 `assets/index-B47gmFVJ.js`/`index-GqCIjfUN.css`；两文件公网 sha256 为 `5ed9245736308bd56b19175c06a22f0dba8f554f6b4c2461d2d5e66f8bd85969` 与 `1424fbda2c30e97532500ce214bbe689a644908cd63aade32391d0c89a89f826`，与本地构建、镜像内文件、本机安装包三端一致。
- 线上 JS 含 `plan-day-stats`、`plan-timed-when`、`plan-now-label` 与 3 处 `showBands` 标记。两端（本机包与公网）同为本次 `beb34fc` 产物。

## 验收边界

- 桌面按授权保持关闭，未做真实 Tauri 窗口操作验收；运行时验证走的是 `desktop:smoke` 与包内容一致性，不能替代打开界面后的观感与交互检查。
- 规划页视觉结论来自 `084c0e6`/`beb34fc` 的 9 张明暗与宽窄屏验收截图；真机（实体手机、中文输入法）与深色下的长时间使用仍待日常使用确认。
- 本机磁盘 `/` 使用率 97%（可用 2.1G）：本次流程未清理任何镜像、卷或备份，后续发版需要先处理空间。
