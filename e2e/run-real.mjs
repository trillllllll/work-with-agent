import { spawn } from 'node:child_process';

const required = ['E2E_REAL_MODEL', 'E2E_MODEL_BASE_URL', 'E2E_MODEL_API_KEY', 'E2E_MODEL_NAME'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing real-model configuration: ${missing.join(', ')}`);
  process.exit(2);
}
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(command, ['playwright', 'test', 'e2e/real-model.spec.ts', '--project=chromium'], {
  stdio: 'inherit',
  env: { ...process.env, E2E_REAL_MODEL: '1' },
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
