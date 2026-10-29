import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canSaveDocumentAs, convertDocumentCopy, pendingSaveAs, saveAsFormats, saveDocumentAs } from './save-as.js';
import type { DocumentSnapshot, ResourceDocument } from './types.js';

const mocks = vi.hoisted(() => ({ read: vi.fn(), api: vi.fn(), active: true }));
vi.mock('./api.js', () => ({ loadResource: mocks.read }));
vi.mock('../api.js', () => ({ api: mocks.api, ApiError: class ApiError extends Error { constructor(message: string, public code?: string, public status?: number) { super(message); } }, authHeaders: () => ({}) }));
vi.mock('../task-editor-runtime.js', () => ({ isEditorRuntimeActive: () => mocks.active, EditorRuntime: { current: () => null } }));
const resource = (format: ResourceDocument['format'] = 'text', content: ResourceDocument['content'] = '正文'): ResourceDocument => ({ id: 'source', title: '来源', format, content, revision: 2, currentRevision: 2, organizationRevision: 1, contentHash: 'hash', schemaVersion: format === 'richdoc-v1' ? 1 : null, readOnly: false, supported: true, kind: format });
beforeEach(() => {
  vi.clearAllMocks(); mocks.active = true;
  const data = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
});

describe('save as document conversion', () => {
  it('preserves text/Markdown bytes and rejects unknown rich schemas', async () => {
    const source = '\ufeff# 标题\r\n\r\n![图](image.png)\r\n';
    expect((await convertDocumentCopy(resource('text', source), 'markdown')).content).toBe(source);
    expect(await convertDocumentCopy({ ...resource('markdown', source), relativeReferences: [{ path: 'image.png', resourceId: 'image', revision: 1 }] }, 'text')).toEqual({ content: source, relativeReferences: [] });
    const unknown = resource('richdoc-v1', { schemaVersion: 2, blocks: [] } as never);
    expect(saveAsFormats(unknown)).toEqual([]);
    await expect(convertDocumentCopy(unknown, 'text')).rejects.toThrow('DOCUMENT_CONVERSION_UNSUPPORTED');
  });

  it('preserves rich text and exact resources while making table loss explicit in readable code text', async () => {
    const rich = resource('richdoc-v1', { schemaVersion: 1, blocks: [
      { id: 'heading', kind: 'heading', level: 1, text: [{ text: '方案' }] },
      { id: 'link', kind: 'paragraph', text: [{ text: '链接', marks: [{ kind: 'link', href: 'https://example.com/evidence' }] }] },
      { id: 'picture', kind: 'image', width: 320, alt: '封面', target: { resourceId: 'image', revision: 3 } },
      { id: 'file', kind: 'file', label: '证据', target: { resourceId: 'file', revision: 4 } },
      { id: 'table', kind: 'table', children: [{ id: 'row', kind: 'tableRow', children: [{ id: 'cell', kind: 'tableCell', colspan: 2, children: [{ id: 'p', kind: 'paragraph', text: [{ text: '原表文字' }] }] }] }] },
    ] });
    const before = JSON.stringify(rich);
    const markdown = await convertDocumentCopy(rich, 'markdown');
    expect(markdown.content).toContain('# 方案'); expect(markdown.content).toContain('![封面](assets/resource-1)'); expect(markdown.content).toContain('```\n原表文字\n```');
    expect(markdown.relativeReferences).toEqual([{ path: 'assets/resource-1', resourceId: 'image', revision: 3 }, { path: 'assets/resource-2', resourceId: 'file', revision: 4 }]);
    const plain = await convertDocumentCopy(rich, 'text');
    expect(plain.content).toContain('封面 (wwa-material:image · v3)'); expect(plain.content).toContain('链接 (https://example.com/evidence)'); expect(plain.content).toContain('原表文字'); expect(plain.relativeReferences).toEqual([]);
    expect(JSON.stringify(rich)).toBe(before);
  });

  it('requires a confirmed snapshot without conflict, upload, or newer unsaved identity', () => {
    const snapshot = { status: 'saved', resourceId: 'source', revision: 2, uploads: [], staleBranches: [], conflict: null, error: null } as unknown as DocumentSnapshot;
    expect(canSaveDocumentAs(resource(), snapshot)).toBe(true);
    for (const change of [{ status: 'local-pending' }, { status: 'conflict' }, { revision: 1 }, { uploads: [{ state: 'queued' }] }]) expect(canSaveDocumentAs(resource(), { ...snapshot, ...change } as DocumentSnapshot)).toBe(false);
  });

  it('retries a lost response with the same body and exact source version', async () => {
    mocks.read.mockResolvedValue(resource()); mocks.api.mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce({ id: 'copy', revision: 1 });
    await expect(saveDocumentAs('scope', resource(), 'markdown', '副本')).rejects.toThrow('lost reply');
    expect(pendingSaveAs('scope', resource())).toMatchObject({ conversionSource: { resourceId: 'source', revision: 2 } });
    await expect(saveDocumentAs('scope', resource(), 'markdown', '副本')).resolves.toMatchObject({ id: 'copy' });
    expect(mocks.api.mock.calls[0][1].body).toBe(mocks.api.mock.calls[1][1].body);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith('source', 2); expect(pendingSaveAs('scope', resource())).toBeNull();
  });

  it('does not send after switching scope, and clears definite rejections without retrying them automatically', async () => {
    mocks.active = false; await expect(saveDocumentAs('scope', resource(), 'markdown', '副本')).rejects.toThrow('DOCUMENT_SCOPE_CHANGED'); expect(mocks.api).not.toHaveBeenCalled();
    mocks.active = true; mocks.read.mockResolvedValue(resource());
    const { ApiError } = await import('../api.js'); mocks.api.mockRejectedValue(new ApiError('Denied', 'SCOPE_DENIED', 403));
    await expect(saveDocumentAs('scope', resource(), 'markdown', '副本')).rejects.toThrow('Denied'); expect(pendingSaveAs('scope', resource())).toBeNull();
  });
});
