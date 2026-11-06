import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'streaming-render-demo.spec.ts', workers: 1, timeout: 60_000,
  outputDir: 'test-results/streaming-render', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5186', locale: 'zh-CN', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1080 } } }, { name: 'mobile', use: { ...devices['Pixel 7'] } }],
  webServer: { command: 'npm run dev -w client -- --port 5186 --strictPort', url: 'http://127.0.0.1:5186/streaming-render-demo.html', reuseExistingServer: true },
});
