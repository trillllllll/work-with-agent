# Work With Agent

![CI](https://github.com/trillllllll/work-with-agent/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB.svg?logo=react&logoColor=111827)

> **让每一次工作，都能接着上次继续。**
>
> Work With Agent 是一个本地优先的个人项目工作台：从一条 Todo 开始，把任务、材料、项目记忆和 AI 执行结果，沉淀成一条可持续推进的工作链路。

[中文](#中文) · [English](#english)

![Architecture](./architecture.svg)

## 中文

### 你缺的不是又一个 Todo

长期项目真正难的地方，从来不是记住一件事，而是记住它为什么重要、已经试过什么、下一步该怎么继续。

信息散落在清单、文件、聊天记录和不同 AI 会话里，每次重新开始都要重复解释背景；AI 做完工作后，结果又停留在聊天窗口，无法回到项目本身。

**Work With Agent 把这些内容放回同一个工作上下文。**

你可以像使用轻量 Todo 一样快速记录工作，也可以逐步为任务补充项目、材料、决策、完成标准和历史经验。需要 AI 时，交给它的是一份带上下文的正式接力，而不是一段孤立的 Prompt。

### 从记录到完成，形成一个闭环

```text
快速记录 → 整理为任务与项目 → 补充材料和记忆
                         ↓
              自己处理，或交给 AI 接力
                         ↓
        结果、成果和经验回到项目，准备下一步
```

### 核心亮点

- **先记下来，再慢慢整理**：收集箱、清单、今天、搜索和标签，让捕捉想法足够快，不必在输入时决定一切。
- **任务自带完整上下文**：目标、完成标准、相关材料、历史决策和已尝试方案，都可以跟着任务一起交接。
- **AI 是协作者，不是黑箱**：AI 可以整理任务、生成草稿、提出记忆更新和执行建议；重要变化由你确认后才会发生。
- **正式的 AI 接力**：生成包含背景、约束、验收标准和期望交付物的接力包，让不同会话、不同工具都能从正确的位置开始。
- **结果不会丢在聊天里**：执行结果、成果草稿、后续事项和项目记忆都能回到工作台，成为下一次工作的起点。
- **本地优先，过程可追溯**：数据存储在本机，操作有审计记录，支持撤销；文件、Shell 和 HTTP 执行都有校验、超时和敏感信息脱敏。

### 适合这些时刻

- 一个要持续几周或几个月的个人项目
- 需要在多个 AI 工具之间来回接力的开发、研究或创作
- 不想把重要决策埋在聊天记录里的工作
- 想先拥有可靠任务管理，再按需接入 AI 的本地工作流

### 你会得到什么

| 工作对象 | 在 Work With Agent 里如何协作 |
| --- | --- |
| 任务 | 记录下一步行动，并附带目的、优先级、标签、子任务和完成标准 |
| 项目 | 汇总目标、任务、材料、决策、记忆和成果，随工作持续演化 |
| 材料 | 保存文档、Markdown、链接、会话和附件，保留来源与版本 |
| 项目记忆 | 沉淀当前有效的事实、约束、经验和决策，保留来源与变化历史 |
| AI 接力 | 将任务交给受控的 AI 会话或本机执行器，并接收可验收的结果 |
| 成果 | 保存报告、代码、设计、链接和摘要，让输出可以继续被复用 |

### 开始使用

**环境要求**：Node.js 22+、npm 10+

```bash
git clone https://github.com/trillllllll/work-with-agent.git
cd work-with-agent
npm install
cp server/.env.example server/.env
npm run prisma:generate
npm run db:migrate
npm run dev
```

Windows PowerShell 可使用：

```powershell
Copy-Item server/.env.example server/.env
```

启动后访问：

- Web：<http://127.0.0.1:5176>
- API：<http://127.0.0.1:3016>

首次启动时，打开 API 日志中输出的一次性登录链接即可建立本机会话。基础 Todo 不需要配置模型；只有使用内置 Agent 时，才需要在“设置”页面填写 OpenAI 兼容接口地址、API Key 和模型名称。

### 常用命令

```bash
npm run dev       # 同时启动前后端开发服务
npm run build     # 构建服务端和客户端
npm test          # 单元与集成测试
npm run e2e       # 桌面/移动端端到端验收
npm run test:all  # 完整测试
```

### 设计取舍

Work With Agent 不追求让 AI 自动接管所有事情，而是让项目在人和 AI 之间保持连续：

1. **Todo 是入口**：先让记录和推进足够轻，再逐步增加项目上下文。
2. **AI 提议，用户确认**：重要分类、记忆和写操作都保留人的判断权。
3. **材料不等于记忆**：原始证据与已经确认的项目认知分开保存。
4. **结果必须回流**：完成一次任务，不只是收到回复，还要留下成果、经验和下一步。

### 安全与隐私

- API Key 仅由服务端保存和使用，界面只显示掩码值。
- Agent 的敏感写操作进入待审批列表，批准后才会执行。
- 文件、Shell 和 HTTP 执行具备参数校验、超时、输出限制和敏感信息脱敏。
- 服务默认只监听回环地址，不应直接暴露到公网。
- 浏览器会话使用 HttpOnly Cookie 与 CSRF 防护；外部 AI 连接使用独立、可撤销的凭据。
- 用户操作和 Agent 变更保留审计记录，支持对部分操作安全撤销。

### 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19、Vite、TypeScript、Tailwind CSS、TanStack Query |
| 服务端 | Node.js、Express 5、TypeScript、Zod |
| 数据层 | Prisma、SQLite |
| 测试 | Vitest、Supertest、Playwright |

### 项目结构

```text
client/       React 前端
server/       Express API、领域模型、Agent 与 Prisma 适配器
e2e/          Playwright 端到端测试
docs/         架构、产品和工程文档
architecture.svg
```

更多 API、MCP、材料记忆、Handoff、Runner 和回顾能力，见 [完整接口与接入说明](./docs/stages-2-5-api.md)；当前实现和验收状态见 [实施与验收记录](./docs/stages-2-5-implementation.md)。

### 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请运行 `npm run test:all`，并在 PR 中说明行为变化与测试覆盖。

## English

### Keep the work moving, even when the context changes

Work With Agent is a local-first personal project workspace. It starts with a fast Todo experience, then connects tasks with project materials, decisions, durable memory, AI handoffs, and reviewable results.

Long-running work often breaks at the handoff: context lives in one chat, files in another folder, decisions in someone's memory, and the next step in a separate task list. Work With Agent keeps those pieces together so you can capture quickly, resume with context, and let people or AI continue from the same source of truth.

### Highlights

- Fast capture with Inbox, lists, Today, search, tags, priorities, and subtasks.
- Tasks that carry goals, completion criteria, materials, decisions, and previous attempts.
- Project memory for current facts, constraints, decisions, and lessons with source history.
- Structured AI handoffs instead of isolated prompts.
- Streaming Agent chat, controlled file/Shell/HTTP execution, approvals, audit history, and undo.
- Materials, drafts, artifacts, and follow-up work returned to the project after execution.
- Local-first SQLite storage with responsive light and dark interfaces.

### Quick start

**Requirements**: Node.js 22+ and npm 10+

```bash
git clone https://github.com/trillllllll/work-with-agent.git
cd work-with-agent
npm install
cp server/.env.example server/.env
npm run prisma:generate
npm run db:migrate
npm run dev
```

Open the one-time login link printed by the API. The Web UI runs on <http://127.0.0.1:5176> and the loopback API on <http://127.0.0.1:3016>. A model is required only for optional Agent features and can be configured from Settings.

### Commands

```bash
npm run dev       # Start client and server together
npm run build     # Build client and server
npm test          # Unit and integration tests
npm run e2e       # End-to-end acceptance tests
npm run test:all  # Full test suite
```

### Security

The API listens on loopback by default. API keys stay on the server. Sensitive Agent proposals require owner approval, execution output is redacted and audited, and browser sessions use HttpOnly cookies with CSRF protection. Do not expose this local single-user service directly to the public network.

## License

Licensed under the [Apache License 2.0](./LICENSE).
