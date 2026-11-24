import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readHarnessLibrary } from './harness-library.js';

it('projects the latest Claude Code tag and its explicit removal without changing thread identity', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dovun-claude-tags-'));
  try {
    const config = join(await realpath(temporary), 'claude');
    const cwd = join(await realpath(temporary), 'project');
    const directory = join(config, 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', config);
    await Promise.all([mkdir(cwd), mkdir(directory, { recursive: true })]);
    const threadId = '2b9b642c-df99-47ed-86e6-8cbd19036eb7';
    const history = [
      { type: 'user', sessionId: threadId, cwd, message: { content: 'Starting point' } },
      { type: 'tag', sessionId: threadId, tag: 'Older tag' },
      { type: 'assistant', sessionId: threadId, message: { content: 'x'.repeat(140 * 1024) } },
      { type: 'tag', sessionId: threadId, tag: 'Current tag' },
      { type: 'tag', sessionId: 'unrelated-session', tag: 'Unrelated' },
    ];
    const transcript = join(directory, threadId + '.jsonl');
    const save = async () => writeFile(transcript, history.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const read = (organization?: true) => readHarnessLibrary({ kind: 'thread', id: 'read', harness: 'claude', threadId, cwd, organization }, [cwd]);
    await save();
    expect(await read(true)).toMatchObject({ threadId, organization: { tag: 'Current tag' } });
    expect(await read()).toMatchObject({ threadId, organization: undefined });
    history.push({ type: 'tag', sessionId: threadId, tag: '' });
    await save();
    expect(await read(true)).toMatchObject({ threadId, organization: { tag: null } });
  } finally {
    vi.unstubAllEnvs();
    await rm(temporary, { recursive: true, force: true });
  }
});
