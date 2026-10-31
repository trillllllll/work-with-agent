import type { Node as PMNode } from '@tiptap/pm/model';
import { canonicalContent, documentNodeLimit, inspectRichDocument, type RichBlock } from '../../../../server/src/domain/document-content.js';
import { editorBlockToLocal, editorToRichDocument, type LocalRichBlock, type LocalRichDocument } from '../../components/documents/richdoc-codec.js';
import { measureRichDocument } from '../../components/documents/RichDocumentBoundary.js';

/**
 * Per-block caches for the whole-document work done while editing. ProseMirror keeps unchanged nodes
 * identical between transactions, and the session keeps unchanged product blocks identical, so each
 * cache is keyed by object identity and only changed blocks are recomputed. Every function returns
 * exactly what the corresponding whole-document function returns; the tests compare them directly.
 * Callers must treat product blocks as immutable.
 */
type BlockFacts = { supported: boolean; ids: string[]; nodes: number };
const converted = new WeakMap<PMNode, LocalRichBlock>();
const facts = new WeakMap<object, BlockFacts>();
const canonical = new WeakMap<object, string>();
const sizes = new WeakMap<object, { blocks: number; bytes: number }>();
const unbounded = { blocks: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY };
const wrapperBytes = measureRichDocument({ schemaVersion: 1, blocks: [] }, unbounded).bytes;

function plainDocument(value: unknown): value is LocalRichDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 && Array.isArray(record.blocks) && Object.keys(record).every((key) => key === 'schemaVersion' || key === 'blocks')
    && (record.blocks as unknown[]).every((block) => Boolean(block) && typeof block === 'object' && !Array.isArray(block));
}

/** Upload placeholders are validated as empty paragraphs, as in inspectLocalDocument. */
function clean(block: LocalRichBlock): RichBlock {
  if (block.kind === 'upload') return { id: block.id, kind: 'paragraph', text: [] };
  const { children, ...rest } = block;
  return { ...rest, ...(children ? { children: children.map(clean) } : {}) };
}

function blockFacts(block: LocalRichBlock): BlockFacts {
  const cached = facts.get(block);
  if (cached) return cached;
  let result: BlockFacts;
  try {
    const value = clean(block);
    const ids: string[] = []; let nodes = 0;
    const visit = (entry: RichBlock) => {
      nodes++; if (typeof entry.id === 'string') ids.push(entry.id);
      if (Array.isArray(entry.text)) nodes += entry.text.length;
      if (Array.isArray(entry.children)) entry.children.forEach(visit);
    };
    visit(value);
    result = { supported: inspectRichDocument({ schemaVersion: 1, blocks: [value] }).supported, ids, nodes };
  } catch { result = { supported: false, ids: [], nodes: 0 }; }
  facts.set(block, result);
  return result;
}

/** Same result as inspectLocalDocument(value).supported. */
export function richDocumentSupported(value: unknown) {
  if (!plainDocument(value)) {
    try { return inspectRichDocument(value).supported; } catch { return false; }
  }
  if (!value.blocks.length) return false;
  const seen = new Set<string>(); let nodes = 0;
  for (const block of value.blocks) {
    const entry = blockFacts(block);
    if (!entry.supported) return false;
    nodes += entry.nodes;
    if (nodes > documentNodeLimit) return false;
    for (const id of entry.ids) { if (seen.has(id)) return false; seen.add(id); }
  }
  return true;
}

/** Same string as canonicalContent(value). */
export function canonicalDocument(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!plainDocument(value)) return canonicalContent(value);
  return `{"blocks":[${value.blocks.map((block) => {
    let text = canonical.get(block);
    if (text === undefined) { text = canonicalContent(block); canonical.set(block, text); }
    return text;
  }).join(',')}],"schemaVersion":1}`;
}

/** Same result as measureRichDocument(value, budget).withinBudget, with exact totals. */
export function measureDocument(value: LocalRichDocument, budget: { blocks: number; bytes: number }) {
  if (!plainDocument(value)) return measureRichDocument(value, budget);
  let blocks = 0; let bytes = wrapperBytes + Math.max(0, value.blocks.length - 1);
  for (const block of value.blocks) {
    let size = sizes.get(block);
    if (!size) { const measured = measureRichDocument(block as unknown as LocalRichDocument, unbounded); size = { blocks: measured.blocks, bytes: measured.bytes }; sizes.set(block, size); }
    blocks += size.blocks; bytes += size.bytes;
  }
  return { blocks, bytes, withinBudget: blocks <= budget.blocks && bytes <= budget.bytes };
}

/**
 * The product document for an editor state. Unchanged top-level editor nodes reuse their converted block.
 * Throws UNSUPPORTED_DOCUMENT_SCHEMA exactly where editorToRichDocument(doc.toJSON()) would.
 */
export function richDocumentFromEditorDoc(doc: PMNode): LocalRichDocument {
  const blocks: LocalRichBlock[] = [];
  for (let index = 0; index < doc.childCount; index++) {
    const node = doc.child(index);
    let block = converted.get(node);
    if (!block) { block = editorBlockToLocal(node.toJSON()); converted.set(node, block); }
    blocks.push(block);
  }
  const result: LocalRichDocument = { schemaVersion: 1, blocks };
  if (richDocumentSupported(result)) return result;
  // Identities repeated across blocks, or anything else invalid: the full conversion decides, as before.
  return editorToRichDocument(doc.toJSON());
}

/** Whether two documents have the same body, comparing unchanged blocks by identity first. */
export function sameDocument(left: LocalRichDocument, right: LocalRichDocument | null) {
  if (!right || left.blocks.length !== right.blocks.length) return false;
  return left.blocks.every((block, index) => block === right.blocks[index] || canonicalDocument({ schemaVersion: 1, blocks: [block] }) === canonicalDocument({ schemaVersion: 1, blocks: [right.blocks[index]] }));
}
