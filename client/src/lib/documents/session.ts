import { assertWritableContent, canonicalContent, type DocumentContent } from '../../../../server/src/domain/document-content.js';
import type { DocumentDraft, DocumentDraftStorage, DocumentFailure, DocumentReceipt, DocumentSnapshot, DocumentTransport, DocumentUpload, DraftBlock, DraftContent, NewDocument, ResourceDocument, UploadBlock } from './types.js';
import { relativeAssetPath, type RelativeReference } from './markdown-assets.js';

export const DOCUMENT_PERSIST_MS = 250;
export const DOCUMENT_SAVE_MS = 2_000;
export const DOCUMENT_CHECKPOINT_MS = 10_000;
export const HISTORY_BYTE_LIMIT = 16 * 1024 * 1024;
export const HISTORY_STEP_LIMIT = 100;
/** A typing pause of this length starts a new undo step. */
export const HISTORY_PAUSE_MS = 500;
/** Uninterrupted typing is still split so one undo never discards more than this much work. */
export const HISTORY_GROUP_MAX_MS = 5_000;

export type DocumentSessionDeps = {
  store: DocumentDraftStorage;
  transport: DocumentTransport;
  scopeKey: string;
  deviceId: string;
  sessionId: string;
  isActive: () => boolean;
  now?: () => number;
  newId?: () => string;
  schedule?: (fn: () => void, delay: number) => () => void;
  hash?: (content: DocumentContent) => Promise<string>;
  /** A lock is retained until the registry is disposed. Absent locks require explicit branch recovery. */
  holdBranch?: (key: string) => Promise<boolean>;
  onIdentity?: (session: DocumentSession, resourceId: string) => void;
};

async function contentHash(content: DocumentContent) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalContent(content)));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
function equal(left: unknown, right: unknown) { return canonicalContent(left) === canonicalContent(right); }
function copyReferences(references?: RelativeReference[]) { return (references ?? []).map(({ path, resourceId, revision }) => ({ path, resourceId, revision })).sort((a, b) => a.path.localeCompare(b.path)); }
function referenceEqual(left?: RelativeReference[], right?: RelativeReference[]) { return equal(copyReferences(left), copyReferences(right)); }
function documentBase(resource: ResourceDocument) { return { revision: resource.revision, content: structuredClone(resource.content), contentHash: resource.contentHash, relativeReferences: copyReferences(resource.relativeReferences) }; }
function failure(error: unknown, code = 'DOCUMENT_ERROR'): DocumentFailure {
  const detail = error as { code?: string; message?: string; status?: number } | null;
  return { code: detail?.code ?? code, message: detail?.message ?? String(error), ...(detail?.status ? { status: detail.status } : {}) };
}
function walkBlocks(blocks: DraftBlock[], visit: (block: DraftBlock) => DraftBlock | null): DraftBlock[] {
  return blocks.flatMap((block) => {
    const next = visit(block);
    if (!next) return [];
    return [{ ...next, ...('children' in next && next.children ? { children: walkBlocks(next.children, visit) } : {}) }];
  });
}
export function uploadIds(content: DraftContent) {
  const ids = new Set<string>();
  if (typeof content !== 'string') walkBlocks(content.blocks, (block) => { if (block.kind === 'upload') ids.add(block.uploadId); return block; });
  return ids;
}
function insertBlock(content: Exclude<DraftContent, string>, node: UploadBlock, bookmark?: string): DraftContent {
  let inserted = false;
  const insert = (blocks: DraftBlock[]): DraftBlock[] => blocks.flatMap((block) => {
    const next = 'children' in block && block.children ? { ...block, children: insert(block.children) } : block;
    if (block.id === bookmark) { inserted = true; return [next, node]; }
    return [next];
  });
  const blocks = insert(content.blocks);
  if (!inserted) blocks.push(node);
  return { ...content, blocks };
}

/** One editable resource session; views share this object and never own network writes. */
export class DocumentSession {
  private record: DocumentDraft;
  private snapshot!: DocumentSnapshot;
  private listeners = new Set<() => void>();
  private staleBranches: DocumentDraft[] = [];
  private durableVersion = 0;
  private storageError: DocumentFailure | null = null;
  private networkUnavailable = false;
  private active = true;
  private composing = false;
  private pendingRemote: ResourceDocument | null = null;
  private editorFlushers = new Map<string, () => boolean>();
  private pendingEditors = new Set<string>();
  private orphanedEditors = new Set<string>();
  private flushingEditors = false;
  private persistChain: Promise<void> = Promise.resolve();
  private pumping: Promise<void> | null = null;
  private uploading = new Set<string>();
  private files = new Map<string, Blob>();
  private cancelPersist?: () => void;
  private cancelSave?: () => void;
  private cancelCheckpoint?: () => void;
  private undoStack: Array<{ content: DraftContent; bytes: number }> = [];
  private redoStack: Array<{ content: DraftContent; bytes: number }> = [];
  private lastEditAt = -Infinity;
  private groupStartedAt = -Infinity;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  private constructor(private readonly deps: DocumentSessionDeps, record: DocumentDraft) {
    this.record = record;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.schedule = deps.schedule ?? ((fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); });
    this.emit();
  }

  static async open(deps: DocumentSessionDeps, resource: ResourceDocument) {
    const session = new DocumentSession(deps, this.initial(deps, resource));
    try {
      const drafts = (await deps.store.load(deps.scopeKey, resource.id)).filter((item) => item.deviceId === deps.deviceId);
      const own = drafts.find((item) => item.sessionId === deps.sessionId);
      if (own) { session.record = structuredClone(own); session.durableVersion = own.recordVersion; }
      else {
        const recoverable: DocumentDraft[] = [];
        for (const draft of drafts) {
          if (!draft.pending && !draft.organizationPending && !draft.editorRecovery?.length && draft.title === draft.confirmedTitle && !draft.blocked && !draft.conflict && !uploadIds(draft.content).size && equal(draft.content, resource.content) && referenceEqual(draft.relativeReferences, resource.relativeReferences)) continue;
          if (!deps.holdBranch || await deps.holdBranch(session.branchKey(draft))) recoverable.push(draft);
        }
        if (deps.holdBranch && recoverable.length === 1) await session.adopt(recoverable[0]);
        else session.staleBranches = recoverable;
      }
      if (deps.holdBranch) await deps.holdBranch(session.branchKey(session.record));
      session.receiveRemote(resource);
      await session.flushLocal();
    } catch (error) { session.storageError = failure(error, 'STORAGE_ERROR'); }
    session.emit();
    return session;
  }

  static async create(deps: DocumentSessionDeps, input: NewDocument) {
    const newId = deps.newId ?? (() => crypto.randomUUID());
    const record: DocumentDraft = {
      schemaVersion: 1, scopeKey: deps.scopeKey, localId: `local-${newId()}`, resourceId: null,
      deviceId: deps.deviceId, sessionId: deps.sessionId, recordVersion: 1, editSeq: 1, confirmedSeq: 0,
      updatedAt: (deps.now ?? Date.now)(), title: input.title, confirmedTitle: input.title, organizationRevision: 0, organizationPending: null, format: input.format,
      contentSchemaVersion: input.schemaVersion ?? (input.format === 'richdoc-v1' ? 1 : null),
      topicId: input.topicId ?? null, folderId: input.folderId ?? null, content: structuredClone(input.content), relativeReferences: copyReferences(input.relativeReferences),
      base: { revision: 0, content: structuredClone(input.content), contentHash: '' }, readOnly: false,
      pending: null, conflict: null, blocked: null, uploads: [],
    };
    const session = new DocumentSession(deps, record);
    if (deps.holdBranch) await deps.holdBranch(session.branchKey(record));
    await session.flushLocal();
    session.scheduleSave();
    return session;
  }

  private static initial(deps: DocumentSessionDeps, resource: ResourceDocument): DocumentDraft {
    return {
      schemaVersion: 1, scopeKey: deps.scopeKey, localId: resource.id, resourceId: resource.id,
      deviceId: deps.deviceId, sessionId: deps.sessionId, recordVersion: 1, editSeq: 0, confirmedSeq: 0,
      updatedAt: (deps.now ?? Date.now)(), title: resource.title, confirmedTitle: resource.title, organizationRevision: resource.organizationRevision, organizationPending: null, format: resource.format,
      contentSchemaVersion: resource.schemaVersion, topicId: resource.topicId ?? null, folderId: resource.folderId ?? null,
      content: structuredClone(resource.content), relativeReferences: copyReferences(resource.relativeReferences), base: documentBase(resource),
      readOnly: resource.readOnly, pending: null, conflict: null, blocked: null, uploads: [],
    };
  }

  static async restore(deps: DocumentSessionDeps, source: DocumentDraft) {
    if (source.scopeKey !== deps.scopeKey || source.deviceId !== deps.deviceId) throw new Error('The draft belongs to another workspace or device');
    const session = new DocumentSession(deps, structuredClone(source));
    if (deps.holdBranch && !await deps.holdBranch(session.branchKey(source))) throw new Error('The draft is still open in another window');
    if (source.sessionId !== deps.sessionId) await session.adopt(source);
    else session.durableVersion = source.recordVersion;
    if (deps.holdBranch) await deps.holdBranch(session.branchKey(session.record));
    session.emit();
    return session;
  }

  private branchKey(record: DocumentDraft) { return JSON.stringify(['dovun-document', record.scopeKey, record.localId, record.sessionId]); }
  private canWork() { return this.active && this.deps.isActive(); }
  private canPublish() { return this.canWork() && !this.record.readOnly && !this.editorRecoveryIssue() && !this.composing && !this.staleBranches.length && !this.record.conflict && !this.record.blocked; }
  private dirty() { return !this.record.resourceId || this.record.editSeq !== this.record.confirmedSeq; }
  private titleDirty() { return this.record.title !== this.record.confirmedTitle; }
  private changed() { this.record.recordVersion += 1; this.record.updatedAt = this.now(); }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  /** Views may batch serialization, but their untransferred input is already unsaved work. */
  setEditorPending(viewKey: string, pending: boolean) {
    if (!pending && this.orphanedEditors.has(viewKey)) return;
    if (this.pendingEditors.has(viewKey) === pending) return;
    if (pending) this.pendingEditors.add(viewKey); else this.pendingEditors.delete(viewKey);
    this.emit();
  }

  registerEditor(viewKey: string, flush: () => boolean) {
    const previous = this.editorFlushers.get(viewKey);
    if (previous && previous !== flush && this.pendingEditors.has(viewKey)) {
      let captured = false;
      try { captured = previous(); } catch { /* Keep the previous view's unsaved state protected. */ }
      if (!captured) { this.orphanedEditors.add(viewKey); this.emit(); return () => {}; }
    }
    this.editorFlushers.set(viewKey, flush);
    return () => {
      if (this.editorFlushers.get(viewKey) !== flush) return;
      // Keep a failed buffer marked unsafe. A destroyed view is not proof that its input was saved.
      if (this.pendingEditors.has(viewKey)) {
        let captured = false; try { captured = flush(); } catch { /* A failed original view remains protected. */ }
        if (!captured) { this.orphanedEditors.add(viewKey); this.emit(); return; }
      }
      this.editorFlushers.delete(viewKey); this.pendingEditors.delete(viewKey); this.emit();
    };
  }

  flushEditors() {
    if (this.flushingEditors) return this.pendingEditors.size === 0;
    this.flushingEditors = true;
    try {
      // A DOM mutation can precede ProseMirror's observer callback in this same task.
      // Give every live view a chance to drain that observer before inspecting pending state.
      for (const [viewKey, flush] of this.editorFlushers) {
        try { if (flush()) { this.pendingEditors.delete(viewKey); this.orphanedEditors.delete(viewKey); } }
        catch { this.pendingEditors.add(viewKey); this.orphanedEditors.add(viewKey); }
      }
      return this.pendingEditors.size === 0;
    } finally { this.flushingEditors = false; }
  }

  hasUnpersistedChanges() {
    return this.pendingEditors.size > 0 || this.durableVersion < this.record.recordVersion || Boolean(this.storageError)
      || this.record.uploads.some((upload) => upload.state !== 'removed' && !upload.durable);
  }

  captureEditorFailure(viewKey: string, editorJson: unknown, message: string) {
    const captured = { viewKey, capturedAt: this.now(), message, editorJson: structuredClone(editorJson) };
    this.record.editorRecovery = [...(this.record.editorRecovery ?? []).filter((entry) => entry.viewKey !== viewKey), captured];
    this.pendingEditors.delete(viewKey); this.orphanedEditors.delete(viewKey);
    this.changed();
    this.cancelPersist?.(); this.cancelPersist = this.schedule(() => { this.cancelPersist = undefined; void this.flushLocal(); }, 0);
    this.emit();
  }

  private editorRecoveryIssue(): DocumentFailure | null {
    if (this.record.editorRecovery?.length) return { code: 'EDITOR_CAPTURE_FAILED', message: 'The editor could not convert the latest input. Its original editor data is retained in this local draft. Export a local recovery package before recovering this document.' };
    if (this.orphanedEditors.size) return { code: 'EDITOR_CAPTURE_FAILED', message: 'A previous editor view still has unsaved input. Keep the original view open; its unsaved buffer cannot be replaced by a new view.' };
    return null;
  }

  setTitle(title: string) {
    if (!this.canWork() || this.record.readOnly || this.editorRecoveryIssue()) return false;
    this.record.title = title; this.changed(); void this.flushLocal(); this.scheduleSave(); this.emit(); return true;
  }

  private emit() {
    const record = this.record;
    const pendingUploads = uploadIds(record.content).size > 0;
    const unpersistedUpload = record.uploads.some((upload) => upload.state !== 'removed' && !upload.durable);
    const editorRecoveryIssue = this.editorRecoveryIssue();
    const status = editorRecoveryIssue ? 'storage-error'
      : this.pendingEditors.size ? 'local-pending'
      : record.readOnly ? 'read-only'
      : this.storageError ? 'storage-error'
      : unpersistedUpload ? 'storage-error'
      : this.staleBranches.length ? 'recovery'
      : record.conflict ? 'conflict'
      : record.blocked ? 'error'
      : this.durableVersion < record.recordVersion ? 'local-pending'
      : pendingUploads ? 'uploading'
      : record.pending || record.organizationPending ? this.networkUnavailable || !this.canWork() ? 'local-only' : 'saving'
      : this.dirty() || this.titleDirty() ? 'local-only' : 'saved';
    // Content snapshots are immutable references. Network status changes must not clone a long document.
    this.snapshot = {
      localId: record.localId, resourceId: record.resourceId, title: record.title, format: record.format,
      schemaVersion: record.contentSchemaVersion, content: record.content, revision: record.base.revision,
      relativeReferences: record.relativeReferences ?? [],
      status, error: this.storageError ?? editorRecoveryIssue ?? (unpersistedUpload ? { code: 'ATTACHMENT_STORAGE_ERROR', message: 'Attachment bytes have not been saved on this device.' } : record.blocked), conflict: record.conflict ? { ...record.conflict } : null,
      uploads: structuredClone(record.uploads), staleBranches: this.staleBranches.slice(), readOnly: record.readOnly || Boolean(editorRecoveryIssue),
    };
    this.listeners.forEach((listener) => listener());
  }

  edit(content: DraftContent) {
    // Scope expiry blocks publication immediately, but a registered view must still be
    // able to hand its already-typed buffer into this old scope's local draft.
    if ((!this.canWork() && !this.flushingEditors) || this.record.readOnly || this.editorRecoveryIssue() || this.staleBranches.length) return;
    // A typing pause starts a new undo step; uninterrupted typing is split at the group duration.
    const now = this.now();
    if (now - this.lastEditAt >= HISTORY_PAUSE_MS || now - this.groupStartedAt >= HISTORY_GROUP_MAX_MS) { this.pushHistory(this.undoStack, this.record.content); this.groupStartedAt = now; }
    this.lastEditAt = now;
    this.redoStack = [];
    this.applyEdit(content);
  }

  setRelativeReference(path: string, target: { resourceId: string; revision: number } | null) {
    const normalized = relativeAssetPath(path);
    if (!normalized) throw new Error('INVALID_RELATIVE_REFERENCE_PATH');
    return this.setRelativeReferences([...(this.record.relativeReferences ?? []).filter((item) => item.path !== normalized), ...(target ? [{ path: normalized, ...target }] : [])]);
  }

  setRelativeReferences(references: RelativeReference[]) {
    if (!this.canWork() || this.record.readOnly || this.editorRecoveryIssue() || this.staleBranches.length || this.record.format !== 'markdown') return false;
    const seen = new Set<string>();
    const next = references.map((reference) => {
      const path = relativeAssetPath(reference.path);
      if (!path || seen.has(path) || !/^[a-zA-Z0-9_-]{1,128}$/.test(reference.resourceId) || !Number.isSafeInteger(reference.revision) || reference.revision < 1) throw new Error('INVALID_RELATIVE_REFERENCE');
      seen.add(path); return { path, resourceId: reference.resourceId, revision: reference.revision };
    }).sort((a, b) => a.path.localeCompare(b.path));
    if (referenceEqual(next, this.record.relativeReferences)) return true;
    this.record.relativeReferences = next;
    if (this.record.conflict) this.record.conflict.localRelativeReferences = structuredClone(next);
    this.applyEdit(this.record.content);
    return true;
  }

  private applyEdit(content: DraftContent) {
    this.record.content = structuredClone(this.composing ? content : this.withReadyUploads(content));
    this.record.editSeq += 1;
    const present = uploadIds(content);
    for (const upload of this.record.uploads) if (!present.has(upload.id) && upload.state !== 'ready') upload.state = 'removed';
    if (this.record.conflict) this.record.conflict.local = structuredClone(content);
    this.changed();
    if (!this.cancelPersist) this.cancelPersist = this.schedule(() => { this.cancelPersist = undefined; void this.flushLocal(); }, DOCUMENT_PERSIST_MS);
    this.scheduleSave();
    this.emit();
  }

  /** Returns whether a step was applied, so views only move the caret for a real history change. */
  undo() {
    if (!this.canWork() || this.record.readOnly || this.editorRecoveryIssue() || !this.undoStack.length) return false;
    const previous = this.undoStack.pop()!;
    this.pushHistory(this.redoStack, this.record.content);
    this.applyEdit(previous.content);
    this.lastEditAt = -Infinity;
    return true;
  }
  redo() {
    if (!this.canWork() || this.record.readOnly || this.editorRecoveryIssue() || !this.redoStack.length) return false;
    const next = this.redoStack.pop()!;
    this.pushHistory(this.undoStack, this.record.content);
    this.applyEdit(next.content);
    this.lastEditAt = -Infinity;
    return true;
  }

  /** Local undo steps describe this device's earlier bodies; once another body replaces them they must not be replayed. */
  private clearHistory() { this.undoStack = []; this.redoStack = []; this.lastEditAt = -Infinity; this.groupStartedAt = -Infinity; }

  private pushHistory(stack: Array<{ content: DraftContent; bytes: number }>, content: DraftContent) {
    const bytes = (typeof content === 'string' ? content.length : JSON.stringify(content).length) * 2;
    if (bytes > HISTORY_BYTE_LIMIT) return;
    stack.push({ content, bytes });
    const total = () => [...this.undoStack, ...this.redoStack].reduce((sum, entry) => sum + entry.bytes, 0);
    while (stack.length > HISTORY_STEP_LIMIT || total() > HISTORY_BYTE_LIMIT) {
      if (stack.length > 1) stack.shift();
      else if (this.undoStack !== stack && this.undoStack.length) this.undoStack.shift();
      else if (this.redoStack !== stack && this.redoStack.length) this.redoStack.shift();
      else break;
    }
  }

  setComposing(value: boolean) {
    this.composing = value;
    if (!value) {
      const reconciled = this.withReadyUploads(this.record.content);
      if (reconciled !== this.record.content) this.applyEdit(reconciled);
      if (this.pendingRemote) { const remote = this.pendingRemote; this.pendingRemote = null; this.receiveRemote(remote); }
      this.scheduleSave();
    }
  }

  private withReadyUploads(content: DraftContent): DraftContent {
    if (typeof content === 'string') return content;
    const results = new Map(this.record.uploads.filter((upload) => upload.result).map((upload) => [upload.id, upload]));
    if (![...uploadIds(content)].some((id) => results.has(id))) return content;
    return { ...content, blocks: walkBlocks(content.blocks, (block) => {
      if (block.kind !== 'upload') return block;
      const upload = results.get(block.uploadId);
      if (!upload?.result) return block;
      upload.state = 'ready';
      return { id: block.id, kind: upload.kind, target: upload.result, ...(upload.kind === 'image' ? { alt: upload.fileName } : { label: upload.fileName }) };
    }) };
  }

  private scheduleSave() {
    this.cancelSave?.();
    this.cancelSave = this.schedule(() => { this.cancelSave = undefined; void this.flushRemote(); }, DOCUMENT_SAVE_MS);
    if (!this.cancelCheckpoint) this.cancelCheckpoint = this.schedule(() => {
      this.cancelCheckpoint = undefined;
      void this.flushRemote();
      if (this.dirty()) this.scheduleSave();
    }, DOCUMENT_CHECKPOINT_MS);
  }

  /** Navigation only waits for this local transaction, never for the network. */
  async flushLocal(): Promise<boolean> {
    const editorsFlushed = this.flushEditors();
    this.cancelPersist?.(); this.cancelPersist = undefined;
    const record = structuredClone(this.record);
    const run = this.persistChain.catch(() => {}).then(async () => {
      await this.deps.store.put(record);
      this.durableVersion = Math.max(this.durableVersion, record.recordVersion);
      this.storageError = null;
    });
    this.persistChain = run;
    try { await run; this.emit(); return editorsFlushed && !this.hasUnpersistedChanges(); }
    catch (error) { this.storageError = failure(error, 'STORAGE_ERROR'); this.emit(); return false; }
  }

  async flushRemote(): Promise<void> {
    if (this.pumping) return this.pumping;
    const work = this.pump();
    this.pumping = work;
    try { await work; } finally { this.pumping = null; this.emit(); }
  }

  private async pump() {
    if (!this.canPublish()) return;
    if (!await this.flushLocal() || !this.canPublish()) return;
    if (!this.record.pending && this.record.resourceId && (this.record.organizationPending || this.titleDirty())) {
      await this.saveOrganization();
      if (this.record.organizationPending || !this.canPublish()) return;
    }
    if (!this.record.pending) {
      if (uploadIds(this.record.content).size || !this.dirty()) return;
      if (this.record.resourceId && equal(this.record.content, this.record.base.content) && referenceEqual(this.record.relativeReferences, this.record.base.relativeReferences)) {
        this.record.confirmedSeq = this.record.editSeq; this.changed(); await this.flushLocal(); return;
      }
      const content = structuredClone(this.record.content);
      const relativeReferences = copyReferences(this.record.relativeReferences);
      try { assertWritableContent(this.record.format, content, this.record.contentSchemaVersion); }
      catch (error) { this.record.blocked = failure(error, 'INVALID_CONTENT'); this.changed(); await this.flushLocal(); return; }
      const editSeq = this.record.editSeq;
      const requestId = this.newId();
      const hash = await (this.deps.hash ?? contentHash)(content);
      if (!this.canPublish()) return;
      this.record.pending = {
        requestId, resourceId: this.record.resourceId, expectedRevision: this.record.base.revision,
        bodyJson: JSON.stringify({
          requestId, ...(this.record.resourceId ? { expectedRevision: this.record.base.revision } : { title: this.record.title, topicId: this.record.topicId, folderId: this.record.folderId }),
          format: this.record.format, schemaVersion: this.record.contentSchemaVersion, content, contentHash: hash,
          ...(this.record.format === 'markdown' ? { relativeReferences } : {}),
        }),
        content, editSeq, state: 'prepared',
      };
      this.changed();
      if (!await this.flushLocal() || !this.canPublish()) return;
    }
    const pending = structuredClone(this.record.pending!);
    if (pending.state === 'unknown') {
      const checked = await this.deps.transport.receipt(pending.requestId).catch(() => ({ kind: 'unknown' as const }));
      if (checked.kind === 'found') { await this.acknowledge(checked.receipt); return; }
      if (checked.kind === 'rejected') { await this.reject(checked.error); return; }
      if (checked.kind === 'unknown' || !this.canPublish()) { this.networkUnavailable = true; this.emit(); return; }
    }
    // Persist an unknown outcome BEFORE dispatch, so a process crash cannot turn a sent write into a new request.
    this.record.pending!.state = 'unknown'; this.changed();
    if (!await this.flushLocal() || !this.canPublish()) return;
    this.networkUnavailable = false; this.emit();
    const result = await this.deps.transport.send(pending).catch(() => ({ kind: 'unknown' as const }));
    if (result.kind === 'success') await this.acknowledge(result.receipt);
    else if (result.kind === 'rejected') await this.reject(result.error);
    else { this.networkUnavailable = true; this.emit(); }
  }

  private async acknowledge(receipt: DocumentReceipt) {
    const pending = this.record.pending;
    if (!pending || pending.requestId !== receipt.requestId) return;
    if (pending.resourceId && pending.resourceId !== receipt.resourceId) {
      await this.reject({ code: 'INVALID_RECEIPT', message: 'The save receipt belongs to another document.' }); return;
    }
    const requestedHash = (JSON.parse(pending.bodyJson) as { contentHash: string }).contentHash;
    if (!receipt.resourceId || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || receipt.contentHash !== requestedHash) {
      await this.reject({ code: 'INVALID_RECEIPT', message: 'The save receipt does not match the submitted document.' }); return;
    }
    this.record.resourceId = receipt.resourceId;
    if (!pending.resourceId) {
      this.record.confirmedTitle = (JSON.parse(pending.bodyJson) as { title: string }).title;
      this.record.organizationRevision = receipt.organizationRevision ?? 1;
    }
    this.record.base = { revision: receipt.revision, content: structuredClone(pending.content), contentHash: receipt.contentHash, relativeReferences: JSON.parse(pending.bodyJson).relativeReferences ?? [] };
    this.record.confirmedSeq = pending.editSeq;
    this.record.pending = null;
    this.networkUnavailable = false;
    this.changed();
    await this.flushLocal();
    this.deps.onIdentity?.(this, receipt.resourceId);
    if ((this.dirty() || this.titleDirty()) && this.canWork()) this.scheduleSave();
  }

  private async saveOrganization() {
    if (!this.record.resourceId || !this.deps.transport.organize) return;
    if (!this.record.organizationPending) {
      const requestId = this.newId();
      this.record.organizationPending = {
        requestId, resourceId: this.record.resourceId, expectedOrganizationRevision: this.record.organizationRevision,
        title: this.record.title, state: 'prepared',
        bodyJson: JSON.stringify({ requestId, expectedOrganizationRevision: this.record.organizationRevision, title: this.record.title }),
      };
      this.changed(); if (!await this.flushLocal() || !this.canWork()) return;
    }
    const pending = this.record.organizationPending;
    const acknowledge = async (receipt: DocumentReceipt) => {
      if (receipt.requestId !== pending.requestId || receipt.resourceId !== pending.resourceId || !Number.isSafeInteger(receipt.organizationRevision)) {
        this.record.blocked = { code: 'INVALID_RECEIPT', message: 'The title save receipt does not match the document.' };
      } else {
        this.record.confirmedTitle = pending.title;
        this.record.organizationRevision = receipt.organizationRevision!;
        this.record.organizationPending = null;
        this.networkUnavailable = false;
      }
      this.changed(); await this.flushLocal();
    };
    if (pending.state === 'unknown') {
      const receipt = await this.deps.transport.receipt(pending.requestId).catch(() => ({ kind: 'unknown' as const }));
      if (receipt.kind === 'found') { await acknowledge(receipt.receipt); return; }
      if (receipt.kind === 'rejected') { this.record.blocked = receipt.error; this.changed(); await this.flushLocal(); return; }
      if (receipt.kind === 'unknown' || !this.canWork()) { this.networkUnavailable = true; return; }
    }
    pending.state = 'unknown'; this.changed();
    if (!await this.flushLocal() || !this.canWork()) return;
    const result = await this.deps.transport.organize(structuredClone(pending)).catch(() => ({ kind: 'unknown' as const }));
    if (result.kind === 'success') await acknowledge(result.receipt);
    else if (result.kind === 'rejected') { this.record.blocked = result.error; this.changed(); await this.flushLocal(); }
    else this.networkUnavailable = true;
  }

  private async reject(error: DocumentFailure) {
    this.record.blocked = error;
    if (['VERSION_CONFLICT', 'CONFLICT', 'PRECONDITION_FAILED'].includes(error.code) && this.record.resourceId && this.canWork()) {
      try {
        const remote = await this.deps.transport.read(this.record.resourceId);
        this.record.conflict = { base: structuredClone(this.record.base), local: structuredClone(this.record.content), remote };
      } catch { /* Keep the rejected request and local branch until the current remote can be fetched. */ }
    }
    this.changed(); await this.flushLocal();
  }

  /** Automatic reconnect never replays a definitively rejected write. */
  async reconnect() {
    if (!this.canWork() || this.record.blocked || this.record.conflict || this.staleBranches.length) return;
    if (this.record.pending || this.record.organizationPending) await this.flushRemote();
    if (this.record.pending || this.record.organizationPending || this.record.blocked || !this.canWork()) return;
    if (this.record.resourceId) {
      try { this.receiveRemote(await this.deps.transport.read(this.record.resourceId)); }
      catch { this.networkUnavailable = true; this.emit(); return; }
    }
    await this.resumeUploads();
    await this.flushRemote();
  }

  async retry() {
    if (!this.canWork() || this.record.conflict || this.staleBranches.length) return;
    // The old request was definitively rejected; a user retry is a fresh intent with a fresh request identity.
    if (this.record.blocked?.code === 'ORGANIZATION_CONFLICT' && this.record.resourceId) {
      try { const remote = await this.deps.transport.read(this.record.resourceId); this.record.confirmedTitle = remote.title; this.record.organizationRevision = remote.organizationRevision; }
      catch { this.networkUnavailable = true; this.emit(); return; }
    }
    if (this.record.blocked) { this.record.blocked = null; this.record.pending = null; this.record.organizationPending = null; this.changed(); }
    if (!await this.flushLocal()) return;
    await this.reconnect();
  }

  receiveRemote(remote: ResourceDocument) {
    if (remote.id !== this.record.resourceId || remote.revision < this.record.base.revision) return;
    if (!this.flushEditors()) { this.pendingRemote = remote; return; }
    if (this.composing) { this.pendingRemote = remote; return; }
    if (this.titleDirty() && !this.record.organizationPending && remote.organizationRevision > this.record.organizationRevision && remote.title !== this.record.confirmedTitle) {
      this.record.blocked = { code: 'ORGANIZATION_CONFLICT', message: `The title was changed to “${remote.title}” elsewhere. Your title is retained; retry to apply it.` };
      this.changed(); void this.flushLocal();
    }
    if (!this.titleDirty() && !this.record.organizationPending) this.record.title = this.record.confirmedTitle = remote.title;
    if (!this.record.organizationPending) this.record.organizationRevision = remote.organizationRevision;
    this.record.readOnly = remote.readOnly;
    if (this.record.pending || remote.revision === this.record.base.revision) { this.emit(); return; }
    if (this.dirty() || uploadIds(this.record.content).size) {
      if (!equal(this.record.content, remote.content) || !referenceEqual(this.record.relativeReferences, remote.relativeReferences)) this.record.conflict = { base: structuredClone(this.record.base), local: structuredClone(this.record.content), localRelativeReferences: structuredClone(this.record.relativeReferences ?? []), remote: structuredClone(remote) };
      else {
        this.record.base = documentBase(remote);
        this.record.confirmedSeq = this.record.editSeq;
      }
    } else {
      this.record.content = structuredClone(remote.content);
      this.record.relativeReferences = copyReferences(remote.relativeReferences);
      this.record.base = documentBase(remote);
      // The other device's body replaced this one; replaying local undo steps would silently revert it.
      this.clearHistory();
      this.record.format = remote.format; this.record.contentSchemaVersion = remote.schemaVersion;
    }
    this.changed(); void this.flushLocal(); this.emit();
  }

  async resolveConflict(choice: 'local' | 'remote' | DraftContent | { content: DraftContent }) {
    const conflict = this.record.conflict;
    if (!conflict || !this.canWork() || this.editorRecoveryIssue()) return;
    // Conflict alternatives remain in the persisted branch until this explicit choice.
    const content = choice === 'local' ? this.record.content : choice === 'remote' ? conflict.remote.content : typeof choice === 'object' && 'content' in choice ? choice.content : choice;
    this.record.base = documentBase(conflict.remote);
    if (choice === 'remote') {
      this.record.relativeReferences = copyReferences(conflict.remote.relativeReferences);
      this.record.format = conflict.remote.format;
      this.record.contentSchemaVersion = conflict.remote.schemaVersion;
      this.record.readOnly = conflict.remote.readOnly;
      this.record.topicId = conflict.remote.topicId ?? null;
      this.record.folderId = conflict.remote.folderId ?? null;
    }
    this.record.pending = null; this.record.blocked = null; this.record.conflict = null;
    this.record.content = structuredClone(content);
    this.record.editSeq += 1;
    if (choice === 'remote') this.record.confirmedSeq = this.record.editSeq;
    // The resolved body sits on the remote base; earlier local steps no longer describe it.
    this.clearHistory();
    this.changed();
    if (await this.flushLocal()) this.scheduleSave();
  }

  async restoreBranch(sessionId: string) {
    const draft = this.staleBranches.find((branch) => branch.sessionId === sessionId);
    if (!draft || !this.canWork()) return;
    if (this.deps.holdBranch && !await this.deps.holdBranch(this.branchKey(draft))) throw new Error('The draft is open in another window');
    await this.adopt(draft);
    // Selecting one branch enables it. Other branches remain in storage; choosing them in sequence here
    // would overwrite the just-restored draft in the same active session.
    this.staleBranches = [];
    this.emit();
  }

  private async adopt(source: DocumentDraft) {
    const next = { ...structuredClone(source), sessionId: this.deps.sessionId, recordVersion: source.recordVersion + 1, updatedAt: this.now() };
    await this.deps.store.adopt(next, source, Boolean(this.deps.holdBranch));
    this.record = next; this.durableVersion = next.recordVersion;
    this.clearHistory();
    this.deps.onIdentity?.(this, next.resourceId ?? next.localId);
  }

  async addUpload(file: File, options: { kind: 'image' | 'file'; bookmark?: string }) {
    if (!this.canWork() || this.record.readOnly || this.editorRecoveryIssue() || typeof this.record.content === 'string') throw new Error('This document cannot insert resource blocks');
    if (file.size > 100 * 1024 * 1024) throw new Error('UPLOAD_TOO_LARGE');
    const id = this.newId();
    const upload: DocumentUpload = { id, nodeId: `upload-${id}`, fileName: file.name || (options.kind === 'image' ? 'image.png' : 'attachment'), mimeType: file.type || 'application/octet-stream', size: file.size, kind: options.kind, requestId: this.newId(), state: 'queued', durable: false };
    this.record.uploads.push(upload); this.files.set(id, file);
    this.applyEdit(insertBlock(this.record.content, { id: upload.nodeId, kind: 'upload', uploadId: id, label: file.name }, options.bookmark));
    const persisted = await this.persistFile(upload, file);
    if (persisted) void this.runUpload(id);
    return id;
  }

  private async persistFile(upload: DocumentUpload, file: Blob) {
    upload.durable = true; this.changed();
    const snapshot = structuredClone(this.record);
    const run = this.persistChain.catch(() => {}).then(() => this.deps.store.putWithFile(snapshot, upload.id, file));
    this.persistChain = run;
    try { await run; this.durableVersion = Math.max(this.durableVersion, snapshot.recordVersion); this.storageError = null; this.emit(); return true; }
    catch (error) { upload.durable = false; this.storageError = failure(error, 'ATTACHMENT_STORAGE_ERROR'); this.emit(); return false; }
  }

  async retryUpload(id: string) {
    const upload = this.record.uploads.find((entry) => entry.id === id);
    if (!upload || upload.state === 'removed' || !this.canWork()) return;
    if (!upload.durable) {
      const file = this.files.get(id);
      if (!file || !await this.persistFile(upload, file)) return;
    }
    if (upload.errorCode === 'UPLOAD_EXPIRED' || upload.errorCode === 'UPLOAD_CANCELLED') {
      upload.uploadId = undefined; upload.requestId = this.newId();
    }
    upload.state = 'queued'; upload.error = undefined; upload.errorCode = undefined; this.changed();
    if (await this.flushLocal()) await this.runUpload(id);
  }

  async removeUpload(id: string) {
    if (typeof this.record.content === 'string') return;
    this.edit({ ...this.record.content, blocks: walkBlocks(this.record.content.blocks, (block) => block.kind === 'upload' && block.uploadId === id ? null : block) });
    await this.flushLocal();
  }

  async resumeUploads() {
    for (const upload of this.record.uploads) if (upload.durable && ['queued', 'uploading'].includes(upload.state)) await this.runUpload(upload.id);
  }

  private async runUpload(id: string) {
    const upload = this.record.uploads.find((entry) => entry.id === id);
    if (!upload || !this.deps.transport.upload || !this.canWork() || this.uploading.has(id) || upload.state === 'removed' || !upload.durable) return;
    this.uploading.add(id);
    try {
      const file = this.files.get(id) ?? await this.deps.store.readFile(this.record, id);
      if (!file) throw new Error('The attachment was not persisted on this device. Select the file again.');
      upload.state = 'uploading'; this.changed();
      if (!await this.flushLocal() || !this.canWork()) return;
      const result = await this.deps.transport.upload(structuredClone(upload), file, { topicId: this.record.topicId }, async (uploadId) => {
        if (!this.canWork()) throw new Error('Document scope changed');
        upload.uploadId = uploadId; this.changed();
        if (!await this.flushLocal()) throw new Error('Could not persist upload receipt');
      });
      upload.result = result;
      if (typeof this.record.content !== 'string' && uploadIds(this.record.content).has(id)) {
        upload.state = 'ready';
        if (!this.composing) this.applyEdit(this.withReadyUploads(this.record.content));
      } else upload.state = 'removed';
      this.changed(); await this.flushLocal();
    } catch (error) {
      if (upload.state !== 'removed') { const detail = failure(error); upload.state = 'failed'; upload.error = detail.message; upload.errorCode = detail.code; }
      this.changed(); await this.flushLocal();
    } finally { this.uploading.delete(id); this.emit(); }
  }

  /** Recover one local file independently of ZIP budgets, without publishing or replaying any request. */
  async recoveryAttachment(uploadId: string): Promise<Blob> {
    const upload = this.record.uploads.find((entry) => entry.id === uploadId);
    if (!upload) throw new Error('LOCAL_ATTACHMENT_UNAVAILABLE');
    let file: Blob | undefined;
    try { file = this.files.get(uploadId) ?? await this.deps.store.readFile(this.record, uploadId); }
    catch { throw new Error('LOCAL_ATTACHMENT_READ_FAILED'); }
    if (!file) throw new Error('LOCAL_ATTACHMENT_UNAVAILABLE');
    if (file.size !== upload.size) throw new Error('LOCAL_ATTACHMENT_SIZE_MISMATCH');
    return file;
  }

  /** Read-only recovery captures the exact branch, including unknown requests; it never sends or retries. */
  async recoverySnapshot() {
    if (!this.flushEditors()) throw new Error('The editor input could not be captured. Keep this document open and retry.');
    const draft = structuredClone(this.record);
    const files: Array<{ uploadId: string; file: Blob }> = [];
    const missing: Array<{ uploadId: string; reason: string }> = [];
    let index = 0;
    const read = async () => {
      while (index < draft.uploads.length) {
        const upload = draft.uploads[index++];
        try {
          const file = this.files.get(upload.id) ?? await this.deps.store.readFile(draft, upload.id);
          if (file) files.push({ uploadId: upload.id, file });
          else missing.push({ uploadId: upload.id, reason: 'Local attachment bytes are unavailable.' });
        } catch { missing.push({ uploadId: upload.id, reason: 'Local attachment storage could not be read.' }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, draft.uploads.length) }, read));
    return { draft, files, missing };
  }

  /** Scope changes stop writes immediately while retaining durable data under the old identity. */
  deactivate() {
    this.flushEditors();
    this.active = false;
    this.cancelSave?.(); this.cancelCheckpoint?.(); this.cancelPersist?.();
    void this.flushLocal(); this.emit();
  }
}

/** A registry is scoped to one authenticated workspace. Historical versions never enter this map. */
export class DocumentSessionRegistry {
  private sessions = new Map<string, DocumentSession>();
  private opening = new Map<string, Promise<DocumentSession>>();
  constructor(private readonly deps: DocumentSessionDeps) {}
  get(id: string) { return this.sessions.get(id); }
  list() { return [...new Set(this.sessions.values())]; }
  async listDrafts() {
    return (await this.deps.store.listScope(this.deps.scopeKey)).filter((draft) => draft.deviceId === this.deps.deviceId);
  }
  async restoreLocalDraft(localId: string, sessionId: string) {
    const live = this.sessions.get(localId);
    if (live) return live;
    const source = (await this.listDrafts()).find((draft) => draft.localId === localId && draft.sessionId === sessionId);
    if (!source) throw new Error('The document draft is unavailable in this workspace');
    const session = await DocumentSession.restore(this.sessionDeps(), source);
    this.sessions.set(localId, session);
    if (source.resourceId) this.sessions.set(source.resourceId, session);
    this.resumeRecovered(session);
    return session;
  }
  async open(resource: ResourceDocument) {
    const live = this.sessions.get(resource.id);
    if (live) { live.receiveRemote(resource); return live; }
    const pending = this.opening.get(resource.id);
    if (pending) return pending;
    const opened = DocumentSession.open(this.sessionDeps(), resource).then((session) => { this.sessions.set(resource.id, session); this.resumeRecovered(session); return session; });
    this.opening.set(resource.id, opened);
    try { return await opened; } finally { this.opening.delete(resource.id); }
  }
  async create(input: NewDocument) {
    const session = await DocumentSession.create(this.sessionDeps(), input);
    this.sessions.set(session.getSnapshot().localId, session);
    return session;
  }
  private sessionDeps(): DocumentSessionDeps {
    return { ...this.deps, onIdentity: (session, resourceId) => { this.sessions.set(resourceId, session); this.deps.onIdentity?.(session, resourceId); } };
  }
  private resumeRecovered(session: DocumentSession) {
    if (['local-only', 'saving', 'uploading'].includes(session.getSnapshot().status)) void session.reconnect().catch(() => {});
  }
  async reconnect() { await Promise.all([...new Set(this.sessions.values())].map((session) => session.reconnect())); }
  async flushLocal() { await Promise.all([...new Set(this.sessions.values())].map((session) => session.flushLocal())); }
  flushEditors() { for (const session of new Set(this.sessions.values())) session.flushEditors(); }
  hasUnpersistedChanges() { return this.list().some((session) => session.hasUnpersistedChanges()); }
  deactivate() { for (const session of new Set(this.sessions.values())) session.deactivate(); }
}
