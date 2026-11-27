import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';

test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  for (let index = 0; index < 24; index += 1) {
    const response = await request.post(`${api}/api/tasks`, { data: { title: `玻璃标题栏 ${index + 1}` } });
    expect(response.ok()).toBe(true);
  }
  await page.addInitScript(() => { (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(() => e2eDatabase.$disconnect());

for (const theme of ['light', 'dark'] as const) test(`task page header floats as glass and shrinks after scrolling (${theme})`, async ({ page }) => {
  await page.addInitScript(value => localStorage.setItem('dovun.theme', value), theme);
  await page.goto('/#/inbox');
  const main = page.locator('main.app-main');
  const header = main.locator('.dovun-page-header');
  await expect(page.getByTestId('task-list').locator('article[data-testid]')).toHaveCount(24);
  const glass = await header.evaluate(node => {
    const style = getComputedStyle(node, '::before');
    return { position: getComputedStyle(node).position, border: getComputedStyle(node).borderBottomWidth, blur: style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter'), background: style.backgroundColor };
  });
  expect(glass.position).toBe('sticky');
  expect(glass.border).toBe('0px');
  expect(glass.blur).toContain('blur(11px)');
  expect(glass.background).toMatch(/0\.51\)$/);
  await expect(main).not.toHaveAttribute('data-scrolled');
  const titleSize = () => header.locator('h1').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  const expanded = await titleSize();
  await main.evaluate(node => { node.scrollTop = 400; });
  await expect(main).toHaveAttribute('data-scrolled', '');
  await expect(main).toHaveAttribute('data-header-collapsed', '');
  await expect.poll(titleSize).toBe(20);
  expect(expanded).toBeGreaterThan(20);
  // The header stays pinned to the top of the scroller while the list runs underneath.
  const [mainBox, headerBox] = [await main.boundingBox(), await header.boundingBox()];
  expect(Math.abs(headerBox!.y - mainBox!.y)).toBeLessThanOrEqual(1);
  await expect(header.locator('.inbox-description')).toBeHidden();
  // Back at the top the header returns to full size.
  await main.evaluate(node => { node.scrollTop = 0; });
  await expect(main).not.toHaveAttribute('data-header-collapsed');
  await expect.poll(titleSize).toBe(expanded);
});

test('sidebar scrollbar runs in its own gutter beside the rows', async ({ page, isMobile }) => {
  await page.addInitScript(() => localStorage.setItem('dovun.theme', 'light'));
  await page.setViewportSize(isMobile ? { width: 412, height: 520 } : { width: 1280, height: 560 });
  await page.goto('/#/inbox');
  if (isMobile) await page.getByRole('button', { name: '主导航', exact: true }).click();
  const scope = isMobile ? page.locator('.assistant-navigation-sheet') : page.locator('.dovun-workspace > .app-sidebar');
  const scroller = scope.locator('.sidebar-scroll');
  await scroller.hover();
  await scroller.evaluate(node => { node.scrollTop = 40; node.dispatchEvent(new Event('scroll')); });
  const thumb = scope.locator('.sidebar-scroll-thumb');
  await expect(thumb).toHaveCSS('opacity', '1');
  const [thumbBox, rowBox] = [await thumb.boundingBox(), await scroller.locator('.sidebar-link').first().boundingBox()];
  expect(thumbBox!.x).toBeGreaterThanOrEqual(rowBox!.x + rowBox!.width);
});

test('mobile navigation drawer is frosted glass over a progressive blur', async ({ page, isMobile }) => {
  test.skip(!isMobile, '手机导航抽屉');
  await page.addInitScript(() => localStorage.setItem('dovun.theme', 'light'));
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '主导航', exact: true }).click();
  const drawer = page.locator('.assistant-navigation-sheet');
  await expect.poll(() => drawer.evaluate(node => node.getBoundingClientRect().left)).toBe(0);
  const styles = await page.evaluate(() => {
    const sheet = getComputedStyle(document.querySelector('.assistant-navigation-sheet')!);
    const backdrop = getComputedStyle(document.querySelector('.assistant-navigation-backdrop')!);
    const layers = [...document.querySelectorAll('.assistant-navigation-veil > i')].map(node => {
      const style = getComputedStyle(node);
      return { blur: style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter'), opacity: style.opacity };
    });
    const veil = document.querySelector<HTMLElement>('.assistant-navigation-veil')!.getBoundingClientRect();
    return { sheetBlur: sheet.backdropFilter || sheet.getPropertyValue('-webkit-backdrop-filter'), backdropFilter: backdrop.backdropFilter, backdropOpacity: backdrop.opacity, layers, veilLeft: veil.left };
  });
  expect(styles.sheetBlur).toContain('blur(15px)');
  // The overlay itself must stay a plain hit target so the layers inside can sample the page.
  expect(styles.backdropFilter).toBe('none');
  expect(styles.backdropOpacity).toBe('1');
  expect(styles.layers.map(layer => layer.blur).slice(0, 5)).toEqual(['blur(0.25px)', 'blur(0.5px)', 'blur(1px)', 'blur(2px)', 'blur(4px)']);
  expect(styles.layers.every(layer => layer.opacity === '1')).toBe(true);
  // The blur begins at the drawer's edge.
  const width = await drawer.evaluate(node => node.getBoundingClientRect().width);
  expect(Math.abs(styles.veilLeft - (width - 1))).toBeLessThanOrEqual(1);
  // Escape slides it back out before it unmounts.
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});

test('the header glass reaches the edges of the page without making it scroll sideways', async ({ page }) => {
  await page.goto('/#/inbox');
  const main = page.locator('main.app-main');
  await expect(page.getByTestId('task-list').locator('article[data-testid]')).toHaveCount(24);
  const box = await main.evaluate(node => {
    const header = node.querySelector('.dovun-page-header')!;
    const before = getComputedStyle(header, '::before');
    const rect = header.getBoundingClientRect(), mainRect = node.getBoundingClientRect();
    return { overflow: node.scrollWidth - node.clientWidth, left: rect.left + parseFloat(before.left) - mainRect.left, right: rect.right - parseFloat(before.right) - (mainRect.left + node.clientWidth) };
  });
  expect(box.overflow).toBeLessThanOrEqual(0);
  expect(Math.abs(box.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.right)).toBeLessThanOrEqual(1);
});
