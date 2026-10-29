import { expect, it } from 'vitest';
import { documentChanges } from './document-difference.js';
it('shows changed exact file versions even if visible text is identical', () => {
  const base = { blocks: [{ id: 'a', kind: 'file', label: 'proof.pdf', target: { resourceId: 'file1', revision: 1 } }] };
  const next = { blocks: [{ ...base.blocks[0], target: { resourceId: 'file1', revision: 2 } }] };
  expect(documentChanges(base, next)).toEqual([{ id: 'a', kind: 'changed', before: 'file: proof.pdf (file1 · v1)', after: 'file: proof.pdf (file1 · v2)' }]);
});
it('recognizes formatting and inserted/removed blocks without parsing markup', () => {
  const base = { blocks: [{ id: 'a', kind: 'paragraph', text: [{ text: 'same' }] }, { id: 'gone', kind: 'horizontalRule' }] };
  const next = { blocks: [{ id: 'a', kind: 'paragraph', text: [{ text: 'same', marks: [{ kind: 'bold' }] }] }, { id: 'new', kind: 'paragraph' }] };
  expect(documentChanges(base, next).map((change) => change.kind)).toEqual(['changed', 'added', 'removed']);
});
