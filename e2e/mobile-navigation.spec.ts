import { test, expect, type Page, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiPath =
  `${process.env.E2E_API_URL ?? 'http://127.0.0.1:3015'}/api/settings/mobile-navigation`;
const navPath = '**/api/settings/mobile-navigation';

test.beforeEach(resetE2eDatabase);
test.afterAll(() => e2eDatabase.$disconnect());

const ids = (scope: Page) =>
  scope.getByTestId('mobile-bottom-navigation').locator('[data-view]').evaluateAll(elements =>
    elements.map(element => element.getAttribute('data-view')),
  );
const previewIds = (scope: Page) =>
  scope.getByTestId('mobile-navigation-preview').locator('[data-preview-view]').evaluateAll(elements =>
    elements.map(element => element.getAttribute('data-preview-view')),
  );
async function readConfig(request: APIRequestContext): Promise<string[]> {
  const response = await request.get(apiPath);
  return (await response.json()).data.visibleViews as string[];
}
async function putConfig(request: APIRequestContext, visibleViews: string[]) {
  const response = await request.put(apiPath, { data: { visibleViews } });
  expect(response.status()).toBe(200);
}
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

async function waitForSettingsScroll(page: Page) {
  const scroller = page.getByTestId('settings-category');
  await expect.poll(async () => scroller.evaluate((node) => new Promise<boolean>((resolve) => {
    const first = node.scrollTop;
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(node.scrollTop === first)));
  }))).toBe(true);
}

test('exact order, fixed more, persistence and empty selection', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await putConfig(request, ['plan', 'focus', 'inbox']);

  await page.goto('/#/plan');

  const nav = page.getByTestId('mobile-bottom-navigation');
  await expect.poll(() => ids(page)).toEqual(['plan', 'focus', 'inbox', 'more']);

  await page.reload();

  await expect.poll(() => ids(page)).toEqual(['plan', 'focus', 'inbox', 'more']);

  await expect(nav.locator('[data-view="plan"]'))
    .toHaveAttribute('aria-current', 'page');

  await page.goto('/#/today');

  await expect(nav.locator('[data-view="more"]'))
    .toHaveAttribute('aria-current', 'page');

  await putConfig(request, []);

  await page.reload();

  await expect.poll(() => ids(page)).toEqual(['more']);

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(nav).toHaveCount(0);
});

test('settings toggle and drag controls update server', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await putConfig(request, ['plan', 'focus', 'inbox']);

  await page.goto('/#/settings/ui');

  const panel = page.getByTestId('mobile-navigation-settings');
  await expect(panel).toBeVisible();

  // 每项只有一行：拖动手柄把专注拖到规划上方（上移/下移按钮已去掉）。
  await expect(panel.getByRole('button', { name: /^上移|^下移/ })).toHaveCount(0);
  const handle = panel.getByRole('button', { name: '拖动专注', exact: true });
  const targetRow = panel.getByTestId('mobile-navigation-row-plan');
  await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox();
  const target = await targetRow.boundingBox();
  const startX = from!.x + from!.width / 2;
  const startY = from!.y + from!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY - 12, { steps: 2 });
  await page.mouse.move(startX, target!.y + target!.height * 0.2, { steps: 15 });
  await page.mouse.up();

  await expect.poll(() => readConfig(request)).toEqual(['focus', 'plan', 'inbox']);

  const enableToday = panel.getByRole('switch', {
    name: '在底栏显示今天',
    exact: true,
  });

  await expect(enableToday).toBeEnabled();
  await enableToday.click();

  await expect.poll(() => readConfig(request))
    .toEqual(['focus', 'plan', 'inbox', 'today']);

  await expect(panel.getByRole('switch', {
    name: '在底栏显示标签',
    exact: true,
  })).toBeDisabled();

  await expect(panel.getByRole('switch', {
    name: '在底栏显示更多',
    exact: true,
  })).toHaveCount(0);

  await expect(
    panel.getByTestId('mobile-navigation-fixed-more'),
  ).toContainText('固定显示在最右侧');
});

test('保存返回 500 时恢复请求前状态，重试发送同一份内容', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await putConfig(request, ['plan', 'focus']);

  let failedBody = '';
  await page.route(navPath, async (route) => {
    if (route.request().method() === 'PUT') {
      failedBody = route.request().postData() ?? '';
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ data: null, error: '服务器错误' }) });
      return;
    }
    await route.fallback();
  });

  await page.goto('/#/settings/ui');
  const panel = page.getByTestId('mobile-navigation-settings');
  await expect(panel).toBeVisible();

  const focusSwitch = panel.getByRole('switch', { name: '在底栏显示专注', exact: true });
  await focusSwitch.click();

  await expect(panel.getByTestId('mobile-navigation-save-error')).toBeVisible();
  // 底栏、预览、开关都恢复到请求前的同一份配置。
  await expect(focusSwitch).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => ids(page)).toEqual(['plan', 'focus', 'more']);
  await expect.poll(() => previewIds(page)).toEqual(['plan', 'focus', 'more']);
  expect(await readConfig(request)).toEqual(['plan', 'focus']);

  await page.unroute(navPath);
  const retriedBodies: string[] = [];
  await page.route(navPath, async (route) => {
    if (route.request().method() === 'PUT') retriedBodies.push(route.request().postData() ?? '');
    await route.fallback();
  });

  await panel.getByRole('button', { name: '重试保存' }).click();

  await expect(panel.getByTestId('mobile-navigation-save-error')).toHaveCount(0);
  expect(retriedBodies).toEqual([failedBody]);
  await expect.poll(() => readConfig(request)).toEqual(['plan']);
  await expect.poll(() => ids(page)).toEqual(['plan', 'more']);
});

test('延迟 PUT 期间编辑控件禁用，连续点击不产生第二个 PUT', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await putConfig(request, ['plan']);

  let puts = 0;
  await page.route(navPath, async (route) => {
    if (route.request().method() === 'PUT') {
      puts += 1;
      await sleep(1_200);
    }
    await route.fallback();
  });

  await page.goto('/#/settings/ui');
  const panel = page.getByTestId('mobile-navigation-settings');
  await expect(panel).toBeVisible();

  await panel.getByRole('switch', { name: '在底栏显示今天', exact: true }).click();

  await expect(panel.getByTestId('mobile-navigation-save-status')).toHaveText('正在保存…');
  await expect(panel.getByRole('switch', { name: '在底栏显示收集箱', exact: true })).toBeDisabled();
  await expect(panel.getByRole('switch', { name: '在底栏显示今天', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '拖动规划', exact: true })).toBeDisabled();

  await panel.getByRole('switch', { name: '在底栏显示今天', exact: true }).click({ force: true }).catch(() => undefined);
  await panel.getByRole('switch', { name: '在底栏显示收集箱', exact: true }).click({ force: true }).catch(() => undefined);

  await expect.poll(() => readConfig(request)).toEqual(['plan', 'today']);
  await expect(panel.getByTestId('mobile-navigation-save-status')).toHaveText('已同步到当前服务');
  expect(puts).toBe(1);
});

test('保存期间较早完成的 GET 不能把预览或底栏改回旧值', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await putConfig(request, ['inbox']);

  await page.route(navPath, async (route) => {
    if (route.request().method() === 'PUT') await sleep(1_500);
    else await sleep(500);
    await route.fallback();
  });

  await page.goto('/#/settings/ui');
  const panel = page.getByTestId('mobile-navigation-settings');
  await expect(panel).toBeVisible();

  await panel.getByRole('switch', { name: '在底栏显示今天', exact: true }).click();
  // 保存还在途中时触发一次远端刷新；此时服务器仍是旧值 ['inbox']。
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await page.waitForTimeout(900);
  await expect.poll(() => previewIds(page)).toEqual(['inbox', 'today', 'more']);
  await expect.poll(() => ids(page)).toEqual(['inbox', 'today', 'more']);

  await expect.poll(() => readConfig(request)).toEqual(['inbox', 'today']);
  await expect.poll(() => previewIds(page)).toEqual(['inbox', 'today', 'more']);
});

test('两个独立浏览器 context：A 保存后 B 在 35 秒内同步，且不共享 localStorage', async ({ page, browser, request }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await putConfig(request, ['inbox', 'today']);

  const contextB = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: {
      cookies: [{ name: 'wwa_session', value: 'wwa-e2e-owner-session', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' }],
      origins: [],
    },
  });
  const pageB = await contextB.newPage();
  try {
    await page.goto('/#/inbox');
    await pageB.goto('/#/inbox');
    await expect.poll(() => ids(pageB)).toEqual(['inbox', 'today', 'more']);

    await putConfig(request, ['plan', 'focus', 'chat']);

    await expect.poll(() => ids(pageB), { timeout: 35_000 }).toEqual(['plan', 'focus', 'chat', 'more']);

    for (const target of [page, pageB]) {
      const stored = await target.evaluate(() => JSON.stringify(window.localStorage));
      expect(stored).not.toContain('visibleViews');
      expect(stored).not.toContain('mobile-navigation');
    }
  } finally {
    await contextB.close();
  }
});

test('鼠标拖动：从第一项拖到第三项后服务端数组变化且只发一次 PUT', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await putConfig(request, ['plan', 'focus', 'inbox']);

  let puts = 0;
  await page.route(navPath, async (route) => {
    if (route.request().method() === 'PUT') puts += 1;
    await route.fallback();
  });

  await page.goto('/#/settings/ui');
  const panel = page.getByTestId('mobile-navigation-settings');
  const handle = panel.getByRole('button', { name: '拖动规划', exact: true });
  await expect(handle).toBeVisible();
  const targetRow = panel.getByTestId('mobile-navigation-row-inbox');
  // 设置弹窗内容较高，先把行滚进可视区域，坐标才会落在控件上。
  await handle.scrollIntoViewIfNeeded();
  await targetRow.scrollIntoViewIfNeeded();

  const from = await handle.boundingBox();
  const target = await targetRow.boundingBox();
  expect(from).not.toBeNull();
  expect(target).not.toBeNull();
  const startX = from!.x + from!.width / 2;
  const startY = from!.y + from!.height / 2;
  const endY = target!.y + target!.height * 0.75;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 12, { steps: 2 });
  await page.mouse.move(target!.x + target!.width / 2, endY, { steps: 15 });
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target!.x + target!.width / 2, y: endY, button: 'left', buttons: 0, clickCount: 1 });
  await session.detach();

  await expect.poll(() => readConfig(request)).toEqual(['focus', 'inbox', 'plan']);
  expect(puts).toBe(1);
});

test('触屏：真实 touch 长按并拖动完成排序', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await putConfig(request, ['plan', 'focus', 'inbox']);

  let puts = 0;
  await page.route(navPath, async (route) => {
    if (route.request().method() === 'PUT') puts += 1;
    await route.fallback();
  });

  await page.goto('/#/settings/ui');
  const panel = page.getByTestId('mobile-navigation-settings');
  const handle = panel.getByRole('button', { name: '拖动规划', exact: true });
  await expect(handle).toBeVisible();
  const targetRow = panel.getByTestId('mobile-navigation-row-inbox');
  await handle.scrollIntoViewIfNeeded();
  await targetRow.scrollIntoViewIfNeeded();

  const from = await handle.boundingBox();
  const target = await targetRow.boundingBox();
  expect(from).not.toBeNull();
  expect(target).not.toBeNull();
  const startX = from!.x + from!.width / 2;
  const startY = from!.y + from!.height / 2;
  const endY = target!.y + target!.height * 0.75;

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y: startY }] });
  await sleep(260);
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: startX, y: startY + ((endY - startY) * step) / steps }],
    });
    await sleep(20);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  await expect.poll(() => readConfig(request)).toEqual(['focus', 'inbox', 'plan']);
  expect(puts).toBe(1);
});

test('键盘：手柄聚焦后 Space、方向键、Space 完成排序', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await putConfig(request, ['plan', 'focus', 'inbox']);

  await page.goto('/#/settings/ui');
  const panel = page.getByTestId('mobile-navigation-settings');
  const handle = panel.getByRole('button', { name: '拖动规划', exact: true });
  await expect(handle).toBeVisible();
  const targetRow = panel.getByTestId('mobile-navigation-row-inbox');
  await handle.scrollIntoViewIfNeeded();
  await targetRow.scrollIntoViewIfNeeded();
  await waitForSettingsScroll(page);

  await handle.focus();
  await page.keyboard.press('Space');
  await sleep(150);
  await page.keyboard.press('ArrowDown');
  await waitForSettingsScroll(page);
  await sleep(150);
  await page.keyboard.press('ArrowDown');
  await waitForSettingsScroll(page);
  await sleep(150);
  await page.keyboard.press('Space');

  await expect.poll(() => readConfig(request)).toEqual(['focus', 'inbox', 'plan']);
});

test('当前页被远端隐藏：URL 不变、页面仍可见、“更多”选中', async ({ page, request }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await putConfig(request, ['plan', 'inbox']);
  await page.goto('/#/plan');

  const nav = page.getByTestId('mobile-bottom-navigation');
  await expect(nav.locator('[data-view="plan"]')).toHaveAttribute('aria-current', 'page');

  await putConfig(request, ['inbox']);

  await expect(nav.locator('[data-view="more"]')).toHaveAttribute('aria-current', 'page', { timeout: 35_000 });
  await expect(page).toHaveURL(/#\/plan$/);
  await expect(page.getByTestId('timeline-scroll')).toBeVisible();
  await expect.poll(() => ids(page)).toEqual(['inbox', 'more']);
});

test('隐藏入口仍可从“更多”打开，底栏不重新添加', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await putConfig(request, ['inbox']);
  await page.goto('/#/more');

  await page.getByRole('navigation', { name: '工作区导航' }).getByRole('button', { name: '设置', exact: true }).click();
  // 手机上设置先显示分类列表，底栏设置在「界面」里。
  await page.getByRole('dialog').getByRole('button', { name: '界面', exact: true }).click();
  await expect(page.getByTestId('mobile-navigation-settings')).toBeVisible();
  await expect(page.getByTestId('mobile-bottom-navigation').locator('[data-view="settings"]')).toHaveCount(0);
  await expect.poll(() => ids(page)).toEqual(['inbox', 'more']);
  expect(await readConfig(request)).toEqual(['inbox']);
});

test('模型设置接口失败时功能模块仍可加载和保存', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await putConfig(request, ['inbox']);
  await page.route('**/api/settings', async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ data: null, error: '模型设置不可用' }) });
  });

  await page.goto('/#/settings/ui');
  const panel = page.getByTestId('mobile-navigation-settings');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('mobile-navigation-save-status')).toHaveText('已同步到当前服务');

  await panel.getByRole('switch', { name: '在底栏显示今天', exact: true }).click();
  await expect.poll(() => readConfig(request)).toEqual(['inbox', 'today']);
});

test('320px、390px、768px 下没有横向滚动，最后一项固定是 more', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await putConfig(request, ['inbox', 'today', 'quadrant', 'topics']);

  for (const size of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 768, height: 900 }]) {
    await page.setViewportSize(size);
    await page.goto('/#/inbox');
    const nav = page.getByTestId('mobile-bottom-navigation');
    await expect(nav.locator('[data-view]').last()).toHaveAttribute('data-view', 'more');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

test('深浅主题的色值与开关尺寸符合规范', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await putConfig(request, ['inbox', 'today']);
  await page.goto('/#/settings/ui');
  const panel = page.getByTestId('mobile-navigation-settings');
  await expect(panel).toBeVisible();
  // 等设置弹窗的缩放动画结束，再量像素。
  await sleep(400);

  const list = panel.locator('.mnav-list').first();
  const onTrack = panel.getByTestId('mobile-navigation-row-inbox').locator('.mnav-switch-track');
  const offTrack = panel.getByTestId('mobile-navigation-row-plan').locator('.mnav-switch-track');

  const surface = () => list.evaluate((element) => getComputedStyle(element).backgroundColor);
  const divider = () => list.evaluate((element) => getComputedStyle(element).borderTopColor);
  const trackColor = (track: ReturnType<Page['getByTestId']>) => track.evaluate((element) => getComputedStyle(element).backgroundColor);
  const trackBox = (track: ReturnType<Page['getByTestId']>) => track.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });

  await expect.poll(surface).toBe('rgb(255, 255, 255)');
  await expect.poll(() => divider()).toBe('rgb(229, 229, 229)');
  await expect.poll(() => trackColor(onTrack)).toBe('rgb(71, 114, 250)');
  await expect.poll(() => trackColor(offTrack)).toBe('rgb(212, 212, 212)');
  expect(await trackBox(onTrack)).toEqual({ width: 40, height: 24 });

  await page.evaluate(() => { document.documentElement.classList.add('dark'); });
  // 开关轨道背景有 150ms 过渡，颜色断言都要等过渡完成。
  await expect.poll(surface).toBe('rgb(36, 36, 36)');
  await expect.poll(() => divider()).toBe('rgb(54, 54, 54)');
  await expect.poll(() => trackColor(onTrack)).toBe('rgb(71, 114, 250)');
  await expect.poll(() => trackColor(offTrack)).toBe('rgb(85, 85, 85)');
});

test('1023px 显示底栏，1024px 隐藏', async ({ page, request }) => {
  await page.setViewportSize({ width: 1023, height: 768 });
  await putConfig(request, ['inbox']);
  await page.goto('/#/inbox');
  await expect(page.getByTestId('mobile-bottom-navigation')).toHaveCount(1);

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByTestId('mobile-bottom-navigation')).toHaveCount(0);
});

test('关闭设置弹窗后保存仍会完成', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await putConfig(request, ['plan']);

  let puts = 0;
  await page.route(navPath, async (route) => {
    if (route.request().method() === 'PUT') {
      puts += 1;
      await sleep(1_500);
    }
    await route.fallback();
  });

  await page.goto('/#/settings/ui');
  const panel = page.getByTestId('mobile-navigation-settings');
  await expect(panel).toBeVisible();

  await panel.getByRole('switch', { name: '在底栏显示今天', exact: true }).click();
  await expect(panel.getByTestId('mobile-navigation-save-status')).toHaveText('正在保存…');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mobile-navigation-settings')).toHaveCount(0);

  await expect.poll(() => readConfig(request)).toEqual(['plan', 'today']);
  await expect.poll(() => ids(page)).toEqual(['plan', 'today', 'more']);
  expect(puts).toBe(1);
});

test('空配置：真实底栏和预览都只有“更多”', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await putConfig(request, []);
  await page.goto('/#/inbox');

  await expect.poll(() => ids(page)).toEqual(['more']);

  await page.goto('/#/settings/ui');
  const panel = page.getByTestId('mobile-navigation-settings');
  await expect(panel).toBeVisible();
  await expect.poll(() => previewIds(page)).toEqual(['more']);
  // 空配置合法：已显示组为空，收集箱只出现在未显示组。
  await expect(panel.locator('.mnav-list').first().locator('li')).toHaveCount(0);
  await expect(panel.getByTestId('mobile-navigation-row-inbox')).toHaveCount(1);
});

test('截图检查：亮暗主题与窄宽视口', async ({ page, request }) => {
  await putConfig(request, ['inbox', 'today', 'quadrant', 'topics']);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/settings/ui');
  const panel = page.getByTestId('mobile-navigation-settings');
  await expect(panel).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-navigation/390-light.png', fullPage: false });

  await page.evaluate(() => { document.documentElement.classList.add('dark'); });
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'test-results/mobile-navigation/390-dark.png' });

  await page.setViewportSize({ width: 320, height: 720 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/mobile-navigation/320.png' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/settings/ui');
  await expect(page.getByTestId('mobile-navigation-settings')).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-navigation/desktop-settings.png' });
});
