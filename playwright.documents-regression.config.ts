import { defineConfig } from '@playwright/test';
import base from './playwright.documents.config.js';

/** Reuse the explicit document-test database and ports; never use the installed desktop service. */
export default defineConfig({ ...base, testMatch: /task-editor-lightweight\.spec\.ts$/ });
