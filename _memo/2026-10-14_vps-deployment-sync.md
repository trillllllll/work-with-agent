---
createAt: 2026-10-14
updateAt: 2026-10-14
summary: 数据同步（自托管中央服务器模式）的 VPS 部署位置、运维命令、验收结论与后续维护入口
tags: [deployment, vps, docker, nginx, https, sync, server-mode]
---

# 2026-10-14 多端数据同步：VPS 部署与验收

## 结论

- `https://wwa.cby.red` 已上线：nginx(443, Let's Encrypt) → Docker 容器（`127.0.0.1:12716`）→ Node 服务（`WWA_SERVER_MODE=1`）
- 端到端验收通过：owner key 登录（Secure cookie）、建任务、读取、按 `expectedRevision` 删除、每日快照调度
- 博客 `www.cby.red`（four-stage.conf）不受影响；HTTP 自动 301 到 HTTPS
- 本地代码与部署镜像有一处无害差异（snapshots.ts 版本读取重构，见下），下次从 git 重建镜像时自动对齐

## VPS 侧位置（即 wwa.cby.red 所解析的机器）

| 项 | 路径 / 值 |
| --- | --- |
| 源码 + compose | `/opt/work-with-agent`（`.env` 含 `WWA_OWNER_KEY`，600 权限；查看：`cat /opt/work-with-agent/.env`） |
| 数据 | `/opt/work-with-agent/data`（db / blobs / snapshots，每日快照保留 7 份） |
| nginx 配置 | `/www/server/panel/vhost/nginx/wwa.cby.red.conf`（备份 `*.http-only.bak`；宝塔 nginx，主配置 include 该目录） |
| ACME webroot | `/www/wwwroot/wwa-acme`（certbot 自动续期已排程） |
| 防火墙 | firewalld 已放行 443；SSH 已配置本机密钥登录（`~/.ssh/id_ed25519`） |

## 运维命令

```bash
docker compose -f /opt/work-with-agent/docker-compose.yml ps        # 容器状态
docker compose -f /opt/work-with-agent/docker-compose.yml logs -f   # 恋 "API listening"
docker compose -f /opt/work-with-agent/docker-compose.yml restart   # 重启（快照恢复后也走这个）
nginx -t && nginx -s reload                                         # 改 nginx 后先测再重载
certbot renew --dry-run                                             # 证书续期演练
```

升级流程见 `docs/deployment.md`（git pull → compose up -d --build，自动跑迁移）。

## 验收记录

- 外部 `curl https://wwa.cby.red/api/v1/server/info` → `{"mode":"server","version":"0.2.0"}`，证书校验 0
- 错误密钥 401；正确密钥 200 + `wwa_session`（HttpOnly/Secure/SameSite=Strict）
- 快照链路：容器首启已产出 `wwa-snapshot-*.zip`（调度器 60s 后首跑）
- 桌面冒烟（`npm run desktop:smoke`）新增服务器模式用例：bootstrap 凭据禁用、owner key 登录建任务通过

## 踩坑

- **snapshots.ts 读版本在桌面打包布局崩溃**：`require('../../../package.json')` 无兜底（`??` 救不了 throw）。改为复用 security.ts 的 `readVersion()`（循环 try/catch）。Docker 布局不受影响（`/app/package.json` 存在）
- **SSH 装公钥时 `$(cat)` 两次消费 stdin**：第二次读到空 → 只追加了空行。密钥类操作改为参数直传
- **NSIS 静默安装卡死**：从被 Bash 工具超时转后台的 shell 里直接跑 `setup.exe /S` 会继承挂起的管道，安装器 5 分钟不落盘。用 PowerShell `Start-Process`（detached，不继承管道）15 秒装完
- **API 删除任务 428**：需要 body 携带 `expectedRevision`（乐观并发），不是 If-Match 头
- 本机 DNS 被 Clash fake-ip 劫持：外部探测用 `curl --noproxy '*' --resolve 域名:443:IP`

## 待办 / 交接

- [ ] 用户改 root 密码（已在对话中暴露过）
- [ ] 代码提交推送（仓库有一批未提交改动：服务器模式/快照/启动器/部署物）；推送后可把 VPS 升级流切到 git
- [ ] 用户最终验收：手机 + 桌面（新 NSIS 包已静默装到本机，打开即见启动器，选「连接服务器」）
- [ ] 可选：老数据上云（本地模式下载快照 → 网页端 设置→备份与恢复→恢复 上传）
