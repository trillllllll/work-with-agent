// Shared helpers for the Dovun icon review rounds: PNG rasterising and macOS system renders.
import sharp from 'sharp';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const png = (svg, size, file) => sharp(Buffer.from(svg)).resize(size, size).png().toFile(file);

// The 2026-10-23 icon, frozen so review pages keep comparing against it after the app icon changes.
export const baselineDir = join(dirname(fileURLToPath(import.meta.url)), 'baseline');

// Baseline renders; returns the baseline tile SVG so callers can include it in their system renders.
export async function renderCurrent(rendersDir) {
  const tile = await readFile(join(baselineDir, 'dovun-app-icon.svg'), 'utf8');
  for (const size of [16, 32, 64, 128, 256]) await png(tile, size, join(rendersDir, `current-tile-${size}.png`));
  // Android keeps only the alpha channel of a notification badge, so the opaque tile shows as a white block.
  const { data, info } = await sharp(join(baselineDir, 'push-icon-192.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) data[i] = data[i + 1] = data[i + 2] = 255;
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .resize(48, 48).png().toFile(join(rendersDir, 'current-badge-48.png'));
  return tile;
}

// System renders need macOS; set SKIP_SYSTEM=1 to iterate on geometry faster.
export const systemRendersEnabled = process.platform === 'darwin' && !process.env.SKIP_SYSTEM;
export const referenceApps = ['/System/Applications/Calendar.app', '/System/Applications/Notes.app', '/Applications/Safari.app', '/Applications/Obsidian.app', '/Applications/Claude.app', '/Applications/flomo.app'];

const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

async function icns(svg, dir) {
  const iconset = join(dir, 'icon.iconset');
  await mkdir(iconset, { recursive: true });
  for (const base of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    await png(svg, base * scale, join(iconset, `icon_${base}x${base}${scale === 2 ? '@2x' : ''}.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(dir, 'icon.icns')]);
  return join(dir, 'icon.icns');
}

async function probeApp(lab, id, icnsPath, run) {
  const app = join(lab, `${id}.app`);
  await mkdir(join(app, 'Contents/Resources'), { recursive: true });
  await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
  await copyFile(icnsPath, join(app, 'Contents/Resources/icon.icns'));
  await copyFile('/usr/bin/true', join(app, 'Contents/MacOS/probe'));
  await chmod(join(app, 'Contents/MacOS/probe'), 0o755);
  await writeFile(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>lab.dovun-icon.${id}.${run}</string>
<key>CFBundleName</key><string>IconLab ${id}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundleIconFile</key><string>icon</string>
</dict></plist>
`);
  return app;
}

// Draws each app's system icon in a row; background is [r, g, b] in 0..1, or null for transparent.
export function systemSheet(apps, file, background, cell = 160, pad = 18) {
  const fill = background ? `$.NSColor.colorWithSRGBRedGreenBlueAlpha(${background.join(',')}, 1).setFill; $.NSRectFill($.NSMakeRect(0, 0, W, H));` : '';
  const code = `ObjC.import("AppKit");
const apps = ${JSON.stringify(apps)}, cell = ${cell}, pad = ${pad}, W = apps.length * cell, H = cell;
const canvas = $.NSImage.alloc.initWithSize($.NSMakeSize(W, H));
canvas.lockFocus; ${fill}
apps.forEach((p, i) => $.NSWorkspace.sharedWorkspace.iconForFile(p).drawInRectFromRectOperationFraction($.NSMakeRect(i * cell + pad, pad, cell - 2 * pad, cell - 2 * pad), $.NSMakeRect(0, 0, 0, 0), 2, 1.0));
canvas.unlockFocus;
$.NSBitmapImageRep.imageRepWithData(canvas.TIFFRepresentation).representationUsingTypeProperties(4, $()).writeToFileAtomically(${JSON.stringify(file)}, true);
"ok"`;
  execFileSync('osascript', ['-l', 'JavaScript', '-e', code]);
}

// Wraps each tile SVG in a throwaway app bundle under /tmp so macOS renders it as an app icon.
// The bundles are unregistered from LaunchServices and deleted afterwards, even on failure.
export async function withProbeApps(tiles, render) {
  const run = Date.now().toString(36);
  const lab = join('/tmp', `dovun-icon-lab-${run}`);
  const apps = {};
  try {
    for (const [key, svg] of Object.entries(tiles)) {
      const work = join(lab, 'work', key);
      await mkdir(work, { recursive: true });
      apps[key] = await probeApp(lab, key, await icns(svg, work), run);
    }
    await render(apps);
  } finally {
    for (const app of Object.values(apps)) {
      try { execFileSync(lsregister, ['-u', app]); } catch { /* not registered */ }
    }
    await rm(lab, { recursive: true, force: true });
  }
}
