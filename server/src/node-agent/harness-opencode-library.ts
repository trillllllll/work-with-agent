import { basename } from 'node:path';
import { assertAllowed } from './git.js';
import { asObject, CodexRejected } from './harness-codex.js';
import { codexItems, codexText, projectCodexHistory } from './harness-history.js';
import type { HarnessCatalogThread, HarnessReadTask, HarnessView } from './harness-protocol.js';
import {
  ensureOpenCodeService, OpenCodeError, openCodeRequest, type OpenCodeService,
} from './harness-opencode-client.js';

type OpenCodeLibraryPage =
  | { threads: Array<HarnessCatalogThread & { cwd: string; name: string }>; nextCursor: string | null }
  | { threads: HarnessCatalogThread[]; nextCursor: string | null }
  | HarnessCatalogThread
  | { view: HarnessView; nextCursor: string | null };

type OpenCodeMessage = Record<string, unknown>;
type OpenCodeSession = Record<string, unknown>;

const sessionDirectory = (session: OpenCodeSession) => codexText(asObject(session.location).directory);

function sessionModelId(session: OpenCodeSession) {
  const model = asObject(session.model);
  const id = codexText(model.id), provider = codexText(model.providerID);
  return id && provider ? `${provider}/${id}` : '';
}

function sessionAgent(session: OpenCodeSession) {
  return codexText(session.agent) || 'build';
}

export async function openCodeSessionBusy(service: OpenCodeService, threadId: string) {
  const active = await openCodeRequest<{ data?: Record<string, unknown> }>(service, 'GET', '/api/session/active');
  return Boolean(active?.data && threadId in active.data);
}

function threadSummary(session: OpenCodeSession): HarnessCatalogThread {
  const time = asObject(session.time);
  const updated = typeof time.updated === 'number' && Number.isFinite(time.updated) ? new Date(time.updated).toISOString() : new Date().toISOString();
  return { threadId: codexText(session.id), title: (codexText(session.title).trim() || '未命名会话').replace(/\s+/g, ' ').slice(0, 160), updatedAt: updated };
}

function outputOfContent(value: unknown, limit: number) {
  return codexItems(value).map((part) => codexText(part.text)).join('\n').slice(0, limit);
}

/** OpenCode tools map onto the shared Codex item shapes the executor already projects. */
export function openCodeToolKind(name: string, input: Record<string, unknown>): OpenCodeMessage | null {
  if (name === 'shell' || name === 'bash') return { type: 'commandExecution', command: codexText(input.command).slice(0, 1_000) };
  if (name === 'edit' || name === 'write' || name === 'patch' || name === 'multiedit') {
    const path = codexText(input.filePath) || codexText(input.file_path) || codexText(input.path);
    return { type: 'fileChange', changes: path ? [{ path }] : [] };
  }
  return { type: 'dynamicToolCall', tool: name || 'tool' };
}

export function openCodeToolResult(state: Record<string, unknown>) {
  const metadata = asObject(state.metadata);
  const exitCode = typeof metadata.exit === 'number' && Number.isInteger(metadata.exit) ? metadata.exit : undefined;
  return { aggregatedOutput: outputOfContent(state.content, 16_000), ...(exitCode === undefined ? {} : { exitCode }) };
}

function toolItem(part: OpenCodeMessage, completed: boolean): OpenCodeMessage | null {
  const id = codexText(part.id);
  if (!id) return null;
  const state = asObject(part.state);
  const kind = openCodeToolKind(codexText(part.name), asObject(state.input));
  if (!kind) return null;
  return { id, ...kind, ...(completed ? openCodeToolResult(state) : {}) };
}

export function openCodeTurnId(messageId: string) {
  return messageId.startsWith('msg_') ? messageId.slice(4) : messageId;
}

export function openCodeUserItem(message: OpenCodeMessage) {
  const nativeId = codexText(message.id);
  const id = openCodeTurnId(nativeId);
  return {
    id, ...(nativeId.startsWith('msg_') ? { clientId: id } : {}), type: 'userMessage',
    content: [{ type: 'text', text: codexText(message.text).slice(0, 24_000) }],
  };
}

type TurnDraft = { id: string; status: string; items: OpenCodeMessage[] };

function assistantItems(message: OpenCodeMessage): OpenCodeMessage[] {
  const items: OpenCodeMessage[] = [];
  const tools: OpenCodeMessage[] = [];
  for (const [ordinal, part] of codexItems(message.content).entries()) {
    if (part.type === 'text') items.push({ id: `${codexText(message.id)}#${ordinal}`, type: 'agentMessage',
      text: codexText(part.text).slice(0, 24_000), phase: 'final_answer' });
    if (part.type === 'tool') {
      const item = toolItem(part, true);
      if (item) tools.push(item);
    }
  }
  items.push(...tools);
  return items;
}

/**
 * OpenCode groups messages by execution; Dovun groups them by user message. The cursor names the
 * oldest user message of the page above, mirroring the Claude library's boundary behavior.
 */
export async function readOpenCodeTurns(service: OpenCodeService, threadId: string, cursor: string | null,
  limit: number, lastRunning: boolean): Promise<{ data: TurnDraft[]; nextCursor: string | null }> {
  const turns: TurnDraft[] = [];
  let boundary = !cursor;
  let matched = !cursor;
  let walk: string | null = null;
  let batches = 0;
  const tail: OpenCodeMessage[] = [];
  const closeTurn = (user: OpenCodeMessage) => {
    const following = tail.slice().reverse();
    tail.length = 0;
    const idle = following.find((row) => codexText(row.type) === 'idle');
    const outcome = codexText(asObject(idle).outcome);
    const item = openCodeUserItem(user);
    const items: OpenCodeMessage[] = [item];
    for (const row of following) {
      if (codexText(row.type) === 'assistant') items.push(...assistantItems(row));
    }
    turns.push({ id: item.id, status: outcome === 'succeeded' ? 'completed' : outcome, items });
  };
  while (turns.length <= limit && batches < 40) {
    batches += 1;
    const page: { data?: OpenCodeMessage[]; cursor?: Record<string, unknown> } = await openCodeRequest(service, 'GET',
      `/api/session/${encodeURIComponent(threadId)}/message?limit=50${walk ? `&cursor=${encodeURIComponent(walk)}` : ''}`);
    const messages = codexItems(page.data);
    if (!messages.length) break;
    for (const message of messages) {
      if (codexText(message.type) !== 'user') {
        if (boundary) tail.push(message);
        continue;
      }
      const id = codexText(message.id);
      if (!boundary && id && (id === cursor || openCodeTurnId(id) === cursor)) { boundary = true; matched = true; tail.length = 0; continue; }
      if (boundary && id) {
        closeTurn(message);
        if (turns.length > limit) break;
      }
    }
    if (turns.length > limit) break;
    walk = codexText(asObject(page.cursor).next) || null;
    if (!walk) break;
  }
  if (!matched) throw new CodexRejected('历史页已变化，请从最新一页重新读取');
  const running = lastRunning && !cursor && await openCodeSessionBusy(service, threadId);
  for (const [index, turn] of turns.entries()) {
    if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') continue;
    turn.status = index === 0 && running && lastRunning ? 'inProgress' : 'completed';
  }
  const data = turns.slice(0, limit);
  return { data, nextCursor: turns.length > limit ? data.at(-1)?.id ?? null : null };
}

async function readSession(service: OpenCodeService, threadId: string) {
  try {
    const page = await openCodeRequest<{ data?: OpenCodeSession }>(service, 'GET', `/api/session/${encodeURIComponent(threadId)}`);
    return asObject(page.data);
  } catch (error) {
    if (error instanceof OpenCodeError && error.status === 404) throw new CodexRejected('找不到 OpenCode 原会话，无法恢复');
    throw error;
  }
}

export async function readOpenCodeThread(service: OpenCodeService, threadId: string, cwd: string, roots: string[]) {
  const session = await readSession(service, threadId);
  if (codexText(session.id) !== threadId || sessionDirectory(session) !== cwd
      || await assertAllowed(sessionDirectory(session), roots).catch(() => null) !== cwd) {
    throw new CodexRejected('这条对话不在所选项目目录中');
  }
  return session;
}

export async function readOpenCodeLibrary(task: Exclude<HarnessReadTask, { kind: 'files' }>, roots: string[]): Promise<OpenCodeLibraryPage> {
  const service = await ensureOpenCodeService();
  if (task.kind === 'index') {
    const page = await openCodeRequest<{ data?: OpenCodeSession[]; cursor?: Record<string, unknown> }>(service, 'GET',
      `/api/session?limit=30${task.cursor ? `&cursor=${encodeURIComponent(task.cursor)}` : ''}`);
    const threads = [];
    for (const session of codexItems(page.data)) {
      const directory = sessionDirectory(session);
      if (!codexText(session.id) || !directory) continue;
      const cwd = await assertAllowed(directory, roots).catch(() => null);
      if (!cwd) continue;
      threads.push({ ...threadSummary(session), cwd, name: (basename(cwd) || cwd).slice(0, 255) });
    }
    return { threads, nextCursor: codexText(asObject(page.cursor).next) || null };
  }
  if (task.kind === 'catalog') {
    const page = await openCodeRequest<{ data?: OpenCodeSession[]; cursor?: Record<string, unknown> }>(service, 'GET',
      `/api/session?limit=30&directory=${encodeURIComponent(task.cwd)}${task.cursor ? `&cursor=${encodeURIComponent(task.cursor)}` : ''}`);
    const threads = codexItems(page.data)
      .filter((session) => codexText(session.id) && sessionDirectory(session) === task.cwd)
      .map(threadSummary);
    return { threads, nextCursor: codexText(asObject(page.cursor).next) || null };
  }
  const session = await readOpenCodeThread(service, task.threadId, task.cwd, roots);
  if (task.kind === 'thread') return threadSummary(session);
  const page = await readOpenCodeTurns(service, task.threadId, task.cursor, 12, true);
  const { view } = await projectCodexHistory(page.data, task.cwd, roots, false, false, undefined, 'opencode');
  return { view, nextCursor: page.nextCursor };
}
