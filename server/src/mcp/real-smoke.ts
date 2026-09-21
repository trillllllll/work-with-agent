/** Opt-in real host acceptance. Uses a new isolated SQLite database and scoped credentials. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const exec = promisify(execFile);
function redactLogs(value: string, secrets: Set<string>) {
  // MCP results can be JSON inside JSON strings. Discover the one-time claim
  // token before persisting any host output, including repeated report arguments.
  for (const match of value.matchAll(/claimToken[\s\\"':=]+([A-Za-z0-9_-]{20,})/g)) secrets.add(match[1]);
  return [...secrets].filter(Boolean).sort((a, b) => b.length - a.length).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
}
function hostSession(provider: 'codex' | 'claude', output: string) {
  for (const line of output.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const id = provider === 'codex' && event.type === 'thread.started' ? event.thread_id : provider === 'claude' ? event.session_id : undefined;
    if (typeof id === 'string' && id) return id;
  }
  throw new Error(`${provider}: host did not return an explicit session ID`);
}
async function main() {
  const root = process.cwd();
  const evidence = await mkdtemp(join(tmpdir(), 'wwa-mcp-hosts-'));
  process.env.DATABASE_URL = `file:../data/mcp-real-${Date.now()}.db`;
  process.env.CLIENT_ORIGIN = 'http://127.0.0.1:5176';
  await exec(process.execPath, ['--import', 'tsx', 'src/db-migrate.ts'], { cwd: resolve(root, 'server'), env: process.env, windowsHide: true });
  const { app } = await import('../app.js');
  const { prisma } = await import('../infrastructure/prisma.js');
  const { createOwnerBootstrapToken } = await import('../application/security.js');
  const { resolveCli } = await import('../runner/adapters.js');
  const listener = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => listener.once('listening', done));
  const base = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
  const login = await fetch(`${base}/api/v1/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapToken: createOwnerBootstrapToken() }) });
  const csrf = (await login.json() as any).data.csrfToken;
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const credentials = new Map<string, 'codex' | 'claude'>();
  const observations: Array<{ provider: string; path: string; method: string; status: number }> = [];
  listener.on('request', (req, res) => {
    const credential = req.headers.authorization?.replace(/^Bearer /, '');
    const provider = credential ? credentials.get(credential) : undefined;
    const path = ((req as typeof req & { originalUrl?: string }).originalUrl ?? req.url!).split('?')[0];
    if (provider) res.once('finish', () => observations.push({ provider, path, method: req.method!, status: res.statusCode }));
  });
  const versions: Record<string, string> = {};
  async function owner(path: string, data: unknown) {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const body = await response.json() as any;
    if (!response.ok) throw new Error(`${path}: ${JSON.stringify(body)}`);
    return body.data;
  }
  async function host(provider: 'codex' | 'claude', prompt: string, credential: string, phase: string, sessionId?: string) {
    const cli = await resolveCli(provider);
    versions[provider] ??= (await exec(cli.command, [...cli.prefix, '--version'], { windowsHide: true, timeout: 15_000 })).stdout.trim();
    credentials.set(credential, provider);
    const entry = resolve(root, 'server/dist/mcp/index.js');
    const config = { mcpServers: { wwa: { command: process.execPath, args: [entry] } } };
    const enabledTools = phase.startsWith('handoff') ? ['get_handoff', 'claim_handoff', 'report_progress', 'report_run'] : ['list_tasks', 'get_task', 'submit_commands'];
    const args = provider === 'codex'
      ? ['--ask-for-approval', 'never', '--sandbox', 'read-only', '-c', `mcp_servers.wwa.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.wwa.args=${JSON.stringify([entry])}`, '-c', 'mcp_servers.wwa.env_vars=["WWA_API_URL","WWA_CONNECTION_TOKEN"]', '-c', `mcp_servers.wwa.enabled_tools=${JSON.stringify(enabledTools)}`, ...enabledTools.flatMap((tool) => ['-c', `mcp_servers.wwa.tools.${tool}.approval_mode="approve"`]), 'exec', ...(sessionId ? ['resume', sessionId] : []), '--ignore-user-config', '--skip-git-repo-check', '--json', '-']
      : ['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', JSON.stringify(config), '--tools', '', '--allowedTools', ...enabledTools.map((tool) => `mcp__wwa__${tool}`), ...(sessionId ? ['--resume', sessionId] : [])];
    let stdout = '', stderr = '';
    const child = spawn(cli.command, [...cli.prefix, ...args], { cwd: evidence, env: { ...process.env, WWA_API_URL: base, WWA_CONNECTION_TOKEN: credential }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(prompt);
    const timer = setTimeout(() => child.kill(), 240_000);
    const code = await new Promise((done, fail) => { child.once('close', done); child.once('error', fail); });
    clearTimeout(timer);
    const secrets = new Set([credential, cookie, csrf]);
    redactLogs(stdout + '\n' + stderr, secrets);
    await writeFile(join(evidence, `${provider}-${phase}.jsonl`), redactLogs(stdout, secrets));
    await writeFile(join(evidence, `${provider}-${phase}.stderr`), redactLogs(stderr, secrets));
    if (code !== 0) throw new Error(`${provider} ${phase} exited ${code}; see sanitized evidence`);
    return stdout;
  }
  const outcomes: unknown[] = [];
  try {
    if (!process.argv.includes('--handoff-only')) {
    for (const provider of ['codex', 'claude'] as const) {
      const task = await owner('/api/tasks', { title: `${provider} MCP acceptance fixture` });
      const access = await owner('/api/v1/connections', { name: `${provider} real acceptance`, host: provider, topicIds: [], includeInbox: true, autoActions: [] });
      const requestId = `${provider}-real-proposal`;
      const input = { requestId, commands: [{ kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { title: `${provider} proposed through real MCP` } }] };
      const output = await host(provider, `This is an authorized integration acceptance using a synthetic isolated test workspace. Use ONLY the wwa MCP tools. First list_tasks and get_task taskId ${task.id}. Then call submit_commands twice with exactly this identical JSON: ${JSON.stringify(input)}. Confirm both responses are pending_approval with the same proposal ID. Do not claim the task is changed. Do not use shell, files or other integrations.`, access.token, 'proposal');
      const receipt = await prisma.requestReceipt.findUniqueOrThrow({ where: { actorId_requestId: { actorId: `connection:${access.id}`, requestId } } });
      const proposal = JSON.parse(receipt.response).result;
      if (proposal.status !== 'pending_approval') throw new Error('Host did not produce a pending proposal');
      if ((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).title !== task.title) throw new Error('Proposal modified task before approval');
      await owner(`/api/v1/proposals/${proposal.proposalId}/approve`, { expectedRevision: proposal.proposalRevision ?? 1, requestId: `${provider}-owner-confirm` });
      const current = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      if (current.title !== input.commands[0].input.title) throw new Error('Approval did not apply expected title');
      const stale = { ...input, requestId: `${provider}-stale` };
      const verified = await host(provider, `Use only wwa MCP. get_task taskId ${task.id}, verify title "${current.title}" and revision ${current.revision}. Then submit_commands ${JSON.stringify(stale)} and verify a version conflict; do not retry with fresh version or propose another edit. This is an authorized stale-write acceptance test on synthetic data.`, access.token, 'read-conflict');
      const conflict = /VERSION_CONFLICT/.test(verified);
      if (!conflict) throw new Error(`${provider} did not observe expected version conflict`);
      outcomes.push({ provider, proposalConfirmed: true, visibleViaRealHost: true, staleWriteRejected: conflict, repeatedSubmission: (output.match(/submit_commands/g) ?? []).length >= 2 });
      console.log(JSON.stringify(outcomes.at(-1)));
      await prisma.connection.update({ where: { id: access.id }, data: { status: 'revoked', revision: { increment: 1 } } });
    }
    }
    for (const provider of ['codex', 'claude'] as const) {
      const task = await owner('/api/tasks', { title: `${provider} manual handoff acceptance fixture` });
      const marker = `SOURCE_ONLY_${randomUUID()}`;
      const saved = await owner('/api/v1/commands', { requestId: `${provider}-handoff-material`, commands: [{ kind: 'material.create', input: { topicId: null, taskId: task.id, kind: 'text', title: 'Selected evidence for manual handoff', content: `This material is synthetic acceptance data. The exact acceptance marker is ${marker}. Include it unchanged in progress and final summary.` } }] });
      const material = saved.results[0];
      const handoff = await owner('/api/v1/handoffs', { taskId: task.id, expectedTaskRevision: task.revision, provider, mode: 'manual', instruction: 'Read the selected frozen material and report its exact acceptance marker. This task requires no filesystem edits, shell commands or other integrations. Do not complete the Todo.', materialIds: [material.id], memoryIds: [], permissions: { profile: 'read_only', allowShell: false } });
      const access = await owner('/api/v1/connections', { name: `${provider} manual handoff real acceptance`, host: provider, topicIds: [], includeInbox: true, autoActions: [] });
      try {
        // The marker is deliberately absent from the prompt: the real host must
        // discover it through get_handoff's selected immutable material snapshot.
        const progressId = `${provider}-manual-progress-once`;
        const resultId = `${provider}-manual-result-once`;
        const contextOutput = await host(provider, `Authorized integration acceptance in an isolated synthetic WorkWithAgent workspace. Use ONLY get_handoff with handoffId ${handoff.id}. Read the selected frozen material in inputSnapshot.knowledge.sources and remember its exact SOURCE_ONLY_ marker for the next turn. Do not claim the handoff yet. Do not report progress or results. Do not use shell, files or any other tool. Finish by confirming the selected material is available.`, access.token, 'handoff-context');
        const sessionId = hostSession(provider, contextOutput);
        if (await prisma.run.count({ where: { handoffId: handoff.id } })) throw new Error(`${provider}: context-only turn unexpectedly claimed a run`);
        const output = await host(provider, `You are performing authorized integration acceptance in an isolated synthetic WorkWithAgent workspace. Use ONLY the four wwa MCP tools get_handoff, claim_handoff, report_progress, report_run. No shell, filesystem, other integrations or task changes. Follow every step exactly:
1. Call get_handoff with handoffId ${handoff.id}. Read inputSnapshot.knowledge.sources and discover the exact SOURCE_ONLY_ marker in the selected material. Do not invent it.
2. Call claim_handoff with handoffId ${handoff.id} and requestId "${provider}-manual-claim-once". Keep the returned run.id and claimToken for the following tool calls. Do not print claimToken in your final answer.
3. Call report_progress twice with identical arguments: returned runId and claimToken, eventId "${progressId}", message "Read selected material: <exact marker>". Both responses must succeed; use the identical eventId and message twice.
4. Call report_run twice with identical arguments: returned runId and claimToken, eventId "${resultId}", result {"outcome":"ready_for_review","summary":"Verified selected frozen material: <exact marker>","questions":[],"artifacts":[],"checks":[],"unfinished":[],"proposedCommands":[]}. Substitute the exact marker; copy all arguments unchanged for the second call. Repeated submission must succeed without creating a second result.
5. Call get_handoff again and verify the same single run is returned. Report that its result awaits owner review and the Todo has not been completed. Do not call tools outside the whitelist. If any step fails, report the actual failure instead of claiming success.`, access.token, 'handoff', sessionId);
        if (hostSession(provider, output) !== sessionId) throw new Error(`${provider}: explicit resume returned a different host session`);
        const runs = await prisma.run.findMany({ where: { handoffId: handoff.id } });
        if (runs.length !== 1) throw new Error(`${provider}: expected one claimed run, found ${runs.length}`);
        const run = runs[0];
        const result = run.resultJson ? JSON.parse(run.resultJson) : null;
        if (run.status !== 'returned' || run.mode !== 'manual' || run.claimOwner !== `connection:${access.id}` || !result?.summary?.includes(marker)) throw new Error(`${provider}: no valid returned result from the real scoped host with selected source marker`);
        const events = await prisma.runEvent.findMany({ where: { runId: run.id }, orderBy: { sequence: 'asc' } });
        if (events.filter((event) => event.eventId === `progress:${progressId}`).length !== 1 || !events.find((event) => event.eventId === `progress:${progressId}`)?.payload.includes(marker)) throw new Error(`${provider}: progress missing marker or not deduplicated`);
        if (events.filter((event) => event.eventId === `report:${resultId}`).length !== 1 || events.filter((event) => event.type === 'result').length !== 1 || events.some((event) => event.type === 'late_result')) throw new Error(`${provider}: result was not recorded exactly once`);
        const calls = observations.filter((item) => item.provider === provider && (item.path === `/api/v1/handoffs/${handoff.id}` || item.path.startsWith(`/api/v1/handoffs/${handoff.id}/`) || item.path.startsWith(`/api/v1/runs/${run.id}/`)));
        const count = (method: string, path: string) => calls.filter((item) => item.method === method && item.path === path && item.status === 200).length;
        if (count('GET', `/api/v1/handoffs/${handoff.id}`) < 2 || count('POST', `/api/v1/handoffs/${handoff.id}/claim`) !== 1 || count('POST', `/api/v1/runs/${run.id}/progress`) < 2 || count('POST', `/api/v1/runs/${run.id}/report`) < 2 || calls.some((item) => item.status >= 400)) throw new Error(`${provider}: actual MCP HTTP trace did not complete the required flow and duplicate retries`);
        const beforeReview = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
        if (beforeReview.status !== 'todo' || beforeReview.revision !== task.revision) throw new Error(`${provider}: host result changed the Todo before review`);
        await owner(`/api/v1/handoffs/${handoff.id}/review`, { runId: run.id, decision: 'accept', expectedTaskRevision: task.revision, completeTask: false });
        const afterReview = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
        if (afterReview.status !== 'todo' || afterReview.revision !== task.revision || await prisma.handoffReview.count({ where: { handoffId: handoff.id, runId: run.id, decision: 'accept' } }) !== 1) throw new Error(`${provider}: review without completeTask unexpectedly changed Todo`);
        const init = output.split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((line) => line?.type === 'system' && line?.subtype === 'init');
        const outcome = { provider, phase: 'manual-handoff', version: versions[provider], explicitSessionResume: true, sessionId, ...(init?.model ? { modelReportedByHost: init.model } : {}), taskId: task.id, handoffId: handoff.id, runId: run.id, selectedMaterialId: material.id, selectedSourceRevision: material.revision, markerReadFromFrozenSource: true, progressDeduplicated: true, resultDeduplicated: true, taskUnchangedBeforeReview: true, ownerAcceptedWithoutCompletingTask: true, eventTypes: events.map((event) => event.type), calls };
        outcomes.push(outcome);
        console.log(JSON.stringify(outcome));
      } finally { await prisma.connection.update({ where: { id: access.id }, data: { status: 'revoked', revision: { increment: 1 } } }); }
    }
    await writeFile(join(evidence, 'summary.json'), JSON.stringify({ outcomes, versions, evidence, mode: process.argv.includes('--handoff-only') ? 'handoff-only' : 'full', recordedAt: new Date().toISOString(), database: process.env.DATABASE_URL, databaseHash: createHash('sha256').update(process.env.DATABASE_URL!).digest('hex') }, null, 2));
    console.log(JSON.stringify({ evidence, passed: outcomes.length }));
  } catch (error) {
    await writeFile(join(evidence, 'failure.json'), JSON.stringify({ outcomes, versions, evidence, observations, recordedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }, null, 2));
    throw new Error(`${error instanceof Error ? error.message : String(error)}; sanitized evidence: ${evidence}`);
  } finally { await prisma.$disconnect(); listener.close(); listener.closeAllConnections(); }
}
if (process.argv.includes('--run')) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
