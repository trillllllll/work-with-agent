import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { prisma } from '../infrastructure/prisma.js';
import { ownerActor } from './security.js';
import { ResourceService } from './resources/service.js';
import { LibraryService } from './library/service.js';
import { publishLibraryExtraction, runLibraryWorkerOnce, startLibraryWorker } from './library/worker.js';
import { textLineSegments } from './library/text.js';
import * as coordinator from './coordinator-work.js';

if (!process.env.DATABASE_URL?.includes('/tmp/')) throw new Error('Index regression tests require an explicit /tmp/ database');
const resources = new ResourceService();
const library = new LibraryService();
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const outcome = (text: string) => ({
  status: 'ready' as const, errorCode: null, errors: [],
  segments: textLineSegments(text).map(({ text, startLine, endLine }) => ({ text, method: 'native' as const, locator: { kind: 'line', startLine, endLine } })),
});
const create = (content: string) => resources.create(ownerActor, { requestId: randomUUID(), title: '索引事务回归', format: 'text', content });

it('coalesces short lines without changing text or line locators', () => {
  const text = '\uFEFF# 源文件\r\n' + '😀 中文 `code`\r\n'.repeat(25_000) + 'END-OF-ORIGINAL';
  const segments = textLineSegments(text);
  expect(segments.length).toBeLessThan(400);
  expect(segments.map((segment) => segment.text).join('\n')).toBe(text);
  let line = 1;
  for (const segment of segments) {
    expect(segment.startLine).toBe(line);
    expect(segment.endLine).toBe(line + segment.text.split('\n').length - 1);
    expect([...segment.text].length).toBeLessThanOrEqual(1200);
    line = segment.endLine + 1;
  }
  expect(textLineSegments('first\n' + '😀'.repeat(2500) + '\nlast').map((segment) => [segment.startLine, segment.endLine])).toEqual([[1, 1], [2, 2], [3, 3]]);
});

it('indexes the 25,000-line browser fixture with responsive writes and complete paginated projection', async () => {
  const text = '\uFEFF# 源文件\r\n' + '😀 中文 `code`\r\n'.repeat(25_000) + 'END-OF-ORIGINAL';
  const resource = await create(text);
  const extraction = await prisma.materialExtraction.update({ where: { materialId_revision: { materialId: resource.id, revision: 1 } }, data: { nextAttemptAt: '1970-01-01T00:00:00.000Z' } });
  let done = false;
  let partialObserved = false;
  let maxWriteMs = 0;
  const started = Date.now();
  const pending = runLibraryWorkerOnce().finally(() => { done = true; });
  while (!done) {
    const start = Date.now();
    await prisma.material.update({ where: { id: resource.id }, data: { updatedAt: new Date().toISOString() } });
    maxWriteMs = Math.max(maxWriteMs, Date.now() - start);
    const current = await prisma.materialExtraction.findUniqueOrThrow({ where: { id: extraction.id } });
    if (!partialObserved && current.indexedGeneration === 0 && await prisma.materialChunk.count({ where: { extractionId: extraction.id } }) > 0) {
      partialObserved = true;
      const page = await library.content(ownerActor, resource.id, 1);
      // A concurrent final publish may legitimately make the complete page visible.
      expect(page.total === 0 || page.total === textLineSegments(text).length).toBe(true);
    }
    await turn();
  }
  expect(await pending).toMatchObject({ claimed: true, published: true });
  expect(maxWriteMs).toBeLessThan(3000);
  expect(partialObserved).toBe(true);
  const published = await prisma.materialExtraction.findUniqueOrThrow({ where: { id: extraction.id } });
  expect(published.status).toBe('ready');
  expect(published.errorCode).toBeNull();
  const chunks: string[] = [];
  let cursor: number | null = 0;
  do {
    const page = await library.content(ownerActor, resource.id, 1, cursor, 17);
    expect(page.total).toBeLessThan(400);
    chunks.push(...page.items.map((item) => item.text));
    cursor = page.nextCursor;
  } while (cursor !== null);
  expect(chunks.join('\n')).toBe(text);
  const hits = await library.search(ownerActor, 'END-OF-ORIGINAL', {}, 0, 20);
  expect(hits.items.some((item) => item.id === resource.id)).toBe(true);
  const unchanged = await resources.read(ownerActor, resource.id, 1);
  expect(unchanged.content).toBe(text);
  expect(unchanged.contentHash).toBe(resource.contentHash);
  expect(unchanged.revision).toBe(1);
  console.info(JSON.stringify({ scenario: '25000 short lines', bytes: Buffer.byteLength(text), chunks: chunks.length, workerMs: Date.now() - started, maxConcurrentWriteMs: maxWriteMs }));
}, 30_000);

async function reindexFixture(tagId?: string) {
  const resource = await create('旧索引正文');
  if (tagId) await prisma.materialTag.create({ data: { materialId: resource.id, tagId } });
  const extraction = await prisma.materialExtraction.update({ where: { materialId_revision: { materialId: resource.id, revision: 1 } }, data: { status: 'running', generation: 1, leaseToken: 'old' } });
  expect(await publishLibraryExtraction(extraction.id, 'old', 1, outcome('旧索引正文'))).toBe(true);
  const oldPage = await library.content(ownerActor, resource.id, 1);
  await prisma.materialExtraction.update({ where: { id: extraction.id }, data: { status: 'running', generation: 2, leaseToken: 'staging' } });
  const pending = publishLibraryExtraction(extraction.id, 'staging', 2, outcome('新代未发布的正文'.repeat(15_000)));
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await prisma.materialChunk.count({ where: { extractionId: extraction.id, generation: 2 } }) > 0) return { resource, extraction, oldPage, pending };
    await turn();
  }
  throw new Error('No staged batch was observed');
}

it('never exposes partial new generations and removes staging when the lease is replaced', async () => {
  const { resource, extraction, oldPage, pending } = await reindexFixture();
  expect(await library.content(ownerActor, resource.id, 1)).toEqual(oldPage);
  await prisma.materialExtraction.update({ where: { id: extraction.id }, data: { generation: 3, leaseToken: 'replacement' } });
  expect(await pending).toBe(false);
  expect((await prisma.materialExtraction.findUniqueOrThrow({ where: { id: extraction.id } })).indexedGeneration).toBe(1);
  expect(await prisma.materialChunk.count({ where: { extractionId: extraction.id, generation: 2 } })).toBe(0);
  expect((await library.chunk(ownerActor, oldPage.items[0].id)).text).toBe('旧索引正文');
}, 15_000);

it('requeues staging on shared tag rename even when the material organization revision is unchanged', async () => {
  const now = new Date().toISOString();
  const tag = await prisma.libraryTag.create({ data: { id: randomUUID(), name: '原共享标签', normalizedName: `original-${randomUUID()}`, createdAt: now, updatedAt: now } });
  const { resource, extraction, oldPage, pending } = await reindexFixture(tag.id);
  const before = await prisma.material.findUniqueOrThrow({ where: { id: resource.id } });
  await prisma.libraryTag.update({ where: { id: tag.id }, data: { name: '新共享标签', normalizedName: `renamed-${randomUUID()}`, revision: { increment: 1 } } });
  expect(await pending).toBe(false);
  expect((await prisma.material.findUniqueOrThrow({ where: { id: resource.id } })).organizationRevision).toBe(before.organizationRevision);
  expect(await prisma.materialExtraction.findUniqueOrThrow({ where: { id: extraction.id } })).toMatchObject({ status: 'queued', indexedGeneration: 1, leaseToken: null });
  expect(await library.content(ownerActor, resource.id, 1)).toEqual(oldPage);
  expect(await prisma.materialChunk.count({ where: { extractionId: extraction.id, generation: 2 } })).toBe(0);
  await prisma.materialExtraction.update({ where: { id: extraction.id }, data: { generation: 3, leaseToken: 'renamed', status: 'running' } });
  expect(await publishLibraryExtraction(extraction.id, 'renamed', 3, outcome('新代正文'))).toBe(true);
  const documents = await prisma.librarySearchDocument.findMany({ where: { materialId: resource.id } });
  expect(documents.every((document) => document.tagsNorm === '新共享标签')).toBe(true);
}, 15_000);

it('drains 121 plain-text jobs promptly while retaining line locators and full authority', async () => {
  const ids: string[] = [];
  for (let index = 1; index <= 121; index++) {
    const content = index === 101 ? '\uFEFF只有第101份正文包含的词\r\n😀 第二行' : `资料 ${index} 的正文`;
    ids.push((await create(content)).id);
  }
  await prisma.materialExtraction.updateMany({ where: { materialId: { in: ids } }, data: { nextAttemptAt: '1970-01-01T00:00:00.000Z' } });
  const started = Date.now();
  const stop = startLibraryWorker();
  let count = 0;
  try {
    while (Date.now() - started < 15_000) {
      count = await prisma.materialExtraction.count({ where: { materialId: { in: ids }, status: 'ready' } });
      if (count === 121) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(count).toBe(121);
  } finally { stop(); }
  const page = await library.content(ownerActor, ids[100], 1);
  expect(page.items[0]).toMatchObject({ text: '\uFEFF只有第101份正文包含的词\r\n😀 第二行', locator: { kind: 'line', startLine: 1, endLine: 2 } });
  expect((await resources.read(ownerActor, ids[100], 1)).content).toBe(page.items[0].text);
  expect((await library.search(ownerActor, '只有第101份正文包含的词', {})).items.some((item) => item.id === ids[100])).toBe(true);
  console.info(JSON.stringify({ scenario: '121 plain-text queue', jobs: count, workerMs: Date.now() - started }));
  // Let the at-most-two already claimed jobs complete before the next fixture.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!await prisma.materialExtraction.count({ where: { status: 'running', leaseUntil: { gt: new Date().toISOString() } } })) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}, 30_000);

it('does not spin on an empty queue or restart scheduled work after stop', async () => {
  let claimed = false;
  const mock = vi.spyOn(coordinator, 'coordinatorWork').mockImplementation((() => Promise.resolve({ claimed })) as typeof coordinator.coordinatorWork);
  let stop = startLibraryWorker();
  try {
    await turn();
    const idleCalls = mock.mock.calls.length;
    expect(idleCalls).toBe(3); // Startup check and the two bounded claim attempts.
    await turn();
    await turn();
    expect(mock.mock.calls.length).toBe(idleCalls);
    stop();
    claimed = true;
    stop = startLibraryWorker();
    // Allow claims to settle and queue their setImmediate continuations, then stop.
    for (let index = 0; index < 8; index++) await Promise.resolve();
    stop();
    const stoppedCalls = mock.mock.calls.length;
    await turn();
    await turn();
    expect(mock.mock.calls.length).toBe(stoppedCalls);
  } finally { stop(); mock.mockRestore(); }
});

it('requeues a generation when organization changes while it is staged', async () => {
  const { resource, extraction, oldPage, pending } = await reindexFixture();
  await prisma.material.update({ where: { id: resource.id }, data: { title: '并发改名', organizationRevision: { increment: 1 } } });
  expect(await pending).toBe(false);
  const current = await prisma.materialExtraction.findUniqueOrThrow({ where: { id: extraction.id } });
  expect(current).toMatchObject({ status: 'queued', indexedGeneration: 1, leaseToken: null });
  expect(await library.content(ownerActor, resource.id, 1)).toEqual(oldPage);
  expect(await prisma.materialChunk.count({ where: { extractionId: extraction.id, generation: 2 } })).toBe(0);
}, 15_000);
