// Rasterize the reviewed SVG master; original selected PNG remains untouched.
import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = join(dirname(fileURLToPath(import.meta.url)), '../assets');
const exportsDir = join(assets, 'exports');
await mkdir(exportsDir, { recursive: true });
const svg = await readFile(join(assets, 'dovun-mark.svg'), 'utf8');
await writeFile(join(assets, 'dovun-mark-mono.svg'), svg.replace(/#354d85|#cf7659/g, '#242b37'));
await writeFile(join(assets, 'dovun-mark-white.svg'), svg.replace(/#354d85|#cf7659/g, '#ffffff'));
const inner = svg.replace(/<svg[^>]*>/, '').replace('</svg>', '');
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><title>Dovun application icon</title><rect width="1024" height="1024" rx="224" fill="#f5f6f8"/><svg x="84" y="84" width="856" height="856" viewBox="0 0 1254 1254">${inner}</svg></svg>`;
await writeFile(join(assets, 'dovun-app-icon.svg'), tile);
for (const size of [16, 24, 32, 64, 128, 256, 512, 1024]) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(join(exportsDir, `dovun-mark-${size}.png`));
}
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(size => sharp(Buffer.from(tile)).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((bytes, i) => {
  const pos = 6 + i * 16, size = sizes[i];
  header[pos] = header[pos + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, pos + 4); header.writeUInt16LE(32, pos + 6);
  header.writeUInt32LE(bytes.length, pos + 8); header.writeUInt32LE(offset, pos + 12);
  offset += bytes.length;
});
await writeFile(join(exportsDir, 'dovun.ico'), Buffer.concat([header, ...images]));
const iconset = join(exportsDir, 'Dovun.iconset');
await mkdir(iconset, { recursive: true });
for (const base of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
  await sharp(Buffer.from(tile)).resize(base * scale, base * scale).png().toFile(join(iconset, `icon_${base}x${base}${scale === 2 ? '@2x' : ''}.png`));
}
await sharp(Buffer.from(tile)).resize(1024, 1024).png().toFile(join(exportsDir, 'dovun-app-1024.png'));
if (process.platform === 'darwin') execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(exportsDir, 'Dovun.icns')]);
console.log('Dovun vector variants, PNG sizes, ICO and iconset generated. ICNS generated on macOS.');
