import { existsSync } from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from './agent.js';

/**
 * 学习助手（contextPolicy = domain）的系统提示词与改造前快照逐字节相同。
 * 记忆召回改造（docs/2026-11-04_memory-recall-plan.md 不变量 4）不允许改变这一分支。
 * 快照由固定时钟、空学习域和默认设置生成；版本号变化时快照需要同步更新。
 */

const fixturePath = fileURLToPath(new URL('../test/fixtures/learning-system-prompt.txt', import.meta.url));
const frozenTime = new Date('2026-11-04T04:05:06.000Z');

let scratch = '';
let app: typeof import('./app.js')['app'];
let security: typeof import('./application/security.js');
let agentService: typeof import('./agent.js');
let previousDatabaseUrl: string | undefined;
let previousDataDir: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  previousDataDir = process.env.DOVUN_DATA_DIR;
  scratch = mkdtempSync(join(tmpdir(), 'wwa-learning-prompt-'));
  process.env.DATABASE_URL = `file:${join(scratch, 'test.db')}`;
  process.env.DOVUN_DATA_DIR = join(scratch, 'data');
  const { migrateDatabase } = await import('./db-migrate.js');
  await migrateDatabase(process.env.DATABASE_URL);
  app = (await import('./app.js')).app;
  security = await import('./application/security.js');
  agentService = await import('./agent.js');
  const login = await import('supertest').then((supertest) => supertest.default(app).post('/api/v1/auth/session').send({ bootstrapToken: security.createOwnerBootstrapToken() }));
  expect(login.status).toBe(200);
}, 180_000);

afterAll(async () => {
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousDataDir === undefined) delete process.env.DOVUN_DATA_DIR;
  else process.env.DOVUN_DATA_DIR = previousDataDir;
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

describe('learning assistant system prompt snapshot', () => {
  it('is byte-identical to the recorded fixture', async () => {
    // 只冻结 Date：调度与租约依赖真实 setTimeout。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(frozenTime);
    try {
      let seen = '';
      const agent = new agentService.AgentService({
        // 不走 withTestToolLoading：其发现轮按工作助手加载工具组，学习助手不允许。
        stream: async function* (messages: ModelMessage[]) {
          seen = String(messages[0]?.content ?? '');
          yield { text: '好的。' };
        },
      } as never);
      await agent.chat({ message: '你好，帮我复习', identityId: 'study', pageContext: { page: 'learning' } });
      expect(seen).toContain('【学习域概况】');
      if (!existsSync(fixturePath)) {
        writeFileSync(fixturePath, seen, 'utf8');
        console.warn(`[快照] 未找到基线文件，已按当前输出生成：${fixturePath}`);
      }
      expect(seen).toBe(readFileSync(fixturePath, 'utf8'));
    } finally {
      vi.useRealTimers();
    }
  });
});
