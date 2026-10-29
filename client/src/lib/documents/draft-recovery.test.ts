import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { IDBFactory } from 'fake-indexeddb';
import { emptyRichDocument } from '../../../../server/src/domain/document-content.js';
import { DocumentDraftStore } from './draft-store.js';
import { DocumentSession, type DocumentSessionDeps } from './session.js';
import { exportDraftRecovery, type DraftRecoveryManifest } from './draft-recovery.js';
import type { DocumentDraft, DocumentDraftStorage, DocumentTransport } from './types.js';

function setup(store: DocumentDraftStorage = new DocumentDraftStore(new IDBFactory())) {
  let sends = 0;
  const transport: DocumentTransport = { send: async () => { sends++; return { kind: 'unknown' }; }, receipt: async () => { throw new Error('No network'); }, read: async () => { throw new Error('No network'); } };
  const deps: DocumentSessionDeps = { store, transport, scopeKey: 'workspace:alice', deviceId: 'device', sessionId: 'window', isActive: () => true, schedule: () => () => {} };
  return { deps, sent: () => sends };
}

describe('local document recovery package', () => {
  it('downloads pending files from memory and restored IDB without a network request', async () => {
    const h = setup();
    const session = await DocumentSession.create(h.deps, { title: 'Individual rescue', format: 'richdoc-v1', content: emptyRichDocument() });
    const file = new File([new Uint8Array([0, 17, 255])], 'local.bin', { type: 'application/octet-stream' });
    const id = await session.addUpload(file, { kind: 'file' });
    expect(await session.recoveryAttachment(id)).toBe(file);
    const restored = await DocumentSession.restore(h.deps, (await session.recoverySnapshot()).draft);
    expect(new Uint8Array(await (await restored.recoveryAttachment(id)).arrayBuffer())).toEqual(new Uint8Array([0, 17, 255]));
    await expect(restored.recoveryAttachment('not-in-this-draft')).rejects.toThrow('LOCAL_ATTACHMENT_UNAVAILABLE');
    expect(h.sent()).toBe(0);
  });

  it('can retrieve three 100 MiB attachments separately without the recovery ZIP budget', async () => {
    const backing = new DocumentDraftStore(new IDBFactory());
    const blob = new Blob([new Uint8Array(100 * 1024 * 1024)], { type: 'application/octet-stream' });
    const h = setup({ load: backing.load.bind(backing), listScope: backing.listScope.bind(backing), put: backing.put.bind(backing), putWithFile: backing.putWithFile.bind(backing), adopt: backing.adopt.bind(backing), readFile: async () => blob });
    const session = await DocumentSession.create(h.deps, { title: 'Large individual rescue', format: 'richdoc-v1', content: emptyRichDocument() });
    const draft = (await session.recoverySnapshot()).draft;
    draft.uploads = Array.from({ length: 3 }, (_, index) => ({ id: `large-${index}`, nodeId: `large-node-${index}`, fileName: `${index}.bin`, size: blob.size, mimeType: blob.type, kind: 'file', requestId: `pending-${index}`, state: 'queued', durable: true }));
    const restored = await DocumentSession.restore(h.deps, draft);
    for (const upload of draft.uploads) expect((await restored.recoveryAttachment(upload.id)).size).toBe(100 * 1024 * 1024);
    expect(h.sent()).toBe(0);
  });

  it('reports missing local file bytes without falling back to a server download', async () => {
    const h = setup(); const session = await DocumentSession.create(h.deps, { title: 'Missing local file', format: 'text', content: '' });
    const draft = (await session.recoverySnapshot()).draft;
    draft.uploads = [{ id: 'missing', nodeId: 'missing', fileName: 'a.bin', size: 1, mimeType: 'application/octet-stream', kind: 'file', requestId: 'pending', state: 'queued', durable: true }];
    const restored = await DocumentSession.restore(h.deps, draft);
    await expect(restored.recoveryAttachment('missing')).rejects.toThrow('LOCAL_ATTACHMENT_UNAVAILABLE');
    expect(h.sent()).toBe(0);
  });

  it('exports failed raw editor state alongside the last valid product body without publishing either', async () => {
    const h = setup(); const session = await DocumentSession.create(h.deps, { title: 'Raw rescue', format: 'text', content: 'last valid' });
    const raw = { type: 'doc', content: [{ type: 'unknown', attrs: { token: 'raw-newer-input' } }] };
    session.captureEditorFailure('primary', raw, 'Unsupported node'); await session.flushLocal();
    const result = await exportDraftRecovery(session); const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(JSON.parse(await zip.file('editor-recovery/0.json')!.async('string')).editorJson).toEqual(raw);
    expect(JSON.parse(await zip.file('content.json')!.async('string'))).toBe('last valid');
    expect((JSON.parse(await zip.file('draft.json')!.async('string')) as DocumentDraft).editorRecovery?.[0].editorJson).toEqual(raw);
    expect(result.complete).toBe(true); expect(h.sent()).toBe(0);
  });
  it('preserves unknown request bytes and pending upload bytes without any replay', async () => {
    const h = setup();
    const session = await DocumentSession.create(h.deps, { title: 'Local rescue', format: 'richdoc-v1', content: emptyRichDocument() });
    await session.flushRemote();
    expect(h.sent()).toBe(1);
    const expected = (await session.recoverySnapshot()).draft.pending;
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const uploadId = await session.addUpload(new File([bytes], 'untrusted/../filename.bin', { type: 'application/octet-stream' }), { kind: 'file' });
    const before = await session.recoverySnapshot();
    const exported = await exportDraftRecovery(session);
    expect(exported).toMatchObject({ complete: true, missingUploadIds: [] });
    expect(h.sent()).toBe(1);
    const zip = await JSZip.loadAsync(await exported.blob.arrayBuffer());
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as DraftRecoveryManifest;
    const draft = JSON.parse(await zip.file('draft.json')!.async('string')) as DocumentDraft;
    expect(draft.pending).toEqual(expected);
    expect(draft).toEqual(before.draft);
    expect(manifest).toMatchObject({ automaticReplayAllowed: false, complete: true });
    const attachment = manifest.files.find((entry) => entry.uploadId === uploadId)!;
    expect(attachment.path).toBe('uploads/0.bin');
    expect(await zip.file(attachment.path)!.async('uint8array')).toEqual(bytes);
    for (const entry of manifest.files) {
      const data = await zip.file(entry.path)!.async('uint8array');
      const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      expect(actual).toBe(entry.sha256); expect(data.byteLength).toBe(entry.size);
    }
  });

  it('exports in-memory attachment bytes when IndexedDB writes fail', async () => {
    const backing = new DocumentDraftStore(new IDBFactory());
    const h = setup({ load: backing.load.bind(backing), listScope: backing.listScope.bind(backing), readFile: backing.readFile.bind(backing), adopt: backing.adopt.bind(backing), put: async () => { throw new Error('Quota'); }, putWithFile: async () => { throw new Error('Quota'); } });
    const session = await DocumentSession.create(h.deps, { title: 'Quota rescue', format: 'richdoc-v1', content: emptyRichDocument() });
    await session.addUpload(new File(['memory-only'], 'a.txt'), { kind: 'file' });
    expect(session.getSnapshot().status).toBe('storage-error');
    const result = await exportDraftRecovery(session);
    expect(result.complete).toBe(true);
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(await zip.file('uploads/0.bin')!.async('string')).toBe('memory-only');
    expect(h.sent()).toBe(0);
  });

  it('keeps a restored draft readable and explicitly marks unavailable local attachment bytes', async () => {
    const h = setup();
    const session = await DocumentSession.create(h.deps, { title: 'Missing bytes', format: 'richdoc-v1', content: emptyRichDocument() });
    const draft = (await session.recoverySnapshot()).draft;
    draft.uploads.push({ id: 'missing', nodeId: 'missing-node', fileName: 'missing.bin', size: 9, mimeType: 'application/octet-stream', kind: 'file', requestId: 'not-sent', state: 'queued', durable: true });
    const restored = await DocumentSession.restore(h.deps, draft);
    const result = await exportDraftRecovery(restored);
    expect(result).toMatchObject({ complete: false, missingUploadIds: ['missing'] });
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(JSON.parse(await zip.file('draft.json')!.async('string'))).toEqual(draft);
    expect(h.sent()).toBe(0);
  });
});
