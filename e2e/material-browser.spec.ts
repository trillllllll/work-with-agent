import type { Page } from '@playwright/test';
import { test, expect, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const base = 'http://127.0.0.1:3015';
async function owner(request: APIRequestContext, path: string, input: unknown) {
  const response = await request.post(`${base}${path}`, { data: input });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}
const docx = (name: string) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('docx') });

async function previewBox(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((node) => node.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
  return dialog.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const table = node.ownerDocument.querySelector('table[aria-label="材料"]');
    const tableBox = table instanceof HTMLElement ? table.getBoundingClientRect() : null;
    return {
      left: rect.left,
      right: window.innerWidth - rect.right,
      top: rect.top,
      bottom: window.innerHeight - rect.bottom,
      width: rect.width,
      height: rect.height,
      viewport: window.innerWidth,
      viewportHeight: window.innerHeight,
      position: getComputedStyle(node).position,
      scrollOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      beside: tableBox ? rect.left >= tableBox.right - 2 : false,
      below: tableBox ? rect.top >= tableBox.bottom - 2 : false,
    };
  });
}

async function expectPreviewInset(page: Page, name: string) {
  const box = await previewBox(page, name);
  expect(box.position).toBe('fixed');
  expect(box.beside).toBe(false);
  expect(box.below).toBe(false);
  expect(box.left).toBeGreaterThan(23);
  expect(box.right).toBeGreaterThan(23);
  expect(box.top).toBeGreaterThan(16);
  expect(box.bottom).toBeGreaterThan(16);
  expect(box.width).toBeLessThan(box.viewport - 40);
  expect(box.scrollOverflow).toBeLessThanOrEqual(1);
  if (box.viewport >= 1100) expect(box.width).toBeGreaterThan(900);
  else expect(box.width).toBeGreaterThan(box.viewport - 80);
  const cap = Math.min(46 * 16, box.viewportHeight - 48);
  expect(box.height).toBeGreaterThan(cap - 8);
  expect(box.height).toBeLessThan(cap + 8);
}

test.beforeEach(resetE2eDatabase);
test.afterAll(() => e2eDatabase.$disconnect());

test('导入文件不用填标题，预览在弹窗里并随窗口留出边距', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/knowledge');
  await page.getByLabel('选择要导入的文件', { exact: true }).setInputFiles(docx('【售后】九月.docx'));
  await page.getByRole('button', { name: '【售后】九月', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '【售后】九月', exact: true });
  await expect(preview).toContainText('【售后】九月.docx');
  for (const size of [
    { width: 1400, height: 900 },
    { width: 1024, height: 768 },
    { width: 700, height: 800 },
    { width: 578, height: 800 },
    { width: 390, height: 800 },
    { width: 800, height: 560 },
  ]) {
    await page.setViewportSize(size);
    await expectPreviewInset(page, '【售后】九月');
  }

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await page.getByRole('button', { name: '保存材料', exact: true }).click();
  const save = page.getByRole('button', { name: '保存材料', exact: true }).last();
  await expect(save).toBeDisabled();
  await page.getByLabel('材料标题', { exact: true }).fill('临时标题');
  await expect(save).toBeEnabled();
  await page.getByLabel('材料标题', { exact: true }).fill('');
  await expect(save).toBeDisabled();
  await page.getByLabel('材料类型', { exact: true }).selectOption({ label: '附件' });
  await page.getByLabel('选择附件', { exact: true }).setInputFiles(docx('会议纪要.docx'));
  await expect(page.getByLabel('材料标题', { exact: true })).toHaveValue('会议纪要');
  await page.getByLabel('材料标题', { exact: true }).fill('');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('button', { name: '会议纪要', exact: true })).toBeVisible();

  const task = await owner(request, '/api/tasks', { title: '关联检查' });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '任务操作：关联检查', exact: true }).click();
  await page.getByRole('menuitem', { name: '关联资料', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '关联资料', exact: true });
  await expect(dialog.getByRole('button', { name: '已关联任务', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '导入文件', exact: true })).toBeVisible();
  await dialog.getByLabel('选择要导入的文件', { exact: true }).setInputFiles(docx('任务说明.docx'));
  await dialog.getByRole('button', { name: '任务说明', exact: true }).click();
  const nested = page.getByRole('dialog', { name: '任务说明', exact: true });
  await expect(nested).toBeVisible();
  await expect(page.getByRole('dialog', { name: '关联资料', exact: true, includeHidden: true })).toBeVisible();
  await expectPreviewInset(page, '任务说明');
  await page.setViewportSize({ width: 390, height: 800 });
  await expectPreviewInset(page, '任务说明');
  await page.keyboard.press('Escape');
  await expect(nested).toBeHidden();
  await expect(dialog).toBeVisible();
});

test('导入的 Markdown 能预览正文，关联任务可以事后修改', async ({ page, request }) => {
  await owner(request, '/api/tasks', { title: '对接任务' });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/knowledge');
  await page.getByLabel('资料所属清单', { exact: true }).selectOption({ label: '收集箱' });
  await page.getByLabel('选择要导入的文件', { exact: true }).setInputFiles({ name: '接口说明.md', mimeType: 'text/markdown', buffer: Buffer.from('# 接口说明\n\n这是正文') });
  await page.getByRole('button', { name: '接口说明', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '接口说明', exact: true });
  await expect(preview.locator('.markdown-body').getByRole('heading', { name: '接口说明', exact: true })).toBeVisible();
  await expect(preview.locator('.markdown-body')).toContainText('这是正文');
  const link = preview.getByRole('combobox', { name: '关联任务', exact: true });
  await expect(link).toContainText('对接任务');
  await link.selectOption({ label: '对接任务' });
  await expect(link.locator('option:checked')).toHaveText('对接任务');
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(page.getByRole('cell', { name: '对接任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '接口说明', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '接口说明', exact: true });
  await reopened.getByRole('combobox', { name: '关联任务', exact: true }).selectOption({ label: '不关联' });
  await page.keyboard.press('Escape');
  await expect(reopened).toBeHidden();
  await expect(page.getByRole('cell', { name: '对接任务', exact: true })).toHaveCount(0);

  await page.getByLabel('选择要导入的文件', { exact: true }).setInputFiles({ name: '对接说明.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('UEsDBAoAAAAAAGM7PV3XeYTquAEAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiPgogIDxEZWZhdWx0IEV4dGVuc2lvbj0icmVscyIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLnJlbGF0aW9uc2hpcHMreG1sIi8+CiAgPERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz4KICA8T3ZlcnJpZGUgUGFydE5hbWU9Ii93b3JkL2RvY3VtZW50LnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC53b3JkcHJvY2Vzc2luZ21sLmRvY3VtZW50Lm1haW4reG1sIi8+CjwvVHlwZXM+UEsDBAoAAAAAAGM7PV0AAAAAAAAAAAAAAAAGAAAAX3JlbHMvUEsDBAoAAAAAAGM7PV0gG4bqLgEAAC4BAAALAAAAX3JlbHMvLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+CjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPgogIDxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvb2ZmaWNlRG9jdW1lbnQiIFRhcmdldD0id29yZC9kb2N1bWVudC54bWwiLz4KPC9SZWxhdGlvbnNoaXBzPlBLAwQKAAAAAABjOz1dAAAAAAAAAAAAAAAABQAAAHdvcmQvUEsDBAoAAAAAAGM7PV1xKhdY2gAAANoAAAARAAAAd29yZC9kb2N1bWVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+Cjx3OmRvY3VtZW50IHhtbG5zOnc9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy93b3JkcHJvY2Vzc2luZ21sLzIwMDYvbWFpbiI+CiAgPHc6Ym9keT48dzpwPjx3OnI+PHc6dD7lr7nmjqXmrrXokL08L3c6dD48L3c6cj48L3c6cD48L3c6Ym9keT4KPC93OmRvY3VtZW50PlBLAQIUAAoAAAAAAGM7PV3XeYTquAEAALgBAAATAAAAAAAAAAAAAAAAAAAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQACgAAAAAAYzs9XQAAAAAAAAAAAAAAAAYAAAAAAAAAAAAQAAAA6QEAAF9yZWxzL1BLAQIUAAoAAAAAAGM7PV0gG4bqLgEAAC4BAAALAAAAAAAAAAAAAAAAAA0CAABfcmVscy8ucmVsc1BLAQIUAAoAAAAAAGM7PV0AAAAAAAAAAAAAAAAFAAAAAAAAAAAAEAAAAGQDAAB3b3JkL1BLAQIUAAoAAAAAAGM7PV1xKhdY2gAAANoAAAARAAAAAAAAAAAAAAAAAIcDAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAABQAFACABAACQBAAAAAA=', 'base64') });
  await page.getByRole('button', { name: '对接说明', exact: true }).click();
  const word = page.getByRole('dialog', { name: '对接说明', exact: true }).locator('iframe[title="材料正文"]');
  await expect(word).toHaveAttribute('srcdoc', /对接段落/);
  for (const size of [{ width: 1400, height: 900 }, { width: 390, height: 800 }, { width: 800, height: 560 }]) {
    await page.setViewportSize(size);
    await expect.poll(() => word.evaluate((node) => {
      const parent = node.parentElement;
      if (!(parent instanceof HTMLElement)) return 0;
      const frame = node.getBoundingClientRect();
      const box = parent.getBoundingClientRect();
      return Math.abs(frame.height - box.height) + Math.abs(frame.width - box.width);
    })).toBeLessThan(2);
  }
});
