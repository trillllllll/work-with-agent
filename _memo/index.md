---
createAt: 2026-09-10
updateAt: 2026-09-21
summary: Agent 工作室 MVP 验收、受控执行安全和 Git 协作约定索引
tags: [index, mvp, e2e, security, git]
---

# Agent 工作室项目记忆

## 项目概述

Agent 工作室是一个本地优先的任务与主题工作台，包含主题、任务看板、回收站、全局 Agent 对话、写操作审核、成果草稿和变更审计。

## 关键记忆

- [MVP 验收与交付](./2026-09-10_mvp-acceptance.md)
- [全局玻璃化 UI 改版](./2026-09-15_global-glass-ui.md)
- [第二至第五阶段实现及验收](../docs/stages-2-5-implementation.md)：统一命令与身份、MCP、材料记忆、Handoff/runner、定时回顾；真实宿主和数据迁移结果以此记录为准。
- [当前 API 与宿主接入](../docs/stages-2-5-api.md)：认证、版本、预览、提议、启动和恢复操作。

## 当前 Git 约定

- 本地默认分支：`main`
- 远端：`origin = https://github.com/trillllllll/WorkWithAgent.git`
- 远端只保留 `main`，远端 `master` 已删除
- 常用命令：`git pull`、`git push`

## 相关入口

- E2E 配置：`playwright.config.ts`
- E2E 场景：`e2e/app.spec.ts`
- 受控执行与审计：`server/src/services.ts`
- 前端 Agent 状态：`client/src/hooks/useChat.ts`
- 架构和验收命令：`docs/architecture-baseline.md`
