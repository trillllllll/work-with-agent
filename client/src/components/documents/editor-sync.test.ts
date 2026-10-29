import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { externalDocumentTransaction } from './editor-sync.js';

const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*', attrs: { blockId: { default: null } } }, file: { group: 'block', atom: true, attrs: { blockId: { default: null } } }, text: { group: 'inline' } } });
const paragraph = (id: string, text: string) => schema.node('paragraph', { blockId: id }, text ? schema.text(text) : undefined);
const document = (...blocks: ReturnType<typeof paragraph>[]) => schema.node('doc', null, blocks);

describe('external document update selection mapping', () => {
  it('keeps the other view cursor in its logical paragraph after a preceding block is inserted or removed', () => {
    const first = paragraph('first', 'alpha'), second = paragraph('second', 'bravo');
    const before = document(first, second); const position = first.nodeSize + 3;
    const state = EditorState.create({ schema, doc: before, selection: TextSelection.create(before, position) });
    const inserted = paragraph('inserted', 'new block'); const next = document(inserted, first, second);
    const transaction = externalDocumentTransaction(state, next)!;
    expect(transaction.doc.eq(next)).toBe(true);
    expect(transaction.selection.from).toBe(position + inserted.nodeSize);
    expect(transaction.selection.$from.parent.attrs.blockId).toBe('second');
    const after = state.apply(transaction); const removal = externalDocumentTransaction(after, before)!;
    expect(removal.selection.from).toBe(position);
    expect(removal.selection.$from.parent.attrs.blockId).toBe('second');
    expect(transaction.getMeta('preventUpdate')).toBe(true); expect(transaction.getMeta('addToHistory')).toBe(false);
  });

  it('maps both ends of an independent range and a selected resource node', () => {
    const first = paragraph('first', 'alpha'), second = paragraph('second', 'bravo'), file = schema.node('file', { blockId: 'attachment' });
    const before = document(first, second, file); const prefix = paragraph('prefix', 'insert'); const after = document(prefix, first, second, file);
    const state = EditorState.create({ schema, doc: before, selection: TextSelection.create(before, 2, first.nodeSize + 4) });
    const selection = externalDocumentTransaction(state, after)!.selection;
    expect([selection.anchor, selection.head]).toEqual([2 + prefix.nodeSize, first.nodeSize + 4 + prefix.nodeSize]);
    const nodeState = EditorState.create({ schema, doc: before, selection: NodeSelection.create(before, first.nodeSize + second.nodeSize) });
    const mappedNode = externalDocumentTransaction(nodeState, after)!.selection;
    expect(mappedNode).toBeInstanceOf(NodeSelection); expect((mappedNode as NodeSelection).node.attrs.blockId).toBe('attachment');
  });

  it('handles repeated-text overlap and does not emit a transaction for identical documents', () => {
    const before = document(paragraph('p', 'abc')), after = document(paragraph('p', 'ababc'));
    const state = EditorState.create({ schema, doc: before, selection: TextSelection.create(before, 4) });
    const transaction = externalDocumentTransaction(state, after)!;
    expect(transaction.doc.eq(after)).toBe(true); expect(transaction.selection.from).toBe(6);
    expect(externalDocumentTransaction(state, before)).toBeNull();
  });
});
