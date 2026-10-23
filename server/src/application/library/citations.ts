import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Link, Parent, RootContent } from 'mdast';

/** Persisted document reference contract: retained to avoid rewriting user content. */
const prefix = 'wwa-material:';

export type MaterialHit = { materialId: string; start: number; end: number; label: string };

function childrenOf(node: RootContent | { children?: RootContent[] }): RootContent[] {
  return 'children' in node && Array.isArray(node.children) ? node.children : [];
}

function labelOf(node: Parent) {
  const parts: string[] = [];
  const visit = (current: RootContent) => {
    if (current.type === 'text') parts.push(current.value);
    else if (current.type !== 'link' && current.type !== 'linkReference') childrenOf(current).forEach(visit);
  };
  childrenOf(node).forEach(visit);
  return parts.join('');
}

function walk(node: RootContent | { children?: RootContent[] }, hits: MaterialHit[]) {
  for (const child of childrenOf(node)) {
    if (child.type === 'code' || child.type === 'inlineCode') continue;
    if (child.type === 'link' && child.url.startsWith(prefix)) {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      let materialId = child.url.slice(prefix.length);
      try { materialId = decodeURIComponent(materialId); } catch { /* Keep the raw id and let the lookup fail closed. */ }
      hits.push({ materialId, start, end, label: labelOf(child) });
    }
    walk(child, hits);
  }
}

export function materialReferences(markdown: string): MaterialHit[] {
  const hits: MaterialHit[] = [];
  walk(fromMarkdown(markdown) as { children?: RootContent[] }, hits);
  return hits;
}

export function escapeMaterialLabel(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

export function materialCitation(materialId: string, label: string) {
  return `[${escapeMaterialLabel(label)}](${prefix}${encodeURIComponent(materialId)})`;
}

export function stripMaterialReferences(markdown: string, materialId: string) {
  const hits = materialReferences(markdown).filter((hit) => hit.materialId === materialId).sort((left, right) => right.start - left.start);
  let next = markdown;
  for (const hit of hits) next = `${next.slice(0, hit.start)}${hit.label}${next.slice(hit.end)}`;
  return next;
}

export function insertMaterialCitations(markdown: string, from: number, to: number, citations: string[]) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > markdown.length) return null;
  return `${markdown.slice(0, from)}${citations.join('')}${markdown.slice(to)}`;
}

export type { Link };
