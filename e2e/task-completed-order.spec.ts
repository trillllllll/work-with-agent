import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';

type Created = { id: string; title: string; sortOrder?: number; revision?: number; status?: string; parentId?: string | null; topicId?: string | null };
type ReorderBody = { topicId: string | null; parentId: string | null; orderedTaskIds: string[]; expectedRevisions: Record<string, number> };
type Seed = { P: Created; A: Created; B: Created; C: Created; Q: Created; D: Created; E: Created };

async function data(response: Awaited<ReturnType<APIRequestContext['get']>>) {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}
async function task(request: APIRequestContext, id: string) {
  return data(await request.get(`${apiUrl}/api/tasks/${id}`));
}
async function childIds(request: APIRequestContext, parentId: string) {
  return ((await task(request, parentId)).children ?? []).map((child: { id: string }) => child.id);
}
async function revisionsOf(request: APIRequestContext, ids: string[]) {
  const entries = await Promise.all(ids.map(async (id) => [id, (await task(request, id)).revision] as const));
  return Object.fromEntries(entries);
}

async function seed(request: APIRequestContext): Promise<Seed> {
  const P = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '父任务甲' } }));
  const A = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '子任务A', parentId: P.id } }));
  const B = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '子任务B', parentId: P.id } }));
  const C = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '子任务C', parentId: P.id } }));
  const Q = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '已完成父任务' } }));
  const D = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '完成子D', parentId: Q.id } }));
  const E = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '完成子E', parentId: Q.id } }));
  expect((await request.post(`${apiUrl}/api/tasks/reorder`, { data: { topicId: null, parentId: P.id, orderedTaskIds: [A.id, B.id, C.id] } })).ok()).toBe(true);
  expect((await request.post(`${apiUrl}/api/tasks/reorder`, { data: { topicId: null, parentId: Q.id, orderedTaskIds: [D.id, E.id] } })).ok()).toBe(true);
  expect((await request.post(`${apiUrl}/api/tasks/reorder`, { data: { topicId: null, parentId: null, orderedTaskIds: [P.id, Q.id] } })).ok()).toBe(true);
  expect((await request.patch(`${apiUrl}/api/tasks/${B.id}`, { data: { status: 'done' } })).ok()).toBe(true);
  expect((await request.patch(`${apiUrl}/api/tasks/${D.id}`, { data: { status: 'done' } })).ok()).toBe(true);
  expect((await request.patch(`${apiUrl}/api/tasks/${E.id}`, { data: { status: 'done' } })).ok()).toBe(true);
  expect((await request.patch(`${apiUrl}/api/tasks/${Q.id}`, { data: { status: 'done' } })).ok()).toBe(true);
  expect(await childIds(request, P.id)).toEqual([A.id, B.id, C.id]);
  expect(await childIds(request, Q.id)).toEqual([D.id, E.id]);
  return { P, A, B, C, Q, D, E };
}

async function visibleOrder(page: Page, ids: string[]) {
  return page.getByTestId('task-list').locator('article[data-testid]').evaluateAll((nodes, wanted) => {
    const allowed = new Set(wanted as string[]);
    return nodes
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => node.getAttribute('data-testid')!.replace(/^task-row-/, ''))
      .filter((id) => allowed.has(id));
  }, ids);
}

async function rowGeometry(page: Page, id: string) {
  return page.getByTestId(`task-row-${id}`).evaluate((node) => {
    const checkbox = node.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const title = node.querySelector<HTMLElement>('.task-inline-title')!;
    const children = node.closest('.task-children')!;
    return {
      checkboxX: checkbox.getBoundingClientRect().x,
      titleX: title.getBoundingClientRect().x,
      indent: getComputedStyle(children).marginLeft,
      minHeight: getComputedStyle(node).minHeight,
    };
  });
}

async function tokenPaint(page: Page, variable: string) {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    probe.style.backgroundColor = `var(${name})`;
    probe.style.borderTopColor = `var(${name})`;
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const paint = { color: style.color, backgroundColor: style.backgroundColor, borderTopColor: style.borderTopColor };
    probe.remove();
    return paint;
  }, variable);
}

function watchMoves(page: Page) {
  const reorders: ReorderBody[] = [];
  const parentPatches: Array<string | null> = [];
  let pending = 0;
  const track = (request: { method: () => string; url: () => string }) => request.method() === 'POST' && request.url().includes('/api/tasks/reorder');
  page.on('request', (request) => {
    const url = request.url();
    if (track(request)) {
      reorders.push(request.postDataJSON());
      pending += 1;
      return;
    }
    if (request.method() === 'PATCH' && /\/api\/tasks\/[^/]+$/.test(new URL(url).pathname)) {
      const body = request.postDataJSON();
      if (body && Object.prototype.hasOwnProperty.call(body, 'parentId')) parentPatches.push(body.parentId);
    }
  });
  page.on('response', (response) => { if (track(response.request())) pending = Math.max(0, pending - 1); });
  page.on('requestfailed', (request) => { if (track(request)) pending = Math.max(0, pending - 1); });
  return { reorders, parentPatches, pending: () => pending };
}

function expectSiblingReorder(body: ReorderBody, parentId: string | null, orderedIds: string[], revisions: Record<string, number>) {
  expect(body.topicId).toBeNull();
  expect(body.parentId).toBe(parentId);
  expect(body.orderedTaskIds).toEqual(orderedIds);
  expect(new Set(body.orderedTaskIds).size).toBe(orderedIds.length);
  expect([...body.orderedTaskIds].sort()).toEqual([...orderedIds].sort());
  expect(body.expectedRevisions).toEqual(revisions);
}

// dnd-kit calls preventDefault on mousemove, and Playwright then drops mouseup.
async function releaseMouse(page: Page, x: number, y: number) {
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await session.detach();
}

async function dragRows(page: Page, fromId: string, toId: string, toward: 'up' | 'down') {
  const start = page.getByTestId(`task-row-${fromId}`);
  const target = page.getByTestId(`task-row-${toId}`);
  await start.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const from = await start.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('任务行没有布局');
  const x = from.x + Math.min(160, from.width * 0.45);
  const endY = toward === 'up' ? to.y + 8 : to.y + Math.min(12, Math.max(8, to.height * 0.35));
  await page.mouse.move(x, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, from.y + from.height / 2 + (toward === 'up' ? -18 : 18), { steps: 5 });
  await page.mouse.move(x, endY, { steps: 24 });
  await releaseMouse(page, x, endY);
}

async function dragBy(page: Page, id: string, dx: number, dy: number) {
  const start = page.getByTestId(`task-row-${id}`);
  await start.scrollIntoViewIfNeeded();
  const from = await start.boundingBox();
  if (!from) throw new Error('任务行没有布局');
  const x = from.x + Math.min(140, from.width * 0.4);
  const y = from.y + from.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + Math.sign(dx || 0) * 8, y + Math.sign(dy || 0) * 8, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  return { x: x + dx, y: y + dy, release: () => releaseMouse(page, x + dx, y + dy) };
}

async function restoreChildren(page: Page, request: APIRequestContext, parentId: string, ids: string[], moves: { pending: () => number }) {
  // A sibling drop can still be saving when the pointer has already left the row.
  await expect.poll(() => moves.pending(), { timeout: 5_000 }).toBe(0);
  const send = () => request.post(`${apiUrl}/api/tasks/reorder`, { data: { topicId: null, parentId, orderedTaskIds: ids } });
  let response = await send();
  if (!response.ok()) {
    await expect.poll(() => moves.pending(), { timeout: 5_000 }).toBe(0);
    response = await send();
  }
  expect(response.ok(), response.ok() ? '' : `${response.status()} ${await response.text()}`).toBe(true);
  await page.reload();
}

let seeded: Seed;

test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
  seeded = await seed(request);
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto('/#/inbox');
  await expect(page.getByTestId(`task-row-${seeded.A.id}`)).toBeVisible();
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test.describe('已完成子任务保持缩进并混排', () => {
  test('同级子任务在浅色和深色、窄屏和宽屏下对齐', async ({ page }) => {
    test.setTimeout(120_000);
    const { A, B } = seeded;
    for (const width of [393, 1200]) {
      for (const theme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((next) => localStorage.setItem('dovun.theme', next), theme);
        await page.reload();
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
        await expect(page.getByTestId(`task-row-${A.id}`)).toBeVisible();
        await page.mouse.move(0, 0);

        expect(await visibleOrder(page, [A.id, B.id, seeded.C.id])).toEqual([A.id, B.id, seeded.C.id]);
        const a = await rowGeometry(page, A.id);
        const b = await rowGeometry(page, B.id);
        expect(a.indent).toBe('24px');
        expect(b.indent).toBe('24px');
        expect(parseFloat(b.minHeight)).toBeGreaterThanOrEqual(44);
        expect(Math.abs(a.checkboxX - b.checkboxX)).toBeLessThanOrEqual(1);
        expect(Math.abs(a.titleX - b.titleX)).toBeLessThanOrEqual(1);

        const doneRow = page.getByTestId(`task-row-${B.id}`);
        const openRow = page.getByTestId(`task-row-${A.id}`);
        await expect(doneRow.locator('.task-drag-handle')).toHaveCount(1);
        await expect(doneRow.getByRole('checkbox')).toBeChecked();
        const doneTitle = doneRow.getByRole('button', { name: B.title, exact: true }).locator('span').first();
        const openTitle = openRow.getByRole('button', { name: A.title, exact: true }).locator('span').first();
        await expect(doneTitle).toHaveCSS('text-decoration-line', 'line-through');
        await expect(openTitle).toHaveCSS('text-decoration-line', 'none');
        await expect(doneRow).toHaveCSS('opacity', '1');
        for (const property of ['min-height', 'padding-left', 'padding-top', 'column-gap', 'border-top-width', 'border-radius']) {
          await expect(doneRow).toHaveCSS(property, await openRow.evaluate((node, key) => getComputedStyle(node).getPropertyValue(key), property));
        }
        for (const property of ['font-size', 'font-weight']) {
          await expect(doneTitle).toHaveCSS(property, await openTitle.evaluate((node, key) => getComputedStyle(node).getPropertyValue(key), property));
        }
        for (const selector of ['.task-drag-handle', '.task-checkbox']) {
          for (const property of ['width', 'height']) {
            await expect(doneRow.locator(selector)).toHaveCSS(property, await openRow.locator(selector).evaluate((node, key) => getComputedStyle(node).getPropertyValue(key), property));
          }
        }
        const motion = await doneRow.evaluate((node) => {
          const style = getComputedStyle(node);
          return { transition: style.transition, timing: style.transitionTimingFunction };
        });
        expect(motion.transition.includes('160ms') || motion.transition.includes('0.16s')).toBe(true);
        expect(motion.timing.split(',').every((part) => part.trim() === 'ease')).toBe(true);

        const muted = await tokenPaint(page, '--muted-foreground');
        const foreground = await tokenPaint(page, '--foreground');
        const ring = await tokenPaint(page, '--ring');
        expect(await doneTitle.evaluate((node) => getComputedStyle(node).color)).toBe(muted.color);
        expect(await openTitle.evaluate((node) => getComputedStyle(node).color)).toBe(foreground.color);
        const seam = page.locator('.task-children .task-row-block').nth(1);
        await expect(seam).toHaveCSS('border-top-width', '0px');
        await expect(page.locator('.task-children').first()).toHaveCSS('row-gap', '5px');

        const canHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);
        const handle = doneRow.locator('.task-drag-handle');
        if (width < 600) {
          await expect(handle).toBeHidden();
        } else if (canHover) {
          await expect(handle).toHaveCSS('opacity', '0');
          await doneRow.hover();
          await expect(handle).toHaveCSS('opacity', '1');
          await expect(doneRow).toHaveCSS('border-top-color', ring.borderTopColor);
        } else {
          await expect(handle).toHaveCSS('opacity', '1');
        }

        await openRow.getByRole('button', { name: A.title, exact: true }).click();
        await expect(openRow).toHaveAttribute('data-selected', 'true');
        await expect.poll(async () => openRow.evaluate((node) => getComputedStyle(node).backgroundImage)).not.toBe('none');
        await expect(openRow).toHaveCSS('border-top-width', '1px');
        await page.getByRole('button', { name: '关闭工作侧栏', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '任务详情', exact: true })).toBeHidden();
      }
    }
  });

  test('完成和重开、收起展开、点击控件都不改变手动顺序', async ({ page, request }) => {
    test.setTimeout(60_000);
    const { P, A, B, C } = seeded;
    const moves = watchMoves(page);
    expect(await visibleOrder(page, [A.id, B.id, C.id])).toEqual([A.id, B.id, C.id]);
    const sortOrder = (await task(request, A.id)).sortOrder;
    expect((await task(request, B.id)).sortOrder).toBe(1);
    expect((await task(request, C.id)).sortOrder).toBe(2);

    const row = page.getByTestId(`task-row-${A.id}`);
    await row.getByRole('checkbox', { name: '完成任务：子任务A', exact: true }).click();
    await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
    await expect(row.getByRole('checkbox', { name: '重开任务：子任务A', exact: true })).toBeChecked();
    await expect.poll(async () => (await task(request, A.id)).status).toBe('done');
    expect((await task(request, A.id)).sortOrder).toBe(sortOrder);
    expect(await visibleOrder(page, [A.id, B.id, C.id])).toEqual([A.id, B.id, C.id]);
    await row.getByRole('checkbox', { name: '重开任务：子任务A', exact: true }).click();
    await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
    await expect.poll(async () => (await task(request, A.id)).status).toBe('todo');
    expect((await task(request, A.id)).sortOrder).toBe(sortOrder);
    expect(await visibleOrder(page, [A.id, B.id, C.id])).toEqual([A.id, B.id, C.id]);
    expect(await childIds(request, P.id)).toEqual([A.id, B.id, C.id]);

    await page.getByTestId(`task-row-${B.id}`).getByRole('button', { name: '任务操作：子任务B', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '上移任务：子任务B', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '收起子任务：父任务甲', exact: true }).click();
    await expect(page.getByTestId(`task-row-${B.id}`)).toHaveCount(0);
    await page.getByRole('button', { name: '展开子任务：父任务甲', exact: true }).click();
    await expect(page.getByTestId(`task-row-${B.id}`)).toBeVisible();
    expect(await visibleOrder(page, [A.id, B.id, C.id])).toEqual([A.id, B.id, C.id]);
    expect(moves.reorders).toEqual([]);
    expect(moves.parentPatches).toEqual([]);
  });

  test('拖动已完成子任务会按混合顺序保存并在刷新后保留', async ({ page, request }) => {
    test.setTimeout(180_000);
    const { P, A, B, C } = seeded;
    const moves = watchMoves(page);
    const held = await dragBy(page, P.id, 0, -16);
    await expect(page.locator('.task-drag-overlay')).toBeVisible();
    await expect.poll(async () => page.locator('.task-drag-overlay button').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))).toEqual([P.title, A.title, B.title, C.title]);
    await held.release();
    await expect(page.locator('.task-drag-overlay')).toHaveCount(0);
    expect(moves.reorders).toEqual([]);
    expect(await visibleOrder(page, [A.id, B.id, C.id])).toEqual([A.id, B.id, C.id]);

    const beforeUp = await revisionsOf(request, [A.id, B.id, C.id]);
    await dragRows(page, B.id, A.id, 'up');
    await expect.poll(async () => visibleOrder(page, [A.id, B.id, C.id])).toEqual([B.id, A.id, C.id]);
    await expect.poll(async () => childIds(request, P.id)).toEqual([B.id, A.id, C.id]);
    expect(moves.reorders).toHaveLength(1);
    expectSiblingReorder(moves.reorders[0]!, P.id, [B.id, A.id, C.id], beforeUp);
    expect(moves.parentPatches).toEqual([]);
    for (const [id, status] of [[A.id, 'todo'], [B.id, 'done'], [C.id, 'todo']] as const) {
      expect(await task(request, id)).toMatchObject({ parentId: P.id, status, topicId: null });
    }
    await page.reload();
    await expect(page.getByTestId(`task-row-${A.id}`)).toBeVisible();
    expect(await visibleOrder(page, [A.id, B.id, C.id])).toEqual([B.id, A.id, C.id]);

    await restoreChildren(page, request, P.id, [A.id, B.id, C.id], moves);
    await expect(page.getByTestId(`task-row-${A.id}`)).toBeVisible();
    const beforeDown = await revisionsOf(request, [A.id, B.id, C.id]);
    const mark = moves.reorders.length;
    await dragRows(page, B.id, C.id, 'down');
    await expect.poll(async () => visibleOrder(page, [A.id, B.id, C.id])).toEqual([A.id, C.id, B.id]);
    await expect.poll(async () => childIds(request, P.id)).toEqual([A.id, C.id, B.id]);
    expectSiblingReorder(moves.reorders[mark]!, P.id, [A.id, C.id, B.id], beforeDown);
    for (const [id, status] of [[A.id, 'todo'], [B.id, 'done'], [C.id, 'todo']] as const) {
      expect(await task(request, id)).toMatchObject({ parentId: P.id, status, topicId: null });
    }
    await page.reload();
    await expect(page.getByTestId(`task-row-${A.id}`)).toBeVisible();
    expect(await visibleOrder(page, [A.id, B.id, C.id])).toEqual([A.id, C.id, B.id]);
  });

  test('已完成子任务的上移和下移沿混合顺序移动', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { P, A, B, C } = seeded;
    const moves = watchMoves(page);
    const beforeUp = await revisionsOf(request, [A.id, B.id, C.id]);
    await page.getByTestId(`task-row-${B.id}`).getByRole('button', { name: '任务操作：子任务B', exact: true }).click();
    await page.getByRole('menuitem', { name: '上移任务：子任务B', exact: true }).click();
    await expect.poll(async () => visibleOrder(page, [A.id, B.id, C.id])).toEqual([B.id, A.id, C.id]);
    await expect.poll(async () => childIds(request, P.id)).toEqual([B.id, A.id, C.id]);
    expectSiblingReorder(moves.reorders.at(-1)!, P.id, [B.id, A.id, C.id], beforeUp);

    await restoreChildren(page, request, P.id, [A.id, B.id, C.id], moves);
    await expect(page.getByTestId(`task-row-${B.id}`)).toBeVisible();
    const beforeDown = await revisionsOf(request, [A.id, B.id, C.id]);
    await page.getByTestId(`task-row-${B.id}`).getByRole('button', { name: '任务操作：子任务B', exact: true }).click();
    await page.getByRole('menuitem', { name: '下移任务：子任务B', exact: true }).click();
    await expect.poll(async () => visibleOrder(page, [A.id, B.id, C.id])).toEqual([A.id, C.id, B.id]);
    await expect.poll(async () => childIds(request, P.id)).toEqual([A.id, C.id, B.id]);
    expectSiblingReorder(moves.reorders.at(-1)!, P.id, [A.id, C.id, B.id], beforeDown);
    await page.reload();
    await expect(page.getByTestId(`task-row-${A.id}`)).toBeVisible();
    expect(await visibleOrder(page, [A.id, B.id, C.id])).toEqual([A.id, C.id, B.id]);
  });

  test('已完成父任务展开后只允许同一父任务内排序', async ({ page, request }) => {
    test.setTimeout(120_000);
    const { P, Q, D, E } = seeded;
    const moves = watchMoves(page);
    await page.getByText('已完成 · 1', { exact: true }).click();
    await expect(page.getByTestId(`task-row-${E.id}`)).toBeVisible();
    await expect(page.getByTestId(`task-row-${Q.id}`).locator('.task-drag-handle')).toHaveCount(0);
    await expect(page.getByTestId(`task-row-${E.id}`).locator('.task-drag-handle')).toHaveCount(1);
    expect(await visibleOrder(page, [D.id, E.id])).toEqual([D.id, E.id]);

    const preview = await dragBy(page, E.id, 0, 10);
    await expect(page.locator('.task-drag-overlay')).toBeVisible();
    await expect(page.locator('.task-drag-overlay span.w-5')).toHaveCount(0);
    await expect(page.locator('.task-drag-overlay')).toHaveAttribute('style', /translateX\(0px\)/);
    await preview.release();
    await expect(page.locator('.task-drag-overlay')).toHaveCount(0);
    expect(moves.reorders).toEqual([]);
    expect(moves.parentPatches).toEqual([]);

    const horizontal = moves.reorders.length;
    await dragBy(page, E.id, 48, 0).then(async (held) => held.release());
    await expect(page.locator('.task-drag-overlay')).toHaveCount(0);
    await expect.poll(async () => (await task(request, E.id)).parentId).toBe(Q.id);
    expect(moves.reorders.slice(horizontal).every((body) => body.parentId === Q.id && body.orderedTaskIds.every((id) => id === D.id || id === E.id))).toBe(true);
    expect(moves.parentPatches).toEqual([]);
    expect((await task(request, D.id)).parentId).toBe(Q.id);

    const towardParent = moves.reorders.length;
    await dragRows(page, E.id, P.id, 'up');
    await expect(page.locator('.task-drag-overlay')).toHaveCount(0);
    await expect.poll(async () => (await task(request, E.id)).parentId).toBe(Q.id);
    expect(moves.parentPatches).toEqual([]);
    expect(moves.reorders.slice(towardParent).every((body) => body.parentId === Q.id && new Set(body.orderedTaskIds).size === body.orderedTaskIds.length && body.orderedTaskIds.every((id) => id === D.id || id === E.id))).toBe(true);

    await restoreChildren(page, request, Q.id, [D.id, E.id], moves);
    await page.getByText('已完成 · 1', { exact: true }).click();
    await expect(page.getByTestId(`task-row-${E.id}`)).toBeVisible();
    const before = await revisionsOf(request, [D.id, E.id]);
    const mark = moves.reorders.length;
    await dragRows(page, E.id, D.id, 'up');
    await expect.poll(async () => visibleOrder(page, [D.id, E.id])).toEqual([E.id, D.id]);
    await expect.poll(async () => childIds(request, Q.id)).toEqual([E.id, D.id]);
    expectSiblingReorder(moves.reorders[mark]!, Q.id, [E.id, D.id], before);
    expect(moves.parentPatches).toEqual([]);
    await page.reload();
    await page.getByText('已完成 · 1', { exact: true }).click();
    await expect(page.getByTestId(`task-row-${E.id}`)).toBeVisible();
    expect(await visibleOrder(page, [D.id, E.id])).toEqual([E.id, D.id]);
    expect(await childIds(request, Q.id)).toEqual([E.id, D.id]);
  });

  test('排序失败时恢复原顺序并显示错误', async ({ page, request }) => {
    test.setTimeout(60_000);
    const { P, A, B, C } = seeded;
    await page.route('**/api/tasks/reorder', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ data: null, error: '排序范围已变化，请刷新后重试', code: 'SORT_CONFLICT' }) });
    });
    await page.getByTestId(`task-row-${B.id}`).getByRole('button', { name: '任务操作：子任务B', exact: true }).click();
    await page.getByRole('menuitem', { name: '上移任务：子任务B', exact: true }).click();
    await expect(page.getByText('排序范围已变化，请刷新后重试').first()).toBeVisible();
    await expect.poll(async () => visibleOrder(page, [A.id, B.id, C.id])).toEqual([A.id, B.id, C.id]);
    expect(await childIds(request, P.id)).toEqual([A.id, B.id, C.id]);
    await page.reload();
    await expect(page.getByTestId(`task-row-${C.id}`)).toBeVisible();
    expect(await visibleOrder(page, [A.id, B.id, C.id])).toEqual([A.id, B.id, C.id]);
    expect(await childIds(request, P.id)).toEqual([A.id, B.id, C.id]);
  });

  test('筛选、归档和非手动排序不提供排序', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { B } = seeded;
    const moves = watchMoves(page);
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByRole('combobox', { name: '筛选完成状态', exact: true }).selectOption('open');
    await expect(page.getByText('筛选期间不能手动排序；清除筛选后可调整完整列表。', { exact: true })).toBeVisible();
    await expect(page.locator('.task-drag-handle')).toHaveCount(0);
    await expect(page.getByTestId(`task-row-${B.id}`)).toHaveCount(0);
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await page.getByRole('combobox', { name: '任务排序', exact: true }).selectOption('date');
    await expect(page.getByText('切换为手动排序后，可调整任务位置。', { exact: true })).toBeVisible();
    await expect(page.locator('.task-drag-handle')).toHaveCount(0);

    await page.goto('/#/search');
    await expect(page.locator('.task-drag-handle')).toHaveCount(0);

    const list = await data(await request.post(`${apiUrl}/api/topics`, { data: { name: '只读归档' } }));
    const item = await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '归档里的任务' } }));
    await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '归档子任务', parentId: item.id } }));
    expect((await request.post(`${apiUrl}/api/topics/${list.id}/archive`)).ok()).toBe(true);
    await page.goto('/#/archived');
    await page.getByRole('button', { name: '只读归档', exact: true }).click();
    await expect(page.getByTestId(`task-row-${item.id}`)).toBeVisible();
    await expect(page.getByText('恢复清单后可编辑和排序。', { exact: true })).toBeVisible();
    await expect(page.locator('.task-drag-handle')).toHaveCount(0);
    await page.getByTestId(`task-row-${item.id}`).getByRole('button', { name: '任务操作：归档里的任务', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '上移任务：归档里的任务', exact: true })).toHaveCount(0);
    expect(moves.reorders).toEqual([]);
    expect(moves.parentPatches).toEqual([]);
  });
});
