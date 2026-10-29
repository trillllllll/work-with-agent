import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Keep PDF.js support data beside the shipped reader, including desktop/offline builds. */
export function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve('pdfjs-dist/package.json');
  const { version } = JSON.parse(readFileSync(packageFile, 'utf8')) as { version: string };
  const root = path.dirname(packageFile);
  const files = new Map<string, string>();
  for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (entry.isFile()) files.set(`pdfjs/${version}/${directory}/${entry.name}`, path.join(root, directory, entry.name));
    }
  }
  return {
    name: 'dovun-pdfjs-assets',
    generateBundle() {
      for (const [fileName, source] of files) this.emitFile({ type: 'asset', fileName, source: readFileSync(source) });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const base = server.config.base;
        const source = pathname.startsWith(base) ? files.get(pathname.slice(base.length)) : undefined;
        if (!source || !['GET', 'HEAD'].includes(req.method ?? '')) { next(); return; }
        const type = source.endsWith('.wasm') ? 'application/wasm' : source.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        res.setHeader('Content-Type', type);
        res.end(req.method === 'HEAD' ? undefined : readFileSync(source));
      });
    },
  };
}
