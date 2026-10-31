// Round 2: keep 归栈宽缝 exactly as it was on 2026-10-23 and show the cube faces it already implies.
// The left block's outline is a cube's top face plus front face, its right half hidden by the spine;
// the spine's cap is another top face. Variants mark the hidden front-top edge with a lighter
// top face or a narrow cut. Silhouettes stay identical to baseline/dovun-mark.svg.
// 乙 (cut) was adopted on 2026-10-31: candidates/cut/master.svg is that variant baked into plain paths,
// copied to docs/design/dovun/assets/dovun-mark.svg.
// Run from the repo root with Node >= 22: node docs/design/dovun/icon-redesign/generate-round-02.mjs
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineDir, png, referenceApps, renderCurrent, systemRendersEnabled, systemSheet, withProbeApps } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'round-02');
const candidatesDir = join(outDir, 'candidates');
const rendersDir = join(outDir, 'renders');

// ---------- baseline master ----------
const masterSvg = await readFile(join(baselineDir, 'dovun-mark.svg'), 'utf8');
const found = [...masterSvg.matchAll(/<path(?: transform="translate\((-?\d+) 0\)")? fill="(#[0-9a-f]{6})" d="([^"]+)"\/>/g)];
if (found.length !== 3) throw new Error(`expected 3 paths in the baseline mark, found ${found.length}`);
const [left, spine, coral] = found.map(([, dx, fill, d]) => ({ dx: Number(dx ?? 0), fill, d }));
if (left.fill !== '#354d85' || spine.fill !== '#354d85' || coral.fill !== '#cf7659') throw new Error('baseline mark colors changed');

// Hidden front-top edges, in each piece's own coordinates (before its translate).
// Left block: from its top-left corner (98, 645), parallel to its bottom edge (127,963)-(548,1143).
// Spine: from its top-left corner (499, 254.9) to the inner end of its notch (688, 345).
const edgeLine = (x0, y0, slope, from, to) => ({ slope, from, to, y: x => y0 + slope * (x - x0) });
left.edge = edgeLine(98, 645, 180 / 421, 40, 520);
spine.edge = edgeLine(499, 254.9, (345 - 254.9) / (688 - 499), 440, 910);

// ---------- palettes and variants ----------
// lit: the top face, one step lighter than the brand navy (light comes from above).
const palettes = {
  light: { navy: '#354d85', lit: '#5671ad', coral: '#cf7659' },
  dark: { navy: '#b4c9ed', lit: '#dbe5f7', coral: '#e2a18b' },
  mono: { navy: '#303a46', lit: null, coral: '#303a46' },
  white: { navy: '#ffffff', lit: null, coral: '#ffffff' },
};
const cut = 30; // narrow cut, about 40% of the existing gaps between pieces

const variants = [
  { id: 'tone', name: '甲 左块顶面提亮', faces: { left: 'tone' } },
  { id: 'cut', name: '乙 左块顶面开缝', faces: { left: 'cut' } },
  { id: 'tone-spine', name: '丙 左块与中脊顶面提亮', faces: { left: 'tone', spine: 'tone' } },
  { id: 'cut-spine', name: '丁 左块与中脊顶面开缝', faces: { left: 'cut', spine: 'cut' } },
];

const fmt = n => String(Math.round(n * 10) / 10);
const pt = ([x, y]) => `${fmt(x)} ${fmt(y)}`;
const above = e => `M${fmt(e.from)} ${fmt(e.y(e.from))}L${fmt(e.to)} ${fmt(e.y(e.to))}L${fmt(e.to)} -20L${fmt(e.from)} -20Z`;
const along = e => `M${fmt(e.from)} ${fmt(e.y(e.from))}L${fmt(e.to)} ${fmt(e.y(e.to))}`;

// One piece. Single-colour palettes cannot show a lighter face, so they mark the same edge with the cut.
function piece(name, part, requested, palette, prefix) {
  const face = requested === 'tone' && !palette.lit ? 'cut' : requested;
  const fill = name === 'coral' ? palette.coral : palette.navy;
  const open = part.dx ? `<g transform="translate(${part.dx} 0)">` : '<g>';
  if (face === 'tone') {
    const id = `${prefix}-${name}-shape`;
    return `${open}<clipPath id="${id}"><path d="${part.d}"/></clipPath><path fill="${fill}" d="${part.d}"/>`
      + `<path clip-path="url(#${id})" fill="${palette.lit}" d="${above(part.edge)}"/></g>`;
  }
  if (face === 'cut') {
    const id = `${prefix}-${name}-cut`;
    return `${open}<mask id="${id}" maskUnits="userSpaceOnUse" x="-100" y="-100" width="1454" height="1454">`
      + `<rect x="-100" y="-100" width="1454" height="1454" fill="#fff"/><path d="${along(part.edge)}" stroke="#000" stroke-width="${cut}" fill="none"/></mask>`
      + `<path mask="url(#${id})" fill="${fill}" d="${part.d}"/></g>`;
  }
  return `${open}<path fill="${fill}" d="${part.d}"/></g>`;
}

const inner = (v, paletteName, prefix) => {
  const palette = palettes[paletteName];
  return piece('left', left, v.faces.left, palette, prefix) + piece('spine', spine, v.faces.spine, palette, prefix) + piece('coral', coral, null, palette, prefix);
};
const markSvg = (v, paletteName) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254" fill="none"><title>Dovun ${v.name}</title>${inner(v, paletteName, 'm')}</svg>\n`;
// Same tile as the baseline icon (baseline/dovun-app-icon.svg), so only the faces differ.
const tileSvg = v =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><title>Dovun ${v.name}</title><rect width="1024" height="1024" rx="224" fill="#f5f6f8"/>`
  + `<svg x="84" y="84" width="856" height="856" viewBox="0 0 1254 1254">${inner(v, 'light', 't')}</svg></svg>\n`;

// ---------- baking the cut into plain paths ----------
// Parses the absolute M/L/V/Q/Z subset the master uses into line and quadratic segments.
function segments(d) {
  const tokens = d.match(/[MLVQZ]|-?\d*\.?\d+/g);
  const segs = [];
  let i = 0, cmd = null, cur = null, start = null;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[MLVQZ]$/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === 'M') cur = start = [num(), num()];
    else if (cmd === 'L') { const p = [num(), num()]; segs.push({ type: 'L', p: [cur, p] }); cur = p; }
    else if (cmd === 'V') { const p = [cur[0], num()]; segs.push({ type: 'L', p: [cur, p] }); cur = p; }
    else if (cmd === 'Q') { const c = [num(), num()], p = [num(), num()]; segs.push({ type: 'Q', p: [cur, c, p] }); cur = p; }
    else if (cmd === 'Z') { if (cur[0] !== start[0] || cur[1] !== start[1]) segs.push({ type: 'L', p: [cur, start] }); cur = start; }
    else throw new Error(`unsupported path data near token ${i}`);
  }
  return segs;
}

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function split(s, t) {
  if (s.type === 'L') { const m = lerp(s.p[0], s.p[1], t); return [{ type: 'L', p: [s.p[0], m] }, { type: 'L', p: [m, s.p[1]] }]; }
  const [p0, p1, p2] = s.p, a = lerp(p0, p1, t), b = lerp(p1, p2, t), m = lerp(a, b, t);
  return [{ type: 'Q', p: [p0, a, m] }, { type: 'Q', p: [m, b, p2] }];
}

// Where an outline crosses the line f(p) = 0 (f is affine, so it is quadratic along a Q segment).
function crossings(segs, f) {
  const out = [];
  segs.forEach((s, index) => {
    const v = s.p.map(f);
    let ts = [];
    if (s.type === 'L') {
      if ((v[0] < 0) !== (v[1] < 0)) ts = [v[0] / (v[0] - v[1])];
    } else {
      const a = v[0] - 2 * v[1] + v[2], b = 2 * (v[1] - v[0]), c = v[0];
      if (Math.abs(a) < 1e-9) ts = [-c / b];
      else { const disc = b * b - 4 * a * c; if (disc >= 0) ts = [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)]; }
      ts = ts.filter(t => t > 0 && t < 1);
    }
    for (const t of ts) out.push({ index, t });
  });
  return out;
}

// The part of a closed outline on one side of a line (sign < 0: f < 0), closed along the line.
function side(segs, f, sign) {
  const xs = crossings(segs, f);
  if (xs.length !== 2 || xs[0].index === xs[1].index) throw new Error(`the cut must cross two different segments, got ${JSON.stringify(xs)}`);
  const arc = (from, to) => {
    const out = [split(segs[from.index], from.t)[1]];
    for (let i = (from.index + 1) % segs.length; i !== to.index; i = (i + 1) % segs.length) out.push(segs[i]);
    out.push(split(segs[to.index], to.t)[0]);
    return out;
  };
  const first = arc(xs[0], xs[1]);
  const chosen = Math.sign(f(first[0].p.at(-1))) === Math.sign(sign) ? first : arc(xs[1], xs[0]);
  return `M${pt(chosen[0].p[0])}` + chosen.map(s => (s.type === 'L' ? `L${pt(s.p[1])}` : `Q${pt(s.p[1])} ${pt(s.p[2])}`)).join('') + 'Z';
}

// 乙 as shipped: the left block becomes two plain fills, its top face and its front face, with the cut between.
function bakedMaster() {
  const half = (cut / 2) * Math.hypot(1, left.edge.slope); // vertical half-height of a band `cut` wide
  const segs = segments(left.d);
  const top = side(segs, p => p[1] - (left.edge.y(p[0]) - half), -1);
  const front = side(segs, p => p[1] - (left.edge.y(p[0]) + half), 1);
  const shift = dx => (dx ? ` transform="translate(${dx} 0)"` : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254" fill="none">
  <title>Dovun</title>
  <desc>Three staggered work cards, a returning central spine, and two open channels. A narrow cut shows the left card's top face.</desc>
  <path${shift(left.dx)} fill="${left.fill}" d="${top}"/>
  <path${shift(left.dx)} fill="${left.fill}" d="${front}"/>
  <path${shift(spine.dx)} fill="${spine.fill}" d="${spine.d}"/>
  <path${shift(coral.dx)} fill="${coral.fill}" d="${coral.d}"/>
</svg>
`;
}

// The baked file must draw the same pixels as the reviewed 乙.
async function compareRenders(a, b, size = 1024) {
  const [x, y] = await Promise.all([a, b].map(svg => sharp(Buffer.from(svg)).resize(size, size).ensureAlpha().raw().toBuffer()));
  let max = 0, over = 0;
  for (let i = 0; i < x.length; i++) { const d = Math.abs(x[i] - y[i]); max = Math.max(max, d); if (d > 64) over++; }
  return { max, over, total: x.length };
}

// ---------- run ----------
await mkdir(rendersDir, { recursive: true });
const tiles = { current: await renderCurrent(rendersDir) };
for (const v of variants) {
  const dir = join(candidatesDir, v.id);
  await mkdir(dir, { recursive: true });
  const files = {
    'mark.svg': markSvg(v, 'light'),
    'mark-dark.svg': markSvg(v, 'dark'),
    'mark-mono.svg': markSvg(v, 'mono'),
    'badge.svg': markSvg(v, 'white'),
    'tile.svg': tileSvg(v),
  };
  for (const [file, svg] of Object.entries(files)) await writeFile(join(dir, file), svg);
  for (const size of [16, 32, 64, 128, 256]) await png(files['tile.svg'], size, join(rendersDir, `${v.id}-tile-${size}.png`));
  await png(files['mark.svg'], 1024, join(rendersDir, `${v.id}-mark-1024.png`));
  tiles[v.id] = files['tile.svg'];
}

const baked = bakedMaster();
await writeFile(join(candidatesDir, 'cut/master.svg'), baked);
const check = await compareRenders(markSvg(variants.find(v => v.id === 'cut'), 'light'), baked);
console.log(`Baked 乙 vs reviewed 乙 at 1024px: max channel difference ${check.max}, ${check.over} of ${check.total} channel values differ by more than 64.`);
if (check.over > check.total * 0.0005) throw new Error('baked master drifted from the reviewed variant');

if (systemRendersEnabled) {
  await withProbeApps(tiles, async probes => {
    for (const [id, app] of Object.entries(probes)) systemSheet([app], join(rendersDir, `system-${id}.png`), null, 256, 0);
    const row = [probes.current, ...variants.map(v => probes[v.id]), ...referenceApps];
    systemSheet(row, join(rendersDir, 'dock-light.png'), [0.9, 0.9, 0.91]);
    systemSheet(row, join(rendersDir, 'dock-dark.png'), [0.16, 0.16, 0.18]);
  });
}
console.log(`Generated ${variants.length} round-2 variants into ${outDir}.`);
