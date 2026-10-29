import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { pdfjsAssets } from './pdfjs-assets-plugin.js';
import { pdfjsAssetUrls } from './src/components/documents/readers/pdfjs-assets.js';
import { cjkPdf } from '../e2e/fixtures/cjk-pdf.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

it('ships local CMaps, fonts and wasm and reads a Chinese PDF using only those built assets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dovun-pdfjs-assets-')); directories.push(directory);
  const entry = path.join(directory, 'entry.js'); const outDir = path.join(directory, 'dist');
  await writeFile(entry, 'export default 1;');
  await build({ configFile: false, root: directory, logLevel: 'silent', plugins: [pdfjsAssets()], build: { outDir, rollupOptions: { input: entry } } });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const urls = pdfjsAssetUrls(pdfjs.version, `${outDir}/`);
  for (const file of [`${urls.cMapUrl}GB-EUC-H.bcmap`, `${urls.cMapUrl}Adobe-GB1-UCS2.bcmap`, `${urls.standardFontDataUrl}LiberationSans-Regular.ttf`, `${urls.wasmUrl}openjpeg.wasm`]) expect((await readFile(file)).length).toBeGreaterThan(0);
  const loading = pdfjs.getDocument({ data: new Uint8Array(cjkPdf()), enableXfa: false, stopAtErrors: true, ...urls });
  try {
    const document = await loading.promise; const page = await document.getPage(1); const content = await page.getTextContent();
    expect(content.items.map((item) => 'str' in item ? item.str : '').join('')).toBe('中文');
  } finally { await loading.destroy(); }
});
