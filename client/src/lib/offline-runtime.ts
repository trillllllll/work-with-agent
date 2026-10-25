import { t } from '../i18n/index.js';
import { canonicalSyncRow, isCompleteSyncRow, isSyncEntityType, mergeSyncRow, syncRowsEqual, type SyncEntityType, type SyncRow } from '../../../server/src/application/sync-merge.js';
import { DomainError } from '../../../server/src/domain/task.js';
import { emptyReplicaRows, OfflineStore, type BrowserReplica, type ReplicaOp, type ReplicaRows } from './offline-store.js';
import { mutateReplica, readReplica, replicaDto, supportedOfflinePath } from './offline-tasks.js';

type NetworkApi = (path: string, init?: RequestInit) => Promise<{ data: any; error: null }>;
const MARKER = 'dovun.offline.scope';
let current: BrowserOfflineRuntime | null = null;
const fingerprint = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const signalChange = (rowsChanged = true) => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('dovun-replica-change', { detail: { rowsChanged } })); };
const invalid = (): never => { throw new DomainError('SYNC_PROTOCOL_ERROR', t('workspace:offline.errors.protocol'), 502); };
function fileScope(scope: string | null) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready.then(registration => {
    (navigator.serviceWorker.controller ?? registration.active)?.postMessage({ type: 'dovun-offline-scope', scope });
  }).catch(() => {});
}
export const announceOfflineFileScope = fileScope;
export async function offlineFileAvailable(url: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return false;
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 2000);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data?.available === true); };
    navigator.serviceWorker.controller!.postMessage({ type: 'dovun-offline-file-status', url }, [channel.port2]);
  });
}
type Snapshot = { schemaVersion: string; tip: number; entities: Record<SyncEntityType, Array<{ id: string; row: SyncRow }>> };

function reproject(state: BrowserReplica) {
  const rows = structuredClone(state.base);
  for (const op of state.outbox) {
    const existing = rows[op.entityType][op.entityId];
    // Keep this device's unacknowledged fields visible while incorporating unrelated remote fields.
    const next = mergeSyncRow(op.entityType, op.after, op.before, existing?.row ?? null).row;
    if (!next) delete rows[op.entityType][op.entityId];
    else rows[op.entityType][op.entityId] = existing ? { ...existing, row: next } : { id: op.entityId, row: next, revision: 1, createdAt: String(next.createdAt ?? ''), updatedAt: new Date().toISOString() };
  }
  for (const entity of ['topic', 'tag', 'task'] as const) for (const [id, row] of Object.entries(rows[entity])) {
    const old = state.rows[entity][id];
    row.revision = old ? old.revision + (syncRowsEqual(entity, old.row, row.row) ? 0 : 1) : 1;
    row.updatedAt = old && syncRowsEqual(entity, old.row, row.row) ? old.updatedAt : new Date().toISOString();
  }
  state.rows = rows;
}

export class BrowserOfflineRuntime {
  readonly store: OfflineStore;
  private syncing: Promise<void> | null = null;
  private rowsChanged = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private authenticated = true;
  private owner = crypto.randomUUID();
  constructor(readonly scope: string, private network: NetworkApi, store = new OfflineStore()) { this.store = store; }
  async status() { return this.store.read(this.scope); }
  get workspaceId(): string | undefined { try { return JSON.parse(this.scope)[1]; } catch { return undefined; } }
  get needsRecovery() { return !this.authenticated; }
  pause() { this.authenticated = false; }
  resume() { this.authenticated = true; }
  dispose() { if (this.timer) clearInterval(this.timer); this.timer = undefined; window.removeEventListener('online', this.wake); window.removeEventListener('focus', this.wake); }
  start() {
    if (this.timer) return;
    this.timer = setInterval(this.wake, 5000);
    window.addEventListener('online', this.wake); window.addEventListener('focus', this.wake);
  }
  private wake = () => { void this.sync().catch(() => {}); };
  async request(path: string, init?: RequestInit): Promise<any | undefined> {
    const url = new URL(path, window.location.origin), method = (init?.method ?? 'GET').toUpperCase();
    if (url.origin !== window.location.origin) return undefined;
    if (url.pathname === '/api/v1/commands/preview' && method === 'POST') return this.preview(JSON.parse(String(init?.body ?? '{}')));
    if (!supportedOfflinePath(url.pathname, method)) return undefined;
    const state = await this.store.read(this.scope);
    if (!state?.ready) return undefined;
    if (method === 'GET') return { data: readReplica(state, url), error: null };
    const requestId = new Headers(init?.headers).get('X-Request-ID') ?? crypto.randomUUID();
    const raw = JSON.parse(String(init?.body ?? '{}'));
    const { previewToken, ...input } = raw;
    const hash = fingerprint([url.pathname, method, input]);
    const result = await this.store.update(this.scope, current => {
      if (!current?.ready) throw new Error('Offline replica is not ready');
      const receipt = current.receipts[requestId];
      if (receipt) {
        if (receipt.hash !== hash) throw new DomainError('REQUEST_ID_REUSED', t('workspace:offline.errors.requestReused'), 409);
        return { state: current, value: receipt.result };
      }
      const draft = structuredClone(current.rows);
      const changed = mutateReplica(draft, url.pathname, method, input, requestId, new Date().toISOString());
      if (changed.cascade) {
        const ticket = current.previews[String(previewToken)];
        if (!ticket || ticket.hash !== hash || ticket.versions !== fingerprint(current.rows) || ticket.expires < Date.now()) {
          const error = new DomainError('PREVIEW_REQUIRED', t('workspace:offline.errors.preview'), 428) as DomainError & { details?: unknown };
          error.details = { commands: [{ kind: this.kind(url.pathname, method), targetId: changed.result.id, input, offlinePath: url.pathname, offlineMethod: method }] };
          throw error;
        }
      }
      current.rows = draft;
      current.outbox.push(...changed.changes);
      delete current.previews[String(previewToken)];
      const envelope = { data: changed.result, error: null, meta: { affectedTaskIds: changed.affected } };
      current.receipts[requestId] = { hash, result: envelope };
      return { state: current, value: envelope };
    });
    signalChange(); this.wake();
    return result;
  }
  /** Translate only a version the owner actually read, after pending edits are confirmed.
   * Hub revisions are never substituted when the local task changed in the meantime. */
  async prepareOnline(path: string, init?: RequestInit): Promise<RequestInit | undefined> {
    if (!init?.method || ['GET', 'HEAD'].includes(init.method.toUpperCase()) || !/^\/api\/(?:v1\/(?:commands|handoffs|library|knowledge|runs|proposals)|chat|orchestrations)/.test(path)) return init;
    if (!this.authenticated) throw new DomainError('AUTH_REQUIRED', t('workspace:offline.errors.login'), 401);
    await this.sync();
    const state = (await this.status())!;
    if (state.outbox.length) throw new DomainError('SYNC_PENDING', t('workspace:offline.errors.pending'), 409);
    if (!init.body) return init;
    const body = JSON.parse(String(init.body));
    const revision = async (entity: SyncEntityType, id: string, expected: unknown) => {
      const local = state.rows[entity][id];
      if (!local || expected !== local.revision) throw new DomainError('VERSION_CONFLICT', t('workspace:offline.errors.version'), 409);
      const remote = entity === 'tag' ? (await this.network('/api/tags')).data.find((tag: any) => tag.id === id) : (await this.network(`/api/${entity === 'task' ? 'tasks' : 'topics'}/${encodeURIComponent(id)}?includeArchived=true`)).data;
      if (!remote) throw new DomainError('VERSION_CONFLICT', t('workspace:offline.errors.version'), 409);
      const remoteRow = canonicalSyncRow(entity, { ...remote, tagIds: remote.tagIds ?? remote.tags?.map((tag: any) => tag.id) });
      if (!syncRowsEqual(entity, local.row, remoteRow) || !Number.isSafeInteger(remote.revision)) throw new DomainError('VERSION_CONFLICT', t('workspace:offline.errors.version'), 409);
      return remote.revision;
    };
    for (const command of body.commands ?? []) {
      const entity = String(command.kind).split('.')[0];
      if (isSyncEntityType(entity) && command.targetId && command.expectedRevision !== undefined) command.expectedRevision = await revision(entity, command.targetId, command.expectedRevision);
    }
    if (body.expectedTaskRevision !== undefined) {
      const handoff = path.match(/^\/api\/v1\/handoffs\/([^/]+)/);
      const taskId = body.taskId ?? (handoff ? (await this.network(`/api/v1/handoffs/${handoff[1]}`)).data.taskId : null);
      if (!taskId) throw new DomainError('VERSION_CONFLICT', t('workspace:offline.errors.version'), 409);
      body.expectedTaskRevision = await revision('task', taskId, body.expectedTaskRevision);
      for (const [id, expected] of Object.entries(body.expectedChildRevisions ?? {})) body.expectedChildRevisions[id] = await revision('task', id, expected);
    }
    return { ...init, body: JSON.stringify(body) };
  }
  async afterOnline(path: string, init: RequestInit | undefined, value: any) {
    if (!init?.method || ['GET', 'HEAD'].includes(init.method.toUpperCase()) || !/^\/api\/(?:v1\/(?:commands|handoffs|library|knowledge|runs|proposals)|orchestrations)/.test(path)) return value;
    const committedCommands = new URL(path, window.location.origin).pathname === '/api/v1/commands' && value?.data?.status === 'applied';
    if (path.includes('/preview') || value?.data?.status === 'pending_approval' || path.includes('/proposals')) return value;
    // Only direct results of a confirmed command may update the local task view.
    // A preview.after or a frozen handoff snapshot is never a committed task.
    const results = committedCommands && Array.isArray(value.data.results) ? value.data.results : [];
    const observed = results.filter((item: any) => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.status === 'string' && isCompleteSyncRow('task', { ...item, tagIds: item.tagIds ?? item.tags?.map((tag: any) => tag.id) }));
    if (observed.length) await this.store.update(this.scope, state => {
      if (!state) throw new Error('Missing replica');
      for (const item of observed) state.base.task[item.id] = { id: item.id, row: canonicalSyncRow('task', { ...item, tagIds: item.tagIds ?? item.tags?.map((tag: any) => tag.id) })!, revision: 1, createdAt: item.createdAt, updatedAt: item.updatedAt };
      reproject(state); return { state, value: undefined };
    });
    // The server already confirmed this operation. A failed refresh is not a failed write.
    await this.sync().catch(() => {});
    const state = await this.status();
    if (committedCommands && state) return { ...value, data: { ...value.data, results: results.map((item: any) => observed.includes(item) && state.rows.task[item.id] ? { ...item, ...replicaDto(state.rows, 'task', state.rows.task[item.id], Array.isArray(item.children)) } : item) } };
    return value;
  }

  private kind(path: string, method: string) {
    const kind = path.includes('/topics') ? 'topic' : path.includes('/tags') ? 'tag' : 'task';
    return `${kind}.${path.endsWith('/restore') ? 'restore' : method === 'DELETE' ? 'delete' : method === 'PATCH' ? 'update' : path.endsWith('/reorder') ? 'reorder' : 'create'}`;
  }
  private async preview(body: any) {
    if (!Array.isArray(body.commands) || body.commands.length !== 1 || !body.commands[0]?.offlinePath) return undefined;
    const command = body.commands[0];
    if (!supportedOfflinePath(command.offlinePath, command.offlineMethod)) return undefined;
    return this.store.update(this.scope, state => {
      if (!state?.ready) throw new Error('Offline replica is not ready');
      const changed = mutateReplica(structuredClone(state.rows), command.offlinePath, command.offlineMethod, command.input, body.requestId, new Date().toISOString());
      const token = crypto.randomUUID();
      state.previews[token] = { hash: fingerprint([command.offlinePath, command.offlineMethod, command.input]), versions: fingerprint(state.rows), expires: Date.now() + 600_000 };
      return { state, value: { data: { previewToken: token, requiresConfirmation: changed.cascade, preview: [{ detail: { kind: command.kind, before: changed.before.task[command.targetId]?.row, input: command.input, affectedTasks: changed.affected.filter(id => changed.before.task[id]).map(id => replicaDto(changed.before, 'task', changed.before.task[id])) }, after: changed.result }] }, error: null } };
    });
  }
  sync() { return this.syncing ??= this.cycle().finally(() => { this.syncing = null; }); }
  private async device(path: string, init?: RequestInit) {
    const state = await this.status();
    if (!state) throw new Error('Missing replica');
    const response = await fetch(`/api/v1/sync${path}`, { ...init, credentials: 'omit', signal: AbortSignal.timeout(20_000), headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}`, 'x-dovun-workspace-id': state.workspaceId } });
    if (response.status === 401 || response.status === 403) { this.authenticated = false; throw new DomainError('SYNC_AUTH_FAILED', t('workspace:offline.errors.credential'), 502); }
    const body = await response.json();
    if (!response.ok || !body || body.data === undefined) throw new DomainError('SYNC_FAILED', t('workspace:offline.errors.failed'), 502);
    return body.data;
  }
  private async save(reduce: (state: BrowserReplica) => void) {
    await this.store.update(this.scope, state => {
      if (!state || state.lease?.owner !== this.owner) throw new Error('Replica lease changed');
      const before = fingerprint(state.rows);
      reduce(state); state.lease.until = Date.now() + 60_000;
      if (fingerprint(state.rows) !== before) this.rowsChanged = true;
      return { state, value: undefined };
    });
  }
  async bootstrap() {
    const state = await this.status(); if (!state) throw new Error('Missing replica');
    const snapshot: Snapshot = await this.device(`/baseline/snapshot?schemaVersion=${encodeURIComponent(state.schemaVersion)}`);
    if (snapshot.schemaVersion !== state.schemaVersion || !Number.isSafeInteger(snapshot.tip) || snapshot.tip < 0 || !snapshot.entities) invalid();
    const base = emptyReplicaRows();
    for (const entity of ['topic', 'tag', 'task'] as const) {
      if (!Array.isArray(snapshot.entities[entity])) invalid();
      for (const item of snapshot.entities[entity]) {
        if (typeof item.id !== 'string' || !item.id || base[entity][item.id] || !item.row || !isCompleteSyncRow(entity, item.row)) invalid();
        base[entity][item.id] = { id: item.id, row: canonicalSyncRow(entity, item.row)!, revision: 1, createdAt: String(item.row.createdAt ?? ''), updatedAt: new Date().toISOString() };
      }
    }
    await this.save(current => { current.base = base; current.cursor = snapshot.tip; current.ready = true; reproject(current); });
  }
  private async cycle() {
    if (!this.authenticated) return;
    const claimed = await this.store.update(this.scope, state => {
      if (!state) throw new Error('Missing replica');
      if (state.lease && state.lease.owner !== this.owner && state.lease.until > Date.now()) return { state, value: false };
      state.lease = { owner: this.owner, until: Date.now() + 60_000 }; return { state, value: true };
    });
    if (!claimed) return;
    this.rowsChanged = false;
    try {
      let state = (await this.status())!;
      // A cookie identity check is required before uploading private local edits.
      const identity = (await this.network('/api/v1/sync/identity')).data;
      if (identity.workspaceId !== state.workspaceId) { this.authenticated = false; throw new DomainError('WORKSPACE_CHANGED', t('workspace:offline.errors.workspace'), 409); }
      if (identity.schemaVersion !== state.schemaVersion) throw new DomainError('SCHEMA_MISMATCH', t('workspace:offline.errors.schema'), 409);
      await this.save(current => { current.authenticatedAt = Date.now(); });
      if (!state.ready) await this.bootstrap();
      state = (await this.status())!;
      const pending = state.outbox.slice(0, 50);
      if (pending.length) {
        const receipt = await this.device('/push', { method: 'POST', body: JSON.stringify({ schemaVersion: state.schemaVersion, ops: pending }) });
        if (!Number.isSafeInteger(receipt.tip) || receipt.tip < 0 || !Array.isArray(receipt.results) || receipt.results.length !== pending.length) invalid();
        const seen = new Set<string>();
        for (const item of receipt.results) {
          const op = pending.find(op => op.opId === item.opId);
          if (!op || seen.has(item.opId) || !['applied', 'conflict', 'duplicate'].includes(item.status) || !isCompleteSyncRow(op.entityType, item.landed) || (item.seq !== null && (!Number.isSafeInteger(item.seq) || item.seq < 1 || item.seq > receipt.tip))) invalid();
          seen.add(item.opId);
        }
        await this.save(current => {
          for (const item of receipt.results) {
            const op = pending.find(op => op.opId === item.opId)!;
            if (item.seq !== null && item.seq > current.cursor) {
              if (item.landed) current.base[op.entityType][op.entityId] = { id: op.entityId, row: item.landed, revision: 1, createdAt: String(item.landed.createdAt ?? ''), updatedAt: new Date().toISOString() };
              else delete current.base[op.entityType][op.entityId];
            }
          }
          current.outbox = current.outbox.filter(op => !seen.has(op.opId)); reproject(current);
        });
      }
      for (;;) {
        state = (await this.status())!;
        const page = await this.device(`/pull?after=${state.cursor}&limit=100`);
        if (page.schemaVersion !== state.schemaVersion || !Number.isSafeInteger(page.tip) || page.tip < state.cursor || !Array.isArray(page.ops)) invalid();
        let cursor = state.cursor;
        let gap = false;
        const seen = new Set<string>();
        for (const op of page.ops) {
          if (!Number.isSafeInteger(op.seq) || op.seq <= cursor || op.seq > page.tip || !isSyncEntityType(op.entityType) || typeof op.opId !== 'string' || seen.has(op.opId) || typeof op.entityId !== 'string' || !op.entityId || !isCompleteSyncRow(op.entityType, op.before) || !isCompleteSyncRow(op.entityType, op.after)) invalid();
          if (op.seq !== cursor + 1) gap = true;
          cursor = op.seq; seen.add(op.opId);
        }
        if (gap || !page.ops.length && page.tip !== state.cursor) { await this.bootstrap(); break; }
        await this.save(current => {
          if (current.cursor !== state.cursor) throw new Error('Replica cursor changed');
          for (const op of page.ops as Array<ReplicaOp & { seq: number }>) {
            if (op.after) current.base[op.entityType][op.entityId] = { id: op.entityId, row: op.after, revision: 1, createdAt: String(op.after.createdAt ?? ''), updatedAt: new Date().toISOString() };
            else delete current.base[op.entityType][op.entityId];
            current.cursor = op.seq;
          }
          reproject(current);
        });
        if (!page.ops.length || cursor >= page.tip) break;
      }
      await this.save(current => { current.lastSuccessAt = new Date().toISOString(); current.lastError = null; });
    } catch (error) {
      await this.save(current => { current.lastError = error instanceof DomainError ? error.code : 'SYNC_UNAVAILABLE'; }).catch(() => {});
      throw error;
    } finally {
      await this.store.update(this.scope, state => { if (!state) throw new Error('Missing replica'); if (state.lease?.owner === this.owner) delete state.lease; return { state, value: undefined }; });
      signalChange(this.rowsChanged);
    }
  }
}

export async function enableBrowserReplica(actorId: string, mode: 'local' | 'server', network: NetworkApi) {
  if (mode !== 'server') { current?.dispose(); current = null; return; }
  const identity = (await network('/api/v1/sync/identity')).data;
  if (typeof identity.workspaceId !== 'string' || typeof identity.schemaVersion !== 'string') invalid();
  const scope = JSON.stringify([location.origin, identity.workspaceId, actorId]);
  if (current?.scope === scope) {
    const runtime = current;
    runtime.resume();
    try {
      try { await runtime.sync(); }
      catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'SYNC_AUTH_FAILED') throw error;
        const pair = (await network('/api/v1/sync/devices', { method: 'POST', body: JSON.stringify({ name: 'browser' }) })).data;
        await runtime.store.update(scope, state => ({ state: { ...state!, token: pair.token }, value: undefined }));
        runtime.resume(); await runtime.sync();
      }
      await runtime.store.update(scope, state => ({ state: { ...state!, authenticatedAt: Date.now() }, value: undefined }));
      runtime.start(); fileScope(scope);
    } catch (error) { runtime.pause(); throw error; }
    return;
  }

  current?.dispose();
  const runtime = new BrowserOfflineRuntime(scope, network);
  await runtime.store.update(scope, state => {
    if (!state) return { state: { scope, workspaceId: identity.workspaceId, schemaVersion: identity.schemaVersion, actorId, token: '', authenticatedAt: Date.now(), ready: false, cursor: 0, base: emptyReplicaRows(), rows: emptyReplicaRows(), outbox: [], receipts: {}, previews: {}, lastSuccessAt: null, lastError: null }, value: undefined };
    state.authenticatedAt = Date.now(); state.schemaVersion = identity.schemaVersion; return { state, value: undefined };
  });
  const saved = (await runtime.status())!;
  if (!saved.token) {
    const pair = (await network('/api/v1/sync/devices', { method: 'POST', body: JSON.stringify({ name: 'browser' }) })).data;
    await runtime.store.update(scope, state => ({ state: { ...state!, token: pair.token }, value: undefined }));
  }
  try { await runtime.sync(); }
  catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'SYNC_AUTH_FAILED') throw error;
    const pair = (await network('/api/v1/sync/devices', { method: 'POST', body: JSON.stringify({ name: 'browser' }) })).data;
    await runtime.store.update(scope, state => ({ state: { ...state!, token: pair.token }, value: undefined }));
    runtime.resume(); await runtime.sync();
  }
  localStorage.setItem(MARKER, scope); current = runtime; runtime.start(); fileScope(scope); signalChange();
}
export async function restoreOfflineBrowserReplica(network: NetworkApi): Promise<string | null> {
  const scope = localStorage.getItem(MARKER); if (!scope) return null;
  const runtime = new BrowserOfflineRuntime(scope, network), state = await runtime.status();
  if (!state?.ready || Date.now() - state.authenticatedAt > 7 * 86400_000) return null;
  const identity = JSON.parse(scope);
  if (identity[0] !== location.origin) return null;
  current?.dispose(); current = runtime; runtime.pause(); fileScope(scope); signalChange();
  return state.actorId;
}
export function browserReplica() { return current; }
export function pauseBrowserReplica() { current?.pause(); fileScope(null); }
export async function offlineRequest(path: string, init?: RequestInit) { return current?.request(path, init); }
export const cacheableOfflineRead = (path: string, method = 'GET') => method.toUpperCase() === 'GET' && /^\/api\/(?:conversations(?:\/|\?|$)|v1\/library(?:\/|\?|$)|v1\/knowledge(?:\/|\?|$)|plan\/|focus-sessions(?:\?|$)|stats\/|skills(?:\/|\?|$))/.test(path) && !/\/(?:file|download|raw)(?:\?|$)/.test(path);
export async function cachedOfflineRead(path: string, runtime: BrowserOfflineRuntime | null) { return runtime?.store.cached(runtime.scope, path); }
export async function cacheOfflineRead(path: string, value: unknown, runtime: BrowserOfflineRuntime | null) { if (runtime) await runtime.store.cache(runtime.scope, path, value).catch(() => {}); }
