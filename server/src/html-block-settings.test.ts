import { afterEach, describe, expect, it } from 'vitest';
import request from './test-auth.js';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import { DEFAULT_HTML_CDN } from './agent/html-block.js';
import { htmlBlockPolicy } from './application/html-block-settings.js';
describe('interactive html block settings', () => {
  afterEach(async () => { await request(app).patch('/api/settings/html-blocks').send({ enabled: true, cdn: DEFAULT_HTML_CDN }); });
  it('defaults to on with jsDelivr, cdnjs and unpkg', async () => {
    const settings = await request(app).get('/api/settings/html-blocks');
    expect(settings.status).toBe(200);
    expect(settings.body.data).toEqual({ enabled: true, cdn: DEFAULT_HTML_CDN, defaults: DEFAULT_HTML_CDN });
  });
  it('saves the switch and a normalized, de-duplicated allowlist that the agent policy then uses', async () => {
    const saved = await request(app).patch('/api/settings/html-blocks').send({ enabled: false, cdn: ['https://cdn.jsdelivr.net/', 'https://cdn.jsdelivr.net', 'http://127.0.0.1:4100'] });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ enabled: false, cdn: ['https://cdn.jsdelivr.net', 'http://127.0.0.1:4100'] });
    await expect(htmlBlockPolicy()).resolves.toEqual({ enabled: false, cdn: ['https://cdn.jsdelivr.net', 'http://127.0.0.1:4100'] });
  });
  it('rejects entries that are not bare origins and leaves the saved list alone', async () => {
    for (const cdn of [['http://cdn.example.com'], ['https://cdn.example.com/npm'], ['*'], ["https://a.example 'unsafe-eval'"]]) {
      const response = await request(app).patch('/api/settings/html-blocks').send({ cdn });
      expect(response.status, cdn[0]).toBe(400);
    }
    expect((await request(app).patch('/api/settings/html-blocks').send({ sandbox: 'allow-same-origin' })).status).toBe(400);
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { id: 'default' } })).htmlCdnAllowlist).toBe(JSON.stringify(DEFAULT_HTML_CDN));
  });
});
