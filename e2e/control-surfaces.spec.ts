import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const evidence = resolve(process.env.DOVUN_EVIDENCE_DIR ?? 'docs/design/dovun/controls-unification/evidence');
test.afterAll(() => e2eDatabase.$disconnect());

test('real controls keep focus, independent surface depth, theme and responsive layout', async ({ page }) => {
  await page.goto('/controls.html');
  await page.getByRole('heading', { name: '真实控件对照' }).waitFor();
  const primary = page.getByRole('button', { name: '新建任务', exact: true });
  const input = page.getByRole('textbox', { name: '任务名称', exact: true });
  for (const theme of ['浅色', '深色']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    await expect(primary).toHaveCSS('font-size', '14px');
    const shadows = await input.evaluate(el => ({ input: getComputedStyle(el).boxShadow, button: getComputedStyle(document.querySelector('.glass-button-primary')!).boxShadow, card: getComputedStyle(document.querySelector('.controls-card')!).boxShadow }));
    expect(shadows.input).toContain('inset');
    expect(new Set(Object.values(shadows)).size).toBe(3);
    const contrast = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const rgb = (v: string) => [1, 3, 5].map(i => parseInt(v.trim().slice(i, i + 2), 16) / 255);
      const lum = (c: number[]) => c.reduce((sum, v, i) => sum + (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i], 0);
      const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
      return ['--muted-foreground', '--foreground', '--link'].flatMap(fg => ['--surface-card-bg', '--surface-input-bg', '--surface-overlay-bg'].flatMap(bg => {
        const a = rgb(style.getPropertyValue(fg)), b = rgb(style.getPropertyValue(bg));
        return [ratio(a, b), ratio(a, b.map(v => v + (1 - v) * .08))];
      }));
    });
    expect(Math.min(...contrast)).toBeGreaterThanOrEqual(4.5);
    await page.getByRole('button', { name: '打开弹窗', exact: true }).click();
    await page.getByRole('dialog').getByRole('textbox', { name: '记录标题' }).fill('中文输入与长文字测试');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '打开弹窗', exact: true })).toBeFocused();
    await input.focus();
    expect(await input.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe(shadows.input);
    for (const width of [1586, 1440, 1280, 1024, 390]) {
      await page.setViewportSize({ width, height: 992 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  }
  await page.getByRole('button', { name: '跟随系统', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveClass('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass('dark');
  expect(await primary.evaluate(el => Math.max(...getComputedStyle(el).transitionDuration.split(',').map(parseFloat)))).toBeLessThan(.001);
});

test('all application routes use shared themes without viewport overflow or page errors', async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  await resetE2eDatabase();
  const response = await request.post(`${api}/api/tasks`, { data: { title: '整理下一阶段的工作与资料', dueDate: new Date().toISOString().slice(0, 10) } });
  expect(response.ok()).toBe(true);
  const task = (await response.json()).data;
  await request.post(`${api}/api/tasks`, { data: { title: '长标题验证：' + '任务内容与附加说明需要自然换行'.repeat(5) } });
  await page.addInitScript(() => { localStorage.setItem('dovun.theme', 'light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
  const errors: string[] = [], browserNotifications: { route: string; message: string }[] = [];
  page.on('pageerror', e => {
    // WebKit reports an observer delivery-cycle notification during chart resize.
    // Keep it in the report; do not classify it as an application exception.
    if (e.message === 'ResizeObserver loop completed with undelivered notifications.') browserNotifications.push({ route: page.url(), message: e.message });
    else errors.push(e.message);
  });
  const routes = ['today', 'inbox', 'topics', 'plan', 'quadrant', 'focus', 'stats', 'library', 'knowledge/brief', 'knowledge/memories', 'knowledge/extractions', 'reviews', 'proposals', 'skills', 'connections', 'runs', 'worktrees', 'search', 'tags', 'archived', 'settings', 'settings/model', 'settings/local', 'settings/skills', 'settings/projects', 'settings/ui', 'settings/data', 'settings/about', 'changes', 'trash', 'chat', 'more'];
  const snapshots = new Set(['today', 'plan', 'library', 'knowledge/brief', 'settings', 'proposals']);
  const results: unknown[] = [];
  await mkdir(evidence, { recursive: true });
  for (const theme of ['light', 'dark']) {
    for (const width of [1586, 390]) {
      await page.setViewportSize({ width, height: 992 });
      for (const route of routes) {
        await page.goto(`/#/${route}`);
        await page.evaluate(t => { localStorage.setItem('dovun.theme', t); document.documentElement.className = t; }, theme);
        await expect(page.locator('.app-frame')).toBeVisible();
        if (route === 'chat') await expect(page.getByTestId('ai-assistant')).toBeVisible();
        else {
          await expect(page.locator('.app-main')).not.toBeEmpty();
          await expect(page.locator('.dovun-main')).toBeVisible();
        }
        // Allow data and font layout to settle before measuring and capturing.
        await page.waitForTimeout(150);
        const metrics = await page.evaluate(() => {
          const visible = (el: Element) => { const box = el.getBoundingClientRect(); const s = getComputedStyle(el); return box.width > 2 && box.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
          const controls = [...document.querySelectorAll('button, input, textarea, select')].filter(visible).filter(el => !el.closest('.tiptap, [data-user-content]'));
          const uncovered = controls.filter(el => !el.hasAttribute('data-slot')).map(el => el.outerHTML.slice(0, 200));
          const wrongPaint = controls.filter(el => el.getAttribute('data-slot') === 'button' && ['default', 'outline', 'secondary'].includes(el.getAttribute('data-variant') ?? '') && el.getAttribute('aria-pressed') !== 'true' && !getComputedStyle(el).backgroundImage.includes('linear-gradient')).map(el => el.outerHTML.slice(0, 200));
          return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, fontSize: getComputedStyle(document.body).fontSize, background: getComputedStyle(document.body).backgroundColor, controlCount: controls.length, uncovered, wrongPaint };
        });
        expect(metrics.uncovered, `${route}/${theme}/${width}: controls bypassing public components`).toEqual([]);
        expect(metrics.wrongPaint, `${route}/${theme}/${width}: local CSS replaced public material`).toEqual([]);
        expect(metrics.pageWidth, `${route}/${theme}/${width}`).toBeLessThanOrEqual(width);
        expect(metrics.fontSize).toBe('14px');
        if (testInfo.project.name === 'chromium' && snapshots.has(route)) await page.screenshot({ path: `${evidence}/${route.replaceAll('/', '-')}-${theme}-${width}.png`, animations: 'disabled' });
        results.push({ route, theme, ...metrics });
      }
    }
  }
  await page.setViewportSize({ width: 1586, height: 992 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: task.title, exact: true }).click();
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toBeVisible();
  if (testInfo.project.name === 'chromium') for (const theme of ['light', 'dark']) {
    await page.evaluate(t => { document.documentElement.className = t; }, theme);
    await page.screenshot({ path: `${evidence}/task-detail-${theme}-1586.png`, animations: 'disabled' });
  }
  expect(errors).toEqual([]);
  await writeFile(`${evidence}/route-audit-${testInfo.project.name}.json`, JSON.stringify({ results, errors, browserNotifications, taskDetail: true }, null, 2) + '\n');
});

test('English core pages and longer labels reflow in both themes', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { localStorage.setItem('dovun.language', 'en'); (window as any).__REACT_GRAB_DISABLED__ = true; });
  await mkdir(evidence, { recursive: true });
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 992 });
    for (const route of ['today', 'plan', 'library', 'knowledge/brief', 'settings', 'proposals', 'chat', 'connections']) {
      await page.goto(`/#/${route}`);
      await page.evaluate(t => { localStorage.setItem('dovun.theme', t); document.documentElement.className = t; }, theme);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(route === 'chat' ? page.getByTestId('ai-assistant') : page.locator('.dovun-main')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (testInfo.project.name === 'chromium' && route === 'today') await page.screenshot({ path: `${evidence}/today-en-${theme}-${width}.png`, animations: 'disabled' });
    }
  }
});

// Locked-session UI is also part of the shared system, without sending credentials.
test('locked session uses shared input and button surfaces in both themes', async ({ page }, testInfo) => {
  await page.context().clearCookies();
  await page.goto('/#/today');
  await expect(page.locator('form [data-slot="input"]')).toBeVisible();
  await mkdir(evidence, { recursive: true });
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 992 });
    await page.evaluate(t => { document.documentElement.className = t; }, theme);
    await expect(page.locator('form [data-slot="button"]')).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (testInfo.project.name === 'chromium') await page.screenshot({ path: `${evidence}/login-${theme}-${width}.png`, animations: 'disabled' });
  }
});
