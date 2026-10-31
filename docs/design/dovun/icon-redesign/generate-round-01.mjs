// Round 1: three new directions (A/B/C), each on a porcelain and a navy tile.
// Run from the repo root with Node >= 22: node docs/design/dovun/icon-redesign/generate-round-01.mjs
// The shipping icon files are not touched.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { png, referenceApps, renderCurrent, systemRendersEnabled, systemSheet, withProbeApps } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const candidatesDir = join(here, 'round-01/candidates');
const rendersDir = join(here, 'round-01/renders');

// Colors come from the shipping tokens (client/src/styles/control-tokens.css).
const palettes = {
  light: { navy: '#354d85', coral: '#cf7659' },
  dark: { navy: '#b4c9ed', coral: '#e2a18b' },
  mono: { navy: '#303a46', coral: '#303a46' },
  white: { navy: '#ffffff', coral: '#ffffff' },
  onNavy: { navy: '#f6f4ee', coral: '#e8906f' },
};
const tiles = {
  porcelain: { palette: 'light', paint: ['#fcfbf8', '#eeece5'] },
  navy: { palette: 'onNavy', paint: ['#405a95', '#2e4376'] },
};
// macOS grid: 824pt body centred on a 1024 canvas.
const body = { x: 100, size: 824, radius: 185 };

// ---------- geometry helpers ----------
const K = 0.5523; // cubic handle ratio for circular corners
const fmt = n => String(Math.round(n * 10) / 10);
const pt = ([x, y]) => `${fmt(x)} ${fmt(y)}`;

function roundedPolygon(points, radius) {
  const n = points.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const p = points[i], prev = points[(i + n - 1) % n], next = points[(i + 1) % n];
    const r = Array.isArray(radius) ? radius[i] : radius;
    const lp = Math.hypot(prev[0] - p[0], prev[1] - p[1]);
    const ln = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const t = Math.min(r, lp / 2, ln / 2);
    const a = [p[0] + (prev[0] - p[0]) * t / lp, p[1] + (prev[1] - p[1]) * t / lp];
    const b = [p[0] + (next[0] - p[0]) * t / ln, p[1] + (next[1] - p[1]) * t / ln];
    const c1 = [a[0] + (p[0] - a[0]) * K, a[1] + (p[1] - a[1]) * K];
    const c2 = [b[0] + (p[0] - b[0]) * K, b[1] + (p[1] - b[1]) * K];
    d += `${i ? 'L' : 'M'}${pt(a)}C${pt(c1)} ${pt(c2)} ${pt(b)}`;
  }
  return `${d}Z`;
}
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// Card with vertical sides; top and bottom edges rise to the right by `rise` per unit.
function slantCard(x0, x1, top, height, rise) {
  const dy = (x1 - x0) * rise;
  return [[x0, top], [x1, top - dy], [x1, top - dy + height], [x0, top + height]];
}

// One and a half turns of a square fret inside [o0, o1], opening at the lower left.
function fretBand(o0, o1, w, g) {
  const a = o0 + w, b = a + g, c = b + w, e = o1 - w;
  const points = [[o0, o0], [o1, o0], [o1, o1], [b, o1], [b, b], [e - g, b], [e - g, c], [c, c], [c, e], [e, e], [e, a], [a, a], [a, o1], [o0, o1]];
  return { points, inner: [c + g, c + g, e - g, e - g] };
}

// ---------- candidates ----------
// A shape is one fill: one or more rounded polygons, with bounds kept for the mark's view box.
function shape(tone, polygons, rule) {
  const all = polygons.flatMap(([points]) => points);
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  return {
    tone, rule,
    d: polygons.map(([points, radius]) => roundedPolygon(points, radius)).join(''),
    bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  };
}

function candidateA() {
  // The spine steps up and to the right through one 45° jog, so neither side card needs a notch.
  const s = 0.36, g = 64, w = 192, d = 80;
  const L = 372, T = 150, B = 870, jogLeft = 470;
  const jogRight = jogLeft + w * (Math.SQRT2 - 1); // keeps the 45° jog as thick as the spine
  const spine = [
    [L + d, T], [L + d + w, T - w * s], [L + d + w, jogRight], [L + w, jogRight + d],
    [L + w, B], [L, B + w * s], [L, jogLeft + d], [L + d, jogLeft],
  ];
  const left = slantCard(60, L - g, 420 + (L - g - 60) * s, 430, s);
  const right = slantCard(L + d + w + g, 964, 210, 440, s);
  return [
    shape('navy', [[left, 52]]),
    shape('navy', [[spine, [52, 52, 52, 28, 52, 52, 52, 28]]]),
    shape('coral', [[right, 52]]),
  ];
}

function candidateB() {
  // A rounded square split by one L-shaped gap: the workbench and the card on it.
  const gap = 64, card = [528, 128, 896, 496], r = 72, outer = 140;
  const l = [[128, 128], [card[0] - gap, 128], [card[0] - gap, card[3] + gap], [896, card[3] + gap], [896, 896], [128, 896]];
  return [
    shape('navy', [[l, [outer, 48, r + gap, 48, outer, outer]]]),
    shape('coral', [[rect(...card), [r, outer, r, r]]]),
  ];
}

function candidateC() {
  // A seal with a fret carved out (white-text seal); the carving shows whatever is behind it.
  const { points } = fretBand(272, 752, 88, 64);
  const radii = [40, 40, 40, 30, 30, 24, 24, 12, 12, 12, 12, 12, 30, 40];
  return [shape('coral', [[rect(128, 128, 896, 896), 150], [points, radii]], 'evenodd')];
}

// scale: share of the 824 icon body; pad: margin around the bare mark, larger for solid shapes.
const candidates = [
  { id: 'a', name: 'A 归栈·减法', scale: 0.84, pad: 0.04, shapes: candidateA() },
  { id: 'b', name: 'B 工作台·一张卡', scale: 0.84, pad: 0.07, shapes: candidateB() },
  { id: 'c', name: 'C 回纹·朱印', scale: 0.8, pad: 0.08, shapes: candidateC() },
];

// ---------- SVG builders ----------
const paths = (shapes, palette) => shapes.map(s => `<path fill="${palette[s.tone]}"${s.rule ? ` fill-rule="${s.rule}"` : ''} d="${s.d}"/>`).join('');

function markViewBox(c) {
  const [x0, y0, x1, y1] = c.shapes.map(s => s.bounds).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
  const side = Math.max(x1 - x0, y1 - y0) * (1 + 2 * c.pad);
  return [(x0 + x1 - side) / 2, (y0 + y1 - side) / 2, side, side].map(fmt).join(' ');
}
const markSvg = (c, palette, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${markViewBox(c)}"><title>${title}</title>${paths(c.shapes, palettes[palette])}</svg>\n`;

function tileSvg(c, tileName) {
  const tile = tiles[tileName];
  const box = body.size * c.scale, offset = body.x + (body.size - box) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><title>${c.name} · ${tileName}</title>`
    + `<defs><linearGradient id="paint" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tile.paint[0]}"/><stop offset="1" stop-color="${tile.paint[1]}"/></linearGradient></defs>`
    + `<rect x="${body.x}" y="${body.x}" width="${body.size}" height="${body.size}" rx="${body.radius}" fill="url(#paint)"/>`
    + `<svg x="${fmt(offset)}" y="${fmt(offset)}" width="${fmt(box)}" height="${fmt(box)}" viewBox="0 0 1024 1024">${paths(c.shapes, palettes[tile.palette])}</svg></svg>\n`;
}

// ---------- run ----------
await mkdir(rendersDir, { recursive: true });
const tileSvgs = { current: await renderCurrent(rendersDir) };
for (const c of candidates) {
  const dir = join(candidatesDir, c.id);
  await mkdir(dir, { recursive: true });
  const variants = {
    'mark.svg': markSvg(c, 'light', `Dovun ${c.name}`),
    'mark-dark.svg': markSvg(c, 'dark', `Dovun ${c.name} · dark`),
    'mark-mono.svg': markSvg(c, 'mono', `Dovun ${c.name} · mono`),
    'badge.svg': markSvg(c, 'white', `Dovun ${c.name} · badge`),
  };
  for (const tileName of Object.keys(tiles)) variants[`tile-${tileName}.svg`] = tileSvg(c, tileName);
  for (const [file, svg] of Object.entries(variants)) await writeFile(join(dir, file), svg);

  for (const size of [16, 32]) await png(variants['mark.svg'], size, join(rendersDir, `${c.id}-mark-${size}.png`));
  await png(variants['badge.svg'], 48, join(rendersDir, `${c.id}-badge-48.png`));
  for (const tileName of Object.keys(tiles)) {
    const svg = variants[`tile-${tileName}.svg`];
    for (const size of [16, 32, 64, 128, 256]) await png(svg, size, join(rendersDir, `${c.id}-tile-${tileName}-${size}.png`));
    tileSvgs[`${c.id}-${tileName}`] = svg;
  }
}

if (systemRendersEnabled) {
  await withProbeApps(tileSvgs, async probes => {
    for (const [key, app] of Object.entries(probes)) systemSheet([app], join(rendersDir, `system-${key}.png`), null, 256, 0);
    for (const tileName of Object.keys(tiles)) {
      const row = [probes.current, ...candidates.map(c => probes[`${c.id}-${tileName}`]), ...referenceApps];
      systemSheet(row, join(rendersDir, `dock-${tileName}-light.png`), [0.9, 0.9, 0.91]);
      systemSheet(row, join(rendersDir, `dock-${tileName}-dark.png`), [0.16, 0.16, 0.18]);
    }
  });
}
console.log(`Generated ${candidates.length} candidates into ${candidatesDir} and renders into ${rendersDir}.`);
