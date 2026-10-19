import { defineConfig, devices } from '@playwright/test';
import { createHash } from 'node:crypto';

/**
 * Browser E2E for the orchestration flow: real server, real wwa-node process, stub Codex CLI, mock model.
 * Runs on its own ports and database so it can share a machine with the main suite and other jobs:
 *   E2E_API_PORT (3415), E2E_WEB_PORT (5475), MOCK_OPENAI_PORT (4410).
 * Chromium only, one worker, to keep memory use modest.
 */
const root = process.cwd();
const apiPort = process.env.E2E_API_PORT ?? '3415';
const webPort = process.env.E2E_WEB_PORT ?? '5475';
const mockPort = process.env.MOCK_OPENAI_PORT ?? '4410';
const databaseFile = 'orchestration-e2e.db';
process.env.E2E_API_PORT = apiPort;
process.env.E2E_WEB_PORT = webPort;
process.env.MOCK_OPENAI_PORT = mockPort;
process.env.E2E_DATABASE_URL = `file:../../e2e/.data/${databaseFile}`;
const web = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /orchestration\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line']] : 'list',
  use: {
    baseURL: web,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    storageState: { cookies: [{ name: 'wwa_session', value: 'wwa-e2e-owner-session', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' }], origins: [] },
    extraHTTPHeaders: { 'X-CSRF-Token': createHash('sha256').update('csrf:wwa-e2e-owner-session').digest('hex'), Origin: web },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--disable-dev-shm-usage', '--renderer-process-limit=2'] } } }],
  webServer: [
    { command: 'node e2e/mock-openai.mjs', url: `http://127.0.0.1:${mockPort}/health`, reuseExistingServer: false, timeout: 30_000, env: { MOCK_OPENAI_PORT: mockPort } },
    {
      command: 'node e2e/prepare-db.mjs && node --import tsx server/src/index.ts',
      url: `http://127.0.0.1:${apiPort}/api/v1/auth/session`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { E2E_DATABASE_FILE: databaseFile, PORT: apiPort, CLIENT_ORIGIN: web, DATABASE_URL: `file:../../e2e/.data/${databaseFile}`, AGENT_WORKSPACE_ROOT: root, NODE_OPTIONS: '--max-old-space-size=512' },
    },
    { command: `npm run dev -w client -- --port ${webPort} --strictPort`, url: web, reuseExistingServer: false, timeout: 60_000, env: { VITE_API_URL: `http://127.0.0.1:${apiPort}` } },
  ],
});
