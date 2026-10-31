import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { canonicalContent } from '../../../../server/src/domain/document-content.js';
import { editorToRichDocument, inspectLocalDocument, richDocumentToEditor, type LocalRichBlock, type LocalRichDocument } from '../../components/documents/richdoc-codec.js';
import { measureRichDocument } from '../../components/documents/RichDocumentBoundary.js';
import { documentEditorExtensions } from '../../components/documents/RichDocumentEditor.js';
import { canonicalDocument, measureDocument, richDocumentFromEditorDoc, richDocumentSupported, sameDocument } from './content-cache.js';

/** Deterministic pseudo-random generator so a failing case can be replayed. */
function random(seed: number) { let state = seed >>> 0; return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; }; }
const budgets = [{ blocks: 3, bytes: 400 }, { blocks: 50, bytes: 4_000 }, { blocks: 500, bytes: 256 * 1024 }, { blocks: 1e9, bytes: 1e9 }];
const unbounded = { blocks: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY };

function generator(seed: number, options: { invalid?: boolean } = {}) {
  const next = random(seed); let counter = 0;
  const pick = <T,>(values: T[]) => values[Math.floor(next() * values.length)];
  const id = () => `b${seed}-${counter++}`;
  const runs = (code = false) => Array.from({ length: Math.floor(next() * 4) }, () => {
    if (code) return { text: pick(['const a = 1', 'x', '\tindent', '中文😀']) };
    if (next() < 0.1) return { text: '', break: true as const };
    const marks = next() < 0.4 ? [pick([{ kind: 'bold' as const }, { kind: 'italic' as const }, { kind: 'strike' as const }, { kind: 'code' as const }, { kind: 'link' as const, href: pick(['https://example.com', 'mailto:a@b.c', ...(options.invalid ? ['javascript:alert(1)'] : [])]) }])] : undefined;
    return { text: pick(['普通文字', 'quote "x"', 'back\\slash', '😀 emoji', 'a']), ...(marks ? { marks } : {}) };
  });
  const paragraphBlock = (): LocalRichBlock => ({ id: id(), kind: 'paragraph', text: runs() });
  const item = (kind: 'listItem' | 'taskItem', depth: number): LocalRichBlock => ({ id: id(), kind, ...(kind === 'taskItem' ? { checked: next() < 0.5 } : {}), children: [paragraphBlock(), ...(depth < 2 && next() < 0.3 ? [list(depth + 1)] : [])] } as LocalRichBlock);
  const list = (depth = 0): LocalRichBlock => {
    const kind = pick(['bulletList', 'orderedList', 'taskList'] as const);
    return { id: id(), kind, ...(kind === 'orderedList' && next() < 0.5 ? { start: 3 } : {}), children: Array.from({ length: 1 + Math.floor(next() * 3) }, () => item(kind === 'taskList' ? 'taskItem' : 'listItem', depth)) } as LocalRichBlock;
  };
  const block = (): LocalRichBlock => {
    const kind = pick(['paragraph', 'paragraph', 'heading', 'codeBlock', 'list', 'blockquote', 'table', 'horizontalRule', 'image', 'file', 'upload', ...(options.invalid ? ['unknown', 'duplicate'] : [])]);
    switch (kind) {
      case 'heading': return { id: id(), kind: 'heading', level: 1 + Math.floor(next() * 6), text: runs() };
      case 'codeBlock': return { id: id(), kind: 'codeBlock', ...(next() < 0.5 ? { language: 'ts' } : {}), text: runs(true) };
      case 'list': return list();
      case 'blockquote': return { id: id(), kind: 'blockquote', children: [paragraphBlock(), ...(next() < 0.3 ? [paragraphBlock()] : [])] };
      case 'table': return { id: id(), kind: 'table', children: Array.from({ length: 2 }, (_, row) => ({ id: id(), kind: 'tableRow', children: Array.from({ length: 2 }, () => ({ id: id(), kind: row ? 'tableCell' : 'tableHeader', ...(next() < 0.3 ? { align: 'center' } : {}), children: [paragraphBlock()] })) })) } as LocalRichBlock;
      case 'horizontalRule': return { id: id(), kind: 'horizontalRule' };
      case 'image': return { id: id(), kind: 'image', target: { resourceId: 'img-1', revision: 2 }, alt: 'alt', ...(next() < 0.5 ? { width: 320 } : {}) };
      case 'file': return { id: id(), kind: 'file', target: { resourceId: 'file-1', revision: 1 }, label: 'a.pdf' };
      case 'upload': return { id: id(), kind: 'upload', uploadId: `u-${counter}`, label: 'pending.png' };
      case 'unknown': return { id: id(), kind: 'mystery' } as unknown as LocalRichBlock;
      case 'duplicate': return { id: `b${seed}-0`, kind: 'paragraph', text: [] };
      default: return paragraphBlock();
    }
  };
  return () => ({ schemaVersion: 1, blocks: Array.from({ length: Math.floor(next() * 12) }, block) }) as LocalRichDocument;
}

function expectSameAsWholeDocument(doc: LocalRichDocument) {
  expect(richDocumentSupported(doc)).toBe(inspectLocalDocument(doc).supported);
  expect(canonicalDocument(doc)).toBe(canonicalContent(doc));
  for (const budget of budgets) expect(measureDocument(doc, budget).withinBudget).toBe(measureRichDocument(doc, budget).withinBudget);
  const exact = measureRichDocument(doc, unbounded);
  expect(measureDocument(doc, unbounded)).toMatchObject({ blocks: exact.blocks, bytes: exact.bytes });
  expect(measureDocument(doc, unbounded).bytes).toBe(new TextEncoder().encode(JSON.stringify(doc)).byteLength);
}

describe('per-block document caches', () => {
  it('match the whole-document functions for random valid and invalid documents', () => {
    let supported = 0; let unsupported = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const doc = generator(seed, { invalid: seed % 3 === 0 })();
      if (inspectLocalDocument(doc).supported) supported++; else unsupported++;
      expectSameAsWholeDocument(doc);
      // A second pass is served from the caches and must not change any answer.
      expectSameAsWholeDocument(doc);
      expectSameAsWholeDocument({ ...doc, blocks: [...doc.blocks].reverse() });
    }
    expect(supported).toBeGreaterThan(150); expect(unsupported).toBeGreaterThan(30);
  });

  it('match for the structural limits and unusual document shapes', () => {
    let depth: LocalRichBlock = { id: 'deep-0', kind: 'paragraph', text: [{ text: 'x' }] };
    for (let level = 1; level <= 70; level++) depth = { id: `deep-${level}`, kind: 'blockquote', children: [depth] };
    const cases: unknown[] = [
      { schemaVersion: 1, blocks: [depth] },
      { schemaVersion: 1, blocks: Array.from({ length: 25_001 }, (_, index) => ({ id: `n-${index}`, kind: 'paragraph', text: [{ text: 'x' }] })) },
      { schemaVersion: 1, blocks: [] },
      { schemaVersion: 2, blocks: [{ id: 'a', kind: 'paragraph', text: [] }] },
      { schemaVersion: 1, blocks: [{ id: 'a', kind: 'paragraph', text: [] }], extra: undefined },
      { schemaVersion: 1, blocks: [null] },
      { schemaVersion: 1, blocks: [{ id: 'same', kind: 'paragraph', text: [] }, { id: 'same', kind: 'paragraph', text: [] }] },
    ];
    for (const value of cases) {
      expect(richDocumentSupported(value)).toBe(inspectLocalDocument(value).supported);
      expect(canonicalDocument(value)).toBe(canonicalContent(value));
    }
  });

  it('convert an editor document exactly like the full conversion, through a random edit sequence', () => {
    const schema = getSchema(documentEditorExtensions());
    let compared = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed * 7919); let fresh = 0;
      const source = generator(seed)();
      if (!source.blocks.length || !inspectLocalDocument(source).supported) continue;
      let state = EditorState.create({ schema, doc: schema.nodeFromJSON(richDocumentToEditor(source)) });
      // Real editors give split and pasted blocks new identities (StableBlockIds); do the same here.
      const unique = (current: EditorState) => {
        const seen = new Set<string>(); const tr = current.tr;
        current.doc.descendants((node, pos) => {
          if (!('blockId' in node.attrs)) return;
          const value = node.attrs.blockId as string | null;
          if (!value || seen.has(value)) { const replacement = `fresh-${seed}-${fresh++}`; tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: replacement }); seen.add(replacement); }
          else seen.add(value);
        });
        return tr.docChanged ? current.apply(tr) : current;
      };
      for (let step = 0; step < 30; step++) {
        const size = state.doc.content.size;
        const textPositions: number[] = [];
        state.doc.descendants((node: PMNode, pos) => { if (node.isTextblock && node.type.name !== 'codeBlock') textPositions.push(pos + 1 + Math.floor(next() * (node.content.size + 1))); });
        const tr = state.tr; const action = Math.floor(next() * 5);
        try {
          if (action === 0 && textPositions.length) tr.insertText('改', textPositions[Math.floor(next() * textPositions.length)]);
          else if (action === 1 && textPositions.length) { const at = textPositions[Math.floor(next() * textPositions.length)]; tr.setSelection(TextSelection.create(tr.doc, at)); tr.split(at); }
          else if (action === 2) tr.insert(size, schema.nodes.paragraph.create({ blockId: `fresh-${seed}-${fresh++}` }, schema.text('新段落')));
          else if (action === 3 && state.doc.childCount > 1) { const first = state.doc.child(0); tr.delete(0, first.nodeSize); }
          else if (action === 4 && textPositions.length) { const at = textPositions[Math.floor(next() * textPositions.length)]; tr.addMark(Math.max(1, at - 1), at, schema.marks.bold.create()); }
        } catch { continue; }
        if (!tr.docChanged) continue;
        state = unique(state.apply(tr));
        let expected: LocalRichDocument | null = null; let expectedError = '';
        try { expected = editorToRichDocument(state.doc.toJSON()); } catch (error) { expectedError = String(error); }
        if (!expected) { expect(() => richDocumentFromEditorDoc(state.doc)).toThrow(); expect(expectedError).toContain('UNSUPPORTED'); continue; }
        const actual = richDocumentFromEditorDoc(state.doc);
        expect(canonicalContent(actual)).toBe(canonicalContent(expected));
        expect(sameDocument(actual, expected)).toBe(true);
        expectSameAsWholeDocument(actual);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(300);
  });

  it('reuses unchanged blocks between editor states and reports unchanged documents as the same', () => {
    const schema = getSchema(documentEditorExtensions());
    const source: LocalRichDocument = { schemaVersion: 1, blocks: [{ id: 'one', kind: 'paragraph', text: [{ text: 'first' }] }, { id: 'two', kind: 'paragraph', text: [{ text: 'second' }] }] };
    const state = EditorState.create({ schema, doc: schema.nodeFromJSON(richDocumentToEditor(source)) });
    const before = richDocumentFromEditorDoc(state.doc);
    const after = richDocumentFromEditorDoc(state.apply(state.tr.insertText('!', 6)).doc);
    expect(after.blocks[1]).toBe(before.blocks[1]);
    expect(after.blocks[0]).not.toBe(before.blocks[0]);
    expect(sameDocument(after, before)).toBe(false);
    expect(sameDocument(richDocumentFromEditorDoc(state.doc), before)).toBe(true);
    expect(sameDocument(structuredClone(before), before)).toBe(true);
  });
});
