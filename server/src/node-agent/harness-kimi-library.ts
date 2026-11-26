import { CodexRejected } from './harness-codex.js';
import { AcpError, type AcpConnection } from './harness-acp.js';
import { assertAllowed } from './git.js';
import { codexItems as items, codexText as text } from './harness-history.js';
import { HARNESS_TEXT_LIMIT } from './harness-protocol.js';
import { openKimiAcp } from './harness-kimi-client.js';

type Frame = Record<string, unknown>;
export type KimiToolState = {
  id: string;
  kind?: string;
  title?: string;
  status?: 'completed' | 'failed' | 'inProgress';
  rawInput?: Frame;
  rawOutput?: string;
  text?: string;
  diffs?: Array<{ path: string; oldText: string; newText: string }>;
  locations?: string[];
};
type TurnRow = { id: string; status: 'completed' | 'interrupted'; items: Frame[] };
type Summary = { sessionId: string; cwd: string; title: string; updatedAt: number };

function failure(error: unknown): never {
  if (error instanceof AcpError) {
    if (error.code === -32000 || /authentication required/i.test(error.message)) {
      throw new CodexRejected('Kimi Code 需要登录，请先在本机终端运行 kimi login');
    }
    if (/cwd|project|directory/i.test(error.message)) throw new CodexRejected('这条对话不在所选项目目录中');
    if (/unknown session|not found/i.test(error.message)) throw new CodexRejected('找不到 Kimi Code 原会话，无法恢复');
  }
  throw error;
}

async function withKimi<T>(cwd: string, updates: Frame[], read: (acp: AcpConnection) => Promise<T>) {
  const acp = await openKimiAcp(cwd, (method, params, id) => {
    if (method === 'session/update') updates.push(params);
    else if (id !== undefined && method === 'session/request_permission') acp.respond(id, { outcome: { outcome: 'cancelled' } });
    else if (id !== undefined) acp.respondError(id, -32601, 'Unsupported during history read');
  });
  try {
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30_000).catch(failure);
    return await read(acp).catch(failure);
  } finally { await acp.close(); }
}

async function summaries(acp: AcpConnection, cwd?: string): Promise<Summary[]> {
  const result = await acp.request('session/list', cwd ? { cwd } : {}, 30_000);
  return items(result.sessions).flatMap((row) => {
    const sessionId = text(row.sessionId), path = text(row.cwd), at = Date.parse(text(row.updatedAt));
    if (!sessionId || !path || !Number.isFinite(at)) return [];
    return [{ sessionId, cwd: path, title: text(row.title).replace(/\s+/g, ' ').trim().slice(0, 160), updatedAt: at }];
  });
}

function thread(summary: Summary, cwd: string) {
  return {
    id: summary.sessionId, cwd, name: summary.title || 'Kimi Code 会话', preview: summary.title,
    modelProvider: 'kimi', ephemeral: false, updatedAt: Math.floor(summary.updatedAt / 1000), status: { type: 'idle' },
  };
}

async function listNative(roots: string[], cwd?: string) {
  const requested = cwd ? await assertAllowed(cwd, roots).catch(() => null) : null;
  if (cwd && !requested) return [];
  const updates: Frame[] = [];
  const rows = await withKimi(requested ?? roots[0], updates, (acp) => summaries(acp, cwd));
  const found: Array<{ summary: Summary; thread: ReturnType<typeof thread> }> = [];
  for (const summary of rows) {
    const verified = await assertAllowed(summary.cwd, roots).catch(() => null);
    if (!verified || requested && verified !== requested) continue;
    found.push({ summary, thread: thread(summary, verified) });
  }
  found.sort((a, b) => b.summary.updatedAt - a.summary.updatedAt || a.summary.sessionId.localeCompare(b.summary.sessionId));
  return found;
}

export async function listKimiThreads(roots: string[], cursor: string | null, cwd?: string) {
  const found = await listNative(roots, cwd);
  const after = cursor ? /^(\d+):(.+)$/.exec(cursor) : null;
  const offset = after ? found.findIndex((row) => row.summary.updatedAt < Number(after[1])
    || row.summary.updatedAt === Number(after[1]) && row.summary.sessionId > after[2]) : 0;
  if (offset === -1) return { data: [], nextCursor: null };
  const page = found.slice(offset, offset + 30);
  const last = page.at(-1);
  return { data: page.map((row) => row.thread),
    nextCursor: last && offset + page.length < found.length ? `${last.summary.updatedAt}:${last.summary.sessionId}` : null };
}

export async function readKimiThread(id: string, cwd: string) {
  const found = await listNative([cwd], cwd);
  return found.find((row) => row.summary.sessionId === id)?.thread ?? null;
}

export function kimiToolFeed(states: Map<string, KimiToolState>, update: Frame) {
  const id = text(update.toolCallId);
  if (!id) return null;
  const state = states.get(id) ?? { id };
  const kind = text(update.kind), title = text(update.title);
  if (kind) state.kind = kind;
  if (title) state.title = title;
  if (update.status === 'completed' || update.status === 'failed') state.status = update.status;
  else if (!state.status) state.status = 'inProgress';
  if (update.rawInput && typeof update.rawInput === 'object' && !Array.isArray(update.rawInput)) state.rawInput = update.rawInput as Frame;
  if (typeof update.rawOutput === 'string') state.rawOutput = update.rawOutput;
  const texts = items(update.content).flatMap((block) => block.type === 'content' ? [text((block.content as Frame)?.text)] : []);
  if (texts.length && texts.some((part) => part)) state.text = texts.join('\n');
  const diffs = items(update.content).flatMap((block) => {
    const path = text(block.path);
    return block.type === 'diff' && path ? [{ path, oldText: text(block.oldText), newText: text(block.newText) }] : [];
  });
  if (diffs.length) state.diffs = diffs;
  const locations = items(update.locations).map((location) => text(location.path)).filter(Boolean).slice(0, 8);
  if (locations.length) state.locations = locations;
  states.set(id, state);
  return state;
}

function patch(change: { oldText: string; newText: string }) {
  const old = change.oldText ? change.oldText.split('\n') : [];
  const next = change.newText ? change.newText.split('\n') : [];
  return `@@ -1,${old.length} +1,${next.length} @@\n`
    + old.map((line) => '-' + line).join('') + (old.length ? '\n' : '')
    + next.map((line) => '+' + line).join('\n');
}

export function kimiToolItem(state: KimiToolState, completed: boolean): Frame {
  const kind = state.kind ?? 'other';
  const status = completed ? state.status ?? 'completed' : 'inProgress';
  const base = { id: state.id, status };
  const input = state.rawInput ?? {};
  const output = state.rawOutput ?? state.text;
  if (kind === 'execute') return { ...base, type: 'commandExecution', command: text(input.command) || state.title || 'Bash',
    ...(completed && output ? { aggregatedOutput: output.slice(-24_000) } : {}) };
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return { ...base, type: 'fileChange',
    changes: state.diffs?.length ? state.diffs.slice(0, 8).map((change) => ({
      path: change.path, diff: patch(change), kind: { type: change.oldText ? 'update' : 'add' },
    })) : (state.locations ?? []).map((path) => ({ path })) };
  if (kind === 'search') return { ...base, type: 'webSearch', query: text(input.query) || state.title || 'Search' };
  return { ...base, type: 'dynamicToolCall', tool: state.title || kind, ...(completed && output ? { output: output.slice(-24_000) } : {}) };
}

export function kimiHistoryTurns(updates: Frame[], sessionId: string) {
  const turns: TurnRow[] = [];
  let current: TurnRow | undefined;
  let tools = new Map<string, KimiToolState>();
  let run: { id: string; text: string; thought: boolean } | undefined;
  let runs = 0;
  const closeRun = (final: boolean) => {
    if (!current || !run) return;
    const item = { id: run.id, type: 'agentMessage', text: run.text.slice(0, HARNESS_TEXT_LIMIT),
      phase: run.thought || !final ? 'commentary' : 'final_answer' };
    const index = current.items.findIndex((existing) => existing.id === item.id);
    if (index === -1) current.items.push(item); else current.items[index] = item;
    run = undefined;
  };
  for (const params of updates) {
    if (text(params.sessionId) !== sessionId) continue;
    const update = params.update as Frame ?? {};
    const kind = text(update.sessionUpdate);
    if (kind === 'user_message_chunk') {
      const body = text((update.content as Frame)?.text);
      if (!body.trim() || /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(body)) continue;
      if (!current || current.items.some((item) => item.type !== 'userMessage')) {
        closeRun(true);
        const id = `kimi-turn-${turns.length + 1}`;
        current = { id, status: 'interrupted', items: [{ id: `${id}:user`, type: 'userMessage', content: [] }] };
        turns.push(current);
        tools = new Map();
        runs = 0;
      }
      const user = current.items[0];
      (user.content as Frame[]).push({ type: 'text', text: body.slice(0, HARNESS_TEXT_LIMIT) });
      continue;
    }
    if (!current) continue;
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const chunk = text((update.content as Frame)?.text);
      if (!chunk) continue;
      const thought = kind === 'agent_thought_chunk';
      if (!run || run.thought !== thought) {
        closeRun(false);
        run = { id: `${current.id}:${thought ? 'thought' : 'answer'}:${runs++}`, text: '', thought };
      }
      run.text += chunk;
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      closeRun(false);
      const state = kimiToolFeed(tools, update);
      if (!state) continue;
      const done = state.status === 'completed' || state.status === 'failed';
      const item = kimiToolItem(state, done);
      const index = current.items.findIndex((existing) => existing.id === item.id);
      if (index === -1) current.items.push(item); else current.items[index] = item;
    } else if (kind === 'plan') {
      closeRun(false);
      const body = items(update.entries).map((entry) => text((entry.content as Frame)?.text)).filter(Boolean).join('\n');
      if (body) {
        const item = { id: `${current.id}:plan`, type: 'plan', text: body.slice(0, HARNESS_TEXT_LIMIT) };
        const index = current.items.findIndex((existing) => existing.id === item.id);
        if (index === -1) current.items.push(item); else current.items[index] = item;
      }
    }
  }
  closeRun(true);
  for (const turn of turns) {
    if (turn.items.some((item) => item.type !== 'userMessage')) turn.status = 'completed';
  }
  return turns;
}

export function kimiTurnPage(updates: Frame[], id: string, cursor: string | null, limit: number) {
  const turns = kimiHistoryTurns(updates, id);
  const end = cursor ? turns.findIndex((turn) => turn.id === cursor) : turns.length;
  if (end === -1) throw new CodexRejected('历史页已变化，请从最新一页重新读取');
  const start = Math.max(0, end - limit);
  const data = turns.slice(start, end).reverse();
  return { data, nextCursor: start > 0 ? data.at(-1)?.id ?? null : null };
}

export async function readKimiTurns(id: string, cwd: string, cursor: string | null, limit: number) {
  const existing = await readKimiThread(id, cwd);
  if (!existing) return { data: [] as TurnRow[], nextCursor: null };
  const updates: Frame[] = [];
  await withKimi(cwd, updates, async (acp) => {
    await acp.request('session/load', { sessionId: id, cwd, mcpServers: [] }, 120_000);
  });
  return kimiTurnPage(updates, id, cursor, limit);
}
