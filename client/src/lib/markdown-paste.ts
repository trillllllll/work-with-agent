import type { JSONContent } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { parseDescription } from './description-codec.js';

/** Converting a very large paste would block input; such text is pasted as plain text instead. */
export const MARKDOWN_PASTE_LIMIT = 200_000;
const structural = new Set(['heading', 'codeBlock', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'table', 'rawMarkdown']);

function hasStructure(doc: JSONContent) {
  let found = false;
  const visit = (node: JSONContent) => {
    if (found) return;
    if (typeof node.type === 'string' && structural.has(node.type)) found = true;
    for (const mark of node.marks ?? []) if (mark.type === 'link' || mark.type === 'code') found = true;
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return found;
}

/** Whether pasted plain text carries complete, recognisable Markdown structure. */
export function looksLikeMarkdown(text: string) {
  return text.length <= MARKDOWN_PASTE_LIMIT && hasStructure(parseDescription(text, 'clipboard').doc);
}

/** Insert plain text as one paragraph; line breaks become hard breaks and no Markdown is recognised. */
export function insertPlainText(view: EditorView, text: string) {
  const schema = view.state.schema;
  const nodes: PMNode[] = [];
  text.split('\n').forEach((line, index) => {
    if (index > 0) nodes.push(schema.nodes.hardBreak.create());
    if (line) nodes.push(schema.text(line));
  });
  const paragraph = schema.nodes.paragraph.create(null, nodes.length ? nodes : undefined);
  view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray([paragraph]), 0, 0)).scrollIntoView());
}

export type MarkdownPasteOptions = {
  /** Links that fail this check keep their text without the link. */
  isAllowedLink?: (href: string) => boolean;
};

type Adapter = { schema: Schema; allowLink: (href: string) => boolean };
const textLines = (text: string): JSONContent[] => text.split('\n').flatMap((line, index) => [
  ...(index > 0 ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : []),
]);

function marks(adapter: Adapter, value: JSONContent['marks']) {
  const kept = (value ?? []).filter((mark) => adapter.schema.marks[mark.type]
    && (mark.type !== 'link' || adapter.allowLink(String(mark.attrs?.href ?? ''))));
  return kept.length ? kept : undefined;
}

function linkText(adapter: Adapter, text: string, href: string): JSONContent[] {
  if (!text) return [];
  const link = adapter.schema.marks.link && adapter.allowLink(href) ? [{ type: 'link', attrs: { href } }] : undefined;
  return [{ type: 'text', text, ...(link ? { marks: link } : {}) }];
}

function inline(adapter: Adapter, nodes: JSONContent[] | undefined): JSONContent[] {
  return (nodes ?? []).flatMap((node): JSONContent[] => {
    if (node.type === 'text') {
      if (!node.text) return [];
      const kept = marks(adapter, node.marks);
      return [{ type: 'text', text: node.text, ...(kept ? { marks: kept } : {}) }];
    }
    if (node.type === 'hardBreak') return adapter.schema.nodes.hardBreak ? [{ type: 'hardBreak' }] : [{ type: 'text', text: ' ' }];
    if (node.type === 'image') {
      const src = String(node.attrs?.src ?? ''); const alt = String(node.attrs?.alt ?? '');
      if (adapter.schema.nodes.image?.isInline) return [node];
      // A document image is a stored file, never a remote URL; keep the address as a readable link.
      return linkText(adapter, alt || src, src);
    }
    if (node.type === 'materialReference') {
      if (adapter.schema.nodes.materialReference) return [node];
      const id = String(node.attrs?.materialId ?? ''); const label = String(node.attrs?.label ?? '') || id;
      return linkText(adapter, label, `wwa-material:${id}`);
    }
    return node.text ? [{ type: 'text', text: node.text }] : [];
  });
}

function block(adapter: Adapter, node: JSONContent): JSONContent[] {
  const { schema } = adapter;
  switch (node.type) {
    case 'rawMarkdown': {
      if (schema.nodes.rawMarkdown) return [node];
      // Unsupported Markdown keeps its exact characters as text.
      return [{ type: 'paragraph', content: textLines(String(node.attrs?.markdown ?? '')) }];
    }
    case 'paragraph': case 'heading':
      return [{ ...node, content: inline(adapter, node.content) }];
    case 'codeBlock':
      return [{ type: 'codeBlock', ...(node.attrs?.language ? { attrs: { language: node.attrs.language } } : {}), content: (node.content ?? []).filter((child) => child.text).map((child) => ({ type: 'text', text: child.text })) }];
    case 'table': {
      const has = (type: string, attr: string) => Boolean(schema.nodes[type]?.spec.attrs && attr in schema.nodes[type].spec.attrs!);
      if (has('table', 'alignments')) return [{ ...node, content: (node.content ?? []).map((row) => ({ ...row, content: (row.content ?? []).map((cell) => ({ ...cell, content: blocks(adapter, cell.content) })) })) }];
      // Without table-level alignments, GFM column alignment moves onto each cell.
      const alignments = Array.isArray(node.attrs?.alignments) ? node.attrs!.alignments as Array<string | null> : [];
      return [{ type: 'table', content: (node.content ?? []).map((row) => ({ type: 'tableRow', content: (row.content ?? []).map((cell, index) => {
        const align = alignments[index] && has(String(cell.type), 'align') ? alignments[index] : null;
        return { type: cell.type, ...(align ? { attrs: { align } } : {}), content: blocks(adapter, cell.content) };
      }) })) }];
    }
    default:
      return [{ ...node, ...(node.content ? { content: blocks(adapter, node.content) } : {}) }];
  }
}
function blocks(adapter: Adapter, nodes: JSONContent[] | undefined) { return (nodes ?? []).flatMap((node) => block(adapter, node)); }

/**
 * Convert pasted Markdown into a slice of the target editor schema, or null when the text has no
 * Markdown structure or cannot be represented; callers then paste it as plain text, so no text is lost.
 * Nodes the schema lacks are rewritten: raw fragments become text, images and material citations become links.
 */
export function markdownPasteSlice(text: string, schema: Schema, options: MarkdownPasteOptions = {}): Slice | null {
  if (!text || text.length > MARKDOWN_PASTE_LIMIT) return null;
  const parsed = parseDescription(text, 'clipboard').doc;
  if (!hasStructure(parsed)) return null;
  try {
    const adapter: Adapter = { schema, allowLink: options.isAllowedLink ?? (() => true) };
    const doc = schema.nodeFromJSON({ type: 'doc', content: blocks(adapter, parsed.content) });
    doc.check();
    if (!doc.childCount) return null;
    // Leading and trailing paragraphs join the text around the cursor, like any rich paste.
    const open = (node: PMNode | null) => node?.type === schema.nodes.paragraph ? 1 : 0;
    return new Slice(doc.content, open(doc.firstChild), open(doc.lastChild));
  } catch { return null; }
}
