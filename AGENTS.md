# Dovun / Work With Agent

## 先确认操作的是哪套应用

当前 `codex/dovun-workspace` 分支构建的是 **Dovun**。用户说安装、打包或更新 Dovun 时，只操作 Dovun；旧 WWA 的应用、数据、服务和部署不随之更新。

| 项目 | Dovun（当前分支） | 旧 WWA（独立保留） |
| --- | --- | --- |
| 安装路径 | `/Applications/Dovun.app` | `/Applications/Work With Agent.app` |
| 系统应用标识 | `app.dovun.desktop` | `app.workwithagent.desktop` |
| 主程序 | `Contents/MacOS/dovun` | `Contents/MacOS/work-with-agent` |
| 本机服务 | `127.0.0.1:47317` | `127.0.0.1:47316` |
| 默认数据目录 | `~/Library/Application Support/dovun/` | `~/Library/Application Support/work-with-agent/` |
| 数据库 | `dovun.db` | `agent-studio.db` |

- 两套应用、身份、端口和数据独立。普通覆盖安装不重做数据迁移，不改同步或自动化开关，不把另一套目录当来源。
- 表中是默认路径；若设置了 `DOVUN_DATA_DIR` 等覆盖项，先核对实际进程和有效配置，再备份实际数据目录，不能只核对默认目录。
- 安装前核对目标包 `Info.plist` 的标识、版本和主程序，以及当前进程完整路径；不能只看窗口名或图标。历史 0.3.0 候选也可能叫 `Dovun.app`，却使用旧标识，不能拿来覆盖当前 Dovun。

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

macOS Apple Silicon。当前正式 Dovun 标识为 `app.dovun.desktop`，版本看 `package.json` 和 `desktop/src-tauri/tauri.conf.json`，不要用旧 WWA 或历史候选的标识代替。`npm run desktop:build` 等于 `node scripts/assemble-desktop.mjs && node scripts/tauri.mjs build`。组装脚本要求 Node ≥ 22，并往包里放 Node 22.13.0。本机 Volta 默认是 16，不能直接用。

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

只替换 `/Applications/Dovun.app`。先备份旧应用，再整包删掉并复制新包，不要往旧包上 `ditto` 合并。**不退出、不替换旧 WWA，也不要求释放 47316。**

1. 确认没有正在执行的任务后，正常退出 Dovun：运行中时执行 `osascript -e 'tell application id "app.dovun.desktop" to quit'`。仍有残留时，先用 `ps` 核对 PID 的完整路径确实是 `/Applications/Dovun.app/Contents/MacOS/dovun`，再终止该 PID；不要按同名 `dovun` 批量杀进程，也不要 `pkill -f` 含应用路径的命令。
2. 确认 `127.0.0.1:47317` 没有在听。若仍有服务，查明所属进程，不能为了安装停掉另一套应用。
3. 在停止后记录并备份 `~/Library/Application Support/dovun/dovun.db` 及已有的 `-wal`、`-shm`、`-journal`，保留它们的原文件名和同目录关系。备份本机配置、浏览器偏好/草稿状态和旧应用。Dovun 的浏览器状态位于 `~/Library/WebKit/app.dovun.desktop/`、`~/Library/Application Support/app.dovun.desktop/` 等已有位置，只备份，不清空或改写。核对数据库及偏好的大小和 sha256，安装前后必须一致；安装失败保留备份和原数据。
4. 确认新包标识为 `app.dovun.desktop`、备份完整后，`rm -rf "/Applications/Dovun.app"`，再用 `ditto` 把 `desktop/src-tauri/target/release/bundle/macos/Dovun.app` 拷到该位置。
5. 核对安装包全部文件/链接、签名、`Info.plist` 标识和版本、包内 `client/index.html` 的 `assets/index-*.js` 与 `assets/index-*.css`，以及应用功能知识与本次编译产物一致。重新核对数据库及偏好；不要改旧 WWA 库或服务器库。
6. 核验成功后，移除构建目录中的重复 `.app`，保留 DMG。检查 `bundle/` 的历史版本子目录，发现旧候选先核对身份、归档，再清理对应可运行副本，不盲删其他应用或数据。用户没要求打开时，Dovun 保持关闭，47317 无监听。

装好的 Dovun 只有在用户打开并选择本机模式后才听 `127.0.0.1:47317`。开发服务是另一套：默认 Vite `127.0.0.1:5176`、API `127.0.0.1:3016`，隔离测试可另用端口；不能拿开发服务冒充桌面安装验收。关窗口是隐藏，Command-Q 才退出。

## 旧 WWA 覆盖安装（仅明确要求更新 WWA 时）

这段只适用于旧 WWA，不是 Dovun 的安装步骤。

1. 从明确的 WWA 源码/产物核对 `Work With Agent.app`，标识必须为 `app.workwithagent.desktop`；不能把当前分支的 Dovun 包改名当成 WWA 包。
2. 正常退出 `Work With Agent`；只在核对完整路径后终止残留 `work-with-agent` PID，确认 `127.0.0.1:47316` 释放。Dovun 的 47317 和进程不操作。
3. 备份 `~/Library/Application Support/work-with-agent/agent-studio.db`、已有 sidecar、偏好和旧应用，记录大小及 sha256；覆盖前后核对一致。
4. 只整包替换 `/Applications/Work With Agent.app`，不合并旧包内容；不操作 `/Applications/Dovun.app` 或 `dovun/` 数据目录。
5. 核对 WWA 标识、版本、资源和数据后，清理本次 WWA 构建的重复 `.app`、保留 DMG。用户没要求打开时保持关闭。WWA 本机服务端口为 47316。

## 旧 WWA 部署到 wwa.cby.red（仅明确授权时）

以下是旧 WWA 的服务器运行说明，不能自动套用到当前 Dovun 分支。部署前确认目标源码、配置、数据库名及升级路径与服务器相容；不能直接用 Dovun 的 `HEAD` 覆盖旧 WWA 服务。只要求本机安装时，不连接或部署服务器。

公网 `https://wwa.cby.red`：nginx 443（`/www/server/panel/vhost/nginx/wwa.cby.red.conf`）转到 Docker `127.0.0.1:12716`，容器里是 `WWA_SERVER_MODE=1`。源码和 compose 在 `/opt/work-with-agent`，数据在 `/opt/work-with-agent/data`。`www.cby.red` 是另一个站。

这台 VPS 不能从 GitHub `git pull`。`docs/deployment.md` 第 6 节的 `git pull` 在这里走不通。升级用本地 `git archive` 打已提交的源码包，再 scp 上去。

```bash
git archive --format=tar.gz -o /tmp/wwa-src.tgz HEAD
git ls-files -z > /tmp/wwa-tracked.txt
```

SSH 是 `root@1.14.75.14`。本机 Clash 可能把域名收成 `198.18.0.0/15` 的 fake-ip，不要拿那个地址连。真实地址用 `curl --noproxy '*' -H 'accept: application/dns-json' 'https://1.1.1.1/dns-query?name=wwa.cby.red&type=A'`。这台 Mac 没有 `~/.ssh/id_ed25519`，密钥登录会失败。密码不要写进本文件、日记或命令参数。macOS 没有 `setsid`。需要密码时用 Python `subprocess` 的 `start_new_session=True`，加上 `SSH_ASKPASS_REQUIRE=force` 和 askpass 脚本，用完删掉脚本。

在服务器上：

1. 先记 `data/agent-studio.db` 的字节数，并确认 `.env` 还在。不要 `cat .env`，不要打印 `WWA_OWNER_KEY`。
2. 把包解进 `/opt/work-with-agent`。解压不会删掉 git 里已经移除的文件，旧源码会被 `tsc` 编进去。用 `git ls-files -z` 对照，只删除 `client/` 和 `server/` 里不在清单中的文件。跳过 `node_modules` 和 `dist`。`._*` 是 macOS 的 AppleDouble，不是正本，可以删。不要动 `.env` 和 `data/`。
3. 在 `/opt/work-with-agent` 里执行 `docker compose up -d --build`，这样才会读到该目录的 `.env`。构建失败时旧容器还在，清完残留再构建一次。
4. 等到容器 `healthy`。日志里应有 `No pending migrations to apply` 和 `API listening on http://127.0.0.1:3016`。Prisma 的 openssl-1.1.x 警告不挡住健康检查。
5. 再对一次数据库字节数，确认 `.env` 仍在。删掉服务器和本机的临时包。

公网验收要绕过本机代理：

```bash
curl --noproxy '*' --resolve wwa.cby.red:443:1.14.75.14 -fsS https://wwa.cby.red/api/v1/server/info
curl --noproxy '*' --resolve wwa.cby.red:443:1.14.75.14 -fsS https://wwa.cby.red/ | grep -o 'assets/index-[^"]*'
```

`/api/v1/server/info` 应为 `mode` `server`，`version` 与本次已提交源码的 `package.json` 一致。页面上的 `index-*.js` 和 `index-*.css` 应与这次构建、以及刚装上的桌面应用一致。

安装和部署分别按用户授权执行；界面改动不自动授权服务器部署。若用户要求两端发布，两端分别验收源码、数据和资源。只改壳或启动器时，只需重装对应桌面应用。只改服务器页面时，连接该服务器的桌面窗口会看到服务器新页面，本机模式仍需单独更新对应应用。
