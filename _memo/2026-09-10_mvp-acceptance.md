---
createAt: 2026-09-10
updateAt: 2026-09-10
summary: Agent 工作室 MVP 验收基础设施、安全边界、执行审计和 Git 分支迁移已完成
tags: [mvp, playwright, mock-openai, controlled-execution, audit, prisma, git]
---

# 2026-09-10 MVP 验收与交付

## 核心结论

- MVP 已完成可重复验收和安全交付：主题、任务、看板、回收站、Agent 流式对话、Tool 调用、审核闸门、成果草稿、变更审计和受控执行均有覆盖。
- 默认 E2E 不依赖外部模型密钥，使用独立 SQLite 数据库和本地 Mock OpenAI 服务；真实模型联调通过环境变量单独启用。
- 所有受控执行记录使用现有 `ChangeRecord`，`entityType=execution`、`operation=execute`，保存脱敏输入和结果；受控执行不可撤销，验证拒绝不写执行审计。
- Windows 下根目录 `npm run build` 不再隐式执行 Prisma Generate。修改 Prisma Schema 后，停止运行中的服务并显式执行 `npm run prisma:generate`。

## E2E 入口

```text
npm test
npm run build
npm run e2e
npm run test:all
```

真实模型联调：

```text
E2E_REAL_MODEL=1
E2E_MODEL_BASE_URL=...
E2E_MODEL_API_KEY=...
E2E_MODEL_NAME=...
npm run e2e:real
```

Playwright 使用 Chromium 桌面和 Pixel 7 移动视口。测试服务使用 `e2e/.data/agent-studio-e2e.db`，每条用例前清理；不会复用开发数据库。

## 安全边界

- 文件和 Shell 工作目录先做词法路径检查，再对真实路径及祖先目录执行 `realpath` 校验，阻止工作区外软链接/Junction 越界。
- Shell 只允许白名单命令、参数数组和 `shell:false`，具备超时与输出大小限制。
- HTTP 只允许 HTTP(S)，统一检查本地、内网、链路本地、保留 IPv4/IPv6、IPv4-mapped IPv6 和 DNS 解析结果；禁止重定向。
- HTTP/Shell/File 结果中的 Authorization、API Key、Token、Secret、Password、Cookie 等敏感值会脱敏。
- `DnsResolver` 可注入测试替身，稳定验证 DNS 解析到受限地址的情况。

## 已验证结果

- 服务端：22 个测试通过；普通软链接测试因当前 Windows 用户无创建符号链接权限跳过，Junction 测试通过。
- 客户端：2 个测试通过。
- 默认 Playwright：6 个有效场景通过，真实模型场景默认跳过，移动专项场景在移动项目中执行。
- 根目录构建：停止服务和服务运行中均通过，没有 Prisma DLL `EPERM`。

## Git 交付状态

- 远端仓库：`https://github.com/trillllllll/WorkWithAgent.git`
- 当前本地分支：`main`
- 当前远端跟踪：`origin/main`
- 远端 `master` 已删除，以后只使用 `main`。
- 最近合并提交：`e9314be chore: 合并远端 main 初始历史`
- MVP 实现提交：`c0606c3 (feat): 完成 Agent 工作室 MVP 验收基础设施`

## 相关文件

- `package.json`
- `playwright.config.ts`
- `e2e/app.spec.ts`
- `e2e/mock-openai.mjs`
- `server/src/services.ts`
- `server/src/services.test.ts`
- `client/src/hooks/useChat.ts`
- `docs/architecture-baseline.md`
