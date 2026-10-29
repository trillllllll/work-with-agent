import { defineConfig, devices } from '@playwright/test';
import { createHash } from 'node:crypto';

const root = process.cwd();
const testRoot = '/tmp/dovun-document-workspace-e2e';
const databaseFile = `${testRoot}/test.db`;
const databaseUrl = `file:${databaseFile}`;
const apiPort = '3046'; const uiPort = '5196';
process.env.E2E_API_URL = `http://127.0.0.1:${apiPort}`;
process.env.E2E_DATABASE_URL = databaseUrl;
process.env.E2E_UI_URL = `http://127.0.0.1:${uiPort}`;
export default defineConfig({
  testDir: './e2e', testMatch: /document-(workspace|large-upload)\.spec\.ts$/, outputDir: `${testRoot}/results`,
  fullyParallel: false, workers: 1, timeout: 60_000, expect: { timeout: 10_000 }, retries: 0, reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${uiPort}`, locale: 'zh-CN', trace: 'retain-on-failure', screenshot: 'only-on-failure',
    storageState: { cookies: [{ name: 'dovun_session', value: 'wwa-e2e-owner-session', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' }], origins: [] },
    extraHTTPHeaders: { 'X-CSRF-Token': createHash('sha256').update('csrf:wwa-e2e-owner-session').digest('hex'), Origin: `http://127.0.0.1:${uiPort}` },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], locale: 'zh-CN' } },
    { name: 'mobile', use: { ...devices['Pixel 7'], locale: 'zh-CN' } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], locale: 'zh-CN' } },
  ],
  webServer: [
    { command: 'node e2e/prepare-db.mjs && node --import tsx server/src/index.ts', url: `http://127.0.0.1:${apiPort}/api/v1/auth/session`, reuseExistingServer: false, timeout: 120_000, env: { PORT: apiPort, CLIENT_ORIGIN: `http://127.0.0.1:${uiPort}`, DATABASE_URL: databaseUrl, E2E_DATABASE_FILE: databaseFile, AGENT_WORKSPACE_ROOT: root, DOVUN_DATA_DIR: `${testRoot}/runtime`, KNOWLEDGE_STORAGE_ROOT: `${testRoot}/blobs`, LIBRARY_UPLOAD_ROOT: `${testRoot}/uploads`, DOVUN_RUNNER_DIR: `${testRoot}/runner` } },
    { command: `npm run dev -w client -- --port ${uiPort}`, url: `http://127.0.0.1:${uiPort}`, reuseExistingServer: false, timeout: 120_000, env: { VITE_API_URL: `http://127.0.0.1:${apiPort}` } },
  ],
});
