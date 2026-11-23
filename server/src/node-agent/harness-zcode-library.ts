import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { assertAllowed } from './git.js';
import { asObject, CodexRejected, type HarnessRuntime } from './harness-codex.js';
import { codexItems as items, codexText as text, projectCodexHistory } from './harness-history.js';
import { withZCode, zcodeWorkspace } from './harness-zcode-client.js';
import { zcodeHarnessTool } from './harness-zcode-tools.js';
import { HARNESS_TEXT_LIMIT, type HarnessCatalogThread, type HarnessReadTask, type HarnessTurn } from './harness-protocol.js';

const pageSize = 30;
const projectSessionKinds = new Set(['interactive', 'fork', 'workflow_parent']);

async function threadSummary(value: Record<string, unknown>, roots: string[], project?: string) {
  const workspace = asObject(value.workspace);
  const path = text(workspace.workspacePath);
  const id = text(value.sessionId);
  const kind = text(value.sessionKind) || 'interactive';
  if (!id || id.length > 200 || !projectSessionKinds.has(kind) || workspace.workspaceIdentity || workspace.remoteSessionId || !isAbsolute(path)) return null;
  const cwd = await assertAllowed(path, roots).catch(() => null);
  if (!cwd || project && cwd !== project || !(await stat(cwd).catch(() => null))?.isDirectory()) return null;
  const updated = typeof value.updatedAt === 'number' && Math.abs(value.updatedAt) <= 8.64e15 ? value.updatedAt : 0;
  const summary: HarnessCatalogThread = {
    threadId: id,
    title: text(value.title).replace(/\s+/g, ' ').trim().slice(0, 160),
    updatedAt: new Date(updated).toISOString(),
  };
  return { ...summary, cwd, name: (basename(cwd) || cwd).slice(0, 255) };
}

export async function readZCodeThread(app: HarnessRuntime, id: string, cwd: string) {
  const result = await app.request('session/list', { sessionIds: [id], workspace: zcodeWorkspace(cwd) });
  const entry = items(result.sessions).find((item) => item.sessionId === id);
  const verified = entry && await threadSummary(entry, [cwd], cwd);
  if (!verified) throw new CodexRejected('这条对话不在所选项目目录中');
  return verified;
}

export async function readZCodeRows(app: HarnessRuntime, id: string, cwd: string, cursor: string | null, limit: number) {
  const before = cursor === null ? null : Number(cursor);
  if (before !== null && (!/^\d+$/.test(cursor!) || !Number.isSafeInteger(before) || before <= 0)) {
    throw new CodexRejected('历史页已变化，请从最新一页重新读取');
  }
  const workspace = zcodeWorkspace(cwd);
  // Request the cold history projection before paging it. This leaves the native runtime inactive.
  await app.request('v4/conversation/subscribe', { topic: 'conversation/' + id, connectionId: 'dovun-history',
    workspace, clientMode: 'web-remote-replayable', historyFirst: true });
  return app.request('v4/conversation/rowsRange', { sessionId: id, workspace, limit, clientMode: 'web-remote-replayable',
    ...(before === null ? {} : { beforeRowId: before }) });
}

function rowStatus(value: unknown): HarnessTurn['status'] {
  switch (value) {
    case 'running': return 'inProgress';
    case 'completedSuccess': return 'completed';
    case 'completedInterrupted': return 'interrupted';
    case 'failed': return 'failed';
    default: return 'unknown';
  }
}

export function zcodeTurns(rows: unknown) {
  const turns = new Map<string, { id: string; status: HarnessTurn['status']; items: Array<Record<string, unknown>> }>();
  for (const row of items(rows)) {
    const id = text(row.productTurnId) || text(row.turnId);
    if (!id) continue;
    if (row.kind !== 'turnHeader' && row.kind !== 'userInput' && row.kind !== 'assistantText' && row.kind !== 'toolCall') continue;
    const turn = turns.get(id) ?? { id, status: 'completed', items: [] };
    turns.set(id, turn);
    if (row.kind === 'turnHeader') {
      turn.status = rowStatus(row.state);
      continue;
    }
    const itemId = text(row.entityId) || (Number.isSafeInteger(row.rowId) ? 'zcode-row-' + row.rowId : '');
    if (row.kind === 'toolCall') {
      if (itemId) turn.items.push({ ...row, id: itemId });
      continue;
    }
    const body = text(row.text).slice(0, HARNESS_TEXT_LIMIT);
    if (!itemId || !body) continue;
    turn.items.push(row.kind === 'userInput'
      ? { id: itemId, type: 'userMessage', clientId: text(row.sourceCommandId), content: [{ type: 'text', text: body }] }
      : { id: itemId, type: 'agentMessage', text: body });
  }
  return [...turns.values()].reverse();
}

export async function readZCodeLibrary(task: Extract<HarnessReadTask, { kind: 'index' | 'catalog' | 'thread' | 'history' }>, roots: string[]) {
  const cwd = await assertAllowed(task.kind === 'index' ? roots[0] : task.cwd, roots);
  return withZCode(cwd, async (app) => {
    if (task.kind === 'index' || task.kind === 'catalog') {
      const offset = task.cursor === null ? 0 : Number(task.cursor);
      if (!/^\d+$/.test(task.cursor ?? '0') || !Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) {
        throw new CodexRejected('会话列表已变化，请从第一页重新读取');
      }
      const project = task.kind === 'catalog' ? cwd : undefined;
      // ZCode's session/list has a limit and no cursor. Keep the cursor over raw rows so filtered projects cannot skip a page.
      const { sessions } = await app.request('session/list', { limit: offset + pageSize + 1, ...(project ? { workspace: zcodeWorkspace(project) } : {}) });
      const page = items(sessions).slice(offset, offset + pageSize + 1);
      const threads = (await Promise.all(page.slice(0, pageSize).map((row) => threadSummary(row, roots, project))))
        .filter((row) => row !== null);
      const nextCursor = page.length > pageSize && offset + pageSize <= 10_000 ? String(offset + pageSize) : null;
      return { threads: project ? threads.map(({ threadId, title, updatedAt }) => ({ threadId, title, updatedAt })) : threads, nextCursor };
    }
    const { threadId, title, updatedAt } = await readZCodeThread(app, task.threadId, cwd);
    if (task.kind === 'thread') return { threadId, title, updatedAt };
    for (const limit of [36, 18, 9, 4, 1]) {
      const page = await readZCodeRows(app, threadId, cwd, task.cursor, limit);
      const { view } = await projectCodexHistory(zcodeTurns(page.rows), cwd, roots, false, false, zcodeHarnessTool);
      const first = items(page.rows)[0]?.rowId;
      const nextCursor = page.hasMore === true && Number.isSafeInteger(first) ? String(first) : null;
      const result = { view, nextCursor };
      if (Buffer.byteLength(JSON.stringify(result)) <= 6_000_000) return result;
    }
    throw new CodexRejected('这轮历史超出一次读取的大小，请在本机查看');
  });
}
