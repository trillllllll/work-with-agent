/** Opt-in, real authenticated CLI smoke. Does not connect to any application database. */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLaunchSpec, capabilities, readRunnerOutput } from './adapters.js';
import { launchSupervisor, readReceipt, requestCancel } from './supervisor.js';
import { git } from './workspaces.js';
import type { Provider } from './contracts.js';
import { generateExternalReview } from './review-generator.js';

export async function runRealCliSmoke() {
  const root = await mkdtemp(join(tmpdir(), 'wwa-cli-smoke-'));
  process.env.WWA_RUNNER_DIR = root;
  const fixture = resolve(root, 'fixture'); await mkdir(fixture);
  await git(fixture, ['init']); await git(fixture, ['config', 'user.email', 'smoke@example.invalid']); await git(fixture, ['config', 'user.name', 'Acceptance smoke']);
  await writeFile(resolve(fixture, 'README.txt'), 'Isolated real CLI acceptance fixture.'); await git(fixture, ['add', '.']); await git(fixture, ['commit', '-m', 'fixture']);
  console.log(JSON.stringify({ kind: 'capabilities', providers: await capabilities(), evidenceDirectory: root }));
  const outcomes: unknown[] = [];
  async function execute(provider: Provider, pass: string, sessionId?: string) {
    const id = `${provider}-${pass}`;
    const spec = await createLaunchSpec({ runId: id, provider, permissions: { profile: 'read_only', allowShell: false }, controlDir: resolve(root, 'runs', id), cwd: fixture, externalSessionId: sessionId,
      prompt: `This is an authorized minimal integration smoke test. Do not use any tools or edit any files. Return the specified JSON schema, outcome ready_for_review, summary ${sessionId ? 'SMOKE_CONTINUED' : 'SMOKE_OK'}, and empty arrays for questions, artifacts, checks. ${sessionId ? 'This is a new run continuing the explicit previous session.' : ''}` });
    await launchSupervisor(spec);
    for (let attempt = 0; attempt < 240; attempt++) {
      const receipt = await readReceipt(id);
      if (receipt?.state === 'ended') {
        const parsed = await readRunnerOutput(spec.controlDir, provider);
        const success = receipt.exitCode === 0 && Boolean(parsed.result) && !parsed.error && Boolean(parsed.sessionId) && (!sessionId || parsed.sessionId === sessionId);
        const stderr = success ? undefined : (await readFile(resolve(spec.controlDir, 'stderr.log'), 'utf8').catch(() => '')).slice(-2000).replace(/(?:sk-|Bearer\s+)[\w.-]+/g, '[redacted]');
        const outcome = { provider, pass, success, exitCode: receipt.exitCode, sessionId: parsed.sessionId, summary: parsed.result?.summary, error: parsed.error ?? receipt.error, stderr };
        console.log(JSON.stringify(outcome)); outcomes.push(outcome);
        return success ? parsed.sessionId : undefined;
      }
      await new Promise((done) => setTimeout(done, 1000));
    }
    await requestCancel(id);
    const outcome = { provider, pass, success: false, error: 'Timed out after 240 seconds; cancellation requested' }; console.log(JSON.stringify(outcome)); outcomes.push(outcome); return undefined;
  }
  for (const provider of ['codex', 'claude'] as const) {
    try { const sessionId = await execute(provider, 'initial'); if (sessionId) await execute(provider, 'resume', sessionId); }
    catch (error) { const outcome = { provider, success: false, error: error instanceof Error ? error.message : String(error) }; console.log(JSON.stringify(outcome)); outcomes.push(outcome); }
  }
  await writeFile(resolve(root, 'acceptance-results.json'), JSON.stringify(outcomes, null, 2));
  return outcomes;
}
export async function runRealReviewSmoke() {
  const root = await mkdtemp(join(tmpdir(), 'wwa-review-smoke-')); process.env.WWA_RUNNER_DIR = root;
  console.log(JSON.stringify({ evidenceDirectory: root }));
  const outcomes: Array<{ provider: string; success: boolean; result?: unknown; error?: string }> = [];
  for (const provider of ['codex', 'claude'] as const) {
    try { const result = await generateExternalReview({ id: `${provider}-acceptance`, topicId: null, provider, prompt: 'This is an isolated integration test. There are no sources and no tasks to execute. Return summary REVIEW_SMOKE_OK and commandsJson [] without tools.' }); const outcome = { provider, success: result.summary.includes('REVIEW_SMOKE_OK') && result.commands.length === 0, result }; outcomes.push(outcome); console.log(JSON.stringify(outcome)); }
    catch (error) { const outcome = { provider, success: false, error: error instanceof Error ? error.message : String(error) }; outcomes.push(outcome); console.log(JSON.stringify(outcome)); }
  }
  await writeFile(resolve(root, 'acceptance-results.json'), JSON.stringify(outcomes, null, 2));
  return outcomes;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv.includes('--reviews') ? runRealReviewSmoke : process.argv.includes('--run') ? runRealCliSmoke : null;
  if (action) action().then((results) => { if (results.some((result) => !(result as { success: boolean }).success)) process.exitCode = 1; }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
