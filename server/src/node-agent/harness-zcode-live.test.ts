import { expect, it, vi } from 'vitest';
import { applyHarnessEvent, HARNESS_OUTPUT_LIMIT, type HarnessView } from './harness-protocol.js';
import { zcodeStreamEvents, ZCodeLiveConversation } from './harness-zcode-live.js';
import { openZCode } from './harness-zcode-client.js';

vi.mock('./harness-zcode-client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./harness-zcode-client.js')>(),
  openZCode: vi.fn(),
}));

it('projects appended ZCode text and tool output through the shared stream and falls back on a changed window', () => {
  const previous: HarnessView = {
    turn: { id: 'turn', status: 'inProgress' }, approvals: [], error: null,
    messages: [{ id: 'answer', turnId: 'turn', role: 'assistant', text: 'first', streaming: true, order: 1 }],
    tools: [{ id: 'tool', turnId: 'turn', kind: 'command', status: 'running', title: 'fixture', output: 'first', truncated: false, order: 2 }],
  };
  const current: HarnessView = {
    ...previous, messages: [{ ...previous.messages[0], text: 'first second' }],
    tools: [{ ...previous.tools![0], output: 'first line' }],
  };
  const events = zcodeStreamEvents(previous, current);
  expect(events).toMatchObject([{ kind: 'delta', delta: ' second' }, { kind: 'toolOutput', delta: ' line' }]);
  expect(events?.reduce(applyHarnessEvent, previous)).toEqual(current);
  expect(zcodeStreamEvents(current, { ...current, messages: [] })).toBeNull();
});

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
  let model = 'old-model';
  let thought = '';
  let mode = 'build';
  let planEnabled = false;
  const permission = (interactionId: string, optionId: string) => ({ interactionId, kind: 'permission', anchorRowId: 3,
    payload: { kind: 'permission', toolName: 'Bash', summary: 'Approve the next command', detail: tool.input, options: [
      { optionId: 'allowOnce', kind: 'allowOnce' }, { optionId, kind: 'allowAlways', response: { opaque: 'private rules' } },
      { optionId: 'deny', kind: 'deny' }, { optionId: 'fullAccess', kind: 'custom' },
    ] } });
  let pending: Record<string, unknown>[] = [];
  let deduped = false;
  let busy = false;
  let refreshed = false;
  const close = vi.fn(async () => undefined);
  const assertAvailable = vi.fn(async () => {
    if (busy) throw new Error('ZCode 会话已被另一个进程打开');
  });
  const frame = (fromSeq: number, toSeq: number, payload: unknown) => emit({
    topic, subscriptionId, wireVersion: 3, kind: 'complete', frame: { topic, subscriptionId, fromSeq, toSeq, payload },
  });
  const snapshot = () => frame(0, revision, {
    kind: 'snapshot', snapshot: { sessionId: threadId, revision, config: { provider: 'local', model, mode, planEnabled, thought },
      rows: { window: [] }, pendingInteractions: pending },
  });
  const request = vi.fn(async (name: string, arg: Record<string, unknown>) => {
    if (name === 'session/list') return { sessions: [{ sessionId: threadId, workspace, updatedAt: 1 }] };
    if (name === 'session/resume') return { session: { sessionId: threadId }, settings: { model: {
      available: [
        ...['model-a', 'model-b'].map((modelId) => ({ ref: { providerId: 'local', modelId },
          reasoning: { defaultLevel: 'high', levels: [{ value: 'low' }, { value: 'high' }] },
        })),
        ...(refreshed ? [{ ref: { providerId: 'account:fixture', modelId: 'GLM-5.4' }, label: 'GLM-5.4' }] : []),
      ],
    } } };
    if (name === 'provider/refreshRegistry') {
      refreshed = true;
      return {};
    }
    if (name === 'v4/conversation/subscribe' || name === 'v4/conversation/resync') {
      expect(arg.topic).toBe(topic);
      if (name === 'v4/conversation/resync') expect(arg).not.toHaveProperty('workspace');
      snapshot();
      return { ack: { subscriptionId } };
    }
    expect(name).toBe('v4/command');
    const envelope = arg;
    expect(envelope).toMatchObject({ workspace, sessionId: threadId, clientId: 'dovun' });
    if (envelope.type === 'switchModelConfig') {
      const payload = envelope.payload as { thought?: string };
      expect(payload).toMatchObject({ provider: 'local', model: 'model-b' });
      thought = String(payload.thought);
      if (envelope.commandId === 'switch-1') {
        expect(envelope).toMatchObject({ baseRevision: revision, commandId: 'switch-1', payload: { thought: 'high' } });
        model = 'model-b';
      } else {
        expect(envelope.commandId).toBe('switch-effort');
        expect(payload).toMatchObject({ thought: 'low' });
      }
      revision++;
      return { commandId: envelope.commandId, status: 'accepted' };
    }
    if (envelope.type === 'switchCollaborationMode') {
      const target = new Map([['guarded-1', 'guarded'], ['plan-1', 'plan'], ['leave-plan', 'guarded']]).get(String(envelope.commandId));
      expect(target).toBeDefined();
      expect(envelope).toMatchObject({ baseRevision: revision, payload: { mode: target } });
      planEnabled = target === 'plan';
      if (!planEnabled) mode = target!;
      revision++;
      return { commandId: envelope.commandId, status: 'accepted' };
    }
    if (envelope.type === 'resolveInteraction') {
      const plan = envelope.commandId === 'approve-plan';
      const interactionId = plan ? 'plan' : 'project';
      expect(envelope).toMatchObject({ commandId: plan ? 'approve-plan' : 'permit-project', payload: { interactionId,
        answer: plan ? { action: 'accept', content: { answer: 'approve' } } : { optionId: 'allowAlways' },
      } });
      pending = pending.filter((item) => item.interactionId !== interactionId);
      revision++;
      return { commandId: envelope.commandId, status: 'accepted' };
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
  vi.mocked(openZCode).mockImplementation(async (_cwd, onMessage) => {
    emit = (wire) => onMessage('v4/conversation/frame', wire);
    return { request, close } as unknown as Awaited<ReturnType<typeof openZCode>>;
  });

  const live = await ZCodeLiveConversation.open(cwd, threadId, vi.fn(), vi.fn(), () => true, assertAvailable);
  try {
    const initial = live.settings()!;
    expect(initial.models.map(({ id }) => id)).toEqual(['local/model-a', 'local/model-b']);
    expect(initial.models.find((entry) => entry.id === 'local/model-b')).toMatchObject({ efforts: ['low', 'high'], defaultEffort: 'high' });
    expect(initial.effort).toBeNull();
    const beforeUnavailableSend = request.mock.calls.length;
    await expect(live.send('continue here', 'missing-model')).rejects.toThrow('当前 ZCode 模型在 Mac 上不可用');
    expect(request).toHaveBeenCalledTimes(beforeUnavailableSend);
    const reloaded = await live.selectModel(undefined, 'reload-models', initial.revision);
    expect(reloaded?.models.map(({ id }) => id)).toEqual(['local/model-a', 'local/model-b', 'account%3Afixture/GLM-5.4']);
    const changed = await live.selectModel('local/model-b', 'switch-1', initial.revision);
    expect(changed?.model).toBe('local/model-b');
    expect(changed?.effort).toBe('high');
    await expect(live.selectModel('local/model-a', 'stale', initial.revision)).rejects.toThrow('会话设置已变更');
    const effortPicked = await live.selectModel(undefined, 'switch-effort', changed!.revision, 'low');
    expect(effortPicked).toMatchObject({ model: 'local/model-b', effort: 'low' });
    await expect(live.selectModel(undefined, 'bad-effort', effortPicked!.revision, 'bogus')).rejects.toThrow('这个模型不支持所选思考档位');
    expect(changed).toMatchObject({ permissionMode: 'build', permissionModes: ['build', 'guarded', 'yolo'], planAvailable: true });
    const guarded = await live.selectPermission({ permissionMode: 'guarded' }, 'guarded-1', effortPicked!.revision);
    expect(guarded.permissionMode).toBe('guarded');
    const plan = await live.selectPermission({ mode: 'plan' }, 'plan-1', guarded.revision);
    expect(plan).toMatchObject({ mode: 'plan', permissionMode: 'guarded' });
    await expect(live.selectPermission({ permissionMode: 'build' }, 'change-in-plan', plan.revision)).rejects.toThrow('本机不支持');
    const leftPlan = await live.selectPermission({ mode: 'default' }, 'leave-plan', plan.revision);
    expect(leftPlan).toMatchObject({ mode: 'default', permissionMode: 'guarded' });
    busy = true;
    const beforeBusySend = request.mock.calls.length;
    await expect(live.send('continue here', 'message-1')).rejects.toThrow('ZCode 会话已被另一个进程打开');
    expect(request).toHaveBeenCalledTimes(beforeBusySend);
    busy = false;
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
    pending = [permission('project', 'allowAlways'), permission('session', 'allowSession')];
    frame(revision + 3, revision + 4, { kind: 'deltas', deltas: [{ op: 'state.updated', patch: { pendingInteractions: pending } }] });
    const approvals = (await live.view()).view.approvals;
    expect(approvals).toMatchObject([
      { id: 'project', turnId: 'turn-1', kind: 'command', details: expect.stringContaining(tool.input.command), options: [
        { id: 'allowOnce', scope: 'once' }, { id: 'allowAlways', scope: 'project' }, { id: 'deny', scope: 'deny' },
      ] },
      { id: 'session', options: [
        { id: 'allowOnce', scope: 'once' }, { id: 'allowSession', scope: 'session' }, { id: 'deny', scope: 'deny' },
      ] },
    ]);
    expect(JSON.stringify(approvals)).not.toMatch(/private rules|privateInput|fullAccess/);
    await expect(live.choosePermission('session', 'allowAlways', 'wrong-scope')).rejects.toThrow('这条权限请求已处理');
    await live.choosePermission('project', 'allowAlways', 'permit-project');
    expect((await live.view()).view.approvals.map(({ id }) => id)).toEqual(['session']);
    await expect(live.choosePermission('project', 'allowAlways', 'already-answered')).rejects.toThrow('这条权限请求已处理');
    pending.push({ interactionId: 'plan', kind: 'userInput', payload: { kind: 'userInput', schema: { interaction: 'plan_approval' },
      input: { plan: 'Review the changes, then run the tests.' }, questions: [{ options: [{ value: 'approve' }] }],
    } });
    frame(revision, revision + 1, { kind: 'deltas', deltas: [{ op: 'state.updated', patch: { pendingInteractions: pending } }] });
    expect((await live.view()).view.approvals[1]).toMatchObject({ id: 'plan', kind: 'plan',
      details: 'Review the changes, then run the tests.', options: [{ id: 'decline', scope: 'deny' }, { id: 'approve', scope: 'approvePlan' }],
    });
    await live.choosePermission('plan', 'approve', 'approve-plan');
    expect((await live.view()).view.approvals.map(({ id }) => id)).toEqual(['session']);
  } finally { await live.close(); }
  expect(close).toHaveBeenCalledOnce();
});
