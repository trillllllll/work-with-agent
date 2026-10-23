import { runtimeEnv } from '../shared/runtime-env.js';
/**
 * wwa-node: the local executor. Pulls jobs from a (possibly remote) WWA server over outbound HTTPS,
 * performs mechanical git steps, launches local AI CLIs through the existing runner supervisor,
 * collects read-only git facts and reports back. It makes no decisions of its own.
 */
import { chmod, mkdir, readFile, readdir, writeFile, statfs, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import os from 'node:os';
import { NODE_PROTOCOL_VERSION, NODE_RESULT_FEATURES, cleanupPayloadSchema, inventoryPayloadSchema, preparePayloadSchema, probePayloadSchema, pullRequestPayloadSchema, pushPayloadSchema, runPayloadSchema, type LeasedJob, type NodeCapabilities } from './protocol.js';
import { assertAllowed, assertManagedWorktree, cleanupWorktrees, collectFacts, createPullRequest, fetchRef, ghAvailable, gitDirs, hooksFingerprint, git, inventory, NodeError, prepareWorktree, probe, pushBranch } from './git.js';
import { createLocalLaunchSpec, localProviders } from './cli.js';

export type NodeConfig = { server: string; token: string; roots: string[]; dataDir: string; maxConcurrent?: number; pollMs?: number; version?: string };
type JournalState = 'running' | 'pending_report' | 'reported' | 'abandoned';
type Journal = { job: LeasedJob; state: JournalState; report?: { ok: boolean; result?: unknown; error?: string }; pre?: { worktree: string; preHead: string | null; hooksBefore: string | null } };
/** Enough of the supervisor for shutdown. Tests inject this; production uses the real module. */
export type NodeRunner = {
  requestCancel(runId: string): Promise<unknown>;
  readReceipt(runId: string): Promise<{ state?: string } | null>;
};
export type NodeAgentHooks = {
  /** Defaults to `process.exit`. Tests pass a fake so a revocation does not kill the runner. */
  exit?: (code: number) => void;
  runner?: NodeRunner;
  /** Runs after the revocation message and before exit 3. The CLI writes `revokedAt` here. */
  onRevoked?: () => Promise<void> | void;
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const REVOKED_CODES = new Set(['NODE_REVOKED', 'NODE_TOKEN_INVALID']);

const USAGE_FEATURE: string = NODE_RESULT_FEATURES[0];
const CAPS_FEATURE: string = NODE_RESULT_FEATURES[1];
function durationMs(createdAt: string | null, endedAt: string | null): number | null {
  if (!createdAt || !endedAt) return null;
  const start = Date.parse(createdAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const ms = Math.max(0, Math.round(end - start));
  return ms <= 2_147_483_647 ? ms : null;
}
export class NodeAgent {
  private active = new Map<string, Promise<void>>();
  private stopped = false;
  private providers: Awaited<ReturnType<typeof localProviders>> | null = null;
  /** Feature ids from the latest lease response. Missing `accepts` means an old server: report the old result shape. */
  private serverAccepts = new Set<string>();
  private gh: boolean | null = null;
  private runnerModule: Promise<typeof import('../runner/supervisor.js')> | null = null;
  private readonly startedAt = new Date().toISOString();
  /** Latest pull or report failure, already token-stripped and capped at 500 characters. */
  private lastError: string | null = null;
  private quiesceTask: Promise<void> | null = null;
  private exited = false;
  constructor(private readonly config: NodeConfig, private readonly http: typeof fetch = fetch, private readonly hooks: NodeAgentHooks = {}) {
    if (!config.roots.length) throw new Error('至少需要一个允许的目录（--roots）');
    // The runner supervisor keeps its control files under WWA_RUNNER_DIR; give it this node's own data directory.
    process.env.WWA_RUNNER_DIR = resolve(config.dataDir, 'runner'); // 0.3 internal compatibility for older runner modules.
    if (process.env.DOVUN_RUNNER_DIR !== undefined) process.env.DOVUN_RUNNER_DIR = resolve(config.dataDir, 'runner');
  }
  private runner() { return (this.runnerModule ??= import('../runner/supervisor.js')); }
  private runnerApi(): Promise<NodeRunner> { return this.hooks.runner ? Promise.resolve(this.hooks.runner) : this.runner(); }
  private exit(code: number) {
    if (this.hooks.exit) { this.hooks.exit(code); return; }
    process.exit(code);
  }
  private journalPath(id: string) { return resolve(this.config.dataDir, 'jobs', `${id.replace(/[^A-Za-z0-9_-]/g, '')}.json`); }
  private async saveJournal(entry: Journal) { await mkdir(resolve(this.config.dataDir, 'jobs'), { recursive: true }); await writeFile(this.journalPath(entry.job.id), JSON.stringify(entry), { mode: 0o600 }); }
  private async journals(): Promise<Journal[]> {
    const dir = resolve(this.config.dataDir, 'jobs');
    const names = await readdir(dir).catch(() => [] as string[]);
    const entries: Journal[] = [];
    for (const name of names.filter((item) => item.endsWith('.json'))) { try { entries.push(JSON.parse(await readFile(resolve(dir, name), 'utf8'))); } catch { /* ignore torn file */ } }
    return entries;
  }
  /** Drop the node token so a failure summary can be stored and printed. */
  private summary(error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    const token = this.config.token;
    return (token ? raw.split(token).join('') : raw).trim().slice(0, 500);
  }
  private rememberError(error: unknown) {
    const text = this.summary(error);
    this.lastError = text || null;
  }
  private async api(path: string, body: unknown) {
    let response: Response;
    try {
      response = await this.http(`${this.config.server.replace(/\/$/, '')}/api/v1/node${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Node ${this.config.token}` }, body: JSON.stringify(body) });
    } catch (error) {
      this.rememberError(error);
      throw error;
    }
    const payload = await response.json().catch(() => null) as { data?: unknown; code?: unknown; error?: unknown } | null;
    const code = typeof payload?.code === 'string' ? payload.code : undefined;
    // A proxy's bare 401 has no WWA code and must keep retrying. Only these two codes mean the token is dead.
    if (response.status === 401 && code && REVOKED_CODES.has(code)) {
      await this.shutdown('revoked');
      throw Object.assign(new Error(`服务端返回 401 ${code}`), { status: 401, code, revoked: true });
    }
    if (!response.ok) {
      const error = Object.assign(new Error(`服务端返回 ${response.status} ${code ?? ''}`), { status: response.status, code });
      this.rememberError(error);
      throw error;
    }
    return payload?.data;
  }
  async capabilities(): Promise<NodeCapabilities> {
    this.providers ??= await localProviders();
    this.gh ??= await ghAvailable();
    // Old servers parse capabilities with .strict(). Send path / managedBy / logPath / lastError / startedAt only after one lease advertised caps_v2.
    const capsV2 = this.serverAccepts.has(CAPS_FEATURE);
    const providers = this.providers.map((item) => {
      const base = { provider: item.provider, available: item.available, version: item.version };
      return capsV2 ? { ...base, path: item.path } : base;
    });
    const body: NodeCapabilities = { protocol: NODE_PROTOCOL_VERSION, version: this.config.version ?? '', platform: `${os.platform()}-${os.arch()}`, providers, maxConcurrent: this.config.maxConcurrent ?? 2, allowedRoots: this.config.roots, freeBytes: await this.freeBytes(), gh: this.gh };
    if (!capsV2) return body;
    const logPath = runtimeEnv('NODE_LOG')?.trim() || null;
    return { ...body, managedBy: runtimeEnv('NODE_MANAGED') === 'desktop' ? 'desktop' : 'cli', logPath: logPath ? logPath.slice(0, 4096) : null, lastError: this.lastError, startedAt: this.startedAt };
  }
  private async freeBytes() {
    try { await mkdir(this.config.dataDir, { recursive: true }); const stats = await statfs(this.config.dataDir); return stats.bavail * stats.bsize; } catch { return null; }
  }

  private open(entry: Journal) { return entry.state !== 'reported' && entry.state !== 'abandoned'; }
  /** Resume jobs from the local journal after a restart: finish observing, then re-send the same report. Abandoned jobs are never reported again. */
  async resume() {
    for (const entry of await this.journals()) {
      if (!this.open(entry)) continue;
      if (!this.active.has(entry.job.id)) this.active.set(entry.job.id, this.execute(entry).finally(() => this.active.delete(entry.job.id)));
    }
  }
  async pollOnce() {
    if (this.stopped) return 0;
    const pending = (await this.journals()).filter((entry) => this.open(entry)).map((entry) => entry.job.id);
    const activeJobIds = [...new Set([...this.active.keys(), ...pending])];
    const max = Math.max(0, (this.config.maxConcurrent ?? 2) - activeJobIds.length);
    const lease = await this.api('/lease', { capabilities: await this.capabilities(), activeJobIds, max }) as { jobs: LeasedJob[]; cancel: string[]; accepts?: unknown; nodeId?: unknown };
    this.serverAccepts = new Set(Array.isArray(lease.accepts) ? lease.accepts.filter((item): item is string => typeof item === 'string') : []);
    if (typeof lease.nodeId === 'string' && lease.nodeId) await this.writeState(lease.nodeId).catch((error) => console.error(`[wwa-node] 无法写入 state.json：${this.summary(error)}`));
    if (this.stopped) return 0;
    for (const id of lease.cancel) { await (await this.runner()).requestCancel(id).catch(() => undefined); }
    for (const job of lease.jobs) {
      const entry: Journal = { job, state: 'running' };
      await this.saveJournal(entry);
      this.active.set(job.id, this.execute(entry).finally(() => this.active.delete(job.id)));
    }
    return lease.jobs.length;
  }
  /** `<dataDir>/state.json` lets the desktop shell recognize this computer. Never written into config.json. */
  private async writeState(nodeId: string) {
    await mkdir(this.config.dataDir, { recursive: true });
    const path = resolve(this.config.dataDir, 'state.json');
    await writeFile(path, JSON.stringify({ nodeId, server: this.config.server, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    await chmod(path, 0o600);
  }
  async idle() { while (this.active.size) await Promise.allSettled([...this.active.values()]); }
  async run() {
    // Lease once first so resumed jobs know which result fields this server accepts (usage_v1).
    try { await this.pollOnce(); } catch (error) { if (this.stopped) return; this.rememberError(error); console.error(`[wwa-node] 拉取失败：${this.summary(error)}`); }
    if (this.stopped) return;
    await this.resume();
    while (!this.stopped) {
      try { await this.pollOnce(); } catch (error) { if (this.stopped) return; this.rememberError(error); console.error(`[wwa-node] 拉取失败：${this.summary(error)}`); }
      if (this.stopped) return;
      await sleep(this.config.pollMs ?? 3000);
    }
  }
  stop() { this.stopped = true; }

  /**
   * `revoked`: stop pulling, cancel local runs, abandon journals, print, exit 3.
   * `signal`: the first three steps only. The caller exits 0 so a desktop SIGTERM can stop the CLIs.
   */
  async shutdown(reason: 'revoked' | 'signal') {
    this.quiesceTask ??= this.quiesce();
    await this.quiesceTask;
    if (reason !== 'revoked' || this.exited) return;
    this.exited = true;
    console.error('[wwa-node] 这台电脑已在 WWA 里被断开/吊销');
    try { await this.hooks.onRevoked?.(); }
    catch (error) { console.error(`[wwa-node] 无法记录吊销状态：${this.summary(error)}`); }
    this.exit(3);
  }
  /** Stop pulling, cancel unfinished runs, and mark their journals abandoned so they are never reported again. */
  private async quiesce() {
    this.stopped = true;
    const runner = await this.runnerApi();
    const waiting: string[] = [];
    for (const entry of await this.journals()) {
      if (!this.open(entry) || entry.job.kind !== 'run') continue;
      await runner.requestCancel(entry.job.id).catch(() => undefined);
      waiting.push(entry.job.id);
    }
    const pending = new Set(waiting);
    const deadline = Date.now() + 5_000;
    while (pending.size && Date.now() < deadline) {
      for (const id of [...pending]) {
        const receipt = await runner.readReceipt(id).catch(() => null);
        if (receipt?.state === 'ended') pending.delete(id);
      }
      if (pending.size) await sleep(50);
    }
    for (const entry of await this.journals()) {
      if (!this.open(entry)) continue;
      entry.state = 'abandoned';
      await this.saveJournal(entry);
    }
  }

  private async execute(entry: Journal) {
    if (!this.open(entry) || this.stopped) return;
    if (!entry.report) {
      try { entry.report = { ok: true, result: await this.perform(entry) }; }
      catch (error) { entry.report = { ok: false, error: `${error instanceof NodeError ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)}`.slice(0, 20_000) }; }
      if (this.stopped) return;
      entry.state = 'pending_report';
      await this.saveJournal(entry);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      if (this.stopped || entry.state === 'abandoned') return;
      try {
        await this.api(`/jobs/${encodeURIComponent(entry.job.id)}/result`, { leaseToken: entry.job.leaseToken, ...entry.report });
        if (this.stopped) return;
        entry.state = 'reported'; await this.saveJournal(entry); return;
      } catch (error) {
        // Revocation already ran shutdown() inside api(); do not report or retry.
        if (this.stopped) return;
        const status = (error as { status?: number }).status;
        if (status && [403, 404, 409].includes(status)) { entry.state = 'reported'; await this.saveJournal(entry); return; }
        this.rememberError(error);
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      }
    }
    // Still pending: the next resume()/poll keeps it in activeJobIds so the lease stays alive, and retries.
  }
  private async progress(job: LeasedJob, message: string) { await this.api(`/jobs/${encodeURIComponent(job.id)}/progress`, { leaseToken: job.leaseToken, message }).catch(() => undefined); }

  private async perform(entry: Journal): Promise<unknown> {
    const { job } = entry;
    if (job.kind === 'probe') return probe(probePayloadSchema.parse(job.payload).path, this.config.roots);
    if (job.kind === 'prepare') {
      const payload = preparePayloadSchema.parse(job.payload);
      const repo = await assertAllowed(payload.repoPath, this.config.roots);
      return prepareWorktree(repo, this.config.dataDir, payload);
    }
    if (job.kind === 'push') {
      const payload = pushPayloadSchema.parse(job.payload);
      return pushBranch(await assertManagedWorktree(this.config.dataDir, payload.worktree), payload.branch, payload.remote);
    }
    if (job.kind === 'inventory') { inventoryPayloadSchema.parse(job.payload); return inventory(this.config.dataDir, await this.freeBytes()); }
    if (job.kind === 'cleanup') {
      const payload = cleanupPayloadSchema.parse(job.payload);
      const outcome = await cleanupWorktrees(this.config.dataDir, payload.worktrees, payload.deleteBranches);
      return { ...outcome, inventory: await inventory(this.config.dataDir, await this.freeBytes()) };
    }
    if (job.kind === 'pull_request') {
      const payload = pullRequestPayloadSchema.parse(job.payload);
      return createPullRequest(await assertManagedWorktree(this.config.dataDir, payload.worktree), payload);
    }
    if (job.kind === 'run') return this.performRun(entry);
    throw new NodeError('UNKNOWN_JOB', `未知任务类型：${job.kind}`);
  }

  private async performRun(entry: Journal) {
    const payload = runPayloadSchema.parse(entry.job.payload);
    const repo = await assertAllowed(payload.repoPath, this.config.roots);
    if (!entry.pre) {
      const worktree = 'existing' in payload.worktree
        ? await assertManagedWorktree(this.config.dataDir, payload.worktree.existing)
        : (await prepareWorktree(repo, this.config.dataDir, payload.worktree.create)).worktree;
      for (const spec of payload.fetch) await fetchRef(repo, spec);
      entry.pre = { worktree, preHead: (await git(worktree, ['rev-parse', 'HEAD']).catch(() => '')) || null, hooksBefore: await hooksFingerprint(worktree).catch(() => null) };
      await this.saveJournal(entry);
    }
    const { worktree, preHead, hooksBefore } = entry.pre;
    const runner = await this.runner();
    const controlDir = runner.controlDirectory(entry.job.id);
    const launched = await access(resolve(controlDir, 'launch.lock')).then(() => true, () => false);
    if (!launched) {
      const spec = await createLocalLaunchSpec({ runId: entry.job.id, provider: payload.provider, permissions: payload.permissions, cwd: worktree, controlDir, prompt: payload.prompt, gitWrite: payload.gitWrite ? await gitDirs(worktree) : undefined });
      await runner.launchSupervisor(spec);
      await this.progress(entry.job, `已在本机启动 ${payload.provider}${payload.gitWrite ? '（允许写 git）' : ''}`);
    }
    const observation = await this.watch(entry.job.id);
    const { readRunnerOutput } = await import('../runner/adapters.js');
    const output = await readRunnerOutput(controlDir, payload.provider);
    const stderrTail = (await readFile(resolve(controlDir, 'stderr.log'), 'utf8').catch(() => '')).slice(-8000);
    const facts = await collectFacts(worktree, { base: payload.expect.base ?? preHead, includes: payload.expect.includes, hooksBefore, preHead });
    const error = observation.error ?? output.error ?? (output.result ? null : `CLI 结束但没有有效结果（退出码 ${observation.exitCode ?? '未知'}）`);
    // Mechanical transfer for cross-machine rounds: push the worktree branch (never forced) when it has commits and is clean.
    let published: { remote: string; branch: string; head: string } | null = null; let publishError: string | null = null;
    if (payload.publish && facts.branch && facts.head && facts.head !== facts.base && !facts.status.length) {
      try { const pushed = await pushBranch(worktree, facts.branch, payload.publish.remote); published = { remote: payload.publish.remote, branch: facts.branch, head: pushed.head }; }
      catch (failure) { publishError = (failure as Error).message.slice(-20_000); }
    }
    const acceptsUsage = this.serverAccepts.has(USAGE_FEATURE);
    // Old servers reject unknown keys. Strip usage fields unless this lease advertised usage_v1.
    const { diff: _diff, ...factsWithoutDiff } = facts;
    const reportedFacts = acceptsUsage ? facts : factsWithoutDiff;
    const base = { worktree, sessionId: output.sessionId ?? null, result: output.result ?? null, error: error ? error.slice(0, 20_000) : null, stderrTail, facts: reportedFacts, preHead, published, publishError };
    if (!acceptsUsage) return base;
    const providers = (await this.capabilities()).providers;
    const version = providers.find((item) => item.provider === payload.provider)?.version?.trim() ?? '';
    const parsed = output.usage;
    return {
      ...base,
      exitCode: observation.exitCode,
      usage: {
        model: parsed?.model ?? null,
        inputTokens: parsed?.inputTokens ?? null,
        cachedInputTokens: parsed?.cachedInputTokens ?? null,
        outputTokens: parsed?.outputTokens ?? null,
        costUsd: parsed?.costUsd ?? null,
        numTurns: parsed?.numTurns ?? null,
        cliDurationMs: parsed?.cliDurationMs ?? null,
        runDurationMs: durationMs(observation.createdAt, observation.endedAt),
        cliVersion: version ? version.slice(0, 200) : null,
        ...(parsed ? { raw: parsed.raw } : {}),
      },
    };
  }

  private async watch(runId: string): Promise<{ exitCode: number | null; error: string | null; createdAt: string | null; endedAt: string | null }> {
    const runner = await this.runner();
    const startedAt = Date.now();
    while (true) {
      const receipt = await runner.readReceipt(runId);
      if (receipt?.state === 'ended') return { exitCode: receipt.exitCode ?? null, error: receipt.cancelled ? '已取消' : receipt.error ?? null, createdAt: receipt.createdAt ?? null, endedAt: new Date().toISOString() };
      const beat = receipt ? Date.parse(receipt.heartbeatAt) : startedAt;
      if (Date.now() - beat > 60_000) return { exitCode: null, error: '本机运行监督进程失联（心跳超过 60 秒）', createdAt: receipt?.createdAt ?? null, endedAt: null };
      await sleep(1000);
    }
  }
}
