/** Opt-in real CLI → Handoff → worktree → immutable patch → original fixture integration. */
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { git } from './workspaces.js';
import { resultSchema } from './contracts.js';

export async function runRealHandoffSmoke() {
  const root = await mkdtemp(join(tmpdir(), 'wwa-handoff-real-'));
  const database = resolve(root, 'acceptance.db'); await writeFile(database, '');
  process.env.DATABASE_URL = `file:${database.replace(/\\/g, '/')}`;
  process.env.WWA_RUNNER_DIR = resolve(root, 'runner');
  const schema = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));
  await promisify(execFile)(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', schema], { windowsHide: true, env: process.env, maxBuffer: 1024 * 1024 });
  const [{ prisma }, { HandoffService }, { RunService }, { ownerActor }, { registerKnowledgeCommands }] = await Promise.all([import('../infrastructure/prisma.js'), import('../application/handoff.js'), import('../application/runs.js'), import('../application/security.js'), import('../application/knowledge.js')]);
  registerKnowledgeCommands();
  const handoffs = new HandoffService(); const runs = new RunService();
  console.log(JSON.stringify({ evidenceDirectory: root, independentDatabase: database }));
  const results: unknown[] = [];
  try {
    for (const provider of ['codex', 'claude'] as const) {
      let runId: string | undefined;
      try {
        const source = resolve(root, `${provider}-source`); await mkdir(source);
        await git(source, ['init']); await git(source, ['config', 'core.autocrlf', 'false']); await git(source, ['config', 'user.email', 'acceptance@example.invalid']); await git(source, ['config', 'user.name', 'Acceptance']);
        await writeFile(resolve(source, 'README.txt'), 'Isolated real Handoff acceptance fixture.\n'); await git(source, ['add', '.']); await git(source, ['commit', '-m', 'fixture']);
        const task = await prisma.task.create({ data: { title: `Real ${provider} isolated write acceptance`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
        const name = `${provider}-created.txt`; const expected = `written-by-${provider}\n`;
        const handoff = await handoffs.prepare(ownerActor, { taskId: task.id, expectedTaskRevision: task.revision, provider, mode: 'local', permissions: { profile: 'workspace_write', allowShell: true }, materialIds: [], memoryIds: [], instruction: `This is an authorized integration test in an isolated Git worktree. Create exactly one file named ${name} in the current directory, with the text ${JSON.stringify(expected)} (one final newline). Do not edit any other file or create any commit. You may use approved file editing/shell tools in this worktree. Verify the file and return outcome ready_for_review, summary FILE_CREATED, empty questions/unfinished/artifacts/proposedCommandsJson, and an honest check. Do not modify any source directory outside the current worktree.` });
        const started = await runs.start(ownerActor, handoff.id, { sourcePath: source, requestId: randomUUID() }); runId = started.id;
        let terminal: Awaited<ReturnType<typeof runs.get>> | undefined; let previousStatus = '';
        for (let attempt = 0; attempt < 240; attempt++) {
          const current = await runs.get(ownerActor, runId);
          if (current.status !== previousStatus) { console.log(JSON.stringify({ provider, runId, status: current.status })); previousStatus = current.status; }
          if (['returned', 'failed', 'cancelled', 'interrupted'].includes(current.status)) { terminal = current; break; }
          if (current.status === 'unknown') throw new Error('Runner observation is unknown; not retrying');
          await new Promise((done) => setTimeout(done, 1000));
        }
        if (!terminal || terminal.status !== 'returned') throw new Error(terminal?.error ?? `CLI did not return successfully (${terminal?.status ?? 'timeout'})`);
        const resultReport = resultSchema.parse(terminal.result);
        if (resultReport.outcome !== 'ready_for_review') throw new Error(`CLI returned ${resultReport.outcome}: ${resultReport.summary}`);
        let originalExists = false; try { await access(resolve(source, name)); originalExists = true; } catch { /* Required: original remains untouched before applying. */ }
        if (originalExists) throw new Error('Original source was modified before explicit patch application');
        const artifacts = await runs.artifacts(ownerActor, runId);
        const artifact = artifacts.find((row) => row.kind === 'git_patch');
        if (!artifact) throw new Error('No complete patch artifact was collected');
        const preview = await runs.artifactContent(ownerActor, artifact.id);
        if (preview.encoding !== 'utf8' || !preview.content.includes(name)) throw new Error('Patch preview did not include the generated file');
        const application = await runs.apply(ownerActor, runId, { artifactId: artifact.id, expectedHead: await git(source, ['rev-parse', 'HEAD']), requestId: randomUUID() });
        const actual = (await readFile(resolve(source, name), 'utf8')).replace(/\r\n/g, '\n');
        const taskAfter = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
        const success = application.status === 'applied' && actual === expected && taskAfter.status === 'todo';
        const result = { provider, success, runId, sessionId: terminal.externalSessionId, originalUntouchedBeforeApply: !originalExists, artifactId: artifact.id, artifactHash: artifact.hash, applicationStatus: application.status, taskStatus: taskAfter.status, fileName: name, fileContent: actual };
        results.push(result); console.log(JSON.stringify(result));
      } catch (error) {
        if (runId) await runs.cancel(ownerActor, runId).catch(() => undefined);
        const result = { provider, success: false, runId, error: error instanceof Error ? error.message : String(error) }; results.push(result); console.log(JSON.stringify(result));
      }
    }
    await writeFile(resolve(root, 'acceptance-results.json'), JSON.stringify(results, null, 2));
    return results;
  } finally { await prisma.$disconnect(); }
}
if (process.argv.includes('--run') && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runRealHandoffSmoke().then((results) => { if (results.some((result) => !(result as { success: boolean }).success)) process.exitCode = 1; }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
