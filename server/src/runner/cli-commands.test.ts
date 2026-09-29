import request from '../test-auth.js';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { prisma } from '../services.js';
import { absoluteExecutable, windowsDiscoveredPath } from './cli-commands.js';

describe('local CLI commands', () => {
  afterAll(async () => { await prisma.appSetting.deleteMany(); });

  it('rejects a relative command path', () => {
    expect(() => absoluteExecutable('codex')).toThrow(/绝对路径/);
  });

  it('resolves the real npm entry point instead of the Windows POSIX shim', async () => {
    const shim = 'D:\\Program Files\\nodejs\\codex';
    const existing = new Set([
      'D:\\Program Files\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js',
      'D:\\Program Files\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    ]);
    const exists = async (path: string) => existing.has(path);
    await expect(windowsDiscoveredPath('codex', shim, exists)).resolves.toBe('D:\\Program Files\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js');
    await expect(windowsDiscoveredPath('claude', 'D:\\Program Files\\nodejs\\claude', exists)).resolves.toBe('D:\\Program Files\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
  });

  it('keeps a manual command when automatic discovery finds another path', async () => {
    const saved = await request(app).put('/api/settings/cli').send({ provider: 'codex', command: process.execPath });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ source: 'manual', command: process.execPath });
    expect(saved.body.data.version.length).toBeGreaterThan(0);

    const discovered = await request(app).post('/api/settings/cli/discover').send({});
    expect(discovered.status).toBe(200);
    expect(discovered.body.data.cli.codex.source).toBe('manual');
    expect(discovered.body.data.cli.codex.manualCommand).toBe(process.execPath);
    expect(discovered.body.data.cli.codex.command).toBe(process.execPath);

    const restored = await request(app).delete('/api/settings/cli/codex');
    expect(restored.status).toBe(200);
    expect(restored.body.data.source).not.toBe('manual');
  });
});
