import { expect, it, vi } from 'vitest';
import { HARNESS_OUTPUT_LIMIT } from './harness-protocol.js';
import { ZCodeLiveConversation } from './harness-zcode-live.js';
import { acquireZCodeRelay } from './harness-zcode-relay.js';

vi.mock('./harness-zcode-relay.js', () => ({ acquireZCodeRelay: vi.fn() }));

it('preserves the desktop conversation, command IDs and streaming tool rows across updates', async () => {
  const cwd = process.cwd();
  const threadId = 'sess_original';
  const workspace = { workspacePath: cwd, workspaceKey: cwd };
  const subscriptionId = 'subscription';
  const topic = 'conversation/' + threadId;
  const tool = { rowId: 3, entityId: 'native-bash', kind: 'toolCall', turnId: 'turn-1', toolName: 'Bash',
    input: { command: 'printf fixture', privateInput: 'not displayed' } };
  let emit: (wire: Record<string, unknown>) => void;
  let revision = 17;
  let model = 'model-a';
  let deduped = false;
  const release = vi.fn();
  const frame = (fromSeq: number, toSeq: number, payload: unknown) => emit({
    topic, subscriptionId, wireVersion: 3, kind: 'complete', frame: { topic, subscriptionId, fromSeq, toSeq, payload },
  });
  const snapshot = () => frame(0, revision, {
    kind: 'snapshot', snapshot: { sessionId: threadId, revision, config: { provider: 'local', model }, rows: { window: [] } },
  });
  const call = vi.fn(async (name: string, arg?: Record<string, unknown>) => {
    if (name === 'getView') return { providers: [{ providerId: 'local', models: ['model-a', 'model-b'].map((modelId) => ({ modelId })) }] };
    if (name === 'subscribeConversationV4' || name === 'resyncConversationV4') {
      snapshot();
      return { ack: { subscriptionId } };
    }
    if (name === 'unsubscribeConversationV4') return;
    expect(name).toBe('sendConversationCommandV4');
    const envelope = arg!.envelope as Record<string, unknown>;
    expect(envelope).toMatchObject({ workspace, sessionId: threadId, clientId: 'paired-mac' });
    if (envelope.type === 'switchModelConfig') {
      expect(envelope).toMatchObject({ baseRevision: revision, commandId: 'switch-1', payload: { provider: 'local', model: 'model-b', thought: '' } });
      model = 'model-b';
      revision++;
      return { commandId: 'switch-1', status: 'accepted' };
    }
    expect(envelope).toMatchObject({ type: 'sendText', commandId: 'message-1', payload: { text: 'continue here' } });
    if (deduped) return { commandId: 'message-1', status: 'duplicate' };
    deduped = true;
    frame(revision, revision + 1, { kind: 'deltas', deltas: [
      { op: 'row.appended', row: { rowId: 1, kind: 'turnHeader', turnId: 'turn-1', state: 'running' } },
      { op: 'row.appended', row: { rowId: 2, kind: 'userInput', turnId: 'turn-1', text: 'continue here', sourceCommandId: 'message-1' } },
      { op: 'row.appended', row: { ...tool, status: 'inputStreaming' } },
      { op: 'row.upserted', row: { ...tool, status: 'running', outputPreview: { fullText: 'first line', totalLines: 1 } } },
      { op: 'row.appended', row: { rowId: 4, kind: 'assistantText', turnId: 'turn-1', text: 'first' } },
      { op: 'row.delta', rowId: 4, path: 'text', append: ' second' },
    ] });
    return { commandId: 'message-1', status: 'accepted' };
  });
  vi.mocked(acquireZCodeRelay).mockResolvedValue({ release, relay: {
    workspace, clientId: 'paired-mac', closed: false, call, onDisconnect: () => vi.fn(),
    listen: (_name: string, handler: typeof emit) => { emit = handler; return vi.fn(); },
  } as unknown as Awaited<ReturnType<typeof acquireZCodeRelay>>['relay'] });

  const live = await ZCodeLiveConversation.open(cwd, threadId, vi.fn(), vi.fn());
  try {
    const initial = live.settings()!;
    expect(initial.models.map(({ id }) => id)).toEqual(['local/model-a', 'local/model-b']);
    const changed = await live.selectModel('local/model-b', 'switch-1', initial.revision);
    expect(changed?.model).toBe('local/model-b');
    await expect(live.selectModel('local/model-a', 'stale', initial.revision)).rejects.toThrow('会话设置已变更');
    await live.send('continue here', 'message-1');
    await live.send('continue here', 'message-1');
    const { view, clients } = await live.view();
    expect(view.messages.map(({ text }) => text)).toEqual(['continue here', 'first second']);
    expect(view.turn?.status).toBe('inProgress');
    expect(clients.has('message-1')).toBe(true);
    expect(view.tools).toMatchObject([{ id: 'native-bash', kind: 'command', title: 'printf fixture', status: 'running', output: 'first line' }]);
    frame(revision + 1, revision + 2, { kind: 'deltas', deltas: [
      { op: 'row.upserted', row: { ...tool, status: 'running', output: { text: 'prefix' } } },
      { op: 'row.delta', rowId: tool.rowId, path: 'output.text', append: '\nnext line' },
    ] });
    expect((await live.view()).view.tools).toMatchObject([{ id: 'native-bash', status: 'running', output: 'prefix\nnext line' }]);
    frame(revision + 2, revision + 3, { kind: 'deltas', deltas: [
      { op: 'row.upserted', row: { ...tool, status: 'success', output: {
        text: 'fallback', display: { kind: 'bash_output', output: 'x'.repeat(HARNESS_OUTPUT_LIMIT) + '\u001b[32mfinal\u001b[0m' },
      } } },
    ] });
    const updated = (await live.view()).view;
    expect(updated.tools).toMatchObject([{ id: 'native-bash', status: 'completed', truncated: true,
      output: 'x'.repeat(HARNESS_OUTPUT_LIMIT - 5) + 'final' }]);
    expect(JSON.stringify(updated)).not.toContain('not displayed');
  } finally { live.close(); }
  expect(release).toHaveBeenCalledOnce();
});
