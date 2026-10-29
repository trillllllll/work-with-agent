import { canonicalContent } from '../../../../server/src/domain/document-content.js';

type Item = { id: string; label: string; signature: string };
export type DocumentChange = { id: string; kind: 'added' | 'removed' | 'changed'; before?: string; after?: string };
function documentItems(value: unknown): Item[] {
  if (typeof value === 'string') return value.split('\n').map((line, index) => ({ id: `line-${index + 1}`, label: line, signature: line }));
  if (!value || typeof value !== 'object' || !('blocks' in value) || !Array.isArray(value.blocks)) return [{ id: 'unknown', label: canonicalContent(value), signature: canonicalContent(value) }];
  const result: Item[] = []; const queue: unknown[] = [...value.blocks];
  for (let index = 0; index < queue.length && index < 50_000; index++) {
    const raw = queue[index]; if (!raw || typeof raw !== 'object') continue;
    const block = raw as { id?: unknown; kind?: unknown; text?: Array<{ text?: unknown }>; label?: unknown; alt?: unknown; target?: { resourceId?: unknown; revision?: unknown }; children?: unknown[] };
    const { children, ...own } = block;
    const text = Array.isArray(block.text) ? block.text.map((run) => typeof run.text === 'string' ? run.text : '').join('') : '';
    const target = block.target ? `${String(block.target.resourceId ?? '')} · v${String(block.target.revision ?? '')}` : '';
    result.push({ id: String(block.id ?? index), label: `${String(block.kind ?? '')}: ${text || String(block.label ?? block.alt ?? '')}${target ? ` (${target})` : ''}`.slice(0, 1000), signature: canonicalContent(own) });
    if (Array.isArray(children)) for (const child of children) if (queue.length < 50_000) queue.push(child);
  }
  return result;
}
/** Stable rich-block IDs compare content and resource versions; text uses an explicit line comparison. */
export function documentChanges(base: unknown, other: unknown): DocumentChange[] {
  const before = new Map(documentItems(base).map((item) => [item.id, item])); const after = documentItems(other);
  const changes: DocumentChange[] = [];
  for (const item of after) {
    const old = before.get(item.id);
    if (!old) changes.push({ id: item.id, kind: 'added', after: item.label });
    else if (old.signature !== item.signature) changes.push({ id: item.id, kind: 'changed', before: old.label, after: item.label });
    before.delete(item.id);
  }
  for (const old of before.values()) changes.push({ id: old.id, kind: 'removed', before: old.label });
  return changes;
}
