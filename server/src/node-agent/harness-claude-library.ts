import { createReadStream } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { assertAllowed } from './git.js';
import { asObject, CodexRejected } from './harness-codex.js';
import { codexItems as items, codexText as text } from './harness-history.js';
import { HARNESS_TEXT_LIMIT } from './harness-protocol.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const transcriptDirectory = () => resolve(process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), '.claude'), 'projects');
const projectKey = (cwd: string) => cwd.replace(/[^a-zA-Z0-9-]/g, '-');

async function* transcript(path: string, prefix = false) {
  const input = createReadStream(path, { encoding: 'utf8', ...(prefix ? { end: 128 * 1024 } : {}) });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row: Record<string, unknown>;
      try { row = asObject(JSON.parse(line)); } catch { continue; }
      if (!row.isSidechain) yield row;
    }
  } finally { lines.close(); input.destroy(); }
}

function content(value: unknown) {
  return typeof value === 'string' ? value : items(value).filter((entry) => entry.type === 'text').map((entry) => text(entry.text)).join('\n');
}

async function thread(path: string, id: string, roots: string[]) {
  const at = await lstat(path).catch(() => null);
  if (!at?.isFile()) return null;
  const verified = await assertAllowed(path, [transcriptDirectory()]).catch(() => null);
  if (!verified) return null;
  for await (const row of transcript(verified, true)) {
    if (row.type !== 'user' || row.sessionId !== id || typeof row.cwd !== 'string') continue;
    const cwd = await assertAllowed(row.cwd, roots).catch(() => null);
    if (!cwd) return null;
    const prompt = content(asObject(row.message).content).replace(/\s+/g, ' ').trim().slice(0, 160);
    if (prompt) return { id, name: prompt, cwd, path: verified, modelProvider: 'claude', updatedAt: Math.floor(at.mtimeMs / 1000), status: { type: 'notLoaded' } };
  }
  return null;
}

export async function readClaudeThread(id: string, cwd: string) {
  if (!uuid.test(id)) return null;
  return thread(resolve(transcriptDirectory(), projectKey(cwd), id + '.jsonl'), id, [cwd]);
}

export async function listClaudeThreads(roots: string[], cursor: string | null, cwd?: string) {
  const base = transcriptDirectory();
  const dirs = cwd ? [projectKey(cwd)] : (await readdir(base, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const candidates = [];
  for (const dir of dirs) {
    const directory = resolve(base, dir);
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const id = basename(entry.name, '.jsonl');
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !uuid.test(id)) continue;
      const path = resolve(directory, entry.name);
      const at = await stat(path).catch(() => null);
      if (at) candidates.push({ path, id, at: at.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const after = cursor ? /^(\d+(?:\.\d+)?):([0-9a-f-]+)$/i.exec(cursor) : null;
  const offset = after ? candidates.findIndex((row) => row.at < Number(after[1]) || row.at === Number(after[1]) && row.id > after[2]) : 0;
  if (offset === -1) return { data: [], nextCursor: null };
  const page = candidates.slice(offset, offset + 30);
  const data = await Promise.all(page
    .map(async ({ path, id }) => thread(path, id, roots).catch(() => null)));
  const last = page.at(-1);
  return { data: data.filter((row): row is NonNullable<typeof row> => row !== null),
    nextCursor: last && offset + page.length < candidates.length ? `${last.at}:${last.id}` : null };
}

export async function readClaudeTurns(id: string, cwd: string, cursor: string | null, limit: number) {
  const summary = await readClaudeThread(id, cwd);
  if (!summary) return { data: [], nextCursor: null };
  if ((await stat(summary.path)).size > 64 * 1024 * 1024) throw new CodexRejected('这条 Claude Code 历史过大，请在本机查看');
  const turns: Array<{ id: string; status: 'completed' | 'interrupted'; items: Array<Record<string, unknown>> }> = [];
  let current: typeof turns[number] | undefined;
  let foundCursor = !cursor;
  for await (const row of transcript(summary.path)) {
    const message = asObject(row.message);
    const key = text(row.uuid);
    const body = content(message.content).slice(0, HARNESS_TEXT_LIMIT);
    if (row.sessionId !== id || !key || !body) continue;
    if (row.type === 'user' && !row.isMeta && !row.toolUseResult) {
      if (key === cursor) { foundCursor = true; break; }
      current = { id: key, status: 'interrupted', items: [{ id: key, clientId: key, type: 'userMessage', content: [{ type: 'text', text: body }] }] };
      turns.push(current);
      if (turns.length > limit + 1) turns.shift();
    } else if (row.type === 'assistant' && current) {
      current.status = 'completed';
      const part = { id: text(message.id) || key, type: 'agentMessage', text: body };
      const index = current.items.findIndex((item) => item.id === part.id);
      if (index === -1) current.items.push(part); else current.items[index] = part;
    }
  }
  if (!foundCursor) throw new CodexRejected('历史页已变化，请从最新一页重新读取');
  const data = turns.reverse().slice(0, limit);
  return { data, nextCursor: turns.length > limit ? data.at(-1)?.id ?? null : null };
}
