import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';


const root = resolve(import.meta.dirname, '..');
const resources = resolve(root, 'desktop/resources');
const nodeBinary = resolve(resources, 'node');
const serverDir = resolve(resources, 'server');
const dataDir = await mkdtemp(resolve(tmpdir(), 'wwa-desktop-smoke-'));
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;

let child;
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
  await stop(child);
  child = undefined;
  await expectClosed(port);

  child = start();
  const secondToken = await readyToken(child);
  const second = await login(secondToken);
  const tasks = await api(second, '/api/tasks?inbox=true');
  const body = await tasks.json();
  if (!tasks.ok || !body.data?.some((task) => task.title === '桌面冒烟任务')) throw new Error('重启后没有读到冒烟任务');
  await stop(child);
  child = undefined;
  console.log(`桌面运行时冒烟通过，端口 ${port}`);
} finally {
  if (child) child.kill('SIGKILL');
  await rm(dataDir, { recursive: true, force: true });
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
