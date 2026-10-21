/**
 * Local benchmark for GET /api/stats/overview. Not part of CI.
 * Run: cd server && npx tsx scripts/stats-overview-bench.ts
 *
 * Builds a temporary sqlite database, applies the full migration chain, and
 * times 30 calls over a 30-day Asia/Shanghai window.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const tasksN = 10_000;
const changesN = 50_000;
const focusN = 2_000;
const proposalsN = 500;
const memoriesN = 200;
const jobsN = 100;
const connectionsN = 40;
const runs = 30;

const pad = (value: number) => String(value).padStart(2, '0');
const marchDay = (index: number) => `2026-03-${pad((index % 30) + 1)}`;
const stamp = (index: number) => {
  const offset = index % 45;
  if (offset < 30) return `2026-03-${pad(offset + 1)}T04:${pad(index % 60)}:00.000Z`;
  return `2026-02-${pad(offset - 29)}T04:${pad(index % 60)}:00.000Z`;
};

async function batches<T>(rows: T[], size: number, write: (chunk: T[]) => Promise<unknown>) {
  for (let index = 0; index < rows.length; index += size) await write(rows.slice(index, index + size));
}

const directory = await mkdtemp(join(tmpdir(), 'stats-overview-bench-'));
const databaseUrl = `file:${join(directory, 'bench.db')}`;
process.env.DATABASE_URL = databaseUrl;

let disconnect: (() => Promise<void>) | null = null;
try {
  const { migrateDatabase } = await import('../src/db-migrate.js');
  await migrateDatabase(databaseUrl);
  const { prisma } = await import('../src/infrastructure/prisma.js');
  const { statsOverview } = await import('../src/application/stats-overview.js');
  disconnect = () => prisma.$disconnect();

  const seededAt = performance.now();
  const now = '2026-03-15T04:00:00.000Z';
  const topics = Array.from({ length: 10 }, (_, index) => ({
    id: `bench-topic-${index}`,
    name: `清单 ${index}`,
    color: 'slate',
    archivedAt: index === 9 ? now : null,
    createdAt: now,
    updatedAt: now,
  }));
  await prisma.topic.createMany({ data: topics });
  const tags = Array.from({ length: 20 }, (_, index) => ({ id: `bench-tag-${index}`, name: `标签 ${index}`, color: 'blue', createdAt: now, updatedAt: now }));
  await prisma.tag.createMany({ data: tags });
  await prisma.planTimeBand.createMany({ data: [1, 2, 3].map((index) => ({
    id: `bench-band-${index}`,
    name: `时段 ${index}`,
    startMinute: index * 180,
    endMinute: index * 180 + 120,
    weekdaysJson: JSON.stringify([1, 2, 3, 4, 5, 6, 7]),
    color: 'blue',
    position: index,
  })) });
  await prisma.connection.createMany({ data: Array.from({ length: connectionsN }, (_, index) => ({
    id: `bench-conn-${index}`,
    name: `连接 ${index}`,
    host: 'bench',
    tokenHash: `bench-token-${index}`,
    status: index < connectionsN / 2 ? 'active' : 'revoked',
    lastUsedAt: index % 2 === 0 ? now : null,
    createdAt: now,
    updatedAt: now,
  })) });

  const taskRows = Array.from({ length: tasksN }, (_, index) => {
    const deleted = index % 50 === 0;
    const done = !deleted && index % 5 !== 0;
    const date = marchDay(index);
    const block = index % 4 !== 0;
    const at = stamp(index);
    return {
      id: `bench-task-${index}`,
      title: `任务 ${index}`,
      topicId: index % 11 === 0 ? null : topics[index % topics.length]!.id,
      status: done ? 'done' as const : 'todo' as const,
      dueDate: date,
      estimatedMinutes: block ? 40 : 25,
      scheduledStart: block ? `${date}T09:00` : null,
      scheduledEnd: block ? `${date}T10:30` : null,
      deletedAt: deleted ? now : null,
      createdAt: at,
      updatedAt: at,
      completedAt: done ? at : null,
      completedAtEstimated: done && index % 7 === 0,
    };
  });
  await batches(taskRows, 60, (chunk) => prisma.task.createMany({ data: chunk }));
  const links = taskRows.filter((row) => !row.deletedAt).flatMap((row, index) => {
    const first = { taskId: row.id, tagId: tags[index % tags.length]!.id };
    return index % 3 === 0 ? [first, { taskId: row.id, tagId: tags[(index + 1) % tags.length]!.id }] : [first];
  });
  await batches(links, 400, (chunk) => prisma.taskTag.createMany({ data: chunk }));

  const changes = Array.from({ length: changesN }, (_, index) => ({
    id: `bench-change-${index}`,
    connectionId: index % 3 === 0 ? `bench-conn-${index % connectionsN}` : null,
    entityType: 'task',
    entityId: `bench-task-${index % tasksN}`,
    operation: 'update',
    source: 'connection',
    beforeSnapshot: '{"v":1}',
    afterSnapshot: '{"v":2}',
    createdAt: `${marchDay(index)}T${pad(2 + (index % 10))}:${pad(index % 60)}:00.000Z`,
  }));
  await batches(changes, 80, (chunk) => prisma.changeRecord.createMany({ data: chunk }));

  await batches(Array.from({ length: focusN }, (_, index) => ({
    id: `bench-focus-${index}`,
    taskId: index % 5 === 0 ? null : `bench-task-${index % 200}`,
    kind: 'focus',
    startedAt: `${marchDay(index)}T${pad(8 + (index % 10))}:${pad(index % 60)}`,
    endedAt: `${marchDay(index)}T${pad(8 + (index % 10))}:${pad((index % 60 + 25) % 60)}`,
    durationMinutes: 25,
    completed: index % 4 !== 0,
    createdAt: now,
  })), 80, (chunk) => prisma.focusSession.createMany({ data: chunk }));

  const actors = ['local-owner', 'builtin-agent', 'orchestration-learning', 'connection:bench-conn-0', 'auto-memory:bench-job-0', 'stranger'];
  const statuses = ['executed', 'rejected', 'failed', 'pending'] as const;
  await batches(Array.from({ length: proposalsN }, (_, index) => ({
    id: `bench-proposal-${index}`,
    actorId: actors[index % actors.length]!,
    connectionId: index % 2 === 0 ? `bench-conn-${index % connectionsN}` : null,
    status: statuses[index % statuses.length]!,
    commands: '[]',
    preconditions: '[]',
    preview: '{}',
    createdAt: stamp(index),
    updatedAt: stamp(index + 3),
  })), 80, (chunk) => prisma.proposal.createMany({ data: chunk }));

  await batches(Array.from({ length: memoriesN }, (_, index) => ({
    id: `bench-memory-${index}`,
    kind: 'fact',
    title: `记忆 ${index}`,
    content: `内容 ${index}`,
    origin: index % 2 === 0 ? 'manual' : 'ai',
    status: index % 9 === 0 ? 'retired' : 'active',
    createdAt: stamp(index),
    updatedAt: stamp(index + 1),
  })), 80, (chunk) => prisma.memory.createMany({ data: chunk }));

  await batches(Array.from({ length: jobsN }, (_, index) => ({
    id: `bench-job-${index}`,
    scopeKey: 'bench',
    inputHash: `bench-${index}`,
    status: index % 5 === 0 ? 'failed' : 'completed',
    snapshot: '{}',
    proposalIds: JSON.stringify([`bench-proposal-${index % proposalsN}`, `bench-proposal-${(index + 1) % proposalsN}`]),
    createdAt: stamp(index),
  })), 50, (chunk) => prisma.autoMemoryJob.createMany({ data: chunk }));
  console.log(`seeded in ${Math.round(performance.now() - seededAt)}ms`);

  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    const result = await statsOverview({ from: '2026-03-01', to: '2026-03-30', tz: 'Asia/Shanghai' });
    samples.push(performance.now() - started);
    for (const key of ['tasks', 'focus', 'plan', 'ai'] as const) {
      if ('error' in result[key]) throw new Error(`${key} failed: ${JSON.stringify(result[key])}`);
    }
  }
  samples.sort((left, right) => left - right);
  const pick = (ratio: number) => samples[Math.ceil(ratio * samples.length) - 1]!;
  console.log(`stats-overview bench n=${runs} p50=${pick(0.5).toFixed(1)}ms p95=${pick(0.95).toFixed(1)}ms min=${samples[0]!.toFixed(1)}ms max=${samples.at(-1)!.toFixed(1)}ms`);
} finally {
  await disconnect?.();
  await rm(directory, { recursive: true, force: true });
}
