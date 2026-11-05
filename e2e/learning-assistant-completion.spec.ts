import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// Needs the learning model fixture and isolated server from playwright.learning-assistant.config.ts.
test.skip(process.env.LEARNING_WORKFLOW_E2E !== '1', 'Run with playwright.learning-assistant.config.ts');
const api = process.env.E2E_API_URL!;
async function write(request: APIRequestContext, path: string, data: object) {
  const response = await request.post(`${api}${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true); return (await response.json()).data;
}
async function seed(request: APIRequestContext, shape = '<g data-node-id="closure"><rect x="20" y="20" width="200" height="60"/><text x="30" y="55">闭包知识点</text></g>') {
  const title = `对话学习 ${randomUUID().slice(0, 8)}`;
  const created = await write(request, '/api/v1/commands', { requestId: randomUUID(), commands: [
    { kind: 'learning.map.create', clientRef: 'map', input: { title, goal: '在对话里连续学习' } },
    { kind: 'learning.node.create', clientRef: 'node', input: { mapId: { $ref: 'map' }, parentId: null, kind: 'item', title: '闭包知识点', detail: '保存原始答案和题目版本。', status: 'learning', sortOrder: 0 } },
    { kind: 'learning.figure.save', input: { mapId: { $ref: 'map' }, nodeRefs: { closure: { $ref: 'node' } }, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120">${shape}</svg>` } },
  ] });
  return { mapId: created.results[0].id as string, nodeId: created.results[1].id as string, title };
}
async function openStudy(page: Page) {
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const panel = page.getByTestId('ai-assistant');
  await panel.getByRole('button', { name: '切换助手', exact: true }).click();
  await page.getByRole('menuitem', { name: '学习助手', exact: true }).click();
  await expect(panel.getByTestId('study-topic-bar')).toBeVisible(); return panel;
}
async function selectTopic(page: Page, title: string) {
  await page.getByTestId('study-topic-bar').getByRole('button', { name: '切换主题', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: title }).click();
  await expect(page.getByTestId('study-topic-bar').getByRole('button', { name: '切换主题', exact: true })).toContainText(title);
}
async function send(page: Page, text: string) {
  const panel = page.getByTestId('ai-assistant');
  await panel.getByRole('textbox', { name: '向 AI 提问' }).fill(text);
  const sent = page.waitForRequest(request => request.url().endsWith('/api/chat') && request.method() === 'POST');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  return (await sent).postDataJSON();
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('dovun.theme', 'light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
});

test('topic conversation, live node card, figure keyboard navigation and archive survive refresh', async ({ page, request, isMobile }, testInfo) => {
  const topic = await seed(request); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openStudy(page); await selectTopic(page, topic.title);
  const body = await send(page, `学习卡片验收 nodeId=${topic.nodeId}`);
  expect(body.learningMapId).toBe(topic.mapId);
  const card = page.getByTestId('learning-card-node'); await expect(card).toBeVisible();
  await card.getByRole('button', { name: '在主图中看', exact: true }).click();
  const figure = page.getByTestId('study-figure-sheet'); await expect(figure).toBeVisible();
  await expect(figure.locator('[data-node-id]')).toHaveAttribute('data-status', 'learning');
  const colours = await figure.locator('rect').evaluate(element => {
    const context = document.createElement('canvas').getContext('2d')!;
    context.fillStyle = getComputedStyle(element).getPropertyValue('--tag-blue-bg'); const expected = context.fillStyle;
    context.fillStyle = getComputedStyle(element).fill; return { expected, actual: context.fillStyle };
  });
  expect(colours.actual).toBe(colours.expected);
  await figure.locator('[data-node-id]').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('figure-node-detail')).toContainText('闭包知识点');
  await page.screenshot({ path: testInfo.outputPath('study-figure.png') });
  await page.keyboard.press('Escape'); await expect(figure).not.toBeVisible();
  const input = page.getByRole('textbox', { name: '向 AI 提问' }); await input.focus(); await page.keyboard.type('m'); await expect(figure).not.toBeVisible(); await input.fill('');
  await input.blur(); await page.keyboard.press('m'); await expect(figure).toBeVisible(); await page.keyboard.press('Escape');
  await page.reload();
  if (!await page.getByTestId('ai-assistant').isVisible()) await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.getByTestId('learning-card-node')).toBeVisible();
  await page.getByTestId('learning-card-node').getByRole('button', { name: '看笔记', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`map=${topic.mapId}.*node=${topic.nodeId}`));
  if (!isMobile) await page.getByTestId('ai-assistant').getByRole('button', { name: '关闭聊天', exact: true }).click();
  await expect(page.getByTestId('learning-workspace')).toBeVisible();
  await page.getByTestId('learning-archive-figure').getByRole('button', { name: '学习主图', exact: true }).click();
  await expect(page.getByTestId('learning-archive-figure').getByTestId('learning-figure')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('a formal practice has one editor, preserves an unknown submit and resumes inside chat', async ({ page, request, context }, testInfo) => {
  const topic = await seed(request);
  const { job } = await write(request, '/api/v1/learning/practice/generate', { requestId: randomUUID(), mapId: topic.mapId, nodeIds: [topic.nodeId], count: 2, types: ['single'], difficulty: 'easy', mode: 'knowledge' });
  await expect.poll(async () => (await (await request.get(`${api}/api/v1/learning/jobs/${job.id}`)).json()).data.state, { timeout: 45_000 }).toBe('succeeded');
  await openStudy(page); await selectTopic(page, topic.title);
  await send(page, `学习卡片验收 jobId=${job.id}`);
  await expect(page.getByTestId('practice-candidate')).toBeVisible();
  await send(page, `学习卡片验收 jobId=${job.id}`);
  const card = page.getByTestId('learning-card-practice').last();
  await expect(card.getByTestId('practice-editor-occupied')).toBeVisible();
  await page.getByTestId('learning-card-practice').first().getByRole('button', { name: '收起', exact: true }).click();
  await card.getByRole('button', { name: '重试', exact: true }).click();
  await expect(card.getByTestId('practice-candidate')).toBeVisible();
  await card.getByRole('button', { name: '采用并开始', exact: true }).click();
  await expect(card.getByTestId('practice-question')).toBeVisible();
  const competing = await context.newPage();
  const jobRead = (await (await request.get(`${api}/api/v1/learning/jobs/${job.id}`)).json()).data;
  await competing.goto(`/#/learning?map=${topic.mapId}&session=${jobRead.adoptedSessionId}`);
  await expect(competing.getByTestId('practice-editor-occupied').first()).toBeVisible();
  expect(await competing.getByTestId('practice-session').count()).toBe(0);
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let accepted: () => void = () => {}; const submitted = new Promise<void>(resolve => { accepted = resolve; });
  await page.route('**/api/v1/learning/practice/items/*/submit', async route => { const response = await route.fetch(); accepted(); await gate; await route.fulfill({ response }); });
  await card.getByTestId('practice-question').getByRole('radio').first().check();
  await card.getByTestId('practice-submit').click();
  await submitted;
  await card.getByRole('button', { name: '收起', exact: true }).click();
  await competing.getByTestId('practice-editor-occupied').first().getByRole('button', { name: '重试', exact: true }).click();
  expect(await competing.getByTestId('practice-session').count()).toBe(0);
  release();
  await expect.poll(async () => {
    if (await competing.getByTestId('practice-session').count()) return 1;
    await competing.getByTestId('practice-editor-occupied').first().getByRole('button', { name: '重试', exact: true }).click();
    return competing.getByTestId('practice-session').count();
  }).toBe(1);
  await expect(competing.getByTestId('practice-feedback')).toContainText('正确');
  await competing.close();
  await card.getByRole('button', { name: '在对话中练习', exact: true }).click();
  await expect(card.getByTestId('practice-feedback')).toContainText('正确');
  await page.screenshot({ path: testInfo.outputPath('chat-practice.png') });
  await page.reload();
  if (!await page.getByTestId('ai-assistant').isVisible()) await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const restored = page.getByTestId('learning-card-practice').last(); await restored.getByRole('button', { name: '在对话中练习', exact: true }).click(); await expect(restored.getByTestId('practice-feedback')).toBeVisible();
  const read = await (await request.get(`${api}/api/v1/learning/jobs/${job.id}`)).json();
  const session = (await (await request.get(`${api}/api/v1/learning/practice/sessions/${read.data.adoptedSessionId}`)).json()).data;
  expect(session.items[0].attempts).toHaveLength(1); expect(session.items[0].draft.submitted).toBe(true);
});

test('a delayed topic selection cannot override a newer choice or an identity switch', async ({ page, request }) => {
  const a = await seed(request), b = await seed(request);
  await openStudy(page);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/conversations?identityId=study&learningMapId=${a.mapId}`, async route => { await gate; await route.continue(); });
  await page.getByTestId('study-topic-bar').getByRole('button', { name: '切换主题', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: a.title }).click();
  await selectTopic(page, b.title); release();
  await expect(page.getByTestId('study-topic-bar').getByRole('button', { name: '切换主题', exact: true })).toContainText(b.title);
  const body = await send(page, '继续当前主题'); expect(body.learningMapId).toBe(b.mapId);
  await expect(page.getByText('可以先回看当前题目的考点，再比较你的思路；这是一条学习辅导验收回复。', { exact: true })).toBeVisible();
  await page.unroute(`**/api/conversations?identityId=study&learningMapId=${a.mapId}`);
  const identityGate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/conversations?identityId=study&learningMapId=${a.mapId}`, async route => { await identityGate; await route.continue(); });
  await page.getByTestId('study-topic-bar').getByRole('button', { name: '切换主题', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: a.title }).click();
  await page.getByTestId('ai-assistant').getByRole('button', { name: '切换助手', exact: true }).click();
  await page.getByRole('menuitem', { name: '工作助手', exact: true }).click();
  const returned = page.waitForResponse(response => response.url().includes(`learningMapId=${a.mapId}`)); release(); await returned;
  const work = await send(page, '继续工作'); expect(work.identityId).toBe('work'); expect(work.learningMapId).toBeUndefined();
});

test('valid path and directly tagged shapes use saved mastery colours in both themes', async ({ page, request }) => {
  const shapes = ['<g data-node-id="closure"><path d="M20 20h200v60H20z" fill="red"/></g>', '<rect data-node-id="closure" x="20" y="20" width="200" height="60" fill="red"/>'];
  await openStudy(page);
  for (const shape of shapes) {
    const topic = await seed(request, shape); await selectTopic(page, topic.title);
    await page.getByTestId('study-topic-bar').getByRole('button', { name: /主图/ }).click();
    const figure = page.getByTestId('study-figure-sheet');
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark);
      await expect(figure.locator('[data-figure-status]')).toHaveAttribute('data-figure-status', 'learning');
      const colours = await figure.locator('[data-figure-status]').evaluate(element => {
        const context = document.createElement('canvas').getContext('2d')!;
        context.fillStyle = getComputedStyle(element).getPropertyValue('--tag-blue-bg'); const expected = context.fillStyle;
        context.fillStyle = getComputedStyle(element).fill; return { expected, actual: context.fillStyle };
      });
      expect(colours.actual).toBe(colours.expected);
    }
    await figure.getByRole('button', { name: '收起', exact: true }).click();
  }
});

test('cached adoption and session actions wait for durable pending requests to restore', async ({ page, request }) => {
  const topic = await seed(request);
  const { job } = await write(request, '/api/v1/learning/practice/generate', { requestId: randomUUID(), mapId: topic.mapId, nodeIds: [topic.nodeId], count: 1, types: ['single'], difficulty: 'easy', mode: 'knowledge' });
  await expect.poll(async () => (await (await request.get(`${api}/api/v1/learning/jobs/${job.id}`)).json()).data.state, { timeout: 45_000 }).toBe('succeeded');
  const readyJob = (await (await request.get(`${api}/api/v1/learning/jobs/${job.id}`)).json()).data;
  await openStudy(page); await selectTopic(page, topic.title);
  const adoptionId = randomUUID();
  async function save(kind: string, id: string, value: object) {
    await page.evaluate(async ({ kind, id, value }) => {
      const preference = Object.keys(localStorage).map(key => { try { return JSON.parse(key); } catch { return null; } }).find(key => Array.isArray(key) && key[1] === 'ui' && key[2] === 'current-topic');
      const scope = preference[0];
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const opened = indexedDB.open('dovun-learning-v1', 1); opened.onupgradeneeded = () => { const store = opened.result.createObjectStore('records', { keyPath: 'key' }); store.createIndex('scope', 'scope'); }; opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
      await new Promise<void>((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put({ key: JSON.stringify([scope, kind, id]), scope, kind, id, value, updatedAt: Date.now() }); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
    }, { kind, id, value });
  }
  async function hold() {
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.get;
      const pending: Array<() => void> = [];
      let holding = true;
      IDBObjectStore.prototype.get = function (key) {
        const request = original.call(this, key);
        if (holding && this.transaction.mode === 'readonly' && /"(?:setup-pending|session-operation)"/.test(String(key))) {
          Object.defineProperty(request, 'onsuccess', { configurable: true, set(handler) { request.addEventListener('success', event => { const deliver = () => handler.call(request, event); if (holding) pending.push(deliver); else deliver(); }); } });
        }
        return request;
      };
      (window as any).__releaseRecoveryReads = () => { holding = false; for (const deliver of pending.splice(0)) deliver(); IDBObjectStore.prototype.get = original; };
    });
  }
  await save('setup-pending', `job:${job.id}`, { path: '/practice/start', body: { requestId: adoptionId, jobId: job.id, candidateRevision: readyJob.candidateRevision } });
  await hold(); await send(page, `学习卡片验收 jobId=${job.id}`);
  const card = page.getByTestId('learning-card-practice').last();
  await expect(card.getByRole('button', { name: '采用并开始', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).__releaseRecoveryReads());
  const adoption = page.waitForRequest(request => request.url().endsWith('/practice/start') && request.method() === 'POST');
  await card.getByRole('button', { name: '重试', exact: true }).click();
  expect((await adoption).postDataJSON().requestId).toBe(adoptionId);
  await expect(card.getByTestId('practice-session')).toBeVisible();
  const adopted = (await (await request.get(`${api}/api/v1/learning/jobs/${job.id}`)).json()).data.adoptedSessionId;
  const session = (await (await request.get(`${api}/api/v1/learning/practice/sessions/${adopted}`)).json()).data;
  await card.getByRole('button', { name: '收起', exact: true }).click();
  const pauseId = randomUUID();
  await save('session-operation', adopted, { path: `/practice/sessions/${adopted}/update`, body: { requestId: pauseId, expectedRevision: session.revision, state: 'paused' } });
  await hold(); await card.getByRole('button', { name: '在对话中练习', exact: true }).click();
  await expect(card.getByRole('button', { name: '暂停练习', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).__releaseRecoveryReads());
  const pause = page.waitForRequest(request => request.url().endsWith(`/sessions/${adopted}/update`) && request.method() === 'POST');
  await card.getByRole('button', { name: '重试', exact: true }).click();
  expect((await pause).postDataJSON().requestId).toBe(pauseId);
  await expect(card.getByText('本轮练习已暂停，继续后可作答。', { exact: true })).toBeVisible();
});
