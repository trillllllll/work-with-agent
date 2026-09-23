import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../desktop/splash');
const server = createServer((request, response) => {
  const file = request.url === '/' ? '/index.html' : request.url ?? '/index.html';
  const stream = createReadStream(resolve(root, `.${file}`));
  stream.on('error', () => {
    response.writeHead(404);
    response.end();
  });
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  stream.pipe(response);
});
server.listen(47111, '127.0.0.1');
