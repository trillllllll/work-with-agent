import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';

/**
 * Replace only the differing range so ProseMirror maps this view's independent selection.
 * `from`/`to` bound the replaced content in the incoming document.
 */
export function externalDocumentChange(state: EditorState, incoming: PMNode): { transaction: Transaction; from: number; to: number } | null {
  const start = state.doc.content.findDiffStart(incoming.content);
  if (start === null) return null;
  const end = state.doc.content.findDiffEnd(incoming.content)!;
  let endBefore = end.a, endAfter = end.b;
  // Repeated text can make the common prefix and suffix overlap.
  const overlap = start - Math.min(endBefore, endAfter);
  if (overlap > 0) { endBefore += overlap; endAfter += overlap; }
  const transaction = state.tr.replace(start, endBefore, incoming.slice(start, endAfter))
    .setMeta('preventUpdate', true).setMeta('addToHistory', false);
  return { transaction, from: start, to: endAfter };
}

export function externalDocumentTransaction(state: EditorState, incoming: PMNode) {
  return externalDocumentChange(state, incoming)?.transaction ?? null;
}
