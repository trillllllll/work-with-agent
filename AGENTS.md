# Work With Agent

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

## 本机打包

macOS Apple Silicon。标识 `app.workwithagent.desktop`，版本看 `package.json` 和 `desktop/src-tauri/tauri.conf.json`。`npm run desktop:build` 等于 `node scripts/assemble-desktop.mjs && node scripts/tauri.mjs build`。组装脚本要求 Node ≥ 22，并往包里放 Node 22.13.0。本机 Volta 默认是 16，不能直接用。

```bash
export PATH="/Users/byc/.volta/tools/image/node/22.13.0/bin:/Users/byc/.cargo/bin:$PATH"
cd /Users/byc/WorkSpace/work-with-agent
npm run desktop:build > /tmp/wwa-desktop-build.log 2>&1
echo EXIT:$? >> /tmp/wwa-desktop-build.log
```

成功是日志里有 `Finished 2 bundles`，并且 `EXIT:0`。产物：

- 应用：`desktop/src-tauri/target/release/bundle/macos/Work With Agent.app`
- DMG：`desktop/src-tauri/target/release/bundle/dmg/Work With Agent_<版本>_aarch64.dmg`（版本以本次构建为准）

签名身份是临时的 `"-"`。用户没要求时不要接着打开应用。

zsh 里 `status` 是只读变量。安装或打包脚本不要写 `status=$?`，否则后半段整段跳过。

## 覆盖安装到本机

只替换 `/Applications/Work With Agent.app`。先整包删掉再复制，不要往旧包上 `ditto` 合并。

1. 退出：`osascript -e 'tell application "Work With Agent" to quit'`。进程名是 `work-with-agent`。还在的话再 `kill $(pgrep -x work-with-agent)`。不要 `pkill -f` 一条含应用路径的命令，那会把当前包装脚本一起杀掉。
2. 确认 `127.0.0.1:47316` 没有在听。
3. 记下 `~/Library/Application Support/work-with-agent/agent-studio.db` 的大小和 sha256。安装前后必须一致。不要改这个库，也不要改服务器上的库。
4. `rm -rf "/Applications/Work With Agent.app"`，再用 `ditto` 把新包拷进去。
5. 删掉仓库里的 `desktop/src-tauri/target/release/bundle/macos/Work With Agent.app`，避免启动台出现两个图标。DMG 留下。
6. 核对 `Info.plist` 的标识和版本，以及包内 `index.html` 引用的 `assets/index-*.js` 与 `assets/index-*.css`。应用保持关闭。

装好的应用只有在用户打开并选择本机模式后才听 `127.0.0.1:47316`。开发服务仍是 Vite `127.0.0.1:5176`、API `127.0.0.1:3016`。关窗口是隐藏，Command-Q 才退出。

## 部署到 wwa.cby.red

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

界面改动要同时覆盖安装和部署。只改壳或启动器时才只重装桌面应用。只改服务器页面时，已连接服务器的桌面窗口会直接看到新页面，本机模式仍要重装。
