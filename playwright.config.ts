import { defineConfig, devices } from '@playwright/test';
const root = process.cwd();
const databaseUrl = 'file:../../e2e/.data/agent-studio-e2e.db';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'node e2e/mock-openai.mjs',
      url: 'http://127.0.0.1:4010/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node e2e/prepare-db.mjs && npm run dev -w server',
      url: 'http://127.0.0.1:3001/api/topics',
      reuseExistingServer: false,
      timeout: 30_000,
      env: { PORT: '3001', DATABASE_URL: databaseUrl, AGENT_WORKSPACE_ROOT: root },
    },
    {
      command: 'npm run dev -w client -- --port 5175',
      url: 'http://127.0.0.1:5175',
      reuseExistingServer: false,
      timeout: 30_000,
      env: { VITE_API_URL: 'http://127.0.0.1:3001' },
    },
  ],
});
