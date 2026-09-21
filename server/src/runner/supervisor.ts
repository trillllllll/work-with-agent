import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { LaunchSpec, RunnerReceipt } from './contracts.js';
import { DomainError } from '../domain/task.js';

// Resolve identically from src and dist, and keep runtime files out of the source checkout's tracked scope.
export const runnerRoot = () => resolve(process.env.WWA_RUNNER_DIR ?? fileURLToPath(new URL('../../runtime/runner/', import.meta.url)));
export const controlDirectory = (runId: string) => resolve(runnerRoot(), 'runs', runId);
export async function launchSupervisor(spec: LaunchSpec) {
  await mkdir(spec.controlDir, { recursive: true });
  const lock = await open(resolve(spec.controlDir, 'launch.lock'), 'wx').catch(() => { throw new DomainError('RUN_ALREADY_LAUNCHED', '该次运行已发起，必须先观察原进程'); });
  await lock.writeFile(JSON.stringify({ runId: spec.runId, time: new Date().toISOString() })); await lock.close();
  const specPath = resolve(spec.controlDir, 'launch.json');
  await writeFile(specPath, JSON.stringify(spec), { mode: 0o600 });
  const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url));
  const args = worker.endsWith('.ts') ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, worker, specPath] : [worker, specPath];
  const log = await open(resolve(spec.controlDir, 'supervisor.log'), 'a');
  const child = spawn(process.execPath, args, { cwd: spec.cwd, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  try { await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', reject); }); } finally { await log.close(); }
  child.unref();
  return { supervisorPid: child.pid };
}
export async function readReceipt(runId: string): Promise<RunnerReceipt | null> {
  try {
    const lines = (await readFile(resolve(controlDirectory(runId), 'receipt.jsonl'), 'utf8')).split(/\r?\n/);
    for (const line of lines.reverse()) {
      try { const receipt: RunnerReceipt = JSON.parse(line); if (receipt.runId === runId) return receipt; } catch { /* Ignore incomplete trailing writes. */ }
    }
  } catch { /* Accept the old single receipt file when upgrading an existing run. */ }
  try { const receipt: RunnerReceipt = JSON.parse(await readFile(resolve(controlDirectory(runId), 'receipt.json'), 'utf8')); return receipt.runId === runId ? receipt : null; } catch { return null; }
}
export async function requestCancel(runId: string) { await writeFile(resolve(controlDirectory(runId), 'cancel.request'), JSON.stringify({ requestedAt: new Date().toISOString() })); }
