import http from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// supertest opens and closes a port for every request. On macOS that race can
// answer a later request with an empty body. Keep one unref'd server per app.
const here = dirname(fileURLToPath(import.meta.url));
const packaged = [resolve(here, '../node_modules/supertest/index.js'), resolve(here, '../../node_modules/supertest/index.js')].find((path) => existsSync(path));
if (!packaged) throw new Error('supertest package was not found');
const real = createRequire(import.meta.url)(packaged) as (app: unknown, options?: { http2?: boolean }) => Record<string, unknown> & {
  Test: unknown;
  agent: unknown;
  cookies: unknown;
};

const bound = new WeakMap<Function, http.Server>();
const listening = new Set<http.Server>();

function shared(app: Function) {
  let server = bound.get(app);
  if (!server?.listening) {
    server = http.createServer(app as http.RequestListener);
    server.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    server.unref();
    bound.set(app, server);
    listening.add(server);
  }
  return server;
}

function supertest(app: unknown, options?: { http2?: boolean }) {
  if (typeof app !== 'function' || options?.http2) return real(app, options);
  return real(shared(app), options);
}

export async function closeSharedServers() {
  const current = [...listening];
  listening.clear();
  await Promise.all(current.map((server) => new Promise<void>((resolveClose) => {
    if (!server.listening) return resolveClose();
    server.close(() => resolveClose());
    setTimeout(resolveClose, 500).unref();
  })));
}

export default Object.assign(supertest, { Test: real.Test, agent: real.agent, cookies: real.cookies, closeSharedServers });
