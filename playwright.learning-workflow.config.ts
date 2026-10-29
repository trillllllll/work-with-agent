import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const root = process.cwd();
const apiPort = process.env.LEARNING_E2E_API_PORT ?? '3038';
const uiPort = process.env.LEARNING_E2E_UI_PORT ?? '5188';
const modelPort = process.env.LEARNING_E2E_MODEL_PORT ?? '4038';
for (const port of [apiPort, uiPort, modelPort]) {
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('Invalid learning E2E port');
}
if (new Set([apiPort, uiPort, modelPort]).size !== 3) throw new Error('Learning E2E ports must be distinct');
const databaseUrl = `file:${resolve(root, 'e2e/.data/learning-workflow.db')}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const uiUrl = `http://127.0.0.1:${uiPort}`;
const modelUrl = `http://127.0.0.1:${modelPort}`;
const fixtureSession = 'learning-workflow-fixture-session';
const csrf = createHash('sha256').update(`csrf:${fixtureSession}`).digest('hex');

process.env.LEARNING_WORKFLOW_E2E = '1';
process.env.E2E_API_URL = apiUrl;
process.env.E2E_UI_URL = uiUrl;
process.env.E2E_DATABASE_URL = databaseUrl;
process.env.LEARNING_E2E_MODEL_URL = modelUrl;

export default defineConfig({
  testDir: './e2e', testMatch: /learning-workflow\.spec\.ts$/,
  fullyParallel: false, workers: 1, timeout: 60_000,
  expect: { timeout: 10_000 }, retries: 0,
  outputDir: 'test-results/learning-workflow',
  reporter: [['list'], ['json', { outputFile: 'test-results/learning-workflow/results.json' }]],
  use: {
    baseURL: uiUrl, locale: 'zh-CN', trace: 'retain-on-failure', screenshot: 'only-on-failure',
    storageState: {
      cookies: [{ name: 'dovun_session', value: fixtureSession, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' }],
      origins: [],
    },
    extraHTTPHeaders: { 'X-CSRF-Token': csrf, Origin: uiUrl },
  },
  projects: [
    { name: 'learning-desktop', use: { ...devices['Desktop Chrome'], locale: 'zh-CN' } },
    { name: 'learning-mobile', use: { ...devices['Pixel 7'], locale: 'zh-CN' } },
    { name: 'learning-webkit', use: { ...devices['iPhone 13'], locale: 'zh-CN' } },
  ],
  webServer: [
    {
      command: 'node e2e/learning-workflow-model.mjs', url: `${modelUrl}/health`, reuseExistingServer: false, timeout: 30_000,
      env: { LEARNING_E2E_MODEL_PORT: modelPort },
    },
    {
      command: 'node e2e/learning-workflow-prepare.mjs && node --import tsx server/src/index.ts',
      url: `${apiUrl}/api/v1/auth/session`, reuseExistingServer: false, timeout: 120_000,
      env: {
        PORT: apiPort, CLIENT_ORIGIN: uiUrl, DATABASE_URL: databaseUrl,
        LEARNING_WORKFLOW_E2E: '1', LEARNING_E2E_API_PORT: apiPort, LEARNING_E2E_UI_PORT: uiPort,
        LEARNING_E2E_MODEL_PORT: modelPort, DOVUN_SERVER_MODE: '1',
        DOVUN_OWNER_KEY: 'learning-workflow-isolated-fixture-owner-key', DOVUN_PUBLIC_URL: apiUrl,
        DOVUN_DATA_DIR: resolve(root, 'e2e/.data/learning-workflow-runtime'),
        KNOWLEDGE_STORAGE_ROOT: resolve(root, 'e2e/.data/learning-workflow-blobs'),
        DOVUN_RUNNER_DIR: resolve(root, 'e2e/.data/learning-workflow-runner'),
        AGENT_WORKSPACE_ROOT: root,
      },
    },
    {
      command: `npm run dev -w client -- --port ${uiPort} --strictPort`,
      url: uiUrl, reuseExistingServer: false, timeout: 120_000,
      env: { VITE_API_URL: apiUrl },
    },
  ],
});
