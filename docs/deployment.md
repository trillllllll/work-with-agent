# 自托管服务器部署（多端数据同步）

Work With Agent 支持把同一个服务部署到一台常开的机器（VPS/NAS）上，所有设备共用这一份数据：

- 桌面应用切到「连接服务器」模式后，窗口加载的就是服务器页面；
- 手机或任意浏览器直接访问服务器地址，输入访问密钥即可使用；
- 快照机制提供备份、恢复和换机迁移。

数据同步的语义是「唯一数据源」：没有离线编辑，也没有多端冲突合并。网络不通时桌面应用可以随时切回本机模式（数据独立，不与服务器互通）。

## 1. 前置条件

- 一台常开的 Linux 服务器（1 核 1G 起步即可，SQLite 个人数据量很小），已安装 Docker 与 docker compose；
- 一个域名，并添加一条 A 记录指向服务器（下文以 `wwa.example.com` 为例）；
- 服务器上已有 nginx（没有的话 `apt install nginx`；不想用 nginx 也可以用任意反代或 Tailscale 私网直连）。

## 2. 启动容器

```bash
git clone https://github.com/trillllllll/WorkWithAgent.git
cd WorkWithAgent

# 生成本部署的访问密钥（请保存到密码管理器）
openssl rand -base64 32

cat > .env <<'EOF'
WWA_OWNER_KEY=把上面生成的密钥粘到这里
WWA_PUBLIC_URL=https://wwa.example.com
EOF

docker compose up -d --build
docker compose logs -f   # 看到 "API listening" 即启动成功
```

容器只监听宿主机的 `127.0.0.1:12716`，不会直接暴露公网。数据全部落在 `./data/` 目录（数据库、材料文件、快照）。

## 3. HTTPS 与域名（nginx + Let's Encrypt）

```nginx
# /etc/nginx/sites-available/wwa
server {
    server_name wwa.example.com;
    location / {
        proxy_pass http://127.0.0.1:12716;
        proxy_set_header Host $host;                 # 必须：服务按 Host 校验请求
        proxy_set_header X-Forwarded-Proto $scheme;  # 必须：https 下 cookie 加 Secure
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_read_timeout 3600s;                    # 聊天是流式响应
        proxy_buffering off;
        client_max_body_size 2g;                     # 快照恢复上传
    }
}
```

```bash
ln -s /etc/nginx/sites-available/wwa /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
apt install certbot python3-certbot-nginx
certbot --nginx -d wwa.example.com
```

境内服务器绑定域名需已完成 ICP 备案；若 443 被阻，可退到非标端口（如 8443，把 `WWA_PUBLIC_URL` 改成 `https://wwa.example.com:8443`）或改用 Tailscale 私网访问（`WWA_PUBLIC_HTTPS` 设 0 并使用 `http://100.x.x.x` 地址）。

## 4. 客户端接入

- **手机 / 浏览器**：打开 `https://wwa.example.com`，输入访问密钥（`WWA_OWNER_KEY`）。会话 7 天有效。
- **桌面应用**：设置 → 服务器 → 「切换工作区模式」→ 连接服务器 → 填入地址。首次安装时启动器也会直接给出这个选项。
- **外部 AI 工具（MCP）**：在服务器的「连接」页面创建连接，生成的配置会直接指向公网地址。

## 5. 老数据上云（已有本地数据的用户）

1. 在旧电脑的桌面应用（本机模式）里：设置 → 备份与恢复 → 下载快照，得到 `wwa-snapshot-*.zip`；
2. 把该文件传到服务器，改名为 `seed.zip` 放进 `data/snapshots/` 目录；
3. `docker compose restart` —— 启动时自动导入（要求服务器当时还没有自己的数据库）；
4. 桌面应用切到连接服务器模式，全部数据（任务、材料、对话、记忆）随之可见。

新电脑迁移更简单：装桌面应用直接连服务器即可，无需迁移。

## 6. 升级

```bash
git pull
docker compose up -d --build
```

新容器启动时会自动执行数据库迁移。桌面端无需升级（界面永远来自服务器）；只有用到新壳功能（如启动器改动）时才需要重装桌面应用。

## 7. 备份与恢复

- **自动**：容器每天在 `data/snapshots/` 写一份全量快照，保留最近 7 份（`WWA_SNAPSHOT_KEEP` 可调）。
- **手动**：设置 → 备份与恢复 → 下载快照（任何模式可用，也是换机迁移包）。
- **恢复**：设置 → 备份与恢复 → 选择快照 → 恢复。恢复前会自动把当前数据先备份一份；服务会自动重启生效。
- **灾难恢复**：保管好 `data/` 目录（或最近一次快照 zip）+ `.env` 里的密钥，即可在任何机器重建。

快照 zip 含完整工作数据（含设置表，其中有 API Key），请妥善保管，不要提交进代码仓库。

## 8. 安全模型

- 登录唯一凭据是 `WWA_OWNER_KEY`（≥20 字符），校验带时序安全比较；错误 15 分钟内达 10 次会限流。
- 一次性启动凭据（本机模式的启动链接）在服务器模式下**禁用**，不会出现在公网日志里。
- 请求按 Host 白名单（`WWA_PUBLIC_URL`/`CLIENT_ORIGIN`）校验，未配置公网地址时全部拒绝。
- 全程 HTTPS（反代终结），会话 cookie 带 `Secure`/`HttpOnly`/`SameSite=Strict`，写操作强制 CSRF。
- 建议的宿主机加固：SSH 密钥登录并禁用密码、防火墙只放行 22/80/443、定期 `apt upgrade`。

## 9. 已知边界

- **离线**：服务器不可达时无法编辑同步数据；桌面端可切回本机模式（独立数据）应急。
- **Agent 接力执行位置**：服务器模式下 CLI agent（codex/claude）在**服务器主机上**执行；服务器未安装这些 CLI 时接力执行不可用。聊天（OpenAI 兼容 API）不受影响。
- **设置与 API Key**：只存在服务器数据库，不会下发给客户端。

## 10. 故障排查

| 症状 | 排查 |
| --- | --- |
| 打不开页面，502 | 容器是否存活（`docker compose ps`）、nginx `proxy_pass` 端口是否 12716 |
| 登录一直「凭据无效」 | 核对 `WWA_OWNER_KEY`（compose env 与 `.env`），注意首尾空白 |
| 登录后所有请求 403 HOST_DENIED | nginx 缺 `proxy_set_header Host $host;`，或 `WWA_PUBLIC_URL` 与实际访问域名不一致 |
| cookie 登不上（反复回登录页） | HTTPS 未生效或缺 `X-Forwarded-Proto` 头，Secure cookie 被 http 丢弃 |
| 恢复快照后一直转圈 | 查看日志确认容器以退出码 75 重启（`docker compose ps` 短暂 Exited 属预期） |
