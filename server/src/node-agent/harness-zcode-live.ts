import { crc32 } from 'node:zlib';
import { asObject, CodexRejected } from './harness-codex.js';
import { codexItems as items, codexText as text, projectCodexHistory } from './harness-history.js';
import { HARNESS_MODELS, HARNESS_OUTPUT_LIMIT, HARNESS_TEXT_LIMIT, zcodePermissionMode,
  type HarnessApproval, type HarnessSettingsChange, type HarnessSettingsView } from './harness-protocol.js';
import { acquireZCodeRelay, type ZCodeDesktopRelay } from './harness-zcode-relay.js';
import { zcodeTurns } from './harness-zcode-library.js';
import { zcodeHarnessTool } from './harness-zcode-tools.js';

type Fields = Record<string, unknown>;
const timeout = () => new Error('ZCode 原会话更新超时，操作结果待核实');
const nativeRows = 120;
const limitBytes = 16 * 1024 * 1024;

function waitUntil(check: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const interval = setInterval(() => {
      if (check()) { clearInterval(interval); resolve(); }
      else if (Date.now() - started >= 7_000) { clearInterval(interval); reject(timeout()); }
    }, 40);
  });
}

type TopicState = { id: string; seq?: number; fragment?: { id: string; count: number; length: number; parts: Buffer[]; consumed: number } };

function topicFrame(topic: TopicState, wire: Fields): Fields | undefined {
  if (wire.wireVersion !== 3 || (topic.id && wire.subscriptionId !== topic.id)) return;
  if (wire.kind === 'complete') return asObject(wire.frame);
  const { fragmentIndex, fragmentCount, logicalBytes } = wire;
  const id = text(wire.logicalFrameId), encoded = text(wire.dataBase64);
  if (wire.kind !== 'fragment' || !id || !encoded || typeof fragmentCount !== 'number' || !Number.isInteger(fragmentCount)
      || fragmentCount < 1 || fragmentCount > 64 || typeof logicalBytes !== 'number' || !Number.isInteger(logicalBytes)
      || logicalBytes < 1 || logicalBytes > limitBytes) return;
  if (topic.fragment?.id !== id) topic.fragment = { id, count: fragmentCount, length: logicalBytes, parts: [], consumed: 0 };
  const pending = topic.fragment;
  if (fragmentIndex !== pending.parts.length || fragmentCount !== pending.count || logicalBytes !== pending.length) return;
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.toString('base64') !== encoded || pending.consumed + bytes.length > pending.length) return;
  pending.parts.push(bytes);
  pending.consumed += bytes.length;
  if (pending.parts.length !== fragmentCount) return;
  topic.fragment = undefined;
  const full = Buffer.concat(pending.parts, pending.consumed);
  const checksum = asObject(wire.checksum);
  if (full.length !== logicalBytes || checksum.algorithm !== 'crc32'
      || checksum.value !== crc32(full).toString(16).padStart(8, '0')) return;
  return asObject(JSON.parse(full.toString('utf8')));
}

const optionId = (provider: string, model: string) => [provider, model].map(encodeURIComponent).join('/');
type NativeModel = { id: string; provider: string; model: string; label: string; thought: string };
type PermissionOption = NonNullable<HarnessApproval['options']>[number];

function zcodePermissionOption(raw: Fields): PermissionOption | undefined {
  const id = text(raw.optionId);
  if (raw.kind === 'allowOnce' && (id === 'allowOnce' || id === 'allow_once')) return { id, scope: 'once' };
  if (raw.kind === 'allowAlways') {
    if (id === 'allowSession') return { id, scope: 'session' };
    if (id === 'allowAlways' || id === 'allow_project') {
      return { id, scope: raw.label === 'Always allow Computer Use in this project' ? 'projectComputerUse' : 'project' };
    }
  }
  if (raw.kind === 'deny' && id === 'deny') return { id, scope: 'deny' };
}

export class ZCodeLiveConversation {
  private readonly conversation: TopicState = { id: '' };
  private readonly dispose: Array<() => void> = [];
  private rows = new Map<number, Fields>();
  private config: Fields = {};
  private control: Fields = {};
  private permissions: HarnessApproval[] = [];
  private options: NativeModel[] = [];
  private revision = 0;
  private snapshotNumber = 0;
  private repairing = false;
  private ended = false;
  private update?: ReturnType<typeof setTimeout>;

  private constructor(private readonly relay: ZCodeDesktopRelay, private readonly release: () => void,
    private readonly cwd: string, readonly threadId: string, private readonly changed: () => void,
    private readonly offline: () => void, private readonly nativePermissions: () => boolean) {}

  static async open(cwd: string, threadId: string, changed: () => void, offline: () => void, nativePermissions = () => false) {
    const { relay, release } = await acquireZCodeRelay(cwd);
    const live = new ZCodeLiveConversation(relay, release, cwd, threadId, changed, offline, nativePermissions);
    try {
      live.dispose.push(relay.onDisconnect(() => { live.close(); live.offline(); }));
      live.dispose.push(relay.listen('onDynamicConversationFrame', (wire) => {
        if (wire.topic === 'conversation/' + threadId) live.accept(wire);
      }));
      const conversation = asObject(await relay.call('subscribeConversationV4', {
        ...relay.workspace, sessionId: threadId, visibility: 'foreground',
      }));
      live.conversation.id = text(asObject(conversation.ack).subscriptionId);
      if (!live.conversation.id) throw timeout();
      await Promise.all([waitUntil(() => live.ended || live.snapshotNumber > 0), live.readModels().catch(() => undefined)]);
      if (live.ended) throw timeout();
      return live;
    } catch (error) { live.close(); throw error; }
  }

  get connected() { return !this.ended && !this.relay.closed; }

  private accept(wire: Fields) {
    const topic = this.conversation;
    const frame = topicFrame(topic, wire);
    if (!frame || frame.subscriptionId !== wire.subscriptionId || frame.topic !== wire.topic) return;
    const payload = asObject(frame.payload);
    const sequence = frame.toSeq;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) return;
    if (payload.kind === 'snapshot') {
      const snapshot = asObject(payload.snapshot);
      if (snapshot.sessionId === this.threadId) {
        this.rows.clear();
        for (const row of items(asObject(snapshot.rows).window).slice(-nativeRows)) this.put(row);
        this.config = asObject(snapshot.config);
        this.control = asObject(snapshot.control);
        this.updatePermissions(snapshot.pendingInteractions);
        this.revision = typeof snapshot.revision === 'number' && Number.isSafeInteger(snapshot.revision) ? snapshot.revision : 0;
        this.snapshotNumber++;
      } else return;
    } else if (payload.kind === 'deltas') {
      if (topic.seq !== undefined && sequence <= topic.seq) return;
      if (frame.fromSeq !== topic.seq) {
        void this.refresh().catch(() => this.relay.close());
        return;
      }
      for (const delta of items(payload.deltas)) this.apply(delta);
    } else return;
    topic.seq = sequence;
    if (!this.update) {
      this.update = setTimeout(() => { this.update = undefined; if (this.connected) this.changed(); }, 100);
      this.update.unref();
    }
  }

  private put(row: Fields) {
    if (typeof row.rowId !== 'number' || !Number.isSafeInteger(row.rowId)) return;
    this.rows.set(row.rowId, row);
    if (this.rows.size > nativeRows) this.rows.delete(this.rows.keys().next().value!);
  }

  private apply(delta: Fields) {
    if (delta.op === 'row.appended') this.put(asObject(delta.row));
    if (delta.op === 'row.upserted' && this.rows.has(asObject(delta.row).rowId as number)) this.put(asObject(delta.row));
    if (delta.op === 'row.removed' && typeof delta.fromRowId === 'number') {
      for (const id of this.rows.keys()) if (id >= delta.fromRowId) this.rows.delete(id);
    }
    if (delta.op === 'row.delta' && typeof delta.rowId === 'number') {
      const row = this.rows.get(delta.rowId);
      if (row?.kind === 'assistantText' && delta.path === 'text') {
        this.put({ ...row, text: (text(row.text) + text(delta.append)).slice(0, HARNESS_TEXT_LIMIT) });
      }
      if (row?.kind === 'toolCall' && row.output && delta.path === 'output.text') {
        const output = asObject(row.output);
        const value = text(output.text) + text(delta.append);
        this.put({ ...row, output: { ...output, text: value.slice(-HARNESS_OUTPUT_LIMIT * 2),
          truncated: output.truncated || value.length > HARNESS_OUTPUT_LIMIT * 2 } });
      }
    }
    if (delta.op === 'state.updated') {
      const patch = asObject(delta.patch);
      if (patch.config) this.config = asObject(patch.config);
      if (patch.control) this.control = asObject(patch.control);
      if (Array.isArray(patch.pendingInteractions)) this.updatePermissions(patch.pendingInteractions);
      if (typeof patch.revision === 'number' && Number.isSafeInteger(patch.revision)) this.revision = Math.max(this.revision, patch.revision);
    }
  }

  private updatePermissions(pending: unknown) {
    this.permissions = items(pending).flatMap<HarnessApproval>((request) => {
      const id = text(request.interactionId);
      const payload = asObject(request.payload);
      if (!id || id.length > 200 || request.kind !== payload.kind) return [];
      const row = typeof request.anchorRowId === 'number' ? this.rows.get(request.anchorRowId) : undefined;
      const turnId = text(row?.turnId).slice(0, 200) || id;
      if (request.kind === 'userInput' && asObject(payload.schema).interaction === 'plan_approval') {
        const input = asObject(payload.input);
        const plan = text(input.plan).trim();
        const prompts = items(input.allowedPrompts).map((item) => `${text(item.tool)} · ${text(item.prompt)}`);
        const details = [plan, ...prompts].filter(Boolean).join('\n\n');
        const canAccept = plan.length > 0 && details.length <= HARNESS_TEXT_LIMIT && items(payload.questions).some((question) =>
          items(question.options).some((option) => option.value === 'approve'));
        return [{ id, turnId, kind: 'plan', details: details.slice(0, HARNESS_TEXT_LIMIT) || text(payload.prompt).slice(0, 8_000), canAccept,
          options: [{ id: 'decline', scope: 'deny' }, ...(canAccept ? [{ id: 'approve', scope: 'approvePlan' } as const] : [])] }];
      }
      if (request.kind !== 'permission') return [];
      const options = new Map<string, PermissionOption>();
      for (const raw of items(payload.options)) {
        const option = zcodePermissionOption(raw);
        if (option && !options.has(option.scope)) options.set(option.scope, option);
      }
      if (!options.size) return [];
      const tool = text(payload.toolName);
      const input = asObject(payload.detail);
      const kind = tool.toLowerCase() === 'bash' ? 'command'
        : ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) ? 'fileChange' : 'permissions';
      const details = [tool, text(payload.summary), text(input.command), text(input.file_path) || text(input.path) || text(input.url)];
      return [{ id, turnId, kind, details: [...new Set(details.filter(Boolean))].join('\n').slice(0, 8_000),
        canAccept: [...options.keys()].some((scope) => scope !== 'deny'), options: [...options.values()] }];
    }).slice(0, 32);
  }

  private async readModels() {
    // This is the same filtered catalogue used by ZCode's mobile model picker.
    // Do not keep or relay provider connection settings contained in the response.
    const view = asObject(await this.relay.call('getView', undefined, 'model-selection'));
    const preferred = asObject(view.preferredSelection);
    const options: NativeModel[] = [];
    for (const entry of items(view.providers)) {
      const provider = text(entry.providerId);
      if (!provider || asObject(asObject(entry.config).access).entitled === false) continue;
      for (const row of items(entry.models)) {
        const model = text(row.modelId);
        const id = optionId(provider, model);
        const config = asObject(row.config);
        if (!model || id.length > 200 || config.enabled === false) continue;
        const label = text(asObject(config.properties).displayName) || model;
        const thought = preferred.providerId === provider && preferred.modelId === model
          ? text(asObject(preferred.options).reasoningLevel) : '';
        options.push({ id, provider, model, label: label.slice(0, 200), thought });
        if (options.length >= HARNESS_MODELS) break;
      }
      if (options.length >= HARNESS_MODELS) break;
    }
    this.options = options;
  }

  settings(): HarnessSettingsView | undefined {
    const provider = text(this.config.provider), model = text(this.config.model);
    const id = optionId(provider, model);
    if (!provider || !model || id.length > 200) return;
    const models = [...new Map(this.options.map(({ id, label }) => [id, { id, label, efforts: [], defaultEffort: null }])).values()];
    const permissionMode = this.nativePermissions() ? zcodePermissionMode.safeParse(this.config.mode).data : undefined;
    const mode = permissionMode && this.config.planEnabled === true ? 'plan' : 'default';
    // Compare effective settings separately from the conversation revision used by ZCode's CAS.
    const revision = crc32(Buffer.from(JSON.stringify(permissionMode ? [id, this.config.thought, permissionMode, mode] : [id, this.config.thought])));
    return { model: id, revision, effort: null, mode, permission: 'workspace',
      models, planAvailable: Boolean(permissionMode), catalogAvailable: models.length > 0,
      ...(permissionMode ? { permissionMode, permissionModes: zcodePermissionMode.options.filter((value) => value !== 'edit' || permissionMode === 'edit') } : {}) };
  }

  turns() { return zcodeTurns([...this.rows.values()]); }

  async view() {
    const { view, clients } = await projectCodexHistory(this.turns(), this.cwd, [this.cwd], true, true, zcodeHarnessTool);
    return { view: { ...view, settings: this.settings(), approvals: this.nativePermissions() ? this.permissions : view.approvals }, clients };
  }

  private async refresh() {
    const previous = this.snapshotNumber;
    if (!this.conversation.id) throw timeout();
    if (!this.repairing) {
      this.repairing = true;
      try {
        await this.relay.call('resyncConversationV4', {
          ...this.relay.workspace, subscriptionId: this.conversation.id, base: null, forceSnapshot: true,
        });
        await waitUntil(() => !this.connected || this.snapshotNumber > previous);
      } finally { this.repairing = false; }
    } else await waitUntil(() => !this.connected || this.snapshotNumber > previous);
    if (!this.connected) throw timeout();
  }

  private async command(commandId: string, type: 'sendText' | 'switchModelConfig' | 'switchCollaborationMode' | 'resolveInteraction' | 'stop', payload: Fields, revision?: number) {
    const ack = asObject(await this.relay.call('sendConversationCommandV4', {
      ...this.relay.workspace,
      envelope: { workspace: this.relay.workspace, sessionId: this.threadId, clientId: this.relay.clientId, commandId,
        type, payload, issuedAt: Date.now(), ...(revision !== undefined ? { baseRevision: revision } : {}) },
    }));
    if (ack.commandId !== commandId) throw timeout();
    if (ack.status === 'stale') throw new CodexRejected('ZCode 原会话已变化，请刷新后重试');
    if (ack.status === 'rejected') throw new CodexRejected('ZCode 桌面拒绝了会话操作');
    if (ack.status !== 'accepted' && ack.status !== 'duplicate' && ack.status !== 'noop') throw timeout();
    return ack.status;
  }

  send(value: string, commandId: string) {
    return this.command(commandId, 'sendText', { text: value });
  }

  async stop(commandId: string, turnId: string) {
    await this.refresh();
    if (!this.turns().some((turn) => turn.id === turnId && turn.status === 'inProgress')) {
      throw new CodexRejected('当前轮次已结束');
    }
    const execution = items(this.control.activeWorks).find((work) => work.kind === 'primaryTurn');
    const executionId = text(execution?.foregroundExecutionId);
    if (!executionId) throw new CodexRejected('当前轮次已结束');
    await this.command(commandId, 'stop', { expectedForegroundExecutionId: executionId });
  }

  async selectModel(model: string | undefined, commandId: string, expectedSettingsRevision?: number) {
    await Promise.all([this.refresh(), this.readModels()]);
    const current = this.settings();
    if (expectedSettingsRevision !== undefined && expectedSettingsRevision !== current?.revision) {
      throw new CodexRejected('会话设置已变更，请刷新后重试');
    }
    if (model !== undefined && current?.model !== model) {
      const next = this.options.find((option) => option.id === model);
      if (!next) throw new CodexRejected('这个模型在本机 ZCode 中不可用');
      await this.command(commandId, 'switchModelConfig', {
        provider: next.provider, model: next.model, thought: next.thought,
      }, this.revision);
      await this.refresh();
      if (this.settings()?.model !== model) throw timeout();
    }
    return this.settings();
  }

  async selectPermission(changes: HarnessSettingsChange, commandId: string, expectedSettingsRevision: number) {
    await this.refresh();
    const current = this.settings();
    if (expectedSettingsRevision !== current?.revision) throw new CodexRejected('会话设置已变更，请刷新后重试');
    const base = zcodePermissionMode.safeParse(current.permissionMode).data;
    const requested = changes.permissionMode ?? base;
    if (!base || !requested || !current.permissionModes?.includes(requested) || changes.permissionMode && current.mode === 'plan') {
      throw new CodexRejected('本机不支持这个会话操作');
    }
    const mode = changes.mode ?? 'default';
    if (mode === current.mode && requested === base) return current;
    await this.command(commandId, 'switchCollaborationMode', { mode: mode === 'plan' ? 'plan' : requested }, this.revision);
    await this.refresh();
    const updated = this.settings();
    if (updated?.mode !== mode || updated.permissionMode !== requested) throw timeout();
    return updated;
  }

  async choosePermission(interactionId: string, optionId: string, commandId: string) {
    await this.refresh();
    const request = this.permissions.find((item) => item.id === interactionId);
    const option = request?.options?.find((item) => item.id === optionId);
    if (!this.nativePermissions() || !option) {
      throw new CodexRejected('这条权限请求已处理或决定无效');
    }
    const answer = request?.kind === 'plan'
      ? option.scope === 'approvePlan' ? { action: 'accept', content: { answer: optionId } } : { action: 'decline' }
      : { optionId };
    const status = await this.command(commandId, 'resolveInteraction', { interactionId, answer });
    await this.refresh();
    if (status === 'noop') throw new CodexRejected('这条权限请求已处理或决定无效');
  }

  close() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.update);
    for (const dispose of this.dispose.reverse()) dispose();
    if (!this.relay.closed && this.conversation.id) {
      void this.relay.call('unsubscribeConversationV4', { ...this.relay.workspace, subscriptionId: this.conversation.id }).catch(() => undefined);
    }
    this.release();
  }
}
