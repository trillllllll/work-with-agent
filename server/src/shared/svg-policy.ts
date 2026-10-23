/** Static SVG policy shared by Node and the browser. No platform parser or I/O here. */
export const svgLimits = { bytes: 65536, nodes: 500, depth: 24, dimension: 4096, resources: 32, referenceDepth: 8, geometryTokens: 8192, transforms: 128, expandedGeometry: 50000 } as const;
const namespace = 'http://www.w3.org/2000/svg';
const xlinkNamespace = 'http://www.w3.org/1999/xlink';
type XmlNode = { nodeType: number; nodeName: string; nodeValue?: string | null; namespaceURI?: string | null; localName?: string | null; attributes?: ArrayLike<{ name: string; value: string }>; childNodes?: ArrayLike<XmlNode> };
type SvgNode = { tag: string; attrs: Record<string, string>; children: (SvgNode | string)[] };
type Reference = { owner: SvgNode; attribute: string; id: string; targets: readonly string[] };
const words = (value: string) => value.split(' ');
const elements: Record<string, string[]> = {
  svg: words('x y width height viewBox preserveAspectRatio version'), g: [], defs: [],
  path: words('d pathLength'), rect: words('x y width height rx ry pathLength'),
  circle: words('cx cy r pathLength'), ellipse: words('cx cy rx ry pathLength'),
  line: words('x1 y1 x2 y2 pathLength'), polyline: words('points pathLength'), polygon: words('points pathLength'),
  text: words('x y dx dy rotate textLength lengthAdjust'), tspan: words('x y dx dy rotate textLength lengthAdjust'), title: [], desc: [], metadata: [],
  marker: words('id markerWidth markerHeight refX refY orient markerUnits viewBox preserveAspectRatio'),
  linearGradient: words('x1 y1 x2 y2 gradientUnits gradientTransform spreadMethod href'),
  radialGradient: words('cx cy r fx fy fr gradientUnits gradientTransform spreadMethod href'),
  stop: words('offset stop-color stop-opacity'), clipPath: words('clipPathUnits transform'),
};
const textAttributes = new Set(words('aria-label aria-description aria-roledescription aria-valuetext lang xml:lang class'));
const ariaAttributes = new Set(words('aria-activedescendant aria-atomic aria-autocomplete aria-busy aria-checked aria-colcount aria-colindex aria-colspan aria-controls aria-current aria-describedby aria-details aria-disabled aria-errormessage aria-expanded aria-flowto aria-haspopup aria-hidden aria-invalid aria-keyshortcuts aria-labelledby aria-level aria-live aria-modal aria-multiline aria-multiselectable aria-orientation aria-owns aria-placeholder aria-posinset aria-pressed aria-readonly aria-relevant aria-required aria-rowcount aria-rowindex aria-rowspan aria-selected aria-setsize aria-sort aria-valuemax aria-valuemin aria-valuenow'));
const enums: Record<string, string[]> = {
  'fill-rule': words('nonzero evenodd'), 'clip-rule': words('nonzero evenodd'),
  'stroke-linecap': words('butt round square'), 'stroke-linejoin': words('miter miter-clip round bevel arcs'),
  'font-style': words('normal italic oblique'), 'font-variant': words('normal small-caps'),
  'font-stretch': words('normal ultra-condensed extra-condensed condensed semi-condensed semi-expanded expanded extra-expanded ultra-expanded'),
  'text-anchor': words('start middle end'), 'lengthAdjust': words('spacing spacingAndGlyphs'),
  'dominant-baseline': words('auto text-bottom alphabetic ideographic middle central mathematical hanging text-top text-after-edge text-before-edge'),
  'alignment-baseline': words('auto baseline before-edge text-before-edge middle central after-edge text-after-edge ideographic alphabetic hanging mathematical top center bottom'),
  'writing-mode': words('horizontal-tb vertical-rl vertical-lr lr lr-tb rl rl-tb tb tb-rl'), direction: words('ltr rtl'),
  'unicode-bidi': words('normal embed isolate bidi-override isolate-override plaintext'),
  'white-space': words('normal pre nowrap pre-wrap pre-line break-spaces'),
  'text-rendering': words('auto optimizeSpeed optimizeLegibility geometricPrecision'),
  'shape-rendering': words('auto optimizeSpeed crispEdges geometricPrecision'),
  'vector-effect': words('none non-scaling-stroke'), visibility: words('visible hidden collapse'),
  display: words('none inline block inline-block contents'), overflow: words('visible hidden scroll auto'),
  'color-interpolation': words('auto sRGB linearRGB'), 'markerUnits': words('strokeWidth userSpaceOnUse'),
  gradientUnits: words('objectBoundingBox userSpaceOnUse'), spreadMethod: words('pad reflect repeat'), clipPathUnits: words('userSpaceOnUse objectBoundingBox'),
  'xml:space': words('default preserve'),
};
const lengths = new Set(words('width height x y x1 y1 x2 y2 cx cy r rx ry fx fy fr dx dy refX refY markerWidth markerHeight font-size stroke-width stroke-dashoffset letter-spacing word-spacing baseline-shift textLength'));
const nonnegative = new Set(words('width height r rx ry fr markerWidth markerHeight font-size stroke-width textLength'));
const numbers = new Set(words('opacity fill-opacity stroke-opacity stop-opacity stroke-miterlimit pathLength'));
const presentation = words('fill stroke color stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-miterlimit opacity fill-opacity stroke-opacity fill-rule clip-rule transform transform-origin font-size font-family font-weight font-style font-variant font-stretch text-anchor dominant-baseline alignment-baseline baseline-shift letter-spacing word-spacing text-decoration writing-mode direction unicode-bidi white-space text-rendering shape-rendering vector-effect paint-order visibility display overflow color-interpolation marker-start marker-mid marker-end clip-path stop-color stop-opacity');
const resourceTags = new Set(words('marker linearGradient radialGradient clipPath'));
const paintTargets = words('linearGradient radialGradient');
const numeric = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const numberPattern = new RegExp(`^${numeric}$`);
const lengthPattern = new RegExp(`^(${numeric})(px|em|rem|ex|ch|pt|pc|cm|mm|in|%)?$`, 'i');
const idPattern = /^[\p{L}_][\p{L}\p{N}_.:-]{0,127}$/u;
const colors = new Set(words('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgrey darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray grey green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgrey lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent currentcolor'));
export const svgAllowedTags = Object.keys(elements);
export const svgAllowedAttributes = [...new Set(['xmlns', 'id', 'role', 'xml:space', ...textAttributes, ...ariaAttributes, ...presentation, ...Object.values(elements).flat()])];
function invalid(attribute?: string): never { throw Object.assign(new Error(attribute ? `SVG 包含不允许的属性：${attribute}` : 'SVG 内容或规模不符合静态图示规则'), { svgCode: attribute ? 'attribute' : 'format', attribute }); }

export function prepareSvgSource(source: string): string {
  if (source.length > svgLimits.bytes || new TextEncoder().encode(source).length > svgLimits.bytes) invalid();
  const withoutInertText = source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(withoutInertText)) invalid();
  const declaration = /^\uFEFF?<\?xml\s+version=(['"])1\.[01]\1(?:\s+encoding=(['"])[A-Za-z][\w.-]*\2)?(?:\s+standalone=(['"])(?:yes|no)\3)?\s*\?>/;
  const cleaned = source.replace(declaration, '');
  if (/<\?/.test(cleaned.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, ''))) invalid();
  return cleaned;
}
function parseNumber(value: string, attr: string): number {
  if (!numberPattern.test(value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1e6) invalid(attr);
  return Number(value);
}
function validateLength(value: string, attr: string) {
  if (value === 'inherit' || value === 'initial' || value === 'unset') return;
  if (value === 'auto' && ['width', 'height'].includes(attr)) return;
  if (attr === 'font-size' && /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/.test(value)) return;
  if (attr === 'baseline-shift' && /^(?:baseline|sub|super)$/.test(value)) return;
  if (['letter-spacing', 'word-spacing'].includes(attr) && value === 'normal') return;
  const match = lengthPattern.exec(value);
  if (!match) invalid(attr);
  const n = parseNumber(match[1], attr);
  if (nonnegative.has(attr) && n < 0) invalid(attr);
  const unit = (match[2] || '').toLowerCase();
  const factor: Record<string, number> = { px: 1, '': 1, em: 16, rem: 16, ex: 8, ch: 8, pt: 96 / 72, pc: 16, cm: 96 / 2.54, mm: 96 / 25.4, in: 96, '%': 1 };
  if (Math.abs(n) * factor[unit] > svgLimits.dimension) invalid(attr);
}
function validateColor(value: string, attr: string) {
  if (colors.has(value.toLowerCase()) || /^(?:inherit|initial|unset)$/.test(value)) return;
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return;
  if (/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([\d.eE+\-%,\s/degturnrad]+\)$/i.test(value)) return;
  invalid(attr);
}
/** Split declarations without breaking quoted font names or functional values. */
function styleDeclarations(value: string, tag: string): [string, string][] {
  const entries: string[] = []; let part = ''; let quote = ''; let depth = 0;
  for (const char of value) {
    if (quote) { if (char === quote) quote = ''; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') { if (--depth < 0) invalid('style'); }
    if (char === ';' && !quote && depth === 0) { entries.push(part); part = ''; } else part += char;
  }
  if (quote || depth) invalid('style');
  entries.push(part);
  return entries.filter((entry) => entry.trim()).map((entry) => {
    const colon = entry.indexOf(':');
    if (colon < 1) invalid('style');
    const attr = entry.slice(0, colon).trim().toLowerCase(); const content = entry.slice(colon + 1).trim();
    if (['transform', 'd'].includes(attr)) invalid('style');
    if (!(presentation.includes(attr) || (elements[tag].includes(attr) && ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'd'].includes(attr))) || !content || /[!@\\\u0000-\u001f\u007f]/.test(content)) invalid('style');
    // CSS lengths require units where SVG presentation attributes accept bare numbers.
    if (['font-size', 'width', 'height', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'letter-spacing', 'word-spacing', 'baseline-shift', 'transform-origin'].includes(attr)) {
      for (const token of content.split(/\s+/)) if (numberPattern.test(token) && Number(token) !== 0) invalid('style');
    }
    return [attr, content];
  });
}
function escapeXml(value: string, attribute = false) {
  const text = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return attribute ? text.replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;') : text.replace(/\r/g, '&#13;');
}
function serialize(node: SvgNode): string {
  const attrs = Object.entries(node.attrs).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, value]) => ` ${key}="${escapeXml(value, true)}"`).join('');
  return `<${node.tag}${attrs}>${node.children.map((child) => typeof child === 'string' ? escapeXml(child) : serialize(child)).join('')}</${node.tag}>`;
}

/** Read either XML DOM into the same tree, validate it and serialize deterministically. */
export function normalizeSvgDocument(document: XmlNode): string {
  let nodes = 0; let geometryTokens = 0; let transforms = 0;
  const ids = new Map<string, SvgNode>(); const references: Reference[] = []; const resources: SvgNode[] = [];
  function read(input: XmlNode, depth: number): SvgNode {
    const tag = input.localName || input.nodeName;
    if (++nodes > svgLimits.nodes || depth > svgLimits.depth || !Object.prototype.hasOwnProperty.call(elements, tag) || (input.namespaceURI && input.namespaceURI !== namespace)) invalid();
    const node: SvgNode = { tag, attrs: Object.create(null), children: [] };
    if (resourceTags.has(tag)) { resources.push(node); if (resources.length > svgLimits.resources) invalid(); }
    const original = Object.fromEntries(Array.from(input.attributes || []).map((attr) => [attr.name, attr.value]));
    for (const [name, value] of Object.entries(original)) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        if (value !== namespace && !(name === 'xmlns:xlink' && value === xlinkNamespace)) invalid(name);
        continue;
      }
      if (name === 'style') continue;
      const attr = name === 'xlink:href' ? 'href' : name;
      if (Object.prototype.hasOwnProperty.call(node.attrs, attr) && node.attrs[attr] !== value) invalid(attr);
      node.attrs[attr] = value;
    }
    // CSS declarations override presentation attributes; the last declaration wins.
    if (original.style) for (const [key, value] of styleDeclarations(original.style, tag)) node.attrs[key] = value;
    for (const [attr, raw] of Object.entries(node.attrs)) {
      const value = raw.trim();
      if (!elements[tag].includes(attr) && !presentation.includes(attr) && !textAttributes.has(attr) && !ariaAttributes.has(attr) && !['id', 'role', 'xml:space'].includes(attr) && !/^data-[a-zA-Z_][\w.-]*$/.test(attr)) invalid(attr);
      if (textAttributes.has(attr) || ariaAttributes.has(attr) || attr.startsWith('data-')) continue;
      if (attr === 'id') {
        if (!idPattern.test(raw) || ids.has(raw)) invalid(attr);
        ids.set(raw, node); continue;
      }
      if (/[\\<>\u0000-\u001f\u007f]/.test(value)) invalid(attr);
      if (attr === 'role') { if (!/^[a-z][a-z\d-]*(?:\s+[a-z][a-z\d-]*)*$/.test(value)) invalid(attr); continue; }
      node.attrs[attr] = value;
      if (attr === 'href') {
        if (!['linearGradient', 'radialGradient'].includes(tag) || !value.startsWith('#') || !idPattern.test(value.slice(1))) invalid(attr);
        references.push({ owner: node, attribute: attr, id: value.slice(1), targets: paintTargets }); continue;
      }
      if (['fill', 'stroke', 'marker-start', 'marker-mid', 'marker-end', 'clip-path'].includes(attr)) {
        if (['none', 'inherit', 'initial', 'unset'].includes(value)) continue;
        if (/^url\(/i.test(value)) {
          const match = /^url\(\s*(?:"#([^"\s]+)"|'#([^'\s]+)'|#([^\s'"()]+))\s*\)(?:\s+(.+))?$/i.exec(value);
          const id = match && (match[1] || match[2] || match[3]);
          if (!id || !idPattern.test(id)) invalid(attr);
          const paint = ['fill', 'stroke'].includes(attr);
          if (match![4]) { if (!paint) invalid(attr); if (match![4] !== 'none') validateColor(match![4], attr); }
          references.push({ owner: node, attribute: attr, id, targets: paint ? paintTargets : attr === 'clip-path' ? ['clipPath'] : ['marker'] });
          node.attrs[attr] = `url(#${id})${match![4] ? ` ${match![4]}` : ''}`; continue;
        }
        if (!['fill', 'stroke'].includes(attr)) invalid(attr);
        validateColor(value, attr); continue;
      }
      if (attr === 'color' || attr === 'stop-color') { validateColor(value, attr); continue; }
      if (enums[attr]) { if (!enums[attr].includes(value) && !['inherit', 'initial', 'unset'].includes(value)) invalid(attr); continue; }
      if (lengths.has(attr)) {
        if (['x', 'y', 'dx', 'dy'].includes(attr) && ['text', 'tspan'].includes(tag)) for (const item of value.split(/[\s,]+/)) validateLength(item, attr);
        else validateLength(value, attr);
        continue;
      }
      if (numbers.has(attr)) {
        if (['inherit', 'initial', 'unset'].includes(value) && presentation.includes(attr)) continue;
        const percent = attr.includes('opacity') && value.endsWith('%');
        const n = parseNumber(percent ? value.slice(0, -1) : value, attr) / (percent ? 100 : 1);
        if (n < 0 || (attr.includes('opacity') && n > 1) || (attr === 'stroke-miterlimit' && n < 1)) invalid(attr);
        continue;
      }
      if (attr === 'offset') { const n = parseNumber(value.replace(/%$/, ''), attr); if (n < 0 || n > (value.endsWith('%') ? 100 : 1)) invalid(attr); continue; }
      if (attr === 'font-weight') { if (!/^(?:normal|bold|bolder|lighter|inherit|initial|unset|[1-9]\d{0,2}|1000)$/.test(value)) invalid(attr); continue; }
      if (attr === 'font-family') { if (!/^(?:[\p{L}\p{N}_ -]+|"[^"\\<>]+"|'[^'\\<>]+')(?:\s*,\s*(?:[\p{L}\p{N}_ -]+|"[^"\\<>]+"|'[^'\\<>]+'))*$/u.test(value)) invalid(attr); continue; }
      if (attr === 'text-decoration') { if (!/^(?:none|inherit|initial|unset|(?:underline|overline|line-through)(?:\s+(?:underline|overline|line-through))*)$/.test(value)) invalid(attr); continue; }
      if (attr === 'paint-order') { if (!/^(?:normal|inherit|initial|unset|(?:fill|stroke|markers)(?:\s+(?:fill|stroke|markers)){0,2})$/.test(value)) invalid(attr); continue; }
      if (attr === 'stroke-dasharray') { if (!['none', 'inherit', 'initial', 'unset'].includes(value)) for (const item of value.split(/[\s,]+/)) { validateLength(item, 'stroke-width'); } continue; }
      if (attr === 'transform' || attr === 'gradientTransform') {
        if (value === 'none') continue;
        let rest = value; const pattern = /\b(matrix|translate|scale|rotate|skewX|skewY)\(([^()]*)\)/g; let match: RegExpExecArray | null;
        while ((match = pattern.exec(value))) {
          if (++transforms > svgLimits.transforms) invalid(attr);
          const args = match[2].trim().split(/[\s,]+/); args.forEach((arg) => parseNumber(arg, attr));
          const arities: Record<string, number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] };
          if (!arities[match[1]].includes(args.length)) invalid(attr);
          rest = rest.replace(match[0], '');
        }
        if (rest.replace(/[\s,]/g, '') || !value.trim()) invalid(attr); continue;
      }
      if (attr === 'transform-origin') { const parts = value.split(/\s+/); if (parts.length > 3) invalid(attr); for (const part of parts) if (!/^(?:left|center|right|top|bottom)$/.test(part)) validateLength(part, attr); continue; }
      if (attr === 'orient') { if (!['auto', 'auto-start-reverse'].includes(value)) parseNumber(value.replace(/(?:deg|rad|grad|turn)$/, ''), attr); continue; }
      if (attr === 'preserveAspectRatio') { if (!/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value)) invalid(attr); continue; }
      if (attr === 'version') { if (!['1.0', '1.1', '2.0'].includes(value)) invalid(attr); continue; }
      if (attr === 'viewBox' || attr === 'points' || attr === 'rotate' || attr === 'd') {
        if (attr === 'd' && !value) continue;
        const values = value.match(new RegExp(numeric, 'g')) || [];
        geometryTokens += values.length; if (geometryTokens > svgLimits.geometryTokens) invalid(attr);
        values.forEach((item) => parseNumber(item, attr));
        const rest = value.replace(new RegExp(numeric, 'g'), '').replace(/[\s,]/g, '');
        if (attr === 'd' ? !values.length || /[^MmZzLlHhVvCcSsQqTtAa]/.test(rest) : !!rest) invalid(attr);
        if (attr === 'viewBox' && (values.length !== 4 || Number(values[2]) <= 0 || Number(values[3]) <= 0 || Number(values[2]) > svgLimits.dimension || Number(values[3]) > svgLimits.dimension)) invalid(attr);
        if (attr === 'points' && (!values.length || values.length % 2)) invalid(attr);
        continue;
      }
      invalid(attr);
    }
    for (const child of Array.from(input.childNodes || [])) {
      if (child.nodeType === 1) {
        const childTag = child.localName || child.nodeName;
        if (['title', 'desc', 'metadata'].includes(tag)) invalid();
        if (['text', 'tspan'].includes(tag) && !['tspan', 'title', 'desc'].includes(childTag)) invalid();
        if (['linearGradient', 'radialGradient'].includes(tag) && !['stop', 'title', 'desc'].includes(childTag)) invalid();
        if (['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'stop'].includes(tag) && !['title', 'desc'].includes(childTag)) invalid();
        node.children.push(read(child, depth + 1));
      }
      else if (child.nodeType === 3 || child.nodeType === 4) node.children.push(child.nodeValue || '');
      else if (child.nodeType !== 8) invalid();
    }
    return node;
  }
  const top = Array.from(document.childNodes || []);
  const roots = top.filter((node) => node.nodeType === 1);
  if (roots.length !== 1 || (roots[0].localName || roots[0].nodeName) !== 'svg' || top.some((node) => ![1, 8].includes(node.nodeType) && !(node.nodeType === 3 && !node.nodeValue?.trim()))) invalid();
  const root = read(roots[0], 0);
  root.attrs.xmlns = namespace;
  const dependencies = new Map(resources.map((node) => [node, new Set<SvgNode>()]));
  function contains(parent: SvgNode, child: SvgNode): boolean { return parent === child || parent.children.some((item) => typeof item !== 'string' && contains(item, child)); }
  for (const ref of references) {
    const target = ids.get(ref.id);
    if (!target || !ref.targets.includes(target.tag)) throw Object.assign(new Error('SVG 引用了不存在或类型不符的标记'), { svgCode: 'reference' });
    for (const resource of resources) if (contains(resource, ref.owner)) dependencies.get(resource)!.add(target);
  }
  const heights = new Map<SvgNode, number>();
  // Track effective inherited paints/markers as well as explicitly written references.
  const resolved = new Map<SvgNode, Map<string, SvgNode>>();
  for (const ref of references) {
    if (!resolved.has(ref.owner)) resolved.set(ref.owner, new Map());
    resolved.get(ref.owner)!.set(ref.attribute, ids.get(ref.id)!);
  }
  const inheritedProperties = ['fill', 'stroke', 'marker-start', 'marker-mid', 'marker-end'];
  const drawingTags = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan']);
  const effectiveRefs = new Map<SvgNode, Map<string, SvgNode>>();
  function effective(node: SvgNode, inherited: Map<string, SvgNode>, owners: SvgNode[]) {
    const values = new Map(inherited);
    for (const prop of [...inheritedProperties, 'clip-path']) {
      const value = node.attrs[prop];
      if (value === 'inherit' || (value === 'unset' && inheritedProperties.includes(prop))) continue;
      if (value === undefined && inheritedProperties.includes(prop)) continue;
      const target = resolved.get(node)?.get(prop);
      if (target) values.set(prop, target); else values.delete(prop);
    }
    const activeOwners = resourceTags.has(node.tag) ? [...owners, node] : owners;
    effectiveRefs.set(node, values);
    if (drawingTags.has(node.tag) || ['g', 'svg'].includes(node.tag)) {
      for (const [prop, target] of values) {
        if (prop.startsWith('marker-') && !['path', 'line', 'polyline', 'polygon'].includes(node.tag)) continue;
        for (const owner of activeOwners) dependencies.get(owner)!.add(target);

      }
    }
    for (const child of node.children) if (typeof child !== 'string') effective(child, values, activeOwners);
  }
  effective(root, new Map(), []);
  // Nested markers can multiply a tiny source into millions of rendered paths.
  for (const targets of dependencies.values()) if ([...targets].some((target) => target.tag === 'marker')) throw Object.assign(new Error('SVG 资源引用循环或过深'), { svgCode: 'cycle' });
  function visit(node: SvgNode, stack: Set<SvgNode>): number {
    if (stack.has(node)) throw Object.assign(new Error('SVG 资源引用循环或过深'), { svgCode: 'cycle' });
    const cached = heights.get(node);
    if (cached !== undefined) return cached;
    const next = new Set(stack).add(node);
    let height = 1;
    for (const dep of dependencies.get(node) || []) height = Math.max(height, 1 + visit(dep, next));
    if (height > svgLimits.referenceDepth) throw Object.assign(new Error('SVG 资源引用循环或过深'), { svgCode: 'cycle' });
    heights.set(node, height);
    return height;
  }
  for (const resource of resources) visit(resource, new Set());
  // Count repeated geometry/text at every resource application, not only source nodes.
  // Memoize definition costs so branching DAGs remain linear to validate.
  const costs = new Map<SvgNode, number>();
  function cost(node: SvgNode, definition = false): number {
    if (['defs', 'title', 'desc', 'metadata'].includes(node.tag) || (resourceTags.has(node.tag) && !definition)) return 0;
    const cached = definition ? costs.get(node) : undefined;
    if (cached !== undefined) return cached;
    let total = 1;
    for (const attr of ['d', 'points', 'x', 'y', 'dx', 'dy', 'rotate']) total += node.attrs[attr]?.match(new RegExp(numeric, 'g'))?.length || 0;
    for (const child of node.children) {
      total += typeof child === 'string' ? (['text', 'tspan'].includes(node.tag) ? child.length : 0) : cost(child);
      if (total > svgLimits.expandedGeometry) invalid();
    }
    for (const [prop, target] of effectiveRefs.get(node) || []) {
      if (prop.startsWith('marker-') && !['path', 'line', 'polyline', 'polygon'].includes(node.tag)) continue;
      if (prop !== 'clip-path' && !drawingTags.has(node.tag)) continue;
      const instances = prop === 'marker-mid' ? Math.max(1, (node.attrs.d || node.attrs.points || '').match(new RegExp(numeric, 'g'))?.length || 0) : 1;
      total += instances * cost(target, true);
      if (total > svgLimits.expandedGeometry) invalid();
    }
    const inheritedGradient = resolved.get(node)?.get('href');
    if (inheritedGradient) total += cost(inheritedGradient, true);
    if (total > svgLimits.expandedGeometry) invalid();
    if (definition) costs.set(node, total);
    return total;
  }
  // Also bound unused definitions, so later reuse cannot turn a small source into a bomb.
  for (const resource of resources) cost(resource, true);
  cost(root);

  const result = serialize(root);
  if (new TextEncoder().encode(result).length > svgLimits.bytes) invalid();
  return result;
}
