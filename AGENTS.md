# Dovun

## 前端与 Demo 规范

- 每次设计或实现前端页面、Demo 前，先查找并优先复用现有公共组件。
- 现有公共组件无法满足需求时，再新做组件；尽量将可复用的部分抽象为公共组件，供后续页面和 Demo 复用。

## 部署与执行规范

- 只执行用户授权的范围。调查、方案、本机安装和线上发布分别对待；已授权的步骤连续完成，不重复确认。
- 发布前更新并提交应用功能手册，完成相关测试和代码复核。记录实际提交，不能只凭版本号判断是否更新。
- 本机部署必须覆盖 `/Applications/Dovun.app`：先确认无执行中任务，退出应用并备份实际数据、配置和旧应用，再整包替换，不合并旧包、不清数据、不改同步或自动化开关。
- 本机只保留一个可运行的 Dovun。安装验收后删除构建目录中的重复 `.app`，旧应用保存为压缩备份，保留 DMG；未要求时不自动打开。
- 线上发布先核对实际服务、配置和数据挂载，备份并保留回滚版本。不能混用应用、目录或数据库。
- 在这台 VPS 禁止执行 `docker system df`（包括 `-v`），不做无界 Docker 统计；构建和查询设置资源限制或超时。不擅自重启主机、Docker或清理镜像、卷及数据。
- 发布后验证服务健康、实际资源和相关业务流程。草稿与同步修复必须覆盖旧数据及登录后的同步，不能只验证页面打开。
- 凭据不进入文档、日志或命令参数；临时认证材料用后清理。

## 应用身份

- 当前仅维护 Dovun：安装路径 `/Applications/Dovun.app`，标识 `app.dovun.desktop`，主程序 `Contents/MacOS/dovun`，本机服务 `127.0.0.1:47317`。
- 默认数据目录为 `~/Library/Application Support/dovun/`，数据库为 `dovun.db`。若有 `DOVUN_DATA_DIR` 等覆盖项，先核对实际进程与有效配置，再备份实际目录。
- 发布前核对实际分支、提交和构建身份；安装前核对 `Info.plist` 的标识、版本、主程序及运行进程完整路径，不能只凭版本号、名称或图标判断。
- 普通覆盖安装不重做数据迁移，不改同步或自动化开关。

## 只覆盖安装

再安装时只覆盖原来的那一条，不要新建第二条。

- 宿主里已经有名为 `work_with_agent` 的 MCP 时，覆盖这一条配置。不要再执行 `grok mcp add`、`claude mcp add` 或等价命令去新增一条。
- 应用里同一个宿主已经有连接时，更新那条连接。不要再创建一条同名连接。
- 发现刚多出来的新连接或新的 MCP 条目，删掉新的，留下原来那条。

## 发版前先更新应用功能知识

内置助手的版本使用手册是 `server/src/agent/app-knowledge.ts` 里的 `appKnowledge`。助手用 `read_app_knowledge` 按页面读取，提示词带上 `package.json` 的版本。

每次打包或部署之前，先按这次要发出的界面和工具改这份目录，并提交。手册没跟上这次发版，就停在这里，不要打包，也不要部署。

- 对照这次发版实际有的页面、入口和助手工具。新的写进去，行为变了就改原文，拿掉的删掉。
- 版本号沿用 `applicationVersion`，不要写死在条文里。
- 只写已经能用的行为。计划文档里还没做的功能不要抄进来。
- 密钥、令牌、连接凭据不要写进说明。

## Dovun 本机打包

macOS Apple Silicon。当前正式 Dovun 标识为 `app.dovun.desktop`，版本看 `package.json` 和 `desktop/src-tauri/tauri.conf.json`，不要用历史候选的标识代替。`npm run desktop:build` 等于 `node scripts/assemble-desktop.mjs && node scripts/tauri.mjs build`。组装脚本要求 Node ≥ 22，并往包里放 Node 22.13.0。本机 Volta 默认是 16，不能直接用。

```bash
export PATH="/Users/byc/.volta/tools/image/node/22.13.0/bin:/Users/byc/.cargo/bin:$PATH"
cd /Users/byc/WorkSpace/work-with-agent
npm run desktop:build > /tmp/dovun-desktop-build.log 2>&1
build_rc=$?
echo "EXIT:$build_rc" >> /tmp/dovun-desktop-build.log
```

成功是日志里有 `Finished 2 bundles`，并且 `EXIT:0`。产物：

- 应用：`desktop/src-tauri/target/release/bundle/macos/Dovun.app`
- DMG：`desktop/src-tauri/target/release/bundle/dmg/Dovun_<版本>_aarch64.dmg`（版本以本次构建为准）

签名身份是临时的 `"-"`。用户没要求时不要接着打开应用。

zsh 里 `status` 是只读变量。安装或打包脚本不要写 `status=$?`，否则后半段整段跳过。

## Dovun 覆盖安装到本机

只替换 `/Applications/Dovun.app`。先备份旧应用，再整包删掉并复制新包，不要往旧包上 `ditto` 合并。

1. 确认没有正在执行的任务后，正常退出 Dovun：运行中时执行 `osascript -e 'tell application id "app.dovun.desktop" to quit'`。仍有残留时，先用 `ps` 核对 PID 的完整路径确实是 `/Applications/Dovun.app/Contents/MacOS/dovun`，再终止该 PID；不要按同名 `dovun` 批量杀进程，也不要 `pkill -f` 含应用路径的命令。
2. 确认 `127.0.0.1:47317` 没有在听。若仍有服务，查明所属进程，不能为了安装停掉另一套应用。
3. 在停止后记录并备份 `~/Library/Application Support/dovun/dovun.db` 及已有的 `-wal`、`-shm`、`-journal`，保留它们的原文件名和同目录关系。备份本机配置、浏览器偏好/草稿状态和旧应用。Dovun 的浏览器状态位于 `~/Library/WebKit/app.dovun.desktop/`、`~/Library/Application Support/app.dovun.desktop/` 等已有位置，只备份，不清空或改写。核对数据库及偏好的大小和 sha256，安装前后必须一致；安装失败保留备份和原数据。
4. 确认新包标识为 `app.dovun.desktop`、备份完整后，`rm -rf "/Applications/Dovun.app"`，再用 `ditto` 把 `desktop/src-tauri/target/release/bundle/macos/Dovun.app` 拷到该位置。
5. 核对安装包全部文件/链接、签名、`Info.plist` 标识和版本、包内 `client/index.html` 的 `assets/index-*.js` 与 `assets/index-*.css`，以及应用功能知识与本次编译产物一致。重新核对数据库及偏好；不要改服务器库。
6. 核验成功后，移除构建目录中的重复 `.app`，保留 DMG。检查 `bundle/` 的历史版本子目录，发现旧候选先核对身份、归档，再清理对应可运行副本，不盲删其他应用或数据。用户没要求打开时，Dovun 保持关闭，47317 无监听。

当前 Dovun 桌面启动后使用本机任务副本，由已安装应用提供 `127.0.0.1:47317` 服务。开发服务是另一套：默认 Vite `127.0.0.1:5176`、API `127.0.0.1:3016`，隔离测试可另用端口；不能拿开发服务冒充桌面安装验收。关窗口是隐藏，Command-Q 才退出。

## 当前 Dovun 线上位置

公网 `https://wwa.cby.red` 当前运行的是 Dovun。已知生产运行根为 `/opt/dovun-release-20261026`，配置为 `compose-production.json`，容器名仍为 `work-with-agent`，实际数据为该目录下的 `data/dovun.db`；nginx 443 转到 `127.0.0.1:12716`。每次发布仍须核对实际容器、镜像、挂载和有效配置，不能只凭名称判断。

## 服务器交付与验收

- SSH：`root@1.14.75.14`。这台 VPS 不能从 GitHub `git pull`，使用本地 `git archive` 打包已提交源码后上传；不要覆盖运行配置和数据目录。
- 公网验收绕过本机代理，核对 `/api/v1/server/info` 的 `mode` 为 `server`、版本与本次源码一致，并检查实际镜像提交和页面资源哈希。
- 安装和部署分别按用户授权执行；界面改动不自动授权服务器部署。两端发布时分别验收源码、数据和资源；只有同次发布两端时，才要求两端资源与本次产物一致。
- 只改壳或启动器时，只需重装对应桌面应用；仅部署服务器不会更新本机安装包，不得宣称两端都已更新。
