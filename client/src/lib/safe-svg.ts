import DOMPurify from 'dompurify';

const tags = 'svg g defs marker path rect circle ellipse line polyline polygon text tspan title desc'.split(' ');
const attributes = 'xmlns viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray opacity fill-opacity stroke-opacity transform font-size font-family font-weight text-anchor dominant-baseline id marker-start marker-mid marker-end markerWidth markerHeight refX refY orient markerUnits preserveAspectRatio role'.split(' ');

/** Validate before filtering: no active content, CSS, external resources or oversized trees. */
export function safeSvg(source: string): string {
  if (new TextEncoder().encode(source).length > 65536 || /<!DOCTYPE|<!ENTITY|<\?/i.test(source)) throw new Error('Invalid SVG');
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = document.documentElement;
  if (document.querySelector('parsererror') || root.localName !== 'svg' || (root.namespaceURI && root.namespaceURI !== 'http://www.w3.org/2000/svg')) throw new Error('Invalid SVG');
  const ids = new Set<string>();
  const refs: string[] = [];
  let count = 0;
  function walk(node: Element, depth: number) {
    if (++count > 500 || depth > 24 || !tags.includes(node.tagName)) throw new Error('Unsupported SVG element');
    for (const attr of Array.from(node.attributes)) {
      if (attr.name === 'xmlns' && attr.value === 'http://www.w3.org/2000/svg') continue;
      if (!attributes.includes(attr.name) || /[<>\\\x00-\x1f\x7f]|javascript:|data:|https?:|\/\/|expression|@import/i.test(attr.value)) throw new Error('Unsupported SVG attribute: ' + attr.name);
      if (attr.name === 'id') {
        if (!/^[A-Za-z][\w-]{0,79}$/.test(attr.value) || ids.has(attr.value)) throw new Error('Invalid SVG id');
        ids.add(attr.value);
      }
      if (/url\s*\(/i.test(attr.value)) {
        const match = /^url\(#([A-Za-z][\w-]{0,79})\)$/.exec(attr.value);
        if (!match) throw new Error('External SVG reference');
        refs.push(match[1]);
      }
      if (['width', 'height', 'font-size', 'markerWidth', 'markerHeight'].includes(attr.name) && (!/^\d+(?:\.\d+)?(?:px|%)?$/.test(attr.value) || parseFloat(attr.value) > 4096)) throw new Error('Invalid SVG size');
    }
    for (const child of Array.from(node.children)) walk(child, depth + 1);
  }
  walk(root, 0);
  if (refs.some((id) => !ids.has(id))) throw new Error('Missing SVG reference');
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return DOMPurify.sanitize(new XMLSerializer().serializeToString(root), { ALLOWED_TAGS: [...tags], ALLOWED_ATTR: [...attributes], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
}
