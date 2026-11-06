import type { Root } from 'mdast';
import type { VFile } from 'vfile';
/** Mark unfinished fences as plain code; completed fences can render during later text. */
export function holdIncompleteFences() {
  return (tree: Root, file: VFile) => {
    const content = String(file);
    const visit = (node: Root | Root['children'][number]) => {
      if (node.type === 'code') {
        const raw = content.slice(node.position?.start.offset, node.position?.end.offset);
        const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
        if (opener) {
          const lines = raw.split('\n');
          const close = new RegExp('^\\s{0,3}' + opener[1][0] + '{' + opener[1].length + ',}\\s*$');
          if (lines.length < 2 || !close.test(lines[lines.length - 1])) node.lang = 'text';
        }
      }
      if ('children' in node) for (const child of node.children) visit(child as Root['children'][number]);
    };
    visit(tree);
  };
}
