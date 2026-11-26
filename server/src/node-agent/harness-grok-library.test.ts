import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readHarnessLibrary } from './harness-library.js';
import { grokSessionExists, isGrokSessionActive, listGrokThreads, readGrokTurns } from './harness-grok-library.js';

const threadId = '01a21348-ae50-7260-9166-0480e752ad35';
const otherId = '01a21349-9c9a-7902-8d0d-b02d7d35ff3c';
const update = (sessionUpdate: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ timestamp: 1792645223, method: 'session/update', params: { sessionId: threadId, update: { sessionUpdate, ...extra } } });
const row = (line: string) => line + '\n';

async function grokHome() {
  const temporary = await mkdtemp(join(tmpdir(), 'dovun-grok-lib-'));
  const home = join(await realpath(temporary), 'grok-home');
  const project = join(await realpath(temporary), 'project');
  const foreign = join(await realpath(temporary), 'foreign');
  await Promise.all([mkdir(project), mkdir(foreign)]);
  const summary = (id: string, cwd: string, messages: number) => JSON.stringify({
    info: { id, cwd }, session_summary: `Summary ${id.slice(0, 8)}`, generated_title: `Title ${id.slice(0, 8)}`,
    created_at: '2026-11-20T05:00:15.615854Z', updated_at: '2026-11-22T08:30:54.750028Z',
    num_chat_messages: messages, current_model_id: 'grok-4.6', reasoning_effort: 'high',
  });
  const history = [
    update('hook_execution', { event_name: 'session_start' }).replace('session/update', '_x.ai/session/update'),
    update('user_message_chunk', { content: { type: 'text', text: 'Look at this project' }, _meta: { promptId: 'p-1' } }),
    update('agent_thought_chunk', { content: { type: 'text', text: 'Browsing the tree.' } }),
    update('agent_message_chunk', { content: { type: 'text', text: 'I will inspect the files.' } }),
    update('tool_call', { toolCallId: 'tc-1', title: 'bash', rawInput: { command: 'ls -la' }, _meta: { 'x.ai/tool': { name: 'bash' } } }),
    update('tool_call_update', { toolCallId: 'tc-1', kind: 'execute', title: 'Run `ls -la`', content: [{ type: 'content', content: { type: 'text', text: 'Listing files' } }] }),
    update('tool_call_update', { toolCallId: 'tc-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'README.md' } }] }),
    update('tool_call', { toolCallId: 'tc-2', title: 'search_replace', rawInput: {}, _meta: { 'x.ai/tool': { name: 'search_replace' } } }),
    update('tool_call_update', { toolCallId: 'tc-2', kind: 'edit', title: 'Edit `src/a.ts`',
      content: [{ type: 'diff', path: join(project, 'src/a.ts'), oldText: 'old', newText: 'new' }], locations: [{ path: join(project, 'src/a.ts') }] }),
    update('tool_call_update', { toolCallId: 'tc-2', status: 'completed', content: [{ type: 'diff', path: join(project, 'src/a.ts'), oldText: 'old', newText: 'new' }] }),
    update('tool_call', { toolCallId: 'tc-3', title: 'web_search', rawInput: { query: 'docs' }, _meta: { 'x.ai/tool': { name: 'web_search' } } }),
    update('tool_call_update', { toolCallId: 'tc-3', kind: 'search', title: 'web_search for docs', status: 'completed', content: [] }),
    update('plan', { entries: [{ content: { type: 'text', text: 'Step one' }, state: 'pending' }, { content: { type: 'text', text: 'Step two' }, state: 'completed' }] }),
    update('user_message_chunk', { content: { type: 'text', text: 'Second question' }, _meta: { promptId: 'p-2' } }),
    update('agent_message_chunk', { content: { type: 'text', text: 'Second answer.' }, _meta: { promptId: 'p-2' } }),
    update('turn_completed', { prompt_id: 'p-2', stop_reason: 'end_turn' }).replace('"session/update"', '"_x.ai/session/update"'),
  ];
  const session = (cwd: string, id: string, messages: number, updates?: string[]) => {
    const directory = join(home, 'sessions', encodeURIComponent(cwd), id);
    return Promise.all([
      mkdir(directory, { recursive: true }),
    ]).then(async () => Promise.all([
      writeFile(join(directory, 'summary.json'), summary(id, cwd, messages)),
      updates ? writeFile(join(directory, 'updates.jsonl'), updates.map(row).join('')) : undefined,
    ]));
  };
  await Promise.all([
    session(project, threadId, 2, history),
    session(project, otherId, 0),
    session(foreign, '01a21349-5999-7292-a01a-baf9e9a18e59', 5),
  ]);
  return { home, project, foreign, temporary };
}

it('lists only real Grok sessions inside allowed roots, sorted with a stable cursor', async () => {
  const setup = await grokHome();
  try {
    vi.stubEnv('GROK_HOME', setup.home);
    const page = await listGrokThreads([setup.project], null);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ id: threadId, cwd: setup.project, name: 'Title 01a21348' });
    expect(await isGrokSessionActive(threadId)).toBe(false);
    const catalog = await readHarnessLibrary({ kind: 'catalog', id: 'read', cwd: setup.project, harness: 'grok', cursor: null }, [setup.project]);
    if (!('threads' in catalog) || !catalog.threads) throw new Error('expected a catalog page');
    expect(catalog.threads.map((thread) => thread.threadId)).toEqual([threadId]);
    const index = await readHarnessLibrary({ kind: 'index', id: 'read', harness: 'grok', cursor: null }, [setup.project]);
    if (!('threads' in index) || !index.threads) throw new Error('expected an index page');
    expect(index.threads.map((thread) => thread.threadId)).toEqual([threadId]);
    expect(index.threads[0]).toMatchObject({ cwd: setup.project, title: 'Title 01a21348' });
  } finally {
    vi.unstubAllEnvs();
    await rm(setup.temporary, { recursive: true, force: true });
  }
});

it('uses the native Grok stop reason even when an interrupted or failed turn produced text', async () => {
  const setup = await grokHome();
  try {
    vi.stubEnv('GROK_HOME', setup.home);
    const path = join(setup.home, 'sessions', encodeURIComponent(setup.project), threadId, 'updates.jsonl');
    const prompts = ['end_turn', 'cancelled', 'error', 'missing'];
    await writeFile(path, prompts.flatMap((reason) => [
      update('user_message_chunk', { content: { type: 'text', text: reason },
        ...(reason === 'cancelled' ? {} : { _meta: { promptId: reason } }) }),
      update('agent_thought_chunk', { content: { type: 'text', text: 'thinking' } }),
      ...(reason === 'missing' ? [] : [
        update('agent_message_chunk', { content: { type: 'text', text: 'reply' } }),
        update('turn_completed', { prompt_id: reason, stop_reason: reason }).replace('"session/update"', '"_x.ai/session/update"'),
      ]),
    ]).map(row).join(''));
    const history = await readGrokTurns(threadId, setup.project, null, 5);
    expect(history.data.map(({ id, status }) => [id, status])).toEqual([
      ['missing', 'interrupted'], ['error', 'failed'], ['grok-turn-2', 'interrupted'], ['end_turn', 'completed'],
    ]);
  } finally {
    vi.unstubAllEnvs();
    await rm(setup.temporary, { recursive: true, force: true });
  }
});

it('projects Grok history into the shared turn view with tools, diffs and plans', async () => {
  const setup = await grokHome();
  try {
    vi.stubEnv('GROK_HOME', setup.home);
    const page = await readHarnessLibrary({ kind: 'history', id: 'read', cwd: setup.project, threadId, harness: 'grok', cursor: null }, [setup.project]);
    if (!('view' in page)) throw new Error('expected a history page');
    expect(page.view.turn).toBeNull();
    expect(page.view.messages.map((message) => [message.role, message.phase ?? ''])).toEqual([
      ['user', ''], ['assistant', 'commentary'], ['assistant', 'commentary'], ['user', ''], ['assistant', 'final_answer'],
    ]);
    expect(page.view.messages[0]).toMatchObject({ text: 'Look at this project', role: 'user' });
    expect(page.view.messages[2]).toMatchObject({ text: 'I will inspect the files.' });
    const tools = page.view.tools ?? [];
    expect(tools).toHaveLength(3);
    expect(tools.find((tool) => tool.id === 'tc-1')).toMatchObject({ kind: 'command', title: 'Run `ls -la`', status: 'completed', output: 'README.md' });
    const edit = tools.find((tool) => tool.id === 'tc-2');
    expect(edit).toMatchObject({ kind: 'fileChange', files: [join(setup.project, 'src/a.ts')] });
    expect(edit?.diffs?.[0]).toMatchObject({ path: join(setup.project, 'src/a.ts'), added: 1, removed: 1 });
    expect(tools.find((tool) => tool.id === 'tc-3')).toMatchObject({ kind: 'webSearch', title: 'web_search for docs' });
    expect(page.view.plan).toMatchObject({ text: 'Step one\nStep two', steps: [] });
    expect(page.view.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Second answer.' });

    const first = await readHarnessLibrary({ kind: 'history', id: 'read', cwd: setup.project, threadId, harness: 'grok', cursor: null }, [setup.project]);
    if (!('view' in first)) throw new Error('expected a history page');
    expect(first.view.messages.map((message) => message.id)).toContain('p-1:user');
    const next = await readHarnessLibrary({ kind: 'history', id: 'read', cwd: setup.project, threadId, harness: 'grok', cursor: 'p-2' }, [setup.project]);
    if (!('view' in next)) throw new Error('expected a history page');
    expect(next.view.messages.map((message) => message.text)).toEqual(['Look at this project', 'Browsing the tree.', 'I will inspect the files.']);
    await expect(readHarnessLibrary({ kind: 'history', id: 'read', cwd: setup.project, threadId, harness: 'grok', cursor: 'missing-turn' }, [setup.project]))
      .rejects.toThrow('历史页已变化，请从最新一页重新读取');
  } finally {
    vi.unstubAllEnvs();
    await rm(setup.temporary, { recursive: true, force: true });
  }
});

it('accepts fresh sessions without messages for resume, rejects sessions in other projects', async () => {
  const setup = await grokHome();
  try {
    vi.stubEnv('GROK_HOME', setup.home);
    expect(await grokSessionExists(setup.project, otherId)).toBe(true);
    expect(await grokSessionExists(setup.project, 'not-a-session')).toBe(false);
    expect(await grokSessionExists(setup.foreign, threadId)).toBe(false);
    await expect(readHarnessLibrary({ kind: 'thread', id: 'read', cwd: setup.project, threadId: '01a21349-5999-7292-a01a-baf9e9a18e59', harness: 'grok' }, [setup.project]))
      .rejects.toThrow('这条对话不在所选项目目录中');
  } finally {
    vi.unstubAllEnvs();
    await rm(setup.temporary, { recursive: true, force: true });
  }
});
