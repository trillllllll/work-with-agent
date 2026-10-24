# 回复风格配置本机发布记录

2026-10-24 已提交并 push 到 `codex/dovun-workspace`，完成打包和 `/Applications/Dovun.app` 整包覆盖安装。服务器未部署，旧 WWA 应用、数据、配置和服务未操作。

## 源码与安装来源

- 源码提交：`7a00fc1cda72458209a1c78f7c985370687648e4`。本记录的后续文档提交不改变已安装代码。
- 应用功能知识已随源码提交，之后才执行打包。
- 版本：`0.4.0`；标识：`app.dovun.desktop`；主程序：`dovun`。
- 安装时间：`2026-10-24T15:05:25.207279+08:00`。
- Node `22.13.0`；桌面构建 `Finished 2 bundles`、`EXIT:0`。
- 前端资源：`/assets/index-BIuqNw_z.js`、`/assets/index-vgdeqFs9.css`。
- CI、Dockerfile 和版本号未改动；未合并 main、未打标签。

## 验证

- 完整测试：服务端 `845`、客户端 `375`，全部通过。
- Chromium、手机 Chromium、WebKit 的回复风格设置与原审批链路：`6` 项通过。
- 构建、语言、公共控件及差异空白检查通过；独立代码审查无阻塞项。
- 旧 schema 升级演练：既有设置列、模型凭据和任务记录保持一致，新字段获得默认值。
- 隔离桌面运行时：默认回复风格、无模型时独立保存、重启持久化通过；任务、MCP 停止/恢复、服务器模式登录和 bootstrap 禁用通过。临时端口 `54110`、`54137`，没有连接或部署真实服务器。
- 候选应用签名、DMG 完整性检查通过。包内应用功能知识、回复风格模块、上下文组装及 migration 与本次编译源码一致，打包 Prisma Client 包含新字段。

## 数据保护与产物

正常退出 Dovun 并确认 `47317` 释放后，备份数据库、已有 SQLite sidecar、本机配置、浏览器偏好/草稿状态和旧应用。数据库及 sidecar 保留原文件名和同目录关系。备份完整后先删除旧应用整包，再复制候选包。

- 备份目录：`/Users/byc/Library/Application Support/dovun-release-backups/20261024-150423-reply-style-7a00fc1`。
- 旧应用：该目录的 `previous-Dovun.app.zip`，逐文件校验通过。
- 数据库备份 `PRAGMA quick_check` 为 `ok`；备份目录的私有 `install-verification.json` 保存恢复映射与哈希清单，不将业务内容和凭据写入仓库。
- 安装后全部 `15394` 个文件/链接与候选包一致，签名核验通过。
- 数据库、配置、偏好和草稿的大小、SHA256 及权限安装前后一致；没有重复迁移用户数据、没有改变同步和自动化开关。
- 应用保持关闭、`47317` 无监听。真实数据库本次未运行新增列 migration，下次启动时由现有数据库升级流程应用；仅隔离库完成了升级演练。
- 已删除构建目录中的重复 `.app`，保留 DMG。

DMG：`desktop/src-tauri/target/release/bundle/dmg/Dovun_0.4.0_aarch64.dmg`，`181230642` 字节。

SHA256：`e112fabe8fc1f663af0d419f5d9cb82bafb6644e3c938e841f4631879322bf0a`。

限制：真实模型的风格遵循效果未实测；覆盖安装后未启动用户应用。桌面冒烟使用独立临时数据。
