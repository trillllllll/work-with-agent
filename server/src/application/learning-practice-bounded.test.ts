import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { prisma } from '../infrastructure/prisma.js';
import { ownerActor, internalActor } from './security.js';
import { readPracticeSession, practiceHistory, practiceGrades, searchLearning } from './learning-practice/read.js';
import { attemptViews, type Db } from './learning-practice/store.js';
import { assistanceForItem } from './learning-practice/assistance.js';

const prefix = `bounded:${randomUUID()}:`;
const key = (part: string) => `${prefix}${part}`;
afterEach(async () => {
  await prisma.learningPracticeEvent.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.learningGrade.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.learningAttempt.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.learningAnswerDraft.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.learningPracticeItem.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.learningPracticeSession.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.learningQuestionVersion.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.learningQuestion.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.learningNode.updateMany({ where: { id: { startsWith: prefix } }, data: { parentId: null } });
  await prisma.learningNode.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.learningMap.deleteMany({ where: { id: { startsWith: prefix } } });
});

it('keeps session reads bounded while every attempt and grade remains reachable, including the effective older grade', async () => {
  const stamp = new Date().toISOString();
  const ownerId = ownerActor.id;
  await prisma.learningMap.create({ data: { id: key('map'), title: '历史分页', goal: '', createdAt: stamp, updatedAt: stamp } });
  await prisma.learningNode.create({ data: { id: key('node'), mapId: key('map'), title: '历史节点', kind: 'item', createdAt: stamp, updatedAt: stamp } });
  await prisma.learningQuestion.create({ data: { id: key('q'), mapId: key('map'), nodeId: key('node'), currentVersionId: key('v'), createdAt: stamp } });
  await prisma.learningQuestionVersion.create({ data: { id: key('v'), questionId: key('q'), nodeId: key('node'), nodeTitle: '历史节点', contentJson: JSON.stringify({ nodeId: key('node'), type: 'short', prompt: '公开问题', answer: 'secret', explanation: 'secret', rubric: 'secret', hints: ['提示一', '提示二'], options: [], difficulty: 'medium', objective: '理解', source: { kind: 'note', label: '来源' } }), promptVersion: 'test', createdAt: stamp } });
  await prisma.learningPracticeSession.create({ data: { id: key('s'), ownerId, mapId: key('map'), mapTitle: '历史分页', generationJobId: key('job'), mode: 'knowledge', configJson: '{}', createdAt: stamp, updatedAt: stamp } });
  await prisma.learningPracticeItem.create({ data: { id: key('item'), sessionId: key('s'), questionVersionId: key('v'), position: 0, selectionReason: 'selected_knowledge' } });
  await prisma.learningAnswerDraft.create({ data: { id: key('draft'), itemId: key('item'), activeAttemptId: key('a125'), attemptNo: 125, submitted: true, updatedAt: stamp } });
  await prisma.learningAttempt.createMany({ data: Array.from({ length: 125 }, (_, i) => ({ id: key(`a${i + 1}`), ownerId, itemId: key('item'), questionVersionId: key('v'), attemptNo: i + 1, clientAttemptId: key(`c${i}`), answerJson: JSON.stringify(`原始答案${i + 1}`), submittedAt: stamp, gradingState: 'succeeded', currentGradeId: i === 124 ? key('g1') : null })) });
  await prisma.learningGrade.createMany({ data: Array.from({ length: 17 }, (_, i) => ({ id: key(`g${i + 1}`), attemptId: key('a125'), version: i + 1, method: 'model', state: 'succeeded', result: 'correct', score: 1, maxScore: 1, explanation: `历史判题${i + 1}`, strengths: '', mistakesJson: '[]', promptVersion: 'test', createdAt: stamp })) });
  await prisma.learningGrade.createMany({ data: Array.from({ length: 11 }, (_, i) => ({ id: key(`b${i + 1}`), attemptId: key('a124'), version: i + 1, method: 'model', state: 'succeeded', result: 'partial', score: 0.5, maxScore: 1, explanation: `另一作答判题${i + 1}`, strengths: '', mistakesJson: '[]', promptVersion: 'test', createdAt: stamp })) });
  await prisma.learningAttempt.update({ where: { id: key('a124') }, data: { currentGradeId: key('b1') } });
  await prisma.learningPracticeSession.create({ data: { id: key('foreign-session'), ownerId: 'another-owner', mapId: key('map'), mapTitle: '隔离会话', generationJobId: key('foreign-job'), mode: 'knowledge', configJson: '{}', createdAt: stamp, updatedAt: stamp } });
  await prisma.learningPracticeItem.create({ data: { id: key('foreign-item'), sessionId: key('foreign-session'), questionVersionId: key('v'), position: 0, selectionReason: 'selected_knowledge' } });
  await prisma.learningAttempt.create({ data: { id: key('foreign-attempt'), ownerId: 'another-owner', itemId: key('foreign-item'), questionVersionId: key('v'), clientAttemptId: key('foreign-client'), attemptNo: 1, answerJson: '"PRIVATE_OTHER_ANSWER"', submittedAt: stamp, currentGradeId: key('foreign-grade') } });
  await prisma.learningGrade.create({ data: { id: key('foreign-grade'), attemptId: key('foreign-attempt'), version: 1, method: 'model', state: 'succeeded', result: 'incorrect', score: 0, maxScore: 1, explanation: 'PRIVATE_OTHER_GRADE', strengths: '', mistakesJson: '[]', promptVersion: 'test', createdAt: stamp } });
  // Defensively reject a corrupt pointer rather than borrowing another attempt's grade.
  await prisma.learningAttempt.update({ where: { id: key('a123') }, data: { currentGradeId: key('foreign-grade') } });
  await prisma.learningPracticeEvent.createMany({ data: Array.from({ length: 400 }, (_, i) => ({ id: key(`e${i}`), ownerId, itemId: key('item'), activeAttemptId: key('a1'), eventKey: key(`event${i}`), type: 'hint', payloadJson: JSON.stringify({ level: i === 0 ? 2 : 1 }), createdAt: stamp })) });
  const session = await readPracticeSession(key('s'));
  const item = session.items[0];
  expect(item.attempts.map(a => a.attemptNo)).toEqual([121, 122, 123, 124, 125]);
  expect(item.attemptsNextCursor).toBe('5');
  expect(item.hintCount).toBe(2);
  expect(item.assistance).toBe(true);
  expect(item.solution).toBeUndefined();
  const latest = item.attempts.at(-1)!;
  expect(latest.grade?.id).toBe(key('g1'));
  expect(latest.grades.map(g => g.version)).toEqual([13, 14, 15, 16, 17]);
  expect(latest.grades.every(g => typeof g.version === 'number' && typeof g.score === 'number' && typeof g.maxScore === 'number')).toBe(true);
  expect(() => JSON.stringify(session)).not.toThrow();
  expect(latest.gradesNextCursor).toBe('13');
  expect(item.attempts.find(a => a.attemptNo === 124)?.grade?.id).toBe(key('b1'));
  expect(item.attempts.find(a => a.attemptNo === 123)?.grade).toBeNull();
  const firstPage = await practiceHistory({ itemId: item.id, limit: 3 });
  expect(firstPage.items.map(a => a.attemptNo)).toEqual([125, 124, 123]);
  expect(firstPage.items.map(a => a.grade?.id ?? null)).toEqual([key('g1'), key('b1'), null]);
  expect(firstPage.items[0].grades.map(g => g.version)).toEqual([13, 14, 15, 16, 17]);
  expect(firstPage.items[1].grades.map(g => g.version)).toEqual([7, 8, 9, 10, 11]);
  expect(firstPage.nextCursor).toBe('3');
  expect(JSON.stringify(firstPage)).not.toContain('PRIVATE_OTHER');
  const windowSizes: number[] = [];
  let currentGradeBatches = 0;
  const recordingDb = {
    $queryRaw: async (query: Parameters<Db['$queryRaw']>[0]) => {
      const rows = await prisma.$queryRaw<unknown[]>(query);
      windowSizes.push(rows.length); return rows;
    },
    learningGrade: { findMany: (args: Parameters<Db['learningGrade']['findMany']>[0]) => {
      currentGradeBatches++; return prisma.learningGrade.findMany(args);
    } },
  } as unknown as Db;
  const selectedAttempts = await prisma.learningAttempt.findMany({ where: { id: { in: firstPage.items.map(a => a.id) } }, orderBy: { attemptNo: 'desc' } });
  const projected = await attemptViews(recordingDb, selectedAttempts);
  expect(projected.map(a => a.grade?.id ?? null)).toEqual([key('g1'), key('b1'), null]);
  expect(windowSizes).toEqual([12]); // Six rows per graded attempt, not all 28 historical grades.
  expect(currentGradeBatches).toBe(1);
  expect((await practiceHistory({ mapId: key('map'), limit: 100 })).items.every(a => a.sessionId === key('s'))).toBe(true);
  const attempts = new Set(item.attempts.map(a => a.id));
  let cursor: string | null = item.attemptsNextCursor!;
  while (cursor) {
    const page = await practiceHistory({ itemId: item.id, mapId: key('map'), nodeId: key('node'), limit: 19, cursor });
    expect(page.items.length).toBeLessThanOrEqual(19);
    for (const attempt of page.items) { expect(attempts.has(attempt.id)).toBe(false); attempts.add(attempt.id); }
    cursor = page.nextCursor;
  }
  expect(attempts.size).toBe(125);
  const grades = new Set(latest.grades.map(g => g.id));
  cursor = latest.gradesNextCursor!;
  while (cursor) {
    const page = await practiceGrades(latest.id, { limit: 4, cursor });
    for (const grade of page.items) { expect(grades.has(grade.id)).toBe(false); grades.add(grade.id); }
    cursor = page.nextCursor;
  }
  expect(grades.size).toBe(17);
  expect((await practiceHistory({ itemId: item.id, mapId: 'different-map' })).items).toEqual([]);
  await expect(practiceGrades(latest.id, {}, internalActor)).rejects.toMatchObject({ status: 403 });
  expect(await assistanceForItem(prisma, item.id)).toEqual({ assisted: true, solutionViewed: false, uncertain: false, pendingSources: [] });
  await prisma.learningQuestion.update({ where: { id: key('q') }, data: { archived: true } });
  const archived = await practiceHistory({ itemId: item.id, limit: 1 });
  expect(archived.items[0].question.archived).toBe(true);
  expect(archived.items[0].answer).toBe('原始答案125');
});

it('batches shared search ancestors while keeping cross-map paging, state filtering and malformed paths isolated', async () => {
  const stamp = new Date().toISOString();
  const mapA = key('search-map-a'), mapB = key('search-map-b');
  await prisma.learningMap.createMany({ data: [{ id: mapA, title: '主题甲', createdAt: stamp, updatedAt: stamp }, { id: mapB, title: '主题乙', createdAt: stamp, updatedAt: stamp }] });
  const node = (part: string, mapId: string, title: string, kind = 'topic', parentId: string | null = null, sortOrder = 0, status = 'learning') => ({ id: key(part), mapId, title, kind, parentId, sortOrder, status, detail: kind === 'item' ? prefix : '', createdAt: stamp, updatedAt: stamp });
  await prisma.learningNode.create({ data: node('root', mapA, '基础') });
  await prisma.learningNode.create({ data: node('branch', mapA, '定义', 'topic', key('root')) });
  await prisma.learningNode.createMany({ data: [node('a1', mapA, '甲一', 'item', key('branch'), 1), node('a2', mapA, '甲二', 'item', key('branch'), 2), node('done', mapA, '已掌握', 'item', key('branch'), 3, 'done')] });
  await prisma.learningNode.create({ data: node('foreign-parent', mapB, '不属于甲的路径') });
  await prisma.learningNode.create({ data: node('foreign-path', mapA, '甲跨主题坏路径', 'item', key('foreign-parent'), 4) });
  await prisma.learningNode.create({ data: node('cycle-a', mapB, '环甲') });
  await prisma.learningNode.create({ data: node('cycle-b', mapB, '环乙', 'topic', key('cycle-a')) });
  await prisma.learningNode.update({ where: { id: key('cycle-a') }, data: { parentId: key('cycle-b') } });
  await prisma.learningNode.createMany({ data: [node('b1', mapB, '乙一', 'item', key('cycle-a'), 1), node('b2', mapB, '乙二', 'item', null, 2)] });
  const first = await searchLearning({ q: prefix, status: 'learning', limit: 2 });
  expect(first.items.map(n => n.id)).toEqual([key('a1'), key('a2')]);
  expect(first.items.map(n => n.path)).toEqual([['主题甲', '基础', '定义'], ['主题甲', '基础', '定义']]);
  const second = await searchLearning({ q: prefix, status: 'learning', limit: 2, cursor: first.nextCursor! });
  expect(second.items.map(n => n.id)).toEqual([key('foreign-path'), key('b1')]);
  expect(second.items[0].path).toEqual(['主题甲']);
  expect(second.items[1].path[0]).toBe('主题乙');
  expect(new Set(second.items[1].path).size).toBe(second.items[1].path.length);
  const third = await searchLearning({ q: prefix, status: 'learning', limit: 2, cursor: second.nextCursor! });
  expect(third.items.map(n => n.id)).toEqual([key('b2')]); expect(third.nextCursor).toBeNull();
  expect((await searchLearning({ q: prefix, mapId: mapA, status: 'done' })).items.map(n => n.id)).toEqual([key('done')]);
});
