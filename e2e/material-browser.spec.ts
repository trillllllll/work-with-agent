import type { Locator, Page } from '@playwright/test';
import { test, expect, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const base = 'http://127.0.0.1:3015';
async function owner(request: APIRequestContext, path: string, input: unknown) {
  const response = await request.post(`${base}${path}`, { data: input });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}
const docx = (name: string) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('docx') });

async function placement(scope: Page | Locator) {
  const table = scope.getByRole('table', { name: '材料', exact: true });
  await expect(table).toBeVisible();
  return table.evaluate((node) => {
    const preview = node.ownerDocument.querySelector('article[aria-label="材料预览"]');
    if (!(preview instanceof HTMLElement)) return null;
    const tableBox = node.getBoundingClientRect();
    const previewBox = preview.getBoundingClientRect();
    return { beside: previewBox.left >= tableBox.right - 2, below: previewBox.top >= tableBox.bottom - 2 };
  });
}

test.beforeEach(resetE2eDatabase);
test.afterAll(() => e2eDatabase.$disconnect());

test('导入文件不用填标题，明细里能看到原名，窄屏预览改到列表下面', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/knowledge');
  await page.getByLabel('选择要导入的文件', { exact: true }).setInputFiles(docx('【售后】九月.docx'));
  await page.getByRole('button', { name: '【售后】九月', exact: true }).click();
  await expect(page.getByRole('article', { name: '材料预览', exact: true })).toContainText('【售后】九月.docx');
  await expect.poll(() => placement(page)).toMatchObject({ beside: true });

  await page.setViewportSize({ width: 390, height: 800 });
  await expect.poll(() => placement(page)).toMatchObject({ below: true, beside: false });

  await page.setViewportSize({ width: 1400, height: 900 });
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
  await expect.poll(() => placement(dialog)).toMatchObject({ below: true, beside: false });
});

test('导入的 Markdown 能预览正文，关联任务可以事后修改', async ({ page, request }) => {
  await owner(request, '/api/tasks', { title: '对接任务' });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/knowledge');
  await page.getByLabel('资料所属清单', { exact: true }).selectOption({ label: '收集箱' });
  await page.getByLabel('选择要导入的文件', { exact: true }).setInputFiles({ name: '接口说明.md', mimeType: 'text/markdown', buffer: Buffer.from('# 接口说明\n\n这是正文') });
  await page.getByRole('button', { name: '接口说明', exact: true }).click();
  const preview = page.getByRole('article', { name: '材料预览', exact: true });
  await expect(preview.locator('.markdown-body').getByRole('heading', { name: '接口说明', exact: true })).toBeVisible();
  await expect(preview.locator('.markdown-body')).toContainText('这是正文');
  const link = preview.getByRole('combobox', { name: '关联任务', exact: true });
  await expect(link).toContainText('对接任务');
  await link.selectOption({ label: '对接任务' });
  await expect(page.getByRole('cell', { name: '对接任务', exact: true })).toBeVisible();
  await link.selectOption({ label: '不关联' });
  await expect(page.getByRole('cell', { name: '对接任务', exact: true })).toHaveCount(0);

  await page.getByLabel('选择要导入的文件', { exact: true }).setInputFiles({ name: '对接说明.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('UEsDBAoAAAAAAGM7PV3XeYTquAEAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiPgogIDxEZWZhdWx0IEV4dGVuc2lvbj0icmVscyIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLnJlbGF0aW9uc2hpcHMreG1sIi8+CiAgPERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz4KICA8T3ZlcnJpZGUgUGFydE5hbWU9Ii93b3JkL2RvY3VtZW50LnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC53b3JkcHJvY2Vzc2luZ21sLmRvY3VtZW50Lm1haW4reG1sIi8+CjwvVHlwZXM+UEsDBAoAAAAAAGM7PV0AAAAAAAAAAAAAAAAGAAAAX3JlbHMvUEsDBAoAAAAAAGM7PV0gG4bqLgEAAC4BAAALAAAAX3JlbHMvLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+CjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPgogIDxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvb2ZmaWNlRG9jdW1lbnQiIFRhcmdldD0id29yZC9kb2N1bWVudC54bWwiLz4KPC9SZWxhdGlvbnNoaXBzPlBLAwQKAAAAAABjOz1dAAAAAAAAAAAAAAAABQAAAHdvcmQvUEsDBAoAAAAAAGM7PV1xKhdY2gAAANoAAAARAAAAd29yZC9kb2N1bWVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+Cjx3OmRvY3VtZW50IHhtbG5zOnc9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy93b3JkcHJvY2Vzc2luZ21sLzIwMDYvbWFpbiI+CiAgPHc6Ym9keT48dzpwPjx3OnI+PHc6dD7lr7nmjqXmrrXokL08L3c6dD48L3c6cj48L3c6cD48L3c6Ym9keT4KPC93OmRvY3VtZW50PlBLAQIUAAoAAAAAAGM7PV3XeYTquAEAALgBAAATAAAAAAAAAAAAAAAAAAAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQACgAAAAAAYzs9XQAAAAAAAAAAAAAAAAYAAAAAAAAAAAAQAAAA6QEAAF9yZWxzL1BLAQIUAAoAAAAAAGM7PV0gG4bqLgEAAC4BAAALAAAAAAAAAAAAAAAAAA0CAABfcmVscy8ucmVsc1BLAQIUAAoAAAAAAGM7PV0AAAAAAAAAAAAAAAAFAAAAAAAAAAAAEAAAAGQDAAB3b3JkL1BLAQIUAAoAAAAAAGM7PV1xKhdY2gAAANoAAAARAAAAAAAAAAAAAAAAAIcDAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAABQAFACABAACQBAAAAAA=', 'base64') });
  await page.getByRole('button', { name: '对接说明', exact: true }).click();
  await expect(page.getByRole('article', { name: '材料预览', exact: true }).locator('iframe[title="材料正文"]')).toHaveAttribute('srcdoc', /对接段落/);
});
