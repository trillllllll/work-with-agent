import type { Element, ElementContent, Root, Text } from 'hast';

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
const graphemes = segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function words(text: string): string[] {
  if (!segmenter || !graphemes) return [text];
  return Array.from(segmenter.segment(text)).flatMap(({ segment }) =>
    cjk.test(segment) ? Array.from(graphemes.segment(segment), (glyph) => glyph.segment) : [segment]);
}

/** Decorate only received, newly appended prose. Markdown, selection and line wrapping use the full chunk immediately. */
export function revealMarkdownArrival({ from }: { from: number }) {
  return (tree: Root) => {
    let order = 0;
    function split(node: Text): ElementContent[] {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined || end <= from) return [node];
      // Escapes and character references can change the length of the rendered text.
      if (start < from && end - start !== node.value.length) return [node];
      const cut = Math.max(0, from - start);
      const parts: ElementContent[] = cut ? [{ type: 'text', value: node.value.slice(0, cut) }] : [];
      let offset = start + cut;
      for (const word of words(node.value.slice(cut))) {
        const text: Text = { type: 'text', value: word };
        if (!word.trim()) parts.push(text);
        else parts.push({
          type: 'element', tagName: 'span',
          properties: { className: ['markdown-arrival'], dataArrivalOffset: offset, style: 'animation-delay:' + Math.min(order++ * 12, 84) + 'ms' },
          children: [text],
        });
        offset += word.length;
      }
      return parts;
    }
    function visit(node: Element) {
      if (['code', 'pre', 'svg', 'math'].includes(node.tagName)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text') return split(child);
        if (child.type === 'element') visit(child);
        return [child];
      });
    }
    for (const child of tree.children) if (child.type === 'element') visit(child);
  };
}
