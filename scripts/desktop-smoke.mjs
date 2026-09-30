import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';


const root = resolve(import.meta.dirname, '..');
const resources = resolve(root, 'desktop/resources');
const nodeBinary = resolve(resources, 'node.exe');
const serverDir = resolve(resources, 'server');
const dataDir = await mkdtemp(resolve(tmpdir(), 'wwa-desktop-smoke-'));
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;

let child;
let proxy;
try {
  child = start();
  const firstToken = await readyToken(child);
  const page = await fetch(`${origin}/`);
  if (!page.ok || !(await page.text()).includes('<title>')) throw new Error(`页面没有从打包服务返回（${page.status}）`);
  const anonymous = await fetch(`${origin}/api/v1/auth/session`);
  if (!anonymous.ok) throw new Error(`会话接口不可用（${anonymous.status}）`);
  const mcp = await fetch(`${origin}/mcp`, { method: 'POST' });
  if (mcp.status !== 401) throw new Error(`未授权的 MCP 请求应被拒绝，实际是 ${mcp.status}`);
  const first = await login(firstToken);
  const created = await api(first, '/api/tasks', { method: 'POST', body: JSON.stringify({ title: '桌面冒烟任务' }) });
  if (!created.ok) throw new Error(`创建任务失败：${created.status} ${await created.text()}`);
  const connection = await api(first, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ name: 'smoke', host: 'claude' }) });
  if (!connection.ok) throw new Error(`创建连接失败：${connection.status} ${await connection.text()}`);
  const credential = (await connection.json()).data.token;
  await mcpInitialize(credential);
  await stop(child);
  child = undefined;
  await expectClosed(port);
  const mcpClosed = await fetch(`${origin}/mcp`, { method: 'POST' }).then(() => false, () => true);
  if (!mcpClosed) throw new Error('服务退出后 /mcp 仍可访问');

  proxy = startProxy(credential);
  const outage = await proxy.call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_topics', arguments: {} } });
  const outageDetail = outage.result?.structuredContent;
  if (outageDetail?.code !== 'CONNECTION_UNAVAILABLE' || outageDetail?.retryable !== true) {
    throw new Error(`服务停止期间代理应返回可重试的 CONNECTION_UNAVAILABLE，实际 ${JSON.stringify(outage)}`);
  }

  child = start();
  const secondToken = await readyToken(child);
  const second = await login(secondToken);
  const tasks = await api(second, '/api/tasks?inbox=true');
  const body = await tasks.json();
  if (!tasks.ok || !body.data?.some((task) => task.title === '桌面冒烟任务')) throw new Error('重启后没有读到冒烟任务');
  await mcpInitialize(credential);
  const recovery = await proxy.call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_topics', arguments: {} } });
  if (recovery.result?.isError) throw new Error(`服务重启后同一代理应自动恢复，实际 ${JSON.stringify(recovery)}`);
  proxy.stop();
  proxy = undefined;
  await stop(child);
  child = undefined;
  console.log(`桌面运行时冒烟通过，端口 ${port}（MCP 随服务启停并可在重启后恢复）`);
} finally {
  if (proxy) proxy.stop();
  if (child) child.kill('SIGKILL');
  await cleanup(dataDir);
}

async function cleanup(dir) {
  // Windows 上 SQLite 可能晚一点才释放数据库文件，先重试几次；仍失败就把临时目录留给系统。
  for (const delay of [250, 1000, 3000]) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch { /* 文件还被锁着，稍后再试。 */ }
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    console.warn(`临时目录暂未清理：${dir}`);
  }
}

function start() {
  return spawn(nodeBinary, [resolve(serverDir, 'dist/index.js')], {
    cwd: serverDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WWA_PACKAGED: '1',
      PORT: String(port),
      CLIENT_ORIGIN: origin,
      WWA_DATA_DIR: dataDir,
      WWA_STATIC_DIR: resolve(resources, 'client'),
      DATABASE_URL: `file:${resolve(dataDir, 'agent-studio.db')}`,
      KNOWLEDGE_STORAGE_ROOT: resolve(dataDir, 'knowledge-blobs'),
      WWA_RUNNER_DIR: resolve(dataDir, 'runner'),
      AGENT_WORKSPACE_ROOT: resolve(dataDir, 'workspace'),
    },
  });
}

function readyToken(process) {
  return new Promise((resolvePromise, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('等待桌面服务启动超时')), 60_000);
    const fail = (error) => { clearTimeout(timer); reject(error); };
    process.once('exit', (code) => fail(new Error(`桌面服务在登录链接出现前退出（${code}）\n${buffer}`)));
    process.stderr.on('data', (chunk) => { buffer += chunk.toString(); });
    process.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/Open workspace: (\S+)/);
      if (!match) return;
      clearTimeout(timer);
      process.removeAllListeners('exit');
      resolvePromise(new URL(match[1]).hash.replace(/^#owner-token=/, ''));
    });
  });
}

async function login(token) {
  const response = await fetch(`${origin}/api/v1/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ bootstrapToken: token }),
  });
  if (!response.ok) throw new Error(`登录失败：${response.status} ${await response.text()}`);
  const cookie = response.headers.getSetCookie?.().map((item) => item.split(';')[0]).join('; ')
    ?? (response.headers.get('set-cookie') ?? '').split(',').map((item) => item.split(';')[0]).join('; ');
  const csrf = (await response.json()).data.csrfToken;
  return { cookie, csrf };
}

function api(session, path, init = {}) {
  return fetch(`${origin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', origin, cookie: session.cookie, 'x-csrf-token': session.csrf, ...init.headers },
  });
}

async function mcpInitialize(credential) {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'wwa-smoke', version: '0.0.0' } },
    }),
  });
  if (!response.ok) throw new Error(`MCP initialize 失败：${response.status} ${await response.text()}`);
  if (!response.headers.get('mcp-session-id')) throw new Error('MCP initialize 未返回会话 ID');
  const text = await response.text();
  const payload = text.trimStart().startsWith('{')
    ? JSON.parse(text)
    : JSON.parse(text.split('\n').find((line) => line.startsWith('data:'))?.slice(5) ?? '{}');
  if (payload.result?.serverInfo?.name !== 'work-with-agent') throw new Error(`MCP initialize 未返回服务信息：${text}`);
}

/** The stdio entry hosts spawn stays alive across API restarts: unreachable while down, recovered when back. */
function startProxy(credential) {
  const proxyProcess = spawn(nodeBinary, [resolve(serverDir, 'dist/mcp/index.js')], {
    cwd: serverDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, WWA_API_URL: origin, WWA_CONNECTION_TOKEN: credential },
  });
  const pending = new Map();
  let buffer = '';
  proxyProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch { /* 跳过非 JSON-RPC 输出。 */ }
    }
  });
  proxyProcess.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'wwa-smoke', version: '0.0.0' } },
  })}\n`);
  proxyProcess.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    call(request, timeoutMs = 30_000) {
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(new Error(`stdio 代理超时：${request.method}`));
        }, timeoutMs);
        pending.set(request.id, (message) => {
          clearTimeout(timer);
          resolvePromise(message);
        });
        proxyProcess.stdin.write(`${JSON.stringify(request)}\n`);
      });
    },
    stop() {
      proxyProcess.kill('SIGKILL');
    },
  };
}

function stop(process) {
  return new Promise((resolvePromise) => {
    process.once('exit', () => resolvePromise());
    process.stdin.end();
    setTimeout(() => process.kill('SIGKILL'), 5_000).unref();
  });
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const value = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePromise(value));
    });
  });
}

function expectClosed(value) {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`端口 ${value} 在服务退出后仍被占用`)));
    probe.listen(value, '127.0.0.1', () => probe.close(() => resolvePromise()));
  });
}
