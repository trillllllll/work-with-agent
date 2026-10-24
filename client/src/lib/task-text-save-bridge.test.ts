import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { TaskTextSaveBridge } from './task-text-save-bridge.js';
import type { Task } from './api.js';
import { createWriteQueue, queryKeys } from './todo.js';

const task = { id: 'a', revision: 1, title: 'Original', description: '', status: 'todo', priority: 'none', tagIds: [] } as unknown as Task;
const request = (revision = 1, extra = {}) => ({ requestId: `save-${revision}`, method: 'PATCH' as const, path: '/api/tasks/a', bodyJson: JSON.stringify({ expectedRevision: revision, title: 'Saved', ...extra }) });

describe('acknowledged editor text saves', () => {
  it('updates detail and existing filtered lists, preserving absent lists and newer responses', async () => {
    const client = new QueryClient();
    const bridge = new TaskTextSaveBridge(client, () => true);
    client.setQueryData(queryKeys.task('a'), task);
    client.setQueryData(queryKeys.taskList('inbox=true'), [task]);
    client.setQueryData(queryKeys.taskList('status=done'), []);
    await bridge.acknowledge(request(), { data: { ...task, revision: 2, title: 'Saved' } });
    expect(client.getQueryData<Task>(queryKeys.task('a'))?.revision).toBe(2);
    expect(client.getQueryData<Task[]>(queryKeys.taskList('inbox=true'))?.[0].title).toBe('Saved');
    expect(client.getQueryData(queryKeys.taskList('status=done'))).toEqual([]);
    client.setQueryData(queryKeys.task('a'), { ...task, revision: 5, status: 'done' });
    await bridge.acknowledge(request(), { data: { ...task, revision: 2 } });
    expect(client.getQueryData<Task>(queryKeys.task('a'))?.revision).toBe(5);
    client.clear();
  });

  it('advances an action queued behind a text save before a list can rerender', async () => {
    const bridge = new TaskTextSaveBridge(new QueryClient(), () => true);
    const queue = createWriteQueue();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const save = queue(['a'], async () => { await gate; await bridge.acknowledge(request(), { data: { ...task, revision: 2 } }); });
    const complete = queue(['a'], async () => bridge.advance('a', 1));
    release();
    await save;
    expect(await complete).toBe(2);
  });

  it('cannot cross a remote revision, another task or another authenticated scope', async () => {
    const bridge = new TaskTextSaveBridge(new QueryClient(), () => true);
    await bridge.acknowledge(request(), { data: { ...task, revision: 2 } });
    // Revision 3 was a remote edit; a later local text save must not bridge 2 -> 3.
    await bridge.acknowledge(request(3), { data: { ...task, revision: 4 } });
    expect(bridge.advance('a', 1)).toBe(2);
    expect(bridge.advance('a', 3)).toBe(4);
    expect(bridge.advance('b', 1)).toBe(1);
    const otherScope = new TaskTextSaveBridge(new QueryClient(), () => true);
    expect(otherScope.advance('a', 1)).toBe(1);
  });

  it('ignores non-text, mismatched and nonconsecutive replies, and discards a scope closed during cancellation', async () => {
    const client = new QueryClient();
    let active = true;
    const bridge = new TaskTextSaveBridge(client, () => active);
    await bridge.acknowledge(request(1, { status: 'done' }), { data: { ...task, revision: 2 } });
    await bridge.acknowledge(request(), { data: { ...task, id: 'b', revision: 2 } });
    await bridge.acknowledge(request(), { data: { ...task, revision: 3 } });
    const pending = bridge.acknowledge(request(), { data: { ...task, revision: 2 } });
    active = false;
    await pending;
    expect(bridge.advance('a', 1)).toBe(1);
    expect(client.getQueryData(queryKeys.task('a'))).toBeUndefined();
    client.clear();
  });

  it('stops using earlier receipts when the editor scope is no longer authenticated', async () => {
    let active = true;
    const client = new QueryClient();
    const bridge = new TaskTextSaveBridge(client, () => active);
    await bridge.acknowledge(request(), { data: { ...task, revision: 2 } });
    expect(bridge.advance('a', 1)).toBe(2);
    active = false;
    expect(bridge.advance('a', 1)).toBe(1);
    client.clear();
  });
});
