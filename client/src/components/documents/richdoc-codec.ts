import type { JSONContent } from '@tiptap/core';
import { inspectRichDocument, type RichBlock, type RichDocument, type RichMark, type RichText } from '../../../../server/src/domain/document-content.js';

export type UploadBlock = { id: string; kind: 'upload'; uploadId: string; label: string };
export type LocalRichBlock = Omit<RichBlock, 'children'> & { children?: LocalRichBlock[] } | UploadBlock;
export type LocalRichDocument = { schemaVersion: 1; blocks: LocalRichBlock[] };
const attributeNames = ['level', 'language', 'start', 'checked', 'align', 'colspan', 'rowspan', 'colwidth', 'alt', 'caption', 'width', 'label'] as const;

export function inspectLocalDocument(value: unknown) {
  const clean = (blocks: LocalRichBlock[]): RichBlock[] => blocks.map((block) => {
    if (block.kind === 'upload') return { id: block.id, kind: 'paragraph', text: [] };
    const { children, ...rest } = block;
    return { ...rest, ...(children ? { children: clean(children) } : {}) };
  });
  try { return inspectRichDocument({ ...(value as LocalRichDocument), blocks: clean((value as LocalRichDocument).blocks) }); }
  catch { return { supported: false, issues: ['Unsupported document schema'], references: [] }; }
}

export function richDocumentToEditor(value: LocalRichDocument): JSONContent {
  if (!inspectLocalDocument(value).supported) throw new Error('UNSUPPORTED_DOCUMENT_SCHEMA');
  const inline = (run: RichText): JSONContent => run.break ? { type: 'hardBreak' } : {
    type: 'text', text: run.text,
    ...(run.marks?.length ? { marks: run.marks.map((mark) => ({ type: mark.kind, ...(mark.href ? { attrs: { href: mark.href } } : {}) })) } : {}),
  };
  const block = (node: LocalRichBlock): JSONContent => {
    if (node.kind === 'upload') return { type: 'upload', attrs: { blockId: node.id, uploadId: node.uploadId, label: node.label } };
    const attrs: Record<string, unknown> = { blockId: node.id };
    for (const name of attributeNames) if (node[name] !== undefined) attrs[name] = node[name];
    if (node.target) { attrs.resourceId = node.target.resourceId; attrs.revision = node.target.revision; }
    return { type: node.kind, attrs, ...(node.text ? { content: node.text.filter((run) => run.text || run.break).map(inline) } : node.children ? { content: node.children.map(block) } : {}) };
  };
  return { type: 'doc', content: value.blocks.map(block) };
}

/** Convert one editor block (and its children) to the product shape. Identities repeated within `seen` get fresh ids. */
export function editorBlockToLocal(node: JSONContent, seen: Set<string> = new Set(), newId: () => string = () => crypto.randomUUID()): LocalRichBlock {
  const inline = (child: JSONContent): RichText => {
    if (child.type === 'hardBreak') return { text: '', break: true };
    if (child.type !== 'text') throw new Error(`UNSUPPORTED_INLINE_NODE: ${child.type}`);
    return { text: child.text ?? '', ...(child.marks?.length ? { marks: child.marks.map((mark): RichMark => ({ kind: mark.type as RichMark['kind'], ...(mark.type === 'link' ? { href: String(mark.attrs?.href ?? '') } : {}) })) } : {}) };
  };
  const block = (entry: JSONContent): LocalRichBlock => {
    let id = String(entry.attrs?.blockId ?? '');
    if (!id || seen.has(id)) id = newId();
    seen.add(id);
    if (entry.type === 'upload') return { id, kind: 'upload', uploadId: String(entry.attrs?.uploadId ?? ''), label: String(entry.attrs?.label ?? '') };
    const result: RichBlock = { id, kind: entry.type as RichBlock['kind'] };
    for (const name of attributeNames) if (entry.attrs?.[name] !== undefined && entry.attrs[name] !== null) Object.assign(result, { [name]: entry.attrs[name] });
    if (entry.type === 'image' || entry.type === 'file') result.target = { resourceId: String(entry.attrs?.resourceId ?? ''), revision: Number(entry.attrs?.revision) };
    if (['paragraph', 'heading', 'codeBlock'].includes(entry.type ?? '')) result.text = (entry.content ?? []).map(inline);
    else if (entry.content) return { ...result, children: entry.content.map(block) };
    return result;
  };
  return block(node);
}

export function editorToRichDocument(value: JSONContent, newId: () => string = () => crypto.randomUUID()): LocalRichDocument {
  const seen = new Set<string>();
  const result: LocalRichDocument = { schemaVersion: 1, blocks: (value.content ?? []).map((node) => editorBlockToLocal(node, seen, newId)) };
  if (!inspectLocalDocument(result).supported) throw new Error('UNSUPPORTED_DOCUMENT_SCHEMA');
  return result;
}

export function richDocumentOutline(value: RichDocument | LocalRichDocument): Array<{ id: string; level: number; text: string }> {
  const entries: Array<{ id: string; level: number; text: string }> = [];
  const visit = (blocks: LocalRichBlock[]) => { for (const block of blocks) if (block.kind !== 'upload') { if (block.kind === 'heading') entries.push({ id: block.id, level: block.level ?? 1, text: (block.text ?? []).map((run) => run.text).join('') }); if (block.children) visit(block.children); } };
  visit(value.blocks); return entries;
}
