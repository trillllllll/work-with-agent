---
createAt: 2026-10-13
updateAt: 2026-10-13
summary: v0.2.0 Windows 桌面打包、静默安装与验证的完整流程，及拉取后必须先重新生成 Prisma Client 的坑
tags: [desktop, tauri, nsis, windows, prisma, packaging]
---

# 2026-10-13 Windows 桌面打包与安装（v0.2.0）

## 核心结论

- 打包命令：`npm run desktop:build:windows`（= `scripts/assemble-desktop.mjs` 组装运行时 + `scripts/tauri.mjs build --bundles nsis`）
- 产物：`desktop/src-tauri/target/release/bundle/nsis/Work With Agent_<版本>_x64-setup.exe`（0.2.0 为 79 MB）
- 静默安装：对 setup.exe 传 `/S` 参数（Tauri NSIS 标准）；装完不自动启动
- 安装位置：**每用户安装**，落在 `%LOCALAPPDATA%\Work With Agent\`（不是 `Programs` 子目录，找安装结果时别只搜 `Programs`）
- 验证：`npm run desktop:smoke` 冒烟脚本针对 `desktop/resources`（即打进安装包的同一份运行时），覆盖页面服务、匿名会话、任务创建、MCP 鉴权、服务重启恢复
- 工具链要求：Node ≥ 22（组装脚本硬校验）、Rust/cargo（Tauri 编译，release 约 1 分钟）

## 问题与解决

- **问题**：`git pull` 大版本更新后直接打包，server 的 `tsc` 报数百个 `TS2339: Property 'xxx' does not exist on type 'PrismaClient'`（缺 `libraryFolder`、`focusSession`、`planTimeBand`、`materialExtraction`、`scheduledStart` 等）
- **根因**：schema.prisma 新增了模型/字段，但 `@prisma/client` 的生成物还是旧的
- **解决**：打包前先跑 `npm run prisma:generate`（等价 `npm run prisma:generate -w server`）
- **通用规则**：凡是拉取后 schema.prisma 有变更，先 `npm install` + `npm run prisma:generate`，再 build

## 打包流水线要点（assemble-desktop.mjs）

1. 根目录 `npm run build`（server tsc + client vite）
2. 下载独立 Node 22.13.0 win-x64 到 `desktop/resources/node.exe`（有版本校验，不符才重下）
3. 在 `desktop/resources/server` 按运行时依赖清单单独 `npm install --omit=dev`（有 `.deps-stamp` 缓存，依赖清单没变就跳过）
4. 拷贝 schema、migrations、server/dist、client/dist 到 resources，并重新 `prisma generate`
5. `tauri build --bundles nsis` 编译 Rust 并出安装包

## v0.2.0 版本内容速览（2026-10-13 拉取）

- 资料库 Library（前后端全套 + 6 个 Prisma migration）
- 专注模式 Focus、计划时间带 Plan Time Bands、任务日程字段
- Chat 任务批量卡片、四象限看板、任务详情格式工具栏
- 13 个新 e2e spec；Tauri 升级、release workflow 调整

## 相关文件

- `scripts/assemble-desktop.mjs` — 桌面运行时组装
- `scripts/tauri.mjs` — Tauri CLI 包装（Windows 下经 cmd 调 tauri.cmd）
- `scripts/desktop-smoke.mjs` — 打包运行时冒烟
- `desktop/src-tauri/tauri.conf.json` — 版本号、窗口、bundle 资源映射
- `package.json` — `desktop:build:windows` / `desktop:smoke` 脚本入口
