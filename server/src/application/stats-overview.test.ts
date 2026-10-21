import ownerRequest from '../test-auth.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { localCalendarDate } from './reviews-clock.js';
import { parseOverviewQuery, statsOverview, type AiSection, type FocusSection, type PlanSection, type TasksSection } from './stats-overview.js';

const TZ = 'Asia/Shanghai';
const ids = {
  tasks: [] as string[],
  topics: [] as string[],
  tags: [] as string[],
  focus: [] as string[],
  proposals: [] as string[],
  memories: [] as string[],
  jobs: [] as string[],
  connections: [] as string[],
};

function view(from: string, to: string, now?: Date) {
  return statsOverview({ from, to, tz: TZ }, now ? { now } : undefined);
}
function tasksOf(section: TasksSection | { error: { message: string } }): TasksSection {
  if ('error' in section) throw new Error(section.error.message);
  return section;
}
function focusOf(section: FocusSection | { error: { message: string } }): FocusSection {
  if ('error' in section) throw new Error(section.error.message);
  return section;
}
function planOf(section: PlanSection | { error: { message: string } }): PlanSection {
  if ('error' in section) throw new Error(section.error.message);
  return section;
}
function aiOf(section: AiSection | { error: { message: string } }): AiSection {
  if ('error' in section) throw new Error(section.error.message);
  return section;
}

async function topic(id: string, name: string, extra: { color?: string; archivedAt?: string | null } = {}) {
  ids.topics.push(id);
  await prisma.topic.create({ data: { id, name, color: extra.color ?? 'slate', archivedAt: extra.archivedAt ?? null, createdAt: '2080-01-01T00:00:00.000Z', updatedAt: '2080-01-01T00:00:00.000Z' } });
}
async function task(id: string, data: Record<string, unknown> = {}) {
  ids.tasks.push(id);
  await prisma.task.create({ data: { id, title: id, createdAt: '2080-01-01T00:00:00.000Z', updatedAt: '2080-01-01T00:00:00.000Z', ...data } as never });
}
async function tag(id: string, name: string, color: string) {
  ids.tags.push(id);
  await prisma.tag.create({ data: { id, name, color, createdAt: '2080-01-01T00:00:00.000Z', updatedAt: '2080-01-01T00:00:00.000Z' } });
}
async function focus(id: string, data: { taskId?: string | null; startedAt: string; endedAt: string; durationMinutes: number; completed?: boolean; kind?: string }) {
  ids.focus.push(id);
  await prisma.focusSession.create({ data: { id, taskId: data.taskId ?? null, kind: data.kind ?? 'focus', startedAt: data.startedAt, endedAt: data.endedAt, durationMinutes: data.durationMinutes, completed: data.completed ?? true, createdAt: '2080-01-01T00:00:00.000Z' } });
}
async function proposal(id: string, data: { actorId: string; status: string; createdAt: string; updatedAt: string; connectionId?: string }) {
  ids.proposals.push(id);
  await prisma.proposal.create({ data: { id, actorId: data.actorId, status: data.status, connectionId: data.connectionId, commands: '[]', preconditions: '[]', preview: '{}', createdAt: data.createdAt, updatedAt: data.updatedAt } });
}
async function memory(id: string, data: { origin?: string; status?: string; createdAt: string; updatedAt: string }) {
  ids.memories.push(id);
  await prisma.memory.create({ data: { id, kind: 'fact', title: id, content: id, origin: data.origin ?? 'manual', status: data.status ?? 'active', createdAt: data.createdAt, updatedAt: data.updatedAt } });
}

describe('stats overview', () => {
  afterAll(async () => {
    if (ids.focus.length) await prisma.focusSession.deleteMany({ where: { id: { in: ids.focus } } });
    if (ids.tasks.length) {
      await prisma.taskTag.deleteMany({ where: { taskId: { in: ids.tasks } } });
      await prisma.taskTopicAssignment.deleteMany({ where: { taskId: { in: ids.tasks } } });
      await prisma.changeRecord.deleteMany({ where: { OR: [{ entityId: { in: ids.tasks } }, { connectionId: { in: ids.connections } }] } });
      await prisma.task.updateMany({ where: { id: { in: ids.tasks } }, data: { parentId: null } });
      await prisma.task.deleteMany({ where: { id: { in: ids.tasks } } });
    } else if (ids.connections.length) {
      await prisma.changeRecord.deleteMany({ where: { connectionId: { in: ids.connections } } });
    }
    if (ids.tags.length) await prisma.tag.deleteMany({ where: { id: { in: ids.tags } } });
    if (ids.topics.length) await prisma.topic.deleteMany({ where: { id: { in: ids.topics } } });
    if (ids.jobs.length) await prisma.autoMemoryJob.deleteMany({ where: { id: { in: ids.jobs } } });
    if (ids.proposals.length) await prisma.proposal.deleteMany({ where: { id: { in: ids.proposals } } });
    if (ids.memories.length) await prisma.memory.deleteMany({ where: { id: { in: ids.memories } } });
    if (ids.connections.length) await prisma.connection.deleteMany({ where: { id: { in: ids.connections } } });
  });

  it('buckets UTC instants in Asia/Shanghai, leaves focus wall time alone, and repeats tags', async () => {
    await topic('sov-topic', '跨日清单', { color: 'teal' });
    await tag('sov-tag-a', '甲', 'blue');
    await tag('sov-tag-b', '乙', 'rose');
    const early = '2088-04-04T15:59:00.000Z';
    const late = '2088-04-04T16:30:00.000Z';
    const previous = '2088-04-03T04:00:00.000Z';
    await task('sov-done-early', { topicId: 'sov-topic', status: 'done', completedAt: early, completedAtEstimated: true, createdAt: early, updatedAt: early });
    await task('sov-done-late', { status: 'done', completedAt: late, createdAt: late, updatedAt: late });
    await task('sov-done-prev', { status: 'done', completedAt: previous, createdAt: previous, updatedAt: previous });
    await prisma.taskTag.createMany({ data: [{ taskId: 'sov-done-early', tagId: 'sov-tag-a' }, { taskId: 'sov-done-early', tagId: 'sov-tag-b' }, { taskId: 'sov-done-late', tagId: 'sov-tag-a' }] });
    await task('sov-focus-task', { title: '专注任务' });
    await focus('sov-focus-wall', { taskId: 'sov-focus-task', startedAt: '2088-04-04T16:30', endedAt: '2088-04-04T17:00', durationMinutes: 30 });
    await focus('sov-focus-free', { startedAt: '2088-04-04T09:00', endedAt: '2088-04-04T09:20', durationMinutes: 20, completed: false });
    await focus('sov-focus-prev', { startedAt: '2088-04-03T08:00', endedAt: '2088-04-03T08:10', durationMinutes: 10 });
    await focus('sov-focus-break', { kind: 'break', startedAt: '2088-04-04T11:00', endedAt: '2088-04-04T12:40', durationMinutes: 100 });

    const result = await view('2088-04-04', '2088-04-05');
    const tasks = tasksOf(result.tasks);
    const focusSection = focusOf(result.focus);
    expect(result.range).toMatchObject({ from: '2088-04-04', to: '2088-04-05', tz: TZ, days: 2, previous: { from: '2088-04-02', to: '2088-04-03' } });
    expect(tasks.completedByDay).toEqual([
      { date: '2088-04-04', count: 1, estimated: 1 },
      { date: '2088-04-05', count: 1, estimated: 0 },
    ]);
    expect(tasks.createdByDay).toEqual([{ date: '2088-04-04', count: 1 }, { date: '2088-04-05', count: 1 }]);
    expect(tasks.created).toEqual({ value: 2, previous: 1 });
    expect(tasks.completed).toEqual({ value: 2, previous: 1 });
    expect(tasks.estimatedCount).toEqual({ value: 1, previous: 0 });
    expect(tasks.byTag).toEqual([{ tagId: 'sov-tag-a', name: '甲', color: 'blue', count: 2 }, { tagId: 'sov-tag-b', name: '乙', color: 'rose', count: 1 }]);
    expect(tasks.byTopic).toEqual([
      { topicId: null, name: null, color: null, count: 1 },
      { topicId: 'sov-topic', name: '跨日清单', color: 'teal', count: 1 },
    ]);
    expect(focusSection.minutesByDay).toEqual([{ date: '2088-04-04', minutes: 50 }, { date: '2088-04-05', minutes: 0 }]);
    expect(focusSection.sessionsByDay).toEqual([{ date: '2088-04-04', count: 2 }, { date: '2088-04-05', count: 0 }]);
    expect(focusSection.minutes).toEqual({ value: 50, previous: 10 });
    expect(focusSection.sessions).toEqual({ value: 2, previous: 1 });
    expect(focusSection.completedSessions).toEqual({ value: 1, previous: 1 });
    expect(focusSection.avgSession).toEqual({ value: 25, previous: 10 });
    expect(focusSection.completionRate).toEqual({ value: 0.5, previous: 1 });
    expect(focusSection.byTask).toEqual([
      { taskId: 'sov-focus-task', title: '专注任务', minutes: 30, sessions: 1 },
      { taskId: null, title: null, minutes: 20, sessions: 1 },
    ]);
    const ai = aiOf(result.ai);
    expect(ai.dispatch.byDay.map((day) => day.date)).toEqual(['2088-04-04', '2088-04-05']);
    expect(ai.dispatch.byDay.reduce((sum, day) => sum + day.rounds, 0)).toBe(ai.dispatch.rounds.value);
    expect(ai.dispatch.byDay.reduce((sum, day) => sum + day.costMicroUsd, 0)).toBe(ai.dispatch.costMicroUsd.value);
  });

  it('counts overdue stock with scheduleLastDate and keeps subtasks', async () => {
    const now = new Date('1000-01-03T04:00:00.000Z');
    const before = tasksOf((await view('2099-12-01', '2099-12-01', now)).tasks);
    await topic('sov-od-topic', '逾期清单', { color: 'green' });
    await topic('sov-od-archived', '归档清单', { archivedAt: '1000-01-01T00:00:00.000Z' });
    await task('sov-od-parent', { dueDate: '1000-01-03', createdAt: '1000-06-01T00:00:00.000Z', updatedAt: '1000-06-01T00:00:00.000Z' });
    await task('sov-od-a', { title: '收件箱逾期', dueDate: '1000-01-01', createdAt: '1000-06-01T00:00:00.000Z', updatedAt: '1000-06-01T00:00:00.000Z' });
    await task('sov-od-b', { title: '子任务逾期', parentId: 'sov-od-parent', dueDate: '1000-01-01', createdAt: '1000-06-01T00:00:00.000Z', updatedAt: '1000-06-01T00:00:00.000Z' });
    await task('sov-od-c', { title: '清单逾期', topicId: 'sov-od-topic', dueDate: '1000-01-02', createdAt: '1000-06-01T00:00:00.000Z', updatedAt: '1000-06-01T00:00:00.000Z' });
    await task('sov-od-done', { status: 'done', dueDate: '1000-01-01', completedAt: '1000-01-01T00:00:00.000Z', createdAt: '1000-06-01T00:00:00.000Z', updatedAt: '1000-06-01T00:00:00.000Z' });
    await task('sov-od-deleted', { dueDate: '1000-01-01', deletedAt: '1000-01-02T00:00:00.000Z', createdAt: '1000-06-01T00:00:00.000Z', updatedAt: '1000-06-01T00:00:00.000Z' });
    await task('sov-od-archived', { topicId: 'sov-od-archived', dueDate: '1000-01-01', createdAt: '1000-06-01T00:00:00.000Z', updatedAt: '1000-06-01T00:00:00.000Z' });
    await task('sov-od-none', { createdAt: '1000-06-01T00:00:00.000Z', updatedAt: '1000-06-01T00:00:00.000Z' });
    await task('sov-od-today', { dueDate: '1000-01-03', createdAt: '1000-06-01T00:00:00.000Z', updatedAt: '1000-06-01T00:00:00.000Z' });
    await task('sov-od-span', { scheduledStart: '1000-01-02T22:00', scheduledEnd: '1000-01-04T02:00', dueDate: '1000-01-02', createdAt: '1000-06-01T00:00:00.000Z', updatedAt: '1000-06-01T00:00:00.000Z' });

    const overdue = await view('2099-12-01', '2099-12-01', now);
    const tasks = tasksOf(overdue.tasks);
    expect(overdue.range.today).toBe('1000-01-03');
    expect(tasks.overdue - before.overdue).toBe(3);
    const mine = tasks.overdueTop.filter((row) => row.id.startsWith('sov-od-'));
    expect(before.overdue).toBe(0);
    expect(mine).toEqual([
      { id: 'sov-od-a', title: '收件箱逾期', topicId: null, topicName: null, topicColor: null, days: 2 },
      { id: 'sov-od-b', title: '子任务逾期', topicId: null, topicName: null, topicColor: null, days: 2 },
      { id: 'sov-od-c', title: '清单逾期', topicId: 'sov-od-topic', topicName: '逾期清单', topicColor: 'green', days: 1 },
    ]);
    expect(tasks.overdueOldestDays).toBe(2);
    expect(tasks.overdueTop.some((row) => ['sov-od-done', 'sov-od-deleted', 'sov-od-archived', 'sov-od-none', 'sov-od-today', 'sov-od-span', 'sov-od-parent'].includes(row.id))).toBe(false);
  });

  it('keeps the completion day when the title changes and drops it when completion is undone', async () => {
    const today = localCalendarDate(new Date(), TZ);
    const before = tasksOf((await view(today, today)).tasks).completed.value;
    const created = await ownerRequest(app).post('/api/tasks').send({ title: '完成日' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    ids.tasks.push(created.body.data.id);
    const completed = await ownerRequest(app).patch(`/api/tasks/${created.body.data.id}`).send({ status: 'done' });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    const after = tasksOf((await view(today, today)).tasks);
    expect(after.completed.value).toBe(before + 1);
    const stamped = await prisma.task.findUniqueOrThrow({ where: { id: created.body.data.id } });
    const renamed = await ownerRequest(app).patch(`/api/tasks/${created.body.data.id}`).send({ title: '新题' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const titled = await prisma.task.findUniqueOrThrow({ where: { id: created.body.data.id } });
    expect(titled.completedAt).toBe(stamped.completedAt);
    expect(titled.title).toBe('新题');
    const still = tasksOf((await view(today, today)).tasks);
    expect(still.completed.value).toBe(after.completed.value);
    expect(still.completedByDay.find((day) => day.date === today)?.count).toBe(after.completedByDay.find((day) => day.date === today)?.count);

    const second = await ownerRequest(app).post('/api/tasks').send({ title: '可撤销' });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    ids.tasks.push(second.body.data.id);
    const secondDone = await ownerRequest(app).patch(`/api/tasks/${second.body.data.id}`).send({ status: 'done' });
    expect(secondDone.status, JSON.stringify(secondDone.body)).toBe(200);
    expect(tasksOf((await view(today, today)).tasks).completed.value).toBe(before + 2);
    const undone = await ownerRequest(app).post(`/api/changes/${secondDone.body.meta.changeId}/undo`);
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: second.body.data.id } })).toMatchObject({ status: 'todo', completedAt: null });
    expect(tasksOf((await view(today, today)).tasks).completed.value).toBe(before + 1);
  });

  it('excludes pending and failed from the adoption denominator', async () => {
    const day = '2099-08-10T04:00:00.000Z';
    const prev = '2099-08-09T04:00:00.000Z';
    const pendingBefore = await prisma.proposal.count({ where: { status: 'pending' } });
    const activeBefore = await prisma.memory.count({ where: { status: 'active' } });
    await proposal('sov-p-prev-ex', { actorId: 'local-owner', status: 'executed', createdAt: prev, updatedAt: prev });
    await proposal('sov-p-prev-re', { actorId: 'local-owner', status: 'rejected', createdAt: prev, updatedAt: prev });
    await proposal('sov-p-ex', { actorId: 'connection:sov', status: 'executed', createdAt: day, updatedAt: day });
    await proposal('sov-p-re', { actorId: 'auto-memory:sov-job', status: 'rejected', createdAt: day, updatedAt: day });
    await proposal('sov-p-fail', { actorId: 'builtin-agent', status: 'failed', createdAt: day, updatedAt: day });
    await proposal('sov-p-pend', { actorId: 'orchestration-learning', status: 'pending', createdAt: day, updatedAt: day });
    await proposal('sov-p-other', { actorId: 'auto-memory-archive', status: 'pending', createdAt: day, updatedAt: day });
    await memory('sov-m-man', { origin: 'manual', createdAt: day, updatedAt: day });
    await memory('sov-m-ai', { origin: 'ai', createdAt: day, updatedAt: day });
    await memory('sov-m-prev', { origin: 'manual', createdAt: prev, updatedAt: prev });
    await memory('sov-m-retired', { origin: 'manual', status: 'retired', createdAt: '2080-01-01T00:00:00.000Z', updatedAt: day });
    ids.jobs.push('sov-job-prev', 'sov-job-cur', 'sov-job-fail');
    await prisma.autoMemoryJob.createMany({ data: [
      { id: 'sov-job-prev', scopeKey: 'sov', inputHash: 'sov-prev', status: 'failed', snapshot: '{}', proposalIds: '[]', createdAt: prev },
      { id: 'sov-job-cur', scopeKey: 'sov', inputHash: 'sov-cur', status: 'completed', snapshot: '{}', proposalIds: JSON.stringify(['sov-p-ex', 'sov-p-re', 'sov-p-pend']), createdAt: day },
      { id: 'sov-job-fail', scopeKey: 'sov', inputHash: 'sov-fail', status: 'failed', snapshot: '{}', proposalIds: '[]', createdAt: day },
    ] });

    const ai = aiOf((await view('2099-08-10', '2099-08-10')).ai);
    expect(ai.proposals.created).toEqual({ value: 5, previous: 2 });
    expect(ai.proposals.executed).toEqual({ value: 1, previous: 1 });
    expect(ai.proposals.rejected).toEqual({ value: 1, previous: 1 });
    expect(ai.proposals.failed).toEqual({ value: 1, previous: 0 });
    expect(ai.proposals.pending).toBe(pendingBefore + 2);
    expect(ai.proposals.adoptionRate).toEqual({ value: 0.5, previous: 0.5 });
    expect(ai.proposals.bySource).toEqual([
      { source: 'auto-memory', count: 1 },
      { source: 'builtin-agent', count: 1 },
      { source: 'connection', count: 1 },
      { source: 'orchestration-learning', count: 1 },
      { source: 'other', count: 1 },
    ]);
    expect(ai.memories.created).toEqual({ value: 2, previous: 1 });
    expect(ai.memories.retired).toEqual({ value: 1, previous: 0 });
    expect(ai.memories.byOrigin).toEqual({ manual: 1, ai: 1 });
    expect(ai.memories.activeTotal).toBe(activeBefore + 3);
    expect(ai.autoMemory).toMatchObject({ jobs: { value: 2, previous: 1 }, failed: { value: 1, previous: 1 }, adoption: { value: 0.5, previous: null } });
  });

  it('lists active connections and revoked ones with in-range activity', async () => {
    const stamp = '2099-08-20T00:00:00.000Z';
    const make = async (id: string, name: string, status: string, lastUsedAt: string | null = null) => {
      ids.connections.push(id);
      await prisma.connection.create({ data: { id, name, host: `${name}-host`, status, tokenHash: `sov-${id}`, lastUsedAt, createdAt: stamp, updatedAt: stamp } });
    };
    await make('sov-c-quiet', 'Quiet', 'active');
    await make('sov-c-busy', 'Busy', 'active', '2099-07-01T00:00:00.000Z');
    await make('sov-c-rev-write', 'Revoked write', 'revoked');
    await make('sov-c-rev-idle', 'Revoked idle', 'revoked', '2099-08-20T08:00:00.000Z');
    await make('sov-c-rev-prop', 'Revoked proposal', 'revoked');
    const write = async (id: string, connectionId: string, createdAt: string) => {
      await prisma.changeRecord.create({ data: { id, connectionId, entityType: 'task', entityId: 'sov-c-entity', operation: 'update', source: 'connection', beforeSnapshot: '{"v":1}', afterSnapshot: '{"v":2}', createdAt } });
    };
    await write('sov-w-heat', 'sov-c-busy', '2099-08-07T04:00:00.000Z');
    await write('sov-w-range', 'sov-c-busy', '2099-08-20T03:00:00.000Z');
    await write('sov-w-later', 'sov-c-busy', '2099-12-01T00:00:00.000Z');
    await write('sov-w-revoked', 'sov-c-rev-write', '2099-08-20T02:00:00.000Z');
    await proposal('sov-c-proposal', { actorId: 'connection:sov-c-busy', status: 'pending', connectionId: 'sov-c-busy', createdAt: '2099-08-20T05:00:00.000Z', updatedAt: '2099-08-20T05:00:00.000Z' });
    await proposal('sov-c-rev-proposal', { actorId: 'connection:sov-c-rev-prop', status: 'executed', connectionId: 'sov-c-rev-prop', createdAt: '2099-08-20T06:00:00.000Z', updatedAt: '2099-08-20T06:00:00.000Z' });

    const ai = aiOf((await view('2099-08-20', '2099-08-20')).ai);
    const mine = ai.connections.filter((row) => row.id.startsWith('sov-c-'));
    expect(mine.map((row) => row.id)).toEqual(['sov-c-busy', 'sov-c-quiet', 'sov-c-rev-prop', 'sov-c-rev-write']);
    expect(mine.find((row) => row.id === 'sov-c-rev-idle')).toBeUndefined();
    const busy = mine.find((row) => row.id === 'sov-c-busy')!;
    expect(busy).toMatchObject({ name: 'Busy', status: 'active', host: 'Busy-host', writes: 1, proposals: 1, lastActiveAt: '2099-12-01T00:00:00.000Z' });
    expect(busy.byDay).toHaveLength(14);
    expect(busy.byDay[0]).toEqual({ date: '2099-08-07', count: 1 });
    expect(busy.byDay.at(-1)).toEqual({ date: '2099-08-20', count: 1 });
    expect(busy.byDay.slice(1, -1).every((day) => day.count === 0)).toBe(true);
    expect(mine.find((row) => row.id === 'sov-c-quiet')).toMatchObject({ writes: 0, proposals: 0, lastActiveAt: null });
    expect(mine.find((row) => row.id === 'sov-c-rev-write')).toMatchObject({ status: 'revoked', writes: 1, proposals: 0 });
    expect(mine.find((row) => row.id === 'sov-c-rev-prop')).toMatchObject({ status: 'revoked', writes: 0, proposals: 1, lastActiveAt: '2099-08-20T06:00:00.000Z' });
  });

  it('splits plan blocks into bands and rates unique tasks', async () => {
    const saved = await prisma.planTimeBand.findMany();
    await prisma.planTimeBand.deleteMany();
    await prisma.planTimeBand.create({ data: { id: 'sov-band', name: '上午', startMinute: 540, endMinute: 720, weekdaysJson: JSON.stringify([1, 2, 3, 4, 5, 6, 7]), color: 'blue', position: 0 } });
    try {
      await task('sov-plan-on', { status: 'done', scheduledStart: '2099-11-10T10:00', scheduledEnd: '2099-11-10T11:00', dueDate: '2099-11-10', estimatedMinutes: 999, completedAt: '2099-11-10T15:59:00.000Z', updatedAt: '2099-11-10T15:59:00.000Z' });
      await task('sov-plan-late', { status: 'done', scheduledStart: '2099-11-10T13:00', scheduledEnd: '2099-11-10T14:00', dueDate: '2099-11-10', completedAt: '2099-11-10T16:30:00.000Z', updatedAt: '2099-11-10T16:30:00.000Z' });
      await task('sov-plan-date', { dueDate: '2099-11-10', estimatedMinutes: 45 });
      await task('sov-plan-span', { scheduledStart: '2099-11-10T22:00', scheduledEnd: '2099-11-11T02:00', dueDate: '2099-11-10' });
      await task('sov-plan-prev', { status: 'done', dueDate: '2099-11-09', estimatedMinutes: 15, completedAt: '2099-11-09T04:00:00.000Z', updatedAt: '2099-11-09T04:00:00.000Z' });
      await focus('sov-plan-morning', { startedAt: '2099-11-10T10:15', endedAt: '2099-11-10T10:45', durationMinutes: 30 });
      await focus('sov-plan-afternoon', { startedAt: '2099-11-10T13:00', endedAt: '2099-11-10T13:20', durationMinutes: 20 });
      await focus('sov-plan-midnight', { startedAt: '2099-11-09T23:30', endedAt: '2099-11-10T00:30', durationMinutes: 60 });

      const plan = planOf((await view('2099-11-10', '2099-11-10')).plan);
      expect(plan.byDay).toEqual([{ date: '2099-11-10', plannedTasks: 4, plannedMinutes: 285, doneOnPlan: 1, doneLate: 1, notDone: 2, focusMinutes: 50 }]);
      expect(plan.plannedTasks).toEqual({ value: 4, previous: 1 });
      expect(plan.doneOnPlanTasks).toEqual({ value: 1, previous: 1 });
      expect(plan.onPlanRate).toEqual({ value: 0.25, previous: 1 });
      expect(plan.plannedMinutesTotal).toEqual({ value: 285, previous: 15 });
      expect(plan.focusMinutesTotal).toEqual({ value: 50, previous: 60 });
      expect(plan.byBand).toEqual([
        { id: 'sov-band', name: '上午', color: 'blue', startMinute: 540, endMinute: 720, weekdays: [1, 2, 3, 4, 5, 6, 7], plannedMinutes: 60, focusMinutes: 30 },
        { id: null, name: null, color: null, startMinute: null, endMinute: null, weekdays: null, plannedMinutes: 180, focusMinutes: 50 },
      ]);

      await task('sov-plan-long', { status: 'done', scheduledStart: '2099-11-20T09:00', scheduledEnd: '2099-11-23T00:00', dueDate: '2099-11-20', completedAt: '2099-11-22T04:00:00.000Z', updatedAt: '2099-11-22T04:00:00.000Z' });
      await task('sov-plan-miss', { dueDate: '2099-11-20' });
      const unique = planOf((await view('2099-11-20', '2099-11-22')).plan);
      expect(unique.plannedTasks).toEqual({ value: 2, previous: 0 });
      expect(unique.doneOnPlanTasks).toEqual({ value: 1, previous: 0 });
      expect(unique.onPlanRate).toEqual({ value: 0.5, previous: null });
      expect(unique.byDay.reduce((sum, day) => sum + day.plannedTasks, 0)).toBe(4);
      expect(unique.byDay.reduce((sum, day) => sum + day.doneOnPlan, 0)).toBe(3);
    } finally {
      await prisma.planTimeBand.deleteMany();
      if (saved.length) {
        await prisma.planTimeBand.createMany({ data: saved.map((row) => ({ id: row.id, name: row.name, startMinute: row.startMinute, endMinute: row.endMinute, weekdaysJson: row.weekdaysJson, color: row.color, position: row.position })) });
      }
    }
  });

  it('returns the other sections when one section throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await statsOverview({ from: '2077-02-01', to: '2077-02-02', tz: TZ }, { tasks: async () => { throw new Error('boom'); } });
      expect(result.tasks).toEqual({ error: { code: 'STATS_SECTION_FAILED', message: '统计分区加载失败' } });
      expect(result.focus).not.toHaveProperty('error');
      expect(result.plan).not.toHaveProperty('error');
      expect(result.ai).not.toHaveProperty('error');
      expect(result.range.days).toBe(2);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a bad zone, an inverted range, and more than 366 days', async () => {
    await expect(statsOverview({ from: '2099-01-01', to: '2099-01-02', tz: 'Not/AZone' })).rejects.toMatchObject({ code: 'INVALID_TIME_ZONE', status: 400 });
    await expect(statsOverview({ from: '2099-01-02', to: '2099-01-01', tz: TZ })).rejects.toMatchObject({ code: 'INVALID_STATS_RANGE', status: 400, message: '统计区间无效' });
    await expect(statsOverview({ from: '2099-01-01', to: '2100-01-02', tz: 'UTC' })).rejects.toMatchObject({ code: 'INVALID_STATS_RANGE', status: 400 });
    await expect(statsOverview({ from: '2099-02-31', to: '2099-03-01', tz: 'UTC' })).rejects.toMatchObject({ code: 'INVALID_STATS_RANGE', status: 400 });
    await expect(statsOverview({ from: '2099-01-01', to: '2099-01-01', tz: '' })).rejects.toMatchObject({ code: 'INVALID_TIME_ZONE', status: 400 });
    expect(parseOverviewQuery({ from: '2099-01-01', to: '2100-01-01', tz: 'UTC' }).days).toBe(366);
  });

  it('serves GET /api/stats/overview to the owner', async () => {
    const response = await ownerRequest(app).get('/api/stats/overview').query({ from: '2099-11-10', to: '2099-11-10', tz: TZ });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.error).toBeNull();
    expect(response.body.data.range).toMatchObject({ from: '2099-11-10', to: '2099-11-10', tz: TZ, days: 1, previous: { from: '2099-11-09', to: '2099-11-09' } });
    expect(response.body.data.tasks).not.toHaveProperty('error');
    expect(response.body.data.focus).not.toHaveProperty('error');
    expect(response.body.data.plan).not.toHaveProperty('error');
    expect(response.body.data.ai).not.toHaveProperty('error');
    const bad = await ownerRequest(app).get('/api/stats/overview').query({ from: '2099-11-12', to: '2099-11-10', tz: TZ });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'INVALID_STATS_RANGE', error: '统计区间无效' });
    const zone = await ownerRequest(app).get('/api/stats/overview').query({ from: '2099-11-10', to: '2099-11-10', tz: 'Nope/Zone' });
    expect(zone.status).toBe(400);
    expect(zone.body.code).toBe('INVALID_TIME_ZONE');
  });
});
