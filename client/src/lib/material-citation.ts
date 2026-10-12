import type { Content, Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const parse = unified().use(remarkParse).use(remarkGfm);
const prefix = 'wwa-material:';

function walk(node: Content | Root, visit: (node: Content) => void) {
  if (node.type !== 'root') visit(node as Content);
  if (node.type === 'code' || node.type === 'inlineCode') return;
  if ('children' in node && Array.isArray(node.children)) node.children.forEach((child) => walk(child, visit));
}

export function materialCitation(materialId: string, label: string) {
  const escaped = label.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
  return `[${escaped}](${prefix}${encodeURIComponent(materialId)})`;
}

export function materialIdFromHref(href: string) {
  if (!href.startsWith(prefix)) return '';
  const raw = href.slice(prefix.length);
  try { return decodeURIComponent(raw); } catch { return raw; }
}

export function descriptionCitesMaterial(markdown: string, materialId: string) {
  let found = false;
  walk(parse.parse(markdown) as Root, (node) => {
    if (found || node.type !== 'link') return;
    if (materialIdFromHref(node.url) === materialId) found = true;
  });
  return found;
}
