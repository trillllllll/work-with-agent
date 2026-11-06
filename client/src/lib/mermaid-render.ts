import DOMPurify from 'dompurify';
import { validateMermaid } from '../../../server/src/shared/mermaid-policy.js';
// Both Markdown and structured blocks use this lane: Mermaid configuration is global.
let lane: Promise<unknown> = Promise.resolve();
export function renderMermaid(source: string, dark: boolean, structured = false, id = `diagram-${crypto.randomUUID()}`): Promise<string> {
  const job = lane.then(async () => {
    if (structured) validateMermaid(source);
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default',
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges'],
      htmlLabels: false, flowchart: { htmlLabels: false }, suppressErrorRendering: true, logLevel: 'fatal',
      ...(structured ? { maxTextSize: 16384, maxEdges: 200 } : { fontFamily: 'inherit' }),
    });
    if (await mermaid.parse(source, { suppressErrors: true }) === false) throw new Error('Incomplete Mermaid syntax');
    const result = await mermaid.render(id, source);
    if (!result.svg.includes('<svg') || /<script/i.test(result.svg)) throw new Error('Invalid Mermaid result');
    const svg = structured ? DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'script', 'a', 'image', 'animate', 'set'], FORBID_ATTR: ['href', 'xlink:href', 'onload', 'onclick'] }) : result.svg;
    if (structured) {
      const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
      document.querySelectorAll('defs,style,title,desc,metadata,marker,symbol').forEach(node => node.remove());
      if (!document.querySelector('path,rect,circle,ellipse,line,polygon,polyline,text')) throw new Error('Empty Mermaid diagram');
    }
    return svg;
  });
  lane = job.catch(() => {}); return job;
}
