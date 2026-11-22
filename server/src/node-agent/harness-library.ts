import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { assertAllowed } from './git.js';
import { asObject, CodexAppServer, CodexRejected } from './harness-codex.js';
import { codexItems, codexText, projectCodexHistory } from './harness-history.js';
import type { HarnessCatalogThread, HarnessReadTask } from './harness-protocol.js';

const exec = promisify(execFile);

async function belongsToProject(thread: Record<string, unknown>, cwd: string, roots: string[]) {
  return thread.ephemeral !== true && typeof thread.cwd === 'string'
    && await assertAllowed(thread.cwd, roots).catch(() => null) === cwd;
}

export async function readProjectThread(app: CodexAppServer, threadId: string, cwd: string, roots: string[]) {
  const { thread: result } = await app.request('thread/read', { threadId, includeTurns: false });
  const thread = asObject(result);
  if (thread.id !== threadId || !await belongsToProject(thread, cwd, roots)) {
    throw new CodexRejected('这条 Codex 对话不在所选项目目录中');
  }
  return thread;
}

export async function assertNativeThreadIdle(app: CodexAppServer, thread: Record<string, unknown>, threadId: string) {
  const page = await app.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
  const latest = codexItems(page.data)[0];
  let busy = asObject(thread.status).type === 'active' || latest?.status === 'inProgress';
  // Another Mac Codex process reports an unfinished turn as interrupted when read from disk.
  if (!busy && latest?.status === 'interrupted' && latest.startedAt != null && latest.completedAt == null
      && process.platform === 'darwin' && typeof thread.path === 'string' && isAbsolute(thread.path)) {
    const { stdout } = await exec('/usr/sbin/lsof', ['-w', '-Fa', '--', thread.path], { timeout: 2_000, maxBuffer: 32_768 })
      .catch(() => ({ stdout: '' }));
    busy = stdout.split('\n').some((field) => field === 'aw' || field === 'au');
  }
  if (busy) throw new CodexRejected('原 Codex 会话正在运行，结束后可以继续');
}

function summary(thread: Record<string, unknown>): HarnessCatalogThread {
  const seconds = typeof thread.updatedAt === 'number' && Math.abs(thread.updatedAt) < 8_640_000_000_000 ? thread.updatedAt : 0;
  return { threadId: codexText(thread.id), title: (codexText(thread.name).trim() || codexText(thread.preview).trim())
    .replace(/\s+/g, ' ').slice(0, 160), updatedAt: new Date(seconds * 1000).toISOString() };
}

export async function readHarnessLibrary(task: HarnessReadTask, roots: string[]) {
  const cwd = await assertAllowed(task.cwd, roots);
  if (!(await stat(cwd)).isDirectory()) throw new CodexRejected('项目位置不是目录');
  const app = await CodexAppServer.open(cwd, () => undefined, () => undefined);
  try {
    if (task.kind === 'catalog') {
      const { data, nextCursor } = await app.request('thread/list', {
        cwd: [...new Set([task.cwd, cwd])], limit: 30, sortKey: 'updated_at', modelProviders: [], cursor: task.cursor,
      });
      const threads: HarnessCatalogThread[] = [];
      for (const thread of codexItems(data)) {
        if (codexText(thread.id) && await belongsToProject(thread, cwd, roots)) threads.push(summary(thread));
      }
      return { threads, nextCursor: codexText(nextCursor) || null };
    }
    const thread = await readProjectThread(app, task.threadId, cwd, roots);
    if (task.kind === 'thread') return summary(thread);
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
