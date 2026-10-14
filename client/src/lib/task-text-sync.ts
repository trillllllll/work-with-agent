import { mergeText } from './task-text-merge.js';
import type { TaskDraftStore } from './task-draft-store.js';
import type { FieldConflict, SaveStatus, TaskText, TaskTextDraftV1, TextField, TextVersion } from './task-editor-types.js';

export const EDIT_DEBOUNCE_MS = 800;
export const NETWORK_WAIT_MS = 15_000;
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
const CONFLICT_CODES = ['VERSION_CONFLICT', 'CONFLICT', 'PRECONDITION_FAILED'];

export type TransportRequest = {
  requestId: string;
  method: 'PATCH' | 'POST';
  path: string;
  bodyJson: string;
};

export type TransportOutcome =
  | { kind: 'success'; status: number; body: unknown }
  | { kind: 'rejected'; status: number; code?: string; body: unknown }
  | { kind: 'network' };

export type SyncEvent = {
  taskId: string;
  status: SaveStatus;
  record: TaskTextDraftV1 | null;
  unsyncedCount: number;
};

export type BranchLocks = {
  /** 尝试取得并持有分支锁；已被其他窗口持有时返回 false。 */
  tryHold: (name: string) => Promise<boolean>;
};

export type CoordinatorDeps = {
  scopeKey: string;
  store: TaskDraftStore;
  send: (request: TransportRequest) => Promise<TransportOutcome>;
  now: () => number;
  schedule: (fn: () => void, ms: number) => () => void;
  enqueue: <T>(keys: string[], run: () => Promise<T>) => Promise<T>;
  newRequestId: () => string;
  fetchTaskText: (taskId: string) => Promise<TextVersion | null>;
  isAuthed: () => boolean;
  locks?: BranchLocks;
  onEvent?: (event: SyncEvent) => void;
};

export type OpenTaskResult = {
  record: TaskTextDraftV1;
  /** 存在多份不同遗留草稿时暂停自动同步，等待用户选择。 */
  staleBranches: TaskTextDraftV1[];
};

type ServerTask = { id?: string; revision?: number; title?: string; description?: string };

function bodyTask(body: unknown): ServerTask | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  return data && typeof data === 'object' ? data as ServerTask : null;
}

function asTextVersion(task: ServerTask, fallback: TextVersion): TextVersion {
  return {
    revision: typeof task.revision === 'number' && Number.isFinite(task.revision) && task.revision > 0 ? Math.trunc(task.revision) : fallback.revision,
    title: typeof task.title === 'string' ? task.title : fallback.title,
    description: typeof task.description === 'string' ? task.description : fallback.description,
  };
}

function textEqual(a: TaskText, b: TaskText) {
  return a.title === b.title && a.description === b.description;
}

function sameFieldText(field: TextField, a: string, b: string) {
  return field === 'title' ? a.trim() === b.trim() : a === b;
}

/**
 * 应用级保存协调器：编辑、本地持久化、outbox 重放、三方合并与安全离开。
 * 本地状态更新和网络回包处理都在同一实例内串行执行。
 */
export class TaskTextSyncCoordinator {
  readonly scopeKey: string;
  readonly branchId: string;
  private readonly deps: CoordinatorDeps;
  private readonly records = new Map<string, TaskTextDraftV1>();
  /** openTask 还在读 IndexedDB 时到达的输入，记录创建后补上，避免被丢掉。 */
  private readonly queuedEdits = new Map<string, TaskText>();
  private readonly persistChains = new Map<string, Promise<void>>();
  private readonly durableVersions = new Map<string, number>();
  private readonly storageFailed = new Set<string>();
  private readonly pumping = new Map<string, Promise<void>>();
  private readonly debounceTimers = new Map<string, () => void>();
  private readonly retryTimers = new Map<string, () => void>();
  private readonly composing = new Set<string>();
  private readonly compositionWaiters = new Map<string, Array<() => void>>();
  private readonly pendingExternal = new Map<string, TextVersion>();
  private readonly pausedStale = new Map<string, TaskTextDraftV1[]>();
  private readonly subscribers = new Map<string, Set<(event: SyncEvent) => void>>();
  private readonly retryExhausted = new Set<string>();
  private disposed = false;

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
    this.scopeKey = deps.scopeKey;
    this.branchId = deps.newRequestId();
  }

  private key(taskId: string, branchId = this.branchId) {
    return `${taskId}\u0000${branchId}`;
  }

  subscribe(taskId: string, listener: (event: SyncEvent) => void): () => void {
    const set = this.subscribers.get(taskId) ?? new Set();
    set.add(listener);
    this.subscribers.set(taskId, set);
    // 重新打开任务时，内存里的草稿要立刻交给新订阅者；否则界面会先显示服务端旧文字。
    if (this.records.has(this.key(taskId))) this.emit(taskId);
    return () => {
      set.delete(listener);
      if (!set.size) this.subscribers.delete(taskId);
    };
  }

  private emit(taskId: string) {
    const record = this.records.get(this.key(taskId)) ?? null;
    const event: SyncEvent = { taskId, status: this.status(taskId), record, unsyncedCount: this.unsyncedTaskIds().length };
    for (const listener of this.subscribers.get(taskId) ?? []) listener(event);
    this.deps.onEvent?.(event);
  }

  private emitAll() {
    for (const taskId of new Set([...this.records.keys()].map((key) => key.split('\u0000')[0]))) this.emit(taskId);
  }

  status(taskId: string): SaveStatus {
    const key = this.key(taskId);
    const record = this.records.get(key);
    if (!record) return 'clean';
    if (this.storageFailed.has(key)) return 'storage-error';
    if (record.conflicts.title || record.conflicts.description) return 'conflict';
    if (record.blockedReason) return 'blocked';
    if (record.outbox) return this.retryExhausted.has(key) ? 'local-only' : 'saving';
    if ((this.durableVersions.get(key) ?? 0) < record.recordVersion) return 'local-pending';
    if (!textEqual(record.draft, record.base)) return 'local-pending';
    return 'clean';
  }

  getRecord(taskId: string): TaskTextDraftV1 | null {
    return this.records.get(this.key(taskId)) ?? null;
  }

  unsyncedTaskIds(): string[] {
    const ids = new Set<string>();
    for (const [key, record] of this.records) {
      const taskId = key.split('\u0000')[0];
      if (textEqual(record.draft, record.base) && !record.outbox) continue;
      ids.add(taskId);
    }
    return [...ids];
  }

  // ---------- 分支 ----------

  private lockName(record: { scopeKey: string; taskId: string; branchId: string }) {
    return `${record.scopeKey}/${record.taskId}/${record.branchId}`;
  }

  /** 打开任务的编辑分支；多份不同遗留草稿时返回暂停列表，等用户显式选择。 */
  async openTask(taskId: string, base: TextVersion): Promise<OpenTaskResult> {
    const key = this.key(taskId);
    const existing = await this.deps.store.load(this.scopeKey, taskId);
    const mine = existing.find((record) => record.branchId === this.branchId);
    if (mine && !this.records.has(key)) {
      this.records.set(key, mine);
      this.durableVersions.set(key, mine.recordVersion);
      this.mergeExternal(taskId, base, { immediate: true });
      this.flushQueuedEdit(taskId);
      if (mine.outbox) void this.pump(taskId);
      return { record: this.records.get(key)!, staleBranches: [] };
    }
    if (mine) {
      this.flushQueuedEdit(taskId);
      return { record: this.records.get(key) ?? mine, staleBranches: [] };
    }
    const others = existing.filter((record) => record.branchId !== this.branchId);
    if (this.deps.locks) {
      const adoptable: TaskTextDraftV1[] = [];
      for (const other of others) {
        if (await this.deps.locks.tryHold(this.lockName(other))) adoptable.push(other);
      }
      const liveCount = others.length - adoptable.length;
      if (liveCount === 0 && adoptable.length === 1) {
        const adopted = await this.adopt(taskId, adoptable[0], base);
        this.flushQueuedEdit(taskId);
        return { record: this.records.get(key) ?? adopted, staleBranches: [] };
      }
      if (liveCount === 0 && adoptable.length > 1) {
        this.pausedStale.set(taskId, adoptable);
        const record = this.createRecord(taskId, base);
        this.records.set(key, record);
        this.flushQueuedEdit(taskId);
        return { record: this.records.get(key) ?? record, staleBranches: adoptable };
      }
    }
    const record = this.createRecord(taskId, base);
    this.records.set(key, record);
    this.flushQueuedEdit(taskId);
    void this.persist(taskId, record);
    return { record: this.records.get(key) ?? record, staleBranches: this.pausedStale.get(taskId) ?? [] };
  }

  /** 显式恢复一个遗留分支为当前窗口的编辑内容；不删除其他分支。 */
  async restoreBranch(taskId: string, branchId: string): Promise<TaskTextDraftV1 | null> {
    const existing = await this.deps.store.load(this.scopeKey, taskId);
    const target = existing.find((record) => record.branchId === branchId);
    if (!target) return null;
    const adopted = await this.adopt(taskId, target, target.base);
    this.pausedStale.delete(taskId);
    return adopted;
  }

  private async adopt(taskId: string, source: TaskTextDraftV1, base: TextVersion): Promise<TaskTextDraftV1> {
    const record: TaskTextDraftV1 = {
      ...source,
      branchId: this.branchId,
      recordVersion: source.recordVersion + 1,
      updatedAt: this.deps.now(),
    };
    const key = this.key(taskId);
    this.records.set(key, record);
    this.durableVersions.set(key, source.recordVersion);
    this.storageFailed.delete(key);
    await this.persist(taskId, record);
    // 旧分支记录只有在迁移写入成功后才移除；失败时保留双份，用户可重新选择。
    await this.deps.store.deleteBranch(this.scopeKey, taskId, source.branchId).catch(() => {});
    this.mergeExternal(taskId, base, { immediate: true });
    if (record.outbox) void this.pump(taskId);
    return record;
  }

  private createRecord(taskId: string, base: TextVersion): TaskTextDraftV1 {
    return {
      schemaVersion: 1,
      scopeKey: this.scopeKey,
      taskId,
      branchId: this.branchId,
      recordVersion: 1,
      editSeq: 0,
      base: { ...base },
      draft: { title: base.title, description: base.description },
      outbox: null,
      conflicts: {},
      blockedReason: null,
      retryCount: 0,
      nextRetryAt: null,
      updatedAt: this.deps.now(),
    };
  }

  /** 用户明确放弃当前分支，或确认内容已解决后删除。 */
  async discardBranch(taskId: string, branchId = this.branchId): Promise<void> {
    await this.deps.store.deleteBranch(this.scopeKey, taskId, branchId);
    if (branchId === this.branchId) {
      this.records.delete(this.key(taskId));
      this.emit(taskId);
    }
  }

  // ---------- 编辑与本地持久化 ----------

  private waitComposition(taskId: string): Promise<void> {
    if (!this.composing.has(taskId)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.compositionWaiters.get(taskId) ?? [];
      list.push(resolve);
      this.compositionWaiters.set(taskId, list);
    });
  }

  setComposing(taskId: string, composing: boolean) {
    if (composing) {
      this.composing.add(taskId);
      this.cancelDebounce(taskId);
    } else {
      this.composing.delete(taskId);
      const waiters = this.compositionWaiters.get(taskId);
      this.compositionWaiters.delete(taskId);
      waiters?.forEach((resolve) => resolve());
      // 组词结束后安排 now + 800ms 保存；编辑器的最终 onUserEdit 会再刷新计时。
      const record = this.records.get(this.key(taskId));
      if (record && !textEqual(record.draft, record.base)) this.scheduleSave(taskId, EDIT_DEBOUNCE_MS);
    }
  }

  isComposing(taskId: string) {
    return this.composing.has(taskId);
  }

  onUserEdit(taskId: string, nextText: TaskText) {
    const key = this.key(taskId);
    const record = this.records.get(key);
    if (!record) {
      this.queuedEdits.set(taskId, { ...nextText });
      return;
    }
    if (record.blockedReason === 'readonly' || record.blockedReason === 'not-found') return;
    this.queuedEdits.delete(taskId);
    record.draft = { ...nextText };
    record.editSeq += 1;
    record.recordVersion += 1;
    record.updatedAt = this.deps.now();
    this.storageFailed.delete(key);
    void this.persist(taskId, record);
    if (this.composing.has(taskId)) return;
    this.scheduleSave(taskId, EDIT_DEBOUNCE_MS);
  }

  private flushQueuedEdit(taskId: string) {
    const queued = this.queuedEdits.get(taskId);
    if (!queued || !this.records.has(this.key(taskId))) return;
    this.onUserEdit(taskId, queued);
  }

  private cancelDebounce(taskId: string) {
    this.debounceTimers.get(taskId)?.();
    this.debounceTimers.delete(taskId);
  }

  private scheduleSave(taskId: string, ms: number) {
    this.cancelDebounce(taskId);
    const cancel = this.deps.schedule(() => {
      this.debounceTimers.delete(taskId);
      void this.pump(taskId);
    }, ms);
    this.debounceTimers.set(taskId, cancel);
  }

  /** 本地状态更新按记录串行持久化；旧的异步写入不能覆盖新 recordVersion。 */
  private persist(taskId: string, record: TaskTextDraftV1): Promise<void> {
    const key = this.key(taskId);
    const snapshot: TaskTextDraftV1 = structuredClone(record);
    const chain = (this.persistChains.get(key) ?? Promise.resolve())
      .then(() => this.deps.store.put(snapshot))
      .then(() => {
        this.durableVersions.set(key, Math.max(this.durableVersions.get(key) ?? 0, snapshot.recordVersion));
        this.storageFailed.delete(key);
        this.emit(taskId);
      })
      .catch(() => {
        this.storageFailed.add(key);
        this.emit(taskId);
      });
    this.persistChains.set(key, chain);
    return chain;
  }

  private async waitForPersist(taskId: string): Promise<boolean> {
    await this.persistChains.get(this.key(taskId));
    return !this.storageFailed.has(this.key(taskId));
  }

  // ---------- 同步 ----------

  /** 触发一次同步。已在运行时返回同一个 Promise。 */
  pump(taskId: string): Promise<void> {
    const running = this.pumping.get(taskId);
    if (running) return running;
    const run = this.runPump(taskId).finally(() => {
      if (this.pumping.get(taskId) === run) this.pumping.delete(taskId);
      this.emit(taskId);
    });
    this.pumping.set(taskId, run);
    return run;
  }

  private async runPump(taskId: string): Promise<void> {
    if (this.disposed) return;
    const key = this.key(taskId);
    const record = this.records.get(key);
    if (!record) return;
    if (!this.deps.isAuthed()) return;
    if (this.composing.has(taskId)) return;
    if (record.conflicts.title || record.conflicts.description) return;
    if (record.blockedReason) return;
    if (this.pausedStale.has(taskId)) return;

    if (!(await this.waitForPersist(taskId))) return;

    // 文字保存与状态、日期等其他任务写入共享同一条任务写入锁。
    await this.deps.enqueue([taskId], async () => {
      if (this.disposed) return;
      const current = this.records.get(key);
      if (!current) return;
      if (current.outbox) {
        await this.deliver(taskId, current.outbox);
        return;
      }
      const body: { expectedRevision: number; title?: string; description?: string } = { expectedRevision: current.base.revision };
      if (!sameFieldText('title', current.draft.title, current.base.title)) body.title = current.draft.title.trim();
      if (current.draft.description !== current.base.description) body.description = current.draft.description;
      if (body.title === undefined && body.description === undefined) {
        this.finishClean(taskId);
        return;
      }
      if (!current.draft.title.trim()) {
        current.blockedReason = 'invalid-title';
        current.recordVersion += 1;
        await this.persist(taskId, current);
        this.emit(taskId);
        return;
      }
      const pending = {
        requestId: this.deps.newRequestId(),
        kind: 'text' as const,
        method: 'PATCH' as const,
        path: `/api/tasks/${taskId}`,
        bodyJson: JSON.stringify(body),
        base: { ...current.base },
        sentText: { title: current.draft.title, description: current.draft.description },
        sentEditSeq: current.editSeq,
        createdAt: this.deps.now(),
      };
      current.outbox = pending;
      current.recordVersion += 1;
      // outbox 持久化成功后才能发请求。
      await this.persist(taskId, current);
      if (this.storageFailed.has(key)) {
        current.outbox = null;
        return;
      }
      await this.deliver(taskId, pending);
    });
  }

  private async deliver(taskId: string, pending: NonNullable<TaskTextDraftV1['outbox']>): Promise<void> {
    if (!pending) return;
    const key = this.key(taskId);
    const outcome = await this.deps.send({ requestId: pending.requestId, method: pending.method, path: pending.path, bodyJson: pending.bodyJson });
    const record = this.records.get(key);
    // 离开详情或切换任务后，旧请求的回包只允许处理仍在本窗口的同一记录。
    if (!record || record.outbox?.requestId !== pending.requestId) return;
    if (outcome.kind === 'success') {
      this.acknowledge(taskId, pending, outcome.body);
      return;
    }
    if (outcome.kind === 'network' || outcome.status >= 500) {
      // 请求超时、断线、5xx：保留 outbox，同一 requestId 幂等重试。
      record.retryCount += 1;
      record.updatedAt = this.deps.now();
      if (record.retryCount <= RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[record.retryCount - 1];
        record.nextRetryAt = this.deps.now() + delay;
        record.recordVersion += 1;
        await this.persist(taskId, record);
        this.scheduleRetry(taskId, delay);
      } else {
        record.nextRetryAt = null;
        record.recordVersion += 1;
        this.retryExhausted.add(key);
        await this.persist(taskId, record);
      }
      this.emit(taskId);
      return;
    }
    if (CONFLICT_CODES.includes(outcome.code ?? '') || (pending.kind === 'reference' && outcome.kind === 'rejected')) {
      if (pending.kind === 'reference' && outcome.status !== 409 && outcome.status !== 412) {
        // 资料版本或权限冲突：保留本地正文，停止自动重试并提示处理。
        record.outbox = null;
        record.blockedReason = 'reference-conflict';
        record.retryCount = 0;
        record.nextRetryAt = null;
        record.recordVersion += 1;
        await this.persist(taskId, record);
        this.emit(taskId);
        return;
      }
      // 版本冲突：请求已明确失败，可清除该 outbox，再读取远端做三方合并。
      record.outbox = null;
      record.recordVersion += 1;
      await this.persist(taskId, record);
      await this.resolveConflict(taskId);
      return;
    }
    // 4xx：保存草稿，设置对应 blockedReason，停止定时重试。
    if (outcome.status === 401) record.blockedReason = 'auth';
    else if (outcome.status === 403) record.blockedReason = 'readonly';
    else if (outcome.status === 404) record.blockedReason = 'not-found';
    else record.blockedReason = 'invalid-input';
    record.retryCount = 0;
    record.nextRetryAt = null;
    record.recordVersion += 1;
    await this.persist(taskId, record);
    this.emit(taskId);
  }

  private scheduleRetry(taskId: string, delay: number) {
    this.retryTimers.get(taskId)?.();
    const cancel = this.deps.schedule(() => {
      this.retryTimers.delete(taskId);
      void this.pump(taskId);
    }, delay);
    this.retryTimers.set(taskId, cancel);
  }

  /**
   * 资料引用的整篇正文提交：命令与目标正文写入持久化 outbox 后经统一通道发送。
   * 本地富文本事务已在调用方应用；这里只负责网络与确认。
   */
  async sendReference(taskId: string, command: unknown, newDescription: string): Promise<boolean> {
    await this.waitComposition(taskId);
    this.cancelDebounce(taskId);
    const key = this.key(taskId);
    const record = this.records.get(key);
    if (!record) return false;
    if (record.outbox) await this.pump(taskId);
    const current = this.records.get(key);
    if (!current || current.outbox) return false;
    if (!(await this.waitForPersist(taskId))) return false;
    const requestId = this.deps.newRequestId();
    const body = { requestId, commands: [command] };
    const pending: NonNullable<TaskTextDraftV1['outbox']> = {
      requestId,
      kind: 'reference',
      method: 'POST',
      path: '/api/v1/commands',
      bodyJson: JSON.stringify(body),
      base: { ...current.base },
      sentText: { ...current.draft },
      sentEditSeq: current.editSeq,
      createdAt: this.deps.now(),
    };
    current.draft = { ...current.draft, description: newDescription };
    current.editSeq += 1;
    current.outbox = pending;
    current.blockedReason = null;
    current.recordVersion += 1;
    await this.persist(taskId, current);
    if (this.storageFailed.has(key)) {
      current.outbox = null;
      return false;
    }
    await this.deps.enqueue([taskId], async () => {
      if (this.disposed) return;
      await this.deliver(taskId, pending);
    });
    const latest = this.records.get(key);
    return !latest?.blockedReason && !latest?.conflicts.description;
  }

  private acknowledge(taskId: string, pending: NonNullable<TaskTextDraftV1['outbox']>, body: unknown) {
    const key = this.key(taskId);
    const record = this.records.get(key);
    if (!record || record.outbox?.requestId !== pending.requestId) return;
    const server = asTextVersion(bodyTask(body) ?? {}, pending.base);
    // 请求期间用户继续输入的内容不能被 ACK 覆盖。
    const draft: TaskText = { title: record.draft.title, description: record.draft.description };
    if (draft.title === pending.sentText.title) draft.title = server.title;
    if (draft.description === pending.sentText.description) draft.description = server.description;
    record.base = { revision: server.revision, title: server.title, description: server.description };
    record.draft = draft;
    record.outbox = null;
    record.retryCount = 0;
    record.nextRetryAt = null;
    if (record.blockedReason === 'auth' || record.blockedReason === 'invalid-input') record.blockedReason = null;
    record.recordVersion += 1;
    record.updatedAt = this.deps.now();
    this.retryExhausted.delete(key);
    void this.persist(taskId, record).then(() => {
      const latest = this.records.get(key);
      if (!latest) return;
      const queued = this.pendingExternal.get(taskId);
      this.pendingExternal.delete(taskId);
      if (queued) this.mergeExternal(taskId, queued, { immediate: true });
      if (textEqual(latest.draft, latest.base) && !latest.outbox) {
        // 已解决内容：条件删除；出现更新版本时删除失败，新版本仍存在。
        void this.deps.store.deleteIfResolved(this.scopeKey, taskId, this.branchId, {
          recordVersion: latest.recordVersion,
          outboxEmpty: true,
          text: latest.draft,
        }).then(() => this.emit(taskId));
        return;
      }
      if (!textEqual(latest.draft, latest.base)) this.scheduleSave(taskId, EDIT_DEBOUNCE_MS);
    });
    this.emit(taskId);
  }

  private finishClean(taskId: string) {
    const key = this.key(taskId);
    this.retryExhausted.delete(key);
    const queued = this.pendingExternal.get(taskId);
    this.pendingExternal.delete(taskId);
    if (queued) this.mergeExternal(taskId, queued, { immediate: true });
    const record = this.records.get(key);
    if (record && textEqual(record.draft, record.base) && !record.outbox) {
      void this.deps.store.deleteIfResolved(this.scopeKey, taskId, this.branchId, {
        recordVersion: record.recordVersion,
        outboxEmpty: true,
        text: record.draft,
      }).then(() => this.emit(taskId));
    }
    this.emit(taskId);
  }

  private async resolveConflict(taskId: string) {
    const key = this.key(taskId);
    const record = this.records.get(key);
    if (!record) return;
    const remote = await this.deps.fetchTaskText(taskId).catch(() => null);
    if (!remote) {
      record.blockedReason = 'not-found';
      record.recordVersion += 1;
      await this.persist(taskId, record);
      this.emit(taskId);
      return;
    }
    this.mergeExternal(taskId, remote, { immediate: true });
    const merged = this.records.get(key);
    if (!merged) return;
    if (!merged.conflicts.title && !merged.conflicts.description) {
      // 无字段冲突：基于新版本继续提交。
      this.scheduleSave(taskId, 0);
    }
  }

  /** 外部（其他窗口或其他客户端）更新到达时的三方合并入口。 */
  mergeExternal(taskId: string, remote: TextVersion, options: { immediate?: boolean } = {}) {
    const key = this.key(taskId);
    const record = this.records.get(key);
    if (!record) return;
    if (remote.revision < record.base.revision) {
      record.blockedReason = 'server-reset';
      record.recordVersion += 1;
      void this.persist(taskId, record);
      this.emit(taskId);
      return;
    }
    if (remote.revision === record.base.revision && textEqual(remote, record.base)) return;
    // 正在飞行中的请求：先缓存，等 acknowledge 之后再合并。
    if (!options.immediate && (record.outbox || this.pumping.has(taskId))) {
      const queued = this.pendingExternal.get(taskId);
      if (!queued || queued.revision < remote.revision) this.pendingExternal.set(taskId, remote);
      return;
    }
    const merged = mergeText(record.base, record.draft, remote);
    record.base = { ...remote };
    record.draft = merged.draft;
    record.conflicts = merged.conflicts;
    record.recordVersion += 1;
    record.updatedAt = this.deps.now();
    if (merged.conflicts.title || merged.conflicts.description) this.cancelDebounce(taskId);
    void this.persist(taskId, record);
    this.emit(taskId);
  }

  externalUpdate(taskId: string, remote: TextVersion) {
    this.mergeExternal(taskId, remote);
  }

  /** “使用我的内容”：只确认冲突字段，以远端版本为基线后正常提交。 */
  resolveConflictsKeepMine(taskId: string) {
    const record = this.records.get(this.key(taskId));
    if (!record) return;
    record.conflicts = {};
    record.recordVersion += 1;
    void this.persist(taskId, record);
    this.scheduleSave(taskId, 0);
  }

  /** “使用最新内容”：只替换冲突字段，不影响另一字段未同步的修改。 */
  resolveConflictsKeepRemote(taskId: string) {
    const record = this.records.get(this.key(taskId));
    if (!record) return;
    const conflicts = record.conflicts as Partial<Record<TextField, FieldConflict>>;
    for (const field of ['title', 'description'] as const) {
      const conflict = conflicts[field];
      if (conflict) record.draft[field] = conflict.remote;
    }
    record.conflicts = {};
    record.recordVersion += 1;
    void this.persist(taskId, record);
    this.emit(taskId);
  }

  // ---------- 离开与确认 ----------

  /** 本地草稿安全写入即可离开；不等远端保存。 */
  async prepareLeave(taskId: string): Promise<boolean> {
    await this.waitComposition(taskId);
    const key = this.key(taskId);
    const record = this.records.get(key);
    if (!record) return true;
    const persisted = await this.waitForPersist(taskId);
    if (persisted) {
      // 后台继续同步，不等待完成。
      void this.pump(taskId);
      return true;
    }
    if (textEqual(record.draft, record.base) && !record.outbox) return true;
    this.emit(taskId);
    return false;
  }

  /** 所有当前文字已获服务端确认、无冲突且无待发请求才返回 true。 */
  async ensureSaved(taskId: string): Promise<boolean> {
    await this.waitComposition(taskId);
    this.cancelDebounce(taskId);
    const key = this.key(taskId);
    if (!(await this.waitForPersist(taskId))) return false;
    await this.pump(taskId);
    const record = this.records.get(key);
    if (!record) return true;
    return textEqual(record.draft, record.base) && !record.outbox && !record.conflicts.title && !record.conflicts.description;
  }

  /** 登录失效时暂停网络同步，保留本地记录；重新认证同一 scope 后恢复。 */
  setAuthenticated(authed: boolean) {
    if (!authed) return;
    for (const key of [...this.records.keys()]) {
      const taskId = key.split('\u0000')[0];
      const record = this.records.get(key);
      if (!record) continue;
      if (record.blockedReason === 'auth') record.blockedReason = null;
      record.recordVersion += 1;
      void this.persist(taskId, record);
      if (!textEqual(record.draft, record.base) || record.outbox) this.scheduleSave(taskId, 0);
    }
    this.emitAll();
  }

  /** 是否存在尚未安全持久化的文字（beforeunload 保护范围）。 */
  hasUnpersistedWork() {
    for (const [key, record] of this.records) {
      if ((this.durableVersions.get(key) ?? 0) < record.recordVersion) return true;
    }
    return false;
  }

  listStaleBranches(taskId: string) {
    return this.pausedStale.get(taskId) ?? [];
  }

  dispose() {
    this.disposed = true;
    for (const cancel of this.debounceTimers.values()) cancel();
    for (const cancel of this.retryTimers.values()) cancel();
    this.debounceTimers.clear();
    this.retryTimers.clear();
  }
}
