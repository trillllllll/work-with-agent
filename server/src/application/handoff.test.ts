import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../infrastructure/prisma.js';
import { HandoffService } from './handoff.js';
import { RunService } from './runs.js';
import { actorFromConnection, ownerActor } from './security.js';
import { digest } from '../runner/workspaces.js';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { git, inside } from '../runner/workspaces.js';
import { readReceipt } from '../runner/supervisor.js';
import { CommandService } from './commands.js';
import { registerKnowledgeCommands } from './knowledge.js';

const handoffs = new HandoffService(); const runs = new RunService();
const tasks: string[] = []; const connections: string[] = []; const ids: string[] = [];
let localRoot: string | undefined;
const previousRunner = process.env.WWA_RUNNER_DIR; const previousCli = process.env.WWA_CODEX_BIN;
beforeAll(() => registerKnowledgeCommands());
async function setup() {
  const task = await prisma.task.create({ data: { title: '交接测试', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }); tasks.push(task.id);
  const connection = await prisma.connection.create({ data: { name: '宿主测试', host: 'codex', tokenHash: digest(randomUUID()), topicIds: '[]', includeInbox: true, autoActions: '[]', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }); connections.push(connection.id);
  const handoff = await handoffs.prepare(ownerActor, { taskId: task.id, expectedTaskRevision: task.revision, provider: 'codex', instruction: '完成文本分析', materialIds: [], memoryIds: [] }); ids.push(handoff.id);
  return { task, handoff, actor: actorFromConnection(connection) };
}
afterAll(async () => {
  const runIds = (await prisma.run.findMany({ where: { handoffId: { in: ids } } })).map((run) => run.id);
  await prisma.codeApplication.deleteMany({ where: { runId: { in: runIds } } });
  const organizationIds = runIds.map((id) => `run-${id}-candidates`);
  await prisma.proposal.deleteMany({ where: { actorId: { in: organizationIds.map((id) => `organization:${id}`) } } });
  await prisma.requestReceipt.deleteMany({ where: { actorId: { in: organizationIds.map((id) => `organization:${id}`) } } });
  await prisma.organizationRequest.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.runEvent.deleteMany({ where: { runId: { in: runIds } } }); await prisma.artifact.deleteMany({ where: { runId: { in: runIds } } }); await prisma.handoffReview.deleteMany({ where: { handoffId: { in: ids } } }); await prisma.run.deleteMany({ where: { id: { in: runIds } } }); await prisma.handoff.deleteMany({ where: { id: { in: ids } } });
  await prisma.changeRecord.deleteMany({ where: { entityId: { in: [...tasks, ...ids, ...runIds] } } }); await prisma.taskTopicAssignment.deleteMany({ where: { taskId: { in: tasks } } }); await prisma.task.updateMany({ where: { id: { in: tasks } }, data: { parentId: null } }); await prisma.task.deleteMany({ where: { id: { in: tasks } } }); await prisma.connection.deleteMany({ where: { id: { in: connections } } });
  if (previousRunner) process.env.WWA_RUNNER_DIR = previousRunner; else delete process.env.WWA_RUNNER_DIR;
  if (previousCli) process.env.WWA_CODEX_BIN = previousCli; else delete process.env.WWA_CODEX_BIN;
  if (localRoot && inside(tmpdir(), localRoot)) await rm(localRoot, { recursive: true, force: true });
});
const result = { outcome: 'ready_for_review', summary: '产物已准备好', questions: [], artifacts: [{ name: '分析', kind: 'text', content: '结果' }], checks: [] };
describe('Handoff, immutable Run result and separate review', () => {
  it('freezes context, binds claims to a connection, deduplicates results and completes only through owner review', async () => {
    const { task, handoff, actor } = await setup();
    const claimed = await handoffs.claim(actor, handoff.id, { requestId: randomUUID() });
    expect(claimed.claimToken).toBeTruthy();
    await expect(runs.report(ownerActor, claimed.run.id, { claimToken: claimed.claimToken, eventId: 'result-1', result })).rejects.toMatchObject({ code: 'RUN_TOKEN_INVALID' });
    await runs.report(actor, claimed.run.id, { claimToken: claimed.claimToken, eventId: 'result-1', result, externalSessionId: 'session-explicit' });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('todo');
    expect((await runs.report(actor, claimed.run.id, { claimToken: claimed.claimToken, eventId: 'result-1', result })).replay).toBe(true);
    await expect(runs.report(actor, claimed.run.id, { claimToken: claimed.claimToken, eventId: 'result-2', result: { ...result, summary: '覆盖' } })).rejects.toMatchObject({ code: 'RESULT_CONFLICT' });
    expect(await prisma.artifact.count({ where: { runId: claimed.run.id } })).toBe(1);
    await handoffs.review(ownerActor, handoff.id, { runId: claimed.run.id, decision: 'accept', expectedTaskRevision: task.revision, completeTask: true });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('done');
  });
  it('rejects stale acceptance and refuses cancelled or revoked reports without applying them', async () => {
    const { task, handoff, actor } = await setup();
    const claimed = await handoffs.claim(actor, handoff.id, { requestId: randomUUID() });
    await runs.report(actor, claimed.run.id, { claimToken: claimed.claimToken, eventId: 'done', result });
    await prisma.task.update({ where: { id: task.id }, data: { title: '后续修改', revision: { increment: 1 } } });
    await expect(handoffs.review(ownerActor, handoff.id, { runId: claimed.run.id, decision: 'accept', expectedTaskRevision: task.revision, completeTask: true })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const next = await setup(); const nextClaim = await handoffs.claim(next.actor, next.handoff.id, { requestId: randomUUID() });
    await handoffs.cancel(ownerActor, next.handoff.id);
    expect((await runs.report(next.actor, nextClaim.run.id, { claimToken: nextClaim.claimToken, eventId: 'late', result })).ignored).toBe(true);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: nextClaim.run.id } })).resultJson).toBeNull();
    await prisma.connection.update({ where: { id: next.actor.connectionId }, data: { status: 'revoked' } });
    await expect(runs.report(next.actor, nextClaim.run.id, { claimToken: nextClaim.claimToken, eventId: 'late2', result })).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
  });
  it('versions editable prepared input, freezes it at claim, and only proposes reported modifications', async () => {
    const { task, handoff, actor } = await setup();
    const revised = await handoffs.revise(ownerActor, handoff.id, { expectedRevision: 1, expectedTaskRevision: task.revision, instruction: '新版交接' });
    expect(revised.revision).toBe(2); expect(revised.inputHash).not.toBe(handoff.inputHash);
    await expect(handoffs.revise(ownerActor, handoff.id, { expectedRevision: 1, expectedTaskRevision: task.revision, instruction: '过期' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const claimed = await handoffs.claim(actor, handoff.id, { requestId: randomUUID() });
    await expect(handoffs.revise(ownerActor, handoff.id, { expectedRevision: 3, expectedTaskRevision: task.revision, instruction: '领取后修改' })).rejects.toMatchObject({ code: 'HANDOFF_FROZEN' });
    const proposed = { ...result, unfinished: ['等待用户采纳'], proposedCommands: [{ kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { description: '候选修改' } }] };
    await runs.report(actor, claimed.run.id, { claimToken: claimed.claimToken, eventId: 'proposal-result', result: proposed });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).description).toBe('');
    const candidate = await runs.prepareProposals(ownerActor, claimed.run.id);
    expect(candidate.proposalIds).toHaveLength(1);
    expect((await new CommandService().get(ownerActor, candidate.proposalIds[0])).status).toBe('pending');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).description).toBe('');
    expect((await runs.prepareProposals(ownerActor, claimed.run.id)).proposalIds).toEqual(candidate.proposalIds);
  });
  it('binds manual claims to the chosen provider and accepts the Claude Code host alias', async () => {
    const initial = await setup();
    const claude = await handoffs.prepare(ownerActor, { taskId: initial.task.id, expectedTaskRevision: initial.task.revision, instruction: 'Claude交接', provider: 'claude', materialIds: [], memoryIds: [] }); ids.push(claude.id);
    await expect(handoffs.claim(initial.actor, claude.id, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'HOST_MISMATCH', status: 403 });
    await prisma.connection.update({ where: { id: initial.actor.connectionId }, data: { host: 'Claude Code' } });
    expect((await handoffs.claim(initial.actor, claude.id, { requestId: randomUUID() })).claimToken).toBeTruthy();
  });
  it('checks the complete child revision set before completing a family on acceptance', async () => {
    const initial = await setup();
    const child = await prisma.task.create({ data: { title: '子任务', parentId: initial.task.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }); tasks.push(child.id);
    const claimed = await handoffs.claim(initial.actor, initial.handoff.id, { requestId: randomUUID() });
    await runs.report(initial.actor, claimed.run.id, { claimToken: claimed.claimToken, eventId: 'ready', result });
    const input = { runId: claimed.run.id, decision: 'accept', expectedTaskRevision: initial.task.revision, completeTask: true, completeChildren: true };
    await expect(handoffs.review(ownerActor, initial.handoff.id, input)).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED', status: 428 });
    await prisma.task.update({ where: { id: child.id }, data: { description: '新修改', revision: { increment: 1 } } });
    await expect(handoffs.review(ownerActor, initial.handoff.id, { ...input, expectedChildRevisions: { [child.id]: 1 } })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: child.id } })).status).toBe('todo');
    await handoffs.review(ownerActor, initial.handoff.id, { ...input, expectedChildRevisions: { [child.id]: 2 } });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: child.id } })).status).toBe('done');
  });
  it('collects a durable completion after API restart, preserves the completion/cancel race and starts continuation as a new run', async () => {
    localRoot ??= await mkdtemp(join(tmpdir(), 'wwa-handoff-local-')); process.env.WWA_RUNNER_DIR = resolve(localRoot, 'runner');
    const source = resolve(localRoot, 'source'); await mkdir(source);
    await git(source, ['init']); await git(source, ['config', 'core.autocrlf', 'false']); await git(source, ['config', 'user.email', 'test@example.invalid']); await git(source, ['config', 'user.name', 'Test']); await writeFile(resolve(source, 'base.txt'), 'base\n'); await git(source, ['add', '.']); await git(source, ['commit', '-m', 'base']);
    const fakeCli = resolve(localRoot, 'fixture-cli.cjs');
    await writeFile(fakeCli, `require('fs').writeFileSync('result.txt','controlled fixture result\\n');for(const event of [{type:'thread.started',thread_id:'explicit-fixture-session'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(${JSON.stringify({ ...result, artifacts: [] })})}},{type:'turn.completed'}]) console.log(JSON.stringify(event));`);
    process.env.WWA_CODEX_BIN = fakeCli;
    const initial = await setup();
    const prepared = await handoffs.prepare(ownerActor, { taskId: initial.task.id, expectedTaskRevision: 1, instruction: 'Controlled fixture', provider: 'codex', mode: 'local', materialIds: [], memoryIds: [] }); ids.push(prepared.id);
    const started = await runs.start(ownerActor, prepared.id, { sourcePath: source, requestId: randomUUID() });
    async function waitEnded(id: string) { for (let attempt = 0; attempt < 100; attempt++) { if ((await readReceipt(id))?.state === 'ended') return; await new Promise((done) => setTimeout(done, 100)); } throw new Error('Fixture did not end'); }
    await waitEnded(started.id);
    // A new application service sees only persisted DB state + supervisor receipt.
    const recovered = await new RunService().cancel(ownerActor, started.id);
    expect(recovered.status).toBe('returned');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: initial.task.id } })).status).toBe('todo');
    const requestId = randomUUID();
    const continued = await runs.continue(ownerActor, started.id, { answer: '检查一遍', requestId });
    expect(continued.id).not.toBe(started.id); expect(continued.continuationOf).toBe(started.id); expect(continued.externalSessionId).toBe('explicit-fixture-session');
    await waitEnded(continued.id); await new RunService().reconcile(ownerActor, continued.id);
    const replay = await runs.continue(ownerActor, started.id, { answer: '检查一遍', requestId }); expect(replay.id).toBe(continued.id);
    const artifact = await prisma.artifact.findFirstOrThrow({ where: { runId: continued.id, kind: 'git_patch' } });
    const expectedHead = await git(source, ['rev-parse', 'HEAD']); const applyRequest = { artifactId: artifact.id, expectedHead, requestId: randomUUID() };
    const applied = await runs.apply(ownerActor, continued.id, applyRequest); expect(applied.status).toBe('applied');
    expect((await runs.apply(ownerActor, continued.id, applyRequest)).id).toBe(applied.id);
    expect(await readFile(resolve(source, 'result.txt'), 'utf8')).toBe('controlled fixture result\n');
  }, 20000);
  it('records a preparation failure, accepts corrected selected inputs and retries as a new native session', async () => {
    localRoot ??= await mkdtemp(join(tmpdir(), 'wwa-handoff-local-')); process.env.WWA_RUNNER_DIR = resolve(localRoot, 'runner');
    const source = resolve(localRoot, 'selected-retry-source'); await mkdir(resolve(source, 'notes'), { recursive: true }); await writeFile(resolve(source, 'notes', 'input.txt'), 'frozen input'); await writeFile(resolve(source, 'unselected.txt'), 'excluded');
    const cli = resolve(localRoot, 'selected-retry-cli.cjs');
    await writeFile(cli, `if(require('fs').readFileSync('notes/input.txt','utf8')!=='frozen input'||require('fs').existsSync('unselected.txt'))process.exit(3);for(const event of [{type:'thread.started',thread_id:'fresh-retry-session'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(${JSON.stringify({ ...result, artifacts: [] })})}}])console.log(JSON.stringify(event));`); process.env.WWA_CODEX_BIN = cli;
    const initial = await setup(); const prepared = await handoffs.prepare(ownerActor, { taskId: initial.task.id, expectedTaskRevision: 1, instruction: 'Read selected files', provider: 'codex', mode: 'local', materialIds: [], memoryIds: [] }); ids.push(prepared.id);
    const requestId = randomUUID();
    await expect(runs.start(ownerActor, prepared.id, { sourcePath: source, inputFiles: ['./missing.txt'], requestId })).rejects.toMatchObject({ code: 'INPUT_FILE_NOT_FOUND' });
    const failed = await prisma.run.findFirstOrThrow({ where: { handoffId: prepared.id } }); expect(failed.status).toBe('failed'); expect(failed.externalSessionId).toBeNull();
    expect(JSON.parse(failed.configJson)).toMatchObject({ sourcePath: source, inputFiles: ['missing.txt'] });
    expect(JSON.parse((await prisma.runEvent.findFirstOrThrow({ where: { runId: failed.id, type: 'launch_failed' } })).payload)).toMatchObject({ code: 'INPUT_FILE_NOT_FOUND', inputFiles: ['missing.txt'] });
    expect((await runs.start(ownerActor, prepared.id, { sourcePath: source, inputFiles: ['missing.txt'], requestId })).id).toBe(failed.id);
    await expect(runs.start(ownerActor, prepared.id, { sourcePath: source, inputFiles: ['notes/input.txt'], requestId })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await prisma.run.update({ where: { id: failed.id }, data: { status: 'unknown' } });
    await expect(runs.continue(ownerActor, failed.id, { answer: 'retry', requestId: randomUUID() })).rejects.toMatchObject({ code: 'RUN_NOT_CONTINUABLE' });
    await prisma.run.update({ where: { id: failed.id }, data: { status: 'failed' } });
    const retry = await runs.continue(ownerActor, failed.id, { answer: '修正输入并重试', sourcePath: source, inputFiles: ['./notes\\input.txt'], requestId: randomUUID() });
    expect(retry.id).not.toBe(failed.id); expect(retry.continuationOf).toBe(failed.id); expect(retry.externalSessionId).toBeNull();
    const workspace = JSON.parse((await prisma.run.findUniqueOrThrow({ where: { id: retry.id } })).workspaceJson);
    expect(workspace.inputs).toEqual([{ path: 'notes/input.txt', size: 12, hash: digest('frozen input') }]);
    const launch = JSON.parse(await readFile(resolve(localRoot, 'runner', 'runs', retry.id, 'launch.json'), 'utf8')); expect(launch.args).not.toContain('resume'); expect(launch.args).not.toContain('--last'); expect(launch.prompt).toContain(digest('frozen input'));
    async function finish(id: string) { for (let attempt = 0; attempt < 150; attempt++) { if ((await readReceipt(id))?.state === 'ended') return runs.reconcile(ownerActor, id); await new Promise((done) => setTimeout(done, 100)); } throw new Error('Fixture did not end'); }
    expect((await finish(retry.id)).status).toBe('returned');
    await expect(runs.continue(ownerActor, retry.id, { answer: '不能替换输入', inputFiles: [], requestId: randomUUID() })).rejects.toMatchObject({ code: 'WORKSPACE_INPUTS_FROZEN' });
    await writeFile(resolve(source, 'notes', 'input.txt'), 'source changed');
    const continuation = await runs.continue(ownerActor, retry.id, { answer: '复核原副本', requestId: randomUUID() });
    const continuedWorkspace = JSON.parse((await prisma.run.findUniqueOrThrow({ where: { id: continuation.id } })).workspaceJson);
    expect(continuedWorkspace).toEqual(workspace); expect(continuation.externalSessionId).toBe('fresh-retry-session'); expect((await finish(continuation.id)).status).toBe('returned');
  }, 25000);
  it('reuses a prepared workspace after a missing CLI failure without guessing an external session', async () => {
    localRoot ??= await mkdtemp(join(tmpdir(), 'wwa-handoff-local-')); process.env.WWA_RUNNER_DIR = resolve(localRoot, 'runner');
    const source = resolve(localRoot, 'cli-retry-source'); await mkdir(source); process.env.WWA_CODEX_BIN = resolve(localRoot, 'missing-cli.cjs');
    const initial = await setup(); const prepared = await handoffs.prepare(ownerActor, { taskId: initial.task.id, expectedTaskRevision: 1, instruction: 'Retry CLI', provider: 'codex', mode: 'local', materialIds: [], memoryIds: [] }); ids.push(prepared.id);
    await expect(runs.start(ownerActor, prepared.id, { sourcePath: source, requestId: randomUUID() })).rejects.toMatchObject({ code: 'CLI_NOT_FOUND' });
    const failed = await prisma.run.findFirstOrThrow({ where: { handoffId: prepared.id } }); expect(failed.externalSessionId).toBeNull(); expect(JSON.parse(failed.workspaceJson).workPath).toBeTruthy();
    const cli = resolve(localRoot, 'cli-retry.cjs'); await writeFile(cli, `for(const event of [{type:'thread.started',thread_id:'new-native-session'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(${JSON.stringify({ ...result, artifacts: [] })})}}])console.log(JSON.stringify(event));`); process.env.WWA_CODEX_BIN = cli;
    const retry = await runs.continue(ownerActor, failed.id, { answer: 'CLI现已配置', requestId: randomUUID() });
    expect(retry.continuationOf).toBe(failed.id); expect(retry.externalSessionId).toBeNull(); expect((await prisma.run.findUniqueOrThrow({ where: { id: retry.id } })).workspaceJson).toBe(failed.workspaceJson);
    const launch = JSON.parse(await readFile(resolve(localRoot, 'runner', 'runs', retry.id, 'launch.json'), 'utf8')); expect(launch.args).not.toContain('resume'); expect(launch.args).not.toContain('--last');
    for (let attempt = 0; attempt < 150; attempt++) { if ((await readReceipt(retry.id))?.state === 'ended') break; await new Promise((done) => setTimeout(done, 100)); }
    expect((await runs.reconcile(ownerActor, retry.id)).status).toBe('returned');
  }, 20000);
});
