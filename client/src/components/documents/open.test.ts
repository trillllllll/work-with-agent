import { describe, expect, it } from 'vitest';
import { addDocumentTab, type OpenDocuments } from './open.js';
import { insertResourceReference } from './ResourceReferencePicker.js';

describe('document view identity', () => {
  it('reopens a latest document in its existing tab while keeping exact evidence versions separate', () => {
    const initial: OpenDocuments = { tabs: [], active: null, secondary: null, create: null };
    const first = addDocumentTab(initial, { resourceId: 'document', title: 'Before rename' });
    const historical = addDocumentTab(first, { resourceId: 'document', revision: 2, chunkId: 'evidence' });
    const current = addDocumentTab(historical, { resourceId: 'document', title: 'After rename', nodeId: 'section' });
    expect(current.tabs).toHaveLength(2);
    expect(current.tabs[0]).toMatchObject({ title: 'After rename', nodeId: 'section' });
    expect(current.tabs[1]).toMatchObject({ revision: 2, chunkId: 'evidence' });
    expect(current.active).toBe(current.tabs[0].key);
  });

  it('inserts a fixed reference only at the captured block and refuses a removed bookmark', () => {
    const content = { schemaVersion: 1 as const, blocks: [{ id: 'p1', kind: 'paragraph' as const, text: [{ text: 'before' }] }, { id: 'p2', kind: 'paragraph' as const, text: [{ text: 'after' }] }] };
    const file = { id: 'reference', kind: 'file' as const, target: { resourceId: 'file', revision: 3 }, label: 'attachment' };
    const updated = insertResourceReference(content, file, 'p1');
    expect(typeof updated === 'object' && updated?.blocks.map((block) => block.id)).toEqual(['p1', 'reference', 'p2']);
    expect(insertResourceReference(content, file, 'removed')).toBeNull();
    expect(content.blocks.map((block) => block.id)).toEqual(['p1', 'p2']);
  });
});
