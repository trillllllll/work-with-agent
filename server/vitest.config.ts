import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [{ find: /^supertest$/, replacement: fileURLToPath(new URL('./test/supertest-stable.ts', import.meta.url)) }],
  },
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    setupFiles: ['./test/settle-runs.ts'],
  },
});
