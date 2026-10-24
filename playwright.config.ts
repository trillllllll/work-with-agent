import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
const databaseFile = process.env.E2E_DATABASE_FILE ?? 'agent-studio-e2e.db';
const databaseUrl = `file:${resolve(root, 'e2e/.data', databaseFile)}`;
const apiPort = process.env.E2E_API_PORT ?? '3015';
const uiPort = process.env.E2E_UI_PORT ?? '5175';
process.env.E2E_API_URL = `http://127.0.0.1:${apiPort}`;
process.env.E2E_DATABASE_URL = databaseUrl;
process.env.E2E_UI_URL = `http://127.0.0.1:${uiPort}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${uiPort}`,
    // The UI follows the browser language; the suite asserts the default Chinese UI.
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    storageState: { cookies: [{ name: 'dovun_session', value: 'wwa-e2e-owner-session', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' }], origins: [] },
    extraHTTPHeaders: { 'X-CSRF-Token': createHash('sha256').update('csrf:wwa-e2e-owner-session').digest('hex'), Origin: `http://127.0.0.1:${uiPort}` },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], locale: 'zh-CN' } },
    { name: 'mobile', use: { ...devices['Pixel 7'], locale: 'zh-CN' } },
    // 限定编辑器相关用例的 WebKit 项目。
    { name: 'webkit-editor', use: { ...devices['Desktop Safari'], locale: 'zh-CN' }, testMatch: /task-editor-lightweight|task-detail-editor|task-detail-rich|task-materials/ },
    // 只跑助手 HTML 块用例的 WebKit 项目（Desktop Safari）。
    { name: 'webkit-html', use: { ...devices['Desktop Safari'], locale: 'zh-CN' }, testMatch: /assistant-html-blocks/ },
    // The macOS desktop app uses WebKit; keep SVG parser/filter parity covered.
    { name: 'webkit-svg', use: { ...devices['Desktop Safari'], locale: 'zh-CN' }, testMatch: /svg-chat/ },
    { name: 'webkit-controls', use: { ...devices['Desktop Safari'], locale: 'zh-CN' }, testMatch: /control-surfaces|control-reuse|task-inline|task-save-version|mobile-navigation|context-usage|reply-style/ },
  ],
  webServer: [
    {
      command: 'node e2e/mock-openai.mjs',
      url: 'http://127.0.0.1:4010/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node e2e/prepare-db.mjs && node --import tsx server/src/index.ts',
      url: `http://127.0.0.1:${apiPort}/api/v1/auth/session`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { PORT: apiPort, CLIENT_ORIGIN: `http://127.0.0.1:${uiPort}`, DATABASE_URL: databaseUrl, E2E_DATABASE_FILE: databaseFile, AGENT_WORKSPACE_ROOT: root, KNOWLEDGE_STORAGE_ROOT: `${root}/e2e/.data/${databaseFile}-blobs`, DOVUN_RUNNER_DIR: `${root}/e2e/.data/${databaseFile}-runner` },
    },
    {
      command: `npm run dev -w client -- --port ${uiPort}`,
      url: `http://127.0.0.1:${uiPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_API_URL: `http://127.0.0.1:${apiPort}` },
    },
  ],
});
