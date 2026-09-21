/** Independent supervisor: no database connection or dependency on the API process. */
import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, appendFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { LaunchSpec, RunnerReceipt } from './contracts.js';
import { providerEnvironment } from './environment.js';

export async function supervise(specPath: string) {
  const spec: LaunchSpec = JSON.parse(await readFile(specPath, 'utf8'));
  const receiptPath = resolve(spec.controlDir, 'receipt.jsonl');
  const receipt: RunnerReceipt = { runId: spec.runId, token: randomUUID(), supervisorPid: process.pid, createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), state: 'starting' };
  let writing = Promise.resolve();
  // Append-only receipts avoid Windows rename/read races. An interrupted final line
  // is ignored by observers; the previous complete observation remains valid.
  const persist = () => { const snapshot = `${JSON.stringify(receipt)}\n`; writing = writing.catch(() => undefined).then(() => appendFile(receiptPath, snapshot, { mode: 0o600 })); return writing; };
  await persist();
  const stdout = createWriteStream(resolve(spec.controlDir, 'stdout.jsonl'), { flags: 'a' });
  const stderr = createWriteStream(resolve(spec.controlDir, 'stderr.log'), { flags: 'a' });
  let child: ReturnType<typeof spawn>;
  try { child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: providerEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); }
  catch (error) {
    receipt.state = 'ended'; receipt.exitCode = null; receipt.error = error instanceof Error ? error.message : String(error); receipt.heartbeatAt = new Date().toISOString();
    await persist(); stdout.end(); stderr.end(); return;
  }
  const resultPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>((done) => {
    child.once('error', (error) => done({ code: null, signal: null, error: error.message }));
    child.once('close', (code, signal) => done({ code, signal }));
  });
  receipt.childPid = child.pid;
  receipt.state = 'running';
  await persist();
  child.stdout!.pipe(stdout);
  child.stderr!.pipe(stderr);
  child.stdin!.on('error', () => undefined);
  child.stdin!.end(spec.prompt);
  let killing = false;
  const cancel = async () => {
    if (killing || !child.pid) return;
    killing = true;
    receipt.cancelled = true;
    // This supervisor owns the child handle. Never kill a PID reconstructed from old DB data.
    if (process.platform === 'win32') await new Promise<void>((done) => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => done()));
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
    await persist();
  };
  const timer = setInterval(async () => {
    receipt.heartbeatAt = new Date().toISOString();
    await persist().catch(() => undefined);
    try { await access(resolve(spec.controlDir, 'cancel.request')); await cancel(); } catch { /* No cancellation requested. */ }
  }, 1000);
  const result = await resultPromise;
  clearInterval(timer);
  await Promise.all([new Promise<void>((done) => stdout.end(done)), new Promise<void>((done) => stderr.end(done))]);
  receipt.state = 'ended'; receipt.exitCode = result.code; receipt.signal = result.signal; receipt.error = result.error; receipt.heartbeatAt = new Date().toISOString();
  await persist();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  supervise(resolve(process.argv[2])).catch(async (error) => { process.stderr.write(String(error)); process.exitCode = 1; });
}
