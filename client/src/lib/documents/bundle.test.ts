import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import JSZip from 'jszip';
import { emptyRichDocument, type RichDocument } from '../../../../server/src/domain/document-content.js';
import { exportResourceBundle, importResourceBundle, readableCopies, validateResourceBundle, type BundleManifest } from './bundle.js';
import type { ResourceDocument } from './types.js';

const mocks = vi.hoisted(() => ({ read: vi.fn(), api: vi.fn(), upload: vi.fn(), active: true }));
vi.mock('./api.js', () => ({ loadResource: mocks.read, documentTransport: () => ({ upload: mocks.upload }) }));
vi.mock('../task-editor-runtime.js', () => ({ EditorRuntime: { current: () => ({ scopeKey: 'workspace:alice' }) }, isEditorRuntimeActive: () => mocks.active }));
vi.mock('../api.js', () => ({ authHeaders: () => ({}), api: mocks.api, ApiError: class ApiError extends Error { constructor(message: string, public code?: string, public status?: number) { super(message); } } }));

const rich = (id: string, content: RichDocument): ResourceDocument => ({ id, revision: 1, currentRevision: 1, organizationRevision: 1, title: 'A document', kind: 'document', format: 'richdoc-v1', schemaVersion: 1, content, contentHash: '', readOnly: false, supported: true });
const file: ResourceDocument = { ...rich('image-old', emptyRichDocument()), title: 'Image', format: 'binary', kind: 'attachment', content: '', schemaVersion: null, attachment: { fileName: 'image.png', mimeType: 'image/png' } };
const document: RichDocument = { schemaVersion: 1, blocks: [{ id: 'paragraph', kind: 'paragraph', text: [{ text: '<script>hello</script>' }] }, { id: 'image', kind: 'image', target: { resourceId: 'image-old', revision: 1 }, alt: 'Image', width: 320 }, { id: 'file', kind: 'file', target: { resourceId: 'image-old', revision: 1 }, label: 'Download' }] };
beforeEach(() => {
  vi.clearAllMocks(); mocks.active = true; vi.stubGlobal('indexedDB', new IDBFactory());
  mocks.read.mockImplementation(async (id: string) => id === 'root-old' ? rich(id, document) : file);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } })));
});

describe('resource bundle preservation and validation', () => {
  it('exports Markdown aliases as exact dependencies and remaps them on import without changing source text', async () => {
    const markdown = '![封面](../images/cover.png)\r\n\r\n[下载][attachment]\r\n\r\n[attachment]: ../images/cover.png\r\n';
    const refs = [{ path: '../images/cover.png', resourceId: 'image-old', revision: 1 }];
    mocks.read.mockImplementation(async (id: string) => id === 'root-old' ? { ...rich(id, emptyRichDocument()), format: 'markdown', schemaVersion: null, content: markdown, relativeReferences: refs } : file);
    const exported = await exportResourceBundle('root-old', 1);
    const bundle = await validateResourceBundle(exported);
    expect(bundle.manifest.resources[0].relativeReferences).toEqual(refs);
    expect(bundle.manifest.resources).toHaveLength(2);
    expect(JSON.parse(new TextDecoder().decode(bundle.files.get('resources/r0/body.json')))).toBe(markdown);
    expect(new TextDecoder().decode(bundle.files.get('readable/r0.md'))).toContain('../resources/r1/original.png');
    const writes: Record<string, unknown>[] = [];
    const { ApiError } = await import('../api.js');
    mocks.upload.mockResolvedValue({ resourceId: 'original-new', revision: 1 });
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/receipts/')) throw new ApiError('missing', 'NOT_FOUND', 404);
      const body = JSON.parse(String(init?.body)); writes.push(body);
      return { id: body.format === 'binary' ? 'image-new' : 'root-new', revision: 1 };
    });
    await importResourceBundle(exported, 'workspace:alice');
    expect(writes.find((body) => body.format === 'markdown')).toMatchObject({ managed: false, content: markdown, relativeReferences: [{ path: '../images/cover.png', resourceId: 'image-new', revision: 1 }] });
    expect(writes.find((body) => body.format === 'binary')).toMatchObject({ managed: true });
  });
  it('exports exact transitive files once with checksums and relative readable copies', async () => {
    const blob = await exportResourceBundle('root-old', 1);
    const bundle = await validateResourceBundle(blob);
    expect(bundle.manifest.resources).toHaveLength(2);
    expect(mocks.read.mock.calls).toEqual([['root-old', 1], ['image-old', 1]]);
    const html = new TextDecoder().decode(bundle.files.get('readable/r0.html'));
    expect(html).toContain('../resources/r1/original.png');
    expect(html).toContain('&lt;script&gt;hello&lt;/script&gt;');
    expect(html).not.toContain('/api/');
    expect(bundle.files.get('resources/r1/original.png')).toEqual(new Uint8Array([1, 2, 3]));
    expect(JSON.parse(new TextDecoder().decode(bundle.files.get('resources/r0/body.json')))).toEqual(document);
  });

  it('rejects modified bytes and unlisted files before any import write', async () => {
    const exported = await exportResourceBundle('root-old', 1);
    const zip = await JSZip.loadAsync(await exported.arrayBuffer());
    zip.file('resources/r1/original.png', new Uint8Array([9, 8, 7]));
    await expect(validateResourceBundle(await zip.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow('BUNDLE_CHECKSUM_MISMATCH');
    const extra = await JSZip.loadAsync(await exported.arrayBuffer()); extra.file('extra.js', 'alert(1)');
    await expect(validateResourceBundle(await extra.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow('BUNDLE_UNDECLARED_FILE');
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('rejects path traversal in an archive even when ZIP sanitizes its displayed name', async () => {
    const zip = new JSZip(); zip.file('../outside', 'bad'); zip.file('manifest.json', '{}');
    await expect(validateResourceBundle(await zip.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow('UNSAFE_BUNDLE_PATH');
  });

  it('rejects forged declared allocation budgets before inflating a large entry', async () => {
    const blob = await exportResourceBundle('root-old', 1);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as BundleManifest;
    manifest.files['resources/r1/original.png'].size = 1;
    zip.file('manifest.json', JSON.stringify(manifest));
    await expect(validateResourceBundle(await zip.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow('BUNDLE_BUDGET_EXCEEDED');
  });

  it('renders tables with spans and code fences without executing HTML text', () => {
    const copies = readableCopies({ schemaVersion: 1, blocks: [
      { id: 'code', kind: 'codeBlock', language: 'js', text: [{ text: '```\n<script>oops</script>' }] },
      { id: 'table', kind: 'table', children: [{ id: 'row', kind: 'tableRow', children: [{ id: 'cell', kind: 'tableCell', colspan: 2, children: [{ id: 'cell-text', kind: 'paragraph', text: [{ text: 'A&B' }] }] }] }] },
    ] }, () => 'file');
    expect(copies.markdown).toContain('````js'); expect(copies.markdown).toContain('colspan="2"');
    expect(copies.html).not.toContain('<script>'); expect(copies.html).toContain('A&amp;B');
  });

  it('imports new identities, remaps exact references, and resumes after a lost creation response', async () => {
    const exported = await exportResourceBundle('root-old', 1);
    const { ApiError } = await import('../api.js');
    const receipts = new Map<string, { resourceId: string; revision: number; requestId: string }>();
    const writes: Record<string, unknown>[] = []; let loseResponse = true;
    mocks.upload.mockImplementation(async (_upload, _file, _context, checkpoint) => { await checkpoint('upload-new'); return { resourceId: 'image-original-new', revision: 1 }; });
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/receipts/')) { const receipt = receipts.get(path.split('/').pop()!); if (!receipt) throw new ApiError('missing', 'NOT_FOUND', 404); return receipt; }
      const body = JSON.parse(String(init?.body)); writes.push(body);
      const id = body.format === 'binary' ? 'image-new' : 'root-new';
      const receipt = { requestId: body.requestId, resourceId: id, revision: 1 }; receipts.set(body.requestId, receipt);
      if (loseResponse && body.format !== 'binary') { loseResponse = false; throw new Error('connection lost'); }
      return { id, revision: 1 };
    });
    await expect(importResourceBundle(exported, 'workspace:alice')).rejects.toThrow('connection lost');
    const result = await importResourceBundle(exported, 'workspace:alice');
    expect(result).toEqual({ resourceId: 'root-new', revision: 1 });
    expect(writes).toHaveLength(2); expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(writes[0].importSource).toEqual({ original: { resourceId: 'image-original-new', revision: 1 } });
    expect((writes[1].content as RichDocument).blocks[1].target).toEqual({ resourceId: 'image-new', revision: 1 });
    expect(writes[1]).not.toHaveProperty('id'); expect(writes[1]).not.toHaveProperty('expectedRevision');
    expect(await importResourceBundle(exported, 'workspace:alice')).toEqual(result);
  });

  it('refuses a changed authenticated scope before touching an import journal or sending data', async () => {
    const exported = await exportResourceBundle('root-old', 1); mocks.active = false;
    await expect(importResourceBundle(exported, 'old-workspace')).rejects.toThrow('DOCUMENT_SCOPE_CHANGED');
    expect(mocks.api).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('reconstructs imported original, source-original and supplemental notes on the new version', async () => {
    const current = '# Current\r\n', source = '\ufeff# Source\r\n';
    mocks.read.mockResolvedValue({ ...rich('markdown-old', emptyRichDocument()), format: 'markdown', schemaVersion: null, content: current, hasSourceOriginal: true, supplementalContent: 'Legacy notes', attachment: { fileName: 'plan.md', mimeType: 'text/markdown' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.endsWith('/source-original') ? source : current)));
    const bundle = await exportResourceBundle('markdown-old', 1);
    const { ApiError } = await import('../api.js'); let created: Record<string, unknown> | undefined;
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/receipts/')) throw new ApiError('missing', 'NOT_FOUND', 404);
      created = JSON.parse(String(init?.body)); return { id: 'new-markdown', revision: 1 };
    });
    mocks.upload.mockImplementation(async (upload, bytes, context, checkpoint) => {
      expect(context.managed).toBe(true); await checkpoint(`${upload.id}-upload`);
      expect([current, source]).toContain(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await bytes.arrayBuffer()));
      return { resourceId: `${upload.id}-new`, revision: 1 };
    });
    expect(await importResourceBundle(bundle, 'workspace:alice')).toEqual({ resourceId: 'new-markdown', revision: 1 });
    expect(created).toMatchObject({ content: current, format: 'markdown', importSource: { original: { resourceId: 'r0-original-new', revision: 1 }, sourceOriginal: { resourceId: 'r0-source-new', revision: 1 }, supplementalContent: 'Legacy notes' } });
  });
});
