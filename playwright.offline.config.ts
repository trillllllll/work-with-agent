import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = process.cwd(), port = process.env.E2E_API_PORT ?? '3217';
const origin = `http://127.0.0.1:${port}`;
const databaseFile = 'dovun-offline-browser.db';
const databaseUrl = `file:${resolve(root, 'e2e/.data', databaseFile)}`;
process.env.E2E_API_URL = origin; process.env.E2E_UI_URL = origin; process.env.E2E_DATABASE_URL = databaseUrl;
export default defineConfig({
  testDir: './e2e', testMatch: /offline-browser\.spec\.ts/, fullyParallel: false, workers: 1, timeout: 60_000,
  use: {
    baseURL: origin, locale: 'zh-CN', trace: 'retain-on-failure', screenshot: 'only-on-failure',
    storageState: { cookies: [{ name: 'dovun_session', value: 'wwa-e2e-owner-session', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' }], origins: [] },
    extraHTTPHeaders: { 'X-CSRF-Token': createHash('sha256').update('csrf:wwa-e2e-owner-session').digest('hex'), Origin: origin },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node e2e/prepare-db.mjs && node e2e/offline-test-server.mjs', url: `${origin}/api/v1/auth/session`, reuseExistingServer: false, timeout: 120_000,
    env: { PORT: port, DATABASE_URL: databaseUrl, E2E_DATABASE_FILE: databaseFile, DOVUN_SERVER_MODE: '1', DOVUN_OWNER_KEY: 'offline-integration-fixture-owner-key', DOVUN_PUBLIC_URL: origin, DOVUN_STATIC_DIR: resolve(root, 'client/dist'), DOVUN_DATA_DIR: resolve(root, 'e2e/.data/offline-browser-runtime'), AGENT_WORKSPACE_ROOT: root, KNOWLEDGE_STORAGE_ROOT: resolve(root, 'e2e/.data/offline-browser-blobs'), DOVUN_RUNNER_DIR: resolve(root, 'e2e/.data/offline-browser-runner') },
  },
});
