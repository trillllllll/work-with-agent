import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';


const root = resolve(import.meta.dirname, '..');
const resources = resolve(root, 'desktop/resources');
const nodeBinary = resolve(resources, 'node.exe');
const serverDir = resolve(resources, 'server');
const expectedVersion = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
const dataDir = await mkdtemp(resolve(tmpdir(), 'wwa-desktop-smoke-'));
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
let remoteData;

let child;
let proxy;
try {
  // Exercise the assembled dependency graph, which may differ from the workspace's node_modules.
  const sanitizerUrl = pathToFileURL(resolve(serverDir, 'dist/agent/svg-sanitize.js')).href;
  execFileSync(nodeBinary, ['--input-type=module', '-e', `
    import { sanitizeSvg } from ${JSON.stringify(sanitizerUrl)};
    if (!sanitizeSvg('<svg><text>桌面 SVG</text></svg>').includes('桌面 SVG')) process.exit(1);
    let rejected = false;
    try { sanitizeSvg('<svg><g></svg>'); } catch { rejected = true; }
    if (!rejected) throw new Error('打包 XML 依赖未严格拒绝格式错误的 SVG');
  `], { cwd: serverDir, stdio: 'pipe' });
  child = start();
  const firstToken = await readyToken(child);
  const page = await fetch(`${origin}/`);
  if (!page.ok || !(await page.text()).includes('<title>')) throw new Error(`页面没有从打包服务返回（${page.status}）`);
  const anonymous = await fetch(`${origin}/api/v1/auth/session`);
  if (!anonymous.ok) throw new Error(`会话接口不可用（${anonymous.status}）`);
  const mcp = await fetch(`${origin}/mcp`, { method: 'POST' });
  if (mcp.status !== 401) throw new Error(`未授权的 MCP 请求应被拒绝，实际是 ${mcp.status}`);
  const localInfo = await (await fetch(`${origin}/api/v1/server/info`)).json();
  if (localInfo.data?.version !== expectedVersion) throw new Error(`桌面运行时版本不一致：${localInfo.data?.version}，期望 ${expectedVersion}`);
  const first = await login({ bootstrapToken: firstToken });
  const imageSettings = await api(first, '/api/settings/image-search');
  const imageConfig = (await imageSettings.json()).data;
  if (!imageSettings.ok || imageConfig?.provider !== 'brave') throw new Error('桌面运行时没有提供 Brave 图片搜索设置');
  if (imageConfig.managedBy !== 'environment') {
    const testKey = 'desktop-smoke-brave-test-key-9876';
    const savedImageKey = await api(first, '/api/settings/image-search', { method: 'PATCH', body: JSON.stringify({ apiKey: testKey }) });
    const savedImageBody = await savedImageKey.text();
    if (!savedImageKey.ok || savedImageBody.includes(testKey) || !JSON.parse(savedImageBody).data.configured) throw new Error('桌面运行时保存图片密钥失败或返回了明文');
    const clearedImageKey = await api(first, '/api/settings/image-search', { method: 'DELETE' });
    if (!clearedImageKey.ok || (await clearedImageKey.json()).data.configured) throw new Error('桌面运行时未能清除图片密钥');
  }
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
  const second = await login({ bootstrapToken: secondToken });
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

  // —— 服务器模式：桌面壳远程探测的同一接口与凭据流。 ——
  const remotePort = await freePort();
  const remoteOrigin = `http://127.0.0.1:${remotePort}`;
  const ownerKey = 'smoke-owner-key-0123456789abcdef';
  remoteData = await mkdtemp(resolve(tmpdir(), 'wwa-desktop-smoke-server-'));
  child = start({
    PORT: String(remotePort),
    CLIENT_ORIGIN: remoteOrigin,
    DOVUN_PUBLIC_URL: remoteOrigin,
    DOVUN_DATA_DIR: remoteData,
    DATABASE_URL: `file:${resolve(remoteData, 'agent-studio.db')}`,
    KNOWLEDGE_STORAGE_ROOT: resolve(remoteData, 'knowledge-blobs'),
    DOVUN_RUNNER_DIR: resolve(remoteData, 'runner'),
    AGENT_WORKSPACE_ROOT: resolve(remoteData, 'workspace'),
    DOVUN_SERVER_MODE: '1',
    DOVUN_BIND_HOST: '127.0.0.1',
    DOVUN_OWNER_KEY: ownerKey,
  });
  const banner = await waitLine(child, 'API listening');
  if (/owner-token=/.test(banner)) throw new Error('服务器模式不应在日志里打印一次性启动凭据');
  const info = await (await fetch(`${remoteOrigin}/api/v1/server/info`)).json();
  if (info.data?.mode !== 'server' || info.data?.version !== expectedVersion) throw new Error(`服务器模式探测失败：${JSON.stringify(info)}`);
  const bootstrap = await login({ bootstrapToken: 'anything' }, remoteOrigin).then(() => 'ok', (error) => error.message);
  if (bootstrap === 'ok') throw new Error('服务器模式下一次性启动凭据应被禁用');
  const rejected = await fetch(`${remoteOrigin}/api/v1/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: remoteOrigin },
    body: JSON.stringify({ ownerKey: 'wrong-owner-key-0123456789' }),
  });
  if (rejected.status !== 401) throw new Error(`错误访问密钥应返回 401，实际 ${rejected.status}`);
  const remote = await login({ ownerKey }, remoteOrigin);
  const remoteTask = await api(remote, '/api/tasks', { method: 'POST', body: JSON.stringify({ title: '服务器模式冒烟任务' }) }, remoteOrigin);
  if (!remoteTask.ok) throw new Error(`服务器模式创建任务失败：${remoteTask.status} ${await remoteTask.text()}`);
  await stop(child);
  child = undefined;
  console.log(`服务器模式冒烟通过，端口 ${remotePort}（owner key 登录，bootstrap 凭据禁用）`);
} finally {
  if (proxy) proxy.stop();
  if (child) child.kill('SIGKILL');
  await cleanup(dataDir);
  if (remoteData) await cleanup(remoteData);
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

function start(overrides = {}) {
  return spawn(nodeBinary, [resolve(serverDir, 'dist/index.js')], {
    cwd: serverDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DOVUN_PACKAGED: '1',
      PORT: String(port),
      CLIENT_ORIGIN: origin,
      DOVUN_DATA_DIR: dataDir,
      DOVUN_STATIC_DIR: resolve(resources, 'client'),
      DATABASE_URL: `file:${resolve(dataDir, 'agent-studio.db')}`,
      KNOWLEDGE_STORAGE_ROOT: resolve(dataDir, 'knowledge-blobs'),
      DOVUN_RUNNER_DIR: resolve(dataDir, 'runner'),
      AGENT_WORKSPACE_ROOT: resolve(dataDir, 'workspace'),
      ...overrides,
    },
  });
}

/** Resolves with the output seen so far once a matching line appears. */
function waitLine(process, pattern) {
  return new Promise((resolvePromise, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`等待 ${pattern} 超时`)), 60_000);
    const check = () => {
      if (buffer.includes(pattern)) {
        clearTimeout(timer);
        process.stderr.removeAllListeners('data');
        process.stdout.removeAllListeners('data');
        resolvePromise(buffer);
      }
    };
    process.once('exit', (code) => { clearTimeout(timer); reject(new Error(`服务在 ${pattern} 前退出（${code}）\n${buffer}`)); });
    process.stderr.on('data', (chunk) => { buffer += chunk.toString(); check(); });
    process.stdout.on('data', (chunk) => { buffer += chunk.toString(); check(); });
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

async function login(credential, at = origin) {
  const response = await fetch(`${at}/api/v1/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: at },
    body: JSON.stringify(credential),
  });
  if (!response.ok) throw new Error(`登录失败：${response.status} ${await response.text()}`);
  const cookie = response.headers.getSetCookie?.().map((item) => item.split(';')[0]).join('; ')
    ?? (response.headers.get('set-cookie') ?? '').split(',').map((item) => item.split(';')[0]).join('; ');
  const csrf = (await response.json()).data.csrfToken;
  return { cookie, csrf };
}

function api(session, path, init = {}, at = origin) {
  return fetch(`${at}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', origin: at, cookie: session.cookie, 'x-csrf-token': session.csrf, ...init.headers },
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
  if (payload.result?.serverInfo?.name !== 'dovun') throw new Error(`MCP initialize 未返回服务信息：${text}`);
}

/** The stdio entry hosts spawn stays alive across API restarts: unreachable while down, recovered when back. */
function startProxy(credential) {
  const proxyProcess = spawn(nodeBinary, [resolve(serverDir, 'dist/mcp/index.js')], {
    cwd: serverDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DOVUN_API_URL: origin, DOVUN_CONNECTION_TOKEN: credential },
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
