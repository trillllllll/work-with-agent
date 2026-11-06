/** Conservative closed-element scanner for explicit-tag HTML and SVG.
 * Quotes, comments and raw script/style bodies may cross chunks. No guessed closing tags.
 */
const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
export function closedElements(source: string): { parts: string[]; rest: string } {
  const parts: string[] = []; const stack: string[] = [];
  let cursor = 0, start = 0;
  while (cursor < source.length) {
    if (source[cursor] !== '<') { cursor++; continue; }
    if (source.startsWith('<!--', cursor)) {
      const end = source.indexOf('-->', cursor + 4); if (end < 0) break;
      cursor = end + 3; continue;
    }
    let end = cursor + 1, quote = '';
    for (; end < source.length; end++) {
      const c = source[end];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (end === source.length) break;
    const tag = source.slice(cursor, end + 1);
    const match = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)\b/.exec(tag);
    if (!match) throw new Error('仅支持显式闭合的 HTML / SVG 元素');
    const name = match[2].toLowerCase();
    if (match[1]) { if (stack.pop() !== name) throw new Error('标签未按顺序闭合'); }
    else if (!/\/\s*>$/.test(tag) && !voids.has(name)) {
      if (name === 'style' || name === 'script') {
        const close = new RegExp('</' + name + '\\s*>', 'ig'); close.lastIndex = end + 1;
        const found = close.exec(source); if (!found) break;
        end = found.index + found[0].length - 1;
      } else stack.push(name);
    }
    cursor = end + 1;
    if (!stack.length) { parts.push(source.slice(start, cursor)); start = cursor; }
  }
  return { parts, rest: source.slice(start) };
}
export function svgCandidate(source: string): string {
  const open = /^\s*<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(source);
  if (!open) return '';
  const body = source.slice(open[0].length).replace(/<\/svg>\s*$/i, '');
  const { parts } = closedElements(body);
  return parts.length ? open[0] + parts.join('') + '</svg>' : '';
}

/** The fragments contract deliberately excludes document loading semantics. */
export function htmlFragments(source: string, final = false): { parts: string[]; script?: string } {
  const { parts, rest } = closedElements(source);
  if (final && rest.replace(/<!--[\s\S]*?-->/g, '').trim()) throw new Error('HTML 仍有未闭合片段');
  const markup: string[] = [];
  let script: string | undefined;
  for (const part of parts) {
    const clean = part.replace(/^(?:\s*<!--[\s\S]*?-->)*\s*/, '').trim();
    if (!clean.startsWith('<')) throw new Error('分段 HTML 顶层文字需要放在元素中');
    if (script !== undefined) throw new Error('初始化脚本必须是最后一个片段');
    const init = /^<script\s*>([\s\S]*)<\/script\s*>$/i.exec(clean);
    if (init) { script = init[1]; continue; }
    // Do not inspect CSS strings as HTML. Scripts elsewhere and inline handlers are unsupported.
    if (/<style\b[^>]*>[\s\S]*?@import/i.test(clean)) throw new Error('分段 HTML 不支持外部样式导入');
    const tags = clean.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '<style></style>');
    if (/<\s*(?:!|\/?(?:html|head|body|base|meta|link|script|iframe|object|embed|template))\b/i.test(tags) || /\son[a-z]+\s*=/i.test(tags)) throw new Error('分段 HTML 不支持文档标签、外部依赖或内联事件；请使用完整页面模式');
    markup.push(part);
  }
  if (script !== undefined && rest.trim()) throw new Error('初始化脚本必须位于末尾');
  return { parts: markup, ...(final && script !== undefined ? { script } : {}) };
}
