import type { Page } from '@playwright/test';

export async function assistantMenuItem(page: Page, name: string | RegExp) {
  await page.getByTestId('ai-assistant').getByTestId('assistant-more-actions').click();
  return page.getByRole('menuitem', { name, exact: typeof name === 'string' });
}

export async function assistantInputTools(page: Page) {
  await page.getByTestId('ai-assistant').getByTestId('assistant-input-tools').click();
  return page.getByRole('dialog', { name: '输入工具', exact: true });
}
