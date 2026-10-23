import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { createOwnerBootstrapToken, mcpLoopbackHeaders, resetLoginRateLimiter, resetOwnerKeyCache, resolveOwnerKeyHash } from './application/security.js';

const previous = {
  serverMode: process.env.DOVUN_SERVER_MODE,
  ownerKey: process.env.DOVUN_OWNER_KEY,
  dataDir: process.env.DOVUN_DATA_DIR,
  clientOrigin: process.env.CLIENT_ORIGIN,
  publicUrl: process.env.DOVUN_PUBLIC_URL,
};

let dataDirectory = '';

beforeEach(() => {
  resetOwnerKeyCache();
  resetLoginRateLimiter();
});

afterEach(() => {
  restore('DOVUN_SERVER_MODE', previous.serverMode);
  restore('DOVUN_OWNER_KEY', previous.ownerKey);
  restore('DOVUN_DATA_DIR', previous.dataDir);
  restore('CLIENT_ORIGIN', previous.clientOrigin);
  restore('DOVUN_PUBLIC_URL', previous.publicUrl);
  resetOwnerKeyCache();
  resetLoginRateLimiter();
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function enableServerMode() {
  process.env.DOVUN_SERVER_MODE = '1';
  process.env.DOVUN_OWNER_KEY = 'test-owner-key-with-enough-length';
  process.env.DOVUN_PUBLIC_URL = 'https://wwa.example.com';
  process.env.CLIENT_ORIGIN = 'https://wwa.example.com';
}

describe('server info', () => {
  it('reports local mode and the package version', async () => {
    delete process.env.DOVUN_SERVER_MODE;
    const response = await supertest(app).get('/api/v1/server/info');
    expect(response.status).toBe(200);
    expect(response.body.data.mode).toBe('local');
    expect(typeof response.body.data.version).toBe('string');
  });

  it('reports server mode when enabled', async () => {
    process.env.DOVUN_SERVER_MODE = '1';
    const response = await supertest(app).get('/api/v1/server/info');
    expect(response.body.data.mode).toBe('server');
  });
});

describe('server mode origin checks', () => {
  it('accepts requests for the configured public host', async () => {
    enableServerMode();
    const response = await supertest(app).get('/api/v1/auth/session').set('Host', 'wwa.example.com');
    expect(response.status).toBe(200);
    expect(response.body.data.authenticated).toBe(false);
  });

  it('rejects requests for any other host even with a session cookie', async () => {
    enableServerMode();
    const login = await supertest(app).post('/api/v1/auth/session').set('Host', 'wwa.example.com').send({ ownerKey: process.env.DOVUN_OWNER_KEY });
    expect(login.status).toBe(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const response = await supertest(app).get('/api/v1/auth/session').set('Cookie', cookie);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('HOST_DENIED');
  });

  it('rejects every host while no public origin is configured', async () => {
    process.env.DOVUN_SERVER_MODE = '1';
    delete process.env.DOVUN_OWNER_KEY;
    delete process.env.DOVUN_PUBLIC_URL;
    process.env.CLIENT_ORIGIN = '';
    const response = await supertest(app).get('/api/v1/auth/session');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('HOST_DENIED');
  });

  it('accepts the MCP process calling the loopback API', async () => {
    enableServerMode();
    const response = await supertest(app).get('/api/v1/tasks').set(mcpLoopbackHeaders());
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });

  it('rejects a forged loopback header and a loopback header aimed at another host', async () => {
    enableServerMode();
    const forged = await supertest(app).get('/api/v1/tasks').set('x-dovun-loopback', 'a'.repeat(43));
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('HOST_DENIED');
    const otherHost = await supertest(app).get('/api/v1/tasks').set('Host', 'evil.example.com').set(mcpLoopbackHeaders());
    expect(otherHost.status).toBe(403);
    expect(otherHost.body.code).toBe('HOST_DENIED');
  });

  it('still rejects non-local hosts in local mode', async () => {
    delete process.env.DOVUN_SERVER_MODE;
    const response = await supertest(app).get('/api/v1/auth/session').set('Host', 'evil.example.com');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('HOST_DENIED');
  });
});

describe('server mode owner key login', () => {
  it('exchanges a valid owner key for a session with csrf', async () => {
    enableServerMode();
    const login = await supertest(app).post('/api/v1/auth/session').set('Host', 'wwa.example.com').send({ ownerKey: 'test-owner-key-with-enough-length' });
    expect(login.status).toBe(200);
    expect(login.body.data.authenticated).toBe(true);
    expect(typeof login.body.data.csrfToken).toBe('string');
    expect((login.headers['set-cookie'] as unknown as string[])[0].toLowerCase()).toContain('httponly');
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const session = await supertest(app).get('/api/v1/auth/session').set('Host', 'wwa.example.com').set('Cookie', cookie);
    expect(session.body.data.authenticated).toBe(true);
  });

  it('marks the session cookie secure behind https', async () => {
    enableServerMode();
    const login = await supertest(app).post('/api/v1/auth/session').set('Host', 'wwa.example.com').set('X-Forwarded-Proto', 'https').send({ ownerKey: process.env.DOVUN_OWNER_KEY });
    expect((login.headers['set-cookie'] as unknown as string[])[0]).toMatch(/Secure/i);
  });

  it('rejects a wrong owner key', async () => {
    enableServerMode();
    const login = await supertest(app).post('/api/v1/auth/session').set('Host', 'wwa.example.com').send({ ownerKey: 'wrong-owner-key-with-enough-length' });
    expect(login.status).toBe(401);
  });

  it('refuses one-use bootstrap tokens while in server mode', async () => {
    enableServerMode();
    const login = await supertest(app).post('/api/v1/auth/session').set('Host', 'wwa.example.com').send({ bootstrapToken: createOwnerBootstrapToken() });
    expect(login.status).toBe(401);
  });

  it('rate limits repeated failures', async () => {
    enableServerMode();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await supertest(app).post('/api/v1/auth/session').set('Host', 'wwa.example.com').send({ ownerKey: 'wrong-owner-key-with-enough-length' });
      expect(response.status).toBe(401);
    }
    const blocked = await supertest(app).post('/api/v1/auth/session').set('Host', 'wwa.example.com').send({ ownerKey: process.env.DOVUN_OWNER_KEY });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('LOGIN_RATE_LIMITED');
  });
});

describe('server mode owner key resolution', () => {
  it('generates the key file once and reuses it afterwards', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'wwa-server-key-'));
    process.env.DOVUN_SERVER_MODE = '1';
    process.env.DOVUN_DATA_DIR = dataDirectory;
    delete process.env.DOVUN_OWNER_KEY;
    try {
      const first = resolveOwnerKeyHash();
      expect(typeof first).toBe('string');
      const stored = (await readFile(join(dataDirectory, 'owner-key'), 'utf8')).trim();
      expect(stored.length).toBeGreaterThanOrEqual(20);
      resetOwnerKeyCache();
      expect(resolveOwnerKeyHash()).toBe(first);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it('refuses a configured key that is too short', async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'wwa-server-key-'));
    process.env.DOVUN_SERVER_MODE = '1';
    process.env.DOVUN_DATA_DIR = dataDirectory;
    process.env.DOVUN_OWNER_KEY = 'short';
    try {
      expect(() => resolveOwnerKeyHash()).toThrow(/DOVUN_OWNER_KEY/);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it('returns null outside server mode', () => {
    delete process.env.DOVUN_SERVER_MODE;
    expect(resolveOwnerKeyHash()).toBeNull();
  });
});

describe('server mode connection configuration', () => {
  it('points MCP tooling at the public workspace url', async () => {
    enableServerMode();
    const { connectionConfiguration } = await import('./application/security.js');
    const config = connectionConfiguration('secret');
    expect(config.env.DOVUN_API_URL).toBe('https://wwa.example.com');
    expect(config.url).toBe('https://wwa.example.com/mcp');
  });
});
