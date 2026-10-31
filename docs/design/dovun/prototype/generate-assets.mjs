// Rasterize the reviewed SVG master; original selected PNG remains untouched.
// node docs/design/dovun/prototype/generate-assets.mjs          regenerate variants and exports here
// node docs/design/dovun/prototype/generate-assets.mjs --app    also install them where the app reads icons (macOS)
import sharp from 'sharp';
import { copyFile, cp, mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const install = process.argv.includes('--app');
if (install && process.platform !== 'darwin') throw new Error('--app needs macOS: the desktop bundle uses the ICNS built by iconutil.');

const assets = join(dirname(fileURLToPath(import.meta.url)), '../assets');
const exportsDir = join(assets, 'exports');
await mkdir(exportsDir, { recursive: true });
const svg = await readFile(join(assets, 'dovun-mark.svg'), 'utf8');
await writeFile(join(assets, 'dovun-mark-mono.svg'), svg.replace(/#354d85|#cf7659/g, '#242b37'));
await writeFile(join(assets, 'dovun-mark-white.svg'), svg.replace(/#354d85|#cf7659/g, '#ffffff'));
// Android notification badge: only the alpha channel is shown, so it is the white mark on transparency,
// fitted to Material's 20dp live area of a 24dp icon (80 of 96 px; 96 px covers 4x screens).
// Separate sharp pipelines on purpose: within one pipeline sharp trims before it resizes.
{
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  const rendered = await sharp(Buffer.from(svg)).png().toBuffer();
  const trimmed = await sharp(rendered).trim().toBuffer();
  const { data, info } = await sharp(trimmed).resize(80, 80, { fit: 'contain', background: transparent })
    .extend({ top: 8, bottom: 8, left: 8, right: 8, background: transparent })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) data[i] = data[i + 1] = data[i + 2] = 255;
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(join(exportsDir, 'dovun-badge-96.png'));
}
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

if (install) {
  const repo = join(assets, '../../../..');
  const icons = join(repo, 'desktop/src-tauri/icons');
  const copies = [
    [join(assets, 'dovun-mark.svg'), 'client/src/assets/dovun-mark.svg'],
    [join(assets, 'dovun-mark.svg'), 'client/public/dovun.svg'],
    [join(assets, 'dovun-mark.svg'), 'desktop/splash/dovun.svg'],
    [join(exportsDir, 'dovun-badge-96.png'), 'client/public/push-badge-96.png'],
    [join(exportsDir, 'Dovun.icns'), 'desktop/src-tauri/icons/icon.icns'],
    [join(exportsDir, 'dovun.ico'), 'desktop/src-tauri/icons/icon.ico'],
    [join(exportsDir, 'dovun-app-1024.png'), 'desktop/src-tauri/icons/icon.png'],
    [join(iconset, 'icon_32x32.png'), 'desktop/src-tauri/icons/32x32.png'],
    [join(iconset, 'icon_128x128.png'), 'desktop/src-tauri/icons/128x128.png'],
    [join(iconset, 'icon_128x128@2x.png'), 'desktop/src-tauri/icons/128x128@2x.png'],
  ];
  for (const [from, to] of copies) await copyFile(from, join(repo, to));
  for (const [size, name] of [[180, 'apple-touch-icon.png'], [192, 'push-icon-192.png'], [512, 'push-icon-512.png']]) {
    await sharp(Buffer.from(tile)).resize(size, size).png().toFile(join(repo, 'client/public', name));
  }
  // Store, Android and iOS icons are not in the current bundle; the Tauri CLI regenerates them so none keeps an old mark.
  const scratch = await mkdtemp(join(tmpdir(), 'dovun-tauri-icons-'));
  try {
    execFileSync(process.execPath, [join(repo, 'scripts/tauri.mjs'), 'icon', join(exportsDir, 'dovun-app-1024.png'), '-o', scratch], { stdio: ['ignore', 'ignore', 'inherit'] });
    for (const name of (await readdir(scratch)).filter(name => /^(64x64|StoreLogo|Square\d+x\d+Logo)\.png$/.test(name))) {
      await copyFile(join(scratch, name), join(icons, name));
    }
    for (const dir of ['android', 'ios']) await cp(join(scratch, dir), join(icons, dir), { recursive: true });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log('Installed into client/src/assets, client/public, desktop/splash and desktop/src-tauri/icons.');
}
