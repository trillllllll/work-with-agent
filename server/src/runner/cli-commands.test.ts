import request from '../test-auth.js';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { prisma } from '../services.js';
import { absoluteExecutable } from './cli-commands.js';

describe('local CLI commands', () => {
  afterAll(async () => { await prisma.appSetting.deleteMany(); });

  it('rejects a relative command path', () => {
    expect(() => absoluteExecutable('codex')).toThrow(/绝对路径/);
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
