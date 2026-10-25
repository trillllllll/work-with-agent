// Owns one isolated test server and an HTTP fault proxy. Never imported by the application.
import http from 'node:http';
import { spawn } from 'node:child_process';
const front = Number(process.env.PORT), back = front + 1;
let offline = false;
const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { stdio: 'inherit', env: { ...process.env, PORT: String(back) } });
const proxy = http.createServer((request, response) => {
  if (offline) { response.destroy(); return; }
  const upstream = http.request({ hostname: '127.0.0.1', port: back, path: request.url, method: request.method, headers: request.headers }, source => {
    response.writeHead(source.statusCode, source.headers); source.pipe(response);
  });
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  response.on('close', () => upstream.destroy());
  request.on('aborted', () => upstream.destroy()); request.pipe(upstream);
});
const control = http.createServer((request, response) => {
  if (request.method !== 'POST' || !['/offline', '/online'].includes(request.url)) { response.writeHead(404).end(); return; }
  offline = request.url === '/offline'; response.writeHead(200).end('ok');
});
proxy.listen(front, '127.0.0.1'); control.listen(front + 2, '127.0.0.1');
process.on('SIGTERM', () => { proxy.closeAllConnections(); proxy.close(); control.closeAllConnections(); control.close(); child.kill('SIGTERM'); setTimeout(() => process.exit(0), 500).unref(); });
child.on('exit', code => process.exit(code ?? 1));
