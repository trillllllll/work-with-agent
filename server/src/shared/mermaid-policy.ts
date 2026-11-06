export function validateMermaid(source: string) {
  if (!/^\s*(flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram)\b/.test(source)) throw new Error('仅支持流程、时序、状态和类图');
  if (/%%\{|^\s*---|\bclick\b|<\s*\/?\s*(script|iframe|img|a|foreignObject)\b|javascript:|https?:\/\//im.test(source)) throw new Error('图形包含不允许的配置、链接或交互');
  if (source.split(/[\n;]/).length > 400 || (source.match(/-->|---|=>|->|\bclass\b/g)?.length ?? 0) > 200) throw new Error('图形规模超过限制');
}
/** A diagram declaration alone renders a blank SVG; it is not a usable preview. */
export function mermaidHasContent(source: string) {
  return Boolean(source.replace(/^\s*%%[^\n]*$/gm, '').replace(/^\s*(?:(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram)\b/, '').replace(/[;\s]/g, ''));
}
