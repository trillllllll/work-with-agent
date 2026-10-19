/**
 * wwa-node: the local executor. Pulls jobs from a (possibly remote) WWA server over outbound HTTPS,
 * performs mechanical git steps, launches local AI CLIs through the existing runner supervisor,
 * collects read-only git facts and reports back. It makes no decisions of its own.
 */
import { mkdir, readFile, readdir, writeFile, statfs, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import os from 'node:os';
import { NODE_PROTOCOL_VERSION, preparePayloadSchema, probePayloadSchema, pushPayloadSchema, runPayloadSchema, type LeasedJob, type NodeCapabilities } from './protocol.js';
import { assertAllowed, assertManagedWorktree, collectFacts, gitDirs, hooksFingerprint, git, NodeError, prepareWorktree, probe, pushBranch } from './git.js';
import { createLocalLaunchSpec, localProviders } from './cli.js';

export type NodeConfig = { server: string; token: string; roots: string[]; dataDir: string; maxConcurrent?: number; pollMs?: number; version?: string };
type Journal = { job: LeasedJob; state: 'running' | 'pending_report' | 'reported'; report?: { ok: boolean; result?: unknown; error?: string }; pre?: { worktree: string; preHead: string | null; hooksBefore: string | null } };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export class NodeAgent {
  private active = new Map<string, Promise<void>>();
  private stopped = false;
  private providers: NodeCapabilities['providers'] | null = null;
  private runnerModule: Promise<typeof import('../runner/supervisor.js')> | null = null;
  constructor(private readonly config: NodeConfig, private readonly http: typeof fetch = fetch) {
    if (!config.roots.length) throw new Error('至少需要一个允许的目录（--roots）');
    // The runner supervisor keeps its control files under WWA_RUNNER_DIR; give it this node's own data directory.
    process.env.WWA_RUNNER_DIR = resolve(config.dataDir, 'runner');
  }
  private runner() { return (this.runnerModule ??= import('../runner/supervisor.js')); }
  private journalPath(id: string) { return resolve(this.config.dataDir, 'jobs', `${id.replace(/[^A-Za-z0-9_-]/g, '')}.json`); }
  private async saveJournal(entry: Journal) { await mkdir(resolve(this.config.dataDir, 'jobs'), { recursive: true }); await writeFile(this.journalPath(entry.job.id), JSON.stringify(entry), { mode: 0o600 }); }
  private async journals(): Promise<Journal[]> {
    const dir = resolve(this.config.dataDir, 'jobs');
    const names = await readdir(dir).catch(() => [] as string[]);
    const entries: Journal[] = [];
    for (const name of names.filter((item) => item.endsWith('.json'))) { try { entries.push(JSON.parse(await readFile(resolve(dir, name), 'utf8'))); } catch { /* ignore torn file */ } }
    return entries;
  }
  private async api(path: string, body: unknown) {
    const response = await this.http(`${this.config.server.replace(/\/$/, '')}/api/v1/node${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Node ${this.config.token}` }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null) as { data?: unknown; code?: string; error?: unknown } | null;
    if (!response.ok) throw Object.assign(new Error(`服务端返回 ${response.status} ${payload?.code ?? ''}`), { status: response.status, code: payload?.code });
    return payload?.data;
  }
  async capabilities(): Promise<NodeCapabilities> {
    this.providers ??= await localProviders();
    let freeBytes: number | null = null;
    try { await mkdir(this.config.dataDir, { recursive: true }); const stats = await statfs(this.config.dataDir); freeBytes = stats.bavail * stats.bsize; } catch { /* unknown */ }
    return { protocol: NODE_PROTOCOL_VERSION, version: this.config.version ?? '', platform: `${os.platform()}-${os.arch()}`, providers: this.providers, maxConcurrent: this.config.maxConcurrent ?? 2, allowedRoots: this.config.roots, freeBytes };
  }

  /** Resume jobs from the local journal after a restart: finish observing, then re-send the same report. */
  async resume() {
    for (const entry of await this.journals()) {
      if (entry.state === 'reported') continue;
      if (!this.active.has(entry.job.id)) this.active.set(entry.job.id, this.execute(entry).finally(() => this.active.delete(entry.job.id)));
    }
  }
  async pollOnce() {
    const pending = (await this.journals()).filter((entry) => entry.state !== 'reported').map((entry) => entry.job.id);
    const activeJobIds = [...new Set([...this.active.keys(), ...pending])];
    const max = Math.max(0, (this.config.maxConcurrent ?? 2) - activeJobIds.length);
    const lease = await this.api('/lease', { capabilities: await this.capabilities(), activeJobIds, max }) as { jobs: LeasedJob[]; cancel: string[] };
    for (const id of lease.cancel) { await (await this.runner()).requestCancel(id).catch(() => undefined); }
    for (const job of lease.jobs) {
      const entry: Journal = { job, state: 'running' };
      await this.saveJournal(entry);
      this.active.set(job.id, this.execute(entry).finally(() => this.active.delete(job.id)));
    }
    return lease.jobs.length;
  }
  async idle() { while (this.active.size) await Promise.allSettled([...this.active.values()]); }
  async run() {
    await this.resume();
    while (!this.stopped) {
      try { await this.pollOnce(); } catch (error) { console.error(`[wwa-node] 拉取失败：${(error as Error).message}`); }
      await sleep(this.config.pollMs ?? 3000);
    }
  }
  stop() { this.stopped = true; }

  private async execute(entry: Journal) {
    if (!entry.report) {
      try { entry.report = { ok: true, result: await this.perform(entry) }; }
      catch (error) { entry.report = { ok: false, error: `${error instanceof NodeError ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)}`.slice(0, 20_000) }; }
      entry.state = 'pending_report';
      await this.saveJournal(entry);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.api(`/jobs/${encodeURIComponent(entry.job.id)}/result`, { leaseToken: entry.job.leaseToken, ...entry.report });
        entry.state = 'reported'; await this.saveJournal(entry); return;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status && [403, 404, 409].includes(status)) { entry.state = 'reported'; await this.saveJournal(entry); return; }
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
    return { worktree, sessionId: output.sessionId ?? null, result: output.result ?? null, error: error ? error.slice(0, 20_000) : null, stderrTail, facts, preHead };
  }

  private async watch(runId: string): Promise<{ exitCode: number | null; error: string | null }> {
    const runner = await this.runner();
    const startedAt = Date.now();
    while (true) {
      const receipt = await runner.readReceipt(runId);
      if (receipt?.state === 'ended') return { exitCode: receipt.exitCode ?? null, error: receipt.cancelled ? '已取消' : receipt.error ?? null };
      const beat = receipt ? Date.parse(receipt.heartbeatAt) : startedAt;
      if (Date.now() - beat > 60_000) return { exitCode: null, error: '本机运行监督进程失联（心跳超过 60 秒）' };
      await sleep(1000);
    }
  }
}
