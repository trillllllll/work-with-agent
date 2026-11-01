import workflow from './playwright.learning-workflow.config.js';
import { defineConfig } from '@playwright/test';

export default defineConfig({ ...workflow, testMatch: /learning-assistant-completion\.spec\.ts$/,
  outputDir: 'test-results/learning-assistant', reporter: [['list'], ['json', { outputFile: 'test-results/learning-assistant/results.json' }]] });
