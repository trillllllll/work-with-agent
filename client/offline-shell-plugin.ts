import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

export function offlineShell(): Plugin {
  return {
    name: 'dovun-offline-shell', enforce: 'post', apply: 'build',
    generateBundle(_options, bundle) {
      const assets = ['/index.html', ...Object.keys(bundle).filter(name => /\.(?:js|css|woff2?|ttf|svg|png|ico)$/.test(name)).map(name => `/${name}`)];
      const version = createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0, 16);
      const worker = readFileSync(new URL('./offline-worker.js', import.meta.url), 'utf8');
      this.emitFile({ type: 'asset', fileName: 'offline-worker.js', source: `const SHELL = ${JSON.stringify('dovun-shell-' + version)};\nconst ASSETS = ${JSON.stringify(assets)};\n${worker}` });
    },
  };
}
