import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readHarnessArtifacts } from './harness-artifacts.js';
import { applyHarnessEvent, HARNESS_OUTPUT_LIMIT, legacyHarnessEvent, legacyHarnessSnapshot, type HarnessView } from './harness-protocol.js';
import { codexHarnessTool, harnessOutput } from './harness-tools.js';

it('updates a single command row, keeps its order and bounds the live and final output', () => {
  let view: HarnessView = { messages: [], turn: null, approvals: [], error: null };
  const turnId = 'turn';
  const id = 'command';
  const started = { type: 'commandExecution', id, command: 'fixture', status: 'inProgress' };
  view = applyHarnessEvent(view, { kind: 'message', message: { id: 'intro', turnId, role: 'assistant', text: '开始', phase: 'commentary' } });
  view = applyHarnessEvent(view, { kind: 'tool', tool: codexHarnessTool(started, turnId, false)! });
  view = applyHarnessEvent(view, { kind: 'toolOutput', turnId, id, delta: 'a'.repeat(HARNESS_OUTPUT_LIMIT) });
  view = applyHarnessEvent(view, { kind: 'toolOutput', turnId, id, delta: 'live tail' });
  expect(view.tools).toMatchObject([{ id, order: 2, status: 'running', truncated: true }]);
  expect(view.tools?.[0]?.output).toHaveLength(HARNESS_OUTPUT_LIMIT);
  expect(view.tools?.[0]?.output?.endsWith('live tail')).toBe(true);
  view = applyHarnessEvent(view, { kind: 'tool', tool: codexHarnessTool({
    ...started, status: 'failed', exitCode: 1, aggregatedOutput: '\x1b[31mfailed\x1b[0m',
  }, turnId, true)! });
  view = applyHarnessEvent(view, { kind: 'toolOutput', turnId, id, delta: 'late' });
  expect(view.tools).toMatchObject([{ id, order: 2, output: 'failed', status: 'failed', exitCode: 1, truncated: false }]);
  expect(harnessOutput('\x00line\n')).toMatchObject({ output: 'line\n' });
  expect(legacyHarnessEvent({ kind: 'tool', tool: view.tools![0] })).toBeNull();
  const legacy = legacyHarnessSnapshot({ type: 'snapshot', threadId: 'thread', seq: 4, epoch: 1, view });
  expect(legacy.view).toEqual({ messages: [{ id: 'intro', turnId, role: 'assistant', text: '开始' }], turn: null, approvals: [], error: null });
});

it('registers bounded linked SVGs from paired directories without following an escaping symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dovun-harness-svg-'));
  try {
    const project = join(root, 'project');
    const outside = join(root, 'outside.svg');
    const diagram = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>';
    await mkdir(project);
    await writeFile(outside, diagram);
    await writeFile(join(project, 'inside.svg'), diagram);
    await writeFile(join(project, 'large.svg'), diagram + ' '.repeat(70_000));
    await symlink(outside, join(project, 'escape.svg'));
    const message = { id: 'answer', turnId: 'turn', role: 'assistant' as const,
      text: '[inside](inside.svg) [outside](../outside.svg) [escape](escape.svg) [large](large.svg)' };
    const first = await readHarnessArtifacts(message, project, [project]);
    expect(first).toEqual([{ id: expect.any(String), turnId: 'turn', messageId: 'answer', kind: 'svg',
      name: 'inside.svg', href: 'inside.svg', source: diagram }]);
    expect(await readHarnessArtifacts(message, project, [project])).toEqual(first);
  } finally { await rm(root, { recursive: true, force: true }); }
});
