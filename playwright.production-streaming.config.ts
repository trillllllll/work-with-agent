import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.js';
export default defineConfig({ ...base, testMatch: /production-streaming|assistant-html-blocks|assistant-rich-media|mermaid-chat|svg-chat/, timeout: 45_000,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], locale: 'zh-CN' } },
    { name: 'mobile', use: { ...devices['Pixel 7'], locale: 'zh-CN' } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], locale: 'zh-CN' } },
  ],
});
