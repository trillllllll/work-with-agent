import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'dovun-sync-http-'));
type Peer = { child: ChildProcess; port: number; cookie: string; csrf: string; request: (path: string, body?: object, method?: string) => Promise<{ status: number; data: any; code?: string }> };
const children = new Set<ChildProcess>();

async function start(name: string, port = 0): Promise<Peer> {
  const data = join(directory, name);
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: `file:${join(data, 'test.db')}`, DOVUN_DATA_DIR: data, DOVUN_SERVER_MODE: '0', SYNC_TEST_PORT: String(port) };
  delete env.VITEST; delete env.DOVUN_SYNC_URL; delete env.DOVUN_SYNC_TOKEN; delete env.DOVUN_CONTAINER;
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/sync-process.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.once('exit', () => children.delete(child));
  const ready = await new Promise<{ port: number; bootstrap: string }>((accept, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Sync fixture startup timed out')); }, 20_000);
    child.stdout!.on('data', chunk => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        try { const row = JSON.parse(line); if (row.port && row.bootstrap) { clearTimeout(timer); accept(row); } } catch { /* Ignore unrelated startup text. */ }
      }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Sync fixture exited before startup')); });
    child.once('error', reject);
    // Consume stderr without exposing tokens or body contents in test output.
    child.stderr!.resume();
  });
  const url = `http://127.0.0.1:${ready.port}`;
  const login = await fetch(`${url}/api/v1/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrapToken: ready.bootstrap }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const csrf = (await login.json()).data.csrfToken;
  return { child, port: ready.port, cookie, csrf, request: async (path, body, method) => {
    const response = await fetch(url + path, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const payload = await response.json();
    return { status: response.status, data: payload.data, code: payload.code };
  } };
}
async function stop(peer: Peer) {
  if (peer.child.exitCode !== null) return;
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => { peer.child.kill('SIGKILL'); reject(new Error('Sync fixture did not stop')); }, 5_000);
    peer.child.once('exit', () => { clearTimeout(timer); children.delete(peer.child); accept(); });
    peer.child.kill('SIGTERM');
  });
}

describe('task sync across independent HTTP processes', () => {
  beforeAll(() => {
    for (const name of ['hub', 'local']) {
      const data = join(directory, name); mkdirSync(data);
      writeFileSync(join(data, 'test.db'), '');
      execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { cwd: root, env: { ...process.env, DATABASE_URL: `file:${join(data, 'test.db')}` }, stdio: 'pipe' });
    }
  }, 30_000);
  afterAll(async () => {
    for (const child of children) { if (child.exitCode !== null) continue; child.kill('SIGKILL'); await new Promise<void>(accept => child.once('exit', () => accept())); }
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps an offline edit through restart, automatically catches up, and resolves cloud conflicts locally', async () => {
    let hub = await start('hub');
    let local = await start('local');
    const cloudTask = await hub.request('/api/tasks', { title: '云端起始任务' });
    expect(cloudTask.status).toBe(200);
    const taskId = cloudTask.data.id;
    const pairing = await hub.request('/api/v1/sync/devices', { name: 'http-fixture' });
    const binding = { url: `http://127.0.0.1:${hub.port}`, token: pairing.data.token };
    // A rejected first credential must not leave an irreparable binding behind.
    expect(await local.request('/api/v1/sync/bind', { ...binding, token: 'invalid-token-that-is-long-enough' })).toMatchObject({ status: 502, code: 'SYNC_AUTH_FAILED' });
    expect(existsSync(join(directory, 'local', 'sync-device.json'))).toBe(false);
    expect((await local.request('/api/v1/sync/bind', binding)).status).toBe(200);
    expect((await local.request('/api/v1/sync/run', {})).status).toBe(200);
    expect((await local.request(`/api/tasks/${taskId}`)).data.title).toBe('云端起始任务');

    const hubPort = hub.port;
    await stop(hub);
    const before = (await local.request(`/api/tasks/${taskId}`)).data;
    expect((await local.request(`/api/tasks/${taskId}`, { description: '断网时的修改，重启后必须还在', expectedRevision: before.revision }, 'PATCH')).status).toBe(200);
    expect((await local.request('/api/v1/sync/run', {})).status).not.toBe(200);
    expect((await local.request('/api/v1/sync/status')).data.pending).toBeGreaterThan(0);
    await stop(local);
    local = await start('local');
    expect((await local.request(`/api/tasks/${taskId}`)).data.description).toBe('断网时的修改，重启后必须还在');
    expect((await local.request('/api/v1/sync/status')).data.pending).toBeGreaterThan(0);
    hub = await start('hub', hubPort);
    await expect.poll(async () => (await hub.request(`/api/tasks/${taskId}`)).data.description, { timeout: 12_000, interval: 200 }).toBe('断网时的修改，重启后必须还在');
    expect((await local.request('/api/v1/sync/status')).data.pending).toBe(0);

    const cloudBefore = (await hub.request(`/api/tasks/${taskId}`)).data;
    const localBefore = (await local.request(`/api/tasks/${taskId}`)).data;
    await stop(hub);
    expect((await local.request(`/api/tasks/${taskId}`, { title: '本机离线标题', expectedRevision: localBefore.revision }, 'PATCH')).status).toBe(200);
    hub = await start('hub', hubPort);
    expect((await hub.request(`/api/tasks/${taskId}`, { title: '云端独立标题', expectedRevision: cloudBefore.revision }, 'PATCH')).status).toBe(200);
    expect((await local.request('/api/v1/sync/run', {})).status).toBe(200);
    const conflicts = await local.request('/api/v1/sync/conflicts');
    const conflict = conflicts.data.find((item: any) => item.entityId === taskId && item.field === 'title');
    expect(conflict).toMatchObject({ incoming: '本机离线标题', live: '云端独立标题' });
    expect((await local.request(`/api/v1/sync/conflicts/${conflict.id}/resolve`, { choice: 'mine' })).status).toBe(200);
    await local.request('/api/v1/sync/run', {});
    expect((await local.request(`/api/tasks/${taskId}`)).data.title).toBe('本机离线标题');
    expect((await hub.request(`/api/tasks/${taskId}`)).data.title).toBe('本机离线标题');
    await stop(local); await stop(hub);
  }, 60_000);
});
