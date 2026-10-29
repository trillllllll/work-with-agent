import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { canonicalContent, emptyRichDocument } from '../../../../server/src/domain/document-content.js';
import { DocumentDraftStore } from './draft-store.js';
import { DocumentSession, DocumentSessionRegistry, uploadIds, type DocumentSessionDeps } from './session.js';
import type { DocumentDraftStorage, DocumentReceipt, DocumentTransport, DocumentWrite, ReceiptOutcome, ResourceDocument, WriteOutcome } from './types.js';

const drain = async () => { for (let i = 0; i < 15; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
const hash = async (content: unknown) => `hash:${canonicalContent(content)}`;
const resource = (id = 'doc-1', content = 'base', revision = 1): ResourceDocument => ({ id, title: 'Document', kind: 'text', format: 'text', schemaVersion: null, content, revision, currentRevision: revision, organizationRevision: 1, contentHash: `hash:${content}`, readOnly: false });
class Clock {
  time = 0;
  timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  schedule = (fn: () => void, ms: number) => {
    const timer = { at: this.time + ms, fn, cancelled: false }; this.timers.push(timer); return () => { timer.cancelled = true; };
  };
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const timer = this.timers.filter((item) => !item.cancelled && item.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!timer) break;
      this.timers.splice(this.timers.indexOf(timer), 1); this.time = timer.at; timer.fn();
    }
    this.time = end;
  }
}
function setup(options: { store?: DocumentDraftStorage; scopeKey?: string; sessionId?: string; holdBranch?: DocumentSessionDeps['holdBranch'] } = {}) {
  let nextId = 0, active = true;
  const clock = new Clock();
  const store = options.store ?? new DocumentDraftStore(new IDBFactory());
  const sent: DocumentWrite[] = [], lookups: string[] = [];
  const pending: Array<(value: WriteOutcome) => void> = [];
  const receipts = new Map<string, ReceiptOutcome>();
  let remote = resource();
  const transport: DocumentTransport = {
    send: async (write) => { sent.push(structuredClone(write)); return new Promise((resolve) => pending.push(resolve)); },
    receipt: async (id) => { lookups.push(id); return receipts.get(id) ?? { kind: 'missing' }; },
    read: async () => remote,
  };
  const deps: DocumentSessionDeps = { store, transport, scopeKey: options.scopeKey ?? 'workspace:alice', deviceId: 'device-1', sessionId: options.sessionId ?? 'window-1', isActive: () => active, now: () => clock.time, schedule: clock.schedule, newId: () => `request-${++nextId}`, hash, holdBranch: options.holdBranch };
  const receipt = (index: number, revision = 2): DocumentReceipt => ({ requestId: sent[index].requestId, resourceId: sent[index].resourceId ?? 'created-doc', revision, contentHash: JSON.parse(sent[index].bodyJson).contentHash });
  return { deps, store, transport, clock, sent, pending, receipts, lookups, receipt, setRemote: (value: ResourceDocument) => { remote = value; }, deactivate: () => { active = false; } };
}

describe('document session durability and version protocol', () => {
  it('marks buffered editor input pending immediately and synchronously transfers it before local persistence', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    let calls = 0;
    const unregister = session.registerEditor('primary', () => {
      calls++; session.edit('latest buffered keystroke'); session.setEditorPending('primary', false); return true;
    });
    session.setEditorPending('primary', true);
    expect(session.getSnapshot().status).toBe('local-pending');
    expect(session.hasUnpersistedChanges()).toBe(true);
    expect(session.getSnapshot().content).toBe('base');
    const persisted = session.flushLocal();
    // No 250ms advance and no async wait are needed to hand the editor body to the session.
    expect(session.getSnapshot().content).toBe('latest buffered keystroke');
    expect(calls).toBe(1);
    expect(session.hasUnpersistedChanges()).toBe(true);
    expect(await persisted).toBe(true);
    expect(session.hasUnpersistedChanges()).toBe(false);
    expect((await h.store.load(h.deps.scopeKey, 'doc-1'))[0].content).toBe('latest buffered keystroke');
    unregister();
  });

  it('does not permit departure or claim durability when a view cannot serialize its pending input', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    const unregister = session.registerEditor('secondary', () => false);
    session.setEditorPending('secondary', true);
    expect(await session.flushLocal()).toBe(false);
    expect(session.getSnapshot().status).toBe('local-pending');
    unregister();
    expect(session.hasUnpersistedChanges()).toBe(true);
    await expect(session.recoverySnapshot()).rejects.toThrow('could not be captured');
  });

  it('does not let a replacement view clear the previous failed view buffer', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    const unregister = session.registerEditor('primary', () => false);
    session.setEditorPending('primary', true); unregister();
    let replacementCalls = 0;
    session.registerEditor('primary', () => { replacementCalls++; return true; });
    session.setEditorPending('primary', false);
    expect(await session.flushLocal()).toBe(false);
    expect(replacementCalls).toBe(0);
    expect(session.getSnapshot()).toMatchObject({ status: 'storage-error', readOnly: true, error: { code: 'EDITOR_CAPTURE_FAILED' } });
  });

  it('durably quarantines failed raw editor JSON across view replacement and refresh without publishing it', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    const raw = { type: 'doc', content: [{ type: 'futureUnknownBlock', attrs: { blockId: 'preserve-me' }, content: [{ type: 'text', text: 'newer input must survive' }] }] };
    let buffered = true;
    const unregister = session.registerEditor('primary', () => { if (buffered) { buffered = false; session.captureEditorFailure('primary', raw, 'Unsupported node'); } return true; });
    session.setEditorPending('primary', true);
    expect(await session.flushLocal()).toBe(true);
    unregister(); session.registerEditor('primary', () => true); session.setEditorPending('primary', false);
    await session.flushRemote(); expect(h.sent).toHaveLength(0);
    const drafts = await h.store.load(h.deps.scopeKey, 'doc-1');
    expect(drafts[0].editorRecovery?.[0].editorJson).toEqual(raw);
    const reopened = setup({ store: h.store, sessionId: 'window-2', holdBranch: async () => true });
    const recovered = await DocumentSession.open(reopened.deps, resource());
    expect(recovered.getSnapshot()).toMatchObject({ content: 'base', status: 'storage-error', readOnly: true, error: { code: 'EDITOR_CAPTURE_FAILED' } });
    expect((await recovered.recoverySnapshot()).draft.editorRecovery?.[0].editorJson).toEqual(raw);
    await recovered.flushRemote(); expect(reopened.sent).toHaveLength(0);
  });

  it('rechecks publication permission after local flush first discovers unconvertible editor state', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    session.edit('previous valid edit');
    let pending = true;
    session.registerEditor('primary', () => { if (pending) { pending = false; session.captureEditorFailure('primary', { type: 'doc', content: [{ type: 'unknown' }] }, 'Unsupported node'); } return true; });
    await session.flushRemote();
    expect(h.sent).toHaveLength(0);
    expect(session.getSnapshot()).toMatchObject({ status: 'storage-error', readOnly: true, error: { code: 'EDITOR_CAPTURE_FAILED' } });
    expect((await h.store.load(h.deps.scopeKey, 'doc-1'))[0].editorRecovery).toHaveLength(1);
  });

  it('adopts the remote format, schema and read-only state when resolving a cross-format restore conflict', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    session.edit('keep as conflict alternative');
    const remote = { ...resource('doc-1', '', 2), format: 'binary' as const, readOnly: true, schemaVersion: null, topicId: 'topic-new', folderId: 'folder-new', attachment: { fileName: 'restored.pdf', mimeType: 'application/pdf' } };
    session.receiveRemote(remote); expect(session.getSnapshot().conflict).not.toBeNull();
    await session.resolveConflict('remote');
    expect(session.getSnapshot()).toMatchObject({ format: 'binary', schemaVersion: null, content: '', revision: 2, readOnly: true, status: 'read-only' });
    session.receiveRemote(remote); session.edit('must not overwrite binary'); await session.flushRemote();
    expect(session.getSnapshot().content).toBe(''); expect(h.sent).toHaveLength(0);
    expect((await h.store.load(h.deps.scopeKey, 'doc-1'))[0]).toMatchObject({ format: 'binary', topicId: 'topic-new', folderId: 'folder-new' });

    const second = await DocumentSession.open(h.deps, resource('doc-rich'));
    second.edit('local text'); second.receiveRemote({ ...resource('doc-rich', '', 2), format: 'richdoc-v1', content: emptyRichDocument(), schemaVersion: 1 });
    await second.resolveConflict('remote');
    expect(second.getSnapshot()).toMatchObject({ format: 'richdoc-v1', schemaVersion: 1, readOnly: false, status: 'saved' });
    second.undo(); second.redo();
    expect(second.getSnapshot().content).toEqual(emptyRichDocument());
  });

  it('flushes both view buffers before a remote refresh so the latest buffered input becomes a conflict', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    session.registerEditor('primary', () => { session.edit('buffered local'); session.setEditorPending('primary', false); return true; });
    session.setEditorPending('primary', true);
    session.receiveRemote(resource('doc-1', 'remote', 2));
    expect(session.getSnapshot().conflict).toMatchObject({ base: { content: 'base' }, local: 'buffered local', remote: { content: 'remote' } });
    await session.flushLocal();
  });

  it('captures composition input locally on navigation without sending it to the server', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    session.setComposing(true);
    session.registerEditor('primary', () => { session.edit('中文组词'); session.setEditorPending('primary', false); return true; });
    session.setEditorPending('primary', true);
    expect(await session.flushLocal()).toBe(true);
    await session.flushRemote();
    expect(h.sent).toHaveLength(0);
    expect((await h.store.load(h.deps.scopeKey, 'doc-1'))[0].content).toBe('中文组词');
  });

  it('captures already-typed buffers into the old scope on expiry while preventing network writes', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    session.registerEditor('primary', () => { session.edit('typed before expiry'); session.setEditorPending('primary', false); return true; });
    session.setEditorPending('primary', true); h.deactivate(); session.deactivate();
    expect(await session.flushLocal()).toBe(true);
    expect((await h.store.load(h.deps.scopeKey, 'doc-1'))[0].content).toBe('typed before expiry');
    await session.flushRemote(); expect(h.sent).toHaveLength(0);
  });
  it('persists attachment bytes as plain binary records while unrelated drafts remain readable', async () => {
    const factory = new IDBFactory(); const h = setup({ store: new DocumentDraftStore(factory) });
    const session = await DocumentSession.open(h.deps, { ...resource(), format: 'richdoc-v1', schemaVersion: 1, content: emptyRichDocument() });
    const input = new File([new Uint8Array([0, 1, 2, 255])], 'source.bin', { type: 'application/octet-stream' });
    const id = await session.addUpload(input, { kind: 'file' });
    const records = await h.store.load(h.deps.scopeKey, 'doc-1');
    const restored = await h.store.readFile(records[0], id);
    expect(new Uint8Array(await restored!.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(restored!.type).toBe('application/octet-stream');
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = factory.open('dovun-document-drafts', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const raw = await new Promise<unknown>((resolve) => { const tx = db.transaction('files'); const request = tx.objectStore('files').getAll(); tx.oncomplete = () => resolve(request.result[0]); });
    expect(raw).toMatchObject({ version: 1, mimeType: 'application/octet-stream' });
    expect(raw).not.toBeInstanceOf(Blob);
    db.close();
    expect((await DocumentSession.open(h.deps, resource('other'))).getSnapshot().resourceId).toBe('other');
  });

  it('saves mapping-only Markdown changes and keeps newer mappings after an older acknowledgement', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, { ...resource(), format: 'markdown', relativeReferences: [] });
    session.setRelativeReference('./images/a.png', { resourceId: 'image-first', revision: 2 });
    const first = session.flushRemote(); await drain();
    expect(JSON.parse(h.sent[0].bodyJson)).toMatchObject({ content: 'base', relativeReferences: [{ path: 'images/a.png', resourceId: 'image-first', revision: 2 }] });
    session.setRelativeReference('images/a.png', { resourceId: 'image-second', revision: 5 });
    h.pending[0]({ kind: 'success', receipt: h.receipt(0) }); await first;
    expect(session.getSnapshot().relativeReferences?.[0].resourceId).toBe('image-second');
    expect(session.getSnapshot().status).toBe('local-only');
    const second = session.flushRemote(); await drain();
    expect(h.sent[1].expectedRevision).toBe(2);
    expect(JSON.parse(h.sent[1].bodyJson).relativeReferences[0].resourceId).toBe('image-second');
    h.pending[1]({ kind: 'success', receipt: h.receipt(1, 3) }); await second;
    expect(session.getSnapshot().status).toBe('saved');
    session.setRelativeReference('images/a.png', null);
    const clear = session.flushRemote(); await drain();
    expect(JSON.parse(h.sent[2].bodyJson).relativeReferences).toEqual([]);
    h.pending[2]({ kind: 'success', receipt: h.receipt(2, 4) }); await clear;
  });

  it('does not replay response-only reference permission flags in a Markdown save', async () => {
    const h = setup(); const reference = { path: 'image.png', resourceId: 'image-1', revision: 1, accessible: true };
    const session = await DocumentSession.open(h.deps, { ...resource(), format: 'markdown', relativeReferences: [reference] });
    session.edit('changed'); const saving = session.flushRemote(); await drain();
    expect(JSON.parse(h.sent[0].bodyJson).relativeReferences).toEqual([{ path: 'image.png', resourceId: 'image-1', revision: 1 }]);
    h.pending[0]({ kind: 'success', receipt: h.receipt(0) }); await saving;
  });

  it('treats a concurrent mapping-only change as a conflict with independent local and remote targets', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, { ...resource(), format: 'markdown', relativeReferences: [] });
    session.setRelativeReference('../photo.png', { resourceId: 'local-image', revision: 1 });
    session.receiveRemote({ ...resource('doc-1', 'base', 2), format: 'markdown', relativeReferences: [{ path: '../photo.png', resourceId: 'remote-image', revision: 4 }] });
    expect(session.getSnapshot().conflict).toMatchObject({ base: { relativeReferences: [] }, localRelativeReferences: [{ resourceId: 'local-image' }], remote: { relativeReferences: [{ resourceId: 'remote-image' }] } });
    await session.resolveConflict('remote');
    expect(session.getSnapshot().relativeReferences?.[0].resourceId).toBe('remote-image');
    expect(session.getSnapshot().status).toBe('saved');
  });
  it('persists typing before the idle save and does not create a version for unchanged text', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    session.edit('typed'); h.clock.advance(250); await drain();
    expect((await h.store.load(h.deps.scopeKey, 'doc-1'))[0].content).toBe('typed');
    expect(h.sent).toHaveLength(0);
    h.clock.advance(1750); await drain();
    expect(h.sent).toHaveLength(1);
    h.pending[0]({ kind: 'success', receipt: h.receipt(0) }); await drain();
    expect(session.getSnapshot().status).toBe('saved');
    session.edit('typed'); await session.flushRemote();
    expect(h.sent).toHaveLength(1);
    expect(session.getSnapshot().status).toBe('saved');
  });

  it('old acknowledgements advance only the submitted base and keep later typing', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    session.edit('first'); const saving = session.flushRemote(); await drain();
    session.edit('second');
    h.pending[0]({ kind: 'success', receipt: h.receipt(0) }); await saving;
    expect(session.getSnapshot().content).toBe('second');
    expect(session.getSnapshot().revision).toBe(2);
    expect(session.getSnapshot().status).toBe('local-only');
    const second = session.flushRemote(); await drain();
    expect(h.sent[1].expectedRevision).toBe(2);
    expect(h.sent[1].requestId).not.toBe(h.sent[0].requestId);
    expect(JSON.parse(h.sent[1].bodyJson).content).toBe('second');
    h.pending[1]({ kind: 'success', receipt: h.receipt(1, 3) }); await second;
  });

  it('looks up unknown outcomes and retries exactly the same request before newer edits', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    session.edit('first'); const saving = session.flushRemote(); await drain();
    h.pending[0]({ kind: 'unknown' }); await saving;
    session.edit('second');
    const retry = session.flushRemote(); await drain();
    expect(h.lookups).toEqual([h.sent[0].requestId]);
    expect(h.sent[1]).toMatchObject({ requestId: h.sent[0].requestId, bodyJson: h.sent[0].bodyJson });
    h.pending[1]({ kind: 'success', receipt: h.receipt(1) }); await retry;
    expect(session.getSnapshot().content).toBe('second');
  });

  it('recovers a lost creation response after refresh without creating another resource', async () => {
    const h = setup(); const session = await DocumentSession.create(h.deps, { title: 'New', format: 'text', content: 'offline' });
    const saving = session.flushRemote(); await drain(); h.pending[0]({ kind: 'unknown' }); await saving;
    const draft = (await h.store.listScope(h.deps.scopeKey))[0];
    const reloaded = setup({ store: h.store, sessionId: 'window-2', holdBranch: async () => true });
    reloaded.receipts.set(h.sent[0].requestId, { kind: 'found', receipt: h.receipt(0, 1) });
    const registry = new DocumentSessionRegistry(reloaded.deps);
    const recovered = await registry.restoreLocalDraft(draft.localId, draft.sessionId);
    await recovered.flushRemote();
    expect(recovered.getSnapshot().resourceId).toBe('created-doc');
    expect(reloaded.sent).toHaveLength(0);
    expect(registry.get('created-doc')).toBe(recovered);
    expect(registry.get(draft.localId)).toBe(recovered);
  });

  it('durably preserves a new title typed while creation is in flight and saves it separately', async () => {
    const h = setup();
    const titles: Array<{ title: string; requestId: string; bodyJson: string }> = [];
    h.transport.organize = async (write) => {
      titles.push(write);
      return { kind: 'success', receipt: { requestId: write.requestId, resourceId: write.resourceId, revision: 1, contentHash: 'hash:text', organizationRevision: 2 } };
    };
    const session = await DocumentSession.create(h.deps, { title: 'Untitled', format: 'text', content: 'text' });
    const creating = session.flushRemote(); await drain();
    session.setTitle('Changed while saving'); await session.flushLocal();
    expect((await h.store.listScope(h.deps.scopeKey))[0].title).toBe('Changed while saving');
    h.pending[0]({ kind: 'success', receipt: h.receipt(0, 1) }); await creating;
    expect(session.getSnapshot().status).toBe('local-only');
    await session.flushRemote();
    expect(titles[0].title).toBe('Changed while saving');
    expect(JSON.parse(titles[0].bodyJson).expectedOrganizationRevision).toBe(1);
    expect(session.getSnapshot().status).toBe('saved');
    expect(h.sent).toHaveLength(1);
  });

  it('groups rapid typing into session undo and keeps history across view subscriptions', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    session.edit('a'); h.clock.advance(100); session.edit('ab'); h.clock.advance(100); session.edit('abc');
    const unsubscribe = session.subscribe(() => {}); unsubscribe();
    session.undo(); expect(session.getSnapshot().content).toBe('base');
    session.redo(); expect(session.getSnapshot().content).toBe('abc');
  });

  it('keeps local, base and remote conflict content and never replays rejection on reconnect', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    session.edit('local'); h.setRemote(resource('doc-1', 'remote', 2));
    const saving = session.flushRemote(); await drain();
    h.pending[0]({ kind: 'rejected', error: { code: 'VERSION_CONFLICT', message: 'Conflict', status: 409 } }); await saving;
    expect(session.getSnapshot().conflict).toMatchObject({ local: 'local', base: { content: 'base' }, remote: { content: 'remote' } });
    await session.reconnect(); expect(h.sent).toHaveLength(1);
    await session.resolveConflict('merged');
    const resolving = session.flushRemote(); await drain();
    expect(h.sent[1].expectedRevision).toBe(2);
    expect(JSON.parse(h.sent[1].bodyJson).content).toBe('merged');
    h.pending[1]({ kind: 'success', receipt: h.receipt(1, 3) }); await resolving;
  });

  it('retains rejected drafts until explicit retry and uses a new request identity', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    session.edit('local'); const saving = session.flushRemote(); await drain();
    h.pending[0]({ kind: 'rejected', error: { code: 'FORBIDDEN', message: 'No access', status: 403 } }); await saving;
    await session.reconnect(); expect(h.sent).toHaveLength(1); expect(session.getSnapshot().content).toBe('local');
    const retry = session.retry(); await drain();
    expect(h.sent[1].requestId).not.toBe(h.sent[0].requestId);
    h.pending[1]({ kind: 'success', receipt: h.receipt(1) }); await retry;
  });

  it('does not submit or replace content during Chinese composition', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource());
    session.setComposing(true); session.edit('中文组词');
    session.receiveRemote(resource('doc-1', 'remote', 2));
    await session.flushRemote(); expect(h.sent).toHaveLength(0);
    expect(session.getSnapshot().content).toBe('中文组词'); expect(session.getSnapshot().conflict).toBeNull();
    session.setComposing(false);
    expect(session.getSnapshot().conflict?.local).toBe('中文组词');
  });

  it('keeps different windows as separate branches when the first window owns its draft', async () => {
    const h = setup(); const first = await DocumentSession.open(h.deps, resource());
    first.edit('window one'); await first.flushLocal();
    const second = setup({ store: h.store, sessionId: 'window-2', holdBranch: async () => false });
    const other = await DocumentSession.open(second.deps, resource()); other.edit('window two'); await other.flushLocal();
    expect((await h.store.load(h.deps.scopeKey, 'doc-1')).map((draft) => draft.content).sort()).toEqual(['window one', 'window two']);
    expect(other.getSnapshot().staleBranches).toEqual([]);
  });

  it('requires explicit recovery without Web Locks and never adopts another user scope', async () => {
    const h = setup(); const session = await DocumentSession.open(h.deps, resource()); session.edit('private'); await session.flushLocal();
    const next = setup({ store: h.store, sessionId: 'window-2' });
    const recovered = await DocumentSession.open(next.deps, resource());
    expect(recovered.getSnapshot().status).toBe('recovery');
    await recovered.restoreBranch('window-1'); expect(recovered.getSnapshot().content).toBe('private');
    const otherUser = setup({ store: h.store, scopeKey: 'workspace:bob' });
    expect((await DocumentSession.open(otherUser.deps, resource())).getSnapshot().content).toBe('base');
    expect(await new DocumentSessionRegistry(otherUser.deps).listDrafts()).not.toContainEqual(expect.objectContaining({ content: 'private' }));
  });

  it('restoring one of several branches leaves the others intact and enables only the selected draft', async () => {
    const h = setup(); const first = await DocumentSession.open(h.deps, resource()); first.edit('first branch'); await first.flushLocal();
    const second = setup({ store: h.store, sessionId: 'second-window', holdBranch: async () => false });
    const secondSession = await DocumentSession.open(second.deps, resource()); secondSession.edit('second branch'); await secondSession.flushLocal();
    const third = setup({ store: h.store, sessionId: 'recovery-window' });
    const restored = await DocumentSession.open(third.deps, resource()); expect(restored.getSnapshot().staleBranches).toHaveLength(2);
    await restored.restoreBranch('window-1'); restored.edit('continued first'); await restored.flushLocal();
    expect(restored.getSnapshot().status).toBe('local-only');
    expect((await h.store.load(h.deps.scopeKey, 'doc-1')).map((item) => item.content)).toContain('second branch');
    await restored.restoreBranch('second-window'); expect(restored.getSnapshot().content).toBe('continued first');
  });

  it('reuses one session for concurrent opens and deactivates all writes on workspace change', async () => {
    const h = setup(); const registry = new DocumentSessionRegistry(h.deps);
    const [first, second] = await Promise.all([registry.open(resource()), registry.open(resource())]); expect(first).toBe(second);
    first.edit('unsent'); registry.deactivate(); await first.flushRemote(); expect(h.sent).toHaveLength(0);
    expect((await h.store.load(h.deps.scopeKey, 'doc-1'))[0].content).toBe('unsent');
  });

  it('does not claim local success or send data after quota failure', async () => {
    const base = setup();
    const store: DocumentDraftStorage = { load: base.store.load.bind(base.store), listScope: base.store.listScope.bind(base.store), readFile: base.store.readFile.bind(base.store), adopt: base.store.adopt.bind(base.store), put: async () => { throw new DOMException('quota', 'QuotaExceededError'); }, putWithFile: async () => { throw new DOMException('quota', 'QuotaExceededError'); } };
    const h = setup({ store }); const session = await DocumentSession.open(h.deps, resource()); session.edit('must survive in memory');
    await session.flushRemote(); expect(h.sent).toHaveLength(0); expect(session.getSnapshot().status).toBe('storage-error');
  });
});

describe('attachment drafts remain tied to the original document session', () => {
  it('persists binary bytes and placeholder, blocks document save, then inserts a fixed version', async () => {
    const h = setup();
    let finish!: (result: { resourceId: string; revision: number }) => void;
    h.transport.upload = async (_upload, _file, _context, checkpoint) => { await checkpoint('server-upload'); return new Promise((resolve) => { finish = resolve; }); };
    const rich = { ...resource(), format: 'richdoc-v1' as const, schemaVersion: 1, content: emptyRichDocument() };
    const first = await DocumentSession.open(h.deps, rich);
    const other = await DocumentSession.open(h.deps, { ...rich, id: 'doc-2' });
    const file = new File(['image bytes'], 'screen.png', { type: 'image/png' });
    const id = await first.addUpload(file, { kind: 'image', bookmark: 'initial' }); await drain();
    const draft = (await h.store.load(h.deps.scopeKey, rich.id))[0];
    expect(await (await h.store.readFile(draft, id))?.text()).toBe('image bytes');
    expect(uploadIds(draft.content).has(id)).toBe(true);
    await first.flushRemote(); expect(h.sent).toHaveLength(0); expect(first.getSnapshot().status).toBe('uploading');
    finish({ resourceId: 'image-resource', revision: 4 }); await drain();
    expect(uploadIds(first.getSnapshot().content).size).toBe(0);
    expect(canonicalContent(first.getSnapshot().content)).toContain('image-resource');
    expect(canonicalContent(other.getSnapshot().content)).not.toContain('image-resource');
    const saving = first.flushRemote(); await drain();
    expect(JSON.parse(h.sent[0].bodyJson).content.blocks[1]).toMatchObject({ kind: 'image', target: { resourceId: 'image-resource', revision: 4 } });
    h.pending[0]({ kind: 'success', receipt: h.receipt(0) }); await saving;
  });

  it('keeps completed upload recoverable but does not reinsert a deleted placeholder', async () => {
    const h = setup(); let finish!: (result: { resourceId: string; revision: number }) => void;
    h.transport.upload = async () => new Promise((resolve) => { finish = resolve; });
    const session = await DocumentSession.open(h.deps, { ...resource(), format: 'richdoc-v1', schemaVersion: 1, content: emptyRichDocument() });
    const id = await session.addUpload(new File(['zip'], 'file.zip'), { kind: 'file' }); await drain();
    await session.removeUpload(id); finish({ resourceId: 'file-resource', revision: 1 }); await drain();
    expect(canonicalContent(session.getSnapshot().content)).not.toContain('file-resource');
    expect(session.getSnapshot().uploads[0]).toMatchObject({ state: 'removed', result: { resourceId: 'file-resource', revision: 1 } });
  });

  it('defers upload replacement during composition and reconciles against the final local text', async () => {
    const h = setup(); let finish!: (result: { resourceId: string; revision: number }) => void;
    h.transport.upload = async () => new Promise((resolve) => { finish = resolve; });
    const session = await DocumentSession.open(h.deps, { ...resource(), format: 'richdoc-v1', schemaVersion: 1, content: emptyRichDocument() });
    const id = await session.addUpload(new File(['image'], 'photo.png'), { kind: 'image' }); await drain();
    session.setComposing(true);
    finish({ resourceId: 'image-resource', revision: 3 }); await drain();
    expect(uploadIds(session.getSnapshot().content).has(id)).toBe(true);
    const content = session.getSnapshot().content;
    if (typeof content === 'string') throw new Error('expected rich document');
    session.edit({ ...content, blocks: [{ id: 'initial', kind: 'paragraph', text: [{ text: '中文输入完成' }] }, ...content.blocks.slice(1)] });
    session.setComposing(false);
    expect(canonicalContent(session.getSnapshot().content)).toContain('中文输入完成');
    expect(canonicalContent(session.getSnapshot().content)).toContain('image-resource');
    expect(uploadIds(session.getSnapshot().content).size).toBe(0);
  });

  it('explicitly retries an expired upload with a fresh upload identity and the same durable placeholder', async () => {
    const h = setup(); const requests: string[] = [];
    h.transport.upload = async (upload, _bytes, _context, checkpoint) => {
      requests.push(upload.requestId);
      if (requests.length === 1) { await checkpoint('expired-upload'); throw Object.assign(new Error('Expired'), { code: 'UPLOAD_EXPIRED' }); }
      expect(upload.uploadId).toBeUndefined(); return { resourceId: 'recovered-file', revision: 1 };
    };
    const session = await DocumentSession.open(h.deps, { ...resource(), format: 'richdoc-v1', schemaVersion: 1, content: emptyRichDocument() });
    const id = await session.addUpload(new File(['file'], 'a.zip'), { kind: 'file' }); await drain();
    expect(session.getSnapshot().uploads[0].state).toBe('failed');
    await session.retryUpload(id);
    expect(requests[1]).not.toBe(requests[0]);
    expect(session.getSnapshot().uploads[0]).toMatchObject({ id, state: 'ready', result: { resourceId: 'recovered-file', revision: 1 } });
  });
});
