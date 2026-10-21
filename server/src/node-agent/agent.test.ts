import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeAgent, type NodeRunner } from './agent.js';
import { markConfigRevoked, readPackageVersion, refuseRevokedStart } from './index.js';

const TOKEN = 'node-token-VERY-SECRET';
const SERVER = 'http://127.0.0.1:9';

function lease(data: Record<string, unknown>, status = 200) {
  if (status === 200) return Response.json({ data });
  return Response.json(data, { status });
}

function runnerFake() {
  const cancelled: string[] = [];
  const ended = new Set<string>();
  const runner: NodeRunner = {
    async requestCancel(id) { cancelled.push(id); ended.add(id); },
    async readReceipt(id) { return ended.has(id) ? { state: 'ended' } : { state: 'running' }; },
  };
  return { runner, cancelled };
}

async function seed(dir: string, id: string, state: string, kind = 'run', report?: unknown) {
  await mkdir(join(dir, 'jobs'), { recursive: true });
  await writeFile(join(dir, 'jobs', `${id}.json`), JSON.stringify({
    job: { id, kind, phase: 'work', leaseToken: '0123456789abcdef', payload: {} },
    state,
    ...(report === undefined ? {} : { report }),
  }));
}

async function journal(dir: string, id: string) {
  return JSON.parse(await readFile(join(dir, 'jobs', `${id}.json`), 'utf8')) as { state: string };
}

describe('wwa-node revocation and heartbeat', () => {
  const previous = {
    runner: process.env.WWA_RUNNER_DIR,
    codex: process.env.WWA_CODEX_BIN,
    claude: process.env.WWA_CLAUDE_BIN,
    gh: process.env.WWA_GH_BIN,
    managed: process.env.WWA_NODE_MANAGED,
    log: process.env.WWA_NODE_LOG,
    version: process.env.WWA_NODE_VERSION,
  };
  const errors: string[] = [];
  let spy: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    spy?.mockRestore();
    spy = null;
    const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    restore('WWA_RUNNER_DIR', previous.runner);
    restore('WWA_CODEX_BIN', previous.codex);
    restore('WWA_CLAUDE_BIN', previous.claude);
    restore('WWA_GH_BIN', previous.gh);
    restore('WWA_NODE_MANAGED', previous.managed);
    restore('WWA_NODE_LOG', previous.log);
    restore('WWA_NODE_VERSION', previous.version);
  });

  async function temp() {
    errors.length = 0;
    spy?.mockRestore();
    spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const dir = await mkdtemp(join(tmpdir(), 'wwa-node-agent-'));
    process.env.WWA_CODEX_BIN = join(dir, 'missing-codex');
    process.env.WWA_CLAUDE_BIN = join(dir, 'missing-claude');
    process.env.WWA_GH_BIN = join(dir, 'missing-gh');
    delete process.env.WWA_NODE_MANAGED;
    delete process.env.WWA_NODE_LOG;
    return dir;
  }

  it('cancels unfinished runs, stops reporting, and exits 3 on NODE_REVOKED', async () => {
    const dir = await temp();
    try {
      await seed(dir, 'job-run', 'running', 'run');
      await seed(dir, 'job-probe', 'running', 'probe');
      await seed(dir, 'job-done', 'reported', 'run');
      const urls: string[] = [];
      const exits: number[] = [];
      const { runner, cancelled } = runnerFake();
      const http: typeof fetch = async (input) => {
        urls.push(String(input));
        return lease({ code: 'NODE_REVOKED', error: '电脑已断开' }, 401);
      };
      const agent = new NodeAgent({ server: SERVER, token: TOKEN, roots: [dir], dataDir: dir, pollMs: 20 }, http, { exit: (code) => { exits.push(code); }, runner });
      await expect(agent.pollOnce()).rejects.toThrow(/401 NODE_REVOKED/);
      expect(exits).toEqual([3]);
      expect(cancelled).toEqual(['job-run']);
      expect(urls.some((url) => url.includes('/result'))).toBe(false);
      expect(errors.some((line) => line.includes('这台电脑已在 WWA 里被断开/吊销'))).toBe(true);
      expect((await journal(dir, 'job-run')).state).toBe('abandoned');
      expect((await journal(dir, 'job-probe')).state).toBe('abandoned');
      expect((await journal(dir, 'job-done')).state).toBe('reported');
      expect(await agent.pollOnce()).toBe(0);
      await agent.resume();

      const again: string[] = [];
      let active: unknown = 'missing';
      const next = new NodeAgent({ server: SERVER, token: TOKEN, roots: [dir], dataDir: dir, pollMs: 20 }, async (input, init) => {
        again.push(String(input));
        active = JSON.parse(String(init?.body)).activeJobIds;
        return lease({ jobs: [], cancel: [], accepts: [] });
      }, { exit: () => { throw new Error('should not exit'); }, runner: runnerFake().runner });
      await next.resume();
      await next.pollOnce();
      expect(again.some((url) => url.includes('/result'))).toBe(false);
      expect(active).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('shuts down when a result retry receives NODE_TOKEN_INVALID and does not report again', async () => {
    const dir = await temp();
    try {
      await seed(dir, 'job-run', 'pending_report', 'run', { ok: true, result: { done: true } });
      const urls: string[] = [];
      const exits: number[] = [];
      const order: string[] = [];
      const { runner, cancelled } = runnerFake();
      const configPath = join(dir, 'config.json');
      await writeFile(configPath, JSON.stringify({ server: SERVER, token: TOKEN, roots: [dir], maxConcurrent: 2, note: 'keep' }, null, 2));
      const http: typeof fetch = async (input) => {
        urls.push(String(input));
        return lease({ code: 'NODE_TOKEN_INVALID', error: '电脑凭据无效' }, 401);
      };
      const agent = new NodeAgent({ server: SERVER, token: TOKEN, roots: [dir], dataDir: dir, pollMs: 20 }, http, {
        exit: (code) => { order.push('exit'); exits.push(code); },
        runner,
        onRevoked: async () => { order.push('mark'); await markConfigRevoked(configPath); },
      });
      await agent.resume();
      await agent.idle();
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('/result');
      expect(exits).toEqual([3]);
      expect(order).toEqual(['mark', 'exit']);
      expect(cancelled).toEqual(['job-run']);
      expect((await journal(dir, 'job-run')).state).toBe('abandoned');
      const saved = JSON.parse(await readFile(configPath, 'utf8')) as { token: string; note: string; revokedAt: string; roots: string[] };
      expect(saved.token).toBe(TOKEN);
      expect(saved.note).toBe('keep');
      expect(saved.roots).toEqual([dir]);
      expect(saved.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('retries a bare 401 and a 401 without a revocation code', async () => {
    const dir = await temp();
    try {
      const exits: number[] = [];
      const seen: string[] = [];
      let agent!: NodeAgent;
      const http: typeof fetch = async () => {
        seen.push('call');
        if (seen.length === 1) return new Response('<html>gateway timeout</html>', { status: 401 });
        if (seen.length === 2) return Response.json({ error: 'unauthorized' }, { status: 401 });
        if (seen.length === 3) return Response.json({ code: 'AUTH_REQUIRED', error: '需要登录' }, { status: 401 });
        agent.stop();
        return lease({ jobs: [], cancel: [], accepts: [] });
      };
      agent = new NodeAgent({ server: SERVER, token: TOKEN, roots: [dir], dataDir: dir, pollMs: 10 }, http, { exit: (code) => { exits.push(code); } });
      await agent.run();
      expect(exits).toEqual([]);
      expect(seen).toHaveLength(4);
      expect(errors.some((line) => line.includes('拉取失败'))).toBe(true);
      expect(errors.some((line) => line.includes('被断开/吊销'))).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('omits caps_v2 fields until a lease accepts them, then sends path, managedBy, logPath, lastError and startedAt', async () => {
    const dir = await temp();
    try {
      const cli = join(dir, 'codex.js');
      await writeFile(cli, 'console.log("codex 1.2.3\\n")\n');
      process.env.WWA_CODEX_BIN = cli;
      process.env.WWA_NODE_MANAGED = 'desktop';
      process.env.WWA_NODE_LOG = join(dir, 'logs', 'node.log');
      const bodies: Array<Record<string, unknown>> = [];
      let step = 0;
      const http: typeof fetch = async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        step += 1;
        if (step === 1) return lease({ code: `${TOKEN}${'x'.repeat(600)}` }, 500);
        return lease({ jobs: [], cancel: [], accepts: ['usage_v1', 'caps_v2'], nodeId: '' });
      };
      const agent = new NodeAgent({ server: SERVER, token: TOKEN, roots: [dir], dataDir: dir, version: '0.2.5' }, http, { exit: () => { throw new Error('should not exit'); } });
      await expect(agent.pollOnce()).rejects.toThrow(/500/);
      await agent.pollOnce();
      await agent.pollOnce();
      const caps = (index: number) => bodies[index].capabilities as Record<string, unknown>;
      for (const index of [0, 1]) {
        expect(caps(index)).not.toHaveProperty('managedBy');
        expect(caps(index)).not.toHaveProperty('logPath');
        expect(caps(index)).not.toHaveProperty('lastError');
        expect(caps(index)).not.toHaveProperty('startedAt');
        expect((caps(index).providers as Array<Record<string, unknown>>)[0]).not.toHaveProperty('path');
      }
      expect(caps(2).managedBy).toBe('desktop');
      expect(caps(2).logPath).toBe(join(dir, 'logs', 'node.log'));
      expect(caps(2).startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const lastError = String(caps(2).lastError);
      expect(lastError.includes(TOKEN)).toBe(false);
      expect(lastError.length).toBeLessThanOrEqual(500);
      expect(lastError.includes('x')).toBe(true);
      const providers = caps(2).providers as Array<{ provider: string; path: string; version: string }>;
      expect(providers.find((item) => item.provider === 'codex')).toMatchObject({ path: resolve(cli), version: 'codex 1.2.3', available: true });
      expect(providers.find((item) => item.provider === 'claude')).toMatchObject({ path: '', available: false });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('writes state.json from the lease nodeId and does not write config.json', async () => {
    const dir = await temp();
    try {
      let calls = 0;
      const http: typeof fetch = async () => {
        calls += 1;
        if (calls === 1) return lease({ jobs: [], cancel: [], accepts: ['usage_v1'] });
        return lease({ jobs: [], cancel: [], accepts: ['caps_v2'], nodeId: 'node-42' });
      };
      const agent = new NodeAgent({ server: SERVER, token: TOKEN, roots: [dir], dataDir: dir }, http, { exit: () => { throw new Error('should not exit'); } });
      await agent.pollOnce();
      await expect(readFile(join(dir, 'state.json'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(dir, 'config.json'), 'utf8')).rejects.toThrow();
      await agent.pollOnce();
      const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { nodeId: string; server: string; updatedAt: string };
      expect(state).toMatchObject({ nodeId: 'node-42', server: SERVER });
      expect(state.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect((await stat(join(dir, 'state.json'))).mode & 0o777).toBe(0o600);
      await expect(readFile(join(dir, 'config.json'), 'utf8')).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('exits 3 on the next start when revokedAt matches the same token, without calling the server', async () => {
    const dir = await temp();
    try {
      const configPath = join(dir, 'config.json');
      await writeFile(configPath, JSON.stringify({ server: SERVER, token: TOKEN, roots: ['/code'], maxConcurrent: 2 }, null, 2));
      await markConfigRevoked(configPath);
      const saved = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      expect(saved.server).toBe(SERVER);
      expect(saved.roots).toEqual(['/code']);
      expect(saved.maxConcurrent).toBe(2);
      expect(typeof saved.revokedAt).toBe('string');
      const exits: number[] = [];
      const stopped = refuseRevokedStart(saved, TOKEN, (code) => { exits.push(code); });
      expect(stopped).toBe(true);
      expect(exits).toEqual([3]);
      expect(errors.some((line) => line.includes('已被吊销，请在 WWA 里重新生成连接命令'))).toBe(true);
      expect(refuseRevokedStart(saved, 'a-different-token', () => { throw new Error('should not exit'); })).toBe(false);
      expect(refuseRevokedStart({ token: TOKEN, server: SERVER }, TOKEN, () => { throw new Error('should not exit'); })).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('signal shutdown cancels runs and abandons journals without exiting 3', async () => {
    const dir = await temp();
    try {
      await seed(dir, 'job-run', 'running');
      const exits: number[] = [];
      const { runner, cancelled } = runnerFake();
      const agent = new NodeAgent({ server: SERVER, token: TOKEN, roots: [dir], dataDir: dir }, async () => {
        throw new Error('signal shutdown must not call the server');
      }, { exit: (code) => { exits.push(code); }, runner });
      await agent.shutdown('signal');
      expect(exits).toEqual([]);
      expect(cancelled).toEqual(['job-run']);
      expect((await journal(dir, 'job-run')).state).toBe('abandoned');
      expect(await agent.pollOnce()).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reads the root package version and lets WWA_NODE_VERSION override it', async () => {
    const dir = await temp();
    try {
      delete process.env.WWA_NODE_VERSION;
      const expected = JSON.parse(await readFile(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')).version as string;
      expect(await readPackageVersion()).toBe(expected);
      process.env.WWA_NODE_VERSION = '   ';
      expect(await readPackageVersion()).toBe(expected);
      process.env.WWA_NODE_VERSION = '9.9.9-desktop';
      expect(await readPackageVersion()).toBe('9.9.9-desktop');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
