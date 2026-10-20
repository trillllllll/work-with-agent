# Work With Agent

[简体中文](./README.md) | **English**

![CI](https://github.com/trillllllll/work-with-agent/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)

A personal task list that runs on your own machine. Codex, Claude Code, and Grok read the same tasks and project memory, and their writes wait for your approval.

- **Capture first.** Inbox, Today, lists, tags, subtasks, and manual ordering. Tasks don't need a model.
- **Then hand it to an AI.** Copy a config from **AI connections**. The host reads tasks, materials, and memories over MCP.
- **Nothing changes until you approve.** Writes land in the **Review queue** and can be undone. Data lives in local SQLite, and in development the API listens only on `127.0.0.1`.

[Quick start](#quick-start) · [Download](#download)

<img src="./docs/readme/task-list-light-en.png" width="880" alt="Light theme: the Sign-in revamp list, with the task Switch sign-in to one-time links open on the right, showing two materials and subtasks">

## Features

| Where | What it does |
| --- | --- |
| Inbox, Today, Lists, Search, Tags | Capture tasks, add descriptions, dates, priorities, and subtasks, and drag to reorder |
| AI connections | Issue a revocable credential to Codex, Claude Code, or Grok, and limit which lists it can see |
| Review queue | AI writes stop here; data changes only after you accept them |
| Work context, Library | Keep materials, sourced memories, and organized candidates |
| Skills | Write a reusable procedure once. The built-in assistant sees only names and descriptions and loads the body when it needs it. Import SKILL.md, browse versions, and approve skills the assistant drafts. |
| AI runs | Hand off a task with its goal, constraints, and acceptance criteria, then collect progress and results |
| Reviews | Generate a daily or weekly report plus suggestions for the Review queue; rules are off by default |
| Settings → Language | Switch the interface between 简体中文 and English. It follows your browser language by default, and your choice is saved on this device |

Terminology (in Chinese): [CONTEXT.md](./CONTEXT.md). API and host integration (in Chinese): [docs/stages-2-5-api.md](./docs/stages-2-5-api.md).

<img src="./docs/readme/task-list-dark-en.png" width="880" alt="Dark theme: the same list and task details, with each list's own color in the sidebar">

**Plan** lays out scheduled tasks by day, week, or month. Tasks with a date but no time go in the all-day row at the top. Tasks that crowd the same time slot stack into one card.

<img src="./docs/readme/plan-week-en.png" width="880" alt="Light theme: the Plan week view, with three overlapping Wednesday-afternoon tasks stacked into one card">

In **Work context**, confirmed memories group into communities by their relationships and can be shown as 3D terrain. The sample data below puts sign-in, lists, memory, and handoff in their own clusters; higher ground means more important, better-connected knowledge.

<img src="./docs/readme/knowledge-graph-dark-en.png" width="880" alt="Dark 3D terrain: sample project memory grouped into four communities: Sign-in, Lists, Memory, and Handoff">

## Architecture

The work loop: capture, fill in context, hand off, and bring the results back. (The diagram is in Chinese.)

![Work With Agent work loop](./architecture.svg)

<a id="download"></a>

## Download

Prebuilt installers are on [GitHub Releases](https://github.com/trillllllll/work-with-agent/releases/latest):

- macOS Apple Silicon: `.dmg`
- Windows x64: NSIS installer `.exe`

After installation, data lives in `~/Library/Application Support/work-with-agent/` on macOS and `%LOCALAPPDATA%\work-with-agent\` on Windows. The app listens on `127.0.0.1:47316`. The macOS bundle is ad-hoc signed (`signingIdentity` is `-` in `desktop/src-tauri/tauri.conf.json`) and not notarized by Apple. The Windows build has no code signing configured.

To build installers from source, see [Desktop app](#desktop-app).

<a id="quick-start"></a>

## Run from source

CI, `server/Dockerfile`, and the desktop assembler use Node.js 22. `scripts/assemble-desktop.mjs` exits on major versions below 22.

```bash
git clone https://github.com/trillllllll/work-with-agent.git
cd work-with-agent
npm install
cp server/.env.example server/.env
npm run prisma:generate
npm run db:migrate
npm run dev
```

On Windows PowerShell, copy the env file with:

```powershell
Copy-Item server/.env.example server/.env
```

The API log prints `Open workspace:`. Open that link; the `#owner-token=` in it works once, within ten minutes. The web UI is at <http://127.0.0.1:5176> (Vite proxies `/api` to the API) and the API at <http://127.0.0.1:3016>. Tasks don't need a model; for the built-in chat, enter an OpenAI-compatible endpoint, API key, and model name in **Settings**.

<a id="desktop-app"></a>

## Desktop app

The window shows the same web app; data and the API come from a bundled Node.js 22.13.0. Assembly only runs on macOS Apple Silicon or Windows x64. During development, `npm run dev` still uses <http://127.0.0.1:5176> and <http://127.0.0.1:3016>. The launcher screen follows the system language (English for `en-*`, Chinese otherwise).

macOS:

```bash
npm run desktop:build
```

The output is in `desktop/src-tauri/target/release/bundle/dmg/`. The app listens on `127.0.0.1:47316` and stores data in `~/Library/Application Support/work-with-agent/`. Before the first launch you can import your existing development database. The command refuses to overwrite a database that already exists at the target:

```bash
node scripts/import-desktop-data.mjs
```

Codex, Claude Code, and Grok can connect only while the desktop app is open. Copy the configs again from **AI connections** in the app: the stdio command points at `bin/wwa-mcp` in the data directory above, and Grok uses `http://127.0.0.1:47316/mcp`. Configs that still point at port 3016 keep talking to the development server.

Windows x64:

```powershell
npm run desktop:build:windows
```

The output is in `desktop/src-tauri/target/release/bundle/nsis/`. Data lives in `%LOCALAPPDATA%\work-with-agent\`. The MCP stdio config calls the bundled `node.exe` with `server/dist/mcp/index.js` directly.

## Connect your AI tools

Build the MCP entry point first and keep the service running:

```bash
npm run build -w server
```

Open **AI connections**, create a Codex, Claude Code, or Grok connection, and select at least the Inbox or one list. The credential is shown only once, when the connection is created. The copy button fills in your local Node path, `server/dist/mcp/index.js`, and the credential. Below is what the same config looks like; replace the path and credential with your own.

Codex `config.toml`:

```toml
[mcp_servers.work_with_agent]
command = "node"
args = ["/absolute/path/to/work-with-agent/server/dist/mcp/index.js"]

[mcp_servers.work_with_agent.env]
WWA_API_URL = "http://127.0.0.1:3016"
WWA_CONNECTION_TOKEN = "credential-shown-when-you-create-the-connection"
```

Claude Code:

```bash
claude mcp add work_with_agent node "/absolute/path/to/work-with-agent/server/dist/mcp/index.js" --scope user --env WWA_API_URL=http://127.0.0.1:3016 WWA_CONNECTION_TOKEN=credential-shown-when-you-create-the-connection
```

Grok:

```bash
grok mcp add work_with_agent --scope user --transport http http://127.0.0.1:3016/mcp --header "Authorization: Bearer credential-shown-when-you-create-the-connection"
```

Reload MCP in the host and ask it to call `list_tasks`. Writes that aren't allowed to run directly go to the **Review queue**; at that point, no data has changed yet. `get_task` includes screenshots referenced in the task description, and `get_material_attachment` reads a material file.

## Self-hosting and multi-device sync

By default each computer has its own data. To share one dataset between the desktop app and phone browsers, run an always-on instance with `docker-compose.yml` from the repo root. For the full walkthrough, reverse proxy, and snapshot migration, see [Self-hosted deployment](./docs/deployment.md) (in Chinese).

Two values are required: `WWA_OWNER_KEY` (at least 20 characters; `openssl rand -base64 32`) and `WWA_PUBLIC_URL` (the address browsers use; cookies and CORS follow it). Export them as environment variables or put them in a `.env` file in the repo root. The compose file's header also mentions putting them in `compose.override.yml`.

```bash
openssl rand -base64 32
docker compose up -d --build
docker compose logs -f
```

`API listening` in the logs means the process is up. The container maps the host's `127.0.0.1:12716` to port `3016` inside the container and doesn't listen on the public network directly. Data is in `./data` (mounted at `/data` in the container).

In the desktop app, choose **Connect to a server** on the launcher; you can switch back to local mode later from **Server** in the app. On a phone or browser, open `WWA_PUBLIC_URL` and sign in with `WWA_OWNER_KEY`. Server mode has no one-time startup link.

## Configuration

This table lists only the variables in `server/.env.example` and `docker-compose.yml`. For local development, copying `.env.example` is enough; commented-out entries have default behavior.

| Variable | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `.env.example` | SQLite. The example `file:../data/agent-studio.db` is relative to `server/prisma/schema.prisma`, i.e. `server/data/agent-studio.db` |
| `PORT` | `.env.example` (commented) | Defaults to `3016` |
| `CLIENT_ORIGIN` | Both | Local example `http://127.0.0.1:5176,http://localhost:5176`. Set to `WWA_PUBLIC_URL` in compose |
| `KNOWLEDGE_STORAGE_ROOT` | `.env.example` (commented) | Optional absolute path for material files |
| `WWA_RUNNER_DIR` | `.env.example` (commented) | Optional absolute path for the runner directory |
| `WWA_CODEX_BIN` | `.env.example` (commented) | Optional absolute path to the Codex executable |
| `WWA_CLAUDE_BIN` | `.env.example` (commented) | Optional absolute path to the Claude Code executable |
| `WWA_CODEX_WINDOWS_SANDBOX` | `.env.example` (commented) | On Windows, `unelevated` (default) or `elevated` |
| `BRAVE_IMAGE_SEARCH_KEY` | Both | Optional. The image search key stays on the server |
| `BRAVE_IMAGE_SEARCH_PROXY_URL` | `docker-compose.yml` | Optional. Outbound proxy for image search |
| `WWA_OWNER_KEY` | `docker-compose.yml` (required) | Self-hosted sign-in key, at least 20 characters |
| `WWA_PUBLIC_URL` | `docker-compose.yml` (required) | The address browsers use, e.g. `https://wwa.example.com` |
| `WWA_PUBLIC_HTTPS` | `docker-compose.yml` | Fixed at `1` |
| `TZ` | `docker-compose.yml` | Defaults to `Asia/Shanghai` |

## Project layout

| Path | Contents |
| --- | --- |
| `client/` | React 19, Vite, TypeScript, Tailwind. Dev server on `127.0.0.1:5176`. Translations in `client/src/i18n/locales/` |
| `server/` | Node.js, Express 5, Prisma, SQLite. Entry point `server/src/index.ts`; MCP in `server/src/mcp/` |
| `desktop/` | Tauri shell. Config in `desktop/src-tauri/` |
| `e2e/` | Playwright |
| `scripts/` | Test wrapper, backup, desktop assembly and import |
| `docs/` | Product notes and [deployment](./docs/deployment.md) (in Chinese) |

The repo root also holds `architecture.svg`, `docker-compose.yml`, and `package.json`.

## Development and testing

All commands come from the root `package.json`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start server and client together |
| `npm run build` | Build the server, then the client |
| `npm run prisma:generate` | Generate the Prisma Client |
| `npm run db:migrate` | Migrate the database |
| `npm test` | `scripts/test.mjs`: generate the client and migrate if needed, then run server and client Vitest |
| `npm run i18n:check` | Check that the Chinese and English locale files have the same keys and that no Chinese literals remain in `client/src` |
| `npm run e2e` | Playwright |
| `npm run test:all` | `npm test`, then `npm run e2e` |
| `npm run e2e:real` | Real-model smoke test. Needs `E2E_REAL_MODEL`, `E2E_MODEL_BASE_URL`, `E2E_MODEL_API_KEY`, `E2E_MODEL_NAME` |
| `npm run test:library:migration` | Library migration rehearsal |
| `npm run test:library:performance` | Library performance script |
| `npm run db:backup` | Back up SQLite, the materials directory, and the runner directory to `.backups/`. Stop the API and runner first |
| `npm run desktop:assemble` | Assemble the desktop runtime (needs Node.js 22 on macOS Apple Silicon or Windows x64) |
| `npm run desktop:dev` | Assemble, then start Tauri |
| `npm run desktop:build` | Assemble and build `app` and `dmg` per `tauri.conf.json` |
| `npm run desktop:build:windows` | Assemble and build NSIS (`--bundles nsis`) |
| `npm run desktop:smoke` | Check the assembled desktop runtime |

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run prisma:generate`, `npm run i18n:check`, `npm test`, and `npm run build` on Node.js 22.

## Data and security

- In development the API listens only on `127.0.0.1` by default. The database is SQLite.
- The model API key is stored on the server and only ever returned masked. `BRAVE_IMAGE_SEARCH_KEY` is never sent to the client.
- External AIs use their own credentials. Writes not allowed to run directly go to the **Review queue**.
- **Change history** keeps a record of operations, and some of them can be undone.

Details (in Chinese): [Local identity](./docs/stages-2-5-api.md#本机身份).

## Language support

The web and desktop interface is available in Simplified Chinese and English. Some text produced by the server, such as error messages, generated briefs, and knowledge-tree branch names, is still in Chinese.

## License and contributing

[Apache License 2.0](./LICENSE). Issues and pull requests are welcome. Run `npm run test:all` before submitting, and describe the behavior change and test coverage in your PR.
