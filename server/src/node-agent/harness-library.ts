import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { assertAllowed } from './git.js';
import { asObject, CodexAppServer, CodexRejected, type HarnessRuntime } from './harness-codex.js';
import { codexOrganization, readCodexPins, readCodexProjectPins } from './harness-codex-organization.js';
import { listClaudeThreads, readClaudeThread, readClaudeTurns } from './harness-claude-library.js';
import { codexItems, codexText, projectCodexHistory } from './harness-history.js';
import type { HarnessCatalogThread, HarnessReadTask } from './harness-protocol.js';
import { readHarnessFiles } from './harness-files.js';
import { readZCodeLibrary } from './harness-zcode-library.js';

const exec = promisify(execFile);

async function belongsToProject(thread: Record<string, unknown>, cwd: string, roots: string[]) {
  return thread.ephemeral !== true && typeof thread.cwd === 'string'
    && await assertAllowed(thread.cwd, roots).catch(() => null) === cwd;
}

export async function readProjectThread(app: HarnessRuntime, threadId: string, cwd: string, roots: string[]) {
  const { thread: result } = await app.request('thread/read', { threadId, includeTurns: false });
  const thread = asObject(result);
  if (thread.id !== threadId || !await belongsToProject(thread, cwd, roots)) {
    throw new CodexRejected('这条对话不在所选项目目录中');
  }
  return thread;
}

export async function assertNativeThreadIdle(app: HarnessRuntime, thread: Record<string, unknown>, threadId: string) {
  const page = await app.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
  const latest = codexItems(page.data)[0];
  let busy = asObject(thread.status).type === 'active' || latest?.status === 'inProgress';
  // Another Mac Codex process reports an unfinished turn as interrupted when read from disk.
  if (!busy && (thread.modelProvider === 'claude' || latest?.status === 'interrupted' && latest.startedAt != null && latest.completedAt == null)
      && process.platform === 'darwin' && typeof thread.path === 'string' && isAbsolute(thread.path)) {
    const { stdout } = await exec('/usr/sbin/lsof', ['-w', '-Fa', '--', thread.path], { timeout: 2_000, maxBuffer: 32_768 })
      .catch(() => ({ stdout: '' }));
    busy = stdout.split('\n').some((field) => field === 'aw' || field === 'au');
  }
  if (busy) throw new CodexRejected('原会话正在运行，结束后可以继续');
}

function summary(thread: Record<string, unknown>): HarnessCatalogThread {
  const seconds = typeof thread.updatedAt === 'number' && Math.abs(thread.updatedAt) < 8_640_000_000_000 ? thread.updatedAt : 0;
  return { threadId: codexText(thread.id), title: (codexText(thread.name).trim() || codexText(thread.preview).trim())
    .replace(/\s+/g, ' ').slice(0, 160), updatedAt: new Date(seconds * 1000).toISOString() };
}

export async function readHarnessLibrary(task: HarnessReadTask, roots: string[]) {
  if ('harness' in task && task.harness === 'zcode') return readZCodeLibrary(task, roots);
  if ('harness' in task && task.harness === 'claude') {
    if (task.kind === 'index') {
      const page = await listClaudeThreads(roots, task.cursor, undefined, task.organization);
      return { threads: page.data.map((thread) => ({ ...summary(thread), organization: thread.organization, cwd: thread.cwd, name: (basename(thread.cwd) || thread.cwd).slice(0, 255) })),
        nextCursor: page.nextCursor };
    }
    const cwd = await assertAllowed(task.cwd, roots);
    if (task.kind === 'catalog') {
      const page = await listClaudeThreads([cwd], task.cursor, cwd, task.organization);
      return { threads: page.data.map((thread) => ({ ...summary(thread), organization: thread.organization })), nextCursor: page.nextCursor };
    }
    const thread = await readClaudeThread(task.threadId, cwd, task.kind === 'thread' && task.organization);
    if (!thread) throw new CodexRejected('这条对话不在所选项目目录中');
    if (task.kind === 'thread') return { ...summary(thread), organization: thread.organization };
    const page = await readClaudeTurns(task.threadId, cwd, task.cursor, 12);
    return { view: (await projectCodexHistory(page.data, cwd, roots, false)).view, nextCursor: page.nextCursor };
  }
  if (task.kind === 'index') {
    const app = await CodexAppServer.open(roots[0], () => undefined, () => undefined, { experimental: task.organization });
    try {
      const pins = task.organization ? await readCodexPins() : {};
      const archived = task.archived === true;
      const filter = { limit: 30, sortKey: 'updated_at', modelProviders: [], ...(task.organization ? { archived } : {}) };
      const { data, nextCursor } = await app.request('thread/list', { ...filter, cursor: task.cursor });
      const project = async (value: unknown, fromArchive: boolean) => {
        const threads = [];
        for (const thread of codexItems(value)) {
          if (thread.ephemeral === true || !codexText(thread.id) || typeof thread.cwd !== 'string' || !isAbsolute(thread.cwd)) continue;
          const cwd = await assertAllowed(thread.cwd, roots).catch(() => null);
          if (!cwd || !(await stat(cwd).catch(() => null))?.isDirectory()) continue;
          const organization = task.organization ? codexOrganization(thread, pins.threads, fromArchive) : undefined;
          threads.push({ ...summary(thread), cwd, name: (basename(cwd) || cwd).slice(0, 255), ...(organization ? { organization } : {}) });
        }
        return threads;
      };
      const threads = await project(data, archived);
      if (task.cursor || !task.organization) return { threads, nextCursor: codexText(nextCursor) || null };
      const recheck = task.recheckThreadIds ?? [];
      const pinned = archived ? [] : pins.threads?.slice(0, 30) ?? [];
      const known = new Set(threads.map((thread) => thread.threadId));
      const loadPriority = async (ids: string[], fromArchive: boolean) => {
        if (!ids.length) return [];
        try {
          const page = await app.request('thread/list', { ...filter, limit: ids.length,
            archived: fromArchive, includedThreadIds: ids, useStateDbOnly: true });
          return await project(codexItems(page.data).filter((thread) => ids.includes(codexText(thread.id))), fromArchive);
        } catch { return []; }
      };
      const [priority, projectPins] = await Promise.all([
        loadPriority([...new Set([...pinned, ...recheck])].filter((id) => !known.has(id)), archived),
        readCodexProjectPins(app, pins.projects, roots),
      ]);
      for (const thread of priority) known.add(thread.threadId);
      const moved = await loadPriority(recheck.filter((id) => !known.has(id)), !archived);
      return { threads, nextCursor: codexText(nextCursor) || null, priorityThreads: [...priority, ...moved], projectPins };
    } finally {
      await app.close();
    }
  }
  const cwd = await assertAllowed(task.cwd, roots);
  if (!(await stat(cwd)).isDirectory()) throw new CodexRejected('项目位置不是目录');
  if (task.kind === 'files') return readHarnessFiles(cwd, task.path, task.preview);
  const app = await CodexAppServer.open(cwd, () => undefined, () => undefined);
  try {
    const pins = 'organization' in task && task.organization ? await readCodexPins() : {};
    if (task.kind === 'catalog') {
      const { data, nextCursor } = await app.request('thread/list', {
        cwd: [...new Set([task.cwd, cwd])], limit: 30, sortKey: 'updated_at', modelProviders: [], cursor: task.cursor,
      });
      const threads: HarnessCatalogThread[] = [];
      for (const thread of codexItems(data)) {
        if (codexText(thread.id) && await belongsToProject(thread, cwd, roots)) {
          const organization = task.organization ? codexOrganization(thread, pins.threads, false) : undefined;
          threads.push({ ...summary(thread), ...(organization ? { organization } : {}) });
        }
      }
      return { threads, nextCursor: codexText(nextCursor) || null };
    }
    const thread = await readProjectThread(app, task.threadId, cwd, roots);
    if (task.kind === 'thread') {
      const organization = task.organization ? codexOrganization(thread, pins.threads) : undefined;
      return { ...summary(thread), ...(organization ? { organization } : {}) };
    }
    // Use Codex's opaque cursor even when the returned page has to be smaller.
    for (let limit = 12; limit >= 1; limit = Math.floor(limit / 2)) {
      const page = await app.request('thread/turns/list', { threadId: task.threadId, cursor: task.cursor,
        limit, sortDirection: 'desc', itemsView: 'full' });
      const { view } = await projectCodexHistory(page.data, cwd, roots, false);
      const result = { view, nextCursor: codexText(page.nextCursor) || null };
      if (Buffer.byteLength(JSON.stringify(result)) <= 6_000_000) return result;
    }
    throw new CodexRejected('这轮历史超出一次读取的大小，请在 Codex 中查看');
  } finally {
    await app.close();
  }
}
