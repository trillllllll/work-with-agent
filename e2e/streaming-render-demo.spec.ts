import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/streaming-render-demo.html'); });

for (const [name, kind] of [['Markdown', 'markdown'], ['Chart', 'chart'], ['Mermaid', 'mermaid'], ['SVG', 'svg'], ['HTML', 'html']]) {
  test(`${name} paints before the full reply and completes`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: new RegExp('^' + name + ' ') }).click();
    await page.getByRole('button', { name: '开始演示', exact: true }).click();
    await expect.poll(async () => parseInt((await page.getByTestId('render-count').textContent()) || '0', 10), { timeout: 10_000, intervals: [50, 100] }).toBeGreaterThan(0);
    await expect(page.getByTestId('render-count')).toHaveAttribute('data-first-before-end', 'true');
    await page.getByLabel('播放速度').selectOption('4');
    await expect(page.getByTestId('stream-status')).toHaveText('生成完成');
    if (kind === 'markdown') {
      const cards = page.locator('.markdown-table-rows');
      if (info.project.name === 'mobile') { await expect(cards).toBeVisible(); await expect(page.locator('.markdown-table-scroll')).toBeHidden(); }
      else { await expect(cards).toBeHidden(); await expect(page.locator('.markdown-table-scroll')).toBeVisible(); }
    }
    if (kind === 'chart') await expect(page.locator('[data-points="5"]')).toBeVisible();
    if (kind === 'mermaid' || kind === 'svg') {
      const img = page.getByTestId('stream-output').locator('img'); await expect(img).toBeVisible();
      expect(await img.evaluate(async node => fetch((node as HTMLImageElement).src).then(r => r.text()))).toContain(kind === 'mermaid' ? '保留可读结果' : '每一个完整片段');
    }
    if (kind === 'html') await expect(page.frameLocator('iframe').getByRole('button', { name: '确认我的下一步' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/streaming-render/${info.project.name}-${kind}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('pause, step, interrupt and replay obey the transport state', async ({ page }) => {
  await page.getByRole('button', { name: '开始演示', exact: true }).click();
  await expect.poll(async () => parseInt((await page.getByTestId('render-count').textContent()) || '0', 10), { timeout: 10_000, intervals: [50, 100] }).toBeGreaterThan(0);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const paused = await page.getByTestId('received-bytes').textContent();
  await page.waitForTimeout(250);
  expect(await page.getByTestId('received-bytes').textContent()).toBe(paused);
  await page.getByRole('button', { name: '接收下一块' }).click();
  expect(await page.getByTestId('received-bytes').textContent()).not.toBe(paused);
  await page.getByRole('button', { name: '模拟断流' }).click();
  await expect(page.getByRole('alert')).toContainText('流已中断');
  await expect(page.getByRole('button', { name: '继续', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重新演示', exact: true }).first().click();
  await expect(page.getByTestId('stream-status')).toHaveText('准备就绪');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
});

test('HTML input and frame survive streaming, and script executes once', async ({ page }) => {
  await page.getByRole('button', { name: /^HTML / }).click();
  await page.getByRole('button', { name: '开始演示', exact: true }).click();
  const frame = page.frameLocator('iframe');
  await frame.getByLabel('我的下一步').fill('保留这个输入');
  expect(await page.getByTestId('stream-output').getAttribute('data-done')).toBe('false');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const child = page.frames().find(f => f.parentFrame());
  expect(await child!.evaluate(() => (window as unknown as { __demoScriptRuns?: number }).__demoScriptRuns ?? 0)).toBe(0);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByLabel('播放速度').selectOption('4');
  await expect(page.getByTestId('stream-status')).toHaveText('生成完成');
  await expect(frame.getByLabel('我的下一步')).toHaveValue('保留这个输入');
  await frame.getByRole('button', { name: '确认我的下一步' }).click();
  await expect(frame.locator('output')).toHaveText('下一步：保留这个输入');
  expect(await child!.evaluate(() => (window as unknown as { __demoScriptRuns?: number }).__demoScriptRuns)).toBe(1);
  await page.getByRole('button', { name: '切换深色' }).click();
  await expect(frame.getByLabel('我的下一步')).toHaveValue('保留这个输入');
  expect(await child!.evaluate(() => (window as unknown as { __demoScriptRuns?: number }).__demoScriptRuns)).toBe(1);
  expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts');
});

for (const name of ['Mermaid', 'SVG']) test(`${name} retains the last valid picture on a bad final fragment`, async ({ page }) => {
  await page.getByRole('button', { name: new RegExp('^' + name + ' ') }).click();
  await page.getByRole('button', { name: '在末尾加入错误片段' }).click();
  await page.getByRole('button', { name: '开始演示', exact: true }).click();
  await expect(page.getByTestId('stream-output').locator('img')).toBeVisible();
  await page.getByLabel('播放速度').selectOption('4');
  await expect(page.getByRole('alert')).toContainText('保留最近成功的预览');
  await expect(page.getByTestId('stream-output').locator('img')).toBeVisible();
});

test('waiting mode is blank until completion; controls work with keyboard', async ({ page }) => {
  await page.getByRole('button', { name: '等待完成', exact: true }).click();
  await page.getByRole('button', { name: '开始演示', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('收到完整内容后再显示')).toBeVisible();
  await page.getByLabel('播放速度').selectOption('4');
  await expect(page.getByTestId('stream-status')).toHaveText('生成完成');
  await expect(page.getByRole('heading', { name: '把这一周，变成看得见的进展' })).toBeVisible();
  await page.getByRole('button', { name: '切换深色' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
});
