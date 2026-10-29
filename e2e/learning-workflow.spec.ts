import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { PracticeJobView, PracticeQuestionType, PracticeReviewView, PracticeSessionView } from '../server/src/domain/learning-practice.js';

// This suite owns an isolated database, ports and model transport. Do not run it
// against the generic suite's server or turn a skip into evidence of acceptance.
test.skip(process.env.LEARNING_WORKFLOW_E2E !== '1', 'Run with playwright.learning-workflow.config.ts');
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3038';

async function read<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${api}${path}`);
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return (await response.json()).data as T;
}
async function write<T>(request: APIRequestContext, path: string, data: object): Promise<T> {
  const response = await request.post(`${api}${path}`, { data });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return (await response.json()).data as T;
}
async function seed(request: APIRequestContext) {
  const suffix = randomUUID().slice(0, 8);
  const result = await write<{ results: Array<{ id: string; revision: number }> }>(request, '/api/v1/commands', {
    requestId: randomUUID(), commands: [
      { kind: 'learning.map.create', clientRef: 'map', input: { title: `持久练习验收 ${suffix}`, goal: '保留学习过程并持续改进理解。' } },
      { kind: 'learning.node.create', clientRef: 'group', input: { mapId: { $ref: 'map' }, parentId: null, kind: 'topic', title: '学习记录', detail: '', sortOrder: 0 } },
      { kind: 'learning.node.create', input: { mapId: { $ref: 'map' }, parentId: { $ref: 'group' }, kind: 'item', title: `可核查的作答 ${suffix}`, detail: '提交时保留原始答案和题目版本，后续重做保留每次尝试。', status: 'learning', sortOrder: 0 } },
      { kind: 'learning.node.create', input: { mapId: { $ref: 'map' }, parentId: { $ref: 'group' }, kind: 'item', title: `反思与巩固 ${suffix}`, detail: '按原始证据复习，人工安排和掌握状态应分别处理。', status: 'review', sortOrder: 1 } },
    ],
  });
  return { mapId: result.results[0].id, groupId: result.results[1].id, nodeId: result.results[2].id, nodeTitle: `可核查的作答 ${suffix}`, reviewTitle: `反思与巩固 ${suffix}`, mapTitle: `持久练习验收 ${suffix}` };
}
async function generate(request: APIRequestContext, mapId: string, nodeId: string, types: PracticeQuestionType[] = ['single'], count = 3) {
  const { job } = await write<{ job: PracticeJobView }>(request, '/api/v1/learning/practice/generate', {
    requestId: randomUUID(), mapId, nodeIds: [nodeId], count, types, difficulty: 'easy', mode: 'knowledge',
  });
  let current = job;
  await expect.poll(async () => {
    current = await read<PracticeJobView>(request, `/api/v1/learning/jobs/${job.id}`);
    return current.state;
  }, { timeout: 45_000, message: 'The real generation worker must finish the fixture request' }).toBe('succeeded');
  expect(current.error).toBeNull();
  expect(current.candidate?.questions).toHaveLength(count);
  return current;
}
async function start(request: APIRequestContext, job: PracticeJobView, requestId = randomUUID()) {
  return write<{ session: PracticeSessionView }>(request, '/api/v1/learning/practice/start', { requestId, jobId: job.id, candidateRevision: job.candidateRevision });
}
async function session(request: APIRequestContext, id: string) {
  return read<PracticeSessionView>(request, `/api/v1/learning/practice/sessions/${id}`);
}
async function readNode(request: APIRequestContext, mapId: string, nodeId: string) {
  type Node = { id: string; title: string; detail: string; status: string; children: Node[] };
  const map = await read<{ tree: Node[] }>(request, `/api/v1/learning/maps/${mapId}`);
  const flatten = (nodes: Node[]): Node[] => nodes.flatMap(node => [node, ...flatten(node.children ?? [])]);
  const node = flatten(map.tree).find(item => item.id === nodeId);
  expect(node, 'Seeded historical node remains available').toBeTruthy();
  return node!;
}
async function openPractice(page: Page, current: PracticeSessionView) {
  await page.goto(`/#/learning?map=${current.mapId}&session=${current.id}`);
  await expect(page.getByTestId('practice-session')).toHaveAttribute('data-session-id', current.id);
  await expect(page.getByTestId('practice-question')).toBeVisible();
}
async function waitForGrade(request: APIRequestContext, id: string, index = 0) {
  let current = await session(request, id);
  await expect.poll(async () => {
    current = await session(request, id);
    return current.items[index].attempts.at(-1)?.gradingState;
  }, { timeout: 45_000 }).toBe('succeeded');
  return current;
}
function submission(current: PracticeSessionView, index: number, answer: string | string[]) {
  const item = current.items[index];
  return {
    requestId: randomUUID(), activeAttemptId: item.draft.activeAttemptId, expectedDraftRevision: item.draft.revision,
    questionVersionId: item.question.versionId, clientAttemptId: randomUUID(), answer,
  };
}
function expectNoPrivateAnswer(value: unknown) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(expectNoPrivateAnswer); return; }
  for (const [key, child] of Object.entries(value)) {
    expect(['answer', 'rubric', 'explanation', 'hints'], `Private field ${key} leaked before adoption/submission`).not.toContain(key);
    expectNoPrivateAnswer(child);
  }
}

test('A06 A15 A29: generated candidates hide answers and adoption freezes validated versions', async ({ request }) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId);
  expectNoPrivateAnswer(job.candidate);
  expect(job.candidate?.questions.every(question => question.nodeId === seeded.nodeId)).toBe(true);
  const rejected = await request.post(`${api}/api/v1/learning/practice/start`, { data: { requestId: randomUUID(), jobId: job.id, candidateRevision: 'stale-candidate-version' } });
  expect(rejected.ok()).toBe(false);
  const injected = await request.post(`${api}/api/v1/learning/practice/start`, { data: { requestId: randomUUID(), jobId: job.id, candidateRevision: job.candidateRevision, rubric: '客户端伪造评分规则' } });
  expect(injected.status()).toBe(400);
  const startId = randomUUID();
  const accepted = await start(request, job, startId);
  const retried = await start(request, job, startId);
  expect(retried.session.id).toBe(accepted.session.id);
  expect(accepted.session.items.map(item => item.position)).toEqual([0, 1, 2]);
  for (const item of accepted.session.items) {
    expect(item.solution).toBeUndefined();
    expectNoPrivateAnswer(item.question);
    expect(item.attempts).toEqual([]);
    expect(item.hints).toEqual([]);
  }
  const frozen = accepted.session.items.map(item => ({ versionId: item.question.versionId, prompt: item.question.prompt }));
  await write(request, '/api/v1/commands', { requestId: randomUUID(), commands: [{ kind: 'learning.node.update', targetId: seeded.nodeId, expectedRevision: 1, input: { detail: '笔记后来补充了新的理解，不能改写已开始题目。' } }] });
  const restored = await session(request, accepted.session.id);
  expect(restored.items.map(item => ({ versionId: item.question.versionId, prompt: item.question.prompt }))).toEqual(frozen);
});

test('A09 A10 A16: duplicate submission is idempotent and a second device cannot rewrite a submitted attempt', async ({ request }) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['single'], 1);
  const current = (await start(request, job)).session, item = current.items[0];
  const input = submission(current, 0, 'a');
  const responses = await Promise.all([
    request.post(`${api}/api/v1/learning/practice/items/${item.id}/submit`, { data: input }),
    request.post(`${api}/api/v1/learning/practice/items/${item.id}/submit`, { data: input }),
  ]);
  for (const response of responses) expect(response.ok(), await response.text()).toBe(true);
  const saved = await session(request, current.id);
  expect(saved.items[0].attempts).toHaveLength(1);
  expect(saved.items[0].attempts[0].answer).toBe('a');
  const changedRequest = await request.post(`${api}/api/v1/learning/practice/items/${item.id}/submit`, { data: { ...input, answer: 'b' } });
  expect(changedRequest.ok()).toBe(false);
  const secondDevice = await request.post(`${api}/api/v1/learning/practice/items/${item.id}/submit`, { data: { ...input, requestId: randomUUID(), clientAttemptId: randomUUID(), answer: 'b' } });
  expect(secondDevice.ok()).toBe(false);
  const unchanged = await session(request, current.id);
  expect(unchanged.items[0].attempts).toHaveLength(1);
  expect(unchanged.items[0].attempts[0].answer).toBe('a');
});

test('A11 A12: grading failure retains the answer and never records it as an incorrect result', async ({ request }) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['short'], 1);
  const current = (await start(request, job)).session;
  const input = submission(current, 0, 'fixture-model-failure：这里保留原始答案。');
  await write(request, `/api/v1/learning/practice/items/${current.items[0].id}/submit`, input);
  let stored = current;
  await expect.poll(async () => {
    stored = await session(request, current.id);
    return stored.items[0].attempts[0]?.gradingState;
  }, { timeout: 45_000 }).toBe('failed');
  expect(stored.items[0].attempts).toHaveLength(1);
  expect(stored.items[0].attempts[0].answer).toBe(input.answer);
  expect(stored.items[0].attempts[0].grade).toBeNull();
  expect(stored.summary.incorrect).toBe(0);
  expect(stored.summary.correct).toBe(0);
});

test('A01 A03: learning page reads old notes and filters matching content without changing mastery', async ({ page, request }) => {
  const seeded = await seed(request);
  await page.addInitScript(() => { localStorage.setItem('dovun.theme', 'light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/learning');
  await expect(page.getByTestId('learning-home-summary')).toBeVisible();
  await page.getByRole('combobox', { name: '学习主题', exact: true }).click();
  await page.getByRole('option', { name: seeded.mapTitle, exact: true }).click();
  const search = page.getByTestId('learning-search').getByRole('textbox', { name: '搜索学习内容' });
  await search.fill('原始答案');
  const results = page.getByRole('region', { name: '学习搜索结果', exact: true });
  await expect(results.getByText(seeded.nodeTitle, { exact: true })).toBeVisible();
  await expect(results).toContainText(`${seeded.mapTitle} / 学习记录`);
  await expect(results).toContainText('提交时保留原始答案和题目版本');
  await page.getByRole('combobox', { name: '掌握状态筛选', exact: true }).click();
  await page.getByRole('option', { name: '需巩固', exact: true }).click();
  await expect(results).toContainText('没有找到匹配的知识点');
  await search.fill('人工安排');
  await expect(results.getByText(seeded.reviewTitle, { exact: true })).toBeVisible();
  await expect(results.getByText(seeded.nodeTitle, { exact: true })).toHaveCount(0);
  const node = await readNode(request, seeded.mapId, seeded.nodeId);
  expect(node.status).toBe('learning');
  expect(node.detail).toContain('保留原始答案');
});

test('A07 A08 A17: third-question draft and position survive reload and an independent browser context', async ({ page, context, browser, request }) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['short']);
  const current = (await start(request, job)).session;
  await openPractice(page, current);
  await page.getByTestId('practice-session').locator('nav button').nth(2).click();
  await expect(page.getByTestId('practice-question')).toContainText('第 3 题');
  const answer = '我会保留原始答案和题目版本，便于回看每次变化。';
  await page.getByTestId('practice-answer').fill(answer);
  await expect.poll(async () => (await session(request, current.id)).items[2].draft.answer).toBe(answer);
  await expect.poll(async () => (await session(request, current.id)).currentPosition).toBe(2);
  await page.reload();
  await expect(page.getByTestId('practice-question')).toContainText('第 3 题');
  await expect(page.getByTestId('practice-answer')).toHaveValue(answer);
  const second = await browser.newContext({ storageState: await context.storageState(), baseURL: process.env.E2E_UI_URL, locale: 'zh-CN' });
  try {
    const other = await second.newPage();
    await openPractice(other, current);
    await expect(other.getByTestId('practice-question')).toContainText('第 3 题');
    await expect(other.getByTestId('practice-answer')).toHaveValue(answer);
    const saved = await session(request, current.id);
    expect(saved.items[2].attempts).toHaveLength(0);
    expect(saved.items.map(item => item.question.versionId)).toEqual(current.items.map(item => item.question.versionId));
  } finally { await second.close(); }
});

test('A09: a committed submission with a lost response retries its original durable request', async ({ page, request }) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['single'], 1);
  const current = (await start(request, job)).session, item = current.items[0];
  await openPractice(page, current);
  await page.getByRole('radio', { name: '提交时保存原始答案' }).check();
  await expect.poll(async () => (await session(request, current.id)).items[0].draft.answer).toBe('a');
  const bodies: Array<Record<string, unknown>> = [];
  await page.route(`**/practice/items/${item.id}/submit`, async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) {
      const committed = await route.fetch();
      expect(committed.ok(), await committed.text()).toBe(true);
      await route.abort('failed');
    } else { await route.continue(); }
  });
  await page.getByTestId('practice-submit').click();
  await expect.poll(() => bodies.length).toBe(1);
  await expect(page.getByTestId('practice-submit')).toBeEnabled();
  await page.getByTestId('practice-submit').click();
  await expect(page.getByTestId('practice-feedback')).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  const stored = await waitForGrade(request, current.id);
  expect(stored.items[0].attempts).toHaveLength(1);
  expect(stored.items[0].attempts[0].answer).toBe('a');
  expect(stored.items[0].attempts[0].grades).toHaveLength(1);
});

test('A16: another device submission preserves the offline local answer as a visible conflict', async ({ page, context, browser, request }) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['short'], 1);
  const current = (await start(request, job)).session;
  await openPractice(page, current);
  const otherContext = await browser.newContext({ storageState: await context.storageState(), baseURL: process.env.E2E_UI_URL, locale: 'zh-CN' });
  try {
    const other = await otherContext.newPage();
    await openPractice(other, current);
    await otherContext.setOffline(true);
    const localAnswer = '另一台设备的独立思路，暂时保留在本机。';
    await other.getByTestId('practice-answer').fill(localAnswer);
    await page.getByTestId('practice-answer').fill('第一台设备提交原始答案和题目版本。');
    await expect.poll(async () => (await session(request, current.id)).items[0].draft.answer).toContain('第一台设备');
    await page.getByTestId('practice-submit').click();
    await expect(page.getByTestId('practice-feedback')).toBeVisible();
    await otherContext.setOffline(false);
    await expect(other.getByRole('alert').filter({ hasText: '第一台设备' })).toBeVisible();
    await expect(other.getByTestId('practice-answer')).toHaveValue(localAnswer);
    const stored = await session(request, current.id);
    expect(stored.items[0].attempts).toHaveLength(1);
    expect(stored.items[0].attempts[0].answer).toContain('第一台设备');
    expect(stored.items[0].draft.answer).not.toBe(localAnswer);
  } finally { await otherContext.close(); }
});

test('A18: an offline submit stays durable and resumes once without an extra user submission', async ({ page, context, request }) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['short'], 1);
  const current = (await start(request, job)).session;
  await openPractice(page, current);
  await context.setOffline(true);
  const answer = '离线提交也要保留原始答案和题目版本。';
  await page.getByTestId('practice-answer').fill(answer);
  // Wait for the actual failed autosave, then submit; this covers the common
  // case where a user has been typing offline for longer than the debounce.
  await expect(page.getByTestId('practice-session').getByRole('alert').first()).toBeVisible();
  await page.getByTestId('practice-submit').click();
  await expect(page.getByTestId('practice-save-state')).toContainText('提交');
  expect((await session(request, current.id)).items[0].attempts).toHaveLength(0);
  await context.setOffline(false);
  await expect(page.getByTestId('practice-feedback')).toBeVisible({ timeout: 20_000 });
  const stored = await waitForGrade(request, current.id);
  expect(stored.items[0].attempts).toHaveLength(1);
  expect(stored.items[0].attempts[0].answer).toBe(answer);
  await page.reload();
  await expect(page.getByTestId('practice-feedback')).toBeVisible();
  expect((await session(request, current.id)).items[0].attempts).toHaveLength(1);
});

test('A13 A15 A22: hints and solutions remain recorded across retries without claiming independent mastery', async ({ page, request }) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['single'], 1);
  let current = (await start(request, job)).session;
  const item = current.items[0];
  await openPractice(page, current);
  await page.getByRole('button', { name: '提示', exact: true }).click();
  await expect(page.getByTestId('practice-session')).toContainText('想想重做后是否还需要回看旧答案');
  await page.getByRole('radio', { name: '提交时保存原始答案' }).check();
  await page.getByTestId('practice-submit').click();
  current = await waitForGrade(request, current.id);
  expect(current.items[0].attempts[0].assisted).toBe(true);
  expect(current.summary.independentCorrect).toBe(0);
  expect(current.summary.assistedCorrect).toBe(1);
  await write(request, `/api/v1/learning/practice/items/${item.id}/events`, { requestId: randomUUID(), activeAttemptId: item.draft.activeAttemptId, type: 'solution' });
  await write(request, `/api/v1/learning/practice/items/${item.id}/retry`, { requestId: randomUUID(), expectedDraftRevision: current.items[0].draft.revision });
  current = await session(request, current.id);
  await write(request, `/api/v1/learning/practice/items/${item.id}/submit`, submission(current, 0, 'a'));
  const retried = await waitForGrade(request, current.id);
  expect(retried.items[0].attempts).toHaveLength(2);
  expect(retried.items[0].attempts[0].solutionViewed).toBe(false);
  expect(retried.items[0].attempts[1].solutionViewed).toBe(true);
  expect(retried.items[0].attempts[0].answer).toBe('a');
  expect(retried.items[0].attempts[1].answer).toBe('a');
  expect(retried.items[0].question.versionId).toBe(item.question.versionId);
  expect((await readNode(request, seeded.mapId, seeded.nodeId)).status).toBe('learning');
});

test('A14 A21 A30: regrading retains old grades and manual review scheduling', async ({ request }) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['short'], 1);
  const current = (await start(request, job)).session;
  await write(request, `/api/v1/learning/practice/items/${current.items[0].id}/submit`, submission(current, 0, '这次答案没有解释理由。'));
  const graded = await waitForGrade(request, current.id), attempt = graded.items[0].attempts[0];
  expect(attempt.grade?.result).toBe('incorrect');
  const reviews = await read<{ items: PracticeReviewView[] }>(request, `/api/v1/learning/reviews?nodeId=${seeded.nodeId}`);
  const review = reviews.items.find(entry => entry.questionId === current.items[0].question.id)!;
  expect(review).toBeTruthy();
  const dueAt = '2031-04-05T06:07:00.000Z';
  await write(request, '/api/v1/learning/reviews/update', { requestId: randomUUID(), id: review.id, expectedRevision: review.revision, dueAt, paused: true, policy: 'manual' });
  const { job: regrade } = await write<{ job: PracticeJobView }>(request, `/api/v1/learning/practice/attempts/${attempt.id}/regrade`, { requestId: randomUUID(), reason: '请依据保存的原始题目和评分依据再次检查。' });
  await expect.poll(async () => (await read<PracticeJobView>(request, `/api/v1/learning/jobs/${regrade.id}`)).state, { timeout: 45_000 }).toBe('succeeded');
  const regraded = await session(request, current.id);
  expect(regraded.items[0].attempts[0].grades).toHaveLength(2);
  expect(regraded.items[0].attempts[0].grades.some(grade => grade.id === attempt.grade?.id)).toBe(true);
  const updated = (await read<{ items: PracticeReviewView[] }>(request, `/api/v1/learning/reviews?nodeId=${seeded.nodeId}`)).items.find(entry => entry.id === review.id)!;
  expect(updated.dueAt).toBe(dueAt);
  expect(updated.paused).toBe(true);
  expect(updated.policy).toBe('manual');
  expect(updated.manualSchedule).toBe(true);
});

test('A02 R07: practice fits the viewport and retains touch-size primary controls', async ({ page, request }, testInfo) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['short'], 3);
  await openPractice(page, (await start(request, job)).session);
  await page.getByTestId('practice-session').locator('nav button').nth(2).click();
  await expect(page.getByTestId('practice-answer')).toBeVisible();
  await expect(page.getByTestId('practice-answer')).toBeEnabled();
  await page.getByTestId('practice-answer').focus();
  await expect(page.getByTestId('practice-answer')).toBeFocused();
  const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.viewport + 1);
  const button = page.getByTestId('practice-submit');
  const bounds = await button.boundingBox();
  expect(bounds?.height).toBeGreaterThanOrEqual(44);
  expect(bounds?.width).toBeGreaterThanOrEqual(44);
  const previous = page.getByTestId('practice-session').getByRole('button', { name: '上一条', exact: true });
  await previous.scrollIntoViewIfNeeded();
  await expect(previous).toBeEnabled();
  expect(await previous.evaluate(element => {
    const box = element.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === element;
  })).toBe(true);
  await testInfo.attach('practice-responsive-simulation', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});

test('A05 A06: native setup generates scoped candidates and explicitly adopts the chosen set', async ({ page, request }) => {
  const seeded = await seed(request);
  await page.goto(`/#/learning?map=${seeded.mapId}&node=${seeded.nodeId}`);
  await expect(page.getByTestId('learning-workspace')).toBeVisible();
  await page.getByRole('button', { name: '考考我', exact: true }).click();
  const setup = page.getByTestId('practice-setup');
  await expect(setup).toBeVisible();
  await setup.getByRole('spinbutton', { name: '题量（1–20）', exact: true }).fill('2');
  const generation = page.waitForRequest(request => request.url().endsWith('/api/v1/learning/practice/generate') && request.method() === 'POST');
  await setup.getByRole('button', { name: '生成题目', exact: true }).click();
  const body = (await generation).postDataJSON();
  expect(body).toMatchObject({ mapId: seeded.mapId, nodeIds: [seeded.nodeId], count: 2 });
  const candidate = page.getByTestId('practice-candidate');
  await expect(candidate).toBeVisible({ timeout: 20_000 });
  await expect(candidate).toContainText('共 2 题');
  await expect(candidate).not.toContainText('验收解析');
  await expect(candidate).not.toContainText('提到保留原始答案');
  await candidate.getByRole('button', { name: '采用并开始', exact: true }).click();
  const practice = page.getByTestId('practice-session');
  await expect(practice).toBeVisible();
  const id = await practice.getAttribute('data-session-id');
  expect(id).toBeTruthy();
  const stored = await session(request, id!);
  expect(stored.items).toHaveLength(2);
  expect(stored.items.every(item => item.question.nodeId === seeded.nodeId)).toBe(true);
  expect(stored.summary.answered).toBe(0);
});

test('A05 A07 A31: asking the study assistant retains the third draft and records delivered help', async ({ page, request }) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['short']);
  const current = (await start(request, job)).session;
  await openPractice(page, current);
  await page.getByTestId('practice-session').locator('nav button').nth(2).click();
  const answer = '当前第三题：我要保留原始答案和历史证据。';
  await page.getByTestId('practice-answer').fill(answer);
  await expect.poll(async () => (await session(request, current.id)).items[2].draft.answer).toBe(answer);
  await page.getByTestId('practice-session').getByRole('button', { name: '问学习助手', exact: true }).click();
  const panel = page.getByTestId('ai-assistant');
  await expect(panel.getByRole('heading', { name: '学习助手', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: /移除.*理解学习记录持久化/ })).toBeVisible();
  const composer = panel.getByRole('textbox', { name: '向 AI 提问', exact: true });
  await expect(composer).toHaveValue(/当前题目/);
  await composer.fill('请给我一个小提示，我还要自己完成当前第三题。');
  const sent = page.waitForRequest(request => request.url().endsWith('/api/chat') && request.method() === 'POST');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.identityId).toBe('study');
  expect(body.context.attachments).toHaveLength(1);
  expect(body.context.attachments[0]).toMatchObject({ learningSessionId: current.id, learningItemId: current.items[2].id, learningAttemptId: current.items[2].draft.activeAttemptId, learningIntent: 'hint', unsaved: true });
  expect(body.context.attachments[0].text).toContain(answer);
  await expect(panel.getByText('可以先回看当前题目的考点，再比较你的思路；这是一条学习辅导验收回复。', { exact: true })).toBeVisible({ timeout: 20_000 });
  await panel.getByRole('button', { name: '返回学习', exact: true }).click();
  await expect(page.getByTestId('practice-question')).toContainText('第 3 题');
  await expect(page.getByTestId('practice-answer')).toHaveValue(answer);
  await expect.poll(async () => (await session(request, current.id)).items[2].assistance).toBe(true);
  await page.getByTestId('practice-submit').click();
  const graded = await waitForGrade(request, current.id, 2);
  expect(graded.items[2].attempts[0].assisted).toBe(true);
  expect(graded.items[2].attempts[0].assistanceUncertain).toBe(false);
  expect(graded.summary.independentCorrect).toBe(0);
  expect(graded.summary.assistedCorrect).toBe(1);
});

test('A04 A27: switching identities restores each draft and references without carrying work context into study', async ({ page, request, isMobile }) => {
  const seeded = await seed(request), materialTitle = `工作参考 ${randomUUID().slice(0, 8)}`;
  await write(request, '/api/v1/commands', { requestId: randomUUID(), commands: [{ kind: 'material.create', input: { topicId: null, kind: 'text', title: materialTitle, content: '工作资料不应自动带给学习助手。' } }] });
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const panel = page.getByTestId('ai-assistant');
  const composer = panel.getByRole('textbox', { name: '向 AI 提问', exact: true });
  await expect(panel.getByRole('heading', { name: 'Dovun 工作助手', exact: true, level: 2 })).toBeVisible();
  const workDraft = '这是一份尚未发送的工作草稿，需要回来继续。';
  await composer.fill(workDraft);
  await panel.getByRole('button', { name: '添加参考资料', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索参考资料', exact: true }).fill(materialTitle);
  await page.getByRole('button', { name: materialTitle, exact: true }).click();
  await expect(panel.getByTestId('assistant-context-trigger')).toContainText('1');
  await panel.getByRole('button', { name: isMobile ? '返回当前页面' : '关闭聊天', exact: true }).click();
  await page.evaluate(hash => { location.hash = hash; }, `/learning?map=${seeded.mapId}&node=${seeded.nodeId}`);
  await expect(page.getByTestId('learning-workspace')).toBeVisible();
  await page.getByRole('button', { name: '讲解一下', exact: true }).click();
  await expect(panel.getByRole('heading', { name: '学习助手', exact: true })).toBeVisible();
  await expect(composer).toHaveValue(/关键概念/);
  await expect(panel.getByRole('button', { name: `移除 ${seeded.nodeTitle}`, exact: true })).toBeVisible();
  await expect(panel.getByTestId('assistant-context-trigger')).not.toContainText('1 份');
  const studyDraft = '这是未发送的学习草稿，引用当前知识点。';
  await composer.fill(studyDraft);
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(composer).toHaveValue(studyDraft);
  await expect(panel.getByRole('button', { name: `移除 ${seeded.nodeTitle}`, exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '切换助手', exact: true }).click();
  await page.getByRole('menuitem', { name: '工作助手', exact: true }).click();
  await expect(composer).toHaveValue(workDraft);
  await expect(panel.getByTestId('assistant-context-trigger')).toContainText('1');
  await expect(panel.getByRole('button', { name: `移除 ${seeded.nodeTitle}`, exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '切换助手', exact: true }).click();
  await page.getByRole('menuitem', { name: '学习助手', exact: true }).click();
  await expect(composer).toHaveValue(studyDraft);
  await expect(panel.getByRole('button', { name: `移除 ${seeded.nodeTitle}`, exact: true })).toBeVisible();
  const sent = page.waitForRequest(request => request.url().endsWith('/api/chat') && request.method() === 'POST');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.identityId).toBe('study');
  expect(body.context.selectedMaterialIds).toEqual([]);
  expect(body.context.attachments[0]).toMatchObject({ learningNodeId: seeded.nodeId, learningIntent: 'explain' });
  await expect(panel.getByText('可以先回看当前题目的考点，再比较你的思路；这是一条学习辅导验收回复。', { exact: true })).toBeVisible({ timeout: 20_000 });
  await composer.fill('接着追问，还未发送。');
  await panel.getByRole('button', { name: '切换助手', exact: true }).click();
  await page.getByRole('menuitem', { name: '工作助手', exact: true }).click();
  await expect(composer).toHaveValue(workDraft);
  await panel.getByRole('button', { name: '切换助手', exact: true }).click();
  await page.getByRole('menuitem', { name: '学习助手', exact: true }).click();
  await expect(composer).toHaveValue('接着追问，还未发送。');
  await expect(panel.getByText(studyDraft, { exact: true })).toBeVisible();
});

test('A27: an unknown chat submission prevents identity switching and keeps its recovery snapshot', async ({ page }) => {
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const panel = page.getByTestId('ai-assistant');
  let original: Record<string, unknown> | undefined;
  await page.route('**/api/chat', route => { original = route.request().postDataJSON(); return route.abort('failed'); });
  const message = '网络断开时不能丢掉这次原始发送。';
  await panel.getByRole('textbox', { name: '向 AI 提问', exact: true }).fill(message);
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '切换助手', exact: true })).toBeDisabled();
  await expect(panel.getByRole('heading', { name: 'Dovun 工作助手', exact: true, level: 2 })).toBeVisible();
  await page.unroute('**/api/chat');
  const retried = page.waitForRequest(request => request.url().endsWith('/api/chat') && request.method() === 'POST');
  await panel.getByRole('button', { name: '重试', exact: true }).click();
  expect((await retried).postDataJSON()).toEqual(original);
  await expect(panel.getByText(message, { exact: true })).toBeVisible();
  await expect(panel.getByText('可以先回看当前题目的考点，再比较你的思路；这是一条学习辅导验收回复。', { exact: true })).toBeVisible({ timeout: 20_000 });
});

test('A26: an unsupported server keeps notes editable and enables practice only after a successful recheck', async ({ page, request }) => {
  const seeded = await seed(request);
  await page.route('**/api/v1/learning/overview', route => route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><title>404</title>Cannot GET /api/v1/learning/overview' }));
  await page.route('**/api/v1/learning/resume', route => route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><title>404</title>Cannot POST /api/v1/learning/resume' }));
  await page.goto(`/#/learning?map=${seeded.mapId}&node=${seeded.nodeId}`);
  await expect(page.getByTestId('learning-unsupported')).toContainText('服务器尚不支持');
  await expect(page.getByRole('button', { name: '练习', exact: true })).toBeDisabled();
  await expect(page.getByTestId('learning-note-reading')).toContainText('保留原始答案');
  await page.getByRole('button', { name: '编辑笔记', exact: true }).click();
  const changedTitle = `${seeded.nodeTitle} · 兼容编辑`;
  await page.getByRole('textbox', { name: '笔记标题', exact: true }).fill(changedTitle);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await readNode(request, seeded.mapId, seeded.nodeId)).title).toBe(changedTitle);
  await expect(page.getByRole('button', { name: '重新检查服务端支持', exact: true })).toBeEnabled();
  await page.unroute('**/api/v1/learning/overview');
  await page.getByRole('button', { name: '重新检查服务端支持', exact: true }).click();
  await expect(page.getByTestId('learning-unsupported')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '练习', exact: true })).toBeEnabled();
});

test('A12 A24: retiring a question preserves completed answers while removing its score from future practice', async ({ page, request }) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['single'], 1);
  const current = (await start(request, job)).session, item = current.items[0];
  await write(request, `/api/v1/learning/practice/items/${item.id}/submit`, submission(current, 0, 'b'));
  const graded = await waitForGrade(request, current.id);
  expect(graded.summary.incorrect).toBe(1);
  await write(request, `/api/v1/learning/practice/sessions/${current.id}/update`, { requestId: randomUUID(), expectedRevision: graded.revision, state: 'finished' });
  await openPractice(page, await session(request, current.id));
  await page.getByRole('button', { name: '题目操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '作废本题', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '作废本题', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const retired = await session(request, current.id);
  expect(retired.items[0].question.retired).toBe(true);
  expect(retired.items[0].attempts[0].answer).toBe('b');
  expect(retired.items[0].attempts[0].grade?.id).toBe(graded.items[0].attempts[0].grade?.id);
  expect(retired.summary).toMatchObject({ answered: 1, invalid: 1, incorrect: 0 });
  await expect(page.getByTestId('practice-result')).toContainText('已作废');
  await expect(page.getByRole('button', { name: '题目操作', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('practice-feedback')).toBeVisible();
  const wrong = await request.post(`${api}/api/v1/learning/practice/generate`, { data: { requestId: randomUUID(), mapId: seeded.mapId, nodeIds: [seeded.nodeId], mode: 'wrong', count: 1, types: ['single'] } });
  expect(wrong.ok()).toBe(false);
});

test('A19: a late pause response cannot navigate away from the page opened after leaving practice', async ({ page, request }) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['short'], 1);
  const current = (await start(request, job)).session;
  await openPractice(page, current);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const intercepted = new Promise<void>(resolve => { entered = resolve; });
  await page.route(`**/api/v1/learning/practice/sessions/${current.id}/update`, async route => {
    const response = await route.fetch();
    entered();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '暂停练习', exact: true }).click();
  await intercepted;
  await page.evaluate(() => { location.hash = '/inbox'; });
  await expect(page.getByTestId('practice-session')).toHaveCount(0);
  const received = page.waitForResponse(response => response.url().endsWith(`/practice/sessions/${current.id}/update`));
  release();
  await (await received).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page).toHaveURL(/#\/inbox$/);
  expect((await session(request, current.id)).state).toBe('paused');
});

test('A24: an archived knowledge point keeps historical practice readable but disables a new answer', async ({ page, request }) => {
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['short'], 1);
  const current = (await start(request, job)).session, item = current.items[0];
  await write(request, `/api/v1/learning/practice/items/${item.id}/submit`, submission(current, 0, '历史原始答案不能因为知识点归档而丢失。'));
  const graded = await waitForGrade(request, current.id);
  await write(request, `/api/v1/learning/practice/items/${item.id}/retry`, { requestId: randomUUID(), expectedDraftRevision: graded.items[0].draft.revision });
  await write(request, '/api/v1/commands', { requestId: randomUUID(), commands: [{ kind: 'learning.node.archive', targetId: seeded.nodeId, expectedRevision: 1, input: {} }] });
  await openPractice(page, current);
  await expect(page.getByTestId('practice-answer')).toBeDisabled();
  await expect(page.getByTestId('practice-submit')).toHaveCount(0);
  await expect(page.getByTestId('practice-session')).toContainText('停用');
  const stored = await session(request, current.id);
  expect(stored.items[0].question.archived).toBe(true);
  expect(stored.items[0].attempts[0].answer).toBe('历史原始答案不能因为知识点归档而丢失。');
  const blocked = await request.post(`${api}/api/v1/learning/practice/items/${item.id}/submit`, { data: submission(stored, 0, '归档后新答案') });
  expect(blocked.ok()).toBe(false);
  expect((await session(request, current.id)).items[0].attempts).toHaveLength(1);
});

test('A02: directory and note retain their own scroll positions through hash navigation', async ({ page, request }) => {
  const seeded = await seed(request), longTitle = `目录末端笔记 ${randomUUID().slice(0, 8)}`;
  const rows = await write<{ results: Array<{ id: string }> }>(request, '/api/v1/commands', {
    requestId: randomUUID(), commands: Array.from({ length: 28 }, (_, index) => ({
      kind: 'learning.node.create', input: { mapId: seeded.mapId, parentId: seeded.groupId, kind: 'item', title: index === 27 ? longTitle : `目录练习 ${index + 1}`, detail: index === 27 ? Array.from({ length: 70 }, (_, n) => `### 阅读段落 ${n + 1}\n\n每段记录一个可以返回继续阅读的知识点。保留独立位置，不把目录位置与笔记位置混在一起。`).join('\n\n') : '', sortOrder: index + 2 },
    })),
  });
  await page.goto(`/#/learning?map=${seeded.mapId}`);
  await page.getByRole('button', { name: '知识目录', exact: true }).click();
  const main = page.getByRole('main');
  const entry = page.getByRole('button').filter({ hasText: longTitle });
  await entry.scrollIntoViewIfNeeded();
  const mapPosition = await main.evaluate(element => element.scrollTop);
  expect(mapPosition).toBeGreaterThan(300);
  await entry.click();
  await expect(page).toHaveURL(new RegExp(`node=${rows.results.at(-1)!.id}`));
  await expect(page.getByTestId('learning-workspace')).toBeVisible();
  await expect.poll(() => main.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(2000);
  await main.evaluate(element => { element.scrollTop = 1100; });
  const notePosition = await main.evaluate(element => element.scrollTop);
  await test.info().attach('learning-scroll-before-back.json', { body: JSON.stringify({ mapPosition, notePosition, stored: await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes('scroll:')))) }), contentType: 'application/json' });
  await page.goBack();
  await expect(page.getByTestId('learning-workspace')).toHaveCount(0);
  try { await expect.poll(async () => Math.abs(await main.evaluate(element => element.scrollTop) - mapPosition)).toBeLessThan(8); }
  finally { await test.info().attach('learning-scroll-after-back.json', { body: JSON.stringify({ actual: await main.evaluate(element => element.scrollTop), stored: await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes('scroll:')))) }), contentType: 'application/json' }); }
  await entry.click();
  await expect(page.getByTestId('learning-workspace')).toBeVisible();
  await expect.poll(async () => Math.abs(await main.evaluate(element => element.scrollTop) - notePosition)).toBeLessThan(8);
});

test('A14 A15: long attempt and grading histories load older records on demand', async ({ page, request }) => {
  test.setTimeout(120_000);
  const seeded = await seed(request), job = await generate(request, seeded.mapId, seeded.nodeId, ['single'], 1);
  let current = (await start(request, job)).session;
  const itemId = current.items[0].id;
  for (let number = 1; number <= 7; number++) {
    await write(request, `/api/v1/learning/practice/items/${itemId}/submit`, submission(current, 0, 'a'));
    current = await waitForGrade(request, current.id);
    if (number < 7) {
      await write(request, `/api/v1/learning/practice/items/${itemId}/retry`, { requestId: randomUUID(), expectedDraftRevision: current.items[0].draft.revision });
      current = await session(request, current.id);
    }
  }
  const attemptId = current.items[0].attempts.at(-1)!.id;
  for (let version = 2; version <= 7; version++) {
    await write(request, `/api/v1/learning/practice/attempts/${attemptId}/regrade`, { requestId: randomUUID(), reason: '核对原始答案与当前评分依据。' });
    current = await waitForGrade(request, current.id);
  }
  expect(current.items[0].attempts).toHaveLength(5);
  expect(current.items[0].attempts.at(-1)!.grades).toHaveLength(5);
  await openPractice(page, current);
  const history = page.getByRole('heading', { name: '此前作答', exact: true }).locator('..');
  await expect(history.getByText('第 1 次尝试', { exact: false })).toHaveCount(0);
  const attemptPage = page.waitForResponse(response => response.url().includes('/practice/history?') && response.url().includes('itemId='));
  await history.getByRole('button', { name: '加载更多', exact: true }).click();
  expect((await attemptPage).ok()).toBe(true);
  await expect(history.getByText('第 1 次尝试', { exact: false })).toBeVisible();
  const feedback = page.getByTestId('practice-feedback');
  await feedback.getByText('查看历次判题', { exact: true }).click();
  const revisions = feedback.locator('details');
  await expect(revisions.getByText('版本 1', { exact: false })).toHaveCount(0);
  const gradePage = page.waitForResponse(response => response.url().includes(`/attempts/${attemptId}/grades?`));
  await revisions.getByRole('button', { name: '加载更多', exact: true }).click();
  expect((await gradePage).ok()).toBe(true);
  await expect(revisions.getByText('版本 1', { exact: false })).toBeVisible();
});
