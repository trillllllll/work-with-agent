import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
const elements = new Set('svg g defs marker path rect circle ellipse line polyline polygon text tspan title desc'.split(' '));
const attributes = new Set('xmlns viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray opacity fill-opacity stroke-opacity transform font-size font-family font-weight text-anchor dominant-baseline id marker-start marker-mid marker-end markerWidth markerHeight refX refY orient markerUnits preserveAspectRatio role'.split(' '));
/** Rebuild allowed SVG, rejecting active content and every external resource. */
export function sanitizeSvg(source: string) {
  if (Buffer.byteLength(source) > 65536 || /<!DOCTYPE|<!ENTITY|<\?/i.test(source)) throw new Error('SVG 声明或大小不符合要求');
  const document = new DOMParser({ onError: () => { throw new Error('SVG XML 格式无效'); } }).parseFromString(source, 'image/svg+xml');
  const root = document.documentElement;
  if (!root || root.tagName !== 'svg' || (root.namespaceURI && root.namespaceURI !== 'http://www.w3.org/2000/svg')) throw new Error('需要 SVG 根节点');
  let count = 0;
  const ids = new Set<string>(); const refs: string[] = [];
  function walk(node: Element, depth: number) {
    if (++count > 500 || depth > 24 || !elements.has(node.tagName)) throw new Error('SVG 包含不允许的图元或超出规模');
    for (const attr of Array.from(node.attributes)) {
      if (attr.name === 'xmlns') { if (attr.value !== 'http://www.w3.org/2000/svg') throw new Error('SVG 命名空间无效'); continue; }
      if (!attributes.has(attr.name) || /[<>]|javascript:|data:|https?:|\/\/|expression|@import/i.test(attr.value)) throw new Error(`SVG 包含不允许的属性：${attr.name.slice(0, 80)}`);
      if (attr.name === 'xmlns' && attr.value !== 'http://www.w3.org/2000/svg') throw new Error('SVG 命名空间无效');
      if (attr.name === 'id') { if (!/^[A-Za-z][\w-]{0,79}$/.test(attr.value) || ids.has(attr.value)) throw new Error('SVG id 无效'); ids.add(attr.value); }
      if (/url\s*\(/i.test(attr.value)) { const match = /^url\(#([A-Za-z][\w-]{0,79})\)$/.exec(attr.value); if (!match) throw new Error('SVG 只能引用内部标记'); refs.push(match[1]); }
      if (['width', 'height', 'font-size', 'markerWidth', 'markerHeight'].includes(attr.name) && (!/^\d+(?:\.\d+)?(?:px|%)?$/.test(attr.value) || parseFloat(attr.value) > 4096)) throw new Error('SVG 尺寸无效');
    }
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1) walk(child as unknown as Element, depth + 1);
      else if (child.nodeType !== 3) node.removeChild(child);
    }
  }
  walk(root as unknown as Element, 0);
  if (refs.some((id) => !ids.has(id))) throw new Error('SVG 引用了不存在的标记');
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(root);
}
