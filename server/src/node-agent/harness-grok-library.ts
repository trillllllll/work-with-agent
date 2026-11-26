import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { assertAllowed } from './git.js';
import { asObject, CodexRejected } from './harness-codex.js';
import { codexItems as items, codexText as text } from './harness-history.js';
import { HARNESS_TEXT_LIMIT } from './harness-protocol.js';

const sessionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** Grok keeps everything under `$GROK_HOME` (default `~/.grok`): config, auth, and the session store. */
export const grokHome = () => process.env.GROK_HOME ? resolve(process.env.GROK_HOME) : resolve(homedir(), '.grok');
export const grokSessionsDirectory = () => resolve(grokHome(), 'sessions');
export const grokSessionDirectory = (cwd: string, id: string) => resolve(grokSessionsDirectory(), encodeURIComponent(cwd), id);

type Summary = {
  info: { id: string; cwd: string };
  session_summary?: string;
  generated_title?: string;
  created_at?: string;
  updated_at?: string;
  num_chat_messages?: number;
  current_model_id?: string;
  reasoning_effort?: string;
};

async function readSummary(cwd: string, id: string): Promise<{ summary: Summary; path: string } | null> {
  const directory = grokSessionDirectory(cwd, id);
  const at = await lstat(resolve(directory, 'summary.json')).catch(() => null);
  if (!at?.isFile()) return null;
  const raw = await readFile(resolve(directory, 'summary.json'), 'utf8').catch(() => null);
  if (raw === null) return null;
  const summary = asObject(JSON.parse(raw)) as unknown as Summary;
  if (summary?.info?.id !== id || summary?.info?.cwd !== cwd) return null;
  return { summary, path: directory };
}

/** Existence check that also accepts freshly created sessions with no messages yet. */
export async function grokSessionExists(cwd: string, id: string) {
  if (!sessionIdPattern.test(id)) return false;
  return readSummary(cwd, id).then((found) => found !== null);
}

function title(summary: Summary) {
  return (summary.generated_title ?? summary.session_summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function updatedSeconds(summary: Summary) {
  const at = Date.parse(summary.updated_at ?? summary.created_at ?? '');
  return Number.isSafeInteger(at) && at > 0 ? Math.floor(at / 1000) : 0;
}

/** A native Grok session is busy while its TUI/agent process still holds it open in `active_sessions.json`. */
export async function isGrokSessionActive(id: string) {
  const raw = await readFile(resolve(grokHome(), 'active_sessions.json'), 'utf8').catch(() => null);
  return raw !== null && raw.includes('"' + id + '"');
}

async function threadRow(cwd: string, id: string, roots: string[]) {
  const found = await readSummary(cwd, id);
  if (!found || (found.summary.num_chat_messages ?? 0) < 1) return null;
  const verified = await assertAllowed(cwd, roots).catch(() => null);
  if (!verified) return null;
  const active = await isGrokSessionActive(id).catch(() => false);
  return {
    id, cwd: verified, name: title(found.summary) || 'Grok 会话', preview: title(found.summary),
    modelProvider: 'grok', ephemeral: false, updatedAt: updatedSeconds(found.summary),
    status: { type: active ? 'active' : 'idle' },
    model: text(found.summary.current_model_id), effort: text(found.summary.reasoning_effort),
  };
}

export async function readGrokThread(id: string, cwd: string) {
  if (!sessionIdPattern.test(id)) return null;
  return threadRow(cwd, id, [cwd]);
}

/** Lists Grok sessions on disk. `cwd` narrows the scan to one project; otherwise every allowed root is scanned. */
export async function listGrokThreads(roots: string[], cursor: string | null, cwd?: string) {
  const base = grokSessionsDirectory();
  const decode = (name: string) => { try { return decodeURIComponent(name); } catch { return ''; } };
  const dirs = cwd
    ? [encodeURIComponent(cwd)]
    : (await readdir(base, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && decode(entry.name))
      .map((entry) => entry.name);
  const candidates: Array<{ dir: string; id: string; at: number }> = [];
  for (const dir of dirs) {
    const directory = resolve(base, dir);
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !sessionIdPattern.test(entry.name)) continue;
      const at = await stat(resolve(directory, entry.name)).catch(() => null);
      if (at) candidates.push({ dir, id: entry.name, at: at.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const after = cursor ? /^(\d+(?:\.\d+)?):([0-9a-f-]+)$/i.exec(cursor) : null;
  const offset = after ? candidates.findIndex((row) => row.at < Number(after[1]) || row.at === Number(after[1]) && row.id > after[2]) : 0;
  if (offset === -1) return { data: [], nextCursor: null };
  const page = candidates.slice(offset, offset + 30);
  const data = (await Promise.all(page
    .map(async ({ dir, id }) => threadRow(decode(dir), id, roots).catch(() => null))))
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const last = page.at(-1);
  return { data, nextCursor: last && offset + page.length < candidates.length ? `${last.at}:${last.id}` : null };
}

export function grokTurnStatus(reason: string) {
  return reason === 'end_turn' ? 'completed' : reason === 'cancelled' ? 'interrupted' : 'failed';
}

type TurnRow = { id: string; status: ReturnType<typeof grokTurnStatus>; items: Array<Record<string, unknown>> };

/** Tool state accumulated across a tool call's `tool_call` / `tool_call_update` rows. */
export type GrokToolState = {
  id: string;
  order: number;
  name?: string;
  kind?: string;
  title?: string;
  status?: 'completed' | 'failed' | 'inProgress';
  text?: string;
  diffs?: Array<{ path: string; oldText: string; newText: string }>;
  locations?: string[];
};

/**
 * Grok streams one tool call as several rows: `tool_call` carries the tool name in
 * `x.ai/tool` metadata, later `tool_call_update` rows carry the kind and title, and the
 * final row only carries `status` plus content — so classification must accumulate per
 * tool call instead of reading any single row.
 */
export function grokToolFeed(states: Map<string, GrokToolState>, update: Record<string, unknown>): GrokToolState | null {
  const id = text(update.toolCallId);
  if (!id) return null;
  const meta = asObject(asObject(update._meta)['x.ai/tool']);
  const state = states.get(id) ?? { id, order: states.size };
  const name = text(meta.name);
  if (name) state.name = name;
  const kind = text(update.kind) || text(meta.kind);
  if (kind) state.kind = kind;
  const title = text(update.title);
  if (title) state.title = title;
  if (update.status === 'completed' || update.status === 'failed') state.status = update.status;
  else if (!state.status) state.status = 'inProgress';
  const texts = items(update.content).flatMap((block) => block.type === 'content' ? [text(asObject(block.content).text)]
    : block.type === 'text' ? [text(block.text)] : []);
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

/** A unified-style patch for one edit, shaped for `harnessFileDiffs` counting. */
function grokPatch(change: { oldText: string; newText: string }) {
  const old = change.oldText ? change.oldText.split('\n') : [];
  const next = change.newText ? change.newText.split('\n') : [];
  return `@@ -1,${old.length} +1,${next.length} @@\n`
    + old.map((line) => '-' + line).join('\n') + (old.length ? '\n' : '')
    + next.map((line) => '+' + line).join('\n');
}

/** Coarse tool category the harness contract and approval UI share. */
export function grokToolCategory(state: Pick<GrokToolState, 'name' | 'kind'>) {
  if (state.kind === 'execute' || ['bash', 'run_terminal_command', 'run_terminal_cmd', 'sh'].includes(state.name ?? '')) return 'execute' as const;
  if (state.kind === 'edit' || state.kind === 'delete' || state.kind === 'move' || state.name === 'search_replace') return 'edit' as const;
  if (state.name === 'web_search') return 'search' as const;
  return (state.kind ?? 'other') as string;
}

/** Projects an accumulated tool state onto the Codex-shaped item the harness contract expects. */
export function grokToolItem(state: GrokToolState, completed: boolean): Record<string, unknown> | null {
  const name = state.name ?? state.title ?? 'tool';
  const kind = grokToolCategory(state);
  const status = completed ? state.status ?? 'completed' : 'inProgress';
  const base = { id: state.id, status };
  if (kind === 'execute') {
    return { ...base, type: 'commandExecution', command: state.title ?? name,
      ...(completed && state.text ? { aggregatedOutput: state.text } : {}) };
  }
  if (kind === 'edit') {
    return { ...base, type: 'fileChange',
      changes: state.diffs?.length ? state.diffs.slice(0, 8).map((change) => ({
        path: change.path, diff: grokPatch(change), kind: { type: change.oldText ? 'update' : 'add' },
      })) : (state.locations ?? []).map((path) => ({ path })) };
  }
  if (kind === 'search' && name === 'web_search') {
    return { ...base, type: 'webSearch', query: state.title ?? name };
  }
  return { ...base, type: 'dynamicToolCall', tool: name, ...(completed && state.text ? { output: state.text } : {}) };
}

/** Projects `updates.jsonl` — Grok's authoritative ACP update stream — into Codex-shaped turn rows. */
export async function readGrokTurns(id: string, cwd: string, cursor: string | null, limit: number) {
  const summary = await readSummary(cwd, id);
  if (!summary) return { data: [] as TurnRow[], nextCursor: null };
  const path = resolve(summary.path, 'updates.jsonl');
  if (!(await stat(path).catch(() => null))?.isFile()) return { data: [], nextCursor: null };
  if ((await stat(path)).size > 64 * 1024 * 1024) throw new CodexRejected('这条 Grok 历史过大，请在本机查看');

  const turns: TurnRow[] = [];
  let current: TurnRow | undefined;
  let currentPrompt = '';
  let turnNumber = 0;
  let tools = new Map<string, GrokToolState>();
  let messageRun: { id: string; text: string; thought: boolean } | undefined;
  let foundCursor = !cursor;

  const closeRun = (final: boolean) => {
    if (!current || !messageRun) return;
    const phase = messageRun.thought || !final ? 'commentary' : 'final_answer';
    const item = { id: messageRun.id, type: 'agentMessage', text: messageRun.text.slice(0, HARNESS_TEXT_LIMIT), phase };
    const index = current.items.findIndex((existing) => existing.id === item.id);
    if (index === -1) current.items.push(item); else current.items[index] = item;
    messageRun = undefined;
  };

  const rows = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rows) {
      let row: Record<string, unknown>;
      try { row = asObject(JSON.parse(line)); } catch { continue; }
      if (row.method !== 'session/update' && row.method !== '_x.ai/session/update') continue;
      const params = asObject(row.params);
      if (params.sessionId !== id) continue;
      const update = asObject(params.update);
      const kind = update.sessionUpdate;
      if (row.method === '_x.ai/session/update' && kind !== 'turn_completed') continue;
      const meta = asObject(update._meta);
      const promptId = text(meta.promptId);
      if (kind === 'user_message_chunk') {
        closeRun(true);
        const body = text(asObject(update.content).text).trim();
        if (!body) continue;
        currentPrompt = promptId;
        turnNumber++;
        const turnId = promptId || `grok-turn-${turnNumber}`;
        if (turnId === cursor) { foundCursor = true; break; }
        current = { id: turnId, status: 'interrupted', items: [
          { id: turnId + ':user', type: 'userMessage', content: [{ type: 'text', text: body.slice(0, HARNESS_TEXT_LIMIT) }] },
        ] };
        tools = new Map();
        turns.push(current);
        if (turns.length > limit + 1) turns.shift();
      } else if (!current) {
        continue;
      } else if (kind === 'turn_completed') {
        const finishedPrompt = text(update.prompt_id) || promptId;
        const reason = text(update.stop_reason);
        // Some native logs only supply the prompt id on their terminal row.
        if (reason && (!finishedPrompt || !currentPrompt || finishedPrompt === currentPrompt)) {
          current.status = grokTurnStatus(reason);
          closeRun(current.status === 'completed');
          current = undefined;
        }
      } else if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
        const chunk = text(asObject(update.content).text);
        if (!chunk) continue;
        const thought = kind === 'agent_thought_chunk';
        if (!messageRun || messageRun.thought !== thought) {
          closeRun(false);
          messageRun = { id: `${current.id}:${thought ? 'thought' : 'answer'}:${current.items.length}`, text: '', thought };
        }
        messageRun.text += chunk;
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        closeRun(false);
        const state = grokToolFeed(tools, update);
        if (!state) continue;
        const completed = state.status === 'completed' || state.status === 'failed';
        const item = grokToolItem(state, completed);
        if (item) {
          const index = current.items.findIndex((existing) => existing.id === item.id);
          if (index === -1) current.items.push(item); else current.items[index] = item;
        }
      } else if (kind === 'plan') {
        closeRun(false);
        const body = items(update.entries).map((entry) => text(asObject(entry.content).text)).filter(Boolean).join('\n');
        if (body) current.items.push({ id: `${current.id}:plan`, type: 'plan', text: body.slice(0, HARNESS_TEXT_LIMIT) });
      }
    }
  } finally {
    rows.close();
  }
  closeRun(true);
  if (!foundCursor) throw new CodexRejected('历史页已变化，请从最新一页重新读取');
  const data = turns.reverse().slice(0, limit);
  return { data, nextCursor: turns.length > limit ? data.at(-1)?.id ?? null : null };
}
