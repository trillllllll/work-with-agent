/** Interactive html reply blocks: policy, static source checks and the prompt section. */
export const DEFAULT_HTML_CDN = ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com'];
export const HTML_SOURCE_LIMIT = 65536;
export const HTML_HEIGHT_MIN = 120;
export const HTML_HEIGHT_MAX = 1200;
export type HtmlBlockPolicy = { enabled: boolean; cdn: string[] };

const cdnEntry = /^(https:\/\/[a-z0-9.-]+(?::\d{1,5})?|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?)$/;
/** Returns the normalized origin, or null when the entry is not a plain https origin (or local http for testing). */
export function normalizeCdnEntry(raw: string) {
  const value = raw.trim().toLowerCase().replace(/\/+$/, '');
  return cdnEntry.test(value) ? value : null;
}

const pinned = /@v?\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?(?:\/|$)|\/v?\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?\//i;
function attributes(tag: string) {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(/([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) found.set(match[1].toLowerCase(), match[3] ?? match[4] ?? match[5] ?? '');
  return found;
}
function checkUrl(url: string, cdn: string[], label: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`${label} 只能使用白名单 CDN 的完整地址`); }
  if (!cdn.includes(parsed.origin)) throw new Error(`${label} 来自未允许的地址：${parsed.origin}`);
  if (!pinned.test(parsed.pathname)) throw new Error(`${label} 必须写死版本号：${url.slice(0, 200)}`);
}

/**
 * Early, best-effort rejection. The real boundary is the client sandbox and CSP;
 * dynamic or obfuscated loads are left to the CSP.
 */
export function validateHtmlSource(source: string, policy: HtmlBlockPolicy) {
  if (!policy.enabled) throw new Error('html 块已在设置中关闭');
  if (!source.trim()) throw new Error('html 内容为空');
  if (source.length > HTML_SOURCE_LIMIT) throw new Error('html 内容超过大小限制');
  for (const [tag] of source.matchAll(/<\s*(meta|base|link|script)\b[^>]*>/gi)) {
    const name = /<\s*([a-z]+)/i.exec(tag)![1].toLowerCase();
    const attrs = attributes(tag);
    if (name === 'base') throw new Error('html 不能使用 <base>');
    if (name === 'meta' && (attrs.get('http-equiv') ?? '').toLowerCase() === 'refresh') throw new Error('html 不能使用自动跳转');
    if (name === 'link') {
      const rel = (attrs.get('rel') ?? '').toLowerCase();
      if (/\b(dns-prefetch|preconnect|prefetch|prerender|preload|modulepreload)\b/.test(rel)) throw new Error('html 不能预取外部地址');
      if (attrs.has('href')) checkUrl(attrs.get('href')!, policy.cdn, '样式');
    }
    if (name === 'script' && attrs.has('src')) checkUrl(attrs.get('src')!, policy.cdn, '脚本');
  }
}

export function htmlBlockPrompt(policy: HtmlBlockPolicy) {
  if (!policy.enabled) return '【交互页面】\nhtml 块已在设置中关闭。不要使用 html 块；需要图示时用 svg、mermaid 或 chart。';
  return `【交互页面】
只有需要用户在页面里操作时（选择题、快速决策、筛选、小计算器、概念模拟器、互动讲解、参数实验、知识自测），才在 present_reply 里用 html 块；静态图示仍用 svg、mermaid 或 chart。
html 块：{ type: "html", title, alt, source, height? }。source 是完整的单文件 HTML（最多 ${HTML_SOURCE_LIMIT} 字符），alt 用一句话说明页面内容和用法，height 是 ${HTML_HEIGHT_MIN}-${HTML_HEIGHT_MAX} 的初始高度。
页面运行在隔离沙箱里：不能联网（fetch、XHR、WebSocket 都会失败），不能跳转、弹窗、提交表单，读不到 WWA 的数据。页面需要的数据直接写在 source 里。
外部库只能从这些地址加载：${policy.cdn.join('、')}。地址必须写死精确版本号（例如 https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js），能加 integrity 就加。不能用 eval 或 new Function。
用户做出选择后，调用 window.wwa.fillInput(文字) 把结果填进对话输入框，例如 window.wwa.fillInput("我选择：先做 A")。文字要完整、可直接作为下一条消息，最多 2000 字。它只填入、不发送，用户确认后自己发送。不要声称已经替用户发送或执行了任何操作。
配色用 CSS 变量 var(--wwa-bg)、var(--wwa-fg)、var(--wwa-muted)、var(--wwa-border)、var(--wwa-accent)，它们会跟随浅色和深色模式。页面宽度自适应，高度会自动调整。`;
}
