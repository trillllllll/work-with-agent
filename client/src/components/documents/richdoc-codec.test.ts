import { describe, expect, it } from 'vitest';
import { canonicalContent, contentText, inspectRichDocument, type RichDocument } from '../../../../server/src/domain/document-content.js';
import { editorToRichDocument, inspectLocalDocument, richDocumentToEditor } from './richdoc-codec.js';

const fixture: RichDocument = { schemaVersion: 1, blocks: [
  { id: 'title', kind: 'heading', level: 2, text: [{ text: '支付方案', marks: [{ kind: 'bold' }] }] },
  { id: 'paragraph', kind: 'paragraph', text: [{ text: '说明' }, { text: '', break: true }, { text: '官网', marks: [{ kind: 'link', href: 'https://example.com' }] }] },
  { id: 'list', kind: 'taskList', children: [{ id: 'item', kind: 'taskItem', checked: true, children: [{ id: 'itemText', kind: 'paragraph', text: [{ text: '已核对' }] }] }] },
  { id: 'code', kind: 'codeBlock', language: 'typescript', text: [{ text: 'const 中文 = 1;\n' }] },
  { id: 'table', kind: 'table', children: [{ id: 'row', kind: 'tableRow', children: [{ id: 'cell', kind: 'tableCell', colspan: 1, rowspan: 1, colwidth: [240], children: [{ id: 'cellText', kind: 'paragraph', text: [{ text: '金额' }] }] }] }] },
  { id: 'image', kind: 'image', target: { resourceId: 'image-resource', revision: 3 }, width: 420, alt: '截图', caption: '确切版本' },
  { id: 'file', kind: 'file', target: { resourceId: 'zip-resource', revision: 1 }, label: '附件.zip' },
] };

describe('richdoc product contract', () => {
  it('round-trips mixed content, identities, image properties, code language and fixed references', () => {
    expect(inspectRichDocument(fixture).supported).toBe(true);
    expect(editorToRichDocument(richDocumentToEditor(fixture))).toEqual(fixture);
    expect(inspectRichDocument(fixture).references).toEqual([
      { nodeId: 'image', resourceId: 'image-resource', revision: 3, mode: 'fixed' },
      { nodeId: 'file', resourceId: 'zip-resource', revision: 1, mode: 'fixed' },
    ]);
  });
  it('retains an unknown schema without permitting an editor conversion or lossy write', () => {
    for (const future of [ { ...fixture, schemaVersion: 2 }, { ...fixture, blocks: [...fixture.blocks, { id: 'new', kind: 'future-chart', payload: { secret: 1 } }] }, { ...fixture, blocks: [{ ...fixture.blocks[0], futureProperty: true }] } ]) {
      const original = JSON.stringify(future);
      expect(inspectRichDocument(future).supported).toBe(false);
      expect(() => richDocumentToEditor(future as RichDocument)).toThrow('UNSUPPORTED_DOCUMENT_SCHEMA');
      expect(JSON.stringify(future)).toBe(original);
    }
  });
  it('keeps upload placeholders in device drafts and rejects them as publishable references', () => {
    const draft = { ...fixture, blocks: [...fixture.blocks, { id: 'pending', kind: 'upload' as const, uploadId: 'upload-1', label: '图.png' }] };
    expect(inspectLocalDocument(draft).supported).toBe(true);
    expect(editorToRichDocument(richDocumentToEditor(draft))).toEqual(draft);
    expect(inspectRichDocument(draft).supported).toBe(false);
  });
  it('gives copied duplicate blocks a new identity without changing originals', () => {
    const editor = richDocumentToEditor(fixture); editor.content!.push(structuredClone(editor.content![0]));
    const result = editorToRichDocument(editor, () => 'copied-title');
    expect(result.blocks[0].id).toBe('title'); expect(result.blocks[result.blocks.length - 1]?.id).toBe('copied-title');
  });
  it('rejects unsafe links, forged references and invalid node nesting', () => {
    const invalids = [
      { id: 'p', kind: 'paragraph', text: [{ text: 'x', marks: [{ kind: 'link', href: 'javascript:alert(1)' }] }] },
      { id: 'i', kind: 'image', target: { resourceId: '../other', revision: 1 } },
      { id: 'c', kind: 'tableCell', children: [{ id: 'p', kind: 'paragraph', text: [] }] },
      { id: 'p', kind: 'paragraph', text: [{ text: 'x', marks: [{ kind: 'unknown' }] }] },
    ];
    for (const block of invalids) expect(inspectRichDocument({ schemaVersion: 1, blocks: [block] }).supported).toBe(false);
  });
  it('generates deterministic content bytes while preserving plain text exactly', () => {
    expect(canonicalContent({ b: 2, a: 1 })).toBe(canonicalContent({ a: 1, b: 2 }));
    expect(canonicalContent('  # not markdown\r\n')).toBe('  # not markdown\r\n');
    expect(contentText('richdoc-v1', fixture)).toContain('const 中文 = 1;\n');
    expect(contentText('richdoc-v1', fixture)).not.toContain('附件.zip');
  });
});
