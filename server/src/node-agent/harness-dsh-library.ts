import { execFile } from 'node:child_process';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertAllowed } from './git.js';
import { asObject, CodexRejected } from './harness-codex.js';
import { codexItems, codexText, projectCodexHistory } from './harness-history.js';
import { dshProjectionDir, dshSessionsDir } from './harness-dsh-client.js';
import { decodeFirstZstdFrame, decodeZstd } from './harness-dsh-zstd.js';
import type { HarnessCatalogThread, HarnessReadTask, HarnessView } from './harness-protocol.js';

const exec = promisify(execFile);
// The first frame holds the header line alone, so this is enough to read a session's identity without decoding its log.
const HEADER_BYTES = 65_536;
const PAGE = 30;
const CACHED_SESSIONS = 6;
const INDEX_MEMO_MS = 5_000;

type DshLibraryPage =
  | { threads: Array<HarnessCatalogThread & { cwd: string; name: string }>; nextCursor: string | null }
  | { threads: HarnessCatalogThread[]; nextCursor: string | null }
  | HarnessCatalogThread
  | { view: HarnessView; nextCursor: string | null };
type Row = Record<string, unknown>;
type TurnDraft = { id: string; status: string; items: Row[] };
type DshThread = HarnessCatalogThread & { id: string; directory: string; file: string; cwd: string };

/** dsh names each project directory after its path. The mapping is lossy, so the header's cwd still decides membership. */
export function dshProjectKey(cwd: string) {
  let readable = '';
  let separator = false;
  for (let index = 0; index < cwd.length; index++) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === '/' || character === '\\' || character === ':') {
      if (!separator) readable += '-';
      separator = true;
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character;
      separator = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separator = false;
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

/** DSH tools map onto the shared Codex item shapes the executor already projects. */
export function dshToolKind(name: string, input: Row, cwd = ''): Row | null {
  const first = (...values: string[]) => values.find((value) => value) ?? '';
  const path = first(codexText(input.file_path), codexText(input.path));
  // File links are resolved inside the session's project, so an absolute path under it becomes relative.
  const inside = (value: string) => isAbsolute(value) && resolve(value).startsWith(resolve(cwd) + '/') ? relative(cwd, value) : value;
  if (name === 'bash') return { type: 'commandExecution', command: codexText(input.command).slice(0, 1_000) };
  if (name === 'write' || name === 'edit' || name === 'apply_patch' || name === 'str_replace_editor') {
    return { type: 'fileChange', changes: path ? [{ path: inside(path).slice(0, 600) }] : [] };
  }
  if (name === 'web_search') return { type: 'webSearch', query: codexItems(input.queries).map((query) => codexText(query)).join(' ').slice(0, 1_000) };
  const brief = first(inside(path), codexText(input.url), codexText(input.pattern));
  return { type: 'dynamicToolCall', tool: (brief ? `${name} ${brief}` : name || 'tool').slice(0, 1_000) };
}

async function logFile(directory: string) {
  let names: string[];
  try { names = await readdir(directory); } catch { return null; }
  const versions = names.flatMap((name) => {
    const match = /^session\.v(\d+)\.jsonl\.zstd$/.exec(name);
    return match ? [{ name, version: Number(match[1]) }] : [];
  }).sort((left, right) => right.version - left.version);
  // Generation 0 has no version in its name; a migrated session keeps both files and reads the newest.
  const name = versions[0]?.name ?? (names.includes('session.jsonl.zstd') ? 'session.jsonl.zstd' : null);
  return name ? join(directory, name) : null;
}

async function headerOf(file: string) {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = asObject(JSON.parse(decodeFirstZstdFrame(buffer.subarray(0, bytesRead)).toString('utf8').split('\n', 1)[0] ?? 'null'));
    return header.type === 'session' && codexText(header.id) ? header : null;
  } catch { return null; } finally { await handle.close(); }
}

type Projection = { title: string; updatedAt: number; preset: string };
async function projection(id: string): Promise<Projection> {
  try {
    const rows = asObject(asObject(asObject(JSON.parse(await readFile(join(dshProjectionDir(), `${id}.json`), 'utf8'))).record).rows);
    const metadata = asObject(asObject(rows.sessionListMetadata).val);
    return {
      title: codexText(asObject(rows.title).val).replace(/\s+/g, ' ').trim(),
      updatedAt: typeof metadata.lastPromptAt === 'number' && Number.isFinite(metadata.lastPromptAt) && metadata.lastPromptAt > 0 ? metadata.lastPromptAt : 0,
      preset: codexText(asObject(asObject(rows.permissions).val).preset),
    };
  } catch { return { title: '', updatedAt: 0, preset: '' }; }
}

/** The preset a session last recorded, read from the cache dsh maintains even when no process holds the session. */
export async function dshRecordedPreset(threadId: string) {
  return (await projection(threadId)).preset;
}

async function threadOf(id: string, directory: string, file: string): Promise<DshThread | null> {
  const header = await headerOf(file);
  // Subagent sessions are owned by their parent and cannot be resumed on their own.
  if (!header || header.origin === 'subagent' || header.id !== id) return null;
  const cached = await projection(id);
  const modified = (await stat(file).catch(() => null))?.mtimeMs;
  const time = cached.updatedAt || (typeof header.createdAt === 'number' ? header.createdAt : 0) || modified || Date.now();
  return {
    id, directory, file, cwd: codexText(header.cwd),
    threadId: id, title: (cached.title || '未命名会话').slice(0, 160), updatedAt: new Date(time).toISOString(),
  };
}

async function sessionsIn(project: string) {
  const directories = (await readdir(project, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory()).map((entry) => join(project, entry.name));
  // Every session costs a few small reads, so they are read side by side instead of one after another.
  const threads = await pooled(directories, 16, async (directory) => {
    const file = await logFile(directory);
    return file ? threadOf(basename(directory), directory, file).catch(() => null) : null;
  });
  return threads.filter((thread): thread is DshThread => thread !== null && Boolean(thread.cwd));
}

async function allSessions() {
  const root = dshSessionsDir();
  const projects = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  const groups = await pooled(projects, 8, sessionsIn);
  return groups.flat();
}

const newest = (left: DshThread, right: DshThread) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);

async function pooled<T, R>(items: T[], limit: number, action: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await action(items[index]);
    }
  }));
  return results;
}

// A session created through a symlinked path is keyed by that path, so membership follows the real directory.
async function within(threads: DshThread[], roots: string[]) {
  const allowed = await pooled(threads, 16, async (thread) => ({ thread, cwd: await assertAllowed(thread.cwd, roots).catch(() => null) }));
  return allowed.flatMap(({ thread, cwd }) => cwd ? [{ ...thread, cwd }] : []).sort(newest);
}

let indexMemo: { roots: string; at: number; threads: DshThread[] } | null = null;

async function allowedIndex(roots: string[]) {
  const key = roots.join('\n');
  if (indexMemo && indexMemo.roots === key && Date.now() - indexMemo.at < INDEX_MEMO_MS) return indexMemo.threads;
  indexMemo = { roots: key, at: Date.now(), threads: await within(await allSessions(), roots) };
  return indexMemo.threads;
}

function pageOf(threads: DshThread[], cursor: string | null) {
  // The cursor names the last thread of the page above. A cursor that no longer matches ends the listing.
  if (!cursor) return { page: threads.slice(0, PAGE), nextCursor: threads.length > PAGE ? threads[PAGE - 1].id : null };
  const anchor = threads.findIndex((thread) => thread.id === cursor);
  const rest = anchor === -1 ? [] : threads.slice(anchor + 1);
  return { page: rest.slice(0, PAGE), nextCursor: rest.length > PAGE ? rest[PAGE - 1].id : null };
}

const summary = ({ threadId, title, updatedAt }: DshThread): HarnessCatalogThread => ({ threadId, title, updatedAt });

async function locate(threadId: string, cwd: string) {
  const root = dshSessionsDir();
  for (const project of [join(root, dshProjectKey(cwd)), ...(await readdir(root).catch(() => [])).map((name) => join(root, name))]) {
    const directory = join(project, threadId);
    const file = await logFile(directory);
    if (file) return { directory, file };
  }
  return null;
}

/** Another Mac process reports an open session by holding its lock file; readers never touch the lock. */
async function lockHeld(directory: string) {
  if (process.platform !== 'darwin') return false;
  const { stdout } = await exec('/usr/sbin/lsof', ['-w', '-Fa', '--', join(directory, 'session.lock')],
    { timeout: 2_000, maxBuffer: 32_768 }).catch(() => ({ stdout: '' }));
  return stdout.split('\n').some((field) => field === 'aw' || field === 'au');
}

const textOf = (value: unknown, limit: number) => codexItems(value).filter((part) => part.type === 'text').map((part) => codexText(part.text)).join('').slice(0, limit);

function outputOf(message: Row) {
  const texts: string[] = [];
  let failed = false;
  for (const part of codexItems(message.content)) {
    if (part.isError === true) failed = true;
    const content = part.content;
    if (Array.isArray(content)) for (const piece of codexItems(content)) texts.push(codexText(piece.text));
    else texts.push(codexText(asObject(content).text) || codexText(part.text));
  }
  return { text: texts.join('\n').slice(0, 16_000), failed };
}

// A turn the user stopped is recorded as `aborted`; it did not run to its end, so it never reads as completed.
const statusOf = (kind: unknown) => kind === 'error' || kind === 'blocked' ? 'failed'
  : kind === 'interrupted' || kind === 'aborted' ? 'interrupted' : 'completed';

function argumentsOf(value: unknown) {
  try { return asObject(typeof value === 'string' ? JSON.parse(value) : value); } catch { return {}; }
}

/** Dovun groups a conversation by user message; dsh records each real prompt separately from injected context. */
export function dshTurns(records: Row[], busy: boolean, cwd = ''): TurnDraft[] {
  const turns: TurnDraft[] = [];
  for (const record of records) {
    const data = asObject(record.data);
    if (record.type === 'user/message' && asObject(data.source).kind === 'user') {
      const id = codexText(data.id) || `turn-${turns.length + 1}`;
      // A prompt that arrives before the previous turn ended means that turn never settled.
      const previous = turns.at(-1);
      if (previous?.status === 'inProgress') previous.status = 'interrupted';
      turns.push({ id, status: 'inProgress', items: [{ id, type: 'userMessage', content: [{ type: 'text', text: textOf(data.content, 24_000) }] }] });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn || turn.status !== 'inProgress') continue;
    const message = asObject(data.message);
    if (record.type === 'assistant/message') {
      const blocks = codexItems(message.content);
      turn.items.push(...blocks.flatMap((block, index): Row[] => block.type === 'text'
        ? [{ id: `${codexText(message.id) || `${turns.length}-${codexText(data.step)}`}#${index}`, type: 'agentMessage',
          text: codexText(block.text).slice(0, 24_000),
          phase: blocks.some((other) => other.type === 'tool-call') ? 'commentary' : 'final_answer' }] : []));
    } else if (record.type === 'tool/call') {
      const kind = dshToolKind(codexText(data.name), argumentsOf(data.arguments), cwd);
      if (kind && codexText(data.callId)) turn.items.push({ id: codexText(data.callId), ...kind });
    } else if (record.type === 'tool/result') {
      // The settled result replaces its call in place, so one tool stays one item.
      const index = turn.items.findIndex((item) => item.id === codexText(asObject(message.source).callId));
      if (index === -1) continue;
      const output = outputOf(message);
      turn.items[index] = { ...turn.items[index], status: output.failed || data.error !== undefined ? 'failed' : 'completed',
        aggregatedOutput: output.text };
    } else if (record.type === 'turn/end') {
      turn.status = statusOf(asObject(data.reason).kind);
    }
  }
  const last = turns.at(-1);
  if (last?.status === 'inProgress' && !busy) last.status = 'interrupted';
  return turns;
}

const cache = new Map<string, { stamp: string; turns: TurnDraft[] }>();

/** Reads a session's own log. Pages are turn slices from the newest end, so the cursor is the oldest turn's position. */
export async function readDshTurns(threadId: string, cwd: string, cursor: string | null, limit: number) {
  const found = await locate(threadId, cwd);
  if (!found) throw new CodexRejected('找不到 DSH 原会话，无法恢复');
  const info = await stat(found.file);
  const stamp = `${info.mtimeMs}:${info.size}`;
  let entry = cache.get(threadId);
  if (!entry || entry.stamp !== stamp) {
    const rows = decodeZstd(await readFile(found.file)).toString('utf8').split('\n').flatMap((line) => {
      try { return [asObject(JSON.parse(line))]; } catch { return []; }
    });
    entry = { stamp, turns: dshTurns(rows, await lockHeld(found.directory).catch(() => false), cwd) };
    cache.set(threadId, entry);
    for (const key of cache.keys()) if (cache.size > CACHED_SESSIONS) cache.delete(key);
  }
  const end = cursor ? Number(cursor) : entry.turns.length;
  if (!Number.isInteger(end) || end < 0 || end > entry.turns.length) throw new CodexRejected('历史页已变化，请从最新一页重新读取');
  const start = Math.max(0, end - limit);
  return { data: entry.turns.slice(start, end).reverse(), nextCursor: start > 0 ? String(start) : null };
}

export async function readDshLibrary(task: Exclude<HarnessReadTask, { kind: 'files' }>, roots: string[]): Promise<DshLibraryPage> {
  if (task.kind === 'index') {
    const { page, nextCursor } = pageOf(await allowedIndex(roots), task.cursor);
    return { threads: page.map((thread) => ({ ...summary(thread), cwd: thread.cwd, name: (basename(thread.cwd) || thread.cwd).slice(0, 255) })), nextCursor };
  }
  const cwd = await assertAllowed(task.cwd, roots);
  if (task.kind === 'catalog') {
    // The native key follows the path a session was created with, which may differ from the real one, so the
    // index that already resolved every session's real directory is the source here as well.
    const { page, nextCursor } = pageOf((await allowedIndex(roots)).filter((thread) => thread.cwd === cwd), task.cursor);
    return { threads: page.map(summary), nextCursor };
  }
  const found = await locate(task.threadId, cwd);
  if (!found) throw new CodexRejected('这条对话不在所选项目目录中');
  const thread = await threadOf(task.threadId, found.directory, found.file);
  if (!thread || await assertAllowed(thread.cwd, roots).catch(() => null) !== cwd) throw new CodexRejected('这条对话不在所选项目目录中');
  if (task.kind === 'thread') return summary(thread);
  // Use a smaller page when the full one would exceed what the server accepts in one read.
  for (let limit = 12; limit >= 1; limit = Math.floor(limit / 2)) {
    const page = await readDshTurns(task.threadId, cwd, task.cursor, limit);
    const { view } = await projectCodexHistory(page.data, cwd, roots, false, false, undefined, 'dsh');
    const result = { view, nextCursor: page.nextCursor };
    if (Buffer.byteLength(JSON.stringify(result)) <= 6_000_000) return result;
  }
  throw new CodexRejected('这轮历史超出一次读取的大小，请在 DSH 中查看');
}
