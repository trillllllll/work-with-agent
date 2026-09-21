# Work With Agent

![CI](https://github.com/trillllllll/work-with-agent/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB.svg?logo=react&logoColor=111827)

> 一个从个人清单出发的本地工作台：先记录、整理和完成任务，再按需使用 AI 对话与受控执行。
>
> A local workspace for capturing, organizing, and completing tasks, with optional AI chat and approved execution.

[中文](#中文) · [English](#english)

![Architecture](./architecture.svg)

## 中文

### 项目简介

Work With Agent 首先是一款无需配置模型的个人清单工具。使用收集箱、清单、今天和搜索管理同一份任务，编辑日期、优先级、标签、一级子任务和顺序，并通过回收站与变更记录恢复操作。内置 Agent 可按需开启，用于整理任务、生成成果草稿及执行经过审批的文件、Shell 或 HTTP 操作。

### 核心能力

- **基础 Todo**：快速录入、清单列表、今天与逾期、搜索筛选、标签、一级子任务和持久化排序。
- **可靠编辑**：详情显式保存，失败保留草稿，父子操作共同保存，归档清单保留任务归属。
- **AI 连接与待确认**：Codex、Claude Code 通过 MCP 按清单授权访问；并发校验、幂等回执、提议整组确认。
- **材料与项目记忆**：保存文本、Markdown、链接、会话及附件，保留来源版本、记忆修订和当前简报。
- **交接与执行**：已有会话接手，或本机 CLI 在独立副本执行；结果验收、代码应用和任务完成分别记录。
- **每日/每周回顾**：规则默认关闭，先保存无模型报告，可追加受限 AI 整理建议。
- **流式 Agent 对话**：通过 Server-Sent Events 实时查看回复、工具调用和执行结果。
- **工作区看板**：以主题、任务和状态组织日常工作。
- **人工审批**：高风险工具调用进入待审批列表，可批准或拒绝。
- **变更审计与撤销**：记录用户和 Agent 的变更来源；对支持的操作提供安全撤销。
- **受控执行**：文件、Shell、HTTP 执行具备参数校验、超时、输出限制和敏感信息脱敏。
- **模型配置**：在设置页配置 OpenAI 兼容的接口地址、API Key 和模型名称。
- **响应式界面**：支持桌面和移动端，并提供亮色/暗色主题。

### 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19、Vite、TypeScript、Tailwind CSS、TanStack Query |
| 服务端 | Node.js、Express 5、TypeScript、Zod |
| 数据层 | Prisma、SQLite |
| 测试 | Vitest、Supertest、Playwright |

### 快速开始

**环境要求**：Node.js 22+、npm 10+；备份和完整测试使用 Node.js 内置 SQLite。

```bash
git clone https://github.com/trillllllll/work-with-agent.git
cd work-with-agent
npm install
copy server\.env.example server\.env   # macOS/Linux: cp server/.env.example server/.env
npm run prisma:generate
npm run db:migrate
npm run dev
```

启动后访问：

- Web：<http://127.0.0.1:5176>
- API：<http://127.0.0.1:3016>

首次使用请打开 API 启动日志中的一次性登录链接，浏览器会建立本机会话。

打开应用后即可使用基础 Todo。只有使用内置 Agent 时，才需要在“设置”页面填写模型配置。也可以通过环境变量设置 `PORT`，并在前端通过 `VITE_API_URL` 指定 API 地址。

第二至第五阶段的身份、命令、资料、MCP、交接和回顾接口见 [完整接口与接入说明](./docs/stages-2-5-api.md)，实际验证状态见 [实施与验收记录](./docs/stages-2-5-implementation.md)。

第一阶段的接口、迁移和兼容说明见 [基础 Todo 实施记录](./docs/stage-1-todo-implementation.md)。新界面的“归档清单”保留任务归属；旧 `DELETE /api/topics/:id` 仍保留归档并移出任务的兼容语义。

### 常用命令

```bash
npm run dev       # 同时启动前后端开发服务
npm run build     # 构建服务端和客户端
npm test          # 运行单元与集成测试
npm run e2e       # 无模型 Todo + Mock Agent 的桌面/移动端验收
npm run test:all  # 单元/集成测试 + E2E
```

修改 `server/prisma/schema.prisma` 后，请先停止开发服务，再运行 `npm run prisma:generate` 和 `npm run db:migrate`。

### 安全说明

- API Key 仅由服务端保存和使用，界面只显示掩码值。
- Agent 发起的敏感变更需要审批后才会执行。
- 执行结果会脱敏，并记录来源、审批 ID 和请求 ID。
- 服务仅监听回环地址。用户会话使用 HttpOnly Cookie 与 CSRF；每个 AI 连接使用独立、可撤销的凭据。
- 数据升级前停止服务并备份 SQLite、附件及运行目录。不要将本机服务直接暴露到公网。

### 项目结构

```text
client/       React 前端
server/       Express API、领域模型、应用用例、Agent 与 Prisma 适配器
e2e/          Playwright 端到端测试
docs/         架构与工程文档
architecture.svg
```

### 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请运行 `npm run test:all`，并在 PR 中说明行为变化及测试覆盖。

## English

### Overview

Work With Agent starts with a personal task list that works without a model configuration. Capture tasks in Inbox, organize lists, use Today and search, manage tags and one-level subtasks, and restore changes through Trash and audit history. Optional AI chat can organize tasks, propose summaries, and run approved file, Shell, and HTTP operations.

### Features

- **Everyday Todo** with quick capture, lists, Today, search, tags, subtasks, and saved manual ordering.
- **Explicit editing** with retained drafts on failure, grouped parent/subtask operations, and archives that preserve ownership.
- **Streaming agent chat** with Server-Sent Events for messages, tool calls, and results.
- **Workspace board** for organizing topics, tasks, and statuses.
- **Human approval** for sensitive tool calls before execution.
- **Change audit and undo** for supported reversible mutations.
- **Controlled execution** with validation, timeouts, output limits, and secret redaction.
- **Model settings** for OpenAI-compatible base URLs, API keys, and model names.
- **Responsive UI** with light and dark themes.

### Tech stack

React 19, Vite, TypeScript, Tailwind CSS, TanStack Query, Node.js, Express 5, Zod, Prisma, SQLite, Vitest, Supertest, and Playwright.

### Quick start

**Requirements**: Node.js 22+ and npm 10+. Backups and the full test suite use Node's built-in SQLite.

```bash
git clone https://github.com/trillllllll/work-with-agent.git
cd work-with-agent
npm install
cp server/.env.example server/.env
npm run prisma:generate
npm run db:migrate
npm run dev
```

Open the one-use login link printed at startup. The UI runs on <http://127.0.0.1:5176> and the loopback API on <http://127.0.0.1:3016>. A model is required only for optional AI chat and can be configured from Settings. Codex/Claude Code MCP, source-versioned materials and memories, isolated local runs, and opt-in periodic reviews are described in [the integration guide](./docs/stages-2-5-api.md).

### Commands

```bash
npm run dev       # Start client and server together
npm run build     # Build client and server
npm test          # Unit and integration tests
npm run e2e       # Desktop/mobile Todo without a model, plus mock Agent tests
npm run test:all  # Full test suite
```

### Security

The API listens on loopback only. Browser sessions use HttpOnly cookies and CSRF; external AI connections use individual revocable credentials. API keys stay on the server. AI proposals require owner review, and execution output is redacted and audited. Stop the service and runners before `npm run db:backup`; keep the SQLite, attachment, and runner snapshots together. Do not expose this local single-user service directly to the public network.

### Contributing

Issues and pull requests are welcome. Run `npm run test:all` before submitting a PR and describe any behavior changes and relevant test coverage.

## License

Licensed under the [Apache License 2.0](./LICENSE).
