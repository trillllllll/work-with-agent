import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import ownerRequest from './test-auth.js';
import { aiHistory, orchestrationFeed } from './application/orchestration/history.js';

const owner = () => ownerRequest(app);
const stamp = `history-${Date.now()}`;
const ids: { tasks: string[]; orchestrations: string[]; projects: string[]; nodes: string[]; handoffs: string[]; runs: string[] } = { tasks: [], orchestrations: [], projects: [], nodes: [], handoffs: [], runs: [] };
const grant = JSON.stringify({ provider: 'codex', maxParallel: 2, allowShell: true });
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

function snapshot(main: { id: string; title: string }, subtasks: Array<{ id: string; title: string }>) {
  return JSON.stringify({ main: { id: main.id, title: main.title, description: '' }, subtasks: subtasks.map((task, index) => ({ id: task.id, title: task.title, description: '', sortOrder: index, revision: 1 })) });
}
function runJson(input: { commits?: Array<{ sha: string; subject: string }>; checks?: Array<{ name: string; passed: boolean }>; leak?: string }) {
  return JSON.stringify({ ok: true, result: { facts: { commits: input.commits ?? [] }, result: { checks: input.checks ?? [] }, ...(input.leak ? { leak: input.leak } : {}) }, error: null });
}

let mainId = '';
let subId = '';
let otherId = '';
let projectP = '';
let projectQ = '';

beforeAll(async () => {
  const now = '2026-10-01T00:00:00.000Z';
  const node = await prisma.agentNode.create({ data: { name: 'Node One', tokenHash: `${stamp}-node`, createdAt: now, updatedAt: now } });
  ids.nodes.push(node.id);
  const project = await prisma.project.create({ data: { name: 'Project P', createdAt: now, updatedAt: now } });
  const foreignProject = await prisma.project.create({ data: { name: 'Project Q', createdAt: now, updatedAt: now } });
  ids.projects.push(project.id, foreignProject.id);
  projectP = project.id;
  projectQ = foreignProject.id;
  const main = await prisma.task.create({ data: { title: 'History main', createdAt: now, updatedAt: now } });
  const sub = await prisma.task.create({ data: { title: 'History sub', parentId: main.id, createdAt: now, updatedAt: now } });
  const other = await prisma.task.create({ data: { title: 'History other', parentId: main.id, createdAt: now, updatedAt: now } });
  const runningTask = await prisma.task.create({ data: { title: 'History running', createdAt: now, updatedAt: now } });
  const draftTask = await prisma.task.create({ data: { title: 'History draft', createdAt: now, updatedAt: now } });
  const foreignTask = await prisma.task.create({ data: { title: 'History foreign', createdAt: now, updatedAt: now } });
  ids.tasks.push(sub.id, other.id, main.id, runningTask.id, draftTask.id, foreignTask.id);
  mainId = main.id;
  subId = sub.id;
  otherId = other.id;
  const snap = snapshot(main, [sub, other]);

  const round1 = await prisma.orchestration.create({ data: { taskId: main.id, round: 1, status: 'awaiting_acceptance', projectId: project.id, nodeId: node.id, integrationBranch: 'orch/history-r1', grantJson: grant, taskSnapshotJson: snap, finalComment: 'done', startedAt: '2026-10-01T00:10:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: now } });
  const round2 = await prisma.orchestration.create({ data: { taskId: main.id, round: 2, status: 'accepted', projectId: project.id, nodeId: node.id, integrationBranch: 'orch/history-r2', grantJson: grant, taskSnapshotJson: snap, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: now, acceptedAt: '2026-10-02T01:00:00.000Z' } });
  const running = await prisma.orchestration.create({ data: { taskId: runningTask.id, round: 1, status: 'running', projectId: project.id, nodeId: node.id, integrationBranch: 'orch/running', grantJson: grant, taskSnapshotJson: '{}', createdAt: '2026-10-03T00:00:00.000Z', updatedAt: now, startedAt: '2026-10-03T00:00:00.000Z' } });
  const draft = await prisma.orchestration.create({ data: { taskId: draftTask.id, round: 1, status: 'draft', projectId: project.id, nodeId: node.id, integrationBranch: 'orch/draft', grantJson: grant, taskSnapshotJson: '{}', createdAt: '2026-10-04T00:00:00.000Z', updatedAt: now } });
  const foreign = await prisma.orchestration.create({ data: { taskId: foreignTask.id, round: 1, status: 'accepted', projectId: foreignProject.id, nodeId: node.id, integrationBranch: 'orch/foreign', grantJson: grant, taskSnapshotJson: '{}', createdAt: '2026-09-15T00:00:00.000Z', updatedAt: now } });
  ids.orchestrations.push(round1.id, round2.id, running.id, draft.id, foreign.id);

  const setup = await prisma.orchestrationStep.create({ data: { orchestrationId: round1.id, kind: 'setup', position: 1, status: 'succeeded', createdAt: now, updatedAt: now } });
  const develop = await prisma.orchestrationStep.create({ data: { orchestrationId: round1.id, kind: 'develop', subtaskId: sub.id, position: 2, status: 'succeeded', attempt: 2, continueCount: 1, retryCount: 3, resultCommit: 'develophead', error: 'E'.repeat(2500), createdAt: now, updatedAt: now } });
  const otherDevelop = await prisma.orchestrationStep.create({ data: { orchestrationId: round1.id, kind: 'develop', subtaskId: other.id, position: 3, status: 'succeeded', createdAt: now, updatedAt: now } });
  const merge = await prisma.orchestrationStep.create({ data: { orchestrationId: round1.id, kind: 'merge', subtaskId: sub.id, position: 4, status: 'succeeded', mergeCommit: 'mergehead', createdAt: now, updatedAt: now } });
  const finalStep = await prisma.orchestrationStep.create({ data: { orchestrationId: round1.id, kind: 'final', position: 5, status: 'succeeded', createdAt: now, updatedAt: now } });
  const push = await prisma.orchestrationStep.create({ data: { orchestrationId: round1.id, kind: 'push', position: 6, status: 'succeeded', createdAt: now, updatedAt: now } });

  const startedA = '2026-10-01T01:00:00.000Z';
  const startedB = '2026-10-01T02:00:00.000Z';
  const startedWork = '2026-10-01T03:00:00.000Z';
  const startedVerify = '2026-10-01T04:00:00.000Z';
  const startedOther = '2026-10-01T01:30:00.000Z';
  const commits = Array.from({ length: 6 }, (_, index) => ({ sha: `abcde${index}1234567890`, subject: `subject ${index}` }));
  await prisma.nodeJob.create({ data: { nodeId: node.id, orchestrationId: round1.id, stepId: setup.id, kind: 'prepare', phase: 'work', dispatchKey: `${stamp}-prepare`, status: 'succeeded', payloadJson: JSON.stringify({ secret: 'payload-secret-zz' }), inputTokens: 8888, createdAt: '2026-10-01T00:30:00.000Z', updatedAt: now, startedAt: '2026-10-01T00:30:00.000Z', endedAt: plus('2026-10-01T00:30:00.000Z', 100) } });
  await prisma.nodeJob.create({ data: { nodeId: node.id, orchestrationId: round1.id, stepId: develop.id, kind: 'run', phase: 'work', dispatchKey: `${stamp}-a`, status: 'succeeded', payloadJson: '{}', resultJson: runJson({}), inputTokens: 100, cachedInputTokens: 10, outputTokens: 20, costMicroUsd: null, filesChanged: 1, linesAdded: 2, linesDeleted: 3, diffStatJson: 'diffstat-secret-zz', exitCode: 0, provider: 'codex', cliVersion: '0.1.0', model: 'stub-a', createdAt: startedA, updatedAt: now, startedAt: startedA, endedAt: plus(startedA, 1000) } });
  await prisma.nodeJob.create({ data: { nodeId: node.id, orchestrationId: round1.id, stepId: develop.id, kind: 'run', phase: 'work', dispatchKey: `${stamp}-b`, status: 'succeeded', payloadJson: '{}', resultJson: runJson({ commits, checks: [{ name: 'unit', passed: true }, { name: 'lint', passed: false }], leak: 'result-secret-zz' }), inputTokens: 50, cachedInputTokens: 5, outputTokens: 8, costMicroUsd: 2500, filesChanged: 4, linesAdded: 9, linesDeleted: 1, exitCode: 0, provider: 'codex', cliVersion: '0.2.0', model: 'stub-b', error: 'X'.repeat(2500), createdAt: startedB, updatedAt: now, startedAt: startedB, endedAt: plus(startedB, 500) } });
  await prisma.nodeJob.create({ data: { nodeId: node.id, orchestrationId: round1.id, stepId: otherDevelop.id, kind: 'run', phase: 'work', dispatchKey: `${stamp}-other`, status: 'succeeded', payloadJson: '{}', inputTokens: 7, cachedInputTokens: 1, outputTokens: 1, costMicroUsd: 100, createdAt: startedOther, updatedAt: now, startedAt: startedOther, endedAt: plus(startedOther, 100) } });
  await prisma.nodeJob.create({ data: { nodeId: node.id, orchestrationId: round1.id, stepId: merge.id, kind: 'run', phase: 'work', dispatchKey: `${stamp}-merge`, status: 'succeeded', payloadJson: '{}', inputTokens: 30, cachedInputTokens: 1, outputTokens: 4, costMicroUsd: null, filesChanged: 2, linesAdded: 3, linesDeleted: 4, createdAt: startedWork, updatedAt: now, startedAt: startedWork, endedAt: plus(startedWork, 2000) } });
  await prisma.nodeJob.create({ data: { nodeId: node.id, orchestrationId: round1.id, stepId: merge.id, kind: 'run', phase: 'verify', dispatchKey: `${stamp}-verify`, status: 'succeeded', payloadJson: '{}', resultJson: runJson({ checks: [{ name: 'verify', passed: true }] }), inputTokens: 11, cachedInputTokens: 0, outputTokens: 2, costMicroUsd: 500, filesChanged: 8, linesAdded: 1, linesDeleted: 2, exitCode: 0, model: 'stub-verify', createdAt: startedVerify, updatedAt: now, startedAt: startedVerify, endedAt: plus(startedVerify, 1500) } });
  await prisma.nodeJob.create({ data: { nodeId: node.id, orchestrationId: round1.id, stepId: push.id, kind: 'push', phase: 'work', dispatchKey: `${stamp}-push`, status: 'succeeded', payloadJson: '{}', inputTokens: 9999, createdAt: '2026-10-01T05:00:00.000Z', updatedAt: now, startedAt: '2026-10-01T05:00:00.000Z', endedAt: plus('2026-10-01T05:00:00.000Z', 50) } });

  const event = (seq: number, type: string, stepId: string | null, payload: unknown) => prisma.orchestrationEvent.create({ data: { orchestrationId: round1.id, seq, type, actorKind: 'server', stepId, payload: JSON.stringify(payload), createdAt: now } });
  await event(1, 'ai_review', develop.id, { jobId: 'a', value: { decision: 'continue', comment: 'again' } });
  await event(2, 'ai_review', develop.id, { jobId: 'b', value: { decision: 'accept', comment: 'looks good' } });
  await event(3, 'develop_check', develop.id, { jobId: 'a', ok: false, problems: ['stale head'] });
  await event(4, 'develop_check', develop.id, { jobId: 'b', ok: false, problems: ['head mismatch'] });
  await event(5, 'accepted', null, { comment: 'ship it' });
  await event(6, 'final_review', finalStep.id, { value: { satisfied: true, comment: 'done' } });
  await event(7, 'merge_check', merge.id, { ok: false, problems: ['conflict'] });
  await event(8, 'verify_check', merge.id, { ok: true, problems: ['merged clean'] });
  await event(9, 'ai_review', otherDevelop.id, { value: { decision: 'accept', comment: 'earlier' } });
  await event(10, 'ai_review', otherDevelop.id, { value: null });

  const handoff = await prisma.handoff.create({ data: { taskId: sub.id, provider: 'codex', mode: 'manual', instruction: 'do it', inputSnapshot: '{}', inputHash: `${stamp}-hash`, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: now } });
  ids.handoffs.push(handoff.id);
  const run = await prisma.run.create({ data: { handoffId: handoff.id, provider: 'codex', mode: 'manual', status: 'returned', resultJson: JSON.stringify({ summary: 'S'.repeat(2500), leak: 'legacy-secret-zz' }), error: 'run failed', usageJson: JSON.stringify({ leak: 'usage-secret-zz' }), exitCode: 0, inputTokens: 3, createdAt: '2026-09-01T01:00:00.000Z', updatedAt: now, startedAt: '2026-09-01T01:00:00.000Z', endedAt: '2026-09-01T01:00:05.000Z' } });
  ids.runs.push(run.id);
  await prisma.runEvent.create({ data: { runId: run.id, sequence: 1, type: 'note', payload: 'run-event-secret-zz', createdAt: now } });
});

afterAll(async () => {
  if (ids.orchestrations.length) {
    await prisma.orchestrationEvent.deleteMany({ where: { orchestrationId: { in: ids.orchestrations } } });
    await prisma.nodeJob.deleteMany({ where: { orchestrationId: { in: ids.orchestrations } } });
    await prisma.orchestrationStep.deleteMany({ where: { orchestrationId: { in: ids.orchestrations } } });
    await prisma.orchestration.deleteMany({ where: { id: { in: ids.orchestrations } } });
  }
  if (ids.runs.length) await prisma.runEvent.deleteMany({ where: { runId: { in: ids.runs } } });
  if (ids.runs.length) await prisma.run.deleteMany({ where: { id: { in: ids.runs } } });
  if (ids.handoffs.length) await prisma.handoff.deleteMany({ where: { id: { in: ids.handoffs } } });
  if (ids.projects.length) await prisma.project.deleteMany({ where: { id: { in: ids.projects } } });
  if (ids.nodes.length) await prisma.agentNode.deleteMany({ where: { id: { in: ids.nodes } } });
  if (ids.tasks.length) {
    await prisma.task.deleteMany({ where: { parentId: { in: ids.tasks } } });
    await prisma.task.deleteMany({ where: { id: { in: ids.tasks } } });
  }
});

describe('orchestration history', () => {
  it('sums the subtask round, keeps the last diff, and hides other steps', async () => {
    const history = await aiHistory(subId);
    expect(history.rounds.map((round) => round.round)).toEqual([1]);
    const round = history.rounds[0];
    expect(round.role).toBe('subtask');
    expect(round.taskId).toBe(mainId);
    expect(round.taskTitle).toBe('History main');
    expect(round.provider).toBe('codex');
    expect(round.steps.map((step) => step.kind)).toEqual(['develop', 'merge', 'final']);
    expect(round.steps.map((step) => step.subtaskId)).toEqual([subId, subId, null]);
    expect(round.totals).toMatchObject({ inputTokens: 191, cachedInputTokens: 16, outputTokens: 34, costMicroUsd: 3000, costJobs: 2, jobs: 4, durationMs: 5000, rework: 2, rateRetries: 3 });
    const develop = round.steps[0];
    const merge = round.steps[1];
    expect(develop.subtaskTitle).toBe('History sub');
    expect(develop.filesChanged).toBe(4);
    expect(develop.linesAdded).toBe(9);
    expect(develop.linesDeleted).toBe(1);
    expect(develop.inputTokens).toBe(150);
    expect(develop.costMicroUsd).toBe(2500);
    expect(develop.error).toHaveLength(2000);
    expect(develop.review).toEqual({ decision: 'accept', comment: 'looks good' });
    expect(develop.checkProblems).toEqual(['head mismatch']);
    expect(develop.jobs).toHaveLength(2);
    expect(develop.jobs[1].commits).toHaveLength(5);
    expect(develop.jobs[1].commits[0]).toEqual({ sha: 'abcde01234567890', subject: 'subject 0' });
    expect(develop.jobs[1].commits.some((commit) => commit.subject === 'subject 5')).toBe(false);
    expect(develop.jobs[1].error).toHaveLength(2000);
    expect(develop.jobs[1].nodeName).toBe('Node One');
    expect(develop.jobs[1].durationMs).toBe(500);
    expect(develop.jobs[0].costMicroUsd).toBeNull();
    expect(merge.filesChanged).toBe(8);
    expect(merge.linesAdded).toBe(1);
    expect(merge.linesDeleted).toBe(2);
    expect(merge.checkProblems).toEqual(['merged clean']);
    expect(merge.jobs.map((job) => job.phase)).toEqual(['work', 'verify']);
    expect(round.steps[2].review).toEqual({ decision: 'satisfied', comment: 'done' });
    expect(round.userVerdicts).toEqual([{ type: 'accepted', payload: { comment: 'ship it' } }]);
    expect(history.legacy).toHaveLength(1);
    expect(history.legacy[0].runs[0].summary).toBe('S'.repeat(2000));
    expect(history.legacy[0].runs[0].error).toBe('run failed');
    expect(history.legacy[0].runs[0].inputTokens).toBe(3);
    const serialized = JSON.stringify(history);
    for (const secret of ['payload-secret-zz', 'result-secret-zz', 'legacy-secret-zz', 'usage-secret-zz', 'run-event-secret-zz', 'diffstat-secret-zz', '8888', '9999', 'History other']) expect(serialized).not.toContain(secret);
  });

  it('includes every step on the main task and sorts newer rounds first', async () => {
    const history = await aiHistory(mainId);
    expect(history.rounds.map((round) => [round.round, round.role])).toEqual([[2, 'main'], [1, 'main']]);
    const round = history.rounds[1];
    expect(round.steps.map((step) => step.kind)).toEqual(['setup', 'develop', 'develop', 'merge', 'final', 'push']);
    expect(round.totals).toMatchObject({ inputTokens: 198, cachedInputTokens: 17, outputTokens: 35, costMicroUsd: 3100, costJobs: 3, jobs: 5, durationMs: 5100, rework: 2, rateRetries: 3 });
    expect(round.steps[2].subtaskId).toBe(otherId);
    expect(round.steps[2].review).toBeNull();
    expect(round.steps[0].jobs).toEqual([]);
    expect(round.steps[5].jobs[0].inputTokens).toBe(9999);
    expect(round.steps[5].inputTokens).toBeNull();
    expect(history.rounds[0].steps).toEqual([]);
    expect(history.rounds[0].totals.costMicroUsd).toBeNull();
    expect(history.rounds[0].totals.jobs).toBe(0);
    expect(history.legacy).toEqual([]);
    const http = await owner().get(`/api/tasks/${mainId}/ai-history`);
    expect(http.status).toBe(200);
    expect(http.body.data).toEqual(history);
    const subHttp = await owner().get(`/api/tasks/${subId}/ai-history`);
    expect(subHttp.status).toBe(200);
    expect(subHttp.body.data).toEqual(await aiHistory(subId));
  });

  it('filters and pages the orchestration feed without drafts', async () => {
    const page = await orchestrationFeed({ limit: 2 });
    expect(page.items.map((item) => item.taskTitle)).toEqual(['History running', 'History main']);
    expect(page.items.map((item) => item.status)).toEqual(['running', 'accepted']);
    expect(page.items[1].round).toBe(2);
    expect(page.nextCursor).toBeTruthy();
    const next = await orchestrationFeed({ limit: 2, cursor: page.nextCursor! });
    expect(next.items.map((item) => [item.taskTitle, item.status])).toEqual([['History main', 'awaiting_acceptance'], ['History foreign', 'accepted']]);
    expect(next.nextCursor).toBeNull();
    const awaiting = next.items[0];
    expect(awaiting.projectName).toBe('Project P');
    expect(awaiting.nodeName).toBe('Node One');
    expect(awaiting.provider).toBe('codex');
    expect(awaiting.totals).toMatchObject({ inputTokens: 198, costMicroUsd: 3100, costJobs: 3, jobs: 5, durationMs: 5100 });
    const open = await orchestrationFeed({ status: 'open', limit: 10 });
    expect(open.items.map((item) => item.status).sort()).toEqual(['awaiting_acceptance', 'running']);
    const foreign = await orchestrationFeed({ status: 'accepted', projectId: projectQ, limit: 10 });
    expect(foreign.items.map((item) => item.taskTitle)).toEqual(['History foreign']);
    const project = await orchestrationFeed({ projectId: projectP, limit: 10 });
    expect(project.items).toHaveLength(3);
    expect(project.items.some((item) => item.status === 'draft')).toBe(false);
    expect(await orchestrationFeed({ status: 'nope' })).toEqual({ items: [], nextCursor: null });
    const http = await owner().get('/api/orchestrations/feed').query({ limit: 2 });
    expect(http.status).toBe(200);
    expect(http.body.data).toEqual(page);
  });
});
